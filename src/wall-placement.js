import * as THREE from 'three';
import { intersectWallPlane, buildWallCalibration } from './wall-geometry.js';

const UP = new THREE.Vector3(0, 1, 0);
const VERTICAL_LIMIT = Math.sin(20 * Math.PI / 180);
const pointNames = ['左下', '右下', '左上'];
const matrixOf = pose => new THREE.Matrix4().fromArray(pose.transform.matrix);
const cancelSource = source => {try {source?.cancel();} catch { /* Session may already be inactive. */ }};

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
    this.report = {state: 'not-started'};
    this.visuals.visible = false;
  }

  start(session, referenceSpace, {mode = 'auto', width = 2.4, distance = 2} = {}) {
    this.end();
    this.session = session; this.referenceSpace = referenceSpace;
    this.mode = mode; this.width = width; this.distance = distance;
    this.points = []; this.candidate = null; this.placed = null; this.message = '';
    this.roomAttempted = false; this.viewer = null; this.lastUpdate = -Infinity;
    this.report = {state: 'active', mode, enabledFeatures: session.enabledFeatures ? Array.from(session.enabledFeatures) : null,
      planeAPI: 'waiting', planes: 0, verticalPlanes: 0, hitTest: 'waiting', roomCapture: typeof session.initiateRoomCapture === 'function' ? 'available' : 'unavailable'};
    this.visuals.visible = true;
    this.preview.visible = false; this.dots.forEach(dot => { dot.visible = false; });
    // Feature requests can settle after XR has ended. Dispose late results too.
    if (mode === 'auto') this.setupHitTest(session);
  }

  async setupHitTest(session) {
    if (typeof session.requestHitTestSource !== 'function') {this.report.hitTest = 'unavailable'; return;}
    try {
      const space = await session.requestReferenceSpace('viewer');
      if (this.session !== session) return;
      const source = await session.requestHitTestSource({space, entityTypes: ['plane']});
      if (this.session !== session) {cancelSource(source); return;}
      this.hitSource = source; this.report.hitTest = 'available';
    } catch (error) {
      if (this.session === session) this.report.hitTest = error.name || 'unavailable';
    }
  }

  end() {
    cancelSource(this.hitSource); this.hitSource = null;
    this.session = null; this.candidate = null; this.placed = null;
    this.visuals.visible = false;
    for (const {line} of this.planeViews.values()) {this.visuals.remove(line); line.geometry.dispose();}
    this.planeViews.clear();
    if (this.report.state === 'active') this.report.state = 'ended';
  }

  reset({switchToManual = false} = {}) {
    if (switchToManual) this.mode = 'manual';
    this.points = []; this.placed = null; this.candidate = null; this.message = '';
    this.lastUpdate = -Infinity; this.report.tracking = false;
    this.report.mode = this.mode;
    this.preview.visible = false;
    this.dots.forEach(dot => {dot.visible = false;});
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
    if (this.session.visibilityState !== 'visible') return;
    const pose = frame.getViewerPose(this.referenceSpace);
    if (!pose || pose.emulatedPosition) return;
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
      this.candidate = {point: this.viewer.clone().addScaledVector(direction, this.distance), normal: direction.clone().negate(), source: 'distance'};
    } else {
      this.scanPlanes(frame, {origin: this.viewer, direction});
      if (!this.candidate && this.hitSource) this.scanHits(frame);
    }
    if (this.candidate) {
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
    for (const [plane, {line}] of this.planeViews) {
      if (!planes?.has(plane)) {this.visuals.remove(line); line.geometry.dispose(); this.planeViews.delete(plane);}
    }
    if (!planes) return;
    for (const plane of planes) {
      const pose = frame.getPose(plane.planeSpace, this.referenceSpace);
      if (!pose || pose.emulatedPosition) continue;
      const matrix = matrixOf(pose);
      const normal = new THREE.Vector3(0, 1, 0).transformDirection(matrix);
      if (plane.orientation === 'horizontal' || Math.abs(normal.dot(UP)) > VERTICAL_LIMIT) continue;
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
      const hit = intersectWallPlane(ray, {matrix, polygon: plane.polygon, orientation: plane.orientation});
      if (hit && hit.distance >= .25 && hit.distance <= 8 && (!this.candidate || hit.distance < this.candidate.distance)) {
        this.candidate = {...hit, source: 'plane-detection'};
      }
    }
  }

  scanHits(frame) {
    try {
      for (const result of frame.getHitTestResults(this.hitSource)) {
        const pose = result.getPose(this.referenceSpace);
        if (!pose || pose.emulatedPosition) continue;
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
    if (this.mode !== 'auto' || this.roomAttempted || typeof session?.initiateRoomCapture !== 'function') {
      this.message = '壁が見つからない場合はグリップで3点指定へ'; return;
    }
    this.roomAttempted = true; this.report.roomCapture = 'requested';
    this.message = '端末の部屋スキャン案内を確認してください';
    try {
      await session.initiateRoomCapture();
      if (this.session === session) {this.report.roomCapture = 'completed'; this.message = '';}
    } catch (error) {
      if (this.session === session) {this.report.roomCapture = error.name; this.message = '部屋スキャンを利用できません。グリップで3点指定へ';}
    }
  }

  guidance() {
    if (!this.report.tracking) return ['位置を追跡中', '周囲を見て追跡の復帰を待ってください'];
    if (this.placed) return ['ステージを配置しました', 'トリガーで開演 · グリップで再配置'];
    if (this.message) return ['壁の配置', this.message];
    if (this.mode === 'manual') return [`壁の3点指定 ${this.points.length + 1}/3 · ${pointNames[this.points.length]}`, '緑の点を指定位置に合わせてトリガー'];
    if (this.candidate) return [this.mode === 'distance' ? '指定距離で配置（壁検出なし）' : '壁の候補を検出', '枠の位置でトリガー → 配置 · もう一度で開演'];
    if (this.report.planeAPI !== 'available' && !['available', 'waiting'].includes(this.report.hitTest)) return ['壁情報を取得できません', 'グリップでコントローラーによる3点指定へ'];
    return [`壁を探しています · 垂直面 ${this.report.verticalPlanes}`, this.report.roomCapture === 'available' ? '壁中心を見る · トリガーで部屋スキャン' : '壁中心を見る · グリップで3点指定へ'];
  }

  diagnostics() {return {...this.report};}
}
