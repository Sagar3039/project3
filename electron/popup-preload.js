const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  hide: () => ipcRenderer.send('popup:hide'),
  chat: (query, model) => ipcRenderer.invoke('popup:chat', query, model),
  onChunk: (callback) => ipcRenderer.on('popup:chunk', (_, data) => callback(data)),
  tts: (text) => ipcRenderer.invoke('popup:tts', text),
  getModel: () => ipcRenderer.invoke('popup:getModel'),
  composio: {
    getTools: (toolkits) => ipcRenderer.invoke('composio:getTools', toolkits),
    connectUrl: (toolkit) => ipcRenderer.invoke('composio:connectUrl', toolkit),
    status: (toolkit) => ipcRenderer.invoke('composio:status', toolkit)
  }
});
