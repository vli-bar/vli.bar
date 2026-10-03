import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicCapture } from '../src/music-capture.js';
import { LiveMotionSampler, MotionRecorder } from '../src/motion-capture.js';
import { CameraPoseSampler } from '../src/camera-pose.js';
import { serializeMotionClip, validateMotionClip } from '../src/motion-data.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class FakeAudio {
  constructor() {
    this.time = 0;
    this.duration = 72;
    this.ready = true;
    this.active = false;
    this.prepareCalls = 0;
    this.playCalls = [];
    this.stopCalls = 0;
    this.nextPreparation = null;
    this.failPlay = false;
  }
  prepare() {
    this.prepareCalls++;
    return this.nextPreparation ?? Promise.resolve();
  }
  play(offset) {
    this.playCalls.push(offset);
    if (this.failPlay) throw new Error('Audio device unavailable');
    this.active = true;
    this.time = offset;
  }
  stop() { this.stopCalls++; this.active = false; this.time = 0; }
}

function context({ fps = 30 } = {}) {
  const clock = { now: 0 };
  const audio = new FakeAudio();
  const recorder = new MotionRecorder({ fps });
  const capture = new MusicCapture({ recorder, audio, now: () => clock.now });
  // Establish the same head-relative origin while waiting that the live view
  // and recordSample subsequently share.
  const sampler = new LiveMotionSampler({ referenceSpaceType: 'local-floor' });
  const tracking = sampler.sampleFrame(500, {
    session: { visibilityState: 'visible', inputSources: [] },
    getViewerPose: () => ({ transform: { position: { x: 2, y: 1.65, z: -3 }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, emulatedPosition: false }),
    getPose: () => null,
  }, {});
  return { clock, audio, recorder, capture, tracking };
}

function cameraResult(confidence = .99) {
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: confidence, presence: confidence }));
  for (const [index, x, y, z = 0] of [
    [2, .035, -.71, -.045], [5, -.035, -.71, -.045], [7, .075, -.67], [8, -.075, -.67],
    [11, .2, -.45], [12, -.2, -.45], [13, .47, -.45], [14, -.47, -.45], [15, .71, -.45], [16, -.71, -.45],
    [23, .11, 0], [24, -.11, 0], [25, .11, .42], [26, -.11, .42], [27, .11, .84], [28, -.11, .84],
    [31, .11, .89, -.13], [32, -.11, .89, -.13],
  ]) Object.assign(world[index], { x, y, z });
  return { worldLandmarks: [world], landmarks: [world.map(point => ({ ...point, x: .5 + point.x * .4, y: .5 + point.y * .35 }))] };
}

test('music and actual recorder wait for preparation and the complete three-second countdown', async () => {
  const { clock, audio, recorder, capture, tracking } = context();
  const preparation = deferred();
  audio.nextPreparation = preparation.promise;
  const armed = capture.arm({ referenceSpaceType: 'local-floor' });
  clock.now = 4000;
  capture.tick(4000, tracking);
  assert.equal(capture.preparing, true);
  assert.equal(recorder.state, 'idle');
  assert.deepEqual(audio.playCalls, []);
  preparation.resolve();
  await armed;
  assert.equal(capture.countdownAt, 7000, 'countdown begins only after audio is ready');
  clock.now = 6999;
  capture.tick(96000, tracking);
  assert.equal(recorder.state, 'idle');
  assert.deepEqual(audio.playCalls, []);
  clock.now = 7000;
  capture.tick(96001, tracking);
  assert.equal(recorder.state, 'recording');
  assert.deepEqual(audio.playCalls, [0]);
  assert.equal(recorder.frames.length, 1);
  assert.equal(recorder.frames[0].t, 0);
  assert.deepEqual(recorder.origin, tracking.origin);
});

test('elapsed countdown still waits for a visible head pose and calibrated origin', async () => {
  const { clock, audio, recorder, capture, tracking } = context();
  await capture.arm();
  clock.now = 3000;
  const noOrigin = { ...tracking, origin: null };
  const noHead = { ...tracking, sample: { ...tracking.sample, head: null } };
  const emulatedHead = { ...tracking, sample: { ...tracking.sample, head: { ...tracking.sample.head, emulatedPosition: true } } };
  const hidden = { ...tracking, sample: { ...tracking.sample, visibility: 'hidden', head: null } };
  for (const missing of [null, noOrigin, noHead, emulatedHead, hidden]) {
    assert.equal(capture.tick(9000, missing), null);
    assert.equal(capture.pending, true);
    assert.equal(recorder.state, 'idle');
    assert.deepEqual(audio.playCalls, []);
  }
  capture.tick(10000, tracking);
  assert.equal(capture.pending, false);
  assert.equal(recorder.state, 'recording');
  assert.equal(recorder.frames[0].t, 0);
});

test('recorded motion starts at zero and follows the audio clock despite XR timestamp jitter', async () => {
  const { clock, audio, recorder, capture, tracking } = context();
  await capture.arm({ referenceSpaceType: 'local-floor' });
  clock.now = 3000;
  capture.tick(50000, tracking);
  audio.time = .1;
  capture.tick(70000, tracking);
  audio.time = .2;
  capture.tick(1000, tracking);
  audio.time = .3;
  capture.tick(1001, tracking);
  assert.deepEqual(recorder.frames.map(frame => frame.t), [0, .1, .2, .3]);
  assert.equal(recorder.initialHeadHeight, 1.65);
  assert.equal(recorder.referenceSpaceType, 'local-floor');
  assert.equal(recorder.frames[0].head.position[0], 0);
  tracking.sample.head.position[0] = 4;
  assert.equal(recorder.frames[0].head.position[0], 0, 'recorded snapshots do not change with the live sample');
});

test('song end finishes motion and audio together and preserves accompaniment through JSON', async () => {
  const { clock, audio, recorder, capture, tracking } = context();
  await capture.arm({ referenceSpaceType: 'local-floor' });
  clock.now = 3000;
  capture.tick(4000, tracking);
  audio.time = 71.9;
  assert.equal(capture.tick(4010, tracking), null);
  audio.time = audio.duration;
  const stopCalls = audio.stopCalls;
  const clip = capture.tick(4020, tracking);
  assert.equal(clip.duration, 72);
  assert.equal(recorder.state, 'complete');
  assert.equal(audio.active, false);
  assert.equal(audio.stopCalls, stopCalls + 1);
  assert.equal(capture.pending, false);
  assert.deepEqual(clip.accompaniment, { track: 'neon-door', offset: 0 });
  assert.equal(recorder.lastClip, clip);
  assert.deepEqual(validateMotionClip(JSON.parse(serializeMotionClip(clip))).accompaniment, clip.accompaniment);
  assert.equal(capture.tick(5000, tracking), null, 'completion is returned only once');
  assert.equal(capture.finish(), null);
});

test('cancelled preparation or countdown cannot start later when a stale promise resolves', async () => {
  const { clock, audio, recorder, capture, tracking } = context();
  const preparation = deferred();
  audio.nextPreparation = preparation.promise;
  const armed = capture.arm();
  capture.cancel();
  preparation.resolve();
  await armed;
  clock.now = 50000;
  capture.tick(50000, tracking);
  assert.equal(capture.pending, false);
  assert.equal(recorder.state, 'idle');
  assert.deepEqual(audio.playCalls, []);
  audio.nextPreparation = null;
  await capture.arm();
  capture.cancel();
  clock.now += 3000;
  capture.tick(53000, tracking);
  assert.equal(recorder.state, 'idle');
  assert.deepEqual(audio.playCalls, []);
});

test('audio preparation and playback errors do not silently record and permit a fresh retry', async () => {
  const { clock, audio, recorder, capture, tracking } = context();
  audio.nextPreparation = Promise.reject(new Error('Cannot resume audio'));
  await capture.arm();
  assert.match(capture.error, /準備できません/);
  assert.equal(capture.pending, false);
  clock.now = 4000;
  capture.tick(4000, tracking);
  assert.equal(recorder.state, 'idle');
  assert.deepEqual(audio.playCalls, []);
  audio.nextPreparation = null;
  audio.failPlay = true;
  await capture.arm();
  assert.equal(capture.error, null);
  clock.now += 3000;
  assert.equal(capture.tick(7000, tracking), null);
  assert.match(capture.error, /開始できません/);
  assert.equal(capture.pending, false);
  assert.equal(recorder.state, 'idle');
  assert.equal(recorder.frameCount, 0);
  assert.equal(audio.active, false);
  audio.failPlay = false;
  await capture.arm();
  clock.now += 3000;
  capture.tick(10000, tracking);
  assert.equal(capture.error, null);
  assert.equal(recorder.state, 'recording');
  assert.equal(audio.active, true);
  audio.time = .1;
  capture.tick(10001, tracking);
  assert.equal(capture.finish().duration, .1);
  assert.equal(audio.active, false);
});

test('silent recording keeps XR time and does not depend on audio preparation or time', async () => {
  const { clock, audio, recorder, capture, tracking } = context();
  audio.prepare = () => assert.fail('silent capture must not prepare audio');
  audio.play = () => assert.fail('silent capture must not play audio');
  audio.ready = false;
  await capture.arm({ withMusic: false, referenceSpaceType: 'local-floor' });
  clock.now = 3000;
  capture.tick(45000, tracking);
  audio.time = 60;
  capture.tick(45100, tracking);
  audio.time = 0;
  capture.tick(45200, tracking);
  assert.deepEqual(recorder.frames.map(frame => frame.t), [0, .1, .2]);
  const clip = capture.finish();
  assert.equal(clip.duration, .2);
  assert.ok(!Object.hasOwn(clip, 'accompaniment'));
  assert.equal(recorder.state, 'complete');
});

test('interrupted audio returns the existing take once instead of recording against a frozen clock', async () => {
  const { clock, audio, recorder, capture, tracking } = context();
  await capture.arm({ referenceSpaceType: 'local-floor' });
  clock.now = 3000;
  capture.tick(4000, tracking);
  audio.time = .1;
  capture.tick(4100, tracking);
  const recorded = structuredClone(recorder.frames);
  audio.ready = false;
  const stopsBefore = audio.stopCalls;
  const clip = capture.tick(90000, tracking);
  assert.equal(clip.duration, .1);
  assert.deepEqual(clip.frames, recorded);
  assert.deepEqual(clip.accompaniment, { track: 'neon-door', offset: 0 });
  assert.match(capture.error, /音声が中断/);
  assert.equal(recorder.state, 'complete');
  assert.equal(recorder.lastClip, clip);
  assert.equal(audio.active, false);
  assert.equal(audio.stopCalls, stopsBefore + 1);
  assert.equal(capture.pending, false);
  assert.equal(capture.tick(100000, tracking), null);
  assert.equal(recorder.frameCount, recorded.length);
  assert.equal(audio.stopCalls, stopsBefore + 1);

  // A new user gesture can resume the transport and start a separate take.
  audio.ready = true;
  await capture.arm({ referenceSpaceType: 'local-floor' });
  assert.equal(capture.error, null);
  clock.now += 3000;
  capture.tick(100001, tracking);
  assert.equal(recorder.state, 'recording');
  assert.equal(recorder.frameCount, 1);
  assert.equal(recorder.frames[0].t, 0);
  assert.equal(audio.active, true);
});

for (const countdownSeconds of [5, 10]) {
  test(`camera capture accepts estimated sampler poses only after its ${countdownSeconds}-second countdown`, async () => {
    const { clock, audio, recorder, capture } = context({ fps: 15 });
    const sampler = new CameraPoseSampler();
    const tracking = sampler.sample(cameraResult(), 0);
    assert.equal(tracking.sample.head.emulatedPosition, true);
    await capture.arm({ withMusic: true, referenceSpaceType: 'camera', countdownSeconds });
    clock.now = countdownSeconds * 1000 - 1;
    capture.tick(clock.now, tracking);
    assert.equal(recorder.state, 'idle');
    assert.deepEqual(audio.playCalls, []);
    clock.now++;
    capture.tick(clock.now, sampler.sample(cameraResult(), clock.now));
    assert.equal(recorder.state, 'recording');
    assert.deepEqual(audio.playCalls, [0]);
    assert.equal(recorder.referenceSpaceType, 'camera');
    assert.equal(recorder.frames[0].t, 0);
    assert.equal(recorder.frames[0].head.source, 'camera-pose');
  });
}

test('camera countdown cannot start with missing or low-confidence estimates or a mislabeled XR pose', async () => {
  const { clock, audio, recorder, capture } = context({ fps: 15 });
  const sampler = new CameraPoseSampler();
  await capture.arm({ referenceSpaceType: 'camera', countdownSeconds: 5 });
  clock.now = 5000;
  for (const result of [null, cameraResult(.2)]) {
    capture.tick(5000, sampler.sample(result, 5000));
    assert.equal(capture.pending, true);
    assert.equal(recorder.frameCount, 0);
    assert.deepEqual(audio.playCalls, []);
  }
  const good = sampler.sample(cameraResult(), 5100);
  const lostHead = cameraResult();
  for (const index of [2, 5, 7, 8]) lostHead.worldLandmarks[0][index].visibility = 0;
  clock.now = 5200;
  capture.tick(5200, sampler.sample(lostHead, 5200));
  assert.equal(recorder.state, 'idle', 'an old calibrated origin does not replace a current head observation');
  capture.tick(5201, { ...good, source: 'viewer' });
  capture.tick(5202, { ...good, referenceSpace: 'local' });
  assert.equal(recorder.state, 'idle', 'the camera exception requires both provenance fields');
  clock.now = 5300;
  capture.tick(5300, sampler.sample(cameraResult(), 5300));
  assert.equal(recorder.state, 'recording');
  assert.equal(recorder.frames[0].t, 0);
});

for (const withMusic of [false, true]) {
  test(`15fps camera recording preserves estimated raw metadata ${withMusic ? 'with accompaniment' : 'without accompaniment'}`, async () => {
    const { clock, audio, recorder, capture } = context({ fps: 15 });
    const sampler = new CameraPoseSampler();
    await capture.arm({ withMusic, referenceSpaceType: 'camera', countdownSeconds: 5 });
    clock.now = 10000;
    capture.tick(10000, sampler.sample(cameraResult(), 10000));
    const step = (inferenceTime, mediaTime, result = cameraResult()) => {
      clock.now = inferenceTime;
      audio.time = mediaTime;
      capture.tick(inferenceTime, sampler.sample(result, inferenceTime));
    };
    step(10020, .02); // The recorder, unlike the live preview, is capped at 15fps.
    step(10100, .1);
    step(10200, .2, cameraResult(.1));
    step(10300, .3);
    const clip = capture.finish();
    const restored = validateMotionClip(JSON.parse(serializeMotionClip(clip)));
    assert.equal(restored.fps, 15);
    assert.equal(restored.referenceSpace, 'camera');
    assert.equal(restored.duration, .3);
    assert.deepEqual(restored.frames.map(frame => frame.t), [0, .1, .2, .3]);
    assert.equal(restored.frames[2].head, null);
    assert.equal(restored.frames[2].body, null);
    assert.equal(restored.frames[0].head.source, 'camera-pose');
    assert.equal(restored.frames[0].left.source, 'camera-pose');
    assert.ok(restored.frames[0].head.emulatedPosition);
    assert.ok(Object.values(restored.frames[0].body).every(joint => joint.emulatedPosition));
    assert.deepEqual(restored.tracking, { head: 'camera-pose', hands: 'camera-pose', body: 'camera-pose' });
    if (withMusic) assert.deepEqual(restored.accompaniment, { track: 'neon-door', offset: 0 });
    else assert.ok(!Object.hasOwn(restored, 'accompaniment'));
    assert.equal(audio.prepareCalls, withMusic ? 1 : 0);
    assert.equal(audio.active, false);
  });
}

for (const withMusic of [true, false]) {
  test(`camera ${withMusic ? 'music timestamps subtract inference delay' : 'silent timestamps keep observation time'} with varying inference cost`, async () => {
    const { clock, audio, recorder, capture } = context({ fps: 15 });
    const sampler = new CameraPoseSampler();
    await capture.arm({ withMusic, referenceSpaceType: 'camera', countdownSeconds: 5 });

    // The first image was observed at 5000ms, but its 80ms inference completes
    // at 5080ms. Only then may the song start; the first saved pose remains t=0.
    clock.now = 5080;
    capture.tick(5000, sampler.sample(cameraResult(), 5000));
    const songStartedAt = clock.now;
    assert.equal(recorder.frames[0].t, 0);
    const deliver = (observedAt, finishedAt) => {
      clock.now = finishedAt;
      audio.time = (finishedAt - songStartedAt) / 1000;
      capture.tick(observedAt, sampler.sample(cameraResult(), observedAt));
    };
    deliver(5180, 5220); // 40ms inference; image observed 100ms into the song.
    deliver(5280, 5420); // 140ms inference; image observed 200ms into the song.
    const expected = withMusic ? [0, .1, .2] : [0, .18, .28];
    assert.deepEqual(recorder.frames.map(frame => frame.t), expected);
    const clip = capture.finish();
    assert.equal(clip.duration, expected.at(-1));
    assert.equal(clip.frames[0].head.emulatedPosition, true);
    assert.equal(audio.active, false);
  });
}
