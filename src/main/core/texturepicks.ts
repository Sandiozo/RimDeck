import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { atomicWrite, exists, readJson } from './store.ts'

// A tiny local mod that loads last; copying a texture into it makes that version win, one texture at a time.
export const PICKS_ID = 'rimdeck.texturepicks'
export const PICKS_FOLDER = 'RimDeck_TexturePicks'

export interface TexturePick {
  packageId: string // mod the texture was taken from
  source: string
  files: string[] // paths relative to the picks mod
  at: number
}

const ABOUT = (versions: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<ModMetaData>
  <name>RimDeck Texture Picks</name>
  <author>RimDeck</author>
  <packageId>RimDeck.TexturePicks</packageId>
  <supportedVersions>
${versions.map((v) => `    <li>${v}</li>`).join('\n')}
  </supportedVersions>
  <description>Textures you picked in RimDeck's texture viewer. Keep this mod at the bottom of your load order so your picks win. Managed by RimDeck — remove picks there rather than editing these files.</description>
</ModMetaData>
`

const TEXTURE_EXTS = new Set(['png', 'jpg', 'jpeg', 'psd', 'dds'])

export function picksDir(localModsDir: string) {
  return join(localModsDir, PICKS_FOLDER)
}

const picksFile = (dir: string) => join(dir, 'picks.json')

// Changes to the picks mod run one at a time, so two quick picks can't both read picks.json and lose one.
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => {})
  return run
}

async function readPicks(dir: string): Promise<Record<string, TexturePick>> {
  return readJson<Record<string, TexturePick>>(picksFile(dir), {})
}

async function writePicks(dir: string, picks: Record<string, TexturePick>) {
  await atomicWrite(picksFile(dir), JSON.stringify(picks, null, 2))
}

export async function listPicks(localModsDir: string) {
  return readPicks(picksDir(localModsDir))
}

export function ensurePicksMod(localModsDir: string, versions: string[]): Promise<boolean> {
  return serial(async () => {
    const dir = picksDir(localModsDir)
    const about = join(dir, 'About', 'About.xml')
    if (await exists(about)) return false
    await atomicWrite(about, ABOUT(versions))
    // Earlier picks are kept if only About.xml went missing.
    if (!(await exists(picksFile(dir)))) await writePicks(dir, {})
    return true
  })
}

/**
 * Path of a texture file under its mod's Textures folder, in its original casing, e.g. "Things/Building/Bath_east.png".
 * `key` is that same path lowercased without extension (see textures.ts), so it says how many trailing segments
 * belong to the texture; searching the path for "/textures/" breaks on folders like ".../textures/MyMod/Textures/".
 */
function relUnderTextures(file: string, key: string): string | null {
  const want = key.split('/')
  if (want.some((s) => !s || s === '.' || s === '..')) return null
  const parts = file.split(/[\\/]/)
  if (parts.length <= want.length) return null
  const rel = parts.slice(-want.length)
  const name = rel[rel.length - 1]
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || !TEXTURE_EXTS.has(name.slice(dot + 1).toLowerCase())) return null
  if ([...rel.slice(0, -1), name.slice(0, dot)].join('/').toLowerCase() !== key) return null
  if (parts[parts.length - want.length - 1].toLowerCase() !== 'textures') return null
  return rel.join('/')
}

// The .dds next to a texture, whatever the case of its name (Linux file names are case-sensitive).
async function ddsSibling(file: string): Promise<string | null> {
  const want = basename(file).replace(/\.[^.]+$/, '').toLowerCase() + '.dds'
  const hit = (await readdir(dirname(file)).catch(() => [] as string[])).find((n) => n.toLowerCase() === want)
  return hit ? join(dirname(file), hit) : null
}

export function pickTexture(localModsDir: string, key: string, packageId: string, source: string, hasDds: boolean): Promise<TexturePick> {
  return serial(async () => {
    const dir = picksDir(localModsDir)
    if (!relUnderTextures(source, key)) throw new Error('Not a texture file')
    const picks = await readPicks(dir)
    if (picks[key]) {
      await removeFiles(dir, picks[key].files)
      delete picks[key]
    }
    const sources = [source]
    // Copy the .dds sibling too, so the game can't fall back to the other mod's DDS version.
    const dds = hasDds && !/\.dds$/i.test(source) ? await ddsSibling(source) : null
    if (dds) sources.push(dds)
    const files: string[] = []
    try {
      for (const src of sources) {
        const target = join('Textures', relUnderTextures(src, key)!)
        await mkdir(dirname(join(dir, target)), { recursive: true })
        await copyFile(src, join(dir, target))
        files.push(target)
      }
    } catch (e) {
      // The old pick is gone already; record that instead of leaving an entry for files that aren't there.
      await removeFiles(dir, files).catch(() => {})
      await writePicks(dir, picks).catch(() => {})
      throw e
    }
    const pick: TexturePick = { packageId, source, files, at: Date.now() }
    picks[key] = pick
    await writePicks(dir, picks)
    return pick
  })
}

async function removeFiles(dir: string, files: string[]) {
  for (const f of files) {
    if (f.includes('..')) continue
    await rm(join(dir, f), { force: true })
  }
}

export function unpickTexture(localModsDir: string, key: string): Promise<void> {
  return serial(async () => {
    const dir = picksDir(localModsDir)
    const picks = await readPicks(dir)
    if (!picks[key]) return
    await removeFiles(dir, picks[key].files)
    delete picks[key]
    await writePicks(dir, picks)
  })
}
