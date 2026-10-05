import * as THREE from 'three';

const HIDDEN = () => ({ t: 0, visibility: 'hidden', head: null, left: null, right: null, body: {} });
const TRACKS = ['head', 'left', 'right'];
const round = n => Math.round(n * 1e6) / 1e6;
const MAX_PEERS = 16;
const finiteQuaternion = values => Array.isArray(values) && values.length === 4 && values.every(Number.isFinite) && Math.abs(Math.hypot(...values) - 1) < .02;

function cleanPose(pose) {
  if (!pose || pose.emulatedPosition === true || !Array.isArray(pose.position) || pose.position.length !== 3 ||
    !pose.position.every(n => Number.isFinite(n) && Math.abs(n) <= 100) || !finiteQuaternion(pose.quaternion)) return null;
  return { position: [...pose.position], quaternion: new THREE.Quaternion().fromArray(pose.quaternion).normalize().toArray(), emulatedPosition: false };
}

/**
 * Audience coordinates are absolute in the shared stage frame, never relative
 * to an independently calibrated head/room origin. The stage must already be
 * placed in this XR referenceSpace before calling. Its matrixWorld includes
 * parent transforms and the configured stage width.
 */
export function sampleAudiencePose(frame, referenceSpace, stage, { device = 'phone' } = {}) {
  const sample = HIDDEN();
  if (!frame || !referenceSpace || !stage || frame.session?.visibilityState && frame.session.visibilityState !== 'visible') return sample;
  stage.updateWorldMatrix(true, false);
  if (!stage.matrixWorld.elements.every(Number.isFinite) || stage.matrixWorld.determinant() < 1e-8) return sample;
  const inverse = stage.matrixWorld.clone().invert();
  const stageRotation = stage.getWorldQuaternion(new THREE.Quaternion()).invert();
  const relative = (pose, source) => {
    if (!pose?.transform || pose.emulatedPosition === true) return null;
    const { position: p, orientation: q } = pose.transform;
    if (![p?.x, p?.y, p?.z, q?.x, q?.y, q?.z, q?.w].every(Number.isFinite)) return null;
    const rotation = new THREE.Quaternion(q.x, q.y, q.z, q.w);
    if (Math.abs(rotation.length() - 1) > .02) return null;
    const position = new THREE.Vector3(p.x, p.y, p.z).applyMatrix4(inverse);
    const clean = cleanPose({ position: position.toArray(), quaternion: rotation.normalize().premultiply(stageRotation).normalize().toArray() });
    return clean ? { position: clean.position.map(round), quaternion: clean.quaternion.map(round), emulatedPosition: false, source } : null;
  };
  try { sample.head = relative(frame.getViewerPose(referenceSpace), 'viewer'); } catch { /* tracking unavailable */ }
  if (!sample.head) return sample;
  sample.visibility = 'visible';
  // A phone's tracked camera does not provide tracked human hands. Ignore any
  // touchscreen/controller sources even when the browser happens to expose one.
  if (device !== 'headset') return sample;
  for (const input of frame.session?.inputSources ?? []) {
    const side = input.handedness;
    if (!['left', 'right'].includes(side)) continue;
    // Natural-input pinch grips are temporary interaction points. Broadcasting
    // them as wrists makes an audience member's hands jump on every selection.
    if (input.targetRayMode === 'transient-pointer') continue;
    let tracked = null;
    try {
      const wrist = input.hand?.get?.('wrist');
      if (wrist && typeof frame.getJointPose === 'function') tracked = relative(frame.getJointPose(wrist, referenceSpace), 'hand-wrist');
    } catch { /* optional hand tracking */ }
    if (!tracked && input.gripSpace) {
      try { tracked = relative(frame.getPose(input.gripSpace, referenceSpace), 'controller-grip'); } catch { /* controller currently lost */ }
    }
    if (tracked && (sample[side]?.source !== 'hand-wrist' || tracked.source === 'hand-wrist')) sample[side] = tracked;
  }
  return sample;
}

function interpolate(a, b, alpha) {
  if (!a || !b) return null;
  return {
    position: a.position.map((value, index) => value + (b.position[index] - value) * alpha),
    quaternion: new THREE.Quaternion().fromArray(a.quaternion).slerp(new THREE.Quaternion().fromArray(b.quaternion), alpha).toArray(),
  };
}

function atTime(frames, time, track) {
  if (!frames.length) return null;
  // Missing tracking always wins immediately over buffered older observations.
  if (!frames.at(-1).sample[track]) return null;
  if (time <= frames[0].time) return frames[0].sample[track];
  for (let i = 1; i < frames.length; i++) {
    if (time >= frames[i].time) continue;
    const a = frames[i - 1], b = frames[i];
    return interpolate(a.sample[track], b.sample[track], (time - a.time) / (b.time - a.time));
  }
  return frames.at(-1).sample[track];
}

/** Remote audience heads; face front is XR's -Z, with optional real HMD hands. */
export function createLivePresence(scene, stage, { ttlMs = 1000, interpolationMs = 80 } = {}) {
  if (!scene?.add || !stage?.matrixWorld) throw new Error('Presence requires a scene and placed stage.');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isFinite(interpolationMs) || interpolationMs < 0 || interpolationMs > ttlMs) throw new RangeError('Invalid presence timing.');
  const room = new THREE.Group(); room.name = 'live-audience'; room.matrixAutoUpdate = false; scene.add(room);
  const peers = new Map();
  let selfId = null, disposed = false;
  const geometry = { sphere: new THREE.SphereGeometry(1, 16, 12), box: new THREE.BoxGeometry(1, 1, 1) };
  const materials = {
    shell: new THREE.MeshBasicMaterial({ color: 0xdddaf5 }),
    dark: new THREE.MeshBasicMaterial({ color: 0x202337 }),
    eye: new THREE.MeshBasicMaterial({ color: 0xe7fff8 }),
    accents: [0x75edcd, 0xbca2ff, 0xd5f27b, 0xffaacd].map(color => new THREE.MeshBasicMaterial({ color })),
  };
  function mesh(parent, kind, material, scale, position = [0, 0, 0], name = '') {
    const object = new THREE.Mesh(geometry[kind], material);
    object.name = name; object.scale.fromArray(scale); object.position.fromArray(position); parent.add(object); return object;
  }
  function makePeer(peer) {
    const group = new THREE.Group(); group.name = `audience:${peer.id}`; group.visible = false; room.add(group);
    const colorIndex = [...peer.id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % materials.accents.length;
    const accent = materials.accents[colorIndex];
    const head = new THREE.Group(); head.name = 'audience-head'; group.add(head);
    mesh(head, 'sphere', materials.shell, [.105, .12, .1]);
    mesh(head, 'sphere', materials.dark, [.091, .063, .026], [0, .012, -.091], 'face-front');
    for (const x of [-.034, .034]) mesh(head, 'sphere', materials.eye, [.014, .024, .008], [x, .023, -.115], 'eye');
    mesh(head, 'box', accent, [.04, .008, .008], [0, -.022, -.116], 'mouth');
    mesh(head, 'sphere', accent, [.086, .025, .065], [0, .106, .012], 'cap');
    for (const x of [-.106, .106]) mesh(head, 'sphere', accent, [.018, .045, .047], [x, .006, 0], 'ear');
    const tracks = { head };
    for (const side of ['left', 'right']) {
      const hand = new THREE.Group(); hand.name = `audience-${side}`; hand.visible = false; group.add(hand); tracks[side] = hand;
      mesh(hand, 'sphere', accent, [.042, .026, .057]);
      mesh(hand, 'box', materials.eye, [.045, .008, .025], [0, .024, -.01]);
    }
    return { group, tracks, peer, frames: [], receivedAt: -Infinity, seq: -1 };
  }
  function remove(id) { const record = peers.get(id); if (record) room.remove(record.group); peers.delete(id); }
  function clear() { for (const id of peers.keys()) remove(id); }
  return {
    room,
    get size() { return peers.size; },
    setPeers(roster, ownId) {
      if (disposed) return;
      selfId = ownId;
      const accepted = new Map();
      for (const peer of Array.isArray(roster) ? roster : []) {
        if (!peer || typeof peer.id !== 'string' || !peer.id || peer.id.length > 100 || peer.id === selfId || peer.role !== 'audience' ||
          !['headset', 'phone', 'desktop'].includes(peer.device) || accepted.has(peer.id)) continue;
        accepted.set(peer.id, { id: peer.id, name: String(peer.name ?? '').slice(0, 48), role: peer.role, device: peer.device });
        if (accepted.size === MAX_PEERS) break;
      }
      for (const [id, record] of peers) if (!accepted.has(id) || accepted.get(id).device !== record.peer.device) remove(id);
      for (const [id, peer] of accepted) {
        if (!peers.has(id)) peers.set(id, makePeer(peer));
        const record = peers.get(id); record.peer = peer; record.group.userData.peer = { ...peer };
      }
    },
    receive(packet) {
      if (disposed || !packet || packet.id === selfId || packet.role !== 'audience' || packet.referenceSpace !== 'stage') return false;
      const record = peers.get(packet.id), receivedAt = packet.receivedAt;
      if (!record || packet.device !== record.peer.device || !Number.isFinite(receivedAt) || receivedAt < 0 || receivedAt < record.receivedAt ||
        !Number.isSafeInteger(packet.seq) || packet.seq < 0 || packet.seq <= record.seq || !packet.sample) return false;
      const sample = { head: null, left: null, right: null };
      if (packet.sample.visibility === 'visible') sample.head = cleanPose(packet.sample.head);
      if (sample.head && record.peer.device === 'headset') {
        sample.left = cleanPose(packet.sample.left); sample.right = cleanPose(packet.sample.right);
      }
      if (receivedAt - record.receivedAt > ttlMs) record.frames.length = 0;
      if (record.frames.at(-1)?.time === receivedAt) record.frames.pop();
      record.frames.push({ time: receivedAt, sample });
      if (record.frames.length > 8) record.frames.shift();
      record.receivedAt = receivedAt; record.seq = packet.seq;
      if (!sample.head) record.group.visible = false;
      for (const track of TRACKS) if (!sample[track]) record.tracks[track].visible = false;
      return true;
    },
    update(now) {
      if (disposed || !Number.isFinite(now)) return;
      stage.updateWorldMatrix(true, false); scene.updateWorldMatrix(true, false);
      const validStage = stage.matrixWorld.elements.every(Number.isFinite) && stage.matrixWorld.determinant() > 1e-8 && Math.abs(scene.matrixWorld.determinant()) > 1e-8;
      if (validStage) {
        // scene itself may be transformed: room.matrix is relative to that
        // parent, while every audience sample remains in the stage frame.
        room.matrix.copy(scene.matrixWorld).invert().multiply(stage.matrixWorld);
        room.matrixWorldNeedsUpdate = true;
      }
      for (const record of peers.values()) {
        const age = now - record.receivedAt;
        const head = atTime(record.frames, now - interpolationMs, 'head');
        record.group.visible = !!(validStage && head && age >= 0 && age <= ttlMs);
        if (!record.group.visible) continue;
        for (const track of TRACKS) {
          const pose = track === 'head' ? head : atTime(record.frames, now - interpolationMs, track);
          const object = record.tracks[track]; object.visible = !!pose;
          if (pose) { object.position.fromArray(pose.position); object.quaternion.fromArray(pose.quaternion); }
        }
      }
    },
    clear,
    dispose() {
      if (disposed) return;
      disposed = true; clear(); scene.remove(room);
      for (const item of Object.values(geometry)) item.dispose();
      for (const item of [materials.shell, materials.dark, materials.eye, ...materials.accents]) item.dispose();
    },
  };
}
