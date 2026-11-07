import { AsyncLocalStorage } from 'node:async_hooks'

export interface User {
  id: number
  username: string
  name: string
  role: 'admin' | 'player'
  admin_source: 'manual' | 'provider' | 'allowlist'
  admin_provider: string
  admin_subject: string
  /** 3.x column, kept in step with adult_ceiling so a downgrade reads the same access (content.ts legacyMirror). */
  adult_access: number
  /** Ceiling set by an admin or recomputed from sign-in groups: off, blurred or shown. */
  adult_ceiling: string
  /** The person's own level, at or below the ceiling. */
  adult_choice: string
  disabled: number
  created_at: string
  prefs: string
  avatar: string
  avatar_uploaded: number
  /** The PIN for switching to this person on a signed-in device (scrypt), or empty. Never sent. */
  pin_hash: string
  pin_failures: number
  /** Until when switching to this person is locked after five wrong PINs (ms), or 0. */
  pin_locked_until: number
}
export interface Viewer {
  user: User
  session: string
  bearer: boolean
  /** This device's level, sent by the browser. It can only narrow what the person may see. */
  device?: 'off' | 'blurred'
}
/** Request-local permissions; background installs deliberately have no viewer. */
export const viewers = new AsyncLocalStorage<Viewer>()
export const viewer = () => viewers.getStore()
