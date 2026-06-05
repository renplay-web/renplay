import { useState, useMemo } from 'react'
import { useGames } from './hooks/useGames'
import GameCard from './components/GameCard'
import SearchBar from './components/SearchBar'
import AdminModal from './components/AdminModal'

function SkeletonCard() {
  return (
    <div className="flex flex-col overflow-hidden rounded-md bg-gray-900 border border-white/[0.06]">
      <div className="aspect-[460/215] bg-gray-800 animate-pulse" />
      <div className="px-3 pt-2.5 pb-3 flex flex-col gap-2">
        <div className="h-3 w-3/4 rounded-sm bg-gray-800 animate-pulse" />
        <div className="h-2.5 w-1/3 rounded-sm bg-gray-800/70 animate-pulse" />
      </div>
    </div>
  )
}

export default function App() {
  const { games, loading, error, reload } = useGames()
  const [search, setSearch] = useState('')
  const [selectedTag, setSelectedTag] = useState<string | null>(null)
  const [adminOpen, setAdminOpen] = useState(false)

  const allTags = useMemo(() => {
    const tags = new Set<string>()
    games.forEach((g) => g.tags?.forEach((t) => tags.add(t)))
    return Array.from(tags).sort()
  }, [games])

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim()
    return games.filter((g) => {
      if (q && !g.title.toLowerCase().includes(q)) return false
      if (selectedTag && !g.tags?.includes(selectedTag)) return false
      return true
    })
  }, [games, search, selectedTag])

  const isFiltered = !!(search || selectedTag)

  return (
    <div className="min-h-screen bg-gray-950">

      {/* Sticky header */}
      <header className="sticky top-0 z-20 border-b border-white/[0.04] bg-gray-950/90 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-12 items-center gap-4">
            <span className="flex-shrink-0 text-[15px] font-bold tracking-tight text-white select-none">
              renplay
            </span>

            <div className="flex-1 min-w-0 max-w-xs">
              <SearchBar value={search} onChange={setSearch} />
            </div>

            <div className="ml-auto flex items-center gap-3 flex-shrink-0">
              {!loading && games.length > 0 && (
                <span className="hidden sm:block text-xs tabular-nums text-gray-600">
                  {isFiltered ? `${filtered.length} / ${games.length}` : `${games.length}`}
                </span>
              )}
              <button
                onClick={() => setAdminOpen(true)}
                className="rounded-md p-1.5 text-gray-600 hover:bg-white/[0.06] hover:text-gray-300 transition-colors"
                aria-label="Manage games"
                title="Manage games"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-5">

        {/* Tag filter row */}
        {!loading && allTags.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-5">
            <button
              onClick={() => setSelectedTag(null)}
              aria-pressed={selectedTag === null}
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-all ${
                selectedTag === null
                  ? 'bg-indigo-500/15 text-indigo-400 ring-1 ring-inset ring-indigo-500/25'
                  : 'bg-white/[0.04] text-gray-500 hover:bg-white/[0.07] hover:text-gray-300'
              }`}
            >
              All
            </button>
            {allTags.map(tag => (
              <button
                key={tag}
                onClick={() => setSelectedTag(tag === selectedTag ? null : tag)}
                aria-pressed={tag === selectedTag}
                className={`rounded-full px-2.5 py-1 text-[11px] font-medium transition-all ${
                  tag === selectedTag
                    ? 'bg-indigo-500/15 text-indigo-400 ring-1 ring-inset ring-indigo-500/25'
                    : 'bg-white/[0.04] text-gray-500 hover:bg-white/[0.07] hover:text-gray-300'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-md border border-red-800/40 bg-red-950/30 px-5 py-4 text-center text-sm text-red-400">
            {error}
          </div>
        )}

        {/* Skeleton loading */}
        {loading && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
          </div>
        )}

        {/* Empty state */}
        {!loading && !error && filtered.length === 0 && (
          <div className="flex flex-col items-center py-24 gap-3">
            <p className="text-sm text-gray-600">
              {isFiltered ? 'No games match your filters.' : 'No games yet.'}
            </p>
            {!isFiltered && (
              <button
                onClick={() => setAdminOpen(true)}
                className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
              >
                Add games
              </button>
            )}
          </div>
        )}

        {/* Game grid */}
        {!loading && !error && filtered.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filtered.map(game => (
              <GameCard key={game.slug} game={game} />
            ))}
          </div>
        )}

      </main>

      <AdminModal
        open={adminOpen}
        onClose={() => setAdminOpen(false)}
        games={games}
        onChanged={reload}
      />
    </div>
  )
}
