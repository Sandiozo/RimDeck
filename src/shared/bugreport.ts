import type { CrashEntry } from './types.ts'

// The bug report: plain Markdown the user reads before sharing it. Built in one place, so another
// destination than a GitHub issue would only need a new way to send the same text.

export const REPO = 'Sandiozo/RimDeck'
export const REPO_URL = `https://github.com/${REPO}`
export const NEW_ISSUE_URL = `${REPO_URL}/issues/new`
// Windows opens links through the shell, which refuses links longer than 2048 characters.
// GitHub itself takes about 8000, so the Windows limit is the one that counts everywhere.
export const MAX_LINK = 2000
const MAX_ERRORS = 5
const LINK_NOTE = '**The full report did not fit in the link. RimDeck copied it to your clipboard: please paste it below.**'

export interface ReportFacts {
  version: string
  packaged: boolean
  system: string // "Windows 10.0.26100 (x64)"
  electron: string
  game: string // RimWorld version, '' when not found
  installed: number
  active: number
  dlcs: string[]
  sorting: string[] // "style: by category", "community rules: on", …
  checkingAgainst?: string // the version mods are checked against, when not the installed game
  abnormalEnd: boolean
  damaged: string[] // settings files set aside this run
  errors: CrashEntry[] // newest first
  mods?: string[] // active package ids in load order, when the user chose to include them
}

// A code fence longer than any run of backticks inside, so the text can't end it early.
function fenced(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}text\n${text}\n${fence}`
}

function firstLine(s: string, max = 80): string {
  const line = s.trim().split(/\r?\n/)[0].trim()
  return line.length > max ? line.slice(0, max - 1) + '…' : line
}

function setup(f: ReportFacts): string {
  return [
    `- RimDeck ${f.version} (${f.packaged ? 'installed app' : 'development build'})`,
    `- ${f.system}`,
    `- Electron ${f.electron}`,
    `- RimWorld ${f.game || 'not found'}`,
    `- Mods: ${f.installed} installed, ${f.active} active`,
    `- DLCs: ${f.dlcs.length ? f.dlcs.join(', ') : 'none'}`,
    `- Sorting: ${f.sorting.join(' · ')}`,
    ...(f.checkingAgainst ? [`- Checking mods against ${f.checkingAgainst}`] : []),
    ...(f.abnormalEnd ? ['- The previous run did not close normally'] : []),
    ...(f.damaged.length ? [`- Damaged settings files set aside this run: ${f.damaged.join(', ')}`] : []),
  ].join('\n')
}

function error(e: CrashEntry, current: string, stackLines = Infinity): string {
  const when = e.time.slice(0, 16).replace('T', ' ') + ' UTC'
  const times = (e.count ?? 1) > 1 ? ` (${e.count} times)` : ''
  const version = e.version !== current ? ` · RimDeck ${e.version}` : ''
  const head = `**${when} · ${e.source} · ${e.kind}**${times}${version}`
  // Most stack traces start with the message; show it once, then the frames.
  const stack = e.stack ? e.stack.split('\n') : []
  const start = stack.findIndex((l) => /^\s+(at\s|…)/.test(l))
  const repeats = start > 0 && stack[0].includes(e.message.split('\n')[0].trim())
  const header = repeats ? stack.slice(0, start) : e.message.split('\n')
  const frames = repeats ? stack.slice(start) : stack
  return `${head}\n\n${fenced([...header, ...frames.slice(0, stackLines)].join('\n'))}`
}

const section = (title: string, body: string) => `### ${title}\n\n${body}`

/** The issue title: the first line of the description, else the newest error. */
export function reportTitle(f: ReportFacts, description: string): string {
  if (description.trim()) return firstLine(description)
  const e = f.errors[0]
  return e ? firstLine(`${e.kind}: ${e.message}`) : 'Bug report'
}

/** The full report. */
export function buildReport(f: ReportFacts, description: string): string {
  const parts = [
    section('What happened', description.trim() || '_No description given._'),
    section('Setup', setup(f)),
    section('Recent errors', f.errors.length ? f.errors.slice(0, MAX_ERRORS).map((e) => error(e, f.version)).join('\n\n') : '_No errors logged._'),
  ]
  if (f.mods) parts.push(`<details>\n<summary>Active mods in load order (${f.mods.length})</summary>\n\n${fenced(f.mods.join('\n'))}\n\n</details>`)
  return parts.join('\n\n') + '\n'
}

export function issueUrl(title: string, body: string): string {
  return `${NEW_ISSUE_URL}?${new URLSearchParams({ title, body })}`
}

/**
 * A link to a new GitHub issue with the report filled in. When the full report is too long for a
 * link, the link gets the description, the setup and the newest error, cut further if needed.
 */
export function issueLink(f: ReportFacts, description: string, max = MAX_LINK): { url: string; title: string; cut: boolean } {
  const title = reportTitle(f, description)
  const fits = (body: string) => issueUrl(title, body).length <= max
  const full = buildReport(f, description)
  if (fits(full)) return { url: issueUrl(title, full), title, cut: false }
  const short = (desc: string, err: string | null) =>
    [section('What happened', desc.trim() || '_No description given._'), section('Setup', setup(f)), ...(err ? [section('Newest error', err)] : []), LINK_NOTE].join('\n\n') + '\n'
  const newest = f.errors[0]
  if (newest)
    for (const n of [10, 5, 2, 0]) {
      const body = short(description, error(newest, f.version, n))
      if (fits(body)) return { url: issueUrl(title, body), title, cut: true }
    }
  if (fits(short(description, null))) return { url: issueUrl(title, short(description, null)), title, cut: true }
  // Keep as much of the description as fits.
  const chars = [...description.trim()]
  let lo = 0
  let hi = chars.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(short(chars.slice(0, mid).join('') + '…', null))) lo = mid
    else hi = mid - 1
  }
  const body = short(chars.slice(0, lo).join('') + '…', null)
  if (fits(body)) return { url: issueUrl(title, body), title, cut: true }
  return { url: issueUrl(title, LINK_NOTE), title, cut: true }
}
