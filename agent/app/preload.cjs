// The only bridge between the window and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agent', {
  getState: () => ipcRenderer.invoke('agent:state'),
  pair: (server, code) => ipcRenderer.invoke('agent:pair', server, code),
  fetchPrinters: (opts) => ipcRenderer.invoke('agent:fetch', opts),
  setOption: (name, value) => ipcRenderer.invoke('agent:option', name, value),
  unpair: () => ipcRenderer.invoke('agent:unpair'),
  openDashboard: () => ipcRenderer.invoke('agent:openDashboard'),
  onState: (cb) => ipcRenderer.on('state', (_event, state) => cb(state)),
});
