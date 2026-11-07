import { useState, type ReactNode } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Clock, History, Settings, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import Avatar from '../components/Avatar'
import AvatarUpload from '../components/AvatarUpload'
import LinkedSignIns from '../components/LinkedSignIns'
import AdultLadder from '../components/AdultLadder'
import WhoIsPlaying from '../components/WhoIsPlaying'
import { Button, Confirm, Modal, Spinner, accountInput, errorText, useToast } from '../components/ui'
import { useRoom } from '../lantern/Room'
import { api, del, post, put } from '../lib/api'
import { useAuth } from '../lib/auth'
import { ago } from '../lib/format'

export function AccountSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel stack" style={{ gap: 14, alignItems: 'stretch' }}>
      <h2 className="h3">{title}</h2>
      {children}
    </section>
  )
}
interface Session { id: string; label: string; created_at: number; touched_at: number; expires_at: number; current: boolean }
interface Token { id: string; name: string; created_at: number }

function sessionLabel(label: string): string {
  const browser = /Edg\//.test(label) ? 'Edge' : /Firefox\//.test(label) ? 'Firefox' : /Chrome\//.test(label) ? 'Chrome' : /Safari\//.test(label) ? 'Safari' : 'Browser'
  const device = /iPhone/.test(label) ? 'iPhone' : /iPad/.test(label) ? 'iPad' : /Android/.test(label) ? 'Android' : /Windows/.test(label) ? 'Windows' : /Macintosh|Mac OS/.test(label) ? 'Mac' : /Linux/.test(label) ? 'Linux' : ''
  return device ? `${browser} on ${device}` : 'Browser session'
}

export default function Account() {
  const { data: me } = useAuth(), qc = useQueryClient(), toast = useToast()
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<{ sessions: Session[] }>('/api/me/sessions') })
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => api<{ tokens: Token[] }>('/api/me/tokens') })
  const [dialog, setDialog] = useState<'password' | 'token' | ''>('')
  const [confirm, setConfirm] = useState<{ title: string; action: () => Promise<unknown> } | null>(null)
  const [secret, setSecret] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useRoom({ game: null, quiet: true })
  if (!me) return <Spinner />
  const admin = me.user.role === 'admin'
  const run = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true); setError('')
    try { await action(); await qc.invalidateQueries(); toast(message, 'success'); return true }
    catch (e) { setError(errorText(e)); toast(errorText(e), 'error'); return false }
    finally { setBusy(false) }
  }
  return (
    <div>
      <header className="row" style={{ gap: 16 }}>
        <Avatar name={me.user.name} avatar={me.user.avatar} className="xl" />
        <div className="grow">
          <h1 className="h1">{me.user.name}</h1>
          <p className="muted-2" style={{ marginTop: 4 }}>
            {me.user.role === 'admin' ? 'Admin' : 'Player'}
            {me.auth ? '' : ' · Sign-in is off'}
          </p>
        </div>
      </header>
      <nav className="acct-nav" aria-label="Account pages">
        <Link to="/history" className={admin ? '' : 'full'}><History /> Play history</Link>
        {admin && (
          <>
            <Link to="/settings"><Settings /> Settings</Link>
            <Link to="/settings/users"><Users /> Users</Link>
            <Link to="/activity"><Clock /> Activity</Link>
          </>
        )}
      </nav>
      {!me.auth && (
        <section className="panel" style={{ marginTop: 18 }}>
          <h2 className="h3">Sign-in is off</h2>
          <p className="small muted-2" style={{ marginTop: 6 }}>Everyone uses this account ({me.user.name}). Other users’ saves stay separate and untouched.</p>
          <a className="link small" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center', marginTop: 8 }} href="https://renplay.org/docs/accounts/" target="_blank" rel="noreferrer">
            How to turn on sign-in ↗
          </a>
        </section>
      )}
      {me.unclaimed && me.user.role === 'admin' && me.user.id !== 1 && (
        <section className="panel" style={{ marginTop: 18 }}>
          <h2 className="h3">Claim the owner account</h2>
          <p className="small muted" style={{ marginTop: 6 }}>Keep the saves made before sign-in and bring your current saves with you. Replaced files stay in history.</p>
          <div style={{ marginTop: 10 }}>
            <Button onClick={() => setConfirm({ title: 'Claim the owner account?', action: async () => { await post('/api/me/claim-owner'); window.location.reload() } })}>Claim the owner account</Button>
          </div>
        </section>
      )}
      <div className="grid2" style={{ marginTop: 22, alignItems: 'start' }}>
        <AccountSection title="Adult games">
          <p className="small muted">The one place for what you see. Each row can only narrow the one above it. Off, Blurred and Shown mean the same everywhere.</p>
          <AdultLadder />
        </AccountSection>
        <AccountSection title="Profile">
          <form onSubmit={(e) => { e.preventDefault(); const form = new FormData(e.currentTarget); void run(() => put('/api/me', { name: form.get('name') }), 'Display name saved') }} className="stack">
            <label className="field">
              <span>Display name</span>
              <input key={me.user.name} name="name" autoComplete="name" required maxLength={100} defaultValue={me.user.name} className={accountInput} />
            </label>
            <div>
              <Button type="submit" size="sm" loading={busy}>Save name</Button>
            </div>
          </form>
          <p className="small muted">Username: {me.user.username}.</p>
          <AvatarUpload />
          {me.hasPassword && (
            <div>
              <Button size="sm" onClick={() => { setError(''); setDialog('password') }}>Change password</Button>
            </div>
          )}
        </AccountSection>
        {me.auth && (
          <AccountSection title="Switching on a shared device">
            <PinSection admin={admin} hasPin={!!me.user.hasPin} />
          </AccountSection>
        )}
        <AccountSection title="How you sign in">
          <LinkedSignIns />
        </AccountSection>
        <AccountSection title="Where you are signed in">
          {sessions.isPending ? <Spinner /> : sessions.isError ? <p role="alert" className="small red">{errorText(sessions.error)}</p> : (
            <div className="list tight">
              {sessions.data.sessions.map((session) => (
                <div key={session.id} className="row between wrap" style={{ gap: 8 }}>
                  <div className="grow">
                    <p className="small" style={{ overflowWrap: 'anywhere' }}>{session.current ? 'This session' : sessionLabel(session.label)}</p>
                    <p className="xs muted">Active {ago(session.touched_at)} · Expires {ago(session.expires_at, true)}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm({ title: 'Sign out of this session?', action: async () => { await del(`/api/me/sessions/${session.id}`); if (session.current) window.location.assign('/signin') } })}>Sign out</Button>
                </div>
              ))}
              {!sessions.data.sessions.length && <p className="small muted">No signed-in sessions. {me.auth ? '' : 'Sign-in is off.'}</p>}
            </div>
          )}
          <div>
            <Button size="sm" disabled={!sessions.data?.sessions.some((s) => !s.current)} onClick={() => setConfirm({ title: 'Sign out everywhere else?', action: () => del('/api/me/sessions') })}>Sign out everywhere else</Button>
          </div>
        </AccountSection>
        <AccountSection title="Access tokens">
          <p className="small muted">For scripts and the upload tool. A token acts as you. Keep it private.</p>
          {tokens.isPending ? <Spinner /> : tokens.isError ? <p role="alert" className="small red">{errorText(tokens.error)}</p> : (
            <div className="list tight">
              {tokens.data.tokens.map((token) => (
                <div key={token.id} className="row between">
                  <div className="grow">
                    <p className="small" style={{ overflowWrap: 'anywhere' }}>{token.name}</p>
                    <p className="xs muted">Created {ago(token.created_at)}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setConfirm({ title: `Revoke ${token.name}?`, action: () => del(`/api/me/tokens/${token.id}`) })}>Revoke</Button>
                </div>
              ))}
              {!tokens.data.tokens.length && <p className="small muted">No access tokens.</p>}
            </div>
          )}
          <div>
            <Button size="sm" onClick={() => { setError(''); setSecret(''); setDialog('token') }}>New token</Button>
          </div>
        </AccountSection>
        <AccountSection title="Your saves">
          <p className="small muted">Export current saves for the games you can see, including shared keys and HTML game data, as one zip. Hidden games’ saves and save history stay on the server.</p>
          <div>
            <Button size="sm" href="/api/saves-export">Export all my saves</Button>
          </div>
        </AccountSection>
      </div>
      <Modal open={!!dialog} onClose={() => { if (!busy) { setDialog(''); setSecret('') } }} title={dialog === 'password' ? 'Change password' : 'New token'}>
        {secret ? (
          <div className="stack">
            <p className="small muted-2">Copy this token now. It will not be shown again.</p>
            <textarea aria-label="Access token" readOnly value={secret} className="input mono" style={{ height: 112, padding: 12, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }} onFocus={(e) => e.target.select()} />
            <div>
              <Button onClick={async () => { try { await navigator.clipboard.writeText(secret); toast('Token copied', 'success') } catch { toast('Select the token and copy it.', 'error') } }}>Copy token</Button>
            </div>
          </div>
        ) : (
          <form className="stack" onSubmit={async (e) => {
            e.preventDefault(); const form = new FormData(e.currentTarget)
            if (dialog === 'password') {
              if (await run(() => post('/api/me/password', { current: form.get('current'), password: form.get('password') }), 'Password changed. Other sessions ended.')) setDialog('')
            } else await run(async () => { const result = await post<{ token: string }>('/api/me/tokens', { name: form.get('name') }); setSecret(result.token) }, 'Token created')
          }}>
            {dialog === 'password' ? (
              <>
                <p className="small muted">Your other sessions will end. Your saves stay safe.</p>
                <label className="field"><span>Current password</span><input name="current" type="password" autoComplete="current-password" required className={accountInput} /></label>
                <label className="field"><span>New password</span><input name="password" type="password" autoComplete="new-password" minLength={10} maxLength={1024} required className={accountInput} /></label>
              </>
            ) : (
              <label className="field"><span>Token name</span><input name="name" required maxLength={100} placeholder="Upload script" className={accountInput} /></label>
            )}
            {error && <p role="alert" className="small red">{error}</p>}
            <div>
              <Button variant="primary" type="submit" loading={busy}>{dialog === 'password' ? 'Change password' : 'Create token'}</Button>
            </div>
          </form>
        )}
      </Modal>
      <Confirm open={!!confirm} onClose={() => !busy && setConfirm(null)} title={confirm?.title || ''} confirmLabel="Confirm" busy={busy} onConfirm={async () => { if (confirm && await run(confirm.action, 'Done')) setConfirm(null) }}>
        This takes effect immediately. Your saves are kept.
      </Confirm>
    </div>
  )
}

/** A PIN to switch in on a device someone is already signed in on (Who is playing). */
function PinSection({ admin, hasPin }: { admin: boolean; hasPin: boolean }) {
  const qc = useQueryClient()
  const toast = useToast()
  const [pin, setPin] = useState('')
  const [editing, setEditing] = useState(false)
  const [switching, setSwitching] = useState(false)
  const save = async (value: string) => {
    try {
      await put('/api/me/pin', { pin: value })
      toast(value ? 'PIN saved' : 'PIN removed', 'success')
      setPin('')
      setEditing(false)
      await qc.invalidateQueries({ queryKey: ['me'] })
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }
  return (
    <div className="stack" style={{ gap: 10 }}>
      {admin ? (
        <p className="small muted">Admins switch in with their full sign-in, so an admin account has no PIN.</p>
      ) : editing || !hasPin ? (
        <form
          className="stack"
          style={{ gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault()
            void save(pin)
          }}
        >
          <p className="small muted">With a PIN you can switch in on a shared device that someone is signed in on, without your password. It works only on browsers you signed in on before. Signing out everywhere or changing your password removes it.</p>
          <label className="field">
            <span>PIN, 4 to 8 digits</span>
            <input className={accountInput} type="password" inputMode="numeric" autoComplete="new-password" pattern="\d{4,8}" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
          </label>
          <div className="row" style={{ gap: 8 }}>
            <Button type="submit" size="sm" disabled={pin.length < 4}>
              Save PIN
            </Button>
            {hasPin && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            )}
          </div>
        </form>
      ) : (
        <>
          <p className="small muted">You have a PIN for switching in on a shared device.</p>
          <div className="row wrap" style={{ gap: 8 }}>
            <Button size="sm" onClick={() => setEditing(true)}>
              Change PIN
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void save('')}>
              Remove PIN
            </Button>
          </div>
        </>
      )}
      <div>
        <Button size="sm" variant="ghost" onClick={() => setSwitching(true)}>
          Who is playing?
        </Button>
      </div>
      <WhoIsPlaying open={switching} onClose={() => setSwitching(false)} />
    </div>
  )
}
