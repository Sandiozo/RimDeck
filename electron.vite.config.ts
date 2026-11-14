import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      rolldownOptions: {
        // The worker pool is its own file (out/main/pool.js) so it can be tried out without starting
        // the app, from plain Node or the packaged app run as Node. The worker itself is a chunk made
        // by the `?nodeWorker` import in index.ts.
        input: { index: resolve('src/main/index.ts'), pool: resolve('src/main/workers/pool.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: '[name].cjs' } } },
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()],
    server: { port: 5173, strictPort: true },
  },
})
