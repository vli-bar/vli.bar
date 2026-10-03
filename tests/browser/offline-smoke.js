import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { CameraMotion } from '../../src/camera-motion.js';
import { CameraPoseSampler } from '../../src/camera-pose.js';
import { applyMotionSampleToVRM } from '../../src/motion-data.js';
import { parseVRMA, createVRMAPlayer } from '../../src/vrma.js';
import { LiveRoom } from '../../src/live-room.js';

// Built as a separate test entry and served by the offline kit. Only camera
// input is injected through CameraMotion's explicit DI; network/WASM are real.
const el = id => document.getElementById(id);
const asset = path => new URL(path, location.origin).href;
const labels = new Map([...el('assertions').children].map(item => [item.id, item.textContent.replace(/^WAIT: /, '')]));
const clients = new Map();
const violations = [];
const canvas = el('source');
const painter = canvas.getContext('2d');
const sampler = new CameraPoseSampler();
let runId = 0, repaint = null, presenceTimer = null, motion = null, stream = null;
let audioContext = null, vrm = null, renderer = null, scene = null, view = null;
let frameCount = 0, usableCount = 0, bodyCount = 0, inferenceError = null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function status(state, text) { el('status').dataset.state = state; el('status').textContent = text; }
function assertion(name, passed, detail = '') {
  const item = el(`assert-${name}`);
  item.dataset.state = passed ? 'passed' : 'failed';
  item.textContent = `${passed ? 'PASS' : 'FAIL'}: ${labels.get(item.id)}${detail ? ` (${detail})` : ''}`;
  el('assertion-count').textContent = `${el('assertions').querySelectorAll('[data-state="passed"]').length} / ${labels.size}`;
  if (!passed) throw new Error(item.textContent);
}
function reset() {
  for (const [id, label] of labels) { el(id).dataset.state = 'pending'; el(id).textContent = `WAIT: ${label}`; }
  el('assertion-count').textContent = `0 / ${labels.size}`;
  el('frames').textContent = '0'; el('joints').textContent = '0';
  frameCount = 0; usableCount = 0; bodyCount = 0; inferenceError = null;
  sampler.reset();
}
async function until(predicate, id, label, maxMs = 20000) {
  const deadline = performance.now() + maxMs;
  while (!predicate()) {
    if (runId !== id) throw new Error('検証を停止しました。');
    if (inferenceError) throw inferenceError;
    if (performance.now() > deadline) throw new Error(`時間切れ: ${label}`);
    await delay(50);
  }
  if (runId !== id) throw new Error('検証を停止しました。');
}
async function bytes(path) {
  const response = await fetch(asset(path));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.arrayBuffer();
}
function cleanup() {
  runId++;
  motion?.dispose(); motion = null;
  clearInterval(repaint); repaint = null;
  clearInterval(presenceTimer); presenceTimer = null;
  stream?.getTracks().forEach(track => track.stop());
  for (const client of clients.values()) client.room.disconnect();
  clients.clear();
  audioContext?.close().catch(() => {}); audioContext = null;
  el('start').disabled = false; el('stop').disabled = true;
}
function audit() {
  const entries = [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')];
  const resources = entries.map(entry => {
    const url = new URL(entry.name, location.href);
    return { type: entry.initiatorType || entry.entryType, url: url.href, origin: url.origin,
      network: ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) };
  });
  // WebSocket resource timing is not exposed consistently; include the actual
  // endpoints selected by each connected LiveRoom separately.
  for (const name of clients.keys()) resources.push({type: `WebSocket ${name}`, url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/live`, origin: location.origin, network: true});
  const external = resources.filter(entry => entry.network && entry.origin !== location.origin);
  const rows = resources.map(entry => {
    const row = document.createElement('tr');
    for (const text of [entry.type, entry.url, entry.origin]) { const cell = document.createElement('td'); cell.textContent = text; row.append(cell); }
    return row;
  });
  el('resources').replaceChildren(...rows);
  return { origin: location.origin, resources, external, violations: [...violations] };
}
document.addEventListener('securitypolicyviolation', event => {
  violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI });
  if (el('status').dataset.state === 'passed') { status('failed', '完了後にCSP違反が発生しました。'); el('result').textContent = JSON.stringify(audit(), null, 2); }
});

async function assets(id) {
  const loader = new GLTFLoader(); loader.register(parser => new VRMLoaderPlugin(parser));
  const [modelBytes, motionBytes, audioBytes] = await Promise.all([
    bytes('/demo/vli-performer.vrm'), bytes('/demo/neon-door.vrma'), bytes('/demo/neon-door.wav'),
  ]);
  if (runId !== id) return;
  const gltf = await loader.parseAsync(modelBytes, '');
  if (runId !== id) return;
  vrm = gltf.userData.vrm;
  assertion('vrm', !!vrm?.humanoid.getNormalizedBoneNode('head'), `${modelBytes.byteLength} bytes`);
  const animation = await parseVRMA(motionBytes);
  if (runId !== id) return;
  assertion('vrma', Math.abs(animation.duration - 72) < .02, `${animation.duration.toFixed(2)} seconds`);
  const decoded = await audioContext.decodeAudioData(audioBytes);
  if (runId !== id) return;
  const samples = decoded.getChannelData(0);
  let nonzero = 0, invalid = 0;
  for (let i = 0; i < samples.length; i += 97) { nonzero += Math.abs(samples[i]) > .001 ? 1 : 0; invalid += Number.isFinite(samples[i]) ? 0 : 1; }
  assertion('audio', Math.abs(decoded.duration - 72) < .02 && decoded.numberOfChannels === 2 && nonzero > 100 && invalid === 0,
    `${decoded.duration.toFixed(2)} s / ${decoded.numberOfChannels} ch / ${decoded.sampleRate} Hz`);
  if (runId !== id) return;
  renderer?.dispose(); el('avatar').replaceChildren();
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }); renderer.setSize(310, 360); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  el('avatar').append(renderer.domElement);
  scene = new THREE.Scene(); scene.add(new THREE.HemisphereLight(0xffffff, 0x566e80, 2.5)); scene.add(vrm.scene);
  view = new THREE.PerspectiveCamera(36, 310 / 360, .01, 20); view.position.set(0, 1, 3.2); view.lookAt(0, .85, 0);
  const player = createVRMAPlayer(vrm, animation); player.seek(12); vrm.update(0); renderer.render(scene, view); player.dispose();
}

function client(name) {
  const value = { id: null, peers: [], packets: [], room: null };
  clients.set(name, value);
  value.room = new LiveRoom({
    onRoster(event) { value.id = event.selfId; value.peers = event.peers; },
    onPose(packet) { value.packets.push(packet); if (value.packets.length > 100) value.packets.shift(); },
    onNotice(message) { inferenceError = new Error(String(message)); },
  });
  return value;
}
function received(receiver, sender) {
  return clients.get(receiver)?.packets.filter(packet => packet.id === clients.get(sender)?.id) ?? [];
}
const pose = (x, y, z) => ({ position: [x, y, z], quaternion: [0, 0, 0, 1], emulatedPosition: false });
async function connect(id) {
  const token = crypto.randomUUID().replaceAll('-', '');
  await Promise.all(['performer', 'phone', 'headset'].map(name => client(name).room.connect({
    url: location.origin, room: `offline-${token.slice(0, 16)}`, token, name: `Offline ${name}`,
    role: name === 'performer' ? 'performer' : 'audience', device: name === 'performer' ? 'desktop' : name,
  })));
  await until(() => [...clients.values()].every(value => value.id && value.peers.length === 2), id, '3 client rosters');
  assertion('roster', true, '3 real sockets; 2 peers each');
  presenceTimer = setInterval(() => {
    for (const name of ['phone', 'headset']) {
      const x = name === 'phone' ? -.7 : .7;
      clients.get(name)?.room.sendPose({ referenceSpace: 'stage', sample: { t: performance.now() / 1000, visibility: 'visible',
        head: pose(x, 1.6, 1), left: pose(x - .2, 1.1, 1), right: pose(x + .2, 1.1, 1), body: { hips: pose(x, .9, 1) } } });
    }
  }, 100);
}

async function infer(id) {
  const fixture = new Image(); fixture.src = new URL('./fixtures/pose.jpg', location.href).href;
  await fixture.decode();
  if (runId !== id) return;
  const draw = () => {
    painter.drawImage(fixture, 0, 0, canvas.width, canvas.height);
    painter.fillStyle = '#102338'; painter.fillRect(0, 0, 100, 18);
    painter.fillStyle = 'white'; painter.font = '11px monospace'; painter.fillText(`synthetic ${Math.round(performance.now())}`, 2, 12);
  };
  draw(); repaint = setInterval(draw, 1000 / 15);
  motion = new CameraMotion({ video: el('video'), maxFps: 15,
    wasmBaseUrl: asset('/vendor/mediapipe/wasm'), modelAssetUrl: asset('/vendor/mediapipe/pose_landmarker_lite.task'),
    deps: { mediaDevices: { getUserMedia() { stream = canvas.captureStream(15); return Promise.resolve(stream); } } },
    onStatus(event) {
      if (['error', 'hidden', 'ended'].includes(event.state)) inferenceError = new Error(event.message);
      else status('running', event.message);
    },
    onFrame(result, timeMs) {
      const tracking = sampler.sample(result, timeMs);
      frameCount++; bodyCount = tracking.bodyCount;
      if (tracking.sample.head && bodyCount >= 8) usableCount++;
      el('frames').textContent = String(frameCount); el('joints').textContent = String(bodyCount);
      if (tracking.sample.head) {
        clients.get('performer')?.room.sendPose({ sample: tracking.sample, initialHeadHeight: tracking.initialHeadHeight, referenceSpace: 'camera' });
        if (vrm && renderer) { applyMotionSampleToVRM(vrm, tracking.sample, tracking); vrm.update(1 / 15); renderer.render(scene, view); }
      }
    },
  });
  await motion.start();
  await until(() => usableCount >= 4, id, '実WASMで有効な頭・身体関節');
  assertion('inference', true, `${frameCount} frames / ${bodyCount} body joints`);
  await until(() => received('phone', 'performer').length >= 3 && received('headset', 'performer').length >= 3
    && received('phone', 'headset').length >= 2 && received('headset', 'phone').length >= 2, id, '推論と観客姿勢の中継');
  const phoneFrames = received('phone', 'performer'), headsetFrames = received('headset', 'performer');
  assertion('relay', [...phoneFrames, ...headsetFrames].every(packet => packet.referenceSpace === 'camera' && packet.sample.head?.source === 'camera-pose'),
    `camera → phone ${phoneFrames.length} / headset ${headsetFrames.length}`);
  assertion('phone', received('headset', 'phone').every(packet => packet.sample.head && !packet.sample.left && !packet.sample.right && !packet.sample.body));
  assertion('headset', received('phone', 'headset').every(packet => packet.sample.left && packet.sample.right));
}

el('start').addEventListener('click', async () => {
  cleanup(); reset();
  const id = runId;
  el('start').disabled = true; el('stop').disabled = false;
  status('running', '同じサーバーから素材と通信を確認しています…');
  try {
    audioContext = new AudioContext();
    await Promise.all([assets(id), connect(id)]);
    if (runId !== id) return;
    await infer(id);
    motion.stop({ notify: false }); clearInterval(repaint); repaint = null;
    clearInterval(presenceTimer); presenceTimer = null;
    // Allow resource timing/CSP events from initialization to be delivered.
    await delay(100);
    const report = audit();
    assertion('origin', report.external.length === 0 && report.violations.length === 0, `${report.resources.length} resources; external 0; CSP 0`);
    status('passed', '9 / 9 assertions passed — 同一サーバーの素材・実推論・3接続の中継を確認しました。WAN切断と実機ARは別途確認してください。');
    el('result').textContent = JSON.stringify({ result: 'passed', input: 'local fixture through canvas stream; actual WASM inference',
      frames: frameCount, bodyJoints: bodyCount, cameraToPhone: received('phone', 'performer').length,
      cameraToHeadset: received('headset', 'performer').length, ...report }, null, 2);
    audioContext.close().catch(() => {}); audioContext = null;
  } catch (error) {
    if (runId !== id) return;
    status('failed', error.message); el('result').textContent = JSON.stringify({ error: error.stack || error.message, ...audit() }, null, 2);
    cleanup();
  }
});
el('stop').addEventListener('click', () => { cleanup(); status('stopped', '推論・音声・3つの接続を終了しました。'); });
window.addEventListener('pagehide', () => { cleanup(); renderer?.dispose(); });
