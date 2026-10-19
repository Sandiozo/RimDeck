import { useEffect, useMemo, useRef, useState } from 'react'
import { Download, ExternalLink, Layers, ListChecks, LoaderCircle, RotateCw, X } from 'lucide-react'
import type { ModInfo } from '@shared/types'
import { parseWorkshopIds } from '@shared/workshop'
import { useStore } from '../store'
import { api, workshopUrl } from '../api'
import { bytes } from '../lib'
import { ModIcon } from '../components/ui'

type ItemStatus = 'active' | 'installed' | 'downloading' | 'missing' | 'unavailable'

const STATUS: Record<ItemStatus, [string, string]> = {
  active: ['Active', 'ok'],
  installed: ['Installed', 'info'],
  downloading: ['Downloading', 'accent'],
  missing: ['Missing', 'err'],
  unavailable: ['Unavailable', ''],
}

/** Workshop collection import: preview what's installed, download the rest, use it as the load order. */
export function CollectionPanel() {
  const s = useStore()
  const c = s.collection
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (s.collectionFocus) ref.current?.focus()
  }, [s.collectionFocus])

  const byWorkshop = useMemo(() => {
    const map = new Map<string, ModInfo>()
    for (const src of ['local', 'workshop']) for (const m of s.app!.mods) if (m.source === src && m.workshopId && !map.has(m.workshopId)) map.set(m.workshopId, m)
    return map
  }, [s.app])

  const rows = useMemo(() => {
    if (!c) return []
    const busy = new Set(s.downloads?.jobs.filter((j) => j.status === 'queued' || j.status === 'downloading' || j.status === 'installing').map((j) => j.workshopId))
    return c.items.map((d) => {
      const mod = byWorkshop.get(d.workshopId)
      const status: ItemStatus = mod
        ? s.active.includes(mod.packageId) ? 'active' : 'installed'
        : !d.ok ? 'unavailable' : busy.has(d.workshopId) ? 'downloading' : 'missing'
      return { d, mod, status }
    })
  }, [c, byWorkshop, s.active, s.downloads])

  const count = (st: ItemStatus) => rows.filter((r) => r.status === st).length
  const missing = rows.filter((r) => r.status === 'missing').map((r) => r.d.workshopId)
  const newSinceApply = s.collectionApplied ? rows.filter((r) => r.mod && !s.collectionApplied!.includes(r.d.workshopId)).length : 0

  const load = async () => {
    const id = parseWorkshopIds(input)[0]
    if (!id) return s.toast('error', 'Paste a collection link or ID')
    setLoading(true)
    await s.loadCollection(id)
    setLoading(false)
  }

  if (!c)
    return (
      <div className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <Layers size={14} color="var(--text-3)" />
          <input
            ref={ref}
            className="input grow"
            value={input}
            placeholder="Import a Workshop collection: paste its link or ID…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && load()}
          />
          <button className="btn" onClick={load} disabled={!input.trim() || loading}>
            {loading ? <LoaderCircle size={14} className="spin" /> : <Layers size={14} />} Load collection
          </button>
        </div>
      </div>
    )

  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="panel-head">
        <Layers size={14} color="var(--accent)" />
        <h3 className="grow ellipsis">
          {c.title}
          <span className="dim" style={{ fontWeight: 400 }}>
            {' '}· {c.items.length} mods{c.nested.length ? ` (incl. ${c.nested.length} nested ${c.nested.length === 1 ? 'collection' : 'collections'})` : ''}
          </span>
        </h3>
        <button className="btn sm" disabled={!missing.length} onClick={() => s.download(missing)}>
          <Download size={12} /> Download missing ({missing.length})
        </button>
        <button className="btn sm primary" disabled={!rows.some((r) => r.mod)} onClick={() => s.applyCollection()} title="Replace the working load order (not saved until you press Save)">
          <ListChecks size={12} /> Use as mod list
        </button>
        <button className="btn sm ghost icon" title="Workshop page" onClick={() => api.openUrl(workshopUrl(c.workshopId))}>
          <ExternalLink size={12} />
        </button>
        <button className="btn sm ghost icon" title="Close" onClick={() => { s.closeCollection(); setInput('') }}>
          <X size={12} />
        </button>
      </div>
      {newSinceApply > 0 && (
        <div className="banner accent" style={{ borderRadius: 0 }}>
          <span className="grow">
            {newSinceApply} {newSinceApply === 1 ? 'mod' : 'mods'} from this collection installed since it was applied.
          </span>
          <button className="btn sm" onClick={() => s.applyCollection()}>
            <RotateCw size={12} /> Apply again
          </button>
        </div>
      )}
      <div className="panel-body" style={{ paddingBottom: 6 }}>
        <div className="chips">
          {(['active', 'installed', 'downloading', 'missing', 'unavailable'] as ItemStatus[]).map((st) =>
            count(st) ? (
              <span key={st} className={'chip ' + STATUS[st][1]}>
                {STATUS[st][0]} {count(st)}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <div style={{ maxHeight: 360, overflow: 'auto' }}>
        <table className="table">
          <tbody>
            {rows.map(({ d, mod, status }, i) => (
              <tr key={d.workshopId}>
                <td className="mono dim" style={{ width: 34 }}>{i + 1}</td>
                <td style={{ width: 26 }}>
                  <ModIcon mod={mod} size={18} />
                </td>
                <td>
                  <span
                    className="ellipsis"
                    style={{ fontWeight: 560, cursor: mod ? 'pointer' : undefined }}
                    onClick={() => mod && (s.select(mod.packageId), s.setView('mods'))}
                  >
                    {mod?.name ?? d.title}
                  </span>
                </td>
                <td style={{ width: 110 }}>
                  <span className={'chip ' + STATUS[status][1]}>
                    {status === 'downloading' && <LoaderCircle size={10} className="spin" />} {STATUS[status][0]}
                  </span>
                </td>
                <td className="mono muted" style={{ width: 80 }}>{d.size ? bytes(d.size) : ''}</td>
                <td style={{ width: 1, whiteSpace: 'nowrap', textAlign: 'right' }}>
                  {status === 'missing' && (
                    <button className="btn sm" onClick={() => s.download([d.workshopId])}>
                      <Download size={11} />
                    </button>
                  )}
                  <button className="btn sm ghost icon" title="Workshop page" onClick={() => api.openUrl(workshopUrl(d.workshopId))}>
                    <ExternalLink size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
