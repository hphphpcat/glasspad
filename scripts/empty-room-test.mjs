// 验证：房间在所有人离开后，凭证仍有效（修复「空房立即删除导致凭证无效」）
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
    ws.on('message', (raw) => msgs.push(JSON.parse(raw.toString())));
    ws.on('close', (code) => resolve({ ws, msgs, open: false, closeCode: code }));
  });
}

const waitFor = (fn, ms = 5000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const c = () => fn() ? res() : (Date.now() - t0 > ms ? rej(new Error('超时')) : setTimeout(c, 50));
  c();
});

const { roomId, token } = (await createRoom(ADMIN_KEY)).data;
console.log('建房成功:', roomId);

// 1. 导师进入后立刻离开 → 房间人数归零
const mentor = await connectWS({ room: roomId, token, user: 'Mentor' });
await waitFor(() => mentor.msgs.some((m) => m.type === 'INIT'));
mentor.ws.close();
await new Promise((r) => setTimeout(r, 500)); // 等断开完成

// 2. 客户此时加入 → 凭证应仍然有效（修复前这里会 AUTH_FAIL）
const client = await connectWS({ room: roomId, token, user: 'Client' });
await waitFor(() => client.msgs.some((m) => m.type === 'INIT'));
const authFail = client.msgs.some((m) => m.type === 'AUTH_FAIL');

if (!authFail) {
  console.log('✓ 空房后客户加入，凭证仍有效（bug 已修复）');
  client.ws.close();
  process.exit(0);
} else {
  console.error('✗ 空房后凭证失效（bug 仍存在）');
  process.exit(1);
}
