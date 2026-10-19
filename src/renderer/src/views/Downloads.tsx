import { useMemo, useState, type ReactNode } from 'react'
import { CircleAlert, CircleCheck, Clock, Download, ExternalLink, FolderOpen, KeyRound, LoaderCircle, RefreshCw, RotateCw, Terminal, X } from 'lucide-react'
import type { DownloadJob, WorkshopUpdate } from '@shared/types'
import { parseWorkshopIds } from '@shared/workshop'
import { useStore } from '../store'
import { api, workshopUrl } from '../api'
import { bytes, timeAgo } from '../lib'
import { ModIcon } from '../components/ui'
import { CollectionPanel } from './Collection'
import { SteamAccountPanel } from './SteamAccount'

const STATUS_LABEL: Record<DownloadJob['status'], string> = {
  queued: 'Queued',
  downloading: 'Downloading',
  installing: 'Installing',
  done: 'Installed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

const BASIS_LABEL: Record<WorkshopUpdate['basis'], string> = {
  steam: "from Steam's records",
  rimdeck: "from RimDeck's download record",
  mtime: 'guessed from file dates',
}

const busy = (j: DownloadJob) => j.status === 'queued' || j.status === 'downloading' || j.status === 'installing'

function StatusIcon({ job }: { job: DownloadJob }) {
  if (job.status === 'done') return <CircleCheck size={14} color="var(--ok)" />
  if (job.status === 'failed') return <CircleAlert size={14} color="var(--err)" />
  if (job.status === 'cancelled') return <X size={14} color="var(--text-3)" />
  if (job.status === 'queued') return <Clock size={14} color="var(--text-3)" />
  return <LoaderCircle size={14} className="spin" color="var(--accent-text)" />
}

/** Two-step button for actions that replace files. */
function ConfirmButton({ label, confirm, onConfirm, className = 'btn sm' }: { label: ReactNode; confirm: string; onConfirm: () => void; className?: string }) {
  const [armed, setArmed] = useState(false)
  if (!armed)
    return (
      <button className={className} onClick={() => setArmed(true)}>
        {label}
      </button>
    )
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="dim" style={{ fontSize: 11.5 }}>{confirm}</span>
      <button className={className + ' primary'} onClick={() => { setArmed(false); onConfirm() }}>
        Confirm
      </button>
      <button className="btn sm ghost icon" title="Close" aria-label="Close" onClick={() => setArmed(false)}>
        <X size={12} />
      </button>
    </span>
  )
}

export function DownloadsView() {
  const s = useStore()
  const d = s.downloads
  const [input, setInput] = useState('')
  const jobs = d?.jobs ?? []
  const active = jobs.filter(busy)
  const finished = jobs.filter((j) => !busy(j))
  const since = active.length ? Math.min(...active.map((j) => j.addedAt)) : Infinity
  const batchDone = jobs.filter((j) => j.status === 'done' && (j.finishedAt ?? 0) >= since).length

  // Every Workshop id that a "Download" fix anywhere in the current problems points at.
  const missing = useMemo(() => {
    const ids = new Set<string>()
    for (const i of s.issues) for (const f of i.fixes) if (f.fix.type === 'download' && i.kind !== 'replacement') f.fix.workshopIds.forEach((id) => ids.add(id))
    for (const j of active) ids.delete(j.workshopId)
    return [...ids]
  }, [s.issues, active.length])

  const updates = s.updates?.updates ?? []
  const localUpdates = updates.filter((u) => u.source === 'local')
  const steamUpdates = updates.filter((u) => u.source === 'workshop')
  const removed = (s.updates?.removed ?? []).map((id) => s.app!.mods.find((m) => m.workshopId === id)).filter((m) => !!m)

  const submit = () => {
    const ids = parseWorkshopIds(input)
    if (!ids.length) return s.toast('error', 'Paste a Workshop link or numeric ID')
    void s.download(ids)
    setInput('')
  }
  const run = (p: Promise<any>) => p.then((st) => st && 'jobs' in st && s.setDownloads(st)).catch((e) => s.toast('error', e.message))

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Downloads & updates</h1>
          <p>Downloads Workshop mods with SteamCMD (anonymous by default) into your local mods folder, and checks installed mods for newer uploads.</p>
        </div>
        <button className="btn" disabled={s.checkingUpdates} onClick={() => s.checkUpdates(true)}>
          <RefreshCw size={14} className={s.checkingUpdates ? 'spin' : ''} /> Check for updates
        </button>
        <button className="btn primary" disabled={!missing.length} onClick={() => s.download(missing)} title="Every missing dependency or listed-but-not-installed mod with a known Workshop page">
          <Download size={14} /> Download missing{missing.length ? ` (${missing.length})` : ''}
        </button>
      </div>

      <div className="panel">
        <div className="panel-head">
          <input
            className="input grow"
            value={input}
            placeholder="Paste one or more Workshop links or IDs…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <button className="btn primary" onClick={submit} disabled={!input.trim()}>
            <Download size={14} /> Download
          </button>
        </div>
        <div className="panel-body">
          <div className="kv">
            <span>Installs into</span>
            <span className="mono ellipsis">
              {d?.targetDir || <span style={{ color: 'var(--err)' }}>No local mods folder set</span>}
              {d?.targetDir && (
                <button className="btn sm ghost icon" title="Open folder" onClick={() => api.openPath(d.targetDir)} style={{ marginLeft: 6 }}>
                  <FolderOpen size={12} />
                </button>
              )}
            </span>
            <span>SteamCMD</span>
            <span className="row" style={{ gap: 8 }}>
              {d?.phase === 'installing-steamcmd' ? (
                <span className="muted"><LoaderCircle size={12} className="spin" /> Installing…</span>
              ) : d?.steamcmd.installed ? (
                <span className="mono ellipsis muted">{d.steamcmd.dir}</span>
              ) : (
                <>
                  <span className="muted">Not installed yet. It is set up automatically (about 45 MB) on the first download.</span>
                  <button className="btn sm" onClick={() => run(api.installSteamcmd())}>
                    Install now
                  </button>
                </>
              )}
            </span>
          </div>
        </div>
      </div>

      <SteamAccountPanel />

      <CollectionPanel />

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <h3 className="grow">
            Queue
            {active.length > 0 && <span className="dim" style={{ fontWeight: 400 }}> · {active.length} remaining{batchDone ? `, ${batchDone} installed` : ''}</span>}
          </h3>
          {active.length > 0 && (
            <button className="btn sm" onClick={() => run(api.cancelDownloads())}>
              <X size={12} /> Cancel all
            </button>
          )}
          {finished.length > 0 && (
            <button className="btn sm ghost" onClick={() => run(api.clearDownloads())}>
              Clear finished
            </button>
          )}
        </div>
        {active.length > 0 && (
          <div className="progress" title={`${batchDone} of ${batchDone + active.length}`}>
            <span style={{ width: `${(100 * batchDone) / (batchDone + active.length)}%` }} />
          </div>
        )}
        {jobs.length ? (
          <table className="table">
            <tbody>
              {[...active, ...finished.slice().reverse()].map((j) => {
                const mod = j.status === 'done' ? s.app!.mods.find((m) => m.path === j.path) : undefined
                return (
                  <tr key={j.workshopId}>
                    <td style={{ width: 26 }}>
                      <StatusIcon job={j} />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        {mod && <ModIcon mod={mod} size={18} />}
                        <b style={{ fontWeight: 580 }} className="ellipsis">{j.title}</b>
                        {j.update && <span className="chip info">update</span>}
                      </div>
                      <div className="dim" style={{ fontSize: 11.5 }}>
                        {STATUS_LABEL[j.status]}
                        {j.message ? `: ${j.message}` : ''}
                        {j.finishedAt && !busy(j) ? ` · ${timeAgo(j.finishedAt)}` : ''}
                      </div>
                      {j.status === 'downloading' && <div className="progress indeterminate" style={{ marginTop: 6 }}><span /></div>}
                    </td>
                    <td className="mono muted" style={{ width: 90 }}>{j.size ? bytes(j.size) : ''}</td>
                    <td style={{ width: 1, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {busy(j) && j.status !== 'installing' && (
                        <button className="btn sm ghost" title={j.status === 'downloading' ? 'Stops the current SteamCMD session; other items in it are re-queued' : 'Remove from queue'} onClick={() => run(api.cancelDownloads([j.workshopId]))}>
                          Cancel
                        </button>
                      )}
                      {j.status === 'failed' && j.needsLogin && (
                        <button className="btn sm" title="Log in with a Steam account that owns RimWorld" onClick={() => document.getElementById('steam-account')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>
                          <KeyRound size={11} /> Log in
                        </button>
                      )}
                      {(j.status === 'failed' || j.status === 'cancelled') && (
                        <button className="btn sm" onClick={() => s.download([j.workshopId])}>
                          <RotateCw size={11} /> Retry
                        </button>
                      )}
                      {mod && (
                        <button className="btn sm" onClick={() => { s.showMod(mod.packageId) }}>
                          Show mod
                        </button>
                      )}
                      {j.path && (
                        <button className="btn sm ghost icon" title="Open folder" onClick={() => api.openPath(j.path!)}>
                          <FolderOpen size={12} />
                        </button>
                      )}
                      <button className="btn sm ghost icon" title="Workshop page" onClick={() => api.openUrl(workshopUrl(j.workshopId))}>
                        <ExternalLink size={12} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty">No downloads yet. Use “Download” on a missing dependency in Problems or a save in Saves, or paste a link above.</div>
        )}
        {(d?.log.length ?? 0) > 0 && (
          <details className="dl-log">
            <summary>
              <Terminal size={12} /> SteamCMD output
            </summary>
            <pre>{d!.log.slice(-120).join('\n')}</pre>
          </details>
        )}
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <h3 className="grow">
            Updates
            {s.updates && !s.updates.error && (
              <span className="dim" style={{ fontWeight: 400 }}> · {s.updates.checked} Workshop mods checked {timeAgo(s.updates.checkedAt)}</span>
            )}
          </h3>
          {localUpdates.length > 1 && (
            <ConfirmButton
              label={<><Download size={12} /> Update all {localUpdates.length} local</>}
              confirm="Old copies go to the Recycle Bin."
              onConfirm={() => s.download(localUpdates.map((u) => u.workshopId))}
            />
          )}
        </div>
        {s.updates?.error && <div className="empty" style={{ color: 'var(--err)' }}>{s.updates.error}</div>}
        {!s.updates && <div className="empty">{s.checkingUpdates ? 'Checking the Workshop…' : 'Not checked yet.'}</div>}
        {s.updates && !s.updates.error && !updates.length && !removed.length && <div className="empty">All installed Workshop mods are up to date.</div>}
        {updates.length > 0 && (
          <table className="table">
            <tbody>
              {[...localUpdates, ...steamUpdates].map((u) => {
                const mod = s.app!.mods.find((m) => m.path === u.path)
                const queued = active.some((j) => j.workshopId === u.workshopId)
                return (
                  <tr key={u.path}>
                    <td style={{ width: 30 }}>
                      <ModIcon mod={mod} size={20} />
                    </td>
                    <td>
                      <b style={{ fontWeight: 580, cursor: 'pointer' }} onClick={() => { s.showMod(u.packageId) }}>{u.name}</b>
                      <div className="dim" style={{ fontSize: 11.5 }}>
                        Updated {timeAgo(u.remoteTime * 1000)} · your copy is from {new Date(u.localTime * 1000).toLocaleDateString()} ({BASIS_LABEL[u.basis]})
                      </div>
                    </td>
                    <td style={{ width: 1, whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {u.source === 'workshop' ? (
                        <>
                          <span className="dim" style={{ fontSize: 11.5, marginRight: 8 }}>Steam updates subscribed mods</span>
                          <button className="btn sm" onClick={() => api.openUrl('steam://open/downloads')}>
                            <ExternalLink size={11} /> Steam downloads
                          </button>
                        </>
                      ) : queued ? (
                        <span className="dim">Queued</span>
                      ) : (
                        <ConfirmButton label={<><Download size={11} /> Update</>} confirm="Old copy goes to the Recycle Bin." onConfirm={() => s.download([u.workshopId])} />
                      )}
                      <button className="btn sm ghost icon" title="Workshop page" onClick={() => api.openUrl(workshopUrl(u.workshopId))}>
                        <ExternalLink size={12} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
        {removed.length > 0 && (
          <div className="panel-body">
            <div className="dim" style={{ fontSize: 11.5, marginBottom: 6 }}>No longer available on the Workshop (removed or made private). Your installed copy still works.</div>
            <div className="chips">
              {removed.map((m) => (
                <span key={m.uid} className="chip click" onClick={() => { s.showMod(m.packageId) }}>
                  {m.name}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
