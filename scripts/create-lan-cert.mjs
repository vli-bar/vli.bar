import {mkdir,writeFile,readFile,access,mkdtemp,rename,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {isIP} from 'node:net';
import {randomBytes,X509Certificate,createPublicKey} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const defaultDirectory=fileURLToPath(new URL('../.lan-certs/',import.meta.url));
const markerName='managed.json';
const names=['ca.key','ca.crt','server.key','server.crt','server.csr','ca.cnf','server.cnf',markerName];
const exists=filename=>access(filename).then(()=>true,()=>false);
const matchesKey=(certificate,key)=>certificate.publicKey.equals(createPublicKey(key));
const validFor=(certificate,now,days)=>Date.parse(certificate.validFrom)<=now && Date.parse(certificate.validTo)>now+days*86400000;
const caConfig='[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=VLI LAN Demo CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n';

/** Generate offline, or reuse only this helper's explicitly marked CA. Never changes OS trust. */
export async function ensureLanCertificate({directory=defaultDirectory,hosts,reuse=false,now=Date.now(),openssl='openssl'}={}) {
  if (!Array.isArray(hosts)) throw new Error('接続に使うIP・ホスト名を明示してください。');
  hosts=[...new Set(hosts)];
  if (!hosts.length || hosts.some(host=>typeof host!=='string' || !isIP(host) && !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host))) throw new Error('接続に使うIP・ホスト名を確認してください。');
  directory=path.resolve(directory);
  await mkdir(directory,{recursive:true,mode:0o700});
  const occupied=[];
  for(const name of names)if(await exists(path.join(directory,name)))occupied.push(name);
  if(occupied.length && !reuse)throw new Error(`既存の ${occupied[0]} を上書きしません。既存証明書を使用するか、.lan-certsを別の場所へ退避してください。`);
  let ca,caBytes,caKey,metadata;
  const result=(reused,rotated)=>({directory,caPath:path.join(directory,'ca.crt'),certPath:path.join(directory,'server.crt'),keyPath:path.join(directory,'server.key'),reused,rotated,hosts});
  if(occupied.length) {
    try {
      metadata=JSON.parse(await readFile(path.join(directory,markerName),'utf8'));
      caBytes=await readFile(path.join(directory,'ca.crt')); caKey=await readFile(path.join(directory,'ca.key'));
      ca=new X509Certificate(caBytes);
      if(metadata.format!=='vli.lan-certificate' || metadata.version!==1 || metadata.caFingerprint!==ca.fingerprint256 || !ca.ca || !ca.verify(ca.publicKey) || !matchesKey(ca,caKey))throw new Error('unmanaged');
      if(!validFor(ca,now,1))throw new Error('CA期限またはPC時刻を確認してください。CAの自動置換は行いません。');
      const leaf=new X509Certificate(await readFile(path.join(directory,'server.crt')));
      const leafKey=await readFile(path.join(directory,'server.key'));
      if(metadata.leafFingerprint!==leaf.fingerprint256 || !leaf.verify(ca.publicKey) || !matchesKey(leaf,leafKey))throw new Error('unmanaged');
      const matches=hosts.every(host=>isIP(host)?leaf.checkIP(host)===host:!!leaf.checkHost(host));
      if(matches && validFor(leaf,now,7))return result(true,false);
    } catch(error) {
      if(error.message.startsWith('CA期限'))throw error;
      throw new Error('このツールが管理する証明書だと確認できないため上書きしません。.lan-certsを確認するか、--cert-dirで新しい保存先を指定してください。');
    }
  }
  const work=await mkdtemp(path.join(directory,'.creating-'));
  const previousMask=process.umask(0o077);
  try {
    const run=args=>{
      const execution=spawnSync(openssl,args,{cwd:work,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:30000});
      if(execution.error?.code==='ENOENT')throw new Error('ローカルOpenSSLが見つかりません。会場へ持ち込む前にOpenSSLを用意してください。インターネットからの取得は行いません。');
      if(execution.error || execution.status!==0)throw new Error(execution.error?.message || execution.stderr || 'OpenSSLの実行に失敗しました。');
    };
    const creatingCA=!ca;
    if(creatingCA) {
      await writeFile(path.join(work,'ca.cnf'),caConfig,{flag:'wx',mode:0o600});
      run(['req','-x509','-newkey','rsa:3072','-nodes','-keyout','ca.key','-out','ca.crt','-days','3650','-config','ca.cnf']);
      caBytes=await readFile(path.join(work,'ca.crt')); ca=new X509Certificate(caBytes);
    }
    const san=hosts.map(host=>`${isIP(host)?'IP':'DNS'}:${host}`).join(',');
    await writeFile(path.join(work,'server.cnf'),`[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=VLI LAN Demo Server\n[server]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,{flag:'wx',mode:0o600});
    run(['req','-new','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-config','server.cnf']);
    run(['x509','-req','-in','server.csr','-CA',creatingCA?'ca.crt':path.join(directory,'ca.crt'),'-CAkey',creatingCA?'ca.key':path.join(directory,'ca.key'),
      '-set_serial',`0x${randomBytes(16).toString('hex')}`,'-out','server.crt','-days','365','-sha256','-extfile','server.cnf','-extensions','server']);
    const leaf=new X509Certificate(await readFile(path.join(work,'server.crt')));
    await writeFile(path.join(work,markerName),JSON.stringify({format:'vli.lan-certificate',version:1,caFingerprint:ca.fingerprint256,leafFingerprint:leaf.fingerprint256,hosts},null,2)+'\n',{flag:'wx',mode:0o600});
    const publish=[...(creatingCA?['ca.key','ca.crt','ca.cnf']:[]),'server.key','server.crt','server.csr','server.cnf',markerName];
    for(const name of publish)await rename(path.join(work,name),path.join(directory,name));
    return result(false,!creatingCA);
  } finally {process.umask(previousMask);await rm(work,{recursive:true,force:true});}
}

if(process.argv[1] && realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const hosts=process.argv.slice(2);
    if(!hosts.length)throw new Error('使用法: npm run lan:cert -- 192.168.1.10 your-computer.local\n接続に使うIP・ホスト名を明示してください。');
    const certificate=await ensureLanCertificate({hosts});
    console.log(`証明書を ${certificate.directory} に作成しました。信頼ストアは変更していません。\n接続名: ${hosts.join(', ')}\n`+
      '必要な端末にca.crtを手動で信頼させてから起動してください。秘密鍵（*.key）は配布しないでください。\n'+
      'VLI_TLS_CERT=.lan-certs/server.crt VLI_TLS_KEY=.lan-certs/server.key npm run lan');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
