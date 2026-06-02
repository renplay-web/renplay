import { useState, useMemo } from 'react'
import { useGames } from './hooks/useGames'
import GameCard from './components/GameCard'
import SearchBar from './components/SearchBar'
import AdminModal from './components/AdminModal'

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

  return (
    <div className="mx-auto min-h-screen max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-10 flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-white">
            Renplay
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            {games.length} game{games.length !== 1 ? 's' : ''} available
          </p>
        </div>

        <div className="flex items-center gap-4">
          <SearchBar value={search} onChange={setSearch} />
          <button
            onClick={() => setAdminOpen(true)}
            className="rounded-xl border border-gray-700/50 bg-gray-800/60 p-2.5 text-gray-400 hover:border-indigo-500/40 hover:text-indigo-300 transition-all backdrop-blur-sm"
            aria-label="Manage games"
            title="Manage games"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>
        </div>
      </header>

      {loading && (
        <div className="flex items-center justify-center py-32">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent" />
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-800/50 bg-red-900/20 px-6 py-4 text-center text-red-400">
          {error}
        </div>
      )}

      {!loading && !error && (
        <>
          {allTags.length > 0 && (
            <div className="mb-6 flex flex-wrap gap-2">
              <button
                onClick={() => setSelectedTag(null)}
                className={`rounded-full px-3 py-1 text-xs font-medium border transition-all ${
                  selectedTag === null
                    ? 'bg-indigo-600 text-white border-indigo-500'
                    : 'bg-gray-800/60 text-gray-400 border-gray-700/50 hover:border-gray-500'
                }`}
                aria-pressed={selectedTag === null}
              >
                All
              </button>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  onClick={() => setSelectedTag(tag === selectedTag ? null : tag)}
                  className={`rounded-full px-3 py-1 text-xs font-medium border transition-all ${
                    tag === selectedTag
                      ? 'bg-indigo-600 text-white border-indigo-500'
                      : 'bg-gray-800/60 text-gray-400 border-gray-700/50 hover:border-gray-500'
                  }`}
                  aria-pressed={tag === selectedTag}
                >
                  {tag}
                </button>
              ))}
            </div>
          )}

          {filtered.length === 0 ? (
            <div className="py-32 text-center">
              <p className="text-gray-500">
                {search || selectedTag
                  ? 'No games match your filters.'
                  : 'No games found.'}
              </p>
              {!search && !selectedTag && (
                <button
                  onClick={() => setAdminOpen(true)}
                  className="mt-4 rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 transition-colors"
                >
                  Manage games
                </button>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {filtered.map((game) => (
                <GameCard key={game.slug} game={game} />
              ))}
            </div>
          )}
        </>
      )}
      <AdminModal
        open={adminOpen}
        onClose={() => setAdminOpen(false)}
        games={games}
        onChanged={reload}
      />
    </div>
  )
}
