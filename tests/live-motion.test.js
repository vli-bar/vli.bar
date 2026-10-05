import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { LiveMotionSampler, MotionRecorder } from '../src/motion-capture.js';
import { applyMotionSampleToVRM, applyCaptureToVRM, validateMotionClip, serializeMotionClip, sampleMotionClip } from '../src/motion-data.js';

const reference = {};
const xrPose = (x = 0, y = 1.6, z = 0) => ({ transform: { position: { x, y, z }, orientation: { x: 0, y: 0, z: 0, w: 1 } }, emulatedPosition: false });
function xrFrame(head = xrPose(), left = xrPose(-.35, 1.1, -.25), right = xrPose(.35, 1.1, -.25)) {
  return { session: { visibilityState: 'visible', inputSources: [{ handedness: 'left', gripSpace: 'left' }, { handedness: 'right', gripSpace: 'right' }] },
    getViewerPose: () => head, getPose: side => ({ left, right })[side] ?? null };
}
async function avatar() {
  const buffer = await readFile(new URL('../public/demo/vli-performer.vrm', import.meta.url));
  const loader = new GLTFLoader(); loader.register(parser => new VRMLoaderPlugin(parser));
  return (await loader.parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '')).userData.vrm;
}

test('live tracking responds before recording and between recorded frames without changing calibration', () => {
  const live = new LiveMotionSampler({ referenceSpaceType: 'local-floor' });
  const recorder = new MotionRecorder();
  assert.equal(live.sampleFrame(0, xrFrame(null), reference).origin, null);
  live.sampleFrame(100, xrFrame(xrPose(2)), reference);
  const waiting = live.sampleFrame(110, xrFrame(xrPose(2.02)), reference);
  assert.equal(waiting.sample.head.position[0], .02);
  assert.equal(recorder.frameCount, 0);
  recorder.start();
  const first = live.sampleFrame(150, xrFrame(xrPose(2.1)), reference);
  assert.equal(recorder.recordSample(150, first), true);
  const intermediate = live.sampleFrame(160, xrFrame(xrPose(2.3)), reference);
  assert.equal(intermediate.sample.head.position[0], .3);
  assert.equal(recorder.recordSample(160, intermediate), false);
  const final = live.sampleFrame(190, xrFrame(xrPose(2.4)), reference);
  assert.equal(recorder.recordSample(190, final), true);
  final.sample.head.position[0] = 99;
  const clip = recorder.stop();
  assert.equal(clip.referenceSpace, 'local-floor');
  assert.equal(clip.initialHeadHeight, 1.6);
  assert.deepEqual(clip.origin.position, [2, 1.6, 0]);
  assert.equal(clip.frames[0].t, 0);
  assert.equal(clip.frames[0].head.position[0], .1);
  assert.equal(clip.frames[1].head.position[0], .4);
  assert.equal(clip.duration, .04);
});

test('standard hand wrist input takes precedence and missing wrists fall back to controller grip', () => {
  const live = new LiveMotionSampler();
  const frame = xrFrame();
  frame.session.inputSources[0].hand = new Map([['wrist', 'left-wrist']]);
  frame.session.inputSources[1].hand = new Map([['wrist', 'right-wrist']]);
  frame.getJointPose = joint => joint === 'left-wrist' ? xrPose(-.31, 1.3, -.2) : null;
  const tracking = live.sampleFrame(0, frame, reference);
  assert.deepEqual(tracking.sources, { left: 'hand-wrist', right: 'controller-grip' });
  assert.equal(tracking.sample.left.position[0], -.31);
  assert.equal(tracking.sample.right.position[0], .35);
  const recorder = new MotionRecorder(); recorder.start(); recorder.recordSample(0, tracking);
  const clip = recorder.stop();
  assert.equal(clip.tracking.hands, 'mixed');
  assert.equal(JSON.parse(serializeMotionClip(clip)).frames[0].left.source, 'hand-wrist');
  frame.session.visibilityState = 'hidden';
  const hidden = live.sampleFrame(50, frame, reference);
  assert.equal(hidden.sample.head, null); assert.equal(hidden.sample.left, null);
  assert.equal(hidden.sample.body, null);
});

test('visionOS transient pinch sources never become recorded hands without hand tracking permission', () => {
  const live = new LiveMotionSampler();
  const recorder = new MotionRecorder(); recorder.start();
  const frame = xrFrame();
  let pinchReads = 0;
  frame.getPose = () => { pinchReads++; return xrPose(-.1, 1.3, -.1); };
  const pinch = { targetRayMode: 'transient-pointer', handedness: 'left', gripSpace: 'pinch' };
  for (const [index, sources] of [[], [pinch], []].entries()) {
    frame.session.inputSources = sources;
    const tracking = live.sampleFrame(index * 40, frame, reference);
    assert.ok(tracking.sample.head);
    assert.equal(tracking.sample.left, null); assert.equal(tracking.sample.right, null);
    assert.deepEqual(tracking.sources, { left: 'unavailable', right: 'unavailable' });
    assert.equal(recorder.recordSample(index * 40, tracking), true);
  }
  const clip = recorder.stop();
  assert.equal(pinchReads, 0, 'pinch grip is an interaction point, not tracked hand motion');
  assert.ok(clip.frames.every(sample => sample.head && sample.left === null && sample.right === null));
  assert.equal(clip.tracking.body, 'inferred');
});

test('visionOS wrist motion stays continuous across pinch lifecycle and input source ordering', () => {
  const live = new LiveMotionSampler();
  const frame = xrFrame();
  const hands = ['left', 'right'].map(side => ({ targetRayMode: 'tracked-pointer', handedness: side, hand: new Map([['wrist', side]]) }));
  const pinch = { targetRayMode: 'transient-pointer', handedness: 'left', gripSpace: 'pinch' };
  let wristX = -.3, pinchReads = 0;
  frame.getJointPose = side => xrPose(side === 'left' ? wristX : .3, 1.2, -.2);
  frame.getPose = () => { pinchReads++; return xrPose(-.1, 1.3, -.1); };
  const sequences = [hands, [...hands, pinch], [pinch, ...hands], hands];
  for (const [index, sources] of sequences.entries()) {
    frame.session.inputSources = sources; wristX -= .02;
    const tracking = live.sampleFrame(index * 40, frame, reference);
    assert.deepEqual(tracking.sources, { left: 'hand-wrist', right: 'hand-wrist' });
    assert.ok(Math.abs(tracking.sample.left.position[0] - wristX) < 1e-6);
    assert.equal(tracking.sample.right.position[0], .3);
    assert.equal(tracking.sample.body, null);
  }
  // Losing the wrist during a pinch must clear the hand, never substitute pinch.
  frame.session.inputSources = [...hands, pinch];
  frame.getJointPose = () => null;
  const lost = live.sampleFrame(200, frame, reference);
  assert.equal(lost.sample.left, null); assert.equal(lost.sample.right, null);
  assert.equal(pinchReads, 0, 'pinch cannot substitute for a tracked wrist');
});

test('browser body joints share the live head origin and survive recording, import and interpolation', () => {
  const live = new LiveMotionSampler();
  const frame = xrFrame(xrPose(2, 1.6, 3));
  frame.body = new Map([['hips', 'hips-space'], ['left-upper-leg', 'leg-space']]);
  let x = 2;
  frame.getPose = space => space === 'hips-space' ? xrPose(x, 1, 3) : space === 'leg-space' ? xrPose(x - .1, .9, 3) : null;
  const first = live.sampleFrame(0, frame, reference);
  assert.equal(first.bodyStatus, 'tracked'); assert.equal(first.bodyCount, 2);
  assert.deepEqual(first.sample.body.hips.position, [0, -.6, 0]);
  const recorder = new MotionRecorder(); recorder.start(); recorder.recordSample(0, first);
  x = 2.1;
  recorder.recordSample(34, live.sampleFrame(34, frame, reference));
  const clip = validateMotionClip(JSON.parse(serializeMotionClip(recorder.stop())));
  assert.equal(clip.tracking.body, 'browser-body');
  assert.equal(Object.keys(clip.frames[0].body).length, 2);
  assert.ok(Math.abs(sampleMotionClip(clip, .017).body.hips.position[0] - .05) < 1e-8);
  const invalid = structuredClone(clip); invalid.frames[1].visibility = 'hidden'; invalid.frames[1].head = null;
  assert.throws(() => validateMotionClip(invalid), /身体関節/);
  delete frame.body;
  const missing = live.sampleFrame(68, frame, reference);
  assert.equal(missing.bodyStatus, 'unavailable'); assert.equal(missing.sample.body, null);
});

test('live avatar motion matches the saved preview and clears prior demo expressions', async () => {
  const vrm = await avatar();
  const stage = new THREE.Group(); stage.add(vrm.scene);
  stage.position.set(2, .5, -3); stage.rotation.y = .6; stage.scale.setScalar(.8);
  const live = new LiveMotionSampler({ referenceSpaceType: 'local-floor' });
  const recorder = new MotionRecorder(); recorder.start();
  const first = live.sampleFrame(0, xrFrame(), reference);
  recorder.recordSample(0, first);
  applyMotionSampleToVRM(vrm, first.sample, first);
  const hand = vrm.humanoid.getNormalizedBoneNode('leftHand');
  vrm.scene.updateWorldMatrix(true, true);
  const originalHand = vrm.scene.worldToLocal(hand.getWorldPosition(new THREE.Vector3()));
  const tracking = live.sampleFrame(50, xrFrame(xrPose(.08), xrPose(-.3, 1.4, -.2)), reference);
  recorder.recordSample(50, tracking);
  vrm.expressionManager.setValue('aa', .9); vrm.expressionManager.setValue('happy', .8);
  assert.equal(applyMotionSampleToVRM(vrm, tracking.sample, tracking), true);
  const expected = vrm.humanoid.getNormalizedPose();
  vrm.scene.updateWorldMatrix(true, true);
  const raisedHand = vrm.scene.worldToLocal(hand.getWorldPosition(new THREE.Vector3()));
  assert.ok(raisedHand.y > originalHand.y + .1, 'raising a controller visibly raises the avatar hand');
  assert.equal(vrm.expressionManager.getValue('aa'), 0); assert.equal(vrm.expressionManager.getValue('happy'), 0);
  const clip = recorder.stop();
  // A stage placement change must not change captured joint geometry on replay.
  stage.position.set(-1, 0, 2); stage.rotation.y = -1; stage.scale.setScalar(1.7);
  applyCaptureToVRM(vrm, clip, clip.duration);
  const actual = vrm.humanoid.getNormalizedPose();
  for (const [name, pose] of Object.entries(expected)) {
    assert.ok(new THREE.Quaternion().fromArray(pose.rotation).angleTo(new THREE.Quaternion().fromArray(actual[name].rotation)) < .0001, `${name} preview differs from live pose`);
  }
  assert.deepEqual(actual.hips.position, expected.hips.position);
});

test('sampler reset removes the previous session origin and tracking never reuses stale hands', () => {
  const live = new LiveMotionSampler();
  live.sampleFrame(0, xrFrame(xrPose(2)), reference);
  const lost = live.sampleFrame(34, xrFrame(null, null, null), reference);
  assert.equal(lost.sample.head, null); assert.equal(lost.sample.left, null);
  live.reset();
  const next = live.sampleFrame(100, xrFrame(xrPose(-3)), reference);
  assert.deepEqual(next.sample.head.position, [0, 0, 0]);
  assert.deepEqual(next.origin.position, [-3, 1.6, 0]);
  assert.equal(next.sample.t, 0);
});

test('an emulated head position cannot establish the recording origin', () => {
  const live = new LiveMotionSampler();
  const pose = xrPose(); pose.emulatedPosition = true;
  const approximate = live.sampleFrame(0, xrFrame(pose), reference);
  assert.equal(approximate.origin, null); assert.equal(approximate.sample.head, null);
  const recorder = new MotionRecorder(); recorder.start();
  assert.equal(recorder.recordSample(0, approximate), false);
  const real = live.sampleFrame(34, xrFrame(), reference);
  assert.ok(real.origin); assert.equal(recorder.recordSample(34, real), true);
});

test('controller retargeting respects the VRM 0 and VRM 1 forward axes and anatomical hands', () => {
  for (const metaVersion of ['0', '1']) {
    const axis = metaVersion === '0' ? -1 : 1;
    const scene = new THREE.Group(), nodes = {};
    const add = (name, parent, p) => { const node = new THREE.Bone(); node.position.fromArray(p); parent.add(node); nodes[name] = node; return node; };
    const hips = add('hips', scene, [0, .9, 0]);
    const spine = add('spine', hips, [0, .3, 0]);
    add('head', spine, [0, .4, 0]);
    for (const side of ['left', 'right']) {
      const sign = (side === 'left' ? 1 : -1) * axis;
      const upper = add(side + 'UpperArm', spine, [sign * .2, .2, 0]);
      const lower = add(side + 'LowerArm', upper, [sign * .3, 0, 0]);
      add(side + 'Hand', lower, [sign * .25, 0, 0]);
    }
    const rest = Object.fromEntries(Object.entries(nodes).map(([name, node]) => [name, node.position.clone()]));
    const vrm = { scene, meta: { metaVersion }, humanoid: {
      getNormalizedBoneNode: name => nodes[name],
      resetNormalizedPose() { for (const [name, node] of Object.entries(nodes)) { node.position.copy(rest[name]); node.quaternion.identity(); } },
    } };
    const sample = { head: { position: [.1, 0, -.15], quaternion: [Math.sin(.1), 0, 0, Math.cos(.1)] },
      left: { position: [-.3, -.5, -.3] }, right: { position: [.3, -.5, -.3] } };
    applyMotionSampleToVRM(vrm, sample, { initialHeadHeight: 1.6 });
    assert.ok(Math.abs(hips.position.x + axis * .1) < 1e-6);
    assert.ok(Math.abs(hips.position.z - axis * .15) < 1e-6);
    scene.updateWorldMatrix(true, true);
    const hand = nodes.leftHand.getWorldPosition(new THREE.Vector3());
    assert.ok(hand.distanceTo(new THREE.Vector3(axis * .3, 1.1, axis * .3)) < .001, `${metaVersion} left hand points to the wrong side`);
    const head = nodes.head.getWorldQuaternion(new THREE.Quaternion());
    assert.ok(Math.abs(head.x + axis * Math.sin(.1)) < .00001, `${metaVersion} head pitch is reversed`);
  }
});
