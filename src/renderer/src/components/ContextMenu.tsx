import { useEffect } from 'react'
import { create } from 'zustand'
import { Gamepad2, Trash, SlidersHorizontal, ArrowDownToLine, ArrowUpToLine, Copy, ExternalLink, EyeOff, Eye, FolderOpen, Minus, Plus } from 'lucide-react'
import { categoryOf, useStore } from '../store'
import { CATEGORY_LABEL } from '@shared/graph'
import type { ModCategory } from '@shared/types'
import { api, workshopUrl } from '../api'
import { TAG_COLORS } from '../lib'
import { openSettings, settingsFor, useSettingsFiles } from './SettingsEditor'
import { removeLabel, removeMods, steamUrl } from '../removeMods'

interface MenuState {
  open: { x: number; y: number; pid: string; kind: 'active' | 'inactive' } | null
}
const useMenu = create<MenuState>(() => ({ open: null }))

export function openContextMenu(x: number, y: number, pid: string, kind: 'active' | 'inactive') {
  useMenu.setState({ open: { x, y, pid, kind } })
}

export function ContextMenu() {
  const open = useMenu((m) => m.open)
  const s = useStore()
  useEffect(() => {
    if (!open) return
    const close = () => useMenu.setState({ open: null })
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [open])
  if (!open) return null

  const ids = s.selection.has(open.pid) ? [...s.selection] : [open.pid]
  const mod = s.installed.get(open.pid)?.[0]
  const meta = s.app?.user.meta[open.pid]
  const ignored = s.app?.user.ignored.includes(open.pid)
  const multi = ids.length > 1
  const cfg = !multi && mod && (mod.source === 'local' || mod.source === 'workshop') ? settingsFor(useSettingsFiles.getState().files, mod.folder) : []
  const run = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
    useMenu.setState({ open: null })
  }
  const x = Math.min(open.x, window.innerWidth - 230)
  const y = Math.max(8, Math.min(open.y, window.innerHeight - 520))

  return (
    <div className="menu" style={{ left: x, top: y, maxHeight: window.innerHeight - 16, overflowY: 'auto' }} onMouseDown={(e) => e.stopPropagation()}>
      {open.kind === 'inactive' ? (
        <button onClick={run(() => s.activate(ids))}>
          <Plus size={14} /> Activate{multi ? ` ${ids.length} mods` : ''}
        </button>
      ) : (
        <>
          <button onClick={run(() => s.deactivate(ids))}>
            <Minus size={14} /> Deactivate{multi ? ` ${ids.length} mods` : ''}
          </button>
          <button onClick={run(() => s.move(ids, 0))}>
            <ArrowUpToLine size={14} /> Move to top
          </button>
          <button onClick={run(() => s.move(ids, s.active.length))}>
            <ArrowDownToLine size={14} /> Move to bottom
          </button>
        </>
      )}
      <hr />
      {cfg.length > 0 && (
        <button onClick={run(() => openSettings(cfg[0].path))}>
          <SlidersHorizontal size={14} /> Configure mod settings…
        </button>
      )}
      {mod && (
        <button onClick={run(() => api.openPath(mod.path))}>
          <FolderOpen size={14} /> Open folder
        </button>
      )}
      {mod?.workshopId && (
        <button onClick={run(() => api.openUrl(workshopUrl(mod.workshopId!)))}>
          <ExternalLink size={14} /> Workshop page
        </button>
      )}
      {mod?.workshopId && (
        <button onClick={run(() => api.openUrl(steamUrl(mod.workshopId!)))}>
          <Gamepad2 size={14} /> Open in Steam
        </button>
      )}
      <button onClick={run(() => navigator.clipboard.writeText(ids.join('\n')))}>
        <Copy size={14} /> Copy packageId{multi ? 's' : ''}
      </button>
      <button
        onClick={run(() => {
          const set = new Set(s.app!.user.ignored)
          ids.forEach((id) => (ignored ? set.delete(id) : set.add(id)))
          s.setUser({ ignored: [...set] })
        })}
      >
        {ignored ? <Eye size={14} /> : <EyeOff size={14} />} {ignored ? 'Show warnings' : 'Mute warnings'}
      </button>
      <hr />
      <div className="menu-label">Category</div>
      <div className="menu-cats">
        {(Object.keys(CATEGORY_LABEL) as ModCategory[])
          .filter((c) => c !== 'game')
          .map((c) => {
            const current = categoryOf(s, open.pid) === c
            return (
              <span
                key={c}
                className={'chip click' + (current ? ' accent' : '')}
                onClick={run(() =>
                  ids.forEach((id) => {
                    const auto = s.installed.get(id)?.[0]?.category
                    s.setMeta(id, { ...s.app!.user.meta[id], category: c === auto ? undefined : c })
                  }),
                )}
              >
                {CATEGORY_LABEL[c]}
              </span>
            )
          })}
        {meta?.category && (
          <span className="chip click" title="Back to automatic" onClick={run(() => ids.forEach((id) => s.setMeta(id, { ...s.app!.user.meta[id], category: undefined })))}>
            Auto
          </span>
        )}
      </div>
      {removeLabel(ids) && (
        <>
          <hr />
          <button className="danger-item" onClick={run(() => void removeMods(ids))}>
            <Trash size={14} /> {removeLabel(ids)}…
          </button>
        </>
      )}
      <hr />
      <div className="swatches" style={{ padding: '4px 8px 6px' }}>
        <span className="swatch none" title="No color" onClick={run(() => ids.forEach((id) => s.setMeta(id, { ...s.app!.user.meta[id], color: undefined })))}>
          ×
        </span>
        {TAG_COLORS.map((c) => (
          <span
            key={c}
            className={'swatch' + (meta?.color === c ? ' on' : '')}
            style={{ background: c }}
            onClick={run(() => ids.forEach((id) => s.setMeta(id, { ...s.app!.user.meta[id], color: c })))}
          />
        ))}
      </div>
    </div>
  )
}
