import test from 'node:test';
import assert from 'node:assert/strict';
import { cue, DURATION, BPM, SECTIONS } from '../src/timeline.js';
import { readFileSync } from 'node:fs';

const motion = JSON.parse(readFileSync('public/demo/motion.json'));
const wav = readFileSync('public/demo/neon-door.wav');
function wavChunks(buffer) {
  assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buffer.toString('ascii', 8, 12), 'WAVE');
  const chunks = {};
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4);
    chunks[buffer.toString('ascii', offset, offset + 4)] = buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  return chunks;
}

test('curtain and musical sections cover the complete performance continuously', () => {
  assert.equal(cue(-1).curtain, 0);
  assert.equal(cue(2).curtain, 1);
  assert.equal(cue(6).curtain, 0);
  assert.equal(cue(70).curtain, 0);
  assert.equal(cue(DURATION).curtain, 1);
  assert.equal(cue(DURATION + 100).curtain, 1);
  assert.equal(cue(NaN).label, 'STANDBY');
  for (let t = 0; t <= DURATION; t += .01) {
    assert.ok(cue(t).curtain >= 0 && cue(t).curtain <= 1);
    if (t > 0) assert.ok(Math.abs(cue(t).curtain - cue(t - .01).curtain) < .01);
  }
  assert.equal(SECTIONS[0].start, 0);
  assert.equal(SECTIONS.at(-1).end, DURATION);
  for (let i = 1; i < SECTIONS.length; i++) assert.equal(SECTIONS[i].start, SECTIONS[i - 1].end);
  assert.deepEqual(motion.sections.map(({ start, end, label }) => ({ start, end, label })), SECTIONS);
});

test('original stereo soundtrack matches the choreography and retains headroom', () => {
  const chunks = wavChunks(wav);
  const fmt = chunks['fmt '];
  const pcm = chunks.data;
  assert.equal(fmt.readUInt16LE(0), 1, 'PCM encoding');
  assert.equal(fmt.readUInt16LE(2), 2, 'stereo');
  assert.equal(fmt.readUInt32LE(4), motion.sampleRate);
  assert.equal(fmt.readUInt16LE(14), 16);
  assert.equal(pcm.length / fmt.readUInt32LE(8), DURATION);
  let peak = 0;
  let energy = 0;
  let sideEnergy = 0;
  let initial = 0;
  let final = 0;
  const frames = pcm.length / 4;
  const edgeFrames = Math.round(motion.sampleRate * .01);
  for (let frame = 0; frame < frames; frame++) {
    const left = pcm.readInt16LE(frame * 4) / 32768;
    const right = pcm.readInt16LE(frame * 4 + 2) / 32768;
    assert.ok(Number.isFinite(left) && Number.isFinite(right));
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
    energy += (left * left + right * right) / 2;
    sideEnergy += (left - right) ** 2;
    if (frame < edgeFrames) initial = Math.max(initial, Math.abs(left), Math.abs(right));
    if (frame >= frames - edgeFrames) final = Math.max(final, Math.abs(left), Math.abs(right));
  }
  assert.ok(peak > .5 && peak < .92, `peak ${peak} preserves headroom`);
  assert.ok(Math.sqrt(energy / frames) > .08, 'audible mix');
  assert.ok(sideEnergy / energy > .01, 'stereo has meaningful width');
  assert.ok(initial < .02 && final < .005, 'click-free beginning and faded tail');
  for (const section of motion.sections.slice(1, -1)) {
    let sum = 0;
    for (let frame = section.start * motion.sampleRate; frame < section.end * motion.sampleRate; frame += 64) {
      sum += Math.abs(pcm.readInt16LE(frame * 4));
    }
    assert.ok(sum > 10000, `${section.id} is audible`);
  }
});

test('authored choreography is continuous, VRM-normalized, and covers expressive phrases', () => {
  assert.equal(motion.duration, DURATION);
  assert.equal(motion.bpm, BPM);
  assert.equal(motion.frames.at(-1).t, DURATION);
  assert.equal(motion.frames.length, DURATION * motion.fps + 1);
  assert.ok(motion.frames[0].bones.leftUpperArm[2] < 0, 'left arm lowers from +X');
  assert.ok(motion.frames[0].bones.rightUpperArm[2] > 0, 'right arm lowers from -X');
  let maxChange = 0;
  for (let i = 0; i < motion.frames.length; i++) {
    const frame = motion.frames[i];
    assert.ok(Math.abs(frame.t - i / motion.fps) < .000001);
    assert.equal(frame.aa, 0, 'instrumental does not pretend to sing');
    assert.ok(frame.blink >= 0 && frame.blink <= 1);
    assert.ok(frame.happy >= 0 && frame.happy <= 1);
    assert.ok(frame.root.every(Number.isFinite));
    assert.ok(Math.hypot(...frame.root) < .025, 'root movement keeps feet close to planted');
    for (const [bone, rot] of Object.entries(frame.bones)) {
      assert.equal(rot.length, 3);
      assert.ok(rot.every(value => Number.isFinite(value) && Math.abs(value) < Math.PI));
      if (i) rot.forEach((value, axis) => {
        maxChange = Math.max(maxChange, Math.abs(value - motion.frames[i - 1].bones[bone][axis]));
      });
    }
  }
  assert.ok(maxChange < .21, `no abrupt pose jumps (${maxChange} rad/frame)`);
  const poses = new Set(motion.choreography.map(key => key.pose));
  for (const pose of ['welcome', 'sway_left', 'sway_right', 'heart', 'reach_left', 'reach_right', 'celebrate', 'bow']) assert.ok(poses.has(pose));
  assert.ok(motion.frames.some(frame => frame.bones.spine[0] > .3), 'final bow is present');
  assert.ok(motion.frames.some(frame => frame.blink > .9), 'natural blinks are present');
});
