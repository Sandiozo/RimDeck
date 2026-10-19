import type { Issue, ModInfo, ModMeta } from '@shared/types'

export interface FilterCtx {
  meta: Record<string, ModMeta>
  issues: Map<string, Issue[]>
  gameMajor: string
  categoryOf?: (pid: string) => string
  changed?: Set<string> // mods updated/added/turned on since the last play session
}

const DAY = 86400000
export const NEW_DAYS = 3

/**
 * Search syntax: free text matches name/author/packageId/tags/notes.
 * Tokens: is:error is:warning is:outdated is:current is:new is:workshop is:local is:dlc is:issue has:dll has:patches
 *         v:<version> updated:<days> cat:<category> tag:<tag> author:<name> -<token> negates.
 */
export function matchMod(m: ModInfo | undefined, pid: string, query: string, ctx: FilterCtx): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const meta = ctx.meta[pid]
  const issues = ctx.issues.get(pid) ?? []
  for (let tok of q.split(/\s+/)) {
    const neg = tok.startsWith('-') && tok.length > 1
    if (neg) tok = tok.slice(1)
    let ok: boolean
    const [k, v] = tok.includes(':') ? [tok.slice(0, tok.indexOf(':')), tok.slice(tok.indexOf(':') + 1)] : ['', tok]
    switch (k) {
      case 'is':
        ok =
          v === 'error' ? issues.some((i) => i.severity === 'error')
          : v === 'warning' ? issues.some((i) => i.severity === 'warning')
          : v === 'issue' ? issues.length > 0
          : v === 'outdated' ? !!m && m.source !== 'dlc' && m.source !== 'core' && !m.supportedVersions.includes(ctx.gameMajor)
          : v === 'current' ? !!m && (m.source === 'dlc' || m.source === 'core' || m.supportedVersions.includes(ctx.gameMajor))
          : v === 'changed' ? !!ctx.changed?.has(pid)
          : v === 'new' || v === 'updated' ? !!m && Date.now() - m.mtime < NEW_DAYS * DAY
          : v === 'missing' ? !m
          : v === 'workshop' || v === 'steam' ? m?.source === 'workshop'
          : v === 'local' ? m?.source === 'local'
          : v === 'dlc' ? m?.source === 'dlc' || m?.source === 'core'
          : v === 'tagged' ? !!meta?.tags?.length
          : v === 'colored' ? !!meta?.color
          : false
        break
      case 'has':
        ok = v === 'dll' || v === 'code' ? !!m?.hasAssemblies : v === 'patches' ? !!m?.hasPatches : v === 'notes' ? !!meta?.notes : false
        break
      case 'cat':
      case 'category':
        ok = (ctx.categoryOf?.(pid) ?? meta?.category ?? m?.category ?? '').startsWith(v)
        break
      case 'v':
      case 'ver':
      case 'version':
        ok = !!m?.supportedVersions.includes(v)
        break
      case 'updated':
      case 'new':
        ok = !!m && Date.now() - m.mtime < (Number(v) || NEW_DAYS) * DAY
        break
      case 'tag':
        ok = !!meta?.tags?.some((t) => t.toLowerCase().includes(v))
        break
      case 'author':
        ok = !!m?.authors.some((a) => a.toLowerCase().includes(v))
        break
      case 'id':
        ok = pid.includes(v)
        break
      default:
        ok =
          pid.includes(tok) ||
          !!m?.name.toLowerCase().includes(tok) ||
          !!m?.authors.some((a) => a.toLowerCase().includes(tok)) ||
          !!meta?.tags?.some((t) => t.toLowerCase().includes(tok)) ||
          !!meta?.notes?.toLowerCase().includes(tok) ||
          (!!m?.workshopId && m.workshopId === tok)
    }
    if (ok === neg) return false
  }
  return true
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Unity rich text (<b>, <i>, <color>, <size>) rendered safely; everything else is escaped.
export function richText(src: string): string {
  let out = esc(src)
  out = out
    .replace(/&lt;(\/?)(b|i)&gt;/gi, '<$1$2>')
    .replace(/&lt;color=(&quot;)?(#[0-9a-f]{3,8}|[a-z]+)(&quot;)?&gt;/gi, (_m, _q, c) => `<span style="color:${c}">`)
    .replace(/&lt;\/color&gt;/gi, '</span>')
    .replace(/&lt;size=[^&]*&gt;|&lt;\/size&gt;/gi, '')
    .replace(/(https?:\/\/[^\s<)"]+)/g, '<a href="$1" target="_blank" rel="noreferrer">$1</a>')
  return out
}

export function timeAgo(ms: number): string {
  if (!ms) return 'never'
  const s = (Date.now() - ms) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
  return new Date(ms).toLocaleDateString()
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(2)} GB`
}

// Earthy marker colours that sit with the steel-and-rust theme.
export const TAG_COLORS = ['#d9614c', '#d9792b', '#e2a83e', '#8fb854', '#4fb3a6', '#6f9fc4', '#8f86c4', '#b98aa8', '#a39e94']

export function worst(issues: Issue[] | undefined): Issue['severity'] | null {
  if (!issues?.length) return null
  if (issues.some((i) => i.severity === 'error')) return 'error'
  if (issues.some((i) => i.severity === 'warning')) return 'warning'
  return 'info'
}

const NOISE_TERMS = new Set(['null', 'true', 'false', 'object', 'string', 'none', 'this', 'type', 'name', 'value', 'named', 'defname'])

// Def names worth searching for in a log message, e.g. "No Verse.ThingDef named Foo" -> Foo.
const termCache = new Map<string, string[]>()

export function searchTerms(message: string): string[] {
  const hit = termCache.get(message)
  if (hit) return hit
  if (termCache.size > 2000) termCache.clear()
  const out = findSearchTerms(message)
  termCache.set(message, out)
  return out
}

function findSearchTerms(message: string): string[] {
  const out: string[] = []
  const patterns = [
    /\bnamed\s+["']?([A-Za-z_][\w\-]{2,})/g,
    /\bdefName\s*[=:]?\s*["']?([A-Za-z_][\w\-]{2,})/g,
    /\b(?:ThingDef|HediffDef|RecipeDef|ResearchProjectDef|TerrainDef|JobDef|StatDef|TraitDef|PawnKindDef|FactionDef|WorkGiverDef|ThoughtDef|GeneDef|AbilityDef)\s+["']?([A-Za-z_][\w\-]{2,})/g,
    /["']([A-Za-z_][\w\-]{3,})["']/g,
  ]
  for (const re of patterns)
    for (const m of message.matchAll(re)) {
      const t = m[1]
      if (!NOISE_TERMS.has(t.toLowerCase()) && !t.includes('.') && !out.includes(t)) out.push(t)
    }
  return out.slice(0, 3)
}
