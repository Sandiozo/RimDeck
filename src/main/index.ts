import { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, shell } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppEvent } from '../shared/types.ts'
import { Service } from './service.ts'
import * as updater from './updater.ts'
import { captureScreenshots } from './screenshots.ts'
import { decodeDds } from './core/dds.ts'

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
  'readSave',
  'listBackups',
  'analyze',
  'readLog',
  'launch',
  'restoreBackup',
  'readListFile',
  'writeListFile',
  'lookupWorkshop',
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
  'archiveSettings',
  'checkGameRunning',
  'loadReport',
  'texturePicks',
  'defData',
  'listInstalls',
  'switchProfile',
  'trashMods',
  'unsubscribeMods',
  'switchInstall',
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
const ready = () => (initPromise ??= service.init())
const sseClients = new Set<import('node:http').ServerResponse>()

function emit(e: AppEvent) {
  win?.webContents.send('rd:event', e)
  for (const res of sseClients) res.write(`data: ${JSON.stringify(e)}\n\n`)
}

// Shell / dialog helpers live here because they need Electron; everything else is in Service.
const native = {
  updateState: () => updater.getState(),
  updateCheck: () => updater.check(),
  updateInstall: () => updater.install(),
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
}

async function call(method: string, args: unknown[]): Promise<unknown> {
  if ((API as readonly string[]).includes(method)) {
    await ready()
    return (service as any)[method](...args)
  }
  if (method in native) return (native as any)[method](...args)
  throw new Error(`Unknown method ${method}`)
}

// Thumbnails are resized once and cached on disk; full images are streamed as-is.
// Mod DDS textures follow Unity's bottom-up row order, so those under Textures/ are flipped to look as they do in game.
async function ddsImage(path: string): Promise<Electron.NativeImage> {
  const decoded = decodeDds(new Uint8Array(await readFile(path)))
  if (!decoded) throw new Error('unsupported dds')
  const { width, height, rgba } = decoded
  const flip = /[\\/]textures[\\/]/i.test(path)
  const bgra = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const src = (flip ? height - 1 - y : y) * width * 4
    const dst = y * width * 4
    for (let x = 0; x < width * 4; x += 4) {
      bgra[dst + x] = rgba[src + x + 2]
      bgra[dst + x + 1] = rgba[src + x + 1]
      bgra[dst + x + 2] = rgba[src + x]
      bgra[dst + x + 3] = rgba[src + x + 3]
    }
  }
  return nativeImage.createFromBitmap(bgra, { width, height })
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
  createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', 'http://localhost:5173')
    res.setHeader('Access-Control-Allow-Headers', 'content-type')
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
    backgroundColor: '#0a0b0e',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0a0b0e', symbolColor: '#9aa3b2', height: 44 },
    icon: join(here, '../../resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  })
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
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(here, '../renderer/index.html'))
}

app.whenReady().then(async () => {
  protocol.handle('rdimg', async (req) => {
    const url = new URL(req.url)
    try {
      const { data, type } = await image(url.searchParams.get('p') ?? '', Number(url.searchParams.get('w') ?? 0))
      return new Response(new Uint8Array(data), { headers: { 'content-type': type, 'access-control-allow-origin': '*' } })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
  service = new Service(app.getPath('userData'), emit)
  ipcMain.handle('rd:invoke', (_e, method: string, args: unknown[]) => call(method, args))
  if ((!app.isPackaged || process.env.RD_BRIDGE) && !process.env.RD_SCREENSHOTS) startBridge()
  createWindow()
  updater.setupUpdater(emit)
})

app.on('window-all-closed', () => {
  service?.dispose()
  app.quit()
})
