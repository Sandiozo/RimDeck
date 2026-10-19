import { copyFile, mkdir, readdir, readFile, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModsConfig } from '../../shared/types.ts'
import { atomicWrite } from './store.ts'
import { escapeXml, parseXml, strList, text } from './xml.ts'

export function modsConfigPath(configDir: string) {
  return join(configDir, 'ModsConfig.xml')
}

export async function readModsConfig(configDir: string): Promise<ModsConfig | null> {
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

/** Copies the current ModsConfig.xml into the backup folder; null when there is none. */
export async function backupModsConfig(configDir: string, backupDir: string): Promise<string | null> {
  const file = modsConfigPath(configDir)
  try {
    await stat(file)
    await mkdir(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const backup = join(backupDir, `ModsConfig-${stamp}.xml`)
    await copyFile(file, backup)
    await pruneBackups(backupDir, 30)
    return backup
  } catch {
    return null
  }
}

async function pruneBackups(dir: string, keep: number) {
  const files = (await readdir(dir)).filter((f) => f.startsWith('ModsConfig-')).sort()
  for (const f of files.slice(0, Math.max(0, files.length - keep))) await unlink(join(dir, f)).catch(() => {})
}

export async function listBackups(dir: string): Promise<{ file: string; mtime: number; count: number }[]> {
  try {
    const files = (await readdir(dir)).filter((f) => f.startsWith('ModsConfig-')).sort().reverse()
    return Promise.all(
      files.map(async (f) => {
        const p = join(dir, f)
        const [raw, st] = await Promise.all([readFile(p, 'utf8'), stat(p)])
        // Only the active mods count, not the <knownExpansions> list.
        const active = raw.match(/<activeMods>([\s\S]*?)<\/activeMods>/i)?.[1] ?? ''
        return { file: p, mtime: st.mtimeMs, count: (active.match(/<li>/g) ?? []).length }
      }),
    )
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
