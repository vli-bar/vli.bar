import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { resolvePlaybackSource, canResumeTake, startTakePlayback, applyPlaybackMotion } from '../src/playback-source.js';
import { applyCaptureToVRM, validateMotionClip } from '../src/motion-data.js';
import { validateDemoMotion } from '../src/demo-motion.js';
import { exportMotionVRMA } from '../src/vrma-export.js';
import { parseVRMA, createVRMAPlayer } from '../src/vrma.js';

const deferred = () => { let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; }); return { promise, resolve, reject }; };
const bytes = async name => { const data = await readFile(new URL(name, import.meta.url)); return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength); };
const capture = validateMotionClip(JSON.parse(await readFile(new URL('./fixtures/capture-sample.json', import.meta.url), 'utf8')));
const sameRotation = (actual, expected) => assert.ok(actual.clone().normalize().angleTo(expected.clone().normalize()) < 1e-6,
  `${actual.toArray()} matches ${expected.toArray()}`);
async function avatar() {
  const loader = new GLTFLoader(); loader.register(parser => new VRMLoaderPlugin(parser));
  const vrm = (await loader.parseAsync(await bytes('../public/demo/vli-performer.vrm'), '')).userData.vrm;
  const bounds = new THREE.Box3().setFromObject(vrm.scene), scale = 1.8 / (bounds.max.y - bounds.min.y);
  vrm.scene.scale.setScalar(scale); vrm.scene.position.set(0, -bounds.min.y * scale, -1.1);
  const stage = new THREE.Group(); stage.position.set(2, .2, -3); stage.rotation.y = .6; stage.scale.setScalar(1.2); stage.add(vrm.scene);
  return { vrm, stage };
}

const take = { format: 'vrma', duration: 2 };
const placedAR = { source: 'take', take, sessionMode: 'live', inputReady: true, placed: true, tracking: true, visibility: 'visible' };

test('source selection preserves a chosen take and gives active LAN reception priority', () => {
  assert.equal(resolvePlaybackSource('take', take), 'take');
  assert.equal(resolvePlaybackSource('take', null), 'demo');
  assert.equal(resolvePlaybackSource('demo', take), 'demo');
  assert.equal(resolvePlaybackSource('live', take), 'demo');
  for (const choice of ['take', 'demo', 'live', null]) {
    assert.equal(resolvePlaybackSource(choice, take, { watchingLAN: true }), 'live');
    assert.equal(resolvePlaybackSource(choice, null, { watchingLAN: true }), 'live');
  }
});

test('take resume works on the page and in placed AR, but not in capture or untracked AR', () => {
  assert.equal(canResumeTake({ source: 'take', take }), true);
  assert.equal(canResumeTake(placedAR), true);
  for (const change of [{ source: 'demo' }, { source: 'live' }, { take: null }, { xrBusy: true }, { cameraOpen: true },
    { inputReady: false }, { placed: false }, { tracking: false }, { visibility: 'hidden' }, { visibility: 'visible-blurred' },
    { sessionMode: 'record' }, { sessionMode: 'unsupported' }]) {
    assert.equal(canResumeTake({ ...placedAR, ...change }), false, JSON.stringify(change));
  }
  assert.equal(canResumeTake(), false);
});

test('a cancelled request cannot prepare audio or start a playback clock', async () => {
  const fail = () => { throw new Error('cancelled playback must not run'); };
  assert.equal(await startTakePlayback({ audio: { prepare: fail, play: fail }, withMusic: true, isCurrent: () => false, onStart: fail }), false);
});

test('marker AR resumes the selected take only while the marker is visible', async () => {
  const state = {source:'take',take,markerActive:true,markerTracked:true};
  assert.equal(canResumeTake(state),true);
  for (const change of [{markerTracked:false},{visibility:'hidden'},{cameraOpen:true},{sessionMode:'record'}]) {
    assert.equal(canResumeTake({...state,...change}),false);
  }
  const prepared = deferred(), calls = [];
  const pending = startTakePlayback({audio:{prepare:()=>prepared.promise,play:()=>calls.push('play')},withMusic:true,
    isCurrent:()=>canResumeTake(state),onStart:()=>calls.push('start')});
  state.markerTracked = false;prepared.resolve();
  assert.equal(await pending,false);assert.deepEqual(calls,[]);
});

test('ending or repositioning AR while music prepares invalidates the pending start', async () => {
  for (const transition of ['end', 'reposition', 'tracking-loss', 'source-change']) {
    const ready = deferred(); const calls = []; let request = 1, state = { ...placedAR };
    const current = request;
    const pending = startTakePlayback({ audio: { prepare() { calls.push('prepare'); return ready.promise; }, play() { calls.push('play'); } }, withMusic: true,
      isCurrent: () => request === current && canResumeTake(state), onStart: () => calls.push('start') });
    if (transition === 'end') { request++; state.sessionMode = null; }
    else if (transition === 'reposition') state.placed = false;
    else if (transition === 'tracking-loss') state.tracking = false;
    else state.source = 'live';
    ready.resolve();
    assert.equal(await pending, false, transition); assert.deepEqual(calls, ['prepare'], transition);
  }
});

test('music begins at the requested offset before its playback clock, while silent takes never touch audio', async () => {
  const calls = [];
  assert.equal(await startTakePlayback({ audio: { async prepare() { calls.push('prepare'); }, play(offset) { calls.push(['play', offset]); } },
    withMusic: true, offset: 7.25, isCurrent: () => true, onStart: () => calls.push('start') }), true);
  assert.deepEqual(calls, ['prepare', ['play', 7.25], 'start']);
  let started = 0;
  const forbiddenAudio = new Proxy({}, { get() { throw new Error('silent take must not access audio'); } });
  assert.equal(await startTakePlayback({ audio: forbiddenAudio, withMusic: false, isCurrent: () => true, onStart: () => started++ }), true);
  assert.equal(started, 1);
});

test('audio failures propagate without starting the visual playback clock', async () => {
  for (const failingPhase of ['prepare', 'play']) {
    let started = false;
    await assert.rejects(startTakePlayback({ audio: {
      async prepare() { if (failingPhase === 'prepare') throw new Error('prepare failed'); },
      play() { if (failingPhase === 'play') throw new Error('play failed'); },
    }, withMusic: true, isCurrent: () => true, onStart: () => { started = true; } }), new RegExp(failingPhase));
    assert.equal(started, false);
  }
});

test('live, absent take and missing VRMA player never fall through to the demo animation', () => {
  const calls = [];
  const demoPlayer = { seek: time => calls.push(time) };
  for (const parameters of [{ source: 'live', take }, { source: 'take', take: null }, { source: 'take', take },
    { source: 'take', take: { format: 'unsupported' } }, { source: null }]) {
    assert.equal(applyPlaybackMotion({}, { ...parameters, t: 1, demoPlayer }), false);
  }
  assert.deepEqual(calls, []);
  assert.equal(applyPlaybackMotion({}, { source: 'demo', t: -5, demoPlayer }), true);
  assert.deepEqual(calls, [0]);
});

test('selected captured motion controls the real VRM inside an AR-transformed stage and survives VRM.update', async () => {
  const { vrm, stage } = await avatar();
  const demo = await parseVRMA(await bytes('../public/demo/neon-door.vrma'));
  const actualDemo = createVRMAPlayer(vrm, demo); let demoCalls = 0;
  const demoPlayer = { seek(time) { demoCalls++; actualDemo.seek(time); } };
  applyCaptureToVRM(vrm, capture, .5);
  const expectedHead = vrm.humanoid.getNormalizedBoneNode('head').quaternion.clone();
  const expectedArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm').quaternion.clone();
  const expectedHips = vrm.humanoid.getNormalizedBoneNode('hips').position.clone();
  const stageTransform = stage.matrix.clone();
  applyPlaybackMotion(vrm, { source: 'demo', t: 20, demoPlayer });
  assert.equal(demoCalls, 1);
  assert.equal(applyPlaybackMotion(vrm, { source: 'take', take: capture, t: .5, demoPlayer }), true);
  vrm.update(1 / 60);
  sameRotation(vrm.humanoid.getNormalizedBoneNode('head').quaternion, expectedHead);
  sameRotation(vrm.humanoid.getNormalizedBoneNode('leftUpperArm').quaternion, expectedArm);
  assert.ok(vrm.humanoid.getNormalizedBoneNode('hips').position.distanceTo(expectedHips) < 1e-6);
  assert.equal(demoCalls, 1, 'a selected recording must not seek the demo in the same render path');
  assert.deepEqual(stage.matrix.elements, stageTransform.elements);
  actualDemo.dispose();
});

test('an exported/imported VRMA and legacy choreography each apply the selected motion without invoking demo', async () => {
  const { vrm } = await avatar();
  const source = await parseVRMA(exportMotionVRMA(vrm, capture));
  const player = createVRMAPlayer(vrm, source);
  const expectedArm = vrm.humanoid.getNormalizedBoneNode('leftUpperArm');
  player.seek(.5); const expected = expectedArm.quaternion.clone();
  player.seek(1.5);
  const demoPlayer = { seek() { throw new Error('demo must not override a selected take'); } };
  assert.equal(applyPlaybackMotion(vrm, { source: 'take', take: source, t: .5, takePlayer: player, demoPlayer }), true);
  vrm.update(1 / 60); sameRotation(expectedArm.quaternion, expected);
  const legacy = validateDemoMotion({ duration: 1, fps: 1, frames: [
    { t: 0, bones: { head: [0, 0, 0] }, root: [0, 0, 0] },
    { t: 1, bones: { head: [0, .6, 0] }, root: [.1, 0, 0] },
  ] });
  const restHips = vrm.humanoid.getNormalizedBoneNode('hips').position.clone();
  assert.equal(applyPlaybackMotion(vrm, { source: 'take', take: legacy, t: .5, restHips, demoPlayer }), true);
  const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, .3, 0));
  sameRotation(vrm.humanoid.getNormalizedBoneNode('head').quaternion, turn);
  assert.ok(vrm.humanoid.getNormalizedBoneNode('hips').position.distanceTo(restHips.clone().add(new THREE.Vector3(.05, 0, 0))) < 1e-6);
  player.dispose();
});
