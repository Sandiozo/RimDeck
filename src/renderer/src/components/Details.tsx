import { useEffect, useMemo, useState } from 'react'
import { Gamepad2, Trash, SlidersHorizontal, Copy, Cpu, Download, ExternalLink, FolderOpen, Link2, Minus, Plus, Tags, StickyNote, Paintbrush, ArrowRight, Check } from 'lucide-react'
import type { ModCategory } from '@shared/types'
import { CATEGORY_LABEL, resolver } from '@shared/graph'
import { categoryOf, useStore } from '../store'
import { api, imgUrl, workshopUrl } from '../api'
import { richText, TAG_COLORS, timeAgo } from '../lib'
import { ModIcon, SeverityIcon } from './ui'
import { removeLabel, removeMods, steamUrl } from '../removeMods'
import { ModSettingsSection, openSettings, settingsFor, useSettingsFiles } from './SettingsEditor'

export function IssueCard({ issue }: { issue: import('@shared/types').Issue }) {
  const applyFix = useStore((s) => s.applyFix)
  return (
    <div className={'issue-card ' + issue.severity}>
      <div className="row">
        <SeverityIcon severity={issue.severity} />
        <span className="t">{issue.title}</span>
      </div>
      {issue.detail && <div className="d">{issue.detail}</div>}
      {issue.fixes.length > 0 && (
        <div className="f">
          {issue.fixes.map((f) => (
            <button key={f.label} className="btn sm" onClick={() => applyFix(f.fix)}>
              {f.fix.type === 'url' ? <ExternalLink size={12} /> : f.fix.type === 'download' ? <Download size={12} /> : <Check size={12} />} {f.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function Details() {
  const s = useStore()
  const pid = s.focus
  const mod = pid ? s.installed.get(pid)?.[0] : undefined
  const app = s.app!
  const meta = pid ? app.user.meta[pid] : undefined
  const [tagDraft, setTagDraft] = useState('')
  const [notes, setNotes] = useState(meta?.notes ?? '')
  const [showAll, setShowAll] = useState(false)
  useEffect(() => {
    setNotes(meta?.notes ?? '')
    setShowAll(false)
  }, [pid])

  const isActive = pid ? s.active.includes(pid) : false
  const settingsFiles = useSettingsFiles((x) => x.files)
  useEffect(() => {
    if (!settingsFiles) void useSettingsFiles.getState().load()
  }, [])
  const modSettings = mod && (mod.source === 'local' || mod.source === 'workshop') ? settingsFor(settingsFiles, mod.folder) : []
  const issues = pid ? (s.issuesByPid.get(pid) ?? []) : []
  const report = pid ? s.analysis[pid] : undefined
  const update = mod ? s.updates?.updates.find((u) => u.path === mod.path) : undefined

  const resolveInstalled = useMemo(() => resolver(s.installed.keys()), [s.installed])
  const resolveActive = useMemo(() => resolver(s.active), [s.active])

  // Other active mods that patch the same game methods.
  const overlaps = useMemo(() => {
    if (!report || !pid) return []
    const mine = new Set(report.patches.filter((p) => p.targetMember).map((p) => `${p.targetType}::${p.targetMember}`))
    const out: { pid: string; targets: string[] }[] = []
    for (const [other, r] of Object.entries(s.analysis)) {
      if (other === pid || !s.active.includes(other)) continue
      const shared = [...new Set(r.patches.map((p) => `${p.targetType}::${p.targetMember}`).filter((k) => mine.has(k)))]
      if (shared.length) out.push({ pid: other, targets: shared })
    }
    return out.sort((a, b) => b.targets.length - a.targets.length)
  }, [report, s.analysis, s.active, pid])

  if (!pid)
    return (
      <section className="pane details">
        <div className="hero blank" />
        <div className="details-body">
          <h2>No mod selected</h2>
          <p className="muted">Select a mod to see its details, problems, dependencies and Harmony patches.</p>
          <div className="d-section">
            <h4>Shortcuts</h4>
            <div className="kv">
              <span>Ctrl K</span><span>Search mods and commands</span>
              <span>Ctrl S</span><span>Save load order</span>
              <span>Ctrl Shift S</span><span>Auto-sort</span>
              <span>Ctrl Z / Y</span><span>Undo / redo</span>
              <span>Enter</span><span>Activate / deactivate selected</span>
              <span>Alt ↑ ↓</span><span>Move selected mods</span>
              <span>Double-click</span><span>Toggle a mod</span>
            </div>
          </div>
        </div>
      </section>
    )

  const setMeta = (patch: Partial<NonNullable<typeof meta>>) => s.setMeta(pid, { ...meta, ...patch })
  const addTag = () => {
    const t = tagDraft.trim()
    if (t && !meta?.tags?.includes(t)) setMeta({ tags: [...(meta?.tags ?? []), t] })
    setTagDraft('')
  }
  const dependents = s.dependents.get(pid) ?? []
  const supports = mod?.supportedVersions ?? []
  const category = categoryOf(s, pid)
  const description = mod?.description ?? ''
  const longDesc = description.length > 900 && !showAll

  return (
    <section className="pane details">
      <div className={'hero' + (mod?.previewPath ? '' : ' blank')}>{mod?.previewPath && <img key={mod.previewPath} src={imgUrl(mod.previewPath, 760)} draggable={false} />}</div>
      <div className="details-body">
        <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
          <ModIcon mod={mod} size={44} />
          <div className="grow">
            <h2>{mod?.name ?? pid}</h2>
            <div className="by ellipsis">{mod ? mod.authors.join(', ') || 'Unknown author' : 'Not installed'}</div>
          </div>
        </div>

        <div className="chips">
          <span className="chip click mono" title="Copy packageId" onClick={() => navigator.clipboard.writeText(mod?.packageIdRaw ?? pid)}>
            <Copy size={10} /> {mod?.packageIdRaw ?? pid}
          </span>
          {mod && <span className="chip">{mod.source === 'workshop' ? 'Workshop' : mod.source === 'local' ? 'Local' : mod.source === 'core' ? 'Core' : 'DLC'}</span>}
          {category && <span className="chip accent">{CATEGORY_LABEL[category]}</span>}
          {mod?.modVersion && <span className="chip">v{mod.modVersion}</span>}
          {supports.map((v) => (
            <span key={v} className={'chip' + (v === app.gameMajor ? ' ok' : '')}>
              {v}
            </span>
          ))}
          {mod && mod.source !== 'dlc' && mod.source !== 'core' && !supports.includes(app.gameMajor) && <span className="chip warn">Not marked for {app.gameMajor}</span>}
          {update && (
            <span className="chip info click" title={`Workshop upload from ${new Date(update.remoteTime * 1000).toLocaleString()}`} onClick={() => s.setView('downloads')}>
              <Download size={10} /> Update available
            </span>
          )}
        </div>

        <div className="actions">
          {pid !== 'ludeon.rimworld' &&
            (isActive ? (
              <button className="btn sm" onClick={() => s.deactivate([pid])}>
                <Minus size={13} /> Deactivate
              </button>
            ) : (
              mod && (
                <button className="btn sm primary" onClick={() => s.activate([pid])}>
                  <Plus size={13} /> Activate
                </button>
              )
            ))}
          {modSettings.length > 0 && (
            <button className="btn sm" title="Edit this mod's saved settings without starting the game" onClick={() => openSettings(modSettings[0].path)}>
              <SlidersHorizontal size={13} /> Configure
            </button>
          )}
          {mod && (
            <button className="btn sm" onClick={() => api.openPath(mod.path)}>
              <FolderOpen size={13} /> Folder
            </button>
          )}
          {mod?.workshopId && (
            <button className="btn sm" title="Open the Workshop page in your browser" onClick={() => api.openUrl(workshopUrl(mod.workshopId!))}>
              <ExternalLink size={13} /> Workshop
            </button>
          )}
          {mod?.workshopId && (
            <button className="btn sm" title="Open the Workshop page in the Steam app" onClick={() => api.openUrl(steamUrl(mod.workshopId!))}>
              <Gamepad2 size={13} /> Open in Steam
            </button>
          )}
          {removeLabel([pid]) && (
            <button
              className="btn sm ghost danger"
              title={mod?.source === 'workshop' ? 'Unsubscribe on Steam; Steam then deletes the files' : 'Move this mod folder to the Recycle Bin'}
              onClick={() => removeMods([pid])}
            >
              <Trash size={13} /> {removeLabel([pid])}
            </button>
          )}
          {mod?.url && !mod.url.includes('steamcommunity') && (
            <button className="btn sm" onClick={() => api.openUrl(mod.url!)}>
              <Link2 size={13} /> Website
            </button>
          )}
        </div>

        {issues.length > 0 && (
          <div className="d-section">
            <h4>Problems</h4>
            {issues.map((i) => (
              <IssueCard key={i.id} issue={i} />
            ))}
          </div>
        )}

        {mod && mod.dependencies.length > 0 && (
          <div className="d-section">
            <h4>Requires</h4>
            {mod.dependencies.map((d) => {
              const candidates = [d.packageId, ...(d.alternatives ?? [])]
              const act = candidates.map(resolveActive).find(Boolean)
              const inst = candidates.map(resolveInstalled).find(Boolean)
              const target = act ?? inst
              return (
                <div key={d.packageId} className={'d-item' + (target ? ' click' : '')} onClick={() => target && s.select(target)}>
                  <span className={'dot ' + (act ? 'ok' : inst ? 'warn' : 'err')} />
                  <span className="grow ellipsis">{(target && s.installed.get(target)?.[0]?.name) ?? d.name ?? d.packageId}</span>
                  <span className="dim" style={{ fontSize: 11.5 }}>
                    {act ? 'active' : inst ? 'inactive' : 'missing'}
                  </span>
                  {!target && d.workshopId && (
                    <button className="btn sm" title="Download with SteamCMD" onClick={(e) => { e.stopPropagation(); s.download([d.workshopId!]) }}>
                      <Download size={11} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {dependents.length > 0 && (
          <div className="d-section">
            <h4>Required by {dependents.length} active mods</h4>
            {dependents.slice(0, 12).map((d) => (
              <div key={d} className="d-item click" onClick={() => s.select(d)}>
                <ModIcon mod={s.activeMap.get(d)} size={16} />
                <span className="grow ellipsis">{s.activeMap.get(d)?.name ?? d}</span>
              </div>
            ))}
            {dependents.length > 12 && <div className="d-item dim">+{dependents.length - 12} more</div>}
          </div>
        )}

        {mod && (mod.loadAfter.length > 0 || mod.loadBefore.length > 0 || mod.incompatibleWith.length > 0) && (
          <div className="d-section">
            <h4>Load rules</h4>
            {[
              ['After', mod.loadAfter],
              ['Before', mod.loadBefore],
              ['Conflicts', mod.incompatibleWith],
            ].map(([label, ids]) =>
              (ids as string[]).slice(0, 8).map((id) => {
                const t = resolveInstalled(id)
                return (
                  <div key={label + id} className={'d-item' + (t ? ' click' : '')} onClick={() => t && s.select(t)}>
                    <span className="dim" style={{ width: 62, fontSize: 11.5 }}>{label as string}</span>
                    <ArrowRight size={12} className="dim" />
                    <span className="grow ellipsis">{(t && s.installed.get(t)?.[0]?.name) ?? id}</span>
                    {t && resolveActive(id) && <span className="dot ok" />}
                  </div>
                )
              }),
            )}
          </div>
        )}

        <div className="d-section">
          <h4>
            <Paintbrush size={11} /> Color and tags
          </h4>
          <div className="swatches" style={{ marginBottom: 8 }}>
            <span className={'swatch none' + (!meta?.color ? ' on' : '')} onClick={() => setMeta({ color: undefined })}>
              ×
            </span>
            {TAG_COLORS.map((c) => (
              <span key={c} className={'swatch' + (meta?.color === c ? ' on' : '')} style={{ background: c }} onClick={() => setMeta({ color: c })} />
            ))}
          </div>
          <div className="tag-input">
            <Tags size={13} className="dim" style={{ marginLeft: 4 }} />
            {meta?.tags?.map((t) => (
              <span key={t} className="chip click" onClick={() => setMeta({ tags: meta.tags!.filter((x) => x !== t) })} title="Remove tag">
                {t} ×
              </span>
            ))}
            <input
              value={tagDraft}
              placeholder="Add tag…"
              onChange={(e) => setTagDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault()
                  addTag()
                }
              }}
              onBlur={addTag}
            />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <span className="dim" style={{ fontSize: 12 }}>Category</span>
            <select
              className="input"
              style={{ height: 26, flex: 1 }}
              value={meta?.category ?? ''}
              onChange={(e) => setMeta({ category: (e.target.value || undefined) as ModCategory | undefined })}
            >
              <option value="">Auto ({mod ? CATEGORY_LABEL[mod.category] : '—'})</option>
              {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="d-section">
          <h4>
            <StickyNote size={11} /> Notes
          </h4>
          <textarea
            className="input"
            rows={3}
            style={{ width: '100%' }}
            value={notes}
            placeholder="Private notes about this mod…"
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== (meta?.notes ?? '') && setMeta({ notes: notes || undefined })}
          />
        </div>

        {mod?.hasAssemblies && (
          <div className="d-section">
            <h4>
              <Cpu size={11} /> Code
              <span className="grow" />
              {!report && (
                <button className="btn sm" onClick={() => s.analyze([pid, ...s.active])}>
                  Analyze patches
                </button>
              )}
            </h4>
            {report ? (
              <>
                <div className="kv" style={{ marginBottom: 8 }}>
                  <span>Assemblies</span>
                  <span>{report.dlls.map((d) => `${d.name} ${d.version}`).join(', ') || '—'}</span>
                  <span>Harmony</span>
                  <span>{report.usesHarmony ? `${report.patches.length} patches` : 'Not used'}</span>
                </div>
                {overlaps.length > 0 && (
                  <div style={{ marginBottom: 8 }}>
                    <div className="dim" style={{ fontSize: 11.5, margin: '4px 0' }}>
                      Also patched by active mods
                    </div>
                    {overlaps.slice(0, 8).map((o) => (
                      <div key={o.pid} className="d-item click" title={o.targets.join('\n')} onClick={() => s.select(o.pid)}>
                        <ModIcon mod={s.activeMap.get(o.pid)} size={16} />
                        <span className="grow ellipsis">{s.activeMap.get(o.pid)?.name ?? o.pid}</span>
                        <span className="chip">{o.targets.length}</span>
                      </div>
                    ))}
                  </div>
                )}
                {report.patches.slice(0, showAll ? 400 : 40).map((p, i) => (
                  <div key={i} className="patch-row" title={p.patchClass}>
                    <span className={'patch-kind ' + p.kind}>{p.kind}</span>
                    <span className="ellipsis">
                      {p.targetType.split('.').pop()}
                      <span className="dim">::</span>
                      {p.targetMember ?? '?'}
                    </span>
                  </div>
                ))}
                {report.patches.length > 40 && !showAll && (
                  <button className="btn ghost sm" onClick={() => setShowAll(true)}>
                    Show all {report.patches.length}
                  </button>
                )}
              </>
            ) : (
              <p className="dim" style={{ margin: 0, fontSize: 12 }}>
                {mod.assemblies.length} DLL{mod.assemblies.length === 1 ? '' : 's'}. Analysis reads them without running any code.
              </p>
            )}
          </div>
        )}

        {mod && (mod.source === 'local' || mod.source === 'workshop') && <ModSettingsSection folder={mod.folder} />}

        {mod && (
          <div className="d-section">
            <h4>Info</h4>
            <div className="kv">
              <span>Folder</span>
              <span className="mono">{mod.path}</span>
              <span>Updated</span>
              <span>{timeAgo(mod.mtime)}</span>
              <span>Loads</span>
              <span className="mono">{mod.contentDirs.join(', ')}</span>
            </div>
          </div>
        )}

        {description && (
          <div className="d-section">
            <h4>Description</h4>
            <div className="desc" dangerouslySetInnerHTML={{ __html: richText(longDesc ? description.slice(0, 900) + '…' : description) }} />
            {longDesc && (
              <button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setShowAll(true)}>
                Read more
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
