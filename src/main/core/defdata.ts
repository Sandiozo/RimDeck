import { XMLParser } from 'fast-xml-parser'
import type { ItemDef, ModInfo, ResearchData, ResearchNode, UnlockRef } from '../../shared/types.ts'
import { parseXpath, readXmlText } from './xmlindex.ts'

// Case-sensitive (RimWorld field names are), `li` and every top-level def are always arrays.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name, jpath) => name === 'li' || String(jpath).split('.').length === 2,
})

const KEEP_TYPES = new Set(['ThingDef', 'ResearchTabDef'])
// Mods subclass research defs (e.g. VFE Tribals' TribalResearchProjectDef); they still count as research.
const isResearch = (type: string) => /ResearchProjectDef$/.test(type)
// Internal wrappers that are technically items but not something a player thinks of as one.
const NOT_REALLY_ITEMS = /Minified|Unfinished|Corpse|Transporter|Skyfaller|Blueprint|Frame|DropPod|Pawn/

interface RawDef {
  type: string
  node: any
  mod: number // index into the mods array (load order)
  file: string
}

const txt = (v: any): string => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim()
const lis = (v: any): any[] => (v && typeof v === 'object' && Array.isArray(v.li) ? v.li : [])
// A patch may set a number to 0, so only an empty or non-numeric value keeps the old one.
const num = (v: string, old: number) => (v !== '' && Number.isFinite(Number(v)) ? Number(v) : old)
// Path order, the same on every run and platform (case-insensitive like Windows' own folder listing).
const byPath = (a: string, b: string) => {
  const x = a.toUpperCase()
  const y = b.toUpperCase()
  return x < y ? -1 : x > y ? 1 : 0
}
// Lets the main process answer other requests between batches; a big mod list takes seconds to parse.
const breather = () => new Promise<void>((r) => setImmediate(r))
const CHUNK = 32 // files read ahead, then parsed in order

function parseFile(raw: string): any {
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  try {
    return parser.parse(raw)
  } catch {
    return null
  }
}

// XmlInheritance: child fields override the parent's, `li` lists append unless Inherit="False".
function merge(parent: any, child: any): any {
  if (parent == null) return child
  if (child == null) return parent
  if (typeof parent !== 'object' || typeof child !== 'object') return child
  if (child['@Inherit'] === 'False') return child
  // Attributes (Name, Abstract, ParentName…) belong to the child itself and are never inherited.
  const out: any = Object.fromEntries(Object.entries(parent).filter(([k]) => !k.startsWith('@')))
  for (const [k, v] of Object.entries(child)) {
    if (k === 'li' && Array.isArray(v) && Array.isArray(parent.li)) out.li = [...parent.li, ...v]
    else if (k.startsWith('@')) out[k] = v
    else out[k] = merge(parent[k], v)
  }
  return out
}

const cache = new Map<string, { key: string; defs: RawDef[]; patches: { file: string; root: any }[] }>()

async function modDefs(mod: ModInfo, index: number, files: string[]): Promise<{ defs: RawDef[]; patches: { file: string; root: any }[] }> {
  const key = `${mod.mtime}|${files.length}|${files[0] ?? ''}`
  const c = cache.get(mod.path)
  if (c?.key === key) return { defs: c.defs.map((d) => ({ ...d, mod: index })), patches: c.patches }
  const defs: RawDef[] = []
  const patches: { file: string; root: any }[] = []
  // Files are handled in path order, so which definition wins never depends on which read finishes first.
  const sorted = [...files].sort(byPath)
  let unreadable = 0
  for (let at = 0; at < sorted.length; at += CHUNK) {
    const part = sorted.slice(at, at + CHUNK)
    const texts = await Promise.all(part.map(readXmlText))
    texts.forEach((raw, i) => {
      const file = part[i]
      if (raw == null) return void unreadable++
      if (/[\\/]patches[\\/]/i.test(file)) {
        if (raw.includes('ResearchProjectDef')) {
          const root = parseFile(raw)
          if (root) patches.push({ file, root })
        }
        return
      }
      if (!/ThingDef|ResearchProjectDef|ResearchTabDef|researchPrerequisite/.test(raw)) return
      const root = parseFile(raw)
      const top = root?.Defs
      if (!top || typeof top !== 'object') return
      for (const [type, list] of Object.entries(top)) {
        if (type.startsWith('@') || !Array.isArray(list)) continue
        for (const node of list) {
          if (!node || typeof node !== 'object') continue
          const unlocks = 'researchPrerequisites' in node || 'researchPrerequisite' in node
          if (KEEP_TYPES.has(type) || isResearch(type) || unlocks) defs.push({ type, node, mod: index, file })
        }
      }
    })
    await breather()
  }
  // A mod with files that could not be read is read again next time instead of keeping a partial result.
  if (unreadable) console.warn(`[rimdeck] ${mod.packageId}: ${unreadable} definition file(s) could not be read`)
  else cache.set(mod.path, { key, defs, patches })
  return { defs, patches }
}

type TexLookup = (texPath: string, graphicClass: string) => string | undefined

export async function extractDefData(
  mods: ModInfo[],
  filesPerMod: string[][],
  texture: TexLookup,
): Promise<{ research: ResearchData; items: ItemDef[] }> {
  const t = performance.now()
  const per = await Promise.all(mods.map((m, i) => modDefs(m, i, filesPerMod[i])))
  const activeIds = new Set(mods.map((m) => m.packageId.replace(/_steam$/, '')))
  const activeNames = new Set(mods.map((m) => m.name.toLowerCase()))
  const allowed = (node: any) => {
    const req = node?.['@MayRequire']
    return !req || String(req).split(',').every((p) => activeIds.has(p.trim().toLowerCase()))
  }

  // Later mods replace earlier defs with the same name, exactly like DefDatabase. Within one mod the game
  // keeps the first one (in file order) and skips repeats.
  const named = new Map<string, RawDef>() // `${type}|${Name}` abstract/parent lookup
  const byDefName = new Map<string, RawDef>() // `${type}|${defName}`
  for (const { defs } of per) {
    const seenNames = new Set<string>()
    const seenDefs = new Set<string>()
    for (const d of defs) {
      if (!allowed(d.node)) continue
      const n = d.node['@Name']
      const nk = `${d.type}|${n}`
      if (n && !seenNames.has(nk)) {
        seenNames.add(nk)
        named.set(nk, d)
      }
      const dn = txt(d.node.defName)
      const dk = `${d.type}|${dn}`
      if (dn && d.node['@Abstract'] !== 'True' && !seenDefs.has(dk)) {
        seenDefs.add(dk)
        byDefName.set(dk, d)
      }
    }
  }
  const resolveCache = new Map<RawDef, any>()
  const resolve = (d: RawDef, depth = 0): any => {
    if (resolveCache.has(d)) return resolveCache.get(d)
    const p = d.node['@ParentName']
    const parent = p && depth < 20 ? named.get(`${d.type}|${p}`) : undefined
    const out = parent ? merge(resolve(parent, depth + 1), d.node) : d.node
    resolveCache.set(d, out)
    return out
  }

  // ---- Research ----
  const nodes = new Map<string, ResearchNode>()
  const tabs = new Map<string, string>([['Main', 'Main']])
  for (const [k, d] of byDefName) {
    if (d.type === 'ResearchTabDef') tabs.set(txt(d.node.defName), txt(d.node.label) || txt(d.node.defName))
    if (!isResearch(d.type)) continue
    const r = resolve(d)
    const defName = k.split('|')[1]
    const subtype = d.type === 'ResearchProjectDef' ? '' : d.type.split('.').pop()!.replace(/ResearchProjectDef$/, '')
    const prereq = (v: any) => lis(v).filter(allowed).map(txt).filter(Boolean)
    nodes.set(defName, {
      defName,
      label: txt(r.label) || defName,
      packageId: mods[d.mod].packageId,
      cost: Number(txt(r.baseCost)) || 0,
      techLevel: txt(r.techLevel) || 'Undefined',
      tab: txt(r.tab) || (subtype ? `${subtype} research` : 'Main'),
      x: Number(txt(r.researchViewX)) || 0,
      y: Number(txt(r.researchViewY)) || 0,
      prerequisites: prereq(r.prerequisites),
      hiddenPrerequisites: prereq(r.hiddenPrerequisites),
      description: txt(r.description).slice(0, 400),
      file: d.file,
      patchedBy: [],
    })
  }

  // Apply research patches in load order (the common shapes: coordinates, prerequisites, plain field replaces).
  const patchedBy = (n: ResearchNode, pid: string) => !n.patchedBy.includes(pid) && n.patchedBy.push(pid)
  const targets = (xpath: string) => {
    if (!/ResearchProjectDef|\*\[defName/.test(xpath)) return { list: [] as ResearchNode[], node: '' }
    const { defs, node } = parseXpath(xpath)
    return { list: defs.map((dn) => nodes.get(dn)).filter((n): n is ResearchNode => !!n), node }
  }
  const setField = (n: ResearchNode, field: string, value: any, add: boolean) => {
    const v = txt(value)
    if (field === 'researchViewX') n.x = num(v, n.x)
    else if (field === 'researchViewY') n.y = num(v, n.y)
    else if (field === 'baseCost') n.cost = num(v, n.cost)
    else if (field === 'techLevel') n.techLevel = v || n.techLevel
    else if (field === 'tab') n.tab = v || n.tab
    else if (field === 'label') n.label = v || n.label
    else if (field === 'prerequisites' || field === 'hiddenPrerequisites') {
      const items = lis(value).filter(allowed).map(txt).filter(Boolean)
      const key = field === 'prerequisites' ? 'prerequisites' : 'hiddenPrerequisites'
      n[key] = add ? [...new Set([...n[key], ...items])] : items
    }
  }
  const apply = (op: any, pid: string): void => {
    if (!op || typeof op !== 'object') return
    const cls = String(op['@Class'] ?? '').split('.').pop() ?? ''
    const xpath = txt(op.xpath)
    if (/Sequence/.test(cls)) return lis(op.operations).forEach((o) => apply(o, pid))
    if (/FindMod/.test(cls)) {
      const found = lis(op.mods).map(txt).some((n) => activeNames.has(n.toLowerCase()))
      return apply(found ? op.match : op.nomatch, pid)
    }
    if (/Conditional/.test(cls)) {
      const { defs } = parseXpath(xpath)
      if (!defs.length || !/ResearchProjectDef/.test(xpath)) return
      return apply(defs.some((d) => nodes.has(d)) ? op.match : op.nomatch, pid)
    }
    const { list, node } = targets(xpath)
    if (!list.length) return
    for (const n of list) {
      if (/ReplaceResearchCoords/.test(cls)) {
        if (op.researchViewX != null) n.x = num(txt(op.researchViewX), n.x)
        if (op.researchViewY != null) n.y = num(txt(op.researchViewY), n.y)
        patchedBy(n, pid)
        continue
      }
      const field = node.split('/')[0]
      const value = op.value ?? {}
      if (/Remove/.test(cls)) {
        if (!node) nodes.delete(n.defName)
        else if (/^(hidden)?[pP]rerequisites\/li/.test(node)) {
          const gone = node.match(/["']([^"']+)["']/)?.[1]
          const key = node.startsWith('hidden') ? 'hiddenPrerequisites' : 'prerequisites'
          if (gone) n[key] = n[key].filter((x) => x !== gone)
        } else if (field === 'prerequisites') n.prerequisites = []
        patchedBy(n, pid)
      } else if (/Replace|Add|Insert/.test(cls)) {
        const add = /Add|Insert/.test(cls) && !/OrReplace/.test(cls)
        if (!node) for (const [f, v] of Object.entries(value)) setField(n, f, v, add)
        else if ((field === 'prerequisites' || field === 'hiddenPrerequisites') && node === field && add) setField(n, field, value, true)
        else if (value[field] != null) setField(n, field, value[field], add)
        patchedBy(n, pid)
      }
    }
  }
  per.forEach(({ patches }, i) => {
    for (const { root } of patches) {
      const ops = root?.Patch
      if (!ops || typeof ops !== 'object') continue
      for (const op of [ops.Operation ?? []].flat()) apply(op, mods[i].packageId)
    }
  })

  // What each project unlocks: anything listing it in researchPrerequisites / researchPrerequisite.
  // Resolving every ThingDef's parents is the slow part, so the event loop gets a turn now and then.
  const unlocks: Record<string, UnlockRef[]> = {}
  let count = 0
  for (const [k, d] of byDefName) {
    if (++count % 2000 === 0) await breather()
    const r = d.type === 'ThingDef' ? resolve(d) : d.node
    const reqs = [...lis(r.researchPrerequisites).map(txt), txt(r.researchPrerequisite)].filter(Boolean)
    for (const req of reqs) {
      if (!nodes.has(req)) continue
      ;(unlocks[req] ??= []).push({ type: d.type, defName: k.split('|')[1], label: txt(r.label) || k.split('|')[1], packageId: mods[d.mod].packageId })
    }
  }

  // ---- Items ----
  const items: ItemDef[] = []
  for (const [k, d] of byDefName) {
    if (++count % 2000 === 0) await breather()
    if (d.type !== 'ThingDef') continue
    const r = resolve(d)
    if (txt(r.category) !== 'Item' || r['@Abstract'] === 'True') continue
    const defName = k.split('|')[1]
    if (NOT_REALLY_ITEMS.test(txt(r.thingClass)) || NOT_REALLY_ITEMS.test(defName) || txt(r.destroyOnDrop) === 'true') continue
    const stat = (s: string) => {
      const v = Number(txt(r.statBases?.[s]))
      return Number.isFinite(v) && txt(r.statBases?.[s]) !== '' ? v : undefined
    }
    const texPath = txt(r.graphicData?.texPath)
    items.push({
      defName,
      label: txt(r.label) || defName,
      packageId: mods[d.mod].packageId,
      value: stat('MarketValue'),
      mass: stat('Mass'),
      stack: Number(txt(r.stackLimit)) || 1,
      categories: lis(r.thingCategories).map(txt).filter(Boolean),
      techLevel: txt(r.techLevel) || undefined,
      description: txt(r.description).slice(0, 300),
      icon: texPath ? texture(texPath, txt(r.graphicData?.graphicClass)) : undefined,
      file: d.file,
    })
  }

  for (const n of nodes.values()) if (!tabs.has(n.tab)) tabs.set(n.tab, n.tab)

  return {
    research: { tabs: [...tabs].map(([defName, label]) => ({ defName, label })), nodes: [...nodes.values()], unlocks, ms: Math.round(performance.now() - t) },
    items,
  }
}
