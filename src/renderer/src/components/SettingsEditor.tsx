import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FolderOpen,
  Info,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react'
import type { SettingElem, SettingSchema, SettingsFile, SettingsNode, SettingsSchema } from '@shared/types'
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
  /** Readable name shown in the row: the game window's label when known. */
  label: string
  /** Namespace of a dotted name, shown dimmed. */
  hint?: string
  /** Readable path from the top, used for search and tooltips. */
  path: string
  group: boolean
  count: number
  /** What the mod's code says about this setting, when known. */
  schema?: SettingSchema
  /** Not in the file yet: the setting is at its default. */
  virtual?: boolean
  /** A list or dictionary entries can be added to. */
  collection?: { kind: 'list' | 'dict'; elem: SettingElem; key?: SettingElem; tags?: string[] }
  /** The list or dictionary this entry can be removed from. */
  owner?: { kind: 'list' | 'dict'; id: string; index: number }
  /** The key of a dictionary entry. */
  keyNode?: SettingsNode
}

// Ids of settings that are not in the file yet: NEW + element names below ModSettings.
const NEW = 'new:'
// Ids of entries added in this session.
const ADD = 'add:'
let added = 0
const addId = () => `${ADD}${++added}`

// "overviewLetterSent" → "Overview letter sent", "IsInValidBestStorage_Patch" → "Is in valid best storage patch"
function humanize(name: string): string {
  const words = name
    .replace(/^m?_+/, '')
    .replace(/_+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z]{2,})/g, '$1 $2')
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
  if (n.attrs?.Class) return { label: tagLabel(n.attrs.Class).label }
  return { label: `#${i + 1}` }
}

const isBool = (v: string) => v === 'True' || v === 'False'
const isNum = (v: string) => /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(v)
const isInt = (v: string) => /^-?\d+$/.test(v)
const simple = (e?: SettingElem) => !!e && e.type !== 'other'

// The element type of an existing list, when every entry is a plain value.
function inferElem(items: SettingsNode[]): SettingElem | undefined {
  if (!items.length || !items.every((i) => i.tag === 'li' && isLeaf(i) && !i.attrs)) return undefined
  const v = items.map((i) => i.text ?? '')
  if (v.every(isBool)) return { type: 'bool' }
  if (v.every(isInt)) return { type: 'int' }
  if (v.every(isNum)) return { type: 'float' }
  return { type: 'string' }
}

const elemSchema = (e: SettingElem): SettingSchema | undefined =>
  e.type === 'other' ? undefined : { label: 'li', type: e.type === 'def' ? 'string' : e.type, def: null, options: e.options }

const blank = (e?: SettingElem) => (e?.type === 'bool' ? 'False' : e?.type === 'int' || e?.type === 'float' ? '0' : e?.type === 'enum' ? e.options?.[0] ?? '' : '')

const blankFor = (sc: SettingSchema) =>
  sc.type === 'color' ? 'RGBA(1.000, 1.000, 1.000, 1.000)' : sc.type === 'intRange' || sc.type === 'floatRange' ? '0~0' : sc.type === 'vector' ? '(0, 0, 0)' : blank({ type: sc.type as SettingElem['type'], options: sc.options })

// An element whose children are all <li>, or an empty one: a list.
const listLike = (n?: SettingsNode) => !!n && (n.children ? n.children.every((c) => c.tag === 'li') : n.text === '')

function flatten(root: SettingsNode, schema: SettingsSchema | null): Row[] {
  const rows: Row[] = []

  // One element of the file, with what the code says about it when known.
  const child = (c: SettingsNode, i: number, depth: number, trail: string[], sc?: SettingSchema, owner?: Row['owner'], elem?: SettingElem, tags?: string[]) => {
    const named = c.tag === 'li' ? itemLabel(c, i) : { ...tagLabel(c.tag), from: undefined }
    const label = sc?.title ?? named.label
    const path = [...trail, label]
    const base = { depth, label, hint: sc?.title ? undefined : named.hint, path: path.join(' › '), schema: sc, owner }

    if (sc?.type === 'group' && c.children !== undefined) {
      rows.push({ ...base, node: c, group: true, count: sc.children!.length })
      level(c, sc.children!, depth + 1, path, tags ?? [])
      return
    }

    // Scribe dictionaries are <keys> and <values> lists; each value is shown under its key.
    const keys = c.children?.find((x) => x.tag === 'keys')
    const values = c.children?.find((x) => x.tag === 'values')
    const isDict =
      (c.children?.length === 2 && listLike(keys) && listLike(values) && (keys!.children?.length ?? 0) === (values!.children?.length ?? 0) && (keys!.children ?? []).every(isLeaf)) ||
      (sc?.type === 'dict' && c.text === '')
    if (isDict) {
      const kItems = keys?.children ?? []
      const vItems = values?.children ?? []
      const keyElem = sc?.key ?? inferElem(kItems)
      const valElem = sc?.elem ?? inferElem(vItems)
      const editable = simple(keyElem) && simple(valElem) && vItems.every(isLeaf)
      rows.push({ ...base, node: c, group: true, count: kItems.length, collection: editable ? { kind: 'dict', elem: valElem!, key: keyElem } : undefined })
      vItems.forEach((v, k) => {
        const kn = kItems[k]
        const key = kn.text || `#${k + 1}`
        const p = [...path, key]
        rows.push({
          node: v,
          depth: depth + 1,
          label: key,
          path: p.join(' › '),
          group: !!v.children,
          count: v.children?.length ?? 0,
          schema: editable && isLeaf(v) ? elemSchema(valElem!) : undefined,
          keyNode: kn,
          owner: editable ? { kind: 'dict', id: c.id, index: k } : undefined,
        })
        if (v.children) walk(v, depth + 2, p)
      })
      return
    }

    if (c.children || sc?.type === 'list') {
      const items = c.children ?? []
      // Half of a dictionary cannot grow on its own.
      const pairHalf = c.tag === 'keys' || c.tag === 'values'
      const listElem = sc?.type === 'list' ? sc.elem : !pairHalf && items.every((x) => x.tag === 'li') ? inferElem(items) : undefined
      const editable = simple(listElem) && items.every((x) => x.tag === 'li' && isLeaf(x))
      rows.push({ ...base, node: c, group: true, count: items.length - (named.from ? 1 : 0), collection: editable ? { kind: 'list', elem: listElem! } : undefined })
      items.forEach((x, j) => {
        if (x !== named.from) child(x, j, depth + 1, path, undefined, editable ? { kind: 'list', id: c.id, index: j } : undefined, editable ? listElem : undefined)
      })
      return
    }
    rows.push({ ...base, node: c, group: false, count: 0, schema: sc ?? (elem && elemSchema(elem)) })
  }

  // Settings the code declares come first, in the mod's own order; ones that are not in the
  // file are at their default and are shown from the code.
  const level = (n: SettingsNode | null, entries: SettingSchema[], depth: number, trail: string[], tags: string[]) => {
    const kids = n?.children ?? []
    const used = new Set<SettingsNode>()
    for (const e of entries) {
      const t = [...tags, e.label]
      const c = kids.find((k) => k.tag === e.label && !used.has(k))
      if (c) {
        used.add(c)
        child(c, kids.indexOf(c), depth, trail, e, undefined, undefined, t)
        continue
      }
      const label = e.title ?? tagLabel(e.label).label
      const path = [...trail, label]
      const id = NEW + t.join('/')
      const base = { depth, label, path: path.join(' › '), schema: e, virtual: true }
      if (e.type === 'group') {
        rows.push({ ...base, node: { id, tag: e.label, children: [] }, group: true, count: e.children!.length })
        level(null, e.children!, depth + 1, path, t)
      } else if (e.type === 'list' || e.type === 'dict') {
        const editable = simple(e.elem) && (e.type === 'list' || simple(e.key))
        rows.push({ ...base, node: { id, tag: e.label, text: '' }, group: true, count: 0, collection: editable ? { kind: e.type, elem: e.elem!, key: e.key, tags: t } : undefined })
      } else rows.push({ ...base, node: { id, tag: e.label, text: e.def ?? '' }, group: false, count: 0 })
    }
    kids.forEach((c, i) => {
      if (!used.has(c)) child(c, i, depth, trail)
    })
  }

  const walk = (n: SettingsNode, depth: number, trail: string[]) => {
    for (const [i, c] of (n.children ?? []).entries()) {
      // The ModSettings wrapper adds no information.
      if (depth === 0 && c.tag === 'ModSettings') level(c, schema?.entries ?? [], 0, trail, [])
      else child(c, i, depth, trail)
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

// ---------- tree edits ----------

function findNode(n: SettingsNode, id: string): SettingsNode | null {
  if (n.id === id) return n
  for (const c of n.children ?? []) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

// Finds or creates the element at these names below ModSettings (mutates the tree).
function ensurePath(root: SettingsNode, tags: string[]): SettingsNode {
  let cur = root.children?.find((c) => c.tag === 'ModSettings')
  if (!cur) {
    cur = { id: '0/ModSettings', tag: 'ModSettings', children: [] }
    root.children = [...(root.children ?? []), cur]
  }
  tags.forEach((tag, i) => {
    let next = cur!.children?.find((c) => c.tag === tag)
    if (!next) {
      next = { id: NEW + tags.slice(0, i + 1).join('/'), tag, text: '' }
      cur!.text = undefined
      cur!.children = [...(cur!.children ?? []), next]
    }
    if (i < tags.length - 1 && !next.children) {
      next.text = undefined
      next.children = []
    }
    cur = next
  })
  return cur!
}

// Empty collections are written as empty elements too; they cannot take a typed value.
const listName = (tag: string) => /(keys|values|list|set|dict|dictionary|[^su]s)$/i.test(tag)
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
  const [doc, setDoc] = useState<SettingsNode | null>(null)
  const [schema, setSchema] = useState<SettingsSchema | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [structural, setStructural] = useState(0)
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const reloadFiles = useSettingsFiles((x) => x.load)

  useEffect(() => {
    if (!path) return
    setDoc(null)
    setEdits({})
    setStructural(0)
    setUnlocked(new Set())
    setQ('')
    setError('')
    setSchema(null)
    Promise.all([api.readModSettings(path), api.modSettingsSchema(path).catch(() => null)]).then(([r, sc]) => {
      setSchema(sc)
      setDoc(r)
      setCollapsed(initialCollapsed(flatten(r, sc)))
    }, (e) => setError(e.message))
    api.gameRunning().then(setRunning)
  }, [path])

  const rows = useMemo(() => (doc ? flatten(doc, schema) : []), [doc, schema])
  const values = useMemo(() => rows.filter((r) => !r.group).length, [rows])
  const visible = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (t) {
      return rows.filter(
        (r) => !r.group && (r.path.toLowerCase().includes(t) || r.node.tag.toLowerCase().includes(t) || (edits[r.node.id] ?? r.node.text ?? '').toLowerCase().includes(t)),
      )
    }
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
  const changed = Object.keys(edits).length + structural
  const groups = rows.filter((r) => r.group)
  const close = () => {
    if (changed && !confirm('Discard your unsaved changes?')) return
    useStore.setState({ settingsEditor: null })
  }

  // The file to write: typed values applied, and settings changed away from their default
  // added where the game would write them.
  const apply = (): SettingsNode => {
    const out = structuredClone(doc!)
    const visit = (n: SettingsNode) => {
      if (!n.children && n.id in edits) n.text = edits[n.id]
      n.children?.forEach(visit)
    }
    visit(out)
    for (const [id, v] of Object.entries(edits)) {
      if (id.startsWith(NEW) && !findNode(out, id)) ensurePath(out, id.slice(NEW.length).split('/')).text = v
    }
    return out
  }

  const save = async () => {
    if (!doc) return
    try {
      const next = apply()
      const { backup } = await api.writeModSettings(path, next)
      s.toast('ok', `Saved ${changed} change${changed === 1 ? '' : 's'}. ${backup ? 'The previous file was backed up.' : 'The settings file was created.'}`)
      setDoc(next)
      setEdits({})
      setStructural(0)
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

  // Adding and removing entries changes the tree itself.
  const restructure = (fn: (d: SettingsNode) => void) => {
    const d = structuredClone(doc!)
    fn(d)
    setDoc(d)
    setStructural((n) => n + 1)
  }

  const addEntry = (r: Row) => {
    const col = r.collection!
    restructure((d) => {
      const target = findNode(d, r.node.id) ?? ensurePath(d, col.tags ?? [])
      target.text = undefined
      if (target.attrs?.IsNull) {
        const { IsNull: _, ...rest } = target.attrs
        target.attrs = Object.keys(rest).length ? rest : undefined
      }
      if (col.kind === 'list') {
        target.children = [...(target.children ?? []), { id: addId(), tag: 'li', text: blank(col.elem) }]
        return
      }
      const list = (tag: string) => {
        let l = target.children?.find((c) => c.tag === tag)
        if (!l) target.children = [...(target.children ?? []), (l = { id: addId(), tag, children: [] })]
        l.text = undefined
        l.children = l.children ?? []
        return l
      }
      list('keys').children!.push({ id: addId(), tag: 'li', text: blank(col.key) })
      list('values').children!.push({ id: addId(), tag: 'li', text: blank(col.elem) })
    })
    const open = new Set(collapsed)
    open.delete(r.node.id)
    setCollapsed(open)
  }

  const removeEntry = (r: Row) => {
    const o = r.owner!
    restructure((d) => {
      const target = findNode(d, o.id)
      if (!target?.children) return
      if (o.kind === 'list') target.children.splice(o.index, 1)
      else for (const l of target.children) if (l.tag === 'keys' || l.tag === 'values') l.children?.splice(o.index, 1)
    })
    const next = { ...edits }
    delete next[r.node.id]
    if (r.keyNode) delete next[r.keyNode.id]
    setEdits(next)
  }

  const numInput = (n: SettingsNode, val: string, int: boolean, extra = '') => (
    <input
      className={'input mono setting-input num' + extra + ((int ? isInt(val) : isNum(val)) ? '' : ' bad')}
      value={val}
      onChange={(e) => setVal(n, e.target.value)}
      spellCheck={false}
    />
  )

  const control = (n: SettingsNode, sc?: SettingSchema, virtual?: boolean) => {
    const val = edits[n.id] ?? n.text ?? ''
    if (sc) {
      // The default is computed at runtime; only a value set here is known.
      if (virtual && sc.defUnknown && !(n.id in edits)) {
        return (
          <>
            <span className="setting-tag">Game default</span>
            <button className="btn sm ghost icon" title="Set a value" onClick={() => setVal(n, blankFor(sc))}>
              <Pencil size={11} />
            </button>
          </>
        )
      }
      if (sc.type === 'group') return <span className="setting-tag">{n.attrs?.IsNull === 'True' ? 'Not set' : 'Default values'}</span>
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
      if (sc.type === 'int' || sc.type === 'float') {
        const int = sc.type === 'int'
        if (sc.min === undefined || sc.max === undefined) return numInput(n, val, int)
        const step = int ? 1 : Math.max((sc.max - sc.min) / 200, 0.001)
        return (
          <>
            <input
              type="range"
              className="setting-range"
              min={sc.min}
              max={sc.max}
              step={step}
              value={isNum(val) ? Number(val) : sc.min}
              onChange={(e) => setVal(n, int ? String(Math.round(+e.target.value)) : String(+(+e.target.value).toPrecision(6)))}
              title={`${sc.min} to ${sc.max}`}
            />
            {numInput(n, val, int)}
          </>
        )
      }
      if (sc.type === 'intRange' || sc.type === 'floatRange') {
        const int = sc.type === 'intRange'
        const [a = '', b = ''] = val.split('~')
        const ok = (x: string) => (int ? isInt(x) : isNum(x))
        const set = (x: string, y: string) => setVal(n, `${x}~${y}`)
        return (
          <span className="setting-pair">
            <input className={'input mono setting-input num narrow' + (ok(a) ? '' : ' bad')} value={a} onChange={(e) => set(e.target.value, b)} spellCheck={false} />
            <span className="dim">to</span>
            <input className={'input mono setting-input num narrow' + (ok(b) ? '' : ' bad')} value={b} onChange={(e) => set(a, e.target.value)} spellCheck={false} />
          </span>
        )
      }
      if (sc.type === 'color') return colorControl(n, val)
      return (
        <input
          className={'input mono setting-input' + (val.length > 32 ? ' wide' : '')}
          value={val}
          placeholder={sc.elem?.type === 'def' ? 'defName' : sc.def === null ? 'not set' : 'empty'}
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
    if (rgbaToHex(n.text!)) return colorControl(n, val)
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

  const colorControl = (n: SettingsNode, val: string) => (
    <>
      <input type="color" className="setting-color" value={rgbaToHex(val) ?? '#ffffff'} onChange={(e) => setVal(n, hexToRgba(e.target.value, val))} />
      <input className={'input mono setting-input wide' + (RGBA.test(val) ? '' : ' bad')} value={val} onChange={(e) => setVal(n, e.target.value)} spellCheck={false} />
    </>
  )

  const name = (r: Row) => {
    const sc = r.schema
    const tip = [sc?.tip, r.path, r.node.tag !== 'li' ? r.node.tag : ''].filter(Boolean).join('\n')
    // A key typed for a new dictionary entry.
    if (r.keyNode?.id.startsWith(ADD)) {
      return (
        <span className="setting-name grow">
          <input
            className="input mono setting-input"
            value={edits[r.keyNode.id] ?? r.keyNode.text ?? ''}
            placeholder="key"
            onChange={(e) => setVal(r.keyNode!, e.target.value)}
            onClick={(e) => e.stopPropagation()}
            spellCheck={false}
            autoFocus
          />
        </span>
      )
    }
    return (
      <span className="setting-name grow" title={tip}>
        <span className="ellipsis">{q && !r.group ? r.path : r.label}</span>
        {!q && r.hint && <span className="setting-hint">{r.hint}</span>}
        {sc?.tip && <Info size={11} className="setting-info" />}
      </span>
    )
  }

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="modal" style={{ width: 'min(920px, 94vw)', maxHeight: '86vh' }} onMouseDown={(e) => e.stopPropagation()}>
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
          {!doc && !error && <div className="empty">Reading…</div>}
          {doc && !rows.length && <div className="empty">This mod has no settings RimDeck can edit. Its options may only be available in game.</div>}
          {visible.slice(0, 600).map((r) => {
            const n = r.node
            const dirty = n.id in edits || (!!r.keyNode && r.keyNode.id in edits)
            const indent = 8 + (q ? 0 : r.depth * 18)
            const remove = r.owner && (
              <button
                className="btn sm ghost icon"
                title="Remove this entry"
                onClick={(e) => {
                  e.stopPropagation()
                  removeEntry(r)
                }}
              >
                <X size={11} />
              </button>
            )
            if (r.group) {
              const open = !collapsed.has(n.id)
              return (
                <div key={n.id} className={'setting-row group' + (r.depth === 0 ? ' top' : '')} style={{ paddingLeft: indent }} onClick={() => toggle(n.id)}>
                  <span className="caret">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
                  {name(r)}
                  <span className="setting-count">
                    {r.count} {r.count === 1 ? 'entry' : 'entries'}
                  </span>
                  {r.collection && (
                    <button
                      className="btn sm ghost"
                      title={r.collection.kind === 'dict' ? 'Add a key and value' : 'Add an entry'}
                      onClick={(e) => {
                        e.stopPropagation()
                        addEntry(r)
                      }}
                    >
                      <Plus size={11} /> Add
                    </button>
                  )}
                  {remove}
                </div>
              )
            }
            const sc = r.schema
            const val = edits[n.id] ?? n.text
            return (
              <div key={n.id} className={'setting-row' + (dirty ? ' dirty' : '')} style={{ paddingLeft: indent }}>
                <span className="caret" />
                {name(r)}
                {control(n, sc, r.virtual)}
                {sc && sc.def !== null && !sc.defUnknown && val !== sc.def && !(dirty && n.text === sc.def) && (
                  <button className="btn sm ghost icon" title={`Reset to default (${sc.def || 'empty'})`} onClick={() => setVal(n, sc.def!)}>
                    <RotateCcw size={11} />
                  </button>
                )}
                {n.id in edits && (
                  <button className="btn sm ghost icon" title={`Undo (was ${n.text || 'empty'})`} onClick={() => setVal(n, n.text!)}>
                    <Undo2 size={11} />
                  </button>
                )}
                {remove}
              </div>
            )
          })}
          {visible.length > 600 && <div className="empty">Showing 600 of {visible.length}. Use the filter or collapse groups to narrow it down.</div>}
          {q && doc && !visible.length && <div className="empty">No settings match “{q}”.</div>}
        </div>
        <div className="modal-foot">
          <span className="grow dim" style={{ alignSelf: 'center', fontSize: 12 }}>
            {changed
              ? `${changed} unsaved change${changed === 1 ? '' : 's'}`
              : schema
                ? 'Labels, defaults and limits come from the mod’s code. Hover a setting for its file name.'
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
