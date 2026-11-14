import { mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Replacement, RuleMap, RulesBundle } from '../../shared/types.ts'
import { lowerRuleKeys, rimsortDir } from './rimsort.ts'
import { atomicWrite } from './store.ts'

const COMMUNITY_URL = 'https://raw.githubusercontent.com/RimSort/Community-Rules-Database/main/communityRules.json'
const REPLACEMENTS_URL = 'https://raw.githubusercontent.com/emipa606/UseThisInstead/main/replacements.json.gz'
const MAX_AGE = 24 * 3600 * 1000

function stripBom(s: string) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

// Both files hold thousands of entries; a cut-off or garbage download fails these checks.
function communityOk(buf: Buffer) {
  try {
    const rules = JSON.parse(stripBom(buf.toString('utf8'))).rules
    return buf.length > 1024 && !!rules && typeof rules === 'object' && !Array.isArray(rules) && Object.keys(rules).length >= 10
  } catch {
    return false
  }
}

function replacementsOk(buf: Buffer) {
  try {
    const raw = buf[0] === 0x1f ? gunzipSync(buf) : buf
    const rules = JSON.parse(stripBom(raw.toString('utf8'))).rules
    return raw.length > 1024 && Array.isArray(rules) && rules.length >= 10
  } catch {
    return false
  }
}

// A download replaces the cached copy only once it reads as a real rules file.
async function fetchTo(url: string, file: string, ok: (buf: Buffer) => boolean): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  if (!ok(buf)) throw new Error('The download was incomplete or damaged')
  await atomicWrite(file, buf)
  return buf
}

async function cached(file: string): Promise<{ buf: Buffer; age: number } | null> {
  try {
    const [buf, st] = await Promise.all([readFile(file), stat(file)])
    return { buf, age: Date.now() - st.mtimeMs }
  } catch {
    return null
  }
}

async function getFile(url: string, file: string, ok: (buf: Buffer) => boolean, force: boolean, fallback?: string): Promise<{ buf: Buffer | null; fetchedAt: number; source: string }> {
  let c = await cached(file)
  // A cache damaged before downloads were checked is treated as missing.
  if (c && !ok(c.buf)) c = null
  if (c && !force && c.age < MAX_AGE) return { buf: c.buf, fetchedAt: Date.now() - c.age, source: 'cache' }
  try {
    return { buf: await fetchTo(url, file, ok), fetchedAt: Date.now(), source: 'network' }
  } catch {
    if (c) return { buf: c.buf, fetchedAt: Date.now() - c.age, source: 'cache (offline)' }
    if (fallback) {
      try {
        return { buf: await readFile(fallback), fetchedAt: 0, source: 'RimSort cache' }
      } catch {}
    }
    return { buf: null, fetchedAt: 0, source: 'unavailable' }
  }
}

export async function loadRules(dbDir: string, force = false): Promise<RulesBundle> {
  await mkdir(dbDir, { recursive: true })
  const rimsort = rimsortDir()
  const [cr, rp] = await Promise.all([
    getFile(COMMUNITY_URL, join(dbDir, 'communityRules.json'), communityOk, force, rimsort && join(rimsort, 'communityRules.json')),
    getFile(REPLACEMENTS_URL, join(dbDir, 'replacements.json.gz'), replacementsOk, force, rimsort && join(rimsort, 'dbs', 'UseThisInstead', 'replacements.json.gz')),
  ])
  let community: RuleMap = {}
  let replacements: Replacement[] = []
  try {
    if (cr.buf) community = lowerRuleKeys(JSON.parse(stripBom(cr.buf.toString('utf8'))).rules)
  } catch {}
  try {
    if (rp.buf) {
      const raw = rp.buf[0] === 0x1f ? gunzipSync(rp.buf) : rp.buf
      replacements = JSON.parse(stripBom(raw.toString('utf8'))).rules ?? []
    }
  } catch {}
  return {
    community,
    replacements,
    fetchedAt: Math.min(cr.fetchedAt || Date.now(), rp.fetchedAt || Date.now()),
    source: `rules: ${cr.source}, replacements: ${rp.source}`,
  }
}
