import type { ModCategory, ModInfo, RuleMap, SortMode } from './types.ts'
import { buildEdges, CATEGORY_LABEL, CATEGORY_RANK, isBottom, isTop, OFFICIAL_ORDER, type Edge } from './graph.ts'

export interface SortMove {
  packageId: string
  from: number
  to: number
  reason: string
}

export interface SortResult {
  order: string[]
  moves: SortMove[]
  cycles: string[][]
  edges: Edge[]
}

export interface SortOptions {
  mode: SortMode
  depsAsLoadAfter: boolean
  community?: RuleMap
  user?: RuleMap
  inferred?: RuleMap
  categoryOf: (id: string) => ModCategory
  nameOf: (id: string) => string
}

const SOURCE_LABEL: Record<Edge['source'], string> = {
  about: 'its About.xml',
  dependency: 'dependency',
  community: 'community rules',
  user: 'your rules',
  force: 'forced by About.xml',
  inferred: 'it redefines things from that mod',
}

export function sortMods(order: string[], mods: Map<string, ModInfo>, opts: SortOptions): SortResult {
  const edges = buildEdges(order, mods, opts.community, opts.user, opts.depsAsLoadAfter, opts.inferred)
  const index = new Map(order.map((id, i) => [id, i]))

  const tier = (id: string) => {
    if (isTop(id, mods.get(id), opts.community, opts.user)) return 0
    if (OFFICIAL_ORDER.includes(id) || mods.get(id)?.source === 'dlc' || mods.get(id)?.source === 'core') return 1
    if (isBottom(id, opts.community, opts.user)) return 3
    return 2
  }
  const key = new Map<string, (string | number)[]>()
  for (const id of order) {
    const t = tier(id)
    // Harmony must precede every other loader (e.g. mods that declare loadBefore Core).
    const official = id === 'brrainz.harmony' ? -1 : OFFICIAL_ORDER.indexOf(id)
    const k: (string | number)[] = [t, official < 0 ? 99 : official]
    if (opts.mode === 'grouped') k.push(CATEGORY_RANK[opts.categoryOf(id)], index.get(id)!)
    else if (opts.mode === 'alphabetical') k.push(opts.nameOf(id).toLowerCase())
    else k.push(index.get(id)!)
    key.set(id, k)
  }
  const cmp = (a: string, b: string) => {
    const ka = key.get(a)!
    const kb = key.get(b)!
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      const x = ka[i] ?? 0
      const y = kb[i] ?? 0
      if (x < y) return -1
      if (x > y) return 1
    }
    return 0
  }

  // Kahn's algorithm, always taking the best-ranked ready mod so unconstrained mods keep their grouping/order.
  const indeg = new Map(order.map((id) => [id, 0]))
  const out = new Map<string, string[]>(order.map((id) => [id, []]))
  for (const e of edges) {
    out.get(e.before)!.push(e.after)
    indeg.set(e.after, indeg.get(e.after)! + 1)
  }
  const remaining = new Set(order)
  const result: string[] = []
  const cycles: string[][] = []
  while (remaining.size) {
    let best: string | undefined
    for (const id of remaining) if (indeg.get(id) === 0 && (!best || cmp(id, best) < 0)) best = id
    if (!best) {
      const stuck = [...remaining].sort(cmp)
      cycles.push(findCycle(stuck[0], out, remaining) ?? [stuck[0]])
      best = stuck[0]
    }
    remaining.delete(best)
    result.push(best)
    for (const n of out.get(best)!) indeg.set(n, indeg.get(n)! - 1)
  }

  return { order: result, moves: explainMoves(order, result, edges, tier, opts), cycles, edges }
}

function findCycle(start: string, out: Map<string, string[]>, alive: Set<string>): string[] | null {
  const stack: string[] = []
  const onStack = new Set<string>()
  const visited = new Set<string>()
  const dfs = (n: string): string[] | null => {
    visited.add(n)
    stack.push(n)
    onStack.add(n)
    for (const m of out.get(n) ?? []) {
      if (!alive.has(m)) continue
      if (onStack.has(m)) return stack.slice(stack.indexOf(m))
      if (!visited.has(m)) {
        const c = dfs(m)
        if (c) return c
      }
    }
    stack.pop()
    onStack.delete(n)
    return null
  }
  return dfs(start)
}

// Minimal set of moved mods = everything outside the longest increasing subsequence of old positions.
function explainMoves(
  before: string[],
  after: string[],
  edges: Edge[],
  tier: (id: string) => number,
  opts: SortOptions,
): SortMove[] {
  const oldIdx = new Map(before.map((id, i) => [id, i]))
  const seq = after.map((id) => oldIdx.get(id)!)
  const keep = lis(seq)
  const moves: SortMove[] = []
  after.forEach((id, to) => {
    if (keep.has(to)) return
    const from = oldIdx.get(id)!
    // Prefer the rule that explains the direction of travel: moved down → something it must follow.
    const broken = edges.filter(
      (e) => (e.after === id || e.before === id) && oldIdx.get(e.before)! > oldIdx.get(e.after)!,
    )
    const movedDown = to > from
    const violated =
      broken.find((e) => (movedDown ? e.after === id : e.before === id)) ?? broken[0]
    let reason: string
    if (violated) {
      const other = violated.after === id ? violated.before : violated.after
      const rel = violated.after === id ? 'after' : 'before'
      reason = `Must load ${rel} ${opts.nameOf(other)} (${SOURCE_LABEL[violated.source]})`
    } else {
      const t = tier(id)
      if (t === 0) reason = 'Loaders go to the top'
      else if (t === 1) reason = 'Core and DLCs keep their official order'
      else if (t === 3) reason = 'Community rules say this loads last'
      else if (opts.mode === 'grouped') reason = `Grouped with ${CATEGORY_LABEL[opts.categoryOf(id)]}`
      else if (opts.mode === 'alphabetical') reason = 'Alphabetical order'
      else reason = 'Shifted to satisfy other rules'
    }
    moves.push({ packageId: id, from, to, reason })
  })
  return moves
}

function lis(seq: number[]): Set<number> {
  const tails: number[] = []
  const tailIdx: number[] = []
  const prev = new Array<number>(seq.length).fill(-1)
  seq.forEach((v, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (tails[mid] < v) lo = mid + 1
      else hi = mid
    }
    tails[lo] = v
    tailIdx[lo] = i
    prev[i] = lo > 0 ? tailIdx[lo - 1] : -1
  })
  const keep = new Set<number>()
  let k = tailIdx[tails.length - 1] ?? -1
  while (k >= 0) {
    keep.add(k)
    k = prev[k]
  }
  return keep
}
