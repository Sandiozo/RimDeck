import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return typeof fallback === 'object' && fallback && !Array.isArray(fallback) ? { ...fallback, ...parsed } : parsed
  } catch {
    return fallback
  }
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

// Windows can briefly lock files (antivirus, indexer); retry transient rename failures.
export async function renameRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY')) throw e
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
    }
  }
}

// Writes a uniquely named temp file next to the target and renames it into place, so a crash
// or two overlapping writes never leave a half-written file.
export async function atomicWrite(file: string, data: string) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  try {
    await writeFile(tmp, data, 'utf8')
    await renameRetry(tmp, file)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
}
