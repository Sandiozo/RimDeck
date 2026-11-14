// The mod lists only render the rows near their view, so a mod far down a list has no element to
// scroll to. Each list registers how to scroll to a mod it shows; showMod asks them in turn.
type Revealer = (pid: string) => boolean

const revealers = new Set<Revealer>()

/** Registers a list; returns the function that removes it again. */
export function addRevealer(fn: Revealer): () => void {
  revealers.add(fn)
  return () => {
    revealers.delete(fn)
  }
}

/** Scrolls the list that shows this mod to it. False when no list shows it (not on screen, or filtered out). */
export function revealMod(pid: string): boolean {
  for (const fn of revealers) if (fn(pid)) return true
  return false
}
