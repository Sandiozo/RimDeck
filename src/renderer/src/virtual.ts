// The maths behind long lists that only render the rows near their view (see useVirtual.tsx).
// No DOM or React here, so it can be tested on its own. Positions are in pixels from the top of
// the first item; offsets[i] is where item i starts and offsets[count] is the height of them all.

export interface Range {
  start: number // first item to render
  end: number // one past the last item to render
}

export type Slot = { kind: 'item'; index: number } | { kind: 'gap'; key: string; size: number }

export type Align = 'nearest' | 'center' | 'start' | 'end'

// Spacer keys start with a character no row key uses, so they never clash with one.
export const GAP_TOP = '\u0000top'
export const GAP_END = '\u0000end'

export function buildOffsets(count: number, sizeOf: (index: number) => number): Float64Array {
  const offsets = new Float64Array(count + 1)
  for (let i = 0; i < count; i++) offsets[i + 1] = offsets[i] + sizeOf(i)
  return offsets
}

/** The item at position y, clamped to the list; -1 for an empty list. */
export function indexAt(offsets: ArrayLike<number>, y: number): number {
  const n = offsets.length - 1
  if (n <= 0) return -1
  if (y >= offsets[n]) return n - 1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * The items to render for a view `height` tall that starts `top` below the first item, plus
 * `overscan` items beyond each edge. A position past the end (left over from a longer list) is
 * treated as the end, so a list that shrinks shows its last rows instead of blank space.
 */
export function visibleRange(offsets: ArrayLike<number>, top: number, height: number, overscan = 0): Range {
  const n = offsets.length - 1
  if (n <= 0) return { start: 0, end: 0 }
  const h = Math.max(0, height)
  const t = Math.max(0, Math.min(top, offsets[n] - h))
  const first = indexAt(offsets, t)
  const last = Math.max(first, indexAt(offsets, t + h))
  return { start: Math.max(0, first - overscan), end: Math.min(n, last + 1 + overscan) }
}

/**
 * What to put in the list, top to bottom: the items of `range`, any `pinned` items outside it, and
 * a spacer of the right height for every stretch that is not rendered. The top and bottom spacers
 * are always there; a spacer between two stretches is keyed by the item after it, so rows keep
 * their order among their siblings and React never has to move one.
 */
export function plan(offsets: ArrayLike<number>, range: Range, pinned: readonly number[] = []): Slot[] {
  const n = offsets.length - 1
  if (n <= 0) return []
  const start = Math.max(0, Math.min(n, range.start))
  const end = Math.max(start, Math.min(n, range.end))
  const extra = [...new Set(pinned)].filter((i) => Number.isInteger(i) && i >= 0 && i < n && (i < start || i >= end)).sort((a, b) => a - b)
  const runs: [number, number][] = []
  const add = (a: number, b: number) => {
    const last = runs[runs.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else runs.push([a, b])
  }
  for (const i of extra) if (i < start) add(i, i + 1)
  if (end > start) add(start, end)
  for (const i of extra) if (i >= end) add(i, i + 1)

  let at = runs.length ? runs[0][0] : n
  const out: Slot[] = [{ kind: 'gap', key: GAP_TOP, size: offsets[at] }]
  runs.forEach(([a, b], k) => {
    if (k > 0) out.push({ kind: 'gap', key: '\u0000' + a, size: offsets[a] - offsets[at] })
    for (let i = a; i < b; i++) out.push({ kind: 'item', index: i })
    at = b
  })
  out.push({ kind: 'gap', key: GAP_END, size: offsets[n] - offsets[at] })
  return out
}

/**
 * The scroll position that shows the box [top, top + size) the way Element.scrollIntoView({ block })
 * would, kept within 0..max. All values are in the scroller's own coordinates.
 */
export function scrollTarget(top: number, size: number, scrollTop: number, viewport: number, align: Align, max = Infinity): number {
  const bottom = top + size
  let t: number
  if (align === 'start') t = top
  else if (align === 'end') t = bottom - viewport
  else if (align === 'center') t = top + size / 2 - viewport / 2
  else if (top >= scrollTop && bottom <= scrollTop + viewport) t = scrollTop // already in view
  else if (top < scrollTop && bottom > scrollTop + viewport) t = scrollTop // covers the whole view
  else if ((top < scrollTop && size <= viewport) || (bottom > scrollTop + viewport && size > viewport)) t = top
  else t = bottom - viewport
  return Math.max(0, Math.min(max, t))
}
