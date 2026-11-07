import { useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  BookOpen,
  Check,
  CloudOff,
  Expand,
  Loader2,
  Menu,
  MonitorSmartphone,
  Pin,
  RefreshCw,
  Save,
  Share,
  Shrink,
  Smartphone,
  SquarePlus,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import SceneCard from '../components/SceneCard'
import { GuideList, GuideWindow, PlayerDrawer, type DrawerTab } from '../components/PlayerDrawer'
import DocsLink from '../components/DocsLink'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { formatFor, hashUrl, TitleArt, useHidden } from '../lantern/art'
import { Bar, Seg, SourceLabel } from '../lantern/controls'
import { flyGhost, takeTravel } from '../lantern/travel'
import { Button, Confirm, IconButton, Progress, Spinner, Switch, cx, useToast } from '../components/ui'
import { useAuth } from '../lib/auth'
import { api, slotName, type Game } from '../lib/api'
import {
  NO_INSETS,
  frameRect,
  fullscreenCoversNotch,
  fullscreenMode,
  isTouchDevice,
  loadPrefs,
  notchHeight,
  safeInsets,
  savePrefs,
  type DisplayPrefs,
  type Insets,
} from '../lib/display'
import { ago } from '../lib/format'
import { useDefaults, useGame, useSaves, type Defaults } from '../lib/queries'
import { queueHtmlSave, uploadHtmlSave, replayHtmlSaves } from '../lib/html-save-queue'

type Panel = null | 'fullscreen'

/**
 * Keyboard Lock (Chromium): in fullscreen, a tap of Esc reaches the game
 * (Ren'Py's menu) and holding Esc leaves fullscreen. Elsewhere the browser
 * keeps Esc for leaving fullscreen.
 */
type KeyboardLock = { lock?: (keys: string[]) => Promise<void>; unlock?: () => void }
const keyboard = () => (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard
const canLockEscape = () => typeof keyboard()?.lock === 'function'
/** How long Chromium wants Esc held (kHoldEscapeTime in exclusive_access_manager.cc). */
const HOLD_ESCAPE_MS = 1500

/** Muting works like muting a tab, for every game in this browser; the runtime reads it at start. */
const MUTE_KEY = 'renplay:muted'

const HOME_TIP_KEY = 'renplay:home-screen-tip'

export default function Player() {
  const { data: account } = useAuth()
  const userId = useRef(account!.user.id).current
  const [signedOut, setSignedOut] = useState(false)
  const [signInError, setSignInError] = useState('')
  const [legacySaves, setLegacySaves] = useState(false)
  const { id: gameId = '' } = useParams()
  const [params] = useSearchParams()
  const resume = params.get('resume')
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { data: game, isLoading } = useGame(gameId)

  useEffect(() => {
    document.title = game ? `${game.title} · Renplay` : 'Renplay'
    return () => { document.title = 'Renplay' }
  }, [game?.title])

  const shellRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [ready, setReady] = useState(false)
  const [slow, setSlow] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [sync, setSync] = useState({ pending: 0, online: true, lastSync: 0 })
  const [drawer, setDrawer] = useState<DrawerTab | null>(null)
  const [guide, setGuide] = useState<string | null>(null)
  const [savingNow, setSavingNow] = useState(false)
  const toast = useToast()
  const [panel, setPanel] = useState<Panel>(null)
  const [fullscreen, setFullscreen] = useState(false)
  const [prefs, setPrefsState] = useState<DisplayPrefs>(loadPrefs)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [coversNotch, setCoversNotch] = useState(false)
  const [screenSize, setScreenSize] = useState<[number, number] | null>(null)
  const [exiting, setExiting] = useState(false)
  // Save and exit could not get every save to the server: where the person meant to go.
  const [unsent, setUnsent] = useState<'library' | 'game' | null>(null)
  const savingId = useRef<string | null>(null)
  // Ren'Py games: the patches this person chose and the text size, as the game reports them.
  const [gameOptions, setGameOptions] = useState<{ patches: { rollback?: boolean; skip?: boolean; console?: boolean }; fontSize: number; patchesFrom: string; sizeFrom: string } | null>(null)
  // Defaults for everyone, sent with every options message so a game uses them until the person chooses.
  const defaults = useDefaults()
  const defaultsRef = useRef<Defaults | undefined>(undefined)
  defaultsRef.current = defaults.data
  const sendOptions = (extra: Record<string, unknown>) => send({ type: 'renplay:options', defaults: defaultsRef.current, ...extra })
  const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === '1')
  // Esc is locked (a tap reaches the game), shown as a hint for a few seconds,
  // and currently held down.
  const [escLocked, setEscLocked] = useState(false)
  const [escHint, setEscHint] = useState(false)
  const [escHeld, setEscHeld] = useState(false)
  const notch = useMemo(notchHeight, [])
  const touch = useMemo(isTouchDevice, [])
  const fsMode = useMemo(fullscreenMode, [])
  const [insets, setInsets] = useState<Insets>(NO_INSETS)
  const [portraitOk, setPortraitOk] = useState(false)
  const [homeTip, setHomeTip] = useState(() => fsMode === 'home-screen' && !localStorage.getItem(HOME_TIP_KEY))
  const resumed = useRef(false)
  const waiters = useRef(new Map<string, (ok: boolean) => void>())
  // Other engines run their own JavaScript, so they play in a sandboxed frame
  // (opaque origin, no access to Renplay) and their storage comes through here.
  const sandboxed = !!game && game.family !== 'renpy'
  const storageWrite = useRef<Promise<unknown>>(Promise.resolve())
  const storageUpload = useRef<Promise<unknown>>(Promise.resolve())
  const [htmlQueueReady, setHtmlQueueReady] = useState(false)
  useEffect(() => {
    if (!sandboxed) return
    let stopped = false
    setHtmlQueueReady(false)
    void replayHtmlSaves(userId, gameId).then(() => {
      if (!stopped) setHtmlQueueReady(true)
    }).catch(() => {
      if (!stopped) setFailed('Your unsent saves are kept on this device. Connect and retry to sync them before playing.')
    })
    return () => { stopped = true }
  }, [sandboxed, userId, gameId, attempt])

  const setPrefs = (p: DisplayPrefs) => {
    setPrefsState(p)
    savePrefs(p)
  }

  const send = useCallback(
    (msg: Record<string, unknown>) => {
      // An opaque origin cannot be named; the message goes to that frame only.
      frameRef.current?.contentWindow?.postMessage(msg, sandboxed ? '*' : location.origin)
    },
    [sandboxed],
  )

  useEffect(() => {
    const signedOut = () => setSignedOut(true)
    window.addEventListener('renplay:signed-out', signedOut)
    return () => window.removeEventListener('renplay:signed-out', signedOut)
  }, [])

  // Messages from the in-game runtime.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return
      if (e.origin !== (sandboxed ? 'null' : location.origin)) return
      const d = e.data
      if (!d || typeof d.type !== 'string' || !d.type.startsWith('renplay:')) return
      if (sandboxed && d.userId !== userId) return
      switch (d.type) {
        case 'renplay:legacy-saves':
          setLegacySaves(true)
          break
        case 'renplay:signed-out':
          setSignedOut(true)
          break
        case 'renplay:progress':
          setProgress({ done: d.done, total: d.total })
          break
        case 'renplay:ready':
          setReady(true)
          void api(`/api/games/${gameId}/played`, { method: 'POST', headers: { 'x-renplay-user': String(userId) } }).then(() => qc.invalidateQueries({ queryKey: ['games'] })).catch(() => {})
          if (resume && !resumed.current) {
            resumed.current = true
            send({ type: 'renplay:load', slot: resume })
          }
          send({ type: 'renplay:focus' })
          send({ type: 'renplay:mute', value: muted })
          // This person's patches and text size (or the defaults for everyone), applied now and read back for Options.
          if (!sandboxed) send({ type: 'renplay:options', defaults: defaultsRef.current })
          break
        case 'renplay:options':
          if (d.ok) setGameOptions({ patches: d.patches ?? {}, fontSize: typeof d.fontSize === 'number' ? d.fontSize : 1, patchesFrom: d.patchesFrom ?? 'default', sizeFrom: d.sizeFrom ?? 'default' })
          else toast('The game did not take that change.')
          break
        case 'renplay:sync':
          setSync({ pending: d.pending, online: d.online, lastSync: d.lastSync })
          break
        case 'renplay:info':
          if (Array.isArray(d.screen) && d.screen[0]) setScreenSize([d.screen[0], d.screen[1]])
          break
        case 'renplay:fullscreen':
          void toggleFullscreen(d.enable)
          break
        case 'renplay:flushed':
          // After the storage that came before it is stored.
          void storageWrite.current.finally(() => waiters.current.get(d.id)?.(d.ok !== false))
          break
        case 'renplay:saved-now':
          if (d.id !== savingId.current) break
          savingId.current = null
          setSavingNow(false)
          toast(d.saved ? (d.ok ? 'Saved' : 'Saved on this device. It syncs when the connection is back.') : 'Nothing to save in the main menu.', d.ok ? 'success' : 'info')
          break
        case 'renplay:save-conflict':
          toast(
            d.deleted
              ? 'Another device saved this save after you deleted it here, so it is back.'
              : d.kept === 'other'
                ? 'Another device saved over this save more recently. Its copy is in the slot, and yours is kept in History.'
                : 'Another device also saved this save. Yours is newer and is in the slot. The other copy is kept in History.',
            'info',
          )
          void qc.invalidateQueries({ queryKey: ['saves', game?.id] })
          break
        case 'renplay:accessibility':
          if (!d.ok) toast('This game does not offer Ren’Py’s accessibility menu.')
          break
        case 'renplay:storage':
          // A game's whole storage, kept within the size a save file may have on the server.
          if (sandboxed && typeof d.data === 'string' && d.data.length <= 32 << 20 && game?.saveDir) {
            const path = `${game.saveDir}/${d.kind === 'idb' ? 'indexedDB.json' : 'localStorage.json'}`
            storageWrite.current = storageWrite.current
              .catch(() => {})
              .then(async () => {
                const entry = await queueHtmlSave(userId, gameId, path, d.data)
                send({ type: 'renplay:storage-kept', kind: d.kind, data: d.data, userId })
                // A stalled upload must never delay the next durable snapshot or its acknowledgement.
                storageUpload.current = storageUpload.current.catch(() => {})
                  .then(() => uploadHtmlSave(entry))
                  .catch(() => setSignedOut(true))
              })
              .catch(() => setSignedOut(true))
          }
          break
        case 'renplay:exited':
          void qc.invalidateQueries({ queryKey: ['games'] })
          void qc.invalidateQueries({ queryKey: ['game', gameId] })
          void qc.invalidateQueries({ queryKey: ['saves', gameId] })
          navigate(`/game/${gameId}`)
          break
        case 'renplay:error':
          if (typeof d.message === 'string') setFailed(d.message)
          break
        case 'renplay:escape':
          setEscHeld(!!d.down)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, resume, sandboxed, game?.saveDir, muted])

  useEffect(() => {
    if (!ready || exiting || failed) return
    let previous = performance.now()
    let seconds = 0
    const report = () => {
      const whole = Math.min(60, Math.floor(seconds))
      if (whole < 1) return
      seconds -= whole
      void fetch(`/api/games/${gameId}/play-time`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-renplay-user': String(userId) }, body: JSON.stringify({ seconds: whole }), keepalive: true }).then((response) => { if (response.status === 401) setSignedOut(true) }).catch(() => {})
    }
    // A Ren'Py game left alone stops counting after 15 minutes without a tap, click or key, in the
    // game or on the player. A sandboxed game's input cannot be seen, so it counts while visible.
    let lastInput = performance.now()
    const onInput = () => {
      lastInput = performance.now()
    }
    const inputs = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    const targets: Window[] = [window]
    try {
      const inner = !sandboxed ? frameRef.current?.contentWindow : null
      if (inner) targets.push(inner)
    } catch {}
    for (const t of targets) for (const type of inputs) t.addEventListener(type, onInput, { capture: true, passive: true })
    const sample = () => {
      const now = performance.now()
      const active = sandboxed || now - lastInput < 15 * 60_000
      if (document.visibilityState === 'visible' && active) seconds += Math.min(2, (now - previous) / 1000)
      previous = now
      if (seconds >= 15) report()
    }
    const visibility = () => { previous = performance.now(); report() }
    const timer = window.setInterval(sample, 1000)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('pagehide', report)
    return () => {
      for (const t of targets) for (const type of inputs) { try { t.removeEventListener(type, onInput, { capture: true }) } catch {} }
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('pagehide', report)
      report()
      void qc.invalidateQueries({ queryKey: ['games'] })
      void qc.invalidateQueries({ queryKey: ['game', gameId] })
    }
  }, [ready, exiting, failed, gameId, qc, sandboxed])

  useEffect(() => {
    if (game?.screen && !screenSize) setScreenSize(game.screen)
  }, [game, screenSize])

  useEffect(() => {
    if (ready) return
    const t = window.setTimeout(() => setSlow(true), 90_000)
    return () => clearTimeout(t)
  }, [ready])

  // Stage size for Fill mode.
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [game?.id, isLoading])

  // The screen's real safe area (camera cutout, rounded corners, home indicator), per orientation.
  useEffect(() => {
    const update = () => setInsets(safeInsets())
    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])

  // Keep the screen on while playing (reading a long scene is not "idle").
  useEffect(() => {
    if (!ready || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let done = false
    const take = async () => {
      try {
        if (!done && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen')
      } catch {}
    }
    void take()
    document.addEventListener('visibilitychange', take)
    return () => {
      done = true
      document.removeEventListener('visibilitychange', take)
      void lock?.release().catch(() => {})
    }
  }, [ready])

  // Fullscreen.
  const toggleFullscreen = useCallback(
    async (want?: boolean) => {
      if (fsMode === 'home-screen') {
        if (want !== false) setPanel('fullscreen')
        return
      }
      if (fsMode !== 'api') return
      const on = !!document.fullscreenElement
      const target = want ?? !on
      try {
        if (target && !on) {
          await shellRef.current?.requestFullscreen({ navigationUI: 'hide' })
          // Phones: games are wide, so hold landscape while in fullscreen.
          if (touch) await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {})
          // Chrome may refuse the lock (it asks for permission since 130): then Esc just leaves.
          else if (keyboard()?.lock) setEscLocked(await keyboard()!.lock!(['Escape']).then(() => true, () => false))
        } else if (!target && on) await document.exitFullscreen()
      } catch {}
    },
    [fsMode, touch],
  )
  useEffect(() => {
    const onChange = () => {
      const on = !!document.fullscreenElement
      if (!on) {
        keyboard()?.unlock?.()
        setEscLocked(false)
        setEscHeld(false)
      }
      setFullscreen(on)
      send({ type: 'renplay:fullscreen-state', value: on })
      setTimeout(() => setCoversNotch(on && fullscreenCoversNotch()), 250)
      send({ type: 'renplay:focus' })
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [send])

  // Esc in fullscreen: say how to leave when it starts, and show the hold.
  useEffect(() => {
    if (!escLocked) return
    setEscHint(true)
    const t = setTimeout(() => setEscHint(false), 4000)
    return () => clearTimeout(t)
  }, [escLocked])
  useEffect(() => {
    if (!escLocked) return
    // When the player rather than the game has focus.
    const key = (down: boolean) => (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.repeat) setEscHeld(down)
    }
    const down = key(true)
    const up = key(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [escLocked])

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    if (next) localStorage.setItem(MUTE_KEY, '1')
    else localStorage.removeItem(MUTE_KEY)
    send({ type: 'renplay:mute', value: next })
  }

  const closeDrawer = useCallback(() => {
    setDrawer(null)
    send({ type: 'renplay:focus' })
  }, [send])

  /**
   * Saves (an autosave, or a quick save in a game without autosave), then waits until every save
   * reached the server. Longer than the runtime's own limits, so its answer always arrives first.
   */
  const saveAndFlush = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        const id = Math.random().toString(36).slice(2)
        const t = setTimeout(() => (waiters.current.delete(id), resolve(false)), 20_000)
        waiters.current.set(id, (ok) => {
          clearTimeout(t)
          waiters.current.delete(id)
          resolve(ok)
        })
        send({ type: ready ? 'renplay:save-and-exit' : 'renplay:flush', id })
      }),
    [ready, send],
  )

  const exit = useCallback(async (to: 'library' | 'game' = 'game', anyway = false) => {
    setExiting(true)
    // Saves that did not reach the server stay on this device and go up the next time the game
    // opens here. The person decides whether to leave now.
    if (!anyway && !(await saveAndFlush())) {
      setExiting(false)
      setUnsent(to)
      return
    }
    setUnsent(null)
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {})
    void qc.invalidateQueries({ queryKey: ['saves', gameId] })
    void qc.invalidateQueries({ queryKey: ['games'] })
    navigate(to === 'library' ? '/' : `/game/${gameId}`)
  }, [navigate, qc, send, gameId, saveAndFlush])

  // Defaults that arrive after the game was ready still reach it.
  useEffect(() => {
    if (ready && !sandboxed && defaults.data) send({ type: 'renplay:options', defaults: defaults.data })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sandboxed, defaults.data])

  /** Save now: a quick save, synced to the server. */
  const saveNow = () => {
    if (savingNow) return
    const id = Math.random().toString(36).slice(2)
    savingId.current = id
    setSavingNow(true)
    send({ type: 'renplay:save-now', id })
    // A game that never answers does not leave the button saying Saving.
    window.setTimeout(() => {
      if (savingId.current !== id) return
      savingId.current = null
      setSavingNow(false)
      toast('The game did not answer. Try again, or save from its own menu.')
    }, 20_000)
  }

  /** Main menu: the game saves first (saves that cannot reach the server wait on this device), then starts again at its main menu. */
  const mainMenu = async () => {
    setDrawer(null)
    await saveAndFlush()
    setReady(false)
    setProgress(null)
    navigate(`/play/${gameId}`, { replace: true })
    setAttempt((n) => n + 1)
  }

  // Esc on the player itself (not in the game) opens and closes the drawer.
  useEffect(() => {
    if (!ready) return
    const key = (e: KeyboardEvent) => {
      // A key the drawer already used (to close itself) does not open it again.
      if (e.key !== 'Escape' || e.repeat || e.defaultPrevented || escLocked || drawer || guide) return
      setDrawer(sandboxed ? 'options' : 'saves')
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [ready, escLocked, drawer, guide, sandboxed])

  // Space the game keeps clear of: a MacBook's notch in fullscreen, a phone's
  // camera cutout (the sides in landscape, the top in portrait). The home
  // indicator is only a thin line over the game, so the game may run under it.
  const avoid = prefs.avoidNotch
  const landscape = stage.w >= stage.h
  const pad = {
    top: Math.max(fullscreen && avoid && notch && coversNotch ? notch : 0, avoid && !landscape ? insets.top : 0),
    right: avoid && landscape ? insets.right : 0,
    bottom: 0,
    left: avoid && landscape ? insets.left : 0,
  }
  const area = { w: Math.max(0, stage.w - pad.left - pad.right), h: Math.max(0, stage.h - pad.top - pad.bottom) }
  const rect = frameRect(area.w, area.h, screenSize, prefs.fit)
  const hasCutout = notch > 0 || insets.top + insets.right + insets.bottom + insets.left > 0
  const portrait = touch && stage.h > stage.w && (!screenSize || screenSize[0] > screenSize[1])
  const dismissHomeTip = () => {
    localStorage.setItem(HOME_TIP_KEY, '1')
    setHomeTip(false)
  }

  if (isLoading)
    return (
      <div className="flex h-dvh items-center justify-center bg-black">
        <Spinner />
      </div>
    )
  if (!game || !game.playUrl)
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-black text-zinc-300">
        <p>This game is not installed.</p>
        <Button onClick={() => navigate(game ? `/game/${gameId}` : '/')}>Go back</Button>
      </div>
    )

  const loadPct = progress && progress.total ? progress.done / progress.total : 0

  return (
    <div ref={shellRef} className="fixed inset-0 touch-manipulation overflow-hidden overscroll-none bg-black text-white outline-none">
      {signedOut && <div className="fixed inset-0 z-[100] flex items-end justify-center bg-black/60 p-4 sm:items-center"><section role="dialog" aria-modal="true" aria-label="You were signed out" className="safe-bottom w-full max-w-md space-y-4 rounded-3xl bg-ink-950 p-6 ring-1 ring-white/10"><h2 className="text-xl font-semibold">You were signed out.</h2><p className="text-sm text-zinc-400">Your saves are kept on this device until you sign in to the same account.</p><a className="btn p" style={{ display: 'inline-flex' }} href="/signin" target="_blank" rel="noreferrer">Sign in</a><Button className="ml-3" onClick={async () => {
        try { const me = await api<{ user: { id: number } }>('/api/me'); if (me.user.id !== userId) { setSignInError('Sign in to the account that started this game.'); return }; send({ type: 'renplay:resume-sync', userId }); setSignedOut(false); setSignInError('') } catch { setSignInError('Sign in first, then try again.') }
      }}>Continue</Button>{signInError && <p role="alert" className="text-sm text-rose-300">{signInError}</p>}</section></div>}
      {legacySaves && <div role="status" className="fixed inset-x-4 top-4 z-[90] mx-auto max-w-md rounded-2xl bg-ink-950 p-4 text-sm shadow-xl"><p>Unowned browser saves are kept on this device. Their account is not known. Ask an admin to help recover them before clearing browser storage.</p><Button onClick={() => setLegacySaves(false)} className="mt-2">Dismiss</Button></div>}
      {/* Game stage */}
      <div ref={stageRef} className={cx('rp-stage absolute inset-0', drawer && 'dim')}>
        <div className="absolute overflow-hidden" style={{ top: pad.top, right: pad.right, bottom: pad.bottom, left: pad.left }}>
          <iframe
            ref={frameRef}
            key={attempt}
            src={sandboxed && !htmlQueueReady ? undefined : game.playUrl}
            title={game.title}
            allow="autoplay; fullscreen; gamepad; clipboard-read; clipboard-write"
            sandbox={sandboxed ? 'allow-scripts allow-modals allow-pointer-lock allow-popups allow-downloads allow-forms' : undefined}
            className="absolute border-0 bg-black outline-none"
            style={{ width: rect.width || '100%', height: rect.height || '100%', left: rect.left, top: rect.top }}
          />
        </div>
      </div>

      {/* The door: the stage's art grown to the viewport while the game loads. */}
      <Door game={game} ready={ready || (portrait && !portraitOk)} resume={resume} progress={progress} loadPct={loadPct} failed={failed} slow={slow} sandboxed={sandboxed} onRetry={() => { setFailed(null); setProgress(null); setAttempt((n) => n + 1) }} onShowGame={() => setReady(true)} homeTip={homeTip} onHomeTip={() => setPanel('fullscreen')} onDismissHomeTip={dismissHomeTip} />

      {/* Saving overlay */}
      {exiting && (
        <div className="absolute inset-0 z-50 flex animate-fade-in flex-col items-center justify-center gap-3 bg-black/70 backdrop-blur-sm">
          <Loader2 className="size-6 animate-spin text-accent-300" />
          <p className="text-sm text-zinc-200">Saving your progress</p>
        </div>
      )}

      {/* Portrait phones: games are wide. */}
      {portrait && !portraitOk && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-3 bg-black/95 p-8 text-center backdrop-blur-sm">
          <Smartphone className="mb-2 size-10 rotate-90 text-accent-300" />
          <p className="text-lg font-semibold">Turn your phone sideways</p>
          <p className="max-w-xs text-sm text-zinc-400">{game.title} is made for a wide screen. The game loads in the meantime.</p>
          {!ready && <div className="mt-4 w-full max-w-xs"><p className="mb-3 text-sm text-zinc-400">{failed || (!progress ? 'Starting engine' : `Loading game ${Math.round(loadPct * 100)}%`)}</p>{failed ? <Button onClick={() => { setFailed(null); setProgress(null); setAttempt((n) => n + 1) }}>Try again</Button> : <Progress value={loadPct} indeterminate={!progress || !progress.total} />}</div>}
          <Button variant="ghost" size="sm" className="mt-2" onClick={() => setPortraitOk(true)}>
            Play upright anyway
          </Button>
        </div>
      )}

      {/* Two quiet things over the game: the Renplay pill (the drawer) and, while something waits, the sync pill. */}
      {ready && !drawer && (
        <button
          type="button"
          className="rp-pill"
          onClick={() => setDrawer(sandboxed ? 'options' : 'saves')}
          aria-label="Open the player menu"
          // HTML games often put their own menu in the top left (SugarCube's sidebar toggle).
          style={sandboxed ? { top: 10 + Math.max(insets.top, pad.top), right: 10 + insets.right } : { top: 10 + Math.max(insets.top, pad.top), left: 10 + insets.left }}
        >
          <span className="mark" aria-hidden="true" />
          Renplay
        </button>
      )}
      {ready && (sync.pending > 0 || !sync.online) && (
        <span className={cx('rp-sync', !sync.online && 'amber')} role="status" style={sandboxed ? { top: 14 + Math.max(insets.top, pad.top), left: 10 + insets.left } : { top: 14 + Math.max(insets.top, pad.top), right: 10 + insets.right }}>
          {!sync.online ? <CloudOff /> : <RefreshCw className="animate-spin" />}
          {!sync.online ? `Offline, ${sync.pending} ${sync.pending === 1 ? 'save' : 'saves'} waiting` : 'Syncing'}
        </span>
      )}
      {/* A swipe from the left edge opens the drawer on touch screens. */}
      {touch && ready && !drawer && (
        <div
          className="absolute inset-y-0 left-0 z-20 w-4"
          onTouchStart={(e) => {
            const x0 = e.touches[0]!.clientX
            const y0 = e.touches[0]!.clientY
            const done = () => {
              window.removeEventListener('touchend', end)
              window.removeEventListener('touchcancel', done)
            }
            // A swipe mostly to the right opens it. A cancelled touch (the system's own back
            // gesture) does nothing.
            const end = (ev: TouchEvent) => {
              const t = ev.changedTouches[0]
              const dx = (t?.clientX ?? x0) - x0
              const dy = Math.abs((t?.clientY ?? y0) - y0)
              if (dx > 40 && dx > dy * 2) setDrawer(sandboxed ? 'options' : 'saves')
              done()
            }
            window.addEventListener('touchend', end)
            window.addEventListener('touchcancel', done)
          }}
        />
      )}

      {fullscreen && escLocked && (escHeld || escHint) && <EscapeHint held={escHeld} top={Math.max(insets.top, pad.top) + 60} />}

      <Confirm
        open={unsent !== null}
        onClose={() => setUnsent(null)}
        onConfirm={() => void exit(unsent ?? 'library', true)}
        title="Some saves have not reached the server"
        confirmLabel="Leave anyway"
        cancelLabel="Stay"
      >
        They are kept on this device and go to the server the next time you open this game here. Stay and try Save and exit again, or leave now.
      </Confirm>
      {drawer && (
        <PlayerDrawer
          game={game}
          tab={drawer}
          onTab={setDrawer}
          onClose={closeDrawer}
          portrait={stage.h > stage.w}
          insets={insets}
          renpy={!sandboxed}
          ready={ready}
          pending={sync.pending}
          online={sync.online}
          saving={savingNow}
          onSaveNow={saveNow}
          onExit={(to) => void exit(to)}
          onMainMenu={() => void mainMenu()}
          saves={
            <SavesPanel
              gameId={gameId}
              onLoad={(slot) => {
                send({ type: 'renplay:load', slot })
                setDrawer(null)
              }}
            />
          }
          guide={
            <GuideList
              game={game}
              onOpen={(file) => {
                setGuide(file)
                setDrawer(null)
              }}
            />
          }
          options={
            <div className="stack" style={{ gap: 16 }}>
              <Switch checked={!muted} label="Sound" onChange={() => toggleMute()} />
              {fsMode !== 'none' && (
                <Button size="sm" icon={fullscreen ? <Shrink className="size-4" /> : <Expand className="size-4" />} onClick={() => void toggleFullscreen()}>
                  {fullscreen ? 'Leave full screen' : 'Full screen'}
                </Button>
              )}
              {!sandboxed && gameOptions && (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="row between" style={{ gap: 8 }}>
                    <span className="small" style={{ fontWeight: 600 }}>Text size</span>
                    {gameOptions.sizeFrom === 'admin' && <SourceLabel kind="admin" />}
                  </div>
                  <Seg
                    small
                    label="Text size"
                    value={String(TEXT_SIZES.find((t) => Math.abs(t.value - gameOptions.fontSize) < 0.01)?.value ?? '')}
                    onChange={(v) => sendOptions({ fontSize: Number(v) })}
                    options={TEXT_SIZES.map((t) => ({ value: String(t.value), label: t.label }))}
                  />
                </div>
              )}
              {!sandboxed && (
                <div>
                  <Button size="sm" onClick={() => send({ type: 'renplay:accessibility' })}>
                    Accessibility menu
                  </Button>
                  <p className="xs muted" style={{ marginTop: 6 }}>Ren’Py’s own menu for fonts, self-voicing and mono audio, where the game offers it.</p>
                </div>
              )}
              {!sandboxed && gameOptions && (
                <div className="stack" style={{ gap: 4 }}>
                  <div className="row between" style={{ gap: 8 }}>
                    <span className="small" style={{ fontWeight: 600 }}>For you in this game</span>
                    {gameOptions.patchesFrom === 'admin' && <SourceLabel kind="admin" />}
                  </div>
                  <Switch
                    checked={!!gameOptions.patches.rollback}
                    label="Rollback"
                    hint="Go back to earlier lines with the mouse wheel or Page Up, even where the game turns it off."
                    onChange={(rollback) => sendOptions({ patches: { rollback } })}
                  />
                  <Switch
                    checked={!!gameOptions.patches.skip}
                    label="Skip"
                    hint="Skip text you have read with Ctrl or Tab, even where the game turns it off."
                    onChange={(skip) => sendOptions({ patches: { skip } })}
                  />
                  <Switch
                    checked={!!gameOptions.patches.console}
                    label="Developer console"
                    hint="Ren’Py’s console, opened with Shift and O. For changing variables, at your own risk."
                    onChange={(console) => sendOptions({ patches: { console } })}
                  />
                  <p className="xs muted">Kept with this game’s saves, so they follow you to every device. The game’s files do not change.</p>
                </div>
              )}
              <DisplayPanel
                prefs={prefs}
                setPrefs={setPrefs}
                notch={notch}
                hasCutout={hasCutout}
                fullscreen={fullscreen}
                coversNotch={coversNotch}
                screenSize={screenSize}
                area={area}
                fsMode={fsMode}
                onFullscreen={() => void toggleFullscreen()}
                onDownloadLog={sandboxed ? undefined : () => send({ type: 'renplay:download-log' })}
              />
            </div>
          }
        />
      )}
      {guide && game.walkthroughs.length > 0 && (
        <GuideWindow game={game} file={guide} onFile={setGuide} onClose={() => { setGuide(null); send({ type: 'renplay:focus' }) }} portrait={stage.h > stage.w} insets={insets} />
      )}
      {panel === 'fullscreen' && (
        <SidePanel
          title="Full screen on iPhone"
          onClose={() => {
            dismissHomeTip()
            setPanel(null)
          }}
          top={pad.top}
          narrow
        >
          <HomeScreenHelp />
        </SidePanel>
      )}
    </div>
  )
}

/** The door: the hero across the whole screen, the logo or title and the loading bar at its bottom left. It ends when the game is ready, never after a minimum time. */
function Door({
  game,
  ready,
  resume,
  progress,
  loadPct,
  failed,
  slow,
  sandboxed,
  onRetry,
  onShowGame,
  homeTip,
  onHomeTip,
  onDismissHomeTip,
}: {
  game: Game
  ready: boolean
  resume: string | null
  progress: { done: number; total: number } | null
  loadPct: number
  failed: string | null
  slow: boolean
  sandboxed: boolean
  onRetry: () => void
  onShowGame: () => void
  homeTip: boolean
  onHomeTip: () => void
  onDismissHomeTip: () => void
}) {
  const hidden = useHidden(game)
  const hero = formatFor(game.art, 'hero')
  const art = (!hidden && hero?.url1x) || hashUrl(hero?.thumbhash)
  const [settling, setSettling] = useState(false)
  useEffect(() => {
    const t = takeTravel(game.id)
    if (!t) return
    setSettling(true)
    flyGhost(t, { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight }, () => setSettling(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.id])
  const status = failed ? 'Something went wrong' : sandboxed ? 'Loading game' : resume ? 'Loading your save' : !progress ? 'Starting engine' : loadPct >= 1 ? 'Starting game' : 'Loading game'
  return (
    <div className={cx('door', ready ? 'pointer-events-none opacity-0' : 'opacity-100')} style={{ transition: 'opacity .7s', zIndex: 10, position: 'absolute' }}>
      <div className={cx('art', hero?.made === 'glow' && 'blur')} style={settling ? { opacity: 0 } : undefined}>
        {art && <img src={art} alt="" />}
      </div>
      <div className="tb">
        <TitleArt game={game} hidden={hidden} />
        <div className="muted-2" style={{ marginTop: 8, fontSize: 14 }}>
          {resume ? `Resuming ${resume}` : 'Starting from the main menu'} · {status}
          {!failed && progress && progress.total > 0 ? <> <span className="tnum">{Math.round(loadPct * 100)}%</span></> : null}
        </div>
        {failed ? (
          <div className="stack" style={{ marginTop: 14, alignItems: 'flex-start', gap: 10 }}>
            <p className="red small">{failed}</p>
            <Button onClick={onRetry}>Try again</Button>
          </div>
        ) : (
          <div style={{ marginTop: 14, maxWidth: 360 }}>{progress && progress.total > 0 ? <Bar value={loadPct} /> : <Progress value={0} indeterminate />}</div>
        )}
        {homeTip && (
          <div className="notice" style={{ marginTop: 16, maxWidth: 420 }}>
            <SquarePlus />
            <span className="grow small">
              For full screen, add Renplay to your home screen.{' '}
              <button className="link" onClick={onHomeTip}>
                How
              </button>
            </span>
            <IconButton label="Dismiss" onClick={onDismissHomeTip}>
              <X className="size-4" />
            </IconButton>
          </div>
        )}
        {slow && !failed && (
          <button onClick={onShowGame} className="link-q xs" style={{ marginTop: 14, display: 'inline-block' }}>
            Taking long? Show the game’s own loading screen
          </button>
        )}
      </div>
    </div>
  )
}

/** How to leave fullscreen, and while Esc is held, a ring that fills until it does. */
function EscapeHint({ held, top }: { held: boolean; top: number }) {
  const r = 9
  const c = 2 * Math.PI * r
  return (
    <div className="pointer-events-none absolute inset-x-0 z-40 flex justify-center px-4 animate-fade-in" style={{ top }}>
      <div className="flex items-center gap-3 rounded-full bg-black/75 py-2 pl-2.5 pr-4 text-sm text-white ring-1 ring-white/15 backdrop-blur">
        <svg viewBox="0 0 24 24" className="size-6 -rotate-90" aria-hidden="true">
          <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
          {held && (
            <circle
              key="hold"
              cx="12"
              cy="12"
              r={r}
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={c}
              strokeDashoffset={c}
              style={{ animation: `escape-hold ${HOLD_ESCAPE_MS}ms linear forwards` }}
            />
          )}
        </svg>
        <span>
          {held ? (
            'Keep holding Esc to leave fullscreen'
          ) : (
            <>
              Hold <kbd className="rounded bg-white/15 px-1.5 py-0.5 font-sans text-xs">Esc</kbd> to leave fullscreen. A short press opens the game’s menu.
            </>
          )}
        </span>
      </div>
    </div>
  )
}

function SyncBadge({ sync }: { sync: { pending: number; online: boolean; lastSync: number } }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  const label = !sync.online
    ? 'Offline. Saves are kept and upload when the server is back'
    : sync.pending
      ? 'Uploading saves'
      : sync.lastSync
        ? `Saves synced ${ago(sync.lastSync)}`
        : 'Saves are stored on the server'
  return (
    <span title={label} className="mr-1 flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] text-zinc-300">
      {!sync.online ? (
        <CloudOff className="size-3.5 text-amber-300" />
      ) : sync.pending ? (
        <RefreshCw className="size-3.5 animate-spin text-accent-300" />
      ) : (
        <Check className="size-3.5 text-emerald-400" />
      )}
      <span className="hidden sm:inline">{!sync.online ? 'Offline' : sync.pending ? 'Syncing' : 'Synced'}</span>
    </span>
  )
}

function SidePanel({ title, onClose, children, top, narrow }: { title: string; onClose: () => void; children: React.ReactNode; top: number; narrow?: boolean }) {
  return (
    <div className="absolute inset-0 z-40" style={{ top }}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className={cx('safe-x safe-bottom absolute bg-ink-900/95 backdrop-blur-xl bottom-0 right-0 max-h-[85%] sm:max-h-none sm:top-0 flex w-full animate-rise flex-col rounded-t-3xl sm:rounded-none border-l border-white/10', narrow ? 'sm:w-96' : 'sm:w-[440px]')}>
        <div className="flex items-center justify-between px-5 py-4">
          <h2 className="text-[15px] font-semibold">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </div>
        <div className="scrollbar-thin min-h-0 flex-1 touch-pan-y overflow-y-auto overscroll-contain px-5 pb-6">{children}</div>
      </aside>
    </div>
  )
}

/** Named text sizes: Ren'Py's own text size preference, kept with the game's persistent data. */
const TEXT_SIZES = [
  { value: 1, label: 'Normal' },
  { value: 1.25, label: 'Large' },
  { value: 1.5, label: 'Larger' },
]

function SavesPanel({ gameId, onLoad }: { gameId: string; onLoad: (slot: string) => void }) {
  const { data, isLoading, refetch } = useSaves(gameId)
  const { data: saveGame } = useGame(gameId)
  useEffect(() => {
    void refetch()
  }, [refetch])
  const [filter, setFilter] = useState<'all' | 'pinned' | 'manual' | 'auto' | 'quick'>('all')
  const all = (data?.slots ?? []).filter((s) => s.kind !== 'internal' && s.valid)
  if (isLoading) return <Spinner />
  if (!all.length) return <p className="text-sm text-zinc-400">No saves yet. Saves you make in the game are stored on the server as you make them.</p>
  const pinned = all.filter((s) => s.pinnedAt).length
  const kinds = (['manual', 'auto', 'quick'] as const).filter((k) => all.some((s) => s.kind === k))
  // Pinned saves first, then the newest.
  const slots = all
    .filter((s) => filter === 'all' || (filter === 'pinned' ? !!s.pinnedAt : s.kind === filter))
    .sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || b.ctime - a.ctime)
  return (
    <div className="stack" style={{ gap: 12 }}>
      {(pinned > 0 || kinds.length > 1) && (
        <Seg
          small
          scroll
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all' as const, label: 'All' },
            ...(pinned ? [{ value: 'pinned' as const, label: 'Pinned' }] : []),
            ...kinds.map((k) => ({ value: k, label: `${k[0]!.toUpperCase()}${k.slice(1)}` })),
          ]}
        />
      )}
      <div className="pd-saves">
        {slots.map((s) => (
          <button key={s.file} onClick={() => onLoad(slotName(s.file))} className={cx('pd-save group flex flex-col justify-start overflow-hidden rounded-xl bg-white/[0.04] text-left ring-1 ring-white/10 transition hover:ring-accent-400/60', s.pinnedAt && 'pinned')}>
            {saveGame && <SceneCard game={saveGame} save={s} className="rounded-none" />}
            <div className="p-2.5">
              <div className="row truncate text-xs font-medium text-zinc-100" style={{ gap: 4 }}>
                {s.pinnedAt && <Pin className="size-3 shrink-0" style={{ color: 'var(--amber)' }} aria-label="Pinned" />}
                <span className="truncate">{s.title || s.name || s.label}</span>
              </div>
              {s.note && <div className="pd-note text-[11px] text-zinc-300">{s.note}</div>}
              <div className="truncate text-[11px] text-zinc-400">
                {s.title || s.name ? `${s.label} · ` : ''}
                {ago(s.ctime)}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

function HomeScreenHelp() {
  return (
    <div className="space-y-4 text-sm text-zinc-300">
      <p>Safari on iPhone only lets videos go full screen. Renplay can fill the whole screen when you open it from your home screen:</p>
      <DocsLink path="guides/playing/">Playing on iPhone</DocsLink>
      <ol className="space-y-3">
        <li className="flex items-center gap-3">
          <Share className="size-5 shrink-0 text-accent-300" />
          <span>Tap the Share button in Safari.</span>
        </li>
        <li className="flex items-center gap-3">
          <SquarePlus className="size-5 shrink-0 text-accent-300" />
          <span>Choose Add to Home Screen.</span>
        </li>
        <li className="flex items-center gap-3">
          <Smartphone className="size-5 shrink-0 rotate-90 text-accent-300" />
          <span>Open Renplay from the home screen and hold the phone sideways.</span>
        </li>
      </ol>
      <p className="text-zinc-400">Saves are on the server, so you continue where you left off on any device.</p>
    </div>
  )
}

function DisplayPanel({
  prefs,
  setPrefs,
  notch,
  hasCutout,
  fullscreen,
  coversNotch,
  screenSize,
  area,
  fsMode,
  onFullscreen,
  onDownloadLog,
}: {
  prefs: DisplayPrefs
  setPrefs: (p: DisplayPrefs) => void
  notch: number
  hasCutout: boolean
  fullscreen: boolean
  coversNotch: boolean
  screenSize: [number, number] | null
  area: { w: number; h: number }
  fsMode: 'api' | 'home-screen' | 'none'
  onFullscreen: () => void
  /** Ren'Py games only. */
  onDownloadLog?: () => void
}) {
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-xs font-medium text-zinc-400">Scaling</p>
        <div className="pd-pair">
          {(
            [
              ['fit', 'Fit', 'Whole game visible, bars where the shape differs'],
              ['fill', 'Fill', 'Fill the screen, cropping the edges'],
            ] as const
          ).map(([id, label, hint]) => (
            <button
              key={id}
              onClick={() => setPrefs({ ...prefs, fit: id })}
              className={cx('rounded-xl p-3 text-left ring-1 ring-inset transition', prefs.fit === id ? 'bg-accent-500/15 ring-accent-400/50' : 'bg-white/[0.04] ring-white/10 hover:bg-white/[0.07]')}
            >
              <div className="text-sm font-medium">{label}</div>
              <div className="mt-1 text-[11px] leading-snug text-zinc-400">{hint}</div>
            </button>
          ))}
        </div>
        {screenSize && area.w > 0 && (
          <p className="mt-2 text-[11px] text-zinc-500">
            Game {screenSize[0]}×{screenSize[1]} ({(screenSize[0] / screenSize[1]).toFixed(2)}:1) · Screen area {area.w}×{area.h} ({(area.w / area.h).toFixed(2)}:1)
          </p>
        )}
      </div>
      {hasCutout && (
        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">Camera cutout</p>
          <Switch
            checked={prefs.avoidNotch}
            onChange={(v) => setPrefs({ ...prefs, avoidNotch: v })}
            label="Keep the game clear of the camera"
            hint={
              notch > 0
                ? fullscreen && !coversNotch
                  ? 'Your browser already keeps the notch area black in fullscreen.'
                  : `In fullscreen the top ${notch}px strip below the camera stays black when this is on. Off uses the full screen height.`
                : 'On keeps the game clear of the camera cutout. Off uses the whole screen.'
            }
          />
        </div>
      )}
      {fsMode === 'api' && (
        <div>
          <Button variant="secondary" className="w-full" icon={fullscreen ? <Shrink className="size-4" /> : <Expand className="size-4" />} onClick={onFullscreen}>
            {fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
          </Button>
          <p className="mt-2 text-[11px] leading-snug text-zinc-500">
            {canLockEscape()
              ? 'In fullscreen, Esc opens the game’s menu. Hold Esc to leave fullscreen.'
              : 'In fullscreen, this browser keeps Esc for leaving it. Right-click opens the game’s menu.'}
          </p>
        </div>
      )}
      {fsMode === 'home-screen' && (
        <div>
          <p className="mb-2 text-xs font-medium text-zinc-400">Full screen</p>
          <HomeScreenHelp />
        </div>
      )}
      {onDownloadLog && (
        <div className="flex items-center justify-between border-t border-white/[0.06] pt-4 text-xs text-zinc-500">
          <button onClick={onDownloadLog} className="hover:text-zinc-300">
            Download the game’s log
          </button>
          <a href="https://www.renpy.org/" target="_blank" rel="noreferrer" className="hover:text-zinc-300">
            Powered by Ren’Py
          </a>
        </div>
      )}
    </div>
  )
}
