import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { MotionRecorder } from '../src/motion-capture.js';
import { validateMotionClip, serializeMotionClip, parseMotionFile, sampleMotionClip, applyCaptureToVRM, MAX_MOTION_FILE_BYTES } from '../src/motion-data.js';

const xrPose = (x = 0, y = 1.6, z = 0, quaternion = [0, 0, 0, 1]) => ({
  transform: { position: { x, y, z }, orientation: Object.fromEntries(['x', 'y', 'z', 'w'].map((key, i) => [key, quaternion[i]])) },
  emulatedPosition: false,
});
const reference = {};
function frame(head = xrPose(), hands = {}, visibilityState = 'visible') {
  return {
    session: { visibilityState, inputSources: Object.keys(hands).map(handedness => ({ handedness, gripSpace: handedness })) },
    getViewerPose: () => head,
    getPose: space => hands[space],
  };
}
function take() {
  const recorder = new MotionRecorder({ fps: 30 });
  recorder.start({ referenceSpaceType: 'local-floor' });
  recorder.recordFrame(1000, frame(xrPose(), { left: xrPose(-.3, 1.1, -.3), right: xrPose(.3, 1.1, -.3) }), reference);
  recorder.recordFrame(1034, frame(xrPose(.1), { left: xrPose(-.2, 1.1, -.3) }), reference);
  recorder.recordFrame(1068, frame(xrPose(.2), { left: xrPose(-.1, 1.1, -.3) }), reference);
  return recorder.stop();
}

test('records relative head/controller poses, floor height and capped sample rate', () => {
  const recorder = new MotionRecorder();
  recorder.start({ referenceSpaceType: 'local-floor' });
  assert.equal(recorder.recordFrame(500, frame(null), reference), false);
  assert.equal(recorder.recordFrame(1000, frame(xrPose(2, 1.6, -3), { left: xrPose(1.7, 1.2, -3.3) }), reference), true);
  assert.equal(recorder.recordFrame(1005, frame(), reference), false);
  recorder.recordFrame(1034, frame(xrPose(2.1, 1.6, -3)), reference);
  const clip = recorder.stop();
  assert.deepEqual(clip.frames[0].head.position, [0, 0, 0]);
  assert.deepEqual(clip.frames[0].left.position, [-.3, -.4, -.3]);
  assert.deepEqual(clip.frames[1].head.position, [.1, 0, 0]);
  assert.equal(clip.frames[0].right, null);
  assert.equal(clip.initialHeadHeight, 1.6);
  assert.equal(clip.duration, .034);
  assert.equal(clip.frames.length, 2);
  assert.equal(recorder.stop(), clip);
});

test('calibration removes initial yaw while preserving relative travel', () => {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2).toArray();
  const recorder = new MotionRecorder();
  recorder.start();
  recorder.recordFrame(0, frame(xrPose(0, 0, 0, q)), reference);
  recorder.recordFrame(34, frame(xrPose(-.2, 0, 0, q)), reference);
  const clip = recorder.stop();
  assert.ok(Math.abs(clip.frames[0].head.quaternion[3] - 1) < 1e-5);
  assert.ok(Math.abs(clip.frames[1].head.position[2] + .2) < 1e-5);
  assert.equal(clip.initialHeadHeight, null);
});

test('session loss, hidden state and missing hands are recorded honestly', () => {
  const recorder = new MotionRecorder();
  recorder.start();
  recorder.recordFrame(0, frame(), reference);
  recorder.recordFrame(34, frame(null, { left: null }), reference);
  recorder.recordFrame(68, frame(xrPose(), { right: xrPose() }, 'visible-blurred'), reference);
  const clip = recorder.stop();
  assert.equal(clip.frames[1].head, null);
  assert.equal(clip.frames[2].head, null);
  assert.equal(clip.frames[2].right, null);
  assert.equal(sampleMotionClip(clip, .02).head, null);
});

test('time cap auto-stops, keeps take and invokes callback once', () => {
  let count = 0;
  const recorder = new MotionRecorder({ maxDuration: .1, onLimit: clip => { count++; assert.equal(clip.duration, .1); } });
  recorder.start();
  recorder.recordFrame(0, frame(), reference);
  recorder.recordFrame(500, frame(), reference);
  recorder.recordFrame(600, frame(), reference);
  assert.equal(recorder.state, 'complete');
  assert.equal(count, 1);
  assert.equal(recorder.lastClip.duration, .1);
  recorder.start();
  assert.equal(recorder.stop(), null);
  assert.equal(recorder.lastClip.duration, .1);
});

test('suspended frames across the cap end with a gap instead of an incorrectly timed pose', () => {
  const recorder = new MotionRecorder({ maxDuration: 1 });
  recorder.start();
  recorder.recordFrame(0, frame(), reference);
  recorder.recordFrame(2000, frame(xrPose(4)), reference);
  assert.equal(recorder.lastClip.duration, 1);
  assert.equal(recorder.lastClip.frames.at(-1).head, null);
  assert.equal(sampleMotionClip(recorder.lastClip, .5).head, null);
});

test('invalid initial tracking, backwards timestamps and XR pose exceptions do not corrupt the take', () => {
  const recorder = new MotionRecorder();
  recorder.start();
  assert.equal(recorder.recordFrame(0, frame({ transform: {} }), reference), false);
  assert.equal(recorder.recordFrame(0, frame(xrPose(101)), reference), false);
  const missing = frame();
  missing.getViewerPose = () => { throw new Error('XR session unavailable'); };
  assert.equal(recorder.recordFrame(0, missing, reference), false);
  recorder.recordFrame(1000, frame(), reference);
  assert.equal(recorder.recordFrame(500, frame(), reference), false);
  recorder.recordFrame(1034, missing, reference);
  const clip = recorder.stop();
  assert.equal(clip.frames.length, 2);
  assert.equal(clip.frames[1].head, null);
  assert.doesNotThrow(() => validateMotionClip(JSON.parse(serializeMotionClip(clip))));
  recorder.start();
  recorder.recordFrame(1100, frame(), reference);
  recorder.cancel();
  assert.equal(recorder.state, 'idle');
  assert.equal(recorder.lastClip, clip);
  assert.equal(recorder.frameCount, 0);
});

test('malformed, unbounded and unsupported data fail validation', () => {
  const clip = take();
  const rejected = mutate => { const bad = structuredClone(clip); mutate(bad); assert.throws(() => validateMotionClip(bad), /モーションデータ/); };
  rejected(c => { c.version = 99; });
  rejected(c => { c.frames[0].head.quaternion = [0, 0, 0, 0]; });
  rejected(c => { c.frames[1].t = c.frames[0].t; });
  rejected(c => { c.frames[1].head.position[0] = Infinity; });
  rejected(c => { c.frames[1].left = undefined; });
  rejected(c => { c.frames[1].visibility = 'hidden'; });
  rejected(c => { c.duration = 181; });
  rejected(c => { c.fps = 90; });
  rejected(c => { c.origin = null; });
  rejected(c => { c.frames = Array(5403).fill(c.frames[0]); });
  rejected(c => { c.frames[0].t = .001; });
  assert.equal(JSON.parse(serializeMotionClip(clip)).format, 'vli.motion-capture');
});

test('upload refuses oversized files before reading and reports invalid JSON', async () => {
  await assert.rejects(parseMotionFile({ size: MAX_MOTION_FILE_BYTES + 1, text: () => { throw new Error('must not read'); } }), /32 MB/);
  await assert.rejects(parseMotionFile({ size: 100, text: async () => '{broken' }), /JSON/);
  const text = serializeMotionClip(take());
  assert.equal((await parseMotionFile({ size: text.length, text: async () => text })).frames.length, 3);
});

test('head-only take metadata survives save and import without claiming controller or wrist tracking', async () => {
  const recorder = new MotionRecorder(); recorder.start();
  recorder.recordFrame(0, frame(), reference);
  recorder.recordFrame(34, frame(xrPose(.1)), reference);
  const clip = recorder.stop();
  assert.deepEqual(clip.tracking, { head: 'viewer', hands: 'unavailable', body: 'inferred' });
  // Older saved clips may contain incorrect metadata; actual frames remain the
  // source of truth, including when a caller supplies a conflicting claim.
  clip.tracking.hands = 'controller-grip';
  const text = serializeMotionClip(clip);
  const imported = await parseMotionFile({ size: Buffer.byteLength(text), text: async () => text });
  assert.equal(imported.version, 1);
  assert.equal(imported.tracking.hands, 'unavailable');
  assert.ok(imported.frames.every(sample => sample.head && sample.left === null && sample.right === null));
  assert.equal(sampleMotionClip(imported, .017).head.position[0], .05);
  assert.equal(validateMotionClip({ ...clip, referenceSpace: 'camera' }).tracking.hands, 'unavailable');
});

test('hand tracking metadata continues to distinguish legacy controller, wrist and mixed captures', () => {
  const clip = take();
  for (const frame of clip.frames) for (const side of ['left', 'right']) if (frame[side]) delete frame[side].source;
  assert.equal(validateMotionClip(clip).tracking.hands, 'controller-grip');
  for (const frame of clip.frames) for (const side of ['left', 'right']) if (frame[side]) frame[side].source = 'hand-wrist';
  assert.equal(validateMotionClip(clip).tracking.hands, 'hand-wrist');
  clip.frames[0].right.source = 'controller-grip';
  assert.equal(validateMotionClip(clip).tracking.hands, 'mixed');
});

test('bundled accompaniment survives JSON import and stored-clip validation with its offset', async () => {
  for (const offset of [0, 12.3456789, 71.9999999]) {
    const clip = take();
    clip.frames = [clip.frames[0]];
    clip.duration = 0;
    clip.accompaniment = { track: 'neon-door', offset };
    const text = serializeMotionClip(clip);
    const imported = await parseMotionFile({ size: Buffer.byteLength(text), text: async () => text });
    assert.deepEqual(imported.accompaniment, { track: 'neon-door', offset });
    const restored = validateMotionClip(structuredClone(imported));
    assert.deepEqual(restored.accompaniment, { track: 'neon-door', offset });
    assert.notEqual(restored.accompaniment, imported.accompaniment);
  }
});

test('invalid accompaniment is ignored without rejecting a valid existing motion clip', () => {
  const clip = take();
  assert.ok(!Object.hasOwn(validateMotionClip(clip), 'accompaniment'));
  const invalid = [
    null, false, 0, 'neon-door', [], {},
    { track: 'neon-door' }, { track: 'neon-door', offset: '0' },
    ...[-1, 72, 100, Infinity, -Infinity, NaN].map(offset => ({ track: 'neon-door', offset })),
    { track: 'unknown', offset: 0 }, { track: 'https://example.com/audio.wav', offset: 0 },
    { track: '<audio autoplay>', offset: 0 },
  ];
  for (const value of invalid) {
    const clean = validateMotionClip({ ...clip, accompaniment: value });
    assert.ok(!Object.hasOwn(clean, 'accompaniment'));
    assert.deepEqual(clean.frames, clip.frames);
  }
});

test('accompaniment keeps only the bundled track and numeric offset', () => {
  const clip = take();
  clip.accompaniment = { track: 'neon-door', offset: 0, url: 'https://example.com/audio.wav', html: '<audio autoplay>', arbitrary: { nested: true } };
  const clean = validateMotionClip(clip);
  assert.deepEqual(clean.accompaniment, { track: 'neon-door', offset: 0 });
  assert.ok(clip.accompaniment.url, 'validation must not mutate caller data');
  assert.ok(!serializeMotionClip(clip).includes('example.com'));
});

test('accompaniment cannot bind motion beyond the end of its bundled song', () => {
  const clip = take();
  const remaining = 72 - clip.duration;
  for (const offset of [remaining, remaining + .0005]) {
    assert.deepEqual(validateMotionClip({ ...clip, accompaniment: { track: 'neon-door', offset } }).accompaniment, { track: 'neon-door', offset });
  }
  for (const offset of [remaining + .002, 71.99]) {
    const result = validateMotionClip({ ...clip, accompaniment: { track: 'neon-door', offset } });
    assert.ok(!Object.hasOwn(result, 'accompaniment'));
    assert.equal(result.duration, clip.duration);
    assert.deepEqual(result.frames, clip.frames);
  }
});

test('synthetic browser import fixture follows the same bounded recording format', () => {
  const clip = validateMotionClip(JSON.parse(readFileSync(new URL('./fixtures/capture-sample.json', import.meta.url))));
  assert.equal(clip.duration, 2);
  assert.equal(clip.frames.length, 61);
  assert.ok(clip.frames.every(f => f.head && f.left && f.right));
  assert.equal(clip.fixtureDescription, undefined);
});

test('sampling interpolates positions and shortest quaternion arcs without fabricating lost tracks', () => {
  const clip = take();
  clip.frames[1].head.quaternion = [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)];
  const sampled = sampleMotionClip(clip, .017);
  assert.ok(Math.abs(sampled.head.position[0] - .05) < 1e-9);
  assert.ok(Math.abs(sampled.head.quaternion[1] - Math.sin(Math.PI / 8)) < 1e-9);
  assert.equal(sampled.right, null);
  assert.equal(sampleMotionClip(clip, 100).t, clip.duration);
  clip.frames[1].t = 1;
  clip.frames[2].t = 1.034;
  clip.duration = 1.034;
  assert.equal(sampleMotionClip(clip, .5).head, null);
});

function sparseTake(referenceSpace = 'camera', interval = .2, fps = 15) {
  const clip = take();
  clip.referenceSpace = referenceSpace;
  clip.fps = fps;
  clip.duration = interval;
  clip.frames = [clip.frames[0], { ...clip.frames[2], t: interval }];
  for (const frame of clip.frames) frame.body = { hips: { ...frame.head, position: [frame.head.position[0], -.6, 0] } };
  return validateMotionClip(clip);
}

test('camera preview tolerates 5fps inference under a 15fps sampling ceiling while XR remains strict', () => {
  const camera = sparseTake();
  const sampled = sampleMotionClip(camera, .1);
  assert.equal(sampled.visibility, 'visible');
  assert.ok(Math.abs(sampled.head.position[0] - .1) < 1e-9);
  assert.ok(Math.abs(sampled.body.hips.position[0] - .1) < 1e-9);
  assert.equal(sampled.head.source, 'camera-pose');
  assert.equal(sampled.head.emulatedPosition, true);
  const xr = sampleMotionClip(sparseTake('local-floor'), .1);
  assert.equal(xr.head, null);
  assert.equal(xr.body, null);
  assert.equal(xr.visibility, 'hidden');
});

test('camera interpolation permits the 500ms boundary but never bridges longer intervals', () => {
  assert.ok(sampleMotionClip(sparseTake('camera', .5), .25).head);
  for (const fps of [1, 15, 60]) {
    const sampled = sampleMotionClip(sparseTake('camera', .500001, fps), .25);
    assert.equal(sampled.head, null);
    assert.equal(sampled.body, null);
    assert.equal(sampled.visibility, 'hidden');
  }
});

test('camera interpolation still refuses explicit missing head, body, hand, or hidden frames', () => {
  const camera = sparseTake('camera', .4);
  const gap = { t: .2, visibility: 'visible', head: null, left: null, right: null, body: null };
  camera.frames.splice(1, 0, gap);
  for (const time of [.1, .2, .3]) {
    const sampled = sampleMotionClip(camera, time);
    assert.equal(sampled.head, null);
    assert.equal(sampled.left, null);
    assert.equal(sampled.body, null);
  }
  gap.visibility = 'hidden';
  for (const time of [.1, .3]) assert.equal(sampleMotionClip(camera, time).visibility, 'hidden');

  const partial = sparseTake('camera', .2);
  partial.frames[1].left = null;
  partial.frames[1].body = null;
  const sampled = sampleMotionClip(partial, .1);
  assert.ok(sampled.head, 'an intact head does not depend on an unrelated missing hand');
  assert.equal(sampled.left, null);
  assert.equal(sampled.body, null);
});

test('capture retargeting keeps the stage transform intact and moves arms toward recorded hands', () => {
  const scene = new THREE.Group();
  scene.position.set(3, 0, -2);
  scene.scale.setScalar(1.2);
  const nodes = {};
  const add = (name, parent, position) => { const node = new THREE.Bone(); node.position.fromArray(position); parent.add(node); nodes[name] = node; return node; };
  const hips = add('hips', scene, [0, .9, 0]);
  const spine = add('spine', hips, [0, .3, 0]);
  add('head', spine, [0, .4, 0]);
  for (const side of ['left', 'right']) {
    const sign = side === 'left' ? 1 : -1;
    const upper = add(side + 'UpperArm', spine, [sign * .2, .2, 0]);
    const lower = add(side + 'LowerArm', upper, [sign * .3, 0, 0]);
    add(side + 'Hand', lower, [sign * .25, 0, 0]);
  }
  const rests = Object.fromEntries(Object.entries(nodes).map(([name, node]) => [name, node.position.clone()]));
  const vrm = { scene, humanoid: {
    getNormalizedBoneNode: name => nodes[name],
    resetNormalizedPose: () => { for (const [name, node] of Object.entries(nodes)) { node.quaternion.identity(); node.position.copy(rests[name]); } },
  } };
  assert.equal(applyCaptureToVRM(vrm, take(), 0), true);
  assert.deepEqual(scene.position.toArray(), [3, 0, -2]);
  assert.notEqual(nodes.leftUpperArm.quaternion.z, 0);
  for (const node of Object.values(nodes)) assert.ok(node.quaternion.toArray().every(Number.isFinite));
  scene.updateMatrixWorld(true);
  const hand = scene.worldToLocal(nodes.leftHand.getWorldPosition(new THREE.Vector3()));
  const desired = new THREE.Vector3(.3, 1.6 - .5 * 1.6 / 1.6, .3);
  assert.ok(hand.distanceTo(desired) < .06, `Hand misses IK target: ${hand.toArray()}`);
});
