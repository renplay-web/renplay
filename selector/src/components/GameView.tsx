import { useRef, useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'

export default function GameView() {
  const { slug } = useParams<{ slug: string }>()
  const navigate = useNavigate()
  const [loaded, setLoaded] = useState(false)
  const [iframeError, setIframeError] = useState(false)
  const fullscreenRef = useRef<HTMLDivElement>(null)

  const handleBack = useCallback(() => {
    const iframe = fullscreenRef.current?.querySelector('iframe')
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage({ type: 'renplay-save-now' }, '*')
    }
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
          src={`/play/${encodeURIComponent(slug)}/`}
          className="h-full w-full border-0"
          title={slug}
          allow="autoplay"
          onLoad={() => setLoaded(true)}
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

        <button
          onClick={toggleFullscreen}
          className="pointer-events-auto flex items-center gap-1 rounded-md border border-gray-700/30 bg-gray-800/50 px-1.5 py-0.5 text-xs text-gray-500 hover:border-indigo-500/30 hover:text-indigo-400 transition-all flex-shrink-0"
          title="Fullscreen"
        >
          <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
          Fullscreen
        </button>
      </header>
    </div>
  )
}
