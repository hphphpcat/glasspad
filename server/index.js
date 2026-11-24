// GlassPad 服务端：单端口同源（静态页 + WebSocket 打字同步 + 管理员建房鉴权）
// 部署到 Railway 后，一个 URL 同时提供页面与 wss:// 长连接
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const DIST_DIR = path.join(__dirname, '..', 'dist');
// 管理员密钥：从环境变量读取（Railway 后台配置），未配置时本地开发用默认值
// 生产环境（NODE_ENV=production，Dockerfile 已设置）必须配置 ADMIN_KEY，否则拒绝启动，避免公开的默认值被人用来建房
if (process.env.NODE_ENV === 'production' && !process.env.ADMIN_KEY) {
  console.error('生产环境必须设置 ADMIN_KEY 环境变量，服务未启动');
  process.exit(1);
}
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev-admin-key';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// 房间状态：roomId -> { token, text, language, clients: Map<ws, {name,color}> }
const rooms = new Map();
const COLORS = ['#00bcd4', '#3b82f6', '#10b981', '#f59e0b', '#ec4899'];

// 持久化：房间数据与客户端版本信息写磁盘，Railway 重启/多副本也不丢
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/tmp/codex-data') ? '/tmp/codex-data' : '/tmp/glasspad-data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const VERSION_FILE = path.join(DATA_DIR, 'version.json');

let pkgVersion = '1.0.23';
try {
  pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '1.0.23';
} catch {}

// 语义化版本对比：a > b 返回 1，相等返回 0，小于返回 -1
function compareSemver(a, b) {
  const clean = (v) => String(v || '').trim().replace(/^v/i, '').split('-')[0];
  const aParts = clean(a).split('.').map((n) => parseInt(n, 10) || 0);
  const bParts = clean(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(aParts.length, bParts.length, 3);
  for (let i = 0; i < len; i++) {
    const x = aParts[i] || 0;
    const y = bParts[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

const DEFAULT_MAC_DOWNLOAD_URL =
  `https://github.com/hphphpcat/glasspad/releases/download/glasspad/GlassPad-${pkgVersion}-arm64.dmg`;
const DEFAULT_WIN_DOWNLOAD_URL =
  `https://github.com/hphphpcat/glasspad/releases/download/glasspad/GlassPad-${pkgVersion}-portable.exe`;

let appRelease = {
  version: process.env.LATEST_APP_VERSION || pkgVersion,
  macUrl: process.env.MAC_DOWNLOAD_URL || DEFAULT_MAC_DOWNLOAD_URL,
  winUrl: process.env.WIN_DOWNLOAD_URL || DEFAULT_WIN_DOWNLOAD_URL,
  notes: process.env.RELEASE_NOTES || '1. 新增 Cloudflare Realtime TURN / Metered TURN 中继支持（含 TLS 443 穿透）与国内+海外多 STUN，解决台湾 IP、代理节点、跨国与公司内网共享黑屏\n2. 观看端新增自动重连与连接方式实时显示（P2P 直连 / TURN 中继）\n3. 全屏共享终极隐身加固（LSUIElement 零 Dock 菜单栏痕迹 + 零首帧闪现 + DTD 边放音乐边说话）',
  forceUpdate: process.env.FORCE_UPDATE === 'true',
  updatedAt: Date.now(),
};

function persistRelease() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VERSION_FILE, JSON.stringify(appRelease, null, 2));
  } catch (e) {
    console.error('版本配置持久化失败：', e.message);
  }
}

function loadRelease() {
  try {
    if (!fs.existsSync(VERSION_FILE)) return;
    const saved = JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
    const savedVer = String(saved.version || '').trim();
    // 若代码仓库 package.json 中的版本已经高于磁盘旧缓存版本，自动以最新代码版本为准
    if (savedVer && compareSemver(pkgVersion, savedVer) > 0) {
      persistRelease();
      return;
    }
    appRelease = {
      version: savedVer || appRelease.version,
      macUrl: String(saved.macUrl || appRelease.macUrl).trim(),
      winUrl: String(saved.winUrl || appRelease.winUrl).trim(),
      notes: String(saved.notes ?? appRelease.notes).trim(),
      forceUpdate: Boolean(saved.forceUpdate ?? appRelease.forceUpdate),
      updatedAt: saved.updatedAt || Date.now(),
    };
  } catch (e) {
    console.error('版本配置加载失败：', e.message);
  }
}

function sanitizeColorMarks(raw) {
  if (!Array.isArray(raw)) return [];
  const list = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const start = Number(item.start);
    const end = Number(item.end);
    const color = typeof item.color === 'string' ? item.color.trim() : '';
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) continue;
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) continue;
    list.push({ start, end, color: color.toLowerCase() });
  }
  return list;
}

function sanitizeBoldMarks(raw) {
  if (!Array.isArray(raw)) return [];
  const list = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const start = Number(item.start);
    const end = Number(item.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) continue;
    list.push({ start, end });
  }
  return list;
}

function sanitizeSizeMarks(raw) {
  if (!Array.isArray(raw)) return [];
  const list = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const start = Number(item.start);
    const end = Number(item.end);
    const size = Math.round(Number(item.size));
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) continue;
    if (!Number.isFinite(size) || size < 11 || size > 28 || size === 15) continue;
    list.push({ start, end, size });
  }
  return list;
}

function persistRooms() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const data = {};
    rooms.forEach((room, roomId) => {
      data[roomId] = {
        token: room.token,
        note: room.note || '',
        text: room.text,
        colorMarks: room.colorMarks || [],
        boldMarks: room.boldMarks || [],
        sizeMarks: room.sizeMarks || [],
        language: room.language,
        createdAt: room.createdAt || room.lastActive,
        lastActive: room.lastActive,
      };
    });
    fs.writeFileSync(ROOMS_FILE, JSON.stringify(data));
  } catch (e) {
    console.error('房间持久化失败：', e.message);
  }
}

function loadRooms() {
  try {
    if (!fs.existsSync(ROOMS_FILE)) return;
    const data = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
    Object.entries(data).forEach(([roomId, r]) => {
      rooms.set(roomId, {
        token: r.token,
        note: r.note || '',
        text: r.text || '',
        colorMarks: sanitizeColorMarks(r.colorMarks),
        boldMarks: sanitizeBoldMarks(r.boldMarks),
        sizeMarks: sanitizeSizeMarks(r.sizeMarks),
        language: r.language || 'python',
        clients: new Map(),
        sharerId: null,
        sharerMicOn: false,
        sharerSystemAudio: false,
        createdAt: r.createdAt || r.lastActive || Date.now(),
        lastActive: r.lastActive || Date.now(),
      });
    });
    console.log(`已从磁盘恢复 ${rooms.size} 个房间`);
  } catch (e) {
    console.error('房间加载失败：', e.message);
  }
}

function randomToken() {
  return crypto.randomBytes(6).toString('hex'); // 12 位十六进制，足够难猜
}

function getOrCreateRoom(roomId, token, note = '') {
  if (!rooms.has(roomId)) {
    const now = Date.now();
    rooms.set(roomId, {
      token: token || randomToken(),
      note: note || '',
      text: '',
      colorMarks: [],
      boldMarks: [],
      sizeMarks: [],
      language: 'python',
      clients: new Map(),
      sharerId: null,
      sharerMicOn: false,
      sharerSystemAudio: false,
      createdAt: now,
      lastActive: now,
    });
  }
  return rooms.get(roomId);
}

// 序列化房间信息供管理台展示
function serializeRoom(roomId, room) {
  const participants = Array.from(room.clients.values());
  const text = room.text || '';
  return {
    roomId,
    token: room.token,
    note: room.note || '',
    language: room.language || 'python',
    onlineCount: participants.length,
    participants,
    screenSharing: Boolean(room.sharerId),
    textLength: text.length,
    textPreview: text.slice(0, 120),
    createdAt: room.createdAt || room.lastActive,
    lastActive: room.lastActive,
  };
}

// 销毁指定房间并踢出所有在线 WebSocket 客户端
function destroyRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return false;
  const msg = JSON.stringify({ type: 'ROOM_DESTROYED', payload: { reason: '该房间已被管理员销毁' } });
  room.clients.forEach((_, clientWs) => {
    try {
      if (clientWs.readyState === 1) clientWs.send(msg);
      clientWs.close(4002, 'room_destroyed');
    } catch {}
  });
  room.clients.clear();
  rooms.delete(roomId);
  return true;
}

function checkAdminKey(req, url, body) {
  const headerKey = req.headers['x-admin-key'] || '';
  const queryKey = url.searchParams.get('key') || '';
  const bodyKey = body?.key || '';
  return (headerKey || queryKey || bodyKey) === ADMIN_KEY;
}

function sendJSON(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
  });
  res.end(JSON.stringify(obj));
}

// ── WebRTC ICE/TURN 凭证动态签发与缓存（解决跨国/台湾 IP/代理节点/对称 NAT 黑屏） ──
const FALLBACK_STUN_SERVERS = [
  {
    urls: [
      'stun:stun.cloudflare.com:3478',
      'stun:stun.miwifi.com:3478',
      'stun:stun.qq.com:3478',
      'stun:stun.l.google.com:19302',
    ],
  },
];

let cachedTurnResult = null; // { iceServers, provider, expiresAt }

function httpsJsonRequest(urlStr, options = {}, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = { ...(options.headers || {}) };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: options.method || 'GET',
        headers,
        timeout: 8000,
      },
      (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 过滤浏览器禁止的 53 端口 TURN URL（避免部分网络下等待 53 端口超时）
function sanitizeIceServers(servers) {
  if (!Array.isArray(servers)) return [];
  return servers
    .map((s) => {
      if (!s || !s.urls) return null;
      const list = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(
        (u) => typeof u === 'string' && !/:53(\?|$)/.test(u)
      );
      if (list.length === 0) return null;
      const out = { urls: list };
      if (s.username) out.username = s.username;
      if (s.credential) out.credential = s.credential;
      return out;
    })
    .filter(Boolean);
}

async function getRtcConfig() {
  const now = Date.now();
  if (cachedTurnResult && cachedTurnResult.expiresAt > now) {
    return {
      iceServers: cachedTurnResult.iceServers,
      hasTurn: cachedTurnResult.hasTurn,
      provider: cachedTurnResult.provider,
    };
  }

  // 方案 1（推荐）：Cloudflare Realtime TURN（每月免费 1TB，全球 Anycast 含台湾/香港/日本，支持 UDP/TCP/TLS 443）
  const cfKeyId = (process.env.CF_TURN_KEY_ID || '').trim();
  const cfApiToken = (process.env.CF_TURN_API_TOKEN || '').trim();
  if (cfKeyId && cfApiToken) {
    try {
      const ttl = 86400; // 24 小时临时凭证
      const data = await httpsJsonRequest(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cfKeyId)}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfApiToken}` },
        },
        { ttl }
      );
      const cfServers = sanitizeIceServers(data?.iceServers);
      if (cfServers.length > 0) {
        const merged = [...FALLBACK_STUN_SERVERS, ...cfServers];
        cachedTurnResult = {
          iceServers: merged,
          hasTurn: true,
          provider: 'cloudflare',
          // 提前 2 小时刷新，或至少缓存 1 小时
          expiresAt: now + Math.max(3600, ttl - 7200) * 1000,
        };
        return { iceServers: merged, hasTurn: true, provider: 'cloudflare' };
      }
    } catch (e) {
      console.error('[rtc-config] Cloudflare TURN 凭证获取失败：', e.message);
    }
  }

  // 方案 2（备选）：Metered.ca TURN（每月免费 50GB，支持 TCP/TLS 443）
  const meteredApp = (process.env.METERED_APP_NAME || '').trim();
  const meteredKey = (process.env.METERED_API_KEY || '').trim();
  if (meteredApp && meteredKey) {
    try {
      const data = await httpsJsonRequest(
        `https://${encodeURIComponent(meteredApp)}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(meteredKey)}`
      );
      const mServers = sanitizeIceServers(data);
      if (mServers.length > 0) {
        const merged = [...FALLBACK_STUN_SERVERS, ...mServers];
        cachedTurnResult = {
          iceServers: merged,
          hasTurn: true,
          provider: 'metered',
          expiresAt: now + 3600 * 1000,
        };
        return { iceServers: merged, hasTurn: true, provider: 'metered' };
      }
    } catch (e) {
      console.error('[rtc-config] Metered TURN 凭证获取失败：', e.message);
    }
  }

  // 方案 3（自定义 JSON）：通过环境变量 CUSTOM_ICE_SERVERS 直接传入 JSON 数组
  const customRaw = (process.env.CUSTOM_ICE_SERVERS || '').trim();
  if (customRaw) {
    try {
      const parsed = sanitizeIceServers(JSON.parse(customRaw));
      if (parsed.length > 0) {
        const merged = [...FALLBACK_STUN_SERVERS, ...parsed];
        return { iceServers: merged, hasTurn: true, provider: 'custom' };
      }
    } catch (e) {
      console.error('[rtc-config] CUSTOM_ICE_SERVERS 解析失败：', e.message);
    }
  }

  return {
    iceServers: FALLBACK_STUN_SERVERS,
    hasTurn: false,
    provider: 'stun-only',
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// ── HTTP：静态文件 + 管理员房间管理 API + 客户端版本检测 API ──
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    });
    res.end();
    return;
  }

  // 0a. 客户端查询最新版本信息：GET /api/version（公开接口，供 Win/Mac 客户端检查更新）
  if (req.method === 'GET' && url.pathname === '/api/version') {
    return sendJSON(res, 200, appRelease);
  }

  // 0a-2. 动态签发 WebRTC ICE 服务器列表（国内+海外 STUN + Cloudflare Realtime TURN / Metered TURN 中继）：GET /api/rtc-config
  if (req.method === 'GET' && url.pathname === '/api/rtc-config') {
    const rtcConfig = await getRtcConfig();
    return sendJSON(res, 200, rtcConfig);
  }

  // 0b. 管理员发布/修改客户端版本与下载链接：POST /api/version
  if (req.method === 'POST' && url.pathname === '/api/version') {
    try {
      const body = await readBody(req);
      if (!checkAdminKey(req, url, body)) {
        return sendJSON(res, 401, { error: '无效的管理员密钥' });
      }
      const nextVersion = String(body.version || '').trim();
      if (!nextVersion) {
        return sendJSON(res, 400, { error: '版本号不能为空' });
      }
      appRelease = {
        version: nextVersion.replace(/^v/i, ''),
        macUrl: String(body.macUrl ?? '').trim(),
        winUrl: String(body.winUrl ?? '').trim(),
        notes: String(body.notes ?? '').trim().slice(0, 500),
        forceUpdate: Boolean(body.forceUpdate),
        updatedAt: Date.now(),
      };
      persistRelease();
      return sendJSON(res, 200, appRelease);
    } catch (e) {
      return sendJSON(res, 400, { error: '版本配置保存失败：' + e.message });
    }
  }

  // 1. 管理员查询全部房间列表：GET /api/rooms
  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    if (!checkAdminKey(req, url)) {
      return sendJSON(res, 401, { error: '无效的管理员密钥' });
    }
    const list = [];
    rooms.forEach((room, roomId) => {
      list.push(serializeRoom(roomId, room));
    });
    // 在线人数优先，其次按最近活跃时间倒序
    list.sort((a, b) => (b.onlineCount - a.onlineCount) || (b.lastActive - a.lastActive));
    return sendJSON(res, 200, { rooms: list });
  }

  // 2. 管理员创建房间：POST /api/rooms
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    try {
      const body = await readBody(req);
      if (!checkAdminKey(req, url, body)) {
        return sendJSON(res, 401, { error: '无效的管理员密钥' });
      }
      const roomId = crypto.randomBytes(3).toString('hex'); // 6 位十六进制房间号
      const token = randomToken();
      const note = String(body.note || '').trim().slice(0, 60);
      const room = getOrCreateRoom(roomId, token, note);
      persistRooms();
      return sendJSON(res, 200, serializeRoom(roomId, room));
    } catch (e) {
      return sendJSON(res, 400, { error: '请求解析失败：' + e.message });
    }
  }

  // 3. 管理员销毁单个房间：DELETE /api/rooms/:roomId
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/rooms/')) {
    let body = {};
    try { body = await readBody(req); } catch {}
    if (!checkAdminKey(req, url, body)) {
      return sendJSON(res, 401, { error: '无效的管理员密钥' });
    }
    const targetId = decodeURIComponent(url.pathname.slice('/api/rooms/'.length)).trim();
    if (!targetId || !rooms.has(targetId)) {
      return sendJSON(res, 404, { error: '房间不存在或已销毁' });
    }
    destroyRoom(targetId);
    persistRooms();
    return sendJSON(res, 200, { ok: true, destroyed: targetId });
  }

  // 4. 管理员批量销毁房间：DELETE /api/rooms?mode=idle|all
  if (req.method === 'DELETE' && url.pathname === '/api/rooms') {
    let body = {};
    try { body = await readBody(req); } catch {}
    if (!checkAdminKey(req, url, body)) {
      return sendJSON(res, 401, { error: '无效的管理员密钥' });
    }
    const mode = url.searchParams.get('mode') || body.mode || 'idle';
    const destroyed = [];
    Array.from(rooms.keys()).forEach((roomId) => {
      const r = rooms.get(roomId);
      if (mode === 'all' || (r && r.clients.size === 0)) {
        if (destroyRoom(roomId)) destroyed.push(roomId);
      }
    });
    persistRooms();
    return sendJSON(res, 200, { ok: true, destroyedCount: destroyed.length, destroyed });
  }

  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

  // 未命中的 /api/* 路径直接返回 404 JSON，不走 SPA index.html 回退
  if (url.pathname.startsWith('/api/')) {
    return sendJSON(res, 404, { error: 'API 接口不存在' });
  }

  // 静态文件服务（dist 由 npm run build 生成）
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.join(DIST_DIR, path.normalize(filePath));
  if (!abs.startsWith(DIST_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(abs, (err, data) => {
    // 文件不存在且无扩展名（如 /admin）→ 回退到 index.html，交给前端路由
    if (err && !path.extname(filePath)) {
      fs.readFile(path.join(DIST_DIR, 'index.html'), (err2, html) => {
        if (err2) { res.writeHead(404); res.end('Not Found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── WebSocket：毫秒级按键广播 + 在线队友列表（带 token 鉴权） ──
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room') || '';
  const token = url.searchParams.get('token') || '';
  const userName = url.searchParams.get('user') || 'Cstech Cat';

  // 鉴权：房间必须存在，且 token 必须匹配
  const room = rooms.get(roomId);
  if (!room || room.token !== token) {
    ws.send(JSON.stringify({ type: 'AUTH_FAIL', payload: { reason: '无效的房间或邀请凭证' } }));
    ws.close(4001, 'unauthorized');
    return;
  }

  const clientId = crypto.randomBytes(4).toString('hex');
  const color = COLORS[room.clients.size % COLORS.length];
  room.clients.set(ws, { id: clientId, name: userName, color });
  room.lastActive = Date.now();

  // 根据 clientId 查找房间内的 ws 实例
  const findWsByClientId = (targetId) => {
    for (const [c, info] of room.clients.entries()) {
      if (info.id === targetId && c.readyState === 1) return c;
    }
    return null;
  };

  // 广播房间内最新在线成员列表（含彩色铭牌）
  const broadcastPresence = () => {
    const users = Array.from(room.clients.values());
    const msg = JSON.stringify({ type: 'PRESENCE', payload: users });
    room.clients.forEach((_, c) => {
      if (c.readyState === 1) c.send(msg);
    });
  };

  // 广播当前屏幕共享状态
  const broadcastShareState = () => {
    const msg = JSON.stringify({
      type: 'SCREEN_SHARE_STATE',
      payload: {
        active: Boolean(room.sharerId),
        sharerId: room.sharerId || null,
        micOn: Boolean(room.sharerMicOn),
        systemAudio: Boolean(room.sharerSystemAudio),
      },
    });
    room.clients.forEach((_, c) => {
      if (c.readyState === 1) c.send(msg);
    });
  };

  // 下发当前房间文字内容、局部字体颜色标记、自身的 clientId 以及当前屏幕共享状态
  ws.send(JSON.stringify({
    type: 'INIT',
    payload: {
      clientId,
      text: room.text,
      colorMarks: room.colorMarks || [],
      boldMarks: room.boldMarks || [],
      sizeMarks: room.sizeMarks || [],
      language: room.language,
      screenShare: {
        active: Boolean(room.sharerId),
        sharerId: room.sharerId || null,
        micOn: Boolean(room.sharerMicOn),
        systemAudio: Boolean(room.sharerSystemAudio),
      },
    },
  }));
  broadcastPresence();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'PING') return; // 心跳，不回显

    if (msg.type === 'TEXT_SYNC') {
      room.text = msg.payload.text;
      const outPayload = { text: room.text };
      if (Array.isArray(msg.payload.colorMarks)) {
        room.colorMarks = sanitizeColorMarks(msg.payload.colorMarks);
        outPayload.colorMarks = room.colorMarks;
      }
      if (Array.isArray(msg.payload.boldMarks)) {
        room.boldMarks = sanitizeBoldMarks(msg.payload.boldMarks);
        outPayload.boldMarks = room.boldMarks;
      }
      if (Array.isArray(msg.payload.sizeMarks)) {
        room.sizeMarks = sanitizeSizeMarks(msg.payload.sizeMarks);
        outPayload.sizeMarks = room.sizeMarks;
      }
      room.lastActive = Date.now();
      persistRooms();
      room.clients.forEach((_, c) => {
        if (c !== ws && c.readyState === 1) {
          c.send(JSON.stringify({ type: 'TEXT_SYNC', payload: outPayload }));
        }
      });
    } else if (msg.type === 'COLOR_MARKS_SYNC') {
      room.colorMarks = sanitizeColorMarks(msg.payload?.colorMarks);
      room.lastActive = Date.now();
      persistRooms();
      room.clients.forEach((_, c) => {
        if (c !== ws && c.readyState === 1) {
          c.send(JSON.stringify({ type: 'COLOR_MARKS_SYNC', payload: { colorMarks: room.colorMarks } }));
        }
      });
    } else if (msg.type === 'BOLD_MARKS_SYNC') {
      room.boldMarks = sanitizeBoldMarks(msg.payload?.boldMarks);
      room.lastActive = Date.now();
      persistRooms();
      room.clients.forEach((_, c) => {
        if (c !== ws && c.readyState === 1) {
          c.send(JSON.stringify({ type: 'BOLD_MARKS_SYNC', payload: { boldMarks: room.boldMarks } }));
        }
      });
    } else if (msg.type === 'SIZE_MARKS_SYNC') {
      room.sizeMarks = sanitizeSizeMarks(msg.payload?.sizeMarks);
      room.lastActive = Date.now();
      persistRooms();
      room.clients.forEach((_, c) => {
        if (c !== ws && c.readyState === 1) {
          c.send(JSON.stringify({ type: 'SIZE_MARKS_SYNC', payload: { sizeMarks: room.sizeMarks } }));
        }
      });
    } else if (msg.type === 'LANG_SYNC') {
      room.language = msg.payload.language;
      room.lastActive = Date.now();
      persistRooms();
      room.clients.forEach((_, c) => {
        if (c !== ws && c.readyState === 1) {
          c.send(JSON.stringify({ type: 'LANG_SYNC', payload: msg.payload }));
        }
      });
    } else if (msg.type === 'SEL_SYNC') {
      // 光标与选区同步（CoderPad 风格）：附带发送者的 clientId、姓名与代表色广播给房间内其他成员
      const senderInfo = room.clients.get(ws) || { id: clientId, name: userName, color };
      const outMsg = JSON.stringify({
        type: 'SEL_SYNC',
        payload: {
          clientId: senderInfo.id,
          name: senderInfo.name,
          color: senderInfo.color,
          selections: Array.isArray(msg.payload?.selections) ? msg.payload.selections : [],
        },
      });
      room.clients.forEach((_, c) => {
        if (c !== ws && c.readyState === 1) {
          c.send(outMsg);
        }
      });
    } else if (msg.type === 'NAME_SYNC') {
      const nextName = String(msg.payload?.name || '').trim().slice(0, 24);
      if (nextName) {
        const info = room.clients.get(ws);
        if (info) {
          info.name = nextName;
          broadcastPresence();
        }
      }
    } else if (msg.type === 'SCREEN_SHARE_START') {
      room.sharerId = clientId;
      room.sharerMicOn = Boolean(msg.payload?.micOn);
      room.sharerSystemAudio = Boolean(msg.payload?.systemAudio);
      room.lastActive = Date.now();
      broadcastShareState();
    } else if (msg.type === 'SCREEN_SHARE_MIC') {
      if (room.sharerId === clientId) {
        room.sharerMicOn = Boolean(msg.payload?.micOn);
        broadcastShareState();
      }
    } else if (msg.type === 'SCREEN_SHARE_STOP') {
      // 共享方主动停止，或导师端请求停止共享
      if (room.sharerId) {
        const sharerWs = findWsByClientId(room.sharerId);
        if (sharerWs && sharerWs !== ws) {
          sharerWs.send(JSON.stringify({ type: 'SCREEN_SHARE_FORCE_STOP' }));
        }
        room.sharerId = null;
        room.sharerMicOn = false;
        room.sharerSystemAudio = false;
        broadcastShareState();
      }
    } else if (msg.type === 'SCREEN_VIEWER_JOIN') {
      // 观看端（导师）请求订阅画面，转发给当前共享方以触发 WebRTC Offer
      if (room.sharerId) {
        const sharerWs = findWsByClientId(room.sharerId);
        if (sharerWs) {
          sharerWs.send(JSON.stringify({
            type: 'SCREEN_VIEWER_JOIN',
            payload: { viewerId: clientId },
          }));
        }
      }
    } else if (msg.type === 'SCREEN_VIEWER_LEAVE') {
      if (room.sharerId) {
        const sharerWs = findWsByClientId(room.sharerId);
        if (sharerWs) {
          sharerWs.send(JSON.stringify({
            type: 'SCREEN_VIEWER_LEAVE',
            payload: { viewerId: clientId },
          }));
        }
      }
    } else if (msg.type === 'RTC_SIGNAL') {
      // 点对点转发 WebRTC Offer / Answer / ICE Candidate
      const targetWs = findWsByClientId(msg.payload?.to);
      if (targetWs) {
        targetWs.send(JSON.stringify({
          type: 'RTC_SIGNAL',
          payload: {
            from: clientId,
            sdp: msg.payload.sdp || null,
            candidate: msg.payload.candidate || null,
          },
        }));
      }
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    if (room.sharerId === clientId) {
      room.sharerId = null;
      room.sharerMicOn = false;
      room.sharerSystemAudio = false;
      broadcastShareState();
    } else if (room.sharerId) {
      const sharerWs = findWsByClientId(room.sharerId);
      if (sharerWs) {
        sharerWs.send(JSON.stringify({
          type: 'SCREEN_VIEWER_LEAVE',
          payload: { viewerId: clientId },
        }));
      }
    }
    broadcastPresence();
    // 不立即删除空房间：保留 roomId + token，避免「先建房→后加入」时短暂空房导致凭证失效
    // 房间由定时器在闲置超时后统一回收
  });
});

// 闲置房间回收：房间超过 6 小时无人使用才删除（保留 token 有效性，且不会无限增长）
setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, roomId) => {
    if (room.clients.size === 0 && now - room.lastActive > 6 * 3600 * 1000) {
      rooms.delete(roomId);
    }
  });
  persistRooms();
}, 10 * 60 * 1000);

// WS 升级：接受任意路径
httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

httpServer.listen(PORT, () => {
  loadRooms();   // 启动时从磁盘恢复房间
  loadRelease(); // 启动时从磁盘恢复客户端版本配置
  console.log(`GlassPad 服务已启动：http://localhost:${PORT}`);
  console.log(`  管理员建房: POST /api/rooms  { key }`);
  console.log(`  版本检测: GET /api/version | POST /api/version`);
  console.log(`  WS 打字同步: ws://localhost:${PORT}/ws?room=<id>&token=<t>&user=<name>`);
  console.log(`  静态页: ${DIST_DIR}`);
  console.log(`  数据目录: ${DATA_DIR}`);
  console.log(`  ADMIN_KEY 已${ADMIN_KEY === 'dev-admin-key' ? '使用开发默认值（生产务必在环境变量设置）' : '从环境变量读取'}`);
});
