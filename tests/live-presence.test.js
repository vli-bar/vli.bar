import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createLivePresence, sampleAudiencePose } from '../src/live-presence.js';

const q = [0, 0, 0, 1];
const pose = (position = [0, 1.6, 2], quaternion = q, extra = {}) => ({ position, quaternion, ...extra });
const xrPose = (position, quaternion = q, extra = {}) => ({ transform: {
  position: Object.fromEntries(['x', 'y', 'z'].map((key, i) => [key, position[i]])),
  orientation: Object.fromEntries(['x', 'y', 'z', 'w'].map((key, i) => [key, quaternion[i]])),
}, emulatedPosition: false, ...extra });
const peer = (id, device = 'headset', role = 'audience') => ({ id, device, role, name: id });
const packet = (id, receivedAt, seq, sample = {}, device = 'headset') => ({ id, role: 'audience', device, receivedAt, seq, sentAt: 123456789,
  referenceSpace: 'stage', sample: { t: 0, visibility: 'visible', head: pose(), left: null, right: null, body: {}, ...sample } });
function fixture() {
  const scene = new THREE.Scene(); scene.position.set(1, -.4, 2); scene.rotation.y = -.15;
  const parent = new THREE.Group(); parent.position.set(2, .5, -3); parent.rotation.y = .35; scene.add(parent);
  const stage = new THREE.Group(); stage.position.set(-1, .2, -2); stage.rotation.y = -.7; stage.scale.setScalar(1.5); parent.add(stage);
  const presence = createLivePresence(scene, stage);
  const node = id => presence.room.getObjectByName(`audience:${id}`);
  return { scene, stage, presence, node };
}
const nearVector = (actual, expected) => assert.ok(actual.distanceTo(expected) < 2e-6, `${actual.toArray()} ≈ ${expected.toArray()}`);

test('audience sampling maps both position and orientation through a translated rotated scaled stage', () => {
  const { stage } = fixture(); stage.updateWorldMatrix(true, false);
  const localPosition = new THREE.Vector3(.6, 1.15, 2.4);
  const localRotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(.1, .6, -.2));
  const worldRotation = stage.getWorldQuaternion(new THREE.Quaternion()).multiply(localRotation);
  const worldPosition = localPosition.clone().applyMatrix4(stage.matrixWorld);
  const reference = {};
  const frame = { session: { visibilityState: 'visible', inputSources: [] }, getViewerPose(space) { assert.equal(space, reference); return xrPose(worldPosition.toArray(), worldRotation.toArray()); } };
  const sample = sampleAudiencePose(frame, reference, stage, { device: 'phone' });
  nearVector(new THREE.Vector3().fromArray(sample.head.position), localPosition);
  assert.ok(new THREE.Quaternion().fromArray(sample.head.quaternion).normalize().angleTo(localRotation) < 2e-6);
  assert.equal(sample.visibility, 'visible'); assert.equal(sample.head.source, 'viewer');
  assert.equal(sample.t, 0); assert.deepEqual(sample.body, {});
});

test('phones and desktop never sample hands; head tracking loss returns an explicit hidden pose', () => {
  const stage = new THREE.Group();
  const frame = { session: { visibilityState: 'visible', inputSources: [{ handedness: 'left', gripSpace: {} }] },
    getViewerPose: () => xrPose([0, 1.6, 0]), getPose: () => { throw new Error('phone must never read hands'); } };
  for (const device of ['phone', 'desktop']) {
    const sample = sampleAudiencePose(frame, {}, stage, { device });
    assert.ok(sample.head); assert.equal(sample.left, null); assert.equal(sample.right, null);
  }
  for (const viewer of [null, xrPose([0, 1.6, 0], q, { emulatedPosition: true }), xrPose([NaN, 0, 0])]) {
    frame.getViewerPose = () => viewer;
    const sample = sampleAudiencePose(frame, {}, stage, { device: 'headset' });
    assert.equal(sample.head, null); assert.equal(sample.visibility, 'hidden'); assert.equal(sample.left, null);
  }
  frame.getViewerPose = () => { throw new Error('tracking lost'); };
  assert.equal(sampleAudiencePose(frame, {}, stage).head, null);
  frame.session.visibilityState = 'visible-blurred';
  assert.equal(sampleAudiencePose(frame, {}, stage).visibility, 'hidden');
});

test('headsets prefer a real tracked wrist, fall back to a real grip, and never use emulated hand poses', () => {
  const stage = new THREE.Group();
  const leftWrist = {}, rightWrist = {}, leftGrip = {}, rightGrip = {};
  const frame = { session: { visibilityState: 'visible', inputSources: [
    { handedness: 'left', hand: new Map([['wrist', leftWrist]]), gripSpace: leftGrip },
    { handedness: 'left', gripSpace: leftGrip },
    { handedness: 'right', hand: new Map([['wrist', rightWrist]]), gripSpace: rightGrip },
  ] }, getViewerPose: () => xrPose([0, 1.6, 2]),
  getJointPose: wrist => xrPose([wrist === leftWrist ? -.4 : .4, 1, 2], q, { emulatedPosition: wrist === rightWrist }),
  getPose: grip => xrPose([grip === leftGrip ? -.3 : .3, 1.1, 2]) };
  const sample = sampleAudiencePose(frame, {}, stage, { device: 'headset' });
  assert.equal(sample.left.source, 'hand-wrist'); assert.equal(sample.left.position[0], -.4);
  assert.equal(sample.right.source, 'controller-grip'); assert.equal(sample.right.position[0], .3);
  frame.getPose = () => xrPose([0, 1, 2], q, { emulatedPosition: true });
  assert.equal(sampleAudiencePose(frame, {}, stage, { device: 'headset' }).right, null);
  stage.scale.setScalar(0);
  assert.equal(sampleAudiencePose(frame, {}, stage, { device: 'headset' }).head, null);
});

test('headset audience hands ignore transient pinch input and retain persistent wrists regardless of ordering', () => {
  const stage = new THREE.Group(), reference = {};
  const pinch = { targetRayMode: 'transient-pointer', handedness: 'left', gripSpace: 'pinch' };
  const hand = { targetRayMode: 'tracked-pointer', handedness: 'left', hand: new Map([['wrist', 'left']]) };
  let pinchReads = 0;
  const frame = { session: { visibilityState: 'visible', inputSources: [] },
    getViewerPose: () => xrPose([0, 1.6, 0]), getJointPose: () => xrPose([-.3, 1.2, -.2]),
    getPose: () => { pinchReads++; return xrPose([-.1, 1.3, -.1]); } };
  for (const sources of [[], [pinch], []]) {
    frame.session.inputSources = sources;
    const sample = sampleAudiencePose(frame, reference, stage, { device: 'headset' });
    assert.equal(sample.visibility, 'visible'); assert.ok(sample.head);
    assert.equal(sample.left, null); assert.equal(sample.right, null);
  }
  for (const sources of [[hand], [hand, pinch], [pinch, hand], [hand]]) {
    frame.session.inputSources = sources;
    const sample = sampleAudiencePose(frame, reference, stage, { device: 'headset' });
    assert.equal(sample.left.source, 'hand-wrist'); assert.deepEqual(sample.left.position, [-.3, 1.2, -.2]);
    assert.equal(sample.right, null);
  }
  frame.session.inputSources = [hand, pinch]; frame.getJointPose = () => null;
  assert.equal(sampleAudiencePose(frame, reference, stage, { device: 'headset' }).left, null);
  assert.equal(pinchReads, 0, 'audience must not broadcast natural-input pinch grips');
});

test('presence excludes self and performers, uses the stage world transform, and faces along local minus Z', () => {
  const { scene, stage, presence, node } = fixture();
  presence.setPeers([peer('self'), peer('actor', 'headset', 'performer'), peer('friend')], 'self');
  assert.equal(presence.size, 1); assert.equal(node('self'), undefined); assert.equal(node('actor'), undefined);
  assert.equal(presence.receive(packet('self', 1000, 0)), false);
  assert.equal(presence.receive(packet('friend', 1000, 0)), true);
  presence.update(1000); const avatar = node('friend'), head = avatar.getObjectByName('audience-head');
  assert.equal(avatar.visible, true); assert.equal(presence.room.parent, scene);
  scene.updateMatrixWorld(true);
  nearVector(head.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0, 1.6, 2).applyMatrix4(stage.matrixWorld));
  assert.ok(head.getObjectByName('face-front').position.z < 0);
  assert.ok(head.children.filter(mesh => mesh.name === 'eye').every(eye => eye.position.z < -.1));
  stage.position.x += 3; stage.visible = false;
  presence.update(1020); scene.updateMatrixWorld(true);
  nearVector(head.getWorldPosition(new THREE.Vector3()), new THREE.Vector3(0, 1.6, 2).applyMatrix4(stage.matrixWorld));
  assert.equal(avatar.visible, true, 'portal visibility does not hide audience presence');
  presence.dispose();
});

test('remote interpolation uses local receive times, slerps rotation, and rejects stale sequence packets', () => {
  const { presence, node } = fixture(); presence.setPeers([peer('friend')], 'self');
  presence.receive(packet('friend', 1000, 0, { head: pose([0, 1, 2]) }));
  const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
  presence.receive(packet('friend', 1100, 1, { head: pose([1, 1, 2], turn.toArray()) }));
  presence.update(1130); const head = node('friend').getObjectByName('audience-head');
  nearVector(head.position, new THREE.Vector3(.5, 1, 2));
  assert.ok(head.quaternion.angleTo(new THREE.Quaternion().slerp(turn, .5)) < 1e-7);
  assert.equal(presence.receive(packet('friend', 1150, 1, { head: pose([99, 1, 2]) })), false);
  assert.equal(presence.receive(packet('friend', 1090, 2)), false);
  assert.equal(presence.receive({ ...packet('friend', 1200, 2), referenceSpace: 'local-floor' }), false);
  presence.update(1250); nearVector(head.position, new THREE.Vector3(1, 1, 2));
  presence.dispose();
});

test('missing tracking hides immediately; phone hands stay hidden even if a packet contains them', () => {
  const { presence, node } = fixture(); presence.setPeers([peer('hmd'), peer('phone', 'phone')], 'self');
  presence.receive(packet('hmd', 1000, 0, { left: pose([-.3, 1, 2]), right: pose([.3, 1, 2]) }));
  presence.receive(packet('phone', 1000, 0, { left: pose([-.3, 1, 2]), right: pose([.3, 1, 2]) }, 'phone'));
  presence.update(1000);
  assert.equal(node('hmd').getObjectByName('audience-left').visible, true);
  assert.equal(node('phone').getObjectByName('audience-left').visible, false);
  presence.receive(packet('hmd', 1050, 1, { left: null, right: pose([.3, 1, 2], q, { emulatedPosition: true }) }));
  assert.equal(node('hmd').getObjectByName('audience-left').visible, false);
  assert.equal(node('hmd').getObjectByName('audience-right').visible, false);
  presence.receive(packet('hmd', 1100, 2, { head: null, left: pose() }));
  assert.equal(node('hmd').visible, false);
  presence.update(1120); assert.equal(node('hmd').visible, false);
  presence.receive(packet('phone', 1150, 1, { visibility: 'hidden' }, 'phone'));
  assert.equal(node('phone').visible, false);
  presence.dispose();
});

test('TTL hides stale peers, reacquisition does not interpolate across a gap, and roster departure clears nodes', () => {
  const { presence, node } = fixture(); presence.setPeers([peer('friend')], 'self');
  presence.receive(packet('friend', 1000, 0)); presence.update(1000); assert.equal(node('friend').visible, true);
  presence.update(2001); assert.equal(node('friend').visible, false);
  presence.receive(packet('friend', 2100, 1, { head: pose([4, 1, 2]) })); presence.update(2100);
  assert.equal(node('friend').visible, true); nearVector(node('friend').getObjectByName('audience-head').position, new THREE.Vector3(4, 1, 2));
  presence.setPeers([], 'self'); assert.equal(presence.size, 0); assert.equal(presence.room.children.length, 0);
  assert.equal(presence.receive(packet('friend', 2200, 2)), false);
  presence.dispose();
});

test('room size is bounded and clear/dispose release all nodes and shared GPU resources exactly once', () => {
  const { scene, presence } = fixture();
  presence.setPeers(Array.from({ length: 25 }, (_, i) => peer(`peer-${i}`)), 'self');
  assert.equal(presence.size, 16);
  const geometries = new Set(), materials = new Set();
  presence.room.traverse(object => { if (object.isMesh) { geometries.add(object.geometry); materials.add(object.material); } });
  let geometryDisposals = 0, materialDisposals = 0;
  for (const geometry of geometries) geometry.addEventListener('dispose', () => geometryDisposals++);
  for (const material of materials) material.addEventListener('dispose', () => materialDisposals++);
  presence.clear(); assert.equal(presence.size, 0); assert.equal(presence.room.children.length, 0);
  assert.equal(geometryDisposals, 0, 'shared assets remain reusable until final dispose');
  presence.dispose(); presence.dispose();
  assert.equal(scene.children.includes(presence.room), false);
  assert.equal(geometryDisposals, geometries.size); assert.equal(materialDisposals, materials.size);
  presence.setPeers([peer('late')], 'self'); assert.equal(presence.size, 0);
  assert.equal(presence.receive(packet('late', 1000, 0)), false);
});
