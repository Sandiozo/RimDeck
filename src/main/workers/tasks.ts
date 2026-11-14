// The work the main process hands to worker threads: parsing that would otherwise hold up the window.
// Each task takes and returns plain data. The same functions run in the main process when workers
// are unavailable (see pool.ts), so both ways give the same result.
import { readFile } from 'node:fs/promises'
import { isMainThread } from 'node:worker_threads'
import type { ModInfo, Paths } from '../../shared/types.ts'
import { ddsToBgra } from '../core/dds.ts'
import { extractDefData } from '../core/defdata.ts'
import { readAssembly } from '../core/harmony.ts'
import { mediaStats, startupFromLog } from '../core/loadtime.ts'
import { parsePlayerLog, type Attribution } from '../core/logs.ts'
import { scanAll } from '../core/scanner.ts'
import { textureLookup, textureReport } from '../core/textures.ts'
import { parseXml } from '../core/xml.ts'
import { indexModXml, searchFiles } from '../core/xmlindex.ts'
import { Transfer } from './protocol.ts'

export const tasks = {
  scanAll: (paths: Paths, major: string) => scanAll(paths, major),

  indexModXml: (mod: ModInfo, dirs: string[]) => indexModXml(mod, dirs),

  // The texture lookup is a function, so it is built here, next to the parsing that uses it. Run with
  // the same key every time (see Service.defData), so the parsed files cached between runs are reused.
  defData: async (mods: ModInfo[], filesPerMod: string[][]) => extractDefData(mods, filesPerMod, await textureLookup(mods)),

  // Run with the same key as defData: both read each mod's texture folders through one cache (see core/textures.ts).
  textureReport: (mods: ModInfo[]) => textureReport(mods),

  searchFiles: (lower: string, mods: { packageId: string; files: string[] }[], limit: number) => searchFiles(lower, mods, limit),

  readAssembly: (file: string) => readAssembly(file),

  parsePlayerLog: (file: string, a: Attribution) => parsePlayerLog(file, a),

  startupFromLog: (file: string) => startupFromLog(file),

  // Tens of thousands of file sizes; run with one key so the sizes cached between runs are reused.
  mediaStats: (list: { mod: ModInfo; dirs: string[] }[]) => Promise.all(list.map((x) => mediaStats(x.mod, x.dirs))),

  // The pixels are moved to the main process, not copied.
  ddsBitmap: async (file: string, flip: boolean) => {
    const bmp = ddsToBgra(new Uint8Array(await readFile(file)), flip)
    return bmp && new Transfer(bmp, [bmp.bgra.buffer as ArrayBuffer])
  },

  /** A small parse, to check that workers start and can load the XML parser (see workerCheck). */
  xmlCheck: (xml: string) => ({ inWorker: !isMainThread, defName: String(parseXml(xml)?.defs?.thingdef?.defname ?? '') }),
}

export type Tasks = typeof tasks
