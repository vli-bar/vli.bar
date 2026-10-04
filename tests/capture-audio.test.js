import test from 'node:test';
import assert from 'node:assert/strict';
import { CaptureAudio } from '../src/capture-audio.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture({ duration = 72, fetchAudio, decodeAudioData } = {}) {
  const sources = [], calls = { create: 0, resume: 0, fetch: 0, decode: 0 };
  const context = {
    state: 'suspended', currentTime: 10, destination: {},
    resume() { calls.resume++; this.state = 'running'; return Promise.resolve(); },
    createGain() { return { gain: { value: 1, setValueAtTime(value) { this.value = value; } }, connect() {} }; },
    async decodeAudioData(bytes) { calls.decode++; return decodeAudioData ? decodeAudioData(bytes) : { duration }; },
    createBufferSource() {
      const source = { buffer: null, onended: null, stopped: false, disconnected: false,
        connect(node) { this.connectedTo = node; }, disconnect() { this.disconnected = true; },
        start(when, offset) { this.started = { when, offset }; },
        stop() { this.stopped = true; this.onended?.(); }, finish() { this.onended?.(); } };
      sources.push(source); return source;
    },
  };
  const transport = new CaptureAudio({ url: '/demo/neon-door.wav', volume: .6,
    createContext: () => { calls.create++; return context; },
    fetchAudio: async url => { calls.fetch++; return fetchAudio ? fetchAudio(url) : { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; },
  });
  return { transport, context, sources, calls };
}

test('prepare resumes in the initiating call and shares a single successful fetch/decode', async () => {
  const response = deferred();
  const { transport, context, sources, calls } = fixture({ fetchAudio: () => response.promise });
  const first = transport.prepare();
  assert.equal(calls.create, 1); assert.equal(calls.resume, 1, 'resume is invoked before yielding the user gesture');
  assert.equal(context.state, 'running'); assert.equal(calls.fetch, 1);
  const second = transport.prepare();
  assert.equal(calls.fetch, 1);
  response.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  await Promise.all([first, second]);
  await transport.prepare();
  assert.equal(calls.create, 1); assert.equal(calls.fetch, 1); assert.equal(calls.decode, 1);
  assert.equal(transport.ready, true); assert.equal(transport.duration, 72);
  assert.equal(sources.length, 0, 'preparation never starts playback');
});

test('audio-clock playback, pause, explicit resume offset and stop keep distinct positions', async () => {
  const { transport, context, sources } = fixture();
  await transport.prepare();
  transport.play(4);
  assert.deepEqual(sources[0].started, { when: 10, offset: 4 });
  context.currentTime = 12.5;
  assert.equal(transport.time, 6.5); assert.equal(transport.playing, true);
  transport.pause();
  assert.equal(transport.time, 6.5); assert.equal(transport.playing, false); assert.equal(sources[0].stopped, true);
  context.currentTime = 20;
  assert.equal(transport.time, 6.5);
  transport.play(transport.time);
  assert.equal(sources[1].started.offset, 6.5);
  context.currentTime = 22;
  assert.equal(transport.time, 8.5);
  transport.stop();
  assert.equal(transport.time, 0); assert.equal(transport.playing, false);
  transport.play();
  assert.equal(sources[2].started.offset, 0, 'default play restarts instead of retaining the paused offset');
});

test('natural completion holds the endpoint and a new run restarts without re-decoding', async () => {
  const { transport, context, sources, calls } = fixture({ duration: 5 });
  await transport.prepare(); transport.play();
  context.currentTime = 16;
  assert.equal(transport.time, 5); assert.equal(transport.playing, false);
  sources[0].finish();
  context.currentTime = 30;
  assert.equal(transport.time, 5); assert.equal(sources[0].disconnected, true);
  transport.play();
  assert.equal(transport.time, 0); assert.equal(transport.playing, true);
  context.currentTime = 31;
  assert.equal(transport.time, 1);
  transport.play(0);
  assert.equal(sources[1].stopped, true); assert.equal(transport.time, 0);
  assert.equal(calls.decode, 1); assert.equal(calls.fetch, 1);
});

test('late ended callbacks from stopped or replaced sources cannot finish a newer run', async () => {
  const { transport, context, sources } = fixture();
  await transport.prepare(); transport.play();
  const staleEnd = sources[0].onended;
  context.currentTime = 11; transport.play(8);
  staleEnd();
  assert.equal(transport.playing, true); assert.equal(transport.time, 8);
  const pausedEnd = sources[1].onended;
  transport.pause(); transport.play(2); pausedEnd();
  assert.equal(transport.playing, true); assert.equal(transport.time, 2);
  const stoppedEnd = sources[2].onended;
  transport.stop(); stoppedEnd();
  assert.equal(transport.time, 0); assert.equal(transport.playing, false);
});

test('stop during preparation never causes playback when fetch/decode eventually finishes', async () => {
  const decoded = deferred();
  const { transport, sources } = fixture({ decodeAudioData: () => decoded.promise });
  const preparation = transport.prepare();
  transport.stop();
  decoded.resolve({ duration: 72 });
  await preparation;
  assert.equal(transport.ready, true); assert.equal(transport.time, 0);
  assert.equal(transport.playing, false); assert.equal(sources.length, 0);
});

test('play requires prepared running audio; preparation rejects unresolved activation', async () => {
  const { transport, context } = fixture();
  assert.throws(() => transport.play(), /準備/);
  context.resume = () => Promise.resolve();
  await assert.rejects(transport.prepare(), /有効化/);
  assert.equal(transport.ready, false);
  assert.throws(() => transport.play(), /停止/);
  context.resume = () => { context.state = 'running'; return Promise.resolve(); };
  await transport.prepare(); transport.play();
  context.state = 'closed';
  await assert.rejects(transport.prepare(), /終了/);
});

test('Safari interruption pauses the soundtrack clock and a new gesture resumes the saved offset without reloading', async () => {
  const { transport, context, sources, calls } = fixture();
  await transport.prepare(); transport.play(4);
  context.currentTime = 12.5;
  context.state = 'interrupted';
  assert.equal(transport.ready, false); assert.equal(transport.playing, false);
  assert.equal(transport.time, 6.5);
  transport.pause();
  assert.equal(transport.time, 6.5); assert.equal(sources[0].stopped, true);
  const resume = transport.prepare();
  assert.equal(calls.resume, 2, 'resume is invoked inside the new gesture, before its first await');
  await resume;
  assert.equal(transport.playing, false, 'preparation does not unexpectedly resume a paused source');
  transport.play(transport.time);
  assert.equal(sources[1].started.offset, 6.5);
  assert.equal(transport.playing, true);
  assert.equal(calls.fetch, 1); assert.equal(calls.decode, 1);
});

test('an unresolved Safari interruption remains retryable and seeking during it cannot start sound', async () => {
  const { transport, context, sources } = fixture();
  await transport.prepare(); transport.play(4);
  context.state = 'interrupted';
  transport.seek(12);
  assert.equal(transport.time, 12); assert.equal(transport.playing, false);
  assert.equal(sources.length, 1); assert.equal(sources[0].stopped, true);
  context.resume = () => Promise.resolve();
  await assert.rejects(transport.prepare(), /もう一度/);
  assert.equal(transport.time, 12); assert.equal(transport.ready, false);
  context.resume = () => { context.state = 'running'; return Promise.resolve(); };
  await transport.prepare(); transport.play(transport.time);
  assert.equal(sources[1].started.offset, 12); assert.equal(transport.playing, true);
});

test('failed fetches can retry and failures are exposed to the caller', async () => {
  let available = false;
  const { transport, calls } = fixture({ fetchAudio: async () => available
    ? { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }
    : { ok: false, status: 503 } });
  await assert.rejects(transport.prepare(), /503/);
  available = true;
  await transport.prepare();
  assert.equal(calls.fetch, 2); assert.equal(calls.decode, 1);
  const decodeError = fixture({ decodeAudioData: async () => { throw new Error('broken WAV'); } });
  await assert.rejects(decodeError.transport.prepare(), /broken WAV/);
});

test('seek and endpoint clamping do not make sound while paused', async () => {
  const { transport, sources } = fixture();
  await transport.prepare(); transport.seek(12);
  assert.equal(transport.time, 12); assert.equal(transport.playing, false); assert.equal(sources.length, 0);
  transport.play(12); transport.seek(24);
  assert.equal(transport.time, 24); assert.equal(transport.playing, true); assert.equal(sources[0].stopped, true);
  transport.play(1000);
  assert.equal(transport.time, 72); assert.equal(transport.playing, false); assert.equal(sources.length, 2);
  transport.seek(-10);
  assert.equal(transport.time, 0);
  assert.throws(() => transport.play(NaN), /有限/);
  assert.throws(() => transport.seek(Infinity), /有限/);
});

test('volume applies to the shared gain and is bounded without altering playback position', async () => {
  const { transport, context } = fixture();
  transport.setVolume(.25); await transport.prepare();
  assert.equal(transport.gain.gain.value, .25);
  transport.play(); context.currentTime = 12;
  transport.setVolume(2); assert.equal(transport.gain.gain.value, 1);
  transport.setVolume(-1); assert.equal(transport.gain.gain.value, 0);
  assert.equal(transport.time, 2); assert.equal(transport.playing, true);
  assert.throws(() => transport.setVolume(NaN), /有限/);
});

test('a source start failure leaves transport stopped and propagates the original error', async () => {
  const { transport, context, sources } = fixture();
  await transport.prepare();
  const create = context.createBufferSource.bind(context);
  context.createBufferSource = () => { const source = create(); source.start = () => { throw new Error('audio device unavailable'); }; return source; };
  assert.throws(() => transport.play(3), /audio device unavailable/);
  assert.equal(transport.playing, false); assert.equal(transport.time, 3);
  assert.equal(sources[0].disconnected, true); assert.equal(sources[0].onended, null);
});
