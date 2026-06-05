import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Game } from '../types'
import { PRESPLASH_EXTS } from '../constants'

interface Props {
  game: Game
}

export default function GameCard({ game }: Props) {
  const [extIdx, setExtIdx] = useState(0)
  const [imgFailed, setImgFailed] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(false)

  const src = game.thumbnail
    ? `/api/thumbnails/${game.thumbnail}`
    : `/play/${game.slug}/web-presplash.${PRESPLASH_EXTS[extIdx]}`

  const handleError = () => {
    if (!game.thumbnail && extIdx < PRESPLASH_EXTS.length - 1) {
      setExtIdx(i => i + 1)
    } else {
      setImgFailed(true)
    }
  }

  const tags = game.tags ?? []

  return (
    <Link
      to={`/play/${game.slug}`}
      state={{ game }}
      className="group flex flex-col overflow-hidden rounded-md bg-gray-900 border border-white/[0.06] hover:border-white/[0.16] transition-all duration-200 hover:-translate-y-px hover:shadow-xl hover:shadow-black/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-950"
    >
      {/* 460×215 banner */}
      <div className="relative aspect-[460/215] overflow-hidden bg-gray-800">
        {/* Shimmer shown while image loads */}
        {!imgLoaded && !imgFailed && (
          <div className="absolute inset-0 bg-gradient-to-r from-gray-800 via-gray-750/60 to-gray-800 animate-pulse" />
        )}

        {imgFailed ? (
          <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-gray-800 to-gray-900">
            <svg className="h-8 w-8 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z" />
            </svg>
          </div>
        ) : (
          <img
            key={game.thumbnail ? 'custom' : extIdx}
            src={src}
            alt={game.title}
            className={`absolute inset-0 w-full h-full object-cover transition-all duration-500 group-hover:scale-[1.04] ${imgLoaded ? 'opacity-100' : 'opacity-0'}`}
            loading="lazy"
            onLoad={() => setImgLoaded(true)}
            onError={handleError}
          />
        )}

        {/* Hover overlay — subtle darkening + play hint */}
        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors duration-300" />
      </div>

      {/* Info strip */}
      <div className="px-3 pt-2.5 pb-3 flex flex-col gap-1.5">
        <p className="text-[13px] font-semibold leading-snug text-gray-100 group-hover:text-white transition-colors line-clamp-1">
          {game.title}
        </p>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {tags.slice(0, 3).map(tag => (
              <span
                key={tag}
                className="text-[10px] leading-none px-1.5 py-[3px] rounded-sm bg-white/[0.05] text-gray-500"
              >
                {tag}
              </span>
            ))}
            {tags.length > 3 && (
              <span className="text-[10px] leading-none px-1 py-[3px] text-gray-600">
                +{tags.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
    </Link>
  )
}
