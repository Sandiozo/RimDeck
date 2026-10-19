import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { FolderOpen, Pencil, Plus, Trash } from 'lucide-react'
import type { InstallSummary } from '@shared/types'
import { useStore } from '../store'
import { api } from '../api'

export const useInstalls = create<{ list: InstallSummary[] | null; load: () => Promise<void> }>((set) => ({
  list: null,
  load: async () => set({ list: await api.listInstalls() }),
}))

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
      s.toast('ok', 'Install added. Create or edit a profile to use it.')
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
              {i.version || 'Unknown version'} · {i.paths.gameDir}
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
              <button
                className="btn sm ghost danger icon"
                title="Remove from RimDeck (nothing on disk is deleted)"
                onClick={async () => {
                  if (!confirm(`Remove “${i.name}” from RimDeck? Its files on disk are not affected.`)) return
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
