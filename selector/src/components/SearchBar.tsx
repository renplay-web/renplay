interface Props {
  value: string
  onChange: (value: string) => void
}

export default function SearchBar({ value, onChange }: Props) {
  return (
    <div className="relative">
      <svg
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-600"
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
        placeholder="Search…"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-white/[0.08] bg-white/[0.04] py-1.5 pl-8 pr-3 text-sm text-gray-200 placeholder-gray-600 focus:border-indigo-500/40 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-indigo-500/20 transition-all"
      />
    </div>
  )
}
