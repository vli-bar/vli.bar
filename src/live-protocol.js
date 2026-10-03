export const LIVE_VERSION = 1;
export const MAX_LIVE_PACKET_BYTES = 16 * 1024;
export const MAX_LIVE_BUFFER_BYTES = 128 * 1024;
export const LIVE_MAX_FPS = 30;
export const LIVE_STALE_MS = 1500;
export const MAX_ROOM_PEERS = 16;
const JOINTS = ['hips','spine-lower','spine-middle','spine-upper','chest','neck','head',
  'left-shoulder','left-arm-upper','left-arm-lower','left-hand-wrist',
  'right-shoulder','right-arm-upper','right-arm-lower','right-hand-wrist',
  'left-upper-leg','left-lower-leg','left-foot-ankle','left-foot-ball',
  'right-upper-leg','right-lower-leg','right-foot-ankle','right-foot-ball'];
const SPACES = ['local','local-floor','bounded-floor','unbounded','camera','stage'];
const SOURCES = ['viewer','controller-grip','hand-wrist','camera-pose'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const round = value => Math.round(value * 1e6) / 1e6;

export function sanitizeJoin(value) {
  if (!object(value) || typeof value.room !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(value.room)) fail('部屋名は英数字・_・-で1〜48文字にしてください。');
  if (typeof value.token !== 'string' || value.token.length < 12 || value.token.length > 128 || /[\u0000-\u001f\u007f]/.test(value.token)) fail('合言葉は12〜128文字にしてください。');
  if (!['performer','audience'].includes(value.role)) fail('参加方法が不正です。');
  if (!['headset','phone','desktop'].includes(value.device)) fail('端末の種類が不正です。');
  const name = typeof value.name === 'string' ? value.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32) : '';
  return {room: value.room, token: value.token, role: value.role, device: value.device, name: name || (value.role === 'performer' ? '出演者' : '観客')};
}

export function sanitizeLivePeer(value) {
  if (!object(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)
      || !['performer','audience'].includes(value.role) || !['headset','phone','desktop'].includes(value.device)
      || typeof value.name !== 'string' || value.name.length > 32) fail('参加者情報が不正です。');
  return {id: value.id, role: value.role, name: value.name, device: value.device};
}

function pose(value) {
  if (value === null || value === undefined) return null;
  if (!object(value) || !Array.isArray(value.position) || value.position.length !== 3
      || !value.position.every(n => Number.isFinite(n) && Math.abs(n) <= 50)
      || !Array.isArray(value.quaternion) || value.quaternion.length !== 4
      || !value.quaternion.every(n => Number.isFinite(n) && Math.abs(n) <= 1.01)) fail('姿勢データが不正です。');
  const norm = Math.hypot(...value.quaternion);
  if (Math.abs(norm - 1) > .02) fail('姿勢の回転が不正です。');
  if (value.emulatedPosition !== undefined && typeof value.emulatedPosition !== 'boolean') fail('姿勢の追跡情報が不正です。');
  if (value.source !== undefined && !SOURCES.includes(value.source)) fail('姿勢の入力元が不正です。');
  return {position: value.position.map(round), quaternion: value.quaternion.map(n => round(n / norm)),
    emulatedPosition: value.emulatedPosition === true, ...(value.source ? {source: value.source} : {})};
}

/** Only motion data and the minimal retargeting context cross the network. */
export function sanitizeLivePose(value, {role, device}) {
  if (!object(value) || !object(value.sample)) fail('姿勢フレームがありません。');
  const input = value.sample;
  if (!Number.isFinite(input.t) || input.t < 0 || input.t > 1e7 || !['visible','visible-blurred','hidden'].includes(input.visibility)) fail('姿勢フレームの時刻または可視状態が不正です。');
  const referenceSpace = role === 'audience' ? 'stage' : value.referenceSpace ?? 'local';
  if (!SPACES.includes(referenceSpace) || (role === 'performer' && referenceSpace === 'stage')) fail('姿勢の座標系が不正です。');
  const initialHeadHeight = role === 'audience' ? null : value.initialHeadHeight ?? null;
  if (initialHeadHeight !== null && (!Number.isFinite(initialHeadHeight) || initialHeadHeight < .3 || initialHeadHeight > 3)) fail('頭の高さが不正です。');
  const visible = input.visibility === 'visible';
  const hands = role !== 'audience' || device !== 'phone';
  let body = null;
  if (role === 'performer' && visible && input.body !== null && input.body !== undefined) {
    if (!object(input.body)) fail('身体データが不正です。');
    body = {};
    for (const joint of JOINTS) if (Object.hasOwn(input.body, joint) && input.body[joint] !== null) body[joint] = pose(input.body[joint]);
    if (!Object.keys(body).length) body = null;
  }
  return {sample: {t: round(input.t), visibility: input.visibility, head: visible ? pose(input.head) : null,
    left: visible && hands ? pose(input.left) : null, right: visible && hands ? pose(input.right) : null, body},
    initialHeadHeight, referenceSpace};
}

export function sanitizeLiveFrame(value, peer) {
  if (!object(value) || value.type !== 'pose' || value.v !== LIVE_VERSION || !Number.isSafeInteger(value.seq) || value.seq < 0
      || !Number.isFinite(value.sentAt) || value.sentAt < 0 || value.sentAt > 1e13) fail('ライブ通信のフレームが不正です。');
  return {type: 'pose', v: LIVE_VERSION, seq: value.seq, sentAt: value.sentAt, ...sanitizeLivePose(value, peer)};
}

export function liveSocketUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('中継サーバーのURLを確認してください。'); }
  if (url.username || url.password || url.search || url.hash) fail('URLには合言葉や追加パラメーターを含めないでください。');
  if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol === 'http:') url.protocol = 'ws:';
  const localhost = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && localhost)) fail('LAN接続にはHTTPS / WSSのサーバーが必要です。');
  if (url.pathname === '/' || url.pathname === '') url.pathname = '/live';
  if (url.pathname !== '/live') fail('中継サーバーのパスは /live を指定してください。');
  return url.href;
}
