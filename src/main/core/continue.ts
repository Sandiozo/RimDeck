// "Continue": RimWorld has no way to be told which save to open at startup, so RimDeck ships a tiny
// helper mod. Before launching, RimDeck writes the save's name into RimDeck_Continue.txt in the
// config folder; once the game has loaded, the helper opens that save and removes the file.
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { exists } from './store.ts'
import { savesDir } from './saves.ts'

export const CONTINUE_ID = 'rimdeck.continue'
export const CONTINUE_FOLDER = 'RimDeck_Continue'
const REQUEST = 'RimDeck_Continue.txt'
export const CONTINUE_DLL = 'RimDeckContinue.dll'

const ABOUT = (versions: string[]) => `<?xml version="1.0" encoding="utf-8"?>
<ModMetaData>
  <name>RimDeck Continue</name>
  <author>RimDeck</author>
  <packageId>RimDeck.Continue</packageId>
  <supportedVersions>
${versions.map((v) => `    <li>${v}</li>`).join('\n')}
  </supportedVersions>
  <description>Lets RimDeck's Continue button open your latest save straight after the game starts. It does nothing unless you launch with Continue. Managed by RimDeck.</description>
</ModMetaData>
`

/** Installs or updates the helper mod in the local Mods folder; true when it was just created. */
export async function ensureContinueMod(localModsDir: string, versions: string[], bundledDll: string): Promise<boolean> {
  const dir = join(localModsDir, CONTINUE_FOLDER)
  const created = !(await exists(join(dir, 'About', 'About.xml')))
  await mkdir(join(dir, 'About'), { recursive: true })
  await mkdir(join(dir, 'Assemblies'), { recursive: true })
  if (created) await writeFile(join(dir, 'About', 'About.xml'), ABOUT(versions), 'utf8')
  // readFile works inside the asar archive, so the DLL is copied by content.
  const dll = await readFile(bundledDll)
  const target = join(dir, 'Assemblies', CONTINUE_DLL)
  const current = await readFile(target).catch(() => null)
  if (!current || !current.equals(dll)) await writeFile(target, dll)
  return created
}

/** The most recently written save, by file time. */
export async function latestSave(configDir: string): Promise<{ name: string; file: string; mtime: number } | null> {
  const dir = savesDir(configDir)
  let best: { name: string; file: string; mtime: number } | null = null
  try {
    for (const f of await readdir(dir)) {
      if (!f.toLowerCase().endsWith('.rws')) continue
      const file = join(dir, f)
      const st = await stat(file)
      if (!best || st.mtimeMs > best.mtime) best = { name: f.slice(0, -4), file, mtime: st.mtimeMs }
    }
  } catch {
    return null
  }
  return best
}

export async function writeContinueRequest(configDir: string, saveFile: string) {
  await writeFile(join(configDir, REQUEST), basename(saveFile).replace(/\.rws$/i, ''), 'utf8')
}

/** Removes a request the game never picked up, so a later normal launch doesn't open a save. */
export async function clearContinueRequest(configDir: string) {
  await rm(join(configDir, REQUEST), { force: true }).catch(() => {})
}
