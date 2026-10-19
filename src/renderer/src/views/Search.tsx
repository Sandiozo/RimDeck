import { useEffect, useMemo, useRef, useState } from 'react'
import { FileSearch, FolderOpen, FileText, Search } from 'lucide-react'
import type { XmlSearchHit, XmlSearchResult } from '@shared/types'
import { useStore } from '../store'
import { api } from '../api'
import { ModIcon, Seg } from '../components/ui'

type Scope = 'active' | 'all'

function Hit({ hit, query, label }: { hit: XmlSearchHit; query: string; label?: string }) {
  const s = useStore()
  const mod = s.installed.get(hit.packageId)?.[0]
  const rel = mod && hit.file.startsWith(mod.path) ? hit.file.slice(mod.path.length + 1) : hit.file
  const i = hit.text.toLowerCase().indexOf(query.toLowerCase())
  return (
    <div className="hit" onDoubleClick={() => api.openPath(hit.file)} title="Double-click to open the file">
      <div className="row" style={{ gap: 6, minWidth: 0 }}>
        {label && <span className="chip accent">{label}</span>}
        <span className="mono dim ellipsis grow">
          {rel}:{hit.line}
        </span>
        <button className="btn sm ghost icon" title="Open file" onClick={() => api.openPath(hit.file)}>
          <FileText size={12} />
        </button>
        <button className="btn sm ghost icon" title="Show in folder" onClick={() => api.showItem(hit.file)}>
          <FolderOpen size={12} />
        </button>
      </div>
      <div className="mono hit-text">
        {i >= 0 ? (
          <>
            {hit.text.slice(0, i)}
            <mark>{hit.text.slice(i, i + query.length)}</mark>
            {hit.text.slice(i + query.length)}
          </>
        ) : (
          hit.text
        )}
      </div>
    </div>
  )
}

export function SearchView() {
  const s = useStore()
  const [q, setQ] = useState(s.searchQuery)
  const [scope, setScope] = useState<Scope>('active')
  const [res, setRes] = useState<XmlSearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const run = async (query = q, sc = scope) => {
    if (query.trim().length < 2) return
    setBusy(true)
    try {
      const pids = sc === 'active' ? s.active : [...new Set(s.app!.mods.map((m) => m.packageId))]
      setRes(await api.searchXml(query, pids))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    inputRef.current?.focus()
    if (s.searchQuery) {
      setQ(s.searchQuery)
      void run(s.searchQuery)
    }
  }, [s.searchQuery])

  const grouped = useMemo(() => {
    const m = new Map<string, XmlSearchHit[]>()
    for (const h of res?.hits ?? []) m.set(h.packageId, [...(m.get(h.packageId) ?? []), h])
    return [...m.entries()]
  }, [res])
  const name = (pid: string) => s.installed.get(pid)?.[0]?.name ?? pid
  const ModCell = ({ pid }: { pid: string }) => (
    <span style={{ width: 210, flex: 'none', paddingTop: 5 }} className="row">
      <ModIcon mod={s.installed.get(pid)?.[0]} size={18} />
      <span className="ellipsis" style={{ fontWeight: 560 }}>
        {name(pid)}
      </span>
    </span>
  )

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Search mod files</h1>
          <p>Searches every Defs and Patches XML file, including the game's own. Type a defName to see which mods define and patch it.</p>
        </div>
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <label className="pane-filter grow" style={{ margin: 0, height: 36 }}>
          <Search size={15} />
          <input
            ref={inputRef}
            value={q}
            placeholder="e.g. Steel, MarketValue, BaseWeapon, CompProperties_Refuelable…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
          />
        </label>
        <Seg<Scope>
          value={scope}
          onChange={(v) => {
            setScope(v)
            if (res) void run(q, v)
          }}
          options={[
            ['active', 'Active mods'],
            ['all', 'All installed'],
          ]}
        />
        <button className="btn primary" disabled={busy || q.trim().length < 2} onClick={() => run()}>
          <FileSearch size={14} /> {busy ? 'Searching…' : 'Search'}
        </button>
      </div>

      {res && (
        <>
          <p className="dim" style={{ margin: '0 0 12px', fontSize: 12 }}>
            {res.hits.length}
            {res.truncated ? '+' : ''} matching lines in {grouped.length} mods · {res.filesScanned.toLocaleString()} files searched in {res.ms} ms
            {res.truncated && ' · showing the first 500, refine the search for more'}
          </p>

          {(res.defines.length > 0 || res.patches.length > 0) && (
            <div className="panel" style={{ marginBottom: 12 }}>
              <div className="panel-head">
                <h3 className="grow">“{res.query}” as a def</h3>
                <span className="dim" style={{ fontSize: 12 }}>
                  Defined by {new Set(res.defines.map((d) => d.packageId)).size} · patched by {new Set(res.patches.map((p) => p.packageId)).size}
                </span>
              </div>
              <div className="panel-body col" style={{ gap: 4 }}>
                {res.defines.map((d, i) => (
                  <div key={'d' + i} className="row" style={{ alignItems: 'flex-start' }}>
                    <ModCell pid={d.packageId} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <Hit hit={d} query={res.query} label={'defines ' + d.key.split('/')[0]} />
                    </div>
                  </div>
                ))}
                {res.patches.map((p, i) => (
                  <div key={'p' + i} className="row" style={{ alignItems: 'flex-start' }}>
                    <ModCell pid={p.packageId} />
                    <div className="grow" style={{ minWidth: 0 }}>
                      <Hit hit={p} query={res.query} label={p.op.replace('PatchOperation', '') || 'Patch'} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {grouped.map(([pid, hits]) => (
            <div key={pid} className="panel">
              <div
                className="panel-head"
                style={{ cursor: 'pointer' }}
                onClick={() => {
                  s.select(pid)
                  s.setView('mods')
                }}
              >
                <ModIcon mod={s.installed.get(pid)?.[0]} size={20} />
                <h3 className="grow ellipsis">{name(pid)}</h3>
                {s.active.includes(pid) ? <span className="chip mono">#{s.active.indexOf(pid) + 1}</span> : <span className="chip">inactive</span>}
                <span className="count">{hits.length}</span>
              </div>
              <div className="panel-body" style={{ padding: '6px 10px' }}>
                {hits.slice(0, 40).map((h, i) => (
                  <Hit key={i} hit={h} query={res.query} />
                ))}
                {hits.length > 40 && (
                  <div className="dim" style={{ padding: 6, fontSize: 12 }}>
                    +{hits.length - 40} more in this mod
                  </div>
                )}
              </div>
            </div>
          ))}
          {!grouped.length && !res.defines.length && (
            <div className="panel">
              <div className="empty">No matches.</div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
