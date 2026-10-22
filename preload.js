const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  ask: (pcmBuffer, micBuffer, length) => ipcRenderer.send('ask', pcmBuffer, micBuffer, length),
  hide: () => ipcRenderer.send('hide'),
  getProfile: () => ipcRenderer.invoke('get-profile'),
  saveProfile: (text) => ipcRenderer.invoke('save-profile', text),
  pickResume: () => ipcRenderer.invoke('pick-resume'),
  onChunk: (fn) => ipcRenderer.on('ai-chunk', (_e, t) => fn(t)),
  onDone: (fn) => ipcRenderer.on('ai-done', (_e, text) => fn(text)),
  onError: (fn) => ipcRenderer.on('ai-error', (_e, msg) => fn(msg)),
  onForceAsk: (fn) => ipcRenderer.on('force-ask', () => fn())
});
