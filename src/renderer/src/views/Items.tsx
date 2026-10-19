import { useEffect, useMemo, useState } from 'react'
import { Boxes, FileText, RefreshCw, Search, TriangleAlert, X, FileSearch } from 'lucide-react'
import type { ItemDef } from '@shared/types'
import { useStore } from '../store'
import { api, imgUrl } from '../api'
import { loadDefs, modColor, useDefs } from '../defStore'
import { ModIcon, Seg } from '../components/ui'

type Mode = 'names' | 'replaced' | 'all'

// "Lab coat", "Lab-coat" and "lab coat " all count as the same name.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

interface Group {
  key: string
  label: string
  items: ItemDef[]
  note?: string
}

function ItemIcon({ item, size = 44 }: { item: ItemDef; size?: number }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="item-icon" style={{ width: size, height: size }}>
      {item.icon && !failed ? (
        <img src={imgUrl(item.icon, size * 2)} loading="lazy" draggable={false} onError={() => setFailed(true)} />
      ) : (
        <Boxes size={size * 0.45} />
      )}
    </span>
  )
}

export function ItemsView() {
  const s = useStore()
  const { data, busy, scannedFor, error } = useDefs()
  const [mode, setMode] = useState<Mode>('names')
  const [q, setQ] = useState('')
  const [modFilter, setModFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [limit, setLimit] = useState(200)

  useEffect(() => {
    if (!data && !busy) void loadDefs(s.active)
  }, [])
  const stale = !!data && scannedFor !== s.active.join('|')
  const items = data?.items ?? []
  const name = (pid: string) => s.installed.get(pid)?.[0]?.name ?? pid
  const pos = useMemo(() => new Map(s.active.map((p, i) => [p, i])), [s.active])

  const sameName: Group[] = useMemo(() => {
    const m = new Map<string, ItemDef[]>()
    for (const i of items) m.set(norm(i.label), [...(m.get(norm(i.label)) ?? []), i])
    return [...m.entries()]
      .filter(([, list]) => new Set(list.map((i) => i.packageId)).size > 1)
      .map(([key, list]) => ({ key, label: list[0].label, items: list.sort((a, b) => (pos.get(a.packageId) ?? 0) - (pos.get(b.packageId) ?? 0)) }))
      .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label))
  }, [items, pos])

  // Same defName defined by several mods: only the last loaded survives in game.
  const replaced: Group[] = useMemo(() => {
    const byDef = new Map(items.map((i) => [i.defName, i]))
    return (s.xml?.conflicts ?? [])
      .filter((c) => c.kind === 'def' && c.key.startsWith('ThingDef/') && byDef.has(c.key.slice(9)))
      .map((c) => {
        const winner = byDef.get(c.key.slice(9))!
        const order = [...c.mods].sort((a, b) => (pos.get(a.packageId) ?? 0) - (pos.get(b.packageId) ?? 0))
        return {
          key: c.key,
          label: winner.label,
          items: [winner],
          note: `Defined by ${order.map((m) => name(m.packageId)).join(', ')}. ${name(order[order.length - 1].packageId)} loads last, so its version is the one in game.`,
        }
      })
  }, [s.xml, items, pos])

  const query = norm(q)
  const filterItem = (i: ItemDef) => (!query || norm(i.label).includes(query) || i.defName.toLowerCase().includes(query)) && (!modFilter || i.packageId === modFilter)
  const groups = (mode === 'names' ? sameName : mode === 'replaced' ? replaced : []).filter((g) => g.items.some(filterItem))
  const all = useMemo(() => items.filter(filterItem).sort((a, b) => a.label.localeCompare(b.label)), [items, query, modFilter])
  const current = groups.find((g) => g.key === selected) ?? groups[0]
  const modsWithItems = useMemo(() => [...new Set(items.map((i) => i.packageId))].sort((a, b) => name(a).localeCompare(name(b))), [items])

  return (
    <div className="tex-page">
      <div className="page-head" style={{ padding: '22px 26px 0', margin: 0 }}>
        <div className="grow">
          <h1>Items</h1>
          <p>Every item your load order adds, and the ones that exist more than once.</p>
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

      <div className="cards" style={{ padding: '16px 26px 0', marginBottom: 12 }}>
        <div className={'stat' + (mode === 'all' ? ' on' : '')} onClick={() => setMode('all')}>
          <div className="n">{data ? items.length.toLocaleString() : '…'}</div>
          <div className="l">Items in your load order</div>
        </div>
        <div className={'stat' + (mode === 'names' ? ' on' : '')} onClick={() => setMode('names')}>
          <div className="n" style={{ color: sameName.length ? 'var(--warn)' : undefined }}>{data ? sameName.length : '…'}</div>
          <div className="l">Names added by more than one mod</div>
        </div>
        <div className={'stat' + (mode === 'replaced' ? ' on' : '')} onClick={() => setMode('replaced')}>
          <div className="n">{data ? replaced.length : '…'}</div>
          <div className="l">Items one mod replaces in another</div>
        </div>
      </div>

      <div className="row" style={{ padding: '0 26px 10px', gap: 8 }}>
        <Seg<Mode>
          value={mode}
          onChange={(m) => {
            setMode(m)
            setSelected(null)
          }}
          options={[
            ['names', 'Same name'],
            ['replaced', 'Replaced'],
            ['all', 'All items'],
          ]}
        />
        <label className="pane-filter" style={{ margin: 0, width: 260 }}>
          <Search size={13} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an item…" />
          {q && (
            <button className="btn ghost sm icon" title="Clear search" aria-label="Clear search" onClick={() => setQ('')}>
              <X size={12} />
            </button>
          )}
        </label>
        <select className="input" value={modFilter} onChange={(e) => setModFilter(e.target.value)} style={{ maxWidth: 260 }}>
          <option value="">All mods ({modsWithItems.length})</option>
          {modsWithItems.map((p) => (
            <option key={p} value={p}>
              {name(p)}
            </option>
          ))}
        </select>
      </div>

      {mode === 'all' ? (
        <div className="page" style={{ paddingTop: 0 }}>
          <div className="panel">
            <table className="table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Mod</th>
                  <th>Value</th>
                  <th>Mass</th>
                  <th>Stack</th>
                  <th>Category</th>
                </tr>
              </thead>
              <tbody>
                {all.slice(0, limit).map((i) => (
                  <tr key={i.defName} className="click" onClick={() => s.openSearch(i.defName)} title="Search mod files for this item">
                    <td>
                      <div className="row">
                        <ItemIcon item={i} size={26} />
                        <div style={{ minWidth: 0 }}>
                          <div className="ellipsis" style={{ fontWeight: 560 }}>{i.label}</div>
                          <div className="mono dim" style={{ fontSize: 10.5 }}>{i.defName}</div>
                        </div>
                      </div>
                    </td>
                    <td className="muted ellipsis" style={{ maxWidth: 220 }}>{name(i.packageId)}</td>
                    <td className="mono">{i.value ?? '—'}</td>
                    <td className="mono">{i.mass ?? '—'}</td>
                    <td className="mono">{i.stack}</td>
                    <td className="muted ellipsis" style={{ maxWidth: 180 }}>{i.categories.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {all.length > limit && (
              <button className="btn ghost sm" style={{ margin: 10 }} onClick={() => setLimit(limit + 300)}>
                Show more ({all.length - limit})
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="items-view">
          <section className="pane">
            <div className="list" style={{ paddingTop: 8 }}>
              {groups.map((g) => (
                <div key={g.key} className={'tex-row' + (current?.key === g.key ? ' on' : '')} onClick={() => setSelected(g.key)}>
                  <ItemIcon item={g.items[g.items.length - 1]} size={30} />
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="ellipsis" style={{ fontWeight: 600 }}>{g.label}</div>
                    <div className="dim ellipsis" style={{ fontSize: 11 }}>
                      {mode === 'names' ? [...new Set(g.items.map((i) => name(i.packageId)))].join(' · ') : g.key.slice(9)}
                    </div>
                  </div>
                  {mode === 'names' && <span className="chip mono">×{g.items.length}</span>}
                </div>
              ))}
              {data && !groups.length && <div className="empty">{mode === 'names' ? 'No item names are shared between mods.' : 'No items are replaced by another mod.'}</div>}
              {!data && <div className="empty">Reading items…</div>}
            </div>
          </section>
          <section className="pane" style={{ overflow: 'auto' }}>
            {current && (
              <div style={{ padding: 14 }}>
                <h2 style={{ margin: '0 0 4px', fontSize: 17 }}>{current.label}</h2>
                <p className="dim" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
                  {current.note ??
                    `${current.items.length} different items share this name. They are separate items in game, so several versions may appear in trade, crafting and storage filters.`}
                </p>
                <div className="tex-grid">
                  {current.items.map((i) => (
                    <div key={i.packageId + i.defName} className="tex-card">
                      <div className="item-hero">
                        <ItemIcon item={i} size={96} />
                      </div>
                      <div className="tex-meta">
                        <div className="row" style={{ gap: 6 }}>
                          <span className="rstripe" style={{ position: 'static', width: 4, height: 16, background: modColor(i.packageId) }} />
                          <span className="ellipsis grow" style={{ fontWeight: 600 }}>{name(i.packageId)}</span>
                          <ModIcon mod={s.installed.get(i.packageId)?.[0]} size={16} />
                        </div>
                        <div className="mono dim" style={{ fontSize: 10.5, margin: '4px 0 8px' }}>{i.defName}</div>
                        <div className="kv" style={{ gridTemplateColumns: '70px 1fr' }}>
                          <span>Value</span>
                          <span>{i.value ?? '—'}</span>
                          <span>Mass</span>
                          <span>{i.mass ?? '—'}</span>
                          <span>Stack</span>
                          <span>{i.stack}</span>
                          <span>Category</span>
                          <span>{i.categories.join(', ') || '—'}</span>
                          {i.techLevel && (
                            <>
                              <span>Tech</span>
                              <span>{i.techLevel}</span>
                            </>
                          )}
                        </div>
                        {i.description && <div className="desc" style={{ fontSize: 11.5, marginTop: 8, maxHeight: 80, overflow: 'hidden' }}>{i.description}</div>}
                        <div className="row" style={{ marginTop: 10, gap: 6 }}>
                          <button className="btn sm" onClick={() => s.openSearch(i.defName)} title="Find recipes, patches and other mods that use this item">
                            <FileSearch size={12} /> Where it's used
                          </button>
                          <button className="btn sm ghost icon" title="Open definition file" onClick={() => api.openPath(i.file)}>
                            <FileText size={12} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
