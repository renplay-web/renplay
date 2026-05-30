import { useState, useCallback } from 'react'
import type { Game } from '../types'

export interface GameFormData {
  slug: string
  title: string
  author: string
  description: string
  tags: string
}

export function formToGame(f: GameFormData): Partial<Game> {
  return {
    slug: f.slug.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_'),
    title: f.title.trim(),
    author: f.author.trim() || undefined,
    description: f.description.trim() || undefined,
    tags: f.tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
  }
}

export function gameToForm(g: Game): GameFormData {
  return {
    slug: g.slug,
    title: g.title,
    author: g.author || '',
    description: g.description || '',
    tags: (g.tags || []).join(', '),
  }
}

const emptyForm: GameFormData = {
  slug: '',
  title: '',
  author: '',
  description: '',
  tags: '',
}

export function useAdmin() {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clearError = useCallback(() => setError(null), [])

  const create = useCallback(async (form: GameFormData): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const data = formToGame(form)
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Failed to create (${res.status})`)
      }
      return true
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const update = useCallback(async (slug: string, form: GameFormData): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const data = formToGame(form)
      delete (data as any).slug
      const res = await fetch(`/api/games/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Failed to update (${res.status})`)
      }
      return true
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const remove = useCallback(async (slug: string): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/games/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Failed to delete (${res.status})`)
      }
      return true
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  return { create, update, remove, saving, error, clearError, emptyForm, gameToForm }
}
