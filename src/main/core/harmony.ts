// Read-only ECMA-335 metadata reader: assembly identity, references, namespaces and
// Harmony patches (attribute-declared, plus best-effort manual Harmony.Patch calls).
// Nothing is ever loaded or executed; any malformed input yields null.
import { readFileSync } from 'node:fs'

export type PatchKind = 'prefix' | 'postfix' | 'transpiler' | 'finalizer' | 'manual' | 'unknown'

export interface HarmonyPatch {
  targetType: string
  targetMember: string | null
  kind: PatchKind
  patchClass: string
}

export interface AssemblyInfo {
  name: string
  version: string
  references: string[]
  namespaces: string[]
  patches: HarmonyPatch[]
  usesHarmony: boolean
}

export function readAssembly(filePath: string): AssemblyInfo | null {
  try {
    return readAssemblyBuffer(readFileSync(filePath))
  } catch {
    return null
  }
}

export function readAssemblyBuffer(buf: Uint8Array): AssemblyInfo | null {
  try {
    const md = openMetadata(buf)
    return md ? analyze(md) : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Metadata tables

const MODULE = 0x00, TYPEREF = 0x01, TYPEDEF = 0x02, FIELD = 0x04
const METHODPTR = 0x05, METHOD = 0x06, PARAM = 0x08, MEMBERREF = 0x0a, CUSTOMATTR = 0x0c
const EVENT = 0x14, PROPERTY = 0x17, MODULEREF = 0x1a, TYPESPEC = 0x1b
const ASSEMBLY = 0x20, ASSEMBLYREF = 0x23, FILE = 0x26, EXPORTEDTYPE = 0x27
const MANIFESTRES = 0x28, NESTEDCLASS = 0x29, GENERICPARAM = 0x2a, METHODSPEC = 0x2b
const GENPARAMCONSTRAINT = 0x2c, STANDALONESIG = 0x11, DECLSECURITY = 0x0e
const INTERFACEIMPL = 0x09
const NTABLES = 0x2d

const utf8 = new TextDecoder('utf-8')
const utf16 = new TextDecoder('utf-16le')

interface Md {
  buf: Uint8Array
  dv: DataView
  sections: number[] // [va, vsize, rawPtr, rawSize]*
  strOff: number
  strEnd: number
  blobOff: number
  blobEnd: number
  usOff: number
  usEnd: number
  rows: Uint32Array
  tabOff: number[]
  rowSize: number[]
  colOff: number[][]
  colW: number[][]
  strCache: Map<number, string>
  typeDefNames: (string | undefined)[]
  typeRefNames: (string | undefined)[]
  enclosing: Int32Array | null
  owners: Int32Array | null
}

function rvaToOff(md: { sections: number[]; buf: Uint8Array }, rva: number): number {
  const s = md.sections
  for (let i = 0; i < s.length; i += 4) {
    const va = s[i], size = Math.max(s[i + 1], s[i + 3])
    if (rva >= va && rva < va + size) {
      const off = rva - va + s[i + 2]
      return off < md.buf.length ? off : -1
    }
  }
  return -1
}

function openMetadata(buf: Uint8Array): Md | null {
  if (buf.length < 0x100 || buf[0] !== 0x4d || buf[1] !== 0x5a) return null
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const pe = dv.getUint32(0x3c, true)
  if (pe + 24 > buf.length || dv.getUint32(pe, true) !== 0x00004550) return null
  const nSections = dv.getUint16(pe + 6, true)
  const optSize = dv.getUint16(pe + 20, true)
  const opt = pe + 24
  const magic = dv.getUint16(opt, true)
  let dirs: number, nDirs: number
  if (magic === 0x10b) { dirs = opt + 96; nDirs = dv.getUint32(opt + 92, true) }
  else if (magic === 0x20b) { dirs = opt + 112; nDirs = dv.getUint32(opt + 108, true) }
  else return null
  if (nDirs < 15) return null
  const cliRva = dv.getUint32(dirs + 14 * 8, true)
  if (!cliRva) return null

  const sections: number[] = []
  const secTab = opt + optSize
  for (let i = 0; i < nSections && i < 96; i++) {
    const s = secTab + i * 40
    sections.push(dv.getUint32(s + 12, true), dv.getUint32(s + 8, true), dv.getUint32(s + 20, true), dv.getUint32(s + 16, true))
  }
  const ctx = { sections, buf }
  const cli = rvaToOff(ctx, cliRva)
  if (cli < 0) return null
  const root = rvaToOff(ctx, dv.getUint32(cli + 8, true))
  if (root < 0 || dv.getUint32(root, true) !== 0x424a5342) return null

  const verLen = dv.getUint32(root + 12, true)
  let p = root + 16 + verLen
  const nStreams = dv.getUint16(p + 2, true)
  p += 4
  let tbl = -1, strOff = 0, strSize = 0, blobOff = 0, blobSize = 0, usOff = 0, usSize = 0
  let uncompressed = false, jtd = false
  for (let i = 0; i < nStreams && i < 16; i++) {
    const off = root + dv.getUint32(p, true)
    const size = dv.getUint32(p + 4, true)
    p += 8
    let name = ''
    while (p < buf.length && buf[p] !== 0 && name.length < 32) name += String.fromCharCode(buf[p++])
    p = root + ((p - root + 4) & ~3) // skip NUL + pad to 4
    if (name === '#~' || name === '#-') { tbl = off; uncompressed = name === '#-' }
    else if (name === '#Strings') { strOff = off; strSize = size }
    else if (name === '#Blob') { blobOff = off; blobSize = size }
    else if (name === '#US') { usOff = off; usSize = size }
    else if (name === '#JTD') jtd = true
  }
  if (tbl < 0) return null

  const heapSizes = buf[tbl + 6]
  const big = jtd && uncompressed
  const sW = big || heapSizes & 1 ? 4 : 2
  const gW = big || heapSizes & 2 ? 4 : 2
  const bW = big || heapSizes & 4 ? 4 : 2
  const validLo = dv.getUint32(tbl + 8, true), validHi = dv.getUint32(tbl + 12, true)
  const rows = new Uint32Array(64)
  p = tbl + 24
  for (let i = 0; i < 64; i++) {
    const set = i < 32 ? (validLo >>> i) & 1 : (validHi >>> (i - 32)) & 1
    if (set) { rows[i] = dv.getUint32(p, true); p += 4 }
  }
  if (heapSizes & 0x40) p += 4 // extra data

  const colW = schema(rows, sW, gW, bW, big)
  const tabOff: number[] = []
  const rowSize: number[] = []
  const colOff: number[][] = []
  for (let t = 0; t < NTABLES; t++) {
    const w = colW[t]
    const offs: number[] = []
    let sz = 0
    for (const x of w) { offs.push(sz); sz += x }
    colOff.push(offs)
    rowSize.push(sz)
    tabOff.push(p)
    p += rows[t] * sz
  }
  if (p > buf.length) return null

  return {
    buf, dv, sections,
    strOff, strEnd: Math.min(strOff + strSize, buf.length),
    blobOff, blobEnd: Math.min(blobOff + blobSize, buf.length),
    usOff, usEnd: Math.min(usOff + usSize, buf.length),
    rows, tabOff, rowSize, colOff, colW,
    strCache: new Map(),
    typeDefNames: [], typeRefNames: [],
    enclosing: null,
    owners: null,
  }
}

function schema(rows: Uint32Array, s: number, g: number, b: number, big: boolean): number[][] {
  const idx = (t: number) => (big || rows[t] >= 0x10000 ? 4 : 2)
  const coded = (bits: number, tables: number[]) => {
    if (big) return 4
    let max = 0
    for (const t of tables) if (t >= 0 && rows[t] > max) max = rows[t]
    return max < 1 << (16 - bits) ? 2 : 4
  }
  const typeDefOrRef = coded(2, [TYPEDEF, TYPEREF, TYPESPEC])
  const hasConstant = coded(2, [FIELD, PARAM, PROPERTY])
  const hasCA = coded(5, [METHOD, FIELD, TYPEREF, TYPEDEF, PARAM, INTERFACEIMPL, MEMBERREF, MODULE,
    DECLSECURITY, PROPERTY, EVENT, STANDALONESIG, MODULEREF, TYPESPEC, ASSEMBLY, ASSEMBLYREF, FILE,
    EXPORTEDTYPE, MANIFESTRES, GENERICPARAM, GENPARAMCONSTRAINT, METHODSPEC])
  const hasFieldMarshal = coded(1, [FIELD, PARAM])
  const hasDeclSecurity = coded(2, [TYPEDEF, METHOD, ASSEMBLY])
  const memberRefParent = coded(3, [TYPEDEF, TYPEREF, MODULEREF, METHOD, TYPESPEC])
  const hasSemantics = coded(1, [EVENT, PROPERTY])
  const methodDefOrRef = coded(1, [METHOD, MEMBERREF])
  const memberForwarded = coded(1, [FIELD, METHOD])
  const implementation = coded(2, [FILE, ASSEMBLYREF, EXPORTEDTYPE])
  const caType = coded(3, [-1, -1, METHOD, MEMBERREF, -1])
  const resolutionScope = coded(2, [MODULE, MODULEREF, ASSEMBLYREF, TYPEREF])
  const typeOrMethodDef = coded(1, [TYPEDEF, METHOD])
  return [
    [2, s, g, g, g], // 00 Module
    [resolutionScope, s, s], // 01 TypeRef
    [4, s, s, typeDefOrRef, idx(FIELD), idx(METHOD)], // 02 TypeDef
    [idx(FIELD)], // 03 FieldPtr
    [2, s, b], // 04 Field
    [idx(METHOD)], // 05 MethodPtr
    [4, 2, 2, s, b, idx(PARAM)], // 06 MethodDef
    [idx(PARAM)], // 07 ParamPtr
    [2, 2, s], // 08 Param
    [idx(TYPEDEF), typeDefOrRef], // 09 InterfaceImpl
    [memberRefParent, s, b], // 0A MemberRef
    [2, hasConstant, b], // 0B Constant
    [hasCA, caType, b], // 0C CustomAttribute
    [hasFieldMarshal, b], // 0D FieldMarshal
    [2, hasDeclSecurity, b], // 0E DeclSecurity
    [2, 4, idx(TYPEDEF)], // 0F ClassLayout
    [4, idx(FIELD)], // 10 FieldLayout
    [b], // 11 StandAloneSig
    [idx(TYPEDEF), idx(EVENT)], // 12 EventMap
    [idx(EVENT)], // 13 EventPtr
    [2, s, typeDefOrRef], // 14 Event
    [idx(TYPEDEF), idx(PROPERTY)], // 15 PropertyMap
    [idx(PROPERTY)], // 16 PropertyPtr
    [2, s, b], // 17 Property
    [2, idx(METHOD), hasSemantics], // 18 MethodSemantics
    [idx(TYPEDEF), methodDefOrRef, methodDefOrRef], // 19 MethodImpl
    [s], // 1A ModuleRef
    [b], // 1B TypeSpec
    [2, memberForwarded, s, idx(MODULEREF)], // 1C ImplMap
    [4, idx(FIELD)], // 1D FieldRVA
    [4, 4], // 1E EncLog
    [4], // 1F EncMap
    [4, 2, 2, 2, 2, 4, b, s, s], // 20 Assembly
    [4], // 21 AssemblyProcessor
    [4, 4, 4], // 22 AssemblyOS
    [2, 2, 2, 2, 4, b, s, s, b], // 23 AssemblyRef
    [4, idx(ASSEMBLYREF)], // 24 AssemblyRefProcessor
    [4, 4, 4, idx(ASSEMBLYREF)], // 25 AssemblyRefOS
    [4, s, b], // 26 File
    [4, 4, s, s, implementation], // 27 ExportedType
    [4, 4, s, implementation], // 28 ManifestResource
    [idx(TYPEDEF), idx(TYPEDEF)], // 29 NestedClass
    [2, 2, typeOrMethodDef, s], // 2A GenericParam
    [methodDefOrRef, b], // 2B MethodSpec
    [idx(GENERICPARAM), typeDefOrRef], // 2C GenericParamConstraint
  ]
}

// 1-based row
function cell(md: Md, t: number, row: number, col: number): number {
  const off = md.tabOff[t] + (row - 1) * md.rowSize[t] + md.colOff[t][col]
  return md.colW[t][col] === 2 ? md.dv.getUint16(off, true) : md.dv.getUint32(off, true)
}

function str(md: Md, i: number): string {
  if (i === 0) return ''
  const hit = md.strCache.get(i)
  if (hit !== undefined) return hit
  const start = md.strOff + i
  if (start >= md.strEnd) return ''
  let e = start
  while (e < md.strEnd && md.buf[e] !== 0) e++
  const s = utf8.decode(md.buf.subarray(start, e))
  md.strCache.set(i, s)
  return s
}

function userString(md: Md, i: number): string | null {
  const c = { p: md.usOff + i }
  if (c.p >= md.usEnd) return null
  const len = compressed(md.buf, c)
  if (len < 1 || c.p + len > md.usEnd) return len === 0 ? '' : null
  return utf16.decode(md.buf.subarray(c.p, c.p + (len & ~1)))
}

interface Cur { p: number }

function compressed(buf: Uint8Array, c: Cur): number {
  const b0 = buf[c.p]
  if (b0 === undefined) throw new RangeError('eof')
  if ((b0 & 0x80) === 0) { c.p += 1; return b0 }
  if ((b0 & 0xc0) === 0x80) { const v = ((b0 & 0x3f) << 8) | buf[c.p + 1]; c.p += 2; return v }
  if ((b0 & 0xe0) === 0xc0) {
    const v = ((b0 & 0x1f) * 0x1000000) + (buf[c.p + 1] << 16) + (buf[c.p + 2] << 8) + buf[c.p + 3]
    c.p += 4
    return v
  }
  throw new RangeError('bad compressed int')
}

// returns cursor at blob data start, plus end offset
function blob(md: Md, i: number): { p: number; end: number } {
  const c = { p: md.blobOff + i }
  if (c.p >= md.blobEnd) throw new RangeError('blob')
  const len = compressed(md.buf, c)
  const end = c.p + len
  if (end > md.blobEnd) throw new RangeError('blob')
  return { p: c.p, end }
}

// ---------------------------------------------------------------------------
// Type names

function enclosingOf(md: Md): Int32Array {
  if (md.enclosing) return md.enclosing
  const enc = new Int32Array(md.rows[TYPEDEF] + 1)
  for (let r = 1; r <= md.rows[NESTEDCLASS]; r++) {
    const nested = cell(md, NESTEDCLASS, r, 0)
    if (nested < enc.length) enc[nested] = cell(md, NESTEDCLASS, r, 1)
  }
  return (md.enclosing = enc)
}

function typeDefName(md: Md, row: number, depth = 0): string {
  if (row < 1 || row > md.rows[TYPEDEF]) return '?'
  const hit = md.typeDefNames[row]
  if (hit !== undefined) return hit
  const name = str(md, cell(md, TYPEDEF, row, 1))
  const ns = str(md, cell(md, TYPEDEF, row, 2))
  const outer = enclosingOf(md)[row]
  let full: string
  if (outer && depth < 16) full = typeDefName(md, outer, depth + 1) + '+' + name
  else full = ns ? ns + '.' + name : name
  md.typeDefNames[row] = full
  return full
}

function typeRefName(md: Md, row: number, depth = 0): string {
  if (row < 1 || row > md.rows[TYPEREF]) return '?'
  const hit = md.typeRefNames[row]
  if (hit !== undefined) return hit
  const scope = cell(md, TYPEREF, row, 0)
  const name = str(md, cell(md, TYPEREF, row, 1))
  const ns = str(md, cell(md, TYPEREF, row, 2))
  let full: string
  if ((scope & 3) === 3 && depth < 16) full = typeRefName(md, scope >>> 2, depth + 1) + '+' + name
  else full = ns ? ns + '.' + name : name
  md.typeRefNames[row] = full
  return full
}

// TypeDefOrRef (2-bit tag) or a raw metadata token
function typeName(md: Md, tag: number, row: number): string {
  if (tag === 0) return typeDefName(md, row)
  if (tag === 1) return typeRefName(md, row)
  if (tag === 2) return typeSpecName(md, row)
  return '?'
}

// Generic instantiation → its generic type definition name
function typeSpecName(md: Md, row: number): string {
  if (row < 1 || row > md.rows[TYPESPEC]) return '?'
  const c = blob(md, cell(md, TYPESPEC, row, 0))
  const b = md.buf[c.p++]
  if (b === 0x15) {
    c.p++ // CLASS / VALUETYPE
    const tok = compressed(md.buf, c)
    if ((tok & 3) !== 2) return typeName(md, tok & 3, tok >>> 2)
  } else if (b === 0x12 || b === 0x11) {
    const tok = compressed(md.buf, c)
    if ((tok & 3) !== 2) return typeName(md, tok & 3, tok >>> 2)
  }
  return '?'
}

function tokenTypeName(md: Md, tok: number): string {
  const t = tok >>> 24, row = tok & 0xffffff
  if (t === TYPEDEF) return typeDefName(md, row)
  if (t === TYPEREF) return typeRefName(md, row)
  if (t === TYPESPEC) return typeSpecName(md, row)
  return '?'
}

// "Verse.Pawn, Assembly-CSharp, Version=..." → "Verse.Pawn"
function stripAssembly(s: string): string {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '[') depth++
    else if (ch === ']') depth--
    else if (ch === ',' && depth === 0) return s.slice(0, i).trim()
  }
  return s.trim()
}

// ---------------------------------------------------------------------------
// Methods

function methodListEnd(md: Md): number {
  return (md.rows[METHODPTR] || md.rows[METHOD]) + 1
}

function methodsOf(md: Md, typeRow: number): number[] {
  const end = methodListEnd(md)
  const a = cell(md, TYPEDEF, typeRow, 5)
  const b = typeRow < md.rows[TYPEDEF] ? cell(md, TYPEDEF, typeRow + 1, 5) : end
  const out: number[] = []
  for (let i = a; i < b && i < end; i++) out.push(md.rows[METHODPTR] ? cell(md, METHODPTR, i, 0) : i)
  return out
}

function methodOwners(md: Md): Int32Array {
  if (md.owners) return md.owners
  const owner = new Int32Array(md.rows[METHOD] + 1)
  for (let t = 1; t <= md.rows[TYPEDEF]; t++) {
    for (const m of methodsOf(md, t)) if (m > 0 && m < owner.length) owner[m] = t
  }
  return (md.owners = owner)
}

// ---------------------------------------------------------------------------
// Custom attribute decoding

type PT =
  | { k: 'prim'; size: number }
  | { k: 'str' }
  | { k: 'type' }
  | { k: 'enum'; name: string }
  | { k: 'obj' }
  | { k: 'arr'; elem: PT }

type Val =
  | { k: 'str'; v: string | null }
  | { k: 'type'; v: string | null }
  | { k: 'enum'; name: string; v: number }
  | { k: 'other' }

const PRIM_SIZE: Record<number, number> = {
  0x02: 1, 0x03: 2, 0x04: 1, 0x05: 1, 0x06: 2, 0x07: 2, 0x08: 4, 0x09: 4,
  0x0a: 8, 0x0b: 8, 0x0c: 4, 0x0d: 8,
}

function readSigType(md: Md, c: Cur): PT | null {
  for (let guard = 0; guard < 16; guard++) {
    const b = md.buf[c.p++]
    if (b === 0x1f || b === 0x20) { compressed(md.buf, c); continue } // custom modifiers
    if (b === 0x01) return { k: 'prim', size: 0 } // void (return type only)
    const size = PRIM_SIZE[b]
    if (size) return { k: 'prim', size }
    if (b === 0x0e) return { k: 'str' }
    if (b === 0x1c) return { k: 'obj' }
    if (b === 0x1d) {
      const elem = readSigType(md, c)
      return elem ? { k: 'arr', elem } : null
    }
    if (b === 0x11 || b === 0x12) {
      const tok = compressed(md.buf, c)
      const name = typeName(md, tok & 3, tok >>> 2)
      if (b === 0x11) return { k: 'enum', name }
      if (name === 'System.Type') return { k: 'type' }
      if (name === 'System.Object') return { k: 'obj' }
      return null
    }
    return null
  }
  return null
}

function ctorParams(md: Md, sigBlob: number): PT[] | null {
  const c = blob(md, sigBlob)
  const cc = md.buf[c.p++]
  if (cc & 0x10) compressed(md.buf, c)
  const n = compressed(md.buf, c)
  if (n > 32) return null
  if (!readSigType(md, c)) return null
  const out: PT[] = []
  for (let i = 0; i < n; i++) {
    const t = readSigType(md, c)
    if (!t) return null
    out.push(t)
  }
  return out
}

function serString(md: Md, c: Cur, end: number): string | null {
  if (md.buf[c.p] === 0xff) { c.p++; return null }
  const len = compressed(md.buf, c)
  if (c.p + len > end) throw new RangeError('serstring')
  const s = utf8.decode(md.buf.subarray(c.p, c.p + len))
  c.p += len
  return s
}

// FieldOrPropType tag (used for boxed object args) → PT
function tagType(md: Md, c: Cur, end: number): PT | null {
  const b = md.buf[c.p++]
  const size = PRIM_SIZE[b]
  if (size) return { k: 'prim', size }
  if (b === 0x0e) return { k: 'str' }
  if (b === 0x50) return { k: 'type' }
  if (b === 0x51) return { k: 'obj' }
  if (b === 0x55) return { k: 'enum', name: serString(md, c, end) ?? '' }
  if (b === 0x1d) {
    const elem = tagType(md, c, end)
    return elem ? { k: 'arr', elem } : null
  }
  return null
}

function readValue(md: Md, c: Cur, end: number, t: PT, out: Val[] | null): boolean {
  switch (t.k) {
    case 'prim':
      c.p += t.size
      out?.push({ k: 'other' })
      break
    case 'str':
      out?.push({ k: 'str', v: serString(md, c, end) })
      return c.p <= end
    case 'type': {
      const s = serString(md, c, end)
      out?.push({ k: 'type', v: s == null ? null : stripAssembly(s) })
      return c.p <= end
    }
    case 'enum':
      // Harmony's enums (MethodType, ArgumentType, PropertyMethod) are all int32
      out?.push({ k: 'enum', name: t.name, v: md.dv.getInt32(c.p, true) })
      c.p += 4
      break
    case 'obj': {
      const inner = tagType(md, c, end)
      if (!inner) return false
      return readValue(md, c, end, inner, out)
    }
    case 'arr': {
      const n = md.dv.getUint32(c.p, true)
      c.p += 4
      out?.push({ k: 'other' })
      if (n === 0xffffffff) break
      if (n > end - c.p) return false
      for (let i = 0; i < n; i++) if (!readValue(md, c, end, t.elem, null)) return false
      break
    }
  }
  return c.p <= end
}

interface PInfo {
  type: string | null
  method: string | null
  methodType: number | null
}

function decodeHarmonyPatch(md: Md, params: PT[], valueBlob: number): PInfo | null {
  const c = blob(md, valueBlob)
  if (c.end - c.p < 2 || md.dv.getUint16(c.p, true) !== 1) return null
  c.p += 2
  const vals: Val[] = []
  for (const t of params) if (!readValue(md, c, c.end, t, vals)) return null

  let type: string | null = null
  const strs: string[] = []
  let methodType: number | null = null
  for (const v of vals) {
    if (v.k === 'type' && type == null && v.v) type = v.v
    else if (v.k === 'str' && v.v != null) strs.push(v.v)
    else if (v.k === 'enum') {
      const short = v.name.slice(v.name.lastIndexOf('.') + 1)
      if (short === 'MethodType') methodType = v.v
      else if (short === 'PropertyMethod') methodType = v.v === 0 ? 1 : 2 // Harmony 1: Getter/Setter
    }
  }
  let method: string | null = null
  if (type != null) method = strs[0] ?? null
  else if (strs.length >= 2) { type = strs[0]; method = strs[1] } // (string typeName, string methodName)
  else method = strs[0] ?? null
  return { type, method, methodType }
}

// ---------------------------------------------------------------------------
// Harmony analysis

const HARMONY_ATTRS = new Set([
  'HarmonyPatch', 'HarmonyPrefix', 'HarmonyPostfix', 'HarmonyTranspiler', 'HarmonyFinalizer', 'HarmonyReversePatch',
])
const KIND_BY_ATTR: Record<string, PatchKind> = {
  HarmonyPrefix: 'prefix', HarmonyPostfix: 'postfix', HarmonyTranspiler: 'transpiler', HarmonyFinalizer: 'finalizer',
}
const KIND_BY_NAME: Record<string, PatchKind> = {
  Prefix: 'prefix', Postfix: 'postfix', Transpiler: 'transpiler', Finalizer: 'finalizer',
}
const NOISE_NAMESPACES = new Set([
  'Microsoft.CodeAnalysis', 'System.Runtime.CompilerServices', 'System.Diagnostics.CodeAnalysis',
])

function isHarmonyNs(ns: string): boolean {
  return ns === 'HarmonyLib' || ns === 'Harmony'
}

interface MethodAttrs {
  infos: PInfo[]
  kind: PatchKind | null
  reverse: boolean
}

function analyze(md: Md): AssemblyInfo {
  let name = '', version = '0.0.0.0'
  if (md.rows[ASSEMBLY] > 0) {
    name = str(md, cell(md, ASSEMBLY, 1, 7))
    version = [1, 2, 3, 4].map((i) => cell(md, ASSEMBLY, 1, i)).join('.')
  } else if (md.rows[MODULE] > 0) {
    name = str(md, cell(md, MODULE, 1, 1)).replace(/\.(dll|exe|netmodule)$/i, '')
  }

  const references: string[] = []
  for (let r = 1; r <= md.rows[ASSEMBLYREF]; r++) references.push(str(md, cell(md, ASSEMBLYREF, r, 6)))

  const nsSet = new Set<string>()
  let lastNs = -1
  for (let r = 1; r <= md.rows[TYPEDEF]; r++) {
    const nsIdx = cell(md, TYPEDEF, r, 2)
    if (nsIdx === lastNs || nsIdx === 0) continue
    lastNs = nsIdx
    const ns = str(md, nsIdx)
    if (ns && ns[0] !== '<' && !NOISE_NAMESPACES.has(ns)) nsSet.add(ns)
  }
  const namespaces = [...nsSet].sort()

  const patches: HarmonyPatch[] = []
  const seen = new Set<string>()
  const emit = (p: HarmonyPatch) => {
    const key = p.targetType + '\u0000' + p.targetMember + '\u0000' + p.kind + '\u0000' + p.patchClass
    if (!seen.has(key)) { seen.add(key); patches.push(p) }
  }
  attributePatches(md, emit)
  manualPatches(md, emit)

  return {
    name, version, references, namespaces, patches,
    usesHarmony: references.includes('0Harmony') || patches.length > 0,
  }
}

function attributePatches(md: Md, emit: (p: HarmonyPatch) => void) {
  // Harmony attribute classes, by TypeRef/TypeDef row (TypeDef when Harmony is merged in)
  const refAttr = new Map<number, string>()
  for (let r = 1; r <= md.rows[TYPEREF]; r++) {
    const n = str(md, cell(md, TYPEREF, r, 1))
    if (HARMONY_ATTRS.has(n) && isHarmonyNs(str(md, cell(md, TYPEREF, r, 2)))) refAttr.set(r, n)
  }
  const defAttr = new Map<number, string>()
  for (let r = 1; r <= md.rows[TYPEDEF]; r++) {
    const n = str(md, cell(md, TYPEDEF, r, 1))
    if (HARMONY_ATTRS.has(n) && isHarmonyNs(str(md, cell(md, TYPEDEF, r, 2)))) defAttr.set(r, n)
  }
  if (!refAttr.size && !defAttr.size) return

  // ctor MemberRef row → attribute name
  const refCtor = new Map<number, string>()
  for (let r = 1; r <= md.rows[MEMBERREF]; r++) {
    const cls = cell(md, MEMBERREF, r, 0)
    const tag = cls & 7, row = cls >>> 3
    const n = tag === 1 ? refAttr.get(row) : tag === 0 ? defAttr.get(row) : undefined
    if (n) refCtor.set(r, n)
  }
  const ownerOf = (m: number) => methodOwners(md)[m] ?? 0

  const classAttrs = new Map<number, PInfo[]>()
  const methodAttrs = new Map<number, MethodAttrs>()
  const paramCache = new Map<number, PT[] | null>()

  for (let r = 1; r <= md.rows[CUSTOMATTR]; r++) {
    const parent = cell(md, CUSTOMATTR, r, 0)
    const ptag = parent & 31
    if (ptag !== 0 && ptag !== 3) continue // MethodDef / TypeDef only
    const ctor = cell(md, CUSTOMATTR, r, 1)
    const ctag = ctor & 7, crow = ctor >>> 3
    let attr: string | undefined
    let sig = 0
    if (ctag === 3) {
      attr = refCtor.get(crow)
      if (attr === 'HarmonyPatch') sig = cell(md, MEMBERREF, crow, 2)
    } else if (ctag === 2 && defAttr.size) {
      attr = defAttr.get(ownerOf(crow))
      if (attr === 'HarmonyPatch') sig = cell(md, METHOD, crow, 4)
    }
    if (!attr) continue

    let info: PInfo | null = null
    if (attr === 'HarmonyPatch') {
      const key = ctag * 0x10000000 + crow
      let params = paramCache.get(key)
      if (params === undefined) {
        try { params = ctorParams(md, sig) } catch { params = null }
        paramCache.set(key, params)
      }
      if (params) {
        try { info = decodeHarmonyPatch(md, params, cell(md, CUSTOMATTR, r, 2)) } catch { info = null }
      }
      info ??= { type: null, method: null, methodType: null }
    }

    const prow = parent >>> 5
    if (ptag === 3) {
      if (info) {
        const list = classAttrs.get(prow)
        if (list) list.push(info)
        else classAttrs.set(prow, [info])
      }
    } else {
      let ma = methodAttrs.get(prow)
      if (!ma) methodAttrs.set(prow, (ma = { infos: [], kind: null, reverse: false }))
      if (info) ma.infos.push(info)
      else if (attr === 'HarmonyReversePatch') ma.reverse = true
      else ma.kind = KIND_BY_ATTR[attr] ?? ma.kind
    }
  }

  const classes = new Set<number>(classAttrs.keys())
  for (const m of methodAttrs.keys()) {
    const o = ownerOf(m)
    if (o) classes.add(o)
  }

  for (const t of [...classes].sort((a, b) => a - b)) {
    const patchClass = typeDefName(md, t)
    const cInfos = classAttrs.get(t) ?? []
    const classTargets = targets(cInfos)
    let found = false
    for (const m of methodsOf(md, t)) {
      const ma = methodAttrs.get(m)
      if (ma?.reverse) continue
      const mname = str(md, cell(md, METHOD, m, 3))
      const kind = ma?.kind ?? KIND_BY_NAME[mname] ?? null
      if (!kind) continue
      const hasMethodInfo = !!ma && ma.infos.length > 0
      if (!cInfos.length && !hasMethodInfo) continue
      const methodTargets = hasMethodInfo ? targets(ma!.infos) : [EMPTY]
      for (const ct of classTargets) {
        for (const mt of methodTargets) {
          const info = merge(ct, mt)
          emit({ targetType: info.type ?? '?', targetMember: memberName(info), kind, patchClass })
          found = true
        }
      }
    }
    if (!found && cInfos.length) {
      for (const ct of classTargets) {
        if (ct.type) emit({ targetType: ct.type, targetMember: memberName(ct), kind: 'unknown', patchClass })
      }
    }
  }
}

const EMPTY: PInfo = { type: null, method: null, methodType: null }

function merge(a: PInfo, b: PInfo): PInfo {
  return {
    type: b.type ?? a.type,
    method: b.method ?? a.method,
    methodType: b.methodType ?? a.methodType,
  }
}

function complete(i: PInfo): boolean {
  return i.type != null && (i.method != null || i.methodType === 3 || i.methodType === 4)
}

// Harmony folds stacked attributes into one target; if several are individually
// complete, report each (common modder intent, and newer Harmony honours it).
function targets(infos: PInfo[]): PInfo[] {
  if (!infos.length) return [EMPTY]
  const full = infos.filter(complete)
  if (full.length < 2) return [infos.reduce(merge, EMPTY)]
  const base = infos.filter((i) => !complete(i)).reduce(merge, EMPTY)
  return full.map((f) => merge(base, f))
}

function memberName(i: PInfo): string | null {
  if (i.methodType === 3) return '.ctor'
  if (i.methodType === 4) return '.cctor'
  if (i.method == null) return null
  if (i.methodType === 1) return 'get_' + i.method
  if (i.methodType === 2) return 'set_' + i.method
  return i.method
}

// ---------------------------------------------------------------------------
// Manual patches: scan IL of methods that call Harmony.Patch for
//   ldtoken T; ...; ldstr "M"; ...; call AccessTools.Method/PropertyGetter/...
// AccessTools results that flow straight into `new HarmonyMethod(...)` are patch
// methods, not targets, and are skipped.

const ACCESS_MEMBERS: Record<string, number> = {
  Method: 0, DeclaredMethod: 0, PropertyGetter: 1, DeclaredPropertyGetter: 1,
  PropertySetter: 2, DeclaredPropertySetter: 2, Constructor: 3, DeclaredConstructor: 3,
  EnumeratorMoveNext: 0, AsyncMoveNext: 0,
}
const REFLECTION_MEMBERS: Record<string, number> = {
  GetMethod: 0, GetProperty: 1, GetConstructor: 3,
}

// operand sizes for one-byte opcodes (0xff = switch)
const OPERAND = new Uint8Array(256)
const TWO_BYTE_OPERAND = new Uint8Array(32)
{
  for (let i = 0x0e; i <= 0x13; i++) OPERAND[i] = 1
  OPERAND[0x1f] = 1
  OPERAND[0x20] = 4; OPERAND[0x21] = 8; OPERAND[0x22] = 4; OPERAND[0x23] = 8
  OPERAND[0x27] = 4; OPERAND[0x28] = 4; OPERAND[0x29] = 4
  for (let i = 0x2b; i <= 0x37; i++) OPERAND[i] = 1
  for (let i = 0x38; i <= 0x44; i++) OPERAND[i] = 4
  OPERAND[0x45] = 0xff
  for (const op of [0x6f, 0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x79, 0x7b, 0x7c, 0x7d, 0x7e, 0x7f, 0x80, 0x81,
    0x8c, 0x8d, 0x8f, 0xa3, 0xa4, 0xa5, 0xc2, 0xc6, 0xd0, 0xdd]) OPERAND[op] = 4
  OPERAND[0xde] = 1
  TWO_BYTE_OPERAND[0x06] = 4; TWO_BYTE_OPERAND[0x07] = 4
  for (let i = 0x09; i <= 0x0e; i++) TWO_BYTE_OPERAND[i] = 2
  TWO_BYTE_OPERAND[0x12] = 1; TWO_BYTE_OPERAND[0x15] = 4; TWO_BYTE_OPERAND[0x16] = 4
  TWO_BYTE_OPERAND[0x19] = 1; TWO_BYTE_OPERAND[0x1c] = 4
}

const OP_CALL = 0x28, OP_CALLVIRT = 0x6f, OP_NEWOBJ = 0x73, OP_LDSTR = 0x72, OP_LDTOKEN = 0xd0

interface Pending {
  type: string
  member: string | null
}

function manualPatches(md: Md, emit: (p: HarmonyPatch) => void) {
  // MemberRef classification: 1 = Harmony.Patch, 2 = AccessTools target lookup,
  // 3 = reflection lookup, 4 = HarmonyMethod ctor
  const role = new Map<number, number>()
  const accessKind = new Map<number, number>()
  let hasPatch = false
  for (let r = 1; r <= md.rows[MEMBERREF]; r++) {
    const cls = cell(md, MEMBERREF, r, 0)
    if ((cls & 7) !== 1) continue
    const trow = cls >>> 3
    const tname = str(md, cell(md, TYPEREF, trow, 1))
    const tns = str(md, cell(md, TYPEREF, trow, 2))
    const mname = str(md, cell(md, MEMBERREF, r, 1))
    if (isHarmonyNs(tns)) {
      if ((tname === 'Harmony' || tname === 'HarmonyInstance') && mname === 'Patch') { role.set(r, 1); hasPatch = true }
      else if (tname === 'AccessTools' && mname in ACCESS_MEMBERS) { role.set(r, 2); accessKind.set(r, ACCESS_MEMBERS[mname]) }
      else if (tname === 'HarmonyMethod' && mname === '.ctor') role.set(r, 4)
    } else if (tns === 'System' && tname === 'Type' && mname in REFLECTION_MEMBERS) {
      role.set(r, 3); accessKind.set(r, REFLECTION_MEMBERS[mname])
    }
  }
  if (!hasPatch) return

  const buf = md.buf
  for (let m = 1; m <= md.rows[METHOD]; m++) {
    const rva = cell(md, METHOD, m, 0)
    if (!rva) continue
    const off = rvaToOff(md, rva)
    if (off < 0) continue
    let code: number, size: number
    const h = buf[off]
    if ((h & 3) === 2) { code = off + 1; size = h >>> 2 }
    else if ((h & 3) === 3) { code = off + (buf[off + 1] >>> 4) * 4; size = md.dv.getUint32(off + 4, true) }
    else continue
    const end = Math.min(code + size, buf.length)

    // quick reject: method must call Harmony.Patch
    let callsPatch = false
    let p = code
    while (p < end) {
      let op = buf[p++]
      let n: number
      if (op === 0xfe) { op = buf[p++]; n = op < 32 ? TWO_BYTE_OPERAND[op] : 0; p += n; continue }
      n = OPERAND[op]
      if (n === 0xff) { const cnt = md.dv.getUint32(p, true); p += 4 + cnt * 4; continue }
      if ((op === OP_CALL || op === OP_CALLVIRT) && p + 4 <= end) {
        const tok = md.dv.getUint32(p, true)
        if (tok >>> 24 === MEMBERREF && role.get(tok & 0xffffff) === 1) { callsPatch = true; break }
      }
      p += n
    }
    if (!callsPatch) continue

    const enclosing = typeDefName(md, methodOwners(md)[m] || 0)
    let lastType: string | null = null
    let lastStr: string | null = null
    let pending: Pending | null = null
    let patchType: string | null = null
    const flush = () => {
      if (pending) emit({ targetType: pending.type, targetMember: pending.member, kind: 'manual', patchClass: patchType ?? enclosing })
      pending = null
      patchType = null
    }
    p = code
    while (p < end) {
      let op = buf[p++]
      if (op === 0xfe) { op = buf[p++]; p += op < 32 ? TWO_BYTE_OPERAND[op] : 0; continue }
      const n = OPERAND[op]
      if (n === 0xff) { const cnt = md.dv.getUint32(p, true); p += 4 + cnt * 4; continue }
      if (n === 4 && p + 4 <= end) {
        const tok = md.dv.getUint32(p, true)
        if (op === OP_LDTOKEN) {
          const tt = tok >>> 24
          if (tt === TYPEDEF || tt === TYPEREF || tt === TYPESPEC) {
            lastType = tokenTypeName(md, tok)
            lastStr = null
            if (pending && !patchType && tt === TYPEDEF) patchType = lastType
          }
        } else if (op === OP_LDSTR) {
          lastStr = userString(md, tok & 0xffffff)
        } else if ((op === OP_CALL || op === OP_CALLVIRT || op === OP_NEWOBJ) && tok >>> 24 === MEMBERREF) {
          const r = role.get(tok & 0xffffff)
          if (r === 2 || r === 3) {
            const target = resolveTarget(lastType, lastStr, accessKind.get(tok & 0xffffff) ?? 0, r === 3)
            // a lookup directly wrapped into HarmonyMethod is a patch method, not a target
            if (target && !nextCallIsHarmonyMethod(md, role, p + 4, end)) {
              if (pending) flush()
              pending = target
            }
            lastType = null
            lastStr = null
          } else if (r === 1) {
            flush()
            lastType = null
          } else if (r === 4) {
            lastType = null
          }
        }
      }
      p += n
    }
    flush()
  }
}

function resolveTarget(type: string | null, s: string | null, kind: number, reflection: boolean): Pending | null {
  const colon = s != null && !reflection ? s.indexOf(':') : -1
  if (colon > 0) {
    // AccessTools.Method("Verse.Pawn:Tick")
    type = s!.slice(0, colon)
    s = s!.slice(colon + 1)
  }
  if (type == null || type === '?') return null
  if (kind === 3) return { type, member: '.ctor' }
  if (s == null) return null
  return { type, member: kind === 1 ? 'get_' + s : kind === 2 ? 'set_' + s : s }
}

function nextCallIsHarmonyMethod(md: Md, role: Map<number, number>, p: number, end: number): boolean {
  const buf = md.buf
  for (let steps = 0; p < end && steps < 4; steps++) {
    let op = buf[p++]
    if (op === 0xfe) { op = buf[p++]; p += op < 32 ? TWO_BYTE_OPERAND[op] : 0; continue }
    const n = OPERAND[op]
    if (n === 0xff) return false
    if ((op === OP_NEWOBJ || op === OP_CALL || op === OP_CALLVIRT) && p + 4 <= end) {
      const tok = md.dv.getUint32(p, true)
      return tok >>> 24 === MEMBERREF && role.get(tok & 0xffffff) === 4
    }
    p += n
  }
  return false
}
