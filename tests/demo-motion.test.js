import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { applyDemoMotion, sampleDemoMotion, validateDemoMotion } from '../src/demo-motion.js';

const source = JSON.parse(await readFile(new URL('../public/demo/motion.json', import.meta.url), 'utf8'));
const clip = validateDemoMotion(source);
const smallClip = () => ({
  title: 'Uploaded dance', duration: 2, fps: 30,
  frames: [
    { t: 0, bones: { hips: [0, 0, 0], head: [0, 0, 0] } },
    { t: .3, bones: { hips: [0, .2, 0], head: [0, .3, 0] } },
    { t: 2, bones: { hips: [0, .4, 0], head: [0, .6, 0] } },
  ],
});

test('generated choreography imports without losing animation data or retaining arbitrary properties', () => {
  assert.equal(clip.format, 'vli.demo-motion');
  assert.equal(clip.duration, 72);
  assert.equal(clip.frames.length, 2161);
  assert.deepEqual(clip.frames, source.frames);
  const uploaded = smallClip();
  uploaded.untrusted = '<script>arbitrary metadata</script>';
  uploaded.frames[0].extra = { unknown: true };
  const clean = validateDemoMotion(uploaded);
  assert.equal(clean.untrusted, undefined);
  assert.equal(clean.frames[0].extra, undefined);
  clean.frames[0].bones.head[0] = 1;
  assert.equal(uploaded.frames[0].bones.head[0], 0, 'validated import does not alias input rotations');
});

test('invalid uploaded choreography is rejected before reaching the rig', () => {
  const changes = [
    data => { data.duration = 181; },
    data => { data.duration = 0; },
    data => { data.fps = 61; },
    data => { data.frames[0].t = .01; },
    data => { data.frames[1].t = 0; },
    data => { data.frames[2].t = 1.9; },
    data => { data.frames[1].bones.head = [NaN, 0, 0]; },
    data => { data.frames[1].bones.head = [0, 0]; },
    data => { data.frames[1].bones.head = [0, 13, 0]; },
    data => { data.frames[1].bones.unknown = [0, 0, 0]; },
    data => { data.frames[1].root = [0, 3, 0]; },
    data => { data.frames[1].happy = 1.1; },
    data => { data.frames[1].blink = -1; },
    data => { data.frames[1].aa = Infinity; },
  ];
  for (const mutate of changes) {
    const data = smallClip();
    mutate(data);
    assert.throws(() => validateDemoMotion(data), /振り付けJSON/);
  }
});

test('sampling uses actual timestamps and clamps the playback interval', () => {
  const motion = validateDemoMotion(smallClip());
  const middle = sampleDemoMotion(motion, .15);
  assert.equal(middle.a.t, 0);
  assert.equal(middle.b.t, .3);
  assert.ok(Math.abs(middle.alpha - .5) < 1e-12);
  const later = sampleDemoMotion(motion, 1.15);
  assert.equal(later.a.t, .3);
  assert.equal(later.b.t, 2);
  assert.ok(Math.abs(later.alpha - .5) < 1e-12);
  assert.equal(sampleDemoMotion(motion, -10).alpha, 0);
  assert.equal(sampleDemoMotion(motion, 100).a.t, 2);
  assert.equal(sampleDemoMotion(motion, 100).alpha, 0);
});

test('rotation interpolation takes the short arc and root offsets never accumulate', () => {
  const hips = new THREE.Object3D();
  const restHips = new THREE.Vector3(0, .9, 0);
  hips.position.copy(restHips);
  const expressions = {};
  const vrm = {
    humanoid: { getNormalizedBoneNode: name => name === 'hips' ? hips : null },
    expressionManager: { setValue: (name, value) => { expressions[name] = value; } },
  };
  const angle = THREE.MathUtils.degToRad(179);
  const motion = validateDemoMotion({
    duration: 1, fps: 30,
    frames: [
      { t: 0, bones: { hips: [0, angle, 0] }, root: [0, 0, 0], happy: .2 },
      { t: 1, bones: { hips: [0, -angle, 0] }, root: [.2, .1, -.2], happy: .8, blink: 1 },
    ],
  });
  for (let i = 0; i < 20; i++) applyDemoMotion(vrm, motion, .5, restHips);
  const expected = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
  assert.ok(hips.quaternion.angleTo(expected) < 1e-6, '179° to -179° interpolates through 180°, not 0°');
  assert.ok(hips.position.distanceTo(new THREE.Vector3(.1, .95, -.1)) < 1e-10);
  assert.equal(expressions.aa, 0);
  assert.equal(expressions.happy, .5);
  assert.equal(expressions.blink, .5);
});

test('distributed VRM performs the choreography with lowered rest arms, raised celebration, and a bow', async () => {
  const bytes = await readFile(new URL('../public/demo/vli-performer.vrm', import.meta.url));
  const loader = new GLTFLoader();
  loader.register(parser => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
  const vrm = gltf.userData.vrm;
  const restHips = vrm.humanoid.getNormalizedBoneNode('hips').position.clone();
  const position = name => vrm.humanoid.getRawBoneNode(name).getWorldPosition(new THREE.Vector3());
  const apply = time => {
    applyDemoMotion(vrm, clip, time, restHips);
    vrm.update(1 / 60);
    vrm.scene.updateMatrixWorld(true);
  };
  apply(0);
  const restingHead = position('head');
  const restingHips = position('hips');
  assert.ok(position('leftHand').y < position('leftUpperArm').y - .3);
  assert.ok(position('rightHand').y < position('rightUpperArm').y - .3);
  apply(47);
  assert.ok(position('leftHand').y > position('leftUpperArm').y + .2);
  assert.ok(position('rightHand').y > position('rightUpperArm').y + .2);
  apply(69.4);
  assert.ok(position('head').z > restingHead.z + .12, 'performer bows toward the audience (+Z)');
  assert.ok(position('head').y < restingHead.y - .06, 'head lowers during the bow');
  apply(72);
  assert.ok(position('hips').distanceTo(restingHips) < 1e-8, 'hips return to their rest position');
  assert.ok(position('head').distanceTo(restingHead) < 1e-8, 'performer returns upright');
});
