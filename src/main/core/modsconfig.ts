import { constants } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModsConfig } from '../../shared/types.ts'
import { atomicWrite, withRetry } from './store.ts'
import { escapeXml, parseXml, strList, text } from './xml.ts'

export function modsConfigPath(configDir: string) {
  return join(configDir, 'ModsConfig.xml')
}

export async function readModsConfig(configDir: string): Promise<ModsConfig | null> {
  // An empty folder setting would otherwise read ModsConfig.xml from the working folder.
  if (!configDir) return null
  const file = modsConfigPath(configDir)
  try {
    const [raw, st] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    const doc = parseXml(raw).modsconfigdata ?? {}
    return {
      version: text(doc.version),
      activeMods: strList(doc.activemods).map((s) => s.toLowerCase()),
      knownExpansions: strList(doc.knownexpansions).map((s) => s.toLowerCase()),
      mtime: st.mtimeMs,
    }
  } catch {
    return null
  }
}

export function serializeModsConfig(version: string, activeMods: string[], knownExpansions: string[]): string {
  const li = (ids: string[]) => ids.map((id) => `    <li>${escapeXml(id)}</li>`).join('\n')
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<ModsConfigData>',
    `  <version>${escapeXml(version)}</version>`,
    '  <activeMods>',
    li(activeMods),
    '  </activeMods>',
    '  <knownExpansions>',
    li(knownExpansions),
    '  </knownExpansions>',
    '</ModsConfigData>',
    '',
  ].join('\n')
}

// Backs up the current file, then writes atomically (temp + rename) so a crash never leaves a half-written config.
// When the current file can't be backed up it is left alone and the save fails.
export async function writeModsConfig(
  configDir: string,
  backupDir: string,
  data: { version: string; activeMods: string[]; knownExpansions: string[] },
): Promise<{ backup: string | null; mtime: number }> {
  const file = modsConfigPath(configDir)
  const backup = await backupModsConfig(configDir, backupDir)
  await atomicWrite(file, serializeModsConfig(data.version, data.activeMods, data.knownExpansions))
  const st = await stat(file)
  return { backup, mtime: st.mtimeMs }
}

const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code ?? (e as Error).message

// Backups are named ModsConfig-2026-11-14T10-30-15-123.xml (UTC, to the millisecond); older ones have no
// milliseconds. -2, -3… is added when a name is taken, so a backup never replaces another.
const STAMP = /^ModsConfig-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)(?:-(\d{3}))?(?:-\d+)?\.xml$/i

/** When a backup was taken, read from its name; null for names RimDeck didn't make. */
function stampTime(name: string): number | null {
  const m = name.match(STAMP)
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] ?? 0)) : null
}

async function newBackup(dir: string, write: (file: string) => Promise<unknown>): Promise<string> {
  await mkdir(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)
  for (let n = 1; ; n++) {
    const file = join(dir, `ModsConfig-${stamp}${n > 1 ? `-${n}` : ''}.xml`)
    try {
      await write(file)
      return file
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 50) throw e
    }
  }
}

/** Copies the current ModsConfig.xml into the backup folder; null when there is none yet. Throws when it can't be copied. */
export async function backupModsConfig(configDir: string, backupDir: string): Promise<string | null> {
  const file = modsConfigPath(configDir)
  let backup: string
  try {
    await stat(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Could not back up ModsConfig.xml, so it was not changed (${errCode(e)}).`, { cause: e })
  }
  try {
    backup = await newBackup(backupDir, (dest) => withRetry(() => copyFile(file, dest, constants.COPYFILE_EXCL)))
  } catch (e) {
    throw new Error(`Could not back up ModsConfig.xml, so it was not changed (${errCode(e)}).`, { cause: e })
  }
  await pruneBackups(backupDir, 30).catch(() => {})
  return backup
}

/** Keeps a mod list as one more entry among the ModsConfig.xml backups, so it can be restored from there. */
export async function backupModList(backupDir: string, data: { version: string; activeMods: string[]; knownExpansions: string[] }): Promise<string> {
  const xml = serializeModsConfig(data.version, data.activeMods, data.knownExpansions)
  const backup = await newBackup(backupDir, (dest) => writeFile(dest, xml, { encoding: 'utf8', flag: 'wx' }))
  await pruneBackups(backupDir, 30).catch(() => {})
  return backup
}

// Only files RimDeck named are pruned, oldest first by the time in their name.
async function pruneBackups(dir: string, keep: number) {
  const files = (await readdir(dir))
    .map((f) => ({ f, t: stampTime(f) }))
    .filter((x): x is { f: string; t: number } => x.t !== null)
    .sort((a, b) => a.t - b.t || (a.f < b.f ? -1 : a.f > b.f ? 1 : 0))
  for (const { f } of files.slice(0, Math.max(0, files.length - keep))) await unlink(join(dir, f)).catch(() => {})
}

// `mtime` is when the backup was taken. A copy keeps the original file's modified time, so that comes
// from the name; other files fall back to their own dates.
export async function listBackups(dir: string): Promise<{ file: string; mtime: number; count: number }[]> {
  try {
    const files = (await readdir(dir)).filter((f) => f.startsWith('ModsConfig-') && f.toLowerCase().endsWith('.xml'))
    const list = await Promise.all(
      files.map(async (f) => {
        const p = join(dir, f)
        const [raw, st] = await Promise.all([readFile(p, 'utf8'), stat(p)])
        // Only the active mods count, not the <knownExpansions> list.
        const active = raw.match(/<activeMods>([\s\S]*?)<\/activeMods>/i)?.[1] ?? ''
        return { file: p, mtime: stampTime(f) ?? (st.birthtimeMs || st.mtimeMs), count: (active.match(/<li>/g) ?? []).length }
      }),
    )
    return list.sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export async function readModListFile(file: string): Promise<string[]> {
  const raw = await readFile(file, 'utf8')
  const doc = parseXml(raw)
  const root = doc.modsconfigdata ?? doc.savedmodlist ?? doc.modlist ?? Object.values(doc).find((v) => typeof v === 'object')
  const ids = strList(root?.activemods ?? root?.modlist?.ids ?? root?.ids ?? root?.mods)
  return ids.map((s) => s.toLowerCase())
}
