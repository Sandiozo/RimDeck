// Reads which settings a mod has, from its compiled code. RimWorld only writes a setting to the
// Config file once it differs from its default, so the file alone misses most of them.
// Each Scribe_Values.Look(ref field, "label", default) call in a ModSettings class's ExposeData
// gives the label, the value type and the default. Nothing is loaded or executed.
import { readFileSync } from 'node:fs'
import {
  type Md,
  OPERAND,
  TWO_BYTE_OPERAND,
  blob,
  cell,
  compressed,
  methodsOf,
  openMetadata,
  rvaToOff,
  str,
  typeDefName,
  typeName,
  userString,
} from './harmony.ts'
import type { SettingSchema } from '../../shared/types.ts'

type SettingType = SettingSchema['type']

export interface AssemblySettings {
  /** Mod subclass short name (used in the Config file name) → settings class full name. */
  mods: { modClass: string; settingsClass: string }[]
  /** Settings class full name → its settings. */
  schemas: Record<string, SettingSchema[]>
}

const TYPEDEF = 0x02, FIELD = 0x04, FIELDPTR = 0x03, METHOD = 0x06, MEMBERREF = 0x0a, CONSTANT = 0x0b, METHODSPEC = 0x2b

/** Looks up an enum defined in another assembly: value → name pairs, or null. */
export type EnumResolver = (fullName: string) => [number, string][] | null

const cache = new Map<string, { mtime: number; info: AssemblySettings | null }>()

export function readAssemblySettings(file: string, mtime: number, resolveEnum?: EnumResolver): AssemblySettings | null {
  const hit = cache.get(file)
  if (hit && hit.mtime === mtime) return hit.info
  let info: AssemblySettings | null = null
  try {
    const md = openMetadata(readFileSync(file))
    info = md ? scan(md, resolveEnum) : null
  } catch {
    info = null
  }
  cache.set(file, { mtime, info })
  return info
}

/** Enum members of a type defined in this file, for resolving enums used by other assemblies. */
const opened = new Map<string, Md | null>()

export function enumMembersIn(file: string, fullName: string): [number, string][] | null {
  try {
    if (!opened.has(file)) opened.set(file, openMetadata(readFileSync(file)))
    const md = opened.get(file)
    if (!md) return null
    for (let r = 1; r <= md.rows[TYPEDEF]; r++) if (typeDefName(md, r) === fullName) return enumMembers(md, r)
  } catch {
    // unreadable assembly
  }
  return null
}

function extendsName(md: Md, row: number): string {
  const ext = cell(md, TYPEDEF, row, 3)
  return ext ? typeName(md, ext & 3, ext >>> 2) : ''
}

// Walks the base-class chain inside this assembly until it reaches a type from outside.
function derivesFrom(md: Md, row: number, base: string): boolean {
  for (let guard = 0; guard < 16 && row; guard++) {
    const ext = cell(md, TYPEDEF, row, 3)
    if (!ext) return false
    if ((ext & 3) === 0) row = ext >>> 2
    else return typeName(md, ext & 3, ext >>> 2) === base
  }
  return false
}

function fieldsOf(md: Md, row: number): number[] {
  const end = (md.rows[FIELDPTR] || md.rows[FIELD]) + 1
  const a = cell(md, TYPEDEF, row, 4)
  const b = row < md.rows[TYPEDEF] ? cell(md, TYPEDEF, row + 1, 4) : end
  const out: number[] = []
  for (let i = a; i < b && i < end; i++) out.push(md.rows[FIELDPTR] ? cell(md, FIELDPTR, i, 0) : i)
  return out
}

function enumMembers(md: Md, row: number): [number, string][] | null {
  if (extendsName(md, row) !== 'System.Enum') return null
  const consts = new Map<number, number>()
  for (let r = 1; r <= md.rows[CONSTANT]; r++) {
    const parent = cell(md, CONSTANT, r, 1)
    if ((parent & 3) !== 0) continue
    const type = cell(md, CONSTANT, r, 0) & 0xff
    const c = blob(md, cell(md, CONSTANT, r, 2))
    const dv = md.dv
    const v =
      type === 0x04 ? dv.getInt8(c.p) : type === 0x05 ? dv.getUint8(c.p) : type === 0x06 ? dv.getInt16(c.p, true) : type === 0x07 ? dv.getUint16(c.p, true)
        : type === 0x08 ? dv.getInt32(c.p, true) : type === 0x09 ? dv.getUint32(c.p, true) : type === 0x0a || type === 0x0b ? Number(dv.getBigInt64(c.p, true)) : NaN
    consts.set(parent >>> 2, v)
  }
  const out: [number, string][] = []
  for (const f of fieldsOf(md, row)) {
    const name = str(md, cell(md, FIELD, f, 1))
    const v = consts.get(f)
    if (name !== 'value__' && v !== undefined && !Number.isNaN(v)) out.push([v, name])
  }
  return out.length ? out : null
}

function methodByName(md: Md, row: number, name: string): number {
  for (const m of methodsOf(md, row)) if (str(md, cell(md, METHOD, m, 3)) === name) return m
  return 0
}

// The generic argument of a MethodSpec, plus the generic method's declaring type and name.
function methodSpec(md: Md, row: number): { owner: string; name: string; arg: { el: number; tag?: number; row?: number } } | null {
  if (row < 1 || row > md.rows[METHODSPEC]) return null
  const m = cell(md, METHODSPEC, row, 0)
  if ((m & 1) !== 1) return null // a MemberRef: the method lives in another assembly
  const ref = m >>> 1
  const cls = cell(md, MEMBERREF, ref, 0)
  const owner = (cls & 7) === 1 ? typeName(md, 1, cls >>> 3) : (cls & 7) === 0 ? typeName(md, 0, cls >>> 3) : (cls & 7) === 4 ? typeName(md, 2, cls >>> 3) : '?'
  const name = str(md, cell(md, MEMBERREF, ref, 1))
  const c = blob(md, cell(md, METHODSPEC, row, 1))
  if (md.buf[c.p++] !== 0x0a) return null
  if (compressed(md.buf, c) !== 1) return null
  const el = md.buf[c.p++]
  if (el === 0x11 || el === 0x12) {
    const tok = compressed(md.buf, c)
    return { owner, name, arg: { el, tag: tok & 3, row: tok >>> 2 } }
  }
  return { owner, name, arg: { el } }
}

const PRIM: Record<number, SettingType> = {
  0x02: 'bool', 0x04: 'int', 0x05: 'int', 0x06: 'int', 0x07: 'int', 0x08: 'int', 0x09: 'int', 0x0a: 'int', 0x0b: 'int',
  0x0c: 'float', 0x0d: 'float', 0x0e: 'string',
}

type Push = { k: 'str'; v: string | null } | { k: 'num'; v: number; f32?: boolean } | { k: 'null' } | { k: 'other' }

function methodBody(md: Md, m: number): [number, number] | null {
  const rva = cell(md, METHOD, m, 0)
  if (!rva) return null
  const off = rvaToOff(md, rva)
  if (off < 0) return null
  const h = md.buf[off]
  if ((h & 3) === 2) return [off + 1, Math.min(off + 1 + (h >>> 2), md.buf.length)]
  if ((h & 3) === 3) {
    const code = off + (md.buf[off + 1] >>> 4) * 4
    return [code, Math.min(code + md.dv.getUint32(off + 4, true), md.buf.length)]
  }
  return null
}

// .NET writes a float with the fewest digits that read back to the same value.
function formatFloat(v: number, f32: boolean): string {
  if (!Number.isFinite(v)) return String(v)
  for (let p = 1; p <= 17; p++) {
    const s = Number(v.toPrecision(p))
    if ((f32 ? Math.fround(s) : s) === v) return String(s).replace('e', 'E').replace(/E\+?(-?)(\d)$/, 'E$10$2')
  }
  return String(v)
}

function scanExposeData(md: Md, row: number, resolveEnum: EnumResolver | undefined, out: SettingSchema[]) {
  const m = methodByName(md, row, 'ExposeData')
  const body = m && methodBody(md, m)
  if (!body) return
  const [start, end] = body
  const buf = md.buf
  const recent: Push[] = []
  let nested = 0
  let p = start
  while (p < end) {
    let op = buf[p++]
    if (op === 0xfe) {
      op = buf[p++]
      p += op < 32 ? TWO_BYTE_OPERAND[op] : 0
      recent.push({ k: 'other' })
      continue
    }
    const n = OPERAND[op]
    if (n === 0xff) {
      const cnt = md.dv.getUint32(p, true)
      p += 4 + cnt * 4
      recent.length = 0
      continue
    }
    if (op >= 0x15 && op <= 0x1e) recent.push({ k: 'num', v: op - 0x16 })
    else if (op === 0x1f) recent.push({ k: 'num', v: md.dv.getInt8(p) })
    else if (op === 0x20) recent.push({ k: 'num', v: md.dv.getInt32(p, true) })
    else if (op === 0x21) recent.push({ k: 'num', v: Number(md.dv.getBigInt64(p, true)) })
    else if (op === 0x22) recent.push({ k: 'num', v: md.dv.getFloat32(p, true), f32: true })
    else if (op === 0x23) recent.push({ k: 'num', v: md.dv.getFloat64(p, true) })
    else if (op === 0x14) recent.push({ k: 'null' })
    else if (op === 0x72) recent.push({ k: 'str', v: userString(md, md.dv.getUint32(p, true) & 0xffffff) })
    else if ((op >= 0x67 && op <= 0x6e) || op === 0x76 || (op >= 0xd1 && op <= 0xd3)) {
      // conversions keep the constant in front of them
      const last = recent[recent.length - 1]
      if (last?.k === 'num') last.f32 = op === 0x6b ? true : op === 0x6c ? false : last.f32
      else recent.push({ k: 'other' })
    } else if ((op === 0x28 || op === 0x6f) && p + 4 <= end) {
      const tok = md.dv.getUint32(p, true)
      const tt = tok >>> 24
      if (tt === METHODSPEC) {
        const spec = methodSpec(md, tok & 0xffffff)
        if (spec && spec.owner === 'Verse.Scribe_Values' && spec.name === 'Look' && !nested) {
          const [label, def] = [recent[recent.length - 3], recent[recent.length - 2]]
          const entry = label?.k === 'str' && label.v ? toEntry(md, label.v, def, spec.arg, resolveEnum) : null
          if (entry && !out.some((e) => e.label === entry.label)) out.push(entry)
        }
      } else if (tt === MEMBERREF) {
        const ref = tok & 0xffffff
        const cls = cell(md, MEMBERREF, ref, 0)
        const name = str(md, cell(md, MEMBERREF, ref, 1))
        if ((cls & 7) === 1 && typeName(md, 1, cls >>> 3) === 'Verse.Scribe') {
          if (name === 'EnterNode') nested++
          else if (name === 'ExitNode') nested = Math.max(0, nested - 1)
        }
      }
      recent.length = 0
    } else recent.push({ k: 'other' })
    p += n
    if (recent.length > 8) recent.splice(0, recent.length - 8)
  }
}

function toEntry(md: Md, label: string, def: Push | undefined, arg: { el: number; tag?: number; row?: number }, resolveEnum?: EnumResolver): SettingSchema | null {
  if (!def || def.k === 'other') return null
  const type = PRIM[arg.el]
  if (type === 'bool') return def.k === 'num' ? { label, type, def: def.v ? 'True' : 'False' } : null
  if (type === 'int') return def.k === 'num' ? { label, type, def: String(Math.trunc(def.v)) } : null
  if (type === 'float') return def.k === 'num' ? { label, type, def: formatFloat(def.f32 ? Math.fround(def.v) : def.v, !!def.f32 || arg.el === 0x0c) } : null
  if (type === 'string') return def.k === 'str' ? { label, type, def: def.v } : def.k === 'null' ? { label, type, def: null } : null
  if (arg.el === 0x11 && arg.tag !== undefined && def.k === 'num') {
    const members = arg.tag === 0 ? enumMembers(md, arg.row!) : arg.tag === 1 ? resolveEnum?.(typeName(md, 1, arg.row!)) ?? null : null
    if (!members) return null
    const name = members.find(([v]) => v === def.v)?.[1] ?? String(def.v)
    return { label, type: 'enum', def: name, options: [...new Set(members.map(([, n]) => n))] }
  }
  return null
}

function scan(md: Md, resolveEnum?: EnumResolver): AssemblySettings {
  const schemas: Record<string, SettingSchema[]> = {}
  const mods: AssemblySettings['mods'] = []
  for (let r = 1; r <= md.rows[TYPEDEF]; r++) {
    if (derivesFrom(md, r, 'Verse.ModSettings')) {
      const entries: SettingSchema[] = []
      // Base classes inside this assembly contribute their settings too.
      for (let t = r, guard = 0; t && guard < 16; guard++) {
        scanExposeData(md, t, resolveEnum, entries)
        const ext = cell(md, TYPEDEF, t, 3)
        t = ext && (ext & 3) === 0 ? ext >>> 2 : 0
      }
      schemas[typeDefName(md, r)] = entries
    } else if (derivesFrom(md, r, 'Verse.Mod')) {
      const settingsClass = getSettingsCall(md, r)
      if (settingsClass) mods.push({ modClass: str(md, cell(md, TYPEDEF, r, 1)), settingsClass })
    }
  }
  return { mods, schemas }
}

// Finds GetSettings<T>() inside a Mod subclass, which names its settings class.
function getSettingsCall(md: Md, row: number): string | null {
  for (const m of methodsOf(md, row)) {
    const body = methodBody(md, m)
    if (!body) continue
    for (let p = body[0]; p < body[1]; ) {
      let op = md.buf[p++]
      if (op === 0xfe) {
        op = md.buf[p++]
        p += op < 32 ? TWO_BYTE_OPERAND[op] : 0
        continue
      }
      const n = OPERAND[op]
      if (n === 0xff) {
        p += 4 + md.dv.getUint32(p, true) * 4
        continue
      }
      if ((op === 0x28 || op === 0x6f) && p + 4 <= body[1]) {
        const tok = md.dv.getUint32(p, true)
        if (tok >>> 24 === METHODSPEC) {
          const spec = methodSpec(md, tok & 0xffffff)
          if (spec?.name === 'GetSettings' && spec.arg.el === 0x12 && spec.arg.tag !== undefined) return typeName(md, spec.arg.tag, spec.arg.row!)
        }
      }
      p += n
    }
  }
  return null
}

