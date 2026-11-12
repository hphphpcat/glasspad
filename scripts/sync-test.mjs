// 极简版同步验证：打字广播 + 在线列表 + LANG_SYNC 语言同步
import { WebSocket } from 'ws';

const room = 'sync-test-' + Date.now();
const url = `ws://localhost:8080/?room=${room}`;

function makeClient(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url}&user=${encodeURIComponent(name)}`);
    const messages = [];
    ws.on('open', () => resolve({ ws, messages, name }));
    ws.on('error', reject);
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  });
}

const waitFor = (fn, timeout = 5000) => new Promise((res, rej) => {
  const t0 = Date.now();
  const check = () => {
    if (fn()) res();
    else if (Date.now() - t0 > timeout) rej(new Error('超时'));
    else setTimeout(check, 50);
  };
  check();
});

const a = await makeClient('Candidate');
const b = await makeClient('Mentor');

await waitFor(() => a.messages.some((m) => m.type === 'INIT'));
await waitFor(() => b.messages.some((m) => m.type === 'INIT'));
console.log('✓ 双方收到 INIT');

// PRESENCE
await waitFor(() => {
  const p = b.messages.filter((m) => m.type === 'PRESENCE').at(-1);
  return p && p.payload.length === 2 && p.payload.some((u) => u.name === 'Candidate');
});
console.log('✓ PRESENCE 在线列表含双方');

// TEXT_SYNC
a.ws.send(JSON.stringify({ type: 'TEXT_SYNC', payload: { text: "I'd say..." } }));
await waitFor(() => b.messages.some((m) => m.type === 'TEXT_SYNC' && m.payload.text === "I'd say..."));
console.log('✓ B 收到 A 的 TEXT_SYNC 打字广播');

// LANG_SYNC
a.ws.send(JSON.stringify({ type: 'LANG_SYNC', payload: { language: 'plaintext' } }));
await waitFor(() => b.messages.some((m) => m.type === 'LANG_SYNC' && m.payload.language === 'plaintext'));
console.log('✓ B 收到 A 的 LANG_SYNC 语言切换');

// 语言状态持久（新成员 INIT 拿到 plaintext）
const c = await makeClient('Cstech Cat');
await waitFor(() => c.messages.some((m) => m.type === 'INIT' && m.payload.language === 'plaintext' && m.payload.text === "I'd say..."));
console.log('✓ 房间状态持久（新成员拿到最新文字 + 语言）');

// 断线 PRESENCE
a.ws.close();
await waitFor(() => {
  const p = b.messages.filter((m) => m.type === 'PRESENCE').at(-1);
  return p && p.payload.length === 2;
});
console.log('✓ 断线后 PRESENCE 正确更新');

a.ws.close(); b.ws.close(); c.ws.close();
console.log('\n全部通过 ✓');
process.exit(0);
