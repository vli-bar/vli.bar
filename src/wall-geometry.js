import * as THREE from 'three';

export const WALL_TILT_LIMIT_DEGREES = 20;
const TILT_SINE = Math.sin(THREE.MathUtils.degToRad(WALL_TILT_LIMIT_DEGREES));
const TILT_COSINE = Math.cos(THREE.MathUtils.degToRad(WALL_TILT_LIMIT_DEGREES));
const EPSILON = 1e-7;
const BOUNDARY_EPSILON = 1e-5;
const UP = new THREE.Vector3(0, 1, 0);

function validPoint(point) {
  return point && [point.x, point.y, point.z].every(Number.isFinite);
}

function copyPoint(point) {
  return new THREE.Vector3(point.x, point.y, point.z);
}

/** Point-in-polygon on WebXR's local XZ plane, including boundary hits. */
function insidePolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    const dx = b.x - a.x, dz = b.z - a.z;
    const lengthSquared = dx * dx + dz * dz;
    if (lengthSquared > EPSILON * EPSILON) {
      const along = THREE.MathUtils.clamp(((point.x - a.x) * dx + (point.z - a.z) * dz) / lengthSquared, 0, 1);
      const offsetX = point.x - a.x - along * dx;
      const offsetZ = point.z - a.z - along * dz;
      if (offsetX * offsetX + offsetZ * offsetZ <= BOUNDARY_EPSILON * BOUNDARY_EPSILON) return true;
    }
    if ((a.z > point.z) !== (b.z > point.z) && point.x < (b.x - a.x) * (point.z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Intersect a world-space ray with a tracked WebXR wall polygon. A WebXR plane
 * occupies local XZ, with local +Y as its normal. matrix maps plane to world.
 * Floor/ceiling planes and surfaces tilted >20° from vertical are rejected.
 * The returned unit normal faces the ray origin. Inputs are never mutated.
 */
export function intersectWallPlane(ray, plane) {
  if (!validPoint(ray?.origin) || !validPoint(ray?.direction)) return null;
  if (!plane?.matrix?.isMatrix4 || !plane.matrix.elements.every(Number.isFinite)) return null;
  if (plane.orientation === 'horizontal') return null;
  const polygon = plane.polygon;
  if (!Array.isArray(polygon) || polygon.length < 3 || !polygon.every(point => validPoint(point) && Math.abs(point.y) <= .001)) return null;
  let twiceArea = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    twiceArea += a.x * b.z - b.x * a.z;
  }
  if (Math.abs(twiceArea) < EPSILON) return null;
  if (Math.abs(plane.matrix.determinant()) < EPSILON) return null;
  const direction = copyPoint(ray.direction);
  if (direction.lengthSq() < EPSILON * EPSILON) return null;
  direction.normalize();
  const normal = UP.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(plane.matrix)).normalize();
  if (Math.abs(normal.dot(UP)) > TILT_SINE + EPSILON) return null;
  const inverse = plane.matrix.clone().invert();
  const localOrigin = copyPoint(ray.origin).applyMatrix4(inverse);
  // Do not normalize: this keeps the ray parameter in world-space metres.
  const localDirection = direction.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(inverse));
  if (Math.abs(localDirection.y) < EPSILON) return null;
  const parameter = -localOrigin.y / localDirection.y;
  if (parameter < -EPSILON || !Number.isFinite(parameter)) return null;
  const localHit = localOrigin.clone().addScaledVector(localDirection, Math.max(0, parameter));
  if (!insidePolygon(localHit, polygon)) return null;
  const point = localHit.applyMatrix4(plane.matrix);
  if (!validPoint(point)) return null;
  if (normal.dot(direction) > 0) normal.negate();
  return { point, normal, distance: point.distanceTo(copyPoint(ray.origin)) };
}

/**
 * Calibrate an opening from left-bottom, right-bottom and left-top world points.
 * Stage origin = bottom edge midpoint; +X points right, +Y up, +Z at the viewer
 * when the points are entered in that order while facing the wall. Width is
 * measured along the lower edge; height is the perpendicular upper-edge span.
 * Small input skew is orthogonalized; excessive slope/skew is rejected.
 */
export function buildWallCalibration(points) {
  const fail = message => { throw new Error(`壁の配置: ${message}`); };
  if (!Array.isArray(points) || points.length !== 3 || !points.every(validPoint)) fail('左下・右下・左上の3点を有効な座標で指定してください。');
  const [leftBottom, rightBottom, leftTop] = points.map(copyPoint);
  const across = rightBottom.clone().sub(leftBottom);
  const rising = leftTop.clone().sub(leftBottom);
  const width = across.length();
  if (width < .4 - EPSILON || width > 6 + EPSILON) fail('幅が0.4〜6mになるよう左下・右下を指定してください。');
  if (rising.lengthSq() < EPSILON * EPSILON) fail('左上は左下から離れた位置を指定してください。');
  const xAxis = across.divideScalar(width);
  const roughUp = rising.clone().normalize();
  if (Math.abs(xAxis.dot(UP)) > TILT_SINE + EPSILON) fail('下辺が傾きすぎています。ほぼ同じ高さの2点を指定してください。');
  if (roughUp.dot(UP) < TILT_COSINE - EPSILON) fail('左上は左下のほぼ真上を指定してください。');
  if (Math.abs(xAxis.dot(roughUp)) > TILT_SINE + EPSILON) fail('左上が横にずれすぎています。壁の左側で指定してください。');
  const yAxis = rising.addScaledVector(xAxis, -rising.dot(xAxis));
  const height = yAxis.length();
  if (height < .4 - EPSILON || height > 4 + EPSILON) fail('高さが0.4〜4mになるよう左上を指定してください。');
  yAxis.divideScalar(height);
  const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
  if (Math.abs(zAxis.dot(UP)) > TILT_SINE + EPSILON || yAxis.dot(UP) < TILT_COSINE - EPSILON) fail('垂直な壁に沿って3点を指定してください。床や天井には配置できません。');
  const quaternion = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis)).normalize();
  return {
    position: leftBottom.add(rightBottom).multiplyScalar(.5), quaternion,
    width: THREE.MathUtils.clamp(width, .4, 6), height: THREE.MathUtils.clamp(height, .4, 4),
  };
}
