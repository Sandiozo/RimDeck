import { create } from 'zustand'
import type { DefData } from '@shared/types'
import { api } from './api'

// Shared by the Research and Items views; parsed once per load order in the main process.
export const useDefs = create<{ data: DefData | null; scannedFor: string; busy: boolean; error: string }>(() => ({
  data: null,
  scannedFor: '',
  busy: false,
  error: '',
}))

// Only the newest request may write its result, so a slow earlier read can't replace a later one.
let latest = 0
let latestFor = ''

export async function loadDefs(active: string[]) {
  const id = ++latest
  const key = active.join('|')
  latestFor = key
  useDefs.setState({ busy: true, error: '' })
  try {
    const data = await api.defData(active)
    if (id === latest) useDefs.setState({ data, scannedFor: key })
  } catch (e: any) {
    if (id === latest) useDefs.setState({ error: String(e?.message ?? e) })
  } finally {
    if (id === latest) useDefs.setState({ busy: false })
  }
}

/** Reads the data when there is none (first visit, or cleared by a profile switch), unless that list is already being read. */
export function ensureDefs(active: string[]) {
  const { data, busy } = useDefs.getState()
  if (data || (busy && latestFor === active.join('|'))) return
  void loadDefs(active)
}

// Stable, distinct-ish color per mod for stripes and legends.
export function modColor(pid: string) {
  let h = 0
  for (const c of pid) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 65% 60%)`
}
