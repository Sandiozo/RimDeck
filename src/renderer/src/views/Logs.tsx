import { useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, RefreshCw, Search } from 'lucide-react'
import type { LogEntry, LogReport } from '@shared/types'
import { useStore } from '../store'
import { api } from '../api'
import { searchTerms, timeAgo } from '../lib'
import { Seg } from '../components/ui'

export function LogsView() {
  const s = useStore()
  const [report, setReport] = useState<LogReport | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [level, setLevel] = useState<'all' | LogEntry['level']>('all')
  const [q, setQ] = useState('')
  const [modFilter, setModFilter] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())

  const load = async () => {
    setBusy(true)
    try {
      setReport(await api.readLog())
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    load()
  }, [])

  const entries = useMemo(() => {
    const t = q.toLowerCase()
    return (report?.entries ?? []).filter(
      (e) => (level === 'all' || e.level === level) && (!modFilter || e.mods.includes(modFilter)) && (!t || e.message.toLowerCase().includes(t) || e.stack.toLowerCase().includes(t)),
    )
  }, [report, level, q, modFilter])

  const topMods = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of report?.entries ?? []) if (e.level !== 'warning') for (const pid of e.mods) m.set(pid, (m.get(pid) ?? 0) + e.count)
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)
  }, [report])

  const name = (pid: string) => s.installed.get(pid)?.[0]?.name ?? pid
  const counts = { exception: 0, error: 0, warning: 0 }
  for (const e of report?.entries ?? []) counts[e.level]++

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Game log</h1>
          <p>
            {report
              ? `${report.path} · ${report.lines.toLocaleString()} lines · written ${timeAgo(report.mtime)}`
              : report === null
                ? 'No Player.log found. Launch the game once to create it.'
                : 'Reading Player.log…'}
          </p>
        </div>
        {report && (
          <button className="btn" onClick={() => api.showItem(report.path)}>
            <FolderOpen size={14} /> Show file
          </button>
        )}
        <button className="btn" onClick={load} disabled={busy}>
          <RefreshCw size={14} className={busy ? 'spin' : ''} /> Reload
        </button>
      </div>

      {report && (
        <>
          <div className="cards">
            <div className="stat" style={{ cursor: 'default' }}>
              <div className="n" style={{ color: counts.exception ? 'var(--err)' : undefined }}>{counts.exception}</div>
              <div className="l">Exceptions</div>
            </div>
            <div className="stat" style={{ cursor: 'default' }}>
              <div className="n" style={{ color: counts.error ? '#ff8a5c' : undefined }}>{counts.error}</div>
              <div className="l">Errors</div>
            </div>
            <div className="stat" style={{ cursor: 'default' }}>
              <div className="n" style={{ color: counts.warning ? 'var(--warn)' : undefined }}>{counts.warning}</div>
              <div className="l">Warnings</div>
            </div>
            <div className="stat" style={{ cursor: 'default' }}>
              <div className="n" style={{ fontSize: 16, paddingTop: 8 }}>{report.gameVersion ?? '—'}</div>
              <div className="l">Logged game version</div>
            </div>
          </div>

          {topMods.length > 0 && (
            <div className="panel" style={{ marginBottom: 12 }}>
              <div className="panel-head">
                <h3>Mods named in errors</h3>
                <span className="dim" style={{ fontSize: 12 }}>From stack traces, Harmony patch info and mod namespaces</span>
              </div>
              <div className="panel-body row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {topMods.map(([pid, n]) => (
                  <button key={pid} className={'chip click' + (modFilter === pid ? ' accent' : '')} onClick={() => setModFilter(modFilter === pid ? null : pid)}>
                    {name(pid)} · {n}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="panel">
            <div className="panel-head">
              <Seg
                value={level}
                onChange={setLevel}
                options={[
                  ['all', 'All'],
                  ['exception', 'Exceptions'],
                  ['error', 'Errors'],
                  ['warning', 'Warnings'],
                ]}
              />
              <label className="pane-filter grow" style={{ margin: 0 }}>
                <Search size={13} />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search messages and stack traces…" />
              </label>
              <span className="count">{entries.length}</span>
            </div>
            {entries.slice(0, 400).map((e) => {
              const isOpen = open.has(e.key)
              return (
                <div key={e.key} className="log-entry">
                  <div
                    className="head"
                    onClick={() => {
                      const n = new Set(open)
                      isOpen ? n.delete(e.key) : n.add(e.key)
                      setOpen(n)
                    }}
                  >
                    {e.stack ? isOpen ? <ChevronDown size={14} className="dim" /> : <ChevronRight size={14} className="dim" /> : <span style={{ width: 14 }} />}
                    <span className={'lvl ' + e.level}>{e.level}</span>
                    <div className="grow">
                      <div className="log-msg">{e.message.length > 400 && !isOpen ? e.message.slice(0, 400) + '…' : e.message}</div>
                      {(e.mods.length > 0 || searchTerms(e.message).length > 0) && (
                        <div className="row" style={{ marginTop: 5, flexWrap: 'wrap', gap: 4 }}>
                          {searchTerms(e.message).map((t) => (
                            <span
                              key={'q' + t}
                              className="chip click"
                              title={`Find which mods define or use ${t}`}
                              onClick={(ev) => {
                                ev.stopPropagation()
                                s.openSearch(t)
                              }}
                            >
                              <Search size={10} /> {t}
                            </span>
                          ))}
                          {e.mods.map((pid) => (
                            <span
                              key={pid}
                              className="chip click accent"
                              onClick={(ev) => {
                                ev.stopPropagation()
                                s.select(pid)
                                s.setView('mods')
                              }}
                            >
                              {name(pid)}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    {e.count > 1 && <span className="chip mono">×{e.count}</span>}
                    <span className="dim mono" style={{ fontSize: 10.5 }}>L{e.firstLine}</span>
                  </div>
                  {isOpen && e.stack && <pre>{e.stack}</pre>}
                </div>
              )
            })}
            {!entries.length && <div className="empty">No matching entries.</div>}
          </div>
        </>
      )}
    </div>
  )
}
