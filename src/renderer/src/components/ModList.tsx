import { memo, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { ArrowDownUp, Search, Layers, X, ListFilter } from 'lucide-react'
import type { Issue, ModInfo, ModMeta } from '@shared/types'
import { CATEGORY_LABEL } from '@shared/graph'
import { categoryOf, useStore } from '../store'
import { matchMod, NEW_DAYS } from '../lib'
import { IssueBadge, ModIcon } from './ui'
import { openContextMenu } from './ContextMenu'
import { changedIds } from './Changes'

type Kind = 'active' | 'inactive'
type InactiveSort = 'name' | 'updated' | 'author' | 'category'

let dragPayload: { ids: string[]; from: Kind } | null = null

interface RowProps {
  pid: string
  mod?: ModInfo
  index: number
  kind: Kind
  selected: boolean
  focused: boolean
  meta?: ModMeta
  issues?: Issue[]
  gameMajor: string
  onMouseDown: (e: MouseEvent, pid: string) => void
  onDouble: (pid: string) => void
  onDragStart: (e: DragEvent, pid: string) => void
}

function newestVersion(vs: string[]): string | null {
  const sorted = vs.filter((v) => /^\d+\.\d+$/.test(v)).sort((a, b) => {
    const [a1, a2] = a.split('.').map(Number)
    const [b1, b2] = b.split('.').map(Number)
    return a1 - b1 || a2 - b2
  })
  return sorted.pop() ?? null
}

const QUICK_FILTERS: [string, string][] = [
  ['is:error', 'Errors'],
  ['is:warning', 'Warnings'],
  ['is:outdated', 'Not updated for this version'],
  ['is:current', 'Updated for this version'],
  ['is:changed', 'Changed since last played'],
  ['is:new', `New or updated (${NEW_DAYS} days)`],
  ['is:local', 'Local mods'],
  ['is:workshop', 'Workshop mods'],
  ['has:dll', 'Has code (DLLs)'],
  ['cat:library', 'Libraries'],
  ['cat:patch', 'Patches'],
  ['cat:textures', 'Textures'],
  ['is:tagged', 'Tagged'],
]

function FilterMenu({ query, setQuery }: { query: string; setQuery: (q: string) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', esc as any)
    window.addEventListener('blur', () => setOpen(false))
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', esc as any)
    }
  }, [open])
  const tokens = query.split(/\s+/).filter(Boolean)
  const toggle = (t: string) => {
    setQuery((tokens.includes(t) ? tokens.filter((x) => x !== t) : [...tokens, t]).join(' '))
    setOpen(false)
  }
  return (
    <span ref={ref} style={{ position: 'relative', display: 'flex' }}>
      <button className={'btn ghost sm icon' + (open ? ' on' : '')} title="Quick filters" onClick={() => setOpen(!open)}>
        <ListFilter size={13} />
      </button>
      {open && (
        <div className="menu" style={{ position: 'absolute', right: -6, top: 26, width: 300, whiteSpace: 'nowrap' }}>
          {QUICK_FILTERS.map(([t, label]) => (
            <button key={t} onClick={() => toggle(t)}>
              <span className={'check' + (tokens.includes(t) ? ' on' : '')} />
              {label}
              <span className="grow" />
              <span className="mono dim">{t}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

const ModRow = memo(function ModRow(p: RowProps) {
  const m = p.mod
  const game = !m || m.source === 'dlc' || m.source === 'core'
  const outdated = !game && m!.supportedVersions.length > 0 && !m!.supportedVersions.includes(p.gameMajor)
  // Only the newest supported version is shown; the full list is in the details panel.
  const latest = !game ? newestVersion(m!.supportedVersions) : null
  const isNew = !game && Date.now() - m!.mtime < NEW_DAYS * 86400000
  return (
    <div
      className={'mod-row' + (p.selected ? ' selected' : '') + (p.focused ? ' focused' : '') + (!m ? ' missing' : '') + (p.kind === 'inactive' ? ' inactive' : '')}
      data-index={p.index}
      data-pid={p.pid}
      draggable={p.pid !== 'ludeon.rimworld'}
      onMouseDown={(e) => p.onMouseDown(e, p.pid)}
      onDoubleClick={() => p.onDouble(p.pid)}
      onDragStart={(e) => p.onDragStart(e, p.pid)}
      onContextMenu={(e) => {
        e.preventDefault()
        openContextMenu(e.clientX, e.clientY, p.pid, p.kind)
      }}
    >
      {p.meta?.color && <span className="stripe" style={{ background: p.meta.color }} />}
      {p.kind === 'active' && <span className="idx">{p.index + 1}</span>}
      <ModIcon mod={m} />
      <span className="mod-name">{m?.name ?? p.pid}</span>
      {m && m.authors.length > 0 && <span className="mod-author">{m.authors[0]}</span>}
      <span className="mod-badges">
        {p.meta?.tags?.slice(0, 3).map((t) => <span key={t} className="tag-dot" title={t} style={{ background: p.meta?.color ?? 'var(--text-3)' }} />)}
        {isNew && <span className="badge new" title="Added or updated in the last few days">new</span>}
        {m?.source === 'local' && <span className="badge local" title={`Local copy: ${m.path}`}>local</span>}
        {latest && (outdated || p.kind === 'inactive') && (
          <span className={'ver' + (outdated ? '' : ' ok')} title={outdated ? `Not marked for ${p.gameMajor}. Supports ${m!.supportedVersions.join(', ')}.` : `Supports ${p.gameMajor}`}>
            {latest}
          </span>
        )}
        <IssueBadge issues={p.issues} />
      </span>
    </div>
  )
})

export function ModList({ kind }: { kind: Kind }) {
  const s = useStore()
  const [query, setQuery] = useState('')
  const filterPush = useStore((st) => st.filterPush)
  useEffect(() => {
    if (filterPush) setQuery(filterPush.q)
  }, [filterPush])
  const [sortBy, setSortBy] = useState<InactiveSort>('name')
  const [sections, setSections] = useState(true)
  const [drop, setDrop] = useState<{ index: number; top: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const app = s.app!
  const meta = app.user.meta

  const rows = useMemo(() => {
    const ctx = { meta, issues: s.issuesByPid, gameMajor: app.gameMajor, categoryOf: (pid: string) => categoryOf(s, pid), changed: s.changes ? changedIds(s.changes) : undefined }
    if (kind === 'active') {
      return s.active
        .map((pid, index) => ({ pid, index, mod: s.activeMap.get(pid) }))
        .filter((r) => matchMod(r.mod, r.pid, query, ctx))
    }
    const activeSet = new Set(s.active)
    const seen = new Set<string>()
    const list: { pid: string; index: number; mod?: ModInfo }[] = []
    for (const m of app.mods) {
      if (activeSet.has(m.packageId) || seen.has(m.packageId)) continue
      seen.add(m.packageId)
      if (matchMod(m, m.packageId, query, ctx)) list.push({ pid: m.packageId, index: 0, mod: m })
    }
    const by: Record<InactiveSort, (a: ModInfo, b: ModInfo) => number> = {
      name: (a, b) => a.name.localeCompare(b.name),
      updated: (a, b) => b.mtime - a.mtime,
      author: (a, b) => (a.authors[0] ?? '').localeCompare(b.authors[0] ?? '') || a.name.localeCompare(b.name),
      category: (a, b) => categoryOf(s, a.packageId).localeCompare(categoryOf(s, b.packageId)) || a.name.localeCompare(b.name),
    }
    list.sort((a, b) => by[sortBy](a.mod!, b.mod!))
    list.forEach((r, i) => (r.index = i))
    return list
  }, [kind, s.active, s.activeMap, app.mods, query, sortBy, meta, s.issuesByPid, app.gameMajor, s.changes])

  const visibleIds = useMemo(() => rows.map((r) => r.pid), [rows])

  const onMouseDown = (e: MouseEvent, pid: string) => {
    if (e.button !== 0) {
      if (!s.selection.has(pid)) s.select(pid)
      return
    }
    if (e.ctrlKey || e.metaKey) s.select(pid, 'toggle')
    else if (e.shiftKey) s.select(pid, 'range', visibleIds)
    else if (!s.selection.has(pid) || s.selection.size === 1) s.select(pid)
    else s.setFocus(pid)
  }
  const onDouble = (pid: string) => (kind === 'active' ? s.deactivate([pid]) : s.activate([pid]))

  const onDragStart = (e: DragEvent, pid: string) => {
    const ids = s.selection.has(pid) ? visibleIds.filter((id) => s.selection.has(id)) : [pid]
    dragPayload = { ids, from: kind }
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', ids.join('\n'))
    const ghost = document.createElement('div')
    ghost.textContent = ids.length > 1 ? `${ids.length} mods` : (s.installed.get(pid)?.[0]?.name ?? pid)
    Object.assign(ghost.style, { position: 'fixed', top: '-100px', padding: '6px 12px', borderRadius: '8px', background: '#7c8cff', color: '#0b0c14', font: '600 12px Segoe UI' })
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 10, 10)
    setTimeout(() => ghost.remove())
  }

  const onDragOver = (e: DragEvent) => {
    if (!dragPayload) return
    e.preventDefault()
    setDragOver(true)
    if (kind !== 'active') return
    const list = listRef.current!
    const row = (e.target as HTMLElement).closest('.mod-row') as HTMLElement | null
    if (row) {
      const rect = row.getBoundingClientRect()
      const after = e.clientY > rect.top + rect.height / 2
      const index = Number(row.dataset.index) + (after ? 1 : 0)
      const top = row.offsetTop + (after ? row.offsetHeight : 0)
      if (drop?.index !== index || drop.top !== top) setDrop({ index, top })
    } else if (!drop) {
      const last = list.querySelector('.mod-row:last-of-type') as HTMLElement | null
      setDrop({ index: s.active.length, top: last ? last.offsetTop + last.offsetHeight : 4 })
    }
    // Auto-scroll while dragging near the edges.
    const r = list.getBoundingClientRect()
    if (e.clientY < r.top + 40) list.scrollTop -= 12
    else if (e.clientY > r.bottom - 40) list.scrollTop += 12
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    const p = dragPayload
    dragPayload = null
    setDragOver(false)
    const d = drop
    setDrop(null)
    if (!p) return
    if (kind === 'inactive') {
      if (p.from === 'active') s.deactivate(p.ids)
      return
    }
    const at = d?.index ?? s.active.length
    if (p.from === 'active') s.move(p.ids, at)
    else s.activate(p.ids, at)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    const sel = visibleIds.filter((id) => s.selection.has(id))
    if (e.key === 'Enter' && sel.length) kind === 'active' ? s.deactivate(sel) : s.activate(sel)
    else if (e.key === 'Delete' && kind === 'active' && sel.length) s.deactivate(sel)
    else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && kind === 'active') {
      e.preventDefault()
      s.nudge(e.key === 'ArrowUp' ? -1 : 1)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const cur = s.focus ? visibleIds.indexOf(s.focus) : -1
      const next = visibleIds[Math.max(0, Math.min(visibleIds.length - 1, cur + (e.key === 'ArrowUp' ? -1 : 1)))]
      if (next) {
        s.select(next, e.shiftKey ? 'range' : 'single', visibleIds)
        listRef.current?.querySelector(`[data-pid="${CSS.escape(next)}"]`)?.scrollIntoView({ block: 'nearest' })
      }
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      useStore.setState({ selection: new Set(visibleIds) })
    } else if (e.key === 'Escape') s.clearSelection()
  }

  const showSections = kind === 'active' && sections && !query && app.settings.sortMode === 'grouped'
  let lastCat = ''

  return (
    <section className="pane">
      <div className="pane-head">
        <span className="pane-title">{kind === 'active' ? 'Active' : 'Inactive'}</span>
        <span className="count">{query ? `${rows.length}/` : ''}{kind === 'active' ? s.active.length : rows.length && !query ? rows.length : app.mods.length - s.activeMap.size}</span>
        <span className="grow" />
        {kind === 'inactive' ? (
          <button
            className="btn ghost sm"
            title="Change sort"
            onClick={() => setSortBy(({ name: 'updated', updated: 'author', author: 'category', category: 'name' } as const)[sortBy])}
          >
            <ArrowDownUp size={13} /> {sortBy}
          </button>
        ) : (
          app.settings.sortMode === 'grouped' && (
            <button className={'btn ghost sm icon' + (sections ? '' : ' dim')} title="Toggle category sections" onClick={() => setSections(!sections)}>
              <Layers size={13} />
            </button>
          )
        )}
      </div>
      <label className="pane-filter">
        <Search size={13} />
        <input
          value={query}
          placeholder={kind === 'active' ? 'Filter active…  (is:error, v:1.6, cat:)' : 'Filter inactive…  (is:new, v:1.7, author:)'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        />
        {query && (
          <button className="btn ghost sm icon" onClick={() => setQuery('')}>
            <X size={12} />
          </button>
        )}
        <FilterMenu query={query} setQuery={setQuery} />
      </label>
      <div
        ref={listRef}
        className={'list' + (dragOver && dragPayload?.from !== kind ? ' drop-target' : '')}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!listRef.current?.contains(e.relatedTarget as Node)) {
            setDrop(null)
            setDragOver(false)
          }
        }}
        onDrop={onDrop}
        onDragEnd={() => {
          dragPayload = null
          setDrop(null)
          setDragOver(false)
        }}
      >
        {rows.map((r) => {
          const cat = showSections ? categoryOf(s, r.pid) : ''
          const label = showSections && cat !== lastCat ? CATEGORY_LABEL[cat as keyof typeof CATEGORY_LABEL] : null
          lastCat = cat
          return (
            <div key={r.pid}>
              {label && <div className="section-label">{label}</div>}
              <ModRow
                pid={r.pid}
                mod={r.mod}
                index={r.index}
                kind={kind}
                selected={s.selection.has(r.pid)}
                focused={s.focus === r.pid}
                meta={meta[r.pid]}
                issues={kind === 'active' ? s.issuesByPid.get(r.pid) : undefined}
                gameMajor={app.gameMajor}
                onMouseDown={onMouseDown}
                onDouble={onDouble}
                onDragStart={onDragStart}
              />
            </div>
          )
        })}
        {!rows.length && <div className="empty">{query ? 'No mods match this filter.' : kind === 'active' ? 'Drag mods here to activate them.' : 'All installed mods are active.'}</div>}
        {drop && kind === 'active' && <div className="drop-line" style={{ top: drop.top }} />}
      </div>
    </section>
  )
}
