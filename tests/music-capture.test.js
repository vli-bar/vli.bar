import test from 'node:test';
import assert from 'node:assert/strict';
import { MusicCapture } from '../src/music-capture.js';
import { LiveMotionSampler, MotionRecorder } from '../src/motion-capture.js';
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

function context() {
  const clock = { now: 0 };
  const audio = new FakeAudio();
  const recorder = new MotionRecorder();
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
