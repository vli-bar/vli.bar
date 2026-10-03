import { readFile, writeFile } from 'node:fs/promises';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation';
import { exportMotionVRMA } from '../src/vrma-export.js';

const modelBytes = await readFile(new URL('../public/demo/vli-performer.vrm', import.meta.url));
const loader = new GLTFLoader();
loader.register(parser => new VRMLoaderPlugin(parser));
const model = await loader.parseAsync(modelBytes.buffer.slice(modelBytes.byteOffset, modelBytes.byteOffset + modelBytes.byteLength), '');
const motion = JSON.parse(await readFile(new URL('../public/demo/motion.json', import.meta.url), 'utf8'));
const vrma = exportMotionVRMA(model.userData.vrm, motion);
const animationLoader = new GLTFLoader();
animationLoader.register(parser => new VRMAnimationLoaderPlugin(parser));
const check = await animationLoader.parseAsync(vrma, '');
if (check.userData.vrmAnimations?.length !== 1 || Math.abs(check.userData.vrmAnimations[0].duration - motion.duration) > .001) throw new Error('Official VRMA loader verification failed');
await writeFile(new URL('../public/demo/neon-door.vrma', import.meta.url), new Uint8Array(vrma));
console.log(`Exported and verified neon-door.vrma: ${vrma.byteLength} bytes, ${motion.duration} seconds`);
