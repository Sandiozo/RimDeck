import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModInfo, RuleMap, XmlConflict, XmlReport, XmlSearchResult } from '../../shared/types.ts'

export interface DefEntry {
  key: string // "ThingDef/Steel" or "abstract/BaseWeapon"
  file: string
  line: number
}

export interface PatchEntry {
  file: string
  line: number
  op: string // operation class, e.g. PatchOperationReplace
  xpath: string
  defs: string[] // def names the xpath selects (defName="X")
  node: string // path below the def selector, e.g. "statBases/MarketValue"
}

export interface ModXml {
  defs: DefEntry[]
  patches: PatchEntry[]
  findMods: string[] // mod names used in PatchOperationFindMod
  mayRequire: string[] // packageIds from MayRequire attributes
  parents: string[] // ParentName values used
  files: string[] // every Defs/Patches xml file, for search
  bytes: number
  unreadable?: number // files that exist but could not be read; their defs and patches are missing
}

// All XML reads share one queue, so a long mod list never has thousands of files open at once
// (too many open files, memory spikes). Each worker thread has its own queue (see workers/worker.ts).
let maxReads = 32
const CHUNK = 64 // files read ahead per folder before they are scanned in order
let reading = 0
const waiting: (() => void)[] = []

/** How many files this thread's queue reads at once. */
export function setReadLimit(n: number) {
  maxReads = Math.max(1, Math.floor(n))
}

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (reading < maxReads) reading++
  else await new Promise<void>((r) => waiting.push(r)) // the slot is handed over by the one finishing
  try {
    return await fn()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else reading--
  }
}

const TRANSIENT = new Set(['EMFILE', 'ENFILE', 'EBUSY', 'EAGAIN'])

/** A file's text through the shared queue: '' when it no longer exists, null (with a warning) when it can't be read. */
export async function readXmlText(file: string): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await limited(() => readFile(file, 'utf8'))
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? ''
      if (code === 'ENOENT') return ''
      if (TRANSIENT.has(code) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 100 * (attempt + 1)))
        continue
      }
      console.warn(`[rimdeck] could not read ${file}: ${(e as Error).message}`)
      return null
    }
  }
}

async function walk(dir: string): Promise<string[]> {
  try {
    const entries = (await readdir(dir, { withFileTypes: true, recursive: true })) as any[]
    return entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.xml')).map((e) => join(e.parentPath, e.name))
  } catch {
    return []
  }
}

async function folderCI(root: string, name: string): Promise<string | null> {
  try {
    const e = (await readdir(root, { withFileTypes: true })).find((x) => x.isDirectory() && x.name.toLowerCase() === name)
    return e ? join(root, e.name) : null
  } catch {
    return null
  }
}

// Line numbers for offsets in one file. Offsets mostly increase, so counting continues from the last one.
function lineCounter(text: string) {
  let at = 0
  let line = 1
  return (idx: number) => {
    if (idx < at) {
      at = 0
      line = 1
    }
    for (let i = text.indexOf('\n', at); i !== -1 && i < idx; i = text.indexOf('\n', i + 1)) {
      line++
      at = i + 1
    }
    return line
  }
}

const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g
const ATTR = (attrs: string, name: string) => attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]

// Strip comments/CDATA but keep offsets (replace with spaces) so line numbers stay right.
function blank(text: string) {
  return text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => m.replace(/[^\n]/g, ' '))
}

function scanDefs(raw: string, file: string, out: ModXml) {
  const text = blank(raw)
  const lineAt = lineCounter(text)
  let depth = 0
  let current: { type: string; start: number; name?: string; abstractName?: string } | null = null
  TAG_RE.lastIndex = 0
  for (let m; (m = TAG_RE.exec(text)); ) {
    const [, close, tag, attrs, selfClose] = m
    if (tag.startsWith('?') || tag === 'xml') continue
    if (close) {
      depth--
      if (depth === 1 && current) {
        if (current.name) out.defs.push({ key: `${current.type}/${current.name}`, file, line: lineAt(current.start) })
        if (current.abstractName) out.defs.push({ key: `abstract/${current.abstractName}`, file, line: lineAt(current.start) })
        current = null
      }
      continue
    }
    const mr = ATTR(attrs, 'MayRequire')
    if (mr) for (const p of mr.split(',')) out.mayRequire.push(p.trim().toLowerCase())
    if (depth === 1) {
      const parent = ATTR(attrs, 'ParentName')
      if (parent) out.parents.push(parent)
      current = { type: tag, start: m.index, abstractName: ATTR(attrs, 'Name') }
    } else if (depth === 2 && current && tag === 'defName' && !selfClose) {
      const end = text.indexOf('</defName>', TAG_RE.lastIndex)
      if (end > 0) current.name = text.slice(TAG_RE.lastIndex, end).trim()
    }
    if (!selfClose) depth++
    else if (depth === 1 && current) {
      if (current.abstractName) out.defs.push({ key: `abstract/${current.abstractName}`, file, line: lineAt(current.start) })
      current = null
    }
  }
}

// Splits "/Defs/ThingDef[defName="A" or defName="B"]/statBases/MarketValue" into the defs and the node below them.
export function parseXpath(xpath: string): { defs: string[]; node: string } {
  const defs = [...xpath.matchAll(/defName\s*=\s*["']([^"']+)["']/g)].map((m) => m[1])
  const m = xpath.match(/defName[^\]]*\]\s*\/?(.*)$/)
  return { defs, node: m ? m[1].replace(/\s+/g, '') : '' }
}

function scanPatches(raw: string, file: string, out: ModXml) {
  const text = blank(raw)
  const lineAt = lineCounter(text)
  const classes: { idx: number; cls: string }[] = []
  for (const m of text.matchAll(/Class\s*=\s*"([^"]+)"/g)) classes.push({ idx: m.index!, cls: m[1].split('.').pop()! })
  for (const m of text.matchAll(/<xpath>([\s\S]*?)<\/xpath>/g)) {
    const xpath = m[1].trim()
    let op = 'PatchOperation'
    for (const c of classes) if (c.idx < m.index!) op = c.cls
    const { defs, node } = parseXpath(xpath)
    out.patches.push({ file, line: lineAt(m.index!), op, xpath, defs, node })
  }
  for (const m of text.matchAll(/<mods>([\s\S]*?)<\/mods>/g)) for (const li of m[1].matchAll(/<li>([^<]+)<\/li>/g)) out.findMods.push(li[1].trim())
  for (const m of text.matchAll(/MayRequire\s*=\s*"([^"]+)"/g)) for (const p of m[1].split(',')) out.mayRequire.push(p.trim().toLowerCase())
}

export async function indexModXml(mod: ModInfo, dirsToLoad = mod.contentDirs): Promise<ModXml> {
  const out: ModXml = { defs: [], patches: [], findMods: [], mayRequire: [], parents: [], files: [], bytes: 0, unreadable: 0 }
  for (const dir of dirsToLoad) {
    const root = join(mod.path, dir)
    for (const [name, scan] of [
      ['defs', scanDefs],
      ['patches', scanPatches],
    ] as const) {
      const sub = await folderCI(root, name)
      if (!sub) continue
      const files = await walk(sub)
      out.files.push(...files)
      // A slice at a time, so a big folder's whole text is never held in memory at once.
      for (let at = 0; at < files.length; at += CHUNK) {
        const part = files.slice(at, at + CHUNK)
        const texts = await Promise.all(part.map(readXmlText))
        texts.forEach((t, i) => {
          if (t == null) return void (out.unreadable = (out.unreadable ?? 0) + 1)
          out.bytes += t.length
          scan(t, part[i], out)
        })
      }
    }
  }
  return out
}

const ORDER_SENSITIVE = /Replace|AttributeSet|SetName/
// Lets the main process answer other requests between parts of a big report (tens of ms in all).
const breather = () => new Promise<void>((r) => setImmediate(r))

export async function buildXmlReport(mods: ModInfo[], indexes: ModXml[], ms: number): Promise<XmlReport> {
  const game = (m: ModInfo) => m.source === 'core' || m.source === 'dlc'
  const vanilla = new Set<string>()
  indexes.forEach((x, i) => game(mods[i]) && x.defs.forEach((d) => vanilla.add(d.key)))

  const defOwners = new Map<string, XmlConflict['mods']>()
  const patchOwners = new Map<string, XmlConflict['mods']>()
  const vanillaOverrides: Record<string, number> = {}
  for (let i = 0; i < indexes.length; i++) {
    if (i % 16 === 15) await breather()
    const x = indexes[i]
    const m = mods[i]
    if (game(m)) continue
    const seen = new Set<string>()
    for (const d of x.defs) {
      if (seen.has(d.key)) continue
      seen.add(d.key)
      if (vanilla.has(d.key)) vanillaOverrides[m.packageId] = (vanillaOverrides[m.packageId] ?? 0) + 1
      const owner = { packageId: m.packageId, file: d.file, line: d.line }
      const list = defOwners.get(d.key)
      if (list) list.push(owner)
      else defOwners.set(d.key, [owner])
    }
    const seenP = new Set<string>()
    for (const p of x.patches) {
      if (!/Replace|Remove|AttributeSet|SetName/.test(p.op) || !p.node) continue
      for (const def of p.defs) {
        const k = `${def}/${p.node}`
        if (seenP.has(k)) continue
        seenP.add(k)
        const owner = { packageId: m.packageId, file: p.file, line: p.line, op: p.op }
        const list = patchOwners.get(k)
        if (list) list.push(owner)
        else patchOwners.set(k, [owner])
      }
    }
  }
  await breather()

  const conflicts: XmlConflict[] = []
  for (const [key, owners] of defOwners) if (owners.length > 1) conflicts.push({ kind: 'def', key, mods: owners })
  // Two removals of the same node are harmless; order only matters once something is replaced.
  for (const [key, owners] of patchOwners)
    if (owners.length > 1 && owners.some((o) => ORDER_SENSITIVE.test(o.op ?? ''))) conflicts.push({ kind: 'patch', key, mods: owners })

  await breather()

  // B "refers to" A when it targets A with FindMod, MayRequire, or inherits A's abstract defs.
  const byId = new Map(mods.map((m, i) => [m.packageId, i]))
  const abstracts = indexes.map((x) => new Set(x.defs.filter((d) => d.key.startsWith('abstract/')).map((d) => d.key.slice(9))))
  const refers = (b: number, a: number) => {
    const A = mods[a]
    const X = indexes[b]
    return (
      X.findMods.some((n) => n.toLowerCase() === A.name.toLowerCase()) ||
      X.mayRequire.includes(A.packageId) ||
      X.parents.some((p) => abstracts[a].has(p))
    )
  }
  const inferred: RuleMap = {}
  const counted = new Map<string, number>()
  for (const c of conflicts)
    for (const a of c.mods)
      for (const b of c.mods) {
        if (a.packageId === b.packageId) continue
        const ia = byId.get(a.packageId)!
        const ib = byId.get(b.packageId)!
        if (refers(ib, ia) && !refers(ia, ib)) counted.set(b.packageId + '|' + a.packageId, (counted.get(b.packageId + '|' + a.packageId) ?? 0) + 1)
      }
  for (const [k, n] of counted) {
    const [b, a] = k.split('|')
    const rule = (inferred[b] ??= {})
    rule.loadAfter = { ...rule.loadAfter, [a]: { name: [mods[byId.get(a)!].name], comment: [`Redefines ${n} thing${n === 1 ? '' : 's'} from it`] } }
  }

  return {
    conflicts,
    inferred,
    vanillaOverrides,
    files: indexes.reduce((n, x) => n + x.files.length, 0),
    defs: indexes.reduce((n, x) => n + x.defs.length, 0),
    patches: indexes.reduce((n, x) => n + x.patches.length, 0),
    ms,
  }
}

export interface FileSearch {
  hits: XmlSearchResult['hits']
  filesScanned: number
  truncated: boolean
}

/** Lines containing `lower` (already lowercased), reading each mod's files in turn until `limit` hits. */
export async function searchFiles(lower: string, mods: { packageId: string; files: string[] }[], limit: number): Promise<FileSearch> {
  const res: FileSearch = { hits: [], filesScanned: 0, truncated: false }
  outer: for (const m of mods) {
    const texts = (await Promise.all(m.files.map(readXmlText))).map((t) => t ?? '')
    res.filesScanned += texts.length
    for (let f = 0; f < texts.length; f++) {
      const text = texts[f]
      if (!text.toLowerCase().includes(lower)) continue
      const lines = text.split('\n')
      lines.forEach((l, n) => {
        if (res.hits.length < limit && l.toLowerCase().includes(lower)) res.hits.push({ packageId: m.packageId, file: m.files[f], line: n + 1, text: l.trim().slice(0, 240) })
      })
      if (res.hits.length >= limit) {
        res.truncated = true
        break outer
      }
    }
  }
  return res
}

/** `scan` reads the files; the main process hands that part to a worker thread. */
export async function searchXml(query: string, mods: ModInfo[], indexes: ModXml[], limit = 500, scan = searchFiles): Promise<XmlSearchResult> {
  const t = performance.now()
  const q = query.trim()
  const lower = q.toLowerCase()
  const res: XmlSearchResult = { query: q, defines: [], patches: [], hits: [], filesScanned: 0, truncated: false, ms: 0 }
  if (q.length < 2) return res
  indexes.forEach((x, i) => {
    const pid = mods[i].packageId
    for (const d of x.defs) {
      const name = d.key.slice(d.key.indexOf('/') + 1)
      if (name.toLowerCase() === lower) res.defines.push({ packageId: pid, file: d.file, line: d.line, text: d.key, key: d.key })
    }
    for (const p of x.patches) if (p.defs.some((d) => d.toLowerCase() === lower)) res.patches.push({ packageId: pid, file: p.file, line: p.line, text: p.xpath, op: p.op })
  })
  const found = await scan(lower, indexes.map((x, i) => ({ packageId: mods[i].packageId, files: x.files })), limit)
  res.hits = found.hits
  res.filesScanned = found.filesScanned
  res.truncated = found.truncated
  res.ms = Math.round(performance.now() - t)
  return res
}
