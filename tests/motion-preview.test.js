import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { createMotionPreview } from '../src/motion-preview.js';
import { applyCaptureToVRM, applyMotionSampleToVRM, validateMotionClip } from '../src/motion-data.js';
import { parseVRMA, createVRMAPlayer } from '../src/vrma.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≈ ${expected}`);
function fixture() {
  const scene = new THREE.Scene();
  const stage = new THREE.Group();
  stage.position.set(4, .3, -7); stage.rotation.y = .7; stage.scale.setScalar(.5); scene.add(stage);
  const vrm = { scene: new THREE.Group() };
  vrm.scene.position.set(0, .02, -1.1); vrm.scene.scale.setScalar(1.2); stage.add(vrm.scene);
  const material = () => new THREE.MeshStandardMaterial({ stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc });
  const nested = new THREE.Group();
  nested.add(new THREE.Mesh(new THREE.BoxGeometry(.3, 1.8, .2), [material(), material()]));
  vrm.scene.add(nested, new THREE.Mesh(new THREE.SphereGeometry(.1), material()));
  const preview = createMotionPreview(scene, stage);
  const materials = [];
  vrm.scene.traverse(object => { if (object.isMesh) materials.push(...(Array.isArray(object.material) ? object.material : [object.material])); });
  return { scene, stage, vrm, preview, materials };
}

test('motion preview removes portal clipping and stage transforms while preserving model normalization', () => {
  const { stage, vrm, preview, materials } = fixture();
  const scale = vrm.scene.scale.clone();
  preview.show(vrm, true);
  assert.equal(vrm.scene.parent, preview.room);
  assert.equal(preview.room.visible, true);
  assert.equal(stage.children.includes(vrm.scene), false);
  assert.deepEqual(vrm.scene.position.toArray(), [0, .02, 0]);
  assert.ok(vrm.scene.scale.equals(scale));
  assert.ok(materials.every(material => material.stencilWrite === false));
  preview.room.updateWorldMatrix(true, true);
  assert.deepEqual(vrm.scene.getWorldPosition(new THREE.Vector3()).toArray(), [0, .02, 0]);
  assert.ok(vrm.scene.getWorldScale(new THREE.Vector3()).equals(scale), 'a previous stage width does not resize the motion performer');
});

test('switching back restores portal materials and local placement without accumulating offsets', () => {
  const { stage, vrm, preview, materials } = fixture();
  for (let i = 0; i < 3; i++) {
    preview.show(vrm, true);
    preview.show(vrm, false);
    assert.equal(vrm.scene.parent, stage);
    assert.equal(preview.room.visible, false);
    assert.deepEqual(vrm.scene.position.toArray(), [0, .02, -1.1]);
    assert.equal(stage.children.filter(child => child === vrm.scene).length, 1);
    assert.ok(materials.every(material => material.stencilWrite && material.stencilRef === 1 && material.stencilFunc === THREE.EqualStencilFunc));
  }
  assert.doesNotThrow(() => preview.show(null, false));
});

test('recording room uses the real floor when available and faces the viewer despite head pitch', () => {
  const { preview } = fixture();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(3, 1.72, -4); camera.rotation.set(-.35, .8, .1);
  const direction = camera.getWorldDirection(new THREE.Vector3()); direction.y = 0; direction.normalize();
  preview.place(camera, true);
  const expected = camera.position.clone().addScaledVector(direction, 2.2); expected.y = 0;
  assert.ok(preview.room.position.distanceTo(expected) < 1e-6);
  const front = new THREE.Vector3(0, 0, 1).applyQuaternion(preview.room.quaternion);
  assert.ok(front.dot(direction.clone().negate()) > .99999, 'the avatar faces the user');
  near(preview.room.rotation.x, 0);
  near(preview.room.rotation.z, 0);
  preview.place(camera, false);
  near(preview.room.position.y, camera.position.y - 1.65);
});

test('a vertical gaze has a stable placement fallback and reset removes all XR room placement', () => {
  const { preview } = fixture();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(2, 1.65, 5); camera.rotation.x = Math.PI / 2;
  preview.place(camera, false);
  near(preview.room.position.x, 2);
  near(preview.room.position.y, 0);
  near(preview.room.position.z, 2.8);
  assert.ok(preview.room.quaternion.toArray().every(Number.isFinite));
  preview.reset();
  assert.deepEqual(preview.room.position.toArray(), [0, 0, 0]);
  assert.ok(preview.room.quaternion.equals(new THREE.Quaternion()));
});

test('the shipped VRM remains visible in the desktop motion camera after XR reset and recorded pose application', async () => {
  const bytes = await readFile(new URL('../public/demo/vli-performer.vrm', import.meta.url));
  const loader = new GLTFLoader(); loader.register(parser => new VRMLoaderPlugin(parser));
  const vrm = (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '')).userData.vrm;
  const initial = new THREE.Box3().setFromObject(vrm.scene);
  const scale = 1.8 / (initial.max.y - initial.min.y);
  vrm.scene.scale.setScalar(scale); vrm.scene.position.set(0, -initial.min.y * scale, -1.1);
  const { stage, preview } = fixture(); stage.add(vrm.scene);
  const camera = new THREE.PerspectiveCamera(42, 1.4, .01, 100);
  camera.position.set(3, 1.7, -2); camera.rotation.y = .8;
  preview.place(camera, true); preview.show(vrm, true);
  preview.reset();
  const clip = validateMotionClip(JSON.parse(await readFile(new URL('./fixtures/capture-sample.json', import.meta.url), 'utf8')));
  applyCaptureToVRM(vrm, clip, .3); vrm.update(1 / 60);
  camera.position.set(0, 1.3, 3.8); camera.lookAt(0, .95, 0); camera.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(vrm.scene);
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
    const projected = new THREE.Vector3(x, y, z).project(camera);
    assert.ok(Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1 && projected.z > -1 && projected.z < 1, 'recorded avatar bounds fit inside the normal page camera');
  }
  assert.equal(vrm.scene.parent, preview.room);
  assert.equal(preview.room.visible, true);
  vrm.scene.traverse(object => { if (object.isMesh) assert.ok((Array.isArray(object.material) ? object.material : [object.material]).every(material => !material.stencilWrite)); });

  // A prior demo action must not retain control of the normalized rig when the
  // live path is applied. VRM.update copies that live pose to the render bones.
  const animationBytes = await readFile(new URL('../public/demo/neon-door.vrma', import.meta.url));
  const demo = await parseVRMA(animationBytes.buffer.slice(animationBytes.byteOffset, animationBytes.byteOffset + animationBytes.byteLength));
  const player = createVRMAPlayer(vrm, demo); player.seek(20);
  applyMotionSampleToVRM(vrm, clip.frames[10], clip);
  const liveHead = vrm.humanoid.getNormalizedBoneNode('head').quaternion.clone();
  vrm.update(1 / 60);
  assert.deepEqual(vrm.humanoid.getNormalizedBoneNode('head').quaternion.toArray(), liveHead.toArray(), 'VRM update preserves the live pose after demo playback');
  assert.ok(liveHead.angleTo(new THREE.Quaternion()) > .05);
  player.dispose();
});
