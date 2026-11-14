// A small pool of worker threads for the main process's heavy parsing, so the window keeps responding.
// Workers start when work arrives. If they can't be started at all (a packaging or platform problem),
// every task runs in this thread instead, exactly as it did before workers existed.
import { availableParallelism } from 'node:os'
import type { Worker, WorkerOptions } from 'node:worker_threads'
import { unwrap, type JobMessage, type Offload, type RemoteError, type RunOptions, type TaskResult, type TaskTable, type WorkerMessage } from './protocol.ts'

export interface PoolOptions<T extends TaskTable> {
  /** Starts a worker that runs serve() with the same tasks. */
  create: (options: WorkerOptions) => Worker
  /** The tasks themselves, run in this thread when workers are unavailable. */
  tasks: T
  /** Most workers at once; by default one fewer than the processor cores, at most 4, at least 1. */
  size?: number
  /** Jobs one worker runs side by side before others wait for a free worker. */
  perWorker?: number
  /** How long a worker may take to load before the pool gives up on workers. */
  startTimeout?: number
  /** Called once, when tasks start running in this thread because workers are unavailable. */
  onFallback?: (reason: string) => void
  /** A worker stopped unexpectedly after it had started; its jobs failed and it is replaced. */
  onCrash?: (reason: string) => void
}

interface Job {
  id: number
  task: string
  args: unknown[]
  resolve: (v: any) => void
  reject: (e: Error) => void
}

interface Slot {
  index: number
  worker: Worker
  ready: boolean
  /** Sent and not yet answered. */
  running: Map<number, Job>
  /** Assigned while the worker is still loading. */
  waiting: Job[]
  timer: ReturnType<typeof setTimeout> | null
  error: Error | null
  stopping: boolean
}

export const defaultPoolSize = () => Math.max(1, Math.min(4, availableParallelism() - 1))

function remoteError(r: RemoteError, task: string): Error {
  const e = new Error(r.message)
  e.name = r.name
  // The worker's own stack says where it failed.
  e.stack = `${r.stack ?? `${r.name}: ${r.message}`}\n    at worker task ${task}`
  if (r.code) (e as NodeJS.ErrnoException).code = r.code
  return e
}

const describe = (e: unknown) => (e instanceof Error ? e.message : String(e))

export class WorkerPool<T extends TaskTable> implements Offload<T> {
  readonly size: number
  private o: PoolOptions<T>
  private slots: (Slot | undefined)[]
  private queue: Job[] = []
  private seq = 0
  private closed = false
  /** Why tasks run in this thread, once workers turned out to be unavailable. */
  fallbackReason: string | null = null

  constructor(o: PoolOptions<T>) {
    this.o = o
    this.size = Math.max(1, Math.floor(o.size ?? defaultPoolSize()))
    this.slots = new Array(this.size).fill(undefined)
  }

  /** True while tasks go to worker threads (or will, once one has started). */
  get usingWorkers() {
    return !this.fallbackReason && !this.closed
  }

  /** Workers started and not stopped. */
  get workers() {
    return this.slots.filter((s) => s && !s.stopping).length
  }

  run<K extends keyof T & string>(task: K, args: Parameters<T[K]>, opts: RunOptions = {}): Promise<TaskResult<T, K>> {
    if (this.closed) return Promise.reject(new Error('The worker pool is closed'))
    if (this.fallbackReason) return this.local(task, args)
    return new Promise((resolve, reject) => {
      const job: Job = { id: ++this.seq, task, args, resolve, reject }
      if (opts.key === undefined) {
        this.queue.push(job)
        this.pump()
        return
      }
      const index = this.slotFor(opts.key)
      const slot = this.slots[index] ?? this.start(index)
      if (slot) this.assign(slot, job)
      else this.local(task, args).then(resolve, reject) // could not start: now running in this thread
    })
  }

  /** Stops every worker. Jobs not finished yet fail; later calls are refused. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const gone = new Error('The worker pool was closed')
    for (const job of this.queue.splice(0)) job.reject(gone)
    const stops: Promise<unknown>[] = []
    for (const slot of this.slots) {
      if (!slot) continue
      for (const job of [...slot.running.values(), ...slot.waiting.splice(0)]) job.reject(gone)
      slot.running.clear()
      stops.push(this.stop(slot))
    }
    this.slots.fill(undefined)
    await Promise.all(stops)
  }

  private local<K extends keyof T & string>(task: K, args: unknown[]): Promise<TaskResult<T, K>> {
    return Promise.resolve()
      .then(() => {
        const fn = Object.hasOwn(this.o.tasks, task) ? this.o.tasks[task] : undefined
        if (typeof fn !== 'function') throw new Error(`Unknown worker task ${task}`)
        return fn(...args)
      })
      .then(unwrap) as Promise<TaskResult<T, K>>
  }

  private slotFor(key: string) {
    let h = 0
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
    return h % this.size
  }

  private load(s: Slot) {
    return s.running.size + s.waiting.length
  }

  /** Hands queued jobs to the least busy worker, starting another one while there is room for it. */
  private pump() {
    const cap = Math.max(1, this.o.perWorker ?? 4)
    while (this.queue.length && !this.fallbackReason && !this.closed) {
      let best: Slot | undefined
      for (const s of this.slots) if (s && !s.stopping && this.load(s) < cap && (!best || this.load(s) < this.load(best))) best = s
      if (!best) {
        const free = this.slots.findIndex((s) => !s)
        if (free < 0) return // every worker is busy; finished jobs call pump again
        best = this.start(free) ?? undefined
        if (!best) return // could not start: the queue now runs in this thread
      }
      this.assign(best, this.queue.shift()!)
    }
  }

  // A worker with work keeps the process running until that work is done; an idle one never does.
  private hold(slot: Slot) {
    if (this.load(slot)) slot.worker.ref()
    else slot.worker.unref()
  }

  private assign(slot: Slot, job: Job) {
    if (!slot.ready) slot.waiting.push(job)
    else {
      slot.running.set(job.id, job)
      try {
        slot.worker.postMessage({ id: job.id, task: job.task, args: job.args } satisfies JobMessage)
      } catch (e) {
        // Arguments that can't be copied to another thread.
        slot.running.delete(job.id)
        job.reject(e instanceof Error ? e : new Error(String(e)))
      }
    }
    this.hold(slot)
  }

  private start(index: number): Slot | null {
    let worker: Worker
    try {
      // Not the parent's Node options: some (--input-type, --inspect-brk…) stop a worker from loading or starting.
      worker = this.o.create({ name: `rimdeck-worker-${index + 1}`, execArgv: [] })
    } catch (e) {
      this.giveUp(`a worker could not be created: ${describe(e)}`)
      return null
    }
    const slot: Slot = { index, worker, ready: false, running: new Map(), waiting: [], timer: null, error: null, stopping: false }
    this.slots[index] = slot
    this.hold(slot)
    slot.timer = setTimeout(() => {
      slot.timer = null
      if (slot.ready || slot.stopping) return
      this.giveUp(`a worker did not start within ${this.startTimeout / 1000} s`)
    }, this.startTimeout)
    slot.timer.unref?.()
    worker.on('message', (m: WorkerMessage) => this.message(slot, m))
    worker.on('error', (e) => (slot.error ??= e))
    // A message that arrived but could not be read: its job would wait forever, so the worker is
    // replaced and its jobs fail.
    worker.on('messageerror', (e) => {
      slot.error ??= e instanceof Error ? e : new Error(String(e))
      void worker.terminate()
    })
    worker.on('exit', (code) => this.exited(slot, code))
    return slot
  }

  private get startTimeout() {
    return this.o.startTimeout ?? 20_000
  }

  private message(slot: Slot, m: WorkerMessage) {
    if (m.type === 'ready') {
      slot.ready = true
      if (slot.timer) clearTimeout(slot.timer)
      slot.timer = null
      for (const job of slot.waiting.splice(0)) this.assign(slot, job)
      return
    }
    const job = slot.running.get(m.id)
    if (!job) return
    slot.running.delete(m.id)
    this.hold(slot)
    if (m.type === 'done') job.resolve(m.value)
    else job.reject(remoteError(m.error, job.task))
    if (this.fallbackReason && !slot.running.size) void this.stop(slot)
    else this.pump()
  }

  private exited(slot: Slot, code: number) {
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = null
    if (this.slots[slot.index] === slot) this.slots[slot.index] = undefined
    if (slot.stopping) return
    const why = slot.error ? describe(slot.error) : `exit code ${code}`
    if (!slot.ready) {
      // Never loaded, so none of its jobs ran: they run in this thread, like everything after.
      this.giveUp(`a worker failed to load: ${why}`, slot)
      return
    }
    const jobs = [...slot.running.values()]
    slot.running.clear()
    for (const job of jobs) job.reject(new Error(`The worker running ${job.task} stopped unexpectedly (${why})`))
    try {
      this.o.onCrash?.(`worker stopped while running ${jobs.map((j) => j.task).join(', ') || 'nothing'}: ${why}`)
    } catch {}
    this.pump() // a new worker takes over the queue
  }

  /** From now on every task runs in this thread. */
  private giveUp(reason: string, failed?: Slot) {
    if (!this.fallbackReason) {
      this.fallbackReason = reason
      try {
        this.o.onFallback?.(reason)
      } catch {}
    }
    const orphans = [...this.queue.splice(0)]
    for (const slot of this.slots) {
      if (!slot || slot.ready) continue
      orphans.push(...slot.waiting.splice(0))
      void this.stop(slot)
    }
    if (failed) orphans.push(...failed.waiting.splice(0))
    for (const job of orphans) this.local(job.task, job.args).then(job.resolve, job.reject)
    // Workers that did start finish what they are running, then stop (see message).
    for (const slot of this.slots) if (slot?.ready && !slot.running.size) void this.stop(slot)
  }

  private stop(slot: Slot): Promise<unknown> {
    slot.stopping = true
    if (slot.timer) clearTimeout(slot.timer)
    slot.timer = null
    if (this.slots[slot.index] === slot) this.slots[slot.index] = undefined
    return slot.worker.terminate().catch(() => {})
  }
}

/** Runs the tasks in this thread: what the service uses when no pool is given (tests, scripts). */
export class InProcess<T extends TaskTable> implements Offload<T> {
  private tasks: T
  constructor(tasks: T) {
    this.tasks = tasks
  }
  run<K extends keyof T & string>(task: K, args: Parameters<T[K]>): Promise<TaskResult<T, K>> {
    return Promise.resolve()
      .then(() => this.tasks[task](...args))
      .then(unwrap) as Promise<TaskResult<T, K>>
  }
}
