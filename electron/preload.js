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
  openPrivacySettings: (type) => ipcRenderer.invoke('OPEN_PRIVACY_SETTINGS', type),
  // 客户端版本获取、检查更新与软件内静默自更新
  getAppVersion: () => ipcRenderer.invoke('GET_APP_VERSION'),
  checkForUpdates: (customBase) => ipcRenderer.invoke('CHECK_FOR_UPDATES', customBase),
  openExternalUrl: (url) => ipcRenderer.invoke('OPEN_EXTERNAL_URL', url),
  downloadAndInstallUpdate: (url) => ipcRenderer.invoke('DOWNLOAD_AND_INSTALL_UPDATE', url),
  onUpdateProgress: (cb) => {
    const handler = (_e, data) => cb?.(data);
    ipcRenderer.on('UPDATE_PROGRESS', handler);
    return () => ipcRenderer.removeListener('UPDATE_PROGRESS', handler);
  },
});
