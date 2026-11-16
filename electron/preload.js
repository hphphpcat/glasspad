const { contextBridge, ipcRenderer, clipboard } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  getFrostSupport: () => ipcRenderer.invoke('GET_FROST_SUPPORT'),
  setFrostedGlass: (enabled) => ipcRenderer.send('SET_FROSTED_GLASS', enabled),
  // 桌面端剪贴板读取（供「粘贴邀请链接」使用）
  readClipboardText: () => clipboard.readText(),
});
