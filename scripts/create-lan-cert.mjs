import {mkdir,writeFile,access} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {isIP} from 'node:net';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Creates files only. Trust-store installation is always a separate manual step.
const hosts=[...new Set(process.argv.slice(2))];
if (!hosts.length || hosts.some(host=>!isIP(host) && !/^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host))) {
  console.error('使用法: npm run lan:cert -- 192.168.1.10 your-computer.local\n接続に使うIP・ホスト名を明示してください。');
  process.exitCode=1;
} else {
  const directory=fileURLToPath(new URL('../.lan-certs/',import.meta.url));
  const names=['ca.key','ca.crt','server.key','server.crt','server.csr','ca.cnf','server.cnf'];
  try {
    process.umask(0o077);
    await mkdir(directory,{recursive:true,mode:0o700});
    for(const name of names) {
      const exists=await access(path.join(directory,name)).then(()=>true,()=>false);
      if(exists)throw new Error(`既存の ${name} を上書きしません。既存証明書を使用するか、.lan-certsを別の場所へ退避してください。`);
    }
    const run=args=>{
      const result=spawnSync('openssl',args,{cwd:directory,encoding:'utf8',stdio:['ignore','pipe','pipe']});
      if(result.error || result.status!==0)throw new Error(result.error?.message || result.stderr || 'OpenSSLの実行に失敗しました。');
    };
    await writeFile(path.join(directory,'ca.cnf'),'[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\nCN=VLI LAN Demo CA\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n',{flag:'wx'});
    const san=hosts.map(host=>`${isIP(host)?'IP':'DNS'}:${host}`).join(',');
    await writeFile(path.join(directory,'server.cnf'),`[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=VLI LAN Demo Server\n[server]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\n`,{flag:'wx'});
    run(['req','-x509','-newkey','rsa:3072','-nodes','-keyout','ca.key','-out','ca.crt','-days','3650','-config','ca.cnf']);
    run(['req','-new','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-config','server.cnf']);
    run(['x509','-req','-in','server.csr','-CA','ca.crt','-CAkey','ca.key','-set_serial',`0x${randomBytes(16).toString('hex')}`,
      '-out','server.crt','-days','365','-sha256','-extfile','server.cnf','-extensions','server']);
    console.log(`証明書を ${directory} に作成しました。信頼ストアは変更していません。\n接続名: ${hosts.join(', ')}\n`+
      '必要な端末にca.crtを手動で信頼させてから起動してください。秘密鍵（*.key）は配布しないでください。\n'+
      'VLI_TLS_CERT=.lan-certs/server.crt VLI_TLS_KEY=.lan-certs/server.key npm run lan');
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
