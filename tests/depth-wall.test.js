import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3, Vector4 } from 'three';
import { detectDepthWall } from '../src/depth-wall.js';

const identity = () => new Matrix4();
const makeTransform = (position = [0, 1.6, 0], rotation = [0, 0, 0]) => new Matrix4().compose(
  new Vector3(...position), new Quaternion().setFromEuler(new Euler(...rotation)), new Vector3(1, 1, 1),
);

// A CPU depth fixture implements the specification's own view→buffer mapping,
// integer pixel lookup and camera-plane Z measurement. The tested detector
// receives only the API, never our surface equation or depth buffer.
function fixture({ transform = makeTransform(), sensorTransform, projection, bufferTransform = identity(), surface, mutate, width = 640, height = 480 } = {}) {
  const view = { transform: { matrix: transform.toArray() }, projectionMatrix: (projection || new PerspectiveCamera(65, 1.25, .1, 20).projectionMatrix).toArray() };
  const geometryWorld = sensorTransform || transform;
  const inverseProjection = new Matrix4().fromArray(view.projectionMatrix).invert();
  const inverseBuffer = bufferTransform.clone().invert();
  const normal = new Vector3(0, 0, 1), wallPoint = new Vector3(0, 1.6, -2);
  const measurements = [];
  const depth = {
    width, height,
    normDepthBufferFromNormView: { matrix: bufferTransform.toArray() },
    get data() {throw new Error('Depth buffer must not be read or mutated');},
    getDepthInMeters(u, v) {
      assert.ok(u >= 0 && u <= 1 && v >= 0 && v <= 1);
      measurements.push([u, v]);
      const mapped = new Vector4(u, v, 0, 1).applyMatrix4(bufferTransform);
      const column = Math.max(0, Math.min(width - 1, Math.trunc(mapped.x / mapped.w * width)));
      const row = Math.max(0, Math.min(height - 1, Math.trunc(mapped.y / mapped.w * height)));
      const uv = new Vector4((column + .5) / width, (row + .5) / height, 0, 1).applyMatrix4(inverseBuffer);
      const sensorU = uv.x / uv.w, sensorV = uv.y / uv.w;
      const localRay = new Vector3(sensorU * 2 - 1, 1 - sensorV * 2, 0).applyMatrix4(inverseProjection).normalize();
      const ray = localRay.clone().transformDirection(geometryWorld);
      const origin = new Vector3().setFromMatrixPosition(geometryWorld);
      const planeDepth = (n = normal, point = wallPoint) => {
        const distance = n.dot(point.clone().sub(origin)) / n.dot(ray);
        return distance > 0 ? distance * -localRay.z : 0;
      };
      let meters = surface ? surface({ u: sensorU, v: sensorV, planeDepth, ray, origin, localRay }) : planeDepth();
      if (mutate) meters = mutate(meters, { u, v, sample: measurements.length - 1 });
      return meters;
    },
  };
  if (sensorTransform) {depth.transform = { matrix: sensorTransform.toArray() }; depth.projectionMatrix = view.projectionMatrix;}
  const pose = { transform: view.transform, views: [view], emulatedPosition: false };
  const frame = { session: { depthUsage: 'cpu-optimized' }, getDepthInformation: candidate => {assert.equal(candidate, view); return depth;}, getViewerPose: () => pose };
  return { frame, pose, depth, view, measurements, detect: options => detectDepthWall(frame, {}, pose, options) };
}

function assertWall(result, distance = 2, tolerance = .015) {
  assert.equal(result.state, 'detected', JSON.stringify(result));
  assert.equal(result.candidate.source, 'depth-sensing');
  assert.ok(Math.abs(result.candidate.distance - distance) < tolerance, result.candidate.distance);
  assert.ok(Math.abs(result.candidate.normal.length() - 1) < 1e-7);
  assert.ok(result.metrics.inlierRatio >= .72);
  assert.ok(result.metrics.rms < .03);
  assert.ok(result.metrics.samples <= 121);
}

test('CPU depth reconstructs a front wall from camera-plane depth, without reading native buffers', () => {
  const setup = fixture();
  const result = setup.detect();
  assertWall(result);
  assert.ok(result.candidate.point.distanceTo(new Vector3(0, 1.6, -2)) < .005);
  assert.ok(result.candidate.normal.dot(new Vector3(0, 0, 1)) > .999);
  assert.equal(setup.measurements.length, 121);
  assert.equal(result.metrics.validSamples, 121);
});

test('tilted, yawed and rolled camera reconstructs a world-vertical wall', () => {
  const transform = makeTransform([.3, 1.4, .2], [-.1, .28, .21]);
  const setup = fixture({ transform });
  const result = setup.detect();
  const direction = new Vector3(0, 0, -1).transformDirection(transform);
  assertWall(result, 2.2 / -direction.z);
  assert.ok(result.candidate.normal.dot(new Vector3(0, 0, 1)) > .999);
  assert.ok(Math.abs(result.candidate.point.z + 2) < .015);
});

test('off-axis projection uses its actual inverse rather than an assumed FOV', () => {
  const projection = new PerspectiveCamera(70, .68, .08, 15).projectionMatrix;
  projection.elements[8] = .12;
  projection.elements[9] = -.08;
  assertWall(fixture({ projection }).detect());
});

for (const [name, bufferTransform] of [
  ['flipped axes', new Matrix4().set(-1, 0, 0, 1, 0, -1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1)],
  ['rotated portrait buffer', new Matrix4().set(0, -1, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1)],
  ['scaled and translated crop', new Matrix4().set(.5, 0, 0, .25, 0, .6, 0, .2, 0, 0, 1, 0, 0, 0, 0, 1)],
]) {
  test(`getDepthInMeters receives view UV once for ${name}`, () => {
    const transform = makeTransform([0, 1.6, 0], [0, .2, 0]);
    const setup = fixture({ transform, bufferTransform });
    assertWall(setup.detect(), 2 / Math.cos(.2));
    assert.deepEqual(setup.measurements[0], [.18, .18]);
    assert.ok(Math.abs(setup.measurements[60][0] - .5) < 1e-12);
  });
}

test('sensor view geometry is used when the depth sensor is offset from XRView', () => {
  const setup = fixture({ sensorTransform: makeTransform([.04, 1.61, .03], [0, .025, 0]) });
  const result = setup.detect();
  assertWall(result);
  assert.ok(result.candidate.point.distanceTo(new Vector3(0, 1.6, -2)) < .015);
});

test('noisy depth with foreground outliers still produces a measured stable plane', () => {
  const setup = fixture({ mutate: (depth, { sample }) => sample % 7 === 2 ? .65 : depth + Math.sin(sample * 37.1) * .006 });
  assertWall(setup.detect());
  assert.ok(setup.detect().metrics.inliers < 121);
});

test('fitted normal faces the viewer for a wall viewed from its reverse side', () => {
  const setup = fixture({ transform: makeTransform([0, 1.6, -4], [0, Math.PI, 0]) });
  const result = setup.detect();
  assertWall(result);
  assert.ok(result.candidate.normal.z < -.999);
});

for (const [name, rotation, normal, point] of [
  ['floor', [-.65, 0, 0], [0, 1, 0], [0, 0, 0]],
  ['ceiling', [.65, 0, 0], [0, -1, 0], [0, 3.2, 0]],
  ['slope beyond the 20 degree vertical limit', [0, 0, 0], [0, Math.sin(.5), Math.cos(.5)], [0, 1.6, -2]],
]) {
  test(`${name} is never returned as a wall`, () => {
    const setup = fixture({ transform: makeTransform([0, 1.6, 0], rotation), surface: ({ planeDepth }) => planeDepth(new Vector3(...normal), new Vector3(...point)) });
    const result = setup.detect();
    assert.equal(result.state, 'not-vertical', JSON.stringify(result));
    assert.equal(result.candidate, null);
  });
}

test('small wall slope inside the vertical limit is accepted', () => {
  const normal = new Vector3(0, Math.sin(.2), Math.cos(.2));
  const result = fixture({ surface: ({ planeDepth }) => planeDepth(normal) }).detect();
  assertWall(result);
  assert.ok(result.candidate.normal.dot(normal) > .999);
});

test('curved depth surface is rejected rather than inventing a flat wall', () => {
  const result = fixture({ surface: ({ u, v }) => 2 + 4 * ((u - .5) ** 2 + (v - .5) ** 2) }).detect();
  assert.equal(result.state, 'not-planar');
  assert.equal(result.candidate, null);
});

test('alternating near/far patches cannot combine into a false wall', () => {
  const result = fixture({ mutate: (_, { sample }) => (Math.floor(sample / 11) + sample % 11) % 2 ? 1.1 : 3 }).detect();
  assert.equal(result.state, 'not-planar');
  assert.equal(result.candidate, null);
});

test('unobserved center holes cannot place a stage in front of disconnected wall samples', () => {
  const result = fixture({ mutate: (depth, { u, v }) => Math.abs(u - .5) < .04 && Math.abs(v - .5) < .04 ? 0 : depth }).detect();
  assert.equal(result.state, 'not-planar');
  assert.equal(result.reason, 'disconnected-or-unobserved-center');
});

test('a hole splitting a coplanar surface rejects disconnected combined support', () => {
  const result = fixture({ mutate: (depth, { u, v }) => Math.abs(u - .436) < .01 ? 0 : depth }).detect();
  assert.equal(result.state, 'not-planar');
  assert.equal(result.candidate, null);
});

for (const invalid of [0, NaN, Infinity, -1, .1, 8.01]) {
  test(`invalid or out-of-range depth ${invalid} yields no wall`, () => {
    const result = fixture({ mutate: () => invalid }).detect();
    assert.equal(result.state, 'sparse');
    assert.equal(result.metrics.validSamples, 0);
  });
}

test('sparse depth and one-pixel buffer repetition do not count as planar evidence', () => {
  const result = fixture({ mutate: (depth, { sample }) => sample % 4 === 0 ? depth : 0 }).detect();
  assert.equal(result.state, 'sparse');
  const repeated = fixture({ bufferTransform: new Matrix4().makeScale(.001, .001, 1) }).detect();
  assert.equal(repeated.state, 'sparse');
  assert.ok(repeated.metrics.validSamples < 10);
});

test('coordinates mapped outside the depth buffer are skipped, not edge-clamped into a fake wall', () => {
  const setup = fixture({ bufferTransform: new Matrix4().makeTranslation(1, 0, 0) });
  assert.equal(setup.detect().state, 'sparse');
  assert.equal(setup.measurements.length, 0);
});

test('ray-distance range is enforced even when valid Z depth is less than eight metres', () => {
  const result = fixture({ transform: makeTransform([0, 1.6, 0], [0, .3, 0]), surface: ({ planeDepth }) => planeDepth(new Vector3(0, 0, 1), new Vector3(0, 1.6, -7.8)) }).detect();
  assert.equal(result.candidate, null);
});

test('sample count stays bounded with hostile option values', () => {
  for (const gridSize of [Infinity, NaN, 20000, -100, 10]) {
    const setup = fixture();
    const result = setup.detect({ gridSize });
    assert.ok(result.metrics.samples <= 121);
    assert.ok(setup.measurements.length <= 121);
    assertWall(result);
  }
});

test('unsupported and temporarily missing depth distinguish capability from tracking', () => {
  assert.equal(detectDepthWall({}, {}, {}).state, 'unavailable');
  const setup = fixture();
  setup.frame.session.depthUsage = 'gpu-optimized';
  assert.equal(setup.detect().state, 'unavailable');
  setup.frame.session.depthUsage = 'cpu-optimized';
  setup.frame.getDepthInformation = () => null;
  assert.equal(setup.detect().state, 'tracking');
  setup.frame.getDepthInformation = () => {throw new DOMException('No CPU depth', 'NotSupportedError');};
  assert.equal(setup.detect().state, 'unavailable');
  setup.pose.emulatedPosition = true;
  assert.equal(setup.detect().state, 'tracking');
});

test('expired XR frames and depth accessor exceptions are contained', () => {
  const setup = fixture();
  setup.depth.getDepthInMeters = () => {throw new DOMException('Frame ended', 'InvalidStateError');};
  assert.equal(setup.detect().state, 'sparse');
  setup.frame.getDepthInformation = () => {throw new DOMException('Frame ended', 'InvalidStateError');};
  assert.equal(setup.detect().state, 'unavailable');
});

test('an ungranted depth feature may expose a throwing session.depthUsage getter', () => {
  const setup = fixture();
  Object.defineProperty(setup.frame.session, 'depthUsage', { get() {throw new DOMException('Depth not enabled', 'InvalidStateError');} });
  const result = setup.detect();
  assert.equal(result.state, 'unavailable');
  assert.equal(result.reason, 'InvalidStateError');
  assert.equal(result.candidate, null);
  assert.equal(setup.measurements.length, 0);
});

test('malformed projection, depth transform or dimensions are rejected without non-finite candidates', () => {
  for (const mutate of [
    setup => {setup.view.projectionMatrix[0] = NaN;},
    setup => {setup.depth.normDepthBufferFromNormView.matrix = Array(16).fill(0);},
    setup => {setup.depth.width = 0;},
    setup => {setup.depth.height = 2.5;},
    setup => {setup.depth.transform = { matrix: identity().toArray() };},
  ]) {
    const setup = fixture(); mutate(setup);
    assert.equal(setup.detect().state, 'invalid-depth');
  }
});

test('detector leaves viewer, view and depth mapping matrices unchanged', () => {
  const setup = fixture();
  const before = JSON.stringify([setup.pose, setup.depth.normDepthBufferFromNormView]);
  assertWall(setup.detect());
  assert.equal(JSON.stringify([setup.pose, setup.depth.normDepthBufferFromNormView]), before);
});
