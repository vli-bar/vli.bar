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

  async arm({withMusic = true, referenceSpaceType = 'local'} = {}) {
    this.cancel();
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
      this.countdownAt = this.now() + 3000;
    } catch {
      if (generation !== this.generation) return;
      this.preparing = false;
      this.error = '音楽を準備できません。トリガーで再試行してください。';
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
      if (!tracking?.origin || !tracking.sample?.head || tracking.sample.head.emulatedPosition || tracking.sample.visibility !== 'visible') return null;
      this.countdownAt = null;
      try {
        if (this.withMusic) this.audio.play(0);
        this.recorder.start({referenceSpaceType: this.referenceSpaceType});
        this.recorder.recordSample(this.withMusic ? 0 : timeMs, tracking);
      } catch {
        this.cancel();
        this.error = '音楽を開始できません。トリガーで再試行してください。';
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
    this.recorder.recordSample(this.withMusic ? this.audio.time * 1000 : timeMs, tracking);
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
