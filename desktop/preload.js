const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tube', {
  settings: () => ipcRenderer.invoke('settings'),
  paste: () => ipcRenderer.invoke('paste'),
  folder: () => ipcRenderer.invoke('folder'),
  inspect: url => ipcRenderer.invoke('inspect', url),
  download: data => ipcRenderer.invoke('download', data),
  cancel: () => ipcRenderer.invoke('cancel'),
  invalidate: () => ipcRenderer.invoke('invalidate'),
  reveal: () => ipcRenderer.invoke('reveal'),
  minimize: () => ipcRenderer.invoke('minimize'),
  close: () => ipcRenderer.invoke('close'),
  onProgress: callback => { const listener = (_, data) => callback(data); ipcRenderer.on('progress', listener); return () => ipcRenderer.removeListener('progress', listener); }
});
