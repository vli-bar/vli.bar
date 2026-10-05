import * as THREE from 'three';
import { MAX_CAPTURE_SECONDS, MOTION_FORMAT, MOTION_VERSION, validateMotionClip } from './motion-data.js';
import { readBodyJoints } from './body-tracking.js';

const round = value => Math.round(value * 1e6) / 1e6;
const SPACES = ['local', 'local-floor', 'bounded-floor', 'unbounded', 'camera'];
const hiddenSample = (t = 0, visibility = 'hidden') => ({ t, visibility, head: null, left: null, right: null, body: null });

/**
 * Read tracking at XR display frequency, independently of the recording state.
 * Reset once on session entry/recentering. The same sample is used for the live
 * avatar and recorder, so countdown/recording never choose different origins.
 */
export class LiveMotionSampler {
  constructor(options = {}) { this.reset(options); }

  reset({ referenceSpaceType = 'local' } = {}) {
    if (!SPACES.includes(referenceSpaceType)) throw new Error('参照空間が未対応です。');
    this.referenceSpace = referenceSpaceType;
    this.origin = null;
    this.initialHeadHeight = null;
    this.startedAt = null;
    this.inverseYaw = new THREE.Quaternion();
    this.latest = null;
    return this;
  }

  relativePose(pose, source) {
    if (!this.origin || !pose?.transform) return null;
    const { position, orientation } = pose.transform;
    const values = [position?.x, position?.y, position?.z, orientation?.x, orientation?.y, orientation?.z, orientation?.w];
    if (!values.every(Number.isFinite)) return null;
    const p = new THREE.Vector3(position.x, position.y, position.z)
      .sub(new THREE.Vector3().fromArray(this.origin.position)).applyQuaternion(this.inverseYaw);
    const q = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
    if (!Number.isFinite(q.lengthSq()) || q.lengthSq() < .0001 || p.length() > 100) return null;
    q.normalize().premultiply(this.inverseYaw);
    return { position: p.toArray().map(round), quaternion: q.toArray().map(round), emulatedPosition: pose.emulatedPosition === true, ...(source ? { source } : {}) };
  }

  calibrate(viewer, timeMs) {
    if (viewer?.emulatedPosition) return false;
    const { position: p, orientation: q } = viewer?.transform ?? {};
    if (![p?.x, p?.y, p?.z, q?.x, q?.y, q?.z, q?.w].every(Number.isFinite)) return false;
    if ([p.x, p.y, p.z].some(value => Math.abs(value) > 100) || Math.hypot(q.x, q.y, q.z, q.w) < .0001) return false;
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w).normalize());
    const yaw = direction.x * direction.x + direction.z * direction.z > .0001 ? Math.atan2(-direction.x, -direction.z) : 0;
    const orientation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.origin = { position: [p.x, p.y, p.z].map(round), quaternion: orientation.toArray().map(round), emulatedPosition: viewer.emulatedPosition === true };
    this.inverseYaw.copy(orientation).invert();
    this.initialHeadHeight = this.referenceSpace.includes('floor') && p.y >= .3 && p.y <= 3 ? round(p.y) : null;
    this.startedAt = timeMs;
    return true;
  }

  sampleFrame(timeMs, frame, referenceSpace) {
    const visibility = ['visible', 'visible-blurred', 'hidden'].includes(frame?.session?.visibilityState) ? frame.session.visibilityState : 'visible';
    const result = { sample: hiddenSample(0, visibility), origin: this.origin, initialHeadHeight: this.initialHeadHeight, referenceSpace: this.referenceSpace,
      sources: { left: 'unavailable', right: 'unavailable' }, bodyStatus: 'unavailable', bodyCount: 0, bodyEmulatedCount: 0 };
    if (!frame || !referenceSpace || !Number.isFinite(timeMs)) { result.sample.visibility = 'hidden'; this.latest = result; return result; }
    let viewer = null;
    if (visibility === 'visible') try { viewer = frame.getViewerPose(referenceSpace); } catch { /* not tracked */ }
    if (!this.origin && !this.calibrate(viewer, timeMs)) { this.latest = result; return result; }
    result.origin = this.origin; result.initialHeadHeight = this.initialHeadHeight;
    result.sample.t = round(Math.max(0, (timeMs - this.startedAt) / 1000));
    if (visibility === 'visible') {
      result.sample.head = this.relativePose(viewer, 'viewer');
      for (const input of frame.session?.inputSources ?? []) {
        if (!['left', 'right'].includes(input.handedness)) continue;
        // visionOS exposes a separate, short-lived input for each gaze/pinch
        // gesture. Its grip is the pinch point, not a continuously tracked hand.
        // Hand tracking arrives through persistent XRHand inputs instead.
        if (input.targetRayMode === 'transient-pointer') continue;
        const side = input.handedness;
        let tracked = null;
        // Standard XRHand wrist input is optional. A controller is still usable
        // when hand tracking is absent or a wrist cannot currently be tracked.
        try {
          const wrist = input.hand?.get?.('wrist');
          if (wrist && typeof frame.getJointPose === 'function') tracked = this.relativePose(frame.getJointPose(wrist, referenceSpace), 'hand-wrist');
        } catch { /* optional source */ }
        if (!tracked && input.gripSpace) {
          try { tracked = this.relativePose(frame.getPose(input.gripSpace, referenceSpace), 'controller-grip'); } catch { /* not tracked */ }
        }
        // Prefer a tracked hand wrist if the UA exposes both inputs for a hand.
        if (tracked && (result.sources[side] !== 'hand-wrist' || tracked.source === 'hand-wrist')) {
          result.sample[side] = tracked; result.sources[side] = tracked.source;
        }
      }
      const body = readBodyJoints(frame, referenceSpace, pose => this.relativePose(pose));
      result.sample.body = body.joints; result.bodyStatus = body.status;
      result.bodyCount = body.jointCount; result.bodyEmulatedCount = body.emulatedCount;
    }
    this.latest = result;
    return result;
  }
}

/** Bounded recorder. Display sampling remains independent of its 30 Hz gate. */
export class MotionRecorder {
  constructor({ fps = 30, maxDuration = MAX_CAPTURE_SECONDS, onLimit = null } = {}) {
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error('fps must be 1–60');
    if (!Number.isFinite(maxDuration) || maxDuration <= 0 || maxDuration > MAX_CAPTURE_SECONDS) throw new Error('maxDuration must be 0–180 seconds');
    this.fps = fps; this.maxDuration = maxDuration; this.onLimit = onLimit;
    this.state = 'idle'; this.lastClip = null; this.frames = []; this.origin = null; this.startedAt = null;
    this.sampler = new LiveMotionSampler();
  }

  get duration() { return this.frames.at(-1)?.t ?? 0; }
  get frameCount() { return this.frames.length; }

  start({ referenceSpaceType = 'local' } = {}) {
    if (this.state === 'recording') throw new Error('すでに録画中です。');
    this.sampler.reset({ referenceSpaceType });
    this.referenceSpaceType = referenceSpaceType;
    this.frames = []; this.origin = null; this.startedAt = null; this.initialHeadHeight = null;
    this.state = 'recording';
    return this;
  }

  // Kept for existing integrations. New UI should read once with a live sampler
  // and pass that exact result to recordSample and applyMotionSampleToVRM.
  recordFrame(timeMs, frame, referenceSpace) {
    if (this.state !== 'recording' || !frame || !referenceSpace || !Number.isFinite(timeMs)) return false;
    return this.recordSample(timeMs, this.sampler.sampleFrame(timeMs, frame, referenceSpace));
  }

  recordSample(timeMs, tracking) {
    if (this.state !== 'recording' || !Number.isFinite(timeMs) || !tracking?.sample) return false;
    if (!this.origin) {
      if (!tracking.origin || !tracking.sample.head) return false;
      this.origin = structuredClone(tracking.origin);
      this.initialHeadHeight = tracking.initialHeadHeight ?? null;
      this.referenceSpaceType = tracking.referenceSpace;
      this.startedAt = timeMs;
    }
    const elapsed = Math.max(0, (timeMs - this.startedAt) / 1000);
    if (this.frames.length && elapsed < this.duration + 1 / this.fps - .001) return false;
    const t = round(Math.min(elapsed, this.maxDuration));
    if (this.frames.length && t <= this.duration) return false;
    // Never timestamp a pose resumed after suspension as a measurement made at
    // the earlier cap time. Snapshot values so live consumers cannot mutate it.
    const sample = elapsed <= this.maxDuration + .001 ? structuredClone(tracking.sample) : hiddenSample(t);
    sample.t = t;
    this.frames.push(sample);
    if (elapsed >= this.maxDuration || this.frames.length >= this.maxDuration * this.fps + 1) {
      const clip = this.stop(); this.onLimit?.(clip);
    }
    return true;
  }

  stop() {
    if (this.state !== 'recording') return this.lastClip;
    this.state = 'complete';
    if (!this.frames.length || !this.origin) return null;
    this.lastClip = validateMotionClip({ format: MOTION_FORMAT, version: MOTION_VERSION, units: 'meters', coordinates: 'right-handed-y-up-head-origin',
      referenceSpace: this.referenceSpaceType, fps: this.fps, duration: this.duration, origin: this.origin, initialHeadHeight: this.initialHeadHeight, frames: this.frames });
    return this.lastClip;
  }

  cancel() { this.frames = []; this.origin = null; this.startedAt = null; this.state = 'idle'; }
}
