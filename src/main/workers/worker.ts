// Entry of RimDeck's worker threads (bundled as its own chunk, see index.ts). No Electron here.
import { setReadLimit } from '../core/xmlindex.ts'
import { serve } from './serve.ts'
import { tasks } from './tasks.ts'

// Up to four workers read side by side; together they keep about as many files open as the main process alone did.
setReadLimit(16)
serve(tasks)
