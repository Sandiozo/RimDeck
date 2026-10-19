import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import { ChevronDown, ChevronRight, RotateCcw, Save, Search, SlidersHorizontal, TriangleAlert, Undo2, FolderOpen } from 'lucide-react'
import type { SettingsFile, SettingsNode } from '@shared/types'
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
              {bytes(f.size)} · {timeAgo(f.mtime)}
            </span>
            <button className="btn sm" onClick={() => useStore.setState({ settingsEditor: f.path })}>
              Edit
            </button>
            <button
              className="btn sm ghost icon"
              title="Reset to defaults (the file is backed up, and the game recreates it)"
              onClick={async () => {
                if (!confirm(`Reset ${f.className} to its defaults?\nThe current file is moved to RimDeck's backups.`)) return
                try {
                  await api.resetModSettings(f.path)
                  s.toast('ok', 'Settings reset — the game recreates defaults on next start')
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
          {files ? 'No saved settings yet. The game writes them the first time you change this mod’s options.' : 'Loading…'}
        </p>
      )}
    </div>
  )
}

interface Row {
  node: SettingsNode
  depth: number
  label: string
  path: string
}

function flatten(root: SettingsNode): Row[] {
  const rows: Row[] = []
  const walk = (n: SettingsNode, depth: number, trail: string[]) => {
    for (const [i, c] of (n.children ?? []).entries()) {
      // The ModSettings wrapper adds no information.
      if (depth === 0 && c.tag === 'ModSettings') {
        walk(c, 0, trail)
        continue
      }
      const label = c.tag === 'li' ? `[${i}]` : c.tag
      const path = [...trail, label].join(' › ')
      rows.push({ node: c, depth, label, path })
      // Scribe dictionaries are <keys> and <values> lists; show each value next to its key instead.
      const keys = c.children?.find((x) => x.tag === 'keys')
      const values = c.children?.find((x) => x.tag === 'values')
      const leaves = (x?: SettingsNode) => !!x?.children?.every((li) => li.tag === 'li' && li.text !== undefined)
      if (c.children?.length === 2 && keys && values && leaves(keys) && leaves(values) && keys.children!.length === values.children!.length) {
        values.children!.forEach((v, k) => {
          const key = keys.children![k].text || `[${k}]`
          rows.push({ node: v, depth: depth + 1, label: key, path: [...trail, label, key].join(' › ') })
        })
        continue
      }
      if (c.children) walk(c, depth + 1, [...trail, label])
    }
  }
  walk(root, 0, [])
  return rows
}

const isBool = (v: string) => v === 'True' || v === 'False'
const isNum = (v: string) => /^-?\d+(\.\d+)?(E[+-]?\d+)?$/i.test(v)

export function SettingsEditor() {
  const s = useStore()
  const path = s.settingsEditor
  const [root, setRoot] = useState<SettingsNode | null>(null)
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [q, setQ] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')
  const reloadFiles = useSettingsFiles((x) => x.load)

  useEffect(() => {
    if (!path) return
    setRoot(null)
    setEdits({})
    setError('')
    api.readModSettings(path).then(setRoot, (e) => setError(e.message))
    api.gameRunning().then(setRunning)
  }, [path])

  const rows = useMemo(() => (root ? flatten(root) : []), [root])
  const visible = useMemo(() => {
    const t = q.trim().toLowerCase()
    const hiddenUnder = [...collapsed]
    return rows.filter((r) => {
      if (t) return r.node.text !== undefined && (r.path.toLowerCase().includes(t) || (edits[r.node.id] ?? r.node.text ?? '').toLowerCase().includes(t))
      return !hiddenUnder.some((id) => r.node.id !== id && r.node.id.startsWith(id + '/'))
    })
  }, [rows, q, collapsed, edits])

  if (!path) return null
  const file = path.split(/[\\/]/).pop()!
  const folder = useSettingsFiles.getState().files?.find((f) => f.path === path)?.folder
  const mod = folder
    ? s.app?.mods.find((m) => m.folder === folder)
    : s.app?.mods.find((m) => (m.source === 'local' || m.source === 'workshop') && file.toLowerCase().startsWith(`mod_${m.folder.toLowerCase()}_`))
  const changed = Object.keys(edits).length
  const close = () => {
    if (changed && !confirm('Discard your unsaved changes?')) return
    useStore.setState({ settingsEditor: null })
  }

  const apply = (n: SettingsNode): SettingsNode => ({
    ...n,
    text: n.id in edits ? edits[n.id] : n.text,
    children: n.children?.map(apply),
  })

  const save = async () => {
    if (!root) return
    try {
      await api.writeModSettings(path, apply(root))
      s.toast('ok', `Saved ${changed} change${changed === 1 ? '' : 's'} — a backup of the old file was kept`)
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
        <div style={{ padding: '0 16px 10px' }}>
          <label className="pane-filter" style={{ margin: 0 }}>
            <Search size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter settings by name or value…" autoFocus />
            <span className="count">{rows.filter((r) => r.node.text !== undefined).length}</span>
          </label>
        </div>
        <div className="modal-body settings-body">
          {error && <div className="empty">{error}</div>}
          {!root && !error && <div className="empty">Reading…</div>}
          {visible.slice(0, 600).map((r) => {
            const n = r.node
            const leaf = n.text !== undefined
            const nul = n.attrs?.IsNull === 'True'
            const val = edits[n.id] ?? n.text ?? ''
            const dirty = n.id in edits
            return (
              <div key={n.id} className={'setting-row' + (dirty ? ' dirty' : '')} style={{ paddingLeft: 10 + (q ? 0 : r.depth * 16) }}>
                {leaf ? (
                  <span className="caret" />
                ) : (
                  <button
                    className="caret"
                    onClick={() => {
                      const next = new Set(collapsed)
                      next.has(n.id) ? next.delete(n.id) : next.add(n.id)
                      setCollapsed(next)
                    }}
                  >
                    {collapsed.has(n.id) ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                  </button>
                )}
                <span className={'grow ellipsis ' + (leaf ? '' : 'dim')} title={r.path}>
                  {q ? r.path : r.label}
                  {!leaf && <span className="dim"> · {n.children?.length ?? 0}</span>}
                </span>
                {leaf &&
                  (nul ? (
                    <span className="dim mono" style={{ fontSize: 11 }}>
                      null
                    </span>
                  ) : isBool(n.text!) ? (
                    <Toggle on={val === 'True'} onChange={(v) => setVal(n, v ? 'True' : 'False')} />
                  ) : (
                    <input
                      className={'input mono setting-input' + (isNum(n.text!) && !isNum(val) ? ' bad' : '')}
                      value={val}
                      onChange={(e) => setVal(n, e.target.value)}
                      spellCheck={false}
                    />
                  ))}
                {dirty && (
                  <button className="btn sm ghost icon" title={`Undo (was ${n.text})`} onClick={() => setVal(n, n.text!)}>
                    <Undo2 size={11} />
                  </button>
                )}
              </div>
            )
          })}
          {visible.length > 600 && <div className="empty">Showing 600 of {visible.length}. Use the filter to narrow it down.</div>}
        </div>
        <div className="modal-foot">
          <span className="grow dim" style={{ alignSelf: 'center', fontSize: 12 }}>
            {changed ? `${changed} unsaved change${changed === 1 ? '' : 's'}` : 'Names come from the mod’s code; the game’s settings window may label them differently.'}
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
