// Separate synthetic XR fixture build. It is never included in the public app.
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = await mkdtemp(path.join(os.tmpdir(), 'vli-wall-smoke-'));
await build({ configFile: false, root, base: './', publicDir: false,
  build: { outDir: output, emptyOutDir: false,
    rollupOptions: { input: path.join(root, 'tests/browser/wall-smoke.html') } } });
console.log(`SYNTHETIC_WALL_DIST=${output}`);
console.log('SYNTHETIC_WALL_ENTRY=/tests/browser/wall-smoke.html');
