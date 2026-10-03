import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,writeFile,symlink,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {createLanServer} from '../server/lan-server.js';
import {LiveRoom} from '../src/live-room.js';
import {sanitizeLivePose,sanitizeJoin,liveSocketUrl,MAX_LIVE_PACKET_BYTES} from '../src/live-protocol.js';

const token='demo-room-secret-1234';
const pose = (x=0) => ({position:[x,1.6,0],quaternion:[0,0,0,1],emulatedPosition:false});
const sample = () => ({t:0,visibility:'visible',head:pose(),left:pose(-.3),right:pose(.3),body:{hips:pose()}});
async function until(check) {
  for(let i=0;i<200;i++) { if(check())return; await delay(10); }
  assert.fail('condition did not complete');
}
async function fixture(t,options={}) {
  const relay=createLanServer({localhost:true,port:0,...options});
  const address=await relay.listen();
  const url=`http://127.0.0.1:${address.port}`;
  const clients=[];
  t.after(async()=>{for(const client of clients)client.disconnect();await relay.close();});
  class Socket extends WebSocket {constructor(endpoint){super(endpoint,{origin:url});}}
  const join=async({room='stage',role='audience',device='headset',...rest}={})=>{
    const packets=[];
    const client=new LiveRoom({WebSocketImpl:Socket,onPose:packet=>packets.push(packet)});
    clients.push(client);
    await client.connect({url,room,token,role,device,name:device,...rest});
    return {client,packets};
  };
  return {relay,url,join};
}

test('real relay broadcasts between three clients, isolates another room, and strips phone audience hands',async t=>{
  const {relay,join}=await fixture(t);
  const performer=await join({role:'performer',device:'phone'});
  const phone=await join({device:'phone'});
  const headset=await join({device:'headset'});
  const isolated=await join({room:'other'});
  await until(()=>performer.client.peers.length===2 && headset.client.peers.length===2);
  assert.equal(performer.client.sendPose({sample:sample(),referenceSpace:'camera',initialHeadHeight:1.7}),true);
  await until(()=>phone.packets.length===1 && headset.packets.length===1);
  assert.equal(phone.packets[0].id,performer.client.selfId);
  assert.equal(phone.packets[0].role,'performer');
  assert.equal(phone.packets[0].sample.body.hips.position[1],1.6);
  assert.equal(phone.packets[0].referenceSpace,'camera');
  assert.equal(isolated.packets.length,0);
  assert.equal(phone.client.sendPose({sample:sample(),referenceSpace:'stage'}),true);
  await until(()=>headset.packets.length===2 && performer.packets.length===1);
  assert.equal(headset.packets[1].sample.left,null);
  assert.equal(headset.packets[1].sample.right,null);
  assert.equal(headset.packets[1].sample.body,null);
  assert.equal(headset.packets[1].referenceSpace,'stage');
  assert.equal(headset.client.sendPose({sample:sample(),referenceSpace:'stage'}),true);
  await until(()=>phone.packets.length===2);
  assert.ok(phone.packets[1].sample.left);
  assert.equal(phone.packets[1].sample.body,null);
  performer.client.disconnect();
  await until(()=>phone.client.peers.length===1);
  assert.ok(!phone.client.peers.some(peer=>peer.role==='performer'));
  const next=await join({role:'performer'});
  assert.equal(next.client.connected,true);
  for(const item of [phone,headset,next,isolated])item.client.disconnect();
  await until(()=>relay.rooms.size===0);
});

test('room secrets and the single performer limit are enforced without disturbing existing peers',async t=>{
  const {join}=await fixture(t);
  const performer=await join({role:'performer'});
  await assert.rejects(join({token:'incorrect-secret-token'}),/合言葉/);
  await assert.rejects(join({role:'performer'}),/出演者は1人/);
  assert.equal(performer.client.connected,true);
  assert.equal(performer.client.peers.length,0);
});

test('server assigns identity, drops stale sequence timestamps and rejects malformed poses',async t=>{
  const {join}=await fixture(t);
  const sender=await join({role:'performer'});
  const audience=await join();
  await until(()=>sender.client.peers.length===1);
  const frame={type:'pose',v:1,seq:5,sentAt:100,sample:sample(),referenceSpace:'local',id:'forged',role:'audience',name:'forged'};
  sender.client._socket.send(JSON.stringify(frame));
  await until(()=>audience.packets.length===1);
  assert.equal(audience.packets[0].id,sender.client.selfId);
  assert.equal(audience.packets[0].role,'performer');
  assert.notEqual(audience.packets[0].name,'forged');
  await delay(40);
  sender.client._socket.send(JSON.stringify({...frame,seq:4,sentAt:150}));
  sender.client._socket.send(JSON.stringify({...frame,seq:6,sentAt:90}));
  await delay(50);
  assert.equal(audience.packets.length,1);
  sender.client._socket.send(JSON.stringify({...frame,seq:7,sentAt:200,sample:{...sample(),head:{...pose(),position:[Infinity,0,0]}}}));
  await until(()=>sender.client.state==='error');
  assert.equal(audience.packets.length,1);
});

test('relay rejects oversized packets and unauthorized origins',async t=>{
  const {join,url}=await fixture(t);
  const sender=await join();
  sender.client._socket.send('x'.repeat(MAX_LIVE_PACKET_BYTES+1));
  await until(()=>!sender.client.connected);
  const status=await new Promise(resolve=>{
    const socket=new WebSocket(url.replace('http:','ws:')+'/live',{origin:'https://untrusted.example'});
    socket.on('unexpected-response',(_request,response)=>{resolve(response.statusCode);response.resume();socket.terminate();});
    socket.on('error',()=>{});
  });
  assert.equal(status,403);
});

test('server drops packets for backpressured peers and resumes with current motion',async t=>{
  const {relay,join}=await fixture(t,{maxBufferedBytes:1024});
  const sender=await join({role:'performer'});
  const audience=await join();
  await until(()=>sender.client.peers.length===1);
  const receivingSocket=[...relay.wss.clients].find(socket=>socket.peer.id===audience.client.selfId);
  Object.defineProperty(receivingSocket,'bufferedAmount',{configurable:true,get:()=>2048});
  assert.equal(sender.client.sendPose({sample:sample()}),true);
  await delay(50);
  assert.equal(audience.packets.length,0);
  delete receivingSocket.bufferedAmount;
  assert.equal(sender.client.sendPose({sample:{...sample(),t:.05}}),true);
  await until(()=>audience.packets.length===1);
  assert.equal(audience.packets[0].sample.t,.05);
});

test('room is bounded to sixteen people and a fresh empty room can use a new secret',async t=>{
  const {relay,join}=await fixture(t);
  const joined=[];
  for(let i=0;i<16;i++)joined.push(await join({name:`viewer${i}`}));
  await assert.rejects(join(),/満員/);
  for(const item of joined)item.client.disconnect();
  await until(()=>relay.rooms.size===0);
  const fresh=await join({token:'different-new-secret'});
  assert.equal(fresh.client.connected,true);
});

test('static server serves only built files and never follows a symlink outside dist',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'vli-live-static-'));
  const outside=path.join(root,'secret.txt');
  const dist=path.join(root,'dist');
  await (await import('node:fs/promises')).mkdir(dist);
  await writeFile(outside,'not public');
  await writeFile(path.join(dist,'index.html'),'<h1>LAN demo</h1>');
  await symlink(outside,path.join(dist,'secret.txt'));
  const {url}=await fixture(t,{distDir:dist});
  t.after(()=>rm(root,{recursive:true,force:true}));
  assert.match(await (await fetch(url)).text(),/LAN demo/);
  assert.equal((await fetch(url+'/secret.txt')).status,404);
  assert.equal((await fetch(url+'/index.html',{method:'POST'})).status,405);
});

test('LAN refuses cleartext fallback and the protocol rejects unsafe URLs and unbounded data',()=>{
  assert.throws(()=>createLanServer(),/TLS_CERT/);
  assert.throws(()=>createLanServer({localhost:true,host:'0.0.0.0'}),/loopback/);
  assert.throws(()=>liveSocketUrl('http://192.168.1.5:8080'),/HTTPS/);
  assert.throws(()=>liveSocketUrl('https://example.test/?token=secret'),/パラメーター/);
  assert.equal(liveSocketUrl('https://example.test:8443'),'wss://example.test:8443/live');
  assert.throws(()=>sanitizeJoin({room:123,token,role:'performer',device:'phone'}),/部屋名/);
  assert.throws(()=>sanitizeJoin({room:'stage',token:'short',role:'performer',device:'phone'}),/合言葉/);
  assert.throws(()=>sanitizeLivePose({sample:{...sample(),head:{...pose(),position:[51,0,0]}}},{role:'performer',device:'headset'}),/姿勢/);
  assert.throws(()=>sanitizeLivePose({sample:{...sample(),head:{...pose(),quaternion:[0,0,0,0]}}},{role:'performer',device:'headset'}),/回転/);
});
