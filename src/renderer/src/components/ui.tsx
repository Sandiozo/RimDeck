import { memo, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Box, CircleAlert, FolderOpen, Info, Package, TriangleAlert } from 'lucide-react'
import type { Issue, ModInfo } from '@shared/types'
import { imgUrl } from '../api'
import { worst } from '../lib'

/** Props that make a non-button element clickable with the keyboard too (Enter or Space). */
export function clickable(fn: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e: { key: string; preventDefault(): void }) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        fn()
      }
    },
  }
}

export function Toggle({ on, onChange, title }: { on: boolean; onChange: (v: boolean) => void; title?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={title} className={'toggle' + (on ? ' on' : '')} title={title} onClick={() => onChange(!on)} />
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={v} type="button" aria-pressed={v === value} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

export const ModIcon = memo(function ModIcon({ mod, size = 20 }: { mod?: ModInfo; size?: number }) {
  const [failed, setFailed] = useState(false)
  const src = mod?.iconPath ?? mod?.previewPath
  useEffect(() => setFailed(false), [src])
  const style = { width: size, height: size }
  if (src && !failed)
    return (
      <span className="mod-icon" style={style}>
        <img src={imgUrl(src, size * 2)} loading="lazy" decoding="async" draggable={false} onError={() => setFailed(true)} />
      </span>
    )
  const Icon = !mod ? CircleAlert : mod.source === 'dlc' || mod.source === 'core' ? Box : mod.source === 'local' ? FolderOpen : Package
  return (
    <span className="mod-icon" style={style}>
      <Icon size={size * 0.6} />
    </span>
  )
})

export function SeverityIcon({ severity, size = 14 }: { severity: Issue['severity']; size?: number }) {
  if (severity === 'error') return <CircleAlert size={size} color="var(--err)" />
  if (severity === 'warning') return <TriangleAlert size={size} color="var(--warn)" />
  return <Info size={size} color="var(--info)" />
}

/**
 * Calls onEscape when Escape is pressed while el is the topmost menu or dialog, so one press
 * closes one layer. Menus sit above dialogs; of the same kind, the one added last is on top.
 */
export function useEscape(ref: RefObject<HTMLElement | null>, onEscape: () => void, enabled = true) {
  const fn = useRef(onEscape)
  fn.current = onEscape
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.defaultPrevented || !ref.current) return
      const top = [...document.querySelectorAll('.menu')].pop() ?? [...document.querySelectorAll('.overlay')].pop()
      if (top !== ref.current) return
      // Runs in the capture phase and stops here, so the app's own Escape handling doesn't close a second layer.
      e.preventDefault()
      e.stopPropagation()
      fn.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [enabled, ref])
}

export function IssueBadge({ issues }: { issues?: Issue[] }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const card = useRef<HTMLSpanElement>(null)
  // The card is fixed to the window: below the icon, or above it when there is no room below.
  useLayoutEffect(() => {
    const el = card.current
    if (!anchor || !el) return
    const left = Math.max(8, Math.min(anchor.right + 6 - el.offsetWidth, window.innerWidth - el.offsetWidth - 8))
    const below = anchor.bottom + 4
    const top = below + el.offsetHeight + 8 <= window.innerHeight ? below : Math.max(8, anchor.top - 4 - el.offsetHeight)
    el.style.left = `${left}px`
    el.style.top = `${top}px`
  }, [anchor])
  const sev = worst(issues)
  if (!sev || !issues) return null
  const shown = issues.filter((i) => i.severity !== 'info' || sev === 'info')
  return (
    <span
      className={'issue-badge ' + sev}
      onClick={(e) => e.stopPropagation()}
      onMouseEnter={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setAnchor(null)}
    >
      <SeverityIcon severity={sev} size={13} />
      {anchor && <span className="hovercard" ref={card}>
        {shown.slice(0, 6).map((i) => (
          <span className="hc-item" key={i.id}>
            <SeverityIcon severity={i.severity} size={13} />
            <span>
              {i.title}
              {i.detail && <span className="dim"> — {i.detail.split('\n')[0]}</span>}
            </span>
          </span>
        ))}
        {shown.length > 6 && <span className="hc-item dim">+{shown.length - 6} more</span>}
      </span>}
    </span>
  )
}

