import type { Issue, ModInfo, Replacement, RuleMap, XmlReport } from './types.ts'
import { baseId, buildEdges, depProviders, resolver, ruleFor } from './graph.ts'
import { workshopUrl } from './workshop.ts'

export interface ValidateInput {
  order: string[]
  active: Map<string, ModInfo> // active packageId -> installed mod
  installed: Map<string, ModInfo[]> // every installed mod by packageId
  community?: RuleMap
  user?: RuleMap
  replacements?: Replacement[]
  gameMajor: string
  ignored: Set<string>
  depsAsLoadAfter: boolean
  xml?: XmlReport | null
}

/** Not marked for this game version. A mod that lists no versions at all counts as fine (no warning, not "outdated"). */
export function isOutdated(m: ModInfo, gameMajor: string): boolean {
  return m.source !== 'core' && m.source !== 'dlc' && m.supportedVersions.length > 0 && !m.supportedVersions.includes(gameMajor)
}

export function validate(input: ValidateInput): Issue[] {
  const { order, active, installed, gameMajor } = input
  const issues: Issue[] = []
  const pos = new Map(order.map((id, i) => [id, i]))
  const resolveActive = resolver(order)
  const resolveInstalled = resolver(installed.keys())
  const nameOf = (id: string) => active.get(id)?.name ?? installed.get(id)?.[0]?.name ?? id
  // The sorter's rules, built with its dependency setting. Without "Dependencies load first" a dependency
  // pair is only sorted when another rule covers it.
  const edges = buildEdges(order, active, input.community, input.user, input.depsAsLoadAfter, input.xml?.inferred)
  const sorted = new Set(edges.map((e) => e.before + '>' + e.after))

  // Anything that names a packageId anywhere lets us find its Workshop page even if it isn't installed.
  const knownWorkshop = new Map<string, { name?: string; workshopId?: string }>()
  for (const mods of installed.values())
    for (const m of mods)
      for (const d of m.dependencies) if (d.workshopId) knownWorkshop.set(d.packageId, { name: d.name, workshopId: d.workshopId })

  const replacementByPid = new Map<string, Replacement>()
  const replacementByWs = new Map<string, Replacement>()
  for (const r of input.replacements ?? []) {
    if (!r.newVersions.includes(gameMajor)) continue
    if (r.oldPackageId) replacementByPid.set(r.oldPackageId.toLowerCase(), r)
    if (r.oldWorkshopId) replacementByWs.set(r.oldWorkshopId, r)
  }

  for (const id of order) {
    const m = active.get(id)
    if (!m) {
      const ws = knownWorkshop.get(baseId(id))
      issues.push({
        id: `missing:${id}`,
        packageId: id,
        severity: 'error',
        kind: 'not-installed',
        title: 'Not installed',
        detail: `${ws?.name ?? id} is in the active list but no installed mod has this packageId.`,
        fixes: [
          { label: 'Remove from list', fix: { type: 'deactivate', packageIds: [id] } },
          ...(ws?.workshopId
            ? [
                { label: 'Download', fix: { type: 'download' as const, workshopIds: [ws.workshopId] } },
                { label: 'Workshop page', fix: { type: 'url' as const, url: workshopUrl(ws.workshopId) } },
              ]
            : []),
        ],
      })
      continue
    }

    if (m.aboutError)
      issues.push({ id: `about:${id}`, packageId: id, severity: 'warning', kind: 'about', title: 'About.xml could not be read', detail: m.aboutError, fixes: [] })

    for (const dep of m.dependencies) {
      const candidates = [dep.packageId, ...(dep.alternatives ?? [])]
      // Same providers the sorter orders against (see buildEdges).
      const providers = depProviders(dep, resolveActive)
      if (providers.length) {
        for (const activeDep of providers)
          if (pos.get(activeDep)! > pos.get(id)!) {
            const sorts = sorted.has(activeDep + '>' + id)
            issues.push({
              id: `deporder:${id}:${activeDep}`,
              packageId: id,
              severity: 'warning',
              kind: 'dep-order',
              title: `Loads before its dependency ${nameOf(activeDep)}`,
              detail: sorts ? undefined : `Auto-sort won't move it while “Dependencies load first” is off in Settings. Move it below ${nameOf(activeDep)} by hand.`,
              fixes: sorts ? [{ label: 'Auto-sort', fix: { type: 'sort' } }] : [],
            })
          }
        continue
      }
      const inst = candidates.map(resolveInstalled).find(Boolean)
      issues.push({
        id: `dep:${id}:${dep.packageId}`,
        packageId: id,
        severity: 'error',
        kind: 'missing-dep',
        title: `Requires ${dep.name ?? (inst ? nameOf(inst) : dep.packageId)}`,
        detail: inst ? 'Installed but not active.' : 'Not installed.',
        fixes: inst
          ? [{ label: 'Activate', fix: { type: 'activate', packageIds: [inst] } }]
          : dep.workshopId
            ? [
                { label: 'Download', fix: { type: 'download', workshopIds: [dep.workshopId] } },
                { label: 'Workshop page', fix: { type: 'url', url: workshopUrl(dep.workshopId) } },
              ]
            : dep.url
              ? [{ label: 'Open download page', fix: { type: 'url', url: dep.url } }]
              : [],
      })
    }

    const incompatible = new Set(m.incompatibleWith)
    for (const rules of [input.community, input.user]) for (const x of Object.keys(ruleFor(rules, id)?.incompatibleWith ?? {})) incompatible.add(x)
    for (const x of incompatible) {
      const other = resolveActive(x)
      if (!other || other === id) continue
      issues.push({
        id: `incompat:${[id, other].sort().join(':')}:${id}`,
        packageId: id,
        severity: 'error',
        kind: 'incompatible',
        title: `Incompatible with ${nameOf(other)}`,
        fixes: [
          { label: `Disable ${m.name}`, fix: { type: 'deactivate', packageIds: [id] } },
          { label: `Disable ${nameOf(other)}`, fix: { type: 'deactivate', packageIds: [other] } },
        ],
      })
    }

    if (isOutdated(m, gameMajor)) {
      const rep = replacementByPid.get(baseId(id)) ?? (m.workshopId ? replacementByWs.get(m.workshopId) : undefined)
      const supported = [...m.supportedVersions].sort().reverse().slice(0, 3).join(', ')
      issues.push({
        id: `version:${id}`,
        packageId: id,
        severity: 'warning',
        kind: 'version',
        title: `Not marked for ${gameMajor}`,
        detail: `Supports ${supported}. It may still work, but RimWorld will warn about it.`,
        fixes: rep ? [{ label: `Use ${rep.newName}`, fix: { type: 'url', url: workshopUrl(rep.newWorkshopId) } }] : [],
      })
      if (rep)
        issues.push({
          id: `replace:${id}`,
          packageId: id,
          severity: 'info',
          kind: 'replacement',
          title: `Updated version available: ${rep.newName}`,
          detail: `By ${rep.newAuthor}; supports ${rep.newVersions.slice(-3).join(', ')}.`,
          fixes: [
            { label: `Download ${rep.newName}`, fix: { type: 'download', workshopIds: [rep.newWorkshopId] } },
            { label: 'Workshop page', fix: { type: 'url', url: workshopUrl(rep.newWorkshopId) } },
          ],
        })
    }

    const dupes = installed.get(id) ?? []
    if (dupes.length > 1)
      issues.push({
        id: `dupe:${id}`,
        packageId: id,
        severity: 'warning',
        kind: 'duplicate',
        title: `Installed ${dupes.length} times`,
        detail: dupes.map((d) => `${d.source}: ${d.path}`).join('\n'),
        fixes: [],
      })
  }

  // Declared load-order rules (About.xml, community, yours) that the current order breaks, from the same
  // edges as above so the same inferred rules are kept; dependencies are reported above.
  for (const e of edges) {
    if (e.source === 'dependency' || pos.get(e.before)! < pos.get(e.after)!) continue
    const self = e.owner
    const other = self === e.after ? e.before : e.after
    issues.push({
      id: `order:${e.before}>${e.after}`,
      packageId: self,
      severity: e.source === 'force' ? 'error' : 'warning',
      kind: 'order',
      title: `Should load ${self === e.after ? 'after' : 'before'} ${nameOf(other)}`,
      detail:
        e.source === 'inferred'
          ? `Inferred by RimDeck: it redefines defs or patches from ${nameOf(other)} and refers to it, so it is meant to load after it.`
          : `Rule from ${e.source === 'about' || e.source === 'force' ? 'About.xml' : e.source === 'community' ? 'community rules' : 'your rules'}.`,
      fixes: [{ label: 'Auto-sort', fix: { type: 'sort' } }],
    })
  }

  if (input.xml) issues.push(...xmlIssues(input.xml, pos, nameOf))

  return issues.filter((i) => i.severity === 'error' || !input.ignored.has(i.packageId))
}

// One note per (winner, loser) pair: the later mod's version of a def or patched value is what the game uses.
function xmlIssues(xml: XmlReport, pos: Map<string, number>, nameOf: (id: string) => string): Issue[] {
  const pairs = new Map<string, { winner: string; loser: string; defs: string[]; patches: string[] }>()
  for (const c of xml.conflicts) {
    const mods = c.mods.filter((m) => pos.has(m.packageId)).sort((a, b) => pos.get(a.packageId)! - pos.get(b.packageId)!)
    if (mods.length < 2) continue
    const winner = mods[mods.length - 1].packageId
    for (const m of mods.slice(0, -1)) {
      if (m.packageId === winner) continue
      const k = winner + '|' + m.packageId
      const p = pairs.get(k) ?? { winner, loser: m.packageId, defs: [], patches: [] }
      ;(c.kind === 'def' ? p.defs : p.patches).push(c.key)
      pairs.set(k, p)
    }
  }
  const out: Issue[] = []
  for (const p of pairs.values()) {
    const parts = [p.defs.length && `${p.defs.length} def${p.defs.length === 1 ? '' : 's'}`, p.patches.length && `${p.patches.length} patched value${p.patches.length === 1 ? '' : 's'}`].filter(Boolean)
    out.push({
      id: `xml:${p.winner}|${p.loser}`,
      packageId: p.winner,
      severity: 'info',
      kind: 'xml',
      title: `Overrides ${parts.join(' and ')} from ${nameOf(p.loser)}`,
      detail: `Loaded later, so its version is used: ${[...p.defs, ...p.patches].slice(0, 4).join(', ')}${p.defs.length + p.patches.length > 4 ? '…' : ''}`,
      fixes: [],
    })
  }
  return out
}
