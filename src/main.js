import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { cue, DURATION } from './timeline.js';
import { applyDemoMotion, validateDemoMotion } from './demo-motion.js';
import { buildStage } from './stage.js';
import { createXRHUD } from './xr-hud.js';
import { MotionRecorder, LiveMotionSampler } from './motion-capture.js';
import { validateMotionClip, applyCaptureToVRM, applyMotionSampleToVRM, downloadMotionClip, MAX_MOTION_FILE_BYTES } from './motion-data.js';
import { saveTake, restoreTake } from './take-storage.js';
import { parseVRMA, createVRMAPlayer, downloadVRMA } from './vrma.js';
import { exportMotionVRMA } from './vrma-export.js';
import { WallPlacement } from './wall-placement.js';
import { createMotionPreview } from './motion-preview.js';

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
const clock = new THREE.Clock();
let vrm = null, restHips = null, loading = false;
let session = null, sessionMode = null, xrBusy = false, arSupported = false, vrSupported = false;
let playing = false, finished = false, playRequest = 0, selectedTake = null, activeSource = 'demo';
let previewTime = 0, previewOrigin = 0, pendingPlacement = false, countdownAt = null, lastUI = 0;
let referenceSpaceType = 'local', liveTracking = null, previewAfterXR = false, xrInputReady = false, trackingReport = {state: 'not-started'};
const liveSampler = new LiveMotionSampler();
const recorder = new MotionRecorder({onLimit:clip => { if (clip) acceptTake(clip); endXR(); }});
let haveUserTake = false, demoVRMA = null, demoPlayer = null, takePlayer = null;

function ready() { return !!vrm && !!demoVRMA && !loading; }
function updateButtons() {
  $('play').disabled = !ready() || xrBusy || !!session;
  $('model').disabled = loading || !!session;
  $('motion-file').disabled = !!session;
  $('ar').disabled = !ready() || !arSupported || xrBusy || !!session;
  $('record-xr').disabled = !ready() || !(arSupported || vrSupported) || xrBusy || !!session;
  $('take-play').disabled = !ready() || !selectedTake || !!session;
  $('take-pause').disabled = !ready() || !selectedTake || activeSource !== 'take' || !!session;
  $('take-download').disabled = !selectedTake || !ready();
  $('raw-download').disabled = !selectedTake || selectedTake.format!=='vli.motion-capture';
  $('demo-motion').disabled = !demoVRMA || !!session;
  $('seek').disabled = !!session;
  $('exit-xr').hidden = !session;
  $('tracking-status').textContent = trackingSummary();
  for (const id of ['placement-mode', 'width', 'distance']) $(id).disabled = !!session || xrBusy;
}
function resetPose() {
  vrm?.humanoid.resetNormalizedPose();
  for(const name of ['aa','happy','blink'])vrm?.expressionManager?.setValue(name,0);
}
function duration() { return activeSource === 'take' && selectedTake ? selectedTake.duration : DURATION; }
function playbackTime() {
  if (activeSource === 'demo') return audio.currentTime;
  return playing ? Math.min(duration(), (performance.now() - previewOrigin) / 1000) : previewTime;
}
function stop(reset = true) {
  ++playRequest;
  audio.pause(); playing = false; finished = false;
  if(reset){audio.currentTime = 0; previewTime = 0; resetPose();}
}
async function playDemo() {
  if(!ready())return;
  stop(); activeSource = 'demo';
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
function playTake() {
  if(!ready() || !selectedTake)return;
  stop(); activeSource = 'take'; playing = true;
  previewOrigin = performance.now();
  $('track-title').textContent = 'MOTION PREVIEW';
  if (!session) {
    camera.position.set(0, 1.3, 3.8);controls.target.set(0, .95, 0);controls.update();
    $('stage').scrollIntoView({behavior: 'smooth', block: 'center'});
  }
  status('読み込んだモーションをプレビュー中。音声は再生しません。');
  updateButtons();
}
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
$('play').onclick = playDemo;
$('stop').onclick = () => {stop();status('停止しました。再生または位置調整ができます。');};
$('take-play').onclick = playTake;
$('take-pause').onclick = () => {
  if (activeSource !== 'take' || !selectedTake || session) return;
  if (playing) {previewTime = playbackTime();stop(false);status('モーションを一時停止しました。再生位置のバーで動きを確認できます。');}
  else {if(previewTime >= duration())previewTime=0;previewOrigin=performance.now()-previewTime*1000;playing=true;finished=false;status('モーションのプレビューを再開しました。');}
};
$('demo-motion').onclick = () => {if(demoVRMA){stop();acceptTake(demoVRMA);}};
$('demo-reset').onclick = () => {stop();activeSource='demo';updateButtons();$('track-title').textContent='NEON DOOR';status('デモに戻しました。ライブを再生できます。');};
$('volume').oninput = () => {audio.volume = Number($('volume').value);};
$('seek').oninput = () => {
  const time = Number($('seek').value);
  finished = false;
  if(activeSource === 'demo')audio.currentTime = time;
  else {previewTime = time;previewOrigin = performance.now() - time * 1000;}
};
audio.addEventListener('ended', () => {playing=false;finished=true;status('終演しました。もう一度再生できます。');});
audio.addEventListener('error', () => {stop();status('音源を読み込めません。接続を確認して再読み込みしてください。');});
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
  if(clip.format==='vrma'&&vrm)takePlayer=createVRMAPlayer(vrm,clip);
  $('take-info').textContent = `${formatTime(clip.duration)} · ${clip.format==='vrma'?'VRM Animation 1.0':clip.frames.length+' フレーム · '+(clip.format==='vli.motion-capture'?(clip.tracking?.body==='browser-body'?'頭・手・身体関節の収録':'頭・手の収録（身体は推定）'):'旧形式の振り付け')}`;
  $('record-status').textContent = 'モーションを保存しました。プレビュー・ダウンロードできます。';
  updateButtons();
  saveTake(clip.format==='vrma'?{format:'vrma',bytes:clip.bytes}:clip).catch(() => {$('record-status').textContent='端末内の保存容量が不足しています。ダウンロードして保存してください。';});
}
function finishRecording() {
  countdownAt = null;
  if(recorder.state === 'recording') {
    const clip = recorder.stop();
    if(clip)acceptTake(clip);
    else $('record-status').textContent='追跡データを取得できませんでした。再度お試しください。';
  }
}
async function endXR() { if(session)await session.end().catch(()=>{}); }
function restorePreview() {
  walls.end();pendingPlacement=false;xrInputReady=false;controls.enabled=true;
  stage.visible=true;stage.position.set(0,0,0);stage.rotation.set(0,0,0);
  stage.scale.setScalar(Number($('width').value)/2.4);
  motionPreview.reset();liveTracking = null;
  renderer.setClearColor(0x171922,1);hud.update(camera,'','',false);resize();
}
async function select(event) {
  if(!session || !ready() || !xrInputReady)return;
  if (hud.select(event.frame, event.inputSource, renderer.xr.getReferenceSpace())) {
    finishRecording();await endXR();return;
  }
  if(sessionMode==='record') {
    if(countdownAt!==null){countdownAt=null;$('record-status').textContent='開始をキャンセルしました。';return;}
    if(recorder.state==='recording'){finishRecording();await endXR();}
    else countdownAt = performance.now() + 3000;
    return;
  }
  if (walls.placed) {
    if (playing) stop(); else await playDemo();
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
    countdownAt = null;liveSampler.reset({referenceSpaceType});pendingPlacement = true;return;
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
  if(!ready() || session || xrBusy)return;
  stop();xrBusy=true;xrInputReady=false;previewAfterXR=false;
  if (mode === 'record') {recorder.cancel();liveTracking=null;}
  else {activeSource = 'demo';$('track-title').textContent = 'NEON DOOR';}
  updateButtons();
  const type = mode==='record' ? (vrSupported?'immersive-vr':'immersive-ar') : 'immersive-ar';
  try {
    // requestSession is called directly inside the user gesture, before any await.
    const features = mode === 'record' ? ['local-floor', 'hand-tracking', 'body-tracking']
      : $('placement-mode').value === 'auto' ? ['local-floor', 'plane-detection', 'hit-test'] : ['local-floor'];
    const request = navigator.xr.requestSession(type,{optionalFeatures: features});
    if(mode==='live')audio.play().then(()=>{if(!playing){audio.pause();audio.currentTime=0;}}).catch(()=>{});
    const next = await request;
    session = next;sessionMode = mode;controls.enabled=false;
    renderer.setClearColor(type==='immersive-ar'?0:0x101117,type==='immersive-ar'?0:1);
    next.addEventListener('end', () => {
      const wasRecording = sessionMode === 'record';
      finishRecording();previewAfterXR = wasRecording && recorder.frameCount > 0 && !!recorder.lastClip;
      if (wasRecording) trackingReport.state = 'ended';
      session=null;sessionMode=null;countdownAt=null;stop();restorePreview();
      updateButtons();status('XRを終了しました。収録したモーションは下のスタジオで確認できます。');
    },{once:true});
    await renderer.xr.setSession(next);
    if (session !== next || !renderer.xr.isPresenting) return;
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
      walls.start(next, reference, {mode: $('placement-mode').value, width: Number($('width').value), distance: Number($('distance').value)});
    }
    next.addEventListener('select', select);
    next.addEventListener('squeeze', reposition);
    const recentered=()=>{if(sessionMode==='record'){finishRecording();endXR();}else{stop();stage.visible=false;walls.reset();}};
    reference.addEventListener('reset',recentered);
    next.addEventListener('end',()=>reference.removeEventListener('reset',recentered),{once:true});
    next.addEventListener('visibilitychange',()=>{if(next.visibilityState!=='visible'){countdownAt=null;if(mode==='live')stop(false);}});
    xrInputReady = true;
    status(mode==='record'?'トリガーで3秒後に収録開始。正面を見て両手を自然に構えてください。':'壁の候補を確認してトリガーで配置。もう一度押すと開演します。');
  } catch(error) {
    await endXR();session=null;sessionMode=null;restorePreview();
    status('XRを開始できません。PICOブラウザ・HTTPS・権限を確認してください。');console.error(error);
  } finally {xrBusy=false;updateButtons();}
}
$('ar').onclick = () => enterXR('live');
$('record-xr').onclick = () => enterXR('record');
$('exit-xr').onclick = () => {finishRecording();endXR();};
renderer.xr.addEventListener('sessionend', () => {
  resize();
  if (previewAfterXR) {previewAfterXR = false;playTake();}
});
$('xr-diagnostics').onclick = () => {
  const data = {timestamp: new Date().toISOString(), userAgent: navigator.userAgent,
    secureContext: isSecureContext, arSupported, vrSupported, wall: walls.diagnostics(), tracking: trackingReport};
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'}));
  const link = document.createElement('a');link.href=url;link.download='vli-ar-diagnostics.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
};
async function detectXR() {
  try {
    if(navigator.xr) [arSupported,vrSupported] = await Promise.all(['immersive-ar','immersive-vr'].map(mode=>navigator.xr.isSessionSupported(mode).catch(()=>false)));
    $('ar').textContent = arSupported?'ARでステージを開く ↗':'この環境はAR非対応';
    $('record-xr').textContent = arSupported||vrSupported?'PICOでモーションを収録':'収録にはWebXR対応HMDが必要';
  } finally {updateButtons();}
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
  if(clip.format==='vrma'&&vrm)takePlayer=createVRMAPlayer(vrm,clip);
  $('take-info').textContent=`前回のモーション · ${formatTime(clip.duration)} · ${clip.format==='vrma'?'VRMA':clip.frames.length+' フレーム'}`;
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
  if(pendingPlacement && xrInputReady && renderer.xr.isPresenting && session?.visibilityState === 'visible') {
    const viewer = frame?.getViewerPose(renderer.xr.getReferenceSpace());
    if (viewer && !viewer.emulatedPosition) {motionPreview.place(renderer.xr.getCamera(), referenceSpaceType.includes('floor'));pendingPlacement=false;}
  }
  if(sessionMode==='live' && xrInputReady && frame) {
    walls.update(frame);
    if (!walls.report.tracking && playing) stop(false);
    // Hide stale spatial content while positional tracking is unavailable.
    stage.visible = !!walls.placed && !!walls.report.tracking;
  }
  if(sessionMode==='record' && xrInputReady && frame) {
    liveTracking = liveSampler.sampleFrame(time,frame,renderer.xr.getReferenceSpace());
    if(countdownAt!==null && session.visibilityState==='visible' && performance.now()>=countdownAt){countdownAt=null;recorder.start({referenceSpaceType});}
    if(recorder.state==='recording' && liveTracking)recorder.recordSample(time,liveTracking);
  }
  if(activeSource==='take' && playing && playbackTime()>=duration()) {
    if ($('take-loop').checked && duration() > 0) {previewOrigin=performance.now();previewTime=0;}
    else {previewTime=duration();playing=false;finished=true;}
  }
  const t=playbackTime();
  const demoActive=sessionMode!=='record' && activeSource==='demo' && (playing || finished || t>0);
  const state=demoActive?cue(finished?DURATION:t):{label:sessionMode==='record'?'LIVE TRACKING':activeSource==='take'?'MOTION PREVIEW':'STANDBY',curtain:0};
  curtain.visible=state.curtain>.001;curtain.scale.y=Math.max(.001,state.curtain);curtain.position.y=2.5-1.25*state.curtain;
  if(vrm && demoVRMA) {
    const previewing = sessionMode === 'record' || (!session && activeSource === 'take');
    motionPreview.show(vrm, previewing);
    vrm.scene.visible = sessionMode !== 'record' || (xrInputReady && !pendingPlacement && !!liveTracking?.sample?.head);
    if (sessionMode === 'record' && (!xrInputReady || pendingPlacement)) motionPreview.room.visible = false;
    if (previewing) stage.visible = false;
    else if (!session) stage.visible = true;
    if(sessionMode==='record') {
      if (liveTracking) applyMotionSampleToVRM(vrm,liveTracking.sample,liveTracking);
      else resetPose();
    } else if(activeSource==='take' && selectedTake && !session) {
      if(selectedTake.format==='vrma')takePlayer?.seek(t);
      else if(selectedTake.format==='vli.motion-capture')applyCaptureToVRM(vrm,selectedTake,t);
      else applyDemoMotion(vrm,selectedTake,t,restHips);
    } else if(demoPlayer)demoPlayer.seek(Math.max(0,t));

    vrm.update(delta);
  }
  if(time-lastUI>100) {
    $('phase').textContent=state.label;$('time').textContent=formatTime(t);$('duration').textContent=formatTime(duration());
    $('seek').max=duration();$('seek').value=t;
    $('take-pause').textContent = playing && activeSource === 'take' ? 'プレビューを一時停止' : 'プレビューを再開';
    if(sessionMode==='record') {
      updateTrackingReport();
      const recording=recorder.state==='recording';
      const title=countdownAt!==null?`START IN ${Math.max(1,Math.ceil((countdownAt-performance.now())/1000))}`:recording?(recorder.frameCount?`● REC ${formatTime(recorder.duration)} / 03:00`:'TRACKING…'):'MOTION CAPTURE';
      const detail=countdownAt!==null?'正面を向いて、両手を自然に構えてください':recording?'トリガーで保存してプレビュー':'トリガーで収録 · グリップで正面を合わせる';
      const bodyHint = trackingReport.bodyStatus === 'tracked' ? `身体${trackingReport.bodyCount}関節` : '身体は頭・手から推定';
      const trackingHint = !liveTracking?.sample?.head ? '頭の追跡を待っています' : `左手${liveTracking.sample.left?'○':'×'} 右手${liveTracking.sample.right?'○':'×'} · ${bodyHint}`;
      hud.update(renderer.xr.getCamera(),title,`${trackingHint} / ${detail}`,true,recording);
      if(recorder.state!=='complete')$('record-status').textContent=recording?`${title} · ${recorder.frameCount} フレーム`:detail;
    } else if(session) {
      const [title, detail] = walls.guidance();
      hud.update(renderer.xr.getCamera(),playing?`${formatTime(t)} / ${formatTime(DURATION)}`:title,playing?'トリガーで停止 · グリップで再配置':detail,true);
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
