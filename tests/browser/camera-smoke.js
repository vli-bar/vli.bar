// Development-only entry. This is not an app build entry or a camera permission
// test. Only getUserMedia is replaced; MediaPipe/WASM and recording are real.
import { CameraMotion } from '../../src/camera-motion.js';
import { CameraPoseSampler } from '../../src/camera-pose.js';
import { MotionRecorder } from '../../src/motion-capture.js';
import { serializeMotionClip, validateMotionClip } from '../../src/motion-data.js';

const el = id => document.getElementById(id);
const canvas = el('source');
const ctx = canvas.getContext('2d');
const pose = new CameraPoseSampler();
const recorder = new MotionRecorder({ fps: 15, maxDuration: 10, onLimit: clip => finish(clip) });
let stream = null, repaint = null, downloadUrl = null, stopping = false, startToken = 0;
const fixture = new Image();
fixture.src = './fixtures/pose.jpg';
const draw = () => {
  ctx.drawImage(fixture, 0, 0, canvas.width, canvas.height);
  // Alter a small corner so the canvas always produces a fresh video frame.
  ctx.fillStyle = '#102338'; ctx.fillRect(0, 0, 110, 18);
  ctx.fillStyle = 'white'; ctx.font = '11px monospace';
  ctx.fillText(`synthetic ${Math.round(performance.now())}`, 3, 12);
};
function tracks() { el('stream-tracks').textContent = stream?.getTracks().map(track => track.readyState).join(', ') || 'none'; }
function status(state, message) { el('status').dataset.state = state; el('status').textContent = message; }
const motion = new CameraMotion({
  video: el('camera-video'), maxFps: 15,
  wasmBaseUrl: new URL('/vendor/mediapipe/wasm', location.origin).href,
  modelAssetUrl: new URL('/vendor/mediapipe/pose_landmarker_lite.task', location.origin).href,
  deps: { mediaDevices: { getUserMedia() { stream = canvas.captureStream(15); tracks(); return Promise.resolve(stream); } } },
  onStatus(event) {
    status(event.state, event.message); el('ready').textContent = String(motion.ready); tracks();
    if (['hidden', 'ended', 'error'].includes(event.state) && !stopping) {
      finish();
      if (event.state === 'error') { status('failed', event.message); el('validation-result').textContent = 'failed'; }
    }
  },
  onFrame(result, timeMs) {
    const tracking = pose.sample(result, timeMs);
    el('landmark-count').textContent = String(result.landmarks?.[0]?.length || 0);
    el('usable-landmarks').textContent = String(tracking.landmarkCount);
    el('body-count').textContent = String(tracking.bodyCount);
    el('pose-quality').textContent = tracking.quality;
    recorder.recordSample(timeMs, tracking);
    el('recorded-frames').textContent = String(recorder.frameCount);
    el('duration').textContent = recorder.duration.toFixed(2);
    if (recorder.duration >= 2 && !stopping) finish();
  },
});

function finish(providedClip) {
  startToken++;
  stopping = true;
  motion.stop({ notify: false });
  clearInterval(repaint); repaint = null;
  el('ready').textContent = String(motion.ready); tracks();
  el('start').disabled = false; el('stop').disabled = true;
  try {
    const clip = providedClip ?? recorder.stop();
    if (!clip) {
      el('validation-result').textContent = 'no valid pose';
      status('no-pose', '有効な姿勢が得られる前に停止しました。');
      return;
    }
    const json = serializeMotionClip(clip);
    el('raw-json').value = json;
    const validated = validateMotionClip(JSON.parse(json));
    el('validation-result').textContent = 'passed';
    el('recorded-frames').textContent = String(validated.frames.length);
    el('duration').textContent = validated.duration.toFixed(2);
    if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = el('download'); link.href = downloadUrl; link.download = 'camera-smoke.motion.json'; link.hidden = false;
    el('result').textContent = JSON.stringify({ result: 'passed', input: 'official pose.jpg through canvas.captureStream; no camera',
      referenceSpace: validated.referenceSpace, tracking: validated.tracking, frameCount: validated.frames.length,
      duration: validated.duration, bytes: new Blob([json]).size, firstFrame: validated.frames[0] }, null, 2);
    status('passed', '実 WASM → 33 点検出 → 身体変換 → モーション録画 → JSON 検証が完了しました。');
  } catch (error) {
    el('validation-result').textContent = 'failed'; el('result').textContent = error.stack || error.message;
    status('failed', error.message);
  } finally { stopping = false; }
}

el('start').addEventListener('click', async () => {
  const token = ++startToken;
  el('start').disabled = true; el('stop').disabled = false; el('download').hidden = true;
  el('validation-result').textContent = 'running'; el('recorded-frames').textContent = '0';
  status('fixture', '公式画像を読み込んでいます…');
  try {
    await fixture.decode();
    if (token !== startToken) return;
    draw(); repaint = setInterval(draw, 1000 / 15);
    pose.reset(); recorder.start({ referenceSpaceType: 'camera' });
    await motion.start();
  } catch (error) {
    clearInterval(repaint); repaint = null; motion.stop({ notify: false }); recorder.cancel();
    el('start').disabled = false; el('stop').disabled = true;
    el('validation-result').textContent = 'failed'; el('result').textContent = error.stack || error.message;
    status('failed', `検証失敗: ${error.message}（fixture がなければ fixtures/README.md を参照）`);
  }
});
el('stop').addEventListener('click', () => finish());
window.addEventListener('pagehide', () => {
  motion.dispose(); clearInterval(repaint); if (downloadUrl) URL.revokeObjectURL(downloadUrl);
});
