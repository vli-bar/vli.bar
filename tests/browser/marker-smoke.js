// Development-only dependency injection; never a production app entry point.
import * as THREE from 'three';
import { MarkerAR } from '../../src/marker-ar.js';
import { fitCameraFrame, markerAudiencePose, placeMarkerStage } from '../../src/marker-stage.js';

const el = id => document.getElementById(id), source = el('source'), context = source.getContext('2d');
const markerImage = new Image(); markerImage.src = '/markers/stage.svg';
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0, 0); el('viewport').append(renderer.domElement);
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45, 4 / 3, .01, 100), stage = new THREE.Group();
scene.add(stage);
function outline(points, color) { return new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points.map(point => new THREE.Vector3(...point))), new THREE.LineBasicMaterial({ color, depthTest: false })); }
stage.add(outline([[-1.2, 0, 0], [1.2, 0, 0], [1.2, 2.5, 0], [-1.2, 2.5, 0]], 0xffad48));
// Width=1 stage scales by 1/2.4. This outline is 15 cm after that scale.
stage.add(outline([[-.18, 1.43, .001], [.18, 1.43, .001], [.18, 1.07, .001], [-.18, 1.07, .001]], 0x00ffff));
const axes = new THREE.AxesHelper(.5); axes.position.y = 1.25; stage.add(axes);
const transitions = [];
let stream, timer, frame, visible = true, rotation = 0, token = 0, error = null;
const tracker = new MarkerAR({ video: el('video'), onStatus(event) {
  transitions.push(event.state); el('status').textContent = event.message; el('transitions').textContent = transitions.join(' → ');
  if (['error', 'hidden', 'ended', 'interrupted'].includes(event.state)) finish();
}, deps: { mediaDevices: { getUserMedia() { stream = source.captureStream(20); return Promise.resolve(stream); } } } });
function draw() {
  context.fillStyle = '#b5bdc5'; context.fillRect(0, 0, source.width, source.height);
  if (visible) { context.save(); context.translate(source.width / 2, source.height / 2); context.rotate(rotation);
    context.imageSmoothingEnabled = false; context.drawImage(markerImage, -40, -40, 80, 80); context.restore(); }
  context.fillStyle = '#18273b'; context.font = '14px monospace'; context.fillText(`synthetic ${Math.round(performance.now())}`, 8, 20);
}
function controls(active) { el('start').disabled = active; for (const id of ['stop', 'hide', 'show', 'rotate', 'portrait', 'landscape']) el(id).disabled = !active; }
function paint(time) {
  tracker.update(time); stage.visible = tracker.tracked;
  if (tracker.ready) {
    camera.fov = tracker.cameraFov; camera.aspect = tracker.aspect; camera.updateProjectionMatrix();
    const rect = fitCameraFrame(tracker.width, tracker.height, Math.min(document.body.clientWidth, 800), 540);
    el('viewport').style.width = `${rect.width}px`; el('viewport').style.height = `${rect.height}px`; renderer.setSize(rect.width, rect.height, false);
    el('dimensions').textContent = `${tracker.width} × ${tracker.height}`;
  }
  error = null;
  if (tracker.tracked) {
    placeMarkerStage(stage, tracker.pose, 1);
    const middle = new THREE.Vector3(0, 1.25, 0).applyMatrix4(stage.matrixWorld).project(camera);
    error = Math.hypot(middle.x * tracker.width / 2, middle.y * tracker.height / 2);
    el('alignment').textContent = `${error.toFixed(3)} px center; determinant ${tracker.pose.determinant().toFixed(6)}`;
  } else el('alignment').textContent = 'hidden';
  const audience = markerAudiencePose(camera, stage, tracker.tracked);
  el('tracked').textContent = String(tracker.tracked); el('tracks').textContent = stream?.getTracks().map(track => track.readyState).join(', ') ?? 'none';
  el('result').textContent = JSON.stringify({ active: tracker.active, ready: tracker.ready, tracked: tracker.tracked, marker: 'ARUCO_MIP_36h12 ID 0', input: 'local SVG through canvas.captureStream; no camera',
    centerErrorPixels: error, frame: [tracker.width, tracker.height], pose: tracker.tracked ? tracker.pose.elements : null, audience, transitions }, null, 2);
  renderer.render(scene, camera);
  if (tracker.active) frame = requestAnimationFrame(paint);
}
function finish() { token++; tracker.stop(); clearInterval(timer); cancelAnimationFrame(frame); stage.visible = false; controls(false); paint(performance.now()); }
el('start').addEventListener('click', async () => {
  const current = ++token; controls(true);
  try {
    await markerImage.decode(); if (current !== token) return;
    visible = true; rotation = 0; draw(); timer = setInterval(draw, 50);
    await tracker.start(); if (current !== token) return; paint(performance.now());
  } catch (error) { finish(); el('status').textContent = `Failed: ${error.message}`; }
});
el('stop').addEventListener('click', finish);
el('hide').addEventListener('click', () => { visible = false; draw(); });
el('show').addEventListener('click', () => { visible = true; draw(); });
el('rotate').addEventListener('click', () => { rotation += Math.PI / 2; draw(); });
for (const [id, w, h] of [['portrait', 360, 640], ['landscape', 640, 480]]) el(id).addEventListener('click', () => { source.width = w; source.height = h; draw(); });
window.addEventListener('pagehide', () => { finish(); tracker.dispose(); renderer.dispose(); });
