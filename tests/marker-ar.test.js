import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import aruco from 'js-aruco2';
import { DEFAULT_MARKER_SIZE, MARKER_DICTIONARY, MarkerAR, createMarkerDetector, estimateMarkerPose, markerProjection } from '../src/marker-ar.js';

const width = 640, height = 480, size = DEFAULT_MARKER_SIZE;
const model = [[-size / 2, size / 2], [size / 2, size / 2], [size / 2, -size / 2], [-size / 2, -size / 2]];
const project = (matrix, w = width, h = height) => model.map(([x, y]) => {
  const p = new Vector3(x, y, 0).applyMatrix4(matrix);
  return { x: w / 2 - w * p.x / p.z, y: h / 2 + w * p.y / p.z };
});
const pose = (angles = [0, 0, 0], translation = [0, 0, -.7]) => new Matrix4().compose(new Vector3(...translation), new Quaternion().setFromEuler(new Euler(...angles)), new Vector3(1, 1, 1));
const goodCorners = project(pose());
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

class Video extends EventTarget {
  constructor() { super(); Object.assign(this, { readyState: 4, videoWidth: width, videoHeight: height, currentTime: 0, srcObject: null, pauses: 0 }); }
  play() { return Promise.resolve(); }
  pause() { this.pauses++; }
  setAttribute() {}
}
class Track extends EventTarget {
  constructor() { super(); this.readyState = 'live'; this.stops = 0; }
  stop() { this.readyState = 'ended'; this.stops++; }
}
function stream() { const track = new Track(); return { track, getTracks: () => [track], getVideoTracks: () => [track] }; }
function rig(options = {}) {
  const video = new Video(), doc = new EventTarget(), input = stream(), statuses = [], draws = [], requests = [];
  doc.visibilityState = 'visible';
  const detection = { markers: [{ id: 0, corners: goodCorners }], calls: 0 };
  const context = { drawImage: (...args) => draws.push(args), getImageData: () => ({ width, height, data: new Uint8ClampedArray(0) }) };
  const canvas = { width: 0, height: 0, getContext: () => context };
  const tracker = new MarkerAR({ video, onStatus: e => statuses.push(e), deps: { document: doc, isSecureContext: true,
    mediaDevices: { getUserMedia: request => { requests.push(request); return Promise.resolve(input); } },
    createCanvas: () => canvas, createDetector: () => ({ detect: () => { detection.calls++; return detection.markers; } }), ...options.deps }, ...options.config });
  return { tracker, video, doc, input, statuses, draws, requests, detection, canvas, context };
}

test('known 3D corner projections recover metric position, rotations, and a right-handed front-facing marker', () => {
  for (const angles of [[0, 0, 0], [.3, -.4, .2], [-.45, .5, -.8], [0, 0, Math.PI], [.75, -.3, 1.2]]) {
    const expected = pose(angles, [.07, .03, -.7]);
    const actual = estimateMarkerPose(project(expected), { width, height });
    assert.ok(actual);
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(actual.elements[i] - expected.elements[i]) < .012, `matrix element ${i}, angles ${angles}`);
    assert.ok(Math.abs(actual.determinant() - 1) < 1e-6);
    assert.ok(actual.elements[14] < 0, 'the stage is in front of the camera');
    const center = new Vector3().setFromMatrixPosition(actual);
    const normal = new Vector3(0, 0, 1).transformDirection(actual);
    assert.ok(normal.dot(center.negate()) > 0, '+Z points out of the printed front toward the viewer');
    const raised = new Vector3(0, .05, 0).applyMatrix4(actual);
    if (angles[2] === 0) assert.ok(raised.y > actual.elements[13], '+Y is up');
  }
});

test('projection matches pinhole geometry in landscape and portrait without cropping', () => {
  for (const [w, h] of [[640, 480], [360, 640], [640, 360]]) {
    const projection = markerProjection(w, h);
    assert.equal(projection.focalLength, w);
    assert.equal(projection.aspect, w / h);
    assert.ok(Math.abs(Math.tan(projection.cameraFov * Math.PI / 360) - h / (2 * w)) < 1e-12);
    const expected = pose([.2, -.3, .1]);
    const actual = estimateMarkerPose(project(expected, w, h), { width: w, height: h });
    assert.ok(actual);
    assert.ok(Math.abs(actual.elements[14] + .7) < .002);
  }
  assert.throws(() => markerProjection(0, 480));
});

test('pose rejects degenerate, mirrored, clipped, nonfinite, behind-camera and non-rigid estimates', () => {
  for (const corners of [null, [], goodCorners.slice(0, 3), goodCorners.map(() => ({ x: 1, y: 1 })), [...goodCorners].reverse(),
    [{ x: NaN, y: 1 }, ...goodCorners.slice(1)], [{ x: -1, y: 1 }, ...goodCorners.slice(1)],
    [goodCorners[0], goodCorners[2], goodCorners[1], goodCorners[3]]]) assert.equal(estimateMarkerPose(corners, { width, height }), null);
  const identity = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (const [rotation, translation] of [[identity, [0, 0, -.7]], [identity, [0, 0, Infinity]],
    [[[1, 0, 0], [0, 1, 0], [0, 0, -1]], [0, 0, .7]], [[[2, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, .7]],
    [identity, [0, 0, 50]], [identity, [0, 0, 101]]]) {
    assert.equal(estimateMarkerPose(goodCorners, { width, height, solver: { pose: () => ({ bestRotation: rotation, bestTranslation: translation }) } }), null);
  }
});

// Render the actual checked-in SVG's cells through a 3D pinhole transform into
// raw pixels. Detection is js-aruco2 itself, with no stub corner/ID output.
function rasterMarker(svg, matrix, background = 220) {
  const cells = Array.from({ length: 10 }, () => Array(10).fill(255));
  for (const match of svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" fill="(white|black)"/g)) {
    const [, x, y, w, h, color] = match;
    for (let py = +y; py < +y + +h; py++) for (let px = +x; px < +x + +w; px++) cells[py][px] = color === 'white' ? 255 : 0;
  }
  const data = new Uint8ClampedArray(width * height * 4), inverse = matrix.clone().invert(), origin = new Vector3().applyMatrix4(inverse);
  const ray = new Vector3(), hit = new Vector3();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    ray.set((x + .5 - width / 2) / width, (height / 2 - y - .5) / width, -1).transformDirection(inverse);
    hit.copy(ray).multiplyScalar(-origin.z / ray.z).add(origin);
    const cx = Math.floor((hit.x / size + .5) * 8 + 1), cy = Math.floor((.5 - hit.y / size) * 8 + 1);
    const value = cx >= 0 && cx < 10 && cy >= 0 && cy < 10 ? cells[cy][cx] : background;
    const offset = (y * width + x) * 4; data[offset] = data[offset + 1] = data[offset + 2] = value; data[offset + 3] = 255;
  }
  return { width, height, data };
}

test('printed marker pixels detect ID 0 at all quarter rotations and oblique camera poses', async () => {
  const svg = await readFile(new URL('../public/markers/stage.svg', import.meta.url), 'utf8');
  assert.match(svg, /width="187\.5mm" height="187\.5mm"/);
  assert.match(svg, /x="1" y="1" width="8" height="8" fill="black"/);
  const detector = createMarkerDetector();
  for (const angles of [[0, 0, 0], [0, 0, Math.PI / 2], [0, 0, Math.PI], [0, 0, -Math.PI / 2], [.4, -.5, .2], [-.3, .45, -.7]]) {
    const matrix = pose(angles, [.015, .01, -.55]);
    const markers = detector.detect(rasterMarker(svg, matrix));
    assert.deepEqual(markers.map(marker => marker.id), [0], `rotation ${angles}`);
    const expectedCorners = project(matrix);
    markers[0].corners.forEach((corner, i) => assert.ok(Math.hypot(corner.x - expectedCorners[i].x, corner.y - expectedCorners[i].y) < 3, 'canonical corner order survives rotation'));
    const found = estimateMarkerPose(markers[0].corners, { width, height });
    assert.ok(found);
    assert.ok(Math.abs(found.elements[14] + .55) < .02, 'metric distance survives rasterization');
  }
  assert.deepEqual(detector.detect({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(255) }), []);
});

test('small printed markers retain their black contour beside the white paper margin', async () => {
  const svg = await readFile(new URL('../public/markers/stage.svg', import.meta.url), 'utf8');
  const detector = createMarkerDetector();
  // Exactly the integration fixture: 50px SVG including margin, black 40px,
  // centered on grey. Upstream merges this with the white margin's contour.
  const regression = rasterMarker(svg, pose([0, 0, 0], [0, 0, -2.4]), 195);
  const upstream = new aruco.AR.Detector({ dictionaryName: MARKER_DICTIONARY, maxHammingDistance: 2 });
  assert.deepEqual(upstream.detect(regression), [], 'fixture exercises the upstream contour deduplication bug');
  assert.deepEqual(detector.detect(regression).map(marker => marker.id), [0]);
  for (const blackPixels of [32, 40, 48, 64, 128]) for (const background of [30, 195, 220, 255]) {
    const distance = width * size / blackPixels;
    for (const angles of [[0, 0, 0], [0, 0, Math.PI / 2], [.3, -.4, .2]]) {
      const markers = detector.detect(rasterMarker(svg, pose(angles, [0, 0, -distance]), background));
      assert.deepEqual(markers.map(marker => marker.id), [0], `${blackPixels}px marker, background ${background}, angles ${angles}`);
      const found = estimateMarkerPose(markers[0].corners, { width, height });
      assert.ok(found, 'detected corners yield a valid metric pose');
      assert.ok(Math.abs(found.elements[14] + distance) < distance * .08, 'distance error remains bounded at low resolution');
    }
  }
});

test('camera requests only video, caps full-frame detection at 15fps and hides stale tracking', async () => {
  const r = rig();
  assert.equal(await r.tracker.start(), true);
  assert.equal(r.requests[0].audio, false);
  assert.equal(r.requests[0].video.facingMode.ideal, 'environment');
  assert.equal(r.video.playsInline, true);
  assert.equal(r.video.defaultMuted, true);
  assert.equal(r.tracker.update(0), true);
  r.video.currentTime = .02; r.tracker.update(20);
  assert.equal(r.detection.calls, 1);
  r.video.currentTime = .07; r.tracker.update(70);
  assert.equal(r.detection.calls, 2);
  r.tracker.update(160);
  assert.equal(r.detection.calls, 2, 'duplicate video frame not analyzed');
  assert.equal(r.tracker.update(271), false, 'a stalled video must also expire tracking');
  assert.equal(r.statuses.at(-1).state, 'lost');
  r.detection.markers = [{ id: 1, corners: goodCorners }]; r.video.currentTime = .3;
  assert.equal(r.tracker.update(300), false, 'a different valid marker is ignored');
  r.detection.markers = [{ id: 0, corners: goodCorners }]; r.video.currentTime = .4;
  assert.equal(r.tracker.update(400), true);
  assert.deepEqual(r.draws[0].slice(1), [0, 0, 640, 480]);
  r.tracker.stop();
  assert.equal(r.input.track.readyState, 'ended'); assert.equal(r.video.srcObject, null);
  assert.equal(r.tracker.active, false); assert.equal(r.tracker.tracked, false);
});

test('rotation/metadata resize preserves the full frame and rebuilds the projection', async () => {
  const r = rig(); r.video.videoWidth = 1920; r.video.videoHeight = 1080;
  await r.tracker.start();
  assert.deepEqual([r.tracker.width, r.tracker.height], [640, 360]);
  r.tracker.update(0);
  r.video.videoWidth = 1080; r.video.videoHeight = 1920; r.video.currentTime = .01;
  r.detection.markers = [];
  r.tracker.update(10);
  assert.deepEqual([r.tracker.width, r.tracker.height], [360, 640]);
  assert.equal(r.tracker.aspect, 360 / 640); assert.equal(r.tracker.tracked, false);
  assert.equal(r.draws.at(-1).length, 5, 'drawImage uses the entire source, with no crop rectangle');
  assert.deepEqual(r.draws.at(-1).slice(1), [0, 0, 360, 640]);
  r.tracker.dispose();
});

test('stop cancels an unanswered permission prompt and closes a stream arriving later', async () => {
  const permission = deferred(), late = stream();
  const r = rig({ deps: { mediaDevices: { getUserMedia: () => permission.promise } } });
  const starting = r.tracker.start();
  assert.equal(r.tracker.active, true); r.tracker.stop();
  assert.equal(await starting, false);
  permission.resolve(late); await flush();
  assert.equal(late.track.stops, 1); assert.equal(r.video.srcObject, null);
});

test('a replaced permission request cannot stop the current camera or overwrite its pose', async () => {
  const first = deferred(), stale = stream(), current = stream(); let calls = 0;
  const r = rig({ deps: { mediaDevices: { getUserMedia: () => ++calls === 1 ? first.promise : Promise.resolve(current) } } });
  const pending = r.tracker.start();
  assert.equal(await r.tracker.start(), true); assert.equal(await pending, false);
  assert.equal(r.tracker.update(0), true);
  first.resolve(stale); await flush();
  assert.equal(stale.track.stops, 1); assert.equal(current.track.stops, 0);
  assert.equal(r.video.srcObject, current); assert.equal(r.tracker.tracked, true);
  r.tracker.stop();
});

test('stop during video play or metadata startup releases the camera promptly', async () => {
  for (const stage of ['play', 'metadata']) {
    const r = rig(), pendingPlay = deferred();
    if (stage === 'play') r.video.play = () => pendingPlay.promise;
    else { r.video.readyState = 0; r.video.videoWidth = 0; }
    const starting = r.tracker.start(); await flush();
    r.tracker.stop(); assert.equal(await starting, false);
    assert.equal(r.input.track.readyState, 'ended'); assert.equal(r.video.srcObject, null);
    pendingPlay.resolve(); await flush(); assert.equal(r.tracker.ready, false);
  }
});

test('hidden pages, interrupted or ended camera, video errors and detector errors release all media', async () => {
  for (const trigger of ['hidden', 'ended', 'mute', 'video', 'detector']) {
    const r = rig(); await r.tracker.start(); r.tracker.update(0);
    if (trigger === 'hidden') { r.doc.visibilityState = 'hidden'; r.doc.dispatchEvent(new Event('visibilitychange')); }
    if (trigger === 'ended') r.input.track.dispatchEvent(new Event('ended'));
    if (trigger === 'mute') r.input.track.dispatchEvent(new Event('mute'));
    if (trigger === 'video') r.video.dispatchEvent(new Event('error'));
    if (trigger === 'detector') { r.context.getImageData = () => { throw new Error('read failed'); }; r.video.currentTime = .1; r.tracker.update(100); }
    assert.equal(r.tracker.active, false); assert.equal(r.tracker.tracked, false);
    assert.equal(r.input.track.readyState, 'ended'); assert.equal(r.video.srcObject, null);
    assert.ok(['hidden', 'interrupted', 'ended', 'error'].includes(r.statuses.at(-1).state));
  }
});

test('permission denial, invalid size, insecure context and expired lifecycle are explicit failures', async () => {
  const error = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const r = rig({ deps: { mediaDevices: { getUserMedia: () => Promise.reject(error) } } });
  await assert.rejects(r.tracker.start(), error);
  assert.equal(r.tracker.active, false); assert.match(r.statuses.at(-1).message, /許可/);
  for (const markerSize of [0, .01, 2, NaN, Infinity]) await assert.rejects(r.tracker.start({ markerSize }));
  const insecure = rig({ deps: { isSecureContext: false } }); await assert.rejects(insecure.tracker.start(), /HTTPS/);
  assert.equal(insecure.requests.length, 0);
  const hidden = rig(); hidden.doc.visibilityState = 'hidden'; await assert.rejects(hidden.tracker.start(), /表示/);
  r.tracker.dispose(); await assert.rejects(r.tracker.start(), /終了/);
});

test('status handlers can stop startup and tracking without leaking or returning stale state', async () => {
  const r = rig(); r.tracker.onStatus = event => { if (event.state === 'starting') r.tracker.stop(); };
  assert.equal(await r.tracker.start(), false); assert.equal(r.requests.length, 0);
  r.tracker.onStatus = event => { if (event.state === 'tracking') r.tracker.stop(); };
  assert.equal(await r.tracker.start(), true); assert.equal(r.tracker.update(0), false);
  assert.equal(r.input.track.readyState, 'ended'); assert.equal(r.tracker.active, false);
});
