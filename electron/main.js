const { app, BrowserWindow, globalShortcut, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');

let mainWindow;
const MOVE_STEP = 40; // 每次按 ⌘ + 方向键移动的像素步长

// 检测系统是否支持原生毛玻璃（仅 macOS，或 Windows 11 22H2 Build 22621+）
function checkFrostedGlassSupport() {
  if (process.platform === 'darwin') return true;
  if (process.platform === 'win32') {
    const buildNumber = Number(os.release().split('.')[2] || 0);
    return buildNumber >= 22621; // Win11 22H2 起始版本号
  }
  return false;
}

const supportsFrostedGlass = checkFrostedGlassSupport();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 680,
    frame: false,                 // 无边框设计
    transparent: true,            // 原生透明悬浮窗
    backgroundColor: '#00000000', // 完全透明底色，交由前端滑块控制不透明度
    hasShadow: false,             // 去除 macOS 窗口阴影防残留
    alwaysOnTop: true,            // 悬浮置顶
    skipTaskbar: true,            // 隐藏 Windows 任务栏图标
    hiddenInMissionControl: true, // macOS 调度中心隐藏
    type: process.platform === 'darwin' ? 'panel' : 'toolbar', // 面板模式不抢夺主应用焦点
    // 根据系统版本自动开启 macOS 毛玻璃或 Win11 22H2 亚克力模糊
    ...(process.platform === 'darwin' ? { vibrancy: 'under-window', visualEffectState: 'active' } : {}),
    ...(process.platform === 'win32' && supportsFrostedGlass ? { backgroundMaterial: 'acrylic' } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 系统级防截屏保护（注意：部分平台与透明窗口组合存在渲染差异，见 README）
  mainWindow.setContentProtection(true);

  // 最高层级悬浮，允许在全屏应用上方显示
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // 加载前端地址：默认连线上 Railway 公网地址（可用 ELECTRON_START_URL 覆盖）
  const startUrl = process.env.ELECTRON_START_URL || 'https://codex-clone-production.up.railway.app/';
  let retries = 0;
  mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    // Vite 尚未就绪时（-102 连接拒绝）自动重试，避免并行启动时白屏
    if (retries++ < 10) {
      setTimeout(() => mainWindow.loadURL(startUrl), 800);
    } else {
      console.error('前端加载失败：', code, desc);
    }
  });
  mainWindow.loadURL(startUrl);
}

// 平台能力查询：前端据此决定是否渲染毛玻璃开关
ipcMain.handle('GET_PLATFORM_CAPABILITIES', () => ({
  isDesktop: true,
  supportsFrostedGlass,
}));

// 动态开关毛玻璃效果
ipcMain.on('SET_FROSTED_GLASS', (_e, enabled) => {
  if (!mainWindow || !supportsFrostedGlass) return;
  if (process.platform === 'darwin') {
    mainWindow.setVibrancy(enabled ? 'under-window' : null);
  } else if (process.platform === 'win32') {
    mainWindow.setBackgroundMaterial(enabled ? 'acrylic' : 'none');
  }
});

// 调整窗口透明度（0.15 ~ 1.0，前端滑块直接调用）
ipcMain.on('SET_OPACITY', (_e, opacity) => {
  if (!mainWindow) return;
  const clamped = Math.min(1, Math.max(0.15, Number(opacity) || 1));
  mainWindow.setOpacity(clamped);
});

// 一键调用系统浏览器登录，并通过 Deep Link (codex://) 回传 Token
app.setAsDefaultProtocolClient('codex');
ipcMain.on('OPEN_EXTERNAL_LOGIN', (_e, loginUrl) => {
  shell.openExternal(loginUrl);
});

function registerShortcuts() {
  // 1. ⌘ + B : 显隐切换（showInactive 避免浏览器面试页触发失焦报警）
  globalShortcut.register('CommandOrControl+B', () => {
    if (!mainWindow) return;
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.showInactive();
    }
  });

  // 2. ⌘ + ↑ ↓ ← → : 无鼠移动窗口位置
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
  globalShortcut.register('CommandOrControl+R', () => {
    if (mainWindow) mainWindow.webContents.reload();
  });

  // 4. ⌘ + Q : 快速退出
  globalShortcut.register('CommandOrControl+Q', () => {
    app.quit();
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide(); // 隐藏 Mac Dock 图标
  createWindow();
  registerShortcuts();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
