import { spawn } from 'node:child_process'
import { watch, type FSWatcher } from 'node:fs'
import { cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
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
  SettingsSchema,
  SettingSchema,
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
import type { AssemblyInfo, Md } from './core/harmony.ts'
import { findPlayerLog, type Attribution } from './core/logs.ts'
import { backupModList, listBackups, readModListFile, readModsConfig, serializeModsConfig, writeModsConfig } from './core/modsconfig.ts'
import { defaultConfigDir, detectPaths, gameRoot, majorOf, readGameVersion, validatePaths } from './core/paths.ts'
import { importFromRimSort, lowerRuleKeys } from './core/rimsort.ts'
import { loadRules } from './core/rulesdb.ts'
import { backupNewestSave, listSaves, readSaveMeta } from './core/saves.ts'
import { isGameRunning, matchSettingsFiles, moveToBackup, readSettings, resetSettings, writeSettings } from './core/modsettings.ts'
import { cachedAssemblySettings, enumMembersIn, openForEnums, readAssemblySettings, type AssemblySettings } from './core/settingschema.ts'
import { isSlowXpath, score } from './core/loadtime.ts'
import { ensurePicksMod, listPicks, pickTexture, PICKS_ID, unpickTexture } from './core/texturepicks.ts'
import { clearContinueRequest, CONTINUE_DLL, ensureContinueMod, latestSave, writeContinueRequest } from './core/continue.ts'
import { steamWorkshop, type SteamJobResult } from './core/steamclient.ts'
import { buildXmlReport, searchXml, type ModXml } from './core/xmlindex.ts'
import { DownloadQueue, SteamCmd } from './core/steamcmd.ts'
import { exists, readJson, writeJson } from './core/store.ts'
import { fetchCollections, fetchDetails, newestMtime, readWorkshopAcf } from './core/workshop.ts'
import { InProcess } from './workers/pool.ts'
import type { Offload } from './workers/protocol.ts'
import { tasks, type Tasks } from './workers/tasks.ts'

interface PlaySnapshot {
  time: number
  installed: Record<string, { name: string; mtime: number }>
  active: string[]
}

const OLD_ACCENTS = ['#7c8cff', '#b58cff']

const DEFAULT_SETTINGS: Settings = {
  paths: { gameDir: '', configDir: '', localModsDir: '', workshopDir: '' },
  sortMode: 'grouped',
  launchArgs: '',
  launchViaSteam: false,
  backupSaveOnLaunch: true,
  depsAsLoadAfter: true,
  useCommunityRules: true,
  accent: '#d9792b',
  theme: 'dark',
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

// Heavy read-only calls the interface may make several times at once (start-up, several panels open).
// See Service.call.
const SHARED = new Set(['getRules', 'checkUpdates', 'xmlReport', 'modSettings', 'textures', 'defData', 'loadReport', 'listSaves', 'listInstalls', 'changes'])

export class Service {
  dataDir: string
  emit: (e: AppEvent) => void
  settings: Settings = structuredClone(DEFAULT_SETTINGS)
  user: UserData = structuredClone(DEFAULT_USER)
  mods: ModInfo[] = []
  config: ModsConfig | null = null
  gameVersion = ''
  scanMs = 0
  pathProblems: string[] = []
  lastWrite = 0
  // The watcher can fire before a save has finished; it waits for this so RimDeck's own writes never look external.
  configWrite: Promise<unknown> = Promise.resolve()
  rules: RulesBundle | null = null
  asmCache = new Map<string, { mtime: number; info: AssemblyInfo | null }>()
  watchers: FSWatcher[] = []
  rescanTimer: NodeJS.Timeout | null = null
  // What the mod folders looked like at the last scan; see modsFingerprint.
  scannedFingerprint = ''
  steamcmd: SteamCmd
  downloads: DownloadQueue
  downloadRecords: DownloadRecords = {}
  details = new Map<string, { at: number; d: WorkshopDetails }>()
  updateReport: UpdateReport | null = null
  // Bumped whenever what the shared calls read changes (a rescan, a save, new settings).
  gen = 0
  inflight = new Map<string, Promise<unknown>>()
  laterRescan: NodeJS.Timeout | null = null
  // Where the heavy parsing runs: worker threads in the app (see index.ts), this thread otherwise.
  offload: Offload<Tasks>

  constructor(dataDir: string, emit: (e: AppEvent) => void, opts: { offload?: Offload<Tasks> } = {}) {
    this.dataDir = dataDir
    this.emit = emit
    this.offload = opts.offload ?? new InProcess(tasks)
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
        const epoch = this.installEpoch
        if (!this.updateReport) return
        const report = await this.buildUpdateReport(false)
        if (epoch === this.installEpoch) this.updateReport = report
      },
    })
  }

  /**
   * Runs an API method for the interface. An identical shared call made while one is running waits for
   * that one instead of repeating the work; calls made after a change (see `gen`) always start afresh.
   */
  call(method: string, args: unknown[]): Promise<unknown> {
    const run = () => (this as any)[method](...args) as Promise<unknown>
    if (!SHARED.has(method)) return run()
    const key = `${method}|${this.gen}|${JSON.stringify(args)}`
    let p = this.inflight.get(key)
    if (!p) {
      p = run().finally(() => this.inflight.delete(key))
      this.inflight.set(key, p)
    }
    return p
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
    this.clearInstallCaches()
    await this.rescan(false)
    this.startWatching()
    return this.state()
  }

  async addInstall(opts: { name: string; gameDir: string; dataFolder?: string }): Promise<InstallSummary[]> {
    // On macOS the RimWorld folder holds RimWorldMac.app, which has Data and Mods inside.
    opts = { ...opts, gameDir: await gameRoot(opts.gameDir) }
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

  // Reports built from one install's mods (or one set of folders) must not be shown for another.
  // A report still being built when this runs is not kept either (see installEpoch).
  installEpoch = 0
  clearInstallCaches() {
    this.installEpoch++
    this.updateReport = null
    this.defCache = null
  }

  async init() {
    // A settings or user file that exists but can't be read stops start-up (shown as "Could not start")
    // rather than starting empty and saving over it; ready() in index.ts tries again on the next call.
    this.settings = await readJson(this.file('settings.json'), DEFAULT_SETTINGS)
    this.settings.paths = { ...DEFAULT_SETTINGS.paths, ...this.settings.paths }
    // The first releases defaulted to a purple accent; move those installs to the current default.
    if (OLD_ACCENTS.includes(this.settings.accent)) this.settings.accent = DEFAULT_SETTINGS.accent
    this.user = await readJson(this.file('user.json'), DEFAULT_USER)
    // Rules imported from RimSort by older versions kept the case of the ids they point to, so they never matched.
    this.user.userRules = lowerRuleKeys(this.user.userRules)
    // Only a hint for update checks: without it they fall back to file dates.
    this.downloadRecords = await readJson<DownloadRecords>(this.file('downloads.json'), {}).catch(() => ({}))
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
    await this.syncProfile()
    if (!this.settings.firstRunDone) {
      await this.importRimSort()
      this.settings.firstRunDone = true
      await this.saveSettings()
    }
    this.startWatching()
  }

  // settings.json and user.json are each written one write at a time, so rapid edits (e.g. coloring many
  // mods) never interleave; each write saves the latest state.
  settingsSaving: Promise<void> = Promise.resolve()
  saveSettings() {
    this.gen++
    const write = this.settingsSaving.then(() => writeJson(this.file('settings.json'), this.settings))
    this.settingsSaving = write.catch(() => {})
    return write
  }

  saving: Promise<void> = Promise.resolve()
  saveUser() {
    const write = this.saving.then(() => writeJson(this.file('user.json'), this.user))
    this.saving = write.catch(() => {})
    return write
  }

  // One scan at a time, so the mods and the config always come from the same scan. A request made while
  // one runs queues one more scan, which later requests share.
  scanRunning: Promise<void> = Promise.resolve()
  scanQueued: { emit: boolean; done: Promise<void> } | null = null
  rescan(emit = true): Promise<void> {
    if (this.scanQueued) {
      this.scanQueued.emit ||= emit
      return this.scanQueued.done
    }
    const next = { emit, done: Promise.resolve() }
    next.done = this.scanRunning.then(() => {
      this.scanQueued = null
      return this.scan(next.emit)
    })
    this.scanQueued = next
    this.scanRunning = next.done.catch(() => {})
    return next.done
  }

  async scan(emit: boolean) {
    const t = performance.now()
    const p = this.settings.paths
    const [version, problems, config] = await Promise.all([readGameVersion(p.gameDir), validatePaths(p), readModsConfig(p.configDir)])
    const mods = await this.offload.run('scanAll', [p, majorOf(version)])
    this.gameVersion = version
    this.pathProblems = problems
    this.config = config
    this.mods = mods
    this.gen++
    this.scanMs = Math.round(performance.now() - t)
    this.scannedFingerprint = await this.modsFingerprint()
    if (emit) this.emit({ type: 'mods-changed' })
  }

  // Mod folder names plus the file times of each mod's About.xml and LoadFolders.xml: everything a
  // rescan would pick up. Windows can report a file as changed when it is only read (last-access
  // times), so the watcher compares this before rescanning instead of trusting the event.
  async modsFingerprint(): Promise<string> {
    const p = this.settings.paths
    const parts: string[] = []
    const time = (f: string) => stat(f).then((st) => st.mtimeMs, () => 0)
    const mods = this.mods.filter((m) => m.source === 'local' || m.source === 'workshop')
    const known = new Set(mods.map((m) => m.path))
    // A folder that wasn't a mod at the last scan (still downloading or unzipping) counts once its About.xml appears.
    const aboutTime = async (dir: string) => {
      const about = (await readdir(dir).catch(() => [] as string[])).find((n) => n.toLowerCase() === 'about')
      const file = about && (await readdir(join(dir, about)).catch(() => [] as string[])).find((n) => n.toLowerCase() === 'about.xml')
      return about && file ? time(join(dir, about, file)) : 0
    }
    for (const dir of [p.localModsDir, p.workshopDir]) {
      if (!dir) continue
      const names = (await readdir(dir).catch(() => [] as string[])).sort()
      parts.push(`${dir}:${names.join('|')}`)
      const pending = names.map((n) => join(dir, n)).filter((f) => !known.has(f))
      parts.push(...(await Promise.all(pending.map(async (f) => `${f}:${await aboutTime(f)}`))))
    }
    const times = await Promise.all(mods.map(async (m) => `${m.path}:${await time(join(m.path, 'About', 'About.xml'))},${await time(join(m.path, 'LoadFolders.xml'))}`))
    return parts.concat(times).join('\n')
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
    known.delete('ludeon.rimworld')
    // The official order first; expansions RimDeck doesn't know yet (newer DLC) follow and are kept too.
    const official: readonly string[] = OFFICIAL_ORDER
    const knownExpansions = [...official.filter((id) => known.has(id)), ...[...known].filter((id) => !official.includes(id))]
    const write = writeModsConfig(dir, this.instFile('backups'), {
      version: this.config?.version || this.gameVersion,
      activeMods,
      knownExpansions,
    }).then((r) => {
      this.lastWrite = r.mtime
      return r
    })
    this.configWrite = write.catch(() => {})
    const { backup } = await write
    this.config = await readModsConfig(dir)
    this.gen++
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
    // If ModsConfig.xml can't be read now, this starts empty and syncProfile fills it once it can.
    const profiles: Profile[] = [{ id: 'p-default', name: 'Default', installId: install, mods: [...(this.config?.activeMods ?? [])], createdAt: now, updatedAt: now }]
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
    // ModsConfig.xml may have changed outside RimDeck since it was loaded; the profile being left keeps
    // that newest list, so switching back later doesn't bring back an older one.
    const onDisk = await readModsConfig(this.settings.paths.configDir)
    if (onDisk) {
      this.config = onDisk
      this.gen++
      await this.syncProfile()
    }
    if (p.installId !== this.settings.currentInstall) await this.switchInstall(p.installId)
    this.user.currentProfile = id
    await this.saveUser()
    if (this.settings.paths.configDir) await this.saveModsConfig(p.mods.length ? p.mods : ['ludeon.rimworld'])
    return this.state()
  }

  // ModsConfig.xml is the live list of the current profile, and it can change outside RimDeck (the game,
  // another tool). When the two differ the profile takes the file's list, which is the one on screen; its
  // previous list is kept among the ModsConfig.xml backups in case the file was reset rather than edited.
  async syncProfile() {
    const p = this.currentProfile()
    const mods = this.config?.activeMods
    if (!p || !mods || p.installId !== this.settings.currentInstall) return
    if (p.mods.length === mods.length && p.mods.every((id, i) => id === mods[i])) return
    if (p.mods.length) {
      try {
        await backupModList(this.instFile('backups'), { version: this.config!.version || this.gameVersion, activeMods: p.mods, knownExpansions: this.config!.knownExpansions })
      } catch (e) {
        // Without that copy the profile keeps its list; ModsConfig.xml itself is backed up before any write.
        console.warn(`[rimdeck] profile list not updated from ModsConfig.xml: ${(e as Error).message}`)
        return
      }
    }
    p.mods = [...mods]
    p.updatedAt = Date.now()
    await this.saveUser()
  }

  async reloadConfig(): Promise<ModsConfig | null> {
    this.config = await readModsConfig(this.settings.paths.configDir)
    this.gen++
    return this.config
  }

  async setSettings(patch: Partial<Settings>): Promise<AppState> {
    if (patch.paths?.gameDir) patch = { ...patch, paths: { ...patch.paths, gameDir: await gameRoot(patch.paths.gameDir) } }
    const pathsChanged = patch.paths && JSON.stringify(patch.paths) !== JSON.stringify(this.settings.paths)
    this.settings = { ...this.settings, ...patch, paths: { ...this.settings.paths, ...patch.paths } }
    this.syncCurrentInstall()
    await this.saveSettings()
    if (pathsChanged) {
      this.clearInstallCaches()
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

  async analyzeMod(m: ModInfo): Promise<ModAssemblyReport> {
    const report: ModAssemblyReport = { packageId: m.packageId, dlls: [], patches: [], namespaces: [], usesHarmony: false }
    for (const dll of m.assemblies) {
      const cached = this.asmCache.get(dll)
      const info = cached && cached.mtime === m.mtime ? cached.info : await this.offload.run('readAssembly', [dll])
      if (cached?.info !== info || cached?.mtime !== m.mtime) this.asmCache.set(dll, { mtime: m.mtime, info })
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
    return Promise.all(this.mods.filter((m) => want.has(m.packageId)).map((m) => this.analyzeMod(m)))
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
    // On the worker that runs defData, which has read the same texture folders already (see workers/tasks.ts).
    return this.offload.run('textureReport', [this.resolveMods(packageIds)], { key: 'defs' })
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
        const data = await this.offload.run('indexModXml', [m, dirs])
        // Like defData: a mod with files that could not be read is read again next time instead of keeping a partial index.
        if (data.unreadable) {
          console.warn(`[rimdeck] ${m.packageId}: ${data.unreadable} XML file(s) could not be read`)
          this.xmlCache.delete(m.path)
        } else this.xmlCache.set(m.path, { key, data })
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
    // File sizes for every mod in one job, with one key: the worker keeps them for the next report.
    const [media, harmony] = await Promise.all([
      this.offload.run('mediaStats', [mods.map((m) => ({ mod: m, dirs: effectiveDirs(m, (p) => active.has(p)) }))], { key: 'media' }),
      Promise.all(mods.map(async (m) => (m.hasAssemblies ? (await this.analyzeMod(m)).patches.length : 0))),
    ])
    const costs = mods.map((m, i) => {
      const x = xml[i]
      const base = {
        ...media[i],
        defs: x.defs.length,
        patches: x.patches.length,
        slowPatches: x.patches.filter((p) => isSlowXpath(p.xpath)).length,
        harmonyPatches: harmony[i],
      }
      return { packageId: m.packageId, ...base, score: score(base) } as ModCost
    })
    const log = await findPlayerLog(this.settings.paths.configDir)
    const startup = log ? await this.offload.run('startupFromLog', [log]) : undefined
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
    if (done.size) {
      if (this.laterRescan) clearTimeout(this.laterRescan)
      this.laterRescan = setTimeout(() => {
        this.laterRescan = null
        this.rescan().catch(() => {})
      }, 6000)
    }
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
    const epoch = this.installEpoch
    const indexes = await this.xmlIndexes(mods)
    // Always the same worker, which keeps the files it parsed for the next order (see core/defdata.ts).
    const data = await this.offload.run('defData', [mods, indexes.map((x) => x.files)], { key: 'defs' })
    // Not kept when some XML could not be read, so the next call tries again.
    if (epoch === this.installEpoch && !indexes.some((x) => x.unreadable)) this.defCache = { key, data }
    return data
  }

  // Searches the Defs and Patches of the given mods plus the game itself.
  async searchXml(query: string, packageIds: string[]): Promise<XmlSearchResult> {
    const game = this.mods.filter((m) => m.source === 'core' || m.source === 'dlc').map((m) => m.packageId)
    const mods = this.resolveMods([...new Set([...game, ...packageIds])])
    return searchXml(query, mods, await this.xmlIndexes(mods), 500, (...args) => this.offload.run('searchFiles', args))
  }

  async readLog(): Promise<LogReport | null> {
    const file = await findPlayerLog(this.settings.paths.configDir)
    if (!file) return null
    const active = new Set(this.config?.activeMods ?? [])
    const mods = this.mods.filter((m) => active.has(m.packageId))
    const a: Attribution = { namespaces: new Map(), packageIds: new Set(), names: new Map() }
    // DLLs are read side by side (in workers); namespaces still go to the first mod in load order.
    const reports = await Promise.all(mods.map((m) => (m.source === 'core' || m.source === 'dlc' || m.packageId === 'brrainz.harmony' ? null : this.analyzeMod(m))))
    mods.forEach((m, i) => {
      a.packageIds.add(m.packageId)
      a.names.set(m.name.toLowerCase(), m.packageId)
      for (const ns of reports[i]?.namespaces ?? []) if (!a.namespaces.has(ns)) a.namespaces.set(ns, m.packageId)
    })
    return this.offload.run('parsePlayerLog', [file, a])
  }

  // Mod settings live in Config/Mod_<folder>_<Class>.xml; only files directly in that folder may be touched.
  settingsPath(path: string) {
    // With no config folder set, relative() would measure from the working folder instead.
    if (!this.settings.paths.configDir) throw new Error('Config folder is not set')
    const rel = relative(this.settings.paths.configDir, path)
    if (!rel || rel.includes('..') || /[\\/]/.test(rel) || isAbsolute(rel) || !/^Mod_.+\.xml$/i.test(rel)) throw new Error('Not a mod settings file')
    return path
  }

  async modSettings(): Promise<SettingsFile[]> {
    const mods = this.mods.filter((m) => m.source === 'local' || m.source === 'workshop')
    const configDir = this.settings.paths.configDir
    const files = await matchSettingsFiles(configDir, mods.map((m) => m.folder))
    if (!configDir) return files
    // Mods whose settings were never changed have no file yet; list them so they can be edited too.
    const have = new Set(files.map((f) => f.name.toLowerCase()))
    const order = new Map((this.config?.activeMods ?? []).map((id, i) => [id.toLowerCase(), i]))
    const candidates = new Map<string, { m: ModInfo; name: string; modClass: string; saved: boolean }[]>()
    for (const m of mods) {
      if (!m.assemblies.length) continue
      const info = await this.settingsInfo(m)
      for (const { modClass, settingsClass } of info.mods) {
        if (!info.schemas[settingsClass]?.length) continue
        const name = `Mod_${m.folder}_${modClass}.xml`
        const list = candidates.get(settingsClass) ?? []
        list.push({ m, name, modClass, saved: have.has(name.toLowerCase()) })
        candidates.set(settingsClass, list)
      }
    }
    // Some mods ship a copy of another mod's DLL. The game keeps one settings file per class,
    // owned by the copy that loads first, so only that one is offered.
    for (const list of candidates.values()) {
      if (list.some((c) => c.saved)) continue
      const rank = (c: { m: ModInfo }) => order.get(c.m.packageId.toLowerCase()) ?? Infinity
      const c = list.reduce((a, b) => (rank(b) < rank(a) ? b : a))
      if (have.has(c.name.toLowerCase())) continue
      have.add(c.name.toLowerCase())
      files.push({ path: join(configDir, c.name), name: c.name, folder: c.m.folder, className: c.modClass, size: 0, mtime: 0, exists: false })
    }
    return files
  }

  // Settings declared in a mod's code, merged over the DLLs that load for the current game version.
  async settingsInfo(m: ModInfo): Promise<AssemblySettings> {
    const out: AssemblySettings = { mods: [], schemas: {} }
    // Enums can come from the game or from another DLL of the same mod. Those are opened before
    // reading, and only when something isn't cached, so reading never waits on the disk.
    let sources: Md[] = []
    if (m.assemblies.some((dll) => cachedAssemblySettings(dll, m.mtime) === undefined)) {
      // 1.7 keeps the game code next to the executable; Unity versions keep it under *_Data/Managed.
      const g = this.settings.paths.gameDir
      const game = ['', 'RimWorldWin64_Data/Managed', 'RimWorldLinux_Data/Managed', 'Contents/Resources/Data/Managed'].map((d) => join(g, d, 'Assembly-CSharp.dll'))
      const opened = await Promise.all([...m.assemblies.map((f) => openForEnums(f)), ...game.map((f) => openForEnums(f, true))])
      sources = opened.filter((md): md is Md => !!md)
    }
    const resolveEnum = (name: string) => {
      for (const md of sources) {
        const r = enumMembersIn(md, name)
        if (r) return r
      }
      return null
    }
    for (const dll of m.assemblies) {
      const info = await readAssemblySettings(dll, m.mtime, resolveEnum)
      if (!info) continue
      out.mods.push(...info.mods)
      Object.assign(out.schemas, info.schemas)
    }
    return out
  }

  async modSettingsSchema(path: string): Promise<SettingsSchema | null> {
    const file = this.settingsPath(path)
    const name = basename(file).toLowerCase()
    const m = this.mods
      .filter((x) => (x.source === 'local' || x.source === 'workshop') && name.startsWith(`mod_${x.folder.toLowerCase()}_`))
      .sort((a, b) => b.folder.length - a.folder.length)[0]
    if (!m) return null
    const info = await this.settingsInfo(m)
    let cls: string | undefined
    try {
      cls = (await readSettings(file)).children?.find((c) => c.tag === 'ModSettings')?.attrs?.Class
    } catch {
      // not saved yet
    }
    if (!cls) {
      const modClass = name.slice(`mod_${m.folder.toLowerCase()}_`.length, -4)
      cls = info.mods.find((x) => x.modClass.toLowerCase() === modClass)?.settingsClass
    }
    const entries = cls ? info.schemas[cls] : undefined
    if (!cls || !entries) return null
    const keyed = await readKeyed(m)
    return { settingsClass: cls, entries: entries.map((e) => translateSchema(e, keyed)) }
  }

  async readModSettings(path: string): Promise<SettingsNode> {
    const file = this.settingsPath(path)
    try {
      return await readSettings(file)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      const schema = await this.modSettingsSchema(file)
      if (!schema) throw e
      // The same shape the game writes when every setting is at its default.
      return { id: '', tag: 'SettingsBlock', children: [{ id: '0/ModSettings', tag: 'ModSettings', attrs: { Class: schema.settingsClass }, text: '' }] }
    }
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
    this.gen++
  }

  // Compares against the latest of: RimDeck's last launch snapshot, or the game log's start time (game started elsewhere).
  async changes(): Promise<ChangeReport> {
    // Only read here, so a history that can't be read just means comparing against the game log.
    const history = await readJson<PlaySnapshot[]>(this.instFile('play-history.json'), []).catch(() => [] as PlaySnapshot[])
    const snap = history[history.length - 1]
    let logStart = 0
    const log = await findPlayerLog(this.settings.paths.configDir)
    if (log) {
      try {
        const fh = await open(log, 'r')
        const buf = Buffer.alloc(600)
        let bytesRead = 0
        try {
          bytesRead = (await fh.read(buf, 0, 600, 0)).bytesRead
        } finally {
          await fh.close()
        }
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

  /** The newest save, for the Continue button. */
  async latestSave() {
    return latestSave(this.settings.paths.configDir)
  }

  /** Installs the helper mod that opens a save on startup; the renderer activates it. */
  async prepareContinue(): Promise<{ created: boolean; state: AppState | null }> {
    const dir = this.settings.paths.localModsDir
    if (!dir) throw new Error('Set the local mods folder in Settings first')
    // The DLL ships in resources/helper (inside the asar in the installed app; readFile handles that).
    const { app } = await import('electron')
    const created = await ensureContinueMod(dir, ['1.4', '1.5', '1.6', '1.7'], join(app.getAppPath(), 'resources', 'helper', CONTINUE_DLL))
    if (created) await this.rescan(false)
    return { created, state: created ? this.state() : null }
  }

  // The executable's name differs between game versions and platforms.
  async gameExe(): Promise<string | null> {
    const dir = this.settings.paths.gameDir
    if (process.platform === 'darwin') {
      // The game folder is the app bundle; its executable is the one file in Contents/MacOS.
      const macos = join(dir, 'Contents', 'MacOS')
      const files = await readdir(macos).catch(() => [] as string[])
      const exe = files.find((f) => /rimworld/i.test(f)) ?? files[0]
      return exe ? join(macos, exe) : null
    }
    const names = process.platform === 'win32' ? ['RimWorldWin64.exe', 'RimWorld.exe', 'RimWorldWin.exe'] : ['RimWorldLinux', 'RimWorld', 'RimWorld.x86_64']
    for (const n of names) if (await exists(join(dir, n))) return join(dir, n)
    return null
  }

  // A double click or a repeated key press must not start the game twice.
  launchBusy = false
  launchedAt = 0

  /** Starts the game; with a save file, the Continue helper opens that save once loading is done. */
  async launch(continueSave?: string): Promise<{ ok: boolean; message: string }> {
    if (this.launchBusy || Date.now() - this.launchedAt < 5000) return { ok: false, message: 'RimWorld is already starting' }
    this.launchBusy = true
    try {
      const r = await this.startGame(continueSave)
      if (r.ok) this.launchedAt = Date.now()
      return r
    } finally {
      this.launchBusy = false
    }
  }

  async startGame(continueSave?: string): Promise<{ ok: boolean; message: string }> {
    const p = this.settings.paths
    await this.recordPlay().catch(() => {})
    if (this.settings.backupSaveOnLaunch) await backupNewestSave(p.configDir, this.instFile('save-backups'))
    if (continueSave) await writeContinueRequest(p.configDir, continueSave)
    else await clearContinueRequest(p.configDir)
    if (this.settings.launchViaSteam) {
      const { shell } = await import('electron')
      await shell.openExternal('steam://rungameid/294100' + (this.settings.launchArgs ? '//' + encodeURIComponent(this.settings.launchArgs) : ''))
      return { ok: true, message: 'Launching through Steam' }
    }
    const exe = await this.gameExe()
    if (!exe) {
      await clearContinueRequest(p.configDir)
      return { ok: false, message: `No RimWorld executable found in ${p.gameDir}` }
    }
    // Quote-aware so -savedatafolder="C:\My Games\RimWorld" stays one argument.
    const args = (this.settings.launchArgs.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((a) => a.replace(/"/g, ''))
    const child = spawn(exe, args, { cwd: p.gameDir, detached: true, stdio: 'ignore' })
    const started = await new Promise<string | null>((resolve) => {
      child.once('spawn', () => resolve(null))
      child.once('error', (e) => resolve(e.message))
    })
    if (started) {
      await clearContinueRequest(p.configDir)
      return { ok: false, message: `RimWorld could not be started: ${started}` }
    }
    child.on('exit', () => {
      void clearContinueRequest(p.configDir)
      this.emit({ type: 'game-exited' })
    })
    child.unref()
    return { ok: true, message: 'RimWorld started' }
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

  /** Flattens a Workshop collection, following nested collections (each visited once, so loops can't recurse forever). */
  async workshopCollection(id: string): Promise<WorkshopCollection> {
    if (!/^\d+$/.test(id)) throw new Error('Not a valid Workshop ID')
    const seen = new Set<string>([id])
    const nested: string[] = []
    const items: string[] = []
    const itemSet = new Set<string>()
    let level = [id]
    while (level.length) {
      const found = await fetchCollections(level)
      if (level[0] === id && !found.get(id)) throw new Error(`${id} is not a public Workshop collection (or it is empty)`)
      const next: string[] = []
      for (const cid of level) {
        const c = found.get(cid)
        if (!c) continue
        for (const x of c.items) if (!itemSet.has(x)) {
          itemSet.add(x)
          items.push(x)
        }
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
    const epoch = this.installEpoch
    const report = await this.buildUpdateReport(force)
    if (epoch === this.installEpoch) this.updateReport = report
    return report
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
      this.rescanTimer = setTimeout(async () => {
        try {
          if ((await this.modsFingerprint()) !== this.scannedFingerprint) await this.rescan()
        } catch {
          // a folder that disappeared mid-check; the next event tries again
        }
      }, 1200)
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
              await this.configWrite
              const st = await stat(join(p.configDir, 'ModsConfig.xml'))
              if (Math.abs(st.mtimeMs - this.lastWrite) < 5 || st.mtimeMs === this.config?.mtime) return
              this.emit({ type: 'config-changed', external: true })
            } catch {}
          }),
        )
      } catch {}
    }
    // A watched folder that is deleted or unplugged emits 'error'; without a listener that ends the app.
    for (const w of this.watchers) w.on('error', () => w.close())
  }

  dispose() {
    for (const w of this.watchers) w.close()
    this.watchers = []
    for (const t of [this.rescanTimer, this.laterRescan]) if (t) clearTimeout(t)
    this.rescanTimer = this.laterRescan = null
    this.steamcmd.cancel()
    void this.offload.close?.().catch(() => {})
  }
}

// The mod's English translations (Languages/English/Keyed), used for labels in its settings window.
const keyedCache = new Map<string, { mtime: number; map: Map<string, string> }>()

async function readKeyed(m: ModInfo): Promise<Map<string, string>> {
  const hit = keyedCache.get(m.path)
  if (hit && hit.mtime === m.mtime) return hit.map
  const map = new Map<string, string>()
  const files: string[] = []
  const collect = async (dir: string, depth: number) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.isDirectory() && depth < 3) await collect(join(dir, e.name), depth + 1)
      else if (e.isFile() && e.name.toLowerCase().endsWith('.xml')) files.push(join(dir, e.name))
    }
  }
  for (const d of new Set(['', ...m.contentDirs])) await collect(join(m.path, d, 'Languages', 'English', 'Keyed'), 0)
  for (const f of files) {
    try {
      const xml = await readFile(f, 'utf8')
      for (const [, key, text] of xml.matchAll(/<(?!LanguageData>)([A-Za-z_][\w.\-]*)>([\s\S]*?)<\/\1>/g)) {
        if (!map.has(key)) map.set(key, decodeXmlText(text))
      }
    } catch {
      // unreadable file
    }
  }
  keyedCache.set(m.path, { mtime: m.mtime, map })
  return map
}

function decodeXmlText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
    .replace(/\\n/g, '\n')
}

// Settings windows show translated text; keys without a translation are not shown.
function uiText(raw: string | undefined, keyed: Map<string, string>, title: boolean): string | undefined {
  if (!raw) return undefined
  let text = keyed.get(raw)
  if (text === undefined) {
    // Untranslated text is shown only when it reads like words, not like a key.
    if (!/\s/.test(raw) && !/^[A-Z][a-z]+$/.test(raw)) return undefined
    text = raw
  }
  text = text.replace(/<\/?(color|b|i|size)[^>]*>/gi, '').trim()
  // "Bleeding rate: {0:P0}/day" → "Bleeding rate"
  if (title) text = text.split(/\s*[:：]?\s*\{\d/)[0].replace(/[\s:：]+$/, '')
  else text = text.replace(/\{\d[^}]*\}/g, '…')
  return /\p{L}/u.test(text) ? text : undefined
}

function translateSchema(e: SettingSchema, keyed: Map<string, string>): SettingSchema {
  const out: SettingSchema = { ...e, title: uiText(e.title, keyed, true), tip: uiText(e.tip, keyed, false) }
  // A long "label" is an explanation drawn above the control; keep it as the tooltip.
  if (out.title && out.title.length > 70) {
    out.tip ??= out.title
    delete out.title
  }
  if (!out.title) delete out.title
  if (!out.tip || out.tip === out.title) delete out.tip
  if (e.children) out.children = e.children.map((c) => translateSchema(c, keyed))
  return out
}
