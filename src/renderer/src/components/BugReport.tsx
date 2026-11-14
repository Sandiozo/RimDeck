import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { Bug, CircleAlert, Copy, ExternalLink, FileDown, X } from 'lucide-react'
import type { BugReport as Report, CrashStatus } from '@shared/types'
import { api, isElectron, onEvent } from '../api'
import { useEscape } from './ui'

// "Report a bug": the user describes the problem, reads the full report and chooses where it goes.
// Nothing is sent by RimDeck itself. Works without the main store, so the crash screen can use it.

interface DialogState {
  open: boolean
  draft: string // kept while the dialog is closed, so a stray click doesn't lose it
  includeMods: boolean
}
const useDialog = create<DialogState>(() => ({ open: false, draft: '', includeMods: true }))

export function openBugReport() {
  useDialog.setState({ open: true })
}
const close = () => useDialog.setState({ open: false })

export function BugReport() {
  const open = useDialog((d) => d.open)
  return open ? <BugReportDialog /> : null
}

async function copyText(text: string) {
  await navigator.clipboard.writeText(text)
}

function download(text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `RimDeck bug report ${new Date().toISOString().slice(0, 10)}.md`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

function BugReportDialog() {
  const { draft, includeMods } = useDialog()
  const ref = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const [report, setReport] = useState<Report | null>(null)
  const [failed, setFailed] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const seq = useRef(0)
  useEscape(ref, close)
  useEffect(() => textRef.current?.focus(), [])

  const build = async () => {
    const n = ++seq.current
    const r = await api.bugReport(draft, includeMods)
    if (n === seq.current) {
      setReport(r)
      setFailed('')
    }
    return r
  }
  // The preview follows the text box after a short pause.
  useEffect(() => {
    const t = setTimeout(
      () =>
        build().catch((e) => {
          setFailed(`The report could not be put together: ${e?.message ?? e}`)
        }),
      report ? 300 : 0,
    )
    return () => clearTimeout(t)
  }, [draft, includeMods])

  // Each action uses a freshly built report, so it is exactly what the preview shows.
  const act = async (fn: (r: Report) => Promise<string>) => {
    if (busy) return
    setBusy(true)
    setNote('')
    try {
      setNote(await fn(await build()))
    } catch (e: any) {
      setNote(`That did not work: ${e?.message ?? e}`)
    } finally {
      setBusy(false)
    }
  }
  const openIssue = () =>
    act(async (r) => {
      // Copy first: the browser takes the focus away, and the clipboard needs it.
      const copied = await copyText(r.text).then(
        () => true,
        () => false,
      )
      await api.openUrl(r.url)
      return copied
        ? 'The full report is on your clipboard. Paste it into the issue if it was cut short.'
        : 'The issue page is open, but the report could not be copied. Use Copy report or Save to file.'
    })
  const copy = () =>
    act(async (r) => {
      await copyText(r.text)
      return 'The report is on your clipboard.'
    })
  const save = () =>
    act(async (r) => {
      if (!isElectron) {
        download(r.text)
        return 'The report was downloaded.'
      }
      const file = await api.saveReport(r.text)
      return file ? `Saved as ${file.split(/[\\/]/).pop()}.` : ''
    })

  return (
    <div ref={ref} className="overlay" onMouseDown={close}>
      <div className="modal report" role="dialog" aria-modal="true" aria-labelledby="bug-title" aria-describedby="bug-intro" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <Bug size={20} color="var(--accent-text)" style={{ marginTop: 2 }} />
          <div className="grow">
            <h2 id="bug-title">Report a bug</h2>
            <p id="bug-intro">
              Describe what went wrong. RimDeck adds your setup and its recent errors, with your user name removed from paths. Nothing leaves your computer until you press a button
              below.
            </p>
          </div>
        </div>
        <div className="report-body">
          <label className="report-label" htmlFor="bug-text">
            What happened? What did you expect?
          </label>
          <textarea
            id="bug-text"
            ref={textRef}
            className="input"
            rows={4}
            value={draft}
            placeholder="For example: I clicked Sort and the window went blank. I expected the sort preview."
            onChange={(e) => useDialog.setState({ draft: e.target.value })}
          />
          <label className="row report-check">
            <input type="checkbox" checked={includeMods} onChange={(e) => useDialog.setState({ includeMods: e.target.checked })} />
            <span>Include my active mod list (package ids in load order)</span>
          </label>
          <div className="report-label" id="bug-preview-label">
            What will be shared
          </div>
          <pre className="report-preview" tabIndex={0} aria-labelledby="bug-preview-label" aria-busy={!report && !failed}>
            {failed || report?.text || 'Putting the report together…'}
          </pre>
          <div className="report-note" role="status" aria-live="polite">
            {note}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={close}>
            Close
          </button>
          <span className="grow" />
          <button className="btn" disabled={busy || !report} onClick={save}>
            <FileDown size={14} /> Save to file…
          </button>
          <button className="btn" disabled={busy || !report} onClick={copy}>
            <Copy size={14} /> Copy report
          </button>
          <button className="btn primary" disabled={busy || !report} onClick={openIssue}>
            <ExternalLink size={14} /> Open GitHub issue
          </button>
        </div>
      </div>
    </div>
  )
}

const DAMAGED_LOSS: Record<string, string> = {
  'settings.json': 'started with default settings',
  'user.json': 'started without your profiles, notes, colors and rules',
}

/** One banner after trouble: errors not yet seen, a last run that didn't close normally, damaged files. */
export function ProblemNotice() {
  const [status, setStatus] = useState<CrashStatus | null>(null)
  useEffect(() => {
    const load = () => api.crashStatus().then(setStatus, () => {})
    load()
    return onEvent((e) => e.type === 'problem-logged' && load())
  }, [])
  if (!status) return null
  const problem = status.errors.length ? 'RimDeck ran into a problem.' : status.abnormalEnd ? 'RimDeck did not close normally last time.' : ''
  const damaged = status.damaged.map((d) => `${d.file} was damaged. RimDeck kept it as ${d.keptAs} and ${DAMAGED_LOSS[d.file] ?? 'started without it'}.`)
  if (!problem && !damaged.length) return null
  // Either button counts as seen, so the banner doesn't come back for the same errors.
  const acknowledge = () => {
    const newest = status.errors[0]
    setStatus(null)
    api.crashAck(newest ? (newest.last ?? newest.time) : undefined).catch(() => {})
  }
  return (
    <div className={'banner' + (problem ? ' err' : '')} role="status">
      {problem ? <Bug size={15} color="var(--err)" /> : <CircleAlert size={15} color="var(--warn)" />}
      <span className="grow">
        {problem && (
          <>
            <b>{problem}</b> {status.errors.length ? 'A report helps get it fixed.' : 'If something went wrong, a report helps get it fixed.'}{' '}
          </>
        )}
        {damaged.join(' ')}
      </span>
      <button
        className="btn sm"
        onClick={() => {
          acknowledge()
          openBugReport()
        }}
      >
        Report
      </button>
      <button className="btn sm ghost icon" title="Dismiss" aria-label="Dismiss" onClick={acknowledge}>
        <X size={13} />
      </button>
    </div>
  )
}
