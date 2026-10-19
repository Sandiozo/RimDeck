import { useEffect, useState } from 'react'
import { ArchiveRestore, Check, Copy, CopyPlus, Download, Pencil, Plus, Trash, Upload, UserRound } from 'lucide-react'
import type { Profile } from '@shared/types'
import { useStore } from '../store'
import { api, workshopUrl } from '../api'
import { timeAgo } from '../lib'
import { useInstalls } from '../components/Installs'
import { switchProfile } from '../components/ProfileSwitcher'

const newId = () => `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export function ListsView() {
  const s = useStore()
  const user = s.app!.user
  const profiles = user.profiles ?? []
  const currentId = user.currentProfile
  const { list: installs, load: loadInstalls } = useInstalls()
  const [name, setName] = useState('')
  const [installId, setInstallId] = useState(s.app!.settings.currentInstall)
  const [start, setStart] = useState<'current' | 'vanilla'>('current')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [backups, setBackups] = useState<{ file: string; mtime: number; count: number }[]>([])
  useEffect(() => {
    api.listBackups().then(setBackups)
  }, [s.saved])
  useEffect(() => {
    if (!installs) void loadInstalls()
  }, [])

  const saveProfiles = (next: Profile[]) => s.setUser({ profiles: next })
  const install = (id: string) => installs?.find((i) => i.id === id)

  const create = (mods: string[], label?: string) => {
    const n = (label ?? name).trim() || `Profile ${profiles.length + 1}`
    const now = Date.now()
    saveProfiles([...profiles, { id: newId(), name: n, installId, mods, createdAt: now, updatedAt: now }])
    setName('')
    s.toast('ok', `Created profile “${n}”`)
  }
  const createFromForm = () => create(start === 'current' ? s.active : ['brrainz.harmony', 'ludeon.rimworld'].filter((id) => s.installed.has(id)))

  const update = (id: string, patch: Partial<Profile>) => saveProfiles(profiles.map((p) => (p.id === id ? { ...p, ...patch, updatedAt: Date.now() } : p)))

  const importFile = async () => {
    const file = await api.pickOpenFile('Import a mod list as a new profile', ['xml', 'rml', 'rws'])
    if (!file) return
    try {
      const ids = await api.readListFile(file)
      if (!ids.length) throw new Error('No mods found in that file')
      create(ids, file.split(/[\\/]/).pop()!.replace(/\.(xml|rml|rws)$/i, ''))
    } catch (e: any) {
      s.toast('error', e.message)
    }
  }
  const exportFile = async () => {
    const file = await api.pickSaveFile('Export the current load order', 'ModList.xml')
    if (!file) return
    await api.writeListFile(file, s.active)
    s.toast('ok', 'Load order exported')
  }
  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(
      () => s.toast('ok', `Copied ${what}`),
      () => s.toast('error', 'Could not write to the clipboard'),
    )
  const copyText = () => {
    const lines = s.active.map((id, i) => {
      const m = s.activeMap.get(id)
      const where = m?.workshopId ? workshopUrl(m.workshopId) : m?.source === 'core' || m?.source === 'dlc' ? '(official)' : '(local)'
      return `#${i + 1} ${m?.name ?? id} — ${where}`
    })
    copy(lines.join('\n'), `${lines.length} mods as text`)
  }
  const copyIds = () => {
    const ids = [...new Set(s.active.map((id) => s.activeMap.get(id)?.workshopId).filter(Boolean))]
    if (!ids.length) return s.toast('info', 'No active mods have a Workshop ID')
    copy(ids.join(','), `${ids.length} Workshop IDs`)
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Profiles</h1>
          <p>Each profile has its own game install (and therefore game version) and its own mods in their own order. Saving the load order updates the active profile.</p>
        </div>
        <button className="btn" onClick={importFile} title="Create a profile from a RimWorld, RimSort or RimPy mod list, or from a save file">
          <Upload size={14} /> Import
        </button>
        <button className="btn" onClick={exportFile}>
          <Download size={14} /> Export current
        </button>
        <button className="btn" onClick={copyText} title="One line per active mod with its Workshop link">
          <Copy size={14} /> Copy as text
        </button>
        <button className="btn" onClick={copyIds} title="Comma-separated Workshop IDs of the active mods">
          <Copy size={14} /> Copy Workshop IDs
        </button>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3 className="grow">Profiles</h3>
          <span className="dim" style={{ fontSize: 12 }}>{profiles.length} total</span>
        </div>
        <table className="table">
          <tbody>
            {profiles.map((p) => {
              const inst = install(p.installId)
              const isCurrent = p.id === currentId
              return (
                <tr key={p.id} className={isCurrent ? 'on' : ''}>
                  <td style={{ width: '34%' }}>
                    {renaming === p.id ? (
                      <input
                        className="input"
                        autoFocus
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && draft.trim()) {
                            update(p.id, { name: draft.trim() })
                            setRenaming(null)
                          } else if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={() => setRenaming(null)}
                      />
                    ) : (
                      <div className="row" style={{ gap: 8 }}>
                        <UserRound size={14} className="dim" />
                        <b style={{ fontWeight: 600 }}>{p.name}</b>
                        {isCurrent && <span className="chip accent">Active</span>}
                      </div>
                    )}
                    <div className="dim" style={{ fontSize: 11.5, marginTop: 2 }}>
                      {p.mods.length} mods · updated {timeAgo(p.updatedAt)}
                    </div>
                  </td>
                  <td>
                    <select
                      className="input"
                      value={p.installId}
                      disabled={isCurrent}
                      title={isCurrent ? 'To change the install of the active profile, switch to another profile first' : 'Game install this profile uses'}
                      onChange={(e) => update(p.id, { installId: e.target.value })}
                    >
                      {!inst && <option value={p.installId}>Missing install</option>}
                      {installs?.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name} — RimWorld {i.version.split(' ')[0] || '?'}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {!isCurrent && (
                      <button className="btn sm primary" onClick={() => switchProfile(p.id)}>
                        <Check size={12} /> Use
                      </button>
                    )}{' '}
                    <button className="btn sm ghost icon" title="Rename" onClick={() => { setRenaming(p.id); setDraft(p.name) }}>
                      <Pencil size={12} />
                    </button>
                    <button
                      className="btn sm ghost icon"
                      title="Duplicate"
                      onClick={() => {
                        const now = Date.now()
                        saveProfiles([...profiles, { ...p, id: newId(), name: `${p.name} (copy)`, createdAt: now, updatedAt: now }])
                      }}
                    >
                      <CopyPlus size={12} />
                    </button>
                    <button
                      className="btn sm ghost danger icon"
                      title={isCurrent ? 'The active profile cannot be deleted' : 'Delete'}
                      disabled={isCurrent}
                      onClick={() => confirm(`Delete the profile “${p.name}”? Your mods are not affected.`) && saveProfiles(profiles.filter((x) => x.id !== p.id))}
                    >
                      <Trash size={12} />
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="panel-body row" style={{ gap: 8, borderTop: '1px solid var(--line)', flexWrap: 'wrap' }}>
          <input className="input grow" style={{ minWidth: 200 }} value={name} placeholder="New profile name…" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createFromForm()} />
          <select className="input" value={installId} onChange={(e) => setInstallId(e.target.value)} title="Game install">
            {installs?.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} — RimWorld {i.version.split(' ')[0] || '?'}
              </option>
            ))}
          </select>
          <select className="input" value={start} onChange={(e) => setStart(e.target.value as 'current' | 'vanilla')} title="Starting mods">
            <option value="current">Start from the current load order ({s.active.length})</option>
            <option value="vanilla">Start with Core only</option>
          </select>
          <button className="btn primary" onClick={createFromForm}>
            <Plus size={14} /> Create profile
          </button>
        </div>
        <p className="dim" style={{ margin: '0 14px 12px', fontSize: 12 }}>
          A different game version needs its own install, which you can add under Settings → Game installs.
        </p>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3 className="grow">ModsConfig.xml backups</h3>
          <span className="dim" style={{ fontSize: 12 }}>Created before every save · last 30 kept</span>
        </div>
        {backups.length ? (
          <table className="table">
            <tbody>
              {backups.map((b) => (
                <tr key={b.file}>
                  <td className="mono muted">{b.file.split(/[\\/]/).pop()}</td>
                  <td className="muted">{timeAgo(b.mtime)}</td>
                  <td className="mono">{b.count} mods</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn sm"
                      onClick={async () => {
                        const ids = await api.readListFile(b.file)
                        s.setActive(ids)
                        s.setView('mods')
                        s.toast('ok', 'Backup loaded. Review it, then save.')
                      }}
                    >
                      <ArchiveRestore size={12} /> Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">Backups appear here after the first save.</div>
        )}
      </div>
    </div>
  )
}
