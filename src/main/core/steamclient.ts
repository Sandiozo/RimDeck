import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Talking to the Steam client needs a process that Steam treats as RimWorld (app 294100) for a moment.
// It runs in a short-lived helper so RimDeck itself never shows up as "playing", and so Steam deletes
// unsubscribed items as soon as the helper exits.
const HELPER = `
const sw = require(process.env.RD_SW_PATH)
const { action, ids } = JSON.parse(process.env.RD_SW_JOB)
const out = (o) => { process.stdout.write('\\n@@RIMDECK@@' + JSON.stringify(o) + '\\n'); setTimeout(() => process.exit(0), 300) }
let client
try { client = sw.init(294100) } catch (e) { out({ ok: false, error: 'steam-not-running', detail: String(e && e.message || e) }); return }
;(async () => {
  const done = [], failed = []
  for (const id of ids) {
    try {
      if (action === 'unsubscribe') await client.workshop.unsubscribe(BigInt(id))
      else if (action === 'subscribe') await client.workshop.subscribe(BigInt(id))
      done.push(id)
    } catch (e) { failed.push({ id, error: String(e && e.message || e) }) }
  }
  out({ ok: true, done, failed })
})()
`

export interface SteamJobResult {
  ok: boolean
  done: string[]
  failed: { id: string; error: string }[]
  error?: string
}

function steamworksPath(): string {
  const p = createRequire(import.meta.url).resolve('steamworks.js')
  // Native files are unpacked next to the asar archive in the installed app.
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')
}

export async function steamWorkshop(action: 'unsubscribe' | 'subscribe', ids: string[], workDir: string): Promise<SteamJobResult> {
  if (!ids.length) return { ok: true, done: [], failed: [] }
  await mkdir(workDir, { recursive: true })
  const script = join(workDir, 'steam-helper.cjs')
  await writeFile(script, HELPER, 'utf8')
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RD_SW_PATH: steamworksPath(), RD_SW_JOB: JSON.stringify({ action, ids }) },
      windowsHide: true,
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    const timer = setTimeout(() => child.kill(), 45000)
    child.on('close', () => {
      clearTimeout(timer)
      try {
        // steam_api prints its own lines to stdout, so only the marked line is ours.
        const r = JSON.parse(out.match(/@@RIMDECK@@(.*)/)![1])
        if (!r.ok) return resolve({ ok: false, done: [], failed: [], error: r.error === 'steam-not-running' ? 'Steam must be running and logged in.' : r.detail })
        resolve({ ok: true, done: r.done, failed: r.failed })
      } catch {
        resolve({ ok: false, done: [], failed: [], error: (err || 'The Steam helper did not respond').split('\n')[0] })
      }
    })
  })
}
