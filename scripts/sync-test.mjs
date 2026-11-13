// 管理员鉴权 + 邀请 token 端到端验证
import { WebSocket } from 'ws';

const BASE = 'http://localhost:8080';
const WS_BASE = 'ws://localhost:8080';
const ADMIN_KEY = 'dev-admin-key';

async function createRoom(key) {
  const res = await fetch(`${BASE}/api/rooms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  return { status: res.status, data: await res.json() };
}

function connectWS({ room, token, user }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/?room=${room}&token=${token || ''}&user=${user}`);
    const msgs = [];
    ws.on('open', () => resolve({ ws, msgs, open: true }));
    ws.on('close', (code) => resolve({ ws, msgs, open: false, closeCode: code }));
    ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
  });
}

const waitFor = (fn, ms = 5000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const c = () => fn() ? res() : (Date.now() - t0 > ms ? rej(new Error('超时')) : setTimeout(c, 50));
  c();
});

// 1. 错误密钥 → 401
const bad = await createRoom('wrong-key');
if (bad.status === 401) console.log('✓ 错误密钥被拒绝（401）');
else { console.error('✗ 错误密钥未被拒绝', bad); process.exit(1); }

// 2. 正确密钥 → 返回 roomId + token
const good = await createRoom(ADMIN_KEY);
if (good.status === 200 && good.data.roomId && good.data.token) {
  console.log('✓ 管理员建房成功 →', JSON.stringify(good.data));
} else { console.error('✗ 建房失败', good); process.exit(1); }

const { roomId, token } = good.data;

// 3. 无 token 连接 → 被拒（AUTH_FAIL + close 4001）
const noToken = await connectWS({ room: roomId, user: 'Eve' });
await waitFor(() => noToken.msgs.some((m) => m.type === 'AUTH_FAIL'));
console.log('✓ 无 token 连接被拒（AUTH_FAIL）');
noToken.ws.close();

// 4. 错误 token → 被拒
const badToken = await connectWS({ room: roomId, token: 'ffffffffffff', user: 'Eve' });
await waitFor(() => badToken.msgs.some((m) => m.type === 'AUTH_FAIL'));
console.log('✓ 错误 token 连接被拒');
badToken.ws.close();

// 5. 正确 token → 双端进入 + 同步
const a = await connectWS({ room: roomId, token, user: 'Mentor' });
const b = await connectWS({ room: roomId, token, user: 'Client' });
await waitFor(() => a.msgs.some((m) => m.type === 'INIT'));
await waitFor(() => b.msgs.some((m) => m.type === 'INIT'));
console.log('✓ 正确 token 双方进入房间');

a.ws.send(JSON.stringify({ type: 'TEXT_SYNC', payload: { text: 'hello 加密房' } }));
await waitFor(() => b.msgs.some((m) => m.type === 'TEXT_SYNC' && m.payload.text === 'hello 加密房'));
console.log('✓ token 房间内打字同步成功');

a.ws.close(); b.ws.close();
console.log('\n全部通过 ✓');
process.exit(0);
