const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('codexManager', {
  request: (route, data) => ipcRenderer.invoke('manager:request', route, data),
  onTrayAction: callback => { ipcRenderer.on('manager:tray-action', (_event, value) => callback(value)); },
});
