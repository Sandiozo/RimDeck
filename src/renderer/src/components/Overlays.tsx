import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownUp,
  ArrowRight,
  Bug,
  CircleAlert,
  CircleCheck,
  FolderOpen,
  Gamepad2,
  Info,
  LayoutGrid,
  Download,
  Layers,
  ListChecks,
  Play,
  RefreshCw,
  Redo2,
  Save,
  ScrollText,
  Search,
  Settings,
  Undo2,
  WandSparkles,
  RotateCcw,
  Image as ImageIcon,
  Gauge,
  SlidersHorizontal,
  FlaskConical,
  Boxes,
} from 'lucide-react'
import { useStore, type View } from '../store'
import { switchProfile } from './ProfileSwitcher'
import { api } from '../api'
import { ModIcon } from './ui'

export function SortPreview() {
  const s = useStore()
  const p = s.sortPreview
  if (!p) return null
  const name = (id: string) => s.activeMap.get(id)?.name ?? id
  return (
    <div className="overlay" onMouseDown={() => s.closeSort()}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <ArrowDownUp size={20} color="var(--accent)" style={{ marginTop: 2 }} />
          <div className="grow">
            <h2>{p.moves.length ? `Sort will move ${p.moves.length} ${p.moves.length === 1 ? 'mod' : 'mods'}` : 'Your load order is already sorted'}</h2>
            <p>
              Based on About.xml rules, dependencies{s.app?.settings.useCommunityRules ? ', community rules' : ''} and your rules · {p.edges.length} constraints · mode “{s.app?.settings.sortMode}”. Nothing changes until you apply.
            </p>
          </div>
        </div>
        <div className="modal-body">
          {p.cycles.length > 0 && (
            <div className="issue-card warning" style={{ margin: '0 6px 10px' }}>
              <div className="t">
                {p.cycles.length} conflicting rule {p.cycles.length === 1 ? 'loop' : 'loops'}, resolved by keeping your current order
              </div>
              {p.cycles.map((c, i) => (
                <div key={i} className="d">
                  {c.map(name).join(' → ')} → {name(c[0])}
                </div>
              ))}
            </div>
          )}
          {p.moves.map((m) => (
            <div key={m.packageId} className="move">
              <span className="pos">
                {m.from + 1} <ArrowRight size={11} /> <b style={{ color: 'var(--text)' }}>{m.to + 1}</b>
              </span>
              <div className="row" style={{ minWidth: 0 }}>
                <ModIcon mod={s.activeMap.get(m.packageId)} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis" style={{ fontWeight: 560 }}>
                    {name(m.packageId)}
                  </div>
                  <div className="why ellipsis">{m.reason}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <span className="grow dim" style={{ alignSelf: 'center', fontSize: 12 }}>
            You can undo with Ctrl Z
          </span>
          <button className="btn" onClick={() => s.closeSort()}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => s.applySort()} disabled={!p.moves.length}>
            Apply sort
          </button>
        </div>
      </div>
    </div>
  )
}

interface Cmd {
  id: string
  label: string
  hint?: string
  icon: React.ReactNode
  run: () => void
  group: 'Commands' | 'Mods'
}

export function Palette() {
  const s = useStore()
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => inputRef.current?.focus(), [])

  const go = (v: View) => () => s.setView(v)
  const commands: Cmd[] = [
    { id: 'sort', label: 'Auto-sort load order', hint: 'Ctrl Shift S', icon: <ArrowDownUp size={15} />, run: () => s.previewSort(), group: 'Commands' },
    { id: 'save', label: 'Save to ModsConfig.xml', hint: 'Ctrl S', icon: <Save size={15} />, run: () => s.save(), group: 'Commands' },
    { id: 'play', label: 'Launch RimWorld', hint: 'F5', icon: <Play size={15} />, run: () => s.launch(), group: 'Commands' },
    { id: 'fix', label: 'Fix all fixable problems', icon: <WandSparkles size={15} />, run: () => s.fixAll(), group: 'Commands' },
    { id: 'undo', label: 'Undo', hint: 'Ctrl Z', icon: <Undo2 size={15} />, run: () => s.undo(), group: 'Commands' },
    { id: 'redo', label: 'Redo', hint: 'Ctrl Y', icon: <Redo2 size={15} />, run: () => s.redo(), group: 'Commands' },
    { id: 'revert', label: 'Revert unsaved changes', icon: <RotateCcw size={15} />, run: () => s.revert(), group: 'Commands' },
    { id: 'rescan', label: 'Rescan mod folders', icon: <RefreshCw size={15} />, run: () => s.reload(), group: 'Commands' },
    { id: 'bisect', label: 'Find a broken mod (binary search)', icon: <Bug size={15} />, run: () => s.startBisect(), group: 'Commands' },
    { id: 'v-mods', label: 'Go to Mods', icon: <LayoutGrid size={15} />, run: go('mods'), group: 'Commands' },
    { id: 'v-problems', label: 'Go to Problems', icon: <CircleAlert size={15} />, run: go('problems'), group: 'Commands' },
    { id: 'v-saves', label: 'Go to Saves', icon: <Gamepad2 size={15} />, run: go('saves'), group: 'Commands' },
    { id: 'v-logs', label: 'Go to Game log', icon: <ScrollText size={15} />, run: go('logs'), group: 'Commands' },
    { id: 'v-modsettings', label: 'Go to Mod settings', icon: <SlidersHorizontal size={15} />, run: go('modsettings'), group: 'Commands' },
    { id: 'v-research', label: 'Go to Research tree', icon: <FlaskConical size={15} />, run: go('research'), group: 'Commands' },
    { id: 'v-items', label: 'Go to Items', icon: <Boxes size={15} />, run: go('items'), group: 'Commands' },
    { id: 'v-perf', label: 'Go to Load time', icon: <Gauge size={15} />, run: go('performance'), group: 'Commands' },
    { id: 'v-search', label: 'Search inside mod files', icon: <Search size={15} />, run: go('search'), group: 'Commands' },
    { id: 'v-textures', label: 'Go to Texture conflicts', icon: <ImageIcon size={15} />, run: go('textures'), group: 'Commands' },
    { id: 'v-lists', label: 'Go to Profiles', icon: <ListChecks size={15} />, run: go('lists'), group: 'Commands' },
    ...(s.app?.user.profiles ?? [])
      .filter((p) => p.id !== s.app?.user.currentProfile)
      .map((p) => ({ id: 'profile:' + p.id, label: `Use profile: ${p.name}`, icon: <ListChecks size={15} />, run: () => void switchProfile(p.id), group: 'Commands' as const })),
    { id: 'v-downloads', label: 'Go to Downloads & updates', icon: <Download size={15} />, run: go('downloads'), group: 'Commands' },
    {
      id: 'collection',
      label: 'Import Workshop collection',
      icon: <Layers size={15} />,
      run: () => {
        s.closeCollection()
        s.setView('downloads')
        useStore.setState({ collectionFocus: Date.now() })
      },
      group: 'Commands',
    },
    { id: 'updates', label: 'Check Workshop mods for updates', icon: <RefreshCw size={15} />, run: () => { s.setView('downloads'); void s.checkUpdates(true) }, group: 'Commands' },
    { id: 'v-settings', label: 'Go to Settings', icon: <Settings size={15} />, run: go('settings'), group: 'Commands' },
    { id: 'folder', label: 'Open game folder', icon: <FolderOpen size={15} />, run: () => api.openPath(s.app!.settings.paths.gameDir), group: 'Commands' },
  ]

  const items = useMemo(() => {
    const t = q.trim().toLowerCase()
    const cmds = commands.filter((c) => !t || c.label.toLowerCase().includes(t))
    const activeSet = new Set(s.active)
    const mods: Cmd[] = []
    if (t) {
      const seen = new Set<string>()
      for (const m of s.app!.mods) {
        if (seen.has(m.packageId)) continue
        if (m.name.toLowerCase().includes(t) || m.packageId.includes(t) || m.authors.some((a) => a.toLowerCase().includes(t))) {
          seen.add(m.packageId)
          mods.push({
            id: 'm:' + m.packageId,
            label: m.name,
            hint: activeSet.has(m.packageId) ? `#${s.active.indexOf(m.packageId) + 1} active` : 'inactive',
            icon: <ModIcon mod={m} size={18} />,
            run: () => {
              s.setView('mods')
              s.select(m.packageId)
              setTimeout(() => document.querySelector(`[data-pid="${CSS.escape(m.packageId)}"]`)?.scrollIntoView({ block: 'center' }), 30)
            },
            group: 'Mods',
          })
          if (mods.length >= 40) break
        }
      }
    }
    return [...mods, ...cmds.slice(0, t ? 6 : 99)]
  }, [q, s.app, s.active])

  useEffect(() => setIdx(0), [q])
  const run = (c: Cmd) => {
    s.setPalette(false)
    c.run()
  }
  let lastGroup = ''

  return (
    <div className="overlay" onMouseDown={() => s.setPalette(false)}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <Search size={17} />
          <input
            ref={inputRef}
            value={q}
            placeholder="Search mods, authors, or type a command…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') s.setPalette(false)
              else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIdx(Math.min(items.length - 1, idx + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIdx(Math.max(0, idx - 1))
              } else if (e.key === 'Enter' && items[idx]) run(items[idx])
            }}
          />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list">
          {items.map((c, i) => {
            const header = c.group !== lastGroup ? <div className="palette-group">{c.group}</div> : null
            lastGroup = c.group
            return (
              <div key={c.id}>
                {header}
                <div
                  className={'palette-item' + (i === idx ? ' on' : '')}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => run(c)}
                  ref={(el) => {
                    if (i === idx) el?.scrollIntoView({ block: 'nearest' })
                  }}
                >
                  {c.icon}
                  <span className="ellipsis">{c.label}</span>
                  {c.hint && <span className="hint">{c.hint}</span>}
                </div>
              </div>
            )
          })}
          {!items.length && <div className="empty">No results</div>}
        </div>
      </div>
    </div>
  )
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + t.kind}>
          {t.kind === 'ok' ? <CircleCheck size={16} /> : t.kind === 'error' ? <CircleAlert size={16} /> : <Info size={16} />}
          {t.text}
        </div>
      ))}
    </div>
  )
}
