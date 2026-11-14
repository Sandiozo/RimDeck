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
import { baseId, depProviders, isTop, OFFICIAL_ORDER, resolver } from '@shared/graph'
import { api } from './api'
import { revealMod } from './reveal'

export type View = 'mods' | 'problems' | 'saves' | 'logs' | 'textures' | 'search' | 'performance' | 'research' | 'items' | 'modsettings' | 'lists' | 'downloads' | 'settings'

export interface Toast {
  id: number
  kind: 'ok' | 'error' | 'info'
  text: string
}

export interface Bisect {
  original: string[]
  suspects: string[]
  testing: string[] // every suspect that is turned on in this step
  step: number
  culprit?: string // set when the search is done; if several suspects are left they need each other and can't be tested apart
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
  launching: boolean // true while Play or Continue is saving and starting the game
  collection: WorkshopCollection | null
  collectionApplied: string[] | null // workshop ids that were installed when the collection was last applied
  collectionFocus: number // bumped to focus the collection input

  boot(): Promise<void>
  /** Rescans the mod folders. */
  reload(): Promise<void>
  /** Picks up the main process's state without rescanning (for when it has just rescanned). */
  refreshState(): Promise<void>
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
  /** Starts the game and opens this save (default: the newest) through the Continue helper mod. */
  continueGame(saveFile?: string): Promise<void>
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
// The helper mod behind the Continue button (see src/main/core/continue.ts).
const CONTINUE_ID = 'rimdeck.continue'

let xmlFor = '' // the active set the current report was made for
let xmlStarted = false
let xmlSeq = 0 // only the newest request may set the report
let xmlTimer: ReturnType<typeof setTimeout> | null = null

// The list the open sort preview was worked out from.
let sortedFrom: string[] = []

// Mod meta edits go to the main process one at a time; it replaces a mod's whole entry on each call.
let metaQueue: Promise<void> = Promise.resolve()
let metaPending = 0

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
    // Same list: no undo step (it would look like Ctrl+Z does nothing).
    if (same(active, s.active)) {
      if (Object.keys(extra).length) set(extra)
      return
    }
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
    if (xmlStarted && [...active].sort().join('|') !== xmlFor) {
      if (xmlTimer) clearTimeout(xmlTimer)
      xmlTimer = setTimeout(() => void get().refreshXml(), 800)
    }
  }

  const takeState = (app: AppState) => {
    const s = get()
    set({ app, ...derive(app, s.rules, s.active) })
    void get().refreshXml()
    void get().refreshChanges()
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
    const inList = resolver(have)
    const batch = new Set(ids)
    const out: string[] = []
    const seen = new Set(have)
    const visit = (id: string) => {
      if (seen.has(id)) return
      seen.add(id)
      const m = s.installed.get(id)?.[0]
      for (const d of m?.dependencies ?? []) {
        const candidates = [d.packageId, ...(d.alternatives ?? [])]
        // Already met by the named mod or an alternative in the list: nothing to add.
        if (candidates.some((c) => inList(c))) continue
        // Prefer a candidate that is being turned on anyway, then the first installed one.
        const found = candidates.map(resolve)
        const r = found.find((x) => x && (seen.has(x) || batch.has(x))) ?? found.find(Boolean)
        if (r) visit(r)
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
    launching: false,
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
        .catch((e) => get().toast('error', `Could not load community rules: ${e.message}`))
      api
        .getDownloads()
        .then((downloads) => set({ downloads }))
        .catch((e) => get().toast('error', `Could not read the download queue: ${e.message}`))
      void get().checkUpdates()
      void get().refreshXml()
      void get().refreshChanges()
    },

    async refreshXml() {
      const seq = ++xmlSeq
      xmlStarted = true
      const active = get().active
      try {
        const report = await api.xmlReport(active)
        if (seq !== xmlSeq) return // a newer request is on its way
        xmlReport = report
        xmlFor = [...active].sort().join('|')
        const now = get()
        set({ xml: report, ...derive(now.app, now.rules, now.active) })
      } catch {
        // Keep the last good report; xmlFor is unchanged, so the next change of active mods tries again.
      }
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
      takeState(await api.refresh())
    },

    async refreshState() {
      takeState(await api.getState())
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
      // The mod lists render only the rows near their view, so they scroll to the mod themselves.
      setTimeout(() => revealMod(pid) || document.querySelector(`[data-pid="${CSS.escape(pid)}"]`)?.scrollIntoView({ block: 'center' }), 30)
    },

    // Not while the sort preview is open: Apply would then use a sort of the old list.
    undo() {
      const s = get()
      const prev = s.past[s.past.length - 1]
      if (!prev || s.sortPreview) return
      set({ past: s.past.slice(0, -1), future: [s.active, ...s.future], active: prev, ...derive(s.app, s.rules, prev) })
      scheduleXml(prev)
    },
    redo() {
      const s = get()
      const next = s.future[0]
      if (!next || s.sortPreview) return
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
      sortedFrom = s.active
      set({ sortPreview: result })
    },
    applySort() {
      const p = get().sortPreview
      if (!p) return
      // The list changed after the preview was made: show a fresh preview instead of applying a stale one.
      if (!same(sortedFrom, get().active)) {
        get().previewSort()
        return get().toast('info', 'The load order changed, so the sort was worked out again. Check it and apply.')
      }
      commit(p.order, { sortPreview: null })
      get().toast('ok', p.moves.length ? `Load order sorted: ${p.moves.length} mods moved` : 'Load order is already sorted')
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

    // Either way `saved` becomes what is on disk now, so "Keep current" shows the list as unsaved and Save writes it.
    async acceptExternal(reload) {
      try {
        const config = await api.reloadConfig()
        const s = get()
        const onDisk = config?.activeMods ?? []
        set({ externalChange: false, saved: onDisk, app: s.app && { ...s.app, config } })
        if (reload) commit(onDisk)
      } catch (e: any) {
        get().toast('error', `Could not read ModsConfig.xml: ${e.message}`)
      }
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

    // Shown at once, so the next edit builds on this one, then sent in order. The main process replaces the
    // mod's whole entry, so two quick edits sent side by side could otherwise undo each other.
    async setMeta(pid, meta) {
      const s = get()
      if (!s.app) return
      const value = meta && Object.values(meta).some((v) => (Array.isArray(v) ? v.length : v)) ? meta : null
      const all = { ...s.app.user.meta }
      if (value) all[pid] = value
      else delete all[pid]
      set({ app: { ...s.app, user: { ...s.app.user, meta: all } } })
      metaPending++
      const run = metaQueue.then(async () => {
        try {
          const user = await api.setModMeta(pid, value)
          // Only the last answer is complete; earlier ones lack the edits still waiting.
          const now = get()
          if (metaPending === 1 && now.app) set({ app: { ...now.app, user } })
        } catch (e: any) {
          get().toast('error', `Could not save mod details: ${e.message}`)
          // Show what is really stored again, unless more edits are waiting to be sent.
          const state = metaPending === 1 ? await api.getState().catch(() => null) : null
          const now = get()
          if (state && metaPending === 1 && now.app) set({ app: { ...now.app, user: state.user } })
        } finally {
          metaPending--
        }
      })
      metaQueue = run
      return run
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
      if (get().launching) return // a second click or F5 while the first start is still going
      set({ launching: true })
      try {
        const s = get()
        // Never start the game with a load order that failed to save.
        if (!same(s.active, s.saved) && !(await s.save())) return
        const r = await api.launch()
        get().toast(r.ok ? 'ok' : 'error', r.message)
      } catch (e: any) {
        get().toast('error', `Could not start RimWorld: ${e.message}`)
      } finally {
        set({ launching: false })
      }
    },

    async continueGame(saveFile) {
      if (get().launching) return
      set({ launching: true })
      try {
        const file = saveFile ?? (await api.latestSave())?.file
        if (!file) return get().toast('error', 'No saves found for this install')
        const { created, state } = await api.prepareContinue()
        if (created && state) {
          set({ app: state })
          get().rederive()
        }
        // The helper has to be active to open the save; it waits at the end of the load order.
        if (!get().active.includes(CONTINUE_ID)) commit([...get().active, CONTINUE_ID])
        const s = get()
        if (!same(s.active, s.saved) && !(await s.save())) return
        const r = await api.launch(file)
        const name = file.split(/[\\/]/).pop()!.replace(/\.rws$/i, '')
        get().toast(r.ok ? 'ok' : 'error', r.ok ? `Starting RimWorld; “${name}” opens once the game has loaded` : r.message)
      } catch (e: any) {
        get().toast('error', `Could not start RimWorld: ${e.message}`)
      } finally {
        set({ launching: false })
      }
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

  // Keep about half of the suspects on (plus the suspects they depend on), turn the other suspects off, and save.
  // `testing` lists every suspect that is on, so the answer splits the suspects correctly.
  function applyBisectStep() {
    const s = get()
    const b = s.bisect!
    const suspectSet = new Set(b.suspects)
    const resolve = resolver(b.original)
    // The suspects that have to be on for `ids` to load. Any one provider of a dependency will do, and
    // mods that are not suspects are always on.
    const withNeeds = (ids: string[]) => {
      const on = new Set(ids)
      const stack = [...ids]
      while (stack.length) {
        for (const d of s.installed.get(stack.pop()!)?.[0]?.dependencies ?? []) {
          const providers = depProviders(d, resolve)
          if (!providers.length || providers.some((p) => on.has(p) || !suspectSet.has(p))) continue
          on.add(providers[0])
          stack.push(providers[0])
        }
      }
      return on
    }
    const n = b.suspects.length
    const target = Math.ceil(n / 2)
    let testing = new Set<string>()
    for (const id of b.suspects) {
      if (testing.size >= target) break
      if (testing.has(id)) continue
      const next = withNeeds([...testing, id])
      if (next.size <= target) testing = next
    }
    // Every suspect needs more than half of the others: take the smallest group that still leaves some out.
    if (!testing.size)
      for (const id of b.suspects) {
        const next = withNeeds([id])
        if (next.size < n && (!testing.size || next.size < testing.size)) testing = next
      }
    if (!testing.size) {
      // Each suspect needs all the others, so they can't be tested apart: report them together.
      set({ bisect: { ...b, testing: [], culprit: b.suspects[0] } })
      commit(b.original)
      void get().save()
      return
    }
    const list = b.original.filter((id) => !suspectSet.has(id) || testing.has(id))
    set({ bisect: { ...b, testing: b.suspects.filter((id) => testing.has(id)) } })
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
