interface Props {
  value: string
  onChange: (value: string) => void
}

export default function SearchBar({ value, onChange }: Props) {
  return (
    <div className="relative w-full max-w-md">
      <svg
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      <label htmlFor="game-search" className="sr-only">Search games</label>
      <input
        id="game-search"
        type="text"
        placeholder="Search games..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-xl border border-gray-700/50 bg-gray-800/60 py-3 pl-10 pr-4 text-sm text-white placeholder-gray-500 backdrop-blur-sm focus:border-indigo-500/50 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 transition-all"
      />
    </div>
  )
}
