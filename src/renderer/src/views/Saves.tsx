import { useEffect, useMemo, useState } from 'react'
import { FolderOpen, RefreshCw, Download, ExternalLink, Play } from 'lucide-react'
import type { SaveSummary } from '@shared/types'
import { resolver } from '@shared/graph'
import { useStore } from '../store'
import { api, workshopUrl } from '../api'
import { bytes, timeAgo } from '../lib'
import { ModIcon } from '../components/ui'

export function SavesView() {
  const s = useStore()
  const [saves, setSaves] = useState<SaveSummary[] | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const load = () => api.listSaves().then(setSaves)
  useEffect(() => {
    load()
  }, [])

  const resolveInstalled = useMemo(() => resolver(s.installed.keys()), [s.installed])
  const status = (save: SaveSummary) => {
    const missing = save.modIds.filter((id) => !resolveInstalled(id))
    const active = new Set(s.active)
    const differs = save.modIds.length !== s.active.length || save.modIds.some((id) => !active.has(id))
    return { missing, differs }
  }
  const current = saves?.find((x) => x.path === sel) ?? null

  return (
    <div className="page">
      <div className="page-head">
        <div className="grow">
          <h1>Saves</h1>
          <p>See which mods each save was made with, what's missing, and load its mod list.</p>
        </div>
        <button className="btn" onClick={load}>
          <RefreshCw size={14} /> Refresh
        </button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: current ? 'minmax(0,1fr) 420px' : '1fr', gap: 12, alignItems: 'start' }}>
        <div className="panel">
          <table className="table">
            <thead>
              <tr>
                <th>Save</th>
                <th>Played</th>
                <th>Version</th>
                <th>Mods</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {saves?.map((sv) => {
                const st = status(sv)
                return (
                  <tr key={sv.path} className={'click' + (sel === sv.path ? ' on' : '')} onClick={() => setSel(sv.path)}>
                    <td>
                      <b style={{ fontWeight: 580 }}>{sv.name}</b>
                      <div className="dim" style={{ fontSize: 11.5 }}>{bytes(sv.size)}</div>
                    </td>
                    <td className="muted">{timeAgo(sv.mtime)}</td>
                    <td className="mono muted">{sv.gameVersion}</td>
                    <td className="mono">{sv.modIds.length}</td>
                    <td>
                      {st.missing.length ? (
                        <span className="chip err">{st.missing.length} missing</span>
                      ) : st.differs ? (
                        <span className="chip warn">Differs</span>
                      ) : (
                        <span className="chip ok">Same mods</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {saves && !saves.length && <div className="empty">No saves found.</div>}
          {!saves && <div className="empty">Reading saves…</div>}
        </div>
        {current && <SaveDetail save={current} />}
      </div>
    </div>
  )
}

function SaveDetail({ save }: { save: SaveSummary }) {
  const s = useStore()
  const resolveInstalled = resolver(s.installed.keys())
  const active = new Set(s.active)
  const saveSet = new Set(save.modIds)
  const missing = save.modIds.map((id, i) => ({ id, i })).filter(({ id }) => !resolveInstalled(id))
  const inactive = save.modIds.filter((id) => resolveInstalled(id) && !active.has(resolveInstalled(id)!))
  const extra = s.active.filter((id) => !saveSet.has(id))
  const missingSteam = [...new Set(missing.map(({ i }) => save.modSteamIds[i]).filter((id) => id && id !== '0'))]

  const adopt = () => {
    s.setActive(save.modIds.map((id) => resolveInstalled(id) ?? id))
    s.setView('mods')
    s.toast('ok', `Loaded ${save.modIds.length} mods from “${save.name}”. Review the list, then save.`)
  }

  // RimWorld can't be told which save to open, so this sets up the mods and the player picks the save in the menu.
  const play = async () => {
    if (missing.length && !confirm(`${missing.length} mod${missing.length === 1 ? '' : 's'} from this save ${missing.length === 1 ? 'is' : 'are'} not installed. Play anyway?`)) return
    s.setActive(save.modIds.map((id) => resolveInstalled(id) ?? id).filter((id) => s.installed.has(id)))
    await s.launch()
    s.toast('info', `Load “${save.name}” from the main menu once the game has started.`)
  }

  const Section = ({ title, ids, tone }: { title: string; ids: string[]; tone: string }) =>
    ids.length ? (
      <div className="d-section">
        <h4>
          {title} <span className={'chip ' + tone}>{ids.length}</span>
        </h4>
        {ids.slice(0, 60).map((id) => {
          const m = s.installed.get(resolveInstalled(id) ?? id)?.[0]
          const idx = save.modIds.indexOf(id)
          const steam = idx >= 0 ? save.modSteamIds[idx] : undefined
          return (
            <div key={id} className="d-item">
              <ModIcon mod={m} size={16} />
              <span className="grow ellipsis">{m?.name ?? save.modNames[idx] ?? id}</span>
              {!m && steam && steam !== '0' && (
                <>
                  <button className="btn sm" title="Download with SteamCMD" onClick={() => s.download([steam])}>
                    <Download size={11} /> Download
                  </button>
                  <button className="btn sm ghost icon" title="Workshop page" onClick={() => api.openUrl(workshopUrl(steam))}>
                    <ExternalLink size={11} />
                  </button>
                </>
              )}
            </div>
          )
        })}
      </div>
    ) : null

  return (
    <div className="panel" style={{ position: 'sticky', top: 0 }}>
      <div className="panel-head">
        <h3 className="grow ellipsis">{save.name}</h3>
        <button className="btn sm icon ghost" title="Show in folder" onClick={() => api.showItem(save.path)}>
          <FolderOpen size={13} />
        </button>
      </div>
      <div className="panel-body">
        <div className="kv">
          <span>Game version</span>
          <span className="mono">{save.gameVersion}</span>
          <span>Mods</span>
          <span>{save.modIds.length}</span>
        </div>
        <button className="btn primary" style={{ marginTop: 12, width: '100%', justifyContent: 'center' }} onClick={adopt}>
          Use this save's mod list
        </button>
        <button className="btn play" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }} onClick={play} title="Switch to this save's mods, save, and start RimWorld">
          <Play size={13} fill="currentColor" /> Play with this save's mods
        </button>
        {!missing.length && !inactive.length && !extra.length && <p className="muted">Your current load order has exactly these mods.</p>}
        {missingSteam.length > 1 && (
          <button className="btn" style={{ marginTop: 8, width: '100%', justifyContent: 'center' }} onClick={() => s.download(missingSteam)}>
            <Download size={14} /> Download all {missingSteam.length} missing
          </button>
        )}
        <Section title="Not installed" ids={missing.map((m) => m.id)} tone="err" />
        <Section title="Installed but inactive" ids={inactive} tone="warn" />
        <Section title="Active now, not in save" ids={extra} tone="info" />
      </div>
    </div>
  )
}
