import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { cue, DURATION } from './timeline.js';
import { validateDemoMotion } from './demo-motion.js';
import { buildStage } from './stage.js';
import { createXRHUD } from './xr-hud.js';
import { MotionRecorder, LiveMotionSampler } from './motion-capture.js';
import { validateMotionClip, applyMotionSampleToVRM, downloadMotionClip, MAX_MOTION_FILE_BYTES } from './motion-data.js';
import { saveTake, restoreTake } from './take-storage.js';
import { parseVRMA, createVRMAPlayer, downloadVRMA } from './vrma.js';
import { exportMotionVRMA } from './vrma-export.js';
import { WallPlacement } from './wall-placement.js';
import { createMotionPreview } from './motion-preview.js';
import { CaptureAudio } from './capture-audio.js';
import { MusicCapture } from './music-capture.js';
import { xrInputMode, xrSessionOptions } from './xr-session-options.js';
import { CameraMotion } from './camera-motion.js';
import { CameraPoseSampler } from './camera-pose.js';
import { LiveRoom } from './live-room.js';
import { LivePerformer, liveTrackingFrame } from './live-performer.js';
import { createLivePresence, sampleAudiencePose } from './live-presence.js';
import { discoverLocalVenue } from './local-venue.js';
import { resolvePlaybackSource, canResumeTake, startTakePlayback, applyPlaybackMotion } from './playback-source.js';

const $ = id => document.getElementById(id);
const asset = path => new URL(path, document.baseURI).href;
const formatTime = t => `${String(Math.floor(t / 60)).padStart(2,'0')}:${String(Math.floor(t % 60)).padStart(2,'0')}`;
const status = text => { $('status').textContent = text; };
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, .01, 100);
camera.position.set(.4, 1.45, 4.6);
let renderer;
try {
  renderer = new THREE.WebGLRenderer({antialias:true, alpha:true, stencil:true});
} catch {
  status('3D描画を開始できません。WebGLが使えるブラウザで開いてください。');
  throw new Error('WebGL initialization failed');
}
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');
renderer.setClearColor(0x171922, 1);
$('viewport').append(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.15, -.5);
controls.maxPolarAngle = Math.PI * .65;
controls.minDistance = 1; controls.maxDistance = 8;
controls.update();
const {stage, curtain, stencil} = buildStage(scene);
const hud = createXRHUD(scene);
const walls = new WallPlacement(scene);
const motionPreview = createMotionPreview(scene, stage);
const loader = new GLTFLoader();
loader.register(parser => new VRMLoaderPlugin(parser));
const audio = new Audio(asset('demo/neon-door.wav'));
audio.preload = 'auto'; audio.volume = .6;
const captureAudio = new CaptureAudio({url: asset('demo/neon-door.wav'), volume: .6});
const clock = new THREE.Clock();
let vrm = null, restHips = null, loading = false;
let session = null, sessionMode = null, xrBusy = false, arSupported = false, vrSupported = false;
let playing = false, finished = false, playRequest = 0, selectedTake = null, activeSource = 'demo', musicAudition = false;
let playbackChoice = 'demo', playbackChoiceMade = false;
let previewTime = 0, previewOrigin = 0, pendingPlacement = false, lastUI = 0;
let referenceSpaceType = 'local', liveTracking = null, previewAfterXR = false, autoplayAfterXR = true, xrInputReady = false, trackingReport = {state: 'not-started'};
let sessionInputMode = 'controller', pendingTouchPlacement = false;
let cameraActive = false, cameraBusy = false, cameraTracking = null, cameraRequest = 0, cameraObservedAt = -Infinity;
const cameraAvailable = isSecureContext && !!navigator.mediaDevices?.getUserMedia;
let liveRole = null, liveDevice = 'desktop', livePoseSentAt = -Infinity, sharedHead = false, localVenue = null;
const livePerformer = new LivePerformer();
const livePresence = createLivePresence(scene, stage);
const liveRoom = new LiveRoom({
  onState({state, message}) {
    $('lan-status').textContent = message;
    if (state === 'connected' && liveRole === 'audience') {
      stop(); activeSource = 'live'; $('track-title').textContent = 'LAN LIVE';
      status('LANルームに接続しました。出演者の配信をこの画面とARで視聴できます。');
    }
    if (state !== 'connected') {
      livePerformer.clear(); livePresence.clear(); sharedHead = false;
      $('lan-peers').replaceChildren();
      if (activeSource === 'live') {stop(); activeSource = resolvePlaybackSource(playbackChoice, selectedTake);updateTrackTitle();}
    }
    updateButtons();
  },
  onRoster({selfId, peers}) {
    livePresence.setPeers(peers, selfId); livePerformer.setPeers(peers);
    $('lan-peers').replaceChildren(...peers.map(peer => {
      const item = document.createElement('li');
      item.textContent = `${peer.role === 'performer' ? '出演者' : '観客'} / ${peer.name}`;
      return item;
    }));
  },
  onPose(packet) {livePerformer.receive(packet); livePresence.receive(packet);},
  onNotice(message) {$('lan-status').textContent = typeof message === 'string' ? message : message.message;},
});
function watchingLAN() {return liveRoom.connected && liveRole === 'audience';}
function liveDeviceChoice() {
  const choice = $('lan-device').value;
  return choice !== 'auto' ? choice : vrSupported ? 'headset' : /Android/i.test(navigator.userAgent) ? 'phone' : 'desktop';
}
$('lan-form').onsubmit = async event => {
  event.preventDefault();
  if (!localVenue || session || xrBusy || cameraActive || cameraBusy || !ready()) return;
  liveRole = $('lan-role').value; liveDevice = liveDeviceChoice(); livePoseSentAt = -Infinity;
  try {
    await liveRoom.connect({url: localVenue.origin, room: $('lan-room').value.trim(), token: $('lan-token').value,
      name: $('lan-name').value.trim(), role: liveRole, device: liveDevice});
    $('lan-token').value = '';
    if (liveRole === 'audience') $('stage').scrollIntoView({behavior: 'smooth', block: 'center'});
  } catch (error) {$('lan-status').textContent = error.message; updateButtons();}
};
$('lan-disconnect').onclick = () => liveRoom.disconnect();
discoverLocalVenue({origin:location.origin}).then(venue => {
  localVenue = venue;
  $('lan-url').value = venue?.origin ?? '';
  $('runtime-mode').textContent = venue ? '● LOCAL / インターネット不要' : '● LIVE LAB / PREVIEW';
  $('lan-mode').textContent = venue
    ? '会場PCに接続しています。アプリ・モデル・音源・姿勢推定・モーション通信は、この会場PCだけで動作します。'
    : 'LANライブは会場PCのアプリから参加します。オフラインキットを起動し、表示されたローカルIPのURLを全員の端末で開いてください。この公開プレビューから会場へは接続しません。';
  $('lan-status').textContent = venue ? '同じ会場PCのページを全員で開き、ルーム名と合言葉を合わせて参加してください。'
    : '会場アプリを開くと参加できます。起動方法は下の「オフラインの準備・起動手順」にあります。';
  updateButtons();
});
window.addEventListener('pagehide', () => liveRoom.disconnect());
const liveSampler = new LiveMotionSampler();
const recorder = new MotionRecorder({onLimit:clip => { if (clip) acceptTake(clip); endXR(); }});
const musicCapture = new MusicCapture({recorder, audio: captureAudio});
let haveUserTake = false, demoVRMA = null, demoPlayer = null, takePlayer = null;
const cameraSampler = new CameraPoseSampler();
const cameraRecorder = new MotionRecorder({fps: 15, onLimit: clip => {
  if(clip)acceptTake(clip);
  endCamera({autoplay: true});
}});
const cameraMusic = new MusicCapture({recorder: cameraRecorder, audio: captureAudio});
const viewerHome = document.createComment('live viewer home');
$('stage').before(viewerHome);
const cameraMotion = new CameraMotion({video: $('camera-video'), maxFps: 15,
  onFrame(result, timeMs) {
    if(!cameraActive || cameraBusy)return;
    cameraObservedAt = timeMs;
    cameraTracking = cameraSampler.sample(result, timeMs);
    const clip = cameraMusic.tick(timeMs, cameraTracking);
    if(clip){acceptTake(clip);endCamera({autoplay: !cameraMusic.error, message: cameraMusic.error});}
  },
  onStatus(event) {
    if(!cameraActive && !cameraBusy)return;
    $('camera-status').textContent = event.message;
    if(['hidden','ended','error'].includes(event.state))endCamera({autoplay: false, message: event.message});
  },
});

function ready() { return !!vrm && !!demoVRMA && !loading; }
function updateButtons() {
  const cameraOpen = cameraActive || cameraBusy;
  const busy = xrBusy || !!session || cameraOpen;
  const headset = vrSupported || (arSupported && xrInputMode($('xr-input-mode').value, vrSupported) === 'controller');
  const viewingLAN = watchingLAN();
  $('stop').textContent = viewingLAN ? 'LANから退出' : '停止・リセット';
  $('play').disabled = !ready() || busy || viewingLAN;
  $('model').disabled = loading || busy;
  $('motion-file').disabled = busy || viewingLAN;
  $('ar').disabled = !ready() || !arSupported || busy;
  $('record-xr').disabled = !ready() || !headset || busy || viewingLAN;
  $('record-music').disabled = xrBusy || !!session || cameraMusic.pending || cameraRecorder.state==='recording';
  $('music-check').disabled = !ready() || busy || viewingLAN;
  $('take-play').disabled = !ready() || !selectedTake || busy || viewingLAN;
  $('take-ar').disabled = !ready() || !selectedTake || !arSupported || busy || viewingLAN;
  $('playback-source').disabled = busy || viewingLAN;
  $('playback-take').disabled = !selectedTake;
  $('playback-source').value = playbackChoice;
  $('play').textContent = playbackChoice === 'take' ? 'モーションを再生 ▶' : 'ライブを再生 ▶';
  updateXRLabels();
  $('take-pause').disabled = !ready() || !selectedTake || activeSource !== 'take' || busy;
  $('take-music').disabled = !selectedTake?.accompaniment || busy;
  $('take-download').disabled = !selectedTake || !ready();
  $('raw-download').disabled = !selectedTake || selectedTake.format!=='vli.motion-capture';
  $('demo-motion').disabled = !demoVRMA || busy || viewingLAN;
  $('demo-reset').disabled = busy || viewingLAN;
  $('seek').disabled = busy || viewingLAN;
  $('exit-xr').hidden = !session;
  $('tracking-status').textContent = trackingSummary();
  for (const id of ['xr-input-mode','placement-mode', 'width', 'distance']) $(id).disabled = busy;
  $('camera-start').disabled = !ready() || !cameraAvailable || busy || viewingLAN;
  $('camera-record').disabled = !cameraActive || cameraBusy || !cameraMotion.ready;
  $('camera-stop').hidden = !cameraOpen;
  $('camera-stop').textContent = cameraRecorder.state==='recording' ? '保存してカメラを終了' : 'カメラを終了';
  $('camera-facing').disabled = busy;
  $('camera-delay').disabled = cameraMusic.pending || cameraRecorder.state==='recording';
  const joining = liveRoom.state === 'connecting';
  for (const id of ['lan-url','lan-room','lan-token','lan-name','lan-role','lan-device']) $(id).disabled = !localVenue || liveRoom.connected || joining;
  $('lan-connect').disabled = !localVenue || !ready() || busy || liveRoom.connected || joining;
  $('lan-disconnect').disabled = !liveRoom.connected && !joining;
}
function resetPose() {
  vrm?.humanoid.resetNormalizedPose();
  for(const name of ['aa','happy','blink'])vrm?.expressionManager?.setValue(name,0);
}
function duration() { return activeSource === 'take' && selectedTake ? selectedTake.duration : DURATION; }
function takeWithMusic() { return selectedTake?.accompaniment?.track === 'neon-door' && $('take-music').checked; }
function updateTrackTitle() {
  $('track-title').textContent = activeSource === 'live' ? 'LAN LIVE' : activeSource === 'take'
    ? takeWithMusic() ? 'MOTION PREVIEW / NEON DOOR' : 'MOTION PREVIEW' : 'NEON DOOR';
}
function choosePlayback(source) {
  stop();playbackChoiceMade = true;
  playbackChoice = resolvePlaybackSource(source, selectedTake);
  activeSource = playbackChoice;
  updateTrackTitle();updateButtons();
}
function playbackTime() {
  if (activeSource === 'live') return 0;
  if (activeSource === 'demo') return musicAudition ? captureAudio.time : audio.currentTime;
  if (playing && takeWithMusic()) return captureAudio.time >= captureAudio.duration ? duration()
    : Math.max(0, Math.min(duration(), captureAudio.time - selectedTake.accompaniment.offset));
  return playing ? Math.min(duration(), (performance.now() - previewOrigin) / 1000) : previewTime;
}
function stop(reset = true) {
  // Preserve the take's clock before stopping its accompaniment, including
  // pauses caused by XR visibility or tracking loss.
  if (!reset && activeSource === 'take') previewTime = playbackTime();
  ++playRequest;
  captureAudio.stop();
  musicAudition = false;$('music-check').textContent = '収録用の曲を試聴';
  audio.pause(); playing = false; finished = false;
  if(reset){audio.currentTime = 0; previewTime = 0; resetPose();}
}
async function playDemo({restart = true} = {}) {
  if(!ready() || watchingLAN())return;
  if (restart) choosePlayback('demo');
  else {stop(false);if (audio.ended) audio.currentTime = 0;}
  updateButtons();
  $('track-title').textContent = 'NEON DOOR';
  const request = ++playRequest;
  try {
    await audio.play();
    if(request !== playRequest){audio.pause();return;}
    playing = true;
    status('NEON DOOR — オリジナル音源と振り付けを再生中。');
  } catch {
    status('音声を開始できませんでした。ライブを再生ボタンをもう一度押してください。');
  }
}
function playTake({autoplay = true} = {}) {
  if(!ready() || !selectedTake)return;
  choosePlayback('take');
  if (!session) {
    camera.position.set(0, 1.3, 3.8);controls.target.set(0, .95, 0);controls.update();
    $('stage').scrollIntoView({behavior: 'smooth', block: 'center'});
  }
  if(autoplay)resumeTake();
  else status('収録を保存しました。「プレビューを再開」で曲と動きを確認できます。');
  updateButtons();
}
async function resumeTake() {
  const request = ++playRequest;
  const currentSession = session, take = selectedTake;
  const isCurrent = () => request === playRequest && session === currentSession && selectedTake === take && canResumeTake({
    source: activeSource, take, sessionMode, xrBusy, cameraOpen: cameraActive || cameraBusy,
    inputReady: xrInputReady, placed: !!walls.placed, tracking: !!walls.report.tracking,
    visibility: session?.visibilityState ?? document.visibilityState,
  });
  if (!isCurrent()) return;
  if (previewTime >= duration()) previewTime = 0;
  try {
    const withMusic = takeWithMusic();
    if (withMusic) status('プレビューの音楽を準備しています…');
    await startTakePlayback({audio: captureAudio, withMusic, offset: (take.accompaniment?.offset ?? 0) + previewTime,
      isCurrent, onStart() {
        previewOrigin = performance.now() - previewTime * 1000;
        playing = true;finished = false;
        status(withMusic ? 'NEON DOORに合わせてモーションをプレビュー中。' : 'モーションをプレビュー中（音楽なし）。');
      },
    });
  } catch {
    if (request !== playRequest) return;
    playing = false;
    status('音楽を開始できません。「プレビューを再開」で再試行するか、収録時の音楽をオフにしてください。');
  }
}
function toggleStagePlayback() {
  if (watchingLAN()) return;
  if (playing) {stop(false);return;}
  if (activeSource === 'take') return resumeTake();
  return playDemo({restart: false});
}
async function startCamera() {
  if(!ready() || watchingLAN() || session || xrBusy || cameraActive || cameraBusy)return;
  stop();activeSource='demo';cameraBusy=true;cameraActive=true;cameraTracking=null;cameraObservedAt=-Infinity;
  const request=++cameraRequest;
  cameraRecorder.cancel();cameraMusic.cancel();cameraMusic.error=null;cameraSampler.reset();
  $('camera-panel').hidden=false;$('camera-avatar-slot').append($('stage'));
  $('track-title').textContent='CAMERA MOTION / 推定';
  camera.position.set(0,1.3,3.8);controls.target.set(0,.95,0);controls.update();
  updateButtons();$('camera-studio').scrollIntoView({behavior:'smooth',block:'start'});
  // Unlock the accompaniment in this button gesture before camera permission.
  if($('record-music').checked)captureAudio.prepare().catch(()=>{});
  try {
    const started=await cameraMotion.start({facingMode:$('camera-facing').value});
    if(request!==cameraRequest)return;
    cameraBusy=false;
    if(!started){endCamera({autoplay:false});return;}
    $('camera-status').textContent='全身を映して動きを確認し、「収録を開始」を押してください。';
  } catch(error) {
    if(request!==cameraRequest)return;
    const message=error.name==='NotAllowedError'?'カメラが許可されていません。ブラウザのカメラ権限を確認して、もう一度準備してください。'
      :error.name==='NotFoundError'?'カメラが見つかりません。カメラのあるAndroidスマホで開いてください。'
      :'カメラを準備できません。カメラを使う他のアプリを閉じ、通信とブラウザを確認してください。';
    endCamera({autoplay:false,message});
  } finally {if(request===cameraRequest)updateButtons();}
}
function endCamera({autoplay = true, message = ''} = {}) {
  if(!cameraActive && !cameraBusy)return;
  ++cameraRequest;cameraActive=false;cameraBusy=false;
  const clip=cameraMusic.finish();
  if(clip)acceptTake(clip);
  const recorded=cameraRecorder.frameCount>0 && !!cameraRecorder.lastClip;
  cameraMotion.stop();cameraTracking=null;
  viewerHome.after($('stage'));$('camera-panel').hidden=true;$('camera-countdown').textContent='';
  stop();restorePreview();
  $('camera-record').textContent='収録を開始';
  $('camera-status').textContent=message || (recorded?'カメラの推定モーションを保存しました。プレビュー・VRMAダウンロードができます。':'カメラを終了しました。');
  updateButtons();
  if(recorded)playTake({autoplay});
}
async function cameraRecordAction() {
  if(!cameraActive || cameraBusy || !cameraMotion.ready)return;
  if(cameraMusic.pending){cameraMusic.cancel();updateButtons();return;}
  if(cameraRecorder.state==='recording'){endCamera();return;}
  const arming=cameraMusic.arm({withMusic:$('record-music').checked,referenceSpaceType:'camera',countdownSeconds:Number($('camera-delay').value)});
  updateButtons();await arming;updateButtons();
}
$('camera-start').onclick=startCamera;
$('camera-record').onclick=cameraRecordAction;
$('camera-stop').onclick=()=>endCamera();
if(!cameraAvailable)$('camera-status').textContent='カメラ収録にはHTTPSとカメラ対応ブラウザが必要です。AndroidのChromeで開いてください。';
window.addEventListener('pagehide',()=>{if(cameraActive || cameraBusy)endCamera({autoplay:false});});

async function loadModel(url) {
  loading = true; stop(); updateButtons(); status('VRMを読み込んでいます…');
  try {
    const gltf = await loader.loadAsync(url);
    const next = gltf.userData.vrm;
    if(!next)throw new Error('VRMではありません');
    VRMUtils.rotateVRM0(next);
    const bounds = new THREE.Box3().setFromObject(next.scene);
    const height = bounds.max.y - bounds.min.y;
    if(!Number.isFinite(height) || height < .01)throw new Error('モデルのサイズが不正です');
    next.scene.scale.setScalar(1.8 / height);
    next.scene.position.set(0, -bounds.min.y * 1.8 / height, -1.1);
    next.scene.traverse(object => {
      if(!object.isMesh)return;
      object.frustumCulled = false; object.renderOrder = 3;
      for(const material of (Array.isArray(object.material) ? object.material : [object.material]))stencil(material);
    });
    if(vrm){vrm.scene.removeFromParent(); VRMUtils.deepDispose(vrm.scene);}
    demoPlayer?.dispose();takePlayer?.dispose();
    vrm = next; stage.add(vrm.scene);
    demoPlayer = demoVRMA ? createVRMAPlayer(vrm,demoVRMA) : null;
    takePlayer = selectedTake?.format==='vrma' ? createVRMAPlayer(vrm,selectedTake) : null;
    restHips = vrm.humanoid.getNormalizedBoneNode('hips').position.clone();
    status('準備できました。ライブを再生すると幕が上がります。');
  } catch(error) {
    status('VRMを読み込めませんでした。別のVRMファイルを選択してください。');
    console.error(error);
  } finally {loading = false; updateButtons();}
}
$('model').addEventListener('change', async event => {
  const file = event.target.files[0]; if(!file)return;
  if(file.size > 64 * 1024 * 1024){status('VRMは64MB以内にしてください。');return;}
  const url = URL.createObjectURL(file);
  try{await loadModel(url);}finally{URL.revokeObjectURL(url);event.target.value='';}
});
$('play').onclick = () => playbackChoice === 'take' ? playTake() : playDemo();
$('playback-source').onchange = () => {
  choosePlayback($('playback-source').value);
  status(playbackChoice === 'take' ? '保存・アップロードしたモーションを選択しました。ページでもARでも確認できます。' : 'デモの音源と振り付けを選択しました。');
};
$('stop').onclick = () => {if(watchingLAN()){liveRoom.disconnect();status('ルームから退出しました。');return;}if(cameraActive || cameraBusy){endCamera();return;}if(sessionMode==='record'){finishRecording();endXR();}else stop();status('停止しました。再生または位置調整ができます。');};
$('take-play').onclick = playTake;
$('take-pause').onclick = () => {
  if (activeSource !== 'take' || !selectedTake || session) return;
  if (playing) {previewTime = playbackTime();stop(false);status('モーションを一時停止しました。再生位置のバーで動きを確認できます。');}
  else resumeTake();
};
$('take-music').onchange = () => {
  if (activeSource !== 'take' || session) return;
  // Restart both from zero when changing the accompaniment setting.
  playTake();
};
$('music-check').onclick = async () => {
  if (session || xrBusy) return;
  if (musicAudition) {stop();$('record-status').textContent='試聴を停止しました。';status('試聴を停止しました。');return;}
  stop();activeSource='demo';updateButtons();
  $('record-status').textContent='収録用の音楽を準備しています…';
  const request = ++playRequest;
  try {
    await captureAudio.prepare();
    if (request !== playRequest || session || xrBusy) return;
    captureAudio.play(0);
    musicAudition=true;playing=true;
    $('music-check').textContent='試聴を停止';
    $('track-title').textContent='NEON DOOR';
    $('record-status').textContent='NEON DOORを試聴中。音量はプレビュー画面で調整できます。';
    status('収録用の曲 NEON DOOR を試聴中。音量を調整できます。「停止・リセット」で止まります。');
  } catch { if(request===playRequest){$('record-status').textContent='音楽を準備できません。接続と音声許可を確認して再試行してください。';status($('record-status').textContent);} }
};
$('demo-motion').onclick = () => {if(demoVRMA){stop();acceptTake(demoVRMA);}};
$('demo-reset').onclick = () => {choosePlayback('demo');status('デモに戻しました。ライブを再生できます。');};
$('volume').oninput = () => {const volume=Number($('volume').value);audio.volume=volume;captureAudio.setVolume(volume);};
$('volume').addEventListener('input',()=>{$('xr-touch-volume').value=$('volume').value;});
$('xr-touch-volume').oninput=()=>{const volume=Number($('xr-touch-volume').value);audio.volume=volume;captureAudio.setVolume(volume);$('volume').value=volume;};
$('seek').oninput = () => {
  const time = Number($('seek').value);
  finished = false;
  if(activeSource === 'demo') {
    if (musicAudition) {try{captureAudio.play(time);playing=true;}catch{stop();status('試聴を再開できません。もう一度試聴ボタンを押してください。');}}
    else audio.currentTime = time;
  }
  else {
    const resume = playing;
    stop(false);previewTime = time;
    if (resume && time < duration()) resumeTake();
  }
};
audio.addEventListener('ended', () => {if(activeSource==='demo' && !cameraActive && !musicAudition && sessionMode!=='record'){playing=false;finished=true;status('終演しました。もう一度再生できます。');}});
audio.addEventListener('error', () => {if(activeSource==='demo' && !cameraActive && !musicAudition && sessionMode!=='record'){stop();status('音源を読み込めません。接続を確認して再読み込みしてください。');}});
for(const id of ['width','distance'])$(id).oninput = () => {
  $(id+'Value').textContent = Number($(id).value).toFixed(1)+' m';
  if(id==='width')stage.scale.setScalar(Number($(id).value)/2.4);
};

function trackingSummary() {
  if (trackingReport.state === 'not-started') return '取得できる頭・手・身体の情報を、収録画面で確認できます。';
  return trackingReport.summary || '追跡データを確認中…';
}
function updateTrackingReport() {
  const sample = liveTracking?.sample;
  const tracked = pose => pose ? pose.emulatedPosition ? '推定' : '取得' : '未取得';
  const bodyStatus = liveTracking?.bodyStatus || 'unavailable';
  const bodyCount = liveTracking?.bodyCount || 0;
  const body = bodyStatus === 'tracked' ? `身体 ${bodyCount}関節（端末の推定を含む）`
    : bodyStatus === 'not-tracked' ? '身体API許可済み・追跡待ち'
    : bodyStatus === 'error' ? '身体データ取得エラー・頭と手で推定' : '身体データ未提供・頭と手で推定';
  trackingReport = {...trackingReport, state: 'active', referenceSpace: referenceSpaceType,
    head: tracked(sample?.head), left: liveTracking?.sources?.left || 'unavailable', right: liveTracking?.sources?.right || 'unavailable',
    bodyStatus, bodyCount, bodyEmulatedCount: liveTracking?.bodyEmulatedCount || 0,
    summary: `頭 ${tracked(sample?.head)} / 左手 ${tracked(sample?.left)} / 右手 ${tracked(sample?.right)} / ${body}`};
  $('tracking-status').textContent = trackingReport.summary;
}
function acceptTake(clip) {
  if(!clip)return;
  takePlayer?.dispose();takePlayer=null;
  selectedTake = clip; haveUserTake = true;
  playbackChoice = 'take';playbackChoiceMade = true;activeSource = 'take';previewTime = 0;finished = false;
  $('take-music').checked = !!clip.accompaniment;
  updateTrackTitle();
  if(clip.format==='vrma'&&vrm)takePlayer=createVRMAPlayer(vrm,clip);
  $('take-info').textContent = `${formatTime(clip.duration)} · ${clip.format==='vrma'?'VRM Animation 1.0':clip.frames.length+' フレーム · '+(clip.format==='vli.motion-capture'?(clip.tracking?.body==='browser-body'?'頭・手・身体関節の収録':'頭・手の収録（身体は推定）'):'旧形式の振り付け')}`;
  if(clip.referenceSpace==='camera')$('take-info').textContent=`${formatTime(clip.duration)} · ${clip.frames.length} フレーム · カメラによる姿勢推定`;
  if (clip.accompaniment) $('take-info').textContent += ' · NEON DOORと同期';
  $('record-status').textContent = 'モーションを保存しました。プレビュー・ダウンロードできます。';
  updateButtons();
  saveTake(clip.format==='vrma'?{format:'vrma',bytes:clip.bytes}:clip).catch(() => {$('record-status').textContent='端末内の保存容量が不足しています。ダウンロードして保存してください。';});
}
function finishRecording() {
  const wasRecording = recorder.state === 'recording';
  const clip = musicCapture.finish();
  if(wasRecording) {
    if(clip)acceptTake(clip);
    else $('record-status').textContent='追跡データを取得できませんでした。再度お試しください。';
  }
}
async function endXR() { if(session)await session.end().catch(()=>{}); }
function restorePreview() {
  walls.end();pendingPlacement=false;xrInputReady=false;controls.enabled=true;
  pendingTouchPlacement=false;$('xr-touch-overlay').hidden=true;
  stage.visible=true;stage.position.set(0,0,0);stage.rotation.set(0,0,0);
  stage.scale.setScalar(Number($('width').value)/2.4);
  motionPreview.reset();liveTracking = null;
  renderer.setClearColor(0x171922,1);hud.update(camera,'','',false);resize();
}
async function select(event) {
  if(!session || !ready() || !xrInputReady)return;
  if(sessionMode==='live' && sessionInputMode==='touch')return;
  if (hud.select(event.frame, event.inputSource, renderer.xr.getReferenceSpace())) {
    finishRecording();await endXR();return;
  }
  if(sessionMode==='record') {
    if(musicCapture.pending){musicCapture.cancel();$('record-status').textContent='開始をキャンセルしました。';return;}
    if(recorder.state==='recording'){finishRecording();await endXR();}
    else musicCapture.arm({withMusic: $('record-music').checked, referenceSpaceType});
    return;
  }
  if (walls.placed) {
    if (watchingLAN()) return;
    if (walls.report.tracking) await toggleStagePlayback();
  } else {
    const placement = walls.confirm(event.frame, event.inputSource);
    if (!placement) return;
    stage.position.copy(placement.position);
    stage.quaternion.copy(placement.quaternion);
    stage.scale.setScalar(placement.width / 2.4);
    stage.visible = true;
  }
}
function reposition() {
  if (sessionMode === 'record' && recorder.state !== 'recording') {
    musicCapture.cancel();liveSampler.reset({referenceSpaceType});pendingPlacement = true;return;
  }
  if (sessionMode !== 'live') return;
  stop(); stage.visible = false;
  walls.reset({switchToManual: walls.mode === 'auto' && !walls.placed});
}
for(let i=0;i<2;i++) {
  const controller = renderer.xr.getController(i);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(.012,10,8),new THREE.MeshBasicMaterial({color:0xc6ff75}));
  controller.add(tip);scene.add(controller);
  // Visible controllers help users orient their hands in the recording room.
  const grip=renderer.xr.getControllerGrip(i);
  const marker=new THREE.Mesh(new THREE.SphereGeometry(.025,12,8),new THREE.MeshBasicMaterial({color:i?0xb8a0ff:0xc6ff75}));
  grip.add(marker);scene.add(grip);
}
async function enterXR(mode) {
  if(!ready() || session || xrBusy || cameraActive || cameraBusy)return;
  if(mode === 'record' && watchingLAN())return;
  stop();xrBusy=true;xrInputReady=false;previewAfterXR=false;autoplayAfterXR=true;
  if (mode === 'record') {musicCapture.cancel();musicCapture.error=null;recorder.cancel();liveTracking=null;}
  else {activeSource = resolvePlaybackSource(playbackChoice, selectedTake, {watchingLAN: watchingLAN()});updateTrackTitle();}
  updateButtons();
  const options=xrSessionOptions({mode,vrSupported,preference:$('xr-input-mode').value,
    placementMode:$('placement-mode').value,overlayRoot:$('xr-touch-overlay')});
  const {type,inputMode}=options;sessionInputMode=inputMode;
  try {
    // requestSession is called directly inside the user gesture, before any await.
    const request = navigator.xr.requestSession(type,options.init);
    if(mode==='live' && activeSource==='demo')audio.play().then(()=>{if(!playing){audio.pause();audio.currentTime=0;}}).catch(()=>{});
    if(mode==='live' && activeSource==='take' && takeWithMusic())captureAudio.prepare().catch(()=>{});
    if(mode==='record' && $('record-music').checked)captureAudio.prepare().catch(()=>{});
    const next = await request;
    session = next;sessionMode = mode;controls.enabled=false;
    renderer.setClearColor(type==='immersive-ar'?0:0x101117,type==='immersive-ar'?0:1);
    next.addEventListener('end', () => {
      const wasRecording = sessionMode === 'record';
      finishRecording();previewAfterXR = wasRecording && recorder.frameCount > 0 && !!recorder.lastClip;
      if (wasRecording) trackingReport.state = 'ended';
      session=null;sessionMode=null;stop();restorePreview();
      updateButtons();status(activeSource === 'take' ? 'XRを終了しました。選択したモーションはページでもARでも再確認できます。' : 'XRを終了しました。ページに戻りました。');
    },{once:true});
    await renderer.xr.setSession(next);
    if (session !== next || !renderer.xr.isPresenting) return;
    if(mode==='live' && inputMode==='touch' && !next.domOverlayState)throw new Error('Touch AR requires DOM overlay');
    $('xr-touch-overlay').hidden=!(mode==='live' && inputMode==='touch');
    let reference=renderer.xr.getReferenceSpace();referenceSpaceType = 'local';
    if (mode === 'record') {
      try {
        const floor = await next.requestReferenceSpace('local-floor');
        if (session !== next) return;
        renderer.xr.setReferenceSpace(floor);reference = floor;referenceSpaceType = 'local-floor';
      } catch { /* Head-relative height remains available on browsers without a floor space. */ }
      if (session !== next) return;
      liveSampler.reset({referenceSpaceType});liveTracking = null;pendingPlacement = true;
      trackingReport = {state: 'active', enabledFeatures: next.enabledFeatures ? Array.from(next.enabledFeatures) : null};
    }
    if (mode === 'live') {
      stage.visible = false;
      walls.start(next, reference, {mode: $('placement-mode').value, inputMode, width: Number($('width').value), distance: Number($('distance').value)});
    }
    next.addEventListener('select', select);
    next.addEventListener('squeeze', reposition);
    const recentered=()=>{if(sessionMode==='record'){finishRecording();endXR();}else{stop();stage.visible=false;walls.reset();}};
    reference.addEventListener('reset',recentered);
    next.addEventListener('end',()=>reference.removeEventListener('reset',recentered),{once:true});
    next.addEventListener('visibilitychange',()=>{
      if(next.visibilityState==='visible')return;
      if(mode==='record') {
        // A system overlay or removed headset must not leave music playing
        // while motion frames have stopped arriving.
        if(recorder.state==='recording'){autoplayAfterXR=false;finishRecording();endXR();}
        else musicCapture.cancel();
      } else stop(false);
    });
    xrInputReady = true;
    status(mode==='record'?'トリガーで3秒後に収録開始。正面を見て両手を自然に構えてください。':inputMode==='touch'?'画面中央を壁に向け、「ここに配置」をタップしてください。':'壁の候補を確認してトリガーで配置。もう一度押すと開演します。');
  } catch(error) {
    musicCapture.cancel();await endXR();session=null;sessionMode=null;restorePreview();
    status(inputMode==='touch'?'ARを開始できません。ARCore対応Android、Google Play開発者サービス（AR）、Chrome、カメラ権限を確認してください。3Dプレビューとカメラ収録も利用できます。':'XRを開始できません。PICOブラウザ・HTTPS・権限を確認してください。');console.error(error);
  } finally {xrBusy=false;updateButtons();}
}
$('ar').onclick = () => enterXR('live');
$('take-ar').onclick = () => {choosePlayback('take');enterXR('live');};
$('record-xr').onclick = () => enterXR('record');
$('exit-xr').onclick = () => {finishRecording();endXR();};
$('xr-input-mode').onchange=()=>{updateButtons();updateXRLabels();};
// Do not let a DOM button tap also generate WebXR select on the stage.
$('xr-touch-overlay').addEventListener('beforexrselect',event=>event.preventDefault());
$('xr-touch-place').onclick=()=>{if(sessionMode==='live' && xrInputReady && !walls.placed)pendingTouchPlacement=true;};
$('xr-touch-play').onclick=()=>{if(sessionMode==='live' && walls.placed && walls.report.tracking)toggleStagePlayback();};
$('xr-touch-reset').onclick=()=>{
  if(sessionMode!=='live')return;
  stop();pendingTouchPlacement=false;stage.visible=false;walls.reset();
};
$('xr-touch-mode').onclick=()=>{
  if(sessionMode!=='live')return;
  stop();pendingTouchPlacement=false;stage.visible=false;walls.reset({mode:walls.mode==='auto'?'distance':'auto'});
};
$('xr-touch-exit').onclick=endXR;
renderer.xr.addEventListener('sessionend', () => {
  resize();
  if (previewAfterXR) {previewAfterXR = false;playTake({autoplay: autoplayAfterXR});}
});
$('xr-diagnostics').onclick = () => {
  const data = {timestamp: new Date().toISOString(), userAgent: navigator.userAgent,
    secureContext: isSecureContext, arSupported, vrSupported, inputMode:sessionInputMode, wall: walls.diagnostics(), tracking: trackingReport,
    camera:{available:cameraAvailable,active:cameraActive,quality:cameraTracking?.quality ?? null,bodyCount:cameraTracking?.bodyCount ?? 0}};
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');link.href=url;link.download='vli-ar-diagnostics.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
};
async function detectXR() {
  try {
    if(navigator.xr) [arSupported,vrSupported] = await Promise.all(['immersive-ar','immersive-vr'].map(mode=>navigator.xr.isSessionSupported(mode).catch(()=>false)));
    updateXRLabels();
  } finally {updateButtons();}
}
function updateXRLabels() {
  const input=xrInputMode($('xr-input-mode').value,vrSupported);
  $('ar').textContent=arSupported?(playbackChoice==='take' && !watchingLAN()?'選択モーションをARで確認 ↗':input==='touch'?'スマホARでステージを開く ↗':'ARでステージを開く ↗'):'この環境はAR非対応';
  $('record-xr').textContent=vrSupported || (arSupported && input==='controller')?'HMDでモーションを収録':'HMD収録には対応ヘッドセットが必要';
}

$('motion-file').onchange = async event => {
  const file = event.target.files[0];if(!file)return;
  try {
    if(file.name.toLowerCase().endsWith('.vrma')){if(file.size>20*1024*1024)throw new Error('VRMAは20MB以内にしてください。');const clip=await parseVRMA(await file.arrayBuffer());stop();acceptTake(clip);return;}
    if(file.size>MAX_MOTION_FILE_BYTES || file.size===0)throw new Error('JSONは32MB以内にしてください。');
    const data = JSON.parse(await file.text());
    const clip = data.format === 'vli.motion-capture' ? validateMotionClip(data) : validateDemoMotion(data);
    stop();acceptTake(clip);
    $('take-info').textContent += ` · ${file.name}`;
  } catch(error) {$('take-info').textContent=`読み込み失敗: ${error.message}`;}
  finally {event.target.value='';}
};
$('take-download').onclick = () => {
  if(!selectedTake||!vrm)return;
  try{
    const bytes=selectedTake.format==='vrma'?selectedTake.bytes:exportMotionVRMA(vrm,selectedTake);
    downloadVRMA(bytes);
    $('record-status').textContent='VRMAを書き出しました。VRM Animation対応アプリで利用できます。';
  }catch(error){$('record-status').textContent=`書き出し失敗: ${error.message}`;}
};
$('raw-download').onclick = () => {if(selectedTake?.format==='vli.motion-capture')downloadMotionClip(selectedTake);};
restoreTake().then(async data => {
  if(!data || haveUserTake)return;
  const clip=data.format==='vrma'?await parseVRMA(data.bytes):data.format==='vli.motion-capture'?validateMotionClip(data):validateDemoMotion(data);
  if(haveUserTake)return;
  selectedTake=clip;
  if (!playbackChoiceMade) {playbackChoice = 'take';activeSource = resolvePlaybackSource(playbackChoice, clip, {watchingLAN: watchingLAN()});}
  $('take-music').checked=!!clip.accompaniment;
  updateTrackTitle();
  if(clip.format==='vrma'&&vrm)takePlayer=createVRMAPlayer(vrm,clip);
  $('take-info').textContent=`前回のモーション · ${formatTime(clip.duration)} · ${clip.format==='vrma'?'VRMA':clip.frames.length+' フレーム'}`;
  if(clip.referenceSpace==='camera')$('take-info').textContent+=' · カメラによる姿勢推定';
  if(clip.accompaniment)$('take-info').textContent+=' · NEON DOORと同期';
  updateButtons();
}).catch(()=>{});

function resize() {
  if(renderer.xr.isPresenting)return;
  const el=$('viewport');camera.aspect=el.clientWidth/el.clientHeight;camera.updateProjectionMatrix();
  renderer.setSize(el.clientWidth,el.clientHeight);
}
new ResizeObserver(resize).observe($('viewport'));
renderer.setAnimationLoop((time,frame) => {
  const delta=Math.min(clock.getDelta(),.05);
  const now = performance.now();
  const viewingLAN = watchingLAN();
  const cameraFresh = cameraActive && !cameraBusy && now - cameraObservedAt < 1000;
  if(pendingPlacement && xrInputReady && renderer.xr.isPresenting && session?.visibilityState === 'visible') {
    const viewer = frame?.getViewerPose(renderer.xr.getReferenceSpace());
    if (viewer && !viewer.emulatedPosition) {motionPreview.place(renderer.xr.getCamera(), referenceSpaceType.includes('floor'));pendingPlacement=false;}
  }
  if(sessionMode==='live' && xrInputReady && frame) {
    walls.update(frame);
    if(pendingTouchPlacement) {
      pendingTouchPlacement=false;
      const placement=walls.confirm(frame,null);
      if(placement){stage.position.copy(placement.position);stage.quaternion.copy(placement.quaternion);stage.scale.setScalar(placement.width/2.4);}
    }
    if (!walls.report.tracking && playing) stop(false);
    // Hide stale spatial content while positional tracking is unavailable.
    stage.visible = !!walls.placed && !!walls.report.tracking;
  }
  if(cameraActive && cameraRecorder.state==='recording' && cameraMusic.withMusic && (captureAudio.time>=captureAudio.duration || !captureAudio.ready)) {
    endCamera({autoplay:captureAudio.ready,message:!captureAudio.ready?'音声が中断されたため、ここまでの収録を保存しました。':''});
  }
  if(sessionMode==='record' && xrInputReady && frame) {
    liveTracking = liveSampler.sampleFrame(time,frame,renderer.xr.getReferenceSpace());
    if(session.visibilityState==='visible') {
      const completed=musicCapture.tick(time,liveTracking);
      if(completed){
        acceptTake(completed);
        if(musicCapture.error){autoplayAfterXR=false;$('record-status').textContent=musicCapture.error;}
        endXR();
      }
    }
  }
  // The live stream uses the very same observations as the capture preview.
  // It does not depend on the recorder or send camera images/model files.
  if (liveRoom.connected && now - livePoseSentAt >= 50) {
    const hidden = {t:0, visibility:'hidden', head:null, left:null, right:null, body:null};
    let sample = hidden, initialHeadHeight = null, referenceSpace = liveRole === 'audience' ? 'stage' : 'local';
    const visible = session ? session.visibilityState === 'visible' : document.visibilityState === 'visible';
    if ($('lan-share').checked && visible) {
      if (liveRole === 'performer') {
        const tracking = cameraFresh ? cameraTracking : sessionMode === 'record' && xrInputReady && !pendingPlacement ? liveTracking : null;
        const observation = liveTrackingFrame(tracking, {now, observedAt:cameraActive ? cameraObservedAt : now});
        if (observation) {sample = observation.sample; initialHeadHeight = observation.initialHeadHeight; referenceSpace = observation.referenceSpace;}
      } else if (liveDevice !== 'desktop' && sessionMode === 'live' && xrInputReady && walls.placed && walls.report.tracking && frame) {
        sample = sampleAudiencePose(frame, renderer.xr.getReferenceSpace(), stage, {device:liveDevice});
      }
    }
    sharedHead = !!sample?.head;
    liveRoom.sendPose({sample: sample || hidden, initialHeadHeight, referenceSpace}); livePoseSentAt = now;
  }
  const remotePerformance = viewingLAN ? livePerformer.sample(now) : null;
  livePresence.update(now);
  livePresence.room.visible = liveRoom.connected && !cameraActive && sessionMode !== 'record' &&
    (!session || (xrInputReady && !!walls.placed && !!walls.report.tracking && session.visibilityState === 'visible'));
  if(musicAudition && playing && captureAudio.time>=captureAudio.duration){playing=false;finished=true;$('record-status').textContent='試聴が終了しました。';}
  if(activeSource==='take' && playing && takeWithMusic() && !captureAudio.ready) {
    stop(false);status('音声が中断されたため一時停止しました。再生操作でモーションと曲を再開できます。');
  }
  if(activeSource==='take' && playing && playbackTime()>=duration()) {
    if ($('take-loop').checked && duration() > 0) {
      previewOrigin=performance.now();previewTime=0;
      if(takeWithMusic()) {
        try{captureAudio.play(selectedTake.accompaniment.offset);}catch{stop(false);status('音楽が停止しました。「プレビューを再開」で再試行してください。');}
      }
    } else {previewTime=duration();captureAudio.stop();playing=false;finished=true;}
  }
  const t=playbackTime();
  const demoActive=!cameraActive && sessionMode!=='record' && activeSource==='demo' && (playing || finished || t>0);
  const state=viewingLAN?{label:remotePerformance?'LAN LIVE':'配信・追跡待ち',curtain:0}:demoActive?cue(finished?DURATION:t):{label:cameraActive?'CAMERA / 推定':sessionMode==='record'?'LIVE TRACKING':activeSource==='take'?'MOTION PREVIEW':'STANDBY',curtain:0};
  curtain.visible=state.curtain>.001;curtain.scale.y=Math.max(.001,state.curtain);curtain.position.y=2.5-1.25*state.curtain;
  if(vrm && demoVRMA) {
    const previewing = !viewingLAN && (cameraActive || sessionMode === 'record' || (!session && activeSource === 'take'));
    motionPreview.show(vrm, previewing);
    vrm.scene.visible = viewingLAN ? !!remotePerformance : cameraActive ? cameraFresh && !!cameraTracking?.sample?.head : sessionMode !== 'record' || (xrInputReady && !pendingPlacement && !!liveTracking?.sample?.head);
    if (sessionMode === 'record' && (!xrInputReady || pendingPlacement)) motionPreview.room.visible = false;
    if (previewing) stage.visible = false;
    else if (!session) stage.visible = true;
    if(viewingLAN) {
      if(remotePerformance)applyMotionSampleToVRM(vrm,remotePerformance.sample,remotePerformance);
    } else if(cameraActive) {
      if(cameraTracking)applyMotionSampleToVRM(vrm,cameraTracking.sample,cameraTracking);
      else resetPose();
    } else if(sessionMode==='record') {
      if (liveTracking) applyMotionSampleToVRM(vrm,liveTracking.sample,liveTracking);
      else resetPose();
    } else applyPlaybackMotion(vrm, {source:activeSource, take:selectedTake, t, takePlayer, demoPlayer, restHips});

    vrm.update(delta);
  }
  if(time-lastUI>100) {
    if (liveRoom.connected) {
      $('lan-status').textContent = `${liveRole === 'performer' ? '出演者として配信' : '観客として接続'} · ${liveRoom.peers.length + 1}人が参加中`;
      $('lan-tracking').textContent = !$('lan-share').checked ? '自分の姿勢の共有を停止しています。受信は続けます。'
        : liveRole === 'performer' ? sharedHead ? 'モーションを配信中。観客側では受信した動きを表示します。' : 'カメラを準備するか、HMDの収録画面を開くと配信します。追跡が途切れたモデルは観客側で非表示になります。'
        : `${remotePerformance ? '出演者の動きを受信中。' : '出演者の配信・追跡を待っています。'} ${sharedHead ? (liveDevice === 'phone' ? 'スマホ位置の顔アバターを共有中（手は共有しません）。' : '自分のAR位置を共有中。') : liveDevice === 'desktop' ? 'PCでは3D視聴のみ。自分の位置は送信しません。' : 'ARで同じステージ位置を配置すると、自分の位置も共有します。'}`;
    } else {$('lan-tracking').textContent = '';}
    $('phase').textContent=state.label;$('time').textContent=formatTime(t);$('duration').textContent=formatTime(duration());
    $('seek').max=duration();$('seek').value=t;
    $('take-pause').textContent = playing && activeSource === 'take' ? 'プレビューを一時停止' : 'プレビューを再開';
    if(cameraActive && !cameraBusy) {
      const recording=cameraRecorder.state==='recording';
      const countdown=cameraMusic.countdownAt;
      const count=countdown!==null?Math.max(0,Math.ceil((countdown-performance.now())/1000)):null;
      $('camera-countdown').textContent=recording?`● ${formatTime(cameraRecorder.duration)}`:count>0?String(count):count===0?'全身を映してください':'';
      $('camera-record').textContent=recording?'保存して終了':cameraMusic.pending?'開始をキャンセル':'収録を開始';
      const tracked=cameraFresh && !!cameraTracking?.sample?.head;
      $('camera-status').textContent=cameraMusic.error || (cameraMusic.preparing?'音楽を準備しています…':recording?`収録中 ${formatTime(cameraRecorder.duration)} / ${cameraMusic.withMusic?'01:12':'03:00'} · ${cameraRecorder.frameCount}フレーム · ${tracked?'カメラで姿勢を推定中':'身体を見失いました。全身を映してください。'}`:count!==null?(count>0?`${count}秒後に開始します。全身が映る位置へ移動してください。`:'身体の検出を待っています。顔・肩・腰を画面内へ。'):tracked?`カメラ推定 ${cameraTracking.bodyCount}関節。動きを確認して収録を開始してください。`:'顔・肩・腰を画面内へ。全身が映る位置にスマホを固定してください。');
      updateButtons();
    }
    if(sessionMode==='record') {
      updateTrackingReport();
      const recording=recorder.state==='recording';
      const countdown=musicCapture.countdownAt;
      const limit=musicCapture.withMusic?'01:12':'03:00';
      const title=musicCapture.preparing?'MUSIC LOADING…':musicCapture.error?'MUSIC ERROR':countdown!==null?(performance.now()<countdown?`START IN ${Math.ceil((countdown-performance.now())/1000)}`:'TRACKING…'):recording?`● REC ${formatTime(recorder.duration)} / ${limit}`:'MOTION CAPTURE';
      const musicHint=($('record-music').checked?'NEON DOOR':'音楽なし');
      const detail=musicCapture.error || (musicCapture.preparing?'音楽を準備中 · トリガーでキャンセル':countdown!==null?`${musicHint} · 追跡が安定したら同時に開始`:recording?`${musicHint} · トリガーで保存してプレビュー`:`${musicHint} · トリガーで収録 · グリップで正面合わせ`);
      const bodyHint = trackingReport.bodyStatus === 'tracked' ? `身体${trackingReport.bodyCount}関節` : '身体は頭・手から推定';
      const trackingHint = !liveTracking?.sample?.head ? '頭の追跡を待っています' : `左手${liveTracking.sample.left?'○':'×'} 右手${liveTracking.sample.right?'○':'×'} · ${bodyHint}`;
      hud.update(renderer.xr.getCamera(),liveRoom.connected && liveRole==='performer'?`LAN配信 / ${title}`:title,`${trackingHint} / ${detail}`,true,recording);
      if(recorder.state!=='complete')$('record-status').textContent=recording?`${title} · ${recorder.frameCount} フレーム`:detail;
    } else if(session) {
      const [title, detail] = walls.guidance();
      const takeSelected = activeSource === 'take';
      const liveTitle = viewingLAN && walls.placed ? remotePerformance ? 'LAN LIVE / 配信中' : 'LAN LIVE / 配信待ち'
        : takeSelected && walls.placed ? 'MOTION PREVIEW / 選択モーション' : title;
      const liveDetail = viewingLAN && walls.placed ? '観客の顔も表示中 · グリップで再配置 · 終了は下のボタン'
        : takeSelected && walls.placed ? sessionInputMode === 'touch' ? '「モーションを再生」で開始 · 「置き直す」で再配置'
          : 'トリガーでモーションを再生 · グリップで再配置' : detail;
      hud.update(renderer.xr.getCamera(),playing?`${takeSelected?'MOTION / ':''}${formatTime(t)} / ${formatTime(duration())}`:liveTitle,playing?'トリガーで一時停止 · グリップで再配置':liveDetail,sessionInputMode!=='touch');
      if(sessionInputMode==='touch') {
        $('xr-touch-status').textContent=viewingLAN && walls.placed?`${liveTitle} · 顔アバターの位置はスマホ位置が目安です。`:playing?`${formatTime(t)} / ${formatTime(duration())} · ${takeSelected?'モーション':'ライブ'}再生中`:`${liveTitle}。${liveDetail}`;
        $('xr-touch-place').disabled=!!walls.placed || !walls.candidate || !walls.report.tracking;
        $('xr-touch-play').disabled=viewingLAN || !walls.placed || !walls.report.tracking;
        $('xr-touch-play').textContent=viewingLAN?'LANライブを受信':playing?'一時停止':takeSelected?'モーションを再生':'ライブを再生';
        $('xr-touch-mode').textContent=walls.mode==='auto'?'距離指定へ':'壁の自動検出へ';
      }
      const report = walls.diagnostics();
      $('wall-status').textContent = `${title}。${detail}（平面 ${report.planes} / 垂直面 ${report.verticalPlanes}）`;
    }
    lastUI=time;
  }
  // Reposition head-locked HUD every frame; texture only changes with text.
  if(session) {hud.follow(renderer.xr.getCamera());hud.updatePointers(frame, session.inputSources, renderer.xr.getReferenceSpace());}
  else controls.update();
  renderer.render(scene,camera);
});
detectXR();
try {
  const vrmaResponse=await fetch(asset('demo/neon-door.vrma'));if(!vrmaResponse.ok)throw new Error('VRMA HTTP error');
  demoVRMA=await parseVRMA(await vrmaResponse.arrayBuffer());
  await loadModel(asset('demo/vli-performer.vrm'));
} catch(error) {status('デモを読み込めません。接続を確認して再読み込みしてください。');console.error(error);}
