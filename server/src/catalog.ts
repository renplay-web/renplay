import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { viewer } from './accounts-context.js'
import { catalogPictures, type ArtSet, type ArtStore, type ArtSubject, type CatalogImage } from './art.js'
import type { Config } from './config.js'
import { ContentMode, parseAdultLevel, sfwIndexUrl } from './content.js'
import { parseJson, type Db, type GameRow, type GameSource, type JobRow } from './db.js'
import type { JobContext } from './jobs.js'
import { cleanRelPath } from './util/paths.js'
import { log } from './util/log.js'
import { catalogHosts, fetchPublic } from './util/net.js'
import { readLocalFile, readLocalRecipes } from './recipes-local.js'

export interface RecipeArchive {
  name: string
  size?: number
  sha256?: string
  platform?: string
}

export type RecipeStatus = 'verified' | 'playable' | 'broken' | 'untested'

export interface RecipeRelease {
  version: string
  date?: string
  /** Version of the engine the game was made with (Ren'Py 8.2.1, Godot 4.6.2). */
  madeWith?: string
  /** Web runtime to build this release with (overrides the recipe's). */
  runtime?: string
  status: RecipeStatus
  archives: RecipeArchive[]
  verified?: { date?: string; renplay?: string; browsers?: string[]; notes?: string }
}

export interface RecipePatch {
  /** Destination inside the game, e.g. "game/zz_renplay_fix.rpy". */
  path: string
  /** URL relative to the catalog index, or absolute. */
  url: string
  sha256: string
}

export type GameState = 'ongoing' | 'completed' | 'on-hold' | 'abandoned'
export type Vocabulary = Record<string, { label: string; group: 'play' | 'story' | 'art' | 'protagonist' | 'content' }>

/** Archive names identify releases even when the game's internal version is unrelated. */
export function installedRelease(recipe: Recipe, version: string, archive?: string): RecipeRelease | null {
  const name = archive?.split('/').pop()
  return (name ? recipe.releases.find((r) => r.archives?.some((a) => a.name === name)) : undefined)
    ?? recipe.releases.find((r) => r.version === version) ?? null
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
  /** The game's pictures in SteamGridDB's formats (schema 4). A schema 3 cover becomes one grid. */
  art?: CatalogImage[]
  /** How the game plays on a phone, curated: great, playable, or desktop (needs a bigger screen). */
  phone?: 'great' | 'playable' | 'desktop'
  links?: Record<string, string>
  saveDir?: string
  /** Games whose saves this one imports (an earlier season, a prequel). */
  continuesFrom?: string[]
  /** Archive name patterns (with *) that belong to this game, for releases not listed yet. */
  match?: string[]
  /** What made the game. Ren'Py is what Renplay is for (docs.renplay.org/engines). */
  engine: 'renpy' | 'html' | 'godot' | 'unity'
  /** Web runtime to build with, from renplay-org/engines; default the newest that fits. */
  runtime?: string
  build?: {
    optimizeImages?: boolean
    imageQuality?: number
    /** Files (globs relative to game/) that go into game.zip instead of streaming. */
    keep?: string[]
    /** Files (globs relative to game/) left out of the build entirely. */
    exclude?: string[]
    patches?: RecipePatch[]
  }
  releases: RecipeRelease[]
  /** Index URL the recipe came from (for relative URLs). */
  _base?: string
  /** Its source: the configured catalog address, or 'local' for Your recipes. */
  _origin?: string
}

export interface BuildSettings {
  engine?: string
  quality?: number
  optimize?: boolean
  keep?: string[]
  exclude?: string[]
}

export interface RecipeMatch {
  recipe: Recipe
  /** The listed release, or null for a newer, unlisted version matched by pattern. */
  release: RecipeRelease | null
  /** sha256, or name and size, match a listed archive. */
  exact: boolean
}

const CACHE_KEY = 'catalog_cache'
/** Where Renplay 3.x kept its covers. 4.0 makes its pictures in the art cache and forgets these. */
const COVERS_KEY = 'catalog_covers'
/** What blocking needs to know about adult recipes: ids, archives and save folders, never titles, tags or covers. */
const STUBS_KEY = 'catalog_adult_stubs'
/** How often the catalog is fetched while Renplay runs (cheap: pictures are fetched only once). */
const REFRESH_EVERY = 3600_000

function globMatch(pattern: string, name: string): boolean {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i')
  return re.test(name)
}

function valid(g: any): g is Recipe {
  return g && typeof g.id === 'string' && typeof g.title === 'string' && Array.isArray(g.releases)
}

/**
 * Recipes in catalog schema 4 names. Schema 2 (and caches written by Renplay
 * 2.5 and older) called the runtime `engine` and a release's madeWith and
 * runtime `renpy` and `engine`; all of those were Ren'Py games. Schema 3 had
 * one `cover` instead of the `art` list: it becomes a grid, placed by the
 * making order like any picture of another shape.
 */
export function normalizeRecipe(g: any): Recipe {
  const old = typeof g.engine !== 'string' || /^\d/.test(g.engine)
  const { renpy: _r, engine: _e, cover, coverSfw: _s, ...rest } = g
  const fromCover = (): CatalogImage[] | undefined => {
    const c = typeof cover === 'string' ? { url: cover } : cover && typeof cover === 'object' && typeof cover.url === 'string' ? cover : null
    if (!c) return undefined
    return [{ kind: 'grid', url: c.url, source: 'developer', sha256: c.sha256, width: c.width, height: c.height, default: true }]
  }
  return {
    ...rest,
    art: Array.isArray(g.art) ? g.art : fromCover(),
    engine: old ? 'renpy' : g.engine,
    runtime: g.runtime ?? (old ? g.engine : undefined),
    releases: g.releases.map(({ renpy, engine, ...r }: any) => ({ ...r, madeWith: r.madeWith ?? renpy, runtime: r.runtime ?? engine })),
  }
}

/** A catalog's recipe never names files in Your recipes (`local:`): only recipes there may. */
function withoutLocalFiles(g: Recipe): Recipe {
  const remote = (x: { url?: string }) => typeof x?.url !== 'string' || !x.url.startsWith('local:')
  return {
    ...g,
    art: g.art?.filter(remote),
    build: g.build?.patches ? { ...g.build, patches: g.build.patches.filter(remote) } : g.build,
  }
}

/** An adult recipe reduced to what recognizes its archives and save folder. */
function stub(r: Recipe): Recipe {
  return {
    id: r.id,
    title: '',
    nsfw: true,
    engine: r.engine,
    saveDir: r.saveDir,
    match: r.match,
    releases: r.releases.map((x) => ({ version: x.version, status: x.status, archives: (x.archives ?? []).map(({ name, size, sha256 }) => ({ name, size, sha256 })) })),
  }
}

/** The catalog without its adult games: for an index that is not the safe-for-work one. */
function withoutAdult(games: Recipe[], vocabulary: Vocabulary): { games: Recipe[]; adult: Recipe[]; vocabulary: Vocabulary } {
  const hidden = new Set(Object.entries(vocabulary).filter(([, v]) => v.group === 'content').map(([id]) => id))
  const labels = new Set(Object.entries(vocabulary).filter(([, v]) => v.group === 'content').map(([, v]) => v.label))
  const safe = games.filter((g) => g.nsfw !== true).map((g) => ({
    ...g,
    content: [],
    tagIds: g.tagIds?.filter((t) => !hidden.has(t)),
    tags: g.tags?.filter((t) => !labels.has(t)),
  }))
  return {
    games: safe,
    adult: games.filter((g) => g.nsfw === true),
    vocabulary: Object.fromEntries(Object.entries(vocabulary).filter(([id]) => !hidden.has(id))),
  }
}

interface Index {
  schema?: number
  games?: unknown[]
  vocabulary?: Vocabulary
}

async function fetchIndex(url: string): Promise<Index> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const idx = (await res.json()) as Index
  if ((idx.schema ?? 1) < 2) throw new Error(`catalog schema ${idx.schema ?? 1} is too old`)
  return idx
}

export class Catalog {
  private recipes = new Map<string, Recipe>()
  /** Adult recipes of a blocked install, reduced by stub(): enough to refuse their archives and hide their games. */
  private adult = new Map<string, Recipe>()
  vocabulary: Vocabulary = {}
  /** The art cache, set by the app. Without it (in tests of the catalog alone) nothing is made. */
  art: ArtStore | null = null
  private fetchedAt = 0
  /** Problems of the last refresh. An error about one recipe names it, so a person who may not see that game does not see the error either. */
  private errors: Array<{ text: string; recipe?: string }> = []
  private timer: NodeJS.Timeout | null = null

  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    readonly content: ContentMode = new ContentMode(cfg, db),
  ) {
    content.adultSaveDirs = () => [...this.adult.values(), ...[...this.recipes.values()].filter((r) => r.nsfw === true)].map((r) => r.saveDir ?? '').filter(Boolean)
  }

  async init(): Promise<void> {
    const cached = this.db.getSetting<{ at: number; games: Recipe[]; vocabulary?: Vocabulary; adultGames?: string } | null>(CACHE_KEY, null)
    this.adult = new Map(Object.entries(this.db.getSetting<Record<string, Recipe>>(STUBS_KEY, {})))
    if (cached && Array.isArray(cached.games)) {
      this.load(cached.games)
      this.vocabulary = cached.vocabulary ?? {}
      // A catalog cached without its adult games is stale once they are allowed. Caches written
      // by 3.x say allow/block; 4.0 writes the installation level.
      const cachedLevel = parseAdultLevel(cached.adultGames, true) ?? 'shown'
      this.fetchedAt = cachedLevel === 'off' && this.content.level !== 'off' ? 0 : cached.at
    } else {
      try {
        const here = dirname(fileURLToPath(import.meta.url))
        const idx = JSON.parse(await readFile(join(here, '..', 'catalog.json'), 'utf-8'))
        this.load(idx.games ?? [])
        this.vocabulary = idx.vocabulary ?? {}
      } catch {}
    }
    // 3.x covers: 4.0 never serves them, the art cache replaces them.
    if (this.db.getSetting<unknown>(COVERS_KEY, null) !== null) {
      this.db.raw.prepare('DELETE FROM settings WHERE key = ?').run(COVERS_KEY)
      await rm(this.cfg.coversDir, { recursive: true, force: true }).catch(() => {})
    }
    this.syncAdult()
    if (this.content.level === 'off') await this.restrict()
    this.link()
    if (Date.now() - this.fetchedAt > REFRESH_EVERY) void this.refresh().catch(() => {})
    else void this.syncArt().catch(() => {})
    this.timer = setInterval(() => void this.refresh().catch(() => {}), REFRESH_EVERY)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private setAdult(recipes: Recipe[]): void {
    this.adult = new Map(recipes.map((r) => [r.id, r.title === '' && r.nsfw ? r : stub(r)]))
    this.db.setSetting(STUBS_KEY, Object.fromEntries(this.adult))
  }

  /**
   * Called after the admin changes the setting. Off moves adult recipes out of
   * the catalog (keeping only a stub) and fetches the safe-for-work index, and
   * the next art sync forgets their pictures. Blurred and shown fetch the full
   * index.
   */
  async modeChanged(): Promise<void> {
    if (this.content.level === 'off') {
      this.syncAdult()
      await this.restrict()
    } else {
      // The stubs stay until the full index arrives (refresh clears them), so a failed fetch never
      // leaves adult downloads unrecognized for a later switch back to off.
      this.syncAdult()
    }
    void this.refresh().catch(() => {})
  }

  /** Moves adult recipes out of the catalog, keeping a stub. */
  private async restrict(): Promise<void> {
    const gone = [...this.recipes.values()].filter((r) => r.nsfw === true)
    if (gone.length) {
      const kept = withoutAdult([...this.recipes.values()], this.vocabulary)
      this.setAdult([...this.adult.values(), ...gone])
      this.load(kept.games)
      this.vocabulary = kept.vocabulary
      this.db.setSetting(CACHE_KEY, { at: this.fetchedAt, games: kept.games, vocabulary: kept.vocabulary, adultGames: 'off' })
    } else {
      const cache = this.db.getSetting<{ at: number; games: Recipe[]; vocabulary?: Vocabulary } | null>(CACHE_KEY, null)
      if (cache) this.db.setSetting(CACHE_KEY, { ...cache, adultGames: 'off' })
    }
  }


  /** Remembers which library games have adult recipes, for when the catalog can no longer say. */
  syncAdult(): void {
    for (const g of this.db.allGames()) {
      if (!g.recipe_id) continue
      const adult = this.recipes.has(g.recipe_id) ? (this.recipes.get(g.recipe_id)!.nsfw === true ? 1 : 0) : this.adult.has(g.recipe_id) ? 1 : g.adult
      if (adult !== g.adult) this.db.updateGame(g.id, { adult })
    }
  }

  /** True when this recipe id belongs to an adult game that a blocked install does not show. */
  isAdultId(id: string): boolean {
    return this.adult.has(id) || this.recipes.get(id)?.nsfw === true
  }

  private load(games: unknown[]): void {
    this.recipes.clear()
    for (const g of games) if (valid(g)) this.recipes.set(g.id, normalizeRecipe(g))
  }

  async refresh(): Promise<{ games: number; errors: string[] }> {
    await this.refreshAll()
    return { games: this.visibleCount(), errors: this.visibleErrors() }
  }

  private async refreshAll(): Promise<void> {
    const all: Recipe[] = []
    const vocabulary: Vocabulary = Object.create(null)
    this.errors = []
    const off = this.content.level === 'off'
    const adult: Recipe[] = []
    for (const url of this.cfg.catalogUrls) {
      // At off the install reads the safe-for-work index; where that is missing, the full one with its adult games dropped.
      const sfw = off ? sfwIndexUrl(url) : null
      let idx: Index | null = null
      let from = url
      if (sfw) {
        try {
          idx = await fetchIndex(sfw)
          from = sfw
        } catch (e) {
          console.warn(`catalog: No safe-for-work index at ${sfw} (${(e as Error).message}). Adult games from ${url} are left out.`)
          this.errors.push({ text: `${sfw}: ${(e as Error).message}` })
        }
      } else if (off) {
        console.warn(`catalog: ${url} has no safe-for-work index. Its adult games are left out.`)
      }
      try {
        idx ??= await fetchIndex(url)
        let games: Recipe[] = (idx.games ?? []).filter(valid).map((g) => withoutLocalFiles({ ...normalizeRecipe(g), _base: from, _origin: url }))
        let vocab = idx.vocabulary ?? {}
        if (off) {
          const kept = withoutAdult(games, vocab)
          games = kept.games
          vocab = kept.vocabulary
          adult.push(...kept.adult)
        }
        for (const [id, entry] of Object.entries(vocab)) {
          if (!Object.hasOwn(vocabulary, id)) vocabulary[id] = entry
        }
        all.push(...games)
      } catch (e) {
        this.errors.push({ text: `${url}: ${(e as Error).message}` })
      }
    }
    // Your recipes: read like one more catalog, and a recipe there takes the place of the catalog's.
    const local = await readLocalRecipes(this.cfg.recipesDir, vocabulary)
    for (const p of local.problems) this.errors.push({ text: `Your recipes, ${p.file}: ${p.message}`, recipe: p.recipe })
    let mine = local.games
    if (off) {
      const kept = withoutAdult(mine, {})
      mine = kept.games
      adult.push(...kept.adult)
    }
    if (mine.length) {
      const ids = new Set(mine.map((g) => g.id))
      all.splice(0, all.length, ...all.filter((g) => !ids.has(g.id)), ...mine)
    }
    if (all.length || !this.errors.length) {
      this.load(all)
      this.vocabulary = vocabulary
      this.fetchedAt = Date.now()
      this.setAdult(off ? [...this.adult.values(), ...adult] : [])
      this.db.setSetting(CACHE_KEY, { at: this.fetchedAt, games: all, vocabulary, adultGames: this.content.level })
      this.syncAdult()
      this.link()
      await this.syncArt()
    }
    const failed = this.errors.length
    if (!all.length && failed) log('catalog', `Could not update: ${this.errors.map((e) => e.text).join('. ')}`, 'warn')
    else log('catalog', `Updated: ${all.length} recipes${failed ? `, ${failed} ${failed === 1 ? 'problem' : 'problems'} listed in Settings` : ''}`, failed ? 'warn' : 'info')
  }

  /**
   * Links installed games to their recipe: by the game's id, its archive
   * (checksum, name or pattern) or its save folder. Games installed before
   * their recipe existed pick it up this way without a reinstall.
   */
  link(): void {
    for (const g of this.db.allGames()) {
      if (g.recipe_id) continue
      const source = parseJson<GameSource>(g.source, {})
      const recipe =
        this.recipes.get(g.id) ??
        this.adult.get(g.id) ??
        (source.archive ? this.match({ name: source.archive, size: source.size, sha256: source.sha256 })?.recipe : undefined) ??
        (g.save_dir ? [...this.recipes.values(), ...this.adult.values()].find((r) => r.saveDir === g.save_dir) : undefined)
      if (recipe) this.db.updateGame(g.id, { recipe_id: recipe.id, adult: recipe.nsfw === true ? 1 : g.adult })
    }
  }

  /** The catalog pictures of a recipe, as the art cache takes them. */
  pictures(recipe: Recipe): ReturnType<typeof catalogPictures> {
    const pictures = catalogPictures(recipe.art, recipe._base ?? this.cfg.catalogUrls[0])
    return this.art ? this.art.complete(pictures) : pictures
  }

  /**
   * What the art cache makes: every recipe the installation shows (adult ones only measured by
   * hash below Shown), and every library game with its uploads.
   */
  artSubjects(): ArtSubject[] {
    const subjects: ArtSubject[] = [...this.recipes.values()].map((r) => ({ game: null, recipe: r.id, adult: r.nsfw === true, pictures: this.pictures(r) }))
    for (const g of this.db.allGames()) {
      const recipe = g.recipe_id ? this.recipes.get(g.recipe_id) : undefined
      const adult = g.adult === 1 || recipe?.nsfw === true || this.adult.has(g.recipe_id)
      // At Off an adult game's pictures are not made at all.
      if (adult && this.content.level === 'off') continue
      const uploads = this.art ? (this.db.raw.prepare('SELECT DISTINCT scope FROM art_uploads WHERE game = ?').all(g.id) as Array<{ scope: number }>).flatMap((r) => this.art!.uploads(g.id, r.scope)) : []
      const unique = [...new Map(uploads.map((u) => [`${u.id}:${u.kind}`, u])).values()]
      subjects.push({ game: g.id, recipe: g.recipe_id || null, adult, pictures: [...(recipe ? this.pictures(recipe) : []), ...unique] })
    }
    return subjects
  }

  /** A library game's pictures for this person: the catalog's and the uploads they may choose. */
  gameSubject(row: GameRow): ArtSubject {
    const recipe = row.recipe_id ? this.recipes.get(row.recipe_id) : undefined
    const uploads = this.art ? this.art.uploads(row.id, viewer()?.user.id ?? 0) : []
    return { game: row.id, recipe: row.recipe_id || null, adult: row.adult === 1 || recipe?.nsfw === true, pictures: [...(recipe ? this.pictures(recipe) : []), ...uploads] }
  }

  /** A library game's formats as this person sees them. */
  gameArt(row: GameRow): ArtSet {
    return this.art ? this.art.forSubject(this.gameSubject(row)) : {}
  }

  /** A catalog recipe's formats (its defaults) as this person sees them. */
  recipeArt(recipe: Recipe): ArtSet {
    return this.art ? this.art.forSubject({ game: null, adult: recipe.nsfw === true, pictures: this.pictures(recipe) }, { scope: 0 }) : {}
  }

  /** Makes the pictures every page needs, and forgets the ones nothing uses. */
  async syncArt(): Promise<void> {
    if (!this.art) return
    for (const text of await this.art.sync(this.artSubjects())) this.errors.push({ text, recipe: text.match(/^[a-z]+ of ([a-z0-9][a-z0-9._-]*) \(/)?.[1] })
  }


  /** The newest working release after the installed version, if the catalog lists one. */
  update(recipe: Recipe, version: string, archive?: string): RecipeRelease | null {
    const release = installedRelease(recipe, version, archive)
    const i = release ? recipe.releases.indexOf(release) : -1
    if (i <= 0) return null
    return recipe.releases.slice(0, i).find((r) => r.status === 'verified' || r.status === 'playable') ?? null
  }

  list(): Recipe[] {
    return [...this.recipes.values()].filter((r) => !this.content.hidesRecipe(r.nsfw)).sort((a, b) => a.title.localeCompare(b.title))
  }

  recipe(id: string): Recipe | null {
    const recipe = this.recipes.get(id)
    return recipe && !this.content.hidesRecipe(recipe.nsfw) ? recipe : null
  }


  status(): { fetchedAt: number; urls: string[]; errors: string[]; count: number } {
    return { fetchedAt: this.fetchedAt, urls: this.cfg.catalogUrls, errors: this.visibleErrors(), count: this.visibleCount() }
  }

  /**
   * Each source with what it gave this person: the configured catalogs, then Your recipes. Counts
   * leave out what the person's level hides.
   */
  sources(): Array<{ kind: 'catalog' | 'folder'; location: string; recipes: number; pictures: number; problems: string[] }> {
    const visible = this.list()
    const problems = this.visibleErrors()
    const of = (origin: string) => visible.filter((r) => r._origin === origin)
    const count = (rs: Recipe[]) => ({ recipes: rs.length, pictures: rs.reduce((n, r) => n + (r.art?.length ?? 0), 0) })
    return [
      ...this.cfg.catalogUrls.map((url) => ({ kind: 'catalog' as const, location: url, ...count(of(url)), problems: problems.filter((p) => p.startsWith(url) || p.startsWith(sfwIndexUrl(url) ?? '\0')) })),
      { kind: 'folder' as const, location: this.cfg.recipesDir, ...count(of('local')), problems: problems.filter((p) => p.startsWith('Your recipes')) },
    ]
  }

  /** Errors about an adult recipe name it and its art, so only a person at Shown sees them. */
  private visibleErrors(): string[] {
    const shown = this.content.viewerLevel() === 'shown'
    // The name can be a recipe, or a library game without one (then its own adult flag counts).
    return this.errors.filter((e) => shown || !e.recipe || !(this.isAdultId(e.recipe) || this.db.getGame(e.recipe)?.adult === 1)).map((e) => e.text)
  }

  private visibleCount(): number {
    return [...this.recipes.values()].filter((r) => !this.content.hidesRecipe(r.nsfw)).length
  }

  /** Finds the recipe (and release) an archive belongs to. */
  /**
   * Off: an adult game does not exist, so neither does its download: one a recipe for an adult
   * game names, or one a hidden game was installed from (also a game without a recipe).
   */
  archiveHidden(rel: string, size?: number): boolean {
    if (this.content.viewerLevel() !== 'off') return false
    const row = this.db.getArchive(rel)
    if (this.content.hidesRecipe(this.match({ name: rel, size: size ?? row?.size, sha256: row?.sha256 || undefined })?.recipe.nsfw)) return true
    let hidden = false
    for (const g of this.db.allGames()) {
      if (parseJson<GameSource>(g.source, {}).archive !== rel) continue
      if (!this.content.hides(g)) return false
      hidden = true
    }
    return hidden
  }

  /**
   * Off: a job about an adult game does not exist either. A job names its game when it has one;
   * a first install or a hash has only its download and recipe, and a forgotten game only its id.
   */
  jobHidden(j: Pick<JobRow, 'game' | 'params' | 'result'>): boolean {
    if (this.content.viewerLevel() !== 'off') return false
    const game = j.game ? this.db.getGame(j.game) : null
    if (game) return this.content.hides(game)
    const params = parseJson<{ recipeId?: unknown; path?: unknown; source?: { path?: unknown } }>(j.params, {})
    const result = parseJson<{ recipe?: unknown; game?: unknown } | null>(j.result, null)
    const ids = [j.game, params.recipeId, result?.recipe, result?.game].filter((x): x is string => typeof x === 'string' && x !== '')
    if (ids.some((id) => this.isAdultId(id))) return true
    const archive = [params.source?.path, params.path].find((x): x is string => typeof x === 'string' && x !== '')
    if (!archive) return false
    try {
      return this.archiveHidden(cleanRelPath(archive))
    } catch {
      return false
    }
  }

  match(archive: { name: string; size?: number; sha256?: string }): RecipeMatch | null {
    const base = archive.name.split('/').pop() ?? archive.name
    let byName: RecipeMatch | null = null
    let byPattern: RecipeMatch | null = null
    for (const recipe of [...this.recipes.values(), ...this.adult.values()]) {
      for (const release of recipe.releases) {
        for (const a of release.archives ?? []) {
          if (archive.sha256 && a.sha256 && a.sha256.toLowerCase() === archive.sha256.toLowerCase()) return { recipe, release, exact: true }
          if (a.name === base && (!a.size || !archive.size || a.size === archive.size)) {
            byName ??= { recipe, release, exact: !!(a.size && archive.size) }
          }
        }
      }
      if (!byPattern && (recipe.match ?? []).some((p) => globMatch(p, base))) byPattern = { recipe, release: null, exact: false }
    }
    return byName ?? byPattern
  }

  /** Build settings for a recipe, with the engine of the given release. */
  settings(recipe: Recipe, release: RecipeRelease | null): BuildSettings {
    return {
      engine: release?.runtime ?? recipe.runtime,
      quality: recipe.build?.imageQuality,
      optimize: recipe.build?.optimizeImages,
      keep: recipe.build?.keep ?? [],
      exclude: recipe.build?.exclude ?? [],
    }
  }

  /** Downloads a recipe's patches: path relative to game/ -> content. */
  async patches(recipe: Recipe, ctx: JobContext): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>()
    for (const p of recipe.build?.patches ?? []) {
      const rel = cleanRelPath(p.path)
      if (!rel.startsWith('game/')) throw new Error(`Recipe patch outside game/: ${rel}`)
      let data: Buffer
      if (p.url.startsWith('local:')) data = await readLocalFile(this.cfg.recipesDir, p.url)
      else {
        const url = new URL(p.url, recipe._base ?? this.cfg.catalogUrls[0]).toString()
        const res = await fetchPublic(url, { signal: ctx.signal, allowHosts: catalogHosts(this.cfg.catalogUrls) })
        if (!res.ok) throw new Error(`Recipe patch download failed: ${url} (${res.status})`)
        data = Buffer.from(await res.arrayBuffer())
      }
      if (createHash('sha256').update(data).digest('hex') !== p.sha256.toLowerCase()) throw new Error(`Recipe patch checksum mismatch: ${rel}`)
      out.set(rel.slice(5), data)
      ctx.log(`Recipe patch ${rel}`)
    }
    return out
  }
}
