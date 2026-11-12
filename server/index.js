// Codex 极简版：单端口同源（静态页 + WebSocket 打字同步）
// 部署到 Railway/Render/Fly 后，一个 URL 同时提供页面与 wss:// 长连接，点开即用
const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const DIST_DIR = path.join(__dirname, '..', 'dist');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// 房间内存状态：roomId -> { text, language, clients: Map<ws, {name,color}> }
const rooms = new Map();
const COLORS = ['#00bcd4', '#3b82f6', '#10b981', '#f59e0b', '#ec4899'];

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, { text: '', language: 'python', clients: new Map() });
  }
  return rooms.get(roomId);
}

// ── HTTP：静态文件服务（dist 由 npm run build 生成） ──
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }

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

// ── WebSocket：毫秒级按键广播 + 在线队友列表 ──
const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const roomId = url.searchParams.get('room') || 'default';
  const userName = url.searchParams.get('user') || 'Cstech Cat';

  const room = getRoom(roomId);
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
      // 实时转发给房间内除自己以外的所有人
      room.clients.forEach((_, c) => {
        if (c !== ws && c.readyState === 1) {
          c.send(JSON.stringify({ type: 'TEXT_SYNC', payload: msg.payload }));
        }
      });
    } else if (msg.type === 'LANG_SYNC') {
      // 同步房间语言模式（如切到 Plain Text 避免单引号变色）
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
    if (room.clients.size === 0) rooms.delete(roomId); // 空房间回收，避免内存增长
  });
});

// WS 升级：接受任意路径（前端默认连 /ws，VITE_WS_URL 自定义时也可连 /）
httpServer.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Codex 极简版已启动：http://localhost:${PORT}`);
  console.log(`  WS 打字同步: ws://localhost:${PORT}/ws?room=<id>&user=<name>`);
  console.log(`  静态页: ${DIST_DIR}（npm run build 后可用）`);
});
