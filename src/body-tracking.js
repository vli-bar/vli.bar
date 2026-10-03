import { Matrix4, Quaternion, Vector3 } from 'three';

// Names from the experimental WebXR Body Tracking Module, not a native PICO
// skeleton or inferred controller joints: https://immersive-web.github.io/body-tracking/
// Keep the stored subset bounded. Fingers are intentionally outside this take.
export const BODY_JOINT_NAMES = Object.freeze([
  'hips', 'spine-lower', 'spine-middle', 'spine-upper', 'chest', 'neck', 'head',
  'left-shoulder', 'left-arm-upper', 'left-arm-lower', 'left-hand-wrist',
  'right-shoulder', 'right-arm-upper', 'right-arm-lower', 'right-hand-wrist',
  'left-upper-leg', 'left-lower-leg', 'left-foot-ankle', 'left-foot-ball',
  'right-upper-leg', 'right-lower-leg', 'right-foot-ankle', 'right-foot-ball',
]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const round = value => Math.round(value * 1e6) / 1e6;
const fail = label => { throw new Error(`モーションデータ: ${label} が不正です。`); };

function cleanPose(value, label) {
  if (!isObject(value)) fail(label);
  const { position, quaternion, emulatedPosition } = value;
  if (!Array.isArray(position) || position.length !== 3 || !position.every(n => Number.isFinite(n) && Math.abs(n) <= 100)) fail(`${label}の位置`);
  if (!Array.isArray(quaternion) || quaternion.length !== 4 || !quaternion.every(n => Number.isFinite(n) && Math.abs(n) <= 1.01)) fail(`${label}の回転`);
  const norm = Math.hypot(...quaternion);
  if (Math.abs(norm - 1) > .02) fail(`${label}の単位クォータニオン`);
  if (emulatedPosition !== undefined && typeof emulatedPosition !== 'boolean') fail(`${label}の追跡フラグ`);
  return {
    position: position.map(round), quaternion: quaternion.map(n => round(n / norm)),
    emulatedPosition: emulatedPosition === true,
  };
}

/** Sanitize imported joint poses. Missing joints stay missing; unknown names are discarded. */
export function sanitizeBodyJoints(value, label = '身体関節') {
  if (value === null || value === undefined) return null;
  if (!isObject(value)) fail(label);
  const joints = {};
  for (const name of BODY_JOINT_NAMES) {
    if (!Object.hasOwn(value, name) || value[name] === null) continue;
    joints[name] = cleanPose(value[name], `${label} ${name}`);
  }
  return Object.keys(joints).length ? joints : null;
}

function referencePose(pose) {
  const p = pose?.transform?.position;
  const q = pose?.transform?.orientation;
  return p && q ? {
    position: [p.x, p.y, p.z], quaternion: [q.x, q.y, q.z, q.w],
    emulatedPosition: pose.emulatedPosition === true,
  } : null;
}

function result(joints, status, readErrors = 0) {
  const poses = Object.values(joints ?? {});
  return { joints, status, jointCount: poses.length, emulatedCount: poses.filter(pose => pose.emulatedPosition).length, readErrors };
}

/**
 * Read only actual browser-provided spaces while the XRFrame is active. A
 * recorder passes its calibrated relativePose callback; diagnostics may omit
 * it to inspect poses in referenceSpace. No guessed getBodyPose/native API.
 * emulatedPosition describes position estimation, not full tracking accuracy.
 */
export function readBodyJoints(frame, referenceSpace, relativePose = referencePose) {
  if (!frame || !referenceSpace || typeof frame.getPose !== 'function') return result(null, 'unavailable');
  let body;
  try {
    if (!('body' in frame)) return result(null, 'unavailable');
    body = frame.body;
    if (!body) {
      const granted = Array.from(frame.session?.enabledFeatures ?? []).includes('body-tracking');
      return result(null, granted ? 'not-tracked' : 'unavailable');
    }
    if (typeof body.get !== 'function') return result(null, 'unavailable');
  } catch {
    return result(null, 'error', 1);
  }
  const joints = {};
  let readErrors = 0;
  for (const name of BODY_JOINT_NAMES) {
    try {
      const space = body.get(name);
      if (!space) continue;
      const pose = frame.getPose(space, referenceSpace);
      if (!pose) continue;
      const transformed = relativePose(pose);
      if (transformed) joints[name] = cleanPose(transformed, name);
    } catch {
      // One inaccessible or invalid joint must not erase the other observations.
      readErrors++;
    }
  }
  return Object.keys(joints).length ? result(joints, 'tracked', readErrors) : result(null, readErrors ? 'error' : 'not-tracked', readErrors);
}

/** Interpolate sanitized samples only where both endpoints contain a joint. */
export function interpolateBodyJoints(a, b, factor) {
  if (!a || !b) return null;
  const t = Math.max(0, Math.min(1, Number.isFinite(factor) ? factor : 0));
  const joints = {};
  for (const name of BODY_JOINT_NAMES) {
    const start = a[name], end = b[name];
    if (!start || !end) continue;
    joints[name] = {
      position: start.position.map((n, index) => n + (end.position[index] - n) * t),
      quaternion: new Quaternion().fromArray(start.quaternion).slerp(new Quaternion().fromArray(end.quaternion), t).normalize().toArray(),
      emulatedPosition: start.emulatedPosition === true || end.emulatedPosition === true,
    };
  }
  return Object.keys(joints).length ? joints : null;
}

function setWorldQuaternion(node, quaternion) {
  const parent = node.parent?.getWorldQuaternion(new Quaternion()) ?? new Quaternion();
  node.quaternion.copy(parent.invert().multiply(quaternion)).normalize();
  node.updateWorldMatrix(false, true);
}

function alignDirection(node, child, direction) {
  if (!node || !child || direction.lengthSq() < 1e-10) return false;
  const current = child.getWorldPosition(new Vector3()).sub(node.getWorldPosition(new Vector3()));
  if (current.lengthSq() < 1e-10) return false;
  const delta = new Quaternion().setFromUnitVectors(current.normalize(), direction.clone().normalize());
  setWorldQuaternion(node, delta.multiply(node.getWorldQuaternion(new Quaternion())));
  return true;
}

function frameRotation(lateral, up) {
  if (lateral.lengthSq() < 1e-10 || up.lengthSq() < 1e-10) return null;
  const y = up.clone().normalize();
  const x = lateral.clone().addScaledVector(y, -lateral.dot(y));
  if (x.lengthSq() < 1e-10) return null;
  x.normalize();
  const z = new Vector3().crossVectors(x, y).normalize();
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, y, z));
}

/**
 * Override only observed body chains, after the head/controller fallback. Body
 * joint rotations do not share VRM bone axes, so segment directions drive the
 * normalized rig. This transfers swing but cannot recover axial bone twist.
 * `basis` maps calibrated XR coordinates to the model (VRM 1: yaw PI; VRM 0:
 * identity). `headAnchor` and `meterScale` are in unscaled vrm.scene coordinates.
 * Missing chains keep their fallback pose. The HMD's head orientation and the
 * stage/scene transform are preserved. Call before vrm.update(delta).
 */
export function applyBodyToVRM(vrm, joints, { basis, headAnchor, meterScale } = {}) {
  if (!vrm?.humanoid || !joints || !basis?.isQuaternion || !headAnchor?.isVector3 || !Number.isFinite(meterScale) || meterScale <= 0) return false;
  const get = name => vrm.humanoid.getNormalizedBoneNode(name);
  const hips = get('hips'), head = get('head');
  if (!hips) return false;
  vrm.scene.updateWorldMatrix(true, true);
  const headOrientation = head?.getWorldQuaternion(new Quaternion());
  const position = name => joints[name] ? new Vector3().fromArray(joints[name].position) : null;
  const worldDirection = (start, end) => {
    const a = position(start), b = position(end);
    return a && b ? b.sub(a).applyQuaternion(basis).transformDirection(vrm.scene.matrixWorld) : null;
  };
  let applied = false;

  if (joints.hips) {
    const local = position('hips').applyQuaternion(basis).multiplyScalar(meterScale).add(headAnchor);
    const world = vrm.scene.localToWorld(local);
    hips.position.copy(hips.parent ? hips.parent.worldToLocal(world) : world);
    hips.updateWorldMatrix(false, true);
    applied = true;
  }

  // Resolve body yaw and lean from pelvis width and torso height instead of
  // copying the device-specific pelvis quaternion onto a VRM bone.
  const leftHip = get('leftUpperLeg'), rightHip = get('rightUpperLeg');
  const upperName = ['chest', 'spine-upper', 'neck', 'head'].find(name => joints[name]);
  const upperBone = get('spine') ?? head;
  if (leftHip && rightHip && upperBone && upperName) {
    const lateral = worldDirection('right-upper-leg', 'left-upper-leg');
    const up = worldDirection('hips', upperName);
    if (lateral && up) {
      const source = frameRotation(leftHip.getWorldPosition(new Vector3()).sub(rightHip.getWorldPosition(new Vector3())), upperBone.getWorldPosition(new Vector3()).sub(hips.getWorldPosition(new Vector3())));
      const target = frameRotation(lateral, up);
      if (source && target) {
        setWorldQuaternion(hips, target.multiply(source.invert()).multiply(hips.getWorldQuaternion(new Quaternion())));
        applied = true;
      }
    }
  }

  const chains = [
    ['spine', ['chest', 'upperChest', 'neck', 'head'], [['spine-lower', 'spine-middle'], ['hips', 'chest'], ['hips', 'neck']]],
    ['chest', ['upperChest', 'neck', 'head'], [['spine-middle', 'spine-upper'], ['spine-lower', 'neck'], ['chest', 'neck']]],
    ['upperChest', ['neck', 'head'], [['spine-upper', 'neck'], ['chest', 'neck']]],
    ['neck', ['head'], [['neck', 'head']]],
  ];
  for (const side of ['left', 'right']) {
    chains.push(
      [side + 'Shoulder', [side + 'UpperArm'], [[side + '-shoulder', side + '-arm-upper']]],
      [side + 'UpperArm', [side + 'LowerArm'], [[side + '-arm-upper', side + '-arm-lower']]],
      [side + 'LowerArm', [side + 'Hand'], [[side + '-arm-lower', side + '-hand-wrist']]],
      [side + 'UpperLeg', [side + 'LowerLeg'], [[side + '-upper-leg', side + '-lower-leg']]],
      [side + 'LowerLeg', [side + 'Foot'], [[side + '-lower-leg', side + '-foot-ankle']]],
      [side + 'Foot', [side + 'Toes'], [[side + '-foot-ankle', side + '-foot-ball']]],
    );
  }
  for (const [name, children, pairs] of chains) {
    const child = children.map(get).find(Boolean);
    const direction = pairs.map(([from, to]) => worldDirection(from, to)).find(value => value && value.lengthSq() > 1e-10);
    if (direction) applied = alignDirection(get(name), child, direction) || applied;
  }
  if (head && headOrientation) setWorldQuaternion(head, headOrientation);
  return applied;
}
