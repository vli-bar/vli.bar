import * as THREE from 'three';

export function sampleDemoMotion(motion, time) {
  const frames = motion.frames;
  let low = 0, high = frames.length - 1;
  const t = Math.max(0, Math.min(motion.duration, Number.isFinite(time) ? time : 0));
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (frames[middle].t <= t) low = middle;
    else high = middle - 1;
  }
  const a = frames[low], b = frames[Math.min(low + 1, frames.length - 1)];
  return { a, b, alpha: a === b ? 0 : Math.min(1, (t - a.t) / (b.t - a.t)) };
}
const q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion(), euler = new THREE.Euler();
export function applyDemoMotion(vrm, motion, time, restHips) {
  const { a, b, alpha } = sampleDemoMotion(motion, time);
  for (const [name, rotation] of Object.entries(a.bones)) {
    const bone = vrm.humanoid.getNormalizedBoneNode(name);
    if (!bone) continue;
    q1.setFromEuler(euler.fromArray([...rotation, 'XYZ']));
    q2.setFromEuler(euler.fromArray([...(b.bones[name] || rotation), 'XYZ']));
    bone.quaternion.copy(q1).slerp(q2, alpha);
  }
  const hips = vrm.humanoid.getNormalizedBoneNode('hips');
  if (hips && restHips) {
    hips.position.copy(restHips);
    const r1 = a.root || [0,0,0], r2 = b.root || r1;
    hips.position.add(new THREE.Vector3(...r1).lerp(new THREE.Vector3(...r2), alpha));
  }
  for (const name of ['aa', 'happy', 'blink']) {
    const value = THREE.MathUtils.lerp(a[name] || 0, b[name] || 0, alpha);
    vrm.expressionManager?.setValue(name, value);
  }
}

export function validateDemoMotion(data) {
  const fail = () => { throw new Error('振り付けJSONの形式が不正です。デモ素材のJSONを使用してください。'); };
  if (!data || !Number.isFinite(data.duration) || data.duration <= 0 || data.duration > 180 || !Number.isInteger(data.fps) || data.fps < 1 || data.fps > 60 || !Array.isArray(data.frames) || data.frames.length < 2 || data.frames.length > 10801) fail();
  const allowed = new Set(['hips','spine','chest','upperChest','neck','head','leftShoulder','rightShoulder','leftUpperArm','rightUpperArm','leftLowerArm','rightLowerArm','leftHand','rightHand','leftUpperLeg','rightUpperLeg','leftLowerLeg','rightLowerLeg','leftFoot','rightFoot','leftToes','rightToes']);
  const vector = (v,bound) => Array.isArray(v) && v.length===3 && v.every(n=>Number.isFinite(n)&&Math.abs(n)<=bound);
  let previous=-1, boneKeys=null;
  const frames=data.frames.map((f,i)=>{
    if(!f || !Number.isFinite(f.t) || f.t<=previous || f.t>data.duration+.001 || (i===0&&f.t!==0) || !f.bones || typeof f.bones!=='object' || Array.isArray(f.bones)) fail();
    previous=f.t;
    const bones={};
    for(const [name,rot] of Object.entries(f.bones)){if(!allowed.has(name)||!vector(rot,Math.PI*4)) fail();bones[name]=[...rot];}
    const keys=Object.keys(bones).sort().join(',');
    if(!keys || (boneKeys!==null&&keys!==boneKeys))fail();
    boneKeys=keys;
    const result={t:f.t,bones};
    if(f.root!==undefined){if(!vector(f.root,2)) fail();result.root=[...f.root];}
    for(const key of ['aa','happy','blink']){const n=f[key]??0;if(!Number.isFinite(n)||n<0||n>1)fail();result[key]=n;}
    return result;
  });
  if(Math.abs(frames.at(-1).t-data.duration)>.001)fail();
  return {format:'vli.demo-motion',version:1,title:typeof data.title==='string'?data.title.slice(0,100):'Imported choreography',duration:data.duration,fps:data.fps,frames};
}
