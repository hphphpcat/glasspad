const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  getCapabilities: () => ipcRenderer.invoke('GET_PLATFORM_CAPABILITIES'),
  setFrostedGlass: (enabled) => ipcRenderer.send('SET_FROSTED_GLASS', enabled),
  openExternalLogin: (url) => ipcRenderer.send('OPEN_EXTERNAL_LOGIN', url),
});
