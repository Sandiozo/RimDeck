// The messages between the main process and its worker threads. Nothing here (or in pool.ts,
// serve.ts, tasks.ts, worker.ts) imports Electron, so all of it also runs under plain Node.

/** Functions a worker can run: plain data in, plain data (or a Transfer of it) out. */
export type TaskTable = Record<string, (...args: any[]) => unknown>

/** What a task gives back once any Transfer wrapper is taken off. */
export type TaskResult<T extends TaskTable, K extends keyof T> = Unwrap<Awaited<ReturnType<T[K]>>>
type Unwrap<R> = R extends Transfer<infer V> ? V : R

export interface RunOptions {
  /**
   * Jobs with the same key always go to the same worker, so caches that worker keeps between jobs
   * (parsed definitions, for instance) are used again.
   */
  key?: string
}

/** Runs tasks somewhere: in worker threads, or in this thread when workers are unavailable. */
export interface Offload<T extends TaskTable> {
  run<K extends keyof T & string>(task: K, args: Parameters<T[K]>, opts?: RunOptions): Promise<TaskResult<T, K>>
  close?(): Promise<void>
}

/**
 * A task's result plus the buffers to move to the receiving thread instead of copying them
 * (a decoded image, for instance). Only buffers the task created itself may be listed.
 */
export class Transfer<V> {
  readonly value: V
  readonly list: ArrayBuffer[]
  constructor(value: V, list: ArrayBuffer[]) {
    this.value = value
    this.list = list
  }
}

export const unwrap = <V>(r: V | Transfer<V>): V => (r instanceof Transfer ? r.value : r)

// ---- messages ----

/** Main → worker. */
export interface JobMessage {
  id: number
  task: string
  args: unknown[]
}

export interface RemoteError {
  name: string
  message: string
  stack?: string
  code?: string
}

/** Worker → main. */
export type WorkerMessage =
  | { type: 'ready' }
  | { type: 'done'; id: number; value: unknown }
  | { type: 'failed'; id: number; error: RemoteError }
