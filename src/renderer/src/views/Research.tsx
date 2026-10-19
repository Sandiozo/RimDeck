import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type WheelEvent } from 'react'
import { FileText, FlaskConical, Maximize2, RefreshCw, Search, TriangleAlert, X } from 'lucide-react'
import type { ResearchNode } from '@shared/types'
import { useStore } from '../store'
import { api } from '../api'
import { loadDefs, modColor, useDefs } from '../defStore'
import { ModIcon, Seg } from '../components/ui'

const SX = 190 // px per researchViewX unit (close to the game's own research screen)
const SY = 100 // px per researchViewY unit
const W = 140
const H = 44

const ERAS = ['Neolithic', 'Medieval', 'Industrial', 'Spacer', 'Ultra', 'Archotech', 'Animal', 'Undefined']
const ALL_TABS = '__all'
const ERA_ROWS = 18
type Layout = 'tree' | 'era' | 'game'

const TECH_COLOR: Record<string, string> = {
  Animal: '#9aa3b2',
  Neolithic: '#c9925a',
  Medieval: '#d9b44a',
  Industrial: '#7fa6c9',
  Spacer: '#4fd1c5',
  Ultra: '#b58cff',
  Archotech: '#ff7ab0',
}

interface Issues {
  overlaps: Map<string, string[]> // defName -> others at the same spot
  missing: { node: string; prereq: string }[]
  loops: string[][]
}

function findIssues(nodes: Map<string, ResearchNode>): Issues {
  const spots = new Map<string, string[]>()
  for (const n of nodes.values()) {
    const k = `${n.tab}|${Math.round(n.x * 4)}|${Math.round(n.y * 4)}`
    spots.set(k, [...(spots.get(k) ?? []), n.defName])
  }
  const overlaps = new Map<string, string[]>()
  for (const list of spots.values()) if (list.length > 1) for (const d of list) overlaps.set(d, list.filter((x) => x !== d))
  const missing: Issues['missing'] = []
  for (const n of nodes.values()) for (const p of n.prerequisites) if (!nodes.has(p)) missing.push({ node: n.defName, prereq: p })
  const loops: string[][] = []
  const state = new Map<string, number>()
  const stack: string[] = []
  const visit = (d: string) => {
    state.set(d, 1)
    stack.push(d)
    for (const p of nodes.get(d)?.prerequisites ?? []) {
      if (!nodes.has(p)) continue
      if (state.get(p) === 1) loops.push(stack.slice(stack.indexOf(p)))
      else if (!state.get(p)) visit(p)
    }
    stack.pop()
    state.set(d, 2)
  }
  for (const d of nodes.keys()) if (!state.get(d)) visit(d)
  return { overlaps, missing, loops }
}

export function ResearchView() {
  const s = useStore()
  const { data, busy, scannedFor, error } = useDefs()
  const [tab, setTab] = useState('Main')
  const [q, setQ] = useState('')
  const [modFilter, setModFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [layoutMode, setLayoutMode] = useState<Layout>('tree')
  const [era, setEra] = useState('')
  const [view, setView] = useState({ x: 40, y: 40, k: 0.8 })
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!data && !busy) void loadDefs(s.active)
  }, [])
  const stale = !!data && scannedFor !== s.active.join('|')

  const nodes = useMemo(() => new Map((data?.research.nodes ?? []).map((n) => [n.defName, n])), [data])
  const issues = useMemo(() => findIssues(nodes), [nodes])
  const dependents = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const n of nodes.values()) for (const p of n.prerequisites) m.set(p, [...(m.get(p) ?? []), n.defName])
    return m
  }, [nodes])
  const tabs = useMemo(() => {
    const count = new Map<string, number>()
    for (const n of nodes.values()) count.set(n.tab, (count.get(n.tab) ?? 0) + 1)
    return (data?.research.tabs ?? []).filter((t) => count.get(t.defName)).map((t) => ({ ...t, count: count.get(t.defName)! }))
  }, [data, nodes])
  const shown = useMemo(() => [...nodes.values()].filter((n) => tab === ALL_TABS || n.tab === tab), [nodes, tab])
  const shownSet = useMemo(() => new Set(shown.map((n) => n.defName)), [shown])
  const eraCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of shown) m.set(n.techLevel, (m.get(n.techLevel) ?? 0) + 1)
    return ERAS.filter((e) => m.get(e)).map((e) => [e, m.get(e)!] as const)
  }, [shown])
  const modsHere = useMemo(() => [...new Set(shown.map((n) => n.packageId))], [shown])

  // Two ways to draw a tab:
  //  - 'tree': keeps the game's left-to-right columns (each distinct X gets its own lane, so half-steps don't
  //    collide sideways) and stacks each column in the game's top-to-bottom order without overlaps;
  //  - 'game': the raw XML positions, with colliding nodes pushed down just enough to stay readable.
  const eraBands = useMemo(() => {
    const out: { label: string; list: ResearchNode[]; left: number; width: number }[] = []
    let x = 0
    for (const e of ERAS) {
      const list = shown.filter((n) => (ERAS.includes(n.techLevel) ? n.techLevel : 'Undefined') === e).sort((a, b) => a.x - b.x || a.y - b.y)
      if (!list.length) continue
      const cols = Math.ceil(list.length / ERA_ROWS)
      out.push({ label: e, list, left: x, width: cols * (W + 24) - 24 })
      x += cols * (W + 24) + 90
    }
    return out
  }, [shown])
  const layout = useMemo(() => {
    const out = new Map<string, { left: number; top: number; moved: boolean }>()
    if (layoutMode === 'era') {
      // One band per era (in tech order), each split into columns of ROWS so big eras stay viewable.
      for (const b of eraBands) b.list.forEach((n, i) => out.set(n.defName, { left: b.left + Math.floor(i / ERA_ROWS) * (W + 24), top: (i % ERA_ROWS) * (H + 10), moved: false }))
      return out
    }
    if (layoutMode === 'tree') {
      const lanes = [...new Set(shown.map((n) => Math.round(n.x * 4) / 4))].sort((a, b) => a - b)
      const lane = new Map(lanes.map((x, i) => [x, i]))
      const cols = new Map<number, ResearchNode[]>()
      for (const n of shown) {
        const i = lane.get(Math.round(n.x * 4) / 4)!
        cols.set(i, [...(cols.get(i) ?? []), n])
      }
      for (const [i, list] of cols) {
        let next = -Infinity
        for (const n of list.sort((a, b) => a.y - b.y || a.label.localeCompare(b.label))) {
          const top = Math.max(n.y * SY * 0.6, next)
          out.set(n.defName, { left: i * (W + 50), top, moved: false })
          next = top + H + 10
        }
      }
      return out
    }
    const GAP = 4
    const placed: { l: number; t: number }[] = []
    for (const n of [...shown].sort((a, b) => a.x - b.x || a.y - b.y)) {
      const left = n.x * SX
      let top = n.y * SY
      for (let guard = 0; guard < 400; guard++) {
        const hit = placed.find((r) => left < r.l + W + GAP && left + W + GAP > r.l && top < r.t + H + GAP && top + H + GAP > r.t)
        if (!hit) break
        top = hit.t + H + GAP
      }
      placed.push({ l: left, t: top })
      out.set(n.defName, { left, top, moved: Math.abs(top - n.y * SY) > 0.5 })
    }
    return out
  }, [shown, layoutMode, dependents, eraBands])
  const at = (n: ResearchNode) => layout.get(n.defName) ?? { left: n.x * SX, top: n.y * SY, moved: false }
  const name = (pid: string) => s.installed.get(pid)?.[0]?.name ?? pid

  // Highlight the selected project's whole prerequisite chain and what it leads to.
  const chain = useMemo(() => {
    if (!selected) return null
    const set = new Set<string>([selected])
    const up = (d: string) => nodes.get(d)?.prerequisites.forEach((p) => !set.has(p) && (set.add(p), up(p)))
    const down = (d: string) => dependents.get(d)?.forEach((c) => !set.has(c) && (set.add(c), down(c)))
    up(selected)
    down(selected)
    return set
  }, [selected, nodes, dependents])

  const query = q.trim().toLowerCase()
  const matches = (n: ResearchNode) =>
    (!query || n.label.toLowerCase().includes(query) || n.defName.toLowerCase().includes(query)) &&
    (!modFilter || n.packageId === modFilter) &&
    (!era || n.techLevel === era)

  const fit = (list = shown) => {
    const box = boxRef.current
    if (!box || !list.length) return
    const xs = list.map((n) => at(n).left)
    const ys = list.map((n) => at(n).top)
    const w = Math.max(...xs) - Math.min(...xs) + W + 80
    const h = Math.max(...ys) - Math.min(...ys) + H + 80
    const k = Math.min(1.2, Math.max(0.15, Math.min(box.clientWidth / w, box.clientHeight / h)))
    setView({ k, x: -Math.min(...xs) * k + 40, y: -Math.min(...ys) * k + (layoutMode === 'era' ? 70 : 40) })
  }
  useEffect(() => fit(), [tab, data, layoutMode])

  const focus = (d: string) => {
    const n = nodes.get(d)
    if (!n) return
    setSelected(d)
    if (tab !== ALL_TABS && n.tab !== tab) setTab(n.tab)
    const box = boxRef.current
    if (box)
      setTimeout(() => {
        setView((v) => {
          const k = Math.max(v.k, 0.8)
          const p = at(n)
          return { k, x: box.clientWidth / 2 - (p.left + W / 2) * k, y: box.clientHeight / 2 - (p.top + H / 2) * k }
        })
      }, 0)
  }

  const onWheel = (e: WheelEvent) => {
    const rect = boxRef.current!.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.12, v.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)))
      return { k, x: mx - ((mx - v.x) * k) / v.k, y: my - ((my - v.y) * k) / v.k }
    })
  }
  const onDown = (e: ReactMouseEvent) => {
    if ((e.target as HTMLElement).closest('.rnode')) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }
  }
  const onMove = (e: ReactMouseEvent) => {
    const d = drag.current
    if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }))
  }

  const sel = selected ? nodes.get(selected) : undefined
  const issueCount = issues.overlaps.size + issues.missing.length + issues.loops.length

  return (
    <div className="tex-page">
      <div className="page-head" style={{ padding: '22px 26px 0', margin: 0 }}>
        <div className="grow">
          <h1>Research</h1>
          <p>
            {data
              ? `${nodes.size} projects from ${new Set([...nodes.values()].map((n) => n.packageId)).size} mods, positions after XML patches (${data.research.ms} ms).`
              : 'Reading research from every active mod…'}{' '}
            Changes that mods make to the tree in code at runtime are not shown.
          </p>
        </div>
        <button className="btn" disabled={busy} onClick={() => loadDefs(s.active)}>
          <RefreshCw size={14} className={busy ? 'spin' : ''} /> {busy ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {stale && (
        <div className="banner" style={{ margin: '12px 26px 0' }}>
          <TriangleAlert size={15} color="var(--warn)" />
          <span className="grow">Your load order has changed since this data was read.</span>
          <button className="btn sm" onClick={() => loadDefs(s.active)}>
            Refresh
          </button>
        </div>
      )}
      {error && <div className="banner err" style={{ margin: '12px 26px 0' }}>{error}</div>}

      <div className="row" style={{ padding: '14px 26px 10px', gap: 8, flexWrap: 'wrap' }}>
        <select className="input" value={tab} onChange={(e) => { setTab(e.target.value); setSelected(null) }} style={{ minWidth: 200 }}>
          <option value={ALL_TABS}>All tabs ({nodes.size})</option>
          {tabs.map((t) => (
            <option key={t.defName} value={t.defName}>
              {t.label} ({t.count})
            </option>
          ))}
        </select>
        <label className="pane-filter" style={{ margin: 0, width: 260 }}>
          <Search size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a project…" />
          {q && (
            <button className="btn ghost sm icon" onClick={() => setQ('')}>
              <X size={12} />
            </button>
          )}
        </label>
        <select className="input" value={modFilter} onChange={(e) => setModFilter(e.target.value)} style={{ maxWidth: 240 }}>
          <option value="">All mods on this tab ({modsHere.length})</option>
          {modsHere.map((p) => (
            <option key={p} value={p}>
              {name(p)}
            </option>
          ))}
        </select>
        <Seg<Layout>
          value={layoutMode}
          onChange={setLayoutMode}
          options={[
            ['tree', 'Tidy tree'],
            ['era', 'By era'],
            ['game', 'Game positions'],
          ]}
        />
        <button className="btn sm" onClick={() => fit()} title="Fit tab to view">
          <Maximize2 size={12} /> Fit
        </button>
        <span className="grow" />
        <span className="dim" style={{ fontSize: 12 }}>Drag to pan · scroll to zoom</span>
      </div>
      <div className="row" style={{ padding: '0 26px 10px', gap: 6, flexWrap: 'wrap' }}>
        <span className="dim" style={{ fontSize: 12 }}>Era</span>
        <button className={'chip click' + (!era ? ' accent' : '')} onClick={() => setEra('')}>
          All
        </button>
        {eraCounts.map(([e, c]) => (
          <button
            key={e}
            className={'chip click' + (era === e ? ' accent' : '')}
            style={era === e ? undefined : { color: TECH_COLOR[e] ?? undefined }}
            onClick={() => setEra(era === e ? '' : e)}
          >
            <span className="dot" style={{ background: TECH_COLOR[e] ?? 'var(--text-4)' }} /> {e} · {c}
          </button>
        ))}
      </div>

      <div className="research-wrap">
        <div ref={boxRef} className="research-canvas" onWheel={onWheel} onMouseDown={onDown} onMouseMove={onMove} onMouseUp={() => (drag.current = null)} onMouseLeave={() => (drag.current = null)}>
          <div className="research-inner" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
            {layoutMode === 'era' &&
              eraBands.map((b) => (
                <div key={b.label} className="era-band" style={{ left: b.left - 12, width: b.width + 24, borderColor: TECH_COLOR[b.label] ?? 'var(--line-3)' }}>
                  <span style={{ color: TECH_COLOR[b.label] ?? 'var(--text-2)' }}>{b.label}</span> <span className="dim">{b.list.length}</span>
                </div>
              ))}
            <svg className="research-edges" style={{ overflow: 'visible' }}>
              {shown.flatMap((n) =>
                n.prerequisites
                  .map((p) => nodes.get(p))
                  .filter((p): p is ResearchNode => !!p && shownSet.has(p.defName))
                  .map((p) => {
                    const x1 = at(p).left + W
                    const y1 = at(p).top + H / 2
                    const x2 = at(n).left
                    const y2 = at(n).top + H / 2
                    const mid = (x1 + x2) / 2
                    const on = chain ? chain.has(n.defName) && chain.has(p.defName) : false
                    return (
                      <path
                        key={p.defName + '>' + n.defName}
                        d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                        className={'redge' + (on ? ' on' : chain ? ' dim' : '')}
                      />
                    )
                  }),
              )}
            </svg>
            {shown.map((n) => {
              const dim = (chain && !chain.has(n.defName)) || !matches(n)
              const overlap = issues.overlaps.has(n.defName)
              const offTab = n.prerequisites.filter((p) => nodes.get(p) && !shownSet.has(p)).length
              return (
                <div
                  key={n.defName}
                  className={'rnode' + (selected === n.defName ? ' sel' : '') + (dim ? ' dim' : '') + (overlap ? ' overlap' : '') + (query && matches(n) ? ' hit' : '')}
                  style={{ left: at(n).left, top: at(n).top, width: W, height: H, borderColor: TECH_COLOR[n.techLevel] ?? 'var(--line-3)' }}
                  onClick={() => setSelected(selected === n.defName ? null : n.defName)}
                  title={`${n.label} — ${name(n.packageId)}` + (at(n).moved ? `
Shown lower so that it is not hidden. In game it is at ${n.x.toFixed(2)}, ${n.y.toFixed(2)}.` : '')}
                >
                  <span className="rstripe" style={{ background: modColor(n.packageId) }} />
                  <span className="rlabel">{n.label}</span>
                  <span className="rcost">
                    {n.cost}
                    {offTab > 0 && <span title="Has prerequisites on another tab"> ↗{offTab}</span>}
                    {overlap && <span style={{ color: 'var(--err)' }}> ●</span>}
                    {at(n).moved && <span title="Moved down for display"> ↓</span>}
                  </span>
                </div>
              )
            })}
          </div>
        </div>

        <aside className="pane research-side">
          {sel ? (
            <div className="details-body" style={{ marginTop: 0, paddingTop: 14, overflow: 'auto' }}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <FlaskConical size={18} color={TECH_COLOR[sel.techLevel] ?? 'var(--accent)'} style={{ marginTop: 3 }} />
                <div className="grow">
                  <h2 style={{ fontSize: 16 }}>{sel.label}</h2>
                  <div className="mono dim" style={{ fontSize: 11 }}>{sel.defName}</div>
                </div>
                <button className="btn sm ghost icon" onClick={() => setSelected(null)}>
                  <X size={13} />
                </button>
              </div>
              <div className="chips">
                <span className="chip click" onClick={() => { s.select(sel.packageId); s.setView('mods') }}>
                  <ModIcon mod={s.installed.get(sel.packageId)?.[0]} size={12} /> {name(sel.packageId)}
                </span>
                <span className="chip" style={{ color: TECH_COLOR[sel.techLevel] }}>{sel.techLevel}</span>
                <span className="chip">{sel.cost} pts</span>
                <span className="chip mono">
                  {sel.x.toFixed(2)}, {sel.y.toFixed(2)}
                </span>
              </div>
              {issues.overlaps.has(sel.defName) && (
                <div className="issue-card error" style={{ marginTop: 10 }}>
                  <div className="t">Overlaps {issues.overlaps.get(sel.defName)!.map((d) => nodes.get(d)?.label ?? d).join(', ')}</div>
                  <div className="d">They occupy the same position in game, so one hides the other on the research screen. RimDeck draws them apart (marked ↓) so both are visible.</div>
                </div>
              )}
              {[
                ['Requires', sel.prerequisites],
                ['Also requires (hidden)', sel.hiddenPrerequisites],
                ['Leads to', dependents.get(sel.defName) ?? []],
              ].map(([label, list]) =>
                (list as string[]).length ? (
                  <div key={label as string} className="d-section">
                    <h4>{label as string}</h4>
                    {(list as string[]).map((d) => {
                      const n = nodes.get(d)
                      return (
                        <div key={d} className={'d-item' + (n ? ' click' : '')} onClick={() => n && focus(d)}>
                          <span className={'dot ' + (n ? 'ok' : 'err')} />
                          <span className="grow ellipsis">{n?.label ?? d}</span>
                          <span className="dim" style={{ fontSize: 11 }}>{n ? (n.tab !== sel.tab ? n.tab : '') : 'missing'}</span>
                        </div>
                      )
                    })}
                  </div>
                ) : null,
              )}
              {(data?.research.unlocks[sel.defName]?.length ?? 0) > 0 && (
                <div className="d-section">
                  <h4>Unlocks</h4>
                  {data!.research.unlocks[sel.defName].slice(0, 40).map((u) => (
                    <div key={u.type + u.defName} className="d-item click" title={u.defName} onClick={() => s.openSearch(u.defName)}>
                      <span className="chip">{u.type.replace(/Def$/, '').replace(/^.*\./, '')}</span>
                      <span className="grow ellipsis">{u.label}</span>
                      <span className="dim ellipsis" style={{ fontSize: 11, maxWidth: 110 }}>{name(u.packageId)}</span>
                    </div>
                  ))}
                </div>
              )}
              {sel.patchedBy.length > 0 && (
                <div className="d-section">
                  <h4>Changed by patches from</h4>
                  {sel.patchedBy.map((p) => (
                    <div key={p} className="d-item">
                      <ModIcon mod={s.installed.get(p)?.[0]} size={16} />
                      <span className="grow ellipsis">{name(p)}</span>
                    </div>
                  ))}
                </div>
              )}
              {sel.description && (
                <div className="d-section">
                  <h4>Description</h4>
                  <div className="desc">{sel.description}</div>
                </div>
              )}
              <button className="btn sm" style={{ marginTop: 14 }} onClick={() => api.openPath(sel.file)}>
                <FileText size={12} /> Open definition file
              </button>
            </div>
          ) : (
            <div className="details-body" style={{ marginTop: 0, paddingTop: 14, overflow: 'auto' }}>
              <h2 style={{ fontSize: 16 }}>Tree problems</h2>
              <p className="dim" style={{ marginTop: 4, fontSize: 12 }}>
                {issueCount ? 'Select one to go to it.' : 'No overlaps, missing prerequisites or loops.'}
              </p>
              {issues.missing.length > 0 && (
                <div className="d-section">
                  <h4>Missing prerequisites <span className="count">{issues.missing.length}</span></h4>
                  {issues.missing.map((m) => (
                    <div key={m.node + m.prereq} className="d-item click" onClick={() => focus(m.node)}>
                      <span className="dot err" />
                      <span className="grow ellipsis">
                        {nodes.get(m.node)?.label} <span className="dim">needs</span> <span className="mono">{m.prereq}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {issues.loops.length > 0 && (
                <div className="d-section">
                  <h4>Prerequisite loops <span className="count">{issues.loops.length}</span></h4>
                  {issues.loops.map((l, i) => (
                    <div key={i} className="d-item click" onClick={() => focus(l[0])}>
                      <span className="dot err" />
                      <span className="grow ellipsis">{l.map((d) => nodes.get(d)?.label ?? d).join(' → ')}</span>
                    </div>
                  ))}
                </div>
              )}
              {issues.overlaps.size > 0 && (
                <div className="d-section">
                  <h4>Overlapping nodes <span className="count">{issues.overlaps.size}</span></h4>
                  {[...issues.overlaps.keys()]
                    .filter((d, i, all) => {
                      const others = issues.overlaps.get(d)!
                      return !others.some((o) => all.indexOf(o) < i && all.indexOf(o) >= 0)
                    })
                    .slice(0, 80)
                    .map((d) => {
                      const n = nodes.get(d)!
                      return (
                        <div key={d} className="d-item click" onClick={() => focus(d)}>
                          <span className="dot warn" />
                          <span className="grow ellipsis">
                            {[d, ...issues.overlaps.get(d)!].map((x) => nodes.get(x)?.label ?? x).join(' / ')}
                          </span>
                          <span className="dim ellipsis" style={{ fontSize: 11, maxWidth: 90 }}>{tabs.find((t) => t.defName === n.tab)?.label}</span>
                        </div>
                      )
                    })}
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}
