const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('startupAccess', {
  unlock: password => ipcRenderer.invoke('access:unlock', password),
});
