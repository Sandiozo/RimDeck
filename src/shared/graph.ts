import type { DirCondition, ModCategory, ModDep, ModInfo, RuleMap } from './types.ts'

export type EdgeSource = 'about' | 'dependency' | 'community' | 'user' | 'force' | 'inferred'

// `before` must load before `after`.
export interface Edge {
  before: string
  after: string
  source: EdgeSource
  owner: string // the mod whose metadata declared it
}

export const OFFICIAL_ORDER = [
  'ludeon.rimworld',
  'ludeon.rimworld.royalty',
  'ludeon.rimworld.ideology',
  'ludeon.rimworld.biotech',
  'ludeon.rimworld.anomaly',
  'ludeon.rimworld.odyssey',
]

export const TOP_LOADERS = new Set(['brrainz.harmony', 'zetrith.prepatcher', 'me.samboycoding.betterloading'])

export const CATEGORY_RANK: Record<ModCategory, number> = {
  loader: 0,
  game: 1,
  library: 2,
  content: 3,
  utility: 4,
  performance: 4,
  textures: 5,
  patch: 6,
}

export const CATEGORY_LABEL: Record<ModCategory, string> = {
  loader: 'Loaders',
  game: 'Game & DLC',
  library: 'Libraries',
  content: 'Content',
  utility: 'Utility & UI',
  performance: 'Performance',
  textures: 'Textures',
  patch: 'Patches',
}

/** Resolves a declared packageId to the id actually present in `ids` (handles RimWorld's `_steam` suffix). */
export function resolver(ids: Iterable<string>) {
  const set = new Set(ids)
  return (id: string): string | undefined => {
    if (set.has(id)) return id
    if (set.has(id + '_steam')) return id + '_steam'
    if (id.endsWith('_steam') && set.has(id.slice(0, -6))) return id.slice(0, -6)
    return undefined
  }
}

export function baseId(id: string) {
  return id.endsWith('_steam') ? id.slice(0, -6) : id
}

export function ruleFor(rules: RuleMap | undefined, id: string) {
  return rules?.[id] ?? rules?.[baseId(id)]
}

export function buildEdges(
  order: string[],
  mods: Map<string, ModInfo>,
  community: RuleMap | undefined,
  user: RuleMap | undefined,
  depsAsLoadAfter: boolean,
  inferred?: RuleMap,
): Edge[] {
  const resolve = resolver(order)
  const edges: Edge[] = []
  const seen = new Set<string>()
  const next = new Map<string, string[]>()
  const add = (before: string | undefined, after: string | undefined, source: EdgeSource, owner: string) => {
    if (!before || !after || before === after) return
    const k = before + '>' + after
    if (seen.has(k)) return
    seen.add(k)
    edges.push({ before, after, source, owner })
    const list = next.get(before)
    if (list) list.push(after)
    else next.set(before, [after])
  }
  const reaches = (from: string, to: string) => {
    const done = new Set([from])
    const stack = [from]
    while (stack.length) {
      for (const n of next.get(stack.pop()!) ?? []) {
        if (n === to) return true
        if (!done.has(n)) {
          done.add(n)
          stack.push(n)
        }
      }
    }
    return false
  }
  for (const id of order) {
    const m = mods.get(id)
    if (m) {
      for (const x of m.loadAfter) add(resolve(x), id, 'about', id)
      for (const x of m.loadBefore) add(id, resolve(x), 'about', id)
      for (const x of m.forceLoadAfter) add(resolve(x), id, 'force', id)
      for (const x of m.forceLoadBefore) add(id, resolve(x), 'force', id)
    }
    for (const [rules, source] of [
      [community, 'community'],
      [user, 'user'],
    ] as const) {
      const r = ruleFor(rules, id)
      if (!r) continue
      for (const x of Object.keys(r.loadAfter ?? {})) add(resolve(x), id, source, id)
      for (const x of Object.keys(r.loadBefore ?? {})) add(id, resolve(x), source, id)
    }
  }
  // After the explicit rules, so a dependency never takes the place of a written rule for the same pair.
  if (depsAsLoadAfter)
    for (const id of order) for (const d of mods.get(id)?.dependencies ?? []) for (const p of depProviders(d, resolve)) add(p, id, 'dependency', id)
  // Inferred rules are hints: one is dropped when it would close a loop with the rules already there.
  // They are taken in a fixed order (not the load order) so sorting never changes which ones are kept.
  if (inferred) {
    const hints: [string, string][] = []
    for (const id of order)
      for (const x of Object.keys(ruleFor(inferred, id)?.loadAfter ?? {})) {
        const before = resolve(x)
        if (before && before !== id) hints.push([before, id])
      }
    hints.sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    for (const [before, id] of hints) if (!reaches(id, before)) add(before, id, 'inferred', id)
  }
  return edges
}

/** The active mods that meet a dependency: the named mod when it is active, otherwise every active alternative. */
export function depProviders(dep: ModDep, resolve: (id: string) => string | undefined): string[] {
  const named = resolve(dep.packageId)
  if (named) return [named]
  return [...new Set((dep.alternatives ?? []).map(resolve).filter((x): x is string => !!x))]
}

export function isTop(id: string, m: ModInfo | undefined, community?: RuleMap, user?: RuleMap) {
  return (
    TOP_LOADERS.has(baseId(id)) ||
    !!ruleFor(user, id)?.loadTop?.value ||
    !!ruleFor(community, id)?.loadTop?.value ||
    (!!m && m.source !== 'core' && m.source !== 'dlc' && m.loadBefore.includes('ludeon.rimworld'))
  )
}

export function isBottom(id: string, community?: RuleMap, user?: RuleMap) {
  return !!ruleFor(user, id)?.loadBottom?.value || !!ruleFor(community, id)?.loadBottom?.value
}

/** The folders a mod really loads given which mods are active (applies loadFolders IfModActive conditions). */
export function effectiveDirs(m: ModInfo, isActive: (packageId: string) => boolean): string[] {
  if (!m.dirConditions) return m.contentDirs
  const ok = (c: DirCondition) => (!c.any || c.any.some(isActive)) && (!c.all || c.all.every(isActive)) && (!c.none || !c.none.some(isActive))
  return m.contentDirs.filter((d) => !m.dirConditions![d] || m.dirConditions![d].some(ok))
}
