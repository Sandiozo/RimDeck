import { access, copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// Windows can briefly lock files (antivirus, indexer, cloud sync); errors like these are worth a few retries.
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE'])

export async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 5 || !code || !TRANSIENT.has(code)) throw e
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
    }
  }
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Damaged files readJson set aside during this run (file names only), so the interface can say so. */
export const damagedFiles: { file: string; keptAs: string }[] = []

/**
 * Reads a JSON file. Only a missing file gives the fallback (always a fresh copy). A damaged file is
 * set aside as <name>.damaged-<time> before the fallback is used, so saving later never overwrites it
 * without a copy. Any other read error is retried a few times and then thrown, never taken as "empty".
 */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await withRetry(() => readFile(file, 'utf8'))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return structuredClone(fallback)
    throw new Error(`Could not read ${basename(file)} (${code ?? (e as Error).message}). If another program is using it, close that program and try again.`, { cause: e })
  }
  let parsed: unknown
  try {
    // Notepad and some editors add a byte-order mark, which JSON.parse rejects.
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
  } catch {}
  const fits = isPlain(fallback) ? isPlain(parsed) : Array.isArray(fallback) ? Array.isArray(parsed) : parsed !== undefined
  if (!fits) {
    await setAside(file)
    return structuredClone(fallback)
  }
  return (isPlain(fallback) ? { ...structuredClone(fallback), ...(parsed as object) } : parsed) as T
}

async function setAside(file: string) {
  const dest = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23)}`
  try {
    await renameRetry(file, dest)
  } catch {
    try {
      await withRetry(() => copyFile(file, dest))
    } catch (e) {
      throw new Error(`${basename(file)} is damaged and could not be copied aside (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`, { cause: e })
    }
  }
  damagedFiles.push({ file: basename(file), keptAs: basename(dest) })
  console.warn(`[rimdeck] ${basename(file)} could not be read; kept it as ${basename(dest)} and started from defaults`)
}

export async function writeJson(file: string, data: unknown) {
  await atomicWrite(file, JSON.stringify(data, null, 2))
}

export async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export async function renameRetry(from: string, to: string) {
  return withRetry(() => rename(from, to))
}

// Writes a uniquely named temp file next to the target and renames it into place, so a crash
// or two overlapping writes never leave a half-written file.
export async function atomicWrite(file: string, data: string | Uint8Array) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    const fh = await open(tmp, 'w')
    try {
      await fh.writeFile(data, 'utf8')
      // On disk before the rename, so a power cut can't leave an empty file in its place.
      // Some network drives don't support this; the write itself still counts.
      await fh.sync().catch(() => {})
    } finally {
      await fh.close()
    }
    await renameRetry(tmp, file)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}
