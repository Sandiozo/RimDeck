import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Check, ChevronDown, FolderOpen, HardDrive, Pencil, Plus, Settings2, Trash } from 'lucide-react'
import type { InstallSummary } from '@shared/types'
import { isDirty, useStore } from '../store'
import { api } from '../api'
import { useDefs } from '../defStore'

export const useInstalls = create<{ list: InstallSummary[] | null; load: () => Promise<void> }>((set) => ({
  list: null,
  load: async () => set({ list: await api.listInstalls() }),
}))

export async function switchInstall(id: string) {
  const s = useStore.getState()
  if (isDirty(s) && !confirm('You have unsaved load order changes. Switch install and discard them?')) return
  try {
    const app = await api.switchInstall(id)
    const active = app.config?.activeMods ?? []
    // Reuse the normal "paths changed" path so the whole UI reloads from the new install.
    useStore.setState({ app, active, saved: active, past: [], future: [], selection: new Set(), focus: null })
    s.setActive(active, false)
    useDefs.setState({ data: null, scannedFor: '' })
    void useStore.getState().refreshXml()
    void useStore.getState().refreshChanges()
    await useInstalls.getState().load()
    const name = useInstalls.getState().list?.find((i) => i.id === id)?.name
    useStore.getState().toast('ok', `Switched to ${name ?? 'install'} — ${app.mods.length} mods`)
  } catch (e: any) {
    useStore.getState().toast('error', e.message)
  }
}

/** Title-bar chip: which RimWorld install RimDeck is managing, with a quick switch menu. */
export function InstallSwitcher() {
  const s = useStore()
  const { list, load } = useInstalls()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    void load()
  }, [s.app?.settings.currentInstall])
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const current = list?.find((i) => i.current)
  return (
    <div ref={ref} className="no-drag" style={{ position: 'relative' }}>
      <button className="btn ghost sm install-chip" onClick={() => setOpen(!open)} title="Switch RimWorld install">
        <HardDrive size={12} />
        <span className="ellipsis" style={{ maxWidth: 140 }}>{current?.name ?? 'Install'}</span>
        <span className="dim mono" style={{ fontSize: 10.5 }}>{current?.version.match(/^\d+\.\d+/)?.[0] ?? ''}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu" style={{ position: 'absolute', left: 0, top: 30, width: 320 }}>
          {list?.map((i) => (
            <button
              key={i.id}
              onClick={() => {
                setOpen(false)
                if (!i.current) void switchInstall(i.id)
              }}
            >
              {i.current ? <Check size={14} color="var(--accent)" /> : <span style={{ width: 14 }} />}
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="ellipsis" style={{ display: 'block', fontWeight: 560 }}>{i.name}</span>
                <span className="ellipsis dim mono" style={{ display: 'block', fontSize: 10.5 }}>{i.paths.gameDir}</span>
              </span>
              <span className="dim mono" style={{ fontSize: 10.5 }}>{i.version.split(' ')[0] || '?'}</span>
            </button>
          ))}
          <hr />
          <button
            onClick={() => {
              setOpen(false)
              s.setView('settings')
            }}
          >
            <Settings2 size={14} /> Manage installs…
          </button>
        </div>
      )}
    </div>
  )
}

/** Settings panel: list, add, rename and remove installs. */
export function InstallsPanel() {
  const s = useStore()
  const { list, load } = useInstalls()
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [gameDir, setGameDir] = useState('')
  const [separate, setSeparate] = useState(true)
  const [dataFolder, setDataFolder] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    if (!list) void load()
  }, [])

  const browseGame = async () => {
    const p = await api.pickFolder('RimWorld game folder')
    if (!p) return
    setGameDir(p)
    if (!dataFolder) setDataFolder(p.replace(/[\\/]+$/, '') + '\\RimDeckData')
  }
  const add = async () => {
    try {
      await api.addInstall({ name, gameDir, dataFolder: separate ? dataFolder : undefined })
      await load()
      setAdding(false)
      setName('')
      setGameDir('')
      setDataFolder('')
      s.toast('ok', 'Install added — switch to it from the title bar')
    } catch (e: any) {
      s.toast('error', e.message)
    }
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <h3 className="grow">Game installs</h3>
        <button className="btn sm" onClick={() => setAdding(!adding)}>
          <Plus size={12} /> Add install
        </button>
      </div>
      {list?.map((i) => (
        <div key={i.id} className="setting">
          <div className="label" style={{ width: 'auto', flex: 1, minWidth: 0 }}>
            {renaming === i.id ? (
              <input
                className="input"
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Enter') {
                    await api.renameInstall(i.id, draft)
                    await load()
                    setRenaming(null)
                  } else if (e.key === 'Escape') setRenaming(null)
                }}
                onBlur={() => setRenaming(null)}
              />
            ) : (
              <b>
                {i.name} {i.current && <span className="chip accent" style={{ marginLeft: 6 }}>In use</span>}
              </b>
            )}
            <span className="mono ellipsis" style={{ display: 'block' }}>
              {i.version || 'version unknown'} · {i.paths.gameDir}
            </span>
            {i.dataFolder && <span className="ellipsis" style={{ display: 'block' }}>Separate data: {i.dataFolder}</span>}
            {i.problems.length > 0 && <span style={{ color: 'var(--err)', display: 'block' }}>{i.problems[0]}</span>}
          </div>
          <button className="btn sm ghost icon" title="Rename" onClick={() => { setRenaming(i.id); setDraft(i.name) }}>
            <Pencil size={12} />
          </button>
          <button className="btn sm ghost icon" title="Open game folder" onClick={() => api.openPath(i.paths.gameDir)}>
            <FolderOpen size={12} />
          </button>
          {!i.current && (
            <>
              <button className="btn sm" onClick={() => switchInstall(i.id)}>
                Switch
              </button>
              <button
                className="btn sm ghost danger icon"
                title="Remove from RimDeck (nothing on disk is deleted)"
                onClick={async () => {
                  if (!confirm(`Remove “${i.name}” from RimDeck? Its files on disk are not touched.`)) return
                  try {
                    await api.removeInstall(i.id)
                    await load()
                  } catch (e: any) {
                    s.toast('error', e.message)
                  }
                }}
              >
                <Trash size={12} />
              </button>
            </>
          )}
        </div>
      ))}
      {adding && (
        <div className="panel-body col" style={{ gap: 10, borderTop: '1px solid var(--line)' }}>
          <div className="row">
            <span style={{ width: 120 }} className="muted">Name</span>
            <input className="input grow" value={name} placeholder="e.g. RimWorld 1.6" onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="row">
            <span style={{ width: 120 }} className="muted">Game folder</span>
            <input className="input grow mono" value={gameDir} placeholder="Folder with RimWorldWin64.exe and Data\Core" onChange={(e) => setGameDir(e.target.value)} />
            <button className="btn icon" onClick={browseGame}>
              <FolderOpen size={14} />
            </button>
          </div>
          <label className="row" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />
            <span>
              Keep its saves, settings and mod list separate <span className="dim">(recommended for a different game version)</span>
            </span>
          </label>
          {separate && (
            <div className="row">
              <span style={{ width: 120 }} className="muted">Data folder</span>
              <input className="input grow mono" value={dataFolder} onChange={(e) => setDataFolder(e.target.value)} />
              <button
                className="btn icon"
                onClick={async () => {
                  const p = await api.pickFolder('Folder for this install’s saves and config')
                  if (p) setDataFolder(p)
                }}
              >
                <FolderOpen size={14} />
              </button>
            </div>
          )}
          <p className="dim" style={{ margin: 0, fontSize: 12 }}>
            {separate
              ? 'RimDeck starts this install with -savedatafolder, so the game keeps its saves, mod settings and ModsConfig.xml in the data folder. Workshop mods are shared.'
              : 'This install will share saves, mod settings and the active mod list with your other installs that use the default folder.'}
          </p>
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn primary" disabled={!gameDir.trim() || (separate && !dataFolder.trim())} onClick={add}>
              Add install
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
