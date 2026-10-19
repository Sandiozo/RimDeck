// Types shared by the main process (scanner, IO) and the renderer (UI, live validation).

export type ModSource = 'core' | 'dlc' | 'local' | 'workshop'

export type ModCategory =
  | 'loader'
  | 'game'
  | 'library'
  | 'content'
  | 'utility'
  | 'performance'
  | 'textures'
  | 'patch'

export interface ModDep {
  packageId: string // lowercased
  alternatives?: string[]
  name?: string
  workshopId?: string
  url?: string
}

export interface ModInfo {
  uid: string // stable unique key: `${source}:${folder}`
  packageId: string // lowercased, may carry RimWorld's `_steam` suffix for duplicates
  packageIdRaw: string
  name: string
  authors: string[]
  description: string
  url?: string
  modVersion?: string
  supportedVersions: string[]
  source: ModSource
  path: string
  folder: string
  workshopId?: string
  previewPath?: string
  iconPath?: string
  dependencies: ModDep[]
  loadAfter: string[]
  loadBefore: string[]
  forceLoadAfter: string[]
  forceLoadBefore: string[]
  incompatibleWith: string[]
  contentDirs: string[] // folder names that load for the current game version (before IfModActive checks)
  dirConditions?: Record<string, DirCondition[]> // folders that only load when other mods are (not) active
  hasAssemblies: boolean
  hasDefs: boolean
  hasPatches: boolean
  hasTextures: boolean
  assemblies: string[] // absolute dll paths that load for the current version
  category: ModCategory
  mtime: number // ms, newest of About.xml / folder
  added: number // ms, when the mod folder was created (install time)
  aboutError?: string
}

export interface CommunityRule {
  loadAfter?: Record<string, { name?: string[]; comment?: string[] }>
  loadBefore?: Record<string, { name?: string[]; comment?: string[] }>
  incompatibleWith?: Record<string, { name?: string[]; comment?: string[] }>
  loadTop?: { value: boolean }
  loadBottom?: { value: boolean }
}

export type RuleMap = Record<string, CommunityRule> // keyed by lowercased packageId

export interface Replacement {
  oldWorkshopId: string
  oldName: string
  oldAuthor: string
  oldPackageId: string
  newWorkshopId: string
  newName: string
  newAuthor: string
  newPackageId: string
  oldVersions: string[]
  newVersions: string[]
}

export interface RulesBundle {
  community: RuleMap
  replacements: Replacement[]
  fetchedAt: number
  source: string
}

export interface Paths {
  gameDir: string
  configDir: string
  localModsDir: string
  workshopDir: string
}

export type SortMode = 'grouped' | 'minimal' | 'alphabetical'

export type ThemeMode = 'dark' | 'light' | 'system'

export interface Settings {
  paths: Paths
  sortMode: SortMode
  launchArgs: string
  launchViaSteam: boolean
  backupSaveOnLaunch: boolean
  depsAsLoadAfter: boolean
  useCommunityRules: boolean
  accent: string
  theme: ThemeMode
  firstRunDone: boolean
  targetVersion: string // '' = the installed game's version; otherwise check mods against this one
  installs: GameInstall[]
  currentInstall: string
}

// One RimWorld installation with its own folders and launch options (e.g. a 1.6 copy next to 1.7).
export interface GameInstall {
  id: string
  name: string
  paths: Paths
  launchArgs: string
  dataFolder?: string // used with -savedatafolder so saves/config/ModsConfig stay separate
}

export interface InstallSummary extends GameInstall {
  version: string
  current: boolean
  problems: string[]
}

export interface ModMeta {
  tags?: string[]
  color?: string
  notes?: string
  category?: ModCategory // user override
}

export interface ModList {
  name: string
  ids: string[]
  createdAt: number
  note?: string
}

export interface UserData {
  meta: Record<string, ModMeta> // keyed by packageId
  userRules: RuleMap
  lists: ModList[] // legacy: migrated into profiles on start
  ignored: string[] // packageIds whose warnings are muted
  profiles?: Profile[]
  currentProfile?: string
}

// A named setup: which game install (and so which game version) to use, and which mods in which order.
export interface Profile {
  id: string
  name: string
  installId: string
  mods: string[] // packageIds in load order
  createdAt: number
  updatedAt: number
}

export interface ModsConfig {
  version: string
  activeMods: string[]
  knownExpansions: string[]
  mtime: number
}

export interface AppState {
  settings: Settings
  gameVersion: string // e.g. "1.7.4982 rev1280"
  gameMajor: string // version mods are checked against (target version setting, else installed game)
  installedMajor: string // what the installed game actually is
  mods: ModInfo[]
  config: ModsConfig | null
  user: UserData
  scanMs: number
  pathProblems: string[]
}

export interface SaveSummary {
  path: string
  name: string
  mtime: number
  size: number
  gameVersion: string
  modIds: string[]
  modNames: string[]
  modSteamIds: string[]
}

export interface LogEntry {
  key: string
  level: 'error' | 'warning' | 'exception'
  message: string
  stack: string
  count: number
  firstLine: number
  mods: string[] // packageIds attributed
}

export interface LogReport {
  path: string
  mtime: number
  lines: number
  entries: LogEntry[]
  gameVersion?: string
  loadedMods?: number
}

export type PatchKind = 'prefix' | 'postfix' | 'transpiler' | 'finalizer' | 'manual' | 'unknown'

export interface HarmonyPatch {
  targetType: string
  targetMember: string | null
  kind: PatchKind
  patchClass: string
}

export interface ModAssemblyReport {
  packageId: string
  dlls: { file: string; name: string; version: string; references: string[] }[]
  patches: HarmonyPatch[]
  namespaces: string[]
  usesHarmony: boolean
}

export type IssueKind =
  | 'missing-dep'
  | 'dep-order'
  | 'order'
  | 'incompatible'
  | 'version'
  | 'duplicate'
  | 'not-installed'
  | 'replacement'
  | 'cycle'
  | 'harmony'
  | 'about'
  | 'xml'

export type Fix =
  | { type: 'activate'; packageIds: string[] }
  | { type: 'deactivate'; packageIds: string[] }
  | { type: 'sort' }
  | { type: 'url'; url: string }
  | { type: 'download'; workshopIds: string[] }

export interface Issue {
  id: string
  packageId: string
  severity: 'error' | 'warning' | 'info'
  kind: IssueKind
  title: string
  detail?: string
  fixes: { label: string; fix: Fix }[]
}

export type AppEvent =
  | { type: 'update'; state: UpdateState }
  | { type: 'mods-changed' }
  | { type: 'config-changed'; external: boolean }
  | { type: 'game-exited' }
  | { type: 'log-changed' }
  | { type: 'downloads'; state: DownloadsState }

export type DownloadStatus = 'queued' | 'downloading' | 'installing' | 'done' | 'failed' | 'cancelled'

export interface DownloadJob {
  workshopId: string
  title: string
  size: number // bytes, 0 when unknown
  status: DownloadStatus
  message?: string
  update: boolean // replaces an installed local copy
  attempts: number
  addedAt: number
  finishedAt?: number
  path?: string // install folder once done
  needsLogin?: boolean // failed in a way that a Steam account owning RimWorld may fix
}

export interface SteamLoginState {
  phase: 'idle' | 'working' | 'need-password' | 'need-code' | 'confirm-mobile' | 'error'
  codeKind?: 'email' | '2fa'
  message?: string
}

// Only the username and whether SteamCMD holds a session are stored; the password never leaves memory.
export interface SteamAccount {
  user: string
  loggedIn: boolean
  useForDownloads: boolean // false = anonymous (default)
}

export interface DownloadsState {
  jobs: DownloadJob[]
  phase: 'idle' | 'installing-steamcmd' | 'downloading' | 'login'
  steamcmd: { installed: boolean; dir: string }
  targetDir: string // where finished mods go (the local mods folder)
  log: string[] // recent SteamCMD output
  account: SteamAccount
  login: SteamLoginState
}

export interface WorkshopDetails {
  workshopId: string
  ok: boolean // false when removed, private or not a RimWorld item
  title: string
  size: number
  timeUpdated: number // unix seconds
  previewUrl?: string
}

export interface WorkshopUpdate {
  workshopId: string
  packageId: string
  name: string
  source: 'local' | 'workshop'
  path: string
  localTime: number // unix seconds of the installed copy
  remoteTime: number // unix seconds of the newest Workshop upload
  basis: 'steam' | 'rimdeck' | 'mtime' // where localTime came from
}

export interface UpdateReport {
  checkedAt: number
  checked: number
  updates: WorkshopUpdate[]
  removed: string[] // workshop ids no longer available
  error?: string
}

export interface WorkshopCollection {
  workshopId: string
  title: string
  items: WorkshopDetails[] // every mod in it, nested collections flattened, author's order
  nested: string[] // ids of collections found inside it
}

export interface TextureConflict {
  key: string // path under Textures/, lowercase, no extension
  entries: { packageId: string; file: string; dds: boolean }[] // unordered; the winner is the last in load order
}

export interface TextureReport {
  conflicts: TextureConflict[]
  totals: Record<string, number> // packageId -> textures it ships
  textures: number
  scannedMods: number
  ms: number
}

export interface XmlConflict {
  kind: 'def' | 'patch'
  key: string // "ThingDef/Steel" or "Steel/statBases/MarketValue"
  mods: { packageId: string; file: string; line: number; op?: string }[] // unordered; the last loaded wins
}

export interface XmlReport {
  conflicts: XmlConflict[]
  inferred: RuleMap // load-after rules inferred from overrides between mods that reference each other
  vanillaOverrides: Record<string, number> // packageId -> vanilla/DLC defs it redefines
  files: number
  defs: number
  patches: number
  ms: number
}

export interface XmlSearchHit {
  packageId: string
  file: string
  line: number
  text: string
}

export interface XmlSearchResult {
  query: string
  defines: (XmlSearchHit & { key: string })[]
  patches: (XmlSearchHit & { op: string })[]
  hits: XmlSearchHit[]
  filesScanned: number
  truncated: boolean
  ms: number
}

export interface ChangeReport {
  since: number // when the game was last started
  source: 'rimdeck' | 'log' | 'none'
  updated: string[] // packageIds
  added: string[]
  removed: { packageId: string; name: string }[]
  activated: string[]
  deactivated: string[]
}

export interface SettingsNode {
  id: string
  tag: string
  attrs?: Record<string, string>
  text?: string // leaf nodes
  children?: SettingsNode[]
}

export interface SettingsFile {
  path: string
  name: string
  folder: string | null // null = no installed mod owns it
  className: string
  size: number
  mtime: number
  /** False for a mod whose settings were never saved; the file is created on the first save. */
  exists?: boolean
}

export interface SettingElem {
  type: 'bool' | 'int' | 'float' | 'string' | 'enum' | 'def' | 'other'
  options?: string[]
}

export interface SettingSchema {
  /** The element name in the settings file. */
  label: string
  type: 'bool' | 'int' | 'float' | 'string' | 'enum' | 'color' | 'intRange' | 'floatRange' | 'vector' | 'list' | 'dict' | 'group'
  /** The default as RimWorld writes it; null when the default is null. */
  def: string | null
  /** The default could not be read from the code. */
  defUnknown?: boolean
  options?: string[]
  /** List items, or dictionary values. */
  elem?: SettingElem
  /** Dictionary keys. */
  key?: SettingElem
  /** Settings inside a nested object or node. */
  children?: SettingSchema[]
  /** Label and tooltip from the mod's settings window. */
  title?: string
  tip?: string
  /** Slider limits from the mod's settings window. */
  min?: number
  max?: number
}

/** Settings a mod declares in code, read from its DLL. */
export interface SettingsSchema {
  settingsClass: string
  entries: SettingSchema[]
}

export interface DirCondition {
  any?: string[] // IfModActive / IfModActiveAny
  all?: string[] // IfModActiveAll
  none?: string[] // IfModNotActive
}

export interface ModCost {
  packageId: string
  textures: number
  textureBytes: number
  dds: number
  sounds: number
  soundBytes: number
  defs: number
  patches: number
  slowPatches: number
  dllBytes: number
  harmonyPatches: number
  score: number // relative estimated cost
}

export interface LoadReport {
  mods: ModCost[]
  startup?: {
    when: number // game start time of the logged session
    toMenu: number // ms from start to the main menu
    phases: { label: string; ms: number }[]
    saveLoad?: number // ms from loading a save to being in game
  }
  ms: number
}

export interface ResearchNode {
  defName: string
  label: string
  packageId: string // mod whose definition is used
  cost: number
  techLevel: string
  tab: string
  x: number
  y: number
  prerequisites: string[]
  hiddenPrerequisites: string[]
  description: string
  file: string
  patchedBy: string[] // mods whose patches changed it
}

export interface UnlockRef {
  type: string
  defName: string
  label: string
  packageId: string
}

export interface ResearchData {
  tabs: { defName: string; label: string }[]
  nodes: ResearchNode[]
  unlocks: Record<string, UnlockRef[]>
  ms: number
}

export interface ItemDef {
  defName: string
  label: string
  packageId: string
  value?: number
  mass?: number
  stack: number
  categories: string[]
  techLevel?: string
  description: string
  icon?: string // texture file on disk (vanilla textures live in game bundles, so none)
  file: string
}

export interface DefData {
  research: ResearchData
  items: ItemDef[]
}

export interface UpdateState {
  phase: 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'error'
  current: string
  version?: string
  percent?: number
  checkedAt?: number
  error?: string
}
