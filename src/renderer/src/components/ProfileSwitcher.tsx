import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Settings2, UserRound } from 'lucide-react'
import type { Profile } from '@shared/types'
import { isDirty, useStore } from '../store'
import { api } from '../api'
import { useDefs } from '../defStore'
import { useInstalls } from './Installs'

/** Loads a profile: its game install (if different) and its mods, written to ModsConfig.xml so the game uses them. */
export async function switchProfile(id: string) {
  const s = useStore.getState()
  if (isDirty(s) && !confirm('You have unsaved load order changes. Switch profile and discard them?')) return
  try {
    const app = await api.switchProfile(id)
    const active = app.config?.activeMods ?? []
    useStore.setState({ app, active, saved: active, past: [], future: [], selection: new Set(), focus: null })
    s.setActive(active, false)
    useDefs.setState({ data: null, scannedFor: '' })
    void useStore.getState().refreshXml()
    void useStore.getState().refreshChanges()
    await useInstalls.getState().load()
    const p = app.user.profiles?.find((x) => x.id === id)
    useStore.getState().toast('ok', `Profile “${p?.name}” loaded (${active.length} mods)`)
  } catch (e: any) {
    useStore.getState().toast('error', e.message)
  }
}

/** Title-bar chip showing the active profile, with a quick switch menu. */
export function ProfileSwitcher() {
  const s = useStore()
  const { list, load } = useInstalls()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const profiles = s.app?.user.profiles ?? []
  const current = profiles.find((p) => p.id === s.app?.user.currentProfile)
  useEffect(() => {
    if (!list) void load()
  }, [])
  useEffect(() => {
    if (!open) return
    const close = (e: Event) => !ref.current?.contains(e.target as Node) && setOpen(false)
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])
  const versionOf = (p: Profile) => list?.find((i) => i.id === p.installId)?.version.match(/^\d+\.\d+/)?.[0] ?? ''
  const installName = (p: Profile) => list?.find((i) => i.id === p.installId)?.name ?? 'Missing install'

  return (
    <div ref={ref} className="no-drag" style={{ position: 'relative' }}>
      <button className="btn ghost sm install-chip" onClick={() => setOpen(!open)} title="Switch profile">
        <UserRound size={12} />
        <span className="ellipsis" style={{ maxWidth: 160 }}>{current?.name ?? 'Profile'}</span>
        <span className="dim mono" style={{ fontSize: 10.5 }}>{current ? versionOf(current) : ''}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="menu" style={{ position: 'absolute', left: 0, top: 30, width: 340 }}>
          <div className="menu-label">Profiles</div>
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                setOpen(false)
                if (p.id !== current?.id) void switchProfile(p.id)
              }}
            >
              {p.id === current?.id ? <Check size={14} color="var(--accent)" /> : <span style={{ width: 14 }} />}
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="ellipsis" style={{ display: 'block', fontWeight: 560 }}>{p.name}</span>
                <span className="ellipsis dim" style={{ display: 'block', fontSize: 11 }}>
                  {installName(p)} · {p.mods.length} mods
                </span>
              </span>
              <span className="dim mono" style={{ fontSize: 10.5 }}>{versionOf(p)}</span>
            </button>
          ))}
          <hr />
          <button
            onClick={() => {
              setOpen(false)
              s.setView('lists')
            }}
          >
            <Settings2 size={14} /> Manage profiles…
          </button>
        </div>
      )}
    </div>
  )
}
