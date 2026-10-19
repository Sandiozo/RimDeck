import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { Gauge, RefreshCw, TriangleAlert } from 'lucide-react'
import type { LoadReport, ModCost } from '@shared/types'
import { useStore } from '../store'
import { api } from '../api'
import { bytes, timeAgo } from '../lib'
import { ModIcon } from '../components/ui'

const usePerf = create<{ report: LoadReport | null; busy: boolean }>(() => ({ report: null, busy: false }))

async function measure(active: string[]) {
  usePerf.setState({ busy: true })
  try {
    usePerf.setState({ report: await api.loadReport(active) })
  } finally {
    usePerf.setState({ busy: false })
  }
}

const secs = (ms: number) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`)

type SortKey = 'score' | 'textureBytes' | 'textures' | 'defs' | 'patches' | 'dllBytes'

export function PerformanceView() {
  const s = useStore()
  const { report, busy } = usePerf()
  const [sortKey, setSortKey] = useState<SortKey>('score')
  const [limit, setLimit] = useState(60)
  useEffect(() => {
    if (!report && !busy) void measure(s.active)
  }, [])

  const total = report?.mods.reduce((n, m) => n + m.score, 0) || 1
  // Estimated seconds: share of the measured mod-loading phases (when the log has them).
  const loadMs = report?.startup ? report.startup.phases.slice(1).reduce((n, p) => n + p.ms, 0) : 0
  const rows = useMemo(() => [...(report?.mods ?? [])].sort((a, b) => b[sortKey] - a[sortKey]), [report, sortKey])
  const slow = (report?.mods ?? []).filter((m) => m.slowPatches > 0).sort((a, b) => b.slowPatches - a.slowPatches)
  const bigTex = (report?.mods ?? []).filter((m) => m.textureBytes > 60 * 1048576).sort((a, b) => b.textureBytes - a.textureBytes)
  const name = (pid: string) => s.installed.get(pid)?.[0]?.name ?? pid
  const max = report?.startup ? Math.max(...report.startup.phases.map((p) => p.ms)) : 1

  const Th = ({ k, children }: { k: SortKey; children: React.ReactNode }) => (
    <th style={{ cursor: 'pointer', color: sortKey === k ? 'var(--text)' : undefined }} onClick={() => setSortKey(k)}>
      {children}
    </th>
  )

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Load time</h1>
          <p>Startup phases are measured from your last game log. The per-mod share is an estimate from what each mod ships, scaled to that measurement.</p>
        </div>
        <button className="btn" disabled={busy} onClick={() => measure(s.active)}>
          <RefreshCw size={14} className={busy ? 'spin' : ''} /> {busy ? 'Measuring…' : 'Refresh'}
        </button>
      </div>

      {!report && <div className="panel"><div className="empty">Reading the textures, sounds, XML and code of every active mod… The first run takes a few seconds.</div></div>}

      {report && (
        <>
          <div className="panel" style={{ marginBottom: 12 }}>
            <div className="panel-head">
              <Gauge size={16} color="var(--accent)" />
              <h3 className="grow">
                {report.startup ? `Last startup: ${secs(report.startup.toMenu)} to the main menu` : 'No startup timing found in the game log'}
              </h3>
              {report.startup && <span className="dim" style={{ fontSize: 12 }}>{timeAgo(report.startup.when)}{report.startup.saveLoad ? ` · loading a save took ${secs(report.startup.saveLoad)}` : ''}</span>}
            </div>
            {report.startup && (
              <div className="panel-body col" style={{ gap: 8 }}>
                {report.startup.phases.map((p) => (
                  <div key={p.label} className="row">
                    <span style={{ width: 230, flex: 'none' }} className="muted">{p.label}</span>
                    <div className="perf-bar grow"><span style={{ width: `${(p.ms / max) * 100}%` }} /></div>
                    <span className="mono" style={{ width: 70, textAlign: 'right' }}>{secs(p.ms)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {(slow.length > 0 || bigTex.length > 0) && (
            <div className="panel" style={{ marginBottom: 12 }}>
              <div className="panel-head">
                <TriangleAlert size={15} color="var(--warn)" />
                <h3>Possible slowdowns</h3>
              </div>
              <div className="panel-body col" style={{ gap: 6, fontSize: 12.5 }}>
                {slow.slice(0, 6).map((m) => (
                  <div key={'s' + m.packageId} className="row">
                    <ModIcon mod={s.installed.get(m.packageId)?.[0]} size={18} />
                    <b style={{ fontWeight: 600 }}>{name(m.packageId)}</b>
                    <span className="muted">uses {m.slowPatches} slow “//” patch searches, which scan the whole game data on every load</span>
                  </div>
                ))}
                {bigTex.slice(0, 6).map((m) => (
                  <div key={'t' + m.packageId} className="row">
                    <ModIcon mod={s.installed.get(m.packageId)?.[0]} size={18} />
                    <b style={{ fontWeight: 600 }}>{name(m.packageId)}</b>
                    <span className="muted">
                      ships {bytes(m.textureBytes)} of textures ({m.textures.toLocaleString()} files{m.dds ? `, ${m.dds} DDS` : ''})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="panel">
            <table className="table">
              <thead>
                <tr>
                  <th>Mod</th>
                  <Th k="score">Est. share</Th>
                  <Th k="textureBytes">Textures</Th>
                  <Th k="defs">Defs</Th>
                  <Th k="patches">Patches</Th>
                  <Th k="dllBytes">Code</Th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, limit).map((m: ModCost) => {
                  const share = m.score / total
                  return (
                    <tr key={m.packageId} className="click" onClick={() => { s.select(m.packageId); s.setView('mods') }}>
                      <td style={{ maxWidth: 300 }}>
                        <div className="row">
                          <ModIcon mod={s.installed.get(m.packageId)?.[0]} size={18} />
                          <span className="ellipsis" style={{ fontWeight: 560 }}>{name(m.packageId)}</span>
                        </div>
                      </td>
                      <td style={{ width: 190 }}>
                        <div className="row" style={{ gap: 8 }}>
                          <div className="perf-bar" style={{ width: 80 }}><span style={{ width: `${Math.min(100, share * 100 * 5)}%` }} /></div>
                          <span className="mono" style={{ fontSize: 11 }}>
                            {(share * 100).toFixed(1)}%{loadMs ? ` ≈${secs(share * loadMs)}` : ''}
                          </span>
                        </div>
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{m.textures ? `${m.textures.toLocaleString()} · ${bytes(m.textureBytes)}` : '—'}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{m.defs || '—'}</td>
                      <td className="mono" style={{ fontSize: 11.5 }}>
                        {m.patches || '—'}
                        {m.slowPatches > 0 && <span className="chip warn" style={{ marginLeft: 6 }}>{m.slowPatches} slow</span>}
                      </td>
                      <td className="mono" style={{ fontSize: 11.5 }}>{m.dllBytes ? `${bytes(m.dllBytes)}${m.harmonyPatches ? ` · ${m.harmonyPatches} patches` : ''}` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {rows.length > limit && (
              <button className="btn ghost sm" style={{ margin: 10 }} onClick={() => setLimit(limit + 100)}>
                Show more ({rows.length - limit})
              </button>
            )}
          </div>
          <p className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>Measured in {report.ms} ms. Click a column to sort.</p>
        </>
      )}
    </div>
  )
}
