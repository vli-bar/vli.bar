import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {fitCameraFrame, placeMarkerStage, markerAudiencePose} from '../src/marker-stage.js';
import {sanitizeLivePose} from '../src/live-protocol.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
test('camera overlay fits portrait and landscape with the same uncropped video aspect', () => {
  for (const [w,h,aw,ah] of [[640,480,390,650],[360,640,820,290],[640,360,390,500]]) {
    const fit = fitCameraFrame(w,h,aw,ah);
    close(fit.width / fit.height,w/h);
    assert.ok(fit.width <= aw + 1e-6 && fit.height <= ah + 1e-6);
    assert.ok(Math.abs(fit.width-aw) < 1e-6 || Math.abs(fit.height-ah) < 1e-6);
  }
  assert.equal(fitCameraFrame(640,480,0,20),null);
  assert.equal(fitCameraFrame(NaN,480,100,200),null);
});

test('portal center follows marker center through rotation and stage width changes', () => {
  const stage = new THREE.Group();
  const marker = new THREE.Matrix4().compose(new THREE.Vector3(.3,-.2,-3),new THREE.Quaternion().setFromEuler(new THREE.Euler(.1,.4,-.1)),new THREE.Vector3(1,1,1));
  for (const width of [1,2.4,4]) {
    assert.equal(placeMarkerStage(stage,marker,width),true);
    const center = stage.localToWorld(new THREE.Vector3(0,1.25,0));
    const expected = new THREE.Vector3().setFromMatrixPosition(marker);
    close(center.distanceTo(expected),0);
    close(stage.scale.x,width/2.4);
    close(stage.quaternion.angleTo(new THREE.Quaternion().setFromRotationMatrix(marker)),0);
  }
  assert.equal(placeMarkerStage(stage,new THREE.Matrix4().makeScale(-1,1,1)),false);
  assert.equal(placeMarkerStage(stage,marker,NaN),false);
});

test('marker audience positions share stage coordinates, preserve orientation, and contain no hands', () => {
  const camera = new THREE.PerspectiveCamera();
  const stage = new THREE.Group();
  const marker = new THREE.Matrix4().makeTranslation(0,0,-3);
  placeMarkerStage(stage,marker,2.4);
  let sample = markerAudiencePose(camera,stage,true);
  assert.deepEqual(sample.head.position,[0,1.25,3]);
  assert.deepEqual(sample.head.quaternion,[0,0,0,1]);
  assert.equal(sample.left,null);assert.equal(sample.right,null);
  assert.doesNotThrow(()=>sanitizeLivePose({sample},{role:'audience',device:'phone'}));
  marker.makeRotationY(.4);marker.setPosition(.8,.2,-2);
  placeMarkerStage(stage,marker,3.6);
  sample = markerAudiencePose(camera,stage,true);
  close(stage.localToWorld(new THREE.Vector3().fromArray(sample.head.position)).length(),0);
  const reconstructed = stage.getWorldQuaternion(new THREE.Quaternion()).multiply(new THREE.Quaternion().fromArray(sample.head.quaternion));
  close(reconstructed.angleTo(camera.quaternion),0);
  assert.doesNotThrow(()=>sanitizeLivePose({sample},{role:'audience',device:'phone'}));
});

test('tracking loss and invalid spatial transforms never share a stale audience face', () => {
  const camera = new THREE.PerspectiveCamera(), stage = new THREE.Group();
  placeMarkerStage(stage,new THREE.Matrix4().makeTranslation(0,0,-3));
  assert.equal(markerAudiencePose(camera,stage,false).head,null);
  stage.scale.set(0,0,0);
  assert.equal(markerAudiencePose(camera,stage,true).visibility,'hidden');
});
