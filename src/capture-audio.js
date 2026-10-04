const clamp = (value, maximum) => Math.max(0, Math.min(maximum, value));

function defaultContext() {
  if (!globalThis.AudioContext) throw new Error('このブラウザではWeb Audioを利用できません。');
  return new globalThis.AudioContext();
}

/**
 * Reusable, decoded soundtrack transport. Call prepare() directly in a user
 * gesture; context creation and resume() happen before its first await. Loading
 * never starts playback. time uses the audio clock, so rendering delays do not
 * accumulate drift. Microphone input and recording are outside this class.
 */
export class CaptureAudio {
  constructor({ url, volume = .6, createContext = defaultContext, fetchAudio = globalThis.fetch?.bind(globalThis) } = {}) {
    if (!url) throw new Error('収録用音源のURLがありません。');
    if (typeof createContext !== 'function' || typeof fetchAudio !== 'function') throw new Error('音声の初期化機能がありません。');
    this.url = url;
    this.createContext = createContext;
    this.fetchAudio = fetchAudio;
    this.context = null;
    this.buffer = null;
    this.gain = null;
    this._loadPromise = null;
    this._source = null;
    this._generation = 0;
    this._position = 0;
    this._startedAt = 0;
    this.setVolume(volume);
  }

  get duration() { return this.buffer?.duration ?? 0; }
  get ready() { return !!this.buffer && this.context?.state === 'running'; }
  // On Safari an interruption can retain a live source while its audio clock
  // is suspended. It is not playing until a user gesture resumes the context.
  get playing() { return this.context?.state === 'running' && this._source !== null && this.time < this.duration; }
  get time() {
    const elapsed = this._source ? Math.max(0, this.context.currentTime - this._startedAt) : 0;
    return clamp(this._position + elapsed, this.duration);
  }

  async prepare() {
    if (!this.context) {
      this.context = this.createContext();
      this.gain = this.context.createGain();
      this.gain.gain.setValueAtTime(this._volume, this.context.currentTime);
      this.gain.connect(this.context.destination);
    }
    if (this.context.state === 'closed') throw new Error('音声が終了しています。ページを再読み込みしてください。');
    // Deliberately invoked synchronously in the initiating user gesture.
    const resumed = this.context.resume();
    const loaded = this._load();
    await Promise.all([resumed, loaded]);
    if (this.context.state !== 'running') throw new Error('音声を有効化できません。操作ボタンをもう一度押してください。');
    return this;
  }

  _load() {
    if (this.buffer) return Promise.resolve(this.buffer);
    if (this._loadPromise) return this._loadPromise;
    const pending = (async () => {
      const response = await this.fetchAudio(this.url);
      if (!response?.ok) throw new Error(`収録用音源を読み込めません（HTTP ${response?.status ?? 'error'}）。`);
      const bytes = await response.arrayBuffer();
      const buffer = await this.context.decodeAudioData(bytes);
      if (!Number.isFinite(buffer?.duration) || buffer.duration <= 0) throw new Error('収録用音源の長さが不正です。');
      this.buffer = buffer;
      return buffer;
    })();
    this._loadPromise = pending;
    // A failed network/decode attempt can be retried by the next user gesture.
    pending.catch(() => { if (this._loadPromise === pending) this._loadPromise = null; });
    return pending;
  }

  _detachSource() {
    const source = this._source;
    this._source = null;
    ++this._generation;
    if (!source) return;
    source.onended = null;
    try { source.stop(); } finally { source.disconnect(); }
  }

  _offset(value) {
    if (!Number.isFinite(value)) throw new RangeError('再生位置には有限の秒数を指定してください。');
    return clamp(value, this.duration);
  }

  play(offset = 0) {
    if (!this.buffer || !this.context) throw new Error('収録用音源の準備ができていません。');
    if (this.context.state !== 'running') throw new Error('音声が停止しています。操作ボタンから音声を有効化してください。');
    const position = this._offset(offset);
    this._detachSource();
    this._position = position;
    // Seeking to the endpoint should not create a silent or immediately-ended
    // source, and the UI can still display the final position.
    if (position >= this.duration) return this;
    const source = this.context.createBufferSource();
    const generation = this._generation;
    try {
      source.buffer = this.buffer;
      source.connect(this.gain);
      source.onended = () => {
        if (generation !== this._generation || this._source !== source) return;
        this._position = this.duration;
        this._source = null;
        source.onended = null;
        source.disconnect();
      };
      this._startedAt = this.context.currentTime;
      this._source = source;
      source.start(this._startedAt, position);
    } catch (error) {
      if (this._source === source) this._source = null;
      ++this._generation;
      source.onended = null;
      source.disconnect();
      throw error;
    }
    return this;
  }

  pause() {
    this._position = this.time;
    this._detachSource();
    return this;
  }

  stop() {
    this._position = 0;
    this._detachSource();
    return this;
  }

  /** Seek without making sound when paused; restart a playing source at offset. */
  seek(offset) {
    const position = this._offset(offset);
    if (this.playing) return this.play(position);
    this._detachSource();
    this._position = position;
    return this;
  }

  setVolume(value) {
    if (!Number.isFinite(value)) throw new RangeError('音量には有限の数値を指定してください。');
    this._volume = clamp(value, 1);
    if (this.gain) this.gain.gain.setValueAtTime(this._volume, this.context.currentTime);
    return this;
  }
}
