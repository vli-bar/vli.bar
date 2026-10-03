/**
 * Build LUMI, the original vli.bar demo performer, without external assets.
 * Run: node scripts/generate-avatar.mjs
 * Geometry is attached to a VRM 1.0 humanoid rig, so normalized humanoid poses
 * animate every body part. A rigid android design deliberately needs no skin.
 */
import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../public/demo/', import.meta.url));
const gltf = {
  asset: { version: '2.0', generator: 'vli.bar original LUMI avatar generator 1.0' },
  scene: 0, scenes: [{ name: 'LUMI — virtual stage performer', nodes: [0] }],
  nodes: [{ name: 'LUMI', children: [] }], meshes: [], materials: [],
  accessors: [], bufferViews: [], buffers: [], extensionsUsed: ['VRMC_vrm'],
};
const binary = [];
let binarySize = 0;
const bones = {};
const humanBones = {};
const expressions = {};

function material(name, color, { metalness = 0.15, roughness = 0.5, glow = 0 } = {}) {
  const rgb = new THREE.Color(color).toArray();
  const index = gltf.materials.length;
  gltf.materials.push({ name, pbrMetallicRoughness: {
    baseColorFactor: [...rgb, 1], metallicFactor: metalness, roughnessFactor: roughness,
  }, ...(glow ? { emissiveFactor: rgb.map(value => value * glow) } : {}) });
  return index;
}
const pearl = material('Pearl ceramic', '#edf6f4', { metalness: 0.24, roughness: 0.3 });
const ink = material('Midnight enamel', '#25233d', { metalness: 0.35, roughness: 0.32 });
const lavender = material('Lavender fabric', '#9972ea', { roughness: 0.8 });
const teal = material('Teal lacquer', '#20c6bc', { metalness: 0.2 });
const dark = material('Soft charcoal joints', '#111b26', { metalness: 0.2 });
const visor = material('Obsidian faceplate', '#111b30', { metalness: 0.15, roughness: 0.2 });
const mint = material('Mint luminous trim', '#85ffdc', { glow: 0.65, metalness: 0 });
const lime = material('Citron accent', '#d8ff79', { glow: 0.18 });
const rose = material('Rose LED cheeks', '#ff7bbd', { glow: 0.4 });

function node(name, parent, translation = [0, 0, 0]) {
  const index = gltf.nodes.length;
  gltf.nodes.push({ name, translation, children: [] });
  gltf.nodes[parent].children.push(index);
  return index;
}
function bone(name, parent, translation) {
  const index = node(name, parent === null ? 0 : bones[parent], translation);
  bones[name] = index;
  humanBones[name] = { node: index };
  return index;
}

bone('hips', null, [0, 0.845, 0]);
bone('spine', 'hips', [0, 0.135, 0]);
bone('chest', 'spine', [0, 0.145, 0]);
bone('upperChest', 'chest', [0, 0.12, 0]);
bone('neck', 'upperChest', [0, 0.12, 0]);
bone('head', 'neck', [0, 0.085, 0]);
for (const [side, sign] of [['left', 1], ['right', -1]]) {
  bone(`${side}Shoulder`, 'upperChest', [sign * 0.135, 0.027, 0]);
  bone(`${side}UpperArm`, `${side}Shoulder`, [sign * 0.072, 0, 0]);
  bone(`${side}LowerArm`, `${side}UpperArm`, [sign * 0.245, 0, 0]);
  bone(`${side}Hand`, `${side}LowerArm`, [sign * 0.215, 0, 0]);
  bone(`${side}UpperLeg`, 'hips', [sign * 0.095, -0.025, 0]);
  bone(`${side}LowerLeg`, `${side}UpperLeg`, [0, -0.355, 0]);
  bone(`${side}Foot`, `${side}LowerLeg`, [0, -0.365, 0]);
  bone(`${side}Toes`, `${side}Foot`, [0, -0.035, 0.12]);
}

function accessor(array, type, target, bounds = false) {
  while (binarySize % 4) { binary.push(Buffer.from([0])); binarySize++; }
  const raw = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  const view = gltf.bufferViews.length;
  gltf.bufferViews.push({ buffer: 0, byteOffset: binarySize, byteLength: raw.length, target });
  binary.push(raw); binarySize += raw.length;
  const components = type === 'VEC3' ? 3 : 1;
  const record = { bufferView: view, componentType: array instanceof Float32Array ? 5126 : 5123,
    count: array.length / components, type };
  if (bounds) {
    record.min = Array(components).fill(Infinity);
    record.max = Array(components).fill(-Infinity);
    for (let i = 0; i < array.length; i++) {
      record.min[i % components] = Math.min(record.min[i % components], array[i]);
      record.max[i % components] = Math.max(record.max[i % components], array[i]);
    }
  }
  return gltf.accessors.push(record) - 1;
}
function mesh(name, parent, geometry, mat, position = [0, 0, 0], rotation = null, morph = null) {
  const primitive = { attributes: {
    POSITION: accessor(geometry.attributes.position.array, 'VEC3', 34962, true),
    NORMAL: accessor(geometry.attributes.normal.array, 'VEC3', 34962),
  }, material: mat };
  if (geometry.index) primitive.indices = accessor(new Uint16Array(geometry.index.array), 'SCALAR', 34963);
  if (morph) {
    const source = geometry.attributes.position.array;
    const delta = new Float32Array(source.length);
    for (let i = 0; i < source.length; i += 3) {
      const to = morph([source[i], source[i + 1], source[i + 2]]);
      delta[i] = to[0] - source[i]; delta[i + 1] = to[1] - source[i + 1]; delta[i + 2] = to[2] - source[i + 2];
    }
    primitive.targets = [{ POSITION: accessor(delta, 'VEC3', 34962, true) }];
  }
  const model = { name, primitives: [primitive], ...(morph ? { weights: [0] } : {}) };
  const meshIndex = gltf.meshes.push(model) - 1;
  const result = node(name, typeof parent === 'string' ? bones[parent] : parent, position);
  gltf.nodes[result].mesh = meshIndex;
  if (rotation) gltf.nodes[result].rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)).toArray();
  geometry.dispose();
  return result;
}
const sphere = (x, y, z, segments = 20) => new THREE.SphereGeometry(1, segments, Math.max(8, segments / 2)).scale(x, y, z);
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
const cylinder = (top, bottom, height, segments = 16) => new THREE.CylinderGeometry(top, bottom, height, segments);
const torus = (radius, tube) => new THREE.TorusGeometry(radius, tube, 6, 28);
function ellipsoid(name, parent, scale, mat, position, rotation) {
  return mesh(name, parent, sphere(...scale), mat, position, rotation);
}

// Jacket and a flared, segmented performance tunic.
ellipsoid('Waist actuator', 'hips', [0.1, 0.12, 0.077], dark, [0, 0.055, 0]);
ellipsoid('Pearl bodice', 'spine', [0.13, 0.165, 0.085], pearl, [0, 0.09, 0]);
mesh('Tailored cropped jacket', 'chest', cylinder(0.175, 0.12, 0.16, 8).scale(1, 1, 0.64), lavender, [0, 0.055, -0.018]);
mesh('Teal breastplate', 'chest', box(0.122, 0.135, 0.018), teal, [0, 0.038, 0.084]);
mesh('Jacket zipper light', 'chest', box(0.009, 0.136, 0.012), mint, [0, 0.038, 0.098]);
mesh('Collar left', 'upperChest', box(0.048, 0.08, 0.023), pearl, [0.055, 0.026, 0.072], [0, 0, 0.5]);
mesh('Collar right', 'upperChest', box(0.048, 0.08, 0.023), pearl, [-0.055, 0.026, 0.072], [0, 0, -0.5]);
mesh('Chest star badge', 'chest', new THREE.OctahedronGeometry(0.024), lime, [-0.101, 0.065, 0.075], [0, 0, Math.PI / 4]);
mesh('Waist belt', 'hips', cylinder(0.123, 0.137, 0.055, 16).scale(1, 1, 0.72), ink, [0, 0.035, 0]);
mesh('Belt buckle', 'hips', box(0.06, 0.042, 0.02), mint, [0, 0.037, 0.1]);
mesh('Tunic inner shell', 'hips', cylinder(0.128, 0.212, 0.20, 12).scale(1, 1, 0.69), ink, [0, -0.09, 0]);
for (let i = 0; i < 12; i++) {
  const angle = Math.PI * 2 * i / 12;
  const position = [Math.sin(angle) * 0.173, -0.097, Math.cos(angle) * 0.123];
  mesh(`Tunic pleat ${i + 1}`, 'hips', box(0.076, 0.192, 0.02), i % 3 ? lavender : teal,
    position, [Math.cos(angle) * -0.35, angle, Math.sin(angle) * 0.35]);
  mesh(`Tunic light ${i + 1}`, 'hips', sphere(0.011, 0.014, 0.011, 10), mint,
    [Math.sin(angle) * 0.206, -0.174, Math.cos(angle) * 0.154]);
}
mesh('Neck column', 'neck', cylinder(0.043, 0.044, 0.12), dark, [0, 0.04, 0]);
mesh('Neck light ring', 'neck', torus(0.047, 0.006), mint, [0, 0.009, 0], [Math.PI / 2, 0, 0]);

// Helmet, hair panels, and a readable luminous face. All face parts face +Z.
ellipsoid('Pearl helmet', 'head', [0.196, 0.215, 0.174], pearl, [0, 0.077, -0.008]);
ellipsoid('Midnight back hair', 'head', [0.205, 0.222, 0.16], ink, [0, 0.091, -0.05]);
ellipsoid('Faceplate', 'head', [0.158, 0.155, 0.034], visor, [0, 0.055, 0.151]);
for (const [side, sign] of [['left', 1], ['right', -1]]) {
  const eye = mesh(`${side} eye`, 'head', sphere(0.026, 0.043, 0.01, 16), mint,
    [sign * 0.059, 0.077, 0.184], null, ([x, y, z]) => [x, y * 0.07, z]);
  (expressions.blink ??= { morphTargetBinds: [] }).morphTargetBinds.push({ node: eye, index: 0, weight: 1 });
  (expressions.happy ??= { morphTargetBinds: [] }).morphTargetBinds.push({ node: eye, index: 0, weight: 0.25 });
  mesh(`${side} eye glint`, 'head', sphere(0.007, 0.009, 0.003, 10), pearl, [sign * 0.054, 0.092, 0.195]);
  mesh(`${side} cheek LED`, 'head', sphere(0.022, 0.009, 0.004, 12), rose, [sign * 0.101, 0.021, 0.177]);
  mesh(`${side} eyebrow`, 'head', box(0.038, 0.007, 0.008), teal, [sign * 0.061, 0.135, 0.175], [0, 0, sign * -0.09]);
  ellipsoid(`${side} bob panel`, 'head', [0.058, 0.174, 0.123], ink, [sign * 0.169, 0.008, -0.025], [0, 0, sign * 0.06]);
  ellipsoid(`${side} mint bob tip`, 'head', [0.047, 0.038, 0.101], teal, [sign * 0.177, -0.125, -0.02]);
  mesh(`${side} ear cup`, 'head', cylinder(0.071, 0.071, 0.042), ink, [sign * 0.205, 0.066, -0.01], [0, 0, Math.PI / 2]);
  mesh(`${side} ear LED ring`, 'head', torus(0.05, 0.007), mint, [sign * 0.229, 0.066, -0.01], [0, Math.PI / 2, 0]);
  mesh(`${side} ear center`, 'head', cylinder(0.026, 0.026, 0.005), teal, [sign * 0.231, 0.066, -0.01], [0, 0, Math.PI / 2]);
}
const mouth = mesh('Singing mouth', 'head', sphere(0.023, 0.006, 0.007, 16), mint, [0, -0.013, 0.185],
  null, ([x, y, z]) => [x * 0.82, y * 4.4, z]);
expressions.aa = { morphTargetBinds: [{ node: mouth, index: 0, weight: 1 }] };
expressions.oh = { morphTargetBinds: [{ node: mouth, index: 0, weight: 0.65 }] };
// Three asymmetric sweeping bangs, with a small signal antenna.
ellipsoid('Swept crown', 'head', [0.169, 0.078, 0.096], ink, [-0.018, 0.235, 0.072], [0, 0, -0.1]);
ellipsoid('Front bang', 'head', [0.112, 0.047, 0.034], teal, [0.035, 0.199, 0.154], [0, 0, 0.27]);
ellipsoid('Side bang', 'head', [0.065, 0.047, 0.034], ink, [-0.104, 0.173, 0.145], [0, 0, -0.65]);
mesh('Antenna stem', 'head', cylinder(0.006, 0.006, 0.09, 8), teal, [-0.13, 0.292, -0.046], [0, 0, -0.24]);
mesh('Antenna star', 'head', new THREE.OctahedronGeometry(0.028), lime, [-0.119, 0.337, -0.046], [0, 0, Math.PI / 4]);
// A small headset microphone makes the stage role clear without holding props.
mesh('Microphone boom', 'head', cylinder(0.004, 0.004, 0.15, 8), dark, [-0.142, -0.012, 0.104], [Math.PI / 2, 0, 0.36]);
ellipsoid('Microphone capsule', 'head', [0.018, 0.013, 0.019], dark, [-0.116, -0.018, 0.181]);

for (const [side, sign] of [['left', 1], ['right', -1]]) {
  const arm = `${side}UpperArm`, forearm = `${side}LowerArm`, hand = `${side}Hand`;
  ellipsoid(`${side} shoulder ball`, arm, [0.067, 0.074, 0.071], dark, [0, 0, 0]);
  ellipsoid(`${side} shoulder jacket`, arm, [0.10, 0.081, 0.087], lavender, [sign * 0.036, 0, 0]);
  ellipsoid(`${side} upper arm ceramic`, arm, [0.082, 0.041, 0.043], pearl, [sign * 0.15, 0, 0]);
  mesh(`${side} upper arm stripe`, arm, box(0.103, 0.012, 0.009), teal, [sign * 0.155, 0, 0.043]);
  ellipsoid(`${side} elbow joint`, forearm, [0.036, 0.038, 0.038], dark, [0, 0, 0]);
  ellipsoid(`${side} gauntlet`, forearm, [0.087, 0.047, 0.05], pearl, [sign * 0.112, 0, 0]);
  mesh(`${side} gauntlet LED`, forearm, box(0.095, 0.016, 0.01), mint, [sign * 0.111, 0, 0.049]);
  mesh(`${side} wrist ring`, forearm, cylinder(0.041, 0.041, 0.024), teal, [sign * 0.194, 0, 0], [0, 0, Math.PI / 2]);
  ellipsoid(`${side} palm`, hand, [0.05, 0.031, 0.038], pearl, [sign * 0.043, 0, 0]);
  // Fingers are original geometry, attached to the hand for robust retargeting.
  for (let i = 0; i < 3; i++) ellipsoid(`${side} finger ${i + 1}`, hand, [0.028, 0.012, 0.01], pearl,
    [sign * (0.084 - Math.abs(i - 1) * 0.006), 0, (i - 1) * 0.023]);
  ellipsoid(`${side} thumb`, hand, [0.027, 0.012, 0.012], pearl, [sign * 0.037, -0.029, 0.029], [0, 0, sign * 0.7]);

  const thigh = `${side}UpperLeg`, shin = `${side}LowerLeg`, foot = `${side}Foot`;
  ellipsoid(`${side} hip joint`, thigh, [0.069, 0.07, 0.065], dark, [0, 0, 0]);
  ellipsoid(`${side} thigh`, thigh, [0.061, 0.149, 0.062], pearl, [0, -0.178, 0]);
  mesh(`${side} thigh stripe`, thigh, box(0.013, 0.19, 0.007), teal, [sign * 0.025, -0.195, 0.059]);
  ellipsoid(`${side} knee`, shin, [0.048, 0.047, 0.046], dark, [0, 0, 0]);
  ellipsoid(`${side} knee plate`, shin, [0.043, 0.039, 0.023], lavender, [0, 0, 0.034]);
  ellipsoid(`${side} boot`, shin, [0.067, 0.157, 0.061], ink, [0, -0.189, 0]);
  mesh(`${side} boot front panel`, shin, box(0.071, 0.233, 0.019), teal, [0, -0.184, 0.055]);
  mesh(`${side} boot light`, shin, box(0.012, 0.198, 0.008), mint, [0, -0.181, 0.069]);
  mesh(`${side} boot cuff`, shin, cylinder(0.062, 0.065, 0.038).scale(1, 1, 0.9), lavender, [0, -0.053, 0]);
  ellipsoid(`${side} shoe`, foot, [0.072, 0.061, 0.113], ink, [0, -0.021, 0.047]);
  mesh(`${side} platform sole`, foot, box(0.139, 0.027, 0.192), lavender, [0, -0.066, 0.047]);
  mesh(`${side} toe light`, foot, box(0.078, 0.012, 0.014), lime, [0, -0.033, 0.145]);
}

gltf.extensions = { VRMC_vrm: {
  specVersion: '1.0',
  meta: {
    name: 'LUMI — vli.bar demo performer', version: '1.0', authors: ['vli.bar demo generator'],
    copyrightInformation: 'Original procedural geometry. Dedicated to the public domain under CC0 1.0 where possible.',
    licenseUrl: 'https://vrm.dev/licenses/1.0/', otherLicenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    avatarPermission: 'everyone', commercialUsage: 'corporation', creditNotation: 'unnecessary',
    allowRedistribution: true, modification: 'allowModificationRedistribution',
    allowExcessivelyViolentUsage: true, allowExcessivelySexualUsage: true,
    allowPoliticalOrReligiousUsage: true, allowAntisocialOrHateUsage: true,
    thirdPartyLicenses: 'No external models, textures, or motion assets. Geometry generated with Three.js (MIT).',
  },
  humanoid: { humanBones },
  firstPerson: { meshAnnotations: gltf.nodes.flatMap((item, index) => item.mesh === undefined ? [] : [{ node: index, type: 'both' }]) },
  expressions: { preset: expressions },
} };
// Remove empty children arrays to remain clean glTF, then assemble GLB chunks.
for (const item of gltf.nodes) if (item.children?.length === 0) delete item.children;
gltf.buffers.push({ byteLength: binarySize });
const json = Buffer.from(JSON.stringify(gltf));
const jsonPadded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
const bin = Buffer.concat([...binary, Buffer.alloc((4 - binarySize % 4) % 4)]);
const header = Buffer.alloc(12), jsonHeader = Buffer.alloc(8), binHeader = Buffer.alloc(8);
header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + bin.length, 8);
jsonHeader.writeUInt32LE(jsonPadded.length, 0); jsonHeader.writeUInt32LE(0x4e4f534a, 4);
binHeader.writeUInt32LE(bin.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
mkdirSync(directory, { recursive: true });
const output = Buffer.concat([header, jsonHeader, jsonPadded, binHeader, bin]);
writeFileSync(`${directory}/vli-performer.vrm`, output);
console.log(`Generated LUMI: ${(output.length / 1024).toFixed(0)} KiB, ${Object.keys(humanBones).length} humanoid bones, ${gltf.meshes.length} meshes. Front is +Z; neutral pose is T-pose.`);
