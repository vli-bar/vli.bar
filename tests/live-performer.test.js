import test from 'node:test';
import assert from 'node:assert/strict';
import { LivePerformer, liveTrackingFrame } from '../src/live-performer.js';
const pose = x => ({position:[x,0,0],quaternion:[0,0,0,1],emulatedPosition:false});
const packet = (seq,receivedAt,x,extra={}) => ({id:'p1',role:'performer',seq,receivedAt,referenceSpace:'local',sample:{t:0,visibility:'visible',head:pose(x),left:pose(x),right:null,body:null},...extra});
test('performer interpolates on receiver clock and hides a stalled sender',()=>{
  const buffer=new LivePerformer();
  buffer.receive(packet(1,100,0));buffer.receive(packet(2,200,2));
  assert.equal(buffer.sample(230).sample.head.position[0],1);
  assert.equal(buffer.sample(1201),null);
});
test('performer tracking loss and peer leave remove stale poses immediately',()=>{
  const buffer=new LivePerformer();buffer.receive(packet(1,100,0));
  buffer.receive(packet(2,200,1,{sample:{t:0,visibility:'hidden',head:null,left:null,right:null,body:null}}));
  assert.equal(buffer.sample(201),null);
  buffer.receive(packet(3,300,2));assert.ok(buffer.sample(310));
  buffer.setPeers([]);assert.equal(buffer.sample(311),null);
});
test('performer ignores out of order frames and does not blend distinct performers',()=>{
  const buffer=new LivePerformer();buffer.receive(packet(2,200,2));buffer.receive(packet(1,210,0));
  assert.equal(buffer.sample(300).sample.head.position[0],2);
  buffer.receive(packet(1,310,9,{id:'p2'}));assert.equal(buffer.sample(320).sample.head.position[0],9);
});
test('lost hand disappears before the interpolation delay',()=>{
  const buffer=new LivePerformer();buffer.receive(packet(1,100,0));
  const p=packet(2,200,2);p.sample.left=null;buffer.receive(p);
  assert.equal(buffer.sample(210).sample.left,null);
});
test('performer reacquisition does not interpolate across a tracking gap',()=>{
  const buffer=new LivePerformer();buffer.receive(packet(1,100,0));buffer.receive(packet(2,2000,5));
  assert.equal(buffer.sample(2001).sample.head.position[0],5);
});
test('camera stalls expire at observation time even when the render loop continues',()=>{
  const tracking=packet(1,0,0,{referenceSpace:'camera'});
  tracking.sample.head.emulatedPosition=true;tracking.sample.head.source='camera-pose';
  assert.ok(liveTrackingFrame(tracking,{now:500,observedAt:100}));
  assert.equal(liveTrackingFrame(tracking,{now:1100,observedAt:100}),null);
});
test('XR emulated head is tracking loss while explicitly estimated camera input is allowed',()=>{
  const tracking=packet(1,100,0);tracking.sample.head.emulatedPosition=true;
  const buffer=new LivePerformer();buffer.receive(tracking);
  assert.equal(buffer.sample(101),null);
  assert.equal(liveTrackingFrame(tracking,{now:101,observedAt:100}),null);
  tracking.referenceSpace='camera';tracking.sample.head.source='camera-pose';tracking.seq=2;buffer.receive(tracking);
  assert.ok(buffer.sample(101));
});
