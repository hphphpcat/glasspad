const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const os = require('os');

let mainWindow;
let isClickThrough = false; // 鼠标穿透状态
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
  }
}

// 统一切换鼠标穿透模式，并通知前端更新 UI 状态
function setClickThroughMode(enabled) {
  if (!mainWindow) return;
  isClickThrough = Boolean(enabled);
  if (isClickThrough) {
    // 开启穿透：鼠标点击直接穿透到底层浏览器/IDE，完全不抢焦点
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  } else {
    // 关闭穿透：允许在悬浮窗上修改房间号或拖动滑块
    mainWindow.setIgnoreMouseEvents(false);
  }
  mainWindow.webContents.send('CLICK_THROUGH_CHANGED', isClickThrough);
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
    type: process.platform === 'darwin' ? 'panel' : 'toolbar',
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

  // 默认启动时若系统支持则开启毛玻璃
  applyNativeFrostedGlass(mainWindow, true);

  // 加载前端地址：默认连线上 Railway 公网地址（可用 ELECTRON_START_URL 覆盖）
  const startUrl = process.env.ELECTRON_START_URL || 'https://codex-clone-production.up.railway.app/';
  let retries = 0;
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    // 前端未就绪时（连接拒绝）自动重试，避免白屏
    if (retries++ < 10) {
      setTimeout(() => mainWindow.loadURL(startUrl), 800);
    } else {
      console.error('前端加载失败：', code, desc);
    }
  });
  mainWindow.loadURL(startUrl);
}

// 前端查询当前系统是否支持毛玻璃（Win10 返回 false，前端自动隐藏开关）
ipcMain.handle('GET_FROST_SUPPORT', () => ({
  isDesktop: true,
  supportsFrostedGlass,
}));

// 前端复选框实时开关原生毛玻璃
ipcMain.on('SET_FROSTED_GLASS', (_e, enabled) => {
  applyNativeFrostedGlass(mainWindow, Boolean(enabled));
});

// 前端按钮/快捷键开启鼠标穿透
ipcMain.on('SET_CLICK_THROUGH', (_e, enabled) => {
  setClickThroughMode(enabled);
});

function registerShortcuts() {
  // 1. ⌘ + B : 显隐切换（showInactive 避免面试页触发失焦报警）
  globalShortcut.register('CommandOrControl+B', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.showInactive();
  });

  // 2. ⌘/Ctrl + M : 一键开启/关闭鼠标穿透模式（穿透后可直接点击底层浏览器写代码）
  globalShortcut.register('CommandOrControl+M', () => {
    setClickThroughMode(!isClickThrough);
  });

  // 3. ⌘/Ctrl + ↑ ↓ ← → : 无鼠移动窗口位置
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
