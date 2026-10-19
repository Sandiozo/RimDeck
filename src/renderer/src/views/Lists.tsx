import { useEffect, useState } from 'react'
import { ArchiveRestore, Copy, Download, Plus, Trash, Upload } from 'lucide-react'
import type { ModList } from '@shared/types'
import { useStore } from '../store'
import { api, workshopUrl } from '../api'
import { timeAgo } from '../lib'

export function ListsView() {
  const s = useStore()
  const lists = s.app!.user.lists
  const [name, setName] = useState('')
  const [backups, setBackups] = useState<{ file: string; mtime: number; count: number }[]>([])
  useEffect(() => {
    api.listBackups().then(setBackups)
  }, [s.saved])

  const saveCurrent = () => {
    const n = name.trim() || `List ${lists.length + 1}`
    const entry: ModList = { name: n, ids: s.active, createdAt: Date.now() }
    s.setUser({ lists: [entry, ...lists.filter((l) => l.name !== n)] })
    setName('')
    s.toast('ok', `Saved “${n}”`)
  }
  const load = (l: ModList) => {
    s.setActive(l.ids)
    s.setView('mods')
    s.toast('ok', `Loaded “${l.name}” — review, then save`)
  }
  const importFile = async () => {
    const file = await api.pickOpenFile('Import mod list', ['xml', 'rml', 'rws'])
    if (!file) return
    try {
      const ids = await api.readListFile(file)
      if (!ids.length) throw new Error('No mods found in that file')
      s.setActive(ids)
      s.setView('mods')
      s.toast('ok', `Imported ${ids.length} mods`)
    } catch (e: any) {
      s.toast('error', e.message)
    }
  }
  const exportFile = async () => {
    const file = await api.pickSaveFile('Export mod list', 'ModList.xml')
    if (!file) return
    await api.writeListFile(file, s.active)
    s.toast('ok', 'Exported')
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
    if (!ids.length) return s.toast('info', 'No active mods have a Workshop id')
    copy(ids.join(','), `${ids.length} Workshop ids`)
  }
  const diff = (ids: string[]) => {
    const a = new Set(s.active)
    const b = new Set(ids)
    return { add: ids.filter((x) => !a.has(x)).length, remove: s.active.filter((x) => !b.has(x)).length }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Mod lists</h1>
          <p>Snapshots of load orders you can switch between, plus automatic backups of every save.</p>
        </div>
        <button className="btn" onClick={importFile}>
          <Upload size={14} /> Import
        </button>
        <button className="btn" onClick={exportFile}>
          <Download size={14} /> Export current
        </button>
        <button className="btn" onClick={copyText} title="One line per active mod with its Workshop link, for Reddit, Discord or a bug report">
          <Copy size={14} /> Copy as text
        </button>
        <button className="btn" onClick={copyIds} title="Comma-separated Workshop ids of the active mods">
          <Copy size={14} /> Copy Workshop IDs
        </button>
      </div>

      <div className="panel">
        <div className="panel-head">
          <input className="input grow" value={name} placeholder="Name for the current load order…" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && saveCurrent()} />
          <button className="btn primary" onClick={saveCurrent}>
            <Plus size={14} /> Save current ({s.active.length})
          </button>
        </div>
        {lists.length ? (
          <table className="table">
            <tbody>
              {lists.map((l) => {
                const d = diff(l.ids)
                return (
                  <tr key={l.name}>
                    <td>
                      <b style={{ fontWeight: 600 }}>{l.name}</b>
                      <div className="dim" style={{ fontSize: 11.5 }}>
                        {l.ids.length} mods · {timeAgo(l.createdAt)}
                      </div>
                    </td>
                    <td className="muted" style={{ fontSize: 12 }}>
                      {d.add || d.remove ? `+${d.add} / −${d.remove} vs current` : 'Same mods as current'}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn sm" onClick={() => load(l)}>
                        Load
                      </button>{' '}
                      <button className="btn sm ghost danger icon" title="Delete" onClick={() => s.setUser({ lists: lists.filter((x) => x !== l) })}>
                        <Trash size={12} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty">No saved lists yet.</div>
        )}
      </div>

      <div className="panel">
        <div className="panel-head">
          <h3 className="grow">ModsConfig.xml backups</h3>
          <span className="dim" style={{ fontSize: 12 }}>Made automatically before every save · last 30 kept</span>
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
                        s.toast('ok', 'Backup loaded — review, then save')
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
          <div className="empty">Backups appear here after your first save.</div>
        )}
      </div>
    </div>
  )
}
