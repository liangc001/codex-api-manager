const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('startupAccess', {
  unlock: password => ipcRenderer.invoke('access:unlock', password),
  onProgress: callback => ipcRenderer.on('access:progress', (_event, message) => callback(message)),
});
