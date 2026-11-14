import { api, platform } from './api'
import { isDirty, useStore } from './store'

export const steamUrl = (workshopId: string) => `steam://url/CommunityFilePage/${workshopId}`

/** Where deleted folders go: the Recycle Bin on Windows, the Trash on macOS and Linux. */
export const trashName = platform === 'win32' ? 'Recycle Bin' : 'Trash'

/** What "remove" means for each mod: local folders go to the Recycle Bin or Trash, Workshop items are unsubscribed. */
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
    local.length ? `Move to the ${trashName} (you can restore them from there):\n${list(local)}` : '',
    workshop.length ? `Unsubscribe on Steam (Steam then deletes the files):\n${list(workshop)}` : '',
  ].filter(Boolean)
  if (!confirm(parts.join('\n\n') + '\n\nContinue?')) return

  // Only mods that really went are taken out of the load order, so a failure leaves the list as it was.
  const messages: string[] = []
  const removed: string[] = []
  if (local.length) {
    try {
      const r = await api.trashMods(local.map((m) => m.packageId))
      removed.push(...r.trashed)
      if (r.trashed.length) messages.push(`${r.trashed.length} moved to the ${trashName}`)
      if (r.skipped.length) s.toast('error', `Could not delete ${r.skipped.length} mod${r.skipped.length === 1 ? '' : 's'}`)
    } catch (e: any) {
      s.toast('error', `Could not delete: ${e.message}`)
    }
  }
  if (workshop.length) {
    s.toast('info', 'Requesting unsubscribe from Steam…')
    try {
      const r = await api.unsubscribeMods(workshop.map((m) => m.packageId))
      if (!r.ok) s.toast('error', `Unsubscribe failed: ${r.error}`)
      else {
        removed.push(...r.packageIds)
        if (r.done.length) messages.push(`${r.done.length} unsubscribed (Steam removes the files within a few seconds)`)
        if (r.failed.length) s.toast('error', `Steam could not unsubscribe ${r.failed.length}: ${r.failed[0].error}`)
      }
    } catch (e: any) {
      s.toast('error', `Unsubscribe failed: ${e.message}`)
    }
  }
  if (removed.length) s.deactivate(removed)
  // The main process has already rescanned after deleting (and rescans again once Steam removes the files).
  try {
    await useStore.getState().refreshState()
  } catch (e: any) {
    s.toast('error', `Could not refresh the mod list: ${e.message}`)
  }
  // Don't leave the details panel pointing at a mod that no longer exists.
  const after = useStore.getState()
  if (after.focus && pids.includes(after.focus) && !after.installed.has(after.focus)) useStore.setState({ focus: null, selection: new Set() })
  if (messages.length) s.toast('ok', messages.join(' · ') + (isDirty(useStore.getState()) ? '. Save your load order to finish.' : ''))
}
