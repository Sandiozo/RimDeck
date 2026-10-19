import { create } from 'zustand'
import type {
  ChangeReport,
  XmlReport,
  AppState,
  DownloadsState,
  Fix,
  Issue,
  ModAssemblyReport,
  ModCategory,
  ModInfo,
  ModMeta,
  RulesBundle,
  Settings,
  UpdateReport,
  UserData,
  WorkshopCollection,
} from '@shared/types'
import { sortMods, type SortResult } from '@shared/sort'
import { validate } from '@shared/validate'
import { baseId, isTop, OFFICIAL_ORDER, resolver } from '@shared/graph'
import { api } from './api'

export type View = 'mods' | 'problems' | 'saves' | 'logs' | 'textures' | 'search' | 'performance' | 'research' | 'items' | 'modsettings' | 'lists' | 'downloads' | 'settings'

export interface Toast {
  id: number
  kind: 'ok' | 'error' | 'info'
  text: string
}

export interface Bisect {
  original: string[]
  suspects: string[]
  testing: string[]
  step: number
  culprit?: string
}

interface Derived {
  installed: Map<string, ModInfo[]>
  activeMap: Map<string, ModInfo>
  issues: Issue[]
  issuesByPid: Map<string, Issue[]>
  dependents: Map<string, string[]> // packageId -> active mods that depend on it
}

interface Store extends Derived {
  app: AppState | null
  rules: RulesBundle | null
  loading: string | null
  active: string[]
  saved: string[]
  past: string[][]
  future: string[][]
  selection: Set<string>
  anchor: string | null
  focus: string | null
  view: View
  palette: boolean
  sortPreview: SortResult | null
  externalChange: boolean
  toasts: Toast[]
  analysis: Record<string, ModAssemblyReport>
  xml: XmlReport | null
  changes: ChangeReport | null
  searchQuery: string
  filterPush: { q: string; at: number } | null // asks both mod lists to apply this filter
  settingsEditor: string | null // path of the settings file being edited
  bisect: Bisect | null
  downloads: DownloadsState | null
  updates: UpdateReport | null
  checkingUpdates: boolean
  collection: WorkshopCollection | null
  collectionApplied: string[] | null // workshop ids that were installed when the collection was last applied
  collectionFocus: number // bumped to focus the collection input

  boot(): Promise<void>
  reload(): Promise<void>
  setView(v: View): void
  refreshXml(): Promise<void>
  refreshChanges(): Promise<void>
  openSearch(q: string): void
  setPalette(open: boolean): void
  setActive(ids: string[], record?: boolean): void
  /** Recomputes installed mods, problems and dependents after the app state or rules change. */
  rederive(): void
  /** Selects a mod, opens the Mods view and scrolls it into view. */
  showMod(pid: string): void
  undo(): void
  redo(): void
  activate(ids: string[], at?: number): void
  deactivate(ids: string[]): void
  move(ids: string[], to: number): void
  nudge(delta: number): void
  select(id: string, mode?: 'single' | 'toggle' | 'range', list?: string[]): void
  clearSelection(): void
  setFocus(id: string | null): void
  previewSort(): void
  applySort(): void
  closeSort(): void
  /** True when ModsConfig.xml was written. */
  save(): Promise<boolean>
  revert(): void
  acceptExternal(reload: boolean): Promise<void>
  applyFix(fix: Fix): void
  fixAll(): void
  updateSettings(patch: Partial<Settings>): Promise<void>
  setMeta(pid: string, meta: ModMeta | null): Promise<void>
  setUser(patch: Partial<UserData>): Promise<void>
  analyze(pids: string[]): Promise<void>
  toast(kind: Toast['kind'], text: string): void
  launch(): Promise<void>
  startBisect(): void
  bisectAnswer(stillBroken: boolean): void
  stopBisect(restore: boolean): void
  download(workshopIds: string[]): Promise<void>
  setDownloads(state: DownloadsState): void
  checkUpdates(force?: boolean): Promise<void>
  loadCollection(id: string): Promise<void>
  applyCollection(): void
  closeCollection(): void
}

let toastId = 0

// XML analysis feeds validation/sorting; kept here so every derive() call sees the latest report.
let xmlReport: XmlReport | null = null
let xmlFor = ''
let xmlTimer: ReturnType<typeof setTimeout> | null = null

function derive(app: AppState | null, rules: RulesBundle | null, active: string[]): Derived {
  const installed = new Map<string, ModInfo[]>()
  const activeMap = new Map<string, ModInfo>()
  if (!app) return { installed, activeMap, issues: [], issuesByPid: new Map(), dependents: new Map() }
  // Local copies win over Workshop ones when both claim the same packageId.
  const rank = { core: 0, dlc: 1, local: 2, workshop: 3 }
  for (const m of app.mods) installed.set(m.packageId, [...(installed.get(m.packageId) ?? []), m])
  for (const list of installed.values()) list.sort((a, b) => rank[a.source] - rank[b.source])
  for (const id of active) {
    const m = installed.get(id)?.[0]
    if (m) activeMap.set(id, m)
  }
  const issues = validate({
    order: active,
    active: activeMap,
    installed,
    community: app.settings.useCommunityRules ? rules?.community : undefined,
    user: app.user.userRules,
    replacements: rules?.replacements,
    gameMajor: app.gameMajor,
    ignored: new Set(app.user.ignored),
    depsAsLoadAfter: app.settings.depsAsLoadAfter,
    xml: xmlReport,
  })
  const issuesByPid = new Map<string, Issue[]>()
  for (const i of issues) issuesByPid.set(i.packageId, [...(issuesByPid.get(i.packageId) ?? []), i])
  const dependents = new Map<string, string[]>()
  const resolve = resolver(installed.keys())
  for (const [id, m] of activeMap)
    for (const d of m.dependencies) {
      const t = resolve(d.packageId) ?? d.packageId
      dependents.set(t, [...(dependents.get(t) ?? []), id])
    }
  return { installed, activeMap, issues, issuesByPid, dependents }
}

function same(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

export const useStore = create<Store>((set, get) => {
  const commit = (active: string[], extra: Partial<Store> = {}, record = true) => {
    const s = get()
    if (same(active, s.active) && !Object.keys(extra).length) return
    set({
      ...extra,
      active,
      past: record ? [...s.past.slice(-99), s.active] : s.past,
      future: record ? [] : s.future,
      ...derive(s.app, s.rules, active),
    })
    scheduleXml(active)
  }

  // Activating or deactivating changes which mods' XML matters; reordering alone doesn't.
  const scheduleXml = (active: string[]) => {
    if (xmlFor && [...active].sort().join('|') !== xmlFor) {
      if (xmlTimer) clearTimeout(xmlTimer)
      xmlTimer = setTimeout(() => void get().refreshXml(), 800)
    }
  }

  const sortOptions = () => {
    const s = get()
    const settings = s.app!.settings
    return {
      mode: settings.sortMode,
      depsAsLoadAfter: settings.depsAsLoadAfter,
      community: settings.useCommunityRules ? s.rules?.community : undefined,
      user: s.app!.user.userRules,
      inferred: xmlReport?.inferred,
      categoryOf: (id: string) => categoryOf(s, id),
      nameOf: (id: string) => s.activeMap.get(id)?.name ?? s.installed.get(id)?.[0]?.name ?? id,
    }
  }

  // Dependencies a mod pulls in when activated (recursive, installed only).
  const withDeps = (ids: string[], have: string[] = get().active): string[] => {
    const s = get()
    const resolve = resolver(s.installed.keys())
    const out: string[] = []
    const seen = new Set(have)
    const visit = (id: string) => {
      if (seen.has(id)) return
      seen.add(id)
      const m = s.installed.get(id)?.[0]
      for (const d of m?.dependencies ?? []) {
        const r = [d.packageId, ...(d.alternatives ?? [])].map(resolve).find(Boolean)
        if (r && !have.includes(r)) visit(r)
      }
      out.push(id)
    }
    ids.forEach(visit)
    return out
  }

  return {
    app: null,
    rules: null,
    loading: 'Scanning mods…',
    active: [],
    saved: [],
    past: [],
    future: [],
    selection: new Set(),
    anchor: null,
    focus: null,
    view: 'mods',
    palette: false,
    sortPreview: null,
    externalChange: false,
    toasts: [],
    analysis: {},
    xml: null,
    changes: null,
    searchQuery: '',
    filterPush: null,
    settingsEditor: null,
    bisect: null,
    downloads: null,
    updates: null,
    checkingUpdates: false,
    collection: null,
    collectionApplied: null,
    collectionFocus: 0,
    installed: new Map(),
    activeMap: new Map(),
    issues: [],
    issuesByPid: new Map(),
    dependents: new Map(),

    async boot() {
      const app = await api.getState()
      const active = app.config?.activeMods ?? []
      set({ app, active, saved: active, loading: null, ...derive(app, null, active) })
      api
        .getRules()
        .then((rules) => set({ rules, ...derive(get().app, rules, get().active) }))
        .catch(() => get().toast('error', 'Could not load community rules'))
      api.getDownloads().then((downloads) => set({ downloads }))
      void get().checkUpdates()
      void get().refreshXml()
      void get().refreshChanges()
    },

    async refreshXml() {
      const s = get()
      try {
        const report = await api.xmlReport(s.active)
        xmlReport = report
        xmlFor = [...s.active].sort().join('|')
        const now = get()
        set({ xml: report, ...derive(now.app, now.rules, now.active) })
      } catch {}
    },

    async refreshChanges() {
      try {
        set({ changes: await api.changes() })
      } catch {}
    },

    openSearch(q) {
      set({ searchQuery: q, view: 'search' })
    },

    async reload() {
      const app = await api.refresh()
      const s = get()
      set({ app, ...derive(app, s.rules, s.active) })
      void get().refreshXml()
      void get().refreshChanges()
    },

    setView: (view) => set({ view }),
    setPalette: (palette) => set({ palette }),

    setActive: (ids, record = true) => commit([...new Set(ids)], {}, record),

    rederive() {
      const s = get()
      set(derive(s.app, s.rules, s.active))
    },

    showMod(pid) {
      set({ view: 'mods', selection: new Set([pid]), anchor: pid, focus: pid })
      setTimeout(() => document.querySelector(`[data-pid="${CSS.escape(pid)}"]`)?.scrollIntoView({ block: 'center' }), 30)
    },

    undo() {
      const s = get()
      const prev = s.past[s.past.length - 1]
      if (!prev) return
      set({ past: s.past.slice(0, -1), future: [s.active, ...s.future], active: prev, ...derive(s.app, s.rules, prev) })
      scheduleXml(prev)
    },
    redo() {
      const s = get()
      const next = s.future[0]
      if (!next) return
      set({ future: s.future.slice(1), past: [...s.past, s.active], active: next, ...derive(s.app, s.rules, next) })
      scheduleXml(next)
    },

    activate(ids, at) {
      const s = get()
      const fresh = ids.filter((id) => !s.active.includes(id))
      const add = withDeps(fresh)
      if (!add.length) return
      const deps = add.length - fresh.length
      const list = [...s.active]
      list.splice(at ?? list.length, 0, ...add)
      commit(list)
      if (deps > 0) get().toast('info', `Also activated ${deps} required ${deps === 1 ? 'mod' : 'mods'}`)
    },

    deactivate(ids) {
      const s = get()
      const drop = new Set(ids.filter((id) => id !== 'ludeon.rimworld'))
      commit(s.active.filter((id) => !drop.has(id)), { selection: new Set() })
    },

    move(ids, to) {
      const s = get()
      const moving = s.active.filter((id) => ids.includes(id))
      const before = s.active.slice(0, to).filter((id) => !ids.includes(id)).length
      const rest = s.active.filter((id) => !ids.includes(id))
      rest.splice(before, 0, ...moving)
      commit(rest)
    },

    nudge(delta) {
      const s = get()
      const sel = s.active.filter((id) => s.selection.has(id))
      if (!sel.length) return
      const first = s.active.indexOf(sel[0])
      const target = Math.max(0, Math.min(s.active.length - sel.length, first + delta))
      const rest = s.active.filter((id) => !s.selection.has(id))
      rest.splice(target, 0, ...sel)
      commit(rest)
    },

    select(id, mode = 'single', list = []) {
      const s = get()
      if (mode === 'toggle') {
        const next = new Set(s.selection)
        next.has(id) ? next.delete(id) : next.add(id)
        set({ selection: next, anchor: id, focus: id })
      } else if (mode === 'range' && s.anchor && list.includes(s.anchor)) {
        const a = list.indexOf(s.anchor)
        const b = list.indexOf(id)
        set({ selection: new Set(list.slice(Math.min(a, b), Math.max(a, b) + 1)), focus: id })
      } else set({ selection: new Set([id]), anchor: id, focus: id })
    },
    clearSelection: () => set({ selection: new Set() }),
    setFocus: (focus) => set({ focus }),

    previewSort() {
      const s = get()
      if (!s.app) return
      const result = sortMods(s.active, s.activeMap.size === s.active.length ? s.activeMap : fillMissing(s), sortOptions())
      set({ sortPreview: result })
    },
    applySort() {
      const p = get().sortPreview
      if (p) commit(p.order, { sortPreview: null })
      get().toast('ok', p?.moves.length ? `Load order sorted: ${p.moves.length} mods moved` : 'Load order is already sorted')
    },
    closeSort: () => set({ sortPreview: null }),

    async save() {
      const s = get()
      try {
        const { config, user } = await api.saveModsConfig(s.active)
        set({ saved: s.active, externalChange: false, app: s.app && { ...s.app, config, user } })
        get().toast('ok', `Saved ${s.active.length} mods to ModsConfig.xml`)
        return true
      } catch (e: any) {
        get().toast('error', `Save failed: ${e.message}`)
        return false
      }
    },
    revert() {
      commit(get().saved)
    },

    async acceptExternal(reload) {
      if (!reload) return set({ externalChange: false })
      const config = await api.reloadConfig()
      const s = get()
      const active = config?.activeMods ?? []
      set({ externalChange: false, saved: active, app: s.app && { ...s.app, config } })
      commit(active)
    },

    applyFix(fix) {
      const s = get()
      if (fix.type === 'activate') s.activate(fix.packageIds)
      else if (fix.type === 'deactivate') s.deactivate(fix.packageIds)
      else if (fix.type === 'sort') s.previewSort()
      else if (fix.type === 'url') api.openUrl(fix.url)
      else if (fix.type === 'download') void s.download(fix.workshopIds)
    },

    fixAll() {
      const s = get()
      const toActivate = new Set<string>()
      for (const i of s.issues) for (const f of i.fixes) if (f.fix.type === 'activate') f.fix.packageIds.forEach((p) => toActivate.add(p))
      if (toActivate.size) s.activate([...toActivate])
      get().previewSort()
    },

    async updateSettings(patch) {
      const app = await api.setSettings(patch)
      const s = get()
      set({ app, ...derive(app, s.rules, s.active) })
      if (patch.paths) {
        const active = app.config?.activeMods ?? []
        set({ saved: active, past: [], future: [] })
        commit(active, {}, false)
      }
    },

    async setMeta(pid, meta) {
      const user = await api.setModMeta(pid, meta)
      const s = get()
      if (s.app) set({ app: { ...s.app, user } })
    },

    async setUser(patch) {
      const user = await api.setUser(patch)
      const s = get()
      if (s.app) {
        const app = { ...s.app, user }
        set({ app, ...derive(app, s.rules, s.active) })
      }
    },

    async analyze(pids) {
      const todo = pids.filter((p) => !get().analysis[p])
      if (!todo.length) return
      const reports = await api.analyze(todo)
      const analysis = { ...get().analysis }
      for (const r of reports) analysis[r.packageId] = r
      set({ analysis })
    },

    toast(kind, text) {
      const id = ++toastId
      set({ toasts: [...get().toasts, { id, kind, text }] })
      setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 6000 : 3200)
    },

    async launch() {
      const s = get()
      // Never start the game with a load order that failed to save.
      if (!same(s.active, s.saved) && !(await s.save())) return
      const r = await api.launch()
      get().toast(r.ok ? 'ok' : 'error', r.message)
    },

    startBisect() {
      const s = get()
      const keep = new Set([...OFFICIAL_ORDER, 'brrainz.harmony'])
      const suspects = s.active.filter((id) => !keep.has(baseId(id)) && s.activeMap.get(id)?.source !== 'dlc')
      if (suspects.length < 2) return s.toast('info', 'Not enough active mods to search')
      const bisect: Bisect = { original: s.active, suspects, testing: [], step: 1 }
      set({ bisect })
      applyBisectStep()
    },

    bisectAnswer(stillBroken) {
      const b = get().bisect
      if (!b) return
      const suspects = stillBroken ? b.testing : b.suspects.filter((id) => !b.testing.includes(id))
      if (suspects.length <= 1) {
        set({ bisect: { ...b, suspects, culprit: suspects[0] } })
        commit(b.original)
        void get().save()
        return
      }
      set({ bisect: { ...b, suspects, step: b.step + 1 } })
      applyBisectStep()
    },

    stopBisect(restore) {
      const b = get().bisect
      set({ bisect: null })
      if (b && restore && !b.culprit) {
        commit(b.original)
        void get().save()
      }
    },

    async download(workshopIds) {
      try {
        const downloads = await api.queueDownloads(workshopIds)
        set({ downloads })
        const jobs = downloads.jobs.filter((j) => workshopIds.includes(j.workshopId))
        const failed = jobs.filter((j) => j.status === 'failed')
        if (failed.length === jobs.length && failed.length) get().toast('error', `${failed[0].title}: ${failed[0].message}`)
        else get().toast('info', jobs.length === 1 ? `Downloading ${jobs[0].title}` : `Downloading ${jobs.length} mods`)
      } catch (e: any) {
        get().toast('error', `Download failed: ${e.message}`)
      }
    },

    setDownloads(downloads) {
      const was = get().downloads?.phase
      set({ downloads })
      // The service re-checks installed copies when a queue finishes; pick up its report.
      if (was && was !== 'idle' && downloads.phase === 'idle') {
        void get().checkUpdates()
        if (get().collectionApplied) get().toast('info', 'Downloads finished. Apply the collection again in Downloads to include the new mods.')
      }
    },

    async checkUpdates(force = false) {
      set({ checkingUpdates: true })
      try {
        set({ updates: await api.checkUpdates(force) })
      } catch (e: any) {
        set({ updates: { checkedAt: Date.now(), checked: 0, updates: [], removed: [], error: e.message } })
      } finally {
        set({ checkingUpdates: false })
      }
    },

    async loadCollection(id) {
      try {
        set({ collection: await api.workshopCollection(id), collectionApplied: null })
      } catch (e: any) {
        get().toast('error', `Could not load collection: ${e.message}`)
      }
    },

    // Core, the active DLCs and Harmony stay on top; the collection's installed mods (plus what they require) follow, then the sorter takes over.
    applyCollection() {
      const s = get()
      const c = s.collection
      if (!c || !s.app) return
      const byWorkshop = new Map<string, string>()
      for (const src of ['local', 'workshop'])
        for (const m of s.app.mods) if (m.source === src && m.workshopId && !byWorkshop.has(m.workshopId)) byWorkshop.set(m.workshopId, m.packageId)
      const base = OFFICIAL_ORDER.filter((id) => id === 'ludeon.rimworld' || s.active.includes(id))
      const harmony = [...s.installed.keys()].find((id) => baseId(id) === 'brrainz.harmony')
      if (harmony) base.push(harmony)
      const ids = c.items.map((i) => byWorkshop.get(i.workshopId)).filter((id): id is string => !!id && !base.includes(id))
      commit([...base, ...withDeps(ids, base)])
      set({ collectionApplied: c.items.filter((i) => byWorkshop.has(i.workshopId)).map((i) => i.workshopId) })
      get().toast('ok', `Loaded ${ids.length} mods from “${c.title}”. Review the sort, then save.`)
      get().previewSort()
    },

    closeCollection: () => set({ collection: null, collectionApplied: null }),
  }

  // Keep the first half of the suspects (plus whatever they depend on), disable the rest, and save.
  function applyBisectStep() {
    const s = get()
    const b = s.bisect!
    const half = b.suspects.slice(0, Math.ceil(b.suspects.length / 2))
    const resolve = resolver(b.original)
    const needed = new Set(half)
    const stack = [...half]
    while (stack.length) {
      const m = s.installed.get(stack.pop()!)?.[0]
      for (const d of m?.dependencies ?? []) {
        const r = resolve(d.packageId)
        if (r && !needed.has(r)) {
          needed.add(r)
          stack.push(r)
        }
      }
    }
    const suspectSet = new Set(b.suspects)
    const list = b.original.filter((id) => !suspectSet.has(id) || needed.has(id))
    set({ bisect: { ...b, testing: half } })
    commit(list)
    void get().save()
  }
})

function fillMissing(s: Store) {
  // Mods that are listed but not installed still take part in sorting as plain nodes.
  const map = new Map(s.activeMap)
  for (const id of s.active)
    if (!map.has(id))
      map.set(id, {
        uid: 'missing:' + id,
        packageId: id,
        packageIdRaw: id,
        name: id,
        authors: [],
        description: '',
        supportedVersions: [],
        source: 'local',
        path: '',
        folder: '',
        dependencies: [],
        loadAfter: [],
        loadBefore: [],
        forceLoadAfter: [],
        forceLoadBefore: [],
        incompatibleWith: [],
        contentDirs: [],
        hasAssemblies: false,
        hasDefs: false,
        hasPatches: false,
        hasTextures: false,
        assemblies: [],
        category: 'content',
        mtime: 0,
        added: 0,
      })
  return map
}

export const isDirty = (s: Store) => !same(s.active, s.saved)

/** User override, then "load top" rules (they behave like loaders), then the scanner's guess. */
export function categoryOf(s: Pick<Store, 'app' | 'rules' | 'installed'>, pid: string): ModCategory {
  const m = s.installed.get(pid)?.[0]
  const override = s.app?.user.meta[pid]?.category
  if (override) return override
  if (m?.category !== 'game' && isTop(pid, m, s.app?.settings.useCommunityRules ? s.rules?.community : undefined, s.app?.user.userRules)) return 'loader'
  return m?.category ?? 'content'
}
