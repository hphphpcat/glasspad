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
  // macOS 系统音内录（腾讯会议同款 ScreenCaptureKit 原生流 + BlackHole 多输出兜底）
  getAudioSetupStatus: () => ipcRenderer.invoke('GET_AUDIO_SETUP_STATUS'),
  runAudioSetup: () => ipcRenderer.invoke('RUN_AUDIO_SETUP'),
  restoreAudioOutput: () => ipcRenderer.invoke('RESTORE_AUDIO_OUTPUT'),
  startNativeAudioStream: () => ipcRenderer.invoke('START_NATIVE_AUDIO_STREAM'),
  stopNativeAudioStream: () => ipcRenderer.invoke('STOP_NATIVE_AUDIO_STREAM'),
  onNativeAudioPcm: (cb) => {
    const handler = (_e, buf) => cb?.(buf);
    ipcRenderer.on('NATIVE_AUDIO_PCM', handler);
    return () => ipcRenderer.removeListener('NATIVE_AUDIO_PCM', handler);
  },
  openBlackHoleDownload: () => ipcRenderer.invoke('OPEN_BLACKHOLE_DOWNLOAD'),
  // 物理扬声器音量（0–100）：聚合设备接管后系统音量键失效，用 helper 直接设扬声器子设备音量
  setSpeakerVolume: (volume) => ipcRenderer.invoke('SET_SPEAKER_VOLUME', volume),
  getSpeakerVolume: () => ipcRenderer.invoke('GET_SPEAKER_VOLUME'),
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
