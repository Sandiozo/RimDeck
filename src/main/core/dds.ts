// Pure-TS DDS decoder (top mip only): BC1-5, BC7 and common uncompressed layouts.

export interface DecodedImage {
  width: number
  height: number
  rgba: Uint8Array // top-left origin, RGBA8, straight alpha
}

const KIND_NONE = 0
const KIND_BC1 = 1
const KIND_BC2 = 2
const KIND_BC3 = 3
const KIND_BC4 = 4
const KIND_BC5 = 5
const KIND_BC7 = 7
const KIND_RAW = 10

interface Header {
  width: number
  height: number
  offset: number
  kind: number
  format: string
  premul: boolean
  // uncompressed only
  bpp: number
  rm: number
  gm: number
  bm: number
  am: number
  lum: boolean
}

const DDPF_ALPHAPIXELS = 0x1
const DDPF_ALPHA = 0x2
const DDPF_FOURCC = 0x4
const DDPF_RGB = 0x40
const DDPF_LUMINANCE = 0x20000

function u32(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0
}

function fcc(s: string): number {
  return (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0
}

const FCC_DXT1 = fcc('DXT1')
const FCC_DXT2 = fcc('DXT2')
const FCC_DXT3 = fcc('DXT3')
const FCC_DXT4 = fcc('DXT4')
const FCC_DXT5 = fcc('DXT5')
const FCC_ATI1 = fcc('ATI1')
const FCC_BC4U = fcc('BC4U')
const FCC_ATI2 = fcc('ATI2')
const FCC_BC5U = fcc('BC5U')
const FCC_DX10 = fcc('DX10')

function shiftOf(m: number): number {
  return m === 0 ? 0 : 31 - Math.clz32(m & -m)
}

function bitsOf(m: number): number {
  const max = m >>> shiftOf(m)
  return max === 0 ? 0 : 32 - Math.clz32(max)
}

// Name an uncompressed layout from its masks, channels listed from the low bit up (DXGI style).
function rawName(h: Header): string {
  if (h.lum) {
    const l = bitsOf(h.rm)
    return h.am ? `L${l}A${bitsOf(h.am)}` : `L${l}`
  }
  const ch: [string, number][] = []
  if (h.rm) ch.push(['R', h.rm])
  if (h.gm) ch.push(['G', h.gm])
  if (h.bm) ch.push(['B', h.bm])
  if (h.am) ch.push(['A', h.am])
  ch.sort((a, b) => shiftOf(a[1]) - shiftOf(b[1]))
  let used = 0
  let s = ''
  for (const [n, m] of ch) {
    const b = bitsOf(m)
    used += b
    s += n + b
  }
  if (used < h.bpp && !h.am) s += 'X' + (h.bpp - used)
  return s || `${h.bpp}bpp`
}

function setRaw(h: Header, bpp: number, rm: number, gm: number, bm: number, am: number, lum = false): void {
  h.kind = KIND_RAW
  h.bpp = bpp
  h.rm = rm >>> 0
  h.gm = gm >>> 0
  h.bm = bm >>> 0
  h.am = am >>> 0
  h.lum = lum
}

function dxgiFormat(h: Header, f: number): void {
  switch (f) {
    case 70: case 71: case 72: h.kind = KIND_BC1; h.format = f === 72 ? 'BC1 sRGB' : 'BC1'; return
    case 73: case 74: case 75: h.kind = KIND_BC2; h.format = f === 75 ? 'BC2 sRGB' : 'BC2'; return
    case 76: case 77: case 78: h.kind = KIND_BC3; h.format = f === 78 ? 'BC3 sRGB' : 'BC3'; return
    case 79: case 80: h.kind = KIND_BC4; h.format = 'BC4'; return
    case 82: case 83: h.kind = KIND_BC5; h.format = 'BC5'; return
    case 97: case 98: case 99: h.kind = KIND_BC7; h.format = f === 99 ? 'BC7 sRGB' : 'BC7'; return
    case 27: case 28: case 29: setRaw(h, 32, 0xff, 0xff00, 0xff0000, 0xff000000); h.format = f === 29 ? 'RGBA8 sRGB' : 'RGBA8'; return
    case 87: case 90: case 91: setRaw(h, 32, 0xff0000, 0xff00, 0xff, 0xff000000); h.format = f === 91 ? 'BGRA8 sRGB' : 'BGRA8'; return
    case 88: case 92: case 93: setRaw(h, 32, 0xff0000, 0xff00, 0xff, 0); h.format = f === 93 ? 'BGRX8 sRGB' : 'BGRX8'; return
    case 23: case 24: setRaw(h, 32, 0x3ff, 0xffc00, 0x3ff00000, 0xc0000000); h.format = 'RGB10A2'; return
    case 85: setRaw(h, 16, 0xf800, 0x7e0, 0x1f, 0); h.format = 'B5G6R5'; return
    case 86: setRaw(h, 16, 0x7c00, 0x3e0, 0x1f, 0x8000); h.format = 'B5G5R5A1'; return
    case 115: setRaw(h, 16, 0xf00, 0xf0, 0xf, 0xf000); h.format = 'B4G4R4A4'; return
    case 48: case 49: setRaw(h, 16, 0xff, 0xff00, 0, 0); h.format = 'RG8'; return
    case 60: case 61: setRaw(h, 8, 0xff, 0, 0, 0, true); h.format = 'R8'; return
    case 65: setRaw(h, 8, 0, 0, 0, 0xff); h.format = 'A8'; return
    case 81: h.format = 'BC4 SNORM'; return
    case 84: h.format = 'BC5 SNORM'; return
    case 94: case 95: case 96: h.format = 'BC6H'; return
    default: h.format = `DXGI ${f}`
  }
}

function parseHeader(buf: Uint8Array): Header | null {
  if (!buf || buf.length < 128 || u32(buf, 0) !== fcc('DDS ')) return null
  const height = u32(buf, 12)
  const width = u32(buf, 16)
  if (!width || !height || width > 65536 || height > 65536) return null
  const pfFlags = u32(buf, 80)
  const four = u32(buf, 84)
  const h: Header = {
    width, height, offset: 128, kind: KIND_NONE, format: 'unknown', premul: false,
    bpp: 0, rm: 0, gm: 0, bm: 0, am: 0, lum: false,
  }
  if (pfFlags & DDPF_FOURCC) {
    if (four === FCC_DX10) {
      if (buf.length < 148) return null
      h.offset = 148
      dxgiFormat(h, u32(buf, 128))
    } else if (four === FCC_DXT1) { h.kind = KIND_BC1; h.format = 'BC1/DXT1' }
    else if (four === FCC_DXT2) { h.kind = KIND_BC2; h.format = 'BC2/DXT2'; h.premul = true }
    else if (four === FCC_DXT3) { h.kind = KIND_BC2; h.format = 'BC2/DXT3' }
    else if (four === FCC_DXT4) { h.kind = KIND_BC3; h.format = 'BC3/DXT4'; h.premul = true }
    else if (four === FCC_DXT5) { h.kind = KIND_BC3; h.format = 'BC3/DXT5' }
    else if (four === FCC_ATI1 || four === FCC_BC4U) { h.kind = KIND_BC4; h.format = 'BC4' }
    else if (four === FCC_ATI2 || four === FCC_BC5U) { h.kind = KIND_BC5; h.format = 'BC5' }
    else {
      // Printable FourCC, or a numeric D3DFMT code
      let s = ''
      for (let i = 0; i < 4; i++) {
        const c = buf[84 + i]
        s += c >= 32 && c < 127 ? String.fromCharCode(c) : ''
      }
      h.format = s.length === 4 ? s : `D3DFMT ${four}`
    }
    return h
  }
  const bpp = u32(buf, 88)
  if (pfFlags & (DDPF_RGB | DDPF_LUMINANCE | DDPF_ALPHA)) {
    if (bpp !== 8 && bpp !== 16 && bpp !== 24 && bpp !== 32) { h.format = `${bpp}bpp`; return h }
    const lum = (pfFlags & DDPF_LUMINANCE) !== 0
    const hasA = (pfFlags & (DDPF_ALPHAPIXELS | DDPF_ALPHA)) !== 0
    if (pfFlags & (DDPF_RGB | DDPF_LUMINANCE)) {
      setRaw(h, bpp, u32(buf, 92), lum ? 0 : u32(buf, 96), lum ? 0 : u32(buf, 100), hasA ? u32(buf, 104) : 0, lum)
    } else {
      setRaw(h, bpp, 0, 0, 0, u32(buf, 104)) // alpha-only
    }
    if (!h.rm && !h.gm && !h.bm && !h.am) { h.kind = KIND_NONE; h.format = `${bpp}bpp`; return h }
    h.format = rawName(h)
  }
  return h
}

export function ddsInfo(buf: Uint8Array): { width: number; height: number; format: string } | null {
  try {
    const h = parseHeader(buf)
    return h ? { width: h.width, height: h.height, format: h.format } : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------- block helpers

const TMP = new Uint32Array(16)
const TMP8 = new Uint8Array(TMP.buffer)
const PAL = new Uint8Array(16)
const APAL = new Uint8Array(8)

type BlockFn = (src: Uint8Array, o: number, out: Uint8Array) => void

function decodeBlocks(buf: Uint8Array, off: number, w: number, h: number, blockBytes: number, fn: BlockFn): Uint8Array | null {
  const bw = (w + 3) >> 2
  const bh = (h + 3) >> 2
  if (off + bw * bh * blockBytes > buf.length) return null
  const out = new Uint8Array(w * h * 4)
  const out32 = new Uint32Array(out.buffer)
  let p = off
  for (let by = 0; by < bh; by++) {
    const y0 = by * 4
    const rows = Math.min(4, h - y0)
    for (let bx = 0; bx < bw; bx++) {
      fn(buf, p, TMP8)
      p += blockBytes
      const x0 = bx * 4
      const cols = Math.min(4, w - x0)
      for (let y = 0; y < rows; y++) {
        const d = (y0 + y) * w + x0
        const s = y * 4
        for (let x = 0; x < cols; x++) out32[d + x] = TMP[s + x]
      }
    }
  }
  return out
}

// BC1 color block (8 bytes) -> out RGBA. fourColor forces 4-color mode (BC2/BC3).
function colorBlock(src: Uint8Array, o: number, out: Uint8Array, fourColor: boolean): void {
  const c0 = src[o] | (src[o + 1] << 8)
  const c1 = src[o + 2] | (src[o + 3] << 8)
  let r = (c0 >> 11) & 31, g = (c0 >> 5) & 63, b = c0 & 31
  const r0 = (r << 3) | (r >> 2), g0 = (g << 2) | (g >> 4), b0 = (b << 3) | (b >> 2)
  r = (c1 >> 11) & 31; g = (c1 >> 5) & 63; b = c1 & 31
  const r1 = (r << 3) | (r >> 2), g1 = (g << 2) | (g >> 4), b1 = (b << 3) | (b >> 2)
  PAL[0] = r0; PAL[1] = g0; PAL[2] = b0; PAL[3] = 255
  PAL[4] = r1; PAL[5] = g1; PAL[6] = b1; PAL[7] = 255
  if (fourColor || c0 > c1) {
    PAL[8] = ((2 * r0 + r1 + 1) / 3) | 0; PAL[9] = ((2 * g0 + g1 + 1) / 3) | 0; PAL[10] = ((2 * b0 + b1 + 1) / 3) | 0; PAL[11] = 255
    PAL[12] = ((r0 + 2 * r1 + 1) / 3) | 0; PAL[13] = ((g0 + 2 * g1 + 1) / 3) | 0; PAL[14] = ((b0 + 2 * b1 + 1) / 3) | 0; PAL[15] = 255
  } else {
    PAL[8] = (r0 + r1 + 1) >> 1; PAL[9] = (g0 + g1 + 1) >> 1; PAL[10] = (b0 + b1 + 1) >> 1; PAL[11] = 255
    PAL[12] = 0; PAL[13] = 0; PAL[14] = 0; PAL[15] = 0
  }
  const bits = u32(src, o + 4)
  for (let i = 0; i < 16; i++) {
    const p = ((bits >>> (2 * i)) & 3) << 2
    const d = i << 2
    out[d] = PAL[p]; out[d + 1] = PAL[p + 1]; out[d + 2] = PAL[p + 2]; out[d + 3] = PAL[p + 3]
  }
}

// BC3-style alpha / BC4 block (8 bytes) -> one channel of out
function alphaBlock(src: Uint8Array, o: number, out: Uint8Array, ch: number): void {
  const a0 = src[o], a1 = src[o + 1]
  APAL[0] = a0; APAL[1] = a1
  if (a0 > a1) {
    for (let i = 2; i < 8; i++) APAL[i] = (((8 - i) * a0 + (i - 1) * a1 + 3) / 7) | 0
  } else {
    for (let i = 2; i < 6; i++) APAL[i] = (((6 - i) * a0 + (i - 1) * a1 + 2) / 5) | 0
    APAL[6] = 0; APAL[7] = 255
  }
  const lo = src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16)
  const hi = src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16)
  for (let i = 0; i < 8; i++) out[(i << 2) + ch] = APAL[(lo >> (3 * i)) & 7]
  for (let i = 0; i < 8; i++) out[((i + 8) << 2) + ch] = APAL[(hi >> (3 * i)) & 7]
}

const bc1: BlockFn = (src, o, out) => colorBlock(src, o, out, false)

const bc2: BlockFn = (src, o, out) => {
  colorBlock(src, o + 8, out, true)
  for (let i = 0; i < 16; i++) {
    const n = (src[o + (i >> 1)] >> ((i & 1) << 2)) & 15
    out[(i << 2) + 3] = n * 17
  }
}

const bc3: BlockFn = (src, o, out) => {
  colorBlock(src, o + 8, out, true)
  alphaBlock(src, o, out, 3)
}

const bc4: BlockFn = (src, o, out) => {
  alphaBlock(src, o, out, 0)
  for (let i = 0; i < 64; i += 4) {
    const v = out[i]
    out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255
  }
}

const bc5: BlockFn = (src, o, out) => {
  alphaBlock(src, o, out, 0)
  alphaBlock(src, o + 8, out, 1)
  for (let i = 0; i < 64; i += 4) {
    // Reconstruct Z of a unit normal from XY
    const x = out[i] / 127.5 - 1
    const y = out[i + 1] / 127.5 - 1
    const z = Math.sqrt(Math.max(0, 1 - x * x - y * y))
    out[i + 2] = Math.round((z * 0.5 + 0.5) * 255)
    out[i + 3] = 255
  }
}

// ---------------------------------------------------------------- BC7

// Per mode: subsets, partition bits, rotation bits, index-selection bits, color bits,
// alpha bits, per-endpoint p-bits, shared p-bits, index bits, secondary index bits
const MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0],
  [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0],
  [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3],
  [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0],
  [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
]

function table(rows: string[]): Uint8Array {
  const t = new Uint8Array(rows.length * 16)
  for (let i = 0; i < rows.length; i++) for (let j = 0; j < 16; j++) t[i * 16 + j] = rows[i].charCodeAt(j) - 48
  return t
}

const P2 = table([
  '0011001100110011', '0001000100010001', '0111011101110111', '0001001100110111',
  '0000000100010011', '0011011101111111', '0001001101111111', '0000000100110111',
  '0000000000010011', '0011011111111111', '0000000101111111', '0000000000010111',
  '0001011111111111', '0000000011111111', '0000111111111111', '0000000000001111',
  '0000100011101111', '0111000100000000', '0000000010001110', '0111001100010000',
  '0011000100000000', '0000100011001110', '0000000010001100', '0111001100110001',
  '0011000100010000', '0000100010001100', '0110011001100110', '0011011001101100',
  '0001011111101000', '0000111111110000', '0111000110001110', '0011100110011100',
  '0101010101010101', '0000111100001111', '0101101001011010', '0011001111001100',
  '0011110000111100', '0101010110101010', '0110100101101001', '0101101010100101',
  '0111001111001110', '0001001111001000', '0011001001001100', '0011101111011100',
  '0110100110010110', '0011110011000011', '0110011010011001', '0000011001100000',
  '0100111001000000', '0010011100100000', '0000001001110010', '0000010011100100',
  '0110110010010011', '0011011011001001', '0110001110011100', '0011100111000110',
  '0110110011001001', '0110001100111001', '0111111010000001', '0001100011100111',
  '0000111100110011', '0011001111110000', '0010001011101110', '0100010001110111',
])

const P3 = table([
  '0011001102212222', '0001001122112221', '0000200122112211', '0222002200110111',
  '0000000011221122', '0011001100220022', '0022002211111111', '0011001122112211',
  '0000000011112222', '0000111111112222', '0000111122222222', '0012001200120012',
  '0112011201120112', '0122012201220122', '0011011211221222', '0011200122002220',
  '0001001101121122', '0111001120012200', '0000112211221122', '0022002200221111',
  '0111011102220222', '0001000122212221', '0000001101220122', '0000110022102210',
  '0122012200110000', '0012001211222222', '0110122112210110', '0000011012211221',
  '0022110211020022', '0110011020022222', '0011012201220011', '0000200022112221',
  '0000000211221222', '0222002200120011', '0011001200220222', '0120012001200120',
  '0000111122220000', '0120120120120120', '0120201212010120', '0011220011220011',
  '0011112222000011', '0101010122222222', '0000000021212121', '0022112200221122',
  '0022001100220011', '0220122102201221', '0101222222220101', '0000212121212121',
  '0101010101012222', '0222011102220111', '0002111200021112', '0000211221122112',
  '0222011101110222', '0002111211120002', '0110011001102222', '0000000021122112',
  '0110011022222222', '0022001100110022', '0022112211220022', '0000000000002112',
  '0002000100020001', '0222122202221222', '0101222222222222', '0111201122012220',
])

const A2 = Uint8Array.from([
  15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15,
  15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6,
  6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15,
])

const A3A = Uint8Array.from([
  3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3,
  3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
  8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15,
  3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3,
])

const A3B = Uint8Array.from([
  15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8,
  15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
  15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8,
  15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8,
])

const W2 = Uint8Array.from([0, 21, 43, 64])
const W3 = Uint8Array.from([0, 9, 18, 27, 37, 46, 55, 64])
const W4 = Uint8Array.from([0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64])
const WTAB = [W2, W2, W2, W3, W4]

const BW = new Int32Array(5) // block as 32-bit words (+1 pad word)
let bitPos = 0
const EP = new Uint8Array(24) // [subset*2 + endpoint][rgba]
const IDX = new Uint8Array(16)
const IDX2 = new Uint8Array(16)

function bits(n: number): number {
  const p = bitPos
  bitPos += n
  const wi = p >>> 5
  const o = p & 31
  let v = BW[wi] >>> o
  if (o + n > 32) v |= BW[wi + 1] << (32 - o)
  return v & ((1 << n) - 1)
}

const bc7: BlockFn = (src, o, out) => {
  const b0 = src[o]
  if (b0 === 0) { out.fill(0); return } // reserved mode: transparent black
  const mode = 31 - Math.clz32(b0 & -b0)
  BW[0] = u32(src, o); BW[1] = u32(src, o + 4); BW[2] = u32(src, o + 8); BW[3] = u32(src, o + 12)
  bitPos = mode + 1
  const m = MODES[mode]
  const ns = m[0], cb = m[4], ab = m[5], epb = m[6], spb = m[7], ib = m[8], ib2 = m[9]
  const part = bits(m[1])
  const rot = bits(m[2])
  const isel = bits(m[3])
  const ne = ns * 2

  for (let c = 0; c < 3; c++) for (let i = 0; i < ne; i++) EP[i * 4 + c] = bits(cb)
  if (ab) for (let i = 0; i < ne; i++) EP[i * 4 + 3] = bits(ab)
  else for (let i = 0; i < ne; i++) EP[i * 4 + 3] = 255

  let cbits = cb, abits = ab
  if (epb || spb) {
    const nc = ab ? 4 : 3
    let p = 0
    for (let i = 0; i < ne; i++) {
      if (!spb || !(i & 1)) p = bits(1) // shared p-bit: one per subset
      for (let c = 0; c < nc; c++) EP[i * 4 + c] = (EP[i * 4 + c] << 1) | p
    }
    cbits++
    if (ab) abits++
  }
  // Expand endpoints to 8 bits
  for (let i = 0; i < ne; i++) {
    for (let c = 0; c < 3; c++) {
      const v = EP[i * 4 + c] << (8 - cbits)
      EP[i * 4 + c] = v | (v >> cbits)
    }
    if (ab) {
      const v = EP[i * 4 + 3] << (8 - abits)
      EP[i * 4 + 3] = v | (v >> abits)
    }
  }

  const a1 = ns === 2 ? A2[part] : ns === 3 ? A3A[part] : 0
  const a2 = ns === 3 ? A3B[part] : 0
  for (let i = 0; i < 16; i++) IDX[i] = bits(i === 0 || i === a1 || i === a2 ? ib - 1 : ib)
  if (ib2) for (let i = 0; i < 16; i++) IDX2[i] = bits(i === 0 ? ib2 - 1 : ib2)

  const ptab = ns === 2 ? P2 : P3
  const pbase = part * 16
  let cw = WTAB[ib], aw = cw
  let cidx = IDX, aidx = IDX
  if (ib2) {
    if (isel) { cw = WTAB[ib2]; aw = WTAB[ib]; cidx = IDX2 } else { aw = WTAB[ib2]; aidx = IDX2 }
  }
  for (let i = 0; i < 16; i++) {
    const s = ns === 1 ? 0 : ptab[pbase + i]
    const e0 = s * 8, e1 = e0 + 4
    const w = cw[cidx[i]], iw = 64 - w
    const wa = aw[aidx[i]]
    let r = (iw * EP[e0] + w * EP[e1] + 32) >> 6
    let g = (iw * EP[e0 + 1] + w * EP[e1 + 1] + 32) >> 6
    let b = (iw * EP[e0 + 2] + w * EP[e1 + 2] + 32) >> 6
    let a = ((64 - wa) * EP[e0 + 3] + wa * EP[e1 + 3] + 32) >> 6
    if (rot === 1) { const t = a; a = r; r = t }
    else if (rot === 2) { const t = a; a = g; g = t }
    else if (rot === 3) { const t = a; a = b; b = t }
    const d = i << 2
    out[d] = r; out[d + 1] = g; out[d + 2] = b; out[d + 3] = a
  }
}

// ---------------------------------------------------------------- uncompressed

function chan(mask: number): { shift: number; bits: number; lut: Uint8Array | null } {
  const shift = shiftOf(mask)
  const b = bitsOf(mask)
  let lut: Uint8Array | null = null
  if (b > 0 && b < 8) {
    const max = (1 << b) - 1
    lut = new Uint8Array(max + 1)
    for (let v = 0; v <= max; v++) lut[v] = Math.round((v * 255) / max)
  }
  return { shift, bits: b, lut }
}

function decodeRaw(buf: Uint8Array, h: Header): Uint8Array | null {
  const { width: w, height: hh, offset: off } = h
  const bytes = h.bpp >> 3
  if (off + w * hh * bytes > buf.length) return null
  const out = new Uint8Array(w * hh * 4)
  const n = w * hh
  // Fast paths for byte-aligned 32-bit layouts
  if (bytes === 4 && h.gm === 0xff00 && (h.am === 0 || h.am === 0xff000000) && !h.lum) {
    const ri = h.rm === 0xff ? 0 : h.rm === 0xff0000 ? 2 : -1
    const bi = h.bm === 0xff ? 0 : h.bm === 0xff0000 ? 2 : -1
    if (ri >= 0 && bi >= 0 && ri !== bi) {
      for (let i = 0, s = off, d = 0; i < n; i++, s += 4, d += 4) {
        out[d] = buf[s + ri]; out[d + 1] = buf[s + 1]; out[d + 2] = buf[s + bi]
        out[d + 3] = h.am ? buf[s + 3] : 255
      }
      return out
    }
  }
  const R = chan(h.rm), G = chan(h.gm), B = chan(h.bm), A = chan(h.am)
  const noColor = !h.rm && !h.gm && !h.bm
  const get = (px: number, c: { shift: number; bits: number; lut: Uint8Array | null }, missing: number): number => {
    if (c.bits === 0) return missing
    const v = (px >>> c.shift) & (c.bits >= 32 ? 0xffffffff : (2 ** c.bits - 1))
    if (c.lut) return c.lut[v]
    return c.bits === 8 ? v : v >>> (c.bits - 8)
  }
  for (let i = 0, s = off, d = 0; i < n; i++, s += bytes, d += 4) {
    let px = buf[s]
    if (bytes > 1) px |= buf[s + 1] << 8
    if (bytes > 2) px |= buf[s + 2] << 16
    if (bytes > 3) px |= buf[s + 3] << 24
    px >>>= 0
    const a = get(px, A, 255)
    if (h.lum) {
      const l = get(px, R, 0)
      out[d] = l; out[d + 1] = l; out[d + 2] = l
    } else if (noColor) {
      out[d] = 255; out[d + 1] = 255; out[d + 2] = 255
    } else {
      out[d] = get(px, R, 0); out[d + 1] = get(px, G, 0); out[d + 2] = get(px, B, 0)
    }
    out[d + 3] = a
  }
  return out
}

function unpremultiply(px: Uint8Array): void {
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]
    if (a === 0 || a === 255) continue
    px[i] = Math.min(255, Math.round((px[i] * 255) / a))
    px[i + 1] = Math.min(255, Math.round((px[i + 1] * 255) / a))
    px[i + 2] = Math.min(255, Math.round((px[i + 2] * 255) / a))
  }
}

export function decodeDds(buf: Uint8Array): DecodedImage | null {
  try {
    const h = parseHeader(buf)
    if (!h) return null
    const { width: w, height: hh, offset: off } = h
    let rgba: Uint8Array | null = null
    switch (h.kind) {
      case KIND_BC1: rgba = decodeBlocks(buf, off, w, hh, 8, bc1); break
      case KIND_BC2: rgba = decodeBlocks(buf, off, w, hh, 16, bc2); break
      case KIND_BC3: rgba = decodeBlocks(buf, off, w, hh, 16, bc3); break
      case KIND_BC4: rgba = decodeBlocks(buf, off, w, hh, 8, bc4); break
      case KIND_BC5: rgba = decodeBlocks(buf, off, w, hh, 16, bc5); break
      case KIND_BC7: rgba = decodeBlocks(buf, off, w, hh, 16, bc7); break
      case KIND_RAW: rgba = decodeRaw(buf, h); break
    }
    if (!rgba) return null
    if (h.premul) unpremultiply(rgba)
    return { width: w, height: hh, rgba }
  } catch {
    return null
  }
}
