import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BODY_JOINT_NAMES, readBodyJoints, sanitizeBodyJoints, interpolateBodyJoints, applyBodyToVRM } from '../src/body-tracking.js';

const pose = (position = [0, -.6, 0], quaternion = [0, 0, 0, 1], emulatedPosition = false) => ({ position, quaternion, emulatedPosition });
const xrPose = (p = [0, 1, 0], q = [0, 0, 0, 1], emulatedPosition = false) => ({
  transform: { position: Object.fromEntries(['x', 'y', 'z'].map((n, i) => [n, p[i]])), orientation: Object.fromEntries(['x', 'y', 'z', 'w'].map((n, i) => [n, q[i]])) },
  emulatedPosition,
});

test('body reader follows actual XRBody spaces and preserves calibration and emulation', () => {
  const hips = {}, head = {}, ignoredFinger = {};
  const reference = {};
  const spaces = new Map([['hips', hips], ['head', head], ['left-hand-index-tip', ignoredFinger]]);
  const seen = [];
  const frame = { body: spaces, getPose(space, ref) {
    assert.equal(ref, reference);
    seen.push(space);
    return space === hips ? xrPose([2, 1, -3], [0, 0, 0, 1], true) : xrPose([2, 1.6, -3]);
  } };
  const body = readBodyJoints(frame, reference, source => ({
    position: [source.transform.position.x - 2, source.transform.position.y - 1.6, source.transform.position.z + 3],
    quaternion: [0, 0, 0, 1], emulatedPosition: source.emulatedPosition,
  }));
  assert.equal(body.status, 'tracked');
  assert.equal(body.jointCount, 2);
  assert.equal(body.emulatedCount, 1);
  assert.deepEqual(body.joints.hips, pose([0, -.6, 0], [0, 0, 0, 1], true));
  assert.deepEqual(body.joints.head.position, [0, 0, 0]);
  assert.ok(!seen.includes(ignoredFinger));
  assert.equal(BODY_JOINT_NAMES.length, 23);
});

test('body availability does not manufacture observations or invoke guessed APIs', () => {
  const reference = {};
  const absent = { getPose() {}, getBodyPose() { assert.fail('nonstandard guessed API must not be called'); } };
  assert.equal(readBodyJoints(absent, reference).status, 'unavailable');
  assert.equal(readBodyJoints({ ...absent, body: null }, reference).status, 'unavailable');
  assert.equal(readBodyJoints({ ...absent, body: null, session: { enabledFeatures: ['body-tracking'] } }, reference).status, 'not-tracked');
  assert.equal(readBodyJoints({ ...absent, body: new Map([['hips', {}]]) }, reference).status, 'not-tracked');
  const blocked = { getPose() {}, get body() { throw new Error('denied'); } };
  assert.equal(readBodyJoints(blocked, reference).status, 'error');
  assert.equal(readBodyJoints(null, reference).joints, null);
});

test('invalid or inaccessible joints leave a bounded partial observation', () => {
  const body = new Map([['head', 'head'], ['hips', 'hips'], ['left-lower-leg', 'leg']]);
  const result = readBodyJoints({ body, getPose(space) {
    if (space === 'hips') throw new Error('tracking lost');
    return space === 'leg' ? xrPose([NaN, 1, 0]) : xrPose();
  } }, {});
  assert.equal(result.status, 'tracked');
  assert.equal(result.jointCount, 1);
  assert.equal(result.readErrors, 2);
  assert.ok(result.joints.head);
});

test('body import strips arbitrary fields while rejecting malformed known joint data', () => {
  const source = { hips: { ...pose(), dangerous: 'drop' }, 'made-up-joint': 'drop', head: null };
  assert.deepEqual(sanitizeBodyJoints(source), { hips: pose() });
  assert.notEqual(sanitizeBodyJoints(source).hips.position, source.hips.position);
  assert.equal(sanitizeBodyJoints(undefined), null);
  assert.equal(sanitizeBodyJoints({ unknown: true }), null);
  for (const value of [[], 4, 'hips']) assert.throws(() => sanitizeBodyJoints(value), /身体関節/);
  for (const malformed of [pose([Infinity, 0, 0]), pose([101, 0, 0]), pose([0, 0]), pose([0, 0, 0], [0, 0, 0, 0]), pose([0, 0, 0], [0, 0, 0, 2]), pose([0, 0, 0], [0, 0, 0, 1], 'yes')]) {
    assert.throws(() => sanitizeBodyJoints({ hips: malformed }));
  }
  const normalized = sanitizeBodyJoints({ hips: pose([0, 0, 0], [0, 0, 0, .999]) });
  assert.deepEqual(normalized.hips.quaternion, [0, 0, 0, 1]);
});

test('body interpolation follows shortest rotation and never fills tracking gaps', () => {
  const a = { hips: pose([0, -.6, 0]), head: pose() };
  const b = { hips: pose([.2, -.8, .4], [0, 0, 0, -1], true) };
  const middle = interpolateBodyJoints(a, b, .5);
  assert.deepEqual(middle.hips.position, [.1, -.7, .2]);
  assert.deepEqual(middle.hips.quaternion, [0, 0, 0, 1]);
  assert.equal(middle.hips.emulatedPosition, true);
  assert.ok(!middle.head);
  assert.equal(interpolateBodyJoints(a, null, .5), null);
  assert.equal(interpolateBodyJoints({ head: pose() }, b, .5), null);
  assert.deepEqual(a.hips.position, [0, -.6, 0]);
});

function rig(version) {
  const scene = new THREE.Group();
  scene.position.set(3, .2, -2);
  scene.rotation.y = .4;
  scene.scale.setScalar(1.3);
  const nodes = {};
  const add = (name, parent, position) => {
    const node = new THREE.Bone();
    node.position.fromArray(position);
    parent.add(node);
    nodes[name] = node;
    return node;
  };
  const hips = add('hips', scene, [0, .9, 0]);
  const spine = add('spine', hips, [0, .25, 0]);
  add('head', spine, [0, .45, 0]);
  for (const side of ['left', 'right']) {
    const sign = (side === 'left' ? 1 : -1) * (version === 1 ? 1 : -1);
    const arm = add(side + 'UpperArm', spine, [sign * .2, .25, 0]);
    const elbow = add(side + 'LowerArm', arm, [sign * .3, 0, 0]);
    add(side + 'Hand', elbow, [sign * .25, 0, 0]);
    const thigh = add(side + 'UpperLeg', hips, [sign * .1, -.05, 0]);
    const shin = add(side + 'LowerLeg', thigh, [0, -.4, 0]);
    const foot = add(side + 'Foot', shin, [0, -.4, 0]);
    add(side + 'Toes', foot, [0, 0, version === 1 ? .1 : -.1]);
  }
  return { nodes, vrm: { scene, humanoid: { getNormalizedBoneNode: name => nodes[name] } } };
}

test('body retarget transfers observed limbs in VRM 0/1 coordinates without moving the stage', () => {
  for (const version of [0, 1]) {
    const { vrm, nodes } = rig(version);
    const basis = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), version === 1 ? Math.PI : 0);
    const context = { basis, headAnchor: new THREE.Vector3(0, 1.6, 0), meterScale: 1 };
    const joints = {
      hips: pose([.2, -.7, 0]),
      'left-arm-upper': pose([-.2, -.2, 0]), 'left-arm-lower': pose([-.2, .1, 0]), 'left-hand-wrist': pose([-.2, .4, 0]),
      'left-upper-leg': pose([-.1, -.75, 0]), 'left-lower-leg': pose([-.1, -1.1, -.3]), 'left-foot-ankle': pose([-.1, -1.5, -.1]),
    };
    nodes.rightUpperArm.rotation.z = .3;
    nodes.head.rotation.y = .2;
    vrm.scene.updateMatrixWorld(true);
    const stageMatrix = vrm.scene.matrixWorld.clone();
    const headRotation = nodes.head.getWorldQuaternion(new THREE.Quaternion());
    assert.equal(applyBodyToVRM(vrm, joints, context), true);
    const hipsLocal = vrm.scene.worldToLocal(nodes.hips.getWorldPosition(new THREE.Vector3()));
    assert.ok(hipsLocal.distanceTo(new THREE.Vector3(version === 1 ? -.2 : .2, .9, 0)) < 1e-8);
    const limbDirection = (a, b) => nodes[b].getWorldPosition(new THREE.Vector3()).sub(nodes[a].getWorldPosition(new THREE.Vector3())).normalize();
    assert.ok(limbDirection('leftUpperArm', 'leftLowerArm').dot(new THREE.Vector3(0, 1, 0)) > .99999);
    const targetLeg = new THREE.Vector3(0, -.35, -.3).applyQuaternion(basis).transformDirection(vrm.scene.matrixWorld);
    assert.ok(limbDirection('leftUpperLeg', 'leftLowerLeg').dot(targetLeg) > .99999);
    assert.ok(nodes.head.getWorldQuaternion(new THREE.Quaternion()).angleTo(headRotation) < 1e-7);
    assert.ok(Math.abs(nodes.rightUpperArm.rotation.z - .3) < 1e-7);
    assert.deepEqual(vrm.scene.matrixWorld.elements, stageMatrix.elements);
    const once = nodes.hips.position.clone();
    applyBodyToVRM(vrm, joints, context);
    assert.ok(nodes.hips.position.distanceTo(once) < 1e-8, 'absolute calibrated hips must not accumulate');
  }
});

test('body pelvis yaw follows anatomical positions while the HMD head orientation remains stable', () => {
  const { vrm, nodes } = rig(1);
  const context = { basis: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI), headAnchor: new THREE.Vector3(0, 1.6, 0), meterScale: 1 };
  const joints = { hips: pose([0, -.7, 0]), chest: pose([0, -.3, 0]), 'left-upper-leg': pose([0, -.75, -.1]), 'right-upper-leg': pose([0, -.75, .1]) };
  vrm.scene.updateMatrixWorld(true);
  const oldHead = nodes.head.getWorldQuaternion(new THREE.Quaternion());
  applyBodyToVRM(vrm, joints, context);
  const lateral = nodes.leftUpperLeg.getWorldPosition(new THREE.Vector3()).sub(nodes.rightUpperLeg.getWorldPosition(new THREE.Vector3())).normalize();
  const target = new THREE.Vector3(0, 0, -1).applyQuaternion(context.basis).transformDirection(vrm.scene.matrixWorld);
  assert.ok(lateral.dot(target) > .99999);
  assert.ok(nodes.head.getWorldQuaternion(new THREE.Quaternion()).angleTo(oldHead) < 1e-7);
  assert.equal(applyBodyToVRM(vrm, null, context), false);
  assert.equal(applyBodyToVRM(vrm, { 'left-hand-wrist': pose() }, context), false);
});
