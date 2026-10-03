import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, chmod, stat, rm, readdir, symlink, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildOfflineKit, verifyOfflineKit, validateOfflineAssets, REQUIRED_OFFLINE_ASSETS} from '../scripts/build-offline-kit.mjs';

async function fixture(t, {realNode = false} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vli-offline-test-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const repoRoot = path.join(directory, 'source'), outputRoot = path.join(directory, 'output');
  const put = async (relative, text = 'fixture') => { const file = path.join(repoRoot, relative); await mkdir(path.dirname(file), {recursive: true}); await writeFile(file, text); return file; };
  for (const asset of REQUIRED_OFFLINE_ASSETS) await put(`dist/${asset}`, /\.html$/.test(asset) ? '<!doctype html><html><body>Offline</body></html>' : 'local asset');
  await put('dist/index.html', '<script type="module" src="./assets/main.js"></script><link rel="stylesheet" href="./assets/style.css">');
  await put('dist/assets/main.js', 'import {test} from "./chunk.js"; import("./lazy.js"); console.log(test);');
  await put('dist/assets/chunk.js', 'export const test = 1;');
  await put('dist/assets/lazy.js', 'export default 2;');
  await put('dist/assets/style.css', 'body{background-image:url("./back.svg")}');
  await put('dist/assets/back.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await put('package.json', JSON.stringify({name: 'vli-fixture', version: '1.2.3', type: 'module'}));
  await put('server/lan-server.js', 'export const server = true;');
  await put('src/live-protocol.js', 'export const version = 1;');
  await put('scripts/create-lan-cert.mjs', 'export const certificate = true;');
  await put('scripts/start-offline-lan.mjs', 'console.log(JSON.stringify({exec:process.execPath,cwd:process.cwd(),args:process.argv.slice(2),path:process.env.PATH}));');
  await put('node_modules/ws/package.json', JSON.stringify({name: 'ws', version: '8.22.0'}));
  await put('node_modules/ws/index.js', 'module.exports = {};');
  await put('node_modules/ws/lib/websocket.js');
  await put('node_modules/ws/LICENSE', 'ws license fixture');
  await put('node_modules/three/LICENSE', 'three license fixture');
  await put('node_modules/@pixiv/three-vrm/LICENSE', 'vrm license fixture');
  await put('node_modules/@pixiv/three-vrm-animation/LICENSE', 'animation license fixture');
  await put('node_modules/@mediapipe/tasks-vision/LICENSE', 'mediapipe license fixture');
  await put('LICENSE', 'application license fixture');
  const nodeLicensePath = await put('node-runtime/LICENSE', 'node runtime license fixture');
  const fakeNode = await put('node-runtime/node', '#!/bin/sh\nprintf "v24.16.0\\n"\n'); await chmod(fakeNode, 0o755);
  const options = {repoRoot, outputRoot, nodeExecutable: realNode ? process.execPath : fakeNode, nodeLicensePath, platform: process.platform, arch: process.arch};
  return {directory, repoRoot, outputRoot, put, options, build: () => buildOfflineKit(options)};
}

async function listing(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), {withFileTypes: true})) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await listing(root, file)); else files.push(file.split(path.sep).join('/'));
  }
  return files.sort();
}

test('offline kit contains all local assets, runtime and licenses, while private source files are excluded', async t => {
  const f = await fixture(t);
  for (const file of ['.lan-certs/ca.key', '.lan-certs/server.key', '.env', 'local-assets/private.vrm', 'secrets/room-token.txt', 'src/main.js', 'node_modules/unrelated/private.txt']) await f.put(file, 'PRIVATE DATA');
  const built = await f.build();
  assert.equal(path.basename(built.directory), `vli-bar-offline-${process.platform}-${process.arch}`);
  const files = await listing(built.directory);
  for (const asset of REQUIRED_OFFLINE_ASSETS) assert.ok(files.includes(`dist/${asset}`), asset);
  for (const file of ['server/lan-server.js', 'src/live-protocol.js', 'scripts/create-lan-cert.mjs', 'scripts/start-offline-lan.mjs', 'scripts/build-offline-kit.mjs', 'node_modules/ws/LICENSE', 'runtime/LICENSE', 'licenses/three/LICENSE', 'licenses/pixiv-three-vrm/LICENSE', 'licenses/pixiv-three-vrm-animation/LICENSE', 'licenses/mediapipe-tasks-vision/LICENSE', 'LICENSE']) assert.ok(files.includes(file), file);
  assert.ok(files.every(file => !file.includes('private') && !file.includes('ca.key') && !file.includes('.env') && !file.includes('room-token') && !file.includes('src/main') && !file.includes('unrelated')));
  const manifest = JSON.parse(await readFile(path.join(built.directory, 'manifest.sha256.json'), 'utf8'));
  assert.deepEqual(manifest.files.map(file => file.path).sort(), files.filter(file => file !== 'manifest.sha256.json'));
  assert.equal((await verifyOfflineKit(built.directory)).files, built.files);
  const packageJson = JSON.parse(await readFile(path.join(built.directory, 'package.json'), 'utf8'));
  assert.equal(packageJson.type, 'module'); assert.deepEqual(packageJson.dependencies, {ws: '8.22.0'});
  const launcher = process.platform === 'win32' ? 'start.cmd' : process.platform === 'darwin' ? 'start.command' : 'start.sh';
  const text = await readFile(path.join(built.directory, launcher), 'utf8');
  assert.ok(text.includes('runtime')); assert.ok(!text.includes('npm'));
});

test('bundled launcher and verifier run with an empty PATH and do not invoke host node or npm', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t, {realNode: true}); const built = await f.build();
  const launcher = process.platform === 'darwin' ? 'start.command' : 'start.sh';
  const run = spawnSync(path.join(built.directory, launcher), ['--host', '192.168.1.22', 'argument with spaces'], {cwd: tmpdir(), env: {...process.env, PATH: ''}, encoding: 'utf8', timeout: 10000});
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const result = JSON.parse(run.stdout);
  assert.equal(result.exec, await realpath(path.join(built.directory, 'runtime/node')));
  assert.equal(result.cwd, await realpath(built.directory)); assert.equal(result.path, '');
  assert.deepEqual(result.args, ['--host', '192.168.1.22', 'argument with spaces']);
  const verify = spawnSync(path.join(built.directory, 'runtime/node'), ['scripts/build-offline-kit.mjs', '--verify', '.'], {cwd: built.directory, env: {...process.env, PATH: ''}, encoding: 'utf8', timeout: 10000});
  assert.equal(verify.status, 0, verify.stderr); assert.equal(JSON.parse(verify.stdout).files, built.files);
});

test('manifest detects changed model bytes and missing executable permissions', async t => {
  const f = await fixture(t); const built = await f.build();
  const model = path.join(built.directory, 'dist/vendor/mediapipe/pose_landmarker_lite.task');
  await writeFile(model, 'corrupted'); await assert.rejects(verifyOfflineKit(built.directory), /failed verification.*pose_landmarker/);
  await writeFile(model, 'local asset');
  if (process.platform !== 'win32') {
    await chmod(path.join(built.directory, 'runtime/node'), 0o644);
    await assert.rejects(verifyOfflineKit(built.directory), /executable permission/);
  }
});

test('builder refuses an existing kit so newly created certificate keys cannot be overwritten', async t => {
  const f = await fixture(t); const built = await f.build();
  const key = path.join(built.directory, '.lan-certs/ca.key'); await mkdir(path.dirname(key)); await writeFile(key, 'KEEP EXISTING PRIVATE KEY');
  await assert.rejects(f.build(), /already exists/);
  assert.equal(await readFile(key, 'utf8'), 'KEEP EXISTING PRIVATE KEY');
  assert.ok(await verifyOfflineKit(built.directory), 'runtime-generated certificates are outside the immutable manifest');
});

test('required model and offline help must be present before packaging', async t => {
  const f = await fixture(t);
  await rm(path.join(f.repoRoot, 'dist/help/lan-offline.html'));
  await assert.rejects(f.build(), /Offline asset missing.*help/);
  await f.put('dist/help/lan-offline.html', '<p>offline</p>');
  await rm(path.join(f.repoRoot, 'dist/vendor/mediapipe/pose_landmarker_lite.task'));
  await assert.rejects(f.build(), /Offline asset missing.*pose_landmarker/);
});

test('static dependency closure rejects missing chunks, external runtime resources and unbundled packages', async t => {
  const f = await fixture(t);
  await f.put('dist/assets/main.js', 'import "./missing.js";');
  await assert.rejects(validateOfflineAssets(path.join(f.repoRoot, 'dist')), /Missing local asset/);
  await f.put('dist/assets/main.js', 'import "unbundled-dependency";');
  await assert.rejects(validateOfflineAssets(path.join(f.repoRoot, 'dist')), /Unbundled module/);
  await f.put('dist/assets/main.js', 'export const test = 1;');
  await f.put('dist/index.html', '<script src="https://cdn.example.com/runtime.js"></script>');
  await assert.rejects(f.build(), /External runtime asset/);
  await f.put('dist/index.html', '<script src="./assets/main.js"></script><a href="https://example.com/documentation">Optional docs</a>');
  assert.ok((await validateOfflineAssets(path.join(f.repoRoot, 'dist'))).length > 0, 'ordinary links do not become runtime dependencies');
});

test('asset symlinks are rejected and failed builds leave no partial distribution', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t);
  const privateKey = await f.put('.lan-certs/ca.key', 'PRIVATE');
  await symlink(privateKey, path.join(f.repoRoot, 'dist/leaked.key'));
  await assert.rejects(f.build(), /Symlinks/);
  await rm(path.join(f.repoRoot, 'dist/leaked.key'));
  await rm(path.join(f.repoRoot, 'scripts/start-offline-lan.mjs'));
  await assert.rejects(f.build(), /ENOENT/);
  assert.deepEqual(await readdir(f.outputRoot), [], 'only the builder-owned temporary directory is removed on failure');
});

test('Windows artifact selects an explicit bundled exe and command launcher', async t => {
  const f = await fixture(t);
  const built = await buildOfflineKit({...f.options, platform: 'win32', arch: 'x64'});
  const launcher = await readFile(path.join(built.directory, 'start.cmd'), 'utf8');
  assert.match(launcher, /runtime\\node\.exe/);
  assert.ok((await stat(path.join(built.directory, 'runtime/node.exe'))).isFile());
  assert.match(await readFile(path.join(built.directory, 'START-HERE.txt'), 'utf8'), /win32 \/ x64/);
});

test('verifier CLI executes through a symlink instead of returning a silent success', {skip: process.platform === 'win32'}, async t => {
  const f = await fixture(t); const built = await f.build();
  const alias = path.join(f.directory, 'verify-alias.mjs');
  await symlink(path.join(built.directory, 'scripts/build-offline-kit.mjs'), alias);
  const result = spawnSync(process.execPath, [alias, '--verify', built.directory], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).files, built.files);
  await writeFile(path.join(built.directory, 'dist/demo/vli-performer.vrm'), 'tampered');
  const failed = spawnSync(process.execPath, [alias, '--verify', built.directory], {encoding: 'utf8', timeout: 10000});
  assert.equal(failed.status, 1); assert.match(failed.stderr, /verification/);
});
