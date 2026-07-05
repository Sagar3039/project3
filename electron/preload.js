const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistantAPI', {
  platform: process.platform,
  sessions: {
    load: () => ipcRenderer.invoke('sessions:load'),
    save: (sessions) => ipcRenderer.invoke('sessions:save', sessions)
  },
  memory: {
    load: () => ipcRenderer.invoke('memory:load'),
    save: (memory) => ipcRenderer.invoke('memory:save', memory),
    extract: (session) => ipcRenderer.invoke('memory:extract', session),
    getContext: (currentMessage, currentSessionId) => ipcRenderer.invoke('memory:getContext', currentMessage, currentSessionId)
  },
  tts: {
    getEdgeVoices: () => ipcRenderer.invoke('tts:getEdgeVoices'),
    speak: (text, options) => ipcRenderer.invoke('tts:speak', text, options),
    stop: () => ipcRenderer.invoke('tts:stop')
  },
  stt: {
    transcribe: (audioBase64) => ipcRenderer.invoke('stt:transcribe', audioBase64)
  }
});
