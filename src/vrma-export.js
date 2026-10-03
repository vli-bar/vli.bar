import { VRMHumanBoneList, VRMHumanBoneParentMap, VRMRequiredHumanBoneName } from '@pixiv/three-vrm';
import { applyDemoMotion, validateDemoMotion } from './demo-motion.js';
import { applyCaptureToVRM, validateMotionClip } from './motion-data.js';

const EXTENSION = 'VRMC_vrm_animation';
const EXPRESSION_NAMES = ['aa', 'happy', 'blink'];
const error = message => { throw new Error(`VRMA書き出し: ${message}`); };
const finite = values => values.every(Number.isFinite);

function binaryGLTF(json, arrays) {
  let byteLength = 0;
  json.bufferViews = [];
  json.accessors = [];
  for (const { values, type, min, max } of arrays) {
    const index = json.bufferViews.length;
    json.bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: values.length * 4 });
    json.accessors.push({ bufferView: index, componentType: 5126, count: values.length / ({ SCALAR: 1, VEC3: 3, VEC4: 4 }[type]), type, ...(min ? { min, max } : {}) });
    byteLength += values.length * 4;
  }
  json.buffers = [{ byteLength }];
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = Math.ceil(encoded.byteLength / 4) * 4;
  const total = 12 + 8 + jsonLength + 8 + byteLength;
  const result = new ArrayBuffer(total);
  const view = new DataView(result);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  const output = new Uint8Array(result);
  output.fill(0x20, 20, 20 + jsonLength); output.set(encoded, 20);
  const binaryHeader = 20 + jsonLength;
  view.setUint32(binaryHeader, byteLength, true); view.setUint32(binaryHeader + 4, 0x004e4942, true);
  let offset = binaryHeader + 8;
  // DataView guarantees glTF's little-endian encoding independently of the host.
  for (const { values } of arrays) for (const value of values) { view.setFloat32(offset, value, true); offset += 4; }
  return result;
}

/**
 * Bake normalized humanoid animation into a standalone VRM Animation 1.0 GLB.
 * Models and textures are not embedded. source is authored demo data or raw
 * WebXR capture; capture's estimated body pose is baked as standard FK tracks.
 * The live avatar pose, expressions and scene transforms are restored on exit.
 */
export function exportMotionVRMA(vrm, source, { fps = 30 } = {}) {
  if (!vrm?.humanoid || !vrm.scene) error('VRMモデルを先に読み込んでください。');
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) error('fps は 1〜60 にしてください。');
  const capture = source?.format === 'vli.motion-capture';
  const motion = capture ? validateMotionClip(source) : validateDemoMotion(source);
  if (motion.duration <= 0) error('収録が短すぎます。少し動いてから保存してください。生データはJSONで保存できます。');
  if (vrm.meta?.metaVersion === '0') error('書き出しにはVRM 1.0モデルを使用してください。同梱のLUMIモデルに戻すと書き出せます。');
  const humanoid = vrm.humanoid;
  const bones = VRMHumanBoneList.filter(name => !['leftEye', 'rightEye'].includes(name))
    .map(name => ({ name, bone: humanoid.getNormalizedBoneNode(name) })).filter(({ bone }) => bone);
  const boneNames = new Set(bones.map(({ name }) => name));
  for (const name of Object.values(VRMRequiredHumanBoneName)) if (!boneNames.has(name)) error(`必須ボーン ${name} がありません。`);
  const originalPose = bones.map(({ bone }) => ({ bone, position: bone.position.clone(), quaternion: bone.quaternion.clone(), scale: bone.scale.clone() }));
  const expressions = EXPRESSION_NAMES.filter(name => vrm.expressionManager?.getExpression(name));
  const originalExpressions = expressions.map(name => [name, vrm.expressionManager.getValue(name)]);
  const canonicalVector = vector => vector.toArray();
  try {
    humanoid.resetNormalizedPose();
    const indices = new Map(bones.map(({ name }, index) => [name, index]));
    const nodes = bones.map(({ name, bone }) => {
      const translation = canonicalVector(bone.position);
      if (!finite(translation)) error(`${name} の位置が不正です。`);
      return { name, translation };
    });
    const rootNodes = [];
    for (const { name } of bones) {
      let parent = VRMHumanBoneParentMap[name];
      while (parent && !indices.has(parent)) parent = VRMHumanBoneParentMap[parent];
      const index = indices.get(name);
      if (parent) (nodes[indices.get(parent)].children ??= []).push(index);
      else rootNodes.push(index);
    }
    const restHips = humanoid.getNormalizedBoneNode('hips').position.clone();
    if (restHips.y <= .001) error('Tポーズの腰の高さが不正です。');
    const humanBones = Object.fromEntries(bones.map(({ name }, node) => [name, { node }]));
    const expressionNodes = Object.fromEntries(expressions.map(name => {
      const node = nodes.length;
      nodes.push({ name: `Expression_${name}`, translation: [0, 0, 0] }); rootNodes.push(node);
      return [name, { node }];
    }));
    const times = [];
    for (let i = 0; i / fps < motion.duration; i++) times.push(Math.fround(i / fps));
    const endpoint = Math.fround(motion.duration);
    if (!times.length || endpoint > times.at(-1)) times.push(endpoint);
    const rotations = bones.map(() => []), translations = [], weights = expressions.map(() => []);
    for (const t of times) {
      humanoid.resetNormalizedPose();
      for (const name of expressions) vrm.expressionManager.setValue(name, 0);
      if (capture) applyCaptureToVRM(vrm, motion, t);
      else applyDemoMotion(vrm, motion, t, restHips);
      bones.forEach(({ name, bone }, index) => {
        const q = bone.quaternion.clone().normalize();
        const value = q.toArray();
        if (!finite(value)) error(`${name} の回転が不正です。`);
        const values = rotations[index];
        if (values.length && value.reduce((dot, component, i) => dot + component * values[values.length - 4 + i], 0) < 0) value.forEach((component, i) => { value[i] = -component; });
        values.push(...value);
      });
      const position = canonicalVector(humanoid.getNormalizedBoneNode('hips').position);
      if (!finite(position)) error('腰の位置が不正です。');
      translations.push(...position);
      expressions.forEach((name, i) => weights[i].push(Math.max(0, Math.min(1, vrm.expressionManager.getValue(name) ?? 0)), 0, 0));
    }
    const arrays = [{ values: times, type: 'SCALAR', min: [0], max: [times.at(-1)] }];
    const channels = [], samplers = [];
    const channel = (node, path, values, type) => {
      const output = arrays.length; arrays.push({ values, type });
      const sampler = samplers.length; samplers.push({ input: 0, output, interpolation: 'LINEAR' });
      channels.push({ sampler, target: { node, path } });
    };
    bones.forEach(({ name }, index) => channel(indices.get(name), 'rotation', rotations[index], 'VEC4'));
    channel(indices.get('hips'), 'translation', translations, 'VEC3');
    expressions.forEach((name, index) => channel(expressionNodes[name].node, 'translation', weights[index], 'VEC3'));
    const extension = { specVersion: '1.0', humanoid: { humanBones }, ...(expressions.length ? { expressions: { preset: expressionNodes } } : {}) };
    return binaryGLTF({
      asset: { version: '2.0', generator: 'vli.bar VRM Animation exporter 1.0' },
      extensionsUsed: [EXTENSION], extensions: { [EXTENSION]: extension },
      scene: 0, scenes: [{ name: 'VRM Animation', nodes: rootNodes }], nodes,
      animations: [{ name: capture ? 'Captured performance' : motion.title, channels, samplers }],
      extras: { source: capture ? (motion.tracking?.body === 'browser-body'
        ? 'WebXR head, hands and browser body joints; browser and retargeting estimates included'
        : 'WebXR head and controller or hand-wrist capture; torso and limbs inferred')
        : 'Original vli.bar choreography', bakedFramesPerSecond: fps },
    }, arrays);
  } finally {
    for (const { bone, position, quaternion, scale } of originalPose) { bone.position.copy(position); bone.quaternion.copy(quaternion); bone.scale.copy(scale); }
    for (const [name, value] of originalExpressions) vrm.expressionManager.setValue(name, value);
    vrm.scene.updateMatrixWorld(true);
  }
}
