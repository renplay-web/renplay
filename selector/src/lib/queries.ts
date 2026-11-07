import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { useAuth } from './auth'
import type { AdultLevel } from './adult'
import { api, put, type CatalogResponse, type ContentState, type Archive, type FilesResponse, type Game, type Job, type SavesResponse, type SystemInfo } from './api'

export function useGames() {
  // The server leaves out what the person's level and this device's hide.
  return useQuery({
    queryKey: ['games'],
    queryFn: () => api<{ games: Game[] }>('/api/games').then((r) => r.games),
    refetchInterval: (q) => (q.state.data?.some((g) => g.job) ? 2000 : false),
  })
}

export function useGame(id: string | undefined) {
  return useQuery({
    queryKey: ['game', id],
    queryFn: () => api<{ game: Game }>(`/api/games/${id}`).then((r) => r.game),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.job ? 2000 : false),
  })
}

export function useSaves(id: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['saves', id],
    queryFn: () => api<SavesResponse>(`/api/saves/${id}`),
    enabled: !!id && enabled,
  })
}

export function useJobs() {
  const admin = useAuth().data?.user.role === 'admin'
  const qc = useQueryClient()
  const q = useQuery({
    queryKey: ['jobs'],
    enabled: admin,
    queryFn: () => api<{ jobs: Job[]; busy: boolean }>('/api/jobs?limit=40'),
    refetchInterval: (q) => (q.state.data?.jobs.some((j) => j.status === 'running' || j.status === 'queued') ? 1500 : 15000),
  })
  // Refresh game data when a job finishes.
  const active = useRef<Set<string>>(new Set())
  useEffect(() => {
    const now = new Set((q.data?.jobs ?? []).filter((j) => j.status === 'running' || j.status === 'queued').map((j) => j.id))
    let finished = false
    for (const id of active.current) if (!now.has(id)) finished = true
    active.current = now
    if (finished) {
      void qc.invalidateQueries({ queryKey: ['games'] })
      void qc.invalidateQueries({ queryKey: ['game'] })
      void qc.invalidateQueries({ queryKey: ['archives'] })
      void qc.invalidateQueries({ queryKey: ['files'] })
      void qc.invalidateQueries({ queryKey: ['system'] })
    }
  }, [q.data, qc])
  return q
}

export function useArchives() {
  return useQuery({
    queryKey: ['archives'],
    queryFn: () => api<{ dir: string; archives: Archive[] }>('/api/archives'),
  })
}

export function useCatalog() {
  return useQuery({
    queryKey: ['catalog'],
    queryFn: () => api<CatalogResponse>('/api/catalog'),
  })
}

export function useContent() {
  return useQuery({ queryKey: ['content'], queryFn: () => api<ContentState>('/api/content') })
}

/** Saves the installation's adult level, then reloads everything that depends on it. */
export function useSetInstallationLevel() {
  const qc = useQueryClient()
  return async (level: AdultLevel) => {
    await put('/api/content', { level })
    await qc.invalidateQueries()
  }
}

export function useSystem() {
  const admin = useAuth().data?.user.role === 'admin'
  return useQuery({ enabled: admin, queryKey: ['system'], queryFn: () => api<SystemInfo>('/api/system') })
}

export function useFiles(id: string, dir: string) {
  return useQuery({
    queryKey: ['files', id, dir],
    queryFn: () => api<FilesResponse>(`/api/games/${id}/files?dir=${encodeURIComponent(dir)}`),
  })
}

/** Defaults for everyone, set by an admin: what a person starts with until they choose. */
export interface Defaults {
  tagsExclude: string[]
  lighterBackground: boolean | null
  textSize: number | null
  rollback: boolean | null
  skip: boolean | null
}
export function useDefaults() {
  return useQuery({ queryKey: ['defaults'], queryFn: () => api<Defaults>('/api/defaults'), staleTime: 5 * 60_000, retry: false })
}
