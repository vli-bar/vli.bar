import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMRequiredHumanBoneName } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';
import { exportMotionVRMA } from '../src/vrma-export.js';
import { applyDemoMotion } from '../src/demo-motion.js';
import { applyCaptureToVRM, applyMotionSampleToVRM, serializeMotionClip, validateMotionClip } from '../src/motion-data.js';
import { LiveMotionSampler, MotionRecorder } from '../src/motion-capture.js';
import { parseVRMA, createVRMAPlayer } from '../src/vrma.js';

async function avatar() {
  const buffer = await readFile(new URL('../public/demo/vli-performer.vrm', import.meta.url));
  const loader = new GLTFLoader(); loader.register(parser => new VRMLoaderPlugin(parser));
  return (await loader.parseAsync(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), '')).userData.vrm;
}
async function loadAnimation(buffer) {
  const loader = new GLTFLoader(); loader.register(parser => new VRMAnimationLoaderPlugin(parser));
  return loader.parseAsync(buffer, '');
}
function jsonChunk(buffer) {
  const view = new DataView(buffer);
  assert.equal(view.getUint32(0, true), 0x46546c67);
  assert.equal(view.getUint32(4, true), 2);
  assert.equal(view.getUint32(8, true), buffer.byteLength);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, view.getUint32(12, true))));
}
const demo = JSON.parse(await readFile(new URL('../public/demo/motion.json', import.meta.url), 'utf8'));
const capture = JSON.parse(await readFile(new URL('./fixtures/capture-sample.json', import.meta.url), 'utf8'));
const headOnlyCapture = { ...capture, frames: capture.frames.map(frame => ({ ...frame, left: null, right: null })) };

test('VRMA GLB follows VRMC_vrm_animation 1.0 hierarchy and channel restrictions', async () => {
  const vrm = await avatar();
  const exported = exportMotionVRMA(vrm, demo);
  const json = jsonChunk(exported);
  const extension = json.extensions.VRMC_vrm_animation;
  assert.equal(extension.specVersion, '1.0');
  assert.ok(json.extensionsUsed.includes('VRMC_vrm_animation'));
  assert.equal(json.animations.length, 1);
  assert.equal(json.meshes, undefined);
  assert.equal(json.images, undefined);
  assert.equal(json.buffers[0].uri, undefined);
  const mapping = extension.humanoid.humanBones;
  for (const required of Object.values(VRMRequiredHumanBoneName)) assert.ok(mapping[required]);
  assert.equal(mapping.leftEye, undefined); assert.equal(mapping.rightEye, undefined);
  const mapped = new Set(Object.values(mapping).map(entry => entry.node));
  for (const entry of Object.values(mapping)) {
    const node = json.nodes[entry.node];
    assert.ok(node); assert.equal(node.scale, undefined); assert.equal(node.rotation, undefined);
    assert.ok(node.translation.every(Number.isFinite));
  }
  assert.ok(json.nodes[mapping.hips.node].translation[1] > .1);
  const expressions = extension.expressions.preset;
  for (const name of ['aa', 'happy', 'blink']) assert.ok(json.nodes[expressions[name].node]);
  for (const channel of json.animations[0].channels) {
    const { node, path } = channel.target;
    assert.ok(json.nodes[node]);
    assert.ok(path === 'rotation' || path === 'translation');
    if (mapped.has(node) && path === 'translation') assert.equal(node, mapping.hips.node);
    if (!mapped.has(node)) {
      assert.equal(path, 'translation');
      const sampler = json.animations[0].samplers[channel.sampler];
      assert.equal(json.accessors[sampler.output].type, 'VEC3');
    }
  }
  for (const accessor of json.accessors) {
    assert.equal(accessor.componentType, 5126);
    assert.equal(accessor.count, 2161);
    const bufferView = json.bufferViews[accessor.bufferView];
    assert.equal(bufferView.byteOffset % 4, 0);
    assert.ok(bufferView.byteOffset + bufferView.byteLength <= json.buffers[0].byteLength);
  }
});

for (const [name, source, samples] of [['demo choreography', demo, [0, 7.5, 17.733333333, 41.5, 65.3]], ['captured head and hands', capture, [0, .5, 1, 1.5]]]) {
  test(`${name} round-trips through the official VRMA loader and humanoid retargeter`, async () => {
    const vrm = await avatar();
    const exported = exportMotionVRMA(vrm, source);
    const loaded = await loadAnimation(exported);
    assert.equal(loaded.userData.vrmAnimations.length, 1);
    const animation = loaded.userData.vrmAnimations[0];
    assert.ok(Math.abs(animation.duration - source.duration) < 1e-5);
    const clip = createVRMAnimationClip(animation, vrm);
    const mixer = new THREE.AnimationMixer(vrm.scene);
    const action = mixer.clipAction(clip); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play();
    const restHips = vrm.humanoid.getNormalizedBoneNode('hips').position.clone();
    for (const t of samples) {
      vrm.humanoid.resetNormalizedPose();
      for (const expression of ['aa', 'happy', 'blink']) vrm.expressionManager.setValue(expression, 0);
      if (source.format === 'vli.motion-capture') applyCaptureToVRM(vrm, source, t);
      else applyDemoMotion(vrm, source, t, restHips);
      const expected = vrm.humanoid.getNormalizedPose();
      const weights = ['aa', 'happy', 'blink'].map(expression => vrm.expressionManager.getValue(expression));
      vrm.humanoid.resetNormalizedPose();
      mixer.setTime(t);
      const actual = vrm.humanoid.getNormalizedPose();
      for (const [bone, pose] of Object.entries(expected)) {
        const a = new THREE.Quaternion().fromArray(pose.rotation);
        const b = new THREE.Quaternion().fromArray(actual[bone].rotation);
        assert.ok(a.angleTo(b) < .001, `${bone} rotation differs at ${t}: ${a.angleTo(b)}`);
      }
      const positionError = new THREE.Vector3().fromArray(expected.hips.position).distanceTo(new THREE.Vector3().fromArray(actual.hips.position));
      assert.ok(positionError < .00001, `hips translation differs at ${t}: ${positionError}`);
      // glTF stores key times as Float32. Near a blink's sharp peak, a few
      // microseconds of quantization can change the weight by ~0.0001.
      ['aa', 'happy', 'blink'].forEach((expression, i) => assert.ok(Math.abs(vrm.expressionManager.getValue(expression) - weights[i]) < .001, `${expression} differs at ${t}`));
    }
    mixer.stopAllAction();
  });
}

test('head-only capture identifies unavailable hands and replays through standard VRMA without inventing hand motion', async () => {
  const vrm = await avatar(), expectedVRM = await avatar();
  const exported = exportMotionVRMA(vrm, headOnlyCapture);
  assert.match(jsonChunk(exported).extras.source, /head capture only; hands not tracked/);
  const source = await parseVRMA(exported);
  assert.equal(source.version, 1); assert.equal(source.duration, headOnlyCapture.duration);
  const player = createVRMAPlayer(vrm, source);
  // Use a separate rig for reference poses: mutating the mixer's own rig
  // between seeks bypasses Three's cached constant animation properties.
  for (const t of [0, .5, 1, 1.5, 2, .5]) {
    applyCaptureToVRM(expectedVRM, headOnlyCapture, t);
    player.seek(t);
    const expected = expectedVRM.humanoid.getNormalizedPose(), actual = vrm.humanoid.getNormalizedPose();
    for (const [bone, pose] of Object.entries(expected)) {
      const a = new THREE.Quaternion().fromArray(pose.rotation), b = new THREE.Quaternion().fromArray(actual[bone].rotation);
      assert.ok(a.angleTo(b) < .001, `${bone} differs from head-only preview at ${t}`);
    }
    assert.ok(new THREE.Vector3().fromArray(expected.hips.position).distanceTo(new THREE.Vector3().fromArray(actual.hips.position)) < .00001);
  }
  player.dispose();
});

test('camera export metadata identifies estimates instead of WebXR device tracking', async () => {
  const vrm = await avatar();
  const exported = exportMotionVRMA(vrm, { ...capture, referenceSpace: 'camera' });
  assert.match(jsonChunk(exported).extras.source, /^Camera pose estimates;/);
});

test('export preserves live pose, expressions and world presentation transforms', async () => {
  const vrm = await avatar();
  const hips = vrm.humanoid.getNormalizedBoneNode('hips');
  hips.position.x = .37;
  vrm.humanoid.getNormalizedBoneNode('head').rotation.set(.2, .4, -.1);
  vrm.expressionManager.setValue('happy', .73); vrm.expressionManager.setValue('aa', .31);
  vrm.scene.position.set(1, 2, 3); vrm.scene.rotation.y = .75; vrm.scene.scale.setScalar(.8);
  const pose = vrm.humanoid.getNormalizedPose(), position = vrm.scene.position.toArray(), rotation = vrm.scene.quaternion.toArray();
  exportMotionVRMA(vrm, capture);
  assert.deepEqual(vrm.humanoid.getNormalizedPose(), pose);
  assert.equal(vrm.expressionManager.getValue('happy'), .73); assert.equal(vrm.expressionManager.getValue('aa'), .31);
  assert.deepEqual(vrm.scene.position.toArray(), position); assert.deepEqual(vrm.scene.quaternion.toArray(), rotation); assert.equal(vrm.scene.scale.x, .8);
  assert.throws(() => exportMotionVRMA(vrm, demo, { fps: 120 }), /fps/);
  assert.throws(() => exportMotionVRMA(vrm, { ...capture, version: 99 }), /モーションデータ/);
  assert.throws(() => exportMotionVRMA(vrm, { ...capture, duration: 0, frames: [capture.frames[0]] }), /短すぎます/);
  assert.deepEqual(vrm.humanoid.getNormalizedPose(), pose);
  vrm.meta.metaVersion = '0';
  assert.throws(() => exportMotionVRMA(vrm, capture), /VRM 1.0/);
});

test('distributed VRMA loads with the official implementation and matches demo duration', async () => {
  const bytes = await readFile(new URL('../public/demo/neon-door.vrma', import.meta.url));
  const loaded = await loadAnimation(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const animation = loaded.userData.vrmAnimations[0];
  assert.equal(animation.duration, demo.duration);
  assert.ok(animation.humanoidTracks.rotation.size >= 15);
  assert.ok(animation.humanoidTracks.translation.has('hips'));
  assert.ok(animation.expressionTracks.preset.has('happy'));
});

test('exported capture imports and seeks through the application standard VRMA path', async () => {
  const vrm = await avatar();
  const buffer = exportMotionVRMA(vrm, capture);
  const source = await parseVRMA(buffer);
  assert.equal(source.format, 'vrma'); assert.equal(source.duration, capture.duration);
  const restHips = vrm.humanoid.getNormalizedBoneNode('hips').position.clone();
  applyCaptureToVRM(vrm, capture, .5);
  const expected = vrm.humanoid.getNormalizedBoneNode('leftUpperArm').quaternion.clone();
  const player = createVRMAPlayer(vrm, source);
  player.seek(.5);
  assert.ok(vrm.humanoid.getNormalizedBoneNode('leftUpperArm').quaternion.angleTo(expected) < .001);
  player.seek(2); player.seek(.5);
  assert.ok(vrm.humanoid.getNormalizedBoneNode('leftUpperArm').quaternion.angleTo(expected) < .001);
  player.dispose();
  assert.ok(restHips.y > 0);
});

test('observed body and HMD poses agree between live display, saved preview and standard VRMA playback', async () => {
  const vrm = await avatar();
  const live = new LiveMotionSampler({ referenceSpaceType: 'local-floor' });
  const recorder = new MotionRecorder(); recorder.start();
  const expected = new Map();
  const trackedPose = (position, yaw = 0) => ({ transform: { position: { x: position[0], y: position[1], z: position[2] },
    orientation: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) } }, emulatedPosition: false });
  for (let i = 0; i <= 60; i++) {
    const t = i / 30, bend = Math.sin(t * Math.PI) * .08, bob = Math.sin(t * Math.PI) * .025;
    const positions = {
      hips: [0, .95 + bob, 0], chest: [0, 1.3 + bob, 0], neck: [0, 1.5 + bob, 0], head: [0, 1.6 + bob, 0],
      'left-upper-leg': [-.1, .92 + bob, 0], 'left-lower-leg': [-.1, .59 + bob, -.13 - bend],
      'left-foot-ankle': [-.1, .2, .08], 'left-foot-ball': [-.1, .12, -.03],
      'right-upper-leg': [.1, .92 + bob, 0], 'right-lower-leg': [.1, .56 + bob, 0],
      'right-foot-ankle': [.1, .2, 0], 'right-foot-ball': [.1, .12, -.12],
      'left-arm-upper': [-.2, 1.36 + bob, 0], 'left-arm-lower': [-.45, 1.12 + bob, -.16], 'left-hand-wrist': [-.4, .94 + bob, -.28],
      'right-arm-upper': [.2, 1.36 + bob, 0], 'right-arm-lower': [.45, 1.12 + bob, -.16], 'right-hand-wrist': [.4, .94 + bob, -.28],
    };
    const frame = { session: { visibilityState: 'visible', inputSources: [] }, body: new Map(Object.keys(positions).map(name => [name, name])),
      getViewerPose: () => trackedPose(positions.head, .2), getPose: name => trackedPose(positions[name]) };
    const tracking = live.sampleFrame(t * 1000, frame, {});
    recorder.recordSample(t * 1000, tracking);
    if ([0, 15, 45].includes(i)) {
      assert.equal(applyMotionSampleToVRM(vrm, tracking.sample, tracking), true);
      expected.set(t, vrm.humanoid.getNormalizedPose());
    }
  }
  const take = validateMotionClip(JSON.parse(serializeMotionClip(recorder.stop())));
  assert.equal(take.tracking.body, 'browser-body');
  assert.equal(Object.keys(take.frames[0].body).length, 18);
  assert.ok(Math.abs(expected.get(0).leftLowerLeg.rotation[0]) > .1, 'an observed bent leg overrides the head/controller-only estimate');
  const standard = await parseVRMA(exportMotionVRMA(vrm, take));
  assert.equal(standard.duration, 2);
  const player = createVRMAPlayer(vrm, standard);
  const compare = (actual, target, label) => {
    for (const name of ['hips', 'head', 'spine', 'leftUpperArm', 'leftLowerArm', 'leftUpperLeg', 'leftLowerLeg', 'rightLowerLeg']) {
      const a = new THREE.Quaternion().fromArray(actual[name].rotation), b = new THREE.Quaternion().fromArray(target[name].rotation);
      assert.ok(a.angleTo(b) < .001, `${label}: ${name} differs`);
    }
    assert.ok(new THREE.Vector3().fromArray(actual.hips.position).distanceTo(new THREE.Vector3().fromArray(target.hips.position)) < .00001, `${label}: hips position differs`);
  };
  for (const [t, livePose] of expected) {
    applyCaptureToVRM(vrm, take, t);
    compare(vrm.humanoid.getNormalizedPose(), livePose, `saved preview at ${t}`);
    player.seek(t);
    compare(vrm.humanoid.getNormalizedPose(), livePose, `VRMA at ${t}`);
  }
  player.dispose();
});
