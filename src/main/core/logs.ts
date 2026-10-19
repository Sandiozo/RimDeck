import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { LogEntry, LogReport } from '../../shared/types.ts'
import { defaultConfigDir } from './paths.ts'

export async function findPlayerLog(configDir: string): Promise<string | null> {
  const base = dirname(configDir)
  let best: { p: string; t: number } | null = null
  // A custom -savedatafolder doesn't move Unity's log, so the default location is checked too.
  const fallback = join(dirname(defaultConfigDir()), 'Logs', 'Player.log')
  for (const p of [join(base, 'Player.log'), join(base, 'Logs', 'Player.log'), fallback]) {
    try {
      const t = (await stat(p)).mtimeMs
      if (!best || t > best.t) best = { p, t }
    } catch {}
  }
  return best?.p ?? null
}

export interface Attribution {
  namespaces: Map<string, string> // namespace -> packageId
  packageIds: Set<string>
  names: Map<string, string> // lowercase mod name -> packageId
  harmonyIds: Map<string, string>
}

// 1.7+: "2026-10-17 16:13:54.836 ERROR [Verse] message"
const HEADER_RE = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+\s+(INFO|WARN|WARNING|ERROR|FATAL|DEBUG|TRACE)\s+\[([^\]]+)\]\s?(.*)$/
const HARMONY_RE = /^\s+- (PREFIX|POSTFIX|TRANSPILER|FINALIZER|ILMANIPULATOR) ([^:]+): (\S+) <- \S+ ([\w.+`]+):/
const FRAME_RE = /^\s+at \.?([\w.+`<>]+?)(?:_Patch\d+)?\(/
const LEGACY_STACK_RE =
  /^(\s+at |\s+- (PREFIX|POSTFIX|TRANSPILER|FINALIZER|ILMANIPULATOR) |\[Ref [0-9A-F]+\]|\(wrapper |\(Filename: |UnityEngine\.StackTraceUtility|--->|--- End of|[\w.`<>+[\],]+[:.][\w<>.`|$]+ ?\(.*\)\s*(\[0x[0-9a-f]+\].*)?$)/
const GAME_NS = /^(Verse|RimWorld|System|UnityEngine|Unity|Mono|HarmonyLib|MonoMod|Brutal|Waylith|RimWorldWaylith|LudeonTK|Microsoft|Steamworks|Ionic|\(wrapper|\.?<)/
const ERROR_WORDS = /exception|\berror\b|could not|couldn't|failed to|cannot |invalid |null ?reference|xml error|config error/i
const IGNORED_WARN_CATEGORIES = new Set(['NativeAllocationRuntime', 'UnityStubs', 'VulkanStartup'])

function normalize(msg: string): string {
  return msg
    .replace(/[A-Z]:\\[^\s:]+/gi, '<path>')
    .replace(/0x[0-9a-f]+/gi, '#')
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/-?\d+(\.\d+)?/g, '#')
    .slice(0, 220)
}

function modForType(fullType: string, a: Attribution): string | undefined {
  let ns = fullType
  while (ns) {
    const pid = a.namespaces.get(ns)
    if (pid) return pid
    const i = Math.max(ns.lastIndexOf('.'), ns.lastIndexOf('+'))
    ns = i > 0 ? ns.slice(0, i) : ''
  }
  return undefined
}

/**
 * Blame in order of confidence: the first mod-owned frame of the exception, Harmony patches sitting on the top
 * frames, mod code that called Log.Error, then names/namespaces mentioned in the message itself.
 */
function attribute(message: string, stack: string[], a: Attribution): string[] {
  const hits: string[] = []
  const add = (pid: string | undefined) => {
    if (pid && !hits.includes(pid) && pid !== 'ludeon.rimworld' && pid !== 'brrainz.harmony') hits.push(pid)
  }
  const frames: string[] = []
  const harmony: { target: string; owner: string; id: string }[] = []
  for (const line of stack) {
    const h = line.match(HARMONY_RE)
    if (h) harmony.push({ id: h[2], target: h[3], owner: h[4] })
    else {
      const f = line.match(FRAME_RE)
      if (f) frames.push(f[1])
    }
  }
  const firstMod = frames.find((f) => !GAME_NS.test(f))
  if (firstMod) add(modForType(firstMod, a))
  const top = frames.slice(0, 4)
  for (const h of harmony) {
    if (!top.some((f) => f === h.target || f.startsWith(h.target))) continue
    add(modForType(h.owner, a) ?? a.harmonyIds.get(h.id.toLowerCase()) ?? (a.packageIds.has(h.id.toLowerCase()) ? h.id.toLowerCase() : undefined))
  }
  for (const m of message.matchAll(/\b([A-Z][\w]*(?:\.[A-Z][\w]*)+)/g)) if (!GAME_NS.test(m[1])) add(modForType(m[1], a))
  const bracket = message.match(/^\[([^\]]{2,60})\]/)
  if (bracket) add(a.names.get(bracket[1].toLowerCase()))
  const lower = message.toLowerCase()
  for (const pid of a.packageIds) if (pid.includes('.') && lower.includes(pid)) add(pid)
  return hits.slice(0, 3)
}

interface RawEntry {
  level: LogEntry['level']
  message: string
  stack: string[]
  line: number
}

function* modernEntries(lines: string[]): Generator<RawEntry> {
  let cur: { lvl: string; cat: string; msg: string; stack: string[]; line: number } | null = null
  const flush = function* (): Generator<RawEntry> {
    if (!cur) return
    const isErr = cur.lvl === 'ERROR' || cur.lvl === 'FATAL'
    const isWarn = cur.lvl === 'WARN' || cur.lvl === 'WARNING'
    if (isWarn && IGNORED_WARN_CATEGORIES.has(cur.cat)) return
    if (!isErr && !isWarn) return
    const exception = isErr && (/exception/i.test(cur.msg) || cur.stack[0]?.startsWith('[Ref '))
    yield { level: exception ? 'exception' : isErr ? 'error' : 'warning', message: cur.msg, stack: cur.stack, line: cur.line }
  }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(HEADER_RE)
    if (m) {
      yield* flush()
      cur = { lvl: m[1], cat: m[2], msg: m[3], stack: [], line: i + 1 }
    } else if (cur && lines[i]) {
      if (!cur.stack.length && !/^\s|^\[Ref /.test(lines[i])) cur.msg += '\n' + lines[i]
      else cur.stack.push(lines[i])
    }
  }
  yield* flush()
}

function* legacyEntries(lines: string[]): Generator<RawEntry> {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || LEGACY_STACK_RE.test(line)) continue
    let j = i + 1
    while (j < lines.length && LEGACY_STACK_RE.test(lines[j])) j++
    const stack = lines.slice(i + 1, j)
    const exception = stack[0]?.startsWith('[Ref ') || /exception/i.test(line)
    const level: LogEntry['level'] | null = exception
      ? 'exception'
      : ERROR_WORDS.test(line) || stack.some((s) => s.includes('Verse.Log:Error'))
        ? 'error'
        : /\bwarning\b/i.test(line) || stack.some((s) => s.includes('Verse.Log:Warning'))
          ? 'warning'
          : null
    if (level) yield { level, message: line, stack, line: i + 1 }
    i = j - 1
  }
}

export async function parsePlayerLog(file: string, a: Attribution): Promise<LogReport> {
  const [raw, st] = await Promise.all([readFile(file, 'utf8'), stat(file)])
  const lines = raw.split(/\r?\n/)
  const head = lines.slice(0, 60).join('\n')
  const gameVersion = head.match(/^Version:\s+(\S+)/m)?.[1] ?? head.match(/^RimWorld (\d+\.\d+\.\d+ rev\d+)/m)?.[1]
  const modern = lines.slice(0, 200).some((l) => HEADER_RE.test(l))

  const groups = new Map<string, LogEntry>()
  const refs = new Map<string, LogEntry>()
  for (const e of modern ? modernEntries(lines) : legacyEntries(lines)) {
    const ref = e.stack[0]?.match(/^\[Ref ([0-9A-F]+)\]( Duplicate stacktrace)?/)
    // Identical stack traces share a [Ref] hash, so "Exception ticking <pawn>" collapses into one entry.
    const key = e.level + ':' + (ref && !ref[2] ? 'ref:' + ref[1] : normalize(e.message))
    let entry = (ref?.[2] ? refs.get(ref[1]) : undefined) ?? groups.get(key)
    const stackText = e.stack.join('\n')
    if (entry) {
      entry.count++
      if (!entry.stack && stackText && !ref?.[2]) entry.stack = stackText.slice(0, 12000)
    } else {
      entry = { key, level: e.level, message: e.message.slice(0, 2000), stack: ref?.[2] ? '' : stackText.slice(0, 12000), count: 1, firstLine: e.line, mods: [] }
      groups.set(key, entry)
    }
    if (ref && !ref[2]) refs.set(ref[1], entry)
    if (entry.mods.length < 3) for (const pid of attribute(e.message, e.stack, a)) if (!entry.mods.includes(pid) && entry.mods.length < 3) entry.mods.push(pid)
  }

  const order = { exception: 0, error: 1, warning: 2 }
  const entries = [...groups.values()].sort((x, y) => order[x.level] - order[y.level] || y.count - x.count || x.firstLine - y.firstLine)
  return { path: file, mtime: st.mtimeMs, lines: lines.length, entries: entries.slice(0, 1500), gameVersion }
}
