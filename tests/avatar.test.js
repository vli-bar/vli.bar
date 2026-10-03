import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMRequiredHumanBoneName } from '@pixiv/three-vrm';

test('distributed original avatar loads as VRM 1.0 and responds to humanoid motion and expressions', async () => {
  const bytes = await readFile(new URL('../public/demo/vli-performer.vrm', import.meta.url));
  const array = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const loader = new GLTFLoader();
  loader.register(parser => new VRMLoaderPlugin(parser));
  const gltf = await loader.parseAsync(array, '');
  const vrm = gltf.userData.vrm;
  assert.ok(vrm, 'VRMLoaderPlugin recognizes the model');
  assert.equal(vrm.meta.metaVersion, '1');
  assert.match(vrm.meta.name, /LUMI/);
  assert.equal(vrm.meta.allowRedistribution, true);
  for (const name of Object.values(VRMRequiredHumanBoneName)) {
    assert.ok(vrm.humanoid.getNormalizedBoneNode(name), `required normalized bone ${name}`);
  }
  const bounds = new THREE.Box3().setFromObject(vrm.scene);
  assert.ok(bounds.max.y - bounds.min.y > 1.6 && bounds.max.y - bounds.min.y < 1.9, 'human-sized default model');
  const hand = vrm.humanoid.getRawBoneNode('leftHand');
  const before = hand.getWorldPosition(new THREE.Vector3());
  vrm.humanoid.getNormalizedBoneNode('leftUpperArm').rotation.z = -1;
  vrm.update(1 / 60);
  vrm.scene.updateMatrixWorld(true);
  const after = hand.getWorldPosition(new THREE.Vector3());
  assert.ok(after.y < before.y - 0.2, 'left arm drops from T-pose under normalized motion');
  for (const expression of ['aa', 'oh', 'blink', 'happy']) assert.ok(vrm.expressionManager.getExpression(expression));
  vrm.expressionManager.setValue('aa', 0.8);
  vrm.update(1 / 60);
  const mouth = vrm.scene.getObjectByName('Singing_mouth');
  assert.ok(mouth, 'singing mouth mesh loads');
  assert.ok(mouth.morphTargetInfluences[0] > 0.7, 'voice expression reaches geometry');
});
