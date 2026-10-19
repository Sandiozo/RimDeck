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

export async function loadDefs(active: string[]) {
  useDefs.setState({ busy: true, error: '' })
  try {
    const data = await api.defData(active)
    useDefs.setState({ data, scannedFor: active.join('|') })
  } catch (e: any) {
    useDefs.setState({ error: String(e?.message ?? e) })
  } finally {
    useDefs.setState({ busy: false })
  }
}

// Stable, distinct-ish color per mod for stripes and legends.
export function modColor(pid: string) {
  let h = 0
  for (const c of pid) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return `hsl(${h % 360} 65% 60%)`
}
