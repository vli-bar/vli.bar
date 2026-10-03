import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import WebSocket from 'ws';
import {LiveRoom} from '../src/live-room.js';
import {createLanServer} from '../server/lan-server.js';
import {MAX_LIVE_PACKET_BYTES,MAX_LIVE_BUFFER_BYTES} from '../src/live-protocol.js';

// Every run owns a temporary TCP port and test-only rooms. Seeds and operation
// counts stay fixed so a failing interleaving can be reproduced in CI.
const seeds=[0x564c4901,0x20261004];
const tokens=['monkey-room-a-secret','monkey-room-b-secret','monkey-room-c-secret'];
const rooms=['monkey-a','monkey-b','monkey-c'];
const pose=x=>({position:[x,1.6,0],quaternion:[0,0,0,1],emulatedPosition:false});
const sample=(t,hidden=false)=>({t,visibility:hidden?'hidden':'visible',head:pose(0),left:pose(-.3),right:pose(.3),body:{hips:pose(0)}});
function random(seed) {let value=seed>>>0;return maximum=>{value^=value<<13;value^=value>>>17;value^=value<<5;return(value>>>0)%maximum;};}
async function until(check,label) {for(let i=0;i<200;i++){if(check())return;await delay(5);}assert.fail(label);}

for(const seed of seeds)test(`seeded LAN monkey 0x${seed.toString(16)}: 180 mixed operations retain room and client invariants`,{timeout:15000},async t=>{
  const pick=random(seed);
  let clock=10000;
  const relay=createLanServer({localhost:true,port:0,now:()=>clock,joinTimeoutMs:300,maxBufferedBytes:2048});
  const address=await relay.listen();
  const url=`http://127.0.0.1:${address.port}`;
  const actors=[],registry=new Map(),received=[],trace=[],counts={};
  class Socket extends WebSocket {constructor(endpoint){super(endpoint,{origin:url});}}
  function actor(name) {
    const item={name,room:null,role:'audience',device:'headset',notices:[]};
    item.client=new LiveRoom({WebSocketImpl:Socket,now:()=>clock,connectTimeoutMs:2000,
      onNotice:message=>item.notices.push(message),onPose:packet=>received.push({receiver:item,room:item.room,packet})});
    actors.push(item);return item;
  }
  async function join(item,room=pick(3),role=pick(4)===0?'performer':'audience',token=tokens[room]) {
    item.room=room;item.role=role;item.device=['phone','headset','desktop'][pick(3)];
    try {
      await item.client.connect({url,room:rooms[room],token,role,name:item.name,device:item.device});
      registry.set(item.client.selfId,{room,role,device:item.device,name:item.name});return true;
    } catch(error) {
      assert.match(error.message,/合言葉|出演者は1人|満員|取り消し|接続|参加前/);
      return false;
    }
  }
  async function settle() {
    await until(()=>{
      const expected=new Set(actors.filter(item=>item.client.connected).map(item=>item.client.selfId));
      const actual=[...relay.rooms.values()].flatMap(room=>[...room.clients].map(socket=>socket.peer.id));
      if(actual.length!==expected.size || actual.some(id=>!expected.has(id)))return false;
      for(const item of actors)if(item.client.connected) {
        const room=relay.rooms.get(rooms[item.room]);if(!room)return false;
        const ids=[...room.clients].map(socket=>socket.peer.id).filter(id=>id!==item.client.selfId).sort();
        if(JSON.stringify(ids)!==JSON.stringify(item.client.peers.map(peer=>peer.id).sort()))return false;
      }
      return true;
    },`roster did not converge: ${trace.slice(-8).join(' / ')}`);
    for(const room of relay.rooms.values()) {
      assert.ok(room.clients.size>0 && room.clients.size<=16);
      assert.ok([...room.clients].filter(socket=>socket.peer.role==='performer').length<=1);
    }
    for(const event of received.splice(0)) {
      const sender=registry.get(event.packet.id);
      assert.ok(sender,'server identity must belong to an authenticated connection');
      assert.equal(event.room,sender.room,'a pose must never leave its room');
      assert.equal(event.packet.role,sender.role,'client identity spoofing must be stripped');
      assert.equal(event.packet.device,sender.device);
      assert.equal(event.packet.name,sender.name);
      assert.ok(Number.isFinite(event.packet.receivedAt));
      if(sender.role==='audience') {
        assert.equal(event.packet.referenceSpace,'stage');assert.equal(event.packet.sample.body,null);
        if(sender.device==='phone') {assert.equal(event.packet.sample.left,null);assert.equal(event.packet.sample.right,null);}
      }
      if(event.packet.sample.visibility!=='visible')for(const track of ['head','left','right','body'])assert.equal(event.packet.sample[track],null);
    }
    for(const item of actors)for(const notice of item.notices)assert.ok(!tokens.some(token=>notice.includes(token)),'room tokens must not leak into notices');
  }
  t.after(async()=>{for(const item of actors)item.client.disconnect();await relay.close();});
  const observers=[];
  for(let room=0;room<3;room++)for(let i=0;i<2;i++) {
    const item=actor(`observer-${room}-${i}`);await join(item,room,'audience');observers.push(item);
  }
  const dynamic=Array.from({length:10},(_,i)=>actor(`monkey-${i}`));
  const ensure=async item=>{if(!item.client.connected)await join(item,pick(3),'audience');assert.equal(item.client.connected,true);};
  async function flushSender(item) {
    const socket=item.client._socket;
    if(socket?.readyState!==1)return;
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(new Error('test ping timed out'));},1000);
      const cleanup=()=>{clearTimeout(timer);socket.off('pong',done);socket.off('close',done);};
      const done=()=>{cleanup();resolve();};
      socket.once('pong',done);socket.once('close',done);socket.ping();
    });
    await delay(5);
  }
  try {
    await settle();
    for(let step=0;step<180;step++) {
      clock+=100;
      const item=dynamic[pick(dynamic.length)],operation=pick(13);
      counts[operation]=(counts[operation]??0)+1;trace.push(`${step}:${operation}:${item.name}`);
      if(operation===0)await join(item);
      else if(operation===1) {item.client.disconnect();item.client.disconnect();}
      else if(operation===2) {
        const pending=join(item,pick(3),'audience');item.client.disconnect();assert.equal(await pending,false);
      } else if(operation===3) {
        const first=join(item,pick(3),'audience');const second=join(item,pick(3),'audience');
        assert.equal(await first,false);assert.equal(await second,true);
      } else if(operation===4) {
        await ensure(item);
        assert.equal(item.client.sendPose({sample:sample(clock/1000,pick(4)===0),referenceSpace:item.role==='performer'?'camera':'stage'}),true);
        await flushSender(item);
      } else if(operation===5) {
        await ensure(item);
        const invalid={...sample(0),head:{position:[NaN,0,0],quaternion:[0,0,0,1]}};
        assert.equal(item.client.sendPose({sample:invalid}),false);
        assert.equal(item.client.connected,true);
      } else if(operation===6) {
        await ensure(item);
        const invalid=['{','null','[]','true',JSON.stringify({type:'pose',v:2}),JSON.stringify({type:'pose',v:1,seq:-1,sentAt:clock,sample:sample(0)}),'x'.repeat(MAX_LIVE_PACKET_BYTES+1)];
        item.client._socket.send(invalid[pick(invalid.length)]);
        await until(()=>!item.client.connected,'malformed sender must be removed');
      } else if(operation===7) {
        await ensure(item);
        item.client._socket.send(JSON.stringify({type:'join',v:1,room:rooms[(item.room+1)%3],token:tokens[(item.room+1)%3],role:'performer',device:'headset',name:'duplicate'}));
        await until(()=>!item.client.connected,'duplicate join must not move an authenticated connection');
      } else if(operation===8) {
        await ensure(item);
        const run=item.client._run;
        const frame={type:'pose',v:1,seq:run.seq++,sentAt:clock,sample:sample(clock/1000),referenceSpace:item.role==='performer'?'local':'stage',id:'spoofed',role:'performer',name:'spoofed',device:'phone'};
        item.client._socket.send(JSON.stringify(frame));await flushSender(item);
        const before=received.length;
        clock+=50;
        item.client._socket.send(JSON.stringify({...frame,seq:Math.max(0,frame.seq-1),sentAt:clock}));
        await flushSender(item);assert.equal(received.length,before,'older sequences must not relay');
      } else if(operation===9) {
        await ensure(item);
        const serverPeer=[...relay.wss.clients].find(socket=>socket.peer?.id===item.client.selfId);
        serverPeer.terminate();await until(()=>!item.client.connected,'abrupt drop must clear client state');
      } else if(operation===10) {
        await ensure(item);
        const observer=observers.find(other=>other.room===item.room);
        const serverPeer=[...relay.wss.clients].find(socket=>socket.peer?.id===observer.client.selfId);
        Object.defineProperty(serverPeer,'bufferedAmount',{configurable:true,get:()=>4096});
        const ownSocket=item.client._socket;
        Object.defineProperty(ownSocket,'bufferedAmount',{configurable:true,get:()=>MAX_LIVE_BUFFER_BYTES+1});
        assert.equal(item.client.sendPose({sample:sample(0)}),false);
        delete ownSocket.bufferedAmount;
        try {
          assert.equal(item.client.sendPose({sample:sample(clock/1000),referenceSpace:item.role==='performer'?'camera':'stage'}),true);
          await flushSender(item);
          assert.ok(!received.some(event=>event.receiver===observer),'backpressured receiver gets no queued old pose');
        } finally {delete serverPeer.bufferedAmount;}
      } else if(operation===11) {
        await join(item,pick(3),'audience','wrong-room-secret-value');
        assert.equal(item.client.connected,false);
      } else {
        // Compete for the same performer slot using simultaneous handshakes.
        const room=pick(3),existing=[...relay.rooms.get(rooms[room]).clients].some(socket=>socket.peer.role==='performer');
        const contenders=[actor(`race-${step}-a`),actor(`race-${step}-b`),actor(`race-${step}-c`)];
        const accepted=await Promise.all(contenders.map(contender=>join(contender,room,'performer')));
        assert.equal(accepted.filter(Boolean).length,existing?0:1);
        for(const contender of contenders)contender.client.disconnect();
      }
      await settle();
      assert.ok(observers.every(observer=>observer.client.connected),'malformed actors must not disconnect other rooms or healthy observers');
    }
    for(const item of actors)item.client.disconnect();
    await until(()=>relay.rooms.size===0,'all temporary rooms must disappear after the final exit');
    assert.equal(Object.keys(counts).length,13,'the seed should exercise every operation class');
    t.diagnostic(`seed=0x${seed.toString(16)}, operations=180, coverage=${JSON.stringify(counts)}`);
  } catch(error) {
    error.message+=`\nseed=0x${seed.toString(16)}; recent operations=${trace.slice(-12).join(', ')}`;
    throw error;
  }
});

test('unjoined sockets time out and rate-limit bursts cannot occupy a performer slot permanently',async t=>{
  const relay=createLanServer({localhost:true,port:0,joinTimeoutMs:80});
  const address=await relay.listen(),url=`http://127.0.0.1:${address.port}`;
  t.after(()=>relay.close());
  const open=()=>new Promise(resolve=>{const socket=new WebSocket(url.replace('http:','ws:')+'/live',{origin:url});socket.on('error',()=>{});socket.once('open',()=>resolve(socket));});
  const idle=await open();
  await until(()=>idle.readyState===3,'unauthenticated idle socket must close');
  assert.equal(relay.rooms.size,0);
  const flood=await open();
  flood.send(JSON.stringify({type:'join',v:1,room:'monkey-rate',token:'rate-test-secret',role:'performer',name:'flood',device:'headset'}));
  for(let seq=0;seq<100;seq++)flood.send(JSON.stringify({type:'pose',v:1,seq,sentAt:seq,sample:sample(0),referenceSpace:'local'}));
  await until(()=>flood.readyState===3,'rate-limited sender must close');
  await until(()=>relay.rooms.size===0,'rate-limited sender must release its room');
});
