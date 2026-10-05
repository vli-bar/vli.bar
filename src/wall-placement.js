import * as THREE from 'three';
import { intersectWallPlane, buildWallCalibration } from './wall-geometry.js';
import { detectDepthWall } from './depth-wall.js';

const UP = new THREE.Vector3(0, 1, 0);
const VERTICAL_LIMIT = Math.sin(20 * Math.PI / 180);
const pointNames = ['左下', '右下', '左上'];
const matrixOf = pose => new THREE.Matrix4().fromArray(pose.transform.matrix);
const validPose = pose => pose && !pose.emulatedPosition && pose.transform?.matrix?.length === 16 &&
  Array.from(pose.transform.matrix).every(Number.isFinite) && Math.abs(matrixOf(pose).determinant()) > 1e-8;
const NON_WALL_LABELS = new Set(['floor', 'ceiling', 'table', 'desk', 'couch', 'chair', 'bed', 'screen', 'storage', 'global-mesh', 'global mesh']);
const cancelSource = source => {try {source?.cancel();} catch { /* Session may already be inactive. */ }};
const resolveMode = (mode, inputMode) => inputMode === 'touch' && mode === 'manual' ? 'distance' : mode;

/** Uses native WebXR geometry when supplied; never invents a detected wall. */
export class WallPlacement {
  constructor(scene) {
    this.visuals = new THREE.Group();
    scene.add(this.visuals);
    this.material = new THREE.LineBasicMaterial({color: 0xc6ff75, transparent: true, opacity: .6});
    this.preview = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-1.2, -1.25, 0), new THREE.Vector3(1.2, -1.25, 0),
      new THREE.Vector3(1.2, 1.25, 0), new THREE.Vector3(-1.2, 1.25, 0),
    ]), this.material);
    this.visuals.add(this.preview);
    this.dots = Array.from({length: 3}, () => {
      const dot = new THREE.Mesh(new THREE.SphereGeometry(.018, 10, 8), new THREE.MeshBasicMaterial({color: 0xc6ff75}));
      this.visuals.add(dot); return dot;
    });
    this.planeViews = new Map();
    this.session = null;
    this.hitTestVersion = 0;
    this.report = {state: 'not-started'};
    this.visuals.visible = false;
  }

  start(session, referenceSpace, {mode = 'auto', width = 2.4, distance = 2, inputMode = 'controller', environment = 'ar'} = {}) {
    this.end();
    this.session = session; this.referenceSpace = referenceSpace;
    this.inputMode = inputMode === 'touch' ? 'touch' : 'controller';
    this.environment = environment === 'vr' ? 'vr' : 'ar';
    this.mode = this.environment === 'vr' ? 'distance' : resolveMode(mode, this.inputMode); this.width = width; this.distance = distance;
    this.points = []; this.candidate = null; this.placed = null; this.message = '';
    this.roomAttempted = false; this.viewer = null; this.lastUpdate = -Infinity;
    this.depthStable = null;
    const roomAvailable = typeof session.initiateRoomCapture === 'function' && (!session.enabledFeatures || Array.from(session.enabledFeatures).includes('plane-detection'));
    this.report = {state: 'active', mode: this.mode, environment:this.environment, inputMode: this.inputMode, enabledFeatures: session.enabledFeatures ? Array.from(session.enabledFeatures) : null,
      planeAPI: this.mode === 'auto' ? 'waiting' : 'not-requested', planes: 0, verticalPlanes: 0,
      hitTest: this.mode === 'auto' ? 'waiting' : 'disabled', depth: this.mode === 'auto' ? 'waiting' : 'disabled',
      roomCapture: roomAvailable ? 'available' : 'unavailable'};
    this.visuals.visible = true;
    this.preview.visible = false; this.dots.forEach(dot => { dot.visible = false; });
    // Feature requests can settle after XR has ended. Dispose late results too.
    if (this.mode === 'auto') this.setupHitTest(session);
  }

  async setupHitTest(session) {
    const version = ++this.hitTestVersion;
    const active = () => this.session === session && this.mode === 'auto' && this.hitTestVersion === version;
    if (typeof session.requestHitTestSource !== 'function') {this.report.hitTest = 'unavailable'; return;}
    this.report.hitTest = 'waiting';
    try {
      const space = await session.requestReferenceSpace('viewer');
      if (!active()) return;
      const source = await session.requestHitTestSource({space, entityTypes: ['plane']});
      if (!active()) {cancelSource(source); return;}
      this.hitSource = source; this.report.hitTest = 'available';
    } catch (error) {
      if (active()) this.report.hitTest = error.name || 'unavailable';
    }
  }

  end() {
    ++this.hitTestVersion;
    cancelSource(this.hitSource); this.hitSource = null;
    this.session = null; this.candidate = null; this.placed = null;
    this.depthStable = null;
    this.visuals.visible = false;
    for (const {line} of this.planeViews.values()) {this.visuals.remove(line); line.geometry.dispose();}
    this.planeViews.clear();
    if (this.report.state === 'active') this.report.state = 'ended';
  }

  reset({switchToManual = false, mode} = {}) {
    const previousMode = this.mode;
    this.mode = this.environment === 'vr' ? 'distance' : resolveMode(mode ?? (switchToManual ? 'manual' : this.mode), this.inputMode);
    this.points = []; this.placed = null; this.candidate = null; this.message = '';
    this.depthStable = null; delete this.report.depthMetrics; delete this.report.depthReason;
    this.report.depth = this.mode === 'auto' ? 'waiting' : 'disabled';
    this.lastUpdate = -Infinity; this.report.tracking = false;
    this.report.mode = this.mode;
    delete this.report.placementSource;
    this.preview.visible = false;
    this.dots.forEach(dot => {dot.visible = false;});
    for (const {line} of this.planeViews.values()) line.visible = false;
    if (this.mode !== previousMode) {
      // Requests in flight belong to the mode that initiated them. A late
      // source must not revive auto detection after switching to distance.
      ++this.hitTestVersion;
      cancelSource(this.hitSource); this.hitSource = null;
      this.report.planeAPI = this.mode === 'auto' ? 'waiting' : 'not-requested';
      this.report.hitTest = this.mode === 'auto' ? 'waiting' : 'disabled';
      this.report.planes = 0; this.report.verticalPlanes = 0;
      if (this.session && this.mode === 'auto') this.setupHitTest(this.session);
    }
  }

  orientation(normal) {
    const right = new THREE.Vector3().crossVectors(UP, normal).normalize();
    const up = new THREE.Vector3().crossVectors(normal, right).normalize();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, normal));
  }

  update(frame, now = performance.now()) {
    if (!this.session) return;
    this.lastUpdate = now; this.candidate = null; this.preview.visible = false;
    for (const {line} of this.planeViews.values()) line.visible = false;
    this.report.tracking = false;
    this.dots.forEach(dot => {dot.visible = false;});
    if (this.session.visibilityState !== 'visible') {this.depthStable = null; return;}
    const pose = frame.getViewerPose(this.referenceSpace);
    if (!validPose(pose)) {this.depthStable = null; return;}
    this.report.tracking = true;
    if (!this.placed) this.points.forEach((point, i) => {this.dots[i].visible = true;});
    const view = matrixOf(pose);
    this.viewer = new THREE.Vector3().setFromMatrixPosition(view);
    const direction = new THREE.Vector3(0, 0, -1).transformDirection(view);
    if (this.placed || this.mode === 'manual') return;
    if (this.mode === 'distance') {
      direction.y = 0;
      if (direction.lengthSq() < .001) return;
      direction.normalize();
      this.candidate = {point: this.viewer.clone().addScaledVector(direction, this.distance), normal: direction.clone().negate(), source: this.environment === 'vr' ? 'virtual-stage' : 'distance'};
    } else {
      this.scanPlanes(frame, {origin: this.viewer, direction});
      if (!this.candidate && !this.report.blockedBySurface && this.hitSource) this.scanHits(frame);
      if (!this.candidate && !this.report.blockedBySurface) this.scanDepth(frame, pose, now);
      else {this.depthStable = null; this.report.depth = 'not-needed'; delete this.report.depthMetrics; delete this.report.depthReason;}
    }
    if (this.candidate) {
      this.message = '';
      this.candidate.quaternion = this.orientation(this.candidate.normal);
      this.preview.position.copy(this.candidate.point).addScaledVector(this.candidate.normal, .015);
      this.preview.quaternion.copy(this.candidate.quaternion);
      this.preview.scale.setScalar(this.width / 2.4);
      this.preview.visible = true;
    }
  }

  scanPlanes(frame, ray) {
    let planes;
    try {planes = frame.detectedPlanes; this.report.planeAPI = planes ? 'available' : 'unavailable';}
    catch (error) {this.report.planeAPI = error.name;}
    this.report.planes = planes?.size || 0; this.report.verticalPlanes = 0;
    this.report.blockedBySurface = false;
    let obstacleDistance = Infinity;
    for (const [plane, {line}] of this.planeViews) {
      if (!planes?.has(plane)) {this.visuals.remove(line); line.geometry.dispose(); this.planeViews.delete(plane);}
    }
    if (!planes) return;
    for (const plane of planes) {
      let pose;
      try {pose = frame.getPose(plane.planeSpace, this.referenceSpace);} catch {continue;}
      if (!validPose(pose) || !Array.isArray(plane.polygon) || plane.polygon.length < 3 ||
        !plane.polygon.every(p => p && [p.x, p.y, p.z].every(Number.isFinite))) continue;
      const matrix = matrixOf(pose);
      const normal = new THREE.Vector3(0, 1, 0).transformDirection(matrix);
      if (plane.orientation === 'horizontal' || Math.abs(normal.dot(UP)) > VERTICAL_LIMIT) continue;
      const hit = intersectWallPlane(ray, {matrix, polygon: plane.polygon, orientation: plane.orientation});
      if (NON_WALL_LABELS.has(plane.semanticLabel?.toLowerCase())) {
        if (hit && hit.distance >= .25) obstacleDistance = Math.min(obstacleDistance, hit.distance);
        continue;
      }
      this.report.verticalPlanes++;
      let visual = this.planeViews.get(plane);
      if (!visual) {
        const line = new THREE.LineLoop(new THREE.BufferGeometry(), this.material);
        line.matrixAutoUpdate = false; this.visuals.add(line);
        visual = {line}; this.planeViews.set(plane, visual);
      }
      if (visual.changed !== plane.lastChangedTime || visual.count !== plane.polygon.length) {
        visual.line.geometry.dispose();
        visual.line.geometry = new THREE.BufferGeometry().setFromPoints(plane.polygon.map(p => new THREE.Vector3(p.x, p.y, p.z)));
        visual.changed = plane.lastChangedTime; visual.count = plane.polygon.length;
      }
      visual.line.matrix.copy(matrix); visual.line.visible = true;
      if (hit && hit.distance >= .25 && hit.distance <= 8 && (!this.candidate || hit.distance < this.candidate.distance)) {
        this.candidate = {...hit, source: 'plane-detection'};
      }
    }
    if (obstacleDistance < (this.candidate?.distance ?? Infinity)) {
      this.candidate = null; this.report.blockedBySurface = true;
    }
  }

  scanHits(frame) {
    try {
      for (const result of frame.getHitTestResults(this.hitSource)) {
        const pose = result.getPose(this.referenceSpace);
        if (!validPose(pose)) continue;
        const matrix = matrixOf(pose);
        const normal = new THREE.Vector3(0, 1, 0).transformDirection(matrix);
        if (Math.abs(normal.dot(UP)) > VERTICAL_LIMIT) continue;
        const point = new THREE.Vector3().setFromMatrixPosition(matrix);
        const toViewer = this.viewer.clone().sub(point);
        const distance = toViewer.length();
        if (distance < .25 || distance > 8) continue;
        if (normal.dot(toViewer) < 0) normal.negate();
        if (!this.candidate || distance < this.candidate.distance) this.candidate = {point, normal, distance, source: 'hit-test'};
      }
    } catch (error) {this.report.hitTest = error.name;}
  }

  scanDepth(frame, pose, now) {
    const result = detectDepthWall(frame, this.referenceSpace, pose);
    this.report.depth = result.state; this.report.depthReason = result.reason; this.report.depthMetrics = {...result.metrics};
    const candidate = result.candidate;
    if (!candidate) {this.depthStable = null; return;}
    const stable = this.depthStable;
    // A single noisy depth image must not become a placement. Compare to the
    // original plane, so slowly drifting estimates cannot accumulate confidence.
    if (!stable || now - stable.last > 250 || now < stable.last ||
      stable.normal.dot(candidate.normal) < Math.cos(8 * Math.PI / 180) ||
      Math.abs(candidate.point.clone().sub(stable.point).dot(stable.normal)) > .08 ||
      stable.point.distanceTo(candidate.point) > .3) {
      this.depthStable = {point:candidate.point.clone(), normal:candidate.normal.clone(), since:now, last:now, frames:1};
    } else {stable.last = now; stable.frames++;}
    if (now - this.depthStable.since >= 350 && this.depthStable.frames >= 3) this.candidate = candidate;
    else this.report.depth = 'stabilizing';
  }

  confirm(frame, inputSource, now = performance.now()) {
    if (!this.session || this.session.visibilityState !== 'visible' || !this.report.tracking || now - this.lastUpdate > 250) return null;
    if (this.placed) return this.placed;
    this.message = '';
    if (this.mode === 'manual') {
      const pose = inputSource?.targetRayMode === 'tracked-pointer' && frame?.getPose(inputSource.targetRaySpace, this.referenceSpace);
      if (!pose || pose.emulatedPosition) {this.message = 'コントローラーの追跡を確認してください'; return null;}
      const point = new THREE.Vector3().setFromMatrixPosition(matrixOf(pose));
      const index = this.points.length;
      this.points.push(point); this.dots[index].position.copy(point); this.dots[index].visible = true;
      if (this.points.length < 3) return null;
      try {
        const calibration = buildWallCalibration(this.points);
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(calibration.quaternion);
        if (normal.dot(this.viewer.clone().sub(calibration.position)) <= 0) throw new Error('壁に向かって左下→右下→左上の順に指定してください');
        this.placed = {...calibration, source: 'manual'};
        this.width = calibration.width;
      } catch (error) {this.reset(); this.message = error.message; return null;}
    } else if (this.candidate) {
      const {point, quaternion, source} = this.candidate;
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(quaternion);
      this.placed = {position: point.clone().addScaledVector(up, -1.25 * this.width / 2.4), quaternion: quaternion.clone(), width: this.width, source};
    } else {
      this.requestRoomCapture(); return null;
    }
    if (this.placed) {
      this.report.placementSource = this.placed.source;
      this.preview.visible = false; this.dots.forEach(dot => {dot.visible = false;});
      for (const {line} of this.planeViews.values()) line.visible = false;
    }
    return this.placed;
  }

  async requestRoomCapture() {
    const session = this.session;
    if (!this.canRequestRoomCapture()) {
      this.message = this.inputMode === 'touch'
        ? (this.mode === 'distance' ? 'スマホを壁に向け、配置ボタンを押してください' : '壁が見つからない場合は距離指定へ切り替えてください')
        : '壁が見つからない場合は距離指定へ。コントローラーなら3点指定も使えます';
      return;
    }
    this.roomAttempted = true; this.report.roomCapture = 'requested';
    this.message = '端末の部屋スキャン案内を確認してください';
    try {
      await session.initiateRoomCapture();
      if (this.session === session) {this.report.roomCapture = 'completed'; if (this.mode === 'auto') this.message = '';}
    } catch (error) {
      if (this.session === session) {
        this.report.roomCapture = error.name;
        if (this.mode === 'auto') this.message = this.inputMode === 'touch'
          ? '部屋スキャンを利用できません。距離指定へ切り替えてください'
          : '部屋スキャンを利用できません。距離指定、またはコントローラーで3点指定へ';
      }
    }
  }

  canRequestRoomCapture() {
    return !!this.session && this.session.visibilityState === 'visible' && this.mode === 'auto' &&
      !this.placed && !this.roomAttempted && this.report.roomCapture === 'available';
  }

  guidance() {
    const touch = this.inputMode === 'touch';
    if (!this.report.tracking) return ['位置を追跡中', '周囲を見て追跡の復帰を待ってください'];
    if (this.environment === 'vr') return this.placed
      ? ['VRステージを配置しました', '再生ボタンで開演 · 置き直すボタンで位置を変更']
      : ['VRステージの位置を選択', '見たい方向を向き、ここに配置を選択してください（実際の壁は検出しません）'];
    if (this.placed) return ['ステージを配置しました', touch ? '再生ボタンで開演 · 再配置ボタンで位置を変更' : 'ライブを再生で開演 · 置き直すで再配置'];
    if (this.message) return ['壁の配置', this.message];
    if (this.mode === 'manual') return [`壁の3点指定 ${this.points.length + 1}/3 · ${pointNames[this.points.length]}`, '緑の点を指定位置に合わせてトリガー'];
    if (this.candidate) return [this.mode === 'distance' ? '指定距離で配置（壁検出なし）' : '壁の候補を検出', touch ? '画面中央の枠を確認し、配置ボタンを押してください' : '枠を確認して「ここに配置」を選択 · ピンチまたはトリガーで操作'];
    if (this.mode === 'distance') return ['配置位置を調整中（壁検出なし）', touch ? 'スマホを正面に向け、画面中央の枠を確認してください' : '壁を正面に見て、配置する枠を確認してください'];
    if (this.report.blockedBySurface) return ['壁の前に物があります', '家具を避け、壁が見える位置にゆっくり向きを変えてください'];
    if (this.report.depth === 'stabilizing') return ['壁の奥行きを確認中', '壁の中心に向けたまま、少し静止してください'];
    if (['sparse', 'not-planar', 'not-vertical', 'invalid-depth', 'tracking'].includes(this.report.depth)) return ['奥行きから壁を探しています', '床や家具を避け、壁を広く映しながらゆっくり見回してください'];
    if (this.report.planeAPI !== 'available' && !['available', 'waiting'].includes(this.report.hitTest) && this.report.depth === 'unavailable') return ['壁情報を取得できません', touch ? '距離指定へ切り替えて配置してください' : '距離指定へ切り替えるか、コントローラーによる3点指定へ'];
    const search = this.report.roomCapture === 'available'
      ? (touch ? '画面中央を壁に向ける · 「部屋をスキャン」で端末の案内を開く' : '壁中心を見る · 「部屋をスキャン」で端末の案内を開く')
      : (touch ? '画面中央を壁に向ける · 見つからない場合は距離指定へ' : '壁中心を見る · 見つからない場合は距離指定へ');
    return [`壁を探しています · 垂直面 ${this.report.verticalPlanes}`, search];
  }

  diagnostics() {return {...this.report};}
}
