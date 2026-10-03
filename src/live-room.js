import {LIVE_VERSION, LIVE_MAX_FPS, LIVE_STALE_MS, MAX_LIVE_PACKET_BYTES, MAX_LIVE_BUFFER_BYTES, MAX_ROOM_PEERS,
  liveSocketUrl, sanitizeJoin, sanitizeLivePeer, sanitizeLiveFrame, sanitizeLivePose} from './live-protocol.js';

const noop = () => {};
const byteLength = value => new TextEncoder().encode(value).byteLength;

/** Ephemeral motion relay. No recording, background reconnect or automatic join. */
export class LiveRoom {
  constructor({onState = noop, onRoster = noop, onPose = noop, onNotice = noop,
    WebSocketImpl = globalThis.WebSocket, now = () => performance.now(), connectTimeoutMs = 10000} = {}) {
    this.callbacks = {onState,onRoster,onPose,onNotice};
    this.WebSocketImpl = WebSocketImpl; this.now = now; this.connectTimeoutMs = connectTimeoutMs;
    this._state = 'disconnected'; this._selfId = null; this._peers = []; this._socket = null;
    this._run = null;
  }
  get state() { return this._state; }
  get connected() { return this._state === 'connected'; }
  get selfId() { return this._selfId; }
  get peers() { return this._peers.map(peer => ({...peer})); }
  _stateChange(state, message) { this._state = state; this.callbacks.onState({state,message,selfId:this._selfId}); }
  _clearRoster() { this._selfId = null; this._peers = []; this.callbacks.onRoster({selfId:null,peers:[]}); }

  async connect({url, ...details}) {
    const endpoint = liveSocketUrl(url);
    const join = sanitizeJoin(details);
    if (!this.WebSocketImpl) throw new Error('このブラウザはWebSocketに対応していません。');
    this.disconnect();
    this._stateChange('connecting', 'ルームへ接続しています…');
    return new Promise((resolve, reject) => {
      let socket;
      try { socket = new this.WebSocketImpl(endpoint); }
      catch (error) { this._stateChange('error', '中継サーバーへ接続できません。'); reject(error); return; }
      const run = {socket, join, seq:0, lastSent:-Infinity, seen:new Map(), settled:false, resolve,reject, clockOffset:0};
      this._run = run; this._socket = socket;
      const active = () => this._run === run;
      const fail = message => {
        if (!active()) return;
        clearTimeout(run.timer);
        if (!run.settled) { run.settled = true; reject(new Error(message)); }
        this.callbacks.onNotice(message);
        this._run = null; this._socket = null; this._clearRoster(); this._stateChange('error', message);
        try { socket.close(1000, 'connection ended'); } catch { /* already closed */ }
      };
      run.timer = setTimeout(() => fail('接続がタイムアウトしました。サーバーのURL・証明書・ネットワークを確認してください。'), this.connectTimeoutMs);
      socket.addEventListener('open', () => {
        if (active()) socket.send(JSON.stringify({type:'join',v:LIVE_VERSION,...join}));
      });
      socket.addEventListener('message', event => {
        if (!active()) return;
        try {
          if (typeof event.data !== 'string' || byteLength(event.data) > MAX_LIVE_PACKET_BYTES) throw new Error('中継データが大きすぎます。');
          const packet = JSON.parse(event.data);
          if (packet.v !== LIVE_VERSION) throw new Error('中継サーバーの通信形式が対応していません。');
          if (packet.type === 'error') { fail(typeof packet.message === 'string' ? packet.message.slice(0,200) : 'ルームへ参加できません。'); return; }
          if (packet.type === 'welcome' || packet.type === 'roster') {
            if (!Array.isArray(packet.peers) || packet.peers.length > MAX_ROOM_PEERS) throw new Error('参加者情報が不正です。');
            const peers = packet.peers.map(sanitizeLivePeer);
            if (new Set(peers.map(peer => peer.id)).size !== peers.length) throw new Error('参加者情報が重複しています。');
            if (packet.type === 'welcome') {
              if (run.settled || !Number.isFinite(packet.serverTime)) throw new Error('接続応答が不正です。');
              const self = peers.find(peer => peer.id === packet.id);
              if (!self || self.role !== join.role || self.device !== join.device) throw new Error('参加方法の確認に失敗しました。');
              this._selfId = self.id; run.clockOffset = packet.serverTime - this.now();
              clearTimeout(run.timer); run.settled = true; this._stateChange('connected', 'ルームに接続しました。');
            } else if (!this.connected) return;
            this._peers = peers.filter(peer => peer.id !== this._selfId);
            const currentIds = new Set(this._peers.map(peer => peer.id));
            for (const id of run.seen.keys()) if (!currentIds.has(id)) run.seen.delete(id);
            this.callbacks.onRoster({selfId:this._selfId,peers:this.peers});
            if (packet.type === 'welcome') resolve(this);
          } else if (packet.type === 'pose' && this.connected) {
            const peer = this._peers.find(value => value.id === packet.id);
            if (!peer || !Number.isFinite(packet.serverTime)) return;
            const clean = sanitizeLiveFrame(packet, peer);
            const at = this.now();
            if (at + run.clockOffset - packet.serverTime > LIVE_STALE_MS || packet.serverTime > at + run.clockOffset + 1000) return;
            const previous = run.seen.get(peer.id);
            if (previous && (clean.seq <= previous.seq || clean.sentAt <= previous.sentAt)) return;
            run.seen.set(peer.id, {seq:clean.seq,sentAt:clean.sentAt});
            this.callbacks.onPose({...peer,seq:clean.seq,sentAt:clean.sentAt,receivedAt:at,
              sample:clean.sample,initialHeadHeight:clean.initialHeadHeight,referenceSpace:clean.referenceSpace});
          }
        } catch (error) { fail(error.message || 'ライブ通信を読み込めません。'); }
      });
      socket.addEventListener('error', () => fail('中継サーバーへ接続できません。URL・証明書・ネットワークを確認してください。'));
      socket.addEventListener('close', () => {
        if (!active()) return;
        clearTimeout(run.timer);
        if (!run.settled) { run.settled = true; reject(new Error('参加前に接続が終了しました。')); }
        this._run = null; this._socket = null; this._clearRoster();
        this._stateChange('disconnected', '接続が終了しました。再接続する場合は参加ボタンを押してください。');
      });
    });
  }

  sendPose(value) {
    const run = this._run;
    if (!this.connected || !run || run.socket.readyState !== 1 || run.socket.bufferedAmount > MAX_LIVE_BUFFER_BYTES) return false;
    const at = this.now();
    if (!Number.isFinite(at) || at < 0 || at - run.lastSent < 1000 / LIVE_MAX_FPS) return false;
    try {
      const packet = {type:'pose',v:LIVE_VERSION,seq:run.seq,sentAt:at,...sanitizeLivePose(value,run.join)};
      const text = JSON.stringify(packet);
      if (byteLength(text) > MAX_LIVE_PACKET_BYTES) return false;
      run.socket.send(text); run.seq++; run.lastSent = at;
      return true;
    } catch (error) { this.callbacks.onNotice(error.message || '姿勢データを送信できません。'); return false; }
  }

  disconnect() {
    const run = this._run;
    this._run = null; this._socket = null;
    if (run) {
      clearTimeout(run.timer);
      if (!run.settled) { run.settled = true; run.reject(new Error('接続を取り消しました。')); }
      try { run.socket.close(1000, 'left room'); } catch { /* pending socket is already closed */ }
    }
    this._clearRoster();
    this._stateChange('disconnected', 'ルームから退出しました。');
  }
}
