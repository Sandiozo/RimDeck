import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('rd', {
  invoke: (method: string, ...args: unknown[]) => ipcRenderer.invoke('rd:invoke', method, args),
  on: (cb: (e: unknown) => void) => {
    const listener = (_: unknown, e: unknown) => cb(e)
    ipcRenderer.on('rd:event', listener)
    return () => ipcRenderer.removeListener('rd:event', listener)
  },
  platform: process.platform,
})
