import { app, BrowserWindow, dialog, ipcMain, nativeImage, powerMonitor, protocol, shell } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir, release, userInfo } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppEvent, BugReport, CrashStatus } from '../shared/types.ts'
import { buildReport, issueLink, type ReportFacts } from '../shared/bugreport.ts'
import { CrashLog, endRun, makeScrubber, startRun } from './crashlog.ts'
import { Service } from './service.ts'
import * as updater from './updater.ts'
import { captureScreenshots } from './screenshots.ts'
import { logInterfaceStall, track, watchResponsiveness } from './responsiveness.ts'
import { damagedFiles } from './core/store.ts'
import { WorkerPool } from './workers/pool.ts'
import { tasks } from './workers/tasks.ts'
// electron-vite bundles the worker entry as its own chunk and gives back a function that starts it.
import createWorker from './workers/worker.ts?nodeWorker'

// ---------- Errors and crashes ----------
// RimDeck's own errors go to <userData>/logs/crash.log, with the user's home folder and name removed.
// Nothing is ever sent: the user can read a report and share it themself (Report a bug).

const logsDir = join(app.getPath('userData'), 'logs')
const scrub = makeScrubber({ home: homedir(), names: userNames() })
const crash = new CrashLog({ dir: logsDir, version: app.getVersion(), dev: !app.isPackaged, scrub })
// Only the installed app checks how its last run ended: development runs are killed all the time.
const watchRuns = app.isPackaged && !process.env.RD_SCREENSHOTS
const marker = join(logsDir, 'running')
let abnormalEnd = false // for the notice, until acknowledged
let endedAbnormally = false // for reports, all session
let damagedShown = 0
let quitting = false
let lastNotice = 0

function userNames(): string[] {
  const names = [basename(homedir())]
  try {
    names.push(userInfo().username)
  } catch {}
  for (const v of [process.env.USERNAME, process.env.USER, process.env.LOGNAME]) if (v) names.push(v)
  return names
}

/** Tells the interface that something went wrong: once per burst, and not for repeats. */
function notice(result: 'new' | 'repeat' | null) {
  if (result !== 'new' || process.env.RD_SCREENSHOTS) return
  const now = Date.now()
  if (now - lastNotice < 60_000) return
  lastNotice = now
  try {
    emit({ type: 'problem-logged' })
  } catch {}
}

function describe(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

// With these handlers Electron no longer shows its own error box; the app keeps running and the
// interface shows a notice instead.
function logMainError(kind: string, err: unknown) {
  try {
    // Writing to a console that has gone away fails like this; logging it would only make more.
    if ((err as NodeJS.ErrnoException | null)?.code === 'EPIPE') return
    const e = err instanceof Error ? err : null
    notice(crash.record({ source: 'main', kind, message: e ? String(e) : describe(err), stack: e?.stack }, true))
    if (!app.isPackaged) console.error(`[rimdeck] ${kind}:`, err)
  } catch {}
}
process.on('uncaughtException', (e) => logMainError('uncaught exception', e))
process.on('unhandledRejection', (r) => logMainError('unhandled rejection', r))

// Reading mods (XML, definitions, DLLs, textures, the game log) runs in worker threads, so the window
// keeps responding. Without workers the same code runs here, as it did before; that is logged once.
const pool = new WorkerPool({
  create: (options) => createWorker(options),
  tasks,
  onFallback: (reason) => {
    console.warn(`[rimdeck] worker threads unavailable, reading mods in the main process: ${reason}`)
    notice(crash.record({ source: 'main', kind: 'workers unavailable', message: `Mods are read in the main process instead, so the window may pause: ${reason}` }))
  },
  onCrash: (reason) => {
    console.warn(`[rimdeck] ${reason}`)
    notice(crash.record({ source: 'main', kind: 'worker stopped', message: reason }))
  },
})

let lastReload = 0
app.on('render-process-gone', (_e, wc, d) => {
  if (quitting || d.reason === 'clean-exit') return
  notice(crash.record({ source: 'window', kind: 'window stopped', message: `The window's process ended unexpectedly (${d.reason}, exit code ${d.exitCode}).` }, true))
  // Load the window again so it isn't left blank and the notice can show; not over and over.
  if (win && wc === win.webContents && !process.env.RD_SCREENSHOTS && Date.now() - lastReload > 60_000) {
    lastReload = Date.now()
    setTimeout(() => {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.reload()
    }, 500)
  }
})
app.on('child-process-gone', (_e, d) => {
  if (quitting || d.reason === 'clean-exit') return
  notice(crash.record({ source: 'window', kind: `${d.type.toLowerCase()} process stopped`, message: `${d.name ?? d.type} ended unexpectedly (${d.reason}, exit code ${d.exitCode}).` }, true))
})

function systemName(): string {
  const name = ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' } as Record<string, string>)[process.platform] ?? process.platform
  let version = ''
  try {
    version = process.getSystemVersion()
  } catch {
    version = release()
  }
  return `${name} ${version} (${process.arch})`
}

const SORT_STYLE: Record<string, string> = { grouped: 'by category', minimal: 'keep my order', alphabetical: 'alphabetical' }

/** What a bug report says about this computer and setup. Works even when RimDeck failed to start. */
async function reportFacts(includeMods: boolean): Promise<ReportFacts> {
  if (service) await Promise.race([ready().catch(() => {}), new Promise((r) => setTimeout(r, 3000))])
  const s = service as Service | undefined
  const st = s?.settings
  const active = s?.config?.activeMods ?? []
  const activeSet = new Set(active)
  const mods = s?.mods ?? []
  const onOff = (v: boolean | undefined) => (v ? 'on' : 'off')
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    system: systemName(),
    electron: `${process.versions.electron} (Chromium ${process.versions.chrome})`,
    game: s?.gameVersion ?? '',
    installed: mods.length,
    active: active.length,
    dlcs: mods.filter((m) => m.source === 'dlc' && activeSet.has(m.packageId)).map((m) => scrub(m.name)),
    sorting: st
      ? [SORT_STYLE[st.sortMode] ?? st.sortMode, `dependencies load first: ${onOff(st.depsAsLoadAfter)}`, `community rules: ${onOff(st.useCommunityRules)}`, `own rules: ${Object.keys(s?.user?.userRules ?? {}).length}`]
      : ['not loaded'],
    checkingAgainst: st?.targetVersion ? `${st.targetVersion} (not the installed game's version)` : undefined,
    abnormalEnd: endedAbnormally,
    damaged: damagedFiles.map((d) => d.file),
    errors: crash.entries().slice(0, 5).map((e) => ({ ...e, kind: scrub(e.kind), message: scrub(e.message), stack: e.stack && scrub(e.stack) })),
    mods: includeMods ? active : undefined,
  }
}

const API = [
  'getState',
  'refresh',
  'getRules',
  'saveModsConfig',
  'reloadConfig',
  'setSettings',
  'detectPaths',
  'setModMeta',
  'setUser',
  'importRimSort',
  'listSaves',
  'listBackups',
  'analyze',
  'readLog',
  'launch',
  'latestSave',
  'prepareContinue',
  'readListFile',
  'writeListFile',
  'workshopCollection',
  'getDownloads',
  'queueDownloads',
  'cancelDownloads',
  'clearDownloads',
  'steamLogin',
  'steamLoginCode',
  'steamLoginCancel',
  'steamLogout',
  'steamUseAccount',
  'installSteamcmd',
  'checkUpdates',
  'textures',
  'xmlReport',
  'searchXml',
  'changes',
  'modSettings',
  'readModSettings',
  'writeModSettings',
  'resetModSettings',
  'modSettingsSchema',
  'archiveSettings',
  'checkGameRunning',
  'loadReport',
  'texturePicks',
  'defData',
  'listInstalls',
  'switchProfile',
  'trashMods',
  'unsubscribeMods',
  'addInstall',
  'renameInstall',
  'removeInstall',
  'pickTexture',
  'unpickTexture',
] as const

const here = dirname(fileURLToPath(import.meta.url))
let win: BrowserWindow | null = null
let service: Service
let initPromise: Promise<void> | null = null
// A failed start is retried on the next call instead of failing every call until restart.
const ready = () =>
  (initPromise ??= service.init().catch((e) => {
    initPromise = null
    throw e
  }))
const sseClients = new Set<import('node:http').ServerResponse>()

// One copy of the installed app at a time: two windows would overwrite each other's settings and mod
// lists. A development run or a screenshot run may sit beside the installed app.
const primary = !app.isPackaged || !!process.env.RD_SCREENSHOTS || app.requestSingleInstanceLock()
if (!primary) app.quit()
// A marker left from last time means that run crashed or was killed. A second copy that quits
// straight away because of the lock above never touches it.
if (primary && watchRuns) endedAbnormally = abnormalEnd = startRun(marker, { version: app.getVersion() })
// A normal end: quitting, the restart for an update (see updateInstall) or the system ending the session.
// Processes that stop after this are part of the end, not errors.
function endNormally() {
  quitting = true
  crash.flush()
  if (primary && watchRuns) endRun(marker)
}
// Not before-quit: closing can still be cancelled at the unsaved-changes question.
app.on('will-quit', endNormally)
app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

function emit(e: AppEvent) {
  // Background work can finish after the window has closed.
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('rd:event', e)
  for (const res of sseClients) res.write(`data: ${JSON.stringify(e)}\n\n`)
}

// The interface reports whether the mod list has unsaved changes, so closing can ask first.
let unsaved = false
// Set once the user agreed to lose them (or an update restart is under way), so closing doesn't ask again.
let discardOk = false
let asking = false

async function confirmDiscard(button: string): Promise<boolean> {
  if (!unsaved || discardOk || process.env.RD_SCREENSHOTS || !win || win.isDestroyed()) return true
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    message: 'You have unsaved changes to the mod list.',
    detail: 'They will be lost.',
    buttons: [button, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  })
  return response === 0
}

// Shell / dialog helpers live here because they need Electron; everything else is in Service.
const native = {
  /** The interface reports its long tasks for the responsiveness log. */
  logInterfaceStall: (ms: number, where: string) => logInterfaceStall(ms, where),
  setUnsaved: (dirty: boolean) => {
    unsaved = !!dirty
  },
  updateState: () => updater.getState(),
  updateCheck: () => updater.check(),
  updateInstall: async () => {
    // Restarting for an update closes the window, so unsaved changes get the same question first.
    if (updater.getState().phase === 'ready') {
      if (asking || !(await confirmDiscard('Restart without saving').catch(() => true))) return
      discardOk = true
      // If the restart doesn't happen after all, closing asks again later.
      setTimeout(() => (discardOk = false), 30000)
      // The installer may end RimDeck before it quits by itself; that is a normal end too.
      if (primary && watchRuns) {
        endRun(marker)
        setTimeout(() => !quitting && startRun(marker, { version: app.getVersion() }), 30000).unref()
      }
    }
    updater.install()
  },
  appVersion: () => app.getVersion(),
  openPath: (p: string) => shell.openPath(p),
  showItem: (p: string) => shell.showItemInFolder(p),
  openUrl: (u: string) => {
    if (/^(https?|steam):\/\//i.test(u)) return shell.openExternal(u)
  },
  pickFolder: async (title: string) => {
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  pickOpenFile: async (title: string, ext: string[]) => {
    const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile'], filters: [{ name: 'Files', extensions: ext }] })
    return r.canceled ? null : r.filePaths[0]
  },
  pickSaveFile: async (title: string, name: string) => {
    const r = await dialog.showSaveDialog(win!, { title, defaultPath: name, filters: [{ name: 'Mod list', extensions: ['xml'] }] })
    return r.canceled ? null : r.filePath
  },
  setTitleBarColor: (bg: string, fg: string) => {
    try {
      win?.setTitleBarOverlay({ color: bg, symbolColor: fg, height: 44 })
    } catch {}
  },
  /** The interface reports its own uncaught errors for the error log. */
  reportError: (e: { kind?: unknown; message?: unknown; stack?: unknown }) => {
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '')
    notice(crash.record({ source: 'renderer', kind: text(e?.kind, 60) || 'error', message: text(e?.message, 4000), stack: text(e?.stack, 20000) || undefined }))
  },
  /** What the notice after trouble shows: an abnormal last run, errors not yet seen, damaged files set aside. */
  crashStatus: (): CrashStatus => {
    if (process.env.RD_SCREENSHOTS) return { abnormalEnd: false, errors: [], unseen: 0, damaged: [] }
    // Newest activity first, so the first entry's time covers all of them when acknowledging.
    const unseen = crash.unseen().sort((a, b) => (b.last ?? b.time).localeCompare(a.last ?? a.time))
    return { abnormalEnd, errors: unseen.slice(0, 5), unseen: unseen.length, damaged: damagedFiles.slice(damagedShown) }
  },
  /** The user has seen the notice: errors up to this time (all when left out) don't bring it back. */
  crashAck: (until?: string) => {
    crash.acknowledge(typeof until === 'string' && until ? until : undefined)
    abnormalEnd = false
    damagedShown = damagedFiles.length
  },
  /** The bug report for the user to read and share themself; everything in it has personal paths removed. */
  bugReport: async (description: unknown, includeMods: unknown): Promise<BugReport> => {
    const desc = scrub(typeof description === 'string' ? description.slice(0, 20000) : '')
    const facts = await reportFacts(includeMods !== false)
    const { url, title, cut } = issueLink(facts, desc)
    return { text: scrub(buildReport(facts, desc)), title, url, cut }
  },
  saveReport: async (text: unknown) => {
    if (typeof text !== 'string') throw new Error('There is no report to save')
    const opts = {
      title: 'Save bug report',
      defaultPath: `RimDeck bug report ${new Date().toISOString().slice(0, 10)}.md`,
      filters: [
        { name: 'Markdown', extensions: ['md'] },
        { name: 'Text', extensions: ['txt'] },
      ],
    }
    const r = await (win && !win.isDestroyed() ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts))
    if (r.canceled || !r.filePath) return null
    await writeFile(r.filePath, scrub(text), 'utf8')
    return r.filePath
  },
  openLogFolder: async () => {
    await mkdir(logsDir, { recursive: true })
    return shell.openPath(logsDir)
  },
  /** A small XML parse in a worker thread; worker is false when this build can't use workers (checked by CI). */
  workerCheck: async () => {
    const t = performance.now()
    const r = await pool.run('xmlCheck', ['<Defs><ThingDef><defName>Steel</defName></ThingDef></Defs>'])
    return { worker: r.inWorker && r.defName === 'Steel', ms: Math.round(performance.now() - t), ...(pool.fallbackReason ? { reason: pool.fallbackReason } : {}) }
  },
}

async function call(method: string, args: unknown[]): Promise<unknown> {
  const done = track(method)
  try {
    if ((API as readonly string[]).includes(method)) {
      await ready()
      return await service.call(method, args)
    }
    if (Object.hasOwn(native, method)) return await (native as any)[method](...args)
    throw new Error(`Unknown method ${method}`)
  } finally {
    done()
  }
}

// Thumbnails are resized once and cached on disk; full images are streamed as-is.
// Mod DDS textures follow Unity's bottom-up row order, so those under Textures/ are flipped to look as they do in game.
// Decoding a large one takes tens of milliseconds, so it runs in a worker; the pixels are moved here, not copied.
async function ddsImage(path: string): Promise<Electron.NativeImage> {
  const bmp = await pool.run('ddsBitmap', [path, /[\\/]textures[\\/]/i.test(path)])
  if (!bmp) throw new Error('unsupported dds')
  const { width, height, bgra } = bmp
  return nativeImage.createFromBitmap(Buffer.from(bgra.buffer, bgra.byteOffset, bgra.byteLength), { width, height })
}

async function image(path: string, width: number): Promise<{ data: Buffer; type: string }> {
  const dds = /\.dds$/i.test(path)
  if (!width && !dds) return { data: await readFile(path), type: /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png' }
  const st = await stat(path)
  const key = createHash('sha1').update(`${path}|${st.mtimeMs}|${width}`).digest('hex')
  const cacheFile = join(app.getPath('userData'), 'thumbs', key + '.png')
  try {
    return { data: await readFile(cacheFile), type: 'image/png' }
  } catch {}
  const img = dds ? await ddsImage(path) : nativeImage.createFromPath(path)
  if (img.isEmpty()) throw new Error('bad image')
  const data = (width ? img.resize({ width, quality: 'good' }) : img).toPNG()
  await mkdir(join(app.getPath('userData'), 'thumbs'), { recursive: true })
  await writeFile(cacheFile, data).catch(() => {})
  return { data, type: 'image/png' }
}

protocol.registerSchemesAsPrivileged([{ scheme: 'rdimg', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

function startBridge() {
  // Dev-only HTTP mirror of the IPC API so the renderer can be driven from a normal browser.
  const dev = 'http://localhost:5173'
  createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', dev)
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
    // Only local tools (which send no Origin) and the dev renderer may call in. The Host check stops
    // DNS rebinding. Browsers mark requests from other sites, even plain <img> loads without an Origin,
    // as Sec-Fetch-Site: cross-site; the dev renderer is cross-site too (localhost vs 127.0.0.1) but
    // names itself in Origin or Referer, which a page elsewhere can't fake.
    const { host, origin, referer } = req.headers
    if (host !== '127.0.0.1:5199' && host !== 'localhost:5199') return res.writeHead(403).end()
    if (origin && origin !== dev) return res.writeHead(403).end()
    const fromDev = origin === dev || (!origin && !!referer?.startsWith(dev + '/'))
    if (req.headers['sec-fetch-site'] === 'cross-site' && !fromDev) return res.writeHead(403).end()
    if (req.method === 'OPTIONS') return res.end()
    const url = new URL(req.url ?? '/', 'http://x')
    try {
      if (url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
        return
      }
      if (url.pathname === '/img') {
        const { data, type } = await image(url.searchParams.get('p') ?? '', Number(url.searchParams.get('w') ?? 0))
        res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=3600' })
        return res.end(data)
      }
      if (url.pathname.startsWith('/api/')) {
        let body = ''
        for await (const chunk of req) body += chunk
        const result = await call(url.pathname.slice(5), body ? JSON.parse(body) : [])
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ ok: true, result: result ?? null }))
      }
      res.writeHead(404).end()
    } catch (e: any) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(e?.message ?? e) }))
    }
  })
    // Another dev copy may already own the port; the bridge is optional, so just skip it.
    .on('error', (e) => console.warn(`[rimdeck] dev bridge not started: ${e.message}`))
    .listen(5199, '127.0.0.1')
}

function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1113',
    titleBarStyle: 'hidden',
    // macOS keeps its own window buttons on the left; Windows and Linux draw theirs over the title bar.
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarOverlay: { color: '#15181b', symbolColor: '#b3ada2', height: 44 } }),
    icon: join(here, '../../resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })
  watchResponsiveness(win, app.getPath('userData'))
  // Windows ending the session (shut down, restart, sign out) may not let RimDeck quit by itself.
  win.on('session-end', endNormally)
  win.once('ready-to-show', () => {
    win?.show()
    if (process.env.RD_SCREENSHOTS)
      void captureScreenshots(win!, process.env.RD_SCREENSHOTS).then(
        () => app.quit(),
        () => app.quit(),
      )
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    native.openUrl(url)
    return { action: 'deny' }
  })
  // The window only ever shows RimDeck: a clicked link or a file dropped on it must not replace the app.
  const page = process.env.ELECTRON_RENDERER_URL
  const appFile = resolve(here, '../renderer/index.html')
  const isApp = (url: string) => {
    try {
      const u = new URL(url)
      if (page) return u.origin === new URL(page).origin
      const p = u.protocol === 'file:' ? fileURLToPath(u) : ''
      return process.platform === 'linux' ? p === appFile : p.toLowerCase() === appFile.toLowerCase()
    } catch {
      return false
    }
  }
  win.webContents.on('will-navigate', (e) => {
    if (isApp(e.url)) return
    e.preventDefault()
    if (/^https?:\/\//i.test(e.url)) native.openUrl(e.url)
  })
  // Closing with unsaved changes asks first. Cmd+Q on macOS comes here too: a cancelled close cancels
  // the quit, and once confirmed the window closes and the app quits as usual.
  win.on('close', (e) => {
    if (!unsaved || discardOk || process.env.RD_SCREENSHOTS) return
    e.preventDefault()
    if (asking) return
    asking = true
    void confirmDiscard('Close without saving')
      .catch(() => true)
      .then((ok) => {
        asking = false
        if (!ok) return
        discardOk = true
        win?.close()
      })
  })
  win.on('closed', () => {
    win = null
    unsaved = false
  })
  // A reload or a crashed page starts again from the saved list.
  win.webContents.on('did-navigate', () => (unsaved = false))
  win.webContents.on('render-process-gone', () => (unsaved = false))
  if (page) win.loadURL(page)
  else win.loadFile(appFile)
}

app.whenReady().then(async () => {
  if (!primary) return
  // The same for macOS and Linux shutting down.
  if (process.platform !== 'win32') powerMonitor.on('shutdown', endNormally)
  protocol.handle('rdimg', async (req) => {
    const url = new URL(req.url)
    const done = track('image')
    try {
      const { data, type } = await image(url.searchParams.get('p') ?? '', Number(url.searchParams.get('w') ?? 0))
      return new Response(new Uint8Array(data), { headers: { 'content-type': type, 'access-control-allow-origin': '*' } })
    } catch {
      return new Response(null, { status: 404 })
    } finally {
      done()
    }
  })
  service = new Service(app.getPath('userData'), emit, { offload: pool })
  ipcMain.handle('rd:invoke', (_e, method: string, args: unknown[]) => call(method, args))
  if ((!app.isPackaged || process.env.RD_BRIDGE) && !process.env.RD_SCREENSHOTS) startBridge()
  createWindow()
  updater.setupUpdater(emit)
})

app.on('window-all-closed', () => {
  service?.dispose()
  app.quit()
})
// Workers end with the process anyway; stopping them first ends their work cleanly.
app.on('will-quit', () => void pool.close())
