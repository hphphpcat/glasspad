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
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const http = require('http');
const { execFile, spawn } = require('child_process');

let mainWindow;
let isStealthHidden = false; // ⌘+B 零重建隐身状态（用 setOpacity(0)+鼠标穿透代替 hide/show，彻底杜绝唤醒时单帧闪现）
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

// 读取客户端當前生效的版本号（对比安装包内置版本与热更新记录版本，取较大者）
function getHotMetaPath() {
  return path.join(app.getPath('userData'), 'hot_version.json');
}

function getEffectiveAppVersion() {
  const pkgVer = app.getVersion();
  try {
    const metaPath = getHotMetaPath();
    if (fs.existsSync(metaPath)) {
      const saved = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (saved?.version && compareSemver(saved.version, pkgVer) > 0) {
        return String(saved.version).trim();
      }
    }
  } catch {}
  return pkgVer;
}

function isUsingHotRemoteBundle() {
  try {
    const metaPath = getHotMetaPath();
    if (fs.existsSync(metaPath)) {
      const saved = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      // 仅当热更新记录版本严格高于本地安装包内置版本时才加载远端页面；
      // 一旦用户安装了更新的完整安装包（pkgVer >= saved.version），自动清理旧记录并使用本地内置最新 dist
      if (saved?.version && compareSemver(saved.version, app.getVersion()) > 0 && saved.useRemote) {
        return true;
      }
      try { fs.unlinkSync(metaPath); } catch {}
    }
  } catch {}
  return false
}
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

// 强制锁死系统级防截屏保护（macOS NSWindowSharingNone / Windows WDA_EXCLUDEFROMCAPTURE）
// 在任何可能引起 WindowServer / DWM 重建 Surface 的操作前后均同步调用，确保零单帧泄漏
function enforceStealthProtection(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setContentProtection(true);
    win.setSkipTaskbar(true);
    if (process.platform === 'darwin' && typeof win.setHiddenInMissionControl === 'function') {
      win.setHiddenInMissionControl(true);
    }
  } catch {}
}

// 动态开启/关闭毛玻璃
// 注意：macOS 下绝不挂载 NSVisualEffectView('under-window')，因为 macOS WindowServer 的背景模糊采样层
// 在全屏共享 (Share Entire Screen) 下会在桌面背景上暴露一块无字磨砂矩形，且切换 vibrancy 会重建窗口合成层；
// 因此 macOS 下毛玻璃统一走渲染层 CSS，主进程始终保持 null vibrancy + 强制重申 setContentProtection(true)。
function applyNativeFrostedGlass(win, enabled) {
  if (!win || win.isDestroyed()) return;
  enforceStealthProtection(win);
  if (process.platform === 'darwin') {
    try { win.setVibrancy(null); } catch {}
    enforceStealthProtection(win);
  } else if (process.platform === 'win32' && supportsFrostedGlass) {
    try { win.setBackgroundMaterial(enabled ? 'acrylic' : 'none'); } catch {}
    // Win11 下 setBackgroundMaterial 会重置窗口 DWM 属性，需立即重新挂载防截屏关联
    enforceStealthProtection(win);
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
    enableLargerThanScreen: true,
    roundedCorners: false,        // 禁用系统级圆角阴影合成层，防止全屏捕获时边缘残留半透明圆角轮廓
    show: false,                  // 先不显示，挂载完防截屏属性后再用 showInactive 显示
    title: 'GlassPad',
    // 注意：Windows 上不能设 type: 'toolbar'（WS_EX_TOOLWINDOW 会导致 SetWindowDisplayAffinity 防截屏失效）
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,          // 禁用系统拼写检查弹窗（避免弹出不受防截屏保护的原生候选框）
    },
  });

  // 1. 创建后第 1 时间锁死防截屏保护，并在修改置顶层级与全空间属性前后双重锁定
  enforceStealthProtection(mainWindow);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  enforceStealthProtection(mainWindow);

  // 默认启动时关闭原生毛玻璃合成层
  applyNativeFrostedGlass(mainWindow, false);

  // 2. 拦截一切可能脱离主窗口句柄、不受 setContentProtection 保护的原生子窗口与原生右键菜单
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('context-menu', (e) => {
    e.preventDefault();
  });

  // 3. 在所有可能触发 DWM / WindowServer 刷新窗口属性的生命周期事件上同步重申防截屏保护
  const stealthEvents = [
    'show',
    'focus',
    'blur',
    'move',
    'resize',
    'restore',
    'maximize',
    'unmaximize',
    'enter-full-screen',
    'leave-full-screen',
  ];
  stealthEvents.forEach((evt) => {
    mainWindow.on(evt, () => enforceStealthProtection(mainWindow));
  });

  mainWindow.once('ready-to-show', () => {
    enforceStealthProtection(mainWindow);
    mainWindow.showInactive();
    enforceStealthProtection(mainWindow);
  });

  // 加载前端：若已通过 1 秒极速热更新升级到更高版本，则直接加载线上 Railway 最新前端（若断网则自动回退本地内置 dist）
  const startUrl = process.env.ELECTRON_START_URL;
  const localDistHtml = path.join(__dirname, '..', 'dist', 'index.html');
  const remoteUrl = startUrl || `${DEFAULT_UPDATE_BASE}/`;
  const useRemote = Boolean(startUrl) || isUsingHotRemoteBundle() || !fs.existsSync(localDistHtml);

  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    // 若加载远端热更新页面遇到断网，自动回退本地内置 dist/index.html，保证永不白屏
    if (fs.existsSync(localDistHtml)) {
      mainWindow.loadFile(localDistHtml);
    } else {
      console.error('前端加载失败：', code, desc);
    }
  });

  if (useRemote) {
    mainWindow.loadURL(remoteUrl);
  } else {
    mainWindow.loadFile(localDistHtml);
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

// 屏幕共享能力与权限查询：前端据此决定音频采集策略（Windows 有系统 loopback，macOS 仅有麦克风）
ipcMain.handle('GET_SCREEN_SHARE_CAPS', () => {
  const platform = process.platform;
  // Electron 的 getDisplayMedia loopback 系统内录目前仅 Windows 支持
  const systemAudioSupported = platform === 'win32';
  return {
    platform,
    systemAudioSupported,
    screen: platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
    microphone: platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
  };
});

// ── macOS BlackHole 虚拟声卡：检测与一键配置多输出设备（系统音内录） ──

const BLACKHOLE_HELPER_NAME = 'blackhole-setup';
const BLACKHOLE_DOWNLOAD_URL = 'https://github.com/ExistentialAudio/BlackHole/releases/latest';

// 解析 system_profiler SPAudioDataType 输出，判断是否已安装 BlackHole
function detectBlackHole() {
  return new Promise((resolve) => {
    execFile('/usr/sbin/system_profiler', ['SPAudioDataType', '-json'], { timeout: 15000 }, (err, stdout) => {
      if (err || !stdout) {
        return resolve({ ok: false, blackholeInstalled: false, error: err?.message || '无法读取音频设备' });
      }
      try {
        const data = JSON.parse(stdout);
        const items = data?.SPAudioDataType?.[0]?._items || [];
        const blackhole = items.find(
          (d) => /BlackHole/i.test(d?._name || '') && d?.coreaudio_device_input
        );
        resolve({ ok: true, blackholeInstalled: Boolean(blackhole), deviceName: blackhole?._name || '' });
      } catch (e) {
        resolve({ ok: false, blackholeInstalled: false, error: e.message });
      }
    });
  });
}

// 定位 helper 二进制：打包后在 app 的 Resources，开发模式在 build/
function resolveBlackHoleHelperPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, BLACKHOLE_HELPER_NAME);
  return path.join(__dirname, '..', 'build', BLACKHOLE_HELPER_NAME);
}

// 查询 macOS 系统音内录（BlackHole）的安装状态
ipcMain.handle('GET_AUDIO_SETUP_STATUS', async () => {
  if (process.platform !== 'darwin') {
    return { platform: process.platform, supported: false, blackholeInstalled: false };
  }
  const det = await detectBlackHole();
  return {
    platform: process.platform,
    supported: true,
    blackholeInstalled: det.blackholeInstalled,
    deviceName: det.deviceName || '',
    error: det.error || '',
  };
});

// 通用执行 blackhole-setup helper（setup / set-volume / get-volume），返回解析后的 JSON
function runBlackHoleHelper(args, timeout = 20000) {
  const helperPath = resolveBlackHoleHelperPath();
  if (!fs.existsSync(helperPath)) return Promise.resolve({ ok: false, error: '配置组件缺失，请更新到最新版本' });
  return new Promise((resolve) => {
    execFile(helperPath, args, { timeout }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, error: (stderr || err.message || '操作失败').toString().trim() });
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve({ ok: false, error: (stdout || stderr || '操作失败').toString().trim() });
      }
    });
  });
}

// 一键创建/复用「GlassPad 系统音」多输出设备并设为系统默认输出
ipcMain.handle('RUN_AUDIO_SETUP', async () => {
  if (process.platform !== 'darwin') return { ok: false, error: '仅 macOS 支持' };
  return runBlackHoleHelper(['setup']);
});

// 还原系统默认输出设备到物理扬声器并销毁临时聚合设备（恢复系统键盘音量加减键）
ipcMain.handle('RESTORE_AUDIO_OUTPUT', async () => {
  if (process.platform !== 'darwin') return { ok: false };
  return runBlackHoleHelper(['restore']);
});

// ── 腾讯会议同款：macOS ScreenCaptureKit 原生系统音频内录流（零驱动、不改系统输出设备、自动排除自身进程音频）──
let nativeAudioProc = null;

function stopNativeAudioStream() {
  if (nativeAudioProc) {
    try { nativeAudioProc.kill('SIGTERM'); } catch {}
    nativeAudioProc = null;
  }
}

ipcMain.handle('START_NATIVE_AUDIO_STREAM', async () => {
  if (process.platform !== 'darwin') return { ok: false, error: '仅 macOS 支持' };
  stopNativeAudioStream();
  const helperPath = resolveBlackHoleHelperPath();
  if (!fs.existsSync(helperPath)) return { ok: false, error: '原生音频组件缺失' };

  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (!settled) {
        settled = true;
        resolve(res);
      }
    };

    const child = spawn(helperPath, ['sck-stream', String(process.pid)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    nativeAudioProc = child;

    let remainder = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const buf = remainder.length > 0 ? Buffer.concat([remainder, chunk]) : chunk;
      const frameBytes = 8; // 2ch * Float32(4B)
      const usableLen = buf.length - (buf.length % frameBytes);
      if (usableLen > 0) {
        const sendBuf = buf.subarray(0, usableLen);
        mainWindow.webContents.send('NATIVE_AUDIO_PCM', sendBuf);
      }
      remainder = buf.subarray(usableLen);
    });

    child.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('SCK_READY')) {
        finish({ ok: true, mode: 'sck' });
      } else if (msg.includes('SCK_NO_DISPLAY') || msg.includes('SCK_START_ERR') || msg.includes('SCK_INIT_ERR')) {
        stopNativeAudioStream();
        finish({ ok: false, error: msg.trim() });
      }
    });

    child.on('error', (err) => {
      stopNativeAudioStream();
      finish({ ok: false, error: err.message });
    });

    child.on('exit', (code) => {
      if (nativeAudioProc === child) nativeAudioProc = null;
      finish({ ok: false, error: `SCK exited (${code})` });
    });

    setTimeout(() => {
      finish({ ok: false, error: 'SCK_TIMEOUT' });
    }, 1500);
  });
});

ipcMain.handle('STOP_NATIVE_AUDIO_STREAM', async () => {
  stopNativeAudioStream();
  return { ok: true };
});

// 调节物理扬声器音量（0–100）：聚合设备接管默认输出后系统音量键失效，这里绕过聚合设备直接设扬声器子设备音量
ipcMain.handle('SET_SPEAKER_VOLUME', async (_e, volume) => {
  if (process.platform !== 'darwin') return { ok: false, error: '仅 macOS 支持' };
  const pct = Math.max(0, Math.min(100, Number(volume) || 0));
  return runBlackHoleHelper(['set-volume', String(pct)]);
});

// 读取物理扬声器当前音量（0–100），用于初始化前端音量滑块
ipcMain.handle('GET_SPEAKER_VOLUME', async () => {
  if (process.platform !== 'darwin') return { ok: false, error: '仅 macOS 支持' };
  return runBlackHoleHelper(['get-volume']);
});

// 打开 BlackHole 下载页
ipcMain.handle('OPEN_BLACKHOLE_DOWNLOAD', () => {
  if (process.platform !== 'darwin') return;
  shell.openExternal(BLACKHOLE_DOWNLOAD_URL);
});

// 获取当前客户端版本号与系统平台（优先返回热更新后的生效版本号）
ipcMain.handle('GET_APP_VERSION', () => ({
  version: getEffectiveAppVersion(),
  baseVersion: app.getVersion(),
  platform: process.platform,
  arch: process.arch,
}));

// 检查更新：向后端 /api/version 或自定义 JSON 接口拉取最新版本信息
ipcMain.handle('CHECK_FOR_UPDATES', async (_e, customBase) => {
  const currentVersion = getEffectiveAppVersion();
  const baseUrl = resolveVersionCheckUrl(customBase);
  const checkUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}_t=${Date.now()}`;
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
      checkUrl: baseUrl,
    };
  } catch (err) {
    return {
      ok: false,
      hasUpdate: false,
      currentVersion,
      latestVersion: currentVersion,
      error: err.message || '检查更新失败',
      checkUrl: baseUrl,
    };
  }
});

// 1 秒极速热更新：无需从 GitHub 下载 98MB 安装包，直接将客户端切换到 Railway 最新版前端资源并立即生效
ipcMain.handle('APPLY_HOT_UPDATE', async (_e, targetVersion) => {
  try {
    const ver = String(targetVersion || '').trim().replace(/^v/i, '') || app.getVersion();
    sendUpdateProgress({
      stage: 'downloading',
      percent: 45,
      message: '正在从 Railway 高速节点同步增量热更新…',
    });

    const metaPath = getHotMetaPath();
    fs.mkdirSync(path.dirname(metaPath), { recursive: true });
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ version: ver, useRemote: true, updatedAt: Date.now() }, null, 2),
      'utf8'
    );

    sendUpdateProgress({
      stage: 'installing',
      percent: 100,
      message: `已热更新至 v${ver}，正在刷新界面…`,
    });

    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.webContents.session.clearCache().catch(() => {});
      // 保留当前房间 URL 参数（若已在房间内），无缝热切换至线上最新版
      let currentSearch = '';
      try {
        const curUrl = new URL(mainWindow.webContents.getURL());
        currentSearch = curUrl.search || '';
      } catch {}
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(`${DEFAULT_UPDATE_BASE}/${currentSearch}`);
        }
      }, 250);
    }
    return { ok: true, version: ver };
  } catch (err) {
    return { ok: false, error: err.message || '极速热更新失败' };
  }
});

// 使用系统默认浏览器打开下载链接或外部 URL
ipcMain.handle('OPEN_EXTERNAL_URL', (_e, targetUrl) => {
  const s = String(targetUrl || '').trim();
  if (/^https?:\/\//i.test(s)) {
    return shell.openExternal(s);
  }
});

// 向渲染进程推送自动更新进度与状态
function sendUpdateProgress(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('UPDATE_PROGRESS', payload);
  }
}

// 流式下载文件到本地（支持 GitHub Release 302 多跳重定向与实时进度回调）
function downloadFileWithProgress(targetUrl, destPath, onProgress, redirects = 6) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return reject(new Error('无效的下载链接'));
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(
      targetUrl,
      {
        headers: {
          'User-Agent': `GlassPad/${app.getVersion()} (${process.platform})`,
          Accept: '*/*',
        },
        timeout: 30000,
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
          return resolve(
            downloadFileWithProgress(nextUrl, destPath, onProgress, redirects - 1)
          );
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`下载失败 (HTTP ${res.statusCode})`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10) || 0;
        let receivedBytes = 0;
        let lastEmit = 0;
        const fileStream = fs.createWriteStream(destPath);

        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          const now = Date.now();
          if (now - lastEmit >= 120 || (totalBytes && receivedBytes === totalBytes)) {
            lastEmit = now;
            const percent = totalBytes > 0 ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100)) : 0;
            onProgress?.({ percent, receivedBytes, totalBytes });
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => {
            onProgress?.({ percent: 100, receivedBytes, totalBytes: totalBytes || receivedBytes });
            resolve(destPath);
          });
        });

        fileStream.on('error', (err) => {
          fs.unlink(destPath, () => {});
          reject(err);
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('下载连接超时'));
    });
    req.on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(stdout);
    });
  });
}

// macOS：静默挂载 .dmg -> 用 ditto 覆盖当前 GlassPad.app（或 /Applications/GlassPad.app） -> 清除隔离属性 -> 自动重启
async function applyMacDmgUpdate(dmgPath) {
  const mountDir = path.join(os.tmpdir(), `glasspad_mnt_${Date.now()}`);
  fs.mkdirSync(mountDir, { recursive: true });

  await execFileAsync('hdiutil', [
    'attach',
    dmgPath,
    '-mountpoint',
    mountDir,
    '-nobrowse',
    '-quiet',
  ]);

  try {
    const entries = fs.readdirSync(mountDir);
    const appName = entries.find((item) => item.endsWith('.app'));
    if (!appName) {
      throw new Error('更新包内未找到 GlassPad.app');
    }
    const srcApp = path.join(mountDir, appName);

    // 定位当前正在运行的 .app 路径（如 /Applications/GlassPad.app/Contents/MacOS/GlassPad）
    const exePath = app.getPath('exe');
    const appIdx = exePath.indexOf('.app/');
    let targetApp = '/Applications/GlassPad.app';
    if (appIdx !== -1) {
      const currentBundle = exePath.slice(0, appIdx + 4);
      // 若当前是从只读卷（如 /Volumes/GlassPad）直接运行的，则安装到 /Applications/GlassPad.app
      if (!currentBundle.startsWith('/Volumes/')) {
        targetApp = currentBundle;
      }
    }

    // 使用系统 ditto 覆盖更新包、清除 Gatekeeper 隔离标记，并执行 ad-hoc 重签名防止提示“已损坏”
    await execFileAsync('ditto', [srcApp, targetApp]);
    await execFileAsync('xattr', ['-cr', targetApp]).catch(() => {});
    await execFileAsync('codesign', ['--force', '--deep', '--sign', '-', targetApp]).catch(() => {});

    // 卸载 dmg 并清理临时安装包
    await execFileAsync('hdiutil', ['detach', mountDir, '-force', '-quiet']).catch(() => {});
    fs.unlink(dmgPath, () => {});

    // 重新拉起更新后的客户端并退出当前旧进程
    const relaunchExec = path.join(targetApp, 'Contents', 'MacOS', path.basename(exePath));
    if (fs.existsSync(relaunchExec)) {
      app.relaunch({ execPath: relaunchExec });
    } else {
      app.relaunch();
    }
    app.exit(0);
  } catch (err) {
    await execFileAsync('hdiutil', ['detach', mountDir, '-force', '-quiet']).catch(() => {});
    throw err;
  }
}

// Windows：生成后台静默替换脚本，待当前进程退出后覆盖原 portable .exe 并自动重启新版本
async function applyWinExeUpdate(newExePath) {
  const currentExe = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe');
  const batPath = path.join(os.tmpdir(), `glasspad_update_${Date.now()}.bat`);
  const batContent = [
    '@echo off',
    'chcp 65001 >nul',
    'timeout /t 2 /nobreak >nul',
    ':retry',
    `move /y "${newExePath}" "${currentExe}" >nul 2>&1`,
    'if errorlevel 1 (',
    '  timeout /t 1 /nobreak >nul',
    '  goto retry',
    ')',
    `start "" "${currentExe}"`,
    'del "%~f0"',
  ].join('\r\n');

  fs.writeFileSync(batPath, batContent, 'utf8');
  const child = spawn('cmd.exe', ['/c', batPath], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  app.exit(0);
}

// 软件内一键下载并自动替换更新（无需跳转浏览器）
let isUpdatingInApp = false;
ipcMain.handle('DOWNLOAD_AND_INSTALL_UPDATE', async (_e, downloadUrl) => {
  if (isUpdatingInApp) {
    return { ok: false, error: '更新正在进行中' };
  }
  const url = String(downloadUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: '无效的更新包地址' };
  }

  isUpdatingInApp = true;
  const ext = process.platform === 'darwin' ? '.dmg' : '.exe';
  const tempFile = path.join(os.tmpdir(), `GlassPad_Update_${Date.now()}${ext}`);

  try {
    sendUpdateProgress({
      stage: 'downloading',
      percent: 0,
      message: '正在连接更新服务器…',
    });

    await downloadFileWithProgress(url, tempFile, ({ percent, receivedBytes, totalBytes }) => {
      const mbDone = (receivedBytes / (1024 * 1024)).toFixed(1);
      const mbTotal = totalBytes ? (totalBytes / (1024 * 1024)).toFixed(1) : '?';
      sendUpdateProgress({
        stage: 'downloading',
        percent,
        receivedBytes,
        totalBytes,
        message: `正在下载更新包… ${percent}% (${mbDone} MB / ${mbTotal} MB)`,
      });
    });

    sendUpdateProgress({
      stage: 'installing',
      percent: 100,
      message: '下载完成，正在自动安装并重启 GlassPad…',
    });

    if (process.platform === 'darwin') {
      await applyMacDmgUpdate(tempFile);
    } else if (process.platform === 'win32') {
      await applyWinExeUpdate(tempFile);
    } else {
      shell.openExternal(url);
    }
    return { ok: true };
  } catch (err) {
    isUpdatingInApp = false;
    const msg = err.message || '自动更新失败';
    sendUpdateProgress({
      stage: 'error',
      percent: 0,
      message: msg,
    });
    return { ok: false, error: msg };
  }
});

// 配置免弹窗静默抓屏（自动选择主屏幕；系统内录 loopback 仅 Windows 支持，
// macOS 上 Electron 的 getDisplayMedia loopback 不采集系统声音，因此只在 Windows 上返回 audio: 'loopback'）
function setupSilentScreenCapture() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(true);
  });
  ses.setPermissionCheckHandler(() => true);
  ses.setDisplayMediaRequestHandler(
    (request, callback) => {
      // 在抓屏开始前再次强制锁死防截屏标志，确保当前窗口绝不被录进首帧
      enforceStealthProtection(mainWindow);
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          enforceStealthProtection(mainWindow);
          if (!sources || sources.length === 0) {
            callback({});
            return;
          }
          const result = { video: sources[0] };
          // Electron 的 loopback 系统内录目前仅 Windows 支持（macOS 会得到静音音轨）
          if (request.audioRequested && process.platform === 'win32') {
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
  // 1. ⌘ + B : 零 Surface 重建的隐身切换（用 setOpacity(0) + 鼠标穿透代替 hide()/showInactive()，
  //    避免窗口重新 show 时 DWM / WindowServer 合成第 1 帧早于 setContentProtection 导致单帧闪现，且不触发焦点变化）
  globalShortcut.register('CommandOrControl+B', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    enforceStealthProtection(mainWindow);
    if (!isStealthHidden) {
      isStealthHidden = true;
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
      mainWindow.setOpacity(0);
    } else {
      isStealthHidden = false;
      enforceStealthProtection(mainWindow);
      if (!mainWindow.isVisible()) {
        mainWindow.showInactive();
      }
      mainWindow.setOpacity(1);
      mainWindow.setIgnoreMouseEvents(false);
    }
    enforceStealthProtection(mainWindow);
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
      if (!mainWindow || mainWindow.isDestroyed()) return;
      enforceStealthProtection(mainWindow);
      const [x, y] = mainWindow.getPosition();
      mainWindow.setPosition(x + dx, y + dy, false);
      enforceStealthProtection(mainWindow);
    });
  });

  // 3. ⌘ + R : 刷新窗口
  globalShortcut.register('CommandOrControl+R', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    enforceStealthProtection(mainWindow);
    mainWindow.webContents.reload();
  });

  // 4. ⌘ + Q : 快速退出
  globalShortcut.register('CommandOrControl+Q', () => app.quit());
}

// macOS 启动时自动清除当前 App Bundle 与 /Applications/GlassPad.app 的 com.apple.quarantine 隔离属性
function clearMacQuarantineOnLaunch() {
  if (process.platform !== 'darwin') return;
  try {
    const exePath = app.getPath('exe');
    const appIdx = exePath.indexOf('.app/');
    const targets = new Set(['/Applications/GlassPad.app']);
    if (appIdx !== -1) {
      const bundlePath = exePath.slice(0, appIdx + 4);
      if (!bundlePath.startsWith('/Volumes/')) {
        targets.add(bundlePath);
      }
    }
    targets.forEach((target) => {
      if (fs.existsSync(target)) {
        execFile('xattr', ['-cr', target], () => {});
      }
    });
  } catch {}
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.hide(); // 隐藏 Mac Dock 图标
    clearMacQuarantineOnLaunch();
    // 启动时自动清理可能遗留的聚合设备并恢复系统默认输出到物理扬声器，确保系统键盘音量键正常可用
    runBlackHoleHelper(['restore']).catch(() => {});
  }
  setupSilentScreenCapture();
  createWindow();
  registerShortcuts();

  // 监听显示器插拔、缩放比或分辨率变更，防止多屏切换时操作系统重置窗口防截屏属性
  try {
    screen.on('display-added', () => enforceStealthProtection(mainWindow));
    screen.on('display-removed', () => enforceStealthProtection(mainWindow));
    screen.on('display-metrics-changed', () => enforceStealthProtection(mainWindow));
  } catch {}
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopNativeAudioStream();
  if (process.platform === 'darwin') {
    try {
      const helperPath = resolveBlackHoleHelperPath();
      if (fs.existsSync(helperPath)) {
        spawn(helperPath, ['restore'], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch {}
  }
});
