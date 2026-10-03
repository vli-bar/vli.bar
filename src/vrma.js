import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

export const MAX_VRMA_BYTES = 20 * 1024 * 1024;
/** Accept self-contained VRMA GLB only, without making external asset requests. */
export async function parseVRMA(buffer) {
  if(!(buffer instanceof ArrayBuffer) || buffer.byteLength<28 || buffer.byteLength>MAX_VRMA_BYTES)throw new Error('VRMAは20MB以内のGLB形式にしてください。');
  const view=new DataView(buffer);
  if(view.getUint32(0,true)!==0x46546c67 || view.getUint32(4,true)!==2 || view.getUint32(8,true)!==buffer.byteLength || view.getUint32(16,true)!==0x4e4f534a)throw new Error('VRMAのGLBヘッダーが不正です。');
  const length=view.getUint32(12,true);
  if(length>buffer.byteLength-20)throw new Error('VRMAのJSONチャンクが不正です。');
  const json=JSON.parse(new TextDecoder().decode(new Uint8Array(buffer,20,length)));
  if(json.extensions?.VRMC_vrm_animation?.specVersion!=='1.0')throw new Error('VRM Animation 1.0 (.vrma) に対応しています。');
  if((json.buffers||[]).some(b=>b.uri) || (json.images||[]).some(i=>i.uri))throw new Error('外部ファイルを参照するVRMAは読み込めません。');
  if((json.meshes||[]).length || (json.images||[]).length || (json.nodes||[]).length>256 || (json.animations||[]).length!==1)throw new Error('単一アニメーションのVRMAを使用してください。');
  const loader=new GLTFLoader();loader.register(parser=>new VRMAnimationLoaderPlugin(parser));
  const gltf=await loader.parseAsync(buffer,'');
  const animation=gltf.userData.vrmAnimations?.[0];
  if(!animation || !Number.isFinite(animation.duration) || animation.duration<=0 || animation.duration>180)throw new Error('VRMAの長さは0秒より長く、3分以内にしてください。');
  const tracks=[...animation.humanoidTracks.rotation.values(),...animation.humanoidTracks.translation.values(),...animation.expressionTracks.preset.values(),...animation.expressionTracks.custom.values()];
  if(animation.lookAtTrack)tracks.push(animation.lookAtTrack);
  if(!tracks.length)throw new Error('アニメーショントラックがありません。');
  for(const track of tracks) {
    if(track.times.length>10801 || !track.times.length || !Array.from(track.values).every(Number.isFinite) || !Array.from(track.times).every((t,i)=>Number.isFinite(t)&&t>=0&&(i===0||t>track.times[i-1])))throw new Error('VRMAのキーフレームが不正です。');
  }
  return {format:'vrma',version:1,duration:animation.duration,bytes:buffer,animation};
}
export function createVRMAPlayer(vrm, source) {
  const mixer=new THREE.AnimationMixer(vrm.scene);
  const clip=createVRMAnimationClip(source.animation,vrm);
  const action=mixer.clipAction(clip);action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;
  return {
    seek(time){action.reset().play();mixer.setTime(Math.max(0,Math.min(source.duration,time)));},
    dispose(){mixer.stopAllAction();mixer.uncacheRoot(vrm.scene);},
  };
}
export function downloadVRMA(bytes, filename='vli-motion.vrma') {
  const url=URL.createObjectURL(new Blob([bytes],{type:'model/gltf-binary'}));
  const link=document.createElement('a');link.href=url;link.download=filename;
  document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),30000);
}
