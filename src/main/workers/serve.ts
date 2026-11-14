// The worker side of the pool: runs the tasks it is sent and posts back each result or error.
import { parentPort } from 'node:worker_threads'
import { Transfer, type JobMessage, type RemoteError, type TaskTable, type WorkerMessage } from './protocol.ts'

function toRemote(e: unknown): RemoteError {
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code
    return { name: e.name, message: e.message, stack: e.stack, ...(typeof code === 'string' ? { code } : {}) }
  }
  return { name: 'Error', message: String(e) }
}

/** Serves `tasks` to the thread that started this worker; jobs run side by side, like async calls do. */
export function serve(tasks: TaskTable) {
  const port = parentPort
  if (!port) throw new Error('serve() runs in a worker thread')
  port.on('message', async (job: JobMessage) => {
    let reply: WorkerMessage
    let transfer: ArrayBuffer[] = []
    try {
      const fn = Object.hasOwn(tasks, job.task) ? tasks[job.task] : undefined
      if (typeof fn !== 'function') throw new Error(`Unknown worker task ${job.task}`)
      const r = await fn(...job.args)
      if (r instanceof Transfer) {
        reply = { type: 'done', id: job.id, value: r.value }
        transfer = r.list
      } else reply = { type: 'done', id: job.id, value: r }
    } catch (e) {
      reply = { type: 'failed', id: job.id, error: toRemote(e) }
    }
    try {
      port.postMessage(reply, transfer)
    } catch (e) {
      // A result that can't be copied to another thread (a function, for instance) is an error too.
      port.postMessage({ type: 'failed', id: job.id, error: toRemote(e) } satisfies WorkerMessage)
    }
  })
  port.postMessage({ type: 'ready' } satisfies WorkerMessage)
}
