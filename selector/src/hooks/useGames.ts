import { useState, useEffect, useCallback } from 'react'
import type { Game } from '../types'

export function useGames() {
  const [games, setGames] = useState<Game[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/games')
      if (!r.ok) throw new Error(`Failed to load games (${r.status})`)
      const data = await r.json()
      setGames(data.games ?? [])
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return { games, loading, error, reload: load }
}
