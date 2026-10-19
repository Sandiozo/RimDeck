import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { chmod, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import type { DownloadJob, DownloadsState, SteamAccount, SteamLoginState, WorkshopDetails } from '../../shared/types.ts'
import { APP_ID } from './workshop.ts'

const IS_WIN = process.platform === 'win32'
const INSTALLER = IS_WIN
  ? 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
  : process.platform === 'darwin'
    ? 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz'
    : 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz'
const BATCH = 20 // items per SteamCMD session
const MAX_ATTEMPTS = 3 // SteamCMD resumes timed-out downloads on the next run

async function exists(p: string) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

// Just enough of the zip format for Valve's installer (stored or deflated entries, no zip64).
function unzip(buf: Buffer): { name: string; data: Buffer }[] {
  let eocd = buf.length - 22
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('Not a zip file')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: { name: string; data: Buffer }[] = []
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip directory')
    const method = buf.readUInt16LE(p + 10)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
    if (name.endsWith('/')) continue
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const raw = buf.subarray(start, start + size)
    if (method !== 0 && method !== 8) throw new Error(`Unsupported zip method ${method}`)
    out.push({ name, data: method === 8 ? inflateRawSync(raw) : raw })
  }
  return out
}

export interface RunResult {
  done: Map<string, string> // id -> folder SteamCMD wrote
  failed: Map<string, string> // id -> reason
  loginFailed?: string // the saved Steam session was rejected
}

export type LoginResult = { ok: true } | { ok: false; need: 'password' | 'email' | '2fa' | null; message: string }

const STEAM_USER = /^[A-Za-z0-9_.@-]{2,64}$/
export const validSteamUser = (u: string) => STEAM_USER.test(u)

// Anonymous failures that a Steam account owning RimWorld can fix.
export const NEEDS_LOGIN = /access denied|no subscription|not logged on|license|logon|login/i

/** A private SteamCMD install (default: %APPDATA%/RimDeck/steamcmd) used only for anonymous Workshop downloads. */
export class SteamCmd {
  dir: string
  child: ChildProcess | null = null
  cancelled = false

  constructor(dir: string) {
    this.dir = dir
  }

  get exe() {
    return join(this.dir, IS_WIN ? 'steamcmd.exe' : 'steamcmd.sh')
  }

  get contentDir() {
    return join(this.dir, 'steamapps', 'workshop', 'content', APP_ID)
  }

  installed() {
    return exists(this.exe)
  }

  async install(onLine: (l: string) => void) {
    await mkdir(this.dir, { recursive: true })
    onLine(`Downloading ${INSTALLER}`)
    const res = await fetch(INSTALLER, { signal: AbortSignal.timeout(120000) })
    if (!res.ok) throw new Error(`SteamCMD download failed (${res.status})`)
    const buf = Buffer.from(await res.arrayBuffer())
    if (IS_WIN) {
      for (const f of unzip(buf)) {
        const dest = resolve(this.dir, f.name)
        if (relative(this.dir, dest).startsWith('..')) continue
        await writeFile(dest, f.data)
      }
    } else {
      const archive = join(this.dir, 'steamcmd.tar.gz')
      await writeFile(archive, buf)
      await new Promise<void>((ok, fail) => execFile('tar', ['-xzf', archive, '-C', this.dir], (e) => (e ? fail(e) : ok())))
      await rm(archive, { force: true })
      await chmod(this.exe, 0o755).catch(() => {})
    }
    // The first run downloads the real client (~40 MB); it can exit non-zero after updating itself.
    onLine('Updating SteamCMD (first run takes a minute)…')
    for (let i = 0; i < 2; i++) {
      const code = await this.exec(['+quit'], onLine)
      if (code === 0) break
    }
  }

  exec(args: string[], onLine: (l: string) => void): Promise<number | null> {
    return new Promise((ok, fail) => {
      const child = spawn(this.exe, args, { cwd: this.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      this.child = child
      let rest = ''
      const feed = (chunk: Buffer) => {
        const parts = (rest + chunk.toString('utf8')).split(/\r\n|\r|\n/)
        rest = parts.pop() ?? ''
        for (const p of parts) {
          const line = p.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trimEnd()
          if (line.trim()) onLine(line)
        }
      }
      child.stdout!.on('data', feed)
      child.stderr!.on('data', feed)
      child.on('error', fail)
      child.on('close', (code) => {
        if (rest.trim()) onLine(rest.trim())
        this.child = null
        ok(code)
      })
    })
  }

  /**
   * Downloads a batch in one session: anonymous, or `user` with the session SteamCMD cached at login
   * (never a password). Each item lands in contentDir/<id>.
   */
  async download(ids: string[], onLine: (l: string) => void, onItem: (id: string, ok: boolean, info: string) => void, user?: string): Promise<RunResult> {
    const result: RunResult = { done: new Map(), failed: new Map() }
    // SteamCMD skips items its own manifest says are current, even after we moved the folder out.
    await rm(join(this.dir, 'steamapps', 'workshop', `appworkshop_${APP_ID}.acf`), { force: true })
    for (const id of ids) await rm(join(this.contentDir, id), { recursive: true, force: true }) // leftovers in our own staging folder
    const script = join(this.dir, 'rimdeck-batch.txt')
    const login = user && validSteamUser(user) ? `login ${user}` : 'login anonymous'
    await writeFile(script, ['@ShutdownOnFailedCommand 0', '@NoPromptForPassword 1', login, ...ids.map((id) => `workshop_download_item ${APP_ID} ${id}`), 'quit', ''].join('\n'))
    const want = new Set(ids)
    const code = await this.exec(['+runscript', script], (line) => {
      onLine(line)
      const lf = line.match(/FAILED \(([^)]*)\)|Login Failure: (.+)/)
      if (lf && user && !result.loginFailed && !result.done.size) result.loginFailed = lf[1] ?? lf[2]
      let m = line.match(/Success\. Downloaded item (\d+) to "([^"]+)"/)
      if (m && want.has(m[1])) {
        result.done.set(m[1], m[2])
        return onItem(m[1], true, m[2])
      }
      m = line.match(/ERROR! (?:Download item (\d+) failed \(([^)]*)\)|Timeout downloading item (\d+))/)
      if (m) {
        const id = m[1] ?? m[3]
        const reason = m[2] ?? 'Timeout'
        if (want.has(id) && !result.done.has(id)) {
          result.failed.set(id, reason)
          onItem(id, false, reason)
        }
      }
    })
    for (const id of ids)
      if (!result.done.has(id) && !result.failed.has(id)) {
        // Output can be lost when SteamCMD exits abruptly; trust the folder if it is there.
        const dir = join(this.contentDir, id)
        if (!this.cancelled && (await exists(dir))) result.done.set(id, dir)
        else result.failed.set(id, this.cancelled ? 'Cancelled' : `No result from SteamCMD (exit ${code})`)
      }
    return result
  }

  cancel() {
    this.cancelled = true
    const pid = this.child?.pid
    if (!pid) return
    if (IS_WIN) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {})
    else this.child?.kill()
  }

  /**
   * One login attempt; SteamCMD caches the session so later runs only need `login <user>`.
   * On Windows SteamCMD buffers stdout and ignores stdin when they are pipes, so prompts are read live from
   * logs/console_log.txt, and a run that stops at a Steam Guard prompt is ended: the caller asks the user and
   * retries with the code as `login`'s third argument. `password`/`code` are masked in everything passed on.
   */
  async login(user: string, password: string | null, code: string | null, onLine: (l: string) => void, onMobileConfirm: () => void): Promise<LoginResult> {
    if (!validSteamUser(user)) return { ok: false, need: null, message: 'This is not a valid Steam account name' }
    const secrets = [password, code].filter((s): s is string => !!s)
    const mask = (t: string) => secrets.reduce((acc, s) => acc.split(s).join('****'), t)
    const log = join(this.dir, 'logs', 'console_log.txt')
    let offset = (await stat(log).catch(() => null))?.size ?? 0
    let seen = ''
    let outcome: LoginResult | null = null
    let waitingMobile = false
    const stop = (r: LoginResult) => {
      outcome ??= r
      this.cancel()
    }
    const inspect = (text: string) => {
      seen += text
      if (outcome) return
      const failed = seen.match(/FAILED \(([^)]*)\)|Login Failure: ([^\r\n]+)/)
      const why = mask((failed?.[1] ?? failed?.[2] ?? '').trim())
      if (/two.?factor|mobile authenticator code/i.test(seen)) stop({ ok: false, need: '2fa', message: why })
      else if (/steam guard code|check your email|account ?logon ?denied/i.test(seen)) stop({ ok: false, need: 'email', message: why })
      else if (/no cached credentials|password:\s*$/im.test(seen)) stop({ ok: false, need: 'password', message: '' })
      else if (/invalid password/i.test(seen)) stop({ ok: false, need: 'password', message: 'Wrong account name or password' })
      else if (failed) stop({ ok: false, need: null, message: why || 'Login failed' })
      else if (!waitingMobile && /steam mobile app|confirm the login|confirm.*on your (phone|device)/i.test(seen)) {
        waitingMobile = true
        onMobileConfirm()
      }
    }
    const poll = setInterval(async () => {
      try {
        const buf = await readFile(log)
        if (buf.length < offset) offset = 0 // rotated
        if (buf.length > offset) inspect(buf.subarray(offset).toString('utf8'))
        offset = buf.length
      } catch {}
    }, 400)
    const timeout = setTimeout(() => stop({ ok: false, need: null, message: 'Timed out waiting for Steam' }), 5 * 60 * 1000)
    this.cancelled = false
    const args = ['+@NoPromptForPassword', '1', '+login', user, ...(password ? [password] : []), ...(password && code ? [code] : []), '+quit']
    let exit: number | null = null
    try {
      exit = await this.exec(args, (l) => {
        const line = mask(l)
        onLine(line)
        inspect(line + '\n')
      })
    } finally {
      clearInterval(poll)
      clearTimeout(timeout)
    }
    if (outcome) return outcome
    if (this.cancelled) return { ok: false, need: null, message: 'Cancelled' }
    return exit === 0 ? { ok: true } : { ok: false, need: null, message: `SteamCMD exited with code ${exit}` }
  }

  /** Ends the cached session (best effort: needs the session to still be valid). */
  async logout(user: string, onLine: (l: string) => void) {
    if (!validSteamUser(user)) return
    const timer = setTimeout(() => this.cancel(), 60000)
    try {
      await this.exec(['+@NoPromptForPassword', '1', '+login', user, '+logout', '+quit'], onLine)
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Moves a finished download from SteamCMD's content folder into the local mods folder.
 * An existing copy is handed to `retire` (Recycle Bin) first and never deleted outright.
 */
export async function installInto(src: string, dest: string, id: string, retire: (p: string) => Promise<void>) {
  if (await exists(dest)) await retire(dest)
  if (await exists(dest)) throw new Error(`Could not move the old copy out of ${dest}`)
  try {
    await rename(src, dest)
  } catch {
    // Different drive (SteamCMD lives in %APPDATA%): copy, then remove our own staging copy.
    await cp(src, dest, { recursive: true })
    await rm(src, { recursive: true, force: true })
  }
  // Lets the scanner (and RimWorld) tie the local copy back to its Workshop page.
  const about = (await readdir(dest).catch(() => [] as string[])).find((n) => n.toLowerCase() === 'about')
  if (about) {
    const entries = await readdir(join(dest, about))
    if (!entries.some((n) => n.toLowerCase() === 'publishedfileid.txt')) await writeFile(join(dest, about, 'PublishedFileId.txt'), id, 'utf8')
  }
}

export interface QueueHooks {
  emit(state: DownloadsState): void
  targetFor(id: string): { dir: string; replace?: string } | string // string = reason it can't be downloaded
  retire(path: string): Promise<void>
  installed(id: string, path: string, job: DownloadJob): Promise<void> // after each item
  finished(): Promise<void> // after the queue drains
}

/** Download queue in the main process so it survives renderer reloads. */
export class DownloadQueue {
  steamcmd: SteamCmd
  hooks: QueueHooks
  jobs: DownloadJob[] = []
  phase: DownloadsState['phase'] = 'idle'
  log: string[] = []
  steamcmdInstalled = false
  targetDir = ''
  emitTimer: NodeJS.Timeout | null = null
  cancelPick: Set<string> | null = null
  account: SteamAccount = { user: '', loggedIn: false, useForDownloads: false }
  loginState: SteamLoginState = { phase: 'idle' }
  // Held only while a Steam Guard code is pending, so the retry can send it; never written anywhere.
  pendingPassword: string | null = null

  constructor(steamcmd: SteamCmd, hooks: QueueHooks) {
    this.steamcmd = steamcmd
    this.hooks = hooks
    steamcmd.installed().then((v) => (this.steamcmdInstalled = v))
    readFile(this.accountFile, 'utf8')
      .then((t) => (this.account = { ...this.account, ...JSON.parse(t) }))
      .catch(() => {})
  }

  get accountFile() {
    return join(this.steamcmd.dir, 'rimdeck-account.json')
  }

  async saveAccount() {
    const { user, loggedIn, useForDownloads } = this.account
    await mkdir(this.steamcmd.dir, { recursive: true })
    await writeFile(this.accountFile, JSON.stringify({ user, loggedIn, useForDownloads }, null, 2), 'utf8')
  }

  state(): DownloadsState {
    return {
      jobs: this.jobs,
      phase: this.phase,
      steamcmd: { installed: this.steamcmdInstalled, dir: this.steamcmd.dir },
      targetDir: this.targetDir,
      log: this.log.slice(-300),
      account: this.account,
      login: this.loginState,
    }
  }

  setLogin(s: SteamLoginState) {
    this.loginState = s
    this.changed(true)
  }

  /**
   * Starts or continues a login. No password = try the session SteamCMD cached; a code = retry the pending
   * password with that Steam Guard code. Runs in the background and reports through state events.
   */
  async login(user: string, password: string | null, code: string | null) {
    user = user.trim()
    if (!validSteamUser(user)) return this.setLogin({ phase: 'error', message: 'This is not a valid Steam account name' })
    if (this.running) return this.setLogin({ phase: 'error', message: 'Wait for the current downloads to finish' })
    if (code) password = this.pendingPassword
    if (code && !password) return this.setLogin({ phase: 'need-password', message: 'Enter your password again' })
    this.running = true
    this.phase = 'login'
    if (user !== this.account.user) this.account = { ...this.account, user, loggedIn: false }
    this.setLogin({ phase: 'working', message: code ? 'Sending code…' : password ? 'Logging in…' : 'Checking the saved session…' })
    try {
      await this.ensureSteamcmd()
      this.phase = 'login'
      const r = await this.steamcmd.login(user, password, code, (l) => this.line(l), () =>
        this.setLogin({ phase: 'confirm-mobile', message: 'Approve this login in the Steam Mobile app' }),
      )
      if (r.ok) {
        this.pendingPassword = null
        this.account = { ...this.account, user, loggedIn: true }
        this.setLogin({ phase: 'idle', message: `Logged in as ${user}` })
      } else if (r.need === 'email' || r.need === '2fa') {
        this.pendingPassword = password
        const again = code ? 'The code was not accepted. ' : ''
        this.setLogin({ phase: 'need-code', codeKind: r.need, message: again + (r.need === 'email' ? 'Enter the Steam Guard code sent to your email' : 'Enter the code from your Steam Mobile authenticator') })
      } else if (r.need === 'password') {
        this.pendingPassword = null
        this.account = { ...this.account, loggedIn: false }
        this.setLogin({ phase: 'need-password', message: r.message || (password ? 'Steam asked for the password again' : 'No saved session. Enter your password.') })
      } else {
        this.pendingPassword = null
        this.account = { ...this.account, loggedIn: false }
        this.setLogin({ phase: 'error', message: r.message })
      }
    } catch (e: any) {
      this.pendingPassword = null
      this.setLogin({ phase: 'error', message: String(e?.message ?? e) })
    } finally {
      this.running = false
      this.phase = 'idle'
      await this.saveAccount().catch(() => {})
      this.changed(true)
      void this.pump()
    }
  }

  cancelLogin() {
    this.pendingPassword = null
    if (this.phase === 'login') this.steamcmd.cancel()
    this.setLogin({ phase: 'idle', message: 'Login cancelled' })
  }

  async logout() {
    const user = this.account.user
    this.pendingPassword = null
    this.account = { user: '', loggedIn: false, useForDownloads: false }
    this.setLogin({ phase: 'idle', message: user ? `Logged out ${user}` : undefined })
    await this.saveAccount()
    if (user && !this.running && (await this.steamcmd.installed())) {
      this.running = true
      try {
        await this.steamcmd.logout(user, (l) => this.line(l))
      } finally {
        this.running = false
        this.changed(true)
        void this.pump()
      }
    }
  }

  async useAccount(on: boolean) {
    this.account = { ...this.account, useForDownloads: on && !!this.account.user }
    await this.saveAccount()
    this.changed(true)
  }

  // Coalesce bursts of SteamCMD output into a few UI updates per second.
  changed(now = false) {
    if (now) {
      if (this.emitTimer) clearTimeout(this.emitTimer)
      this.emitTimer = null
      return this.hooks.emit(this.state())
    }
    this.emitTimer ??= setTimeout(() => {
      this.emitTimer = null
      this.hooks.emit(this.state())
    }, 200)
  }

  line(l: string) {
    this.log.push(l)
    if (this.log.length > 600) this.log = this.log.slice(-300)
    this.changed()
  }

  add(details: WorkshopDetails[], update: (id: string) => boolean) {
    for (const d of details) {
      const existing = this.jobs.find((j) => j.workshopId === d.workshopId)
      if (existing && (existing.status === 'queued' || existing.status === 'downloading' || existing.status === 'installing')) continue
      const job: DownloadJob = { workshopId: d.workshopId, title: d.title, size: d.size, status: 'queued', update: update(d.workshopId), attempts: 0, addedAt: Date.now() }
      if (!d.ok) Object.assign(job, { status: 'failed', message: 'Not available on the Workshop (removed, private or not a RimWorld mod)', finishedAt: Date.now() })
      this.jobs = [...this.jobs.filter((j) => j !== existing), job]
    }
    this.changed(true)
    void this.pump()
  }

  set(id: string, patch: Partial<DownloadJob>) {
    this.jobs = this.jobs.map((j) => (j.workshopId === id ? { ...j, ...patch } : j))
    this.changed()
  }

  cancel(ids?: string[]) {
    const all = !ids
    const pick = new Set(ids ?? [])
    const running = this.jobs.some((j) => j.status === 'downloading' && (all || pick.has(j.workshopId)))
    this.jobs = this.jobs.map((j) =>
      (all || pick.has(j.workshopId)) && j.status === 'queued' ? { ...j, status: 'cancelled', message: 'Cancelled', finishedAt: Date.now() } : j,
    )
    // One SteamCMD session serves the whole batch, so stopping one running item stops the session; the rest are re-queued.
    if (running) {
      this.cancelPick = all ? null : pick
      this.steamcmd.cancel()
    }
    this.changed(true)
  }

  clear() {
    this.jobs = this.jobs.filter((j) => j.status === 'queued' || j.status === 'downloading' || j.status === 'installing')
    this.log = []
    this.changed(true)
  }

  async ensureSteamcmd() {
    if (await this.steamcmd.installed()) return (this.steamcmdInstalled = true)
    this.phase = 'installing-steamcmd'
    this.changed(true)
    await this.steamcmd.install((l) => this.line(l))
    this.steamcmdInstalled = await this.steamcmd.installed()
    if (!this.steamcmdInstalled) throw new Error('SteamCMD did not install correctly')
    return true
  }

  running = false
  async pump() {
    if (this.running) return
    this.running = true
    let installedAny = false
    try {
      while (this.jobs.some((j) => j.status === 'queued')) {
        try {
          await this.ensureSteamcmd()
        } catch (e: any) {
          const message = `SteamCMD setup failed: ${e?.message ?? e}`
          this.line(message)
          this.jobs = this.jobs.map((j) => (j.status === 'queued' ? { ...j, status: 'failed', message, finishedAt: Date.now() } : j))
          break
        }
        const batch = this.jobs.filter((j) => j.status === 'queued').slice(0, BATCH)
        const targets = new Map<string, { dir: string; replace?: string }>()
        for (const j of batch) {
          const t = this.hooks.targetFor(j.workshopId)
          if (typeof t === 'string') this.set(j.workshopId, { status: 'failed', message: t, finishedAt: Date.now() })
          else {
            targets.set(j.workshopId, t)
            this.set(j.workshopId, { status: 'downloading', attempts: j.attempts + 1, message: undefined })
          }
        }
        if (!targets.size) continue
        this.phase = 'downloading'
        this.steamcmd.cancelled = false
        this.changed(true)
        const ids = [...targets.keys()]
        // Items are moved into the mods folder as soon as SteamCMD reports them, while the rest keep downloading.
        const installs = new Map<string, Promise<void>>()
        const install = (id: string, src: string) => {
          if (installs.has(id)) return
          const t = targets.get(id)!
          const dest = t.replace ?? join(t.dir, id)
          this.set(id, { status: 'installing' })
          installs.set(
            id,
            (async () => {
              try {
                await installInto(src, dest, id, (p) => this.hooks.retire(p))
                await this.hooks.installed(id, dest, this.jobs.find((j) => j.workshopId === id)!)
                this.set(id, { status: 'done', path: dest, message: undefined, finishedAt: Date.now() })
                installedAny = true
              } catch (e: any) {
                this.set(id, { status: 'failed', message: `Install failed: ${e?.message ?? e}`, finishedAt: Date.now() })
              }
            })(),
          )
        }
        let result: RunResult
        try {
          const user = this.account.useForDownloads && this.account.user ? this.account.user : undefined
          result = await this.steamcmd.download(ids, (l) => this.line(l), (id, ok, info) => (ok ? install(id, info) : this.set(id, { message: info })), user)
        } catch (e: any) {
          result = { done: new Map(), failed: new Map(ids.map((id) => [id, String(e?.message ?? e)])) }
        }
        for (const [id, src] of result.done) install(id, src)
        await Promise.all(installs.values())
        const cancelled = this.steamcmd.cancelled
        if (result.loginFailed) {
          // The cached session was rejected: stop using it until the user logs in again.
          this.account = { ...this.account, loggedIn: false }
          void this.saveAccount().catch(() => {})
          this.loginState = { phase: 'need-password', message: `Steam rejected the saved session (${result.loginFailed}). Enter your password.` }
        }
        for (const [id, reason] of result.failed) {
          const job = this.jobs.find((j) => j.workshopId === id)!
          if (result.loginFailed && !cancelled)
            this.set(id, { status: 'failed', message: 'Steam session expired. Log in again under Steam account.', needsLogin: true, finishedAt: Date.now() })
          else if (!this.account.useForDownloads && NEEDS_LOGIN.test(reason) && !cancelled)
            this.set(id, { status: 'failed', message: `${reason}. This item may require a Steam account that owns RimWorld.`, needsLogin: true, finishedAt: Date.now() })
          else if (cancelled) {
            // Only the items the user stopped are cancelled; the rest of the batch goes back in line.
            if (!this.cancelPick || this.cancelPick.has(id)) this.set(id, { status: 'cancelled', message: 'Cancelled', finishedAt: Date.now() })
            else this.set(id, { status: 'queued', attempts: job.attempts - 1 })
          } else if (job.attempts < MAX_ATTEMPTS && /timeout|no result/i.test(reason)) this.set(id, { status: 'queued', message: `${reason}. Retrying…` })
          else this.set(id, { status: 'failed', message: reason, finishedAt: Date.now() })
        }
        this.cancelPick = null
      }
    } finally {
      this.phase = 'idle'
      this.running = false
      this.changed(true)
      if (installedAny) await this.hooks.finished().catch(() => {})
    }
  }
}
