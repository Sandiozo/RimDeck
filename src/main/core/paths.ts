import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Paths } from '../../shared/types.ts'

const APP_ID = '294100'

async function exists(p: string) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function regQuery(key: string, value: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null)
    execFile('reg', ['query', key, '/v', value], { windowsHide: true }, (err, out) => {
      if (err) return resolve(null)
      const m = out.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`))
      resolve(m ? m[1].trim() : null)
    })
  })
}

export function defaultConfigDir() {
  if (process.platform === 'win32')
    return join(homedir(), 'AppData', 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios', 'Config')
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'RimWorld', 'Config')
  return join(homedir(), '.config', 'unity3d', 'Ludeon Studios', 'RimWorld by Ludeon Studios', 'Config')
}

async function steamLibraries(): Promise<string[]> {
  const roots: string[] = []
  const reg = (await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath')) ??
    (await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'))
  if (reg) roots.push(reg.replace(/\//g, '\\'))
  roots.push('C:\\Program Files (x86)\\Steam', join(homedir(), '.steam', 'steam'), join(homedir(), '.local', 'share', 'Steam'))
  const libs = new Set<string>()
  for (const root of roots) {
    try {
      const vdf = await readFile(join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8')
      for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'))
    } catch {}
    if (await exists(root)) libs.add(root)
  }
  return [...libs]
}

async function fromRimSort(): Promise<Partial<Paths> | null> {
  const base = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'RimSort') : join(homedir(), '.local', 'share', 'RimSort')
  try {
    const s = JSON.parse(await readFile(join(base, 'settings.json'), 'utf8'))
    const inst = s.instances?.[s.current_instance ?? 'Default']
    if (!inst) return null
    return {
      gameDir: inst.game_folder || '',
      configDir: inst.config_folder || '',
      localModsDir: inst.local_folder || '',
      workshopDir: inst.workshop_folder || '',
    }
  } catch {
    return null
  }
}

export async function detectPaths(): Promise<{ paths: Paths; source: string }> {
  const rs = await fromRimSort()
  if (rs?.gameDir && (await exists(rs.gameDir))) {
    return {
      source: 'RimSort',
      paths: {
        gameDir: rs.gameDir,
        configDir: rs.configDir || defaultConfigDir(),
        localModsDir: rs.localModsDir || join(rs.gameDir, 'Mods'),
        workshopDir: rs.workshopDir || '',
      },
    }
  }
  const paths: Paths = { gameDir: '', configDir: defaultConfigDir(), localModsDir: '', workshopDir: '' }
  for (const lib of await steamLibraries()) {
    const game = join(lib, 'steamapps', 'common', 'RimWorld')
    if (!paths.gameDir && (await exists(join(game, 'Data', 'Core')))) {
      paths.gameDir = game
      paths.localModsDir = join(game, 'Mods')
    }
    const ws = join(lib, 'steamapps', 'workshop', 'content', APP_ID)
    if (!paths.workshopDir && (await exists(ws))) paths.workshopDir = ws
  }
  return { paths, source: paths.gameDir ? 'Steam' : 'none' }
}

export async function readGameVersion(gameDir: string): Promise<string> {
  try {
    return (await readFile(join(gameDir, 'Version.txt'), 'utf8')).trim()
  } catch {
    return ''
  }
}

export function majorOf(version: string): string {
  return version.match(/^(\d+\.\d+)/)?.[1] ?? '1.7'
}

export async function validatePaths(p: Paths): Promise<string[]> {
  const problems: string[] = []
  if (!p.gameDir || !(await exists(join(p.gameDir, 'Data', 'Core')))) problems.push('Game folder not found (expected Data/Core inside).')
  if (!p.configDir || !(await exists(p.configDir))) problems.push('Config folder not found.')
  if (p.workshopDir && !(await exists(p.workshopDir))) problems.push('Workshop folder does not exist.')
  if (p.localModsDir && !(await exists(p.localModsDir))) problems.push('Local mods folder does not exist.')
  return problems
}
