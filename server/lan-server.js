import http from 'node:http';
import https from 'node:https';
import {createReadStream, readFileSync} from 'node:fs';
import {realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {hostname, networkInterfaces} from 'node:os';
import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {WebSocketServer} from 'ws';
import {LIVE_VERSION, LIVE_MAX_FPS, LIVE_STALE_MS, MAX_LIVE_PACKET_BYTES, MAX_LIVE_BUFFER_BYTES, MAX_ROOM_PEERS,
  sanitizeJoin, sanitizeLiveFrame} from '../src/live-protocol.js';

const MIME = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.json':'application/json; charset=utf-8','.wasm':'application/wasm','.vrm':'model/gltf-binary','.vrma':'model/gltf-binary',
  '.wav':'audio/wav','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.txt':'text/plain; charset=utf-8'};
const hash = value => createHash('sha256').update(value).digest();
const localhostName = value => ['localhost','127.0.0.1','[::1]','::1'].includes(value);

/** A bounded, in-memory relay. Call listen() explicitly; import never opens a port. */
export function createLanServer({localhost = false, host = localhost ? '127.0.0.1' : '0.0.0.0', port = localhost ? 8080 : 8443,
  cert, key, publicOrigin, distDir = fileURLToPath(new URL('../dist',import.meta.url)), now = Date.now,
  joinTimeoutMs = 5000, heartbeatMs = 15000, maxBufferedBytes = MAX_LIVE_BUFFER_BYTES} = {}) {
  if (localhost && !localhostName(host)) throw new Error('--localhost はloopbackアドレスにだけバインドできます。');
  if (!localhost && (!cert || !key)) throw new Error('LAN配信には VLI_TLS_CERT と VLI_TLS_KEY が必要です。HTTPは --localhost のみ許可します。');
  const scheme = localhost ? 'http:' : 'https:';
  let configuredOrigin = null;
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== scheme || url.href !== `${url.origin}/`) throw new Error('VLI_PUBLIC_ORIGINはこのサーバーのhttps://ホスト:ポートを指定してください。');
    configuredOrigin = url.origin;
  }
  const trustedHosts = new Set(['localhost','127.0.0.1','[::1]',hostname().toLowerCase(),host.toLowerCase()]);
  trustedHosts.delete('0.0.0.0'); trustedHosts.delete('::');
  for (const addresses of Object.values(networkInterfaces())) for (const item of addresses ?? []) trustedHosts.add(item.family === 'IPv6' ? `[${item.address.toLowerCase()}]` : item.address);
  if (configuredOrigin) trustedHosts.add(new URL(configuredOrigin).hostname);
  const rooms = new Map();
  let closing = false;
  const hostOrigin = request => {
    try {
      const url = new URL(`${scheme}//${request.headers.host}`);
      const bound = server.address();
      if (!trustedHosts.has(url.hostname.toLowerCase()) || (Number(url.port || (localhost ? 80 : 443)) !== bound?.port)) return null;
      return url.origin;
    } catch { return null; }
  };
  const handler = async (request,response) => {
    response.setHeader('X-Content-Type-Options','nosniff');
    if (!hostOrigin(request)) { response.writeHead(400); response.end('Invalid host'); return; }
    if (!['GET','HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'https://local.invalid').pathname);
      if (pathname === '/health') { response.setHeader('Content-Type','application/json'); response.end(request.method === 'HEAD' ? undefined : '{"ok":true,"protocol":1}'); return; }
      if (pathname.includes('\0') || pathname.includes('\\')) throw new Error('invalid path');
      const root = await realpath(distDir);
      const filename = await realpath(path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`));
      if (!filename.startsWith(root + path.sep)) throw new Error('outside dist');
      const info = await stat(filename);
      if (!info.isFile()) throw new Error('not a file');
      response.setHeader('Content-Type',MIME[path.extname(filename)] ?? 'application/octet-stream');
      response.setHeader('Cache-Control','no-store'); response.setHeader('Content-Length',info.size);
      if (request.method === 'HEAD') response.end();
      else createReadStream(filename).on('error',() => response.destroy()).pipe(response);
    } catch { response.writeHead(404); response.end('Not found'); }
  };
  const server = localhost ? http.createServer(handler) : https.createServer({cert,key},handler);
  const wss = new WebSocketServer({noServer:true,maxPayload:MAX_LIVE_PACKET_BYTES,perMessageDeflate:false});
  const send = (socket, packet, droppable = false) => {
    if (socket.readyState !== 1) return false;
    if (socket.bufferedAmount > maxBufferedBytes) { if (!droppable) socket.close(1013,'slow connection'); return false; }
    socket.send(JSON.stringify(packet)); return true;
  };
  const members = room => [...room.clients].map(socket => socket.peer);
  const roster = room => { const packet = {type:'roster',v:LIVE_VERSION,peers:members(room)}; for (const client of room.clients) send(client,packet); };
  const remove = socket => {
    clearTimeout(socket.joinTimer);
    if (!socket.room) return;
    const room = socket.room; socket.room = null; room.clients.delete(socket);
    if (!room.clients.size) rooms.delete(room.name); else roster(room);
  };
  const reject = (socket, message) => { send(socket,{type:'error',v:LIVE_VERSION,message}); socket.close(1008,'invalid request'); };
  server.on('upgrade',(request,socket,head) => {
    const origin = hostOrigin(request);
    let allowed = false;
    try {
      const value = new URL(request.headers.origin);
      const localhostDev = ['http:','https:'].includes(value.protocol) && localhostName(value.hostname);
      allowed = value.origin === request.headers.origin && (value.origin === (configuredOrigin ?? origin) || value.origin === 'https://vli.bar' || localhostDev);
    } catch { /* absent or malformed Origin is rejected */ }
    if (closing || !origin || !allowed || request.url !== '/live' || wss.clients.size >= 128) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(request,socket,head,client => wss.emit('connection',client,request));
  });
  wss.on('connection',socket => {
    socket.alive = true; socket.budget = 60; socket.budgetAt = now(); socket.lastPoseAt = -Infinity;
    socket.lastSeq = -1; socket.lastSentAt = -Infinity; socket.motionClockOffset = null;
    socket.joinTimer = setTimeout(() => reject(socket,'参加情報が届かなかったため接続を終了しました。'),joinTimeoutMs);
    socket.joinTimer.unref?.();
    socket.on('error',() => {});
    socket.on('pong',() => { socket.alive = true; });
    socket.on('close',() => remove(socket));
    socket.on('message',(bytes,isBinary) => {
      try {
        if (socket.readyState !== 1) return;
        const at = now();
        socket.budget = Math.min(60,socket.budget + Math.max(0,at-socket.budgetAt)*.04); socket.budgetAt = at;
        if (--socket.budget < 0) { reject(socket,'送信頻度が高すぎるため接続を終了しました。'); return; }
        if (isBinary || bytes.length > MAX_LIVE_PACKET_BYTES) throw new Error('テキストのライブ通信だけに対応しています。');
        const packet = JSON.parse(bytes.toString());
        if (!socket.peer) {
          if (packet.type !== 'join' || packet.v !== LIVE_VERSION) throw new Error('最初にルームへ参加してください。');
          const join = sanitizeJoin(packet);
          let room = rooms.get(join.room);
          const tokenHash = hash(join.token);
          if (room && !timingSafeEqual(room.tokenHash,tokenHash)) throw new Error('部屋の合言葉が一致しません。');
          if (room?.clients.size >= MAX_ROOM_PEERS) throw new Error('この部屋は満員です（最大16人）。');
          if (join.role === 'performer' && room && [...room.clients].some(client => client.peer.role === 'performer')) throw new Error('出演者は1人までです。観客として参加してください。');
          if (!room) {
            if (rooms.size >= 16) throw new Error('中継サーバーの部屋数が上限に達しました。');
            room = {name:join.room,tokenHash,clients:new Set()}; rooms.set(join.room,room);
          }
          socket.peer = {id:randomUUID(),role:join.role,name:join.name,device:join.device};
          socket.room = room; room.clients.add(socket); clearTimeout(socket.joinTimer);
          send(socket,{type:'welcome',v:LIVE_VERSION,id:socket.peer.id,peers:members(room),serverTime:at});
          roster(room); return;
        }
        const clean = sanitizeLiveFrame(packet,socket.peer);
        if (clean.seq <= socket.lastSeq || clean.sentAt <= socket.lastSentAt) return;
        socket.lastSeq = clean.seq; socket.lastSentAt = clean.sentAt;
        // Sender timestamps are monotonic and need not share our wall clock.
        // Track the least observed delay; discard a queued uplink burst rather
        // than presenting its old motion as a newly observed live pose.
        socket.motionClockOffset = Math.min(socket.motionClockOffset ?? Infinity, at - clean.sentAt);
        if (at - (clean.sentAt + socket.motionClockOffset) > LIVE_STALE_MS) return;
        if (at - socket.lastPoseAt < 1000 / LIVE_MAX_FPS) return;
        socket.lastPoseAt = at;
        const outgoing = {...clean,...socket.peer,serverTime:at};
        for (const client of socket.room.clients) if (client !== socket) send(client,outgoing,true);
      } catch (error) { reject(socket, error instanceof SyntaxError ? 'ライブ通信のJSONが不正です。' : error.message); }
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.alive) { socket.terminate(); continue; }
      socket.alive = false; socket.ping();
    }
  },heartbeatMs); heartbeat.unref?.();
  return {server,wss,rooms,
    listen: () => new Promise((resolve,reject) => {
      server.once('error',reject); server.listen(port,host,() => { server.off('error',reject); resolve(server.address()); });
    }),
    close: async () => {
      closing = true; clearInterval(heartbeat);
      for (const socket of wss.clients) { remove(socket); socket.terminate(); }
      await new Promise(resolve => wss.close(resolve));
      await new Promise(resolve => server.close(resolve));
      rooms.clear();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const localhost = args.includes('--localhost');
  const arg = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  try {
    const relay = createLanServer({localhost,host:process.env.VLI_HOST ?? (localhost ? '127.0.0.1' : '0.0.0.0'),
      port:Number(arg('--port') ?? process.env.VLI_PORT ?? (localhost ? 8080 : 8443)), publicOrigin:process.env.VLI_PUBLIC_ORIGIN,
      ...(!localhost ? {cert:process.env.VLI_TLS_CERT && readFileSync(process.env.VLI_TLS_CERT),key:process.env.VLI_TLS_KEY && readFileSync(process.env.VLI_TLS_KEY)} : {})});
    const address = await relay.listen();
    console.log(`vli.bar LAN relay: ${localhost ? 'http' : 'https'}://${localhost ? '127.0.0.1' : 'LAN-HOST'}:${address.port} (WebSocket /live)`);
    for (const signal of ['SIGINT','SIGTERM']) process.once(signal,() => relay.close().then(() => process.exit(0)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
