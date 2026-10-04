// Build the real UI with a synthetic camera into a separate, non-public folder.
import {build} from 'vite';
import {fileURLToPath} from 'node:url';
import {mkdtemp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('..',import.meta.url));
const output = await mkdtemp(path.join(os.tmpdir(),'vli-iphone-smoke-'));
await build({root,plugins:[{name:'synthetic-camera-for-iphone-smoke',enforce:'pre',resolveId(source,importer) {
  if (source === './marker-ar.js' && importer === path.join(root,'src/main.js')) return path.join(root,'tests/browser/iphone-app-marker.js');
}}],build:{outDir:output,emptyOutDir:false}});
console.log(`SYNTHETIC_APP_DIST=${output}`);
