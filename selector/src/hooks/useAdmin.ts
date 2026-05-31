import { useState, useCallback } from 'react'
import type { Game } from '../types'

export interface EditFormData {
  title: string
  tags: string
}

export function gameToForm(g: Game): EditFormData {
  return {
    title: g.title,
    tags: (g.tags || []).join(', '),
  }
}

export function useAdmin() {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clearError = useCallback(() => setError(null), [])

  const update = useCallback(async (slug: string, form: EditFormData): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const body: Record<string, unknown> = {}
      if (form.title.trim()) body.title = form.title.trim()
      body.tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean)

      const res = await fetch(`/api/games/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Failed to update (${res.status})`)
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
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Failed to delete (${res.status})`)
      }
      return true
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const reorder = useCallback(async (slugs: string[]): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/v1/games/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slugs }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Reorder failed (${res.status})`)
      }
      return true
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const scan = useCallback(async (): Promise<{ created: string[] } | null> => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/v1/scan-library', { method: 'POST' })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Scan failed (${res.status})`)
      }
      return await res.json()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      return null
    } finally {
      setSaving(false)
    }
  }, [])

  const uploadThumbnail = useCallback(async (slug: string, file: File): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('thumbnail', file)
      const res = await fetch(`/api/v1/games/${encodeURIComponent(slug)}/thumbnail`, {
        method: 'POST',
        body: fd,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Upload failed (${res.status})`)
      }
      return true
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  const removeThumbnail = useCallback(async (slug: string): Promise<boolean> => {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/v1/games/${encodeURIComponent(slug)}/thumbnail`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error || `Remove failed (${res.status})`)
      }
      return true
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      return false
    } finally {
      setSaving(false)
    }
  }, [])

  return { update, remove, reorder, scan, uploadThumbnail, removeThumbnail, saving, error, clearError, gameToForm }
}
