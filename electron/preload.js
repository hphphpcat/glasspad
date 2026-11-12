const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isDesktop: true,
  getFrostSupport: () => ipcRenderer.invoke('GET_FROST_SUPPORT'),
  setFrostedGlass: (enabled) => ipcRenderer.send('SET_FROSTED_GLASS', enabled),
});
