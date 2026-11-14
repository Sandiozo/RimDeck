// electron-vite's `?nodeWorker` import (see index.ts): a function that starts the bundled worker.
declare module '*?nodeWorker' {
  import type { Worker, WorkerOptions } from 'node:worker_threads'
  export default function (options: WorkerOptions): Worker
}
