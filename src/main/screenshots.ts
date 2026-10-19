import type { BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// `RD_SCREENSHOTS=<dir> electron .` walks the main screens and saves PNGs for the README.
// Screens that show local folder paths (Settings, Game log) are skipped on purpose.
const SHOTS: { file: string; wait: number; script: string }[] = [
  {
    file: 'mods.png',
    wait: 2500,
    script: `(() => {
      const row = document.querySelector('[data-pid="vanillaexpanded.vee"]')
      row?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
      row?.scrollIntoView({ block: 'center' })
    })()`,
  },
  {
    file: 'sort.png',
    wait: 1500,
    script: `document.querySelector('button[title^="Auto-sort"]')?.click()`,
  },
  {
    file: 'textures.png',
    wait: 5000,
    script: `(async () => {
      document.querySelector('.modal-foot .btn:not(.primary)')?.click()
      document.querySelector('.rail-btn[title="Texture conflicts"]')?.click()
      for (let i = 0; i < 40 && !document.querySelector('.tex-row'); i++) await new Promise(r => setTimeout(r, 250))
      const rows = [...document.querySelectorAll('.tex-row')]
      ;(rows.find(r => r.textContent.includes('bath_east')) ?? rows[0])?.click()
    })()`,
  },
  {
    file: 'research.png',
    wait: 6000,
    script: `(async () => {
      document.querySelector('.rail-btn[title="Research tree"]')?.click()
      for (let i = 0; i < 60 && !document.querySelector('.rnode'); i++) await new Promise(r => setTimeout(r, 250))
      const box = document.querySelector('.research-canvas')
      const r = box.getBoundingClientRect()
      for (let i = 0; i < 7; i++) box.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: r.left + 120, clientY: r.top + 120, bubbles: true }))
      const node = [...document.querySelectorAll('.rnode')].find(n => n.textContent.toLowerCase().includes('electricity'))
      node?.click()
    })()`,
  },
  {
    file: 'items.png',
    wait: 2500,
    script: `(async () => {
      document.querySelector('.rail-btn[title="Items"]')?.click()
      for (let i = 0; i < 40 && !document.querySelector('.tex-row'); i++) await new Promise(r => setTimeout(r, 250))
      const rows = [...document.querySelectorAll('.tex-row')]
      ;(rows.find(r => r.textContent.toLowerCase().startsWith('clay')) ?? rows[0])?.click()
    })()`,
  },
  {
    file: 'loadtime.png',
    wait: 9000,
    script: `document.querySelector('.rail-btn[title="Load time"]')?.click()`,
  },
  {
    file: 'problems.png',
    wait: 1500,
    script: `document.querySelector('.rail-btn[title="Problems"]')?.click()`,
  },
  {
    file: 'modsettings.png',
    wait: 2500,
    script: `document.querySelector('.rail-btn[title="Mod settings"]')?.click()`,
  },
  {
    // The editor on a mod whose window has labels, switches and sliders.
    file: 'settings-editor.png',
    wait: 2500,
    script: `(async () => {
      const input = document.querySelector('.page .pane-filter input')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'Animals Logic')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 400))
      document.querySelector('.page table button.primary')?.click()
    })()`,
  },
  {
    file: 'saves.png',
    wait: 3000,
    script: `(async () => {
      ;[...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.trim() === 'Close')?.click()
      document.querySelector('.rail-btn[title="Saves"]')?.click()
      for (let i = 0; i < 40 && !document.querySelector('.page tr.click'); i++) await new Promise(r => setTimeout(r, 250))
      document.querySelector('.page tr.click')?.click()
    })()`,
  },
  {
    // Light theme, shown without changing the saved setting.
    file: 'light.png',
    wait: 2500,
    script: `(() => {
      document.querySelector('.rail-btn[title="Mods"]')?.click()
      document.documentElement.dataset.theme = 'light'
      setTimeout(() => {
        const row = document.querySelector('[data-pid="vanillaexpanded.vee"]')
        row?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
        row?.scrollIntoView({ block: 'center' })
      }, 300)
    })()`,
  },
]

export async function captureScreenshots(win: BrowserWindow, dir: string) {
  await mkdir(dir, { recursive: true })
  await new Promise((r) => setTimeout(r, 9000)) // first scan, rules and XML index
  await win.webContents.insertCSS('.banner, .toasts { display: none !important; }')
  for (const shot of SHOTS) {
    await win.webContents.executeJavaScript(shot.script).catch(() => {})
    await new Promise((r) => setTimeout(r, shot.wait))
    const img = await win.webContents.capturePage()
    await writeFile(join(dir, shot.file), img.toPNG())
  }
}
