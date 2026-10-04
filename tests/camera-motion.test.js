import test from 'node:test';
import assert from 'node:assert/strict';
import { CameraMotion } from '../src/camera-motion.js';

const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
class Events {
  listeners = new Map();
  addEventListener(name, callback) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(callback); }
  removeEventListener(name, callback) { this.listeners.get(name)?.delete(callback); }
  emit(name) { for (const cb of [...(this.listeners.get(name) ?? [])]) cb({ type: name }); }
  get listenerCount() { return [...this.listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0); }
}
function stream() {
  const track = Object.assign(new Events(), { readyState: 'live', stops: 0, stop() { this.readyState = 'ended'; this.stops++; } });
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
function fixture({ nativeFrames = true, ready = true, media, vision, detect } = {}) {
  let now = 1000, nextHandle = 0;
  const frames = new Map(), timers = new Map(), statuses = [], results = [], calls = [];
  const cameraStream = stream();
  const doc = Object.assign(new Events(), { visibilityState: 'visible' });
  const video = Object.assign(new Events(), {
    readyState: ready ? 2 : 0, videoWidth: ready ? 640 : 0, videoHeight: ready ? 480 : 0, currentTime: 0,
    srcObject: null, pauses: 0, setAttribute() {}, play() { calls.push(['play']); return Promise.resolve(); }, pause() { this.pauses++; },
  });
  const enqueue = callback => { const handle = ++nextHandle; frames.set(handle, callback); return handle; };
  const cancel = handle => frames.delete(handle);
  if (nativeFrames) { video.requestVideoFrameCallback = enqueue; video.cancelVideoFrameCallback = cancel; }
  const task = { closed: 0, close() { this.closed++; }, detectForVideo(input, timestamp) { calls.push(['detect', input, timestamp]); return detect?.(input, timestamp) ?? { landmarks: [[]], worldLandmarks: [[]] }; } };
  const api = {
    FilesetResolver: { forVisionTasks(url) { calls.push(['wasm', url]); return Promise.resolve({ wasm: true }); } },
    PoseLandmarker: { createFromOptions(files, options) { calls.push(['model', files, options]); return Promise.resolve(task); } },
  };
  const camera = new CameraMotion({ video, onStatus: status => statuses.push(status), onFrame: (...args) => results.push(args), maxFps: 15,
    wasmBaseUrl: 'https://example.test/vli.bar/vendor/mediapipe/wasm', modelAssetUrl: 'https://example.test/vli.bar/vendor/mediapipe/pose_landmarker_lite.task',
    deps: {
      document: doc, isSecureContext: true,
      mediaDevices: { getUserMedia(constraints) { calls.push(['media', constraints]); return media?.() ?? Promise.resolve(cameraStream); } },
      loadVision() { calls.push(['import']); return vision?.(api) ?? Promise.resolve(api); },
      requestAnimationFrame: enqueue, cancelAnimationFrame: cancel, now: () => now,
      setTimeout(callback) { const handle = ++nextHandle; timers.set(handle, callback); return handle; }, clearTimeout: handle => timers.delete(handle),
    },
  });
  return { camera, cameraStream, doc, video, task, api, calls, results, statuses, frames, timers,
    async frame(time, videoTime) { now = time; video.currentTime = videoTime; const [handle, callback] = frames.entries().next().value ?? []; assert.ok(callback, 'a frame is scheduled'); frames.delete(handle); callback(time); await flush(); },
  };
}

test('camera and model load only on start, use local CPU assets and forward unmirrored video frames', async () => {
  const f = fixture();
  assert.equal(f.calls.length, 0); assert.equal(f.camera.active, false);
  const start = f.camera.start({ facingMode: 'environment' });
  assert.equal(f.calls[0][0], 'media', 'camera is requested before yielding the click gesture');
  assert.equal(f.calls[0][1].audio, false);
  assert.equal(f.calls[0][1].video.facingMode.ideal, 'environment');
  assert.equal(await start, true); assert.equal(f.camera.ready, true);
  assert.deepEqual(f.calls.map(call => call[0]), ['media', 'play', 'import', 'wasm', 'model']);
  const options = f.calls.find(call => call[0] === 'model')[2];
  assert.equal(options.baseOptions.delegate, 'CPU'); assert.equal(options.runningMode, 'VIDEO'); assert.equal(options.numPoses, 1);
  assert.equal(options.outputSegmentationMasks, false);
  assert.match(options.baseOptions.modelAssetPath, /^https:\/\/example.test\/vli.bar\/vendor\//);
  await f.frame(1000, 0);
  assert.equal(f.calls.find(call => call[0] === 'detect')[1], f.video);
  assert.equal(f.results.length, 1); assert.equal(f.results[0][1], 1000);
  assert.deepEqual(f.statuses.map(s => s.state), ['starting', 'loading', 'ready']);
  f.camera.dispose();
  assert.equal(f.cameraStream.track.stops, 1); assert.equal(f.task.closed, 1); assert.equal(f.frames.size, 0);
});

test('permission rejection reports an error without loading MediaPipe and insecure contexts never prompt', async () => {
  const error = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
  const f = fixture({ media: () => Promise.reject(error) });
  await assert.rejects(f.camera.start(), error);
  assert.equal(f.camera.active, false); assert.equal(f.calls.some(call => call[0] === 'import'), false);
  assert.equal(f.statuses.at(-1).state, 'error'); assert.match(f.statuses.at(-1).message, /許可/);
  f.camera.deps.isSecureContext = false;
  const count = f.calls.length;
  await assert.rejects(f.camera.start(), /HTTPS/);
  assert.equal(f.calls.length, count);
});

test('stop cancels an unanswered permission request immediately and disposes a stream arriving later', async () => {
  const permission = deferred(); const f = fixture({ media: () => permission.promise });
  const pending = f.camera.start();
  assert.equal(f.camera.starting, true); assert.equal(f.camera.stop(), true);
  assert.equal(await pending, false); assert.equal(f.camera.active, false);
  const lateStream = stream(); permission.resolve(lateStream); await flush();
  assert.equal(lateStream.track.stops, 1); assert.equal(f.video.srcObject, null);
  assert.equal(f.calls.some(call => call[0] === 'import'), false); assert.equal(f.doc.listenerCount, 0);
});

test('restart owns a fresh stream while a cancelled model is closed on late completion', async () => {
  const modelReady = deferred(); const firstStream = stream(); const secondStream = stream(); let requests = 0;
  const f = fixture({ media: () => Promise.resolve(++requests === 1 ? firstStream : secondStream) });
  const create = f.api.PoseLandmarker.createFromOptions;
  f.api.PoseLandmarker.createFromOptions = () => modelReady.promise;
  const oldStart = f.camera.start(); await flush();
  assert.equal(f.video.srcObject, firstStream);
  f.camera.stop(); assert.equal(firstStream.track.stops, 1); assert.equal(await oldStart, false);
  f.api.PoseLandmarker.createFromOptions = create;
  assert.equal(await f.camera.start(), true);
  const oldTask = { closed: 0, close() { this.closed++; } }; modelReady.resolve(oldTask); await flush();
  assert.equal(oldTask.closed, 1); assert.equal(secondStream.track.stops, 0);
  assert.equal(f.video.srcObject, secondStream); assert.equal(f.camera.ready, true);
  firstStream.track.emit('ended'); assert.equal(f.camera.ready, true);
  f.camera.dispose(); assert.equal(secondStream.track.stops, 1);
});

test('metadata readiness gates model loading and cancellation removes metadata listeners and timeout', async () => {
  const f = fixture({ ready: false });
  const pending = f.camera.start(); await flush();
  assert.equal(f.calls.some(call => call[0] === 'import'), false); assert.equal(f.timers.size, 1);
  f.camera.stop(); assert.equal(await pending, false);
  assert.equal(f.timers.size, 0); assert.equal(f.video.listenerCount, 0); assert.equal(f.cameraStream.track.stops, 1);
  const g = fixture({ ready: false }); const next = g.camera.start(); await flush();
  g.video.readyState = 2; g.video.videoWidth = 640; g.video.videoHeight = 480; g.video.emit('loadeddata');
  assert.equal(await next, true); assert.equal(g.timers.size, 0); g.camera.dispose();
});

test('video playback blocked by the browser can be cancelled without retaining its stream', async () => {
  const play = deferred(); const f = fixture(); f.video.play = () => play.promise;
  const pending = f.camera.start(); await flush();
  f.camera.stop(); assert.equal(await pending, false); assert.equal(f.cameraStream.track.stops, 1);
  play.reject(new Error('play cancelled')); await flush();
  assert.equal(f.calls.some(call => call[0] === 'import'), false); assert.equal(f.statuses.at(-1).state, 'stopped');
});

test('camera video is muted and inline before assigning and playing an iPhone stream', async () => {
  const f = fixture();
  const attributes = new Map();
  f.video.setAttribute = (name, value) => attributes.set(name, value);
  let source = null;
  Object.defineProperty(f.video, 'srcObject', {
    get: () => source,
    set(value) {
      if (value) {
        assert.equal(f.video.muted, true);
        assert.equal(f.video.defaultMuted, true);
        assert.equal(f.video.playsInline, true);
        assert.equal(attributes.has('muted'), true);
        assert.equal(attributes.has('playsinline'), true);
      }
      source = value;
    },
  });
  f.video.play = () => { assert.equal(source, f.cameraStream); return Promise.resolve(); };
  assert.equal(await f.camera.start(), true);
  f.camera.dispose();
});

test('Safari track mute ends capture immediately and late inference cannot extend the interrupted take', async () => {
  const detection = deferred(); const nextStream = stream(); let requests = 0;
  const f = fixture({ detect: () => detection.promise, media: () => Promise.resolve(++requests === 1 ? f.cameraStream : nextStream) });
  await f.camera.start(); await f.frame(1000, 0);
  f.cameraStream.track.emit('mute');
  assert.equal(f.camera.active, false); assert.equal(f.camera.ready, false);
  assert.equal(f.cameraStream.track.stops, 1); assert.equal(f.video.srcObject, null);
  assert.equal(f.statuses.at(-1).state, 'interrupted');
  assert.equal(f.cameraStream.track.listenerCount, 0);
  detection.resolve({ landmarks: [[]] }); await flush();
  assert.equal(f.results.length, 0); assert.equal(f.task.closed, 1);
  assert.equal(await f.camera.start(), true, 'the next user action can obtain a new camera stream');
  f.cameraStream.track.emit('mute'); f.cameraStream.track.emit('ended');
  assert.equal(f.camera.ready, true, 'old track events cannot interrupt the replacement stream');
  f.camera.dispose(); assert.equal(nextStream.track.stops, 1);
});

test('track interruption while the model loads cancels startup and disposes the late model', async () => {
  const model = deferred(); const f = fixture();
  f.api.PoseLandmarker.createFromOptions = () => model.promise;
  const pending = f.camera.start(); await flush();
  f.cameraStream.track.emit('mute');
  assert.equal(await pending, false); assert.equal(f.statuses.at(-1).state, 'interrupted');
  const lateTask = { closed: 0, close() { this.closed++; } };
  model.resolve(lateTask); await flush();
  assert.equal(lateTask.closed, 1); assert.equal(f.cameraStream.track.stops, 1);
  assert.equal(f.frames.size, 0); assert.equal(f.doc.listenerCount, 0);
});

test('inference never overlaps, duplicate frames are skipped, and detection is limited to 15fps', async () => {
  let detection = deferred(); const f = fixture({ detect: () => detection.promise });
  await f.camera.start(); await f.frame(1000, 0);
  assert.equal(f.frames.size, 0, 'no new detection is scheduled while busy');
  detection.resolve({ landmarks: [[{ x: 1 }]] }); await flush();
  assert.equal(f.results.length, 1);
  await f.frame(1100, 0); assert.equal(f.results.length, 1, 'same decoded frame must not be inferred twice');
  await f.frame(1020, .033); assert.equal(f.calls.filter(c => c[0] === 'detect').length, 1);
  detection = deferred(); await f.frame(1080, .066);
  detection.resolve({ landmarks: [[]] }); await flush();
  const timestamps = f.calls.filter(c => c[0] === 'detect').map(c => c[2]);
  assert.deepEqual(timestamps, [1000, 1080]);
  f.camera.dispose();
});

test('stop during inference releases camera immediately and discards the late result before closing the model', async () => {
  const detection = deferred(); const f = fixture({ detect: () => detection.promise });
  await f.camera.start(); await f.frame(1000, 0);
  f.camera.stop(); assert.equal(f.cameraStream.track.stops, 1); assert.equal(f.video.srcObject, null);
  assert.equal(f.task.closed, 0, 'avoid closing WASM during an outstanding inference');
  detection.resolve({ landmarks: [[]] }); await flush();
  assert.equal(f.results.length, 0); assert.equal(f.task.closed, 1); assert.equal(f.frames.size, 0);
});

test('hidden pages and ended tracks stop resources before their status notification', async () => {
  for (const trigger of ['hidden', 'ended']) {
    const f = fixture(); await f.camera.start();
    const notify = f.camera.onStatus;
    f.camera.onStatus = status => { assert.equal(f.camera.active, false); assert.equal(f.cameraStream.track.stops, 1); notify(status); };
    if (trigger === 'hidden') { f.doc.visibilityState = 'hidden'; f.doc.emit('visibilitychange'); }
    else f.cameraStream.track.emit('ended');
    assert.equal(f.statuses.at(-1).state, trigger); assert.equal(f.task.closed, 1);
    assert.equal(f.frames.size, 0); assert.equal(f.doc.listenerCount, 0); assert.equal(f.video.listenerCount, 0);
  }
});

test('model startup and inference failures release resources, RAF fallback cancels, and dispose prevents restart', async () => {
  const f = fixture({ vision: () => Promise.reject(new Error('model missing')) });
  await assert.rejects(f.camera.start(), /model missing/);
  assert.equal(f.cameraStream.track.stops, 1); assert.equal(f.video.srcObject, null);
  const g = fixture({ nativeFrames: false, detect: () => { throw new Error('inference failed'); } });
  await g.camera.start(); await g.frame(1000, 0);
  assert.equal(g.statuses.at(-1).state, 'error'); assert.equal(g.task.closed, 1); assert.equal(g.frames.size, 0);
  const h = fixture({ nativeFrames: false }); await h.camera.start(); assert.equal(h.frames.size, 1);
  h.camera.dispose(); assert.equal(h.frames.size, 0); assert.equal(h.camera.ready, false);
  await assert.rejects(h.camera.start(), /終了/);
});
