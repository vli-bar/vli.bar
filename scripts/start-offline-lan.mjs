import {access,readFile,copyFile} from 'node:fs/promises';
import {realpathSync,constants} from 'node:fs';
import {networkInterfaces} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createLanServer} from '../server/lan-server.js';
import {ensureLanCertificate} from './create-lan-cert.mjs';

const defaultRoot=fileURLToPath(new URL('../',import.meta.url));
export function isPrivateIPv4(address) {
  if(typeof address!=='string')return false;
  const parts=address.split('.');
  if(parts.length!==4 || parts.some(part=>!/^\d{1,3}$/.test(part) || Number(part)>255 || String(Number(part))!==part))return false;
  const [a,b]=parts.map(Number);
  return a===10 || a===172 && b>=16 && b<=31 || a===192 && b===168 || a===169 && b===254;
}
export function lanAddresses(interfaces=networkInterfaces()) {
  return [...new Set(Object.values(interfaces).flatMap(items=>(items??[]).filter(item=>!item.internal && (item.family==='IPv4' || item.family===4) && isPrivateIPv4(item.address)).map(item=>item.address)))].sort();
}
export function selectLanHost(host,interfaces=networkInterfaces()) {
  const candidates=lanAddresses(interfaces);
  if(host) {
    if(!isPrivateIPv4(host) || !candidates.includes(host))throw new Error('--hostにはこのPCのLANインターフェースのプライベートIPv4を指定してください。');
    return host;
  }
  if(!candidates.length)throw new Error('LANのIPv4が見つかりません。会場のWi-Fiまたは有線LANへ接続してください。WAN接続は不要です。');
  if(candidates.length>1)throw new Error(`LANの候補が複数あります。会場Wi-FiのIPを --host で指定してください: ${candidates.join(', ')}`);
  return candidates[0];
}
export function offlineOptions(args) {
  const options={};
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--localhost')options.localhost=true;
    else if(args[i]==='--check')options.check=true;
    else if(['--host','--port','--cert-dir'].includes(args[i]) && args[i+1] && !args[i+1].startsWith('--')) {
      const name=args[i].slice(2);options[name==='cert-dir'?'certDir':name]=args[++i];
    } else throw new Error(`未対応の引数です: ${args[i]}\n使用法: start-offline-lan.mjs [--host LANのIPv4] [--port 8443] [--cert-dir 保存先]`);
  }
  if(options.port!==undefined) {
    options.port=Number(options.port);
    if(!Number.isInteger(options.port) || options.port<1 || options.port>65535)throw new Error('--portは1〜65535の整数で指定してください。');
  }
  return options;
}

/** Uses only bundled app files, local TLS tools, and the venue network. */
export async function startOfflineLan({root=defaultRoot,host,port,certDir,localhost=false,check=false,interfaces=networkInterfaces(),log=console.log}={}) {
  root=path.resolve(root);
  if(await access(path.join(root,'manifest.sha256.json')).then(()=>true,()=>false)) {
    const {verifyOfflineKit}=await import('./build-offline-kit.mjs');
    await verifyOfflineKit(root);
  }
  try {await access(path.join(root,'dist','index.html'));}
  catch {throw new Error('配信用dist/index.htmlがありません。準備済みのオフラインキットを使用してください。会場でnpm install/buildは実行しません。');}
  if(localhost && host && !['localhost','127.0.0.1','::1'].includes(host))throw new Error('--localhostはloopback専用です。LAN端末にはHTTPSを使用してください。');
  host=localhost?(host??'127.0.0.1'):selectLanHost(host,interfaces);
  port=port??(localhost?8080:8443);
  if(!Number.isInteger(port) || port<0 || port>65535)throw new Error('ポート番号が不正です。');
  let certificate,tls={};
  if(!localhost) {
    certificate=await ensureLanCertificate({directory:certDir?path.resolve(root,certDir):path.join(root,'.lan-certs'),hosts:[host],reuse:true});
    tls={cert:await readFile(certificate.certPath),key:await readFile(certificate.keyPath)};
    const visibleCA=path.join(root,'venue-ca.crt');
    try {await copyFile(certificate.caPath,visibleCA,constants.COPYFILE_EXCL);certificate.publicCaPath=visibleCA;}
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      if((await readFile(visibleCA)).equals(await readFile(certificate.caPath)))certificate.publicCaPath=visibleCA;
      else log('既存のvenue-ca.crtは変更していません。以下に示すCAファイルを使用してください。');
    }
  }
  if(check) {
    log(`オフライン起動の準備を確認しました。待受は開始していません。\n接続先: ${localhost?'http':'https'}://${host}:${port}\n${certificate?`CA: ${certificate.publicCaPath??certificate.caPath}`:'localhost開発モードです。'}`);
    return {relay:null,url:`${localhost?'http':'https'}://${host}:${port}`,certificate,checked:true};
  }
  const relay=createLanServer({localhost,host,port,distDir:path.join(root,'dist'),...tls});
  let address;
  try {address=await relay.listen();}catch(error){await relay.close();throw error;}
  const url=`${localhost?'http':'https'}://${host==='::1'?'[::1]':host}:${address.port}`;
  log(`オフライン会場サーバー: ${url}\nローカル手順: ${url}/help/\n全端末を同じLANへ接続してください。WAN・公開サイトへの接続は不要です。`);
  if(certificate)log(`端末に手動で信頼させるCA: ${certificate.publicCaPath??certificate.caPath}\n${certificate.rotated?'IP/有効期限に合わせてサーバー証明書だけを更新しました。既存CAは維持しました。':certificate.reused?'既存の証明書を再利用しました。':'CAとサーバー証明書を作成しました。'}\nOSの信頼設定は変更していません。秘密鍵（*.key）は配布しないでください。`);
  return {relay,url,certificate};
}

if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const {relay}=await startOfflineLan(offlineOptions(process.argv.slice(2)));
    if(relay)for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>relay.close().then(()=>process.exit(0)));
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
