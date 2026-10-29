'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('paradox', {
  data: (day, force) => ipcRenderer.invoke('data', day, !!force),
  config: () => ipcRenderer.invoke('config'),
  addSource: (s) => ipcRenderer.invoke('add-source', s),
  delSource: (i) => ipcRenderer.invoke('del-source', i),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  testNotify: () => ipcRenderer.invoke('test-notify'),
  onGoto: (cb) => ipcRenderer.on('goto', (_e, page) => cb(page)),
});
