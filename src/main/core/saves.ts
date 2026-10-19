import { copyFile, mkdir, open, readdir, stat } from 'node:fs/promises'
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
    const dest = join(backupDir, `${new Date().toISOString().slice(0, 10)}-${newest.f}`)
    await copyFile(join(dir, newest.f), dest)
    return dest
  } catch {
    return null
  }
}
