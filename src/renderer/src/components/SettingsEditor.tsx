import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Pencil, RotateCcw, Save, Search, SlidersHorizontal, TriangleAlert, Undo2, FolderOpen } from 'lucide-react'
import type { SettingSchema, SettingsFile, SettingsNode, SettingsSchema } from '@shared/types'
import { useStore } from '../store'
import { api } from '../api'
import { bytes, timeAgo } from '../lib'
import { Toggle } from './ui'

// Settings files are listed once and refreshed after any write.
export const useSettingsFiles = create<{ files: SettingsFile[] | null; load: () => Promise<void> }>((set) => ({
  files: null,
  load: async () => set({ files: await api.modSettings() }),
}))

/** Settings files saved for a mod folder (workshop id or local folder name). */
export function settingsFor(files: SettingsFile[] | null, folder?: string) {
  return folder ? (files ?? []).filter((f) => f.folder?.toLowerCase() === folder.toLowerCase()) : []
}

export function openSettings(path: string) {
  useStore.setState({ settingsEditor: path })
}

export function ModSettingsSection({ folder }: { folder: string }) {
  const { files, load } = useSettingsFiles()
  const s = useStore()
  useEffect(() => {
    if (!files) void load()
  }, [])
  const mine = (files ?? []).filter((f) => f.folder?.toLowerCase() === folder.toLowerCase())
  return (
    <div className="d-section">
      <h4>
        <SlidersHorizontal size={11} /> Mod settings
      </h4>
      {mine.length ? (
        mine.map((f) => (
          <div key={f.path} className="d-item">
            <span className="grow ellipsis mono" style={{ fontSize: 11.5 }} title={f.name}>
              {f.className}
            </span>
            <span className="dim" style={{ fontSize: 11 }}>
              {f.exists === false ? 'All defaults' : `${bytes(f.size)} · ${timeAgo(f.mtime)}`}
            </span>
            <button className="btn sm" onClick={() => useStore.setState({ settingsEditor: f.path })}>
              Edit
            </button>
            <button
              className="btn sm ghost icon"
              title="Reset to defaults (the file is backed up, and the game recreates it)"
              disabled={f.exists === false}
              onClick={async () => {
                if (!confirm(`Reset ${f.className} to its defaults?\nThe current file is moved to RimDeck's backups.`)) return
                try {
                  await api.resetModSettings(f.path)
                  s.toast('ok', 'Settings reset. The game recreates the defaults on next start.')
                  void load()
                } catch (e: any) {
                  s.toast('error', e.message)
                }
              }}
            >
              <RotateCcw size={12} />
            </button>
          </div>
        ))
      ) : (
        <p className="dim" style={{ margin: 0, fontSize: 12 }}>
          {files ? 'This mod has no settings RimDeck can edit.' : 'Loading…'}
        </p>
      )}
    </div>
  )
}

interface Row {
  node: SettingsNode
  depth: number
  /** Readable name shown in the row. */
  label: string
  /** Where the name came from (tag, class or namespace), shown dimmed. */
  hint?: string
  /** Readable path from the top, used for search and tooltips. */
  path: string
  group: boolean
  count: number
  /** What the mod's code says about this setting, when known. */
  schema?: SettingSchema
  /** Not in the file: the setting is at its default. */
  virtual?: boolean
}

const NEW = 'new:'

// "overviewLetterSent" → "Overview letter sent", "IsInValidBestStorage_Patch" → "Is in valid best storage patch"
function humanize(name: string): string {
  const words = name
    .replace(/^m?_+/, '')
    .replace(/_+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
  if (!words[0]) return name
  return words.map((w, i) => (/^[A-Z0-9]{2,}s?$/.test(w) ? w : i ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join(' ')
}

// Type names and dotted patch names keep their namespace as a hint.
function tagLabel(tag: string): { label: string; hint?: string } {
  const dot = tag.lastIndexOf('.')
  if (dot < 0) return { label: humanize(tag) }
  return { label: humanize(tag.slice(dot + 1)), hint: tag.slice(0, dot) }
}

const NAME_FIELDS = ['key', 'defName', 'def', 'thingDef', 'label', 'name', 'id']
const isLeaf = (n?: SettingsNode) => !!n && !n.children

// A list entry is named after its key or def when it has one, otherwise after its class, otherwise its position.
function itemLabel(n: SettingsNode, i: number): { label: string; hint?: string; from?: SettingsNode } {
  for (const f of NAME_FIELDS) {
    const c = n.children?.find((x) => x.tag === f && isLeaf(x) && x.text)
    if (c) return { label: c.text!, from: f === 'key' ? c : undefined }
  }
  const cls = n.attrs?.Class
  if (cls) {
    return { label: tagLabel(cls).label }
  }
  return { label: `#${i + 1}` }
}

function flatten(root: SettingsNode, schema: SettingsSchema | null): Row[] {
  const rows: Row[] = []
  // Settings the code declares come first, in the mod's own order; ones still at their
  // default are not in the file and are shown from the code.
  const top = (n: SettingsNode) => {
    const byTag = new Map((n.children ?? []).filter(isLeaf).map((c) => [c.tag, c]))
    const used = new Set<SettingsNode>()
    for (const e of schema?.entries ?? []) {
      const c = byTag.get(e.label)
      if (c) used.add(c)
      const node = c ?? { id: NEW + e.label, tag: e.label, text: e.def ?? '' }
      const label = tagLabel(e.label).label
      rows.push({ node, depth: 0, label, path: label, group: false, count: 0, schema: e, virtual: !c })
    }
    walk({ ...n, children: (n.children ?? []).filter((c) => !used.has(c)) }, 0, [])
  }
  const walk = (n: SettingsNode, depth: number, trail: string[], skip?: SettingsNode) => {
    for (const [i, c] of (n.children ?? []).entries()) {
      if (c === skip) continue
      // The ModSettings wrapper adds no information.
      if (depth === 0 && c.tag === 'ModSettings') {
        top(c)
        continue
      }
      // A "key" that already names its entry is not repeated inside it.
      const { label, hint, from } = c.tag === 'li' ? itemLabel(c, i) : { ...tagLabel(c.tag), from: undefined }
      const path = [...trail, label]
      // Scribe dictionaries are <keys> and <values> lists; show each value under its key instead.
      const keys = c.children?.find((x) => x.tag === 'keys')
      const values = c.children?.find((x) => x.tag === 'values')
      if (
        c.children?.length === 2 &&
        keys?.children &&
        values?.children &&
        keys.children.length === values.children.length &&
        keys.children.every((k) => k.tag === 'li' && isLeaf(k))
      ) {
        rows.push({ node: c, depth, label, hint, path: path.join(' › '), group: true, count: keys.children.length })
        values.children.forEach((v, k) => {
          const key = keys.children![k].text || `#${k + 1}`
          const p = [...path, key]
          rows.push({ node: v, depth: depth + 1, label: key, path: p.join(' › '), group: !!v.children, count: v.children?.length ?? 0 })
          if (v.children) walk(v, depth + 2, p)
        })
        continue
      }
      rows.push({ node: c, depth, label, hint, path: path.join(' › '), group: !!c.children, count: (c.children?.length ?? 0) - (from ? 1 : 0) })
      if (c.children) walk(c, depth + 1, path, from)
    }
  }
  walk(root, 0, [])
  return rows
}

// Big files open with their groups folded so the window stays readable.
function initialCollapsed(rows: Row[]): Set<string> {
  if (rows.length <= 250) return new Set()
  return new Set(rows.filter((r) => r.group && (r.depth > 0 || r.count > 30)).map((r) => r.node.id))
}

// Empty collections are written as empty elements too; they cannot take a typed value.
const listName = (tag: string) => /(keys|values|list|set|dict|dictionary|[^su]s)$/i.test(tag)
const isBool = (v: string) => v === 'True' || v === 'False'
const isNum = (v: string) => /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(v)
const RGBA = /^RGBA\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\s*\)$/

function rgbaToHex(v: string): string | null {
  const m = RGBA.exec(v)
  if (!m) return null
  return '#' + [m[1], m[2], m[3]].map((x) => Math.round(Math.min(1, Math.max(0, +x)) * 255).toString(16).padStart(2, '0')).join('')
}

function hexToRgba(hex: string, old: string): string {
  const a = RGBA.exec(old)?.[4] ?? '1.000'
  const c = [1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3))
  return `RGBA(${c.join(', ')}, ${a})`
}

export function SettingsEditor() {
  const s = useStore()
  const path = s.settingsEditor
  const [root, setRoot] = useState<SettingsNode | null>(null)
  const [schema, setSchema] = useState<SettingsSchema | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const reloadFiles = useSettingsFiles((x) => x.load)

  useEffect(() => {
    if (!path) return
    setRoot(null)
    setEdits({})
    setUnlocked(new Set())
    setQ('')
    setError('')
    setSchema(null)
    Promise.all([api.readModSettings(path), api.modSettingsSchema(path).catch(() => null)]).then(([r, sc]) => {
      setSchema(sc)
      setRoot(r)
      setCollapsed(initialCollapsed(flatten(r, sc)))
    }, (e) => setError(e.message))
    api.gameRunning().then(setRunning)
  }, [path])

  const rows = useMemo(() => (root ? flatten(root, schema) : []), [root, schema])
  const values = useMemo(() => rows.filter((r) => !r.group).length, [rows])
  const visible = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (t) return rows.filter((r) => !r.group && (r.path.toLowerCase().includes(t) || r.node.tag.toLowerCase().includes(t) || (edits[r.node.id] ?? r.node.text ?? '').toLowerCase().includes(t)))
    // Rows are in tree order, so everything deeper than a folded group belongs to it.
    const out: Row[] = []
    let foldDepth = Infinity
    for (const r of rows) {
      if (r.depth > foldDepth) continue
      foldDepth = Infinity
      out.push(r)
      if (r.group && collapsed.has(r.node.id)) foldDepth = r.depth
    }
    return out
  }, [rows, q, collapsed, edits])

  if (!path) return null
  const file = path.split(/[\\/]/).pop()!
  const folder = useSettingsFiles.getState().files?.find((f) => f.path === path)?.folder
  const mod = folder
    ? s.app?.mods.find((m) => m.folder === folder)
    : s.app?.mods.find((m) => (m.source === 'local' || m.source === 'workshop') && file.toLowerCase().startsWith(`mod_${m.folder.toLowerCase()}_`))
  const changed = Object.keys(edits).length
  const groups = rows.filter((r) => r.group)
  const close = () => {
    if (changed && !confirm('Discard your unsaved changes?')) return
    useStore.setState({ settingsEditor: null })
  }

  // Settings changed away from their default are added to the ModSettings element, like the game does.
  const added = (schema?.entries ?? [])
    .filter((e) => NEW + e.label in edits)
    .map((e) => ({ id: NEW + e.label, tag: e.label, text: edits[NEW + e.label] }))
  const apply = (n: SettingsNode, depth = 0): SettingsNode => {
    const children = n.children?.map((c) => apply(c, depth + 1))
    const extra = depth === 1 && n.tag === 'ModSettings' ? added.filter((a) => !children?.some((c) => c.tag === a.tag)) : []
    if (extra.length) return { ...n, text: undefined, children: [...(children ?? []), ...extra] }
    return { ...n, text: n.id in edits ? edits[n.id] : n.text, children }
  }

  const save = async () => {
    if (!root) return
    try {
      const { backup } = await api.writeModSettings(path, apply(root))
      s.toast('ok', `Saved ${changed} change${changed === 1 ? '' : 's'}. ${backup ? 'The previous file was backed up.' : 'The settings file was created.'}`)
      setRoot(apply(root))
      setEdits({})
      void reloadFiles()
    } catch (e: any) {
      s.toast('error', e.message)
      api.gameRunning().then(setRunning)
    }
  }

  const setVal = (n: SettingsNode, v: string) => {
    const next = { ...edits }
    if (v === n.text) delete next[n.id]
    else next[n.id] = v
    setEdits(next)
  }

  const toggle = (id: string) => {
    const next = new Set(collapsed)
    next.has(id) ? next.delete(id) : next.add(id)
    setCollapsed(next)
  }

  const control = (n: SettingsNode, sc?: SettingSchema) => {
    const val = edits[n.id] ?? n.text ?? ''
    if (sc) {
      if (sc.type === 'bool') return <Toggle on={val === 'True'} onChange={(v) => setVal(n, v ? 'True' : 'False')} />
      if (sc.type === 'enum') {
        const opts = sc.options?.includes(val) || !val ? sc.options ?? [] : [val, ...(sc.options ?? [])]
        return (
          <select className="input setting-input" value={val} onChange={(e) => setVal(n, e.target.value)}>
            {opts.map((o) => (
              <option key={o} value={o}>
                {humanize(o)}
              </option>
            ))}
          </select>
        )
      }
      const num = sc.type === 'int' || sc.type === 'float'
      const bad = num && !(sc.type === 'int' ? /^-?\d+$/ : /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i).test(val)
      return (
        <input
          className={'input mono setting-input' + (num ? ' num' : '') + (bad ? ' bad' : '')}
          value={val}
          placeholder={sc.def === null ? 'not set' : 'empty'}
          onChange={(e) => setVal(n, e.target.value)}
          spellCheck={false}
        />
      )
    }
    if (n.attrs?.IsNull === 'True') return <span className="setting-tag">Not set</span>
    // Empty elements are usually objects that only hold default values; editing them is opt-in.
    if (n.text === '' && !(n.id in edits) && !unlocked.has(n.id)) {
      return (
        <>
          <span className="setting-tag">{n.attrs?.Class ? 'Default values' : listName(n.tag) ? 'No entries' : 'Empty'}</span>
          {!n.attrs?.Class && !listName(n.tag) && (
            <button className="btn sm ghost icon" title="Enter a value" onClick={() => setUnlocked(new Set(unlocked).add(n.id))}>
              <Pencil size={11} />
            </button>
          )}
        </>
      )
    }
    if (isBool(n.text!)) return <Toggle on={val === 'True'} onChange={(v) => setVal(n, v ? 'True' : 'False')} />
    const hex = rgbaToHex(n.text!)
    if (hex) {
      return (
        <>
          <input type="color" className="setting-color" value={rgbaToHex(val) ?? hex} onChange={(e) => setVal(n, hexToRgba(e.target.value, val))} />
          <input className="input mono setting-input wide" value={val} onChange={(e) => setVal(n, e.target.value)} spellCheck={false} />
        </>
      )
    }
    const num = isNum(n.text!)
    return (
      <input
        className={'input mono setting-input' + (num ? ' num' : '') + (n.text!.length > 32 ? ' wide' : '') + (num && !isNum(val) ? ' bad' : '')}
        value={val}
        placeholder="empty"
        onChange={(e) => setVal(n, e.target.value)}
        spellCheck={false}
        autoFocus={n.text === '' && unlocked.has(n.id) && !(n.id in edits)}
      />
    )
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal" style={{ width: 'min(900px, 94vw)', maxHeight: '86vh' }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <SlidersHorizontal size={20} color="var(--accent)" style={{ marginTop: 2 }} />
          <div className="grow" style={{ minWidth: 0 }}>
            <h2 className="ellipsis">{mod?.name ?? 'Mod settings'}</h2>
            <p className="mono ellipsis">{file}</p>
          </div>
          <button className="btn sm ghost icon" title="Show file" onClick={() => api.showItem(path)}>
            <FolderOpen size={13} />
          </button>
        </div>
        {running && (
          <div className="banner" style={{ margin: '0 16px 10px' }}>
            <TriangleAlert size={15} color="var(--warn)" />
            <span className="grow">RimWorld is running. It rewrites settings when it exits, so close the game before saving.</span>
            <button className="btn sm" onClick={() => api.gameRunning().then(setRunning)}>
              Check again
            </button>
          </div>
        )}
        <div className="row" style={{ padding: '0 16px 10px', gap: 6 }}>
          <label className="pane-filter grow" style={{ margin: 0 }}>
            <Search size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter settings by name or value…" autoFocus />
            <span className="count">{values}</span>
          </label>
          {groups.length > 0 && (
            <>
              <button className="btn sm ghost icon" title="Expand all" disabled={!!q} onClick={() => setCollapsed(new Set())}>
                <ChevronsUpDown size={13} />
              </button>
              <button className="btn sm ghost icon" title="Collapse all" disabled={!!q} onClick={() => setCollapsed(new Set(groups.map((r) => r.node.id)))}>
                <ChevronsDownUp size={13} />
              </button>
            </>
          )}
        </div>
        <div className="modal-body settings-body">
          {error && <div className="empty">{error}</div>}
          {!root && !error && <div className="empty">Reading…</div>}
          {root && !rows.length && <div className="empty">This mod has no settings RimDeck can edit. Its options may only be available in game.</div>}
          {visible.slice(0, 600).map((r) => {
            const n = r.node
            const dirty = n.id in edits
            const indent = 8 + (q ? 0 : r.depth * 18)
            if (r.group) {
              const open = !collapsed.has(n.id)
              return (
                <div key={n.id} className={'setting-row group' + (r.depth === 0 ? ' top' : '')} style={{ paddingLeft: indent }} onClick={() => toggle(n.id)}>
                  <span className="caret">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                  <span className="setting-name grow" title={n.tag}>
                    <span className="ellipsis">{r.label}</span>
                    {r.hint && <span className="setting-hint">{r.hint}</span>}
                  </span>
                  <span className="setting-count">
                    {r.count} {r.count === 1 ? 'entry' : 'entries'}
                  </span>
                </div>
              )
            }
            return (
              <div key={n.id} className={'setting-row' + (dirty ? ' dirty' : '')} style={{ paddingLeft: indent }}>
                <span className="caret" />
                <span className="setting-name grow" title={`${r.path}\n${n.tag}`}>
                  <span className="ellipsis">{q ? r.path : r.label}</span>
                  {!q && r.hint && <span className="setting-hint">{r.hint}</span>}
                </span>
                {control(n, r.schema)}
                {r.schema && r.schema.def !== null && (edits[n.id] ?? n.text) !== r.schema.def && !(dirty && n.text === r.schema.def) && (
                  <button className="btn sm ghost icon" title={`Reset to default (${r.schema.def || 'empty'})`} onClick={() => setVal(n, r.schema!.def!)}>
                    <RotateCcw size={11} />
                  </button>
                )}
                {dirty && (
                  <button className="btn sm ghost icon" title={`Undo (was ${n.text || 'empty'})`} onClick={() => setVal(n, n.text!)}>
                    <Undo2 size={11} />
                  </button>
                )}
              </div>
            )
          })}
          {visible.length > 600 && <div className="empty">Showing 600 of {visible.length}. Use the filter or collapse groups to narrow it down.</div>}
          {q && root && !visible.length && <div className="empty">No settings match “{q}”.</div>}
        </div>
        <div className="modal-foot">
          <span className="grow dim" style={{ alignSelf: 'center', fontSize: 12 }}>
            {changed
              ? `${changed} unsaved change${changed === 1 ? '' : 's'}`
              : schema
                ? 'Defaults and names come from the mod’s code; the game’s settings window may label them differently.'
                : 'Names come from the mod’s code; the game’s settings window may label them differently.'}
          </span>
          <button className="btn" onClick={close}>
            Close
          </button>
          <button className="btn primary" disabled={!changed} onClick={save}>
            <Save size={13} /> Save
          </button>
        </div>
      </div>
    </div>
  )
}
