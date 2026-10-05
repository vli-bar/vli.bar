// Separate synthetic headset fixture. Never included in the public app build.
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(path.join(os.tmpdir(), 'vli-headset-smoke-'));
await build({ configFile: false, root, base: './', publicDir: false,
  build: { outDir: output, emptyOutDir: false,
    rollupOptions: { input: path.join(root, 'tests/browser/headset-smoke.html') } } });
console.log(`SYNTHETIC_HEADSET_DIST=${output}`);
console.log('SYNTHETIC_HEADSET_ENTRY=/tests/browser/headset-smoke.html');
