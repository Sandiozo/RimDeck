import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import type { Replacement, RuleMap, RulesBundle } from '../../shared/types.ts'
import { rimsortDir } from './rimsort.ts'

const COMMUNITY_URL = 'https://raw.githubusercontent.com/RimSort/Community-Rules-Database/main/communityRules.json'
const REPLACEMENTS_URL = 'https://raw.githubusercontent.com/emipa606/UseThisInstead/main/replacements.json.gz'
const MAX_AGE = 24 * 3600 * 1000

function stripBom(s: string) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

function lowerKeys(rules: Record<string, any>): RuleMap {
  const out: RuleMap = {}
  const lowerInner = (o: any) =>
    o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v])) : o
  for (const [id, r] of Object.entries(rules ?? {})) {
    out[id.toLowerCase()] = {
      ...r,
      loadAfter: lowerInner(r.loadAfter),
      loadBefore: lowerInner(r.loadBefore),
      incompatibleWith: lowerInner(r.incompatibleWith),
    }
  }
  return out
}

async function fetchTo(url: string, file: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(file, buf)
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

async function getFile(url: string, file: string, force: boolean, fallback?: string): Promise<{ buf: Buffer | null; fetchedAt: number; source: string }> {
  const c = await cached(file)
  if (c && !force && c.age < MAX_AGE) return { buf: c.buf, fetchedAt: Date.now() - c.age, source: 'cache' }
  try {
    return { buf: await fetchTo(url, file), fetchedAt: Date.now(), source: 'network' }
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
    getFile(COMMUNITY_URL, join(dbDir, 'communityRules.json'), force, rimsort && join(rimsort, 'communityRules.json')),
    getFile(REPLACEMENTS_URL, join(dbDir, 'replacements.json.gz'), force, rimsort && join(rimsort, 'dbs', 'UseThisInstead', 'replacements.json.gz')),
  ])
  let community: RuleMap = {}
  let replacements: Replacement[] = []
  try {
    if (cr.buf) community = lowerKeys(JSON.parse(stripBom(cr.buf.toString('utf8'))).rules)
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
