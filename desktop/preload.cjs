const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexManager', {
  request: (route, data) => ipcRenderer.invoke('manager:request', route, data),
});
