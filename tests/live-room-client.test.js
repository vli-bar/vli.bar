import test from 'node:test';
import assert from 'node:assert/strict';
import {LiveRoom} from '../src/live-room.js';
import {MAX_LIVE_BUFFER_BYTES} from '../src/live-protocol.js';

class Socket extends EventTarget {
  static created=[];
  constructor(url) { super();this.url=url;this.readyState=0;this.bufferedAmount=0;this.sent=[];Socket.created.push(this); }
  send(text) {this.sent.push(JSON.parse(text));}
  close() {this.readyState=3;this.dispatchEvent(new Event('close'));}
  open() {this.readyState=1;this.dispatchEvent(new Event('open'));}
  message(packet) {this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(packet)}));}
}
const self={id:'self',role:'audience',name:'me',device:'phone'};
const peer={id:'artist',role:'performer',name:'performer',device:'headset'};
const sample={t:500,visibility:'visible',head:{position:[0,1.6,0],quaternion:[0,0,0,1]},left:null,right:null,body:null};
const options={url:'https://room.example:8443',room:'demo',token:'private-room-token',...self};
async function connected() {
  let clock=1000;
  const packets=[],states=[],rosters=[];
  const room=new LiveRoom({WebSocketImpl:Socket,now:()=>clock,onPose:p=>packets.push(p),onState:s=>states.push(s),onRoster:r=>rosters.push(r)});
  const promise=room.connect(options);
  const socket=Socket.created.at(-1);
  socket.open(); socket.message({type:'welcome',v:1,id:'self',serverTime:100000,peers:[self,peer]});
  await promise;
  return {room,socket,packets,states,rosters,setTime:value=>{clock=value;}};
}

test('browser client drops stale, duplicate and unknown-peer motion and provides a local receive timestamp',async()=>{
  const {room,socket,packets,setTime}=await connected();
  const frame={type:'pose',v:1,...peer,seq:0,sentAt:100,sample,referenceSpace:'local',serverTime:100000};
  socket.message(frame);
  assert.equal(packets.length,1);
  assert.equal(packets[0].receivedAt,1000);
  socket.message(frame);
  socket.message({...frame,id:'intruder',seq:1,sentAt:150});
  setTime(3000);
  socket.message({...frame,seq:1,sentAt:150});
  assert.equal(packets.length,1);
  socket.message({...frame,seq:2,sentAt:200,serverTime:102000});
  assert.equal(packets.length,2);
  socket.message({type:'roster',v:1,peers:[self]});
  socket.message({...frame,seq:3,sentAt:250,serverTime:102000});
  assert.equal(packets.length,2);
  room.disconnect();
});

test('browser client bounds its send rate and queue without accumulating old motion',async()=>{
  const {room,socket,setTime}=await connected();
  assert.equal(room.sendPose({sample,referenceSpace:'stage'}),true);
  assert.equal(room.sendPose({sample}),false);
  setTime(1050); socket.bufferedAmount=MAX_LIVE_BUFFER_BYTES+1;
  assert.equal(room.sendPose({sample}),false);
  setTime(1100); socket.bufferedAmount=0;
  assert.equal(room.sendPose({sample:{...sample,t:501}}),true);
  const frames=socket.sent.filter(packet=>packet.type==='pose');
  assert.deepEqual(frames.map(frame=>frame.seq),[0,1]);
  assert.equal(frames[1].sample.t,501);
  assert.ok(!JSON.stringify(frames).includes(options.token));
  room.disconnect();
  assert.equal(room.sendPose({sample}),false);
});

test('disconnect during joining cancels the pending join and a late socket cannot join or revive state',async()=>{
  const room=new LiveRoom({WebSocketImpl:Socket});
  const first=room.connect(options);
  const rejected=assert.rejects(first,/取り消し/);
  const oldSocket=Socket.created.at(-1);
  room.disconnect();
  oldSocket.open();oldSocket.message({type:'welcome',v:1,id:'self',serverTime:100000,peers:[self]});
  await rejected;
  assert.equal(oldSocket.sent.length,0);
  assert.equal(room.state,'disconnected');
  assert.equal(room.selfId,null);
  assert.deepEqual(room.peers,[]);
});

test('network closure clears avatars and never automatically reconnects',async()=>{
  const {room,socket,states,rosters}=await connected();
  const count=Socket.created.length;
  socket.close();
  assert.equal(room.connected,false);
  assert.equal(room.selfId,null);
  assert.deepEqual(room.peers,[]);
  assert.equal(states.at(-1).state,'disconnected');
  assert.equal(rosters.at(-1).peers.length,0);
  assert.equal(Socket.created.length,count);
});

test('performer phone can send body data and hidden frames erase all visible poses',async()=>{
  let clock=100;
  const room=new LiveRoom({WebSocketImpl:Socket,now:()=>clock});
  const performer={...self,role:'performer'};
  const pending=room.connect({...options,role:'performer'});
  const socket=Socket.created.at(-1);socket.open();socket.message({type:'welcome',v:1,id:'self',serverTime:10000,peers:[performer]});
  await pending;
  const frame={...sample,body:{hips:sample.head},left:sample.head};
  assert.equal(room.sendPose({sample:frame,referenceSpace:'camera'}),true);
  assert.ok(socket.sent.at(-1).sample.body.hips);
  assert.ok(socket.sent.at(-1).sample.left);
  clock+=50;
  assert.equal(room.sendPose({sample:{...frame,visibility:'hidden'},referenceSpace:'camera'}),true);
  assert.equal(socket.sent.at(-1).sample.body,null);
  assert.equal(socket.sent.at(-1).sample.head,null);
  assert.equal(socket.sent.at(-1).sample.left,null);
  room.disconnect();
});
