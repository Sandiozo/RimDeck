import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CrashEntry } from '../shared/types.ts'

// RimDeck's own error log: <userData>/logs/crash.log, one JSON object per line, newest last.
// Nothing here uses Electron, so it can be tried out with plain Node.

const MAX_ENTRIES = 50
const MAX_BYTES = 128 * 1024
const MAX_MESSAGE = 1000
const STACK_LINES = 15
const LINE_CHARS = 300
// The same error again within this time counts as a repeat of the last one.
const BURST_MS = 60_000
// At most this many new entries a minute; more are counted under one "too many errors" entry.
const PER_MINUTE = 20
const WRITE_GAP_MS = 1000

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
// Not followed by more of a folder name, so /home/ann doesn't also match /home/anna.
const END = String.raw`(?![\p{L}\p{N}_-]|\.[\p{L}\p{N}])`
const SEP = String.raw`[\\/]+`
// A drive letter, not the end of "file:".
const DRIVE = String.raw`(?<![\p{L}\p{N}])[a-z]:`

/**
 * Returns a function that replaces the user's home folder and user name in paths with ~: Windows,
 * macOS and Linux forms, either slash direction, doubled backslashes, file:// URLs and percent-encoded
 * names, ignoring case. A user name that is a folder anywhere else in a path becomes ~ as well.
 */
export function makeScrubber(o: { home?: string; names?: string[] }): (text: string) => string {
  const names = [...new Set((o.names ?? []).map((n) => n.trim()).filter((n) => n.length > 0 && !/[\\/]/.test(n)))]
  const forms = (s: string) => [...new Set([s, encodeURIComponent(s)])]
  const pathPattern = (segments: string[]) => segments.map((seg) => (/^[a-z]:$/i.test(seg) ? `(?<![\\p{L}\\p{N}])${escape(seg)}` : forms(seg).map(escape).join('|'))).map((p) => `(?:${p})`).join(SEP)
  const homes: string[] = []
  const home = o.home?.trim()
  if (home && home.split(/[\\/]+/).filter(Boolean).length > 1) {
    const segs = home.split(/[\\/]+/).filter(Boolean)
    // One leading slash only, so file:///Users/… keeps its file://.
    homes.push((/^[\\/]/.test(home) ? '[\\\\/]' : '') + pathPattern(segs))
  }
  for (const n of names) {
    homes.push(String.raw`${DRIVE}${SEP}Users${SEP}${pathPattern([n])}`)
    homes.push(String.raw`[\\/](?:var${SEP})?(?:home|Users)${SEP}${pathPattern([n])}`)
  }
  const rules: RegExp[] = []
  if (homes.length) rules.push(new RegExp(`(?:${homes.join('|')})${END}`, 'giu'))
  // Windows short names (C:\Users\SANDIS~1) in temp folder paths.
  rules.push(new RegExp(String.raw`${DRIVE}${SEP}Users${SEP}[^\\/\s'"<>|*?:]+~\d+${END}`, 'giu'))
  if (names.length) rules.push(new RegExp(String.raw`(?<=[\\/])(?:${names.flatMap(forms).map(escape).join('|')})${END}`, 'giu'))
  return (text: string) => {
    if (!text) return text
    let out = String(text)
    for (const r of rules) out = out.replace(r, '~')
    return out
  }
}

/** Keeps the first lines of a stack trace, each cut to a readable length. */
export function trimStack(stack: string | undefined, lines = STACK_LINES): string | undefined {
  if (!stack) return undefined
  const all = String(stack).split(/\r?\n/).filter((l) => l.trim())
  const kept = all.slice(0, lines).map((l) => (l.length > LINE_CHARS ? l.slice(0, LINE_CHARS) + '…' : l))
  if (all.length > lines) kept.push(`    … ${all.length - lines} more lines`)
  return kept.join('\n')
}

function trimMessage(message: string): string {
  const m = String(message ?? '').trim() || 'No message'
  return m.length > MAX_MESSAGE ? m.slice(0, MAX_MESSAGE) + '…' : m
}

export interface CrashInput {
  source: CrashEntry['source']
  kind: string
  message: string
  stack?: string
}

export interface CrashLogOptions {
  dir: string
  version: string
  dev: boolean
  scrub: (text: string) => string
  now?: () => number
}

export class CrashLog {
  readonly file: string
  private o: CrashLogOptions
  private now: () => number
  /** New or changed entries not yet written. */
  private pending = new Map<string, CrashEntry>()
  /** Recent entries by what they say, to spot repeats. */
  private recent = new Map<string, CrashEntry>()
  private added: number[] = []
  private seenUntil: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastWrite = 0
  private busy = false
  private seq = 0

  constructor(o: CrashLogOptions) {
    this.o = o
    this.file = join(o.dir, 'crash.log')
    this.now = o.now ?? Date.now
  }

  /**
   * Adds an error. Returns 'new' for a new entry, 'repeat' when it only raised the count of the
   * last one, and null if it could not be recorded. Never throws.
   */
  record(e: CrashInput, urgent = false): 'new' | 'repeat' | null {
    if (this.busy) return null // an error while logging an error
    this.busy = true
    try {
      const scrub = (s: string) => {
        try {
          return this.o.scrub(s)
        } catch {
          return '(could not be shown)'
        }
      }
      const message = trimMessage(scrub(String(e.message ?? '')))
      const stack = trimStack(e.stack ? scrub(String(e.stack)) : undefined)
      const kind = scrub(String(e.kind || 'error')).slice(0, 60)
      const at = this.now()
      const key = `${e.source}|${kind}|${message.replace(/\d+/g, '#')}|${(stack ?? '').split('\n').find((l) => /^\s*at\s/.test(l)) ?? ''}`
      if (this.repeat(key, at)) return 'repeat'
      this.added = this.added.filter((t) => at - t < 60_000)
      if (this.added.length >= PER_MINUTE) {
        const k = `${e.source}|too many`
        if (!this.repeat(k, at)) {
          this.add(k, { source: e.source, kind: 'too many errors', message: 'More errors came in quickly and were counted here instead of logged one by one.' }, at)
          this.flushSoon(false)
        }
        return 'repeat'
      }
      this.added.push(at)
      this.add(key, { source: e.source, kind, message, stack }, at)
      this.flushSoon(urgent)
      return 'new'
    } catch {
      return null
    } finally {
      this.busy = false
    }
  }

  private repeat(key: string, at: number): boolean {
    const last = this.recent.get(key)
    if (!last || last.seen || at - Date.parse(last.last ?? last.time) > BURST_MS) return false
    last.count = (last.count ?? 1) + 1
    last.last = new Date(at).toISOString()
    this.pending.set(last.id, last)
    this.flushSoon(false)
    return true
  }

  private add(key: string, e: CrashInput, at: number) {
    const entry: CrashEntry = {
      id: `${at.toString(36)}-${(++this.seq).toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      time: new Date(at).toISOString(),
      version: this.o.version,
      ...(this.o.dev ? { dev: true } : {}),
      source: e.source,
      kind: e.kind,
      message: e.message,
      ...(e.stack ? { stack: e.stack } : {}),
    }
    this.pending.set(entry.id, entry)
    this.recent.set(key, entry)
    if (this.recent.size > 100) for (const [k, v] of this.recent) if (at - Date.parse(v.last ?? v.time) > BURST_MS) this.recent.delete(k)
  }

  /** Writes at most once a second; urgent entries are written straight away. */
  private flushSoon(urgent: boolean) {
    if (urgent) return this.flush()
    if (this.timer) return
    const wait = Math.max(0, this.lastWrite + WRITE_GAP_MS - this.now())
    if (!wait) return this.flush()
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, wait)
    this.timer.unref?.()
  }

  private read(): CrashEntry[] {
    let text = ''
    try {
      text = readFileSync(this.file, 'utf8')
    } catch {
      return []
    }
    const out: CrashEntry[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const e = JSON.parse(line)
        if (e && typeof e === 'object' && typeof e.id === 'string' && typeof e.time === 'string' && typeof e.message === 'string') out.push(e)
      } catch {
        // a damaged line is skipped
      }
    }
    return out
  }

  private mine = (e: CrashEntry) => !!e.dev === this.o.dev

  /** Writes pending changes to disk, keeping the file small. Never throws. */
  flush() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.pending.size && this.seenUntil === null) return
    try {
      const entries = this.merged()
      const lines = entries.slice(-MAX_ENTRIES).map((e) => JSON.stringify(e))
      let size = lines.reduce((n, l) => n + Buffer.byteLength(l) + 1, 0)
      while (lines.length > 1 && size > MAX_BYTES) size -= Buffer.byteLength(lines.shift()!) + 1
      mkdirSync(this.o.dir, { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      const data = lines.join('\n') + '\n'
      try {
        writeFileSync(tmp, data, 'utf8')
        renameSync(tmp, this.file)
      } catch {
        // Some file locks block the rename on Windows; write in place instead.
        try {
          unlinkSync(tmp)
        } catch {}
        writeFileSync(this.file, data, 'utf8')
      }
      this.pending.clear()
      this.seenUntil = null
    } catch {
      // logging must never get in the way
    } finally {
      this.lastWrite = this.now()
    }
  }

  /** The file with changes not yet written applied on top, oldest first. */
  private merged(): CrashEntry[] {
    const entries = this.read()
    const byId = new Map(entries.map((e, i) => [e.id, i]))
    for (const p of this.pending.values()) {
      const i = byId.get(p.id)
      if (i === undefined) {
        byId.set(p.id, entries.length)
        entries.push({ ...p })
      } else entries[i] = { ...p }
    }
    if (this.seenUntil !== null) for (const e of entries) if (this.mine(e) && (this.seenUntil === '' || (e.last ?? e.time) <= this.seenUntil)) e.seen = true
    return entries
  }

  /** Entries logged by this kind of build (installed app or development run), newest first. */
  entries(): CrashEntry[] {
    try {
      return this.merged().filter(this.mine).reverse()
    } catch {
      return []
    }
  }

  unseen(): CrashEntry[] {
    return this.entries().filter((e) => !e.seen)
  }

  /** Marks entries up to the given time (all when left out) as seen, so the notice doesn't come back for them. */
  acknowledge(until?: string) {
    try {
      const mark = until ?? ''
      // A wider mark wins over a narrower one that is still waiting to be written.
      this.seenUntil = this.seenUntil === '' || mark === '' ? '' : this.seenUntil && this.seenUntil > mark ? this.seenUntil : mark
      for (const e of this.pending.values()) if (mark === '' || (e.last ?? e.time) <= mark) e.seen = true
      for (const e of this.recent.values()) if (mark === '' || (e.last ?? e.time) <= mark) e.seen = true
      this.flush()
    } catch {}
  }
}

/**
 * Notes that RimDeck is running in a small marker file. Returns true when the marker was already
 * there, meaning the previous run never reached endRun: it crashed or was killed. Never throws.
 */
export function startRun(file: string, info: Record<string, unknown>): boolean {
  let found = false
  try {
    found = existsSync(file)
    mkdirSync(join(file, '..'), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...info, pid: process.pid, started: new Date().toISOString() }), 'utf8')
  } catch {}
  return found
}

/** Removes the marker on a normal end. Never throws. */
export function endRun(file: string) {
  try {
    unlinkSync(file)
  } catch {}
}
