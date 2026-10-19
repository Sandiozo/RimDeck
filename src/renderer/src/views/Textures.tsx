import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import { Crown, FolderOpen, RefreshCw, Search, TriangleAlert, ArrowDownToLine, Check, Undo2 } from 'lucide-react'
import type { TextureConflict, TextureReport } from '@shared/types'
import { isDirty, useStore } from '../store'
import { api, imgUrl } from '../api'
import { ModIcon, Seg } from '../components/ui'

// Package id of the generated mod that holds texture picks.
const PICKS = 'rimdeck.texturepicks'
type Picks = Record<string, { packageId: string; source: string; files: string[]; at: number }>
// Kept outside the view so switching tabs doesn't throw away a scan.
const useTex = create<{ report: TextureReport | null; scannedFor: string; busy: boolean; picks: Picks }>(() => ({ report: null, scannedFor: '', busy: false, picks: {} }))

async function scan(active: string[]) {
  useTex.setState({ busy: true })
  try {
    const [report, picks] = await Promise.all([api.textures(active), api.texturePicks()])
    useTex.setState({ report, picks, scannedFor: [...active].sort().join('|') })
  } catch (e: any) {
    useStore.getState().toast('error', `Could not scan textures: ${e.message}`)
  } finally {
    useTex.setState({ busy: false })
  }
}

type Mode = 'side' | 'slider' | 'diff'

interface Ordered extends TextureConflict {
  order: TextureConflict['entries'] // load order; last one is what the game shows
}

const isViewable = (f: string) => /\.(png|jpe?g|dds)$/i.test(f)

export function TexturesView() {
  const s = useStore()
  const { report, scannedFor, busy } = useTex()
  const [modFilter, setModFilter] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [limit, setLimit] = useState(300)

  useEffect(() => {
    if (!report && !busy) void scan(s.active)
  }, [])

  const stale = !!report && scannedFor !== [...s.active].sort().join('|')
  const pos = useMemo(() => new Map(s.active.map((id, i) => [id, i])), [s.active])
  const name = (pid: string) => s.installed.get(pid)?.[0]?.name ?? pid

  const conflicts: Ordered[] = useMemo(() => {
    if (!report) return []
    return report.conflicts
      .map((c) => ({ ...c, order: c.entries.filter((e) => pos.has(e.packageId)).sort((a, b) => pos.get(a.packageId)! - pos.get(b.packageId)!) }))
      .filter((c) => c.order.length > 1)
  }, [report, pos])

  const modStats = useMemo(() => {
    const m = new Map<string, { wins: number; loses: number }>()
    for (const c of conflicts) {
      c.order.forEach((e, i) => {
        const st = m.get(e.packageId) ?? { wins: 0, loses: 0 }
        if (i === c.order.length - 1) st.wins++
        else st.loses++
        m.set(e.packageId, st)
      })
    }
    return [...m.entries()]
      .map(([pid, st]) => ({ pid, ...st, total: report?.totals[pid] ?? 0 }))
      .sort((a, b) => b.loses - a.loses || b.wins - a.wins)
  }, [conflicts, report])

  const hidden = modStats.filter((m) => m.total >= 5 && m.loses / m.total >= 0.8)

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return conflicts.filter((c) => (!modFilter || c.order.some((e) => e.packageId === modFilter)) && (!q || c.key.includes(q)))
  }, [conflicts, modFilter, query])

  const current = conflicts.find((c) => c.key === selected) ?? visible[0] ?? null

  const makeWin = (pid: string, c: Ordered) => {
    const before = new Map(conflicts.map((x) => [x.key, x.order[x.order.length - 1].packageId]))
    const last = Math.max(...c.order.filter((e) => e.packageId !== pid).map((e) => pos.get(e.packageId)!))
    s.move([pid], last + 1)
    // Moving a mod flips every texture it shares with the mods it jumped over, not just this one.
    const after = useStore.getState().active
    const p2 = new Map(after.map((id, i) => [id, i]))
    let flipped = 0
    for (const x of conflicts) {
      const w = [...x.order].sort((a, b) => p2.get(a.packageId)! - p2.get(b.packageId)!).pop()!.packageId
      if (w !== before.get(x.key)) flipped++
    }
    const orderIssues = (useStore.getState().issuesByPid.get(pid) ?? []).filter((i) => i.kind === 'order' || i.kind === 'dep-order').length
    s.toast(
      orderIssues ? 'error' : 'ok',
      `Moved ${name(pid)} to #${useStore.getState().active.indexOf(pid) + 1} (${flipped} texture${flipped === 1 ? '' : 's'} changed)` +
        (orderIssues ? `. This breaks ${orderIssues} load-order rule${orderIssues === 1 ? '' : 's'}; see Problems.` : ''),
    )
  }

  // Copies one texture into the "RimDeck Texture Picks" mod, which is kept active and last so the pick wins.
  const pick = async (pid: string, c: Ordered) => {
    const e = c.order.find((x) => x.packageId === pid)!
    try {
      const r = await api.pickTexture(c.key, pid, e.file, e.dds)
      if (r.created) await s.reload()
      const st = useStore.getState()
      if (!st.active.includes(PICKS)) st.activate([PICKS])
      else if (st.active[st.active.length - 1] !== PICKS) st.move([PICKS], st.active.length)
      await scan(useStore.getState().active)
      const dirty = isDirty(useStore.getState())
      s.toast('ok', `Using ${name(pid)}'s version of ${c.key.split('/').pop()}` + (dirty ? '. Save your load order to apply it.' : ''))
    } catch (err: any) {
      s.toast('error', err.message)
    }
  }
  const unpick = async (c: Ordered) => {
    await api.unpickTexture(c.key)
    await scan(useStore.getState().active)
    s.toast('ok', 'Texture pick removed')
  }

  return (
    <div className="tex-page">
      <div className="page-head" style={{ padding: '22px 26px 0', margin: 0 }}>
        <div className="grow">
          <h1>Textures</h1>
          <p>
            When several active mods ship the same texture, the one loaded last is what you see in game.
            {report && ` ${report.textures.toLocaleString()} textures in ${report.scannedMods} mods · scanned in ${report.ms} ms.`}
          </p>
        </div>
        <button className="btn" disabled={busy} onClick={() => scan(s.active)}>
          <RefreshCw size={14} className={busy ? 'spin' : ''} /> Rescan
        </button>
      </div>

      {stale && (
        <div className="banner" style={{ margin: '12px 26px 0' }}>
          <TriangleAlert size={15} color="var(--warn)" />
          <span className="grow">Your active mods have changed since this scan.</span>
          <button className="btn sm" onClick={() => scan(s.active)}>
            Rescan
          </button>
        </div>
      )}

      <div className="cards" style={{ padding: '16px 26px 0', marginBottom: 12 }}>
        <div className="stat" style={{ cursor: 'default' }}>
          <div className="n">{report ? conflicts.length : '…'}</div>
          <div className="l">Conflicting textures</div>
        </div>
        <div className="stat" style={{ cursor: 'default' }}>
          <div className="n">{report ? modStats.length : '…'}</div>
          <div className="l">Mods involved</div>
        </div>
        <div className="stat" style={{ cursor: hidden.length ? 'pointer' : 'default' }} onClick={() => hidden[0] && setModFilter(hidden[0].pid)}>
          <div className="n" style={{ color: hidden.length ? 'var(--warn)' : undefined }}>{report ? hidden.length : '…'}</div>
          <div className="l">Mostly hidden mods (80%+ overridden)</div>
        </div>
      </div>

      <div className="tex-view">
        <section className="pane">
          <div className="pane-head">
            <span className="pane-title">Mods</span>
            <span className="count">{modStats.length}</span>
          </div>
          <div className="list">
            <div className={'tex-mod' + (!modFilter ? ' on' : '')} onClick={() => setModFilter(null)}>
              <span className="grow">All conflicts</span>
              <span className="count">{conflicts.length}</span>
            </div>
            {modStats.map((m) => {
              const lossPct = m.total ? Math.round((m.loses / m.total) * 100) : 0
              return (
                <div key={m.pid} className={'tex-mod' + (modFilter === m.pid ? ' on' : '')} onClick={() => setModFilter(m.pid)}>
                  <ModIcon mod={s.installed.get(m.pid)?.[0]} size={22} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 560 }}>{name(m.pid)}</div>
                    <div className="dim" style={{ fontSize: 11 }}>
                      shown {m.wins} · hidden {m.loses} of {m.total}
                    </div>
                    <div className="tex-bar">
                      <span style={{ width: `${lossPct}%` }} className={lossPct >= 80 ? 'bad' : ''} />
                    </div>
                  </div>
                  <span className="mono dim" style={{ fontSize: 10.5 }}>#{(pos.get(m.pid) ?? 0) + 1}</span>
                </div>
              )
            })}
            {report && !modStats.length && <div className="empty">No texture conflicts between your active mods.</div>}
            {!report && <div className="empty">Scanning textures…</div>}
          </div>
        </section>

        <section className="pane">
          <label className="pane-filter" style={{ marginTop: 10 }}>
            <Search size={13} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter texture paths…" />
            <span className="count">{visible.length}</span>
          </label>
          <div className="list">
            {visible.slice(0, limit).map((c) => {
              const parts = c.key.split('/')
              const winner = c.order[c.order.length - 1].packageId
              return (
                <div key={c.key} className={'tex-row' + (current?.key === c.key ? ' on' : '')} onClick={() => setSelected(c.key)}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis">
                      <span className="dim">{parts.slice(0, -1).join('/')}/</span>
                      <b style={{ fontWeight: 600 }}>{parts[parts.length - 1]}</b>
                    </div>
                    <div className="ellipsis dim" style={{ fontSize: 11 }}>
                      <Crown size={10} style={{ verticalAlign: -1, color: 'var(--warn)' }} /> {name(winner)}
                    </div>
                  </div>
                  <span className="chip mono">×{c.order.length}</span>
                </div>
              )
            })}
            {visible.length > limit && (
              <button className="btn ghost sm" style={{ margin: 8 }} onClick={() => setLimit(limit + 500)}>
                Show more ({visible.length - limit})
              </button>
            )}
          </div>
        </section>

        <section className="pane">
          {current ? <Compare key={current.key} c={current} name={name} pos={pos} onWin={makeWin} onPick={pick} onUnpick={unpick} /> : <div className="empty">Select a texture to compare.</div>}
        </section>
      </div>
    </div>
  )
}

function Compare({
  c,
  name,
  pos,
  onWin,
  onPick,
  onUnpick,
}: {
  c: Ordered
  name: (pid: string) => string
  pos: Map<string, number>
  onWin: (pid: string, c: Ordered) => void
  onPick: (pid: string, c: Ordered) => void
  onUnpick: (c: Ordered) => void
}) {
  const picked = useTex((t) => t.picks[c.key])
  const [mode, setMode] = useState<Mode>('side')
  const [pixelated, setPixelated] = useState(true)
  const winner = c.order[c.order.length - 1]
  const [other, setOther] = useState(c.order[c.order.length - 2].packageId)
  const b = c.order.find((e) => e.packageId === other) ?? c.order[0]
  const [split, setSplit] = useState(50)
  const imgClass = 'tex-img' + (pixelated ? ' px' : '')

  return (
    <div className="compare">
      <div className="pane-head" style={{ flexWrap: 'wrap', gap: 8 }}>
        <span className="mono ellipsis grow" style={{ minWidth: 160 }} title={c.key}>
          {c.key}
        </span>
        <Seg<Mode>
          value={mode}
          onChange={setMode}
          options={[
            ['side', 'Side by side'],
            ['slider', 'Slider'],
            ['diff', 'Difference'],
          ]}
        />
        <button className={'btn sm' + (pixelated ? ' on' : '')} title="Show pixels sharply when zoomed" onClick={() => setPixelated(!pixelated)}>
          Pixels
        </button>
      </div>

      {mode !== 'side' && (
        <div className="row" style={{ padding: '0 12px 8px', flexWrap: 'wrap', gap: 6 }}>
          <span className="dim" style={{ fontSize: 12 }}>
            In game: <b style={{ color: 'var(--text)' }}>{name(winner.packageId)}</b> vs
          </span>
          {c.order.slice(0, -1).map((e) => (
            <button key={e.packageId} className={'chip click' + (e.packageId === b.packageId ? ' accent' : '')} onClick={() => setOther(e.packageId)}>
              {name(e.packageId)}
            </button>
          ))}
        </div>
      )}

      <div className="compare-body">
        {mode === 'side' && (
          <div className="tex-grid">
            {[...c.order].reverse().map((e) => {
              const isWinner = e === winner
              return (
                <div key={e.packageId} className={'tex-card' + (isWinner ? ' winner' : '')}>
                  <TexImage key={e.file} file={e.file} className={imgClass} />
                  <div className="tex-meta">
                    <div className="row" style={{ gap: 6 }}>
                      {isWinner && <Crown size={13} color="var(--warn)" />}
                      <span className="ellipsis grow" style={{ fontWeight: 600 }}>
                        {e.packageId === PICKS ? `Your pick${picked ? ` (from ${name(picked.packageId)})` : ''}` : name(e.packageId)}
                      </span>
                      <span className="mono dim" style={{ fontSize: 10.5 }}>#{pos.get(e.packageId)! + 1}</span>
                    </div>
                    <div className="row" style={{ gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
                      {isWinner ? <span className="chip ok">Shown in game</span> : <span className="chip">Hidden</span>}
                      {picked?.packageId === e.packageId && <span className="chip accent">Picked</span>}
                      {e.dds && <span className="chip" title="A .dds copy exists; the game may load that instead">dds</span>}
                      <span className="grow" />
                      <button className="btn sm ghost icon" title="Show file" onClick={() => api.showItem(e.file)}>
                        <FolderOpen size={12} />
                      </button>
                      {e.packageId === PICKS ? (
                        <button className="btn sm" title="Delete the copied texture so the load order decides again" onClick={() => onUnpick(c)}>
                          <Undo2 size={12} /> Undo pick
                        </button>
                      ) : (
                        picked?.packageId !== e.packageId &&
                        (!isWinner || picked) && (
                          <>
                            <button className="btn sm primary" title="Use this version for this texture only (copied into the RimDeck Texture Picks mod)" onClick={() => onPick(e.packageId, c)}>
                              <Check size={12} /> Use this one
                            </button>
                            {!isWinner && (
                              <button className="btn sm ghost" title="Move the whole mod below the others, so all its shared textures win" onClick={() => onWin(e.packageId, c)}>
                                <ArrowDownToLine size={12} /> Mod wins all
                              </button>
                            )}
                          </>
                        )
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {mode === 'slider' && (
          <div className="slider-wrap">
            <div className="slider-stage">
              <TexImage key={b.file} file={b.file} className={imgClass} />
              <div className="slider-top" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
                <TexImage key={winner.file} file={winner.file} className={imgClass} />
              </div>
              <div className="slider-line" style={{ left: `${split}%` }} />
              <span className="slider-tag left">{name(b.packageId)}</span>
              <span className="slider-tag right">{name(winner.packageId)} (in game)</span>
            </div>
            <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} className="slider-range" />
          </div>
        )}

        {mode === 'diff' && <Diff a={winner.file} b={b.file} pixelated={pixelated} />}
      </div>
    </div>
  )
}

function TexImage({ file, className }: { file: string; className: string }) {
  const [dims, setDims] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  if (!isViewable(file) || failed)
    return (
      <div className="tex-box">
        <div className="tex-none">
          <b>{file.split('.').pop()?.toUpperCase()}</b>
          <span>No preview for this format</span>
        </div>
      </div>
    )
  return (
    <div className="tex-box">
      <img
        src={imgUrl(file)}
        className={className}
        draggable={false}
        onLoad={(e) => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
        onError={() => setFailed(true)}
      />
      {dims && <span className="tex-dims">{dims}</span>}
    </div>
  )
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

// Pixels that differ are painted red over a dimmed copy of the in-game texture.
function Diff({ a, b, pixelated }: { a: string; b: string; pixelated: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [stats, setStats] = useState<string>('Comparing…')
  useEffect(() => {
    if (!isViewable(a) || !isViewable(b)) return setStats('Difference needs PNG or JPG on both sides.')
    let cancelled = false
    Promise.all([loadImage(imgUrl(a)), loadImage(imgUrl(b))])
      .then(([ia, ib]) => {
        if (cancelled || !ref.current) return
        const w = ia.naturalWidth
        const h = ia.naturalHeight
        const draw = (img: HTMLImageElement) => {
          const c = document.createElement('canvas')
          c.width = w
          c.height = h
          const ctx = c.getContext('2d', { willReadFrequently: true })!
          ctx.drawImage(img, 0, 0, w, h)
          return ctx.getImageData(0, 0, w, h)
        }
        const da = draw(ia).data
        const db = draw(ib).data
        const canvas = ref.current
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')!
        const out = ctx.createImageData(w, h)
        let changed = 0
        for (let i = 0; i < da.length; i += 4) {
          const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]), Math.abs(da[i + 3] - db[i + 3]))
          if (d > 24) {
            changed++
            out.data[i] = 255
            out.data[i + 1] = 60
            out.data[i + 2] = 90
            out.data[i + 3] = 255
          } else {
            const g = (da[i] + da[i + 1] + da[i + 2]) / 3
            out.data[i] = out.data[i + 1] = out.data[i + 2] = g * 0.35
            out.data[i + 3] = da[i + 3] * 0.6
          }
        }
        ctx.putImageData(out, 0, 0)
        const pct = (changed / (w * h)) * 100
        const sizeNote = ib.naturalWidth !== w || ib.naturalHeight !== h ? ` · sizes differ (${w}×${h} vs ${ib.naturalWidth}×${ib.naturalHeight}), compared at ${w}×${h}` : ''
        setStats(changed === 0 ? `Identical pixels${sizeNote}` : `${pct < 0.1 ? '<0.1' : pct.toFixed(1)}% of pixels differ${sizeNote}`)
      })
      .catch(() => setStats('Could not load the images.'))
    return () => {
      cancelled = true
    }
  }, [a, b])
  return (
    <div className="slider-wrap">
      <div className="tex-box" style={{ flex: 1 }}>
        <canvas ref={ref} className={'tex-img' + (pixelated ? ' px' : '')} />
      </div>
      <div className="dim" style={{ textAlign: 'center', fontSize: 12, padding: 8 }}>
        {stats}
      </div>
    </div>
  )
}
