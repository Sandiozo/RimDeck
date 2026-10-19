import { useEffect, useState } from 'react'
import {
  ArrowDownUp,
  CircleAlert,
  Gamepad2,
  LayoutGrid,
  ListChecks,
  Play,
  Redo2,
  RefreshCw,
  Save,
  ScrollText,
  Search,
  Settings,
  Image as ImageIcon,
  FileSearch,
  Gauge,
  FlaskConical,
  Boxes,
  Undo2,
  Bug,
  Download,
  X,
} from 'lucide-react'
import { useStore, isDirty, type View } from './store'
import type { UpdateState } from '@shared/types'
import { isElectron, onEvent, api } from './api'
import { ModList } from './components/ModList'
import { Details } from './components/Details'
import { Palette, SortPreview, Toasts } from './components/Overlays'
import { ContextMenu } from './components/ContextMenu'
import { ProblemsView } from './views/Problems'
import { SavesView } from './views/Saves'
import { LogsView } from './views/Logs'
import { ListsView } from './views/Lists'
import { SettingsView } from './views/Settings'
import { DownloadsView } from './views/Downloads'
import { TexturesView } from './views/Textures'
import { SearchView } from './views/Search'
import { PerformanceView } from './views/Performance'
import { ResearchView } from './views/Research'
import { ItemsView } from './views/Items'
import { ChangesBanner } from './components/Changes'
import { SettingsEditor } from './components/SettingsEditor'
import { InstallSwitcher } from './components/Installs'

const NAV: [View, string, typeof LayoutGrid][] = [
  ['mods', 'Mods', LayoutGrid],
  ['problems', 'Problems', CircleAlert],
  ['saves', 'Saves', Gamepad2],
  ['logs', 'Game log', ScrollText],
  ['textures', 'Texture conflicts', ImageIcon],
  ['research', 'Research tree', FlaskConical],
  ['items', 'Items', Boxes],
  ['search', 'Search mod files', FileSearch],
  ['performance', 'Load time', Gauge],
  ['lists', 'Mod lists', ListChecks],
  ['downloads', 'Downloads & updates', Download],
]

export function App() {
  const s = useStore()
  const app = s.app
  const dirty = isDirty(s)

  useEffect(() => {
    s.boot().catch((e) => useStore.setState({ loading: `Could not start: ${e.message}` }))
    return onEvent((e) => {
      const st = useStore.getState()
      if (e.type === 'mods-changed') {
        st.reload()
        st.toast('info', 'Mod folders changed — list refreshed')
      } else if (e.type === 'config-changed' && e.external) useStore.setState({ externalChange: true })
      else if (e.type === 'game-exited') st.toast('info', 'RimWorld closed')
      else if (e.type === 'downloads') st.setDownloads(e.state)
    })
  }, [])

  // The installed app downloads updates in the background; offer a restart once one is ready.
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [updateDismissed, setUpdateDismissed] = useState(false)
  useEffect(() => {
    api.updateState().then(setUpdate, () => {})
    return onEvent((e) => e.type === 'update' && setUpdate(e.state))
  }, [])

  useEffect(() => {
    if (app?.settings.accent) document.documentElement.style.setProperty('--accent', app.settings.accent)
  }, [app?.settings.accent])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useStore.getState()
      const mod = e.ctrlKey || e.metaKey
      const typing = (e.target as HTMLElement).closest('input, textarea, select')
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        st.setPalette(!st.palette)
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        st.previewSort()
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        st.save()
      } else if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault()
        e.shiftKey ? st.redo() : st.undo()
      } else if (mod && e.key.toLowerCase() === 'y' && !typing) {
        e.preventDefault()
        st.redo()
      } else if (e.key === 'F5') {
        e.preventDefault()
        st.launch()
      } else if (e.key === 'Escape' && st.sortPreview) st.closeSort()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (isDirty(useStore.getState()) && !isElectron) e.preventDefault()
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  if (!app)
    return (
      <div className="splash">
        <div style={{ textAlign: 'center' }}>
          <div className="brand-mark" />
          {s.loading}
        </div>
      </div>
    )

  const errors = s.issues.filter((i) => i.severity === 'error').length
  const warnings = s.issues.filter((i) => i.severity === 'warning').length
  const pending = s.downloads?.jobs.filter((j) => j.status === 'queued' || j.status === 'downloading' || j.status === 'installing').length ?? 0
  const localUpdates = s.updates?.updates.filter((u) => u.source === 'local').length ?? 0

  return (
    <div className="app">
      <header className={'titlebar' + (isElectron ? '' : ' browser')}>
        <div className="brand">
          <span className="brand-mark" />
          RimDeck <small>{app.gameMajor}</small>
        </div>
        <InstallSwitcher />
        <button className="btn ghost icon" title="Undo (Ctrl Z)" disabled={!s.past.length} onClick={s.undo}>
          <Undo2 size={15} />
        </button>
        <button className="btn ghost icon" title="Redo (Ctrl Y)" disabled={!s.future.length} onClick={s.redo}>
          <Redo2 size={15} />
        </button>
        <div className="searchbox no-drag" onClick={() => s.setPalette(true)}>
          <Search size={14} />
          <span className="grow">Search mods & commands</span>
          <span className="kbd">Ctrl K</span>
        </div>
        <button className="btn" title="Auto-sort (Ctrl Shift S)" onClick={s.previewSort}>
          <ArrowDownUp size={14} /> Sort
        </button>
        <button className={'btn' + (dirty ? ' primary' : '')} title="Save to ModsConfig.xml (Ctrl S)" onClick={s.save} disabled={!dirty}>
          <Save size={14} /> Save{dirty && <span className="pip" />}
        </button>
        <button className="btn play" title="Save and launch RimWorld (F5)" onClick={s.launch}>
          <Play size={14} fill="currentColor" /> Play
        </button>
      </header>

      <nav className="rail">
        {NAV.map(([v, label, Icon]) => (
          <button key={v} className={'rail-btn' + (s.view === v ? ' active' : '')} title={label} onClick={() => s.setView(v)}>
            <Icon size={18} />
            {v === 'problems' && (errors || warnings) > 0 && <span className={'rail-badge' + (errors ? '' : ' warn')}>{errors || warnings}</span>}
            {v === 'downloads' && (pending || localUpdates) > 0 && <span className={'rail-badge' + (pending ? ' accent' : ' info')}>{pending || localUpdates}</span>}
          </button>
        ))}
        <span className="rail-spacer" />
        <button className="rail-btn" title="Rescan mod folders" onClick={() => s.reload().then(() => s.toast('ok', 'Rescanned'))}>
          <RefreshCw size={17} />
        </button>
        <button className={'rail-btn' + (s.view === 'settings' ? ' active' : '')} title="Settings" onClick={() => s.setView('settings')}>
          <Settings size={18} />
        </button>
      </nav>

      <main className="main">
        {app.pathProblems.length > 0 && (
          <div className="banner err">
            <CircleAlert size={15} color="var(--err)" />
            <span className="grow">{app.pathProblems[0]} Set your folders in Settings.</span>
            <button className="btn sm" onClick={() => s.setView('settings')}>
              Open settings
            </button>
          </div>
        )}
        {update?.phase === 'ready' && !updateDismissed && (
          <div className="banner accent">
            <Download size={15} color="var(--accent)" />
            <span className="grow">
              RimDeck {update.version} is ready. Restart to update{dirty ? ' (save your load order first)' : ''}, or it installs when you close RimDeck.
            </span>
            <button className="btn sm primary" disabled={dirty} onClick={() => api.updateInstall()}>
              Restart now
            </button>
            <button className="btn sm ghost icon" onClick={() => setUpdateDismissed(true)}>
              <X size={13} />
            </button>
          </div>
        )}
        {s.externalChange && (
          <div className="banner">
            <CircleAlert size={15} color="var(--warn)" />
            <span className="grow">ModsConfig.xml was changed outside RimDeck (probably by the game).</span>
            <button className="btn sm" onClick={() => s.acceptExternal(true)}>
              Load it
            </button>
            <button className="btn sm ghost" onClick={() => s.acceptExternal(false)}>
              Keep mine
            </button>
          </div>
        )}
        {s.bisect && <BisectBanner />}
        {s.view === 'mods' && <ChangesBanner onFilter={(q) => useStore.setState({ filterPush: { q, at: Date.now() } })} />}
        {s.view === 'mods' && (
          <div className="mods-view">
            <ModList kind="inactive" />
            <ModList kind="active" />
            <Details />
          </div>
        )}
        {s.view === 'problems' && <ProblemsView />}
        {s.view === 'saves' && <SavesView />}
        {s.view === 'logs' && <LogsView />}
        {s.view === 'textures' && <TexturesView />}
        {s.view === 'search' && <SearchView />}
        {s.view === 'performance' && <PerformanceView />}
        {s.view === 'research' && <ResearchView />}
        {s.view === 'items' && <ItemsView />}
        {s.view === 'lists' && <ListsView />}
        {s.view === 'downloads' && <DownloadsView />}
        {s.view === 'settings' && <SettingsView />}
      </main>

      <footer className="statusbar">
        <span className="item">
          <span className={'dot ' + (errors ? 'err' : warnings ? 'warn' : 'ok')} />
          {s.active.length} active · {app.mods.length} installed
        </span>
        <button className="item" onClick={() => s.setView('problems')}>
          {errors} errors · {warnings} warnings
        </button>
        {dirty && <span className="item" style={{ color: 'var(--accent)' }}>Unsaved changes</span>}
        <span className="grow" />
        <span className="item">RimWorld {app.gameVersion || '—'}</span>
        <span className="item">scan {app.scanMs} ms</span>
        <span className="item">{s.rules ? `${Object.keys(s.rules.community).length} community rules` : 'rules loading…'}</span>
      </footer>

      {s.palette && <Palette />}
      <SortPreview />
      <ContextMenu />
      <SettingsEditor />
      <Toasts />
    </div>
  )
}

function BisectBanner() {
  const s = useStore()
  const b = s.bisect!
  if (b.culprit) {
    const m = s.installed.get(b.culprit)?.[0]
    return (
      <div className="banner accent">
        <Bug size={15} color="var(--accent)" />
        <span className="grow">
          Found it: <b>{m?.name ?? b.culprit}</b> is the most likely cause. Your original list has been restored (not yet saved).
        </span>
        <button className="btn sm" onClick={() => { s.select(b.culprit!); s.stopBisect(false) }}>
          Show mod
        </button>
        <button className="btn sm ghost icon" onClick={() => s.stopBisect(false)}>
          <X size={13} />
        </button>
      </div>
    )
  }
  const remaining = Math.ceil(Math.log2(Math.max(2, b.suspects.length)))
  return (
    <div className="banner accent">
      <Bug size={15} color="var(--accent)" />
      <span className="grow">
        <b>Step {b.step}</b> · testing {b.testing.length} of {b.suspects.length} suspects (about {remaining} more steps). Launch the game, then tell RimDeck whether the problem still happens.
      </span>
      <button className="btn sm play" onClick={() => api.launch()}>
        <Play size={12} fill="currentColor" /> Launch
      </button>
      <button className="btn sm" onClick={() => s.bisectAnswer(true)}>
        Still broken
      </button>
      <button className="btn sm" onClick={() => s.bisectAnswer(false)}>
        Works now
      </button>
      <button className="btn sm ghost" onClick={() => s.stopBisect(true)}>
        Stop & restore
      </button>
    </div>
  )
}
