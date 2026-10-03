/** Coordinate the countdown and motion samples with the accompaniment clock. */
export class MusicCapture {
  constructor({recorder, audio, now = () => performance.now()}) {
    this.recorder = recorder;
    this.audio = audio;
    this.now = now;
    this.generation = 0;
    this.countdownAt = null;
    this.preparing = false;
    this.withMusic = false;
    this.error = null;
  }

  get pending() { return this.preparing || this.countdownAt !== null; }

  async arm({withMusic = true, referenceSpaceType = 'local', countdownSeconds = 3} = {}) {
    this.cancel();
    if (![3, 5, 10].includes(countdownSeconds)) throw new RangeError('開始までの秒数が不正です。');
    const generation = this.generation;
    this.withMusic = withMusic;
    this.referenceSpaceType = referenceSpaceType;
    this.error = null;
    this.preparing = true;
    try {
      // Called from the trigger gesture; prepare resumes AudioContext immediately.
      if (withMusic) await this.audio.prepare();
      if (generation !== this.generation) return;
      this.preparing = false;
      this.countdownAt = this.now() + countdownSeconds * 1000;
    } catch {
      if (generation !== this.generation) return;
      this.preparing = false;
      this.error = `音楽を準備できません。${this.referenceSpaceType==='camera'?'「収録を開始」':'トリガー'}で再試行してください。`;
    }
  }

  cancel() {
    ++this.generation;
    this.preparing = false;
    this.countdownAt = null;
    this.audio.stop();
  }

  tick(timeMs, tracking) {
    if (this.countdownAt !== null && this.now() >= this.countdownAt) {
      // Neither the song nor the recording starts without a usable first pose.
      const cameraEstimate = tracking?.source === 'camera-pose' && tracking?.referenceSpace === 'camera';
      if (!tracking?.origin || !tracking.sample?.head || (tracking.sample.head.emulatedPosition && !cameraEstimate) || tracking.sample.visibility !== 'visible') return null;
      this.countdownAt = null;
      try {
        if (this.withMusic) this.audio.play(0);
        this.recorder.start({referenceSpaceType: this.referenceSpaceType});
        this.recorder.recordSample(this.withMusic ? 0 : timeMs, tracking);
      } catch {
        this.cancel();
        this.error = `音楽を開始できません。${this.referenceSpaceType==='camera'?'「収録を開始」':'トリガー'}で再試行してください。`;
        return null;
      }
    }
    if (this.recorder.state !== 'recording') return null;
    if (this.withMusic && this.audio.ready === false) {
      const clip = this.finish();
      this.error = '音声が中断されたため、ここまでの収録を保存しました。';
      return clip;
    }
    // The audio clock also drives recorded timestamps, so rendering jitter
    // cannot accumulate drift between a take and its backing track.
    // A camera pose describes the frame before inference, not the later result
    // callback. Subtract processing time from the song clock for that sample.
    const inferenceDelay = this.referenceSpaceType === 'camera' ? Math.max(0, this.now() - timeMs) : 0;
    this.recorder.recordSample(this.withMusic ? Math.max(0, this.audio.time * 1000 - inferenceDelay) : timeMs, tracking);
    if (this.withMusic && this.audio.time >= this.audio.duration) return this.finish();
    return null;
  }

  finish() {
    const clip = this.recorder.state === 'recording' ? this.recorder.stop() : null;
    if (clip && this.withMusic) clip.accompaniment = {track: 'neon-door', offset: 0};
    this.cancel();
    return clip;
  }
}
