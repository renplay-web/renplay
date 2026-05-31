import type { Game } from '../types'

interface Props {
  game: Game
}

function thumbnailUrl(game: Game): string {
  if (game.thumbnail) {
    return `/api/thumbnails/${game.thumbnail}`
  }
  return `/play/${game.slug}/web-presplash.jpg`
}

export default function GameCard({ game }: Props) {
  const playUrl = `/play/${game.slug}`

  return (
    <a
      href={playUrl}
      className="group relative flex flex-col overflow-hidden rounded-xl bg-gray-800/60 backdrop-blur-sm border border-gray-700/50 transition-all duration-300 hover:scale-[1.03] hover:shadow-xl hover:shadow-indigo-500/10 hover:border-indigo-500/40"
    >
      <div className="aspect-[16/9] overflow-hidden bg-gray-900">
        <img
          src={thumbnailUrl(game)}
          alt={game.title}
          className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
          loading="lazy"
          onError={(e) => {
            (e.target as HTMLImageElement).style.display = 'none'
            const parent = (e.target as HTMLImageElement).parentElement!
            const fallback = document.createElement('div')
            fallback.className = 'flex h-full items-center justify-center text-5xl text-gray-600'
            fallback.textContent = '🎮'
            parent.appendChild(fallback)
          }}
        />
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <h3 className="text-lg font-semibold leading-tight text-white group-hover:text-indigo-300 transition-colors">
          {game.title}
        </h3>

        {game.tags && game.tags.length > 0 && (
          <div className="mt-auto flex flex-wrap gap-1.5 pt-2">
            {game.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-indigo-500/10 px-2.5 py-0.5 text-xs font-medium text-indigo-300 border border-indigo-500/20"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="absolute inset-0 rounded-xl ring-1 ring-inset ring-white/0 group-hover:ring-indigo-400/20 transition-all pointer-events-none" />
    </a>
  )
}
