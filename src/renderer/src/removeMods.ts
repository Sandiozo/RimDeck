import { api } from './api'
import { useStore } from './store'

export const steamUrl = (workshopId: string) => `steam://url/CommunityFilePage/${workshopId}`

/** What "remove" means for each mod: local folders go to the Recycle Bin, Workshop items are unsubscribed. */
export function removalPlan(pids: string[]) {
  const s = useStore.getState()
  const mods = pids.map((p) => s.installed.get(p)?.[0]).filter((m): m is NonNullable<typeof m> => !!m)
  return {
    local: mods.filter((m) => m.source === 'local'),
    workshop: mods.filter((m) => m.source === 'workshop' && m.workshopId),
  }
}

export function removeLabel(pids: string[]) {
  const { local, workshop } = removalPlan(pids)
  const n = local.length + workshop.length
  if (!n) return null
  if (!workshop.length) return n === 1 ? 'Delete' : `Delete ${n} mods`
  if (!local.length) return n === 1 ? 'Unsubscribe' : `Unsubscribe ${n} mods`
  return `Remove ${n} mods`
}

export async function removeMods(pids: string[]) {
  const s = useStore.getState()
  const { local, workshop } = removalPlan(pids)
  if (!local.length && !workshop.length) return
  const list = (ms: typeof local) => ms.slice(0, 8).map((m) => `  • ${m.name}`).join('\n') + (ms.length > 8 ? `\n  …and ${ms.length - 8} more` : '')
  const parts = [
    local.length ? `Move to the Recycle Bin (you can restore them from there):\n${list(local)}` : '',
    workshop.length ? `Unsubscribe on Steam (Steam then deletes the files):\n${list(workshop)}` : '',
  ].filter(Boolean)
  if (!confirm(parts.join('\n\n') + '\n\nContinue?')) return

  // Take them out of the working load order first so nothing points at a missing mod.
  s.deactivate([...local, ...workshop].map((m) => m.packageId))
  const messages: string[] = []
  if (local.length) {
    const r = await api.trashMods(local.map((m) => m.packageId))
    if (r.trashed.length) messages.push(`${r.trashed.length} moved to the Recycle Bin`)
    if (r.skipped.length) s.toast('error', `Couldn't delete ${r.skipped.length} mod${r.skipped.length === 1 ? '' : 's'}`)
  }
  if (workshop.length) {
    s.toast('info', 'Asking Steam to unsubscribe…')
    const r = await api.unsubscribeMods(workshop.map((m) => m.packageId))
    if (!r.ok) s.toast('error', `Unsubscribe failed: ${r.error}`)
    else {
      if (r.done.length) messages.push(`${r.done.length} unsubscribed — Steam removes the files in a few seconds`)
      if (r.failed.length) s.toast('error', `Steam refused ${r.failed.length}: ${r.failed[0].error}`)
    }
  }
  await useStore.getState().reload()
  // Don't leave the details panel pointing at a mod that no longer exists.
  const after = useStore.getState()
  if (after.focus && pids.includes(after.focus) && !after.installed.has(after.focus)) useStore.setState({ focus: null, selection: new Set() })
  if (messages.length) s.toast('ok', messages.join(' · ') + (useStore.getState().active.join('|') !== useStore.getState().saved.join('|') ? '. Save your load order to finish.' : ''))
}
