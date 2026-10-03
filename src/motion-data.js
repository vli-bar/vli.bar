import * as THREE from 'three';

export const MOTION_FORMAT = 'vli.motion-capture';
export const MOTION_VERSION = 1;
export const MAX_CAPTURE_SECONDS = 180;
export const MAX_MOTION_FILE_BYTES = 12 * 1024 * 1024;
const TRACKS = ['head', 'left', 'right'];
const VISIBILITY = ['visible', 'visible-blurred', 'hidden'];
const SPACES = ['local', 'local-floor', 'bounded-floor', 'unbounded'];
const round = value => Math.round(value * 1e6) / 1e6;
const fail = message => { throw new Error(`モーションデータ: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function vector(value, length, label, bound) {
  if (!Array.isArray(value) || value.length !== length || !value.every(n => Number.isFinite(n) && Math.abs(n) <= bound)) {
    fail(`${label}が不正です。`);
  }
  return value.map(round);
}

function pose(value, label) {
  if (value === null) return null;
  if (!object(value)) fail(`${label}が不正です。`);
  const position = vector(value.position, 3, `${label}の位置`, 100);
  const quaternion = vector(value.quaternion, 4, `${label}の回転`, 1.01);
  const norm = Math.hypot(...quaternion);
  if (Math.abs(norm - 1) > .02) fail(`${label}の回転は単位クォータニオンにしてください。`);
  if (value.emulatedPosition !== undefined && typeof value.emulatedPosition !== 'boolean') fail(`${label}の追跡フラグが不正です。`);
  return { position, quaternion: quaternion.map(n => round(n / norm)), emulatedPosition: value.emulatedPosition === true };
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
  const origin = pose(data.origin, '原点');
  if (!origin) fail('原点がありません。');
  let previous = -1;
  let hasHead = false;
  const frames = data.frames.map((frame, index) => {
    if (!object(frame) || !Number.isFinite(frame.t) || frame.t < 0 || frame.t > data.duration + .00001 || frame.t <= previous) fail(`${index + 1} フレーム目の時刻が不正です。`);
    if (index === 0 && frame.t !== 0) fail('先頭フレームの時刻は 0 にしてください。');
    if (!VISIBILITY.includes(frame.visibility)) fail('可視状態が不正です。');
    previous = frame.t;
    const clean = { t: frame.t, visibility: frame.visibility };
    for (const track of TRACKS) clean[track] = pose(frame[track], `${index + 1} フレーム目の ${track}`);
    if (frame.visibility !== 'visible' && TRACKS.some(track => clean[track])) fail('非表示中のフレームには追跡データを含められません。');
    hasHead ||= !!clean.head;
    return clean;
  });
  if (!hasHead) fail('頭部の追跡データがありません。');
  if (Math.abs(frames.at(-1).t - data.duration) > .00001) fail('最終フレームと長さが一致しません。');
  const initialHeadHeight = data.initialHeadHeight ?? null;
  if (initialHeadHeight !== null && (!Number.isFinite(initialHeadHeight) || initialHeadHeight < .3 || initialHeadHeight > 3)) fail('初期頭部高さが不正です。');
  return {
    format: MOTION_FORMAT, version: MOTION_VERSION, units: 'meters', coordinates: 'right-handed-y-up-head-origin',
    referenceSpace: data.referenceSpace, fps: data.fps, duration: data.duration, origin, initialHeadHeight,
    tracking: { head: 'viewer', hands: 'controller-grip', body: 'inferred' },
    frames,
  };
}

export async function parseMotionFile(file) {
  if (!file || !Number.isFinite(file.size) || file.size <= 0 || file.size > MAX_MOTION_FILE_BYTES) fail('JSON ファイルは 12 MB 以内にしてください。');
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
  return { position: a.position.map((v, i) => v + (b.position[i] - v) * factor), quaternion: q.toArray(), emulatedPosition: a.emulatedPosition || b.emulatedPosition };
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
  if (b.t - a.t > 2.5 / clip.fps || a.visibility !== 'visible' || b.visibility !== 'visible') {
    return { t, visibility: 'hidden', head: null, left: null, right: null };
  }
  const factor = (t - a.t) / (b.t - a.t);
  return { t, visibility: 'visible', ...Object.fromEntries(TRACKS.map(track => [track, interpolatePose(a[track], b[track], factor)])) };
}

const turn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);
const turnInverse = turn.clone().invert();
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

function armIK(vrm, side, tracked, headAnchor, meterScale) {
  const bone = name => vrm.humanoid.getNormalizedBoneNode(side + name);
  const upper = bone('UpperArm'), lower = bone('LowerArm'), hand = bone('Hand');
  if (!upper || !lower || !hand || !tracked) return;
  const offset = new THREE.Vector3().fromArray(tracked.position).applyQuaternion(turn).multiplyScalar(meterScale);
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
  const pole = new THREE.Vector3(side === 'left' ? .35 : -.35, -.9, -.35)
    .transformDirection(vrm.scene.matrixWorld);
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
  const sample = sampleMotionClip(clip, time);
  const humanoid = vrm?.humanoid;
  if (!humanoid) return false;
  humanoid.resetNormalizedPose();
  const get = name => humanoid.getNormalizedBoneNode(name);
  const head = get('head'), hips = get('hips');
  if (!head || !hips) return false;
  vrm.scene.updateMatrixWorld(true);
  let rest = restCache.get(vrm);
  if (!rest) {
    const anchor = vrm.scene.worldToLocal(head.getWorldPosition(new THREE.Vector3()));
    rest = { headAnchor: anchor, hips: hips.position.clone() };
    restCache.set(vrm, rest);
  }
  // Rest arms hang naturally when one controller loses tracking.
  if (get('leftUpperArm')) get('leftUpperArm').rotation.z = -.85;
  if (get('rightUpperArm')) get('rightUpperArm').rotation.z = .85;
  if (!sample.head) return false;
  const meterScale = Math.max(.1, Math.abs(rest.headAnchor.y)) / (clip.initialHeadHeight ?? 1.65);
  const offset = new THREE.Vector3().fromArray(sample.head.position).applyQuaternion(turn).multiplyScalar(meterScale);
  hips.position.copy(rest.hips).add(new THREE.Vector3(clamp(offset.x, -1, 1), clamp(offset.y * .65, -.4, .25), clamp(offset.z, -1, 1)));
  const orientation = new THREE.Quaternion().fromArray(sample.head.quaternion).premultiply(turn).multiply(turnInverse);
  const angles = new THREE.Euler().setFromQuaternion(orientation, 'YXZ');
  const spine = get('spine');
  if (spine) spine.rotation.set(clamp(angles.x * .16, -.2, .2), clamp(angles.y * .2, -.45, .45), clamp(angles.z * .12, -.15, .15), 'YXZ');
  head.quaternion.copy(orientation);
  if (spine) head.quaternion.premultiply(spine.quaternion.clone().invert());
  for (const side of ['left', 'right']) {
    const leg = get(side + 'LowerLeg');
    if (leg) leg.rotation.x = Math.max(0, -offset.y) * .25;
  }
  vrm.scene.updateMatrixWorld(true);
  armIK(vrm, 'left', sample.left, rest.headAnchor, meterScale);
  armIK(vrm, 'right', sample.right, rest.headAnchor, meterScale);
  return true;
}
