import { useSyncExternalStore } from 'react'

/*
 * Lighter background: a plain backdrop instead of the game's art behind each screen. Until the
 * person chooses on this device, it follows reduced motion and the browser's data saver.
 */
const KEY = 'renplay:lighter-background'
const EVENT = 'renplay:lighter-background'
const REDUCED = '(prefers-reduced-motion: reduce)'

/** The admin's default for everyone (Settings, Defaults for everyone), when one is set. */
let adminDefault: boolean | null = null
export function setAdminLighterBackground(v: boolean | null): void {
  if (v === adminDefault) return
  adminDefault = v
  dispatchEvent(new Event(EVENT))
}

/** What applies until this browser chooses: the admin's default, else the device's settings. */
function followsDevice(): boolean {
  if (adminDefault !== null) return adminDefault
  const reduced = typeof matchMedia !== 'undefined' && matchMedia(REDUCED).matches
  const saveData = !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData
  return reduced || saveData
}

function choice(): boolean | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

export function setLighterBackground(on: boolean): void {
  try {
    // Choosing what the device would do anyway goes back to following it.
    if (on === followsDevice()) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, on ? '1' : '0')
  } catch {}
  dispatchEvent(new Event(EVENT))
}

function subscribe(onChange: () => void): () => void {
  const mq = typeof matchMedia !== 'undefined' ? matchMedia(REDUCED) : null
  addEventListener(EVENT, onChange)
  addEventListener('storage', onChange)
  mq?.addEventListener('change', onChange)
  return () => {
    removeEventListener(EVENT, onChange)
    removeEventListener('storage', onChange)
    mq?.removeEventListener('change', onChange)
  }
}

const snapshot = () => {
  const c = choice()
  return `${c ?? followsDevice()}|${c !== null ? 'chosen' : adminDefault !== null ? 'admin' : 'device'}`
}

/** Whether the background is lighter here, and where that comes from. */
export function useLighterBackground(): { on: boolean; chosen: boolean; from: 'chosen' | 'admin' | 'device' } {
  const [on, from] = useSyncExternalStore(subscribe, snapshot).split('|')
  return { on: on === 'true', chosen: from === 'chosen', from: from as 'chosen' | 'admin' | 'device' }
}
