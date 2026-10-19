import { createRoot } from 'react-dom/client'
import { App } from './App'
import { platform } from './api'
import './styles.css'

// Lets the stylesheet leave room for each platform's window buttons.
document.documentElement.dataset.platform = platform

createRoot(document.getElementById('root')!).render(<App />)
