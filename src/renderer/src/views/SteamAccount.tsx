import { useEffect, useState } from 'react'
import { KeyRound, LoaderCircle, LogOut, Smartphone, UserRound, X } from 'lucide-react'
import { useStore } from '../store'
import { api } from '../api'
import { Seg } from '../components/ui'

/**
 * Optional Steam login for SteamCMD. The password lives only in this component's state until it is sent,
 * then it is cleared; RimDeck stores just the account name and whether SteamCMD holds a session.
 */
export function SteamAccountPanel() {
  const s = useStore()
  const d = s.downloads
  const account = d?.account
  const login = d?.login ?? { phase: 'idle' as const }
  const [user, setUser] = useState(account?.user ?? '')
  const [asking, setAsking] = useState(false) // password field shown
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  useEffect(() => {
    if (account?.user) setUser(account.user)
  }, [account?.user])
  useEffect(() => {
    if (login.phase === 'need-password') setAsking(true)
    if (login.phase === 'idle' && account?.loggedIn) setAsking(false)
  }, [login.phase, account?.loggedIn])
  useEffect(() => () => setPassword(''), [])

  const run = (p: Promise<any>) => p.then((st) => st && s.setDownloads(st)).catch((e) => s.toast('error', e.message))
  // First try the session SteamCMD may have cached; it answers "need password" when there is none.
  const start = () => {
    if (!user.trim()) return
    setAsking(false)
    run(api.steamLogin(user.trim()))
  }
  const submitPassword = () => {
    if (!password) return
    const pw = password
    setPassword('')
    run(api.steamLogin(user.trim(), pw))
  }
  const submitCode = () => {
    if (!code.trim()) return
    run(api.steamLoginCode(code.trim()))
    setCode('')
  }
  const cancel = () => {
    setAsking(false)
    setPassword('')
    run(api.steamLoginCancel())
  }

  const busy = login.phase === 'working' || login.phase === 'confirm-mobile'
  const tone = login.phase === 'error' ? 'var(--err)' : login.phase === 'need-code' || login.phase === 'need-password' ? 'var(--warn)' : 'var(--text-3)'

  return (
    <div className="panel" style={{ marginTop: 12 }} id="steam-account">
      <div className="panel-head">
        <UserRound size={14} color="var(--text-3)" />
        <h3 className="grow">Steam account</h3>
        <span className="dim" style={{ fontSize: 11.5 }}>Downloads use</span>
        <Seg
          value={account?.useForDownloads ? 'account' : 'anonymous'}
          options={[
            ['anonymous', 'Anonymous'],
            ['account', account?.loggedIn ? account.user : 'Steam account'],
          ]}
          onChange={(v) => {
            if (v === 'account' && !account?.loggedIn) return s.toast('info', 'Log in to a Steam account first')
            run(api.steamUseAccount(v === 'account'))
          }}
        />
      </div>
      <div className="panel-body">
        <p className="dim" style={{ margin: '0 0 10px', fontSize: 12 }}>
          Optional. Most mods download anonymously; a few require an account that owns RimWorld. Your password is passed directly to SteamCMD and is never saved.
          SteamCMD keeps its own login session afterwards.
        </p>

        {account?.loggedIn && !busy && login.phase !== 'need-code' ? (
          <div className="row" style={{ gap: 8 }}>
            <span className="chip ok">Logged in</span>
            <b>{account.user}</b>
            <span className="grow" />
            <button className="btn sm" onClick={() => run(api.steamLogout())}>
              <LogOut size={12} /> Log out
            </button>
          </div>
        ) : (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input
              className="input"
              style={{ width: 200 }}
              value={user}
              placeholder="Steam account name"
              autoComplete="username"
              disabled={busy || login.phase === 'need-code'}
              onChange={(e) => setUser(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && start()}
            />
            {asking ? (
              <>
                <input
                  className="input"
                  style={{ width: 200 }}
                  type="password"
                  value={password}
                  placeholder="Password"
                  autoComplete="off"
                  autoFocus
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitPassword()}
                />
                <button className="btn primary" disabled={!password || busy} onClick={submitPassword}>
                  <KeyRound size={13} /> Log in
                </button>
                <button className="btn ghost" onClick={cancel}>
                  Cancel
                </button>
              </>
            ) : login.phase === 'need-code' ? (
              <>
                <input
                  className="input mono"
                  style={{ width: 130 }}
                  value={code}
                  placeholder={login.codeKind === 'email' ? 'Email code' : 'Authenticator code'}
                  autoComplete="one-time-code"
                  autoFocus
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === 'Enter' && submitCode()}
                />
                <button className="btn primary" disabled={!code.trim()} onClick={submitCode}>
                  Submit code
                </button>
                <button className="btn ghost" onClick={cancel}>
                  Cancel
                </button>
              </>
            ) : busy ? (
              <button className="btn" onClick={cancel}>
                <X size={13} /> Cancel
              </button>
            ) : (
              <button className="btn" disabled={!user.trim()} onClick={start}>
                <KeyRound size={13} /> Log in
              </button>
            )}
            {account?.user && !busy && (
              <button className="btn ghost sm" title="Forget this account" onClick={() => { setUser(''); setAsking(false); run(api.steamLogout()) }}>
                <LogOut size={12} /> Forget
              </button>
            )}
          </div>
        )}

        {login.message && (
          <div className="row" style={{ gap: 6, marginTop: 10, fontSize: 12, color: tone }}>
            {login.phase === 'confirm-mobile' ? <Smartphone size={13} /> : busy ? <LoaderCircle size={13} className="spin" /> : null}
            <span>{login.message}</span>
          </div>
        )}
      </div>
    </div>
  )
}
