import type { BrowserWindow } from 'electron'
import { appendFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Records moments when RimDeck stops responding, and what it was doing then, in
// <userData>/logs/responsiveness.log. Three sources: the main process falling behind its own
// timer, Electron reporting the window as unresponsive, and long tasks in the interface.

const MAIN_STALL_MS = 1500
const MAX_LOG_BYTES = 256 * 1024

const inFlight = new Map<number, { what: string; start: number }>()
const recent: string[] = []
let next = 0
let file = ''

/** Marks work (an API call, an image) as running, for the log; call the returned function when done. */
export function track(what: string): () => void {
  const id = ++next
  inFlight.set(id, { what, start: Date.now() })
  return () => {
    const job = inFlight.get(id)
    inFlight.delete(id)
    if (job) {
      const ms = Date.now() - job.start
      if (ms > 500) {
        recent.push(`${job.what} ${ms} ms`)
        if (recent.length > 12) recent.shift()
      }
    }
  }
}

function running(): string {
  const now = Date.now()
  const jobs = [...inFlight.values()].map((j) => `${j.what} (${now - j.start} ms)`)
  return `running: ${jobs.join(', ') || 'nothing'}; recent slow work: ${recent.join(', ') || 'none'}`
}

async function log(line: string) {
  if (!file) return
  try {
    await mkdir(join(file, '..'), { recursive: true })
    await appendFile(file, `${new Date().toISOString()} ${line}\n`, 'utf8')
    // Keep the newest part of the log once it grows past the limit.
    if ((await stat(file)).size > MAX_LOG_BYTES) {
      const text = await readFile(file, 'utf8')
      await writeFile(file, text.slice(text.length - MAX_LOG_BYTES / 2), 'utf8')
    }
  } catch {
    // logging must never get in the way
  }
}

/** The interface reports its own long tasks here. */
export function logInterfaceStall(ms: number, where: string) {
  void log(`interface busy ${Math.round(ms)} ms in ${where}; ${running()}`)
}

export function watchResponsiveness(win: BrowserWindow, userData: string) {
  file = join(userData, 'logs', 'responsiveness.log')
  let last = Date.now()
  setInterval(() => {
    const now = Date.now()
    const late = now - last - 500
    last = now
    if (late > MAIN_STALL_MS) void log(`main process blocked ~${late} ms; ${running()}`)
  }, 500).unref()
  let since = 0
  win.on('unresponsive', () => {
    since = Date.now()
    void log(`window not responding; ${running()}`)
  })
  win.on('responsive', () => {
    if (since) void log(`window responding again after ${Date.now() - since} ms; ${running()}`)
    since = 0
  })
}
