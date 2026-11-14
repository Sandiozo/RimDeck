import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { GAP_TOP, plan, scrollTarget, visibleRange, type Align, type Slot } from './virtual'

export type GapSlot = Extract<Slot, { kind: 'gap' }>

/** A CSS length variable (such as --row-h) in pixels, or 0 when it is not set. */
export function cssPx(el: Element, name: string): number {
  const v = parseFloat(getComputedStyle(el).getPropertyValue(name))
  return Number.isFinite(v) && v > 0 ? v : 0
}

interface Options {
  /** The scrolling element. Its items are rendered as normal blocks between spacers. */
  ref: RefObject<HTMLElement | null>
  /** From buildOffsets, memoised so it only changes when the items or their heights do. */
  offsets: Float64Array
  /** Items rendered beyond each edge of the view, so quick scrolling never shows a gap. */
  overscan?: number
  /** Items that stay rendered wherever the view is, such as the row a drag started from. */
  pinned?: readonly number[]
}

/**
 * Renders only the items near the view of a long list. Render `slots` in order: `spacer(slot)` for a
 * gap, your own element for an item. Spacers keep every rendered item at its real position, so
 * offsetTop and the scrollbar behave as if the whole list were there.
 */
export function useVirtual({ ref, offsets, overscan = 10, pinned }: Options) {
  // The view the window was last worked out for. It is only stored when the window has to change,
  // so scrolling within the rendered items re-renders nothing.
  const [view, setView] = useState({ top: 0, height: 0 })
  const range = visibleRange(offsets, view.top, view.height, overscan)
  const live = useRef({ offsets, overscan, range })
  live.current = { offsets, overscan, range }
  const topGap = useRef<HTMLDivElement>(null)

  // Where the first item starts in the scroller's content: its top padding, plus anything above the items.
  const origin = useCallback(() => {
    const el = ref.current
    const gap = topGap.current
    if (!el || !gap) return 0
    return gap.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop + el.scrollTop
  }, [ref])

  // Reads the scroll position and re-renders when other items should be shown. Outside React's own
  // events (scroll, resize) the update is flushed at once, so the frame that shows the new position
  // also has its rows.
  const sync = useCallback(
    (flush: boolean) => {
      const el = ref.current
      if (!el) return
      const { offsets, overscan, range } = live.current
      const next = { top: el.scrollTop - origin(), height: el.clientHeight }
      const r = visibleRange(offsets, next.top, next.height, overscan)
      if (r.start === range.start && r.end === range.end) return
      // Compared against by the next call even before React has rendered this update.
      live.current.range = r
      if (flush) flushSync(() => setView(next))
      else setView(next)
    },
    [ref, origin],
  )

  // After the items change (or on first show), before the browser paints: the browser may also have
  // clamped the scroll position because the list got shorter.
  useLayoutEffect(() => sync(false), [offsets, sync])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let frame = 0
    const onScroll = () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0
          sync(true)
        })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const resize = new ResizeObserver(() => sync(true))
    resize.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      resize.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [ref, sync])

  /**
   * Scrolls like Element.scrollIntoView({ block: align }) on item `index`, whether or not it is rendered.
   * `tail` limits it to the bottom part of the item (a row with a heading above it).
   */
  const scrollToIndex = useCallback(
    (index: number, align: Align, tail?: number) => {
      const el = ref.current
      const { offsets } = live.current
      if (!el || index < 0 || index >= offsets.length - 1) return
      const size = offsets[index + 1] - offsets[index]
      const part = tail === undefined ? size : Math.min(size, tail)
      const top = origin() + offsets[index + 1] - part
      const target = scrollTarget(top, part, el.scrollTop, el.clientHeight, align, Math.max(0, el.scrollHeight - el.clientHeight))
      if (Math.abs(target - el.scrollTop) < 0.5) return
      el.scrollTop = target
      sync(false)
    },
    [ref, origin, sync],
  )

  /** Where item `index` starts (or, for index = count, where the last one ends), in the same frame as a row's offsetTop. */
  const offsetOf = useCallback(
    (index: number) => {
      const { offsets } = live.current
      return origin() + offsets[Math.max(0, Math.min(offsets.length - 1, index))]
    },
    [origin],
  )

  const slots = useMemo(() => plan(offsets, range, pinned), [offsets, range.start, range.end, pinned])

  // The browser must never pick a spacer as its scroll anchor: rows are added and removed next to them
  // while scrolling, and anchoring to one would push the view along with them.
  const spacer = (slot: GapSlot) => <div key={slot.key} ref={slot.key === GAP_TOP ? topGap : undefined} aria-hidden style={{ height: slot.size, overflowAnchor: 'none' }} />

  return { slots, spacer, scrollToIndex, offsetOf }
}
