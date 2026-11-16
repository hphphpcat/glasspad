// 生成 README 截图：管理台、导师网页端、客户 App（只读 + 导师选区高亮）、加入页
// 用法：先启动本地服务（node server/index.js），再运行 npx electron scripts/screenshots.js
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

ipcMain.handle('GET_FROST_SUPPORT', () => ({ isDesktop: true, supportsFrostedGlass: true }));
ipcMain.on('SET_FROSTED_GLASS', () => {});

const BASE = 'http://localhost:8080';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const TEXT = [
  "Yeah, so my first priority would be to restore the service as quickly as possible.",
  "Since the issue started a few hours after deployment, I'd first check the error logs",
  "and monitoring dashboards to see what's failing.",
  "If the new deployment is causing the issue, I'd roll it back to the last stable version,",
  "rather than trying to debug everything in production.",
  "At the same time, I'd communicate with the affected teams.",
].join('\n');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const save = async (win, name) => {
  fs.writeFileSync(path.join(OUT, name), (await win.webContents.capturePage()).toPNG());
  console.log('saved', name);
};
// 用页面里的 Monaco 实例等待加载
const waitEditor = (win) => win.webContents.executeJavaScript(`new Promise((res) => {
  const t = setInterval(() => { if (window.monaco?.editor.getEditors().length) { clearInterval(t); res(true); } }, 100);
})`);

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // 1. 管理台：填密钥建房，展示两条邀请链接
  const admin = new BrowserWindow({ width: 760, height: 520, show: false });
  await admin.loadURL(`${BASE}/admin`);
  await wait(800);
  await admin.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('input[type=password]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'dev-admin-key');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await wait(200);
  await admin.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find((b) => b.textContent.includes('创建房间')).click()`);
  await wait(1200);
  const links = await admin.webContents.executeJavaScript(`[...document.querySelectorAll('input[readonly]')].map((i) => i.value)`);
  await save(admin, 'admin.png');
  const [clientLink, mentorLink] = links;

  // 2. 导师网页端：等 WebSocket 连上后再输入提词并选中一段
  const mentor = new BrowserWindow({ width: 980, height: 420, show: false });
  await mentor.loadURL(mentorLink);
  await waitEditor(mentor);
  await mentor.webContents.executeJavaScript(`new Promise((res) => {
    const t = setInterval(() => { if (document.body.innerText.includes('Mentor')) { clearInterval(t); res(true); } }, 100);
  })`);
  await wait(500);
  await mentor.webContents.executeJavaScript(`(() => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.executeEdits('demo', [{ range: ed.getModel().getFullModelRange(), text: ${JSON.stringify(TEXT)} }]);
    ed.focus();
    ed.setSelection(new window.monaco.Selection(4, 1, 5, 54));
  })()`);
  await wait(800);
  await save(mentor, 'mentor.png');

  // 3. 客户 App：同样的窗口配置，模拟 preload 的 electronAPI
  const client = new BrowserWindow({
    width: 980, height: 420, frame: false, transparent: true, backgroundColor: '#00000000',
    hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.js'), contextIsolation: true },
  });
  await client.loadURL(clientLink);
  await waitEditor(client);
  await client.webContents.executeJavaScript(`localStorage.setItem('pad_opacity', '1'); localStorage.setItem('pad_frost', 'true');`);
  await client.loadURL(clientLink);
  await waitEditor(client);
  await wait(1200);
  // 导师重新发一次选区，让客户端画出橙色高亮
  await mentor.webContents.executeJavaScript(`(() => {
    const ed = window.monaco.editor.getEditors()[0];
    ed.setSelection(new window.monaco.Selection(1, 1, 1, 1));
    ed.setSelection(new window.monaco.Selection(4, 1, 5, 54));
  })()`);
  await wait(800);
  await save(client, 'client.png');

  // 4. 客户 App 加入页（无 token）
  const gate = new BrowserWindow({
    width: 760, height: 380, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'electron', 'preload.js'), contextIsolation: true },
  });
  await gate.loadURL(`${BASE}/`);
  await wait(1200);
  await save(gate, 'join.png');

  app.quit();
});
