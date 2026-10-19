import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { exists } from './store.ts'

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

export function picksDir(localModsDir: string) {
  return join(localModsDir, PICKS_FOLDER)
}

async function readPicks(dir: string): Promise<Record<string, TexturePick>> {
  try {
    return JSON.parse(await readFile(join(dir, 'picks.json'), 'utf8'))
  } catch {
    return {}
  }
}


export async function listPicks(localModsDir: string) {
  return readPicks(picksDir(localModsDir))
}

export async function ensurePicksMod(localModsDir: string, versions: string[]): Promise<boolean> {
  const dir = picksDir(localModsDir)
  const about = join(dir, 'About', 'About.xml')
  if (await exists(about)) return false
  await mkdir(join(dir, 'About'), { recursive: true })
  await writeFile(about, ABOUT(versions), 'utf8')
  await writeFile(join(dir, 'picks.json'), '{}', 'utf8')
  return true
}

/** Texture path under Textures/ (keeps original casing), e.g. "Things/Building/Bath_east". */
function relUnderTextures(file: string): string | null {
  const norm = file.replace(/\\/g, '/')
  const i = norm.toLowerCase().lastIndexOf('/textures/')
  return i < 0 ? null : norm.slice(i + '/textures/'.length)
}

export async function pickTexture(localModsDir: string, key: string, packageId: string, source: string, hasDds: boolean): Promise<TexturePick> {
  const dir = picksDir(localModsDir)
  const picks = await readPicks(dir)
  if (picks[key]) await removeFiles(dir, picks[key].files)
  const rel = relUnderTextures(source)
  if (!rel) throw new Error('Not a texture file')
  const sources = [source]
  // Copy the .dds sibling too, so the game can't fall back to the other mod's DDS version.
  const dds = source.replace(/\.[^.]+$/, '.dds')
  if (hasDds && dds !== source && (await exists(dds))) sources.push(dds)
  const files: string[] = []
  for (const src of sources) {
    const target = join('Textures', relUnderTextures(src)!)
    await mkdir(dirname(join(dir, target)), { recursive: true })
    await copyFile(src, join(dir, target))
    files.push(target)
  }
  const pick: TexturePick = { packageId, source, files, at: Date.now() }
  picks[key] = pick
  await writeFile(join(dir, 'picks.json'), JSON.stringify(picks, null, 2), 'utf8')
  return pick
}

async function removeFiles(dir: string, files: string[]) {
  for (const f of files) {
    if (f.includes('..')) continue
    await rm(join(dir, f), { force: true })
  }
}

export async function unpickTexture(localModsDir: string, key: string): Promise<void> {
  const dir = picksDir(localModsDir)
  const picks = await readPicks(dir)
  if (!picks[key]) return
  await removeFiles(dir, picks[key].files)
  delete picks[key]
  await writeFile(join(dir, 'picks.json'), JSON.stringify(picks, null, 2), 'utf8')
}
