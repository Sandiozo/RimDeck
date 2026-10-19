import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return typeof fallback === 'object' && fallback && !Array.isArray(fallback) ? { ...fallback, ...parsed } : parsed
  } catch {
    return fallback
  }
}

export async function writeJson(file: string, data: unknown) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}
