import { spawn } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { copyFile, cp, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import type {
  Profile,
  GameInstall,
  InstallSummary,
  DefData,
  ChangeReport,
  LoadReport,
  ModCost,
  SettingsFile,
  SettingsNode,
  TextureReport,
  XmlReport,
  XmlSearchResult,
  AppEvent,
  AppState,
  DownloadsState,
  LogReport,
  ModAssemblyReport,
  ModInfo,
  ModMeta,
  ModsConfig,
  RulesBundle,
  SaveSummary,
  Settings,
  UpdateReport,
  UserData,
  WorkshopCollection,
  WorkshopDetails,
  WorkshopUpdate,
} from '../shared/types.ts'
import { effectiveDirs, OFFICIAL_ORDER } from '../shared/graph.ts'
import { readAssembly, type AssemblyInfo } from './core/harmony.ts'
import { findPlayerLog, parsePlayerLog, type Attribution } from './core/logs.ts'
import { listBackups, readModListFile, readModsConfig, serializeModsConfig, writeModsConfig } from './core/modsconfig.ts'
import { defaultConfigDir, detectPaths, majorOf, readGameVersion, validatePaths } from './core/paths.ts'
import { importFromRimSort } from './core/rimsort.ts'
import { loadRules } from './core/rulesdb.ts'
import { backupNewestSave, listSaves, readSaveMeta } from './core/saves.ts'
import { scanAll } from './core/scanner.ts'
import { textureLookup, textureReport } from './core/textures.ts'
import { extractDefData } from './core/defdata.ts'
import { isGameRunning, matchSettingsFiles, moveToBackup, readSettings, resetSettings, writeSettings } from './core/modsettings.ts'
import { isSlowXpath, mediaStats, score, startupFromLog } from './core/loadtime.ts'
import { ensurePicksMod, listPicks, pickTexture, PICKS_ID, unpickTexture } from './core/texturepicks.ts'
import { steamWorkshop, type SteamJobResult } from './core/steamclient.ts'
import { buildXmlReport, indexModXml, searchXml, type ModXml } from './core/xmlindex.ts'
import { DownloadQueue, SteamCmd } from './core/steamcmd.ts'
import { readJson, writeJson } from './core/store.ts'
import { fetchCollections, fetchDetails, newestMtime, readWorkshopAcf } from './core/workshop.ts'

interface PlaySnapshot {
  time: number
  installed: Record<string, { name: string; mtime: number }>
  active: string[]
}

const DEFAULT_SETTINGS: Settings = {
  paths: { gameDir: '', configDir: '', localModsDir: '', workshopDir: '' },
  sortMode: 'grouped',
  launchArgs: '',
  launchViaSteam: false,
  backupSaveOnLaunch: true,
  depsAsLoadAfter: true,
  useCommunityRules: true,
  accent: '#7c8cff',
  firstRunDone: false,
  targetVersion: '',
  installs: [],
  currentInstall: 'default',
}

const DEFAULT_USER: UserData = { meta: {}, userRules: {}, lists: [], ignored: [] }
const DETAILS_TTL = 30 * 60 * 1000

// What RimDeck itself installed, so update checks for local copies don't have to guess from file dates.
type DownloadRecords = Record<string, { timeUpdated: number; installedAt: number; path: string }>

/** True when `child` is inside `parent`. */
function inside(parent: string, child: string) {
  if (!parent) return false
  const r = relative(parent, child)
  return !!r && !r.startsWith('..') && !isAbsolute(r)
}

export class Service {
  dataDir: string
  emit: (e: AppEvent) => void
  settings: Settings = DEFAULT_SETTINGS
  user: UserData = DEFAULT_USER
  mods: ModInfo[] = []
  config: ModsConfig | null = null
  gameVersion = ''
  scanMs = 0
  pathProblems: string[] = []
  lastWrite = 0
  rules: RulesBundle | null = null
  asmCache = new Map<string, { mtime: number; info: AssemblyInfo | null }>()
  watchers: FSWatcher[] = []
  rescanTimer: NodeJS.Timeout | null = null
  gameRunning = false
  steamcmd: SteamCmd
  downloads: DownloadQueue
  downloadRecords: DownloadRecords = {}
  details = new Map<string, { at: number; d: WorkshopDetails }>()
  updateReport: UpdateReport | null = null

  constructor(dataDir: string, emit: (e: AppEvent) => void) {
    this.dataDir = dataDir
    this.emit = emit
    this.steamcmd = new SteamCmd(join(dataDir, 'steamcmd'))
    this.downloads = new DownloadQueue(this.steamcmd, {
      emit: (state) => this.emit({ type: 'downloads', state }),
      targetFor: (id) => this.downloadTarget(id),
      retire: (p) => this.retireMod(p),
      installed: async (id, path) => {
        this.downloadRecords[id] = { timeUpdated: this.details.get(id)?.d.timeUpdated ?? 0, installedAt: Date.now(), path }
        await writeJson(this.file('downloads.json'), this.downloadRecords)
      },
      finished: async () => {
        await this.rescan()
        if (this.updateReport) this.updateReport = await this.buildUpdateReport(false)
      },
    })
  }

  file(name: string) {
    return join(this.dataDir, name)
  }

  // Backups and play history belong to one install; the first install keeps the original locations.
  instFile(name: string) {
    const id = this.settings.currentInstall
    return !id || id === 'default' ? this.file(name) : join(this.dataDir, 'installs', id, name)
  }

  syncCurrentInstall() {
    const i = this.settings.installs?.find((x) => x.id === this.settings.currentInstall)
    if (i) {
      i.paths = { ...this.settings.paths }
      i.launchArgs = this.settings.launchArgs
    }
  }

  async listInstalls(): Promise<InstallSummary[]> {
    return Promise.all(
      this.settings.installs.map(async (i) => ({
        ...i,
        version: await readGameVersion(i.paths.gameDir),
        current: i.id === this.settings.currentInstall,
        problems: await validatePaths(i.paths),
      })),
    )
  }

  async switchInstall(id: string): Promise<AppState> {
    const target = this.settings.installs.find((i) => i.id === id)
    if (!target) throw new Error('Unknown install')
    this.syncCurrentInstall()
    this.settings.currentInstall = id
    this.settings.paths = { ...target.paths }
    this.settings.launchArgs = target.launchArgs
    await this.saveSettings()
    this.defCache = null
    await this.rescan(false)
    this.startWatching()
    return this.state()
  }

  async addInstall(opts: { name: string; gameDir: string; dataFolder?: string }): Promise<InstallSummary[]> {
    try {
      await stat(join(opts.gameDir, 'Data', 'Core'))
    } catch {
      throw new Error('This folder is not a RimWorld install (no Data/Core folder found)')
    }
    const dataFolder = opts.dataFolder?.trim() || undefined
    if (dataFolder) await mkdir(join(dataFolder, 'Config'), { recursive: true })
    const install: GameInstall = {
      id: `i${Date.now().toString(36)}`,
      name: opts.name.trim() || 'RimWorld',
      paths: {
        gameDir: opts.gameDir,
        localModsDir: join(opts.gameDir, 'Mods'),
        // Workshop content is shared by every install on the same Steam account.
        workshopDir: this.settings.paths.workshopDir,
        configDir: dataFolder ? join(dataFolder, 'Config') : defaultConfigDir(),
      },
      launchArgs: dataFolder ? `-savedatafolder="${dataFolder}"` : '',
      dataFolder,
    }
    this.settings.installs = [...this.settings.installs, install]
    await this.saveSettings()
    return this.listInstalls()
  }

  async renameInstall(id: string, name: string): Promise<InstallSummary[]> {
    const i = this.settings.installs.find((x) => x.id === id)
    if (i && name.trim()) i.name = name.trim()
    await this.saveSettings()
    return this.listInstalls()
  }

  async removeInstall(id: string): Promise<InstallSummary[]> {
    if (id === this.settings.currentInstall) throw new Error('Switch to another install before removing this one')
    this.settings.installs = this.settings.installs.filter((i) => i.id !== id)
    await this.saveSettings()
    return this.listInstalls()
  }

  async init() {
    this.settings = await readJson(this.file('settings.json'), DEFAULT_SETTINGS)
    this.settings.paths = { ...DEFAULT_SETTINGS.paths, ...this.settings.paths }
    this.user = await readJson(this.file('user.json'), DEFAULT_USER)
    this.downloadRecords = await readJson<DownloadRecords>(this.file('downloads.json'), {})
    if (!this.settings.paths.gameDir) {
      const { paths } = await detectPaths()
      this.settings.paths = paths
    }
    // Older settings had a single set of paths: that becomes the first install.
    if (!this.settings.installs?.length) {
      this.settings.installs = [{ id: 'default', name: 'Main install', paths: this.settings.paths, launchArgs: this.settings.launchArgs }]
      this.settings.currentInstall = 'default'
      await this.saveSettings()
    }
    await this.rescan(false)
    await this.migrateProfiles()
    if (!this.settings.firstRunDone) {
      await this.importRimSort()
      this.settings.firstRunDone = true
      await this.saveSettings()
    }
    this.startWatching()
  }

  async saveSettings() {
    await writeJson(this.file('settings.json'), this.settings)
  }

  // Serialized so rapid edits (e.g. coloring many mods) never interleave writes.
  saving: Promise<void> = Promise.resolve()
  saveUser() {
    this.saving = this.saving.then(() => writeJson(this.file('user.json'), this.user)).catch(() => {})
    return this.saving
  }

  async rescan(emit = true) {
    const t = performance.now()
    const p = this.settings.paths
    const [version, problems, config] = await Promise.all([readGameVersion(p.gameDir), validatePaths(p), readModsConfig(p.configDir)])
    this.gameVersion = version
    this.pathProblems = problems
    this.config = config
    this.mods = await scanAll(p, majorOf(version))
    this.scanMs = Math.round(performance.now() - t)
    if (emit) this.emit({ type: 'mods-changed' })
  }

  state(): AppState {
    return {
      settings: this.settings,
      gameVersion: this.gameVersion,
      gameMajor: this.settings.targetVersion || majorOf(this.gameVersion),
      installedMajor: majorOf(this.gameVersion),
      mods: this.mods,
      config: this.config,
      user: this.user,
      scanMs: this.scanMs,
      pathProblems: this.pathProblems,
    }
  }

  async getState(): Promise<AppState> {
    return this.state()
  }

  async refresh(): Promise<AppState> {
    await this.rescan(false)
    return this.state()
  }

  async getRules(force = false): Promise<RulesBundle> {
    if (!this.rules || force) this.rules = await loadRules(this.file('db'), force)
    return this.rules
  }

  async saveModsConfig(activeMods: string[]): Promise<{ backup: string | null; config: ModsConfig | null; user: UserData }> {
    const dir = this.settings.paths.configDir
    if (!dir) throw new Error('Config folder is not set')
    const known = new Set(this.config?.knownExpansions ?? [])
    for (const m of this.mods) if (m.source === 'dlc') known.add(m.packageId)
    const { backup, mtime } = await writeModsConfig(dir, this.instFile('backups'), {
      version: this.config?.version || this.gameVersion,
      activeMods,
      knownExpansions: OFFICIAL_ORDER.filter((id) => known.has(id) && id !== 'ludeon.rimworld'),
    })
    this.lastWrite = mtime
    this.config = await readModsConfig(dir)
    const profile = this.currentProfile()
    if (profile && profile.installId === this.settings.currentInstall) {
      profile.mods = [...activeMods]
      profile.updatedAt = Date.now()
      await this.saveUser()
    }
    return { backup, config: this.config, user: this.user }
  }

  currentProfile(): Profile | undefined {
    return this.user.profiles?.find((p) => p.id === this.user.currentProfile)
  }

  // First run with profiles: the current load order becomes "Default", and saved mod lists become profiles.
  async migrateProfiles() {
    if (this.user.profiles?.length) return
    const now = Date.now()
    const install = this.settings.currentInstall || 'default'
    const profiles: Profile[] = [{ id: 'p-default', name: 'Default', installId: install, mods: this.config?.activeMods ?? [], createdAt: now, updatedAt: now }]
    ;(this.user.lists ?? []).forEach((l, i) =>
      profiles.push({ id: `p-${now.toString(36)}-${i}`, name: l.name, installId: install, mods: l.ids, createdAt: l.createdAt || now, updatedAt: l.createdAt || now }),
    )
    this.user = { ...this.user, profiles, currentProfile: 'p-default', lists: [] }
    await this.saveUser()
  }

  // Switching loads the profile's install (if different) and writes its mods to ModsConfig.xml, ready to play.
  async switchProfile(id: string): Promise<AppState> {
    const p = this.user.profiles?.find((x) => x.id === id)
    if (!p) throw new Error('Unknown profile')
    if (!this.settings.installs.some((i) => i.id === p.installId)) throw new Error('This profile’s game install was removed. Select another install for it first.')
    if (p.installId !== this.settings.currentInstall) await this.switchInstall(p.installId)
    this.user.currentProfile = id
    await this.saveUser()
    if (this.settings.paths.configDir) await this.saveModsConfig(p.mods.length ? p.mods : ['ludeon.rimworld'])
    return this.state()
  }

  async reloadConfig(): Promise<ModsConfig | null> {
    this.config = await readModsConfig(this.settings.paths.configDir)
    return this.config
  }

  async setSettings(patch: Partial<Settings>): Promise<AppState> {
    const pathsChanged = patch.paths && JSON.stringify(patch.paths) !== JSON.stringify(this.settings.paths)
    this.settings = { ...this.settings, ...patch, paths: { ...this.settings.paths, ...patch.paths } }
    this.syncCurrentInstall()
    await this.saveSettings()
    if (pathsChanged) {
      await this.rescan(false)
      this.startWatching()
    }
    return this.state()
  }

  async detectPaths() {
    return detectPaths()
  }

  async setModMeta(packageId: string, meta: ModMeta | null): Promise<UserData> {
    if (meta && Object.values(meta).some((v) => (Array.isArray(v) ? v.length : v))) this.user.meta[packageId] = meta
    else delete this.user.meta[packageId]
    await this.saveUser()
    return this.user
  }

  async setUser(patch: Partial<UserData>): Promise<UserData> {
    this.user = { ...this.user, ...patch }
    await this.saveUser()
    return this.user
  }

  async importRimSort(): Promise<{ found: boolean; rules: number; ignored: number; meta: number }> {
    const imp = await importFromRimSort()
    if (!imp.found) return { found: false, rules: 0, ignored: 0, meta: 0 }
    const byPath = new Map(this.mods.map((m) => [m.path.toLowerCase(), m.packageId]))
    let meta = 0
    for (const [p, m] of Object.entries(imp.metaByPath)) {
      const pid = byPath.get(p)
      if (pid && !this.user.meta[pid]) {
        this.user.meta[pid] = m
        meta++
      }
    }
    this.user.userRules = { ...imp.userRules, ...this.user.userRules }
    this.user.ignored = [...new Set([...this.user.ignored, ...imp.ignored])]
    await this.saveUser()
    return { found: true, rules: Object.keys(imp.userRules).length, ignored: imp.ignored.length, meta }
  }

  async listSaves(): Promise<SaveSummary[]> {
    return listSaves(this.settings.paths.configDir)
  }

  async readSave(file: string) {
    return readSaveMeta(file)
  }

  async listBackups() {
    return listBackups(this.instFile('backups'))
  }

  async readListFile(file: string): Promise<string[]> {
    if (file.toLowerCase().endsWith('.rws')) return (await readSaveMeta(file))?.modIds ?? []
    return readModListFile(file)
  }

  async writeListFile(file: string, ids: string[]) {
    await writeFile(file, serializeModsConfig(this.gameVersion, ids, []), 'utf8')
  }

  analyzeMod(m: ModInfo): ModAssemblyReport {
    const report: ModAssemblyReport = { packageId: m.packageId, dlls: [], patches: [], namespaces: [], usesHarmony: false }
    for (const dll of m.assemblies) {
      const info = this.asmCache.get(dll)?.info ?? readAssembly(dll)
      if (!this.asmCache.has(dll)) this.asmCache.set(dll, { mtime: m.mtime, info })
      if (!info) continue
      report.dlls.push({ file: basename(dll), name: info.name, version: info.version, references: info.references })
      report.patches.push(...info.patches)
      report.namespaces.push(...info.namespaces)
      report.usesHarmony ||= info.usesHarmony
    }
    report.namespaces = [...new Set(report.namespaces)]
    return report
  }

  async analyze(packageIds: string[]): Promise<ModAssemblyReport[]> {
    const want = new Set(packageIds)
    return this.mods.filter((m) => want.has(m.packageId)).map((m) => this.analyzeMod(m))
  }

  // Same rule as the renderer: a local copy wins over a Workshop copy with the same packageId.
  resolveMods(packageIds: string[]): ModInfo[] {
    const rank = { core: 0, dlc: 1, local: 2, workshop: 3 }
    const best = new Map<string, ModInfo>()
    for (const m of this.mods) {
      const cur = best.get(m.packageId)
      if (!cur || rank[m.source] < rank[cur.source]) best.set(m.packageId, m)
    }
    return packageIds.map((id) => best.get(id)).filter((m): m is ModInfo => !!m)
  }

  async textures(packageIds: string[]): Promise<TextureReport> {
    return textureReport(this.resolveMods(packageIds))
  }

  xmlCache = new Map<string, { key: string; data: ModXml }>()

  async xmlIndexes(mods: ModInfo[]): Promise<ModXml[]> {
    const active = new Set(this.config?.activeMods ?? [])
    for (const m of mods) active.add(m.packageId)
    return Promise.all(
      mods.map(async (m) => {
        const dirs = effectiveDirs(m, (p) => active.has(p))
        const key = `${m.mtime}|${dirs.join('|')}`
        const c = this.xmlCache.get(m.path)
        if (c?.key === key) return c.data
        const data = await indexModXml(m, dirs)
        this.xmlCache.set(m.path, { key, data })
        return data
      }),
    )
  }

  async xmlReport(packageIds: string[]): Promise<XmlReport> {
    const t = performance.now()
    const mods = this.resolveMods(packageIds)
    const indexes = await this.xmlIndexes(mods)
    return buildXmlReport(mods, indexes, Math.round(performance.now() - t))
  }

  async loadReport(packageIds: string[]): Promise<LoadReport> {
    const t = performance.now()
    const mods = this.resolveMods(packageIds).filter((m) => m.source !== 'core' && m.source !== 'dlc')
    const active = new Set(packageIds)
    const xml = await this.xmlIndexes(mods)
    const costs = await Promise.all(
      mods.map(async (m, i) => {
        const media = await mediaStats(m, effectiveDirs(m, (p) => active.has(p)))
        const x = xml[i]
        const base = {
          ...media,
          defs: x.defs.length,
          patches: x.patches.length,
          slowPatches: x.patches.filter((p) => isSlowXpath(p.xpath)).length,
          harmonyPatches: m.hasAssemblies ? this.analyzeMod(m).patches.length : 0,
        }
        return { packageId: m.packageId, ...base, score: score(base) } as ModCost
      }),
    )
    const log = await findPlayerLog(this.settings.paths.configDir)
    const startup = log ? await startupFromLog(log) : undefined
    return { mods: costs.sort((a, b) => b.score - a.score), startup, ms: Math.round(performance.now() - t) }
  }

  // Local mods go to the Recycle Bin (restorable). Only folders directly inside the local mods folder qualify.
  async trashMods(packageIds: string[]): Promise<{ trashed: string[]; skipped: string[] }> {
    const { shell } = await import('electron')
    const root = this.settings.paths.localModsDir
    const trashed: string[] = []
    const skipped: string[] = []
    for (const m of this.mods.filter((x) => packageIds.includes(x.packageId))) {
      const rel = root ? relative(root, m.path) : ''
      if (m.source !== 'local' || !rel || rel.startsWith('..') || isAbsolute(rel) || /[\\/]/.test(rel)) {
        skipped.push(m.packageId)
        continue
      }
      try {
        await shell.trashItem(m.path)
        trashed.push(m.packageId)
      } catch {
        skipped.push(m.packageId)
      }
    }
    if (trashed.length) await this.rescan(false)
    return { trashed, skipped }
  }

  // Workshop mods are unsubscribed through the Steam client, which then deletes their files.
  async unsubscribeMods(packageIds: string[]): Promise<SteamJobResult & { packageIds: string[] }> {
    const mods = this.mods.filter((m) => m.source === 'workshop' && m.workshopId && packageIds.includes(m.packageId))
    const result = await steamWorkshop('unsubscribe', mods.map((m) => m.workshopId!), this.file('steam'))
    const done = new Set(result.done)
    // Steam removes the folders a few seconds after the helper exits; the folder watcher picks that up too.
    if (done.size) setTimeout(() => this.rescan().catch(() => {}), 6000)
    return { ...result, packageIds: mods.filter((m) => done.has(m.workshopId!)).map((m) => m.packageId) }
  }

  async texturePicks() {
    const dir = this.settings.paths.localModsDir
    return dir ? listPicks(dir) : {}
  }

  // Creates the picks mod on first use and keeps a "load last" rule for it so sorting never buries it.
  async pickTexture(key: string, packageId: string, source: string, hasDds: boolean) {
    const dir = this.settings.paths.localModsDir
    if (!dir) throw new Error('Set the local mods folder in Settings first')
    const created = await ensurePicksMod(dir, ['1.4', '1.5', '1.6', '1.7'])
    const pick = await pickTexture(dir, key, packageId, source, hasDds)
    if (!this.user.userRules[PICKS_ID]?.loadBottom?.value) {
      this.user.userRules = { ...this.user.userRules, [PICKS_ID]: { ...this.user.userRules[PICKS_ID], loadBottom: { value: true } } }
      await this.saveUser()
    }
    if (created) await this.rescan(false)
    return { pick, created, state: created ? this.state() : null }
  }

  async unpickTexture(key: string) {
    const dir = this.settings.paths.localModsDir
    if (dir) await unpickTexture(dir, key)
  }

  // Research tree and item list for the given load order (game + active mods), cached per order.
  defCache: { key: string; data: DefData } | null = null
  async defData(packageIds: string[]): Promise<DefData> {
    const game = this.mods.filter((m) => m.source === 'core' || m.source === 'dlc')
    const gameIds = new Set(game.map((m) => m.packageId))
    const order = [...packageIds.filter((p) => gameIds.has(p)), ...packageIds.filter((p) => !gameIds.has(p))]
    const mods = this.resolveMods(order)
    const key = mods.map((m) => `${m.packageId}:${m.mtime}`).join('|')
    if (this.defCache?.key === key) return this.defCache.data
    const indexes = await this.xmlIndexes(mods)
    const lookup = await textureLookup(mods)
    const data = await extractDefData(mods, indexes.map((x) => x.files), lookup)
    this.defCache = { key, data }
    return data
  }

  // Searches the Defs and Patches of the given mods plus the game itself.
  async searchXml(query: string, packageIds: string[]): Promise<XmlSearchResult> {
    const game = this.mods.filter((m) => m.source === 'core' || m.source === 'dlc').map((m) => m.packageId)
    const mods = this.resolveMods([...new Set([...game, ...packageIds])])
    return searchXml(query, mods, await this.xmlIndexes(mods))
  }

  async readLog(): Promise<LogReport | null> {
    const file = await findPlayerLog(this.settings.paths.configDir)
    if (!file) return null
    const active = new Set(this.config?.activeMods ?? [])
    const mods = this.mods.filter((m) => active.has(m.packageId))
    const a: Attribution = { namespaces: new Map(), packageIds: new Set(), names: new Map(), harmonyIds: new Map() }
    for (const m of mods) {
      a.packageIds.add(m.packageId)
      a.names.set(m.name.toLowerCase(), m.packageId)
      if (m.source === 'core' || m.source === 'dlc' || m.packageId === 'brrainz.harmony') continue
      for (const ns of this.analyzeMod(m).namespaces) if (!a.namespaces.has(ns)) a.namespaces.set(ns, m.packageId)
    }
    return parsePlayerLog(file, a)
  }

  // Mod settings live in Config/Mod_<folder>_<Class>.xml; only files directly in that folder may be touched.
  settingsPath(path: string) {
    const rel = relative(this.settings.paths.configDir, path)
    if (!rel || rel.includes('..') || /[\\/]/.test(rel) || isAbsolute(rel) || !/^Mod_.+\.xml$/i.test(rel)) throw new Error('Not a mod settings file')
    return path
  }

  async modSettings(): Promise<SettingsFile[]> {
    const folders = this.mods.filter((m) => m.source === 'local' || m.source === 'workshop').map((m) => m.folder)
    return matchSettingsFiles(this.settings.paths.configDir, folders)
  }

  async readModSettings(path: string): Promise<SettingsNode> {
    return readSettings(this.settingsPath(path))
  }

  async assertGameClosed() {
    if (await isGameRunning()) throw new Error('Close RimWorld first. The game rewrites mod settings when it exits.')
  }

  async writeModSettings(path: string, root: SettingsNode): Promise<{ backup: string }> {
    await this.assertGameClosed()
    return writeSettings(this.settingsPath(path), root, this.file('settings-backups'))
  }

  async resetModSettings(path: string): Promise<{ backup: string }> {
    await this.assertGameClosed()
    return resetSettings(this.settingsPath(path), this.file('settings-backups'))
  }

  async archiveSettings(paths: string[]): Promise<number> {
    await this.assertGameClosed()
    return moveToBackup(paths.map((p) => this.settingsPath(p)), join(this.file('settings-backups'), 'orphaned'))
  }

  async checkGameRunning(): Promise<boolean> {
    return isGameRunning()
  }

  // Snapshot of what was installed/active when the game was started from RimDeck.
  async recordPlay() {
    const history = await readJson<PlaySnapshot[]>(this.instFile('play-history.json'), [])
    const installed: PlaySnapshot['installed'] = {}
    for (const m of this.mods) installed[m.packageId] = { name: m.name, mtime: m.mtime }
    history.push({ time: Date.now(), installed, active: this.config?.activeMods ?? [] })
    await writeJson(this.instFile('play-history.json'), history.slice(-10))
  }

  // Compares against the latest of: RimDeck's last launch snapshot, or the game log's start time (game started elsewhere).
  async changes(): Promise<ChangeReport> {
    const history = await readJson<PlaySnapshot[]>(this.instFile('play-history.json'), [])
    const snap = history[history.length - 1]
    let logStart = 0
    const log = await findPlayerLog(this.settings.paths.configDir)
    if (log) {
      try {
        const fh = await open(log, 'r')
        const buf = Buffer.alloc(600)
        const { bytesRead } = await fh.read(buf, 0, 600, 0)
        await fh.close()
        const head = buf.subarray(0, bytesRead).toString('utf8')
        const m = head.match(/^Started:\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?)\s*([+-]\d\d:\d\d)?/m)
        logStart = m ? Date.parse(m[1].replace(' ', 'T') + (m[2] ?? '')) : (await stat(log)).mtimeMs
      } catch {}
    }
    const useSnap = !!snap && snap.time >= logStart - 120000
    const since = useSnap ? snap.time : logStart
    const report: ChangeReport = { since, source: useSnap ? 'rimdeck' : logStart ? 'log' : 'none', updated: [], added: [], removed: [], activated: [], deactivated: [] }
    if (!since) return report
    const game = (m: ModInfo) => m.source === 'core' || m.source === 'dlc'
    for (const m of this.mods) {
      if (game(m)) continue
      const known = useSnap ? snap.installed[m.packageId] : undefined
      if ((useSnap && !known) || (!useSnap && m.added > since)) report.added.push(m.packageId)
      else if (m.mtime > since) report.updated.push(m.packageId)
    }
    if (useSnap) {
      const now = new Set(this.mods.map((m) => m.packageId))
      for (const [pid, v] of Object.entries(snap.installed)) if (!now.has(pid)) report.removed.push({ packageId: pid, name: v.name })
    }
    // What was active then: the snapshot, or failing that the newest save played after the log started.
    let then: string[] | null = useSnap ? snap.active : null
    if (!then) {
      const save = (await listSaves(this.settings.paths.configDir))[0]
      if (save && save.mtime >= since) then = save.modIds
    }
    if (then) {
      const was = new Set(then)
      const nowActive = this.config?.activeMods ?? []
      const is = new Set(nowActive)
      report.activated = nowActive.filter((p) => !was.has(p))
      report.deactivated = then.filter((p) => !is.has(p))
    }
    return report
  }

  async launch(): Promise<{ ok: boolean; message: string }> {
    const p = this.settings.paths
    await this.recordPlay().catch(() => {})
    if (this.settings.backupSaveOnLaunch) await backupNewestSave(p.configDir, this.instFile('save-backups'))
    if (this.settings.launchViaSteam) {
      const { shell } = await import('electron')
      await shell.openExternal('steam://rungameid/294100' + (this.settings.launchArgs ? '//' + encodeURIComponent(this.settings.launchArgs) : ''))
      return { ok: true, message: 'Launching through Steam' }
    }
    const exe = process.platform === 'win32' ? join(p.gameDir, 'RimWorldWin64.exe') : join(p.gameDir, 'RimWorldLinux')
    try {
      await stat(exe)
    } catch {
      return { ok: false, message: `Game executable not found: ${exe}` }
    }
    // Quote-aware so -savedatafolder="C:\My Games\RimWorld" stays one argument.
    const args = (this.settings.launchArgs.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((a) => a.replace(/"/g, ''))
    const child = spawn(exe, args, { cwd: p.gameDir, detached: true, stdio: 'ignore' })
    this.gameRunning = true
    child.on('exit', () => {
      this.gameRunning = false
      this.emit({ type: 'game-exited' })
    })
    child.unref()
    return { ok: true, message: 'RimWorld started' }
  }

  async restoreBackup(file: string): Promise<ModsConfig | null> {
    const dir = this.settings.paths.configDir
    await copyFile(file, join(dir, 'ModsConfig.xml'))
    this.config = await readModsConfig(dir)
    this.lastWrite = this.config?.mtime ?? 0
    return this.config
  }

  // ---- Workshop downloads (SteamCMD) and update checks ----

  async workshopDetails(ids: string[], force = false): Promise<Map<string, WorkshopDetails>> {
    const now = Date.now()
    const todo = ids.filter((id) => force || !this.details.has(id) || now - this.details.get(id)!.at > DETAILS_TTL)
    if (todo.length) {
      const fetched = await fetchDetails(todo)
      for (const id of todo) this.details.set(id, { at: now, d: fetched.get(id) ?? { workshopId: id, ok: false, title: id, size: 0, timeUpdated: 0 } })
    }
    return new Map(ids.filter((id) => this.details.has(id)).map((id) => [id, this.details.get(id)!.d]))
  }

  async lookupWorkshop(ids: string[]): Promise<WorkshopDetails[]> {
    return [...(await this.workshopDetails(ids)).values()]
  }

  /** Flattens a Workshop collection, following nested collections (each visited once, so loops can't recurse forever). */
  async workshopCollection(id: string): Promise<WorkshopCollection> {
    if (!/^\d+$/.test(id)) throw new Error('Not a valid Workshop ID')
    const seen = new Set<string>([id])
    const nested: string[] = []
    const items: string[] = []
    let level = [id]
    while (level.length) {
      const found = await fetchCollections(level)
      if (level[0] === id && !found.get(id)) throw new Error(`${id} is not a public Workshop collection (or it is empty)`)
      const next: string[] = []
      for (const cid of level) {
        const c = found.get(cid)
        if (!c) continue
        for (const x of c.items) if (!items.includes(x)) items.push(x)
        for (const x of c.collections)
          if (!seen.has(x)) {
            seen.add(x)
            nested.push(x)
            next.push(x)
          }
      }
      level = next
    }
    const details = await this.workshopDetails([id, ...items])
    return {
      workshopId: id,
      title: details.get(id)?.title ?? id,
      items: items.map((x) => details.get(x)!).filter(Boolean),
      nested,
    }
  }

  // Downloads always go to the local mods folder: RimWorld only loads Data/, Mods/ and Steam's own Workshop folder.
  downloadTarget(id: string): { dir: string; replace?: string } | string {
    const dir = this.settings.paths.localModsDir
    if (!dir) return 'Set the local mods folder in Settings first'
    const copies = this.mods.filter((m) => m.workshopId === id)
    if (copies.some((m) => m.source === 'workshop')) return 'Already subscribed in Steam, which keeps it up to date'
    const local = copies.find((m) => m.source === 'local')
    if (local && !inside(dir, local.path)) return `Installed outside the mods folder (${local.path})`
    return local ? { dir, replace: local.path } : { dir }
  }

  // A replaced copy goes to the Recycle Bin (or %APPDATA%/RimDeck/replaced-mods if that fails); it is never deleted outright.
  async retireMod(path: string) {
    if (!inside(this.settings.paths.localModsDir, path)) throw new Error(`Cannot replace ${path} because it is not inside the mods folder`)
    try {
      const { shell } = await import('electron')
      await shell.trashItem(path)
      return
    } catch {}
    const dest = join(this.file('replaced-mods'), `${basename(path)}-${Date.now()}`)
    await mkdir(this.file('replaced-mods'), { recursive: true })
    try {
      await rename(path, dest)
    } catch {
      await cp(path, dest, { recursive: true })
      await rm(path, { recursive: true, force: true })
    }
  }

  async getDownloads(): Promise<DownloadsState> {
    this.downloads.targetDir = this.settings.paths.localModsDir
    this.downloads.steamcmdInstalled = await this.steamcmd.installed()
    return this.downloads.state()
  }

  async queueDownloads(ids: string[]): Promise<DownloadsState> {
    const wanted = [...new Set(ids.filter((id) => /^\d+$/.test(id)))]
    if (!wanted.length) throw new Error('No Workshop IDs provided')
    const details = await this.workshopDetails(wanted)
    this.downloads.targetDir = this.settings.paths.localModsDir
    this.downloads.add(
      wanted.map((id) => details.get(id)!),
      (id) => this.mods.some((m) => m.workshopId === id && m.source === 'local'),
    )
    return this.downloads.state()
  }

  async cancelDownloads(ids?: string[]): Promise<DownloadsState> {
    this.downloads.cancel(ids)
    return this.downloads.state()
  }

  async clearDownloads(): Promise<DownloadsState> {
    this.downloads.clear()
    return this.downloads.state()
  }

  // Steam account for SteamCMD. The password is only passed through to SteamCMD and never stored or logged;
  // progress (prompts, errors) arrives as 'downloads' events.
  async steamLogin(user: string, password?: string | null): Promise<DownloadsState> {
    void this.downloads.login(user, password || null, null)
    return this.downloads.state()
  }

  async steamLoginCode(code: string): Promise<DownloadsState> {
    void this.downloads.login(this.downloads.account.user, null, code.trim())
    return this.downloads.state()
  }

  async steamLoginCancel(): Promise<DownloadsState> {
    this.downloads.cancelLogin()
    return this.downloads.state()
  }

  async steamLogout(): Promise<DownloadsState> {
    await this.downloads.logout()
    return this.downloads.state()
  }

  async steamUseAccount(on: boolean): Promise<DownloadsState> {
    await this.downloads.useAccount(on)
    return this.downloads.state()
  }

  async installSteamcmd(): Promise<DownloadsState> {
    if (this.downloads.running) return this.downloads.state()
    this.downloads.running = true
    try {
      await this.downloads.ensureSteamcmd()
    } finally {
      this.downloads.running = false
      this.downloads.phase = 'idle'
      this.downloads.changed(true)
    }
    void this.downloads.pump() // anything queued while SteamCMD was installing
    return this.downloads.state()
  }

  async checkUpdates(force = false): Promise<UpdateReport> {
    const r = this.updateReport
    if (!force && r && !r.error && Date.now() - r.checkedAt < DETAILS_TTL) return r
    this.updateReport = await this.buildUpdateReport(force)
    return this.updateReport
  }

  async buildUpdateReport(force: boolean): Promise<UpdateReport> {
    const mods = this.mods.filter((m) => m.workshopId && (m.source === 'local' || m.source === 'workshop'))
    const report: UpdateReport = { checkedAt: Date.now(), checked: mods.length, updates: [], removed: [] }
    let details: Map<string, WorkshopDetails>
    try {
      details = await this.workshopDetails(mods.map((m) => m.workshopId!), force)
    } catch (e: any) {
      return { ...report, error: `Could not reach Steam: ${e?.message ?? e}` }
    }
    const acf = await readWorkshopAcf(this.settings.paths.workshopDir)
    for (const m of mods) {
      const id = m.workshopId!
      const d = details.get(id)
      if (!d) continue
      if (!d.ok) {
        report.removed.push(id)
        continue
      }
      // Steam's manifest (or our own record) names the exact upload on disk; otherwise guess from file dates.
      const steam = m.source === 'workshop' ? acf.get(id) : undefined
      const ours = m.source === 'local' ? this.downloadRecords[id] : undefined
      let basis: WorkshopUpdate['basis'] = 'mtime'
      let localTime: number
      if (steam?.timeUpdated) {
        basis = 'steam'
        localTime = steam.timeUpdated
      } else if (ours?.timeUpdated && ours.path.toLowerCase() === m.path.toLowerCase()) {
        basis = 'rimdeck'
        localTime = ours.timeUpdated
      } else localTime = Math.floor((await newestMtime(m.path)) / 1000)
      // Copies are written after their upload, so file dates get an hour of slack.
      if (d.timeUpdated > localTime + (basis === 'mtime' ? 3600 : 0))
        report.updates.push({ workshopId: id, packageId: m.packageId, name: m.name, source: m.source as 'local' | 'workshop', path: m.path, localTime, remoteTime: d.timeUpdated, basis })
    }
    report.updates.sort((a, b) => b.remoteTime - a.remoteTime)
    return report
  }

  // Live updates: mod folders (Steam downloads, manual installs) and external ModsConfig edits.
  startWatching() {
    for (const w of this.watchers) w.close()
    this.watchers = []
    const p = this.settings.paths
    const queueRescan = () => {
      if (this.rescanTimer) clearTimeout(this.rescanTimer)
      this.rescanTimer = setTimeout(() => this.rescan().catch(() => {}), 1200)
    }
    for (const dir of [p.localModsDir, p.workshopDir]) {
      if (!dir) continue
      try {
        this.watchers.push(
          watch(dir, { recursive: true }, (_ev, name) => {
            if (!name) return queueRescan()
            const n = String(name).replace(/\\/g, '/')
            const depth = n.split('/').length
            if (depth <= 1 || /about\/about\.xml$|loadfolders\.xml$/i.test(n)) queueRescan()
          }),
        )
      } catch {}
    }
    if (p.configDir) {
      try {
        this.watchers.push(
          watch(p.configDir, async (_ev, name) => {
            if (String(name).toLowerCase() !== 'modsconfig.xml') return
            try {
              const st = await stat(join(p.configDir, 'ModsConfig.xml'))
              if (Math.abs(st.mtimeMs - this.lastWrite) < 5 || st.mtimeMs === this.config?.mtime) return
              this.emit({ type: 'config-changed', external: true })
            } catch {}
          }),
        )
      } catch {}
    }
  }

  dispose() {
    for (const w of this.watchers) w.close()
    this.steamcmd.cancel()
  }
}

export type ServiceMethod = Exclude<
  keyof Service,
  | 'dataDir' | 'emit' | 'settings' | 'user' | 'mods' | 'config' | 'gameVersion' | 'scanMs' | 'pathProblems' | 'lastWrite' | 'rules' | 'asmCache' | 'watchers' | 'rescanTimer' | 'gameRunning' | 'xmlCache' | 'defCache' | 'saving'
  | 'steamcmd' | 'downloads' | 'downloadRecords' | 'details' | 'updateReport'
>
