import { app } from 'electron'
import updaterPkg from 'electron-updater'
import type { AppEvent, UpdateState } from '../shared/types.ts'

const { autoUpdater } = updaterPkg

// Installed copies update themselves from the GitHub releases configured under "publish" in package.json.
let state: UpdateState = { phase: 'idle', current: app.getVersion() }
let emit: (e: AppEvent) => void = () => {}

function setState(patch: Partial<UpdateState>) {
  state = { ...state, ...patch }
  emit({ type: 'update', state })
}

export function setupUpdater(send: (e: AppEvent) => void) {
  emit = send
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => setState({ phase: 'checking', error: undefined }))
  autoUpdater.on('update-not-available', () => setState({ phase: 'none', checkedAt: Date.now() }))
  autoUpdater.on('update-available', (info) => setState({ phase: 'downloading', version: info.version, percent: 0 }))
  autoUpdater.on('download-progress', (p) => setState({ phase: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => setState({ phase: 'ready', version: info.version }))
  autoUpdater.on('error', (e) => setState({ phase: 'error', error: String(e?.message ?? e).split('\n')[0] }))
  setTimeout(() => void check(), 8000)
  setInterval(() => void check(), 6 * 3600 * 1000)
}

export async function check(): Promise<UpdateState> {
  if (!app.isPackaged) return { ...state, phase: 'error', error: 'Updates only work in the installed app' }
  try {
    await autoUpdater.checkForUpdates()
  } catch (e: any) {
    setState({ phase: 'error', error: String(e?.message ?? e).split('\n')[0] })
  }
  return state
}

export function getState(): UpdateState {
  return state
}

export function install() {
  if (state.phase === 'ready') autoUpdater.quitAndInstall(false, true)
}
