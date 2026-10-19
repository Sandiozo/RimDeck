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

const lineAt = (text: string, idx: number) => {
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < idx; i = text.indexOf('\n', i + 1)) n++
  return n
}

const TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)([^>]*?)(\/?)>/g
const ATTR = (attrs: string, name: string) => attrs.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]

// Strip comments/CDATA but keep offsets (replace with spaces) so line numbers stay right.
function blank(text: string) {
  return text.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => m.replace(/[^\n]/g, ' '))
}

function scanDefs(raw: string, file: string, out: ModXml) {
  const text = blank(raw)
  let depth = 0
  let current: { type: string; start: number; name?: string; abstractName?: string } | null = null
  TAG_RE.lastIndex = 0
  for (let m; (m = TAG_RE.exec(text)); ) {
    const [, close, tag, attrs, selfClose] = m
    if (tag.startsWith('?') || tag === 'xml') continue
    if (close) {
      depth--
      if (depth === 1 && current) {
        if (current.name) out.defs.push({ key: `${current.type}/${current.name}`, file, line: lineAt(text, current.start) })
        if (current.abstractName) out.defs.push({ key: `abstract/${current.abstractName}`, file, line: lineAt(text, current.start) })
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
      if (current.abstractName) out.defs.push({ key: `abstract/${current.abstractName}`, file, line: lineAt(text, current.start) })
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
  const classes: { idx: number; cls: string }[] = []
  for (const m of text.matchAll(/Class\s*=\s*"([^"]+)"/g)) classes.push({ idx: m.index!, cls: m[1].split('.').pop()! })
  for (const m of text.matchAll(/<xpath>([\s\S]*?)<\/xpath>/g)) {
    const xpath = m[1].trim()
    let op = 'PatchOperation'
    for (const c of classes) if (c.idx < m.index!) op = c.cls
    const { defs, node } = parseXpath(xpath)
    out.patches.push({ file, line: lineAt(text, m.index!), op, xpath, defs, node })
  }
  for (const m of text.matchAll(/<mods>([\s\S]*?)<\/mods>/g)) for (const li of m[1].matchAll(/<li>([^<]+)<\/li>/g)) out.findMods.push(li[1].trim())
  for (const m of text.matchAll(/MayRequire\s*=\s*"([^"]+)"/g)) for (const p of m[1].split(',')) out.mayRequire.push(p.trim().toLowerCase())
}

export async function indexModXml(mod: ModInfo, dirsToLoad = mod.contentDirs): Promise<ModXml> {
  const out: ModXml = { defs: [], patches: [], findMods: [], mayRequire: [], parents: [], files: [], bytes: 0 }
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
      const texts = await Promise.all(files.map((f) => readFile(f, 'utf8').catch(() => '')))
      texts.forEach((t, i) => {
        out.bytes += t.length
        scan(t, files[i], out)
      })
    }
  }
  return out
}

const ORDER_SENSITIVE = /Replace|AttributeSet|SetName/

export function buildXmlReport(mods: ModInfo[], indexes: ModXml[], ms: number): XmlReport {
  const game = (m: ModInfo) => m.source === 'core' || m.source === 'dlc'
  const vanilla = new Set<string>()
  indexes.forEach((x, i) => game(mods[i]) && x.defs.forEach((d) => vanilla.add(d.key)))

  const defOwners = new Map<string, XmlConflict['mods']>()
  const patchOwners = new Map<string, XmlConflict['mods']>()
  const vanillaOverrides: Record<string, number> = {}
  indexes.forEach((x, i) => {
    const m = mods[i]
    if (game(m)) return
    const seen = new Set<string>()
    for (const d of x.defs) {
      if (seen.has(d.key)) continue
      seen.add(d.key)
      if (vanilla.has(d.key)) vanillaOverrides[m.packageId] = (vanillaOverrides[m.packageId] ?? 0) + 1
      defOwners.set(d.key, [...(defOwners.get(d.key) ?? []), { packageId: m.packageId, file: d.file, line: d.line }])
    }
    const seenP = new Set<string>()
    for (const p of x.patches) {
      if (!/Replace|Remove|AttributeSet|SetName/.test(p.op) || !p.node) continue
      for (const def of p.defs) {
        const k = `${def}/${p.node}`
        if (seenP.has(k)) continue
        seenP.add(k)
        patchOwners.set(k, [...(patchOwners.get(k) ?? []), { packageId: m.packageId, file: p.file, line: p.line, op: p.op }])
      }
    }
  })

  const conflicts: XmlConflict[] = []
  for (const [key, owners] of defOwners) if (owners.length > 1) conflicts.push({ kind: 'def', key, mods: owners })
  // Two removals of the same node are harmless; order only matters once something is replaced.
  for (const [key, owners] of patchOwners)
    if (owners.length > 1 && owners.some((o) => ORDER_SENSITIVE.test(o.op ?? ''))) conflicts.push({ kind: 'patch', key, mods: owners })

  // B "refers to" A when it targets A with FindMod, MayRequire, or inherits A's abstract defs.
  const byId = new Map(mods.map((m, i) => [m.packageId, i]))
  const refers = (b: number, a: number) => {
    const A = mods[a]
    const X = indexes[b]
    const abstracts = new Set(indexes[a].defs.filter((d) => d.key.startsWith('abstract/')).map((d) => d.key.slice(9)))
    return (
      X.findMods.some((n) => n.toLowerCase() === A.name.toLowerCase()) ||
      X.mayRequire.includes(A.packageId) ||
      X.parents.some((p) => abstracts.has(p))
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

export async function searchXml(query: string, mods: ModInfo[], indexes: ModXml[], limit = 500): Promise<XmlSearchResult> {
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
  outer: for (let i = 0; i < indexes.length; i++) {
    const texts = await Promise.all(indexes[i].files.map((f) => readFile(f, 'utf8').catch(() => '')))
    res.filesScanned += texts.length
    for (let f = 0; f < texts.length; f++) {
      const text = texts[f]
      if (!text.toLowerCase().includes(lower)) continue
      const lines = text.split('\n')
      lines.forEach((l, n) => {
        if (res.hits.length < limit && l.toLowerCase().includes(lower)) res.hits.push({ packageId: mods[i].packageId, file: indexes[i].files[f], line: n + 1, text: l.trim().slice(0, 240) })
      })
      if (res.hits.length >= limit) {
        res.truncated = true
        break outer
      }
    }
  }
  res.ms = Math.round(performance.now() - t)
  return res
}
