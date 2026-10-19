import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, RotateCcw, Search, SlidersHorizontal } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../api'
import { bytes, timeAgo } from '../lib'
import { openSettings, useSettingsFiles } from '../components/SettingsEditor'
import { ModIcon, Seg } from '../components/ui'

type Scope = 'active' | 'all'

export function ModSettingsView() {
  const s = useStore()
  const { files, load } = useSettingsFiles()
  const [q, setQ] = useState('')
  const [scope, setScope] = useState<Scope>('active')
  useEffect(() => {
    if (!files) void load()
  }, [])

  // Settings files belong to a mod folder; show each with its mod, active mods first.
  const rows = useMemo(() => {
    const byFolder = new Map((s.app?.mods ?? []).filter((m) => m.source === 'local' || m.source === 'workshop').map((m) => [m.folder.toLowerCase(), m]))
    const t = q.trim().toLowerCase()
    return (files ?? [])
      .filter((f) => f.folder)
      .map((f) => ({ f, mod: byFolder.get(f.folder!.toLowerCase()) }))
      .map((r) => ({ ...r, active: !!r.mod && s.active.includes(r.mod.packageId) }))
      .filter((r) => scope === 'all' || r.active)
      .filter((r) => !t || (r.mod?.name ?? r.f.name).toLowerCase().includes(t) || r.f.className.toLowerCase().includes(t))
      .sort((a, b) => Number(b.active) - Number(a.active) || (a.mod?.name ?? '').localeCompare(b.mod?.name ?? ''))
  }, [files, q, scope, s.app, s.active])

  const total = (files ?? []).filter((f) => f.folder).length

  const reset = async (path: string, label: string) => {
    if (!confirm(`Reset ${label} to its default settings?\nThe current file is moved to RimDeck's backups and the game recreates the defaults.`)) return
    try {
      await api.resetModSettings(path)
      s.toast('ok', `${label} reset to defaults`)
      void load()
    } catch (e: any) {
      s.toast('error', e.message)
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Mod settings</h1>
          <p>Edit the saved settings of your mods without starting the game. A mod appears here after its options have been changed in game at least once.</p>
        </div>
        <button className="btn" onClick={() => load()}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="panel">
        <div className="panel-head">
          <label className="pane-filter grow" style={{ margin: 0 }}>
            <Search size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a mod…" autoFocus />
          </label>
          <Seg<Scope>
            value={scope}
            onChange={setScope}
            options={[
              ['active', 'Active mods'],
              ['all', 'All installed'],
            ]}
          />
          <span className="count">{files ? `${rows.length}/${total}` : '…'}</span>
        </div>
        {files ? (
          <table className="table">
            <tbody>
              {rows.map(({ f, mod, active }) => (
                <tr key={f.path}>
                  <td>
                    <div className="row">
                      <ModIcon mod={mod} size={22} />
                      <div style={{ minWidth: 0 }}>
                        <div className={'ellipsis' + (active ? '' : ' dim')} style={{ fontWeight: 580 }}>
                          {mod?.name ?? f.folder}
                        </div>
                        <div className="mono dim ellipsis" style={{ fontSize: 10.5 }}>{f.className}</div>
                      </div>
                    </div>
                  </td>
                  <td style={{ width: 110 }}>{active ? <span className="chip ok">Active</span> : <span className="chip">Inactive</span>}</td>
                  <td className="muted" style={{ width: 170, fontSize: 12 }}>
                    {bytes(f.size)} · {timeAgo(f.mtime)}
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn sm primary" onClick={() => openSettings(f.path)}>
                      <SlidersHorizontal size={12} /> Configure
                    </button>{' '}
                    <button className="btn sm ghost icon" title="Reset to defaults" onClick={() => reset(f.path, mod?.name ?? f.className)}>
                      <RotateCcw size={12} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">Reading mod settings…</div>
        )}
        {files && !rows.length && <div className="empty">No saved mod settings{q ? ' match the search' : scope === 'active' ? ' for active mods' : ''}.</div>}
      </div>

      <LeftoverSettings />
    </div>
  )
}

// Settings files left behind by mods that are no longer installed.
function LeftoverSettings() {
  const s = useStore()
  const { files, load } = useSettingsFiles()
  const [open, setOpen] = useState(false)
  if (!files) return null
  const orphans = files.filter((f) => !f.folder)
  const size = orphans.reduce((n, f) => n + f.size, 0)
  return (
    <div className="panel">
      <div className="panel-head">
        <h3 className="grow">Leftover settings</h3>
        <span className="dim" style={{ fontSize: 12 }}>
          {orphans.length} files from mods that are not installed ({bytes(size)})
        </span>
      </div>
      <div className="setting">
        <div className="label" style={{ width: 'auto', flex: 1 }}>
          <span>Files are moved into RimDeck's backup folder, not deleted.</span>
        </div>
        <button className="btn sm" disabled={!orphans.length} onClick={() => setOpen(!open)}>
          {open ? 'Hide list' : 'Show list'}
        </button>
        <button
          className="btn"
          disabled={!orphans.length}
          onClick={async () => {
            if (!confirm(`Move ${orphans.length} leftover settings files to RimDeck's backups?`)) return
            try {
              const n = await api.archiveSettings(orphans.map((f) => f.path))
              s.toast('ok', `Moved ${n} leftover settings files to backups`)
              void load()
            } catch (e: any) {
              s.toast('error', e.message)
            }
          }}
        >
          Clean up {orphans.length}
        </button>
      </div>
      {open && (
        <div className="panel-body" style={{ maxHeight: 260, overflow: 'auto', paddingTop: 0 }}>
          {orphans.map((f) => (
            <div key={f.path} className="d-item">
              <span className="grow mono ellipsis" style={{ fontSize: 11.5 }}>
                {f.name}
              </span>
              <span className="dim" style={{ fontSize: 11 }}>
                {bytes(f.size)} · {timeAgo(f.mtime)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
