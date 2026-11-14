import { api } from './api'

// Uncaught interface errors go to RimDeck's error log (nothing leaves the computer). Harmless
// browser noise is left out, and a flood of errors is thinned before it reaches the log.

const NOISE = [/ResizeObserver loop/i, /^Script error\.?$/i, /(chrome|moz)-extension:\/\//i]
const recent = new Map<string, number>()
let times: number[] = []

function text(v: unknown): string {
  try {
    if (typeof v === 'string') return v
    if (v instanceof Error) return String(v)
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

export function reportError(kind: string, error: unknown) {
  try {
    const message = text(error).slice(0, 4000)
    const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack.slice(0, 20000) : undefined
    if (!message || NOISE.some((r) => r.test(message) || (stack && r.test(stack)))) return
    const now = Date.now()
    // The same error again within half a minute, or more than ten a minute, isn't sent.
    const key = message + '|' + (stack?.split('\n')[1] ?? '')
    if (now - (recent.get(key) ?? 0) < 30_000) return
    times = times.filter((t) => now - t < 60_000)
    if (times.length >= 10) return
    times.push(now)
    recent.set(key, now)
    if (recent.size > 50) recent.delete(recent.keys().next().value!)
    api.reportError({ kind, message, stack }).catch(() => {})
  } catch {
    // reporting an error must never cause another
  }
}

export function watchErrors() {
  // Failed images and scripts fire error events too, but those don't reach the window.
  window.addEventListener('error', (e) => reportError('uncaught error', e.error ?? e.message))
  window.addEventListener('unhandledrejection', (e) => reportError('unhandled rejection', e.reason))
}
