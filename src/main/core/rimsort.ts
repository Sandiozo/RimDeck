import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ModMeta, RuleMap } from '../../shared/types.ts'

/** RimSort's data folder (its settings, rules and databases) on this platform. */
export function rimsortDir() {
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'RimSort')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'RimSort')
  return join(homedir(), '.local', 'share', 'RimSort')
}

/** Rules keyed by lower-cased package id, including the ids inside loadAfter/loadBefore/incompatibleWith. */
export function lowerRuleKeys(rules: Record<string, any> | null | undefined): RuleMap {
  const out: RuleMap = {}
  const lower = (o: any) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v])) : o)
  for (const [id, r] of Object.entries(rules ?? {})) {
    if (!r || typeof r !== 'object') continue
    const rule: any = { ...r }
    for (const k of ['loadAfter', 'loadBefore', 'incompatibleWith']) if (k in rule) rule[k] = lower(rule[k])
    out[id.toLowerCase()] = rule
  }
  return out
}

async function json(file: string): Promise<any> {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return null
  }
}

// RimSort keeps colors/notes/tags in SQLite keyed by mod folder path.
async function readAuxDb(file: string): Promise<Record<string, ModMeta>> {
  const byPath: Record<string, ModMeta> = {}
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    const rows = db.prepare('SELECT path, user_notes, color_hex FROM auxiliary_metadata').all() as any[]
    for (const r of rows) {
      const m: ModMeta = {}
      if (r.color_hex) m.color = r.color_hex
      if (r.user_notes) m.notes = r.user_notes
      if (Object.keys(m).length) byPath[String(r.path).toLowerCase()] = m
    }
    try {
      const tags = db
        .prepare('SELECT a.path AS path, t.tag AS tag FROM tags_table x JOIN mod_tags t ON t.id = x.right_id JOIN auxiliary_metadata a ON a.rowid = x.left_id')
        .all() as any[]
      for (const t of tags) {
        const k = String(t.path).toLowerCase()
        byPath[k] = { ...byPath[k], tags: [...(byPath[k]?.tags ?? []), t.tag] }
      }
    } catch {}
    db.close()
  } catch {}
  return byPath
}

export interface RimSortImport {
  userRules: RuleMap
  ignored: string[]
  metaByPath: Record<string, ModMeta>
  found: boolean
}

export async function importFromRimSort(): Promise<RimSortImport> {
  const dir = rimsortDir()
  const settings = await json(join(dir, 'settings.json'))
  const rules = await json(join(dir, 'dbs', 'userRules.json'))
  const ignore = await json(join(dir, 'dbs', 'ignore.json'))
  const instance = settings?.current_instance_path || join(dir, 'instances', 'Default')
  const metaByPath = await readAuxDb(join(instance, 'aux_metadata.db'))
  return {
    userRules: lowerRuleKeys(rules?.rules),
    ignored: (ignore?.ignored_mods ?? []).map((s: string) => s.toLowerCase()),
    metaByPath,
    found: !!(settings || rules || ignore),
  }
}
