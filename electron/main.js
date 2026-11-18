const { app, BrowserWindow, globalShortcut, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow;
const MOVE_STEP = 40;

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
    const remoteUrl = startUrl || 'https://codex-clone-production.up.railway.app/';
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
  createWindow();
  registerShortcuts();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
