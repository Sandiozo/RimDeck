import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DirCondition, ModCategory, ModDep, ModInfo, ModSource, Paths } from '../../shared/types.ts'
import { list, parseXml, strList, text } from './xml.ts'

const DLC_NAMES: Record<string, string> = {
  core: 'Core',
  royalty: 'Royalty',
  ideology: 'Ideology',
  biotech: 'Biotech',
  anomaly: 'Anomaly',
  odyssey: 'Odyssey',
}

const LOADERS = new Set([
  'brrainz.harmony',
  'zetrith.prepatcher',
  'me.samboycoding.betterloading',
  'taranchuk.performanceoptimizer',
  'ludeon.rimworld',
])

type Dirent = { name: string; isDirectory(): boolean; isFile(): boolean }

async function ls(dir: string): Promise<Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function findCI(entries: Dirent[], name: string): Dirent | undefined {
  const lower = name.toLowerCase()
  return entries.find((e) => e.name.toLowerCase() === lower)
}

// Pick the `XByVersion` variant for the running version when present, as RimWorld does.
function byVersion(about: any, key: string, major: string): any {
  const bv = about[key.toLowerCase() + 'byversion']
  if (bv && typeof bv === 'object') {
    const v = bv['v' + major]
    if (v !== undefined) return v
  }
  return about[key.toLowerCase()]
}

function workshopIdFrom(url: string | undefined): string | undefined {
  if (!url) return undefined
  const m = url.match(/(?:CommunityFilePage\/|[?&]id=)(\d{6,})/i)
  return m?.[1]
}

function parseDeps(v: any): ModDep[] {
  const out: ModDep[] = []
  for (const li of list(v)) {
    if (typeof li !== 'object' || !li) continue
    const pid = text(li.packageid).trim().toLowerCase()
    if (!pid) continue
    const url = text(li.steamworkshopurl) || text(li.downloadurl) || undefined
    const alternatives = strList(li.alternativepackageids).map((s) => s.toLowerCase())
    out.push({
      packageId: pid,
      alternatives: alternatives.length ? alternatives : undefined,
      name: text(li.displayname) || undefined,
      workshopId: workshopIdFrom(text(li.steamworkshopurl)),
      url,
    })
  }
  return out
}

// Folders RimWorld will load for this version: loadFolders.xml if present, else root + Common + best version folder.
function resolveContentDirs(rootEntries: Dirent[], loadFolders: any, major: string, conditions: Record<string, DirCondition[] | null>): string[] {
  if (loadFolders) {
    const lf = loadFolders.loadfolders ?? {}
    const older = Object.keys(lf)
      .filter((k) => /^v\d+\.\d+$/.test(k) && cmpVersion(k.slice(1), major) <= 0)
      .sort((a, b) => cmpVersion(a.slice(1), b.slice(1)))
    const entry = lf['v' + major] ?? lf.default ?? (older.length ? lf[older[older.length - 1]] : undefined)
    if (entry !== undefined) {
      const dirs: string[] = []
      for (const li of list(entry)) {
        const raw = text(li).trim()
        if (!raw && typeof li !== 'string') continue
        const d = raw.replace(/^[\\/]+|[\\/]+$/g, '') || '.'
        const ids = (k: string) =>
          typeof li === 'object' && li?.['@' + k]
            ? String(li['@' + k]).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
            : undefined
        const cond: DirCondition = { any: ids('IfModActive') ?? ids('IfModActiveAny'), all: ids('IfModActiveAll'), none: ids('IfModNotActive') }
        if (!dirs.includes(d)) dirs.push(d)
        // A folder listed unconditionally anywhere always loads; otherwise any one of its conditions can load it.
        if (!cond.any && !cond.all && !cond.none) conditions[d] = null
        else if (conditions[d] !== null) conditions[d] = [...(conditions[d] ?? []), cond]
      }
      if (dirs.length) return dirs
    }
  }
  const dirs = ['.']
  if (findCI(rootEntries, 'Common')?.isDirectory()) dirs.push('Common')
  const versions = rootEntries
    .filter((e) => e.isDirectory() && /^\d+\.\d+$/.test(e.name))
    .map((e) => e.name)
    .filter((v) => cmpVersion(v, major) <= 0)
    .sort(cmpVersion)
  if (versions.length) dirs.push(versions[versions.length - 1])
  return dirs
}

export function cmpVersion(a: string, b: string): number {
  const [a1, a2] = a.split('.').map(Number)
  const [b1, b2] = b.split('.').map(Number)
  return a1 - b1 || a2 - b2
}

export async function scanMod(path: string, folder: string, source: ModSource, major: string): Promise<ModInfo | null> {
  const rootEntries = await ls(path)
  const aboutDir = findCI(rootEntries, 'About')
  if (!aboutDir) return null
  const aboutPath = join(path, aboutDir.name)
  const aboutEntries = await ls(aboutPath)
  const aboutFile = findCI(aboutEntries, 'About.xml')
  if (!aboutFile) return null

  let about: any = {}
  let aboutError: string | undefined
  let mtime = 0
  let added = 0
  try {
    const file = join(aboutPath, aboutFile.name)
    const [raw, st, folderSt] = await Promise.all([readFile(file, 'utf8'), stat(file), stat(path)])
    mtime = st.mtimeMs
    added = folderSt.birthtimeMs || folderSt.ctimeMs
    about = parseXml(raw).modmetadata ?? {}
  } catch (e: any) {
    aboutError = String(e?.message ?? e).split('\n')[0]
  }

  const lfEntry = findCI(rootEntries, 'loadFolders.xml')
  let loadFolders: any = null
  if (lfEntry) {
    try {
      loadFolders = parseXml(await readFile(join(path, lfEntry.name), 'utf8'))
    } catch {}
  }

  const packageIdRaw = text(about.packageid).trim() || `unknown.${folder}`
  const packageId = packageIdRaw.toLowerCase()
  let name = text(about.name).trim()
  if (!name && (source === 'core' || source === 'dlc')) name = DLC_NAMES[folder.toLowerCase()] ?? folder
  if (!name) name = folder

  const authors = [
    ...strList(about.authors),
    ...text(about.author)
      .split(/,|&| and /)
      .map((s) => s.trim())
      .filter(Boolean),
  ]

  const conditions: Record<string, DirCondition[] | null> = {}
  const contentDirs = resolveContentDirs(rootEntries, loadFolders, major, conditions)
  const dirConditions = Object.fromEntries(Object.entries(conditions).filter(([, c]) => c)) as Record<string, DirCondition[]>
  const contentListings = await Promise.all(contentDirs.map((d) => (d === '.' ? rootEntries : ls(join(path, d)))))
  let hasAssemblies = false
  let hasDefs = false
  let hasPatches = false
  let hasTextures = false
  const asmDirs: string[] = []
  contentListings.forEach((entries, i) => {
    for (const e of entries) {
      if (!e.isDirectory()) continue
      const n = e.name.toLowerCase()
      if (n === 'assemblies') asmDirs.push(join(path, contentDirs[i], e.name))
      else if (n === 'defs') hasDefs = true
      else if (n === 'patches') hasPatches = true
      else if (n === 'textures') hasTextures = true
    }
  })
  const assemblies: string[] = []
  for (const dir of asmDirs) {
    for (const e of await ls(dir)) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.dll')) assemblies.push(join(dir, e.name))
    }
  }
  hasAssemblies = assemblies.length > 0

  let workshopId: string | undefined
  if (source === 'workshop' && /^\d+$/.test(folder)) workshopId = folder
  const pfid = findCI(aboutEntries, 'PublishedFileId.txt')
  if (!workshopId && pfid) {
    try {
      const id = (await readFile(join(aboutPath, pfid.name), 'utf8')).trim()
      if (/^\d+$/.test(id)) workshopId = id
    } catch {}
  }

  const preview = findCI(aboutEntries, 'Preview.png') ?? findCI(aboutEntries, 'Preview.jpg')
  let iconPath: string | undefined
  const iconFile = findCI(aboutEntries, 'ModIcon.png')
  if (iconFile) iconPath = join(aboutPath, iconFile.name)
  else if (text(about.modiconpath)) {
    const rel = text(about.modiconpath).replace(/\\/g, '/') + '.png'
    for (const d of contentDirs) {
      const p = join(path, d, 'Textures', rel)
      try {
        await stat(p)
        iconPath = p
        break
      } catch {}
    }
  }

  const descriptions = about.descriptionsbyversion?.['v' + major]
  const description = text(descriptions ?? about.description)

  const mod: ModInfo = {
    uid: `${source}:${folder}`,
    packageId,
    packageIdRaw,
    name,
    authors: [...new Set(authors)],
    description,
    url: text(about.url) || undefined,
    modVersion: text(about.modversion) || undefined,
    supportedVersions: strList(about.supportedversions),
    source,
    path,
    folder,
    workshopId,
    previewPath: preview ? join(aboutPath, preview.name) : undefined,
    iconPath,
    dependencies: parseDeps(byVersion(about, 'modDependencies', major)),
    loadAfter: strList(byVersion(about, 'loadAfter', major)).map((s) => s.toLowerCase()),
    loadBefore: strList(byVersion(about, 'loadBefore', major)).map((s) => s.toLowerCase()),
    forceLoadAfter: strList(about.forceloadafter).map((s) => s.toLowerCase()),
    forceLoadBefore: strList(about.forceloadbefore).map((s) => s.toLowerCase()),
    incompatibleWith: strList(byVersion(about, 'incompatibleWith', major)).map((s) => s.toLowerCase()),
    contentDirs,
    dirConditions: Object.keys(dirConditions).length ? dirConditions : undefined,
    hasAssemblies,
    hasDefs,
    hasPatches,
    hasTextures,
    assemblies,
    category: 'content',
    mtime,
    added,
    aboutError,
  }
  return mod
}

async function scanRoot(dir: string, source: ModSource, major: string): Promise<ModInfo[]> {
  if (!dir) return []
  const entries = (await ls(dir)).filter((e) => e.isDirectory())
  const mods = await Promise.all(entries.map((e) => scanMod(join(dir, e.name), e.name, source, major).catch(() => null)))
  return mods.filter((m): m is ModInfo => !!m)
}

export async function scanAll(paths: Paths, major: string): Promise<ModInfo[]> {
  const dataDir = paths.gameDir ? join(paths.gameDir, 'Data') : ''
  const [data, local, workshop] = await Promise.all([
    scanRoot(dataDir, 'dlc', major),
    scanRoot(paths.localModsDir, 'local', major),
    scanRoot(paths.workshopDir, 'workshop', major),
  ])
  for (const m of data) if (m.packageId === 'ludeon.rimworld') m.source = 'core'
  const mods = [...data, ...local, ...workshop]
  applySteamSuffix(mods)
  inferCategories(mods)
  return mods
}

// RimWorld appends `_steam` to a Workshop mod whose packageId collides with a non-Workshop mod.
function applySteamSuffix(mods: ModInfo[]) {
  const nonWorkshop = new Set(mods.filter((m) => m.source !== 'workshop').map((m) => m.packageId))
  for (const m of mods) if (m.source === 'workshop' && nonWorkshop.has(m.packageId)) m.packageId += '_steam'
}

const PERF_RE = /performance|optimi[sz]|rocketman|\bfps\b|tick ?rate|faster|fishery|speedup|lag/i
const PATCH_RE = /\bpatch(es)?\b|compat|\bfix(es)?\b|tweaks? for|integration|addon for/i
const LIB_RE = /framework|\blib(rary)?\b|\bapi\b|\bcore\b|hugslib|xml ?extensions|modsettings/i

function inferCategories(mods: ModInfo[]) {
  const dependents = new Map<string, number>()
  for (const m of mods)
    for (const d of m.dependencies) dependents.set(d.packageId, (dependents.get(d.packageId) ?? 0) + 1)

  for (const m of mods) m.category = inferCategory(m, dependents.get(m.packageId) ?? 0)
}

function inferCategory(m: ModInfo, dependents: number): ModCategory {
  if (m.source === 'core' || m.source === 'dlc') return 'game'
  if (LOADERS.has(m.packageId)) return 'loader'
  const label = `${m.name} ${m.packageId}`
  if (dependents >= 2 || (LIB_RE.test(m.name) && m.hasAssemblies && dependents >= 1)) return 'library'
  if (PERF_RE.test(label) && m.hasAssemblies && !m.hasDefs) return 'performance'
  if (!m.hasDefs && !m.hasAssemblies && !m.hasPatches && m.hasTextures) return 'textures'
  if (PATCH_RE.test(m.name) || (!m.hasDefs && m.hasPatches && m.dependencies.length > 1)) return 'patch'
  if (!m.hasDefs && m.hasAssemblies) return 'utility'
  if (LIB_RE.test(m.name) && dependents >= 1) return 'library'
  return 'content'
}
