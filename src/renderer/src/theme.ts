import { useEffect } from 'react'
import type { ThemeMode } from '@shared/types'
import { api } from './api'

/** Applies the dark or light palette; "system" follows the Windows setting and its changes. */
export function useTheme(mode: ThemeMode) {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: light)')
    const apply = () => {
      const light = mode === 'light' || (mode === 'system' && media.matches)
      document.documentElement.dataset.theme = light ? 'light' : 'dark'
      // Windows draws the window buttons; give them the title bar's colours.
      const css = getComputedStyle(document.documentElement)
      api.setTitleBarColor(css.getPropertyValue('--bg-1').trim(), css.getPropertyValue('--text-2').trim()).catch(() => {})
    }
    apply()
    if (mode !== 'system') return
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [mode])
}
