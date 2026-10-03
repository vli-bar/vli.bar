import {createReadStream, constants} from 'node:fs';
import {access, chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const SOURCE = fileURLToPath(import.meta.url);
const MANIFEST = 'manifest.sha256.json';
const FILES = ['server/lan-server.js', 'src/live-protocol.js', 'scripts/create-lan-cert.mjs', 'scripts/start-offline-lan.mjs'];
export const REQUIRED_OFFLINE_ASSETS = [
  'index.html', 'help/lan-offline.html', 'demo/vli-performer.vrm', 'demo/neon-door.wav', 'demo/neon-door.vrma',
  'vendor/mediapipe/pose_landmarker_lite.task', 'vendor/mediapipe/LICENSE',
  'vendor/mediapipe/wasm/vision_wasm_internal.js', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.js', 'vendor/mediapipe/wasm/vision_wasm_nosimd_internal.wasm',
];
const exists = filename => access(filename).then(() => true, () => false);
const portable = filename => filename.split(path.sep).join('/');

async function fileList(root, directory = '') {
  const result = [];
  for (const entry of await readdir(path.join(root, directory), {withFileTypes: true})) {
    const relative = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed in offline assets: ${portable(relative)}`);
    if (entry.isDirectory()) result.push(...await fileList(root, relative));
    else if (entry.isFile()) result.push(portable(relative));
    else throw new Error(`Unsupported offline asset: ${portable(relative)}`);
  }
  return result.sort();
}
async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}
async function copyRegular(source, destination, executable = false) {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular file: ${source}`);
  await mkdir(path.dirname(destination), {recursive: true});
  await copyFile(source, destination, constants.COPYFILE_FICLONE);
  await chmod(destination, executable ? 0o755 : 0o644);
}
async function copyTree(source, destination) {
  const info = await lstat(source);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Expected an asset directory: ${source}`);
  for (const relative of await fileList(source)) await copyRegular(path.join(source, relative), path.join(destination, relative));
}

/** Check fetchable HTML/CSS/ESM references, in addition to the dynamic ML assets. */
export async function validateOfflineAssets(distRoot) {
  const files = await fileList(distRoot), available = new Set(files);
  for (const required of REQUIRED_OFFLINE_ASSETS) if (!available.has(required)) throw new Error(`Offline asset missing: dist/${required}. Run npm run build first.`);
  const resolveReference = (from, value) => {
    if (!value || value.startsWith('#') || /^(?:data|blob):/i.test(value)) return;
    if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) throw new Error(`External runtime asset is not offline: ${from} -> ${value}`);
    let name;
    try { name = decodeURIComponent(value.split(/[?#]/)[0]); } catch { throw new Error(`Invalid asset URL in ${from}`); }
    if (!name) return;
    const target = path.posix.normalize(name.startsWith('/') ? name.slice(1) : path.posix.join(path.posix.dirname(from), name));
    if (target.startsWith('../') || !available.has(target)) throw new Error(`Missing local asset: ${from} -> ${value}`);
  };
  for (const filename of files) {
    if (!/\.(?:html|css|js|mjs)$/.test(filename)) continue;
    const text = await readFile(path.join(distRoot, filename), 'utf8');
    if (filename.endsWith('.html')) {
      for (const match of text.matchAll(/<(script|link|img|audio|video|source|iframe)\b([^>]*)>/gi)) {
        const attributes = Object.fromEntries([...match[2].matchAll(/([\w-]+)\s*=\s*["']([^"']*)["']/g)].map(item => [item[1].toLowerCase(), item[2]]));
        const tag = match[1].toLowerCase();
        if (tag === 'link') {
          if (/^(?:stylesheet|modulepreload|preload|icon)$/i.test(attributes.rel ?? '')) resolveReference(filename, attributes.href);
        } else resolveReference(filename, attributes.src);
        if (tag === 'video') resolveReference(filename, attributes.poster);
      }
    } else if (filename.endsWith('.css')) {
      for (const match of text.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi)) resolveReference(filename, match[1]);
      for (const match of text.matchAll(/@import\s+["']([^"']+)["']/gi)) resolveReference(filename, match[1]);
    } else {
      for (const match of text.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)|\b(?:import|export)\s*(?:[^;"']*?\bfrom\s*)?["']([^"']+)["']/g)) {
        const reference = match[1] ?? match[2];
        if (reference.startsWith('.') || reference.startsWith('/') || /^[a-z]+:/i.test(reference)) resolveReference(filename, reference);
        else throw new Error(`Unbundled module is not offline: ${filename} -> ${reference}`);
      }
    }
  }
  return files;
}

/** Verify immutable kit files. Runtime-generated certificates are never included. */
export async function verifyOfflineKit(kitRoot) {
  const root = path.resolve(kitRoot);
  const manifest = JSON.parse(await readFile(path.join(root, MANIFEST), 'utf8'));
  if (manifest.format !== 'vli.offline-kit' || manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.files.length) throw new Error('Invalid offline manifest.');
  const seen = new Set();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\') || entry.path.startsWith('/') || entry.path.split('/').some(part => !part || part === '..' || part === '.') ||
        entry.path === MANIFEST || seen.has(entry.path) || !/^[a-f\d]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error('Unsafe offline manifest entry.');
    seen.add(entry.path);
    const filename = path.join(root, entry.path), info = await lstat(filename);
    const resolved = await realpath(filename);
    if (!resolved.startsWith(await realpath(root) + path.sep) || info.isSymbolicLink() || !info.isFile() || info.size !== entry.size || await hashFile(filename) !== entry.sha256) throw new Error(`Offline file failed verification: ${entry.path}`);
    if (process.platform !== 'win32' && entry.executable && !(info.mode & 0o111)) throw new Error(`Offline executable permission missing: ${entry.path}`);
  }
  return {platform: manifest.platform, arch: manifest.arch, nodeVersion: manifest.nodeVersion, files: seen.size};
}

async function findNodeLicense(node, requested) {
  if (requested) return path.resolve(requested);
  for (const candidate of [path.join(path.dirname(node), 'LICENSE'), path.resolve(path.dirname(node), '..', 'LICENSE'), path.resolve(path.dirname(node), '..', 'share', 'doc', 'node', 'LICENSE')]) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error('Node.js redistribution LICENSE was not found. Pass nodeLicensePath for this runtime.');
}

/** Build from an existing dist only. No downloads, npm install, or private files. */
export async function buildOfflineKit({repoRoot = fileURLToPath(new URL('..', import.meta.url)), outputRoot,
  nodeExecutable = process.execPath, nodeLicensePath, platform = process.platform, arch = process.arch} = {}) {
  const repository = path.resolve(repoRoot);
  if (!['darwin', 'linux', 'win32'].includes(platform) || !/^[a-z\d_-]{1,24}$/.test(arch)) throw new Error('Unsupported kit platform or architecture.');
  const output = path.resolve(outputRoot ?? path.join(repository, 'artifacts'));
  const directory = path.join(output, `vli-bar-offline-${platform}-${arch}`);
  if (await exists(directory)) throw new Error(`Offline kit already exists; keep its certificates safe and choose a new outputRoot: ${directory}`);
  await validateOfflineAssets(path.join(repository, 'dist'));
  const executable = await realpath(nodeExecutable);
  const runtimeLicense = await findNodeLicense(executable, nodeLicensePath);
  const nodeCheck = spawnSync(executable, ['--version'], {encoding: 'utf8', timeout: 10000, env: {...process.env, PATH: ''}});
  if (nodeCheck.status !== 0 || !/^v\d+\.\d+\.\d+/.test(nodeCheck.stdout?.trim() ?? '')) throw new Error(`Bundled Node cannot run without the host PATH: ${nodeCheck.error?.message ?? nodeCheck.stderr ?? ''}`);
  const nodeVersion = nodeCheck.stdout.trim();
  const appPackage = JSON.parse(await readFile(path.join(repository, 'package.json'), 'utf8'));
  const wsPackage = JSON.parse(await readFile(path.join(repository, 'node_modules/ws/package.json'), 'utf8'));
  if (wsPackage.name !== 'ws' || !wsPackage.version || Object.keys(wsPackage.dependencies ?? {}).length) throw new Error('Unsupported ws package dependency layout.');
  const wsRoot = path.join(repository, 'node_modules/ws');
  if (!await exists(path.join(wsRoot, 'LICENSE'))) throw new Error('ws redistribution LICENSE is missing.');
  await mkdir(output, {recursive: true});
  const temporary = path.join(output, `.vli-offline-building-${randomUUID()}`);
  try {
    await mkdir(temporary);
    await copyTree(path.join(repository, 'dist'), path.join(temporary, 'dist'));
    for (const name of FILES) await copyRegular(path.join(repository, name), path.join(temporary, name));
    await copyTree(wsRoot, path.join(temporary, 'node_modules/ws'));
    await copyRegular(SOURCE, path.join(temporary, 'scripts/build-offline-kit.mjs'));
    const runtimeName = platform === 'win32' ? 'node.exe' : 'node';
    await copyRegular(executable, path.join(temporary, 'runtime', runtimeName), true);
    await copyRegular(runtimeLicense, path.join(temporary, 'runtime/LICENSE'));
    for (const [name, directory] of [['three', 'three'], ['@pixiv/three-vrm', 'pixiv-three-vrm'], ['@pixiv/three-vrm-animation', 'pixiv-three-vrm-animation'], ['@mediapipe/tasks-vision', 'mediapipe-tasks-vision']]) {
      for (const filename of ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'NOTICE', 'NOTICE.txt']) {
        const source = path.join(repository, 'node_modules', name, filename);
        if (await exists(source)) await copyRegular(source, path.join(temporary, 'licenses', directory, filename));
      }
    }
    for (const license of ['LICENSE', 'NOTICE']) if (await exists(path.join(repository, license))) await copyRegular(path.join(repository, license), path.join(temporary, license));
    await writeFile(path.join(temporary, 'package.json'), JSON.stringify({name: 'vli-bar-offline', version: appPackage.version ?? '0.0.0', private: true, type: 'module', dependencies: {ws: wsPackage.version}}, null, 2) + '\n');
    const shell = '#!/bin/sh\nset -eu\ncase "$0" in */*) kit_dir=${0%/*} ;; *) kit_dir=. ;; esac\ncd -- "$kit_dir"\nexec "./runtime/node" "./scripts/start-offline-lan.mjs" "$@"\n';
    const launchers = platform === 'win32' ? ['start.cmd'] : platform === 'darwin' ? ['start.command', 'start.sh'] : ['start.sh'];
    for (const launcher of launchers) {
      const text = platform === 'win32' ? '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\n"%~dp0runtime\\node.exe" "%~dp0scripts\\start-offline-lan.mjs" %*\r\n' : shell;
      await writeFile(path.join(temporary, launcher), text, {mode: 0o755});
    }
    await writeFile(path.join(temporary, 'START-HERE.txt'), `vli.bar 完全ローカル LAN キット\n\n対象: ${platform} / ${arch} (${nodeVersion})\nこの OS・CPU 用の Node.js を同梱しています。別の OS・CPU には移植できません。\n\n1. 同じ会場 Wi-Fi/LAN に配信用 PC と閲覧端末を接続します。外部インターネットは不要です。\n2. ${launchers[0]} を起動します。会場で npm / Node.js のインストールは不要です。\n3. 初回は画面に示された CA 証明書を各端末へコピーし、手動で信頼させてください。\n4. 表示された HTTPS URL を開き、同じルーム名・合言葉で参加します。\n\n初回および接続先 IP 変更時の証明書発行には、その PC の OpenSSL が必要です。\nmacOS の標準 OpenSSL を想定しています。Windows/Linux は事前配置を確認してください。\nブラウザ・ARCore・端末の AR 対応と証明書の信頼設定も事前に用意してください。\nローカルヘルプは起動後 /help/lan-offline.html を開いてください。\n\n秘密鍵・合言葉・ユーザー VRM はこのキットに含めていません。\n初回起動後に生成される .lan-certs 内の秘密鍵は配布しないでください。\n\n整合性確認: ${platform === 'win32' ? 'runtime\\node.exe' : './runtime/node'} scripts/build-offline-kit.mjs --verify .\nmanifest.sha256.json は配布時の全ファイルを列挙します（manifest 自身と起動後の証明書を除く）。\n`);
    const files = [];
    for (const filename of await fileList(temporary)) {
      const absolute = path.join(temporary, filename), info = await lstat(absolute);
      files.push({path: filename, size: info.size, sha256: await hashFile(absolute), ...(info.mode & 0o111 ? {executable: true} : {})});
    }
    await writeFile(path.join(temporary, MANIFEST), JSON.stringify({format: 'vli.offline-kit', version: 1, platform, arch, nodeVersion,
      createdAt: new Date().toISOString(), runtimeRequirements: {openssl: 'Required locally for first certificate creation or LAN address changes'}, files}, null, 2) + '\n');
    await verifyOfflineKit(temporary);
    if (await exists(directory)) throw new Error(`Offline kit appeared during build: ${directory}`);
    await rename(temporary, directory);
    return {directory, platform, arch, nodeVersion, files: files.length};
  } catch (error) { await rm(temporary, {recursive: true, force: true}); throw error; }
}

// Node resolves the module URL through symlinks; argv can retain a symlink or
// macOS /var alias. Compare canonical paths so an explicit CLI never exits
// successfully without building/verifying anything.
const isEntrypoint = process.argv[1] && await Promise.all([realpath(process.argv[1]), realpath(SOURCE)])
  .then(([entry, source]) => entry === source, () => false);
if (isEntrypoint) {
  try {
    if (process.argv[2] === '--verify') console.log(JSON.stringify(await verifyOfflineKit(process.argv[3] ?? process.cwd()), null, 2));
    else if (process.argv.length > 2) throw new Error('Usage: node scripts/build-offline-kit.mjs [--verify KIT_DIRECTORY]');
    else console.log(JSON.stringify(await buildOfflineKit(), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
