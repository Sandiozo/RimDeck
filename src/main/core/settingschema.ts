// Reads which settings a mod has, from its compiled code. RimWorld only writes a setting to the
// Config file once it differs from its default, so the file alone misses most of them.
// The ModSettings class's ExposeData says what is saved (Scribe_Values, Scribe_Collections,
// Scribe_Deep and Scribe.EnterNode calls, including ones made through the mod's own helper
// methods), and the Mod class's DoSettingsWindowContents says how the game window labels each
// field. Nothing is loaded or executed; the IL is only read.
import { readFile, stat } from 'node:fs/promises'
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
import type { SettingElem, SettingSchema } from '../../shared/types.ts'

export interface AssemblySettings {
  /** Mod subclass short name (used in the Config file name) → settings class full name. */
  mods: { modClass: string; settingsClass: string }[]
  /** Settings class full name → its settings. Titles and tips are untranslated keys or text. */
  schemas: Record<string, SettingSchema[]>
}

const TYPEDEF = 0x02, FIELDPTR = 0x03, FIELD = 0x04, METHOD = 0x06, MEMBERREF = 0x0a, CONSTANT = 0x0b, TYPESPEC = 0x1b, METHODSPEC = 0x2b

/** Looks up an enum defined in another assembly: value → name pairs, or null. */
export type EnumResolver = (fullName: string) => [number, string][] | null

const cache = new Map<string, { mtime: number; info: AssemblySettings | null }>()

/** Settings found in an assembly, cached by file time. Null when it isn't cached yet. */
export function cachedAssemblySettings(file: string, mtime: number): AssemblySettings | null | undefined {
  const hit = cache.get(file)
  return hit && hit.mtime === mtime ? hit.info : undefined
}

export async function readAssemblySettings(file: string, mtime: number, resolveEnum?: EnumResolver): Promise<AssemblySettings | null> {
  const hit = cachedAssemblySettings(file, mtime)
  if (hit !== undefined) return hit
  let info: AssemblySettings | null = null
  try {
    const md = openMetadata(await readFile(file))
    info = md ? scan(md, resolveEnum) : null
  } catch {
    info = null
  }
  cache.set(file, { mtime, info })
  return info
}

// The game's own assembly is large (15 MB on 1.7), so it is opened once per file version.
const gameAssemblies = new Map<string, { mtime: number; md: Md | null }>()

/** Opens an assembly for enum lookups; the game's assembly is kept open, a mod's is not. */
export async function openForEnums(file: string, keep = false): Promise<Md | null> {
  try {
    const mtime = (await stat(file)).mtimeMs
    const hit = gameAssemblies.get(file)
    if (hit && hit.mtime === mtime) return hit.md
    const md = openMetadata(await readFile(file))
    if (keep) gameAssemblies.set(file, { mtime, md })
    return md
  } catch {
    return null
  }
}

/** Enum members of a type defined in this assembly, for resolving enums used by other assemblies. */
export function enumMembersIn(md: Md, fullName: string): [number, string][] | null {
  try {
    for (let r = 1; r <= md.rows[TYPEDEF]; r++) if (typeDefName(md, r) === fullName) return enumMembers(md, r)
  } catch {
    // malformed assembly
  }
  return null
}

// ---------------------------------------------------------------------------
// Types and members

interface TypeSig {
  el: number
  name?: string
  tag?: number
  row?: number
  args?: TypeSig[]
  mvar?: number
}

function readTypeSig(md: Md, c: { p: number }, depth = 0): TypeSig {
  const el = md.buf[c.p++]
  if (depth > 8) return { el: 0 }
  if (el === 0x1f || el === 0x20) {
    compressed(md.buf, c)
    return readTypeSig(md, c, depth + 1)
  }
  if (el === 0x10) return readTypeSig(md, c, depth + 1) // byref
  if (el === 0x11 || el === 0x12) {
    const tok = compressed(md.buf, c)
    return { el, tag: tok & 3, row: tok >>> 2, name: typeName(md, tok & 3, tok >>> 2) }
  }
  if (el === 0x15) {
    const inner = readTypeSig(md, c, depth + 1)
    const n = compressed(md.buf, c)
    const args: TypeSig[] = []
    for (let i = 0; i < n && i < 8; i++) args.push(readTypeSig(md, c, depth + 1))
    return { ...inner, args }
  }
  if (el === 0x13 || el === 0x1e) return { el, mvar: compressed(md.buf, c) }
  if (el === 0x1d) return { el, args: [readTypeSig(md, c, depth + 1)] }
  return { el }
}

// Type tokens as used by initobj; TypeSpecs are generic instantiations.
function tokenType(md: Md, tok: number): TypeSig {
  const t = tok >>> 24, row = tok & 0xffffff
  if (t === TYPEDEF) return { el: 0x12, tag: 0, row, name: typeName(md, 0, row) }
  if (t === 0x01) return { el: 0x12, tag: 1, row, name: typeName(md, 1, row) }
  if (t === TYPESPEC) return readTypeSig(md, blob(md, cell(md, TYPESPEC, row, 0)))
  return { el: 0 }
}

function subst(t: TypeSig, gen: TypeSig[]): TypeSig {
  return t.el === 0x1e ? gen[t.mvar!] ?? { el: 0 } : t
}

function extendsInfo(md: Md, row: number): { tag: number; row: number } | null {
  const ext = cell(md, TYPEDEF, row, 3)
  return ext ? { tag: ext & 3, row: ext >>> 2 } : null
}

// Walks the base-class chain inside this assembly until it reaches a type from outside.
function derivesFrom(md: Md, row: number, base: string): boolean {
  for (let guard = 0; guard < 16 && row; guard++) {
    const ext = extendsInfo(md, row)
    if (!ext) return false
    if (ext.tag === 0) row = ext.row
    else return typeName(md, ext.tag, ext.row) === base
  }
  return false
}

function fieldRange(md: Md, row: number): [number, number] {
  const end = (md.rows[FIELDPTR] || md.rows[FIELD]) + 1
  return [cell(md, TYPEDEF, row, 4), row < md.rows[TYPEDEF] ? cell(md, TYPEDEF, row + 1, 4) : end]
}

function fieldsOf(md: Md, row: number): number[] {
  const [a, b] = fieldRange(md, row)
  const out: number[] = []
  for (let i = a; i < b; i++) out.push(md.rows[FIELDPTR] ? cell(md, FIELDPTR, i, 0) : i)
  return out
}

function fieldOwner(md: Md, field: number): number {
  for (let r = 1; r <= md.rows[TYPEDEF]; r++) {
    const [a, b] = fieldRange(md, r)
    if (field >= a && field < b) return r
  }
  return 0
}

function enumMembers(md: Md, row: number): [number, string][] | null {
  const ext = extendsInfo(md, row)
  if (!ext || typeName(md, ext.tag, ext.row) !== 'System.Enum') return null
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

function methodBody(md: Md, m: number): [number, number] | null {
  if (m < 1 || m > md.rows[METHOD]) return null
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

// Number of stack arguments a call takes, including `this` for instance methods.
function argCount(md: Md, sigBlob: number): number {
  const c = blob(md, sigBlob)
  const cc = md.buf[c.p++]
  if (cc & 0x10) compressed(md.buf, c)
  return compressed(md.buf, c) + (cc & 0x20 ? 1 : 0)
}

function methodsNamed(md: Md, row: number, name: string): number[] {
  return methodsOf(md, row).filter((m) => str(md, cell(md, METHOD, m, 3)) === name)
}

// ---------------------------------------------------------------------------
// A small IL walker. It keeps the values pushed since the last statement boundary, which is
// enough to see the arguments of the calls that RimWorld settings code makes.

type Val =
  | { k: 'num'; v: number; f32?: boolean }
  | { k: 'str'; v: string }
  | { k: 'null' }
  | { k: 'field'; row: number; addr: boolean }
  | { k: 'struct'; type: string; nums: number[] }
  | { k: 'named'; type: string; name: string }
  | { k: 'zero'; type: string }
  | { k: 'other' }

type Call =
  | { local: false; owner: string; name: string; gen: TypeSig[]; argc: number }
  | { local: true; method: number; gen: TypeSig[]; argc: number }

interface Frame {
  args: Val[]
  gen: TypeSig[]
  depth: number
  chain: number[]
}

interface Hooks {
  call?(c: Call, recent: Val[]): void
  store?(field: number, v: Val | undefined): void
  /** Local helper methods are followed with their arguments unless this is false. */
  follow?: boolean
}

const OTHER: Val = { k: 'other' }
// Calls that only reshape a value on its way into another call.
const TRANSPARENT = new Set([
  'Translate', 'op_Implicit', 'CapitalizeFirst', 'Resolve', 'get_RawText', 'ToString', 'Concat', 'Format', 'Colorize', 'ToStringPercent',
  'ToStringByStyle', 'ToStringDecimalIfSmall', 'Trim', 'UncapitalizeFirst', 'AsTipTitle', 'Truncate',
])
const STRUCTS: Record<string, true> = {
  'UnityEngine.Color': true, 'Verse.IntRange': true, 'Verse.FloatRange': true, 'UnityEngine.Vector2': true, 'UnityEngine.Vector3': true, 'Verse.IntVec2': true, 'Verse.IntVec3': true,
}

function decodeCall(md: Md, tok: number, f: Frame): Call | null {
  const t = tok >>> 24, row = tok & 0xffffff
  if (t === METHOD) return row <= md.rows[METHOD] ? { local: true, method: row, gen: [], argc: argCount(md, cell(md, METHOD, row, 4)) } : null
  if (t === MEMBERREF) {
    if (row > md.rows[MEMBERREF]) return null
    const cls = cell(md, MEMBERREF, row, 0)
    const tag = cls & 7
    const owner = tag === 1 ? typeName(md, 1, cls >>> 3) : tag === 0 ? typeName(md, 0, cls >>> 3) : tag === 4 ? typeName(md, 2, cls >>> 3) : '?'
    return { local: false, owner, name: str(md, cell(md, MEMBERREF, row, 1)), gen: [], argc: argCount(md, cell(md, MEMBERREF, row, 2)) }
  }
  if (t === METHODSPEC && row <= md.rows[METHODSPEC]) {
    const m = cell(md, METHODSPEC, row, 0)
    const c = blob(md, cell(md, METHODSPEC, row, 1))
    if (md.buf[c.p++] !== 0x0a) return null
    const n = compressed(md.buf, c)
    const gen: TypeSig[] = []
    for (let i = 0; i < n && i < 8; i++) gen.push(subst(readTypeSig(md, c), f.gen))
    const base = decodeCall(md, (m & 1 ? MEMBERREF : METHOD) * 0x1000000 + (m >>> 1), f)
    return base ? { ...base, gen } : null
  }
  return null
}

function run(md: Md, m: number, f: Frame, hooks: Hooks) {
  const body = methodBody(md, m)
  if (!body || f.depth > 4 || f.chain.includes(m)) return
  const chain = [...f.chain, m]
  const [start, end] = body
  const buf = md.buf
  const dv = md.dv
  let recent: Val[] = []
  let pendingZero: string | null = null
  const push = (v: Val) => {
    recent.push(v)
    if (recent.length > 24) recent.splice(0, recent.length - 24)
  }
  const arg = (i: number) => push(f.args[i] ?? OTHER)
  const local = () => {
    push(pendingZero ? { k: 'zero', type: pendingZero } : OTHER)
    pendingZero = null
  }
  let p = start
  while (p < end) {
    let op = buf[p++]
    if (op === 0xfe) {
      op = buf[p++]
      if (op === 0x09 || op === 0x0a) arg(dv.getUint16(p, true)) // ldarg, ldarga
      else if (op === 0x0c) local() // ldloc
      else if (op === 0x15) {
        // initobj: `default(T)` is built in a local that is loaded right after
        recent.pop()
        pendingZero = tokenType(md, dv.getUint32(p, true)).name ?? null
      } else if (op === 0x0e) recent = [] // stloc
      else if (op >= 0x01 && op <= 0x05) {
        recent.splice(-2, 2)
        push(OTHER)
      } else if (op !== 0x16 && op !== 0x14) push(OTHER) // constrained. / tail. are prefixes
      p += op < 32 ? TWO_BYTE_OPERAND[op] : 0
      continue
    }
    const n = OPERAND[op]
    if (n === 0xff) {
      p += 4 + dv.getUint32(p, true) * 4
      recent = []
      continue
    }
    if (op >= 0x02 && op <= 0x05) arg(op - 0x02)
    else if (op === 0x0e || op === 0x0f) arg(buf[p])
    else if ((op >= 0x06 && op <= 0x09) || op === 0x11) local()
    else if ((op >= 0x0a && op <= 0x0d) || op === 0x13 || op === 0x2a || (op >= 0x2b && op <= 0x44) || op === 0xdc || op === 0xdd || op === 0xde) recent = []
    else if (op >= 0x15 && op <= 0x1e) push({ k: 'num', v: op - 0x16 })
    else if (op === 0x1f) push({ k: 'num', v: dv.getInt8(p) })
    else if (op === 0x20) push({ k: 'num', v: dv.getInt32(p, true) })
    else if (op === 0x21) push({ k: 'num', v: Number(dv.getBigInt64(p, true)) })
    else if (op === 0x22) push({ k: 'num', v: dv.getFloat32(p, true), f32: true })
    else if (op === 0x23) push({ k: 'num', v: dv.getFloat64(p, true) })
    else if (op === 0x14) push({ k: 'null' })
    else if (op === 0x72) push({ k: 'str', v: userString(md, dv.getUint32(p, true) & 0xffffff) ?? '' })
    else if (op === 0x25) push(recent[recent.length - 1] ?? OTHER) // dup
    else if (op === 0x26) recent.pop() // pop
    else if (op === 0x8c || op === 0xa5 || op === 0x00) {
      // box / unbox.any / nop keep the value
    } else if ((op >= 0x67 && op <= 0x6e) || op === 0x76 || (op >= 0xd1 && op <= 0xd3)) {
      const last = recent[recent.length - 1]
      if (last?.k === 'num') recent[recent.length - 1] = { ...last, f32: op === 0x6b ? true : op === 0x6c ? false : last.f32 }
    } else if (op === 0x65) {
      // neg
      const last = recent[recent.length - 1]
      if (last?.k === 'num') recent[recent.length - 1] = { ...last, v: -last.v }
    } else if (op >= 0x58 && op <= 0x64) {
      recent.splice(-2, 2)
      push(OTHER)
    } else if (op === 0x7b || op === 0x7c || op === 0x7e || op === 0x7f) {
      // ldfld / ldflda pop the object they read from
      if (op === 0x7b || op === 0x7c) recent.pop()
      const tok = dv.getUint32(p, true)
      push(tok >>> 24 === FIELD ? { k: 'field', row: tok & 0xffffff, addr: op === 0x7c || op === 0x7f } : OTHER)
    } else if (op === 0x7d || op === 0x80) {
      const tok = dv.getUint32(p, true)
      if (tok >>> 24 === FIELD) hooks.store?.(tok & 0xffffff, recent[recent.length - 1])
      recent = []
    } else if ((op === 0x28 || op === 0x6f || op === 0x73) && p + 4 <= end) {
      const c = decodeCall(md, dv.getUint32(p, true), f)
      if (!c) recent = []
      else if (op === 0x73) {
        // new Color(r, g, b), new IntRange(a, b) …
        const argc = Math.max(0, c.argc - 1)
        const args = argc ? recent.slice(-argc) : []
        recent.splice(recent.length - args.length, args.length)
        if (!c.local && STRUCTS[c.owner] && args.length === argc && args.every((a) => a.k === 'num')) {
          push({ k: 'struct', type: c.owner, nums: args.map((a) => (a as { v: number }).v) })
        } else push(OTHER)
      } else if (!c.local && STRUCTS[c.owner] && c.name.startsWith('get_') && c.argc === 0) {
        push({ k: 'named', type: c.owner, name: c.name.slice(4) })
      } else if (!c.local && TRANSPARENT.has(c.name)) {
        // the value flows on into the next call
      } else {
        hooks.call?.(c, recent)
        if (c.local && hooks.follow !== false) {
          const args = c.argc ? recent.slice(-c.argc) : []
          while (args.length < c.argc) args.unshift(OTHER)
          run(md, c.method, { args, gen: c.gen, depth: f.depth + 1, chain }, hooks)
        }
        recent = []
      }
    } else if (op === 0x29) recent = []
    else push(OTHER)
    p += n
  }
}

// ---------------------------------------------------------------------------
// Values

// .NET writes a float with the fewest digits that read back to the same value.
function formatFloat(v: number, f32: boolean): string {
  if (!Number.isFinite(v)) return String(v)
  if (f32) v = Math.fround(v)
  for (let p = 1; p <= 17; p++) {
    const s = Number(v.toPrecision(p))
    if ((f32 ? Math.fround(s) : s) === v) return String(s).replace('e', 'E').replace(/E\+?(-?)(\d)$/, 'E$10$2')
  }
  return String(v)
}

const COLORS: Record<string, number[]> = {
  white: [1, 1, 1, 1], black: [0, 0, 0, 1], red: [1, 0, 0, 1], green: [0, 1, 0, 1], blue: [0, 0, 1, 1], clear: [0, 0, 0, 0],
  gray: [0.5, 0.5, 0.5, 1], grey: [0.5, 0.5, 0.5, 1], yellow: [1, 0.92156863, 0.015686275, 1], cyan: [0, 1, 1, 1], magenta: [1, 0, 1, 1],
}
const NAMED_NUMS: Record<string, number[]> = { zero: [0, 0, 0], one: [1, 1, 1], Zero: [0, 0, 0], One: [1, 1, 1], ZeroToOne: [0, 1] }

const structKind = (type: string): SettingSchema['type'] | null =>
  type === 'UnityEngine.Color' ? 'color' : type === 'Verse.IntRange' ? 'intRange' : type === 'Verse.FloatRange' ? 'floatRange' : STRUCTS[type] ? 'vector' : null

function formatStruct(type: string, nums: number[]): string {
  if (type === 'UnityEngine.Color') {
    const c = nums.length === 3 ? [...nums, 1] : [...nums, 0, 0, 0, 0].slice(0, 4)
    return `RGBA(${c.map((x) => x.toFixed(3)).join(', ')})`
  }
  if (type === 'Verse.IntRange') return `${Math.trunc(nums[0] ?? 0)}~${Math.trunc(nums[1] ?? 0)}`
  if (type === 'Verse.FloatRange') return `${formatFloat(nums[0] ?? 0, true)}~${formatFloat(nums[1] ?? 0, true)}`
  const dims = type.endsWith('2') ? 2 : 3
  const ints = type.startsWith('Verse.IntVec')
  return `(${[...nums, 0, 0, 0].slice(0, dims).map((x) => (ints ? String(Math.trunc(x)) : formatFloat(x, true))).join(', ')})`
}

function structValue(v: Val, type: string): string | undefined {
  if (v.k === 'struct' && v.type === type) return formatStruct(type, v.nums)
  if (v.k === 'zero' && v.type === type) return formatStruct(type, [0, 0, 0, 0])
  if (v.k === 'named' && v.type === type) {
    const nums = type === 'UnityEngine.Color' ? COLORS[v.name] : NAMED_NUMS[v.name]
    return nums ? formatStruct(type, nums) : undefined
  }
  return undefined
}

const PRIM: Record<number, 'bool' | 'int' | 'float' | 'string'> = {
  0x02: 'bool', 0x04: 'int', 0x05: 'int', 0x06: 'int', 0x07: 'int', 0x08: 'int', 0x09: 'int', 0x0a: 'int', 0x0b: 'int',
  0x0c: 'float', 0x0d: 'float', 0x0e: 'string',
}

class Reader {
  private enums = new Map<string, [number, string][] | null>()
  private inits = new Map<number, Map<number, Val>>()
  private md: Md
  private resolveEnum?: EnumResolver

  constructor(md: Md, resolveEnum?: EnumResolver) {
    this.md = md
    this.resolveEnum = resolveEnum
  }

  enumOf(t: TypeSig): [number, string][] | null {
    if (t.el !== 0x11 || !t.name) return null
    if (!this.enums.has(t.name)) this.enums.set(t.name, t.tag === 0 ? enumMembers(this.md, t.row!) : t.tag === 1 ? this.resolveEnum?.(t.name) ?? null : null)
    return this.enums.get(t.name)!
  }

  elem(t: TypeSig): SettingElem {
    const prim = PRIM[t.el]
    if (prim) return { type: prim }
    const e = this.enumOf(t)
    if (e) return { type: 'enum', options: [...new Set(e.map(([, n]) => n))] }
    if (t.el === 0x12 && t.name && (t.name.endsWith('Def') || (t.tag === 0 && derivesFrom(this.md, t.row!, 'Verse.Def')))) return { type: 'def' }
    return { type: 'other' }
  }

  // Field initializers, from constructors and static constructors.
  init(field: number): Val | undefined {
    const owner = fieldOwner(this.md, field)
    if (!owner) return undefined
    let map = this.inits.get(owner)
    if (!map) {
      const m = (map = new Map<number, Val>())
      for (const ctor of [...methodsNamed(this.md, owner, '.cctor'), ...methodsNamed(this.md, owner, '.ctor')]) {
        run(this.md, ctor, { args: [], gen: [], depth: 3, chain: [] }, {
          follow: false,
          store: (f, v) => {
            if (v && v.k !== 'other' && v.k !== 'field' && !m.has(f)) m.set(f, v)
          },
        })
      }
      this.inits.set(owner, map)
    }
    return map.get(field)
  }

  // Scribe_Values.Look<T>(ref value, label, defaultValue)
  value(label: string, t: TypeSig, def: Val | undefined): SettingSchema | null {
    if (def?.k === 'field' && !def.addr) def = this.init(def.row)
    const unknown = (type: SettingSchema['type'], extra: Partial<SettingSchema> = {}): SettingSchema => ({ label, type, def: null, defUnknown: true, ...extra })
    const prim = PRIM[t.el]
    if (prim) {
      if (!def) return unknown(prim)
      if (prim === 'bool') return def.k === 'num' ? { label, type: prim, def: def.v ? 'True' : 'False' } : unknown(prim)
      if (prim === 'int') return def.k === 'num' ? { label, type: prim, def: String(Math.trunc(def.v)) } : unknown(prim)
      if (prim === 'float') return def.k === 'num' ? { label, type: prim, def: formatFloat(def.v, !!def.f32 || t.el === 0x0c) } : unknown(prim)
      return def.k === 'str' ? { label, type: prim, def: def.v } : def.k === 'null' ? { label, type: prim, def: null } : unknown(prim)
    }
    const e = this.enumOf(t)
    if (e) {
      const options = [...new Set(e.map(([, n]) => n))]
      if (def?.k !== 'num') return unknown('enum', { options })
      const v = def.v
      return { label, type: 'enum', def: e.find(([x]) => x === v)?.[1] ?? String(v), options }
    }
    const kind = t.el === 0x11 && t.name ? structKind(t.name) : null
    if (kind) {
      const v = def && structValue(def, t.name!)
      return v !== undefined ? { label, type: kind, def: v } : unknown(kind)
    }
    return null
  }
}

// ---------------------------------------------------------------------------
// Settings (ExposeData) and labels (DoSettingsWindowContents)

const strOf = (v?: Val) => (v?.k === 'str' ? v.v : undefined)

function exposeData(md: Md, rd: Reader, row: number, out: SettingSchema[], fields: Map<number, SettingSchema>, depth = 0) {
  if (depth > 3) return
  // Open Scribe.EnterNode blocks; settings inside them go into a group.
  const nodes: SettingSchema[][] = [out]
  const add = (e: SettingSchema, field?: number) => {
    const list = nodes[nodes.length - 1]
    if (list.some((x) => x.label === e.label)) return
    list.push(e)
    if (field) fields.set(field, e)
  }
  const hooks: Hooks = {
    call(c, recent) {
      if (c.local || !c.owner.startsWith('Verse.Scribe')) return
      if (c.owner === 'Verse.Scribe') {
        if (c.name === 'EnterNode') {
          const label = strOf(recent[recent.length - 1])
          const list = nodes[nodes.length - 1]
          let g = label ? list.find((x) => x.label === label && x.type === 'group') : undefined
          if (label && !g) list.push((g = { label, type: 'group', def: null, children: [] }))
          nodes.push(g?.children ?? [])
        } else if (c.name === 'ExitNode' && nodes.length > 1) nodes.pop()
        return
      }
      if (c.name !== 'Look') return
      // The arguments start with a reference to the field being saved, then its label.
      let at = -1
      for (let i = recent.length - 2; i >= 0; i--) {
        const v = recent[i]
        if (v.k === 'field' && v.addr && strOf(recent[i + 1]) !== undefined) {
          at = i
          break
        }
      }
      const field = at >= 0 ? (recent[at] as { row: number }).row : undefined
      const label = at >= 0 ? strOf(recent[at + 1]) : c.owner === 'Verse.Scribe_Values' ? strOf(recent[recent.length - 3]) : undefined
      if (!label) return
      if (c.owner === 'Verse.Scribe_Values' && c.gen[0]) {
        const def = at >= 0 ? recent[at + 2] : recent[recent.length - 2]
        const e = rd.value(label, c.gen[0], def && def.k !== 'other' ? def : undefined)
        if (e) add(e, field)
      } else if (c.owner === 'Verse.Scribe_Collections' && c.gen.length) {
        if (c.gen.length === 1) add({ label, type: 'list', def: null, elem: rd.elem(c.gen[0]) }, field)
        else add({ label, type: 'dict', def: null, key: rd.elem(c.gen[0]), elem: rd.elem(c.gen[1]) }, field)
      } else if (c.owner === 'Verse.Scribe_Defs' && c.gen[0]) {
        add({ label, type: 'string', def: null, elem: { type: 'def' } }, field)
      } else if (c.owner === 'Verse.Scribe_Deep' && c.gen[0]?.el === 0x12 && c.gen[0].tag === 0) {
        // A nested settings object from this mod; its own ExposeData writes inside the label.
        const children: SettingSchema[] = []
        exposeData(md, rd, c.gen[0].row!, children, fields, depth + 1)
        if (children.length) add({ label, type: 'group', def: null, children }, field)
      }
    },
  }
  for (let t = row, guard = 0; t && guard < 16; guard++) {
    for (const m of methodsNamed(md, t, 'ExposeData')) run(md, m, { args: [], gen: [], depth, chain: [] }, hooks)
    const ext = extendsInfo(md, t)
    t = ext && ext.tag === 0 ? ext.row : 0
  }
}

const UI_LABEL = /^(Label|LabelDouble|SubLabel|Heading|SectionHeader)/
const UI_VALUE = /slider|numeric|adjust|textfield|entry|spin|range/i
const usableText = (s: string) => /\p{L}{2}/u.test(s) && s.trim().length > 1

function settingsWindow(md: Md, row: number, fields: Map<number, SettingSchema>) {
  let lastLabel: string | undefined
  let labelAge = 9
  const hooks: Hooks = {
    call(c, recent) {
      if (c.local) return
      labelAge++
      const strs = recent.filter((v): v is { k: 'str'; v: string } => v.k === 'str' && usableText(v.v))
      const hits = recent.filter((v): v is { k: 'field'; row: number; addr: boolean } => v.k === 'field' && fields.has(v.row))
      if (hits.length === 1) {
        const at = recent.indexOf(hits[0])
        const e = fields.get(hits[0].row)!
        if (!e.title) {
          const title = strs[0]?.v ?? (labelAge <= 2 && UI_VALUE.test(c.name) ? lastLabel : undefined)
          if (title) e.title = title
          if (strs[1]) e.tip = strs[1].v
        }
        if ((e.type === 'int' || e.type === 'float') && /slider|range/i.test(c.name) && e.min === undefined) {
          const nums = recent.slice(at + 1).filter((v): v is { k: 'num'; v: number; f32?: boolean } => v.k === 'num')
          if (nums.length >= 2 && nums[0].v < nums[1].v) {
            e.min = Number(formatFloat(nums[0].v, !!nums[0].f32))
            e.max = Number(formatFloat(nums[1].v, !!nums[1].f32))
          }
        }
      } else if (UI_LABEL.test(c.name) && strs.length) {
        lastLabel = strs[0].v
        labelAge = 0
      }
    },
  }
  for (const m of methodsNamed(md, row, 'DoSettingsWindowContents')) run(md, m, { args: [], gen: [], depth: 0, chain: [] }, hooks)
}

function scan(md: Md, resolveEnum?: EnumResolver): AssemblySettings {
  const rd = new Reader(md, resolveEnum)
  const schemas: Record<string, SettingSchema[]> = {}
  const mods: AssemblySettings['mods'] = []
  const fields = new Map<number, SettingSchema>()
  const modRows: number[] = []
  for (let r = 1; r <= md.rows[TYPEDEF]; r++) {
    if (derivesFrom(md, r, 'Verse.ModSettings')) {
      const entries: SettingSchema[] = []
      exposeData(md, rd, r, entries, fields)
      schemas[typeDefName(md, r)] = entries
    } else if (derivesFrom(md, r, 'Verse.Mod')) {
      modRows.push(r)
      const settingsClass = getSettingsCall(md, r)
      if (settingsClass) mods.push({ modClass: str(md, cell(md, TYPEDEF, r, 1)), settingsClass })
    }
  }
  for (const r of modRows) settingsWindow(md, r, fields)
  return { mods, schemas }
}

// Finds GetSettings<T>() inside a Mod subclass, which names its settings class.
function getSettingsCall(md: Md, row: number): string | null {
  let found: string | null = null
  for (const m of methodsOf(md, row)) {
    run(md, m, { args: [], gen: [], depth: 4, chain: [] }, {
      follow: false,
      call(c) {
        if (!found && !c.local && c.name === 'GetSettings' && c.gen[0]?.el === 0x12 && c.gen[0].name) found = c.gen[0].name
      },
    })
    if (found) break
  }
  return found
}
