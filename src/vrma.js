import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

export const MAX_VRMA_BYTES = 20 * 1024 * 1024;
const MAX_TRANSLATION = 100;
const cubic = track => track.createInterpolant?.isInterpolantFactoryMethodGLTFCubicSpline === true;
function copyInterpolation(source, target) {
  if (!source || !target) return;
  if (cubic(source)) target.createInterpolant = source.createInterpolant;
  else target.setInterpolation(source.getInterpolation());
}
function validateTrack(track, size, rotation = false, translation = false) {
  const spline = cubic(track), stride = size * (spline ? 3 : 1);
  if (track.times.length > 10801 || !track.times.length || (spline && track.times.length < 2) || track.values.length !== track.times.length * stride ||
    !Array.from(track.values).every(Number.isFinite) || !Array.from(track.times).every((t,i) => Number.isFinite(t) && t >= 0 && (i === 0 || t > track.times[i - 1]))) throw new Error('VRMAのキーフレームが不正です。');
  for (let i = 0; i < track.times.length; i++) {
    // glTF C.5: cubic outputs are [in tangent, value, out tangent]. Tangents
    // may be zero/non-unit and must never be treated as rotation quaternions.
    const offset = i * stride + (spline ? size : 0);
    const value = track.values.subarray(offset, offset + size);
    if (rotation && Math.abs(Math.hypot(...value) - 1) > .02) throw new Error('VRMAの回転は単位クォータニオンにしてください。');
    if (translation && value.some(n => Math.abs(n) > MAX_TRANSLATION)) throw new Error('VRMAの移動量は100メートル以内にしてください。');
  }
  if (spline && translation) {
    // Valid endpoint positions can still overshoot through large tangents.
    // Check exact cubic extrema, without imposing arbitrary velocity limits.
    for (let i = 1; i < track.times.length; i++) for (let axis = 0; axis < size; axis++) {
      const before = (i - 1) * stride, after = i * stride, dt = track.times[i] - track.times[i - 1];
      const p0 = track.values[before + size + axis], p1 = track.values[after + size + axis];
      const m0 = track.values[before + size * 2 + axis] * dt, m1 = track.values[after + axis] * dt;
      const a = 2 * p0 - 2 * p1 + m0 + m1, b = -3 * p0 + 3 * p1 - 2 * m0 - m1, c = m0;
      const discriminant = 4 * b * b - 12 * a * c;
      const extrema = Math.abs(a) < 1e-12 ? (Math.abs(b) < 1e-12 ? [] : [-c / (2 * b)])
        : discriminant < 0 ? [] : [(-2 * b + Math.sqrt(discriminant)) / (6 * a), (-2 * b - Math.sqrt(discriminant)) / (6 * a)];
      for (const u of extrema) if (u > 0 && u < 1 && Math.abs(((a * u + b) * u + c) * u + p0) > MAX_TRANSLATION) throw new Error('VRMAの移動量は100メートル以内にしてください。');
    }
  }
}
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
  // Retargeting divides translation keys by the source rest hips height.
  // Match the loader's T-pose warning threshold before it can produce NaN.
  if(animation.humanoidTracks.translation.size && (!animation.restHipsPosition.toArray().every(Number.isFinite) || animation.restHipsPosition.y < 1e-3))throw new Error('移動を含むVRMAの基準腰高は0.001メートル以上にしてください。');
  // three-vrm-animation converts expression VEC3 tracks to scalar tracks but
  // currently omits their interpolation factory. Preserve STEP and CUBICSPLINE.
  const expressions = json.extensions.VRMC_vrm_animation.expressions;
  for (const kind of ['preset', 'custom']) for (const [name, definition] of Object.entries(expressions?.[kind] ?? {})) {
    const index = json.animations[0].channels.findIndex(channel => channel.target.node === definition.node && channel.target.path === 'translation');
    if (index >= 0) copyInterpolation(gltf.animations[0].tracks[index], animation.expressionTracks[kind].get(name));
  }
  const tracks=[...animation.humanoidTracks.rotation.values(),...animation.humanoidTracks.translation.values(),...animation.expressionTracks.preset.values(),...animation.expressionTracks.custom.values()];
  if(animation.lookAtTrack)tracks.push(animation.lookAtTrack);
  if(!tracks.length)throw new Error('アニメーショントラックがありません。');
  for(const track of animation.humanoidTracks.rotation.values()) validateTrack(track, 4, true);
  for(const track of animation.humanoidTracks.translation.values()) validateTrack(track, 3, false, true);
  for(const track of [...animation.expressionTracks.preset.values(),...animation.expressionTracks.custom.values()]) validateTrack(track, 1);
  if(animation.lookAtTrack)validateTrack(animation.lookAtTrack, 4, true);
  return {format:'vrma',version:1,duration:animation.duration,bytes:buffer,animation};
}
export function createVRMAPlayer(vrm, source) {
  const mixer=new THREE.AnimationMixer(vrm.scene);
  const clip=createVRMAnimationClip(source.animation,vrm);
  // The library creates new humanoid rotation tracks with LINEAR defaults.
  // Reapply the original factory so cubic tangents are not played as poses.
  for (const [name, original] of source.animation.humanoidTracks.rotation) {
    const node = vrm.humanoid.getNormalizedBoneNode(name);
    if (node) copyInterpolation(original, clip.tracks.find(track => track.name === `${node.name}.quaternion`));
  }
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
