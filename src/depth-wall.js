import { Matrix4, Vector3, Vector4 } from 'three';
import { WALL_TILT_LIMIT_DEGREES } from './wall-geometry.js';

const UP = new Vector3(0, 1, 0);
const VERTICAL_LIMIT = Math.sin(WALL_TILT_LIMIT_DEGREES * Math.PI / 180);
const EPSILON = 1e-7;
const finiteMatrix = value => value?.length === 16 && Array.from(value).every(Number.isFinite);

function readMatrix(value) {
  if (!finiteMatrix(value)) return null;
  const matrix = new Matrix4().fromArray(value);
  return Math.abs(matrix.determinant()) > EPSILON ? matrix : null;
}

function planeFromThree(a, b, c) {
  const normal = b.clone().sub(a).cross(c.clone().sub(a));
  if (normal.lengthSq() < 1e-8) return null;
  normal.normalize();
  return { normal, constant: -normal.dot(a) };
}

// Least-squares plane: the smallest eigenvector of the symmetric covariance
// matrix. Jacobi rotations keep this bounded and independent of camera axes.
function fitPlane(points) {
  const center = points.reduce((sum, point) => sum.add(point), new Vector3()).divideScalar(points.length);
  const covariance = Array(9).fill(0);
  for (const point of points) {
    const delta = point.clone().sub(center).toArray();
    for (let row = 0; row < 3; row++) for (let column = 0; column < 3; column++) {
      covariance[row * 3 + column] += delta[row] * delta[column] / points.length;
    }
  }
  const vectors = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let iteration = 0; iteration < 20; iteration++) {
    let p = 0, q = 1;
    for (const [row, column] of [[0, 2], [1, 2]]) {
      if (Math.abs(covariance[row * 3 + column]) > Math.abs(covariance[p * 3 + q])) {p = row; q = column;}
    }
    const off = covariance[p * 3 + q];
    if (Math.abs(off) < 1e-12) break;
    const angle = .5 * Math.atan2(2 * off, covariance[q * 3 + q] - covariance[p * 3 + p]);
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const pp = covariance[p * 3 + p], qq = covariance[q * 3 + q];
    covariance[p * 3 + p] = cosine * cosine * pp - 2 * sine * cosine * off + sine * sine * qq;
    covariance[q * 3 + q] = sine * sine * pp + 2 * sine * cosine * off + cosine * cosine * qq;
    covariance[p * 3 + q] = covariance[q * 3 + p] = 0;
    for (let row = 0; row < 3; row++) {
      if (row !== p && row !== q) {
        const rp = covariance[row * 3 + p], rq = covariance[row * 3 + q];
        covariance[row * 3 + p] = covariance[p * 3 + row] = cosine * rp - sine * rq;
        covariance[row * 3 + q] = covariance[q * 3 + row] = sine * rp + cosine * rq;
      }
      const vp = vectors[row * 3 + p], vq = vectors[row * 3 + q];
      vectors[row * 3 + p] = cosine * vp - sine * vq;
      vectors[row * 3 + q] = sine * vp + cosine * vq;
    }
  }
  const axes = [0, 1, 2].sort((a, b) => covariance[a * 3 + a] - covariance[b * 3 + b]);
  if (covariance[axes[1] * 3 + axes[1]] < 1e-4) return null;
  const axis = axes[0];
  const normal = new Vector3(vectors[axis], vectors[3 + axis], vectors[6 + axis]).normalize();
  return { normal, constant: -normal.dot(center) };
}

const residual = (plane, point) => Math.abs(plane.normal.dot(point) + plane.constant);

function connectedSupport(samples, mask, center, gridSize) {
  if (!mask.has(center)) return [];
  const visited = new Set([center]);
  const queue = [center];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const index = queue[cursor];
    const row = Math.floor(index / gridSize), column = index % gridSize;
    for (const [dr, dc] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const nr = row + dr, nc = column + dc;
      if (nr < 0 || nr >= gridSize || nc < 0 || nc >= gridSize) continue;
      const neighbor = nr * gridSize + nc;
      if (!mask.has(neighbor) || visited.has(neighbor)) continue;
      // A gap in depth must not join separated foreground/background patches.
      // A slanted real plane can change depth smoothly; scale by angular step.
      const allowedGap = .15 + .15 * Math.min(samples[index].depth, samples[neighbor].depth);
      if (Math.abs(samples[index].depth - samples[neighbor].depth) > allowedGap) continue;
      visited.add(neighbor); queue.push(neighbor);
    }
  }
  return queue;
}

/**
 * Estimate one observed vertical plane from CPU WebXR depth, synchronously in
 * the current XR animation frame. No camera images, network, or XR buffer writes.
 *
 * getDepthInMeters accepts normalized VIEW UVs (top-left origin) and applies
 * normDepthBufferFromNormView internally. We inspect that transform only to
 * reject out-of-buffer / duplicate pixels; applying it again would be wrong.
 * Depth is camera-plane Z distance, NOT the length of a normalized view ray.
 * See https://immersive-web.github.io/depth-sensing/#interpreting-the-results
 * and https://immersive-web.github.io/depth-sensing/#dom-xrcpudepthinformation-getdepthinmeters
 *
 * The candidate describes a measured patch, not a semantic wall/room layout.
 * Caller must supply a gravity-aligned reference space and obtain this result
 * inside requestAnimationFrame. All failures return diagnostics without a pose.
 */
export function detectDepthWall(frame, referenceSpace, viewerPose, { gridSize = 11 } = {}) {
  const metrics = { samples: 0, validSamples: 0, inliers: 0, coverage: 0, inlierRatio: 0, rms: null, spanWidth: 0, spanHeight: 0 };
  const fail = (state, reason) => ({ state, reason, candidate: null, metrics });
  if (typeof frame?.getDepthInformation !== 'function') return fail('unavailable', 'cpu-depth-api');
  // This getter may throw when the optional feature was not granted, even
  // though XRFrame exposes getDepthInformation on its prototype.
  try {
    const usage = frame.session?.depthUsage;
    if (usage && usage !== 'cpu-optimized') return fail('unavailable', 'cpu-depth-not-enabled');
  } catch (error) {return fail('unavailable', error?.name || 'cpu-depth-not-enabled');}
  try {viewerPose ??= frame.getViewerPose(referenceSpace);} catch {return fail('tracking', 'viewer-pose');}
  if (!viewerPose || viewerPose.emulatedPosition) return fail('tracking', 'viewer-pose');
  const viewerMatrix = readMatrix(viewerPose.transform?.matrix);
  if (!viewerMatrix) return fail('tracking', 'viewer-transform');
  let depth, view;
  try {
    for (const candidateView of Array.from(viewerPose.views || []).slice(0, 2)) {
      const information = frame.getDepthInformation(candidateView);
      if (information) {depth = information; view = candidateView; break;}
    }
  } catch (error) {return fail('unavailable', error?.name || 'cpu-depth-unavailable');}
  if (!depth) return fail('tracking', 'depth-not-ready');
  if (typeof depth.getDepthInMeters !== 'function') return fail('unavailable', 'cpu-depth-api');
  // Newer depth implementations expose the sensor's own view geometry. Older
  // implementations return depth aligned with XRView and have neither member.
  const geometry = depth.projectionMatrix || depth.transform ? depth : view;
  const projection = readMatrix(geometry.projectionMatrix);
  const world = readMatrix(geometry.transform?.matrix);
  const bufferFromView = readMatrix(depth.normDepthBufferFromNormView?.matrix);
  if (!projection || !world || !bufferFromView || !Number.isInteger(depth.width) || depth.width < 2 || !Number.isInteger(depth.height) || depth.height < 2) {
    return fail('invalid-depth', 'depth-geometry');
  }
  const inverseProjection = projection.clone().invert();
  gridSize = Number.isFinite(gridSize) ? Math.max(5, Math.min(11, Math.floor(gridSize))) : 11;
  if (!(gridSize % 2)) gridSize--;
  const sampleCount = gridSize * gridSize;
  const margin = .18, step = (1 - 2 * margin) / (gridSize - 1);
  const samples = Array(sampleCount).fill(null), valid = [], pixels = new Set();
  for (let row = 0; row < gridSize; row++) for (let column = 0; column < gridSize; column++) {
    metrics.samples++;
    const u = margin + column * step, v = margin + row * step;
    const mapped = new Vector4(u, v, 0, 1).applyMatrix4(bufferFromView);
    if (!Number.isFinite(mapped.w) || Math.abs(mapped.w) < EPSILON) continue;
    const bx = mapped.x / mapped.w, by = mapped.y / mapped.w;
    // The native accessor clamps transformed coordinates; a clamped edge must
    // not masquerade as many independent surface observations.
    if (bx < 0 || bx >= 1 || by < 0 || by >= 1) continue;
    const pixel = Math.floor(by * depth.height) * depth.width + Math.floor(bx * depth.width);
    if (pixels.has(pixel)) continue;
    pixels.add(pixel);
    let meters;
    try {meters = depth.getDepthInMeters(u, v);} catch {continue;}
    if (!Number.isFinite(meters) || meters < .25 || meters > 8) continue;
    const point = new Vector3(2 * u - 1, 1 - 2 * v, 0).applyMatrix4(inverseProjection);
    if (!point.toArray().every(Number.isFinite) || point.z >= -EPSILON) continue;
    point.multiplyScalar(meters / -point.z).applyMatrix4(world);
    if (!point.toArray().every(Number.isFinite)) continue;
    const sample = { index: row * gridSize + column, point, depth: meters, u, v };
    samples[sample.index] = sample; valid.push(sample);
  }
  metrics.validSamples = valid.length;
  const required = Math.ceil(sampleCount * .5);
  if (valid.length < required) return fail('sparse', 'insufficient-depth');
  const sortedDepth = valid.map(sample => sample.depth).sort((a, b) => a - b);
  const tolerance = .02 + .005 * sortedDepth[Math.floor(sortedDepth.length / 2)];
  let best = null, bestInliers = [];
  let seed = 0x564c4901;
  const randomIndex = () => {
    seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
    return (seed >>> 0) % valid.length;
  };
  for (let iteration = 0; iteration < 96; iteration++) {
    const plane = planeFromThree(valid[randomIndex()].point, valid[randomIndex()].point, valid[randomIndex()].point);
    if (!plane) continue;
    const inliers = valid.filter(sample => residual(plane, sample.point) <= tolerance);
    if (inliers.length > bestInliers.length) {best = plane; bestInliers = inliers;}
  }
  metrics.inliers = bestInliers.length;
  metrics.inlierRatio = bestInliers.length / valid.length;
  metrics.coverage = bestInliers.length / sampleCount;
  if (!best || bestInliers.length < required || metrics.inlierRatio < .72) return fail('not-planar', 'plane-consensus');
  const refined = fitPlane(bestInliers.map(sample => sample.point));
  if (!refined) return fail('not-planar', 'degenerate-plane');
  if (Math.abs(refined.normal.dot(UP)) > VERTICAL_LIMIT) return fail('not-vertical', 'floor-ceiling-or-slope');
  const mask = new Set(valid.filter(sample => residual(refined, sample.point) <= tolerance).map(sample => sample.index));
  const center = Math.floor(gridSize / 2) * gridSize + Math.floor(gridSize / 2);
  const component = connectedSupport(samples, mask, center, gridSize);
  metrics.inliers = component.length; metrics.coverage = component.length / sampleCount;
  metrics.inlierRatio = component.length / valid.length;
  if (component.length < required || metrics.inlierRatio < .72) return fail('not-planar', 'disconnected-or-unobserved-center');
  const plane = fitPlane(component.map(index => samples[index].point));
  if (!plane) return fail('not-planar', 'degenerate-plane');
  if (Math.abs(plane.normal.dot(UP)) > VERTICAL_LIMIT) return fail('not-vertical', 'floor-ceiling-or-slope');
  metrics.rms = Math.sqrt(component.reduce((sum, index) => sum + residual(plane, samples[index].point) ** 2, 0) / component.length);
  if (metrics.rms > tolerance * .7) return fail('not-planar', 'plane-residual');
  const origin = new Vector3().setFromMatrixPosition(viewerMatrix);
  const direction = new Vector3(0, 0, -1).transformDirection(viewerMatrix);
  const denominator = plane.normal.dot(direction);
  if (Math.abs(denominator) < .15) return fail('not-planar', 'grazing-view');
  const distance = -(plane.normal.dot(origin) + plane.constant) / denominator;
  if (!Number.isFinite(distance) || distance < .25 || distance > 8) return fail('not-planar', 'wall-range');
  const point = origin.clone().addScaledVector(direction, distance);
  const projected = point.clone().applyMatrix4(world.clone().invert()).applyMatrix4(projection);
  const u = (projected.x + 1) * .5, v = (1 - projected.y) * .5;
  const support = component.map(index => samples[index]).filter(sample => Math.abs(sample.u - u) < step * 1.6 && Math.abs(sample.v - v) < step * 1.6);
  if (support.length < 5 || !support.some(sample => sample.u < u) || !support.some(sample => sample.u > u) || !support.some(sample => sample.v < v) || !support.some(sample => sample.v > v)) {
    return fail('not-planar', 'unobserved-aim');
  }
  if (plane.normal.dot(direction) > 0) plane.normal.negate();
  const right = new Vector3().crossVectors(UP, plane.normal).normalize();
  const up = new Vector3().crossVectors(plane.normal, right).normalize();
  const across = component.map(index => samples[index].point.dot(right));
  const rising = component.map(index => samples[index].point.dot(up));
  metrics.spanWidth = Math.max(...across) - Math.min(...across);
  metrics.spanHeight = Math.max(...rising) - Math.min(...rising);
  if (metrics.spanWidth < .25 || metrics.spanHeight < .25) return fail('sparse', 'insufficient-surface-area');
  return { state: 'detected', reason: 'observed-vertical-depth', candidate: { point, normal: plane.normal, distance, source: 'depth-sensing' }, metrics };
}
