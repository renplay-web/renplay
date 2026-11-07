import type { AdultLevel } from './adult'
import { deviceLevel } from './device'
export type GameState = 'ongoing' | 'completed' | 'on-hold' | 'abandoned'
export type Vocabulary = Record<string, { label: string; group: 'play' | 'story' | 'art' | 'protagonist' | 'content' }>

/** A catalog source and what it gave the person asking. */
export interface CatalogSource {
  kind: 'catalog' | 'folder'
  location: string
  recipes: number
  pictures: number
  problems: string[]
}

export interface CatalogResponse {
  status: { fetchedAt: number; urls: string[]; errors: string[]; count: number; sources?: CatalogSource[] }
  vocabulary: Vocabulary
  games: Recipe[]
}

export interface JobsResponse {
  jobs: Job[]
  busy: boolean
  total: number
}

export type ArtKind = 'grid' | 'wide' | 'hero' | 'logo' | 'icon'
/** Where a picture came from: a SteamGridDB author, a store, Renplay, the developer or an upload. */
export type ArtCredit = { by: string; byUrl?: string; asset?: string } | { store: 'Steam' | 'itch.io' } | { renplay: true } | { developer: true } | { upload: true }
/**
 * One format, made by the server. Below Shown an adult game's formats carry only `thumbhash` and
 * `tint`: no address. A format not made yet has its source's hash and no address for a moment.
 */
export interface ArtFormat {
  url1x?: string | null
  url2x?: string | null
  width?: number
  height?: number
  thumbhash: string | null
  tint: string | null
  /** How it was made: null for real art in the shape. */
  made?: null | 'crop' | 'composed' | 'glow' | 'whole'
  source?: string
  credit?: ArtCredit
  /** A dark logo, inverted on ink. */
  dark?: boolean
}
export type ArtSet = Partial<Record<ArtKind, ArtFormat>>

export interface Game {
  id: string
  title: string
  developer: string | null
  tags: string[]
  tagIds: string[]
  content: string[]
  state: GameState | null
  summary: string | null
  /** The five formats, made by the server from the catalog's pictures and people's choices. */
  art: ArtSet
  /** An adult game, per its recipe. */
  nsfw: boolean
  walkthrough: string | null
  /** Walkthrough files, in order: PDFs, pictures and plain text. */
  walkthroughs: Array<{ file: string; title: string; kind: 'pdf' | 'image' | 'text'; size: number; addedAt: string; url: string }>
  status: 'installed' | 'not_installed' | 'installing'
  build: string | null
  playUrl: string | null
  /** What made the game: renpy, or another engine (docs.renplay.org/engines). */
  family: string
  /** What made it, for other engines: "HTML (SugarCube 2.36.1)". */
  engineLabel: string | null
  version: string | null
  detectedVersion: string | null
  favoriteAt: string | null
  finishedAt: string | null
  playTime: number
  /** The person's status. Stalled, Dropped and Finished leave Up next. */
  playStatus: 'playing' | 'stalled' | 'dropped' | 'finished' | null
  /** The person's rating, 1 to 5. */
  rating: number | null
  /** Not now: out of Up next until it is played again. */
  notNowAt: string | null
  /** How it plays on a phone, curated in the recipe. */
  phone: 'great' | 'playable' | 'desktop' | null
  latestSave: Pick<SaveSlot, 'file' | 'label' | 'name' | 'ctime' | 'runtime' | 'screenshot' | 'screenshotHash'> | null
  free?: boolean
  renpyVersion: string | null
  engine: string | null
  sizeBytes: number
  fileCount: number
  screen: [number, number] | null
  saveDir: string | null
  source: { archive: string | null; size: number | null }
  canReinstall: boolean
  recipe: { id: string; links: Record<string, string>; continuesFrom: string[]; status: string | null } | null
  /** A newer working release listed in the catalog. */
  update: { version: string; date: string | null; status: string; archives?: string[] } | null
  createdAt: string
  installedAt: string | null
  lastPlayedAt: string | null
  saves: { count: number; latest: number }
  mods: { files: number; hash: string; applied: boolean }
  job: { id: string; type: string; status: string; stage: string; progress: number } | null
}

export interface SaveSlot {
  file: string
  size: number
  mtime: number
  kind: 'manual' | 'auto' | 'quick' | 'internal'
  label: string
  page?: string
  slot?: string
  name: string
  ctime: number
  renpyVersion?: string
  gameVersion?: string
  runtime?: number
  screenshot: string | null
  /** At the Blurred level, the picture as a thumbhash instead. */
  screenshotHash?: string | null
  valid: boolean
  /** This person's own name for the save, over the game's. */
  title: string | null
  note: string | null
  /** Pinned: the save keeps every previous version. */
  pinnedAt: string | null
}

export interface SavesResponse {
  saveDir: string | null
  slots: SaveSlot[]
  other: Array<{ name: string; size: number; mtime: number }>
  /** Second versions the conflict rule kept in History during the last two weeks, newest first. */
  conflicts?: Array<{ id: string; file: string; at: number }>
  /** Sync codes are on and this is a Ren'Py game. */
  sync?: boolean
}

export interface Job {
  id: string
  type: string
  game: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  stage: string
  progress: number
  message: string
  error: string | null
  /** `by`: who started it, for installs since 4.0.2. */
  params: { source?: { kind: string; path?: string }; game?: string; path?: string; by?: number } | null
  result: any
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface ArchiveInfo {
  type: string
  layout: 'project' | 'web' | null
  title?: string
  version?: string
  saveDir?: string
  renpyVersion?: string
  files: number
  engine?: EngineInfo
  v?: number
}

/** What made a game; Renplay installs Ren'Py games and, step by step, some others. */
export interface EngineInfo {
  family: string
  kind?: string
  version?: string
  label: string
  title?: string
  installable: boolean
  reason?: string
  warnings: string[]
}

export interface Archive {
  path: string
  name: string
  size: number
  mtime: number
  sha256: string | null
  info: ArchiveInfo | null
  installedAs: string | null
  recipe: { id: string; title: string; version: string | null; status: string; exact: boolean; art: ArtSet; nsfw: boolean } | null
  existingGame: string | null
  /** Why this download cannot be installed here (an adult game on a safe-for-work install). */
  blocked: string | null
}

/** The installation's adult level, fixed when the server's variable sets it. Admins also get the starting level and the sign-in groups. */
export interface ContentState {
  installation: { level: AdultLevel; fixed: boolean; chosen: boolean; variable: string }
  starting?: { level: AdultLevel; variable: string }
  groups?: {
    oidc: { variable: string; map: Record<string, AdultLevel> } | null
    ldap: { variable: string; map: Record<string, AdultLevel> | null } | null
  }
}

export interface RecipeRelease {
  version: string
  date?: string
  madeWith?: string
  runtime?: string
  status: 'verified' | 'playable' | 'broken' | 'untested'
  archives: Array<{ name: string; size?: number; sha256?: string }>
  verified?: { date?: string; renplay?: string; browsers?: string[]; notes?: string }
}

export interface Recipe {
  id: string
  title: string
  developer?: string
  tags?: string[]
  tagIds?: string[]
  content?: string[]
  state?: GameState
  summary?: string
  nsfw?: boolean
  free?: boolean
  art?: ArtSet
  links?: Record<string, string>
  saveDir?: string
  continuesFrom?: string[]
  engine?: string
  releases: RecipeRelease[]
  local: { id: string; status: string; version: string; detectedVersion: string } | null
  /** From the recipes folder on this server, not the catalog. */
  fromYourRecipes?: boolean
}

export interface SystemInfo {
  version: string
  /** Ren'Py Sync codes: off until an admin turns them on. */
  sync?: { on: boolean; server: string; chosen?: boolean }
  /** For each variable Settings shows: set on the server, or the default. */
  setBy?: Record<string, 'server' | 'default'>
  /** An admin chose whether downloads are kept (else the default). */
  keepDownloadsChosen?: boolean
  engines: {
    installed: Array<{ version: string; bytes: number; usedBy: string[] }>
    available: Array<{ version: string; renpy: string; bytes: number }>
    index: string
  }
  disk: { games: { total: number; free: number } | null; data: { total: number; free: number } | null }
  library: { games: number; installed: number; bytes: number }
  orphans: string[]
  purging: number
  paths: { games: string; archives: string; data: string }
  keepDownloads: boolean
  keepDownloadsLocked: boolean
  busy: boolean
}

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'dir'
  size?: number
  count?: number
  changed?: boolean
  state?: 'base' | 'added' | 'modified' | 'deleted'
  text?: boolean
}

export interface FilesResponse {
  dir: string
  dirs: FileEntry[]
  files: FileEntry[]
  mods: { files: number; deleted: number; hash: string; applied: boolean; job: boolean }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  // This device's adult games level: the server applies it to everything it answers. It can only narrow.
  const device = deviceLevel()
  const res = await fetch(path, {
    ...rest,
    headers: { ...(device ? { 'x-renplay-adult': device } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}), ...(rest.headers as Record<string, string> | undefined ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/api/auth/') && path !== '/api/me') window.dispatchEvent(new Event('renplay:signed-out'))
    let msg = `${res.status} ${res.statusText}`
    try {
      const j = await res.json()
      if (j?.error) msg = j.error
    } catch {}
    throw new ApiError(res.status, msg)
  }
  const ct = res.headers.get('content-type') ?? ''
  return (ct.includes('application/json') ? res.json() : res.text()) as Promise<T>
}

export const post = <T,>(path: string, json?: unknown) => api<T>(path, { method: 'POST', json: json ?? {} })
export const put = <T,>(path: string, json?: unknown) => api<T>(path, { method: 'PUT', json: json ?? {} })
export const del = <T,>(path: string) => api<T>(path, { method: 'DELETE' })


export function slotName(file: string): string {
  return file.replace(/-LT\d+\.save$/, '').replace(/\.save$/, '')
}

export function jobTitle(j: Job, games: Game[]): string {
  const game = games.find((g) => g.id === j.game)
  const name = j.params?.source?.path?.split('/').pop() ?? j.params?.path?.split('/').pop() ?? game?.source.archive?.split('/').pop() ?? game?.title ?? j.game
  switch (j.type) {
    case 'import':
      if (j.status === 'done') return `Installed ${name || 'game'}`
      return game && game.status === 'installed' ? `Updating ${name}` : `Installing ${name || 'game'}`
    case 'apply-mods':
      return `${j.status === 'done' ? 'Applied' : 'Applying'} mods to ${name}`
    case 'hash-archive':
      return `${j.status === 'done' ? 'Checked' : 'Checking'} ${name}`
    default:
      return j.type
  }
}
