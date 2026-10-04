import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {X509Certificate} from 'node:crypto';
import {get} from 'node:https';
import WebSocket from 'ws';
import {ensureLanCertificate} from '../scripts/create-lan-cert.mjs';
import {isPrivateIPv4,lanAddresses,selectLanHost,offlineOptions,startOfflineLan} from '../scripts/start-offline-lan.mjs';
import {createLanServer} from '../server/lan-server.js';

const temp=async t=>{const directory=await mkdtemp(path.join(os.tmpdir(),'vli-offline-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;};
const interfaceAt=(address,internal=false)=>({address,family:'IPv4',internal});
async function getHTTPS(url,ca) {
  return new Promise((resolve,reject)=>{get(url,{ca},response=>{
    let text='';response.setEncoding('utf8');response.on('data',part=>{text+=part;});response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text}));
  }).on('error',reject);});
}

test('offline host selection uses only actual private interfaces and requires a choice for multiple LANs',()=>{
  const interfaces={lo:[interfaceAt('127.0.0.1',true)],wifi:[interfaceAt('192.168.20.8')],wan:[interfaceAt('8.8.8.8')]};
  assert.deepEqual(lanAddresses(interfaces),['192.168.20.8']);
  assert.equal(selectLanHost(undefined,interfaces),'192.168.20.8');
  for(const bad of ['8.8.8.8','127.0.0.1','192.168.1.5','localhost','192.168.020.8'])assert.throws(()=>selectLanHost(bad,interfaces),/プライベート/);
  const multiple={...interfaces,ethernet:[interfaceAt('10.0.1.2')]};
  assert.throws(()=>selectLanHost(undefined,multiple),/候補が複数/);
  assert.equal(selectLanHost('10.0.1.2',multiple),'10.0.1.2');
  assert.throws(()=>selectLanHost(undefined,{lo:interfaces.lo}),/見つかりません/);
  assert.equal(isPrivateIPv4('172.31.1.2'),true);
  assert.equal(isPrivateIPv4('172.32.1.2'),false);
  assert.equal(isPrivateIPv4('169.254.2.3'),true);
});

test('offline startup validates CLI options and can check a prepared local build without opening a port',async t=>{
  assert.deepEqual(offlineOptions(['--host','192.168.1.5','--port','8443','--check','--cert-dir','my-certs']),{host:'192.168.1.5',port:8443,check:true,certDir:'my-certs'});
  assert.throws(()=>offlineOptions(['--port','NaN']),/port/);
  assert.throws(()=>offlineOptions(['--host']),/未対応/);
  const root=await temp(t);
  await assert.rejects(startOfflineLan({root,localhost:true,check:true}),/dist\/index/);
  await mkdir(path.join(root,'dist'));
  await writeFile(path.join(root,'dist','index.html'),'<h1>Local app</h1>');
  const logs=[];
  const checked=await startOfflineLan({root,localhost:true,check:true,log:value=>logs.push(value)});
  assert.equal(checked.relay,null);
  assert.equal(checked.checked,true);
  assert.match(logs[0],/待受は開始していません/);
  const serving=await startOfflineLan({root,localhost:true,port:0,log:()=>{}});
  t.after(()=>serving.relay.close());
  assert.match(await(await fetch(serving.url)).text(),/Local app/);
  const config=await(await fetch(serving.url+'/lan-config.json')).json();
  assert.deepEqual(config,{local:true,origin:serving.url,protocol:1});
  await assert.rejects(startOfflineLan({root,localhost:true,host:'192.168.1.2'}),/loopback/);
});

test('managed CA stays unchanged when LAN IP changes, and matching certificates need no OpenSSL',async t=>{
  const directory=await temp(t);
  const first=await ensureLanCertificate({directory,hosts:['192.168.1.5']});
  const originalCA=await readFile(first.caPath);
  const originalKey=await readFile(path.join(directory,'ca.key'));
  const originalLeaf=await readFile(first.certPath);
  const reused=await ensureLanCertificate({directory,hosts:['192.168.1.5'],reuse:true,openssl:'missing-command-that-must-not-run'});
  assert.equal(reused.reused,true);
  assert.deepEqual(await readFile(first.certPath),originalLeaf);
  const rotated=await ensureLanCertificate({directory,hosts:['10.0.20.6'],reuse:true});
  assert.equal(rotated.rotated,true);
  assert.deepEqual(await readFile(rotated.caPath),originalCA);
  assert.deepEqual(await readFile(path.join(directory,'ca.key')),originalKey);
  const leaf=new X509Certificate(await readFile(rotated.certPath));
  assert.equal(leaf.checkIP('10.0.20.6'),'10.0.20.6');
  assert.equal(leaf.checkIP('192.168.1.5'),undefined);
  assert.equal(leaf.verify(new X509Certificate(originalCA).publicKey),true);
  await assert.rejects(ensureLanCertificate({directory,hosts:['10.0.20.6']}),/上書きしません/);
  await mkdir(path.join(directory,'dist'));
  await writeFile(path.join(directory,'dist','index.html'),'<h1>Prepared venue</h1>');
  const checked=await startOfflineLan({root:directory,host:'10.0.20.6',certDir:'.',check:true,
    interfaces:{venue:[interfaceAt('10.0.20.6')]},log:()=>{}});
  assert.equal(checked.relay,null);
  assert.equal(checked.certificate.publicCaPath,path.join(directory,'venue-ca.crt'));
  assert.deepEqual(await readFile(checked.certificate.publicCaPath),originalCA);
});

test('unknown user certificates are never overwritten by offline startup certificate preparation',async t=>{
  const directory=await temp(t);
  const certificate='user supplied certificate placeholder';
  await writeFile(path.join(directory,'server.crt'),certificate);
  await assert.rejects(ensureLanCertificate({directory,hosts:['192.168.1.5'],reuse:true}),/確認できないため上書きしません/);
  assert.equal(await readFile(path.join(directory,'server.crt'),'utf8'),certificate);
});

test('production LAN serves local config/help/marker with restrictive CSP and rejects public or other-localhost origins',async t=>{
  const root=await temp(t);
  const certificate=await ensureLanCertificate({directory:path.join(root,'certs'),hosts:['127.0.0.1']});
  const ca=await readFile(certificate.caPath),cert=await readFile(certificate.certPath),key=await readFile(certificate.keyPath);
  assert.throws(()=>createLanServer({host:'127.0.0.1',cert,key,publicOrigin:'https://vli.bar'}),/ローカルIP/);
  await mkdir(path.join(root,'dist','help'),{recursive:true});
  await writeFile(path.join(root,'dist','help','lan-offline.html'),'<h1>Venue instructions</h1>');
  await mkdir(path.join(root,'dist','markers'),{recursive:true});
  await writeFile(path.join(root,'dist','markers','index.html'),'<h1>Printable marker</h1><img src="./stage.svg">');
  await writeFile(path.join(root,'dist','markers','stage.svg'),'<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
  const relay=createLanServer({host:'127.0.0.1',port:0,cert,key,distDir:path.join(root,'dist')});
  const address=await relay.listen();t.after(()=>relay.close());
  const url=`https://127.0.0.1:${address.port}`;
  const response=await getHTTPS(url+'/lan-config.json',ca);
  assert.equal(response.status,200);
  assert.deepEqual(JSON.parse(response.text),{local:true,origin:url,protocol:1});
  const csp=response.headers['content-security-policy'];
  assert.match(csp,/default-src 'self'/);
  assert.match(csp,/script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp,/style-src 'self' 'unsafe-inline'/);
  assert.ok(csp.includes(`connect-src 'self' blob: ${url.replace('https:','wss:')}`));
  assert.ok(!csp.includes('vli.bar') && !csp.includes('https:;') && !csp.includes('*'));
  assert.match((await getHTTPS(url+'/help/',ca)).text,/Venue instructions/);
  const markerPage=await getHTTPS(url+'/markers/index.html',ca);
  assert.equal(markerPage.status,200);assert.match(markerPage.headers['content-type'],/^text\/html/);
  assert.match(markerPage.text,/Printable marker/);
  const marker=await getHTTPS(url+'/markers/stage.svg',ca);
  assert.equal(marker.status,200);assert.equal(marker.headers['content-type'],'image/svg+xml');
  assert.match(marker.text,/<svg/);assert.equal(marker.headers['content-security-policy'],csp);
  for(const origin of ['https://vli.bar','http://localhost:5173','https://localhost:5173','https://192.168.1.5:8443']) {
    const status=await new Promise(resolve=>{
      const socket=new WebSocket(url.replace('https:','wss:')+'/live',{ca,origin});
      socket.on('unexpected-response',(_request,response)=>{resolve(response.statusCode);response.resume();socket.terminate();});
      socket.on('error',()=>{});
    });
    assert.equal(status,403,origin);
  }
});
