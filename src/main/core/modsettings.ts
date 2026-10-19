// Mod settings (Config/Mod_<folder>_<Class>.xml) reader/writer for the settings editor.
// Uses a small dependency-free XML tokenizer/serializer tuned for RimWorld Scribe XML so an
// unchanged tree round-trips to byte-identical output (UTF-8 BOM, CRLF, tab indentation).
import { readFile, writeFile, readdir, stat, mkdir, rename, copyFile, unlink, access } from 'node:fs/promises'
import { join, basename, dirname } from 'node:path'
import { execFile } from 'node:child_process'

export interface SettingsNode {
  id: string
  tag: string
  attrs?: Record<string, string>
  text?: string
  children?: SettingsNode[]
}

export interface SettingsFile {
  path: string
  name: string
  folder: string | null
  className: string
  size: number
  mtime: number
}

// ---------- file discovery ----------

export async function matchSettingsFiles(configDir: string, modFolders: string[]): Promise<SettingsFile[]> {
  let entries: string[]
  try {
    entries = await readdir(configDir)
  } catch {
    return []
  }
  // Longest folder first so "Foo_Bar" beats "Foo" for "Mod_Foo_Bar_Cls.xml"
  const folders = [...new Set(modFolders)]
    .map((f) => ({ f, prefix: `mod_${f.toLowerCase()}_` }))
    .sort((a, b) => b.prefix.length - a.prefix.length)
  const out: SettingsFile[] = []
  for (const name of entries) {
    if (!name.startsWith('Mod_') || !name.endsWith('.xml')) continue
    const path = join(configDir, name)
    let st
    try {
      st = await stat(path)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    const lower = name.toLowerCase()
    const stem = name.slice(0, -4)
    const hit = folders.find((x) => lower.startsWith(x.prefix) && lower.length > x.prefix.length + 4)
    const className = hit ? stem.slice(hit.prefix.length) : stem.slice(stem.lastIndexOf('_') + 1)
    out.push({ path, name, folder: hit ? hit.f : null, className, size: st.size, mtime: st.mtimeMs })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------- parsing ----------

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m
    }
    return NAMED_ENTITIES[e] ?? m
  })
}

// XML end-of-line normalization (applies to literal text only, not char references)
const normEol = (s: string) => (s.indexOf('\r') < 0 ? s : s.replace(/\r\n?/g, '\n'))

const ATTR_RE = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

interface Frame {
  node: SettingsNode
  kids: SettingsNode[]
  text: string
}

export function parseSettingsXml(xml: string): SettingsNode {
  const src = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml
  const len = src.length
  const stack: Frame[] = []
  let root: SettingsNode | null = null
  let i = 0
  const fail = (msg: string): never => {
    throw new Error(`Invalid settings XML at offset ${i}: ${msg}`)
  }
  while (i < len) {
    const lt = src.indexOf('<', i)
    const textEnd = lt < 0 ? len : lt
    if (textEnd > i && stack.length) stack[stack.length - 1].text += decodeEntities(normEol(src.slice(i, textEnd)))
    if (lt < 0) break
    i = lt
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i)
      if (end < 0) fail('unterminated processing instruction')
      i = end + 2
    } else if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4)
      if (end < 0) fail('unterminated comment')
      i = end + 3
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9)
      if (end < 0) fail('unterminated CDATA')
      if (stack.length) stack[stack.length - 1].text += normEol(src.slice(i + 9, end))
      i = end + 3
    } else if (src.startsWith('<!', i)) {
      // DOCTYPE etc.; internal subsets are not expected in Scribe files
      const end = src.indexOf('>', i)
      if (end < 0) fail('unterminated declaration')
      i = end + 1
    } else if (src[i + 1] === '/') {
      const end = src.indexOf('>', i)
      if (end < 0) fail('unterminated end tag')
      const tag = src.slice(i + 2, end).trim()
      const top = stack.pop()
      if (!top || top.node.tag !== tag) fail(`unexpected </${tag}>`)
      closeFrame(top!)
      if (!stack.length) root = top!.node
      i = end + 1
    } else {
      // Find tag end, skipping '>' inside quoted attribute values
      let j = i + 1
      let quote = ''
      for (; j < len; j++) {
        const c = src[j]
        if (quote) {
          if (c === quote) quote = ''
        } else if (c === '"' || c === "'") quote = c
        else if (c === '>') break
      }
      if (j >= len) fail('unterminated start tag')
      const selfClose = src[j - 1] === '/'
      const inner = src.slice(i + 1, selfClose ? j - 1 : j)
      const m = /^[^\s/>]+/.exec(inner)
      if (!m) fail('missing tag name')
      const tag = m![0]
      if (!stack.length && root) fail('multiple root elements')
      const parent = stack[stack.length - 1]
      const id = parent ? `${parent.node.id ? parent.node.id + '/' : ''}${parent.kids.length}/${tag}` : ''
      const node: SettingsNode = { id, tag }
      const rest = inner.slice(tag.length)
      if (rest.trim()) {
        const attrs: Record<string, string> = {}
        ATTR_RE.lastIndex = 0
        let a: RegExpExecArray | null
        while ((a = ATTR_RE.exec(rest))) {
          // Attribute-value normalization: literal whitespace chars become spaces
          attrs[a[1]] = decodeEntities((a[2] ?? a[3]).replace(/\r\n|[\r\n\t]/g, ' '))
        }
        if (Object.keys(attrs).length) node.attrs = attrs
      }
      if (parent) parent.kids.push(node)
      const frame: Frame = { node, kids: [], text: '' }
      if (selfClose) {
        closeFrame(frame)
        if (!parent) root = node
      } else stack.push(frame)
      i = j + 1
    }
  }
  if (stack.length) fail(`unclosed <${stack[stack.length - 1].node.tag}>`)
  if (!root) fail('no root element')
  return root!
}

function closeFrame(f: Frame) {
  if (f.kids.length) f.node.children = f.kids
  else f.node.text = f.text
}

// ---------- serialization ----------

const NAME_RE = /^[^\s<>&"'/=!?]+$/

function escText(s: string): string {
  return s.replace(/[&<>\r]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&#xD;'))
}

function escAttr(s: string): string {
  return s.replace(/[&<>"\r\n\t]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;'
      : c === '\r' ? '&#xD;' : c === '\n' ? '&#xA;' : '&#x9;')
}

export function serializeSettingsXml(root: SettingsNode, eol = '\r\n'): string {
  const out: string[] = ['<?xml version="1.0" encoding="utf-8"?>']
  const walk = (n: SettingsNode, depth: number) => {
    if (!NAME_RE.test(n.tag)) throw new Error(`Invalid element name: ${JSON.stringify(n.tag)}`)
    let open = '\t'.repeat(depth) + '<' + n.tag
    if (n.attrs) {
      for (const [k, v] of Object.entries(n.attrs)) {
        if (!NAME_RE.test(k)) throw new Error(`Invalid attribute name: ${JSON.stringify(k)}`)
        open += ` ${k}="${escAttr(String(v))}"`
      }
    }
    if (n.children && n.children.length) {
      out.push(open + '>')
      for (const c of n.children) walk(c, depth + 1)
      out.push('\t'.repeat(depth) + '</' + n.tag + '>')
    } else {
      const text = n.text ?? ''
      // Newlines inside a value follow the file's line ending, as .NET's XmlWriter does
      out.push(text === '' ? open + ' />' : open + '>' + escText(text).replace(/\n/g, eol) + '</' + n.tag + '>')
    }
  }
  walk(root, 0)
  return '﻿' + out.join(eol)
}

// ---------- file operations ----------

export async function readSettings(path: string): Promise<SettingsNode> {
  return parseSettingsXml(await readFile(path, 'utf8'))
}

function stamp(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function backupTarget(path: string, backupDir: string): Promise<string> {
  await mkdir(backupDir, { recursive: true })
  const stem = basename(path).replace(/\.xml$/i, '')
  const base = `${stem}-${stamp()}`
  let target = join(backupDir, `${base}.xml`)
  for (let n = 1; await exists(target); n++) target = join(backupDir, `${base}-${n}.xml`)
  return target
}

// Windows can briefly lock files (AV, indexer); retry transient rename failures
async function renameRetry(from: string, to: string) {
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

async function moveFile(from: string, to: string) {
  try {
    await renameRetry(from, to)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    await copyFile(from, to)
    await unlink(from)
  }
}

export async function writeSettings(path: string, root: SettingsNode, backupDir: string): Promise<{ backup: string }> {
  let eol = '\r\n'
  let backup = ''
  let original: Buffer | null = null
  try {
    original = await readFile(path)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
  if (original) {
    if (!original.includes('\r\n') && original.includes('\n')) eol = '\n'
    backup = await backupTarget(path, backupDir)
    await writeFile(backup, original)
  }
  const xml = serializeSettingsXml(root, eol)
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFile(tmp, xml, 'utf8')
    await renameRetry(tmp, path)
  } catch (e) {
    await unlink(tmp).catch(() => {})
    throw e
  }
  return { backup }
}

export async function resetSettings(path: string, backupDir: string): Promise<{ backup: string }> {
  const backup = await backupTarget(path, backupDir)
  await moveFile(path, backup)
  return { backup }
}

export async function moveToBackup(paths: string[], backupDir: string): Promise<number> {
  let moved = 0
  for (const p of paths) {
    try {
      await moveFile(p, await backupTarget(p, backupDir))
      moved++
    } catch {
      // skip missing/locked files; caller re-lists afterwards
    }
  }
  return moved
}

// ---------- game detection ----------

export function isGameRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const win = process.platform === 'win32'
      const [cmd, args] = win ? ['tasklist', ['/fo', 'csv', '/nh']] : ['ps', ['-A', '-o', 'comm']]
      execFile(cmd, args, { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(false)
        const lines = String(stdout).split(/\r?\n/)
        resolve(
          win
            ? lines.some((l) => /^rimworld/i.test(l.replace(/^"/, '')))
            : lines.some((l) => /rimworld/i.test(basename(l.trim())))
        )
      })
    } catch {
      resolve(false)
    }
  })
}
