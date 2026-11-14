import { Component, type ReactNode } from 'react'
import { reportError } from '../errors'
import { BugReport, openBugReport } from './BugReport'

// When drawing the interface fails, show a plain screen instead of a blank window. It doesn't use
// the app's store, which may be what broke.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error) {
    reportError('interface crashed', error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <>
        <div className="splash crash-screen">
          <div role="alert">
            <h1>Something went wrong.</h1>
            <p>RimDeck could not show this screen. Reloading usually helps; unsaved changes to the load order are lost.</p>
            <div className="row">
              <button className="btn primary" onClick={() => location.reload()}>
                Reload
              </button>
              <button className="btn" onClick={openBugReport}>
                Report a bug
              </button>
            </div>
          </div>
        </div>
        <BugReport />
      </>
    )
  }
}
