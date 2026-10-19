import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkshopDetails } from '../../shared/types.ts'

export const APP_ID = '294100'
const DETAILS_URL = 'https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/'

/** Public Steam Web API call, no key needed. Unknown, removed and non-RimWorld items come back with ok: false. */
export async function fetchDetails(ids: string[]): Promise<Map<string, WorkshopDetails>> {
  const out = new Map<string, WorkshopDetails>()
  const unique = [...new Set(ids.filter((id) => /^\d+$/.test(id)))]
  for (let i = 0; i < unique.length; i += 100) {
    const chunk = unique.slice(i, i + 100)
    const body = new URLSearchParams({ itemcount: String(chunk.length) })
    chunk.forEach((id, n) => body.set(`publishedfileids[${n}]`, id))
    const res = await fetch(DETAILS_URL, { method: 'POST', body, signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`Steam API returned ${res.status}`)
    const json: any = await res.json()
    for (const d of json?.response?.publishedfiledetails ?? []) {
      const id = String(d.publishedfileid)
      out.set(id, {
        workshopId: id,
        ok: d.result === 1 && String(d.consumer_app_id) === APP_ID,
        title: d.title || id,
        size: Number(d.file_size) || 0,
        timeUpdated: Number(d.time_updated) || 0,
        previewUrl: d.preview_url || undefined,
      })
    }
  }
  return out
}

/** Minimal Valve KeyValues (VDF/ACF) reader: nested objects of string values. */
export function parseVdf(text: string): Record<string, any> {
  const root: Record<string, any> = {}
  const stack = [root]
  let key: string | null = null
  const re = /"((?:\\.|[^"\\])*)"|([{}])/g
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const top = stack[stack.length - 1]
    if (m[2] === '{') {
      const obj = {}
      if (key !== null) top[key] = obj
      stack.push(obj)
      key = null
    } else if (m[2] === '}') {
      if (stack.length > 1) stack.pop()
      key = null
    } else if (key === null) key = m[1]
    else {
      top[key] = m[1].replace(/\\(.)/g, '$1')
      key = null
    }
  }
  return root
}

export interface AcfItem {
  timeUpdated: number // version on disk
}

/** Steam's record of installed Workshop items: <library>/steamapps/workshop/appworkshop_294100.acf */
export async function readWorkshopAcf(workshopContentDir: string): Promise<Map<string, AcfItem>> {
  const out = new Map<string, AcfItem>()
  if (!workshopContentDir) return out
  let text: string
  try {
    text = await readFile(join(workshopContentDir, '..', '..', `appworkshop_${APP_ID}.acf`), 'utf8')
  } catch {
    return out
  }
  const acf = parseVdf(text).AppWorkshop ?? {}
  for (const [id, v] of Object.entries<any>(acf.WorkshopItemsInstalled ?? {}))
    out.set(id, { timeUpdated: Number(v?.timeupdated) || 0 })
  return out
}

/** Newest file time under a mod folder (ms), for copies we have no Steam record of. */
export async function newestMtime(dir: string, depth = 4): Promise<number> {
  let newest = 0
  try {
    newest = (await stat(dir)).mtimeMs
    if (depth <= 0) return newest
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      const t = e.isDirectory() ? await newestMtime(p, depth - 1) : (await stat(p)).mtimeMs
      if (t > newest) newest = t
    }
  } catch {}
  return newest
}

const COLLECTION_URL = 'https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/'

/** Children of each collection id, in the author's order; null when the id is not a collection. */
export async function fetchCollections(ids: string[]): Promise<Map<string, { items: string[]; collections: string[] } | null>> {
  const out = new Map<string, { items: string[]; collections: string[] } | null>()
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    const body = new URLSearchParams({ collectioncount: String(chunk.length) })
    chunk.forEach((id, n) => body.set(`publishedfileids[${n}]`, id))
    const res = await fetch(COLLECTION_URL, { method: 'POST', body, signal: AbortSignal.timeout(20000) })
    if (!res.ok) throw new Error(`Steam API returned ${res.status}`)
    const json: any = await res.json()
    for (const c of json?.response?.collectiondetails ?? []) {
      const children: any[] = c.result === 1 ? (c.children ?? []) : []
      if (!children.length) {
        out.set(String(c.publishedfileid), null)
        continue
      }
      children.sort((a, b) => (a.sortorder ?? 0) - (b.sortorder ?? 0))
      // filetype 2 = a collection nested inside this one; everything else is a regular item.
      out.set(String(c.publishedfileid), {
        items: children.filter((x) => x.filetype !== 2).map((x) => String(x.publishedfileid)),
        collections: children.filter((x) => x.filetype === 2).map((x) => String(x.publishedfileid)),
      })
    }
  }
  return out
}
