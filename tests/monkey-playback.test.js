import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as THREE from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {VRMLoaderPlugin} from '@pixiv/three-vrm';
import {validateMotionClip, serializeMotionClip, sampleMotionClip} from '../src/motion-data.js';
import {resolvePlaybackSource, canResumeTake, startTakePlayback, applyPlaybackMotion} from '../src/playback-source.js';
import {parseVRMA, createVRMAPlayer} from '../src/vrma.js';
import {exportMotionVRMA} from '../src/vrma-export.js';

const SEED = 0x564c4933;
function random(seed = SEED) { let state = seed; return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; }; }
const choice = (rng, values) => values[Math.floor(rng() * values.length)];
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const bytes = async name => { const value = await readFile(new URL(name, import.meta.url)); return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength); };
const capture = validateMotionClip(JSON.parse(await readFile(new URL('./fixtures/capture-sample.json', import.meta.url), 'utf8')));
const demoBytes = await bytes('../public/demo/neon-door.vrma');
const demoJSON = JSON.parse(new TextDecoder().decode(new Uint8Array(demoBytes, 20, new DataView(demoBytes).getUint32(12, true))));
async function avatar() { const loader = new GLTFLoader(); loader.register(parser => new VRMLoaderPlugin(parser)); return (await loader.parseAsync(await bytes('../public/demo/vli-performer.vrm'), '')).userData.vrm; }

// Valid, tiny self-contained VRMA built with the shipped skeleton. This controls
// the glTF sampler layout independently of the importer and VRMA exporter.
function motionBuffer({rotation = [[0, 0, 0, 1], [0, 0, 0, 1]], translation, expression, interpolation = 'LINEAR', restHipY} = {}) {
  const json = structuredClone(demoJSON), binary = [];
  json.accessors = []; json.bufferViews = []; json.animations = [{samplers: [], channels: []}];
  let size = 0;
  function accessor(values, components) {
    const data = new Float32Array(values.flat());
    const viewIndex = json.bufferViews.length;
    json.bufferViews.push({buffer: 0, byteOffset: size, byteLength: data.byteLength}); binary.push(Buffer.from(data.buffer)); size += data.byteLength;
    const index = json.accessors.length;
    json.accessors.push({bufferView: viewIndex, componentType: 5126, count: data.length / components, type: {1: 'SCALAR', 3: 'VEC3', 4: 'VEC4'}[components]});
    return index;
  }
  function channel(node, path, values, components) {
    const sampler = json.animations[0].samplers.length;
    json.animations[0].samplers.push({input: accessor([0, 1], 1), output: accessor(values, components), interpolation});
    json.animations[0].channels.push({sampler, target: {node, path}});
  }
  const hips = json.extensions.VRMC_vrm_animation.humanoid.humanBones.hips.node;
  if (restHipY !== undefined) json.nodes[hips].translation[1] = restHipY;
  if (rotation) channel(hips, 'rotation', rotation, 4);
  if (translation) channel(hips, 'translation', translation, 3);
  if (expression) channel(json.extensions.VRMC_vrm_animation.expressions.preset.happy.node, 'translation', expression, 3);
  json.buffers = [{byteLength: size}];
  const jsonBytes = Buffer.from(JSON.stringify(json));
  const jsonLength = Math.ceil(jsonBytes.length / 4) * 4;
  const glb = Buffer.alloc(20 + jsonLength + 8 + size);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(jsonLength, 12); glb.writeUInt32LE(0x4e4f534a, 16);
  glb.fill(0x20, 20, 20 + jsonLength); jsonBytes.copy(glb, 20);
  glb.writeUInt32LE(size, 20 + jsonLength); glb.writeUInt32LE(0x004e4942, 24 + jsonLength);
  Buffer.concat(binary).copy(glb, 28 + jsonLength);
  return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength);
}

function finiteRig(vrm, label) {
  const bones = Object.values(vrm.humanoid.normalizedHumanBones);
  assert.ok(bones.length > 0, `${label}: no bones were checked`);
  for (const bone of bones) {
    const node = bone.node;
    assert.ok([...node.position, ...node.quaternion, ...node.scale].every(Number.isFinite), label);
    assert.ok(Math.abs(node.quaternion.length() - 1) < .002, `${label}: non-unit bone rotation`);
  }
}

test(`seed ${SEED}: 320 pending playback requests survive random supersession, AR loss and audio errors`, async () => {
  const rng = random(); let generation = 0, started = 0, audioStarts = 0;
  let state = {source: 'take', take: capture, sessionMode: null};
  const queued = [], settled = [], failures = [];
  for (let step = 0; step < 320; step++) {
    const id = ++generation;
    const inAR = rng() > .45;
    state = {source: resolvePlaybackSource(choice(rng, ['take', 'take', 'demo']), capture, {watchingLAN: rng() < .08}), take: capture,
      sessionMode: inAR ? 'live' : null, inputReady: true, placed: true, tracking: true, visibility: 'visible'};
    const prepared = deferred(), withMusic = rng() > .2;
    const current = () => id === generation && canResumeTake(state);
    const audio = {prepare: () => prepared.promise, play() { assert.equal(current(), true, `stale audio start at ${step}`); audioStarts++; }};
    settled.push(startTakePlayback({audio, withMusic, isCurrent: current, onStart() {
      assert.equal(current(), true, `stale visual start at ${step}`); started++;
    }}).catch(error => { if (error.message !== 'synthetic decode failure') failures.push(error); }));
    queued.push(prepared);
    const action = choice(rng, ['resolve', 'cancel', 'reposition', 'hide', 'capture', 'fail', 'defer']);
    if (action === 'cancel') { generation++; state.sessionMode = null; }
    else if (action === 'reposition') { state.sessionMode = 'live'; state.placed = false; }
    else if (action === 'hide') { state.sessionMode = 'live'; state.visibility = 'hidden'; }
    else if (action === 'capture') state.cameraOpen = true;
    if (action === 'fail' && withMusic && current()) prepared.reject(new Error('synthetic decode failure'));
    else if (action !== 'defer') prepared.resolve();
    if (queued.length > 4) choice(rng, queued).resolve();
    await Promise.resolve(); await Promise.resolve();
  }
  generation++; for (const item of queued) item.resolve(); await Promise.all(settled);
  assert.deepEqual(failures, []); assert.ok(started > 10); assert.ok(audioStarts > 0); assert.ok(audioStarts <= started);
});

test(`seed ${SEED}: 400 malformed raw-pose boundary mutations are rejected without changing the source`, () => {
  const rng = random(); const original = serializeMotionClip(capture);
  const edits = [
    clip => { clip.fps = choice(rng, [0, 61, NaN, 1.5]); },
    clip => { clip.frames[1].t = choice(rng, [0, -1, Infinity, clip.duration + 1]); },
    clip => { clip.frames[0].head.quaternion = choice(rng, [[0, 0, 0, 0], [0, 0, 0, 2], [NaN, 0, 0, 1]]); },
    clip => { clip.frames[0].head.position[Math.floor(rng() * 3)] = choice(rng, [Infinity, -Infinity, NaN, 101, -101, '1']); },
    clip => { clip.frames[0].visibility = choice(rng, ['hidden', 'visible-blurred', 'unknown']); },
    clip => { clip.initialHeadHeight = choice(rng, [-1, .299, 3.001, Infinity]); },
    clip => { clip.duration = choice(rng, [181, -1, NaN, 0]); },
    clip => { clip.referenceSpace = choice(rng, ['stage', '', null, 'camera-pose']); },
  ];
  for (let i = 0; i < 400; i++) { const clip = structuredClone(capture); choice(rng, edits)(clip); assert.throws(() => validateMotionClip(clip), Error, `mutation ${i}`); }
  assert.equal(serializeMotionClip(capture), original);
});

test(`seed ${SEED}: seek and source-switch churn keeps real VRM transforms finite and leaves live poses untouched`, async () => {
  const rng = random(), vrm = await avatar();
  const demo = await parseVRMA(demoBytes), exported = await parseVRMA(exportMotionVRMA(vrm, capture));
  const demoPlayer = createVRMAPlayer(vrm, demo), takePlayer = createVRMAPlayer(vrm, exported);
  const snapshot = () => structuredClone(vrm.humanoid.getNormalizedPose());
  for (let step = 0; step < 280; step++) {
    const source = choice(rng, ['demo', 'take', 'take', 'live']);
    const take = choice(rng, [capture, exported, null]);
    const t = rng() < .2 ? choice(rng, [NaN, Infinity, -Infinity, -1, 0, 180]) : rng() * 75;
    const before = snapshot();
    applyPlaybackMotion(vrm, {source, take, t, demoPlayer, takePlayer});
    if (source === 'live' || (source === 'take' && !take)) assert.deepEqual(snapshot(), before, `unselected source changed bones at ${step}`);
    vrm.update(1 / 60); finiteRig(vrm, `seek step ${step}`);
    if (source === 'take' && take === capture) {
      const sample = sampleMotionClip(capture, t);
      for (const track of ['head', 'left', 'right']) if (sample[track]) assert.ok([...sample[track].position, ...sample[track].quaternion].every(Number.isFinite));
    }
  }
  takePlayer.dispose(); demoPlayer.dispose();
});

test(`seed ${SEED}: malformed VRMA quaternions and extreme translations are rejected`, async () => {
  const rng = random();
  for (let i = 0; i < 24; i++) {
    const norm = choice(rng, [0, .1, .7, 1.3, 4]);
    const quaternion = new THREE.Quaternion().setFromEuler(new THREE.Euler(rng(), rng(), rng())).toArray().map(n => n * norm);
    await assert.rejects(parseVRMA(motionBuffer({rotation: [quaternion, [0, 0, 0, 1]]})), /回転/, `quaternion mutation ${i}`);
    const position = [0, .9, 0]; position[Math.floor(rng() * 3)] = (rng() > .5 ? 1 : -1) * 10 ** (3 + Math.floor(rng() * 20));
    await assert.rejects(parseVRMA(motionBuffer({translation: [position, [0, .9, 0]]})), /移動量/, `translation mutation ${i}`);
  }
});

test('valid CUBICSPLINE accepts zero/non-unit tangents and retains the curve in humanoid and expression playback', async () => {
  const q0 = [0, 0, 0, 1], q1 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .8).toArray();
  const out = [0, .4, 0, 0], incoming = [0, -.3, 0, 0], zeroQ = [0, 0, 0, 0], zeroP = [0, 0, 0];
  const source = await parseVRMA(motionBuffer({interpolation: 'CUBICSPLINE',
    rotation: [zeroQ, q0, out, incoming, q1, zeroQ],
    translation: [zeroP, [0, .9, 0], [.6, 0, 0], [-.2, 0, 0], [.2, .9, 0], zeroP],
    expression: [zeroP, zeroP, [.4, 0, 0], [-.2, 0, 0], [1, 0, 0], zeroP],
  }));
  const vrm = await avatar(), player = createVRMAPlayer(vrm, source);
  player.seek(.5); vrm.update(1 / 60);
  const expectedQ = new THREE.Quaternion().fromArray(q0.map((value, i) => .5 * value + .125 * out[i] + .5 * q1[i] - .125 * incoming[i])).normalize();
  assert.ok(vrm.humanoid.getNormalizedBoneNode('hips').quaternion.clone().normalize().angleTo(expectedQ) < 1e-6);
  const scale = vrm.humanoid.normalizedRestPose.hips.position[1] / source.animation.restHipsPosition.y;
  assert.ok(Math.abs(vrm.humanoid.getNormalizedBoneNode('hips').position.x - .2 * scale) < 1e-6);
  assert.ok(Math.abs(vrm.expressionManager.getValue('happy') - .575) < 1e-6);
  finiteRig(vrm, 'cubic playback');
  for (const t of [1, 0, .2, .8, .5]) { player.seek(t); vrm.update(1 / 60); finiteRig(vrm, `cubic seek ${t}`); }
  player.dispose();
});

test('CUBICSPLINE still rejects invalid value quaternions and between-key translation explosions', async () => {
  const zero = [0, 0, 0, 0], identity = [0, 0, 0, 1];
  await assert.rejects(parseVRMA(motionBuffer({interpolation: 'CUBICSPLINE', rotation: [zero, zero, zero, zero, identity, zero]})), /回転/);
  const zeroP = [0, 0, 0];
  await assert.rejects(parseVRMA(motionBuffer({interpolation: 'CUBICSPLINE', rotation: [zero, identity, zero, zero, identity, zero],
    translation: [zeroP, [0, 1, 0], [1e8, 0, 0], [-1e8, 0, 0], [0, 1, 0], zeroP]})), /移動量/);
});

test('STEP rotations and expressions stay constant between keys after retargeting', async () => {
  const source = await parseVRMA(motionBuffer({interpolation: 'STEP',
    rotation: [[0, 0, 0, 1], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), .8).toArray()], expression: [[0, 0, 0], [1, 0, 0]]}));
  const vrm = await avatar(), player = createVRMAPlayer(vrm, source);
  player.seek(.75);
  assert.ok(vrm.humanoid.getNormalizedBoneNode('hips').quaternion.angleTo(new THREE.Quaternion()) < 1e-6);
  assert.equal(vrm.expressionManager.getValue('happy'), 0);
  player.seek(1); assert.equal(vrm.expressionManager.getValue('happy'), 1);
  player.dispose();
});

test('translation retargeting rejects zero or invalid rest hips height before producing NaN', async () => {
  for (const restHipY of [0, -1, .00001]) {
    await assert.rejects(parseVRMA(motionBuffer({restHipY, translation: [[0, 0, 0], [0, .1, 0]]})), /基準腰高/);
  }
  // Rotation-only clips do not use the hips-height divisor.
  const source = await parseVRMA(motionBuffer({restHipY: 0}));
  const vrm = await avatar(), player = createVRMAPlayer(vrm, source);
  player.seek(.5); vrm.update(1 / 60); finiteRig(vrm, 'rotation-only clip with zero rest hips');
  player.dispose();
});
