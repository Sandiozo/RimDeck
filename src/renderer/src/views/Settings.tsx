import { useEffect, useState } from 'react'
import { FolderOpen, RefreshCw, Download, WandSparkles } from 'lucide-react'
import type { Paths, SortMode, UpdateState } from '@shared/types'
import { useStore } from '../store'
import { api, onEvent } from '../api'
import { Seg, Toggle } from '../components/ui'
import { timeAgo } from '../lib'
import { InstallsPanel } from '../components/Installs'

const ACCENTS = ['#7c8cff', '#b58cff', '#4fd1c5', '#3ecf8e', '#f5b544', '#ff7a90', '#5aa9ff']

const PATH_FIELDS: [keyof Paths, string, string][] = [
  ['gameDir', 'Game folder', 'Contains Data/Core and the game executable'],
  ['configDir', 'Config folder', 'Where ModsConfig.xml lives'],
  ['workshopDir', 'Workshop folder', 'steamapps/workshop/content/294100'],
  ['localModsDir', 'Local mods folder', 'Usually <game>/Mods'],
]

export function SettingsView() {
  const s = useStore()
  const st = s.app!.settings
  const [paths, setPaths] = useState<Paths>(st.paths)
  useEffect(() => setPaths(st.paths), [st.currentInstall])
  const [args, setArgs] = useState(st.launchArgs)
  const [busy, setBusy] = useState('')
  const dirty = (Object.keys(paths) as (keyof Paths)[]).some((k) => paths[k] !== st.paths[k])

  const browse = async (k: keyof Paths, label: string) => {
    const p = await api.pickFolder(label)
    if (p) setPaths({ ...paths, [k]: p })
  }
  const detect = async () => {
    const r = await api.detectPaths()
    setPaths(r.paths)
    s.toast(r.source === 'none' ? 'error' : 'ok', r.source === 'none' ? 'Could not find RimWorld automatically' : `Found paths via ${r.source}`)
  }

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-head">
        <div className="grow">
          <h1>Settings</h1>
          <p>
            RimWorld {s.app!.gameVersion || 'not found'} · {s.app!.mods.length} mods scanned in {s.app!.scanMs} ms
          </p>
        </div>
      </div>

      <InstallsPanel />

      <div className="panel">
        <div className="panel-head">
          <h3 className="grow">Folders for this install</h3>
          <button className="btn sm" onClick={detect}>
            <WandSparkles size={12} /> Auto-detect
          </button>
          <button className="btn sm primary" disabled={!dirty} onClick={() => s.updateSettings({ paths })}>
            Apply
          </button>
        </div>
        {s.app!.pathProblems.length > 0 && (
          <div className="banner err" style={{ margin: '12px 14px 0' }}>
            {s.app!.pathProblems.join(' ')}
          </div>
        )}
        {PATH_FIELDS.map(([k, label, hint]) => (
          <div className="setting" key={k}>
            <div className="label">
              <b>{label}</b>
              <span>{hint}</span>
            </div>
            <input className="input grow mono" value={paths[k]} onChange={(e) => setPaths({ ...paths, [k]: e.target.value })} />
            <button className="btn icon" title="Browse" onClick={() => browse(k, label)}>
              <FolderOpen size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Sorting</h3>
        </div>
        <div className="setting">
          <div className="label">
            <b>Sort style</b>
            <span>How mods with no rules between them are arranged</span>
          </div>
          <Seg<SortMode>
            value={st.sortMode}
            onChange={(v) => s.updateSettings({ sortMode: v })}
            options={[
              ['grouped', 'By category'],
              ['minimal', 'Keep my order'],
              ['alphabetical', 'Alphabetical'],
            ]}
          />
        </div>
        <div className="setting">
          <div className="label">
            <b>Dependencies load first</b>
            <span>Treat “requires” as “load after”</span>
          </div>
          <Toggle on={st.depsAsLoadAfter} onChange={(v) => s.updateSettings({ depsAsLoadAfter: v })} />
        </div>
        <div className="setting">
          <div className="label">
            <b>Community rules</b>
            <span>RimSort's shared rules database plus “Use This Instead” replacements</span>
          </div>
          <Toggle on={st.useCommunityRules} onChange={(v) => s.updateSettings({ useCommunityRules: v })} />
          <span className="grow dim" style={{ fontSize: 12 }}>
            {s.rules ? `${Object.keys(s.rules.community).length} rules · ${s.rules.replacements.length} replacements · updated ${timeAgo(s.rules.fetchedAt)}` : 'Loading…'}
          </span>
          <button
            className="btn sm"
            disabled={busy === 'rules'}
            onClick={async () => {
              setBusy('rules')
              try {
                const rules = await api.getRules(true)
                useStore.setState({ rules })
                s.setActive(s.active, false)
                s.toast('ok', 'Rule databases updated')
              } catch {
                s.toast('error', 'Update failed')
              } finally {
                setBusy('')
              }
            }}
          >
            <RefreshCw size={12} className={busy === 'rules' ? 'spin' : ''} /> Update
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Game version</h3>
        </div>
        <div className="setting">
          <div className="label">
            <b>Check mods against</b>
            <span>Version warnings, badges and the is:outdated filter use this. Useful when planning a list for an older or newer version.</span>
          </div>
          <select className="input" value={st.targetVersion} onChange={(e) => s.updateSettings({ targetVersion: e.target.value })}>
            <option value="">Installed game ({s.app!.installedMajor})</option>
            {['1.7', '1.6', '1.5', '1.4', '1.3', '1.2', '1.1', '1.0']
              .filter((v) => v !== s.app!.installedMajor)
              .map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
          </select>
          {st.targetVersion && <span className="chip warn">Not your installed version</span>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3>Launching</h3>
        </div>
        <div className="setting">
          <div className="label">
            <b>Launch through Steam</b>
            <span>Otherwise RimDeck starts the executable directly</span>
          </div>
          <Toggle on={st.launchViaSteam} onChange={(v) => s.updateSettings({ launchViaSteam: v })} />
        </div>
        <div className="setting">
          <div className="label">
            <b>Launch arguments</b>
            <span>e.g. -popupwindow -logfile</span>
          </div>
          <input className="input grow mono" value={args} onChange={(e) => setArgs(e.target.value)} onBlur={() => args !== st.launchArgs && s.updateSettings({ launchArgs: args })} />
        </div>
        <div className="setting">
          <div className="label">
            <b>Back up newest save</b>
            <span>Copy it to RimDeck's folder before each launch</span>
          </div>
          <Toggle on={st.backupSaveOnLaunch} onChange={(v) => s.updateSettings({ backupSaveOnLaunch: v })} />
        </div>
      </div>

      <AboutPanel />

      <div className="panel">
        <div className="panel-head">
          <h3>Appearance and data</h3>
        </div>
        <div className="setting">
          <div className="label">
            <b>Accent color</b>
          </div>
          <div className="swatches">
            {ACCENTS.map((c) => (
              <span key={c} className={'swatch' + (st.accent === c ? ' on' : '')} style={{ background: c }} onClick={() => s.updateSettings({ accent: c })} />
            ))}
          </div>
        </div>
        <div className="setting">
          <div className="label">
            <b>Import from RimSort</b>
            <span>Your rules, ignored mods, colors and notes</span>
          </div>
          <button
            className="btn"
            onClick={async () => {
              const r = await api.importRimSort()
              if (!r.found) return s.toast('error', 'No RimSort data found')
              await s.reload()
              const app = await api.getState()
              useStore.setState({ app })
              s.setActive(s.active, false)
              s.toast('ok', `Imported ${r.rules} rules, ${r.ignored} ignored mods, ${r.meta} notes/colors`)
            }}
          >
            <Download size={14} /> Import
          </button>
        </div>
        <div className="setting">
          <div className="label">
            <b>Muted mods</b>
            <span>Warnings hidden for these</span>
          </div>
          <span className="grow muted">{s.app!.user.ignored.length} mods</span>
          <button className="btn sm" disabled={!s.app!.user.ignored.length} onClick={() => s.setUser({ ignored: [] })}>
            Unmute all
          </button>
        </div>
      </div>
    </div>
  )
}


function AboutPanel() {
  const [state, setState] = useState<UpdateState | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    api.updateState().then(setState, () => {})
    return onEvent((e) => e.type === 'update' && setState(e.state))
  }, [])
  const status =
    !state ? ''
    : state.phase === 'checking' ? 'Checking…'
    : state.phase === 'downloading' ? `Downloading ${state.version ?? 'update'}… ${state.percent ?? 0}%`
    : state.phase === 'ready' ? `Version ${state.version} has been downloaded and will be installed on restart`
    : state.phase === 'none' ? 'RimDeck is up to date'
    : state.phase === 'error' ? `Could not check: ${state.error}`
    : 'Updates are checked automatically at startup'
  return (
    <div className="panel">
      <div className="panel-head">
        <h3 className="grow">About RimDeck</h3>
        <span className="dim" style={{ fontSize: 12 }}>Version {state?.current ?? ''}</span>
      </div>
      <div className="setting">
        <div className="label">
          <b>Updates</b>
          <span>{status}</span>
        </div>
        <span className="grow" />
        {state?.phase === 'ready' ? (
          <button className="btn primary" onClick={() => api.updateInstall()}>
            <Download size={14} /> Restart and update
          </button>
        ) : (
          <button
            className="btn"
            disabled={busy || state?.phase === 'downloading'}
            onClick={async () => {
              setBusy(true)
              try {
                setState(await api.updateCheck())
              } finally {
                setBusy(false)
              }
            }}
          >
            <RefreshCw size={13} className={busy ? 'spin' : ''} /> Check for updates
          </button>
        )}
        <button className="btn ghost" onClick={() => api.openUrl('https://github.com/Sandiozo/RimDeck')}>
          GitHub
        </button>
      </div>
    </div>
  )
}

