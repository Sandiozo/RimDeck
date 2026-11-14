import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react'
import { ArrowDownUp, Search, Layers, X, ListFilter } from 'lucide-react'
import type { Issue, ModInfo, ModMeta } from '@shared/types'
import { CATEGORY_LABEL } from '@shared/graph'
import { categoryOf, useStore } from '../store'
import { matchMod, NEW_DAYS } from '../lib'
import { addRevealer } from '../reveal'
import { buildOffsets } from '../virtual'
import { cssPx, useVirtual } from '../useVirtual'
import { IssueBadge, ModIcon, useEscape } from './ui'
import { openContextMenu } from './ContextMenu'
import { changedIds } from './Changes'

type Kind = 'active' | 'inactive'
type InactiveSort = 'name' | 'updated' | 'author' | 'category'

let dragPayload: { ids: string[]; from: Kind } | null = null
// Set on drags that start in a mod list, so a drag from elsewhere (a file, some text) is never taken for one.
const DRAG_TYPE = 'application/x-rimdeck-mods'

// The list places its rows with these heights, so they come from the stylesheet (--row-h, --section-h).
// Once the list is on screen a rendered row and label are measured as well, and those win if they differ.
function readSizes(list: HTMLElement | null) {
  const root = list ?? document.documentElement
  const sizes = { row: cssPx(root, '--row-h'), label: cssPx(root, '--section-h') }
  const row = list?.querySelector('.mod-row')
  const label = list?.querySelector('.section-label')
  if (row) sizes.row = row.getBoundingClientRect().height
  if (label) sizes.label = label.getBoundingClientRect().height
  return sizes
}

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
  onClick: (e: MouseEvent, pid: string) => void
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
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false)
    const blur = () => setOpen(false)
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', blur)
    }
  }, [open])
  // Escape closes only the menu, not also the search text or the selection.
  useEscape(menuRef, () => setOpen(false), open)
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
        <div ref={menuRef} className="menu" style={{ position: 'absolute', right: -6, top: 26, width: 300, whiteSpace: 'nowrap' }}>
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
      onClick={(e) => p.onClick(e, p.pid)}
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
  // The row a drag started from. It stays rendered until the drag ends, wherever the list scrolls:
  // if it left the page, its dragend would never reach this list.
  const [dragPid, setDragPid] = useState<string | null>(null)
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

  const showSections = kind === 'active' && sections && !query && app.settings.sortMode === 'grouped'
  // A label goes above the first row of each category. Worked out over the whole list, so it is right
  // wherever the rendered window starts.
  const labels = useMemo(() => {
    if (!showSections) return null
    let last = ''
    return rows.map((r) => {
      const cat = categoryOf(s, r.pid)
      const label = cat !== last ? CATEGORY_LABEL[cat as keyof typeof CATEGORY_LABEL] : null
      last = cat
      return label || null
    })
  }, [showSections, rows, s.app, s.rules, s.installed])

  // Measured once rows are on screen; differences under half a pixel (from page zoom) are ignored.
  const [sizes, setSizes] = useState(() => readSizes(null))
  useLayoutEffect(() => {
    const next = readSizes(listRef.current)
    setSizes((cur) => (Math.abs(cur.row - next.row) < 0.5 && Math.abs(cur.label - next.label) < 0.5 ? cur : next))
  }, [rows.length > 0, showSections])

  // Only the rows near the view are rendered; each item is a row plus the label above it, if any.
  const offsets = useMemo(() => buildOffsets(rows.length, (i) => sizes.row + (labels?.[i] ? sizes.label : 0)), [rows.length, labels, sizes])
  const pinned = useMemo(() => {
    const i = dragPid ? visibleIds.indexOf(dragPid) : -1
    return i >= 0 ? [i] : undefined
  }, [dragPid, visibleIds])
  const { slots, spacer, scrollToIndex, offsetOf } = useVirtual({ ref: listRef, offsets, pinned })
  // Like scrollIntoView on the row itself (the label above it is not part of it).
  const scrollToRow = useCallback((i: number, align: 'nearest' | 'center') => scrollToIndex(i, align, sizes.row), [scrollToIndex, sizes.row])

  // Stable handlers keep the memoised rows from re-rendering on unrelated store changes.
  const idsRef = useRef(visibleIds)
  idsRef.current = visibleIds

  // showMod (store.ts) scrolls to a mod through this, as its row may not be rendered. A mod this list
  // does not show (it is in the other list, or this list's filter hides it) is left alone.
  useLayoutEffect(
    () =>
      addRevealer((pid) => {
        const i = idsRef.current.indexOf(pid)
        if (i < 0) return false
        scrollToRow(i, 'center')
        return true
      }),
    [scrollToRow],
  )

  // After Alt+Up/Down, the moved rows' leading edge is scrolled into view once the list has updated.
  const keepVisible = useRef<'first' | 'last' | null>(null)
  useLayoutEffect(() => {
    const which = keepVisible.current
    if (!which) return
    keepVisible.current = null
    const sel = useStore.getState().selection
    const i = which === 'first' ? visibleIds.findIndex((id) => sel.has(id)) : visibleIds.findLastIndex((id) => sel.has(id))
    if (i >= 0) scrollToRow(i, 'nearest')
  }, [visibleIds, scrollToRow])

  // A drag whose dragend never reaches this list (its row left the page, for example because the drop
  // removed it) must not leave a stale payload behind. No mouse events arrive while a drag is going
  // on, so the next press anywhere means it is over.
  useEffect(() => {
    const reset = () => {
      dragPayload = null
      setDrop(null)
      setDragOver(false)
      setDragPid(null)
    }
    window.addEventListener('dragend', reset)
    window.addEventListener('mousedown', reset, true)
    return () => {
      window.removeEventListener('dragend', reset)
      window.removeEventListener('mousedown', reset, true)
    }
  }, [])
  // A plain press on a row inside a multi-selection keeps the selection, so all of it can be
  // dragged; if the press ends as a click instead of a drag, the selection narrows to that row.
  const narrowTo = useRef<string | null>(null)
  const onMouseDown = useCallback((e: MouseEvent, pid: string) => {
    const st = useStore.getState()
    narrowTo.current = null
    if (e.button !== 0) {
      if (!st.selection.has(pid)) st.select(pid)
      return
    }
    if (e.ctrlKey || e.metaKey) st.select(pid, 'toggle')
    else if (e.shiftKey) st.select(pid, 'range', idsRef.current)
    else if (!st.selection.has(pid) || st.selection.size === 1) st.select(pid)
    else {
      st.setFocus(pid)
      narrowTo.current = pid
    }
  }, [])
  const onClick = useCallback((e: MouseEvent, pid: string) => {
    if (narrowTo.current !== pid || e.ctrlKey || e.metaKey || e.shiftKey) return
    narrowTo.current = null
    useStore.getState().select(pid)
  }, [])
  const onDouble = useCallback((pid: string) => {
    const st = useStore.getState()
    if (kind === 'active') st.deactivate([pid])
    else st.activate([pid])
  }, [kind])

  const onDragStart = useCallback((e: DragEvent, pid: string) => {
    const st = useStore.getState()
    narrowTo.current = null
    const ids = st.selection.has(pid) ? idsRef.current.filter((id) => st.selection.has(id)) : [pid]
    dragPayload = { ids, from: kind }
    setDragPid(pid)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', ids.join('\n'))
    e.dataTransfer.setData(DRAG_TYPE, kind)
    const ghost = document.createElement('div')
    ghost.textContent = ids.length > 1 ? `${ids.length} mods` : (st.installed.get(pid)?.[0]?.name ?? pid)
    Object.assign(ghost.style, { position: 'fixed', top: '-100px', padding: '6px 12px', borderRadius: '5px', background: 'var(--accent)', color: 'var(--on-accent)', font: '600 12px Segoe UI' })
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, 10, 10)
    setTimeout(() => ghost.remove())
  }, [kind])

  const onDragOver = (e: DragEvent) => {
    if (!dragPayload || !e.dataTransfer.types.includes(DRAG_TYPE)) return
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
      // Below the last row (which may not be rendered): drop at the end.
      setDrop({ index: s.active.length, top: rows.length ? offsetOf(rows.length) : 4 })
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
      const before = useStore.getState().active
      s.nudge(e.key === 'ArrowUp' ? -1 : 1)
      if (useStore.getState().active !== before) keepVisible.current = e.key === 'ArrowUp' ? 'first' : 'last'
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      const cur = s.focus ? visibleIds.indexOf(s.focus) : -1
      const at = Math.max(0, Math.min(visibleIds.length - 1, cur + (e.key === 'ArrowUp' ? -1 : 1)))
      const next = visibleIds[at]
      if (next) {
        s.select(next, e.shiftKey ? 'range' : 'single', visibleIds)
        scrollToRow(at, 'nearest')
      }
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      useStore.setState({ selection: new Set(visibleIds) })
    } else if (e.key === 'Escape') s.clearSelection()
  }

  return (
    <section className="pane">
      <div className="pane-head">
        <span className="pane-title">{kind === 'active' ? 'Active' : 'Inactive'}</span>
        <span className="count">{query ? `${rows.length}/` : ''}{kind === 'active' ? s.active.length : rows.length && !query ? rows.length : s.installed.size - s.activeMap.size}</span>
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
          <button className="btn ghost sm icon" title="Clear search" aria-label="Clear search" onClick={() => setQuery('')}>
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
          setDragPid(null)
        }}
      >
        {slots.map((slot) => {
          if (slot.kind === 'gap') return spacer(slot)
          const r = rows[slot.index]
          const label = labels?.[slot.index]
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
                onClick={onClick}
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
