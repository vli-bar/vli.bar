const CANCELLED = Symbol('camera-start-cancelled');
const noop = () => {};
const stopTracks = stream => { for (const track of stream?.getTracks?.() ?? []) { try { track.stop(); } catch { /* already ended */ } } };
const closeTask = task => { try { task?.close?.(); } catch { /* already disposed */ } };
const defaultAsset = path => new URL(path, globalThis.document?.baseURI ?? import.meta.url).href;

/**
 * Owns a camera stream and on-device Pose Landmarker. No microphone or video
 * recording is requested. MediaPipe, WASM and the model load only on start().
 * start() resolves true when ready, false when cancelled, and rejects failures.
 * onStatus receives {state,message,error?}; hidden/ended/error stop the camera
 * before notifying the caller, which can then save its current motion take.
 */
export class CameraMotion {
  constructor({ video, onFrame = noop, onStatus = noop, maxFps = 15,
    wasmBaseUrl = defaultAsset('vendor/mediapipe/wasm'),
    modelAssetUrl = defaultAsset('vendor/mediapipe/pose_landmarker_lite.task'),
    deps = {} } = {}) {
    if (!video) throw new Error('カメラ映像の表示先がありません。');
    if (!Number.isFinite(maxFps) || maxFps < 1 || maxFps > 30) throw new RangeError('推論頻度は1〜30fpsで指定してください。');
    this.video = video; this.onFrame = onFrame; this.onStatus = onStatus;
    this.maxFps = maxFps; this.wasmBaseUrl = wasmBaseUrl; this.modelAssetUrl = modelAssetUrl;
    this.deps = {
      mediaDevices: globalThis.navigator?.mediaDevices,
      document: globalThis.document,
      isSecureContext: globalThis.isSecureContext === true,
      loadVision: () => import('@mediapipe/tasks-vision'),
      requestAnimationFrame: callback => globalThis.requestAnimationFrame(callback),
      cancelAnimationFrame: handle => globalThis.cancelAnimationFrame(handle),
      now: () => performance.now(),
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimeout: handle => globalThis.clearTimeout(handle),
      ...deps,
    };
    this._run = null; this._disposed = false; this.state = 'stopped';
  }

  get ready() { return !!this._run?.ready; }
  get active() { return !!this._run; }
  get starting() { return this.active && !this.ready; }
  _current(run) { return this._run === run && !run.cancelled; }
  _notify(state, message, error) {
    this.state = state;
    this.onStatus({ state, message, ...(error ? { error } : {}) });
  }

  _listen(run, target, name, callback) {
    if (!target?.addEventListener) return;
    target.addEventListener(name, callback);
    run.cleanup.push(() => target.removeEventListener(name, callback));
  }

  // User permission, video.play(), and WASM startup need not resolve before a
  // stop takes effect. Resources which arrive later are disposed separately.
  _wait(run, promise, disposeLate = noop) {
    const guarded = Promise.resolve(promise).then(value => {
      if (!this._current(run)) { disposeLate(value); return CANCELLED; }
      return value;
    }, error => { if (!this._current(run)) return CANCELLED; throw error; });
    return Promise.race([guarded, run.cancelPromise]);
  }

  async start({ facingMode = 'user' } = {}) {
    if (this._disposed) throw new Error('カメラ処理は終了しています。');
    if (!['user', 'environment'].includes(facingMode)) throw new Error('前面または背面カメラを選んでください。');
    this.stop({ notify: false });
    if (!this.deps.isSecureContext) throw new Error('カメラを使うにはHTTPSで開いてください。');
    if (typeof this.deps.mediaDevices?.getUserMedia !== 'function') throw new Error('このブラウザではカメラを利用できません。');
    if (this.deps.document?.visibilityState === 'hidden') throw new Error('ページを表示してからカメラを開始してください。');
    const run = { ready: false, cancelled: false, stream: null, task: null, busy: false,
      cleanup: [], frameHandle: null, frameKind: null, lastTimestamp: -Infinity, lastTick: -Infinity, lastVideoTime: -Infinity };
    run.cancelPromise = new Promise(resolve => { run.resolveCancel = resolve; });
    this._run = run;
    const doc = this.deps.document;
    this._listen(run, doc, 'visibilitychange', () => {
      if (this._current(run) && doc.visibilityState === 'hidden') this._terminate(run, 'hidden', '画面が非表示になったためカメラを停止しました。');
    });
    this._notify('starting', 'カメラの許可を確認しています…');
    if (!this._current(run)) return false;
    try {
      // Invoke inside the caller's click gesture, before importing ML assets.
      const stream = await this._wait(run, this.deps.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
      }), stopTracks);
      if (stream === CANCELLED) return false;
      if (!this._current(run)) { stopTracks(stream); return false; }
      run.stream = stream;
      const tracks = stream.getVideoTracks?.() ?? stream.getTracks?.() ?? [];
      if (!tracks.length || tracks.every(track => track.readyState === 'ended')) throw new Error('カメラ映像を取得できませんでした。');
      for (const track of tracks) this._listen(run, track, 'ended', () => {
        if (this._current(run)) this._terminate(run, 'ended', 'カメラが停止しました。取得済みの動きを保存できます。');
      });
      this._listen(run, this.video, 'error', () => {
        if (this._current(run)) this._terminate(run, 'error', 'カメラ映像を読み込めませんでした。');
      });
      this._listen(run, this.video, 'ended', () => {
        if (this._current(run)) this._terminate(run, 'ended', 'カメラ映像が終了しました。');
      });
      this.video.muted = true; this.video.playsInline = true;
      this.video.setAttribute?.('playsinline', '');
      this.video.srcObject = stream;
      if (await this._wait(run, this.video.play()) === CANCELLED) return false;
      if (!this._current(run)) return false;
      if (await this._wait(run, this._videoReady(run)) === CANCELLED) return false;
      if (!this._current(run)) return false;
      this._notify('loading', '身体推定モデルを読み込んでいます…');
      if (!this._current(run)) return false;
      const vision = await this._wait(run, this.deps.loadVision());
      if (vision === CANCELLED || !this._current(run)) return false;
      const files = await this._wait(run, vision.FilesetResolver.forVisionTasks(this.wasmBaseUrl));
      if (files === CANCELLED || !this._current(run)) return false;
      const task = await this._wait(run, vision.PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: this.modelAssetUrl, delegate: 'CPU' },
        runningMode: 'VIDEO', numPoses: 1, outputSegmentationMasks: false,
        minPoseDetectionConfidence: .6, minPosePresenceConfidence: .6, minTrackingConfidence: .6,
      }), closeTask);
      if (task === CANCELLED) return false;
      if (!this._current(run)) { closeTask(task); return false; }
      run.task = task; run.ready = true;
      this._notify('ready', 'カメラの準備ができました。全身を画面に入れてください。');
      if (!this._current(run)) return false;
      this._schedule(run);
      return true;
    } catch (error) {
      if (!this._current(run)) return false;
      const message = error?.name === 'NotAllowedError' ? 'カメラの許可が必要です。ブラウザの設定を確認して再試行してください。'
        : error?.name === 'NotFoundError' ? 'カメラが見つかりません。'
        : error?.name === 'NotReadableError' ? 'カメラを開始できません。他のアプリで使用中でないか確認してください。'
        : error?.message || 'カメラの開始に失敗しました。';
      this._terminate(run, 'error', message, error);
      throw error;
    }
  }

  _videoReady(run) {
    const ready = () => this.video.readyState >= 2 && this.video.videoWidth > 0 && this.video.videoHeight > 0;
    if (ready()) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer, done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'resize']) this.video.removeEventListener(name, check);
        this.deps.clearTimeout(timer);
      };
      const check = () => { if (ready()) { cleanup(); resolve(); } };
      for (const name of ['loadedmetadata', 'loadeddata', 'canplay', 'resize']) this.video.addEventListener(name, check);
      timer = this.deps.setTimeout(() => { cleanup(); reject(new Error('カメラ映像の準備がタイムアウトしました。再試行してください。')); }, 20000);
      run.cleanup.push(() => { cleanup(); resolve(CANCELLED); });
      check();
    });
  }

  _schedule(run) {
    if (!this._current(run) || !run.ready || run.busy || run.frameHandle !== null) return;
    const callback = () => { run.frameHandle = null; this._detect(run); };
    if (typeof this.video.requestVideoFrameCallback === 'function' && typeof this.video.cancelVideoFrameCallback === 'function') {
      run.frameKind = 'video'; run.frameHandle = this.video.requestVideoFrameCallback(callback);
    } else {
      run.frameKind = 'raf'; run.frameHandle = this.deps.requestAnimationFrame(callback);
    }
  }

  async _detect(run) {
    if (!this._current(run) || run.busy) return;
    const now = this.deps.now();
    const mediaTime = this.video.currentTime;
    if (!Number.isFinite(now) || this.video.readyState < 2 || !this.video.videoWidth || !this.video.videoHeight ||
      !Number.isFinite(mediaTime) || mediaTime === run.lastVideoTime || now - run.lastTick < 1000 / this.maxFps) {
      this._schedule(run); return;
    }
    run.busy = true; run.lastTick = now; run.lastVideoTime = mediaTime;
    const timestamp = Math.max(now, run.lastTimestamp + .001);
    run.lastTimestamp = timestamp;
    try {
      const result = await run.task.detectForVideo(this.video, timestamp);
      if (this._current(run)) this.onFrame(result, timestamp);
    } catch (error) {
      if (this._current(run)) this._terminate(run, 'error', '身体推定を続けられませんでした。取得済みの動きを保存してください。', error);
    } finally {
      run.busy = false;
      if (!this._current(run)) { closeTask(run.task); run.task = null; }
      else this._schedule(run);
    }
  }

  _terminate(run, state, message, error) {
    if (!this._current(run)) return;
    this._run = null; run.cancelled = true; run.ready = false; run.resolveCancel(CANCELLED);
    if (run.frameHandle !== null) {
      if (run.frameKind === 'video') this.video.cancelVideoFrameCallback(run.frameHandle);
      else this.deps.cancelAnimationFrame(run.frameHandle);
      run.frameHandle = null;
    }
    for (const cleanup of run.cleanup.splice(0)) cleanup();
    stopTracks(run.stream);
    if (this.video.srcObject === run.stream) {
      try { this.video.pause(); } catch { /* detached video */ }
      this.video.srcObject = null;
    }
    if (!run.busy) { closeTask(run.task); run.task = null; }
    if (state) this._notify(state, message, error);
  }

  /** Camera tracks stop synchronously; pending starts resolve false. */
  stop({ notify = true } = {}) {
    if (!this._run) return false;
    this._terminate(this._run, notify ? 'stopped' : null, 'カメラを停止しました。');
    return true;
  }

  dispose() { this.stop({ notify: false }); this._disposed = true; this.state = 'disposed'; }
}
