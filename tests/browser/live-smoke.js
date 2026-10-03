// Development-only harness. All sockets and relay traffic are real; only the
// input poses are synthetic. No app globals or WebSocket APIs are replaced.
import { LiveRoom } from '../../src/live-room.js';

const el = id => document.getElementById(id);
const names = ['performer', 'phone', 'headset'];
const labels = new Map([...el('assertions').children].map(item => [item.id, item.textContent.replace(/^WAIT: /, '')]));
const clients = new Map();
let generation = 0;
let busy = false;
let posesPassed = false;
let log = [];
let sceneInterval = null;

function status(state, message) {
  el('status').dataset.state = state;
  el('status').textContent = message;
}
function note(message) {
  log.push(message);
  log = log.slice(-30);
  el('result').textContent = log.join('\n');
}
function assertion(id, passed, detail = '') {
  const item = el(`assert-${id}`);
  item.dataset.state = passed ? 'passed' : 'failed';
  item.textContent = `${passed ? 'PASS' : 'FAIL'}: ${labels.get(item.id)}${detail ? ` (${detail})` : ''}`;
  el('assertion-count').textContent = `${el('assertions').querySelectorAll('[data-state="passed"]').length} / ${labels.size}`;
  if (!passed) throw new Error(item.textContent);
}
function resetAssertions() {
  for (const [id, label] of labels) {
    el(id).dataset.state = 'pending'; el(id).textContent = `WAIT: ${label}`;
  }
  el('assertion-count').textContent = `0 / ${labels.size}`;
}
function render() {
  const rows = [];
  for (const [name, client] of clients) {
    const row = document.createElement('tr');
    for (const text of [name, `${client.state} / ${client.peers.length}`, `${client.packets.length}`]) {
      const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
    }
    rows.push(row);
  }
  el('clients').replaceChildren(...rows);
}
function buttons() {
  const connected = clients.size === 3;
  el('connect').disabled = busy || connected;
  el('relay-url').disabled = busy || connected;
  el('run').disabled = busy || !connected || clients.get('headset')?.left === true;
  el('leave').disabled = busy || !posesPassed || clients.get('headset')?.left === true;
  el('disconnect').disabled = !clients.size && !busy;
  el('scene-start').disabled = busy || !connected || sceneInterval !== null || clients.get('headset')?.left === true;
  el('scene-stop').disabled = sceneInterval === null;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, token, label, timeout = 8000) {
  const end = performance.now() + timeout;
  while (!predicate()) {
    if (token !== generation) throw new Error('接続テストを取り消しました。');
    if (performance.now() >= end) throw new Error(`時間切れ: ${label}`);
    await delay(40);
  }
  if (token !== generation) throw new Error('接続テストを取り消しました。');
}
function disconnect() {
  generation++;
  stopScene();
  for (const client of clients.values()) client.room.disconnect();
  clients.clear(); busy = false; posesPassed = false;
  el('current-room').value = ''; el('current-token').value = '';
  render(); buttons();
}
function failure(error, token) {
  if (token !== generation) return;
  status('failed', error.message); note(error.stack || error.message);
}
function createClient(name) {
  const client = { state: 'idle', id: null, peers: [], packets: [], room: null, left: false };
  clients.set(name, client);
  client.room = new LiveRoom({
    onState(event) {
      client.state = event.state;
      if (event.selfId) client.id = event.selfId;
      note(`${name}: ${event.state}${event.message ? ` — ${event.message}` : ''}`); render();
    },
    onRoster(event) {
      if (event.selfId) client.id = event.selfId;
      client.peers = event.peers; render();
    },
    onPose(packet) {
      client.packets.push(packet);
      if (client.packets.length > 300) client.packets.shift();
      render();
    },
    onNotice(message) { note(`${name}: ${message}`); },
  });
  return client;
}
function received(receiver, sender) {
  const id = clients.get(sender)?.id;
  return clients.get(receiver)?.packets.filter(packet => packet.id === id) ?? [];
}
const pose = (x, y, z, source = 'viewer') => ({ position: [x, y, z], quaternion: [0, 0, 0, 1], emulatedPosition: false, source });
function sample(name, index) {
  // Distinct position markers expose accidental sender/role mixups.
  const x = { performer: .1, phone: -.8, headset: .8 }[name] + index * .01;
  return { t: index * .12, visibility: 'visible', head: pose(x, name === 'performer' ? 0 : 1.6, .5),
    left: pose(x - .25, 1.1, .3, 'controller-grip'), right: pose(x + .25, 1.1, .3, 'controller-grip'),
    body: { hips: pose(x, .9, .5) } };
}

el('connect').addEventListener('click', async () => {
  disconnect(); resetAssertions(); log = [];
  const token = generation;
  busy = true; buttons(); status('connecting', '3つの実 WebSocket 接続を開始しています…');
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const options = { url: el('relay-url').value, room: `smoke-${suffix.slice(0, 16)}`, token: suffix };
  el('current-room').value = options.room; el('current-token').value = options.token;
  try {
    // Room membership is independent for each actual client connection.
    await Promise.all(names.map(name => createClient(name).room.connect({ ...options,
      role: name === 'performer' ? 'performer' : 'audience', name: `Smoke ${name}`,
      device: name === 'performer' ? 'desktop' : name })));
    await until(() => [...clients.values()].every(client => client.id && client.peers.length === 2), token, '全員の名簿');
    assertion('roster', true, '3 sockets; peers 2 / 2 / 2');
    status('connected', '3クライアントが接続しました。Run pose assertions を押してください。');
  } catch (error) { failure(error, token); }
  finally { if (token === generation) { busy = false; buttons(); } }
});

el('run').addEventListener('click', async () => {
  stopScene();
  const token = generation;
  busy = true; posesPassed = false; buttons();
  for (const client of clients.values()) client.packets = [];
  status('running', '演者と両観客の姿勢を実際の中継サーバーへ送っています…');
  try {
    for (let index = 0; index < 8; index++) {
      if (token !== generation) return;
      for (const name of names) clients.get(name).room.sendPose({ sample: sample(name, index), initialHeadHeight: 1.6,
        referenceSpace: name === 'performer' ? 'local-floor' : 'stage' });
      await delay(120);
    }
    await until(() => received('phone', 'performer').length >= 3 && received('headset', 'performer').length >= 3
      && received('phone', 'headset').length >= 3 && received('headset', 'phone').length >= 3, token, '4つの配信経路');
    for (const [receiver, sender, key] of [
      ['phone', 'performer', 'performer-phone'], ['headset', 'performer', 'performer-headset'],
      ['headset', 'phone', 'phone-headset'], ['phone', 'headset', 'headset-phone'],
    ]) {
      const packets = received(receiver, sender);
      const unique = new Set(packets.map(packet => packet.seq));
      assertion(key, unique.size >= 3 && packets.every(packet => packet.sample.head)
        && new Set(packets.map(packet => packet.sample.head.position[0])).size >= 3, `${packets.length} packets / ${unique.size} sequences`);
    }
    const phone = received('headset', 'phone');
    assertion('phone-stripped', phone.every(packet => packet.sample.left === null && packet.sample.right === null && packet.sample.body === null), 'head only');
    const headset = received('phone', 'headset');
    assertion('headset-hands', headset.every(packet => packet.sample.left && packet.sample.right), 'left + right');
    posesPassed = true;
    status('poses-passed', '姿勢中継が成功しました。Leave headset and verify で退室を確認してください。');
    note(JSON.stringify({ result: 'pose assertions passed', performerToPhone: received('phone', 'performer').length,
      performerToHeadset: received('headset', 'performer').length, phoneToHeadset: phone.length, headsetToPhone: headset.length }));
  } catch (error) { failure(error, token); }
  finally { if (token === generation) { busy = false; buttons(); } }
});

el('leave').addEventListener('click', async () => {
  stopScene();
  const token = generation;
  busy = true; buttons(); status('leaving', 'HMDクライアントを切断し、名簿の更新を待っています…');
  const headset = clients.get('headset');
  try {
    headset.left = true; headset.room.disconnect();
    await until(() => ['performer', 'phone'].every(name => {
      const peers = clients.get(name).peers;
      return peers.length === 1 && !peers.some(peer => peer.id === headset.id);
    }), token, '退室後の名簿');
    assertion('leave', true, 'performer + phone: 1 peer each');
    status('passed', '8 / 8 assertions passed — 実 WebSocket の3クライアント中継と退室を確認しました。');
    note('PASS: disconnected headset removed from both remaining rosters.');
  } catch (error) { failure(error, token); }
  finally { if (token === generation) { busy = false; buttons(); } }
});

el('disconnect').addEventListener('click', () => { disconnect(); status('idle', '全クライアントを切断しました。'); });
function stopScene() {
  if (sceneInterval !== null) clearInterval(sceneInterval);
  sceneInterval = null;
  buttons();
}
function sceneSample(name, elapsed) {
  const wave = Math.sin(elapsed * 3);
  if (name === 'performer') return { t: elapsed, visibility: 'visible',
    head: pose(Math.sin(elapsed) * .025, 0, 0),
    left: pose(-.45, -.3 + .25 * wave, -.15, 'controller-grip'),
    right: pose(.45, -.3 - .25 * wave, -.15, 'controller-grip'), body: null };
  const x = name === 'phone' ? -.7 : .7;
  const face = pose(x + Math.sin(elapsed) * .06, 1.6, 1.5);
  // Facing the +Z desktop preview camera makes both synthetic faces visible.
  face.quaternion = [0, 1, 0, 0];
  return { t: elapsed, visibility: 'visible', head: face,
    left: pose(x - .25, 1.1 + .18 * wave, 1.5, 'controller-grip'),
    right: pose(x + .25, 1.1 - .18 * wave, 1.5, 'controller-grip'), body: null };
}
el('scene-start').addEventListener('click', () => {
  stopScene();
  const token = generation;
  const started = performance.now();
  const send = () => {
    const elapsed = (performance.now() - started) / 1000;
    if (token !== generation || elapsed >= 60) {
      stopScene(); status('scene-stopped', '合成姿勢の連続配信を終了しました。'); return;
    }
    for (const name of names) clients.get(name)?.room.sendPose({ sample: sceneSample(name, elapsed),
      initialHeadHeight: 1.6, referenceSpace: name === 'performer' ? 'local-floor' : 'stage' });
    status('scene-running', `合成姿勢を連続配信中: ${elapsed.toFixed(1)} / 60 秒。実アプリを同じルームへ接続してください。`);
  };
  sceneInterval = setInterval(send, 100); send(); buttons();
});
el('scene-stop').addEventListener('click', () => { stopScene(); status('scene-stopped', '合成姿勢の連続配信を停止しました。'); });
window.addEventListener('pagehide', disconnect);
