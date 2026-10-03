import { Quaternion } from 'three';
import { interpolateBodyJoints } from './body-tracking.js';

function observedHead(frame) {
  const head = frame?.sample?.head;
  return !!head && frame.sample.visibility === 'visible' &&
    (!head.emulatedPosition || (frame.referenceSpace === 'camera' && head.source === 'camera-pose'));
}

/** A stalled camera must not turn an old observation into fresh network data. */
export function liveTrackingFrame(tracking, {now, observedAt, staleAfter = 1000}) {
  if (!observedHead(tracking) || !Number.isFinite(observedAt) || now < observedAt || now - observedAt >= staleAfter) return null;
  return {sample:tracking.sample, initialHeadHeight:tracking.initialHeadHeight, referenceSpace:tracking.referenceSpace};
}

function blendPose(a, b, weight) {
  // A missing joint is a tracking loss, never an invitation to extrapolate.
  if (!a || !b) return b;
  return {...b, position: a.position.map((v, i) => v + (b.position[i] - v) * weight),
    quaternion: new Quaternion().fromArray(a.quaternion).slerp(new Quaternion().fromArray(b.quaternion), weight).toArray()};
}

/** Receive-clock buffering avoids comparing clocks on different devices. */
export class LivePerformer {
  constructor({delay = 80, staleAfter = 1000} = {}) {
    this.delay = delay; this.staleAfter = staleAfter; this.clear();
  }
  clear() { this.id = null; this.frames = []; }
  setPeers(peers) {
    if (this.id && !peers.some(peer => peer.id === this.id && peer.role === 'performer')) this.clear();
  }
  receive(packet) {
    if (packet.role !== 'performer') return;
    if (packet.id !== this.id) { this.clear(); this.id = packet.id; }
    if (this.frames.length && packet.seq <= this.frames.at(-1).seq) return;
    if (this.frames.length && packet.receivedAt - this.frames.at(-1).receivedAt > this.staleAfter) this.frames = [];
    if (!observedHead(packet)) this.frames = [];
    this.frames.push(packet);
    if (this.frames.length > 12) this.frames.shift();
  }
  sample(now) {
    const last = this.frames.at(-1);
    if (!last || now - last.receivedAt > this.staleAfter || !observedHead(last)) return null;
    const at = now - this.delay;
    while (this.frames.length > 2 && this.frames[1].receivedAt <= at) this.frames.shift();
    let a = this.frames[0], b = a;
    for (const packet of this.frames) {
      if (packet.receivedAt <= at) a = packet;
      b = packet;
      if (packet.receivedAt >= at) break;
    }
    if (!a.sample.head || !b.sample.head || a.referenceSpace !== b.referenceSpace) return last;
    const weight = b.receivedAt === a.receivedAt ? 1 : Math.max(0, Math.min(1, (at - a.receivedAt) / (b.receivedAt - a.receivedAt)));
    const sample = {...b.sample};
    for (const key of ['head', 'left', 'right']) sample[key] = last.sample[key] ? blendPose(a.sample[key], b.sample[key], weight) : null;
    sample.body = interpolateBodyJoints(a.sample.body, b.sample.body, weight);
    // Do not resurrect a joint lost in the newest packet during interpolation.
    if (sample.body) for (const key of Object.keys(sample.body)) if (!last.sample.body?.[key]) delete sample.body[key];
    return {...b, sample};
  }
}
