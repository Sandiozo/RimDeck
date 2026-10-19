import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LoadReport, ModCost, ModInfo } from '../../shared/types.ts'

interface MediaStats {
  textures: number
  textureBytes: number
  dds: number
  sounds: number
  soundBytes: number
  dllBytes: number
}

async function walkStats(dir: string): Promise<{ name: string; size: number }[]> {
  try {
    const entries = (await readdir(dir, { withFileTypes: true, recursive: true })) as any[]
    const files = entries.filter((e) => e.isFile())
    const sizes = await Promise.all(files.map((e) => stat(join(e.parentPath, e.name)).then((s) => s.size, () => 0)))
    return files.map((e, i) => ({ name: e.name.toLowerCase(), size: sizes[i] }))
  } catch {
    return []
  }
}

async function sub(root: string, name: string): Promise<string | null> {
  try {
    const e = (await readdir(root, { withFileTypes: true })).find((x) => x.isDirectory() && x.name.toLowerCase() === name)
    return e ? join(root, e.name) : null
  } catch {
    return null
  }
}

const mediaCache = new Map<string, { key: string; stats: MediaStats }>()

export async function mediaStats(mod: ModInfo, dirs: string[]): Promise<MediaStats> {
  const key = `${mod.mtime}|${dirs.join('|')}`
  const c = mediaCache.get(mod.path)
  if (c?.key === key) return c.stats
  const s: MediaStats = { textures: 0, textureBytes: 0, dds: 0, sounds: 0, soundBytes: 0, dllBytes: 0 }
  for (const d of dirs) {
    const root = join(mod.path, d)
    const [tex, snd] = await Promise.all([sub(root, 'textures'), sub(root, 'sounds')])
    if (tex)
      for (const f of await walkStats(tex)) {
        if (!/\.(png|jpe?g|dds|psd)$/.test(f.name)) continue
        s.textures++
        s.textureBytes += f.size
        if (f.name.endsWith('.dds')) s.dds++
      }
    if (snd)
      for (const f of await walkStats(snd)) {
        if (!/\.(wav|ogg|mp3)$/.test(f.name)) continue
        s.sounds++
        s.soundBytes += f.size
      }
  }
  for (const dll of mod.assemblies) s.dllBytes += await stat(dll).then((x) => x.size, () => 0)
  mediaCache.set(mod.path, { key, stats: s })
  return s
}

// Rough relative costs (ms). Only the proportions matter: they're scaled to the measured startup time when known.
const W = { texture: 1.2, textureMB: 22, soundMB: 6, def: 0.12, patch: 0.25, slowPatch: 12, dllMB: 25, harmony: 0.6 }

export function score(c: Omit<ModCost, 'score' | 'packageId'>): number {
  return (
    c.textures * W.texture +
    (c.textureBytes / 1048576) * W.textureMB +
    (c.soundBytes / 1048576) * W.soundMB +
    c.defs * W.def +
    c.patches * W.patch +
    c.slowPatches * W.slowPatch +
    (c.dllBytes / 1048576) * W.dllMB +
    c.harmonyPatches * W.harmony
  )
}

// Descendant searches ("//ThingDef") walk the whole merged XML document for every operation.
export function isSlowXpath(xpath: string) {
  return xpath.includes('//')
}

const TS_RE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d+)\s+[A-Z]+\s+\[/

/** Startup phases from a 1.7 Player.log: when each marker first shows up in a logged stack trace. */
export async function startupFromLog(file: string): Promise<LoadReport['startup']> {
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  const head = raw.slice(0, 800)
  const started = head.match(/^Started:\s+(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?)\s*([+-]\d\d:\d\d)?/m)
  if (!started) return undefined
  const tz = started[2] ?? ''
  const t0 = Date.parse(started[1].replace(' ', 'T') + tz)
  const markers: Record<string, string> = {
    load: 'PlayDataLoader.DoPlayLoad',
    statics: 'StaticConstructorOnStartup',
    menu: 'MainMenuDrawer',
    saveStart: 'Game.LoadGame',
    play: 'Game.UpdatePlay',
  }
  const seen: Record<string, number> = {}
  let current = t0
  let pos = 0
  while (pos < raw.length && Object.keys(seen).length < 5) {
    const end = raw.indexOf('\n', pos)
    const line = raw.slice(pos, end < 0 ? raw.length : end)
    pos = end < 0 ? raw.length : end + 1
    const m = line.match(TS_RE)
    if (m) current = Date.parse(m[1].replace(' ', 'T') + tz)
    for (const [k, needle] of Object.entries(markers)) if (!(k in seen) && line.includes(needle)) seen[k] = current
  }
  if (!seen.menu) return undefined
  const at = (k: string, fallback: number) => seen[k] ?? fallback
  const load = at('load', t0)
  const statics = at('statics', load)
  const phases = [
    { label: 'Game engine starting', ms: load - t0 },
    { label: 'Loading mods, XML and textures', ms: statics - load },
    { label: 'Mod startup code', ms: seen.menu - statics },
  ].filter((p) => p.ms >= 0)
  return {
    when: t0,
    toMenu: seen.menu - t0,
    phases,
    saveLoad: seen.saveStart && seen.play && seen.play > seen.saveStart ? seen.play - seen.saveStart : undefined,
  }
}
