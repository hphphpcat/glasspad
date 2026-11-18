const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  platform: process.platform,
  getFrostSupport: () => ipcRenderer.invoke('GET_FROST_SUPPORT'),
  setFrostedGlass: (enabled) => ipcRenderer.send('SET_FROSTED_GLASS', enabled),
  // 桌面端剪贴板读取（走主进程 IPC，避免渲染进程 sandbox 下 clipboard 为 undefined）
  readClipboardText: () => ipcRenderer.invoke('READ_CLIPBOARD_TEXT'),
});
