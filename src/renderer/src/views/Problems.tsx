import { useMemo, useState } from 'react'
import { Bug, CircleAlert, Info, TriangleAlert, WandSparkles, ArrowDownUp, EyeOff, ExternalLink, Check, Download } from 'lucide-react'
import type { Issue, IssueKind } from '@shared/types'
import { useStore } from '../store'
import { ModIcon, SeverityIcon } from '../components/ui'

const KIND_LABEL: Record<IssueKind, string> = {
  'missing-dep': 'Missing dependencies',
  'dep-order': 'Dependency order',
  order: 'Load order rules',
  incompatible: 'Incompatibilities',
  version: `Not updated for this version`,
  duplicate: 'Duplicates',
  'not-installed': 'Not installed',
  replacement: 'Updated versions available',
  cycle: 'Rule loops',
  harmony: 'Harmony',
  about: 'Broken About.xml',
  xml: 'XML overrides',
}

export function ProblemsView() {
  const s = useStore()
  const [sev, setSev] = useState<Issue['severity'] | 'all'>('all')
  const [kind, setKind] = useState<IssueKind | 'all'>('all')
  const counts = {
    error: s.issues.filter((i) => i.severity === 'error').length,
    warning: s.issues.filter((i) => i.severity === 'warning').length,
    info: s.issues.filter((i) => i.severity === 'info').length,
  }
  const kinds = useMemo(() => {
    const m = new Map<IssueKind, number>()
    for (const i of s.issues) m.set(i.kind, (m.get(i.kind) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [s.issues])

  const groups = useMemo(() => {
    const filtered = s.issues.filter((i) => (sev === 'all' || i.severity === sev) && (kind === 'all' || i.kind === kind))
    const byMod = new Map<string, Issue[]>()
    for (const i of filtered) byMod.set(i.packageId, [...(byMod.get(i.packageId) ?? []), i])
    const rank = { error: 0, warning: 1, info: 2 }
    return [...byMod.entries()].sort(
      (a, b) => Math.min(...a[1].map((i) => rank[i.severity])) - Math.min(...b[1].map((i) => rank[i.severity])) || s.active.indexOf(a[0]) - s.active.indexOf(b[0]),
    )
  }, [s.issues, sev, kind, s.active])

  const fixable = s.issues.some((i) => i.fixes.some((f) => f.fix.type === 'activate' || f.fix.type === 'sort'))
  const outdated = s.issues.filter((i) => i.kind === 'version').map((i) => i.packageId)

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Problems</h1>
          <p>Checked live against your current, unsaved load order.</p>
        </div>
        <button className="btn" onClick={() => s.startBisect()} title="Turn half your mods off at a time to find which one breaks the game">
          <Bug size={14} /> Find a broken mod
        </button>
        <button className="btn" onClick={() => s.previewSort()}>
          <ArrowDownUp size={14} /> Sort
        </button>
        <button className="btn primary" disabled={!fixable} onClick={() => s.fixAll()}>
          <WandSparkles size={14} /> Fix what's fixable
        </button>
      </div>

      <div className="cards">
        <div className={'stat' + (sev === 'error' ? ' on' : '')} onClick={() => setSev(sev === 'error' ? 'all' : 'error')}>
          <div className="n" style={{ color: counts.error ? 'var(--err)' : undefined }}>{counts.error}</div>
          <div className="l"><CircleAlert size={13} /> Errors</div>
        </div>
        <div className={'stat' + (sev === 'warning' ? ' on' : '')} onClick={() => setSev(sev === 'warning' ? 'all' : 'warning')}>
          <div className="n" style={{ color: counts.warning ? 'var(--warn)' : undefined }}>{counts.warning}</div>
          <div className="l"><TriangleAlert size={13} /> Warnings</div>
        </div>
        <div className={'stat' + (sev === 'info' ? ' on' : '')} onClick={() => setSev(sev === 'info' ? 'all' : 'info')}>
          <div className="n" style={{ color: counts.info ? 'var(--info)' : undefined }}>{counts.info}</div>
          <div className="l"><Info size={13} /> Suggestions</div>
        </div>
        <div className="stat" style={{ cursor: 'default' }}>
          <div className="n">{s.active.length}</div>
          <div className="l">Active mods</div>
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 14, gap: 6 }}>
        <button className={'chip click' + (kind === 'all' ? ' accent' : '')} onClick={() => setKind('all')}>
          All
        </button>
        {kinds.map(([k, n]) => (
          <button key={k} className={'chip click' + (kind === k ? ' accent' : '')} onClick={() => setKind(kind === k ? 'all' : k)}>
            {KIND_LABEL[k]} · {n}
          </button>
        ))}
        <span className="grow" />
        {kind === 'version' && outdated.length > 0 && (
          <button className="btn sm" onClick={() => s.setUser({ ignored: [...new Set([...s.app!.user.ignored, ...outdated])] })}>
            <EyeOff size={12} /> Mute all {outdated.length} version warnings
          </button>
        )}
      </div>

      {!groups.length && (
        <div className="panel">
          <div className="empty" style={{ padding: 50 }}>
            <div style={{ fontSize: 15, color: 'var(--ok)', fontWeight: 600, marginBottom: 4 }}>All clear</div>
            No problems in this load order.
          </div>
        </div>
      )}

      {groups.length > 0 && (
        <div className="panel">
          {groups.map(([pid, issues]) => {
            const mod = s.installed.get(pid)?.[0]
            return (
              <div key={pid} className="prob-row">
                <div className="prob-mod" onClick={() => { s.select(pid); s.setView('mods') }}>
                  <ModIcon mod={mod} size={22} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 600 }}>{mod?.name ?? pid}</div>
                    <div className="dim mono ellipsis" style={{ fontSize: 10.5 }}>
                      {s.active.includes(pid) ? `#${s.active.indexOf(pid) + 1} · ` : ''}{pid}
                    </div>
                  </div>
                </div>
                <div className="prob-issues">
                  {issues.map((i) => (
                    <div key={i.id} className="prob-issue">
                      <SeverityIcon severity={i.severity} size={13} />
                      <span className="grow" style={{ minWidth: 0 }}>
                        {i.title}
                        {i.detail && <span className="dim"> — {i.detail.split('\n')[0]}</span>}
                      </span>
                      {i.fixes.map((f) => (
                        <button key={f.label} className="btn sm" onClick={() => s.applyFix(f.fix)}>
                          {f.fix.type === 'url' ? <ExternalLink size={11} /> : f.fix.type === 'download' ? <Download size={11} /> : <Check size={11} />} {f.label}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
