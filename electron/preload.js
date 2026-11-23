const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  getFrostSupport: () => ipcRenderer.invoke('GET_FROST_SUPPORT'),
  setFrostedGlass: (enabled) => ipcRenderer.send('SET_FROSTED_GLASS', enabled),
  // 桌面端剪贴板读取（走主进程 IPC，避免渲染进程 sandbox 下 clipboard 为 undefined）
  readClipboardText: () => ipcRenderer.invoke('READ_CLIPBOARD_TEXT'),
  // 屏幕共享权限检测与系统设置跳转
  getMediaPermissionStatus: () => ipcRenderer.invoke('GET_MEDIA_PERMISSION_STATUS'),
  getScreenShareCaps: () => ipcRenderer.invoke('GET_SCREEN_SHARE_CAPS'),
  openPrivacySettings: (type) => ipcRenderer.invoke('OPEN_PRIVACY_SETTINGS', type),
  // macOS BlackHole 系统音内录：状态检测 / 一键配置多输出设备 / 打开下载页
  getAudioSetupStatus: () => ipcRenderer.invoke('GET_AUDIO_SETUP_STATUS'),
  runAudioSetup: () => ipcRenderer.invoke('RUN_AUDIO_SETUP'),
  openBlackHoleDownload: () => ipcRenderer.invoke('OPEN_BLACKHOLE_DOWNLOAD'),
  // 客户端版本获取、检查更新与软件内静默自更新（含 1 秒极速热更新）
  getAppVersion: () => ipcRenderer.invoke('GET_APP_VERSION'),
  checkForUpdates: (customBase) => ipcRenderer.invoke('CHECK_FOR_UPDATES', customBase),
  openExternalUrl: (url) => ipcRenderer.invoke('OPEN_EXTERNAL_URL', url),
  applyHotUpdate: (targetVersion) => ipcRenderer.invoke('APPLY_HOT_UPDATE', targetVersion),
  downloadAndInstallUpdate: (url) => ipcRenderer.invoke('DOWNLOAD_AND_INSTALL_UPDATE', url),
  onUpdateProgress: (cb) => {
    const handler = (_e, data) => cb?.(data);
    ipcRenderer.on('UPDATE_PROGRESS', handler);
    return () => ipcRenderer.removeListener('UPDATE_PROGRESS', handler);
  },
});
