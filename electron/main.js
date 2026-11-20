const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  clipboard,
  session,
  desktopCapturer,
  systemPreferences,
  shell,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');

let mainWindow;
const MOVE_STEP = 40;
const DEFAULT_UPDATE_BASE = 'https://glasspad.up.railway.app';

// 语义化版本对比：remote > local 返回 1，相等返回 0，小于返回 -1
function compareSemver(remoteVer, localVer) {
  const clean = (v) => String(v || '').trim().replace(/^v/i, '').split('-')[0];
  const rParts = clean(remoteVer).split('.').map((n) => parseInt(n, 10) || 0);
  const lParts = clean(localVer).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(rParts.length, lParts.length, 3);
  for (let i = 0; i < len; i++) {
    const r = rParts[i] || 0;
    const l = lParts[i] || 0;
    if (r > l) return 1;
    if (r < l) return -1;
  }
  return 0;
}

// 请求 JSON（支持 http / https 及重定向）
function fetchJson(targetUrl, timeoutMs = 8000, redirects = 3) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('无效的更新检测地址'));
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      targetUrl,
      {
        headers: {
          Accept: 'application/json',
          'Cache-Control': 'no-cache',
          'User-Agent': `GlassPad/${app.getVersion()} (${process.platform})`,
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirects > 0
        ) {
          res.resume();
          const nextUrl = new URL(res.headers.location, targetUrl).toString();
          return resolve(fetchJson(nextUrl, timeoutMs, redirects - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          const trimmed = raw.trim();
          // 若服务端尚未升级而回退了 SPA 的 index.html，将其平滑视为当前版本无更新
          if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html')) {
            return resolve({ version: app.getVersion() });
          }
          try {
            resolve(JSON.parse(trimmed));
          } catch (e) {
            reject(new Error('更新信息 JSON 解析失败'));
          }
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('请求超时'));
    });
    req.on('error', reject);
  });
}

// 将 ws:// 或 wss:// 或页面地址转换为更新接口 URL
function resolveVersionCheckUrl(customBase) {
  const raw = String(customBase || process.env.UPDATE_JSON_URL || '').trim();
  if (!raw) return `${DEFAULT_UPDATE_BASE}/api/version`;
  try {
    const u = new URL(raw);
    if (u.protocol === 'ws:') u.protocol = 'http:';
    if (u.protocol === 'wss:') u.protocol = 'https:';
    if (!u.pathname || u.pathname === '/') {
      u.pathname = '/api/version';
    } else if (!u.pathname.endsWith('/api/version') && !u.pathname.endsWith('.json')) {
      u.pathname = u.pathname.replace(/\/+$/, '') + '/api/version';
    }
    u.search = '';
    return u.toString();
  } catch {
    return `${DEFAULT_UPDATE_BASE}/api/version`;
  }
}

// 检测系统是否支持原生毛玻璃（macOS 或 Windows 11 22H2 Build 22621+）
function checkFrostedGlassSupport() {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'win32') {
    const parts = os.release().split('.');
    const buildNumber = Number(parts[2] || 0);
    return buildNumber >= 22621; // Win11 22H2 及以上才支持真正的透明亚克力模糊
  }
  return false;
}

const supportsFrostedGlass = checkFrostedGlassSupport();

// 动态开启/关闭系统级毛玻璃
function applyNativeFrostedGlass(win, enabled) {
  if (!win || !supportsFrostedGlass) return;
  if (process.platform === 'darwin') {
    win.setVibrancy(enabled ? 'under-window' : null);
  } else if (process.platform === 'win32') {
    win.setBackgroundMaterial(enabled ? 'acrylic' : 'none');
    // Win11 下 setBackgroundMaterial 会重置窗口 DWM 属性，需重新挂载防截屏关联
    win.setContentProtection(true);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1160,
    height: 680,
    frame: false,
    transparent: true,            // 必须为 true：开启原生透明通道
    backgroundColor: '#00000000', // 必须为全透明色值
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    show: false,                  // 先不显示，等页面加载完用 showInactive 避免激活应用
    title: 'GlassPad',
    // 注意：Windows 上不能设 type: 'toolbar'（WS_EX_TOOLWINDOW 会导致 SetWindowDisplayAffinity 防截屏失效）
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 系统级防截屏保护
  mainWindow.setContentProtection(true);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 默认启动时关闭毛玻璃（由用户在顶栏按需勾选开启）
  applyNativeFrostedGlass(mainWindow, false);

  // 页面加载完成后用 showInactive 显示，避免激活应用（防切屏检测）
  // 并在窗口真正显示、以及每次重新 show 时再次调用 setContentProtection(true)，
  // 确保 Windows DWM 的 WDA_EXCLUDEFROMCAPTURE 在 HWND 可见后及样式更新后始终生效
  mainWindow.on('show', () => {
    mainWindow?.setContentProtection(true);
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.setContentProtection(true);
    mainWindow.showInactive();
    mainWindow.setContentProtection(true);
  });

  // 加载前端：若设置了 ELECTRON_START_URL 则连指定 URL；否则优先加载打包进客户端的本地 dist/index.html
  // （本地已内置 Monaco 编辑器与 worker，无需从远端或 jsdelivr CDN 拉取，彻底解决 Windows 版卡 Loading/白屏）
  const startUrl = process.env.ELECTRON_START_URL;
  const localDistHtml = path.join(__dirname, '..', 'dist', 'index.html');
  if (!startUrl && fs.existsSync(localDistHtml)) {
    mainWindow.loadFile(localDistHtml);
  } else {
    const remoteUrl = startUrl || 'https://glasspad.up.railway.app/';
    let retries = 0;
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      // 前端未就绪时（连接拒绝）自动重试，避免白屏
      if (retries++ < 10) {
        setTimeout(() => mainWindow.loadURL(remoteUrl), 800);
      } else {
        console.error('前端加载失败：', code, desc);
      }
    });
    mainWindow.loadURL(remoteUrl);
  }
}

// 前端查询当前系统是否支持毛玻璃（Win10 返回 false，前端自动隐藏开关）
ipcMain.handle('GET_FROST_SUPPORT', () => ({
  isDesktop: true,
  supportsFrostedGlass,
}));

// 主进程读取剪贴板（兼容 Electron 20+ 默认开启的 sandbox 渲染进程）
ipcMain.handle('READ_CLIPBOARD_TEXT', () => clipboard.readText());

// 媒体权限检测（macOS 需检测屏幕录制与麦克风权限，Windows 直接返回 granted）
ipcMain.handle('GET_MEDIA_PERMISSION_STATUS', () => {
  if (process.platform !== 'darwin') {
    return { screen: 'granted', microphone: 'granted' };
  }
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
  };
});

// macOS 一键打开系统「隐私与安全性 -> 屏幕录制/麦克风」设置
ipcMain.handle('OPEN_PRIVACY_SETTINGS', (_e, type) => {
  if (process.platform !== 'darwin') return;
  const anchor = type === 'microphone' ? 'Privacy_Microphone' : 'Privacy_ScreenCapture';
  shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${anchor}`);
});

// 获取当前客户端版本号与系统平台
ipcMain.handle('GET_APP_VERSION', () => ({
  version: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
}));

// 检查更新：向后端 /api/version 或自定义 JSON 接口拉取最新版本信息
ipcMain.handle('CHECK_FOR_UPDATES', async (_e, customBase) => {
  const currentVersion = app.getVersion();
  const checkUrl = resolveVersionCheckUrl(customBase);
  try {
    const data = await fetchJson(checkUrl);
    const latestVersion = String(data.version || data.latestVersion || currentVersion)
      .trim()
      .replace(/^v/i, '');
    const hasUpdate = compareSemver(latestVersion, currentVersion) > 0;
    const downloadUrl =
      process.platform === 'darwin'
        ? data.macUrl || data.dmgUrl || data.downloadUrl || ''
        : data.winUrl || data.exeUrl || data.downloadUrl || '';
    return {
      ok: true,
      hasUpdate,
      currentVersion,
      latestVersion,
      downloadUrl,
      macUrl: data.macUrl || '',
      winUrl: data.winUrl || '',
      notes: data.notes || data.releaseNotes || '',
      forceUpdate: Boolean(data.forceUpdate),
      checkUrl,
    };
  } catch (err) {
    return {
      ok: false,
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      error: err.message || '检查更新失败',
      checkUrl,
    };
  }
});

// 使用系统默认浏览器打开下载链接或外部 URL
ipcMain.handle('OPEN_EXTERNAL_URL', (_e, targetUrl) => {
  const s = String(targetUrl || '').trim();
  if (/^https?:\/\//i.test(s)) {
    return shell.openExternal(s);
  }
});

// 配置免弹窗静默抓屏（对齐 Codex Interview：自动选择主屏幕 + 系统内录声音 loopback，useSystemPicker: false）
function setupSilentScreenCapture() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });
  ses.setPermissionCheckHandler(() => true);
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          if (!sources || sources.length === 0) {
            callback({});
            return;
          }
          const result = { video: sources[0] };
          if (request.audioRequested) {
            result.audio = 'loopback';
          }
          callback(result);
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );
}

// 前端复选框实时开关原生毛玻璃
ipcMain.on('SET_FROSTED_GLASS', (_e, enabled) => {
  applyNativeFrostedGlass(mainWindow, Boolean(enabled));
});

function registerShortcuts() {
  // 1. ⌘ + B : 显隐切换（showInactive 避免面试页触发失焦报警）
  globalShortcut.register('CommandOrControl+B', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.showInactive();
  });

  // 2. ⌘/Ctrl + ↑ ↓ ← → : 无鼠移动窗口位置
  const moveDirections = {
    Up: [0, -MOVE_STEP],
    Down: [0, MOVE_STEP],
    Left: [-MOVE_STEP, 0],
    Right: [MOVE_STEP, 0],
  };
  Object.entries(moveDirections).forEach(([dir, [dx, dy]]) => {
    globalShortcut.register(`CommandOrControl+${dir}`, () => {
      if (!mainWindow) return;
      const [x, y] = mainWindow.getPosition();
      mainWindow.setPosition(x + dx, y + dy, false);
    });
  });

  // 3. ⌘ + R : 刷新窗口
  globalShortcut.register('CommandOrControl+R', () => mainWindow?.webContents.reload());

  // 4. ⌘ + Q : 快速退出
  globalShortcut.register('CommandOrControl+Q', () => app.quit());
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide(); // 隐藏 Mac Dock 图标
  setupSilentScreenCapture();
  createWindow();
  registerShortcuts();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
