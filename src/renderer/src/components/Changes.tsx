import { useState } from 'react'
import { History, ExternalLink, X, ListFilter } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../api'
import { timeAgo } from '../lib'
import { ModIcon } from './ui'

const dismissKey = (since: number) => `rimdeck.changes.dismissed.${since}`
function isDismissed(since: number) {
  try {
    return localStorage.getItem(dismissKey(since)) === '1'
  } catch {
    return false
  }
}

export function changedIds(c: NonNullable<ReturnType<typeof useStore.getState>['changes']>) {
  return new Set([...c.updated, ...c.added, ...c.activated])
}

export function ChangesBanner({ onFilter }: { onFilter: (q: string) => void }) {
  const s = useStore()
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(false)
  const c = s.changes
  if (!c || !c.since || hidden || isDismissed(c.since)) return null
  const total = c.updated.length + c.added.length + c.removed.length + c.activated.length + c.deactivated.length
  if (!total) return null
  const parts = [
    c.updated.length && `${c.updated.length} updated`,
    c.added.length && `${c.added.length} new`,
    c.removed.length && `${c.removed.length} removed`,
    c.activated.length && `${c.activated.length} turned on`,
    c.deactivated.length && `${c.deactivated.length} turned off`,
  ].filter(Boolean)
  return (
    <>
      <div className="banner accent">
        <History size={15} color="var(--accent)" />
        <span className="grow">
          Since you last played ({timeAgo(c.since)}): <b>{parts.join(' · ')}</b>
        </span>
        <button className="btn sm" onClick={() => onFilter('is:changed')}>
          <ListFilter size={12} /> Show in lists
        </button>
        <button className="btn sm" onClick={() => setOpen(true)}>
          Review
        </button>
        <button
          className="btn sm ghost icon"
          title="Dismiss until next time you play"
          onClick={() => {
            try {
              localStorage.setItem(dismissKey(c.since), '1')
            } catch {}
            setHidden(true)
          }}
        >
          <X size={13} />
        </button>
      </div>
      {open && <ChangesModal onClose={() => setOpen(false)} />}
    </>
  )
}

function ChangesModal({ onClose }: { onClose: () => void }) {
  const s = useStore()
  const c = s.changes!
  const Section = ({ title, ids, note }: { title: string; ids: string[]; note?: (pid: string) => string }) =>
    ids.length ? (
      <div className="d-section" style={{ margin: '0 8px 14px' }}>
        <h4>
          {title} <span className="count">{ids.length}</span>
        </h4>
        {ids.map((pid) => {
          const m = s.installed.get(pid)?.[0]
          return (
            <div key={pid} className="d-item click" onClick={() => { s.select(pid); s.setView('mods'); onClose() }}>
              <ModIcon mod={m} size={18} />
              <span className="grow ellipsis">{m?.name ?? pid}</span>
              {note && <span className="dim" style={{ fontSize: 11.5 }}>{note(pid)}</span>}
              {m?.workshopId && (
                <button
                  className="btn sm ghost"
                  title="Open the mod's change notes on Steam"
                  onClick={(e) => {
                    e.stopPropagation()
                    api.openUrl(`https://steamcommunity.com/sharedfiles/filedetails/changelog/${m.workshopId}`)
                  }}
                >
                  <ExternalLink size={11} /> Change notes
                </button>
              )}
            </div>
          )
        })}
      </div>
    ) : null

  const active = new Set(s.active)
  const updatedActive = c.updated.filter((p) => active.has(p))
  const updatedInactive = c.updated.filter((p) => !active.has(p))
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <History size={20} color="var(--accent)" style={{ marginTop: 2 }} />
          <div className="grow">
            <h2>Changes since you last played</h2>
            <p>
              Last game start {new Date(c.since).toLocaleString()} ({c.source === 'rimdeck' ? 'launched from RimDeck' : 'from the game log'}). If something broke, start with the
              updated active mods.
            </p>
          </div>
        </div>
        <div className="modal-body">
          <Section title="Updated (active)" ids={updatedActive} note={(p) => timeAgo(s.installed.get(p)?.[0]?.mtime ?? 0)} />
          <Section title="Turned on" ids={c.activated} />
          <Section title="Turned off" ids={c.deactivated} />
          <Section title="Newly installed" ids={c.added} note={(p) => (active.has(p) ? 'active' : 'inactive')} />
          <Section title="Updated (inactive)" ids={updatedInactive} />
          {c.removed.length > 0 && (
            <div className="d-section" style={{ margin: '0 8px 14px' }}>
              <h4>
                Uninstalled <span className="count">{c.removed.length}</span>
              </h4>
              {c.removed.map((r) => (
                <div key={r.packageId} className="d-item">
                  <span className="dot err" />
                  <span className="grow ellipsis">{r.name}</span>
                  <span className="mono dim" style={{ fontSize: 11 }}>{r.packageId}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
