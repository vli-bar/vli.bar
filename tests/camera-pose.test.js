import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { CameraPoseSampler, createCameraPoseSampler } from '../src/camera-pose.js';
import { MotionRecorder } from '../src/motion-capture.js';
import { applyMotionSampleToVRM, applyCaptureToVRM, serializeMotionClip, validateMotionClip, sampleMotionClip } from '../src/motion-data.js';
import { exportMotionVRMA } from '../src/vrma-export.js';
import { parseVRMA, createVRMAPlayer } from '../src/vrma.js';

function landmarks({ raised = false } = {}) {
  const world = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, visibility: .99, presence: .99 }));
  const points = {
    0: [0, -.67, -.12], 2: [.035, -.71, -.045], 5: [-.035, -.71, -.045],
    7: [.075, -.67, 0], 8: [-.075, -.67, 0], 9: [.04, -.61, -.08], 10: [-.04, -.61, -.08],
    11: [.2, -.45, 0], 12: [-.2, -.45, 0], 13: [.47, -.45, 0], 14: [-.47, -.45, 0],
    15: [.71, -.45, 0], 16: [-.71, -.45, 0], 23: [.11, 0, 0], 24: [-.11, 0, 0],
    25: [.11, .42, 0], 26: [-.11, .42, 0], 27: [.11, .84, 0], 28: [-.11, .84, 0],
    31: [.11, .89, -.13], 32: [-.11, .89, -.13],
  };
  if (raised) { points[13] = [.2, -.76, 0]; points[15] = [.2, -1, 0]; }
  for (const [index, [x, y, z]] of Object.entries(points)) Object.assign(world[index], { x, y, z });
  const image = world.map(point => ({ ...point, x: .5 + point.x * .4, y: .5 + point.y * .35 }));
  return { landmarks: [image], worldLandmarks: [world] };
}

async function avatar() {
  const bytes = await readFile(new URL('../public/demo/vli-performer.vrm', import.meta.url));
  const loader = new GLTFLoader(); loader.register(parser => new VRMLoaderPlugin(parser));
  return (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).userData.vrm;
}

test('camera landmarks retain anatomical sides and are explicitly estimated head-relative data', () => {
  const sampler = createCameraPoseSampler();
  const tracked = sampler.sample(landmarks(), 1000);
  assert.equal(tracked.referenceSpace, 'camera');
  assert.equal(tracked.source, 'camera-pose');
  assert.equal(tracked.absolutePosition, false);
  assert.equal(tracked.bodyCount, 23);
  assert.equal(tracked.bodyEmulatedCount, 23);
  assert.equal(tracked.initialHeadHeight, 1.59);
  assert.equal(tracked.sample.t, 0);
  assert.ok(tracked.sample.head.position.every(value => value === 0));
  assert.ok(tracked.sample.left.position[0] < 0, 'performer left matches the XR capture axes');
  assert.ok(tracked.sample.right.position[0] > 0);
  for (const pose of [tracked.origin, tracked.sample.head, tracked.sample.left, tracked.sample.right, ...Object.values(tracked.sample.body)]) {
    assert.equal(pose.source, 'camera-pose');
    assert.equal(pose.emulatedPosition, true);
    assert.ok(pose.position.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...pose.quaternion) - 1) < 1e-5);
  }
  const legacy = landmarks();
  assert.equal(new CameraPoseSampler().sample({ poseLandmarks: legacy.landmarks[0], poseWorldLandmarks: legacy.worldLandmarks[0] }, 0).bodyCount, 23);
});

test('camera confidence, image bounds and malformed coordinates create gaps without fabricated joints', () => {
  const sampler = new CameraPoseSampler();
  sampler.sample(landmarks(), 0);
  const missing = landmarks();
  missing.worldLandmarks[0][15].visibility = .2;
  missing.landmarks[0][28].presence = .1;
  missing.landmarks[0][16].x = 1.1;
  missing.worldLandmarks[0][25].x = Infinity;
  for (const index of [7, 8, 2, 5]) missing.worldLandmarks[0][index].visibility = .1;
  const tracked = sampler.sample(missing, 100);
  assert.equal(tracked.sample.head, null);
  assert.equal(tracked.sample.left, null);
  assert.equal(tracked.sample.right, null);
  assert.ok(!tracked.sample.body['right-foot-ankle']);
  assert.ok(!tracked.sample.body['left-lower-leg']);
  assert.ok(!tracked.sample.body.head);
  assert.ok(!tracked.sample.body.neck);
  assert.ok(tracked.sample.body.chest);
  assert.equal(tracked.quality, 'head-unavailable');

  const noPerson = sampler.sample({ landmarks: [], worldLandmarks: [] }, 200);
  assert.equal(noPerson.sample.head, null);
  assert.equal(noPerson.sample.body, null);
  assert.equal(noPerson.bodyCount, 0);
  const twoPeople = landmarks(); twoPeople.landmarks.push(twoPeople.landmarks[0]); twoPeople.worldLandmarks.push(twoPeople.worldLandmarks[0]);
  assert.equal(sampler.sample(twoPeople, 300).sample.body, null);
  const noConfidence = landmarks();
  delete noConfidence.landmarks[0][15].visibility; delete noConfidence.worldLandmarks[0][15].visibility;
  assert.equal(sampler.sample(noConfidence, 400).sample.left, null);
});

test('camera calibration waits for reliable torso and head and rejects impossible limb lengths', () => {
  const sampler = new CameraPoseSampler();
  const hiddenHip = landmarks(); hiddenHip.worldLandmarks[0][23].presence = 0;
  assert.equal(sampler.sample(hiddenHip, 0).origin, null);
  const hiddenHead = landmarks();
  for (const index of [7, 8, 2, 5]) hiddenHead.landmarks[0][index].visibility = 0;
  assert.equal(sampler.sample(hiddenHead, 100).origin, null);
  const badTorso = landmarks(); badTorso.worldLandmarks[0][11].x = 2.5;
  assert.equal(sampler.sample(badTorso, 200).origin, null);
  assert.ok(sampler.sample(landmarks(), 300).origin);
  const impossibleArm = landmarks(); impossibleArm.worldLandmarks[0][15].x = 2.4;
  assert.equal(sampler.sample(impossibleArm, 400).sample.left, null);
  const missing = sampler.sample(null, 500);
  assert.ok(missing.origin, 'calibration remains available while the observed pose is absent');
  assert.equal(missing.sample.body, null);
  sampler.reset();
  assert.equal(sampler.origin, null);
  assert.throws(() => new CameraPoseSampler({ minConfidence: NaN }), /minConfidence/);
});

test('hip-centered model output never becomes absolute camera or room translation', () => {
  const sampler = new CameraPoseSampler();
  const first = sampler.sample(landmarks(), 0);
  const movedModel = landmarks();
  for (const point of movedModel.worldLandmarks[0]) { point.x += .4; point.y += .2; point.z -= .3; }
  const second = sampler.sample(movedModel, 100);
  for (const axis of [0, 1, 2]) {
    assert.ok(Math.abs(first.sample.body.hips.position[axis] - second.sample.body.hips.position[axis]) < 1e-6);
    assert.ok(Math.abs(second.sample.head.position[axis]) < 1e-6);
  }
  assert.equal(sampler.sample(landmarks(), 50).sample.visibility, 'hidden');
});

test('actual VRM preserves T-pose sides and raises only the observed anatomical left arm', async () => {
  const vrm = await avatar();
  const sampler = new CameraPoseSampler();
  const get = name => vrm.humanoid.getNormalizedBoneNode(name);
  const direction = (parent, child) => get(child).getWorldPosition(new THREE.Vector3()).sub(get(parent).getWorldPosition(new THREE.Vector3())).normalize();
  const tpose = sampler.sample(landmarks(), 0);
  assert.equal(applyMotionSampleToVRM(vrm, tpose.sample, tpose), true);
  assert.ok(direction('leftUpperArm', 'leftLowerArm').x > .99);
  assert.ok(direction('rightUpperArm', 'rightLowerArm').x < -.99);
  assert.ok(direction('leftUpperLeg', 'leftLowerLeg').y < -.99);
  const raised = sampler.sample(landmarks({ raised: true }), 1000);
  assert.equal(applyMotionSampleToVRM(vrm, raised.sample, raised), true);
  assert.ok(direction('leftUpperArm', 'leftLowerArm').y > .99);
  assert.ok(direction('leftLowerArm', 'leftHand').y > .99);
  assert.ok(direction('rightUpperArm', 'rightLowerArm').x < -.99);
});

test('estimated camera take survives raw import and standard VRMA retargeting with gaps intact', async () => {
  const vrm = await avatar();
  const sampler = new CameraPoseSampler();
  const recorder = new MotionRecorder(); recorder.start({ referenceSpaceType: 'camera' });
  const first = sampler.sample(landmarks(), 1000);
  recorder.recordSample(1000, first);
  const middle = sampler.sample(landmarks({ raised: true }), 1500);
  recorder.recordSample(1500, middle);
  const last = sampler.sample(landmarks(), 2000);
  recorder.recordSample(2000, last);
  const take = validateMotionClip(JSON.parse(serializeMotionClip(recorder.stop())));
  assert.equal(take.referenceSpace, 'camera');
  assert.deepEqual(take.tracking, { head: 'camera-pose', hands: 'camera-pose', body: 'camera-pose' });
  assert.ok(take.frames.every(frame => frame.head.source === 'camera-pose' && frame.head.emulatedPosition));
  assert.ok(take.frames.every(frame => Object.values(frame.body).every(joint => joint.emulatedPosition)));
  applyCaptureToVRM(vrm, take, .5);
  const expected = vrm.humanoid.getNormalizedPose();
  const standard = await parseVRMA(exportMotionVRMA(vrm, take));
  const player = createVRMAPlayer(vrm, standard); player.seek(.5);
  const actual = vrm.humanoid.getNormalizedPose();
  for (const name of ['hips', 'head', 'leftUpperArm', 'leftLowerArm', 'leftUpperLeg', 'rightUpperArm']) {
    assert.ok(new THREE.Quaternion().fromArray(expected[name].rotation).angleTo(new THREE.Quaternion().fromArray(actual[name].rotation)) < .001, name);
  }
  player.dispose();
  assert.ok(sampleMotionClip(take, .25).head, 'valid camera observations at the 500ms boundary interpolate');
  // Camera provenance cannot be imported as measured XR data just by removing
  // flags from its reference-space-tagged payload.
  take.origin.emulatedPosition = false;
  take.frames[0].head.emulatedPosition = false;
  take.frames[0].head.source = 'viewer';
  take.frames[0].body.hips.emulatedPosition = false;
  const clean = validateMotionClip(take);
  assert.equal(clean.origin.emulatedPosition, true);
  assert.equal(clean.frames[0].head.source, 'camera-pose');
  assert.equal(clean.frames[0].body.hips.emulatedPosition, true);
});
