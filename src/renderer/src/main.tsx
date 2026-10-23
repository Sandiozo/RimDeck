import { createRoot } from 'react-dom/client'
import { App } from './App'
import { api, platform } from './api'
import { useStore } from './store'
import './styles.css'

// Lets the stylesheet leave room for each platform's window buttons.
document.documentElement.dataset.platform = platform

// Interface freezes of a second or more go to RimDeck's responsiveness log, with the page they happened on.
try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration < 1000) continue
      const where = useStore.getState().view + (document.querySelector('.modal') ? ' (with a dialog open)' : '')
      api.logInterfaceStall(e.duration, where).catch(() => {})
    }
  }).observe({ type: 'longtask' })
} catch {
  // not supported
}

createRoot(document.getElementById('root')!).render(<App />)
