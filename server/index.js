// Codex 极简版：单端口同源（静态页 + WebSocket 打字同步 + 管理员建房鉴权）
// 部署到 Railway 后，一个 URL 同时提供页面与 wss:// 长连接
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const DIST_DIR = path.join(__dirname, '..', 'dist');
// 管理员密钥：从环境变量读取（Railway 后台配置），未配置时本地开发用默认值
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

function randomToken() {
  return crypto.randomBytes(6).toString('hex'); // 12 位十六进制，足够难猜
}

function getOrCreateRoom(roomId, token) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      token: token || randomToken(),
      text: '',
      language: 'python',
      clients: new Map(),
    });
  }
  return rooms.get(roomId);
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
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

// ── HTTP：静态文件 + 管理员建房 API ──
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // 管理员创建房间
  if (req.method === 'POST' && url.pathname === '/api/rooms') {
    try {
      const body = await readBody(req);
      if ((body.key || '') !== ADMIN_KEY) {
        return sendJSON(res, 401, { error: '无效的管理员密钥' });
      }
      const roomId = crypto.randomBytes(3).toString('hex'); // 6 位十六进制房间号
      const token = randomToken();
      getOrCreateRoom(roomId, token);
      return sendJSON(res, 200, { roomId, token });
    } catch (e) {
      return sendJSON(res, 400, { error: '请求解析失败：' + e.message });
    }
  }

  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

  // 静态文件服务（dist 由 npm run build 生成）
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  const abs = path.join(DIST_DIR, path.normalize(filePath));
  if (!abs.startsWith(DIST_DIR)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(abs, (err, data) => {
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

  const color = COLORS[room.clients.size % COLORS.length];
  room.clients.set(ws, { name: userName, color });

  // 广播房间内最新在线成员列表（含彩色铭牌）
  const broadcastPresence = () => {
    const users = Array.from(room.clients.values());
    const msg = JSON.stringify({ type: 'PRESENCE', payload: users });
    room.clients.forEach((_, c) => {
      if (c.readyState === 1) c.send(msg);
    });
  };

  // 下发当前房间文字内容
  ws.send(JSON.stringify({ type: 'INIT', payload: { text: room.text, language: room.language } }));
  broadcastPresence();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'PING') return; // 心跳，不回显

    if (msg.type === 'TEXT_SYNC') {
      room.text = msg.payload.text;
      room.clients.forEach((_, c) => {
        if (c !== ws && c.readyState === 1) {
          c.send(JSON.stringify({ type: 'TEXT_SYNC', payload: msg.payload }));
        }
      });
    } else if (msg.type === 'LANG_SYNC') {
      room.language = msg.payload.language;
      room.clients.forEach((_, c) => {
        if (c !== ws && c.readyState === 1) {
          c.send(JSON.stringify({ type: 'LANG_SYNC', payload: msg.payload }));
        }
      });
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    broadcastPresence();
    if (room.clients.size === 0) rooms.delete(roomId); // 空房间回收
  });
});

// WS 升级：接受任意路径
httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Codex 服务已启动：http://localhost:${PORT}`);
  console.log(`  管理员建房: POST /api/rooms  { key }`);
  console.log(`  WS 打字同步: ws://localhost:${PORT}/ws?room=<id>&token=<t>&user=<name>`);
  console.log(`  静态页: ${DIST_DIR}`);
  console.log(`  ADMIN_KEY 已${ADMIN_KEY === 'dev-admin-key' ? '使用开发默认值（生产务必在环境变量设置）' : '从环境变量读取'}`);
});
