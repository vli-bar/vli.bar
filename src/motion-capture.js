import * as THREE from 'three';
import { MAX_CAPTURE_SECONDS, MOTION_FORMAT, MOTION_VERSION, validateMotionClip } from './motion-data.js';

const round = value => Math.round(value * 1e6) / 1e6;

/** Bounded WebXR recorder. Only call recordFrame from renderer.setAnimationLoop. */
export class MotionRecorder {
  constructor({ fps = 30, maxDuration = MAX_CAPTURE_SECONDS, onLimit = null } = {}) {
    if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error('fps must be 1–60');
    if (!Number.isFinite(maxDuration) || maxDuration <= 0 || maxDuration > MAX_CAPTURE_SECONDS) throw new Error('maxDuration must be 0–180 seconds');
    this.fps = fps;
    this.maxDuration = maxDuration;
    this.onLimit = onLimit;
    this.state = 'idle';
    this.lastClip = null;
    this.frames = [];
    this.origin = null;
    this.startedAt = null;
    this.inverseYaw = new THREE.Quaternion();
  }

  get duration() { return this.frames.at(-1)?.t ?? 0; }
  get frameCount() { return this.frames.length; }

  start({ referenceSpaceType = 'local' } = {}) {
    if (this.state === 'recording') throw new Error('すでに録画中です。');
    if (!['local', 'local-floor', 'bounded-floor', 'unbounded'].includes(referenceSpaceType)) throw new Error('参照空間が未対応です。');
    this.referenceSpaceType = referenceSpaceType;
    this.frames = [];
    this.origin = null;
    this.startedAt = null;
    this.initialHeadHeight = null;
    this.state = 'recording';
    return this;
  }

  relativePose(pose) {
    if (!pose?.transform) return null;
    const { position, orientation } = pose.transform;
    const values = [position?.x, position?.y, position?.z, orientation?.x, orientation?.y, orientation?.z, orientation?.w];
    if (!values.every(Number.isFinite)) return null;
    const p = new THREE.Vector3(position.x, position.y, position.z)
      .sub(new THREE.Vector3().fromArray(this.origin.position)).applyQuaternion(this.inverseYaw);
    const q = new THREE.Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
    if (q.lengthSq() < .0001 || p.length() > 100) return null;
    q.normalize().premultiply(this.inverseYaw);
    return { position: p.toArray().map(round), quaternion: q.toArray().map(round), emulatedPosition: pose.emulatedPosition === true };
  }

  recordFrame(timeMs, frame, referenceSpace) {
    if (this.state !== 'recording' || !frame || !referenceSpace || !Number.isFinite(timeMs)) return false;
    const visibility = frame.session?.visibilityState ?? 'visible';
    let viewer = null;
    if (visibility === 'visible') {
      try { viewer = frame.getViewerPose(referenceSpace); } catch { /* tracking unavailable */ }
    }
    if (!this.origin) {
      const transform = viewer?.transform;
      if (!transform) return false;
      const { position: p, orientation: q } = transform;
      if (![p?.x, p?.y, p?.z, q?.x, q?.y, q?.z, q?.w].every(Number.isFinite)) return false;
      if ([p.x, p.y, p.z].some(value => Math.abs(value) > 100)) return false;
      if (Math.hypot(q.x, q.y, q.z, q.w) < .0001) return false;
      const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w).normalize());
      // Capture origin is the first head position with only its yaw removed.
      const yaw = Math.atan2(-direction.x, -direction.z);
      const orientation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      this.origin = { position: [p.x, p.y, p.z].map(round), quaternion: orientation.toArray().map(round), emulatedPosition: viewer.emulatedPosition === true };
      this.inverseYaw.copy(orientation).invert();
      this.initialHeadHeight = this.referenceSpaceType.includes('floor') && p.y >= .3 && p.y <= 3 ? round(p.y) : null;
      this.startedAt = timeMs;
    }
    const elapsed = Math.max(0, (timeMs - this.startedAt) / 1000);
    if (this.frames.length && elapsed < this.duration + 1 / this.fps - .001) return false;
    const t = round(Math.min(elapsed, this.maxDuration));
    if (this.frames.length && t <= this.duration) return false;
    const sample = { t, visibility: ['visible', 'visible-blurred', 'hidden'].includes(visibility) ? visibility : 'hidden', head: null, left: null, right: null };
    // If the browser suspended frames across the time limit, do not label a
    // resumed pose as though it had been measured at the earlier limit time.
    if (sample.visibility === 'visible' && elapsed <= this.maxDuration + .001) {
      sample.head = this.relativePose(viewer);
      for (const input of frame.session?.inputSources ?? []) {
        if (!input.gripSpace || !['left', 'right'].includes(input.handedness)) continue;
        try { sample[input.handedness] = this.relativePose(frame.getPose(input.gripSpace, referenceSpace)); } catch { /* retain null when tracking is lost */ }
      }
    }
    this.frames.push(sample);
    if (elapsed >= this.maxDuration || this.frames.length >= this.maxDuration * this.fps + 1) {
      const clip = this.stop();
      this.onLimit?.(clip);
    }
    return true;
  }

  stop() {
    if (this.state !== 'recording') return this.lastClip;
    this.state = 'complete';
    if (!this.frames.length || !this.origin) return null;
    const clip = validateMotionClip({
      format: MOTION_FORMAT, version: MOTION_VERSION, units: 'meters', coordinates: 'right-handed-y-up-head-origin',
      referenceSpace: this.referenceSpaceType, fps: this.fps, duration: this.duration,
      origin: this.origin, initialHeadHeight: this.initialHeadHeight, frames: this.frames,
    });
    this.lastClip = clip;
    return clip;
  }

  cancel() {
    this.frames = [];
    this.origin = null;
    this.startedAt = null;
    this.state = 'idle';
  }
}
