// Development-only fixture. No navigator.xr or camera APIs are replaced.
// Production WallPlacement receives explicit synthetic frame dependencies.
import * as THREE from 'three';
import { WallPlacement } from '../../src/wall-placement.js';

const el = id => document.getElementById(id);
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
el('viewport').append(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x202c40);
const camera = new THREE.PerspectiveCamera(60, 8 / 5, .01, 50);
camera.position.set(0, 1.6, 0); camera.updateMatrixWorld();
const placement = new WallPlacement(scene);
const referenceSpace = { type: 'local', synthetic: true };
const vertical = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const identity = new THREE.Matrix4().toArray();
function pose(position = [0, 1.6, 0], quaternion = new THREE.Quaternion()) {
  return { emulatedPosition: false, transform: { matrix: new THREE.Matrix4().compose(
    new THREE.Vector3(...position), quaternion, new THREE.Vector3(1, 1, 1),
  ).toArray() } };
}
function plane(name, position, { horizontal = false, label = 'wall' } = {}) {
  return {
    value: { planeSpace: { name }, orientation: horizontal ? 'horizontal' : 'vertical', semanticLabel: label, lastChangedTime: 1,
      polygon: [{ x: -3, y: 0, z: -3 }, { x: 3, y: 0, z: -3 }, { x: 3, y: 0, z: 3 }, { x: -3, y: 0, z: 3 }] },
    pose: pose(position, horizontal ? new THREE.Quaternion() : vertical),
  };
}
const wall = plane('synthetic wall', [0, 1.6, -2]);
const floor = plane('synthetic floor', [0, 0, -2], { horizontal: true, label: 'floor' });
const furniture = plane('synthetic couch', [0, 1.6, -1], { label: 'couch' });
const stage = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-1.2, 0, 0), new THREE.Vector3(1.2, 0, 0),
  new THREE.Vector3(1.2, 2.5, 0), new THREE.Vector3(-1.2, 2.5, 0),
]), new THREE.LineBasicMaterial({ color: 0xffad48 }));
scene.add(stage); stage.visible = false;
const target = new THREE.Mesh(new THREE.PlaneGeometry(6, 6), new THREE.MeshBasicMaterial({ color: 0x304561, side: THREE.DoubleSide }));
target.position.set(0, 1.6, -2.03); scene.add(target);
const aim = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(-.025, 0, -1), new THREE.Vector3(.025, 0, -1),
  new THREE.Vector3(0, -.025, -1), new THREE.Vector3(0, .025, -1),
]), new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false }));
aim.position.y = 1.6; scene.add(aim);

let scenario = 'native-wall', session, currentFrame, tick, stopped = false;
let startedAt = 0, frameCount = 0, roomCalls = 0, roomCaptured = false, lastAction = 'start', lastError = null;
let lost = false, depthStates = [], failures = [];
function makeSession() {
  const noGeometry = scenario === 'no-apis';
  const depthOnly = scenario === 'depth-wall';
  const current = { visibilityState: 'visible', enabledFeatures: noGeometry ? [] : depthOnly ? ['depth-sensing'] : ['plane-detection', 'hit-test'] };
  if (depthOnly) current.depthUsage = 'cpu-optimized';
  if (!noGeometry && !depthOnly) {
    current.requestReferenceSpace = async type => ({ type, synthetic: true });
    current.requestHitTestSource = async () => ({ cancel() {} });
    current.initiateRoomCapture = async () => {
      roomCalls++;
      // Complete asynchronously, like the browser API, without any OS prompt.
      await Promise.resolve();
      if (session === current) roomCaptured = true;
    };
  }
  return current;
}
function makeFrame() {
  const viewer = pose();
  viewer.views = [{ eye: 'none', projectionMatrix: camera.projectionMatrix.toArray(), transform: viewer.transform }];
  const value = { session, getViewerPose: () => lost ? null : viewer, getPose: () => null };
  if (scenario === 'depth-wall') {
    value.getDepthInformation = () => ({ width: 320, height: 240,
      normDepthBufferFromNormView: { matrix: identity }, getDepthInMeters: () => 2 });
  } else if (scenario !== 'no-apis') {
    const planes = scenario === 'floor-only' ? [floor] : scenario === 'furniture' ? [furniture, wall]
      : scenario === 'scan-waiting' && !roomCaptured ? [] : [wall];
    value.detectedPlanes = new Set(planes.map(item => item.value));
    const positions = new Map(planes.map(item => [item.value.planeSpace, item.pose]));
    value.getPose = space => positions.get(space) ?? null;
    value.getHitTestResults = () => scenario === 'floor-only' ? [{ getPose: () => floor.pose }]
      : scenario === 'furniture' ? [{ getPose: () => furniture.pose }] : [];
  }
  return value;
}
function begin(next) {
  scenario = next; lost = false; startedAt = performance.now(); frameCount = 0;
  roomCalls = 0; roomCaptured = false; depthStates = []; failures = []; lastError = null;
  lastAction = `scenario: ${scenario}`; session = makeSession();
  placement.start(session, referenceSpace, { mode: 'auto', inputMode: 'touch', width: 2.4 });
  stage.visible = false;
  target.visible = ['native-wall', 'depth-wall', 'scan-waiting'].includes(scenario);
}
function snapshot(time) {
  const report = placement.diagnostics();
  if (report.depth && depthStates.at(-1) !== report.depth) depthStates.push(report.depth);
  const candidate = placement.candidate;
  const placed = placement.placed;
  const scanAvailable = placement.canRequestRoomCapture();
  el('confirm').disabled = !!placed || !candidate || !report.tracking;
  el('room-scan').disabled = !scanAvailable;
  const checks = [];
  const check = (name, pass) => { checks.push({ name, pass }); if (!pass && !failures.includes(name)) failures.push(name); };
  check('candidate coordinates and rotation remain finite', !candidate || [...candidate.point.toArray(), ...candidate.normal.toArray(), ...candidate.quaternion.toArray()].every(Number.isFinite));
  check('no placement button without a tracked candidate', !el('confirm').disabled === (!!candidate && !placed && !!report.tracking));
  check('room scan action follows actual availability even without a wall', !el('room-scan').disabled === scanAvailable);
  check('room scan is at most once per synthetic session', roomCalls <= 1);
  if (lost) {
    check('tracking loss hides candidates and the placed stage', !candidate && !placement.preview.visible && !stage.visible && !report.tracking);
  } else if (scenario === 'native-wall' || (scenario === 'scan-waiting' && roomCaptured)) {
    check('native wall uses plane detection', (placed ?? candidate)?.source === 'plane-detection');
  } else if (scenario === 'depth-wall') {
    if (time - startedAt >= 500) check('depth-only frames produce a stable measured wall', (placed ?? candidate)?.source === 'depth-sensing');
    else check('depth does not place before stabilization', !placed);
  } else {
    check('floor, unavailable data, furniture, or unscanned room never produce a wall', !candidate && !placed);
  }
  if (candidate) check('wall normal faces the viewer', candidate.normal.z > .99);
  if (placed) check('confirmed stage retains the measured two-metre wall', Math.abs(placed.position.z + 2) < 1e-5);
  const state = failures.length ? 'failed' : scenario === 'depth-wall' && time - startedAt < 500 ? 'waiting' : 'passed';
  el('assertions').dataset.state = state;
  el('assertions').textContent = JSON.stringify({ state, checks, failures }, null, 2);
  el('status').textContent = `${lost ? 'tracking-lost' : scenario}: ${placement.guidance().join(' — ')}`;
  el('result').textContent = JSON.stringify({ input: 'synthetic XR frames; no camera or device session',
    scenario, trackingLost: lost, elapsedMs: Math.round(time - startedAt), frameCount, lastAction, lastError,
    candidate: candidate ? { source: candidate.source, point: candidate.point.toArray(), normal: candidate.normal.toArray() } : null,
    placed: placed ? { source: placed.source, position: placed.position.toArray(), width: placed.width } : null,
    previewVisible: placement.preview.visible, stageVisible: stage.visible, scanAvailable, roomCalls, roomCaptured, depthStates, report }, null, 2);
}
function paint(time) {
  if (stopped) return;
  try {
    currentFrame = makeFrame(); placement.update(currentFrame, time); frameCount++;
    stage.visible = !!placement.placed && !!placement.report.tracking;
    if (placement.placed) {
      stage.position.copy(placement.placed.position); stage.quaternion.copy(placement.placed.quaternion);
      stage.scale.setScalar(placement.placed.width / 2.4);
    }
    snapshot(time); renderer.render(scene, camera);
  } catch (error) {
    lastError = error.stack || error.message; failures.push(lastError);
    el('assertions').dataset.state = 'failed'; el('assertions').textContent = lastError;
    el('result').textContent = JSON.stringify({ scenario, lastError }, null, 2);
  }
  tick = requestAnimationFrame(paint);
}
for (const id of ['native-wall', 'depth-wall', 'floor-only', 'no-apis', 'furniture', 'scan-waiting']) el(id).addEventListener('click', () => begin(id));
el('tracking-lost').addEventListener('click', () => { lost = true; lastAction = 'tracking lost'; });
el('reset').addEventListener('click', () => {
  placement.reset(); startedAt = performance.now(); frameCount = 0; depthStates = []; failures = [];
  lastAction = 'reset placement'; stage.visible = false;
});
el('confirm').addEventListener('click', () => { placement.confirm(currentFrame, null); lastAction = 'confirm placement'; });
el('room-scan').addEventListener('click', () => { placement.requestRoomCapture(); lastAction = 'request room scan'; });
function resize() {
  const { width, height } = el('viewport').getBoundingClientRect();
  renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
window.addEventListener('pagehide', () => { stopped = true; cancelAnimationFrame(tick); placement.end(); renderer.dispose(); });
resize(); begin('native-wall'); tick = requestAnimationFrame(paint);
