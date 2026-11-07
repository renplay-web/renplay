import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeftRight, Clock, LogOut, Settings, User, Users } from 'lucide-react'
import { useAuth } from '../lib/auth'
import { post } from '../lib/api'
import Avatar from './Avatar'
import Sheet from '../lantern/Sheet'
import { errorText } from './ui'
import WhoIsPlaying from './WhoIsPlaying'

/** The avatar in the header: your account, and the way out. */
export default function AccountMenu() {
  const { data } = useAuth()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')
  const [switching, setSwitching] = useState(false)
  if (!data) return null
  const admin = data.user.role === 'admin'
  return (
    <>
      <button aria-expanded={open} aria-label={`Your account, ${data.user.name}`} onClick={() => setOpen(!open)} className="avatar">
        <Avatar name={data.user.name} avatar={data.user.avatar} bare />
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Your account">
        <div className="row" style={{ marginBottom: 10 }}>
          <Avatar name={data.user.name} avatar={data.user.avatar} className="lg" />
          <div className="grow">
            <div className="t">{data.user.name}</div>
            <div className="m small muted">{admin ? 'Admin' : 'Player'}</div>
          </div>
        </div>
        <div className="menu">
          <Link to="/account" onClick={() => setOpen(false)}>
            <User /> Account
          </Link>
          {admin && (
            <Link to="/settings/users" onClick={() => setOpen(false)}>
              <Users /> Users
            </Link>
          )}
          {admin && (
            <Link to="/activity" onClick={() => setOpen(false)}>
              <Clock /> Activity
            </Link>
          )}
          <Link to="/settings" onClick={() => setOpen(false)}>
            <Settings /> {admin ? 'Settings' : 'This browser'}
          </Link>
          {data.auth && (
            <>
              <div className="sep" />
              <button
                onClick={() => {
                  setOpen(false)
                  setSwitching(true)
                }}
              >
                <ArrowLeftRight /> Who is playing?
              </button>
              <button
                className="d"
                onClick={async () => {
                  try {
                    await post('/api/auth/logout')
                    window.location.assign('/signin')
                  } catch (e) {
                    setError(errorText(e))
                  }
                }}
              >
                <LogOut /> Sign out
              </button>
            </>
          )}
        </div>
        {error && (
          <p role="alert" className="red small" style={{ marginTop: 10 }}>
            {error}
          </p>
        )}
      </Sheet>
      <WhoIsPlaying open={switching} onClose={() => setSwitching(false)} />
    </>
  )
}
