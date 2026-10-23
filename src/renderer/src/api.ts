import type {
  AppEvent,
  AppState,
  DefData,
  InstallSummary,
  LoadReport,
  ChangeReport,
  DownloadsState,
  LogReport,
  ModAssemblyReport,
  ModMeta,
  ModsConfig,
  Paths,
  RulesBundle,
  SaveSummary,
  SettingsFile,
  SettingsNode,
  SettingsSchema,
  UpdateState,
  TextureReport,
  XmlReport,
  XmlSearchResult,
  Settings,
  UpdateReport,
  UserData,
  WorkshopCollection,
} from '@shared/types'

interface Bridge {
  invoke(method: string, ...args: unknown[]): Promise<any>
  on(cb: (e: AppEvent) => void): () => void
  platform: string
}

const rd: Bridge | undefined = (window as any).rd
const BRIDGE = 'http://127.0.0.1:5199'

export const isElectron = !!rd
export const platform = rd?.platform ?? (/Mac/.test(navigator.platform) ? 'darwin' : /Linux/.test(navigator.platform) ? 'linux' : 'win32')
export const isMac = platform === 'darwin'

async function invoke(method: string, ...args: unknown[]): Promise<any> {
  if (rd) return rd.invoke(method, ...args)
  const res = await fetch(`${BRIDGE}/api/${method}`, { method: 'POST', body: JSON.stringify(args) })
  const json = await res.json()
  if (!json.ok) throw new Error(json.error)
  return json.result
}

export const api = {
  getState: (): Promise<AppState> => invoke('getState'),
  refresh: (): Promise<AppState> => invoke('refresh'),
  getRules: (force = false): Promise<RulesBundle> => invoke('getRules', force),
  saveModsConfig: (ids: string[]): Promise<{ backup: string | null; config: ModsConfig | null; user: UserData }> => invoke('saveModsConfig', ids),
  switchProfile: (id: string): Promise<AppState> => invoke('switchProfile', id),
  reloadConfig: (): Promise<ModsConfig | null> => invoke('reloadConfig'),
  setSettings: (patch: Partial<Settings>): Promise<AppState> => invoke('setSettings', patch),
  detectPaths: (): Promise<{ paths: Paths; source: string }> => invoke('detectPaths'),
  setModMeta: (pid: string, meta: ModMeta | null): Promise<UserData> => invoke('setModMeta', pid, meta),
  setUser: (patch: Partial<UserData>): Promise<UserData> => invoke('setUser', patch),
  importRimSort: (): Promise<{ found: boolean; rules: number; ignored: number; meta: number }> => invoke('importRimSort'),
  listSaves: (): Promise<SaveSummary[]> => invoke('listSaves'),
  listBackups: (): Promise<{ file: string; mtime: number; count: number }[]> => invoke('listBackups'),
  analyze: (pids: string[]): Promise<ModAssemblyReport[]> => invoke('analyze', pids),
  readLog: (): Promise<LogReport | null> => invoke('readLog'),
  launch: (continueSave?: string): Promise<{ ok: boolean; message: string }> => invoke('launch', continueSave),
  latestSave: (): Promise<{ name: string; file: string; mtime: number } | null> => invoke('latestSave'),
  prepareContinue: (): Promise<{ created: boolean; state: AppState | null }> => invoke('prepareContinue'),
  readListFile: (file: string): Promise<string[]> => invoke('readListFile', file),
  writeListFile: (file: string, ids: string[]): Promise<void> => invoke('writeListFile', file, ids),
  workshopCollection: (id: string): Promise<WorkshopCollection> => invoke('workshopCollection', id),
  getDownloads: (): Promise<DownloadsState> => invoke('getDownloads'),
  queueDownloads: (ids: string[]): Promise<DownloadsState> => invoke('queueDownloads', ids),
  cancelDownloads: (ids?: string[]): Promise<DownloadsState> => invoke('cancelDownloads', ids),
  clearDownloads: (): Promise<DownloadsState> => invoke('clearDownloads'),
  steamLogin: (user: string, password?: string): Promise<DownloadsState> => invoke('steamLogin', user, password ?? null),
  steamLoginCode: (code: string): Promise<DownloadsState> => invoke('steamLoginCode', code),
  steamLoginCancel: (): Promise<DownloadsState> => invoke('steamLoginCancel'),
  steamLogout: (): Promise<DownloadsState> => invoke('steamLogout'),
  steamUseAccount: (on: boolean): Promise<DownloadsState> => invoke('steamUseAccount', on),
  installSteamcmd: (): Promise<DownloadsState> => invoke('installSteamcmd'),
  checkUpdates: (force = false): Promise<UpdateReport> => invoke('checkUpdates', force),
  textures: (pids: string[]): Promise<TextureReport> => invoke('textures', pids),
  xmlReport: (pids: string[]): Promise<XmlReport> => invoke('xmlReport', pids),
  searchXml: (query: string, pids: string[]): Promise<XmlSearchResult> => invoke('searchXml', query, pids),
  changes: (): Promise<ChangeReport> => invoke('changes'),
  modSettings: (): Promise<SettingsFile[]> => invoke('modSettings'),
  readModSettings: (path: string): Promise<SettingsNode> => invoke('readModSettings', path),
  writeModSettings: (path: string, root: SettingsNode): Promise<{ backup: string }> => invoke('writeModSettings', path, root),
  resetModSettings: (path: string): Promise<{ backup: string }> => invoke('resetModSettings', path),
  modSettingsSchema: (path: string): Promise<SettingsSchema | null> => invoke('modSettingsSchema', path),
  archiveSettings: (paths: string[]): Promise<number> => invoke('archiveSettings', paths),
  gameRunning: (): Promise<boolean> => invoke('checkGameRunning'),
  loadReport: (pids: string[]): Promise<LoadReport> => invoke('loadReport', pids),
  texturePicks: (): Promise<Record<string, { packageId: string; source: string; files: string[]; at: number }>> => invoke('texturePicks'),
  pickTexture: (key: string, packageId: string, source: string, dds: boolean): Promise<{ created: boolean; state: AppState | null }> => invoke('pickTexture', key, packageId, source, dds),
  unpickTexture: (key: string): Promise<void> => invoke('unpickTexture', key),
  defData: (pids: string[]): Promise<DefData> => invoke('defData', pids),
  listInstalls: (): Promise<InstallSummary[]> => invoke('listInstalls'),
  trashMods: (pids: string[]): Promise<{ trashed: string[]; skipped: string[] }> => invoke('trashMods', pids),
  unsubscribeMods: (pids: string[]): Promise<{ ok: boolean; done: string[]; failed: { id: string; error: string }[]; error?: string; packageIds: string[] }> => invoke('unsubscribeMods', pids),
  addInstall: (o: { name: string; gameDir: string; dataFolder?: string }): Promise<InstallSummary[]> => invoke('addInstall', o),
  renameInstall: (id: string, name: string): Promise<InstallSummary[]> => invoke('renameInstall', id, name),
  removeInstall: (id: string): Promise<InstallSummary[]> => invoke('removeInstall', id),
  openPath: (p: string): Promise<void> => invoke('openPath', p),
  showItem: (p: string): Promise<void> => invoke('showItem', p),
  openUrl: (u: string): Promise<void> => invoke('openUrl', u),
  pickFolder: (title: string): Promise<string | null> => invoke('pickFolder', title),
  pickOpenFile: (title: string, ext: string[]): Promise<string | null> => invoke('pickOpenFile', title, ext),
  pickSaveFile: (title: string, name: string): Promise<string | null> => invoke('pickSaveFile', title, name),
  setTitleBarColor: (bg: string, fg: string): Promise<void> => invoke('setTitleBarColor', bg, fg),
  logInterfaceStall: (ms: number, where: string): Promise<void> => invoke('logInterfaceStall', ms, where),
  updateState: (): Promise<UpdateState> => invoke('updateState'),
  updateCheck: (): Promise<UpdateState> => invoke('updateCheck'),
  updateInstall: (): Promise<void> => invoke('updateInstall'),
  appVersion: (): Promise<string> => invoke('appVersion'),
}

export function imgUrl(path: string, width = 0) {
  const q = `p=${encodeURIComponent(path)}&w=${width}`
  return rd ? `rdimg://img/?${q}` : `${BRIDGE}/img?${q}`
}

export function onEvent(cb: (e: AppEvent) => void): () => void {
  if (rd) return rd.on(cb)
  const es = new EventSource(`${BRIDGE}/events`)
  es.onmessage = (m) => cb(JSON.parse(m.data))
  return () => es.close()
}

export { workshopUrl } from '@shared/workshop'
