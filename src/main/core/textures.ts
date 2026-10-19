import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { ModInfo, TextureConflict, TextureReport } from '../../shared/types.ts'
import { effectiveDirs } from '../../shared/graph.ts'

const EXTS = new Set(['png', 'jpg', 'jpeg', 'psd', 'dds'])
const VIEWABLE = new Set(['png', 'jpg', 'jpeg'])

interface ModTex {
  file: string // preferred file to preview (png/jpg when present)
  dds: boolean
}

// Texture key = path under Textures/, lowercased, no extension: what ContentFinder looks up.
async function indexMod(mod: ModInfo, dirsToLoad: string[]): Promise<Map<string, ModTex>> {
  const out = new Map<string, ModTex>()
  for (const dir of dirsToLoad) {
    const root = join(mod.path, dir)
    let texRoot: string | null = null
    try {
      const entry = (await readdir(root, { withFileTypes: true })).find((e) => e.isDirectory() && e.name.toLowerCase() === 'textures')
      if (entry) texRoot = join(root, entry.name)
    } catch {}
    if (!texRoot) continue
    let files: { name: string; parentPath: string; isFile(): boolean }[] = []
    try {
      files = (await readdir(texRoot, { withFileTypes: true, recursive: true })) as any
    } catch {}
    // Within a mod, later load folders override earlier ones, so later dirs simply overwrite.
    const local = new Map<string, ModTex>()
    for (const f of files) {
      if (!f.isFile()) continue
      const dot = f.name.lastIndexOf('.')
      if (dot < 0) continue
      const ext = f.name.slice(dot + 1).toLowerCase()
      if (!EXTS.has(ext)) continue
      const full = join(f.parentPath, f.name)
      const key = relative(texRoot, full).slice(0, -(ext.length + 1)).replace(/\\/g, '/').toLowerCase()
      const prev = local.get(key)
      if (!prev) local.set(key, { file: full, dds: ext === 'dds' })
      else if (ext === 'dds') prev.dds = true
      else if (VIEWABLE.has(ext) && !VIEWABLE.has(prev.file.slice(prev.file.lastIndexOf('.') + 1).toLowerCase())) prev.file = full
    }
    for (const [k, v] of local) out.set(k, v)
  }
  return out
}

const cache = new Map<string, { mtime: number; dirs: string; tex: Map<string, ModTex> }>()

export async function textureReport(mods: ModInfo[]): Promise<TextureReport> {
  const t = performance.now()
  const active = new Set(mods.map((m) => m.packageId))
  const indexes = await Promise.all(
    mods.map(async (m) => {
      const load = effectiveDirs(m, (p) => active.has(p))
      const dirs = load.join('|')
      const c = cache.get(m.path)
      // The picks mod changes without its About.xml changing, so it's always re-read.
      if (c && c.mtime === m.mtime && c.dirs === dirs && m.packageId !== 'rimdeck.texturepicks') return c.tex
      const tex = await indexMod(m, load)
      cache.set(m.path, { mtime: m.mtime, dirs, tex })
      return tex
    }),
  )
  const owners = new Map<string, number[]>()
  const totals: Record<string, number> = {}
  let textures = 0
  indexes.forEach((tex, i) => {
    totals[mods[i].packageId] = tex.size
    textures += tex.size
    for (const key of tex.keys()) {
      const list = owners.get(key)
      if (list) list.push(i)
      else owners.set(key, [i])
    }
  })
  const conflicts: TextureConflict[] = []
  for (const [key, idx] of owners) {
    if (idx.length < 2) continue
    conflicts.push({
      key,
      entries: idx.map((i) => {
        const t = indexes[i].get(key)!
        return { packageId: mods[i].packageId, file: t.file, dds: t.dds }
      }),
    })
  }
  conflicts.sort((a, b) => a.key.localeCompare(b.key))
  return { conflicts, totals, textures, scannedMods: mods.length, ms: Math.round(performance.now() - t) }
}

/** key -> file for every texture the given mods ship (later mods win), plus a folder index for multi-texture graphics. */
export async function textureLookup(mods: ModInfo[]) {
  const active = new Set(mods.map((m) => m.packageId))
  const files = new Map<string, string>()
  const folders = new Map<string, string>()
  for (const m of mods) {
    const load = effectiveDirs(m, (p) => active.has(p))
    const dirs = load.join('|')
    let c = cache.get(m.path)
    if (!c || c.mtime !== m.mtime || c.dirs !== dirs) {
      c = { mtime: m.mtime, dirs, tex: await indexMod(m, load) }
      cache.set(m.path, c)
    }
    for (const [k, t] of c.tex) {
      files.set(k, t.file)
      const f = k.slice(0, k.lastIndexOf('/'))
      if (!folders.has(f)) folders.set(f, t.file)
    }
  }
  // Graphic_Multi adds _south/_north…; Graphic_StackCount/Random point at a folder.
  return (texPath: string, graphicClass: string): string | undefined => {
    const k = texPath.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
    if (/Multi/.test(graphicClass)) return files.get(k + '_south') ?? files.get(k + '_north') ?? files.get(k)
    return files.get(k) ?? folders.get(k) ?? files.get(k + '_south')
  }
}
