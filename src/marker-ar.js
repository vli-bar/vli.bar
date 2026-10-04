import { Matrix4 } from 'three';
import aruco from 'js-aruco2';
import posit from 'js-aruco2/src/posit1.js';

export const MARKER_DICTIONARY = 'ARUCO_MIP_36h12';
export const MARKER_ID = 0;
export const DEFAULT_MARKER_SIZE = .15; // Width of the black square, in meters.
const CANCELLED = Symbol('marker-start-cancelled');
const noop = () => {};
const stopTracks = stream => { for (const track of stream?.getTracks?.() ?? []) { try { track.stop(); } catch { /* already stopped */ } } };
const validSize = value => Number.isFinite(value) && value >= .03 && value <= 1;

/**
 * Keep the printed white margin distinct from the smaller black marker edge.
 * Upstream's fixed 10px contour deduplication merges those two boundaries when
 * the black square is about 40px wide, discarding the only decodable contour.
 * Use 5% of the smaller candidate's mean edge, bounded to 3–10px. The 3px floor
 * still merges the inner/outer outlines of the same thresholded black edge.
 */
export function createMarkerDetector() {
  const detector = new aruco.AR.Detector({ dictionaryName: MARKER_DICTIONARY, maxHammingDistance: 2 });
  detector.notTooNear = (candidates, maxDistance) => {
    const perimeters = candidates.map(points => points.reduce((sum, point, i) => {
      const next = points[(i + 1) % points.length];
      return sum + Math.hypot(next.x - point.x, next.y - point.y);
    }, 0));
    const removed = new Set();
    for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
      const threshold = Math.min(maxDistance, Math.max(3, Math.min(perimeters[i], perimeters[j]) * .05 / 4));
      const meanSquareDistance = candidates[i].reduce((sum, point, k) => {
        const other = candidates[j][k];
        return sum + (point.x - other.x) ** 2 + (point.y - other.y) ** 2;
      }, 0) / 4;
      if (meanSquareDistance < threshold ** 2) removed.add(perimeters[i] < perimeters[j] ? i : j);
    }
    return candidates.filter((_, index) => !removed.has(index));
  };
  return detector;
}

/** Full-frame pinhole approximation. No lens calibration or persistent SLAM. */
export function markerProjection(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) throw new RangeError('カメラ映像の寸法が不正です。');
  return { width, height, focalLength: width, aspect: width / height, cameraFov: 2 * Math.atan(height / (2 * width)) * 180 / Math.PI };
}

/**
 * Canonical corners are top-left, top-right, bottom-right, bottom-left (after
 * dictionary rotation). Result: marker center origin, +Y up, +Z out of its
 * printed front, expressed in Three's camera space (camera looks down -Z).
 */
export function estimateMarkerPose(corners, { width, height, markerSize = DEFAULT_MARKER_SIZE, solver, target = new Matrix4() } = {}) {
  if (!validSize(markerSize) || !Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || corners?.length !== 4) return null;
  if (corners.some(p => !Number.isFinite(p?.x) || !Number.isFinite(p?.y) || p.x < 0 || p.x > width || p.y < 0 || p.y > height)) return null;
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4], c = corners[(i + 2) % 4];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 8 || (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x) <= 0) return null;
    area += a.x * b.y - b.x * a.y;
  }
  if (area < 128) return null;
  const centered = corners.map(({ x, y }) => ({ x: x - width / 2, y: height / 2 - y }));
  const result = (solver ?? new posit.POS.Posit(markerSize, width)).pose(centered);
  const half = markerSize / 2, model = [[-half, half], [half, half], [half, -half], [-half, -half]];
  let best = null, bestRms = Infinity;
  for (const prefix of ['best', 'alternative']) {
    const r = result?.[`${prefix}Rotation`], t = result?.[`${prefix}Translation`];
    if (r?.length !== 3 || r.some(row => row?.length !== 3 || row.some(v => !Number.isFinite(v))) || t?.length !== 3 || t.some(v => !Number.isFinite(v))) continue;
    if (t[2] < .02 || t[2] > 100 || Math.hypot(...t) > 100) continue;
    let orthogonal = true;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      if (Math.abs(r[i].reduce((sum, v, k) => sum + v * r[j][k], 0) - Number(i === j)) > .03) orthogonal = false;
    }
    if (!orthogonal) continue;
    const determinant = r[0][0] * (r[1][1] * r[2][2] - r[1][2] * r[2][1]) - r[0][1] * (r[1][0] * r[2][2] - r[1][2] * r[2][0]) + r[0][2] * (r[1][0] * r[2][1] - r[1][1] * r[2][0]);
    if (Math.abs(determinant - 1) > .03) continue;
    // Conjugate R by diag(1,1,-1), and negate translation Z. Negating only
    // one row would mirror the avatar and leave a reflection (determinant -1).
    const candidate = new Matrix4().set(r[0][0], r[0][1], -r[0][2], t[0], r[1][0], r[1][1], -r[1][2], t[1], -r[2][0], -r[2][1], r[2][2], -t[2], 0, 0, 0, 1);
    const frontFacing = r[0][2] * t[0] + r[1][2] * t[1] + r[2][2] * t[2];
    if (frontFacing <= 0) continue;
    let squareError = 0, inFront = true;
    for (let i = 0; i < 4; i++) {
      const [x, y] = model[i];
      const px = r[0][0] * x + r[0][1] * y + t[0], py = r[1][0] * x + r[1][1] * y + t[1], pz = r[2][0] * x + r[2][1] * y + t[2];
      if (pz <= .01) { inFront = false; break; }
      squareError += (width * px / pz - centered[i].x) ** 2 + (width * py / pz - centered[i].y) ** 2;
    }
    const rms = Math.sqrt(squareError / 4);
    if (inFront && rms <= Math.max(3, Math.sqrt(area / 2) * .06) && rms < bestRms) { best = candidate; bestRms = rms; }
  }
  return best ? target.copy(best) : null;
}

/**
 * Offline, rear-camera marker tracking. Call update(performance.now()) from
 * the render loop. Render using cameraFov/aspect and an uncropped video;
 * hide geometry whenever tracked is false. start resolves false on cancel.
 */
export class MarkerAR {
  constructor({ video, onStatus = noop, maxFps = 15, maxSize = 640, lostAfterMs = 200, deps = {} } = {}) {
    if (!video) throw new Error('カメラ映像の表示先がありません。');
    if (!Number.isFinite(maxFps) || maxFps < 1 || maxFps > 15 || !Number.isInteger(maxSize) || maxSize < 160 || maxSize > 640 || !Number.isFinite(lostAfterMs) || lostAfterMs < 0 || lostAfterMs > 1000) throw new RangeError('マーカー追跡の設定が不正です。');
    this.video = video; this.onStatus = onStatus; this.maxFps = maxFps; this.maxSize = maxSize; this.lostAfterMs = lostAfterMs;
    this.deps = { mediaDevices: globalThis.navigator?.mediaDevices, document: globalThis.document,
      isSecureContext: globalThis.isSecureContext === true,
      createCanvas: () => globalThis.document.createElement('canvas'),
      createDetector: createMarkerDetector,
      createSolver: (size, focal) => new posit.POS.Posit(size, focal),
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms), clearTimeout: handle => globalThis.clearTimeout(handle), ...deps };
    this.pose = new Matrix4(); this.width = 0; this.height = 0; this.cameraFov = 0; this.aspect = 1;
    this._run = null; this._tracked = false; this.state = 'stopped'; this._disposed = false;
  }
  get active() { return !!this._run; }
  get ready() { return !!this._run?.ready; }
  get tracked() { return this.ready && this._tracked; }
  _current(run) { return this._run === run && !run.cancelled; }
  _notify(state, message, error) { this.state = state; this.onStatus({ state, message, ...(error ? { error } : {}) }); }
  _listen(run, target, name, callback) {
    target?.addEventListener?.(name, callback);
    run.cleanup.push(() => target?.removeEventListener?.(name, callback));
  }
  _wait(run, promise, disposeLate = noop) {
    const guarded = Promise.resolve(promise).then(value => {
      if (!this._current(run)) { disposeLate(value); return CANCELLED; }
      return value;
    }, error => { if (!this._current(run)) return CANCELLED; throw error; });
    return Promise.race([guarded, run.cancelPromise]);
  }
  async start({ markerSize = DEFAULT_MARKER_SIZE } = {}) {
    if (this._disposed) throw new Error('マーカー追跡は終了しています。');
    if (!validSize(markerSize)) throw new RangeError('黒いマーカーの一辺は3〜100cmで指定してください。');
    this.stop({ notify: false });
    if (!this.deps.isSecureContext) throw new Error('カメラARを使うにはHTTPSで開いてください。');
    if (typeof this.deps.mediaDevices?.getUserMedia !== 'function') throw new Error('このブラウザではカメラを利用できません。');
    if (this.deps.document?.visibilityState === 'hidden') throw new Error('ページを表示してからカメラARを開始してください。');
    const run = { ready: false, cancelled: false, stream: null, canvas: null, context: null, detector: null, solver: null,
      markerSize, cleanup: [], lastTick: -Infinity, lastVideoTime: -Infinity, lastSeen: -Infinity, sourceWidth: 0, sourceHeight: 0 };
    run.cancelPromise = new Promise(resolve => { run.resolveCancel = resolve; });
    this._run = run; this._tracked = false;
    this._listen(run, this.deps.document, 'visibilitychange', () => {
      if (this._current(run) && this.deps.document.visibilityState === 'hidden') this._terminate(run, 'hidden', '画面が非表示になったためカメラARを終了しました。');
    });
    try {
      this._notify('starting', '背面カメラの許可を確認しています…');
      if (!this._current(run)) return false;
      const stream = await this._wait(run, this.deps.mediaDevices.getUserMedia({ audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } } }), stopTracks);
      if (stream === CANCELLED) return false;
      if (!this._current(run)) { stopTracks(stream); return false; }
      run.stream = stream;
      const tracks = stream.getVideoTracks?.() ?? stream.getTracks?.() ?? [];
      if (!tracks.length || tracks.every(track => track.readyState === 'ended')) throw new Error('カメラ映像を取得できませんでした。');
      for (const track of tracks) {
        this._listen(run, track, 'ended', () => this._terminate(run, 'ended', 'カメラが停止したためカメラARを終了しました。'));
        this._listen(run, track, 'mute', () => this._terminate(run, 'interrupted', 'カメラが中断されたためカメラARを終了しました。もう一度開始してください。'));
      }
      this._listen(run, this.video, 'error', () => this._terminate(run, 'error', 'カメラ映像を読み込めませんでした。'));
      this._listen(run, this.video, 'ended', () => this._terminate(run, 'ended', 'カメラ映像が終了しました。'));
      this.video.muted = true; this.video.defaultMuted = true; this.video.playsInline = true;
      this.video.setAttribute?.('muted', ''); this.video.setAttribute?.('playsinline', ''); this.video.srcObject = stream;
      if (await this._wait(run, this.video.play()) === CANCELLED || !this._current(run)) return false;
      if (await this._wait(run, this._videoReady(run)) === CANCELLED || !this._current(run)) return false;
      run.canvas = this.deps.createCanvas(); run.context = run.canvas.getContext('2d', { willReadFrequently: true });
      if (!run.context) throw new Error('カメラ映像を解析できませんでした。');
      run.detector = this.deps.createDetector(); this._resize(run); run.ready = true;
      this._notify('ready', '壁のマーカー全体をカメラに映してください。');
      return this._current(run);
    } catch (error) {
      if (!this._current(run)) return false;
      const message = error?.name === 'NotAllowedError' ? 'カメラの許可が必要です。Safariの設定を確認して再試行してください。'
        : error?.name === 'NotFoundError' ? 'カメラが見つかりません。'
          : error?.name === 'NotReadableError' ? 'カメラを開始できません。他のアプリで使用中でないか確認してください。'
            : error?.message || 'カメラARの開始に失敗しました。';
      this._terminate(run, 'error', message, error); throw error;
    }
  }
  _videoReady(run) {
    const ready = () => this.video.readyState >= 2 && this.video.videoWidth > 0 && this.video.videoHeight > 0;
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer, done = false;
      const cleanup = () => {
        if (done) return; done = true;
        for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'resize']) this.video.removeEventListener(name, check);
        this.deps.clearTimeout(timer);
      };
      const check = () => { if (ready()) { cleanup(); resolve(); } };
      for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'resize']) this.video.addEventListener(name, check);
      timer = this.deps.setTimeout(() => { cleanup(); reject(new Error('カメラ映像の準備がタイムアウトしました。')); }, 20000);
      run.cleanup.push(() => { cleanup(); resolve(CANCELLED); }); check();
    });
  }
  _resize(run) {
    const width = this.video.videoWidth, height = this.video.videoHeight;
    if (width === run.sourceWidth && height === run.sourceHeight) return;
    const scale = Math.min(1, this.maxSize / Math.max(width, height));
    this.width = run.canvas.width = Math.max(1, Math.round(width * scale));
    this.height = run.canvas.height = Math.max(1, Math.round(height * scale));
    const projection = markerProjection(this.width, this.height);
    this.aspect = projection.aspect; this.cameraFov = projection.cameraFov;
    run.solver = this.deps.createSolver(run.markerSize, projection.focalLength);
    run.sourceWidth = width; run.sourceHeight = height; run.lastVideoTime = -Infinity; run.lastTick = -Infinity; run.lastSeen = -Infinity;
    this._tracked = false;
  }
  update(timeMs) {
    const run = this._run;
    if (!run?.ready || !Number.isFinite(timeMs)) return false;
    if (this._tracked && timeMs - run.lastSeen > this.lostAfterMs) {
      this._tracked = false; this._notify('lost', 'マーカーを見失いました。全体をカメラに映してください。');
      if (!this._current(run)) return false;
    }
    if (this.video.readyState < 2 || this.video.videoWidth <= 0 || this.video.videoHeight <= 0 || !Number.isFinite(this.video.currentTime)) return this.tracked;
    try {
      this._resize(run);
      if (timeMs - run.lastTick < 1000 / this.maxFps || this.video.currentTime === run.lastVideoTime) return this.tracked;
      run.lastTick = timeMs; run.lastVideoTime = this.video.currentTime;
      run.context.drawImage(this.video, 0, 0, this.width, this.height);
      const markers = run.detector.detect(run.context.getImageData(0, 0, this.width, this.height));
      const marker = markers.find(item => item.id === MARKER_ID);
      const pose = marker && estimateMarkerPose(marker.corners, { width: this.width, height: this.height, markerSize: run.markerSize, solver: run.solver, target: this.pose });
      if (pose) {
        run.lastSeen = timeMs;
        if (!this._tracked) { this._tracked = true; this._notify('tracking', 'マーカーを追跡しています。'); }
      }
    } catch (error) { this._terminate(run, 'error', 'マーカー追跡を続けられませんでした。カメラARを再開してください。', error); }
    return this.tracked;
  }
  _terminate(run, state, message, error) {
    if (!this._current(run)) return;
    this._run = null; this._tracked = false; run.ready = false; run.cancelled = true; run.resolveCancel(CANCELLED);
    for (const cleanup of run.cleanup.splice(0)) cleanup();
    stopTracks(run.stream);
    if (this.video.srcObject === run.stream) { try { this.video.pause(); } catch { /* detached */ } this.video.srcObject = null; }
    run.canvas = run.context = run.detector = run.solver = null;
    if (state) this._notify(state, message, error);
  }
  stop({ notify = true } = {}) {
    if (!this._run) return false;
    this._terminate(this._run, notify ? 'stopped' : null, 'カメラARを終了しました。'); return true;
  }
  dispose() { this.stop({ notify: false }); this._disposed = true; this.state = 'disposed'; }
}
