import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createXRHUD } from '../src/xr-hud.js';

function fixture() {
  const writes = [];
  const ctx = Object.fromEntries(['clearRect', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'quadraticCurveTo', 'closePath', 'fill', 'stroke'].map(name => [name, () => {}]));
  ctx.fillText = (text, x, y) => writes.push({ text, x, y, fill: ctx.fillStyle });
  const canvas = { getContext: () => ctx };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(0, 1.6, 0);
  const hud = createXRHUD(scene, { canvas });
  hud.update(camera, '壁の候補を検出', 'トリガーで配置', true);
  const target = scene.getObjectByName('xr-hud-exit-target');
  const panel = scene.getObjectByName('xr-hud');
  const pointers = scene.getObjectByName('xr-hud-pointers');
  const referenceSpace = { type: 'local' };
  const poses = new Map();
  const frame = { session: { visibilityState: 'visible' }, getPose: space => poses.get(space) ?? null };
  const controller = { targetRayMode: 'tracked-pointer', targetRaySpace: {} };
  function aim(source = controller, point = target.getWorldPosition(new THREE.Vector3()), origin = new THREE.Vector3(.25, 1.15, -.3)) {
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), point.clone().sub(origin).normalize());
    const matrix = new THREE.Matrix4().compose(origin, quaternion, new THREE.Vector3(1, 1, 1));
    const value = { emulatedPosition: false, transform: { matrix: matrix.toArray() } };
    poses.set(source.targetRaySpace, value);
    return value;
  }
  aim();
  return { hud, scene, camera, writes, canvas, panel, target, pointers, referenceSpace, frame, poses, controller, aim };
}

test('XR HUD keeps return controls separate from instructions and changes the recording label', () => {
  const { hud, camera, writes, target, panel } = fixture();
  assert.ok(writes.some(item => item.text === '← ページへ戻る'));
  const button = writes.find(item => item.text === '← ページへ戻る');
  assert.ok(writes.filter(item => /壁の候補|トリガーで配置/.test(item.text)).every(item => item.y < button.y - 100));
  assert.ok(target.geometry.parameters.width > .4, 'the exit target is large enough for controller aiming');
  assert.ok(target.position.y < 0, 'the target stays below the instruction area');
  assert.equal(panel.material.depthTest, false);
  hud.update(camera, '● REC 00:10', '頭と両手を収録中', true, true);
  assert.equal(writes.at(-2).text, '← 保存して戻る');
  hud.update(camera, 'MOTION CAPTURE', '収録待機', true, false);
  assert.equal(writes.at(-2).text, '← ページへ戻る');
});

test('controller rays highlight and select the explicit return button, not surrounding instructions', () => {
  const { hud, frame, controller, referenceSpace, pointers, writes, aim, panel } = fixture();
  assert.equal(hud.updatePointers(frame, [controller], referenceSpace), true);
  assert.equal(hud.select(frame, controller, referenceSpace), true);
  const line = pointers.children[0];
  assert.equal(line.visible, true);
  assert.equal(line.material.depthTest, false);
  assert.equal(line.material.color.getHex(), 0xc6ff75);
  assert.ok(line.scale.z > 0 && line.scale.z < 2, 'visible ray ends at the hovered button');
  const count = writes.length;
  hud.updatePointers(frame, [controller], referenceSpace);
  assert.equal(writes.length, count, 'unchanged hover does not redraw the texture');
  aim(controller, panel.localToWorld(new THREE.Vector3(0, .07, .002)));
  assert.equal(hud.select(frame, controller, referenceSpace), false, 'instruction text is not an exit target');
  assert.equal(hud.updatePointers(frame, [controller], referenceSpace), false);
  assert.equal(line.material.color.getHex(), 0xa1b7c7);
});

test('select uses current tracked input and cannot reuse stale hover or invalid XR poses', () => {
  const { hud, frame, controller, referenceSpace, poses, aim, pointers } = fixture();
  assert.equal(hud.updatePointers(frame, [controller], referenceSpace), true);
  poses.delete(controller.targetRaySpace);
  assert.equal(hud.select(frame, controller, referenceSpace), false);
  assert.equal(hud.updatePointers(frame, [controller], referenceSpace), false);
  assert.equal(pointers.children[0].visible, false);
  aim().emulatedPosition = true;
  assert.equal(hud.select(frame, controller, referenceSpace), false);
  aim().transform.matrix[12] = NaN;
  assert.equal(hud.select(frame, controller, referenceSpace), false);
  aim();
  frame.session.visibilityState = 'visible-blurred';
  assert.equal(hud.select(frame, controller, referenceSpace), false);
  frame.session.visibilityState = 'visible';
  frame.getPose = () => { throw new Error('XR frame has ended'); };
  assert.equal(hud.select(frame, controller, referenceSpace), false);
});

test('inactive HUD rejects selects, hides rays, and can reopen with fresh inputs', () => {
  const { hud, frame, controller, referenceSpace, camera, panel, pointers } = fixture();
  hud.updatePointers(frame, [controller], referenceSpace);
  hud.update(camera, '', '', false);
  assert.equal(panel.visible, false);
  assert.equal(pointers.visible, false);
  assert.equal(hud.select(frame, controller, referenceSpace), false);
  assert.equal(hud.updatePointers(frame, [controller], referenceSpace), false);
  hud.update(camera, 'MOTION CAPTURE', '収録待機', true);
  assert.equal(hud.updatePointers(frame, [controller], referenceSpace), true);
  assert.equal(hud.select(frame, controller, referenceSpace), true);
});

test('the button follows translated and rotated head pose and remains selectable from either hand', () => {
  const { hud, camera, panel, target, frame, controller, referenceSpace, aim, pointers } = fixture();
  camera.position.set(2, 1.75, -3);
  camera.rotation.set(.15, 1.1, 0);
  hud.follow(camera);
  assert.ok(panel.quaternion.angleTo(camera.quaternion) < 1e-6);
  const center = target.getWorldPosition(new THREE.Vector3());
  const otherHand = { targetRayMode: 'tracked-pointer', targetRaySpace: {} };
  aim(controller, center, camera.position.clone().add(new THREE.Vector3(-.25, -.3, 0)));
  aim(otherHand, center, camera.position.clone().add(new THREE.Vector3(.25, -.3, 0)));
  assert.equal(hud.select(frame, controller, referenceSpace), true);
  assert.equal(hud.select(frame, otherHand, referenceSpace), true);
  assert.equal(hud.updatePointers(frame, [controller, otherHand], referenceSpace), true);
  assert.equal(pointers.children.length, 2);
  hud.updatePointers(frame, [otherHand], referenceSpace);
  assert.equal(pointers.children.length, 1, 'disconnected controller rays are removed');
});

test('gaze/screen select can exit without controller rays and HUD resources can be disposed', () => {
  const { hud, frame, referenceSpace, aim, pointers, scene } = fixture();
  for (const mode of ['gaze', 'screen']) {
    const source = { targetRayMode: mode, targetRaySpace: {} };
    aim(source);
    assert.equal(hud.select(frame, source, referenceSpace), true);
    assert.equal(hud.updatePointers(frame, [source], referenceSpace), true);
    assert.equal(pointers.children.length, 0);
  }
  hud.dispose();
  assert.equal(scene.getObjectByName('xr-hud'), undefined);
  assert.equal(scene.getObjectByName('xr-hud-pointers'), undefined);
});

test('all headset actions have distinct targets, including disabled actions and the permanent exit', () => {
  const { hud, scene, frame, controller, referenceSpace, aim, writes, panel, canvas } = fixture();
  const actions = [
    { id: 'place', label: 'ここに配置' }, { id: 'play', label: '再生', enabled: false },
    { id: 'reposition', label: '再配置' }, { id: 'mode', label: '距離指定へ' }, { id: 'scan', label: '部屋をスキャン' },
  ];
  hud.setActions(actions);
  for (const action of [...actions, { id: 'exit', label: '← ページへ戻る' }]) {
    const target = scene.getObjectByName(`xr-hud-${action.id}-target`);
    assert.ok(target, `${action.id} has a separate selectable target`);
    assert.ok(writes.some(write => write.text === action.label));
    aim(controller, target.getWorldPosition(new THREE.Vector3()));
    assert.equal(hud.selectAction(frame, controller, referenceSpace), action.enabled === false ? 'blocked' : action.id);
  }
  assert.equal(panel.children.length, 6);
  assert.equal(panel.geometry.parameters.height / panel.geometry.parameters.width, canvas.height / canvas.width, 'canvas and geometry preserve button proportions');
  aim(controller, panel.localToWorld(new THREE.Vector3(0, .16, .002)));
  assert.equal(hud.selectAction(frame, controller, referenceSpace), null, 'instructions do not activate a button');
});

test('Quest hand tracked-pointer selections use the current pose without a selectstart requirement', () => {
  const { hud, scene, frame, controller, referenceSpace, aim, poses, pointers } = fixture();
  hud.setActions([{ id: 'reposition', label: '再配置' }]);
  const hand = { targetRayMode: 'tracked-pointer', targetRaySpace: {}, handedness: 'right', hand: new Map() };
  aim(hand, scene.getObjectByName('xr-hud-reposition-target').getWorldPosition(new THREE.Vector3()));
  assert.equal(hud.selectAction(frame, hand, referenceSpace), 'reposition');
  hud.updatePointers(frame, [controller], referenceSpace);
  hud.updatePointers(frame, [hand], referenceSpace);
  assert.equal(pointers.children.length, 1, 'switching from controllers to hands releases old rays');
  assert.equal(pointers.children[0].visible, true);
  poses.delete(hand.targetRaySpace);
  assert.equal(hud.selectAction(frame, hand, referenceSpace), null);
});

test('Vision Pro resolves the initial pinch target once even if the completion pose disappears', () => {
  const { hud, scene, frame, referenceSpace, aim, poses, pointers } = fixture();
  hud.setActions([{ id: 'record', label: '収録開始' }]);
  const pinch = { targetRayMode: 'transient-pointer', targetRaySpace: {} };
  aim(pinch, scene.getObjectByName('xr-hud-record-target').getWorldPosition(new THREE.Vector3()));
  hud.beginSelect(frame, pinch, referenceSpace);
  hud.updatePointers(frame, [pinch], referenceSpace);
  assert.equal(pointers.children.length, 0, 'a gesture does not add a continuous gaze ray');
  poses.delete(pinch.targetRaySpace);
  assert.equal(hud.selectAction(frame, pinch, referenceSpace), 'record');
  assert.equal(hud.selectAction(frame, pinch, referenceSpace), 'blocked', 'duplicate completion cannot start another action');
  hud.endSelect(pinch);
  assert.equal(hud.selectAction(frame, pinch, referenceSpace), 'blocked');
});

test('transient pointer movement during pinch does not retarget the initial gaze selection', () => {
  const { hud, scene, frame, referenceSpace, aim } = fixture();
  hud.setActions([{ id: 'mode', label: '距離指定へ' }]);
  const pinch = { targetRayMode: 'transient-pointer', targetRaySpace: {} };
  aim(pinch, scene.getObjectByName('xr-hud-mode-target').getWorldPosition(new THREE.Vector3()));
  hud.beginSelect(frame, pinch, referenceSpace);
  aim(pinch, scene.getObjectByName('xr-hud-exit-target').getWorldPosition(new THREE.Vector3()));
  assert.equal(hud.selectAction(frame, pinch, referenceSpace), 'mode');
});

test('a valid non-HUD pinch can reach stage actions, while missing and invalid starts are blocked', () => {
  const { hud, frame, referenceSpace, aim, panel, poses } = fixture();
  const pinch = { targetRayMode: 'transient-pointer', targetRaySpace: {} };
  aim(pinch);
  assert.equal(hud.selectAction(frame, pinch, referenceSpace), 'blocked');
  poses.delete(pinch.targetRaySpace);
  hud.beginSelect(frame, pinch, referenceSpace);
  aim(pinch);
  assert.equal(hud.selectAction(frame, pinch, referenceSpace), 'blocked', 'an unavailable initial ray must not fall through to stage actions');
  aim(pinch, panel.localToWorld(new THREE.Vector3(0, .07, .002)));
  hud.beginSelect(frame, pinch, referenceSpace);
  assert.equal(hud.selectAction(frame, pinch, referenceSpace), null);
  assert.equal(hud.selectAction(frame, pinch, referenceSpace), 'blocked');
});

test('cancellation, source removal, hidden session, and explicit resets discard transient input', () => {
  for (const clear of [
    ({ hud, pinch }) => hud.endSelect(pinch),
    ({ hud, frame, referenceSpace }) => hud.updatePointers(frame, [], referenceSpace),
    ({ hud, frame, referenceSpace, pinch }) => { frame.session.visibilityState = 'hidden'; hud.updatePointers(frame, [pinch], referenceSpace); frame.session.visibilityState = 'visible'; },
    ({ hud }) => hud.resetInputs(),
    ({ hud, camera }) => { hud.update(camera, '', '', false); hud.update(camera, 'XR', '再開', true); },
  ]) {
    const fixtureValue = fixture();
    const { hud, frame, referenceSpace, aim } = fixtureValue;
    const pinch = { targetRayMode: 'transient-pointer', targetRaySpace: {} };
    aim(pinch); hud.beginSelect(frame, pinch, referenceSpace);
    clear({ ...fixtureValue, pinch });
    assert.equal(hud.selectAction(frame, pinch, referenceSpace), 'blocked');
  }
});

test('transient input cannot cross XR sessions or reference spaces', () => {
  const { hud, frame, referenceSpace, aim } = fixture();
  const pinch = { targetRayMode: 'transient-pointer', targetRaySpace: {} };
  aim(pinch); hud.beginSelect(frame, pinch, referenceSpace);
  assert.equal(hud.selectAction({ ...frame, session: { visibilityState: 'visible' } }, pinch, referenceSpace), 'blocked');
  hud.beginSelect(frame, pinch, referenceSpace);
  assert.equal(hud.selectAction(frame, pinch, {}), 'blocked');
});

test('a changed, disabled, or removed action cancels the pinch even when restored before completion', () => {
  for (const change of [
    hud => hud.setActions([{ id: 'record', label: '収録終了' }]),
    hud => hud.setActions([{ id: 'record', label: '収録開始', enabled: false }]),
    hud => hud.setActions([]),
  ]) {
    const { hud, scene, frame, referenceSpace, aim } = fixture();
    const original = [{ id: 'record', label: '収録開始' }];
    const pinch = { targetRayMode: 'transient-pointer', targetRaySpace: {} };
    hud.setActions(original);
    aim(pinch, scene.getObjectByName('xr-hud-record-target').getWorldPosition(new THREE.Vector3()));
    hud.beginSelect(frame, pinch, referenceSpace);
    change(hud); hud.setActions(original);
    assert.equal(hud.selectAction(frame, pinch, referenceSpace), 'blocked');
  }
});

test('simultaneous pinch gestures keep their selected actions separate', () => {
  const { hud, scene, frame, referenceSpace, aim } = fixture();
  hud.setActions([{ id: 'play', label: '再生' }]);
  const left = { targetRayMode: 'transient-pointer', targetRaySpace: {}, handedness: 'left' };
  const right = { targetRayMode: 'transient-pointer', targetRaySpace: {}, handedness: 'right' };
  aim(left, scene.getObjectByName('xr-hud-play-target').getWorldPosition(new THREE.Vector3()));
  aim(right, scene.getObjectByName('xr-hud-exit-target').getWorldPosition(new THREE.Vector3()));
  hud.beginSelect(frame, left, referenceSpace); hud.beginSelect(frame, right, referenceSpace);
  hud.endSelect(left);
  assert.equal(hud.selectAction(frame, right, referenceSpace), 'exit');
  assert.equal(hud.selectAction(frame, left, referenceSpace), 'blocked');
});
