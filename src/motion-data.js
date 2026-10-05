import * as THREE from 'three';
import { sanitizeBodyJoints, interpolateBodyJoints, applyBodyToVRM } from './body-tracking.js';
import { DURATION as DEMO_DURATION } from './timeline.js';

export const MOTION_FORMAT = 'vli.motion-capture';
export const MOTION_VERSION = 1;
export const MAX_CAPTURE_SECONDS = 180;
export const MAX_MOTION_FILE_BYTES = 32 * 1024 * 1024;
const TRACKS = ['head', 'left', 'right'];
const VISIBILITY = ['visible', 'visible-blurred', 'hidden'];
const SPACES = ['local', 'local-floor', 'bounded-floor', 'unbounded', 'camera'];
const round = value => Math.round(value * 1e6) / 1e6;
const fail = message => { throw new Error(`モーションデータ: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function vector(value, length, label, bound) {
  if (!Array.isArray(value) || value.length !== length || !value.every(n => Number.isFinite(n) && Math.abs(n) <= bound)) {
    fail(`${label}が不正です。`);
  }
  return value.map(round);
}

function pose(value, label, camera = false) {
  if (value === null) return null;
  if (!object(value)) fail(`${label}が不正です。`);
  const position = vector(value.position, 3, `${label}の位置`, 100);
  const quaternion = vector(value.quaternion, 4, `${label}の回転`, 1.01);
  const norm = Math.hypot(...quaternion);
  if (Math.abs(norm - 1) > .02) fail(`${label}の回転は単位クォータニオンにしてください。`);
  if (value.emulatedPosition !== undefined && typeof value.emulatedPosition !== 'boolean') fail(`${label}の追跡フラグが不正です。`);
  if (value.source !== undefined && !['viewer', 'controller-grip', 'hand-wrist', 'camera-pose'].includes(value.source)) fail(`${label}の入力元が不正です。`);
  return { position, quaternion: quaternion.map(n => round(n / norm)), emulatedPosition: camera || value.source === 'camera-pose' || value.emulatedPosition === true, ...(camera ? { source: 'camera-pose' } : value.source ? { source: value.source } : {}) };
}

function accompaniment(value, duration) {
  // Only a bundled track identifier is allowed. Importing a take must never
  // choose a remote audio URL or retain arbitrary metadata from the file.
  if (!object(value) || value.track !== 'neon-door' || !Number.isFinite(value.offset) || value.offset < 0 || value.offset >= DEMO_DURATION || value.offset + duration > DEMO_DURATION + .001) return null;
  return { track: 'neon-door', offset: value.offset };
}

/** Strictly bounded, sanitized import. Never retain arbitrary properties from JSON. */
export function validateMotionClip(data) {
  if (!object(data) || data.format !== MOTION_FORMAT || data.version !== MOTION_VERSION) {
    fail('対応形式は vli.motion-capture バージョン 1 の JSON です。');
  }
  if (data.units !== 'meters' || data.coordinates !== 'right-handed-y-up-head-origin') fail('座標系が未対応です。');
  if (!SPACES.includes(data.referenceSpace)) fail('参照空間が不正です。');
  if (!Number.isInteger(data.fps) || data.fps < 1 || data.fps > 60) fail('サンプリング周波数は 1〜60 Hz にしてください。');
  if (!Number.isFinite(data.duration) || data.duration < 0 || data.duration > MAX_CAPTURE_SECONDS) fail('長さは 180 秒以内にしてください。');
  if (!Array.isArray(data.frames) || !data.frames.length || data.frames.length > MAX_CAPTURE_SECONDS * data.fps + 2) fail('フレーム数が不正です。');
  const camera = data.referenceSpace === 'camera';
  const origin = pose(data.origin, '原点', camera);
  if (!origin) fail('原点がありません。');
  let previous = -1;
  let hasHead = false;
  const frames = data.frames.map((frame, index) => {
    if (!object(frame) || !Number.isFinite(frame.t) || frame.t < 0 || frame.t > data.duration + .00001 || frame.t <= previous) fail(`${index + 1} フレーム目の時刻が不正です。`);
    if (index === 0 && frame.t !== 0) fail('先頭フレームの時刻は 0 にしてください。');
    if (!VISIBILITY.includes(frame.visibility)) fail('可視状態が不正です。');
    previous = frame.t;
    const clean = { t: frame.t, visibility: frame.visibility };
    for (const track of TRACKS) clean[track] = pose(frame[track], `${index + 1} フレーム目の ${track}`, camera);
    if (frame.body !== undefined) clean.body = sanitizeBodyJoints(frame.body, `${index + 1} フレーム目の身体関節`);
    if (camera && clean.body) for (const joint of Object.values(clean.body)) joint.emulatedPosition = true;
    if (frame.visibility !== 'visible' && TRACKS.some(track => clean[track])) fail('非表示中のフレームには追跡データを含められません。');
    if (frame.visibility !== 'visible' && clean.body) fail('非表示中のフレームには身体関節を含められません。');
    hasHead ||= !!clean.head;
    return clean;
  });
  if (!hasHead) fail('頭部の追跡データがありません。');
  if (Math.abs(frames.at(-1).t - data.duration) > .00001) fail('最終フレームと長さが一致しません。');
  const initialHeadHeight = data.initialHeadHeight ?? null;
  if (initialHeadHeight !== null && (!Number.isFinite(initialHeadHeight) || initialHeadHeight < .3 || initialHeadHeight > 3)) fail('初期頭部高さが不正です。');
  const usesWrist = frames.some(frame => ['left', 'right'].some(side => frame[side]?.source === 'hand-wrist'));
  const usesController = frames.some(frame => ['left', 'right'].some(side => frame[side] && frame[side].source !== 'hand-wrist'));
  const hands = usesWrist ? (usesController ? 'mixed' : 'hand-wrist') : usesController ? 'controller-grip' : 'unavailable';
  const usesBody = frames.some(frame => frame.body && Object.keys(frame.body).length);
  const music = accompaniment(data.accompaniment, data.duration);
  return {
    format: MOTION_FORMAT, version: MOTION_VERSION, units: 'meters', coordinates: 'right-handed-y-up-head-origin',
    referenceSpace: data.referenceSpace, fps: data.fps, duration: data.duration, origin, initialHeadHeight,
    tracking: camera ? { head: 'camera-pose', hands: hands === 'unavailable' ? 'unavailable' : 'camera-pose', body: 'camera-pose' }
      : { head: 'viewer', hands, body: usesBody ? 'browser-body' : 'inferred' },
    ...(music ? { accompaniment: music } : {}),
    frames,
  };
}

export async function parseMotionFile(file) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_MOTION_FILE_BYTES) fail('JSON ファイルは 32 MB 以内にしてください。');
  let data;
  try { data = JSON.parse(await file.text()); } catch { fail('JSON ファイルを読み込めません。'); }
  return validateMotionClip(data);
}

export function serializeMotionClip(clip) {
  return JSON.stringify(validateMotionClip(clip));
}

export function downloadMotionClip(clip) {
  const blob = new Blob([serializeMotionClip(clip)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `vli-motion-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  // A delayed revoke gives mobile browsers enough time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function interpolatePose(a, b, factor) {
  if (!a || !b) return null;
  const q = new THREE.Quaternion().fromArray(a.quaternion).slerp(new THREE.Quaternion().fromArray(b.quaternion), factor);
  return { position: a.position.map((v, i) => v + (b.position[i] - v) * factor), quaternion: q.toArray(), emulatedPosition: a.emulatedPosition || b.emulatedPosition,
    ...(a.source && a.source === b.source ? { source: a.source } : {}) };
}

/** Binary search sparse timestamps; never interpolate through tracking gaps. */
export function sampleMotionClip(clip, time) {
  const t = Math.max(0, Math.min(clip.duration, Number.isFinite(time) ? time : 0));
  const frames = clip.frames;
  let low = 0, high = frames.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (frames[middle].t <= t) low = middle; else high = middle - 1;
  }
  const a = frames[low], b = frames[Math.min(low + 1, frames.length - 1)];
  if (a === b || t === a.t) return a;
  // Camera fps is a sampling ceiling, not a guaranteed ML inference cadence.
  // Bridge up to 500ms between valid observations; explicit null/hidden data
  // still remains a gap. XR keeps its stricter cadence-based threshold.
  const maxGap = clip.referenceSpace === 'camera' ? .5 : 2.5 / clip.fps;
  if (b.t - a.t > maxGap || a.visibility !== 'visible' || b.visibility !== 'visible') {
    return { t, visibility: 'hidden', head: null, left: null, right: null, body: null };
  }
  const factor = (t - a.t) / (b.t - a.t);
  return { t, visibility: 'visible', ...Object.fromEntries(TRACKS.map(track => [track, interpolatePose(a[track], b[track], factor)])),
    ...(a.body !== undefined || b.body !== undefined ? { body: interpolateBodyJoints(a.body, b.body, factor) } : {}) };
}

const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const identity = new THREE.Quaternion();
const restCache = new WeakMap();
const clamp = THREE.MathUtils.clamp;

function rotateBoneToward(bone, child, target) {
  const origin = bone.getWorldPosition(new THREE.Vector3());
  const current = child.getWorldPosition(new THREE.Vector3()).sub(origin).normalize();
  const desired = target.clone().sub(origin).normalize();
  if (!current.lengthSq() || !desired.lengthSq()) return;
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  world.premultiply(new THREE.Quaternion().setFromUnitVectors(current, desired));
  const parent = bone.parent?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion();
  bone.quaternion.copy(parent.invert().multiply(world));
  bone.updateWorldMatrix(false, true);
}

function armIK(vrm, side, tracked, headAnchor, meterScale, basis) {
  const bone = name => vrm.humanoid.getNormalizedBoneNode(side + name);
  const upper = bone('UpperArm'), lower = bone('LowerArm'), hand = bone('Hand');
  if (!upper || !lower || !hand || !tracked) return;
  const offset = new THREE.Vector3().fromArray(tracked.position).applyQuaternion(basis).multiplyScalar(meterScale);
  const target = vrm.scene.localToWorld(headAnchor.clone().add(offset));
  const shoulder = upper.getWorldPosition(new THREE.Vector3());
  const elbow = lower.getWorldPosition(new THREE.Vector3());
  const wrist = hand.getWorldPosition(new THREE.Vector3());
  const lengthA = shoulder.distanceTo(elbow), lengthB = elbow.distanceTo(wrist);
  if (lengthA < .001 || lengthB < .001) return;
  const direction = target.clone().sub(shoulder);
  const distance = clamp(direction.length(), Math.abs(lengthA - lengthB) + .001, lengthA + lengthB - .001);
  if (direction.lengthSq() < 1e-8) direction.set(0, -1, 0); else direction.normalize();
  target.copy(shoulder).addScaledVector(direction, distance);
  const pole = new THREE.Vector3(side === 'left' ? -.35 : .35, -.9, .35)
    .applyQuaternion(basis).transformDirection(vrm.scene.matrixWorld);
  pole.addScaledVector(direction, -pole.dot(direction));
  if (pole.lengthSq() < .00001) pole.set(0, 0, 1).addScaledVector(direction, -direction.z);
  pole.normalize();
  const along = (lengthA * lengthA + distance * distance - lengthB * lengthB) / (2 * distance);
  const bend = Math.sqrt(Math.max(0, lengthA * lengthA - along * along));
  const elbowTarget = shoulder.clone().addScaledVector(direction, along).addScaledVector(pole, bend);
  rotateBoneToward(upper, lower, elbowTarget);
  rotateBoneToward(lower, hand, target);
}

/**
 * Retarget head + controller positions to a VRM normalized rig. Arms use two-bone
 * IK. Hips, torso and legs are estimates; this is not full-body motion capture.
 * Call before vrm.update(delta); stage transforms are left untouched.
 */
export function applyCaptureToVRM(vrm, clip, time) {
  return applyMotionSampleToVRM(vrm, sampleMotionClip(clip, time), clip);
}

/** Apply a live or recorded sample using the same retargeting path. */
export function applyMotionSampleToVRM(vrm, sample, { initialHeadHeight = null } = {}) {
  const humanoid = vrm?.humanoid;
  if (!humanoid) return false;
  humanoid.resetNormalizedPose();
  for (const name of ['aa', 'happy', 'blink']) vrm.expressionManager?.setValue(name, 0);
  const get = name => humanoid.getNormalizedBoneNode(name);
  const head = get('head'), hips = get('hips');
  if (!head || !hips) return false;
  vrm.scene.updateWorldMatrix(true, true);
  let rest = restCache.get(vrm);
  if (!rest) {
    const anchor = vrm.scene.worldToLocal(head.getWorldPosition(new THREE.Vector3()));
    rest = { headAnchor: anchor, hips: hips.position.clone() };
    restCache.set(vrm, rest);
  }
  // Rest arms hang naturally when one controller loses tracking.
  const legacy = vrm.meta?.metaVersion === '0';
  const basis = legacy ? identity : turn;
  if (get('leftUpperArm')) get('leftUpperArm').rotation.z = legacy ? .85 : -.85;
  if (get('rightUpperArm')) get('rightUpperArm').rotation.z = legacy ? -.85 : .85;
  const meterScale = Math.max(.1, Math.abs(rest.headAnchor.y)) / (initialHeadHeight ?? 1.65);
  const bodyContext = { basis, headAnchor: rest.headAnchor, meterScale };
  if (!sample?.head) return applyBodyToVRM(vrm, sample?.body, bodyContext);
  const offset = new THREE.Vector3().fromArray(sample.head.position).applyQuaternion(basis).multiplyScalar(meterScale);
  hips.position.copy(rest.hips).add(new THREE.Vector3(clamp(offset.x, -1, 1), clamp(offset.y * .65, -.4, .25), clamp(offset.z, -1, 1)));
  const orientation = new THREE.Quaternion().fromArray(sample.head.quaternion).premultiply(basis).multiply(basis.clone().invert());
  const angles = new THREE.Euler().setFromQuaternion(orientation, 'YXZ');
  const spine = get('spine');
  if (spine) spine.rotation.set(clamp(angles.x * .16, -.2, .2), clamp(angles.y * .2, -.45, .45), clamp(angles.z * .12, -.15, .15), 'YXZ');
  head.quaternion.copy(orientation);
  if (spine) head.quaternion.premultiply(spine.quaternion.clone().invert());
  for (const side of ['left', 'right']) {
    const leg = get(side + 'LowerLeg');
    if (leg) leg.rotation.x = (legacy ? -1 : 1) * Math.max(0, -offset.y) * .25;
  }
  vrm.scene.updateWorldMatrix(true, true);
  armIK(vrm, 'left', sample.left, rest.headAnchor, meterScale, basis);
  armIK(vrm, 'right', sample.right, rest.headAnchor, meterScale, basis);
  const bodyApplied = applyBodyToVRM(vrm, sample.body, bodyContext);
  // Body tracking can move the pelvis even when an arm is outside its field of
  // view. Re-solve incomplete arms against the observed controller/wrist after
  // that change, so those hands do not drift away with the estimated torso.
  if (bodyApplied) for (const side of ['left', 'right']) {
    const completeArm = ['-arm-upper', '-arm-lower', '-hand-wrist'].every(suffix => sample.body?.[side + suffix]);
    if (!completeArm) armIK(vrm, side, sample[side], rest.headAnchor, meterScale, basis);
  }
  return true;
}
