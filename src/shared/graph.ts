import type { DirCondition, ModCategory, ModInfo, RuleMap } from './types.ts'

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
  const add = (before: string | undefined, after: string | undefined, source: EdgeSource, owner: string) => {
    if (!before || !after || before === after) return
    const k = before + '>' + after
    if (seen.has(k)) return
    seen.add(k)
    edges.push({ before, after, source, owner })
  }
  for (const id of order) {
    const m = mods.get(id)
    if (m) {
      for (const x of m.loadAfter) add(resolve(x), id, 'about', id)
      for (const x of m.loadBefore) add(id, resolve(x), 'about', id)
      for (const x of m.forceLoadAfter) add(resolve(x), id, 'force', id)
      for (const x of m.forceLoadBefore) add(id, resolve(x), 'force', id)
      if (depsAsLoadAfter) for (const d of m.dependencies) add(resolve(d.packageId), id, 'dependency', id)
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
  // Inferred rules are hints: they never override an explicit rule pointing the other way.
  if (inferred)
    for (const id of order) {
      for (const x of Object.keys(ruleFor(inferred, id)?.loadAfter ?? {})) {
        const before = resolve(x)
        if (before && !seen.has(id + '>' + before)) add(before, id, 'inferred', id)
      }
    }
  return edges
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
