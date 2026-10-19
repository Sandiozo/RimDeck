import { XMLParser } from 'fast-xml-parser'

// Lowercased tag names, `li` always an array, no value coercion ("1.10" must stay a string).
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  transformTagName: (n) => n.toLowerCase(),
  isArray: (name) => name === 'li',
  processEntities: true,
  htmlEntities: true,
})

export function parseXml(text: string): any {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return parser.parse(text)
}

export function text(v: any): string {
  if (v == null) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'object' && '#text' in v) return String(v['#text'])
  return ''
}

export function list(v: any): any[] {
  if (v == null || v === '') return []
  if (Array.isArray(v)) return v
  if (typeof v === 'object' && Array.isArray(v.li)) return v.li
  return []
}

export function strList(v: any): string[] {
  return list(v).map(text).map((s) => s.trim()).filter(Boolean)
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
