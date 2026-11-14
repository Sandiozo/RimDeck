import { constants } from 'node:fs'
import { copyFile, mkdir, open, readdir, rm, stat, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { SaveSummary } from '../../shared/types.ts'
import { parseXml, strList, text } from './xml.ts'

export function savesDir(configDir: string) {
  return join(dirname(configDir), 'Saves')
}

// Only the <meta> header is read; saves are often 50+ MB.
async function readHead(file: string, bytes = 256 * 1024): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

export async function readSaveMeta(file: string): Promise<SaveSummary | null> {
  try {
    const [head, st] = await Promise.all([readHead(file), stat(file)])
    const start = head.indexOf('<meta>')
    const end = head.indexOf('</meta>')
    if (start < 0 || end < 0) return null
    const meta = parseXml(head.slice(start, end + 7)).meta ?? {}
    return {
      path: file,
      name: basename(file).replace(/\.rws$/i, ''),
      mtime: st.mtimeMs,
      size: st.size,
      gameVersion: text(meta.gameversion),
      modIds: strList(meta.modids).map((s) => s.toLowerCase()),
      modNames: strList(meta.modnames),
      modSteamIds: strList(meta.modsteamids),
    }
  } catch {
    return null
  }
}

export async function listSaves(configDir: string): Promise<SaveSummary[]> {
  // An empty folder setting would otherwise look in the working folder.
  if (!configDir) return []
  const dir = savesDir(configDir)
  let files: string[] = []
  try {
    files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.rws'))
  } catch {
    return []
  }
  const saves = await Promise.all(files.map((f) => readSaveMeta(join(dir, f))))
  return saves.filter((s): s is SaveSummary => !!s).sort((a, b) => b.mtime - a.mtime)
}

export async function backupNewestSave(configDir: string, backupDir: string): Promise<string | null> {
  if (!configDir) return null
  const dir = savesDir(configDir)
  try {
    const files = await readdir(dir)
    let newest: { f: string; t: number } | null = null
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.rws')) continue
      const t = (await stat(join(dir, f))).mtimeMs
      if (!newest || t > newest.t) newest = { f, t }
    }
    if (!newest) return null
    await mkdir(backupDir, { recursive: true })
    // A backup carries the save's file time, so one with the same save name and time is the same save:
    // launching again without having saved in between doesn't copy it again.
    const existing = (await readdir(backupDir)).filter((b) => b.toLowerCase().endsWith('.rws'))
    for (const b of existing) {
      if (!b.endsWith(`-${newest.f}`)) continue
      const st = await stat(join(backupDir, b)).catch(() => null)
      if (st && Math.abs(st.mtimeMs - newest.t) < 2) return join(backupDir, b)
    }
    // 2026-11-14T10-30-15-Colony.rws (UTC); older backups are named by the day only. Never overwrites one.
    const stamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-')
    let dest = ''
    for (let n = 1; ; n++) {
      dest = join(backupDir, `${stamp}${n > 1 ? `-${n}` : ''}-${newest.f}`)
      try {
        await copyFile(join(dir, newest.f), dest, constants.COPYFILE_EXCL)
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 20) throw e
      }
    }
    // Windows keeps the save's time on a copy; elsewhere the copy may get the current time, so set it.
    await utimes(dest, new Date(), newest.t / 1000).catch(() => {})
    await pruneSaveBackups(backupDir, 10)
    return dest
  } catch {
    return null
  }
}

// Saves are large (often 50 MB or more), so only the newest few backups are kept.
async function pruneSaveBackups(dir: string, keep: number) {
  const files = await Promise.all(
    (await readdir(dir))
      .filter((f) => f.toLowerCase().endsWith('.rws'))
      .map(async (f) => ({ f, t: (await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0 })),
  )
  files.sort((a, b) => b.t - a.t)
  for (const { f } of files.slice(keep)) await rm(join(dir, f), { force: true }).catch(() => {})
}
