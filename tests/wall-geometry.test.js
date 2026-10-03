import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { intersectWallPlane, buildWallCalibration } from '../src/wall-geometry.js';

const point = (x, y, z) => ({ x, y, z });
const square = [point(-1, 0, -1), point(1, 0, -1), point(1, 0, 1), point(-1, 0, 1)];
const ray = (x = 0, y = 1.4, z = 0, dx = 0, dy = 0, dz = -2) => ({ origin: point(x, y, z), direction: point(dx, dy, dz) });
function wall(tilt = 0) {
  return {
    matrix: new THREE.Matrix4().compose(new THREE.Vector3(0, 1.4, -3), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2 + THREE.MathUtils.degToRad(tilt)), new THREE.Vector3(1, 1, 1)),
    polygon: square, orientation: 'vertical',
  };
}
function near(actual, expected, tolerance = 1e-6) { assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`); }
function nearVector(actual, expected) { actual.toArray().forEach((value, i) => near(value, expected[i])); }

test('wall intersection accepts non-unit world rays and faces the normal toward the viewer', () => {
  const target = wall(), input = ray();
  const before = JSON.stringify([input, target]);
  const front = intersectWallPlane(input, target);
  nearVector(front.point, [0, 1.4, -3]); nearVector(front.normal, [0, 0, 1]); near(front.distance, 3);
  const back = intersectWallPlane(ray(0, 1.4, -6, 0, 0, 4), target);
  nearVector(back.normal, [0, 0, -1]); near(back.distance, 3);
  assert.equal(JSON.stringify([input, target]), before, 'inputs remain untouched');
});

test('outside, parallel and backwards rays miss while polygon edges and corners hit', () => {
  assert.equal(intersectWallPlane(ray(1.01), wall()), null);
  assert.equal(intersectWallPlane(ray(0, 1.4, 0, 1, 0, 0), wall()), null);
  assert.equal(intersectWallPlane(ray(0, 1.4, 0, 0, 0, 1), wall()), null);
  assert.ok(intersectWallPlane(ray(1), wall()));
  assert.ok(intersectWallPlane(ray(1, 2.4), wall()));
  assert.equal(intersectWallPlane(ray(1.001, 2.401), wall()), null);
});

test('vertical classification rejects floors and walls tilted over twenty degrees', () => {
  const floor = { matrix: new THREE.Matrix4(), polygon: square };
  assert.equal(intersectWallPlane(ray(0, 1, 0, 0, -1, 0), floor), null);
  assert.equal(intersectWallPlane(ray(), { ...wall(), orientation: 'horizontal' }), null);
  assert.ok(intersectWallPlane(ray(), wall(20)));
  assert.ok(intersectWallPlane(ray(), wall(-20)));
  assert.equal(intersectWallPlane(ray(), wall(20.1)), null);
  assert.equal(intersectWallPlane(ray(), wall(-20.1)), null);
});

test('concave polygon hit testing respects the notch and polygon winding', () => {
  const target = wall();
  target.polygon = [point(0, 0, 0), point(2, 0, 0), point(2, 0, 1), point(1, 0, 1), point(1, 0, 2), point(0, 0, 2)];
  assert.ok(intersectWallPlane(ray(.5, -.1), target));
  assert.equal(intersectWallPlane(ray(1.5, -.1), target), null);
  assert.ok(intersectWallPlane(ray(1.5, .9), target));
  target.polygon = [...target.polygon].reverse();
  assert.ok(intersectWallPlane(ray(.5, -.1), target));
  assert.equal(intersectWallPlane(ray(1.5, -.1), target), null);
});

test('invalid and degenerate plane/ray geometry fails without exceptions', () => {
  assert.equal(intersectWallPlane(ray(0, 1.4, 0, 0, 0, 0), wall()), null);
  assert.equal(intersectWallPlane(ray(Infinity), wall()), null);
  assert.equal(intersectWallPlane(ray(), { ...wall(), matrix: new THREE.Matrix4().makeScale(0, 0, 0) }), null);
  assert.equal(intersectWallPlane(ray(), { ...wall(), polygon: [point(0, 0, 0), point(1, 0, 0), point(2, 0, 0)] }), null);
  assert.equal(intersectWallPlane(ray(), { ...wall(), polygon: [point(0, 1, 0), point(1, 1, 0), point(1, 1, 1)] }), null);
  assert.equal(intersectWallPlane(null, null), null);
});

test('three-point wall calibration places the lower midpoint with audience-facing local +Z', () => {
  const points = [point(-1.2, .2, -3), point(1.2, .2, -3), point(-1.2, 2.7, -3)];
  const before = structuredClone(points);
  const result = buildWallCalibration(points);
  nearVector(result.position, [0, .2, -3]); near(result.width, 2.4); near(result.height, 2.5);
  nearVector(new THREE.Vector3(1, 0, 0).applyQuaternion(result.quaternion), [1, 0, 0]);
  nearVector(new THREE.Vector3(0, 1, 0).applyQuaternion(result.quaternion), [0, 1, 0]);
  nearVector(new THREE.Vector3(0, 0, 1).applyQuaternion(result.quaternion), [0, 0, 1]);
  assert.deepEqual(points, before);
});

test('calibration works at another wall heading and orthogonalizes modest hand-placement skew', () => {
  const result = buildWallCalibration([point(-2, .5, -1), point(-2, .5, 1), point(-2, 2.5, -.9)]);
  nearVector(result.position, [-2, .5, 0]); near(result.width, 2); near(result.height, 2);
  nearVector(new THREE.Vector3(0, 0, 1).applyQuaternion(result.quaternion), [-1, 0, 0]);
  nearVector(new THREE.Vector3(0, 1, 0).applyQuaternion(result.quaternion), [0, 1, 0]);
  near(result.quaternion.length(), 1);
});

test('calibration rejects repeated points, bad dimensions, floors, reversed up and excessive tilt', () => {
  const base = point(0, 0, 0);
  const rejects = points => assert.throws(() => buildWallCalibration(points), /壁の配置/);
  rejects([base, base, point(0, 1, 0)]);
  rejects([base, point(2, 0, 0), base]);
  rejects([base, point(.39, 0, 0), point(0, 1, 0)]);
  rejects([base, point(6.01, 0, 0), point(0, 1, 0)]);
  rejects([base, point(2, 0, 0), point(0, .39, 0)]);
  rejects([base, point(2, 0, 0), point(0, 4.01, 0)]);
  rejects([base, point(2, 0, 0), point(0, 0, 2)]);
  rejects([base, point(2, 0, 0), point(0, -1, 0)]);
  rejects([base, point(2, 1, 0), point(0, 2, 0)]);
  rejects([base, point(2, 0, 0), point(1, 2, 0)]);
  rejects([base, point(2, 0, 0), point(0, 2, 1)]);
  rejects([base, point(NaN, 0, 0), point(0, 2, 0)]);
  rejects([base, point(2, 0, 0)]);
  assert.doesNotThrow(() => buildWallCalibration([base, point(.4, 0, 0), point(0, .4, 0)]));
  assert.doesNotThrow(() => buildWallCalibration([base, point(6, 0, 0), point(0, 4, 0)]));
});
