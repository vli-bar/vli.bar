import { Matrix4, Quaternion, Vector3 } from 'three';

const round = value => Math.round(value * 1e6) / 1e6;
const IDENTITY = [0, 0, 0, 1];
const midpoint = (a, b) => a && b ? a.clone().add(b).multiplyScalar(.5) : null;

function onePose(value) {
  if (!Array.isArray(value)) return null;
  if (value.length === 1 && Array.isArray(value[0])) return value[0].length === 33 ? value[0] : null;
  return value.length === 33 && !Array.isArray(value[0]) ? value : null;
}

function confident(point, imagePoint, threshold) {
  if (!point || !imagePoint || ![point.x, point.y, point.z].every(n => Number.isFinite(n) && Math.abs(n) <= 3)) return false;
  if (![imagePoint.x, imagePoint.y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)) return false;
  const visibility = [point.visibility, imagePoint.visibility].filter(value => value !== undefined);
  if (!visibility.length || !visibility.every(n => Number.isFinite(n) && n >= threshold && n <= 1)) return false;
  return [point.presence, imagePoint.presence].filter(value => value !== undefined).every(n => Number.isFinite(n) && n >= threshold && n <= 1);
}

function headRotation(left, right, head, shoulders) {
  if (!left || !right || !head || !shoulders) return null;
  const x = right.clone().sub(left);
  const up = head.clone().sub(shoulders);
  if (x.lengthSq() < .001 || up.lengthSq() < .0025) return null;
  x.normalize();
  const y = up.addScaledVector(x, -up.dot(x));
  if (y.lengthSq() < .0025) return null;
  y.normalize();
  const z = new Vector3().crossVectors(x, y).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z)).normalize().toArray();
}

/**
 * Convert one unmirrored MediaPipe Pose Landmarker result, without running ML.
 * World landmarks use a moving hip origin (estimated meters), not room-space
 * positions: https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js
 * The rotation (x,y,z)->(-x,-y,z) supplies our performer-facing, Y-up capture
 * axes. Existing VRM 1 retargeting then turns these by PI around Y. Mirroring a
 * selfie preview must be CSS-only; mirrored inference input swaps the mapping.
 * Absolute walking/jumping translation and bone-axis twist are not recovered.
 */
export class CameraPoseSampler {
  constructor({ minConfidence = .6 } = {}) {
    if (!Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) throw new RangeError('minConfidence must be 0–1');
    this.minConfidence = minConfidence;
    this.reset();
  }

  reset() {
    this.origin = null;
    this.initialHeadHeight = null;
    this.startedAt = null;
    this.lastTime = -Infinity;
    this.headAnchor = null;
    this.latest = null;
    return this;
  }

  sample(result, timeMs) {
    const tracking = {
      sample: { t: this.startedAt === null || !Number.isFinite(timeMs) ? 0 : round(Math.max(0, (timeMs - this.startedAt) / 1000)), visibility: 'visible', head: null, left: null, right: null, body: null },
      origin: this.origin, initialHeadHeight: this.initialHeadHeight, referenceSpace: 'camera', source: 'camera-pose',
      sources: { left: 'unavailable', right: 'unavailable' }, bodyStatus: 'not-tracked', bodyCount: 0, bodyEmulatedCount: 0,
      landmarkCount: 0, quality: 'missing', absolutePosition: false,
    };
    const finish = () => { this.latest = tracking; return tracking; };
    if (!Number.isFinite(timeMs) || timeMs < this.lastTime) { tracking.sample.visibility = 'hidden'; return finish(); }
    this.lastTime = timeMs;
    const image = onePose(result?.landmarks ?? result?.poseLandmarks);
    const world = onePose(result?.worldLandmarks ?? result?.poseWorldLandmarks);
    // Reject absent or multiple people rather than switching identities.
    if (!image || !world) return finish();
    const points = world.map((point, i) => confident(point, image[i], this.minConfidence) ? new Vector3(-point.x, -point.y, point.z) : null);
    tracking.landmarkCount = points.filter(Boolean).length;

    // A moving hip center is required every frame. No last-known root is used
    // to invent observations while either hip or the torso is occluded.
    const hips = midpoint(points[23], points[24]);
    const shoulders = midpoint(points[11], points[12]);
    const plausible = (a, b, min, max) => !!a && !!b && a.distanceTo(b) >= min && a.distanceTo(b) <= max;
    if (!hips || !shoulders || !plausible(points[23], points[24], .06, .7) || !plausible(points[11], points[12], .1, 1) || !plausible(hips, shoulders, .15, 1.1)) {
      tracking.quality = 'torso-unavailable'; return finish();
    }
    for (let i = 0; i < points.length; i++) if (points[i] && points[i].distanceTo(hips) > 2.5) points[i] = null;
    // Drop an implausible distal landmark without removing an intact other arm.
    for (const [a, b, minimum, maximum] of [[11, 13, .04, .85], [13, 15, .04, .85], [12, 14, .04, .85], [14, 16, .04, .85], [23, 25, .06, 1], [25, 27, .06, 1], [24, 26, .06, 1], [26, 28, .06, 1], [27, 31, .02, .5], [28, 32, .02, .5]]) {
      if (points[a] && points[b] && !plausible(points[a], points[b], minimum, maximum)) points[b] = null;
    }
    const facePair = points[7] && points[8] ? [points[7], points[8]] : [points[2], points[5]];
    let head = midpoint(...facePair);
    if (head && !plausible(head, shoulders, .08, .65)) head = null;
    const headQ = headRotation(...facePair, head, shoulders);
    if (!headQ) head = null;
    if (!this.origin) {
      if (!head) { tracking.quality = 'head-unavailable'; return finish(); }
      this.headAnchor = head.clone().sub(hips);
      this.origin = { position: this.headAnchor.toArray().map(round), quaternion: [...IDENTITY], emulatedPosition: true, source: 'camera-pose' };
      const ankles = midpoint(points[27], points[28]);
      const height = ankles ? head.y - ankles.y + .08 : null;
      this.initialHeadHeight = Number.isFinite(height) && height >= .4 && height <= 2.8 ? round(height) : null;
      this.startedAt = timeMs;
      tracking.sample.t = 0;
    }
    tracking.origin = this.origin;
    tracking.initialHeadHeight = this.initialHeadHeight;
    const pose = (point, quaternion = IDENTITY) => point ? {
      position: point.clone().sub(hips).sub(this.headAnchor).toArray().map(round),
      quaternion: quaternion.map(round), emulatedPosition: true, source: 'camera-pose',
    } : null;
    const body = {};
    const add = (name, point) => { if (point) body[name] = pose(point); };
    add('hips', hips);
    add('spine-lower', hips.clone().lerp(shoulders, .25));
    add('spine-middle', hips.clone().lerp(shoulders, .5));
    add('spine-upper', hips.clone().lerp(shoulders, .75));
    add('chest', shoulders);
    if (head) {
      add('neck', shoulders.clone().lerp(head, .35));
      body.head = pose(head, headQ);
    }
    for (const [side, shoulder, elbow, wrist, hip, knee, ankle, foot] of [
      ['left', 11, 13, 15, 23, 25, 27, 31], ['right', 12, 14, 16, 24, 26, 28, 32],
    ]) {
      add(side + '-shoulder', shoulders.clone().lerp(points[shoulder], .35));
      for (const [joint, index] of [['-arm-upper', shoulder], ['-arm-lower', elbow], ['-hand-wrist', wrist], ['-upper-leg', hip], ['-lower-leg', knee], ['-foot-ankle', ankle], ['-foot-ball', foot]]) add(side + joint, points[index]);
      tracking.sample[side] = pose(points[wrist]);
      if (tracking.sample[side]) tracking.sources[side] = 'camera-pose';
    }
    tracking.sample.head = pose(head, headQ);
    tracking.sample.body = body;
    tracking.bodyStatus = 'tracked';
    tracking.bodyCount = Object.keys(body).length;
    tracking.bodyEmulatedCount = tracking.bodyCount;
    tracking.quality = head ? 'estimated' : 'head-unavailable';
    return finish();
  }
}

export const createCameraPoseSampler = options => new CameraPoseSampler(options);
