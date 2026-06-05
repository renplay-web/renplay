import { useRef, useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import type { Game } from '../types'

export default function GameView() {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [loaded, setLoaded] = useState(false)
  const [iframeError, setIframeError] = useState(false)
  const [game, setGame] = useState<Game | null>(null)
  const fullscreenRef = useRef<HTMLDivElement>(null)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  // Re-focus the iframe whenever the pointer re-enters it.
  // On macOS, if the iframe lost focus (tab switch, address bar, etc.) the next
  // tap refocuses the iframe but the browser swallows the event before it reaches
  // the game canvas. Calling focus() on pointerenter ensures the iframe is already
  // focused by the time the user taps, so the tap lands as a real click.
  useEffect(() => {
    const el = iframeRef.current
    if (!el) return
    const refocus = () => el.focus()
    el.addEventListener('mouseenter', refocus)
    el.addEventListener('pointerenter', refocus)
    return () => {
      el.removeEventListener('mouseenter', refocus)
      el.removeEventListener('pointerenter', refocus)
    }
  }, [loaded])

  const handleBack = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({ type: 'renplay-save-now' }, '*')
    setTimeout(() => navigate('/'), 300)
  }, [navigate])

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.data?.type === 'renplay-game-exited') {
        navigate('/')
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [navigate])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !document.fullscreenElement) {
        handleBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleBack])

  useEffect(() => {
    if (!slug) return
    const stateGame = (location.state as { game?: Game } | null)?.game
    if (stateGame) {
      setGame(stateGame)
      return
    }
    fetch(`/api/games/${encodeURIComponent(slug)}`)
      .then(res => res.json())
      .then(data => setGame(data.game))
      .catch(() => {})
  }, [slug, location.state])

  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      fullscreenRef.current?.requestFullscreen()
    }
  }

  if (!slug) {
    navigate('/')
    return null
  }

  return (
    <div className="relative h-screen bg-gray-950 overflow-hidden">
      {!loaded && !iframeError && (
        <div className="absolute inset-0 flex items-center justify-center z-0">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      )}

      {iframeError && (
        <div className="absolute inset-0 flex items-center justify-center z-0">
          <div className="text-center">
            <p className="text-gray-400 mb-4">Failed to load game</p>
            <button
              onClick={() => navigate('/')}
              className="rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
            >
              Go back
            </button>
          </div>
        </div>
      )}

      <div ref={fullscreenRef} className="absolute inset-0 bg-black">
        <iframe
          ref={iframeRef}
          src={`/play/${encodeURIComponent(slug)}/`}
          className="h-full w-full border-0"
          title={slug}
          allow="autoplay"
          onLoad={() => { setLoaded(true); iframeRef.current?.focus() }}
          onError={() => setIframeError(true)}
        />
      </div>

      <header className="absolute left-0 right-0 top-0 z-10 flex items-center justify-between px-12 py-2.5 pointer-events-none">
        <div className="pointer-events-auto">
          <button
            onClick={handleBack}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
            Renplay
          </button>
        </div>

        <div className="pointer-events-auto flex items-center gap-2">
          {game?.walkthrough && (
            <a
              href={`/api/walkthroughs/${game.walkthrough}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 rounded-md border border-gray-700/30 bg-gray-800/50 px-1.5 py-0.5 text-xs text-gray-500 hover:border-indigo-500/30 hover:text-indigo-400 transition-all flex-shrink-0"
              title="Walkthrough"
            >
              <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
              </svg>
              Walkthrough
            </a>
          )}
          <button
            onClick={toggleFullscreen}
            className="flex items-center gap-1 rounded-md border border-gray-700/30 bg-gray-800/50 px-1.5 py-0.5 text-xs text-gray-500 hover:border-indigo-500/30 hover:text-indigo-400 transition-all flex-shrink-0"
            title="Fullscreen"
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
            </svg>
            Fullscreen
          </button>
        </div>
      </header>
    </div>
  )
}
