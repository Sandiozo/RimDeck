import { memo, useEffect, useState } from 'react'
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

export function IssueBadge({ issues }: { issues?: Issue[] }) {
  const sev = worst(issues)
  if (!sev || !issues) return null
  const shown = issues.filter((i) => i.severity !== 'info' || sev === 'info')
  return (
    <span className={'issue-badge ' + sev} onClick={(e) => e.stopPropagation()}>
      <SeverityIcon severity={sev} size={13} />
      <span className="hovercard">
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
      </span>
    </span>
  )
}

