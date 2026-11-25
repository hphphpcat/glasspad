// GlassPad 服务端：单端口同源（静态页 + WebSocket 打字同步 + 管理员建房鉴权）
// 部署到 Railway 后，一个 URL 同时提供页面与 wss:// 长连接
const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const zlib = require('zlib');
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
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
};

const COMPRESSIBLE_EXTS = new Set(['.html', '.js', '.css', '.svg', '.json', '.wasm']);
// 静态文件压缩缓存：Map<absPath, { mtimeMs, raw, gz, br }>
const staticAssetCache = new Map();
const MAX_STATIC_CACHE_ENTRIES = 64;

// IP 认证失败限流表：Map<ip, { count, resetAt }>
const authFailMap = new Map();
const AUTH_WINDOW_MS = 60 * 1000;
const AUTH_MAX_FAILS = 15;

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) {
    return fwd.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

function isIpRateLimited(ip) {
  const rec = authFailMap.get(ip);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) {
    authFailMap.delete(ip);
    return false;
  }
  return rec.count >= AUTH_MAX_FAILS;
}

function recordAuthFailure(ip) {
  const now = Date.now();
  const rec = authFailMap.get(ip);
  if (!rec || now > rec.resetAt) {
    authFailMap.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  } else {
    rec.count += 1;
  }
}

function clearAuthFailure(ip) {
  authFailMap.delete(ip);
}

// 常量时间字符串比较（防时序侧信道探测 ADMIN_KEY / room.token）
function safeEqual(a, b) {
  const s1 = Buffer.from(String(a || ''), 'utf8');
  const s2 = Buffer.from(String(b || ''), 'utf8');
  if (s1.length !== s2.length) {
    // 仍执行一次等长 timingSafeEqual 消除长度分支时间差
    crypto.timingSafeEqual(s1, s1);
    return false;
  }
  return crypto.timingSafeEqual(s1, s2);
}

// 房间状态：roomId -> { token, text, language, clients: Map<ws, {name,color}> }
const rooms = new Map();
const COLORS = ['#00bcd4', '#3b82f6', '#10b981', '#f59e0b', '#ec4899'];

// 持久化：房间数据与客户端版本信息写磁盘，Railway 重启/多副本也不丢
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/tmp/codex-data') ? '/tmp/codex-data' : '/tmp/glasspad-data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');
const VERSION_FILE = path.join(DATA_DIR, 'version.json');

let pkgVersion = '1.0.30';
try {
  pkgVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version || '1.0.30';
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

const DEFAULT_MIN_NATIVE_VERSION = process.env.MIN_NATIVE_VERSION || '1.0.28';

let appRelease = {
  version: process.env.LATEST_APP_VERSION || pkgVersion,
  minNativeVersion: DEFAULT_MIN_NATIVE_VERSION,
  macUrl: process.env.MAC_DOWNLOAD_URL || DEFAULT_MAC_DOWNLOAD_URL,
  winUrl: process.env.WIN_DOWNLOAD_URL || DEFAULT_WIN_DOWNLOAD_URL,
  notes: process.env.RELEASE_NOTES || '1. 新增「导师实时查看候选人 Pad 阅读范围」：候选人滚动或缩放窗口时实时上报可视行区间，导师端编辑器内直接高亮候选人当前视野（左侧蓝青色发光竖条 + 上下边界线 + 悬浮行号标签 + 滚动条概览标尺）\n2. 导师端顶栏新增「👁 候选人：行 X–Y」一键定位胶囊与「跟随视角」开关，即使看不见候选人隐身悬浮窗，也能实时掌握其阅读位置',
  forceUpdate: process.env.FORCE_UPDATE === 'true',
  updatedAt: Date.now(),
};

function persistRelease() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmpFile = `${VERSION_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify(appRelease, null, 2));
    fs.renameSync(tmpFile, VERSION_FILE);
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
    const savedMinNative = String(saved.minNativeVersion || '').trim();
    appRelease = {
      version: savedVer || appRelease.version,
      minNativeVersion: (savedMinNative && compareSemver(savedMinNative, DEFAULT_MIN_NATIVE_VERSION) >= 0)
        ? savedMinNative
        : DEFAULT_MIN_NATIVE_VERSION,
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

function serializeAllRoomsForDisk() {
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
  return JSON.stringify(data);
}

// 异步防抖原子落盘：高频打字(TEXT_SYNC)合并为 2 秒一次异步写 + tmp 文件 rename 原子替换，
// 彻底杜绝单线程事件循环被 writeFileSync 卡顿以及容器重启半截写残 JSON 文件
let persistTimer = null;
let persistInFlight = false;
let persistDirty = false;

async function flushRoomsToDiskAsync() {
  if (persistInFlight) {
    persistDirty = true;
    return;
  }
  persistInFlight = true;
  persistDirty = false;
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    const payload = serializeAllRoomsForDisk();
    const tmpFile = `${ROOMS_FILE}.tmp.${process.pid}.${Date.now()}`;
    await fs.promises.writeFile(tmpFile, payload, 'utf8');
    await fs.promises.rename(tmpFile, ROOMS_FILE);
  } catch (e) {
    console.error('房间异步持久化失败：', e.message);
  } finally {
    persistInFlight = false;
    if (persistDirty) {
      persistDirty = false;
      schedulePersistRooms(500);
    }
  }
}

function schedulePersistRooms(delayMs = 2000) {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushRoomsToDiskAsync();
  }, delayMs);
}

// 同步原子落盘（仅用于建房/销毁/优雅退出等低频关键节点，保证立即落盘）
function persistRooms(immediate = false) {
  if (!immediate) {
    schedulePersistRooms(2000);
    return;
  }
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmpFile = `${ROOMS_FILE}.tmp.${process.pid}`;
    fs.writeFileSync(tmpFile, serializeAllRoomsForDisk(), 'utf8');
    fs.renameSync(tmpFile, ROOMS_FILE);
  } catch (e) {
    console.error('房间同步持久化失败：', e.message);
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
        voiceSpeakers: new Set(),
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
      voiceSpeakers: new Set(),
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
  const ip = getClientIp(req);
  if (isIpRateLimited(ip)) return { ok: false, rateLimited: true };
  const headerKey = req.headers['x-admin-key'] || '';
  const queryKey = url.searchParams.get('key') || '';
  const bodyKey = body?.key || '';
  const candidate = headerKey || queryKey || bodyKey;
  if (candidate && safeEqual(candidate, ADMIN_KEY)) {
    clearAuthFailure(ip);
    return { ok: true, rateLimited: false };
  }
  recordAuthFailure(ip);
  return { ok: false, rateLimited: false };
}

function checkRoomCredential(req, url) {
  const ip = getClientIp(req);
  if (isIpRateLimited(ip)) return { ok: false, rateLimited: true };
  const roomId = (url.searchParams.get('room') || '').trim();
  const token = (url.searchParams.get('token') || '').trim();
  const room = roomId ? rooms.get(roomId) : null;
  if (room && token && safeEqual(token, room.token)) {
    clearAuthFailure(ip);
    return { ok: true, rateLimited: false };
  }
  // 管理员密钥同样放行（便于运维健康检查与联调）
  const adminHeader = req.headers['x-admin-key'] || '';
  if (adminHeader && safeEqual(adminHeader, ADMIN_KEY)) {
    clearAuthFailure(ip);
    return { ok: true, rateLimited: false };
  }
  recordAuthFailure(ip);
  return { ok: false, rateLimited: false };
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

  // 0a-2. 动态签发 WebRTC ICE 服务器列表（需合法 room+token 或管理员密钥鉴权，防止 Cloudflare TURN 流量被外部盗刷）：GET /api/rtc-config
  if (req.method === 'GET' && url.pathname === '/api/rtc-config') {
    const auth = checkRoomCredential(req, url);
    if (!auth.ok) {
      return sendJSON(res, auth.rateLimited ? 429 : 401, {
        error: auth.rateLimited ? '请求过于频繁，请 1 分钟后重试' : '需要有效的房间凭证才能获取 TURN 中继配置',
      });
    }
    const rtcConfig = await getRtcConfig();
    return sendJSON(res, 200, rtcConfig);
  }

  // 0b. 管理员发布/修改客户端版本与下载链接：POST /api/version
  if (req.method === 'POST' && url.pathname === '/api/version') {
    try {
      const body = await readBody(req);
      const auth = checkAdminKey(req, url, body);
      if (!auth.ok) {
        return sendJSON(res, auth.rateLimited ? 429 : 401, {
          error: auth.rateLimited ? '认证失败次数过多，请 1 分钟后再试' : '无效的管理员密钥',
        });
      }
      const nextVersion = String(body.version || '').trim();
      if (!nextVersion) {
        return sendJSON(res, 400, { error: '版本号不能为空' });
      }
      const nextMinNative = String(body.minNativeVersion ?? appRelease.minNativeVersion ?? DEFAULT_MIN_NATIVE_VERSION)
        .trim()
        .replace(/^v/i, '');
      appRelease = {
        version: nextVersion.replace(/^v/i, ''),
        minNativeVersion: nextMinNative || DEFAULT_MIN_NATIVE_VERSION,
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
    const auth = checkAdminKey(req, url);
    if (!auth.ok) {
      return sendJSON(res, auth.rateLimited ? 429 : 401, {
        error: auth.rateLimited ? '认证失败次数过多，请 1 分钟后再试' : '无效的管理员密钥',
      });
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
      const auth = checkAdminKey(req, url, body);
      if (!auth.ok) {
        return sendJSON(res, auth.rateLimited ? 429 : 401, {
          error: auth.rateLimited ? '认证失败次数过多，请 1 分钟后再试' : '无效的管理员密钥',
        });
      }
      const roomId = crypto.randomBytes(3).toString('hex'); // 6 位十六进制房间号
      const token = randomToken();
      const note = String(body.note || '').trim().slice(0, 60);
      const room = getOrCreateRoom(roomId, token, note);
      persistRooms(true);
      return sendJSON(res, 200, serializeRoom(roomId, room));
    } catch (e) {
      return sendJSON(res, 400, { error: '请求解析失败：' + e.message });
    }
  }

  // 3. 管理员销毁单个房间：DELETE /api/rooms/:roomId
  if (req.method === 'DELETE' && url.pathname.startsWith('/api/rooms/')) {
    let body = {};
    try { body = await readBody(req); } catch {}
    const auth = checkAdminKey(req, url, body);
    if (!auth.ok) {
      return sendJSON(res, auth.rateLimited ? 429 : 401, {
        error: auth.rateLimited ? '认证失败次数过多，请 1 分钟后再试' : '无效的管理员密钥',
      });
    }
    const targetId = decodeURIComponent(url.pathname.slice('/api/rooms/'.length)).trim();
    if (!targetId || !rooms.has(targetId)) {
      return sendJSON(res, 404, { error: '房间不存在或已销毁' });
    }
    destroyRoom(targetId);
    persistRooms(true);
    return sendJSON(res, 200, { ok: true, destroyed: targetId });
  }

  // 4. 管理员批量销毁房间：DELETE /api/rooms?mode=idle|all
  if (req.method === 'DELETE' && url.pathname === '/api/rooms') {
    let body = {};
    try { body = await readBody(req); } catch {}
    const auth = checkAdminKey(req, url, body);
    if (!auth.ok) {
      return sendJSON(res, auth.rateLimited ? 429 : 401, {
        error: auth.rateLimited ? '认证失败次数过多，请 1 分钟后再试' : '无效的管理员密钥',
      });
    }
    const mode = url.searchParams.get('mode') || body.mode || 'idle';
    const destroyed = [];
    Array.from(rooms.keys()).forEach((roomId) => {
      const r = rooms.get(roomId);
      if (mode === 'all' || (r && r.clients.size === 0)) {
        if (destroyRoom(roomId)) destroyed.push(roomId);
      }
    });
    persistRooms(true);
    return sendJSON(res, 200, { ok: true, destroyedCount: destroyed.length, destroyed });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }

  // 未命中的 /api/* 路径直接返回 404 JSON，不走 SPA index.html 回退
  if (url.pathname.startsWith('/api/')) {
    return sendJSON(res, 404, { error: 'API 接口不存在' });
  }

  // 静态文件服务（dist 由 npm run build 生成）：自动开启 Brotli / Gzip 压缩缓存与 /assets/ 一年 immutable 强缓存
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.join(DIST_DIR, path.normalize(filePath));
  if (!abs.startsWith(DIST_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  const serveStaticFile = (targetAbs) => {
    fs.stat(targetAbs, (statErr, stat) => {
      if (statErr || !stat.isFile()) {
        if (!path.extname(filePath) && targetAbs !== path.join(DIST_DIR, 'index.html')) {
          return serveStaticFile(path.join(DIST_DIR, 'index.html'));
        }
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      const ext = path.extname(targetAbs).toLowerCase();
      const contentType = MIME[ext] || 'application/octet-stream';
      const isHtml = ext === '.html';
      const isHashedAsset = !isHtml && targetAbs.startsWith(path.join(DIST_DIR, 'assets') + path.sep);
      const acceptEnc = String(req.headers['accept-encoding'] || '');
      const canCompress = COMPRESSIBLE_EXTS.has(ext) && stat.size >= 1024;
      const wantBr = canCompress && /\bbr\b/i.test(acceptEnc);
      const wantGz = !wantBr && canCompress && /\bgzip\b/i.test(acceptEnc);

      const sendBuf = (buf, encoding) => {
        const headers = {
          'Content-Type': contentType,
          'Content-Length': buf.length,
          Vary: 'Accept-Encoding',
        };
        if (encoding) headers['Content-Encoding'] = encoding;
        if (isHtml) {
          headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        } else if (isHashedAsset) {
          // Vite 产出的 /assets/* 文件名带内容哈希，可安全设 1 年强缓存，二次打开秒开
          headers['Cache-Control'] = 'public, max-age=31536000, immutable';
        } else {
          headers['Cache-Control'] = 'public, max-age=3600';
        }
        res.writeHead(200, headers);
        if (req.method === 'HEAD') res.end();
        else res.end(buf);
      };

      let entry = staticAssetCache.get(targetAbs);
      if (entry && entry.mtimeMs === stat.mtimeMs) {
        if (wantBr && entry.br) return sendBuf(entry.br, 'br');
        if (wantGz && entry.gz) return sendBuf(entry.gz, 'gzip');
        if (!wantBr && !wantGz) return sendBuf(entry.raw, null);
      }

      const loadRaw = entry && entry.mtimeMs === stat.mtimeMs
        ? Promise.resolve(entry.raw)
        : fs.promises.readFile(targetAbs).then((raw) => {
            if (staticAssetCache.size >= MAX_STATIC_CACHE_ENTRIES) {
              const firstKey = staticAssetCache.keys().next().value;
              if (firstKey) staticAssetCache.delete(firstKey);
            }
            entry = { mtimeMs: stat.mtimeMs, raw, gz: null, br: null };
            staticAssetCache.set(targetAbs, entry);
            return raw;
          });

      loadRaw
        .then((raw) => {
          if (wantBr) {
            return new Promise((resolve, reject) => {
              zlib.brotliCompress(
                raw,
                { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 } },
                (zErr, compressed) => (zErr ? reject(zErr) : resolve(compressed))
              );
            }).then((brBuf) => {
              entry.br = brBuf;
              sendBuf(brBuf, 'br');
            });
          }
          if (wantGz) {
            return new Promise((resolve, reject) => {
              zlib.gzip(raw, { level: 6 }, (zErr, compressed) => (zErr ? reject(zErr) : resolve(compressed)));
            }).then((gzBuf) => {
              entry.gz = gzBuf;
              sendBuf(gzBuf, 'gzip');
            });
          }
          sendBuf(raw, null);
        })
        .catch(() => {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end('Internal Server Error');
          }
        });
    });
  };

  serveStaticFile(abs);
});

// ── WebSocket：毫秒级按键广播 + 在线队友列表（带 token 鉴权 + 2MB 载荷上限防 OOM 攻击） ──
const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  // 捕获单连接协议/超长载荷等错误，防止未处理的 ws 'error' 事件导致整个 Node 进程崩溃
  ws.on('error', (err) => {
    console.warn('[ws] 连接异常已隔离：', err?.code || err?.message || err);
  });

  const ip = getClientIp(req);
  if (isIpRateLimited(ip)) {
    ws.send(JSON.stringify({ type: 'AUTH_FAIL', payload: { reason: '尝试次数过多，请 1 分钟后重试' } }));
    ws.close(4001, 'rate_limited');
    return;
  }
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room') || '';
  const token = url.searchParams.get('token') || '';
  const userName = url.searchParams.get('user') || 'Cstech Cat';

  // 鉴权：房间必须存在，且 token 必须常量时间匹配
  const room = rooms.get(roomId);
  if (!room || !safeEqual(token, room.token)) {
    recordAuthFailure(ip);
    ws.send(JSON.stringify({ type: 'AUTH_FAIL', payload: { reason: '无效的房间或邀请凭证' } }));
    ws.close(4001, 'unauthorized');
    return;
  }
  clearAuthFailure(ip);

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

  // 广播当前正在开麦的导师/发言者列表
  const broadcastVoiceState = () => {
    if (!room.voiceSpeakers) room.voiceSpeakers = new Set();
    const speakers = Array.from(room.voiceSpeakers).map((id) => {
      const targetWs = findWsByClientId(id);
      const info = targetWs ? room.clients.get(targetWs) : null;
      return { id, name: info?.name || '导师' };
    });
    const msg = JSON.stringify({ type: 'VOICE_STATE', payload: { speakers } });
    room.clients.forEach((_, c) => {
      if (c.readyState === 1) c.send(msg);
    });
  };

  // 下发当前房间文字内容、局部字体颜色标记、自身的 clientId、屏幕共享状态、开麦导师列表以及候选人当前可视阅读范围
  if (!room.voiceSpeakers) room.voiceSpeakers = new Set();
  if (!room.viewports) room.viewports = new Map();
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
      voiceSpeakers: Array.from(room.voiceSpeakers).map((id) => {
        const targetWs = findWsByClientId(id);
        const info = targetWs ? room.clients.get(targetWs) : null;
        return { id, name: info?.name || '导师' };
      }),
      viewports: Array.from(room.viewports.values()),
    },
  }));
  broadcastPresence();

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    ws.isAlive = true;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'PING') {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'PONG', payload: { t: msg.payload?.t || Date.now() } }));
      }
      return;
    }
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
      // 光标与选区同步（CoderPad 风格）：附带发送者的 clientId、姓名、代表色与是否主动点击标志(showFlag)广播给房间内其他成员
      const senderInfo = room.clients.get(ws) || { id: clientId, name: userName, color };
      const outMsg = JSON.stringify({
        type: 'SEL_SYNC',
        payload: {
          clientId: senderInfo.id,
          name: senderInfo.name,
          color: senderInfo.color,
          selections: Array.isArray(msg.payload?.selections) ? msg.payload.selections : [],
          showFlag: Boolean(msg.payload?.showFlag),
        },
      });
      room.clients.forEach((_, c) => {
        if (c !== ws && c.readyState === 1) {
          c.send(outMsg);
        }
      });
    } else if (msg.type === 'VIEWPORT_SYNC') {
      // 候选人桌面端实时上报自己当前 Pad 的可视行范围（startLine..endLine），让看不见悬浮窗的导师清楚知道候选人正在看哪一段
      const senderInfo = room.clients.get(ws) || { id: clientId, name: userName, color };
      const startLine = Math.max(1, Math.floor(Number(msg.payload?.startLine) || 1));
      const endLine = Math.max(startLine, Math.floor(Number(msg.payload?.endLine) || startLine));
      const totalLines = Math.max(endLine, Math.floor(Number(msg.payload?.totalLines) || endLine));
      const viewportInfo = {
        clientId: senderInfo.id,
        name: senderInfo.name,
        color: senderInfo.color,
        startLine,
        endLine,
        totalLines,
        updatedAt: Date.now(),
      };
      if (!room.viewports) room.viewports = new Map();
      room.viewports.set(senderInfo.id, viewportInfo);
      const outMsg = JSON.stringify({ type: 'VIEWPORT_SYNC', payload: viewportInfo });
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
          if (room.viewports?.has(info.id)) {
            const vp = room.viewports.get(info.id);
            vp.name = nextName;
            const vpMsg = JSON.stringify({ type: 'VIEWPORT_SYNC', payload: vp });
            room.clients.forEach((_, c) => {
              if (c !== ws && c.readyState === 1) c.send(vpMsg);
            });
          }
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
      // 观看端（导师）请求订阅画面，转发给当前共享方以触发 WebRTC Offer（透传 forceRelay 与 iceRestart 标志）
      if (room.sharerId) {
        const sharerWs = findWsByClientId(room.sharerId);
        if (sharerWs) {
          sharerWs.send(JSON.stringify({
            type: 'SCREEN_VIEWER_JOIN',
            payload: {
              viewerId: clientId,
              forceRelay: Boolean(msg.payload?.forceRelay),
              iceRestart: Boolean(msg.payload?.iceRestart),
            },
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
      // 点对点转发 WebRTC Offer / Answer / ICE Candidate（透传 iceRestart / forceRelay 元信息）
      const targetWs = findWsByClientId(msg.payload?.to);
      if (targetWs) {
        targetWs.send(JSON.stringify({
          type: 'RTC_SIGNAL',
          payload: {
            from: clientId,
            sdp: msg.payload.sdp || null,
            candidate: msg.payload.candidate || null,
            iceRestart: Boolean(msg.payload.iceRestart),
            forceRelay: typeof msg.payload.forceRelay === 'boolean' ? msg.payload.forceRelay : undefined,
          },
        }));
      }
    } else if (msg.type === 'VOICE_START') {
      // 导师端开启麦克风语音通话
      if (!room.voiceSpeakers) room.voiceSpeakers = new Set();
      room.voiceSpeakers.add(clientId);
      room.lastActive = Date.now();
      broadcastVoiceState();
    } else if (msg.type === 'VOICE_STOP') {
      if (room.voiceSpeakers?.has(clientId)) {
        room.voiceSpeakers.delete(clientId);
        broadcastVoiceState();
      }
    } else if (msg.type === 'VOICE_LISTENER_JOIN') {
      const targetWs = findWsByClientId(msg.payload?.speakerId);
      if (targetWs) {
        targetWs.send(JSON.stringify({
          type: 'VOICE_LISTENER_JOIN',
          payload: { listenerId: clientId, forceRelay: Boolean(msg.payload?.forceRelay) },
        }));
      }
    } else if (msg.type === 'VOICE_LISTENER_LEAVE') {
      const targetWs = findWsByClientId(msg.payload?.speakerId);
      if (targetWs) {
        targetWs.send(JSON.stringify({
          type: 'VOICE_LISTENER_LEAVE',
          payload: { listenerId: clientId },
        }));
      }
    } else if (msg.type === 'VOICE_SIGNAL') {
      // 独立语音通道的 WebRTC 信令转发（与屏幕共享 RTC_SIGNAL 完全隔离）
      const targetWs = findWsByClientId(msg.payload?.to);
      if (targetWs) {
        targetWs.send(JSON.stringify({
          type: 'VOICE_SIGNAL',
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
    if (room.viewports?.has(clientId)) {
      room.viewports.delete(clientId);
      const leaveMsg = JSON.stringify({ type: 'VIEWPORT_LEAVE', payload: { clientId } });
      room.clients.forEach((_, c) => {
        if (c.readyState === 1) c.send(leaveMsg);
      });
    }
    if (room.voiceSpeakers?.has(clientId)) {
      room.voiceSpeakers.delete(clientId);
      broadcastVoiceState();
    } else if (room.voiceSpeakers?.size > 0) {
      room.voiceSpeakers.forEach((speakerId) => {
        const speakerWs = findWsByClientId(speakerId);
        if (speakerWs) {
          speakerWs.send(JSON.stringify({
            type: 'VOICE_LISTENER_LEAVE',
            payload: { listenerId: clientId },
          }));
        }
      });
    }
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

// WS 协议层心跳探活：每 25 秒向所有在线连接发送原生 ping 帧，超时未响应直接 terminate，
// 防止客户端异常断网/休眠导致服务端残存幽灵 sharerId，卡死新观看者或占用房间共享位
setInterval(() => {
  wss.clients.forEach((client) => {
    if (client.isAlive === false) {
      try { client.terminate(); } catch {}
      return;
    }
    client.isAlive = false;
    try { client.ping(); } catch {}
  });
}, 25 * 1000);

// 闲置房间回收：房间超过 6 小时无人使用才删除（保留 token 有效性，且不会无限增长），顺带清理过期限流记录
setInterval(() => {
  const now = Date.now();
  let removed = false;
  rooms.forEach((room, roomId) => {
    if (room.clients.size === 0 && now - room.lastActive > 6 * 3600 * 1000) {
      rooms.delete(roomId);
      removed = true;
    }
  });
  authFailMap.forEach((rec, ip) => {
    if (now > rec.resetAt) authFailMap.delete(ip);
  });
  if (removed) persistRooms(true);
}, 10 * 60 * 1000);

// 优雅退出：Railway 容器滚动发版收到 SIGTERM/SIGINT 时立即同步刷盘，防止最后 2 秒内的打字丢失
const handleGracefulExit = (signal) => {
  console.log(`收到 ${signal}，正在刷盘房间数据并关闭服务…`);
  persistRooms(true);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
};
process.on('SIGTERM', () => handleGracefulExit('SIGTERM'));
process.on('SIGINT', () => handleGracefulExit('SIGINT'));

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
