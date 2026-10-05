// Development-only dependency fixture; navigator.xr and browser APIs are untouched.
import * as THREE from 'three';
import { createXRHUD } from '../../src/xr-hud.js';
import { WallPlacement } from '../../src/wall-placement.js';
import { xrSessionOptions } from '../../src/xr-session-options.js';

const el = id => document.getElementById(id);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
el('viewport').append(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x202c40);
const camera = new THREE.PerspectiveCamera(60, 8 / 5, .01, 50);
camera.position.set(0, 1.6, 0); camera.updateMatrixWorld();
const hud = createXRHUD(scene);
const walls = new WallPlacement(scene);
const floor = new THREE.GridHelper(12, 24, 0x62718b, 0x34425a); scene.add(floor);
const stage = new THREE.Group(); scene.add(stage);
const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-1.2, 0, 0), new THREE.Vector3(1.2, 0, 0),
  new THREE.Vector3(1.2, 2.5, 0), new THREE.Vector3(-1.2, 2.5, 0),
]), new THREE.LineBasicMaterial({ color: 0xffad48 }));
stage.add(outline);
const performer = new THREE.Group(); stage.add(performer);
const head = new THREE.Mesh(new THREE.SphereGeometry(.14, 20, 12), new THREE.MeshBasicMaterial({ color: 0xc6b3ff }));
head.position.set(0, 1.42, -.1); performer.add(head);
const body = new THREE.Mesh(new THREE.CylinderGeometry(.12, .23, .7, 16), new THREE.MeshBasicMaterial({ color: 0x9580df }));
body.position.set(0, .89, -.1); performer.add(body);
const referenceSpace = { type: 'local', synthetic: true };
const sessionOptions = xrSessionOptions({ mode: 'live', arSupported: false, vrSupported: true, placementMode: 'auto', overlayRoot: null });
let session, currentFrame, layout = 'full', ended = false, playing = false, recording = false;
let tick, stopped = false, geometryReads = 0, actionCount = 0, lastPlacement = null;
let lastInput = null, lastError = null, failures = [];
const inputPoses = new Map();
const forward = new THREE.Vector3(0, 0, -1);
function pose(matrix) { return { emulatedPosition: false, transform: { matrix: matrix.toArray() } }; }
function makeFrame() {
  camera.updateMatrixWorld();
  return {
    session,
    getViewerPose: () => pose(camera.matrixWorld),
    getPose: space => inputPoses.get(space) ?? null,
    get detectedPlanes() { geometryReads++; throw new Error('VR must not request detectedPlanes'); },
    getDepthInformation() { geometryReads++; throw new Error('VR must not request depth'); },
    getHitTestResults() { geometryReads++; throw new Error('VR must not request hit-test results'); },
  };
}
function actions() {
  const place = { id: 'place', label: 'ここに配置', enabled: !walls.placed && !!walls.candidate };
  const play = { id: 'play', label: playing ? '一時停止' : '再生', enabled: !!walls.placed };
  const reposition = { id: 'reposition', label: '再配置' };
  const record = { id: 'record', label: recording ? '収録終了' : '収録開始' };
  if (layout === 'record') return [record, { id: 'recenter', label: '正面を合わせる', enabled: !recording }];
  if (layout === 'vr') return [walls.placed ? play : place, reposition];
  if (layout === 'disabled') return [{ id: 'scan', label: '部屋をスキャン', enabled: false }];
  return [place, play, reposition, record, { id: 'scan', label: '部屋をスキャン', enabled: false }];
}
function refresh() {
  if (!ended) {
    currentFrame = makeFrame(); walls.update(currentFrame);
    hud.setActions(actions());
    hud.update(camera, recording ? '● REC / 合成モーション収録' : 'VR LIVE / 仮想ステージ',
      recording ? 'ピンチ / トリガーで収録終了' : '視線＋ピンチ / 手・コントローラーに対応', true, recording);
    hud.updatePointers(currentFrame, session.inputSources, referenceSpace);
  }
  stage.visible = !ended && !!walls.placed && !!walls.report.tracking;
}
function begin() {
  ended = false; playing = false; recording = false; layout = 'full'; inputPoses.clear(); hud.resetInputs();
  geometryReads = 0; actionCount = 0; failures = []; lastInput = null; lastError = null; lastPlacement = null;
  session = { visibilityState: 'visible', inputSources: [], enabledFeatures: [...sessionOptions.init.optionalFeatures],
    requestHitTestSource() { geometryReads++; throw new Error('VR must not create a hit-test source'); } };
  walls.start(session, referenceSpace, { mode: 'auto', environment: 'vr', inputMode: sessionOptions.inputMode, width: 2.4, distance: 2 });
  refresh(); snapshot();
}
function dispatch(action) {
  if (!action || action === 'blocked') return;
  actionCount++;
  if (action === 'place') {
    const placed = walls.confirm(currentFrame, null);
    if (!placed) throw new Error('The actual VR wall placement rejected a tracked candidate');
    stage.position.copy(placed.position); stage.quaternion.copy(placed.quaternion); stage.scale.setScalar(placed.width / 2.4);
    lastPlacement = { source: placed.source, position: placed.position.toArray(), width: placed.width };
  } else if (action === 'play') playing = !playing;
  else if (action === 'record') recording = !recording;
  else if (action === 'reposition' || action === 'recenter') { walls.reset(); playing = false; }
  else if (action === 'exit') {
    ended = true; playing = false; recording = false;
    walls.end(); hud.resetInputs(); hud.update(camera, '', '', false);
  }
}
function aimAtAction(id, source) {
  const target = scene.getObjectByName(`xr-hud-${id}-target`);
  if (!target) throw new Error(`HUD action ${id} is not available in the ${layout} layout`);
  // Derive the ray from the actual rendered target geometry after HUD follow.
  // No browser coordinates or fixture-specific target positions are assumed.
  const origin = camera.getWorldPosition(new THREE.Vector3());
  const point = target.getWorldPosition(new THREE.Vector3());
  const quaternion = new THREE.Quaternion().setFromUnitVectors(forward, point.sub(origin).normalize());
  inputPoses.set(source.targetRaySpace, pose(new THREE.Matrix4().compose(origin, quaternion, new THREE.Vector3(1, 1, 1))));
}
function choose(id, { transient = true, cancel = false } = {}) {
  if (ended) begin();
  refresh();
  const source = { targetRayMode: transient ? 'transient-pointer' : 'tracked-pointer', targetRaySpace: {}, handedness: 'right' };
  session.inputSources = [source]; aimAtAction(id, source);
  const startFrame = makeFrame();
  const beforeActions = actionCount;
  hud.beginSelect(startFrame, source, referenceSpace);
  if (transient) inputPoses.delete(source.targetRaySpace);
  if (cancel) hud.endSelect(source);
  const action = hud.selectAction(makeFrame(), source, referenceSpace);
  dispatch(action); hud.endSelect(source); session.inputSources = []; inputPoses.clear();
  const expected = cancel || layout === 'disabled' ? 'blocked' : id;
  if (action !== expected) failures.push(`Expected ${expected}, received ${String(action)}`);
  if (action === 'blocked' && actionCount !== beforeActions) failures.push('Blocked input changed the stage or recording');
  lastInput = { mode: source.targetRayMode, target: id, action, canceled: cancel,
    completionPoseAvailable: !transient, actionsBefore: beforeActions, actionsAfter: actionCount };
  refresh(); snapshot();
}
function snapshot() {
  const report = walls.diagnostics();
  const source = (walls.placed ?? walls.candidate)?.source ?? null;
  const checks = [
    { name: 'AR unavailable + VR available selects immersive-vr', pass: sessionOptions.type === 'immersive-vr' && sessionOptions.inputMode === 'controller' },
    { name: 'VR requests hand input without room geometry or DOM overlay', pass: sessionOptions.init.optionalFeatures.includes('hand-tracking') && !sessionOptions.init.optionalFeatures.some(name => ['plane-detection', 'hit-test', 'depth-sensing', 'dom-overlay'].includes(name)) && !sessionOptions.init.requiredFeatures },
    { name: 'No room geometry APIs are read in VR', pass: geometryReads === 0 },
    { name: 'VR source remains virtual-stage before and after placement', pass: ended || source === 'virtual-stage' },
    { name: 'WallPlacement preserves VR environment and distance mode', pass: report.environment === 'vr' && report.mode === 'distance' },
    { name: 'Room scanning is unavailable for virtual stages', pass: !walls.canRequestRoomCapture() },
    { name: 'Exit hides the HUD and stage', pass: !ended || (!scene.getObjectByName('xr-hud').visible && !stage.visible) },
  ];
  for (const check of checks) if (!check.pass && !failures.includes(check.name)) failures.push(check.name);
  const state = failures.length || lastError ? 'failed' : 'passed';
  el('assertions').dataset.state = state;
  el('assertions').textContent = JSON.stringify({ state, checks, failures }, null, 2);
  el('status').textContent = ended ? '終了：ページへ戻りました（合成テスト）' : `${layout} controls · ${walls.placed ? '仮想ステージ配置済み' : '仮想ステージを配置してください'} · ${recording ? '収録中' : playing ? '再生中' : '待機中'}`;
  el('result').textContent = JSON.stringify({ synthetic: true, hardwareVerified: false, layout, ended, playing, recording,
    sessionOptions, geometryReads, actionCount, lastInput, lastPlacement, currentPlacementSource: source,
    hudActions: scene.getObjectByName('xr-hud').children.map(child => child.name), stageVisible: stage.visible, report, lastError }, null, 2);
}
function safely(callback) {
  try { callback(); } catch (error) { lastError = error.stack || error.message; snapshot(); }
}
el('vision-place').onclick = () => safely(() => { if (ended) begin(); layout = 'full'; if (walls.placed) walls.reset(); refresh(); choose('place'); });
el('vision-record').onclick = () => safely(() => { if (ended) begin(); layout = 'record'; refresh(); choose('record'); });
el('vision-exit').onclick = () => safely(() => choose('exit'));
el('quest-trigger').onclick = () => safely(() => { if (ended) begin(); layout = 'vr'; refresh(); choose(walls.placed ? 'play' : 'place', { transient: false }); });
el('cancel-pinch').onclick = () => safely(() => { if (ended) begin(); layout = 'record'; refresh(); choose('record', { cancel: true }); });
el('disabled-action').onclick = () => safely(() => { if (ended) begin(); layout = 'disabled'; refresh(); choose('scan'); });
for (const [id, value] of [['full-controls', 'full'], ['vr-controls', 'vr'], ['record-controls', 'record']]) {
  el(id).onclick = () => safely(() => { if (ended) begin(); layout = value; refresh(); snapshot(); });
}
el('restart').onclick = () => safely(begin);
function paint(time) {
  if (stopped) return;
  safely(() => { refresh(); performer.position.y = playing ? Math.sin(time / 280) * .06 : 0; snapshot(); renderer.render(scene, camera); });
  tick = requestAnimationFrame(paint);
}
function resize() {
  const { width, height } = el('viewport').getBoundingClientRect();
  renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
window.addEventListener('pagehide', () => { stopped = true; cancelAnimationFrame(tick); walls.end(); hud.dispose(); renderer.dispose(); });
resize(); begin(); tick = requestAnimationFrame(paint);
