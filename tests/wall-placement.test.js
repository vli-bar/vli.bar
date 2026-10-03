import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import * as THREE from 'three';
import { WallPlacement } from '../src/wall-placement.js';

const verticalRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
function pose(position = [0, 1.6, 0], rotation = new THREE.Quaternion(), emulatedPosition = false) {
  return { emulatedPosition, transform: { matrix: new THREE.Matrix4().compose(
    new THREE.Vector3(...position), rotation, new THREE.Vector3(1, 1, 1),
  ).toArray() } };
}
function plane(name, position, { horizontal = false } = {}) {
  const value = { planeSpace: { name }, orientation: horizontal ? 'horizontal' : 'vertical', lastChangedTime: 1,
    polygon: [{ x: -2, y: 0, z: -2 }, { x: 2, y: 0, z: -2 }, { x: 2, y: 0, z: 2 }, { x: -2, y: 0, z: 2 }] };
  return { value, pose: pose(position, horizontal ? new THREE.Quaternion() : verticalRotation) };
}
function frame({ planes = [], hits = [], viewer = pose() } = {}) {
  const positions = new Map(planes.map(item => [item.value.planeSpace, item.pose]));
  return {
    positions, detectedPlanes: new Set(planes.map(item => item.value)),
    getViewerPose: () => viewer,
    getPose: space => positions.get(space) ?? null,
    getHitTestResults: () => hits.map(value => ({ getPose: () => value })),
  };
}
function fixture({ mode = 'auto', width = 2.4, distance = 2, inputMode = 'controller', session: extra = {} } = {}) {
  const scene = new THREE.Scene();
  const session = { visibilityState: 'visible', enabledFeatures: [], ...extra };
  const placement = new WallPlacement(scene);
  const referenceSpace = { type: 'local' };
  placement.start(session, referenceSpace, { mode, width, distance, inputMode });
  return { placement, session, scene, referenceSpace };
}
const close = (actual, expected, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${actual} ≈ ${expected}`);
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('native plane detection rejects floors and places the nearest vertical wall facing the viewer', () => {
  const { placement } = fixture();
  const xrFrame = frame({ planes: [plane('far wall', [0, 1.6, -4]), plane('floor', [0, 0, 0], { horizontal: true }), plane('near wall', [0, 1.6, -2])] });
  placement.update(xrFrame, 1000);
  assert.equal(placement.diagnostics().planes, 3);
  assert.equal(placement.diagnostics().verticalPlanes, 2);
  assert.equal(placement.candidate.source, 'plane-detection');
  close(placement.candidate.point.z, -2);
  assert.ok(placement.candidate.normal.z > 0.99);
  assert.equal(placement.preview.visible, true);
  const result = placement.confirm(xrFrame, null, 1010);
  assert.equal(result.source, 'plane-detection');
  close(result.position.y, 1.6 - 1.25);
  close(result.width, 2.4);
  assert.equal(placement.preview.visible, false);
  assert.ok([...placement.planeViews.values()].every(view => !view.line.visible));
});

test('plane transforms refresh without polygon changes and disappeared planes cannot remain candidates', () => {
  const { placement } = fixture();
  const wall = plane('moving reference pose', [0, 1.6, -2]);
  const xrFrame = frame({ planes: [wall] });
  placement.update(xrFrame, 1000);
  const outline = placement.planeViews.get(wall.value).line;
  xrFrame.positions.set(wall.value.planeSpace, pose([0, 1.6, -3], verticalRotation));
  placement.update(xrFrame, 1010);
  close(placement.candidate.point.z, -3);
  close(outline.matrix.elements[14], -3);
  let disposed = false;
  outline.geometry.addEventListener('dispose', () => { disposed = true; });
  xrFrame.detectedPlanes.clear();
  placement.update(xrFrame, 1020);
  assert.equal(placement.candidate, null);
  assert.equal(placement.confirm(xrFrame, null, 1020), null);
  assert.equal(placement.planeViews.size, 0);
  assert.equal(disposed, true);
  assert.equal(outline.parent, null);
});

test('hit-test fallback accepts a tracked vertical surface and rejects floor, emulated, and distant hits', async () => {
  let requests = 0;
  const { placement, referenceSpace } = fixture({ session: {
    requestReferenceSpace: async type => { assert.equal(type, 'viewer'); return { type }; },
    requestHitTestSource: async options => { requests++; assert.deepEqual(options.entityTypes, ['plane']); return { cancel() {} }; },
  } });
  await setImmediate();
  const xrFrame = frame({ hits: [pose([0, 0, -1]), pose([0, 1.6, -1], verticalRotation, true), pose([0, 1.6, -12], verticalRotation), pose([0, 1.6, -2], verticalRotation)] });
  delete xrFrame.detectedPlanes;
  placement.update(xrFrame, 1000);
  assert.equal(requests, 1);
  assert.equal(placement.referenceSpace, referenceSpace);
  assert.equal(placement.diagnostics().planeAPI, 'unavailable');
  assert.equal(placement.diagnostics().hitTest, 'available');
  assert.equal(placement.candidate.source, 'hit-test');
  close(placement.candidate.point.z, -2);
  assert.ok(placement.candidate.normal.z > 0.99);
  assert.equal(placement.confirm(xrFrame, null, 1000).source, 'hit-test');
});

test('browsers without geometry APIs explain the unavailable data and never invent a wall', () => {
  const { placement } = fixture();
  const xrFrame = frame();
  delete xrFrame.detectedPlanes;
  placement.update(xrFrame, 1000);
  assert.equal(placement.diagnostics().planeAPI, 'unavailable');
  assert.equal(placement.diagnostics().hitTest, 'unavailable');
  assert.equal(placement.candidate, null);
  assert.match(placement.guidance().join(' '), /壁情報を取得できません/);
  assert.match(placement.guidance().join(' '), /3点指定/);
  assert.equal(placement.confirm(xrFrame, null, 1000), null);
  assert.equal(placement.placed, null);
  Object.defineProperty(xrFrame, 'detectedPlanes', { get() { throw Object.assign(new Error('Feature not granted'), { name: 'NotSupportedError' }); } });
  placement.update(xrFrame, 1010);
  assert.equal(placement.diagnostics().planeAPI, 'NotSupportedError');
  assert.equal(placement.candidate, null);
  assert.match(placement.guidance().join(' '), /壁情報を取得できません|3点指定/);
});

test('manual calibration requires three tracked controller positions and creates the requested wall opening', () => {
  const { placement } = fixture({ mode: 'manual' });
  const controllerSpace = { name: 'controller' };
  const controller = { targetRayMode: 'tracked-pointer', targetRaySpace: controllerSpace };
  const xrFrame = frame();
  placement.update(xrFrame, 1000);
  assert.equal(placement.confirm(xrFrame, { targetRayMode: 'gaze' }, 1000), null);
  assert.equal(placement.points.length, 0);
  for (const [index, point] of [[-1.2, 0, -2], [1.2, 0, -2], [-1.2, 2.5, -2]].entries()) {
    xrFrame.positions.set(controllerSpace, pose(point));
    placement.update(xrFrame, 1010 + index);
    const result = placement.confirm(xrFrame, controller, 1010 + index);
    if (index < 2) {
      assert.equal(result, null);
      assert.equal(placement.dots[index].visible, true);
      assert.match(placement.guidance()[0], new RegExp(`${index + 2}/3`));
      if (index === 0) {
        placement.update(frame({ viewer: null }), 1010);
        assert.equal(placement.dots[0].visible, false, 'old calibration dots hide during tracking loss');
        assert.equal(placement.confirm(xrFrame, controller, 1010), null);
        assert.equal(placement.points.length, 1);
        placement.update(xrFrame, 1010);
        assert.equal(placement.dots[0].visible, true, 'calibration dots recover with tracking');
      }
    } else {
      assert.equal(result.source, 'manual');
      close(result.width, 2.4);
      close(result.position.x, 0);
      close(result.position.y, 0);
      close(result.position.z, -2);
      assert.ok(new THREE.Vector3(0, 0, 1).applyQuaternion(result.quaternion).z > 0.99);
      assert.ok(placement.dots.every(dot => !dot.visible));
    }
  }
  assert.equal(placement.confirm(xrFrame, controller, 1020), placement.placed, 'confirming a placed manual wall is idempotent');
});

test('invalid manual points reset calibration instead of leaving a broken or inverted wall', () => {
  const { placement } = fixture({ mode: 'manual' });
  const controller = { targetRayMode: 'tracked-pointer', targetRaySpace: {} };
  const xrFrame = frame();
  for (const [index, point] of [[1.2, 0, -2], [-1.2, 0, -2], [1.2, 2.5, -2]].entries()) {
    xrFrame.positions.set(controller.targetRaySpace, pose(point));
    placement.update(xrFrame, 1000 + index);
    assert.equal(placement.confirm(xrFrame, controller, 1000 + index), null);
  }
  assert.equal(placement.placed, null);
  assert.equal(placement.points.length, 0);
  assert.ok(placement.dots.every(dot => !dot.visible));
  assert.ok(placement.message.length > 0);
});

test('tracking loss, hidden sessions, vanished walls, and stale frames cannot confirm an old candidate', () => {
  const { placement, session } = fixture();
  const good = frame({ planes: [plane('wall', [0, 1.6, -2])] });
  for (const unavailable of [frame({ viewer: null }), frame({ viewer: pose([0, 1.6, 0], new THREE.Quaternion(), true) }), frame()]) {
    placement.update(good, 1000);
    assert.ok(placement.candidate);
    placement.update(unavailable, 1010);
    assert.equal(placement.candidate, null);
    assert.equal(placement.preview.visible, false);
    assert.equal(placement.confirm(unavailable, null, 1010), null);
  }
  placement.update(good, 1100);
  assert.equal(placement.confirm(good, null, 1351), null, 'candidate older than 250 ms is rejected');
  session.visibilityState = 'visible-blurred';
  placement.update(good, 1400);
  assert.equal(placement.candidate, null);
  assert.equal(placement.diagnostics().tracking, false);
  assert.equal(placement.confirm(good, null, 1400), null);
  session.visibilityState = 'visible';
  placement.update(good, 1500);
  assert.ok(placement.confirm(good, null, 1500), 'tracking can recover and create a fresh placement');
});

test('hit-test setup settling after session end cancels its source without resurrecting the session', async () => {
  const pendingSource = deferred();
  let canceled = 0;
  const { placement } = fixture({ session: {
    requestReferenceSpace: async () => ({}),
    requestHitTestSource: () => pendingSource.promise,
  } });
  await setImmediate();
  placement.end();
  pendingSource.resolve({ cancel() { canceled++; } });
  await setImmediate();
  assert.equal(canceled, 1);
  assert.equal(placement.session, null);
  assert.equal(placement.hitSource, null);
  assert.equal(placement.visuals.visible, false);
  assert.equal(placement.diagnostics().state, 'ended');

  const pendingSpace = deferred();
  let sourceRequests = 0;
  placement.start({ visibilityState: 'visible', requestReferenceSpace: () => pendingSpace.promise,
    requestHitTestSource: async () => { sourceRequests++; return { cancel() {} }; } }, {});
  placement.end();
  pendingSpace.resolve({});
  await setImmediate();
  assert.equal(sourceRequests, 0, 'a late viewer-space result must not start another request');

  placement.start({ visibilityState: 'visible', requestReferenceSpace: async () => ({}),
    requestHitTestSource: async () => ({ cancel() { throw new Error('XR source already ended'); } }) }, {});
  await setImmediate();
  assert.doesNotThrow(() => placement.end(), 'cleanup remains safe when the browser already invalidated the source');
  assert.equal(placement.session, null);
  assert.equal(placement.hitSource, null);
  assert.equal(placement.visuals.visible, false);
});

test('room-capture failures provide manual guidance and are requested only once per session', async () => {
  let calls = 0;
  const { placement } = fixture({ session: { initiateRoomCapture: async () => {
    calls++; throw Object.assign(new Error('Room capture is unavailable'), { name: 'NotSupportedError' });
  } } });
  const xrFrame = frame();
  placement.update(xrFrame, 1000);
  assert.equal(placement.confirm(xrFrame, null, 1000), null);
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(placement.diagnostics().roomCapture, 'NotSupportedError');
  assert.match(placement.guidance().join(' '), /部屋スキャンを利用できません/);
  assert.match(placement.guidance().join(' '), /3点指定/);
  placement.confirm(xrFrame, null, 1010);
  await setImmediate();
  assert.equal(calls, 1);
  assert.equal(placement.placed, null);

  const pending = deferred();
  const late = fixture({ session: { initiateRoomCapture: () => pending.promise } }).placement;
  late.update(xrFrame, 1000);
  late.confirm(xrFrame, null, 1000);
  late.end();
  pending.resolve();
  await setImmediate();
  assert.equal(late.diagnostics().state, 'ended');
  assert.equal(late.diagnostics().roomCapture, 'requested', 'late capture completion does not mutate the ended session');
});

test('distance fallback is explicitly undetected placement, and grip reset clears it for manual calibration', () => {
  const { placement } = fixture({ mode: 'distance', width: 3, distance: 4 });
  const xrFrame = frame();
  placement.update(xrFrame, 1000);
  assert.equal(placement.candidate.source, 'distance');
  assert.match(placement.guidance()[0], /壁検出なし/);
  const result = placement.confirm(xrFrame, null, 1000);
  close(result.position.z, -4);
  close(result.width, 3);
  assert.equal(result.source, 'distance');
  placement.reset({ switchToManual: true });
  assert.equal(placement.placed, null);
  assert.equal(placement.candidate, null);
  assert.equal(placement.preview.visible, false);
  assert.equal(placement.diagnostics().mode, 'manual');
  assert.equal(placement.points.length, 0);
  assert.equal(placement.diagnostics().tracking, false);
  assert.equal(placement.confirm(xrFrame, null, 1000), null, 'reset requires a fresh tracked frame');
  placement.update(xrFrame, 1010);
  assert.match(placement.guidance()[0], /1\/3.*左下/);
  placement.end();
  assert.equal(placement.confirm(xrFrame, null, 1010), null);
});

test('touch confirmation uses the screen-center wall candidate without a controller pose', () => {
  const { placement } = fixture({ inputMode: 'touch' });
  const xrFrame = frame({ planes: [plane('centered wall', [0, 1.6, -2])] });
  placement.update(xrFrame, 1000);
  assert.match(placement.guidance().join(' '), /画面中央.*配置ボタン/);
  assert.doesNotMatch(placement.guidance().join(' '), /トリガー|グリップ|3点指定/);
  // A DOM overlay action does not have a controller targetRaySpace. The cached
  // fresh center candidate is sufficient; no tap coordinate is used as a pose.
  xrFrame.getPose = () => { throw new Error('No controller pose is available on a phone'); };
  const result = placement.confirm(xrFrame, null, 1010);
  assert.equal(result.source, 'plane-detection');
  close(result.position.x, 0); close(result.position.z, -2);
  assert.equal(placement.diagnostics().inputMode, 'touch');
  assert.equal(placement.diagnostics().mode, 'auto');
  assert.match(placement.guidance().join(' '), /再生ボタン.*再配置ボタン/);
  assert.doesNotMatch(placement.guidance().join(' '), /トリガー|グリップ/);
});

test('touch manual requests fall back to explicit distance placement on start and reset', () => {
  const { placement } = fixture({ inputMode: 'touch', mode: 'manual', width: 1.2, distance: 3 });
  assert.equal(placement.mode, 'distance');
  assert.equal(placement.diagnostics().mode, 'distance');
  assert.equal(placement.diagnostics().inputMode, 'touch');
  assert.equal(placement.diagnostics().hitTest, 'disabled');
  const xrFrame = frame();
  placement.update(xrFrame, 1000);
  assert.match(placement.guidance()[0], /壁検出なし/);
  const result = placement.confirm(xrFrame, null, 1000);
  assert.equal(result.source, 'distance'); close(result.position.z, -3); close(result.width, 1.2);
  placement.reset({ mode: 'manual' });
  assert.equal(placement.mode, 'distance'); assert.equal(placement.placed, null);
  assert.equal(placement.diagnostics().placementSource, undefined);
  placement.reset({ switchToManual: true });
  assert.equal(placement.mode, 'distance'); assert.equal(placement.points.length, 0);
  placement.reset({ mode: 'auto' });
  assert.equal(placement.mode, 'auto');
  placement.reset({ mode: 'distance' });
  assert.equal(placement.mode, 'distance');
  const downward = frame({ viewer: pose([0, 1.6, 0], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)) });
  placement.update(downward, 1010);
  assert.equal(placement.candidate, null);
  assert.match(placement.guidance().join(' '), /スマホを正面/);
  assert.doesNotMatch(placement.guidance().join(' '), /壁情報を取得できません|コントローラー/);
});

test('touch unavailable geometry and room capture failures explain distance controls', async () => {
  const { placement } = fixture({ inputMode: 'touch' });
  const xrFrame = frame(); delete xrFrame.detectedPlanes;
  placement.update(xrFrame, 1000);
  assert.equal(placement.candidate, null);
  assert.match(placement.guidance().join(' '), /距離指定/);
  assert.doesNotMatch(placement.guidance().join(' '), /グリップ|3点指定/);
  placement.confirm(xrFrame, null, 1000);
  assert.match(placement.guidance().join(' '), /距離指定/);

  const failing = fixture({ inputMode: 'touch', session: { initiateRoomCapture: async () => {
    throw Object.assign(new Error('unavailable'), { name: 'NotSupportedError' });
  } } }).placement;
  failing.update(frame(), 1000);
  assert.match(failing.guidance().join(' '), /画面中央.*配置ボタン/);
  failing.confirm(frame(), null, 1000);
  await setImmediate();
  assert.match(failing.guidance().join(' '), /部屋スキャンを利用できません.*距離指定/);
  assert.doesNotMatch(failing.guidance().join(' '), /トリガー|グリップ|3点指定/);
});

test('switching between auto and distance disposes obsolete asynchronous hit sources', async () => {
  const first = deferred(), second = deferred();
  let requests = 0, oldCanceled = 0, currentCanceled = 0;
  const viewerSpace = { type: 'viewer' };
  const { placement } = fixture({ inputMode: 'touch', session: {
    requestReferenceSpace: async type => { assert.equal(type, 'viewer'); return viewerSpace; },
    requestHitTestSource: options => {
      assert.deepEqual(options, { space: viewerSpace, entityTypes: ['plane'] }, 'hit-test remains centered on the viewer, without a screen tap ray');
      return ++requests === 1 ? first.promise : second.promise;
    },
  } });
  await setImmediate();
  placement.reset({ mode: 'distance' });
  assert.equal(placement.diagnostics().hitTest, 'disabled');
  placement.reset({ mode: 'auto' });
  await setImmediate();
  const current = { cancel() { currentCanceled++; } };
  second.resolve(current); await setImmediate();
  assert.equal(placement.hitSource, current);
  first.resolve({ cancel() { oldCanceled++; } }); await setImmediate();
  assert.equal(oldCanceled, 1); assert.equal(currentCanceled, 0);
  assert.equal(placement.hitSource, current, 'late result from the old mode cannot replace the active source');
  assert.equal(placement.diagnostics().hitTest, 'available');
  placement.reset({ mode: 'distance' });
  assert.equal(currentCanceled, 1); assert.equal(placement.hitSource, null);
  placement.end();
  assert.equal(currentCanceled, 1, 'canceled sources are not retained for another cancel');
});

test('a viewer-space request finishing after a touch mode change does not request a source', async () => {
  const pendingSpace = deferred(); let sourceRequests = 0;
  const { placement } = fixture({ inputMode: 'touch', session: {
    requestReferenceSpace: () => pendingSpace.promise,
    requestHitTestSource: async () => { sourceRequests++; return { cancel() {} }; },
  } });
  placement.reset({ mode: 'distance' });
  pendingSpace.resolve({}); await setImmediate();
  assert.equal(sourceRequests, 0); assert.equal(placement.hitSource, null);
  assert.equal(placement.diagnostics().hitTest, 'disabled');
});
