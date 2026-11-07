import { randomBytes } from 'node:crypto'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import express, { Router, type Request } from 'express'
import multer from 'multer'
import YAML from 'yaml'
import { viewer } from '../accounts-context.js'
import { ART_KINDS, type ArtKind } from '../art.js'
import type { Accounts } from '../auth.js'
import type { Builds } from '../builds.js'
import { installedRelease, type Catalog } from '../catalog.js'
import type { Config } from '../config.js'
import { parseJson, type Db, type GameRow, type GameSource } from '../db.js'
import type { JobManager } from '../jobs.js'
import type { Overlays } from '../mods.js'
import type { SaveStore } from '../saves/store.js'
import { playPath } from './play.js'
import { cachedSaveMeta, cachedSceneHash } from './saves.js'
import { slotInfo } from '../saves/savefile.js'
import { exists, writeFileAtomic } from '../util/fsx.js'
import { HttpError, assertSlug, cleanRelPath, safeJoin } from '../util/paths.js'

/** What a walkthrough file is, from its first bytes (and its name for text), or null. */
export function walkthroughKind(data: Buffer, name = ''): { kind: 'pdf' | 'image' | 'text'; ext: string } | null {
  const head = data.subarray(0, 12).toString('latin1')
  if (head.startsWith('%PDF-')) return { kind: 'pdf', ext: 'pdf' }
  if (head.startsWith('\x89PNG')) return { kind: 'image', ext: 'png' }
  if (data[0] === 0xff && data[1] === 0xd8) return { kind: 'image', ext: 'jpg' }
  if (head.startsWith('RIFF') && head.slice(8) === 'WEBP') return { kind: 'image', ext: 'webp' }
  if (/\.(txt|md|markdown)$/i.test(name) && !data.includes(0) && !/^\s*<(!doctype|html|script|svg)/i.test(data.subarray(0, 200).toString('utf8'))) return { kind: 'text', ext: 'txt' }
  return null
}

const pdfs = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 << 20, files: 1 } })
const CACHE_RE = /^(bytecode-\d+|py3analysis|screens)\.rpyb$/

/**
 * Cache files a game may store: Python bytecode and analysis caches, and
 * scripts Ren'Py recompiled (rpyc/<path relative to game/>). Games made with
 * an older Ren'Py are recompiled by the newer engine on every start
 * otherwise, which takes seconds to tens of seconds.
 */
function cacheName(raw: unknown): string {
  const name = cleanRelPath(raw)
  if (CACHE_RE.test(name)) return name
  if (name.startsWith('rpyc/') && /\.rpyc$/i.test(name)) return name
  throw new HttpError(400, 'Not a cache file')
}

/** The catalog's recipe schema, for editors that validate YAML (yaml-language-server). */
export const RECIPE_SCHEMA_URL = 'https://catalog.renplay.org/recipe.schema.json'

export interface GameDeps {
  cfg: Config
  accounts: Accounts
  db: Db
  jobs: JobManager
  builds: Builds
  saves: SaveStore
  overlays: Overlays
  catalog: Catalog
  version: string
}

export async function toGame(row: GameRow, deps: GameDeps) {
  row = deps.accounts.progress(row)
  const source = parseJson<GameSource>(row.source, {})
  const job = deps.jobs.activeFor(row.id)
  let latestSave: { file: string; label: string; name: string; ctime: number; runtime: number | undefined; screenshot: string | null; screenshotHash?: string | null } | null = null
  let latestFile: { name: string; mtimeMs: number; size: number } | null = null
  let saves = { count: 0, latest: 0 }
  if (row.save_dir) {
    try {
      const files = (await deps.saves.list(row.save_dir)).filter((f) => f.name.endsWith('.save') && !f.name.startsWith('_') && !f.name.includes('/'))
      saves = { count: files.length, latest: files.reduce((m, f) => Math.max(m, f.mtimeMs), 0) }
      for (const f of files) {
        const meta = await cachedSaveMeta(deps.saves, row.save_dir, f)
        if (!meta) continue
        const ctime = meta.ctime ? meta.ctime * 1000 : f.mtimeMs
        if (!latestSave || ctime > latestSave.ctime) {
          latestSave = {
            file: f.name, label: slotInfo(f.name).label, name: meta.name ?? '', ctime, runtime: meta.runtime,
            screenshot: meta.hasScreenshot ? `/api/saves/${row.id}/screenshot?user=${deps.accounts.current().id}&file=${encodeURIComponent(f.name)}&v=${f.mtimeMs}` : null,
          }
          latestFile = f
        }
      }
    } catch {}
  }
  const mods = await deps.overlays.summary(row.id)
  const recipe = row.recipe_id ? deps.catalog.recipe(row.recipe_id) : null
  const release = recipe ? installedRelease(recipe, row.version, source.archive) : null
  const update = recipe ? deps.catalog.update(recipe, row.version, source.archive) : null
  const modded = row.build.includes('.m')
  // Blurred: the game shows with its title and metadata, but no picture URL leaves the server.
  const blurred = deps.catalog.content.blurs(row)
  if (blurred && latestSave && latestFile && row.save_dir) {
    // Only the picture's hash, a soft blur of its colours.
    latestSave.screenshotHash = latestSave.screenshot ? await cachedSceneHash(deps.saves, row.save_dir, latestFile) : null
    latestSave.screenshot = null
  }
  return {
    id: row.id,
    // Title, developer, tags and cover come from the catalog; a game without a
    // recipe shows the name it declares itself.
    title: recipe?.title ?? row.title,
    developer: recipe?.developer ?? null,
    tags: recipe?.tags ?? [],
    tagIds: recipe?.tagIds ?? [],
    content: recipe?.content ?? [],
    state: recipe?.state ?? null,
    summary: recipe?.summary ?? null,
    // A game without a recipe can be marked adult in the library, and its tile says so too.
    nsfw: recipe?.nsfw ?? row.adult === 1,
    free: recipe?.free,
    // The five formats. Below Shown an adult game's formats are hashes and tints, no address.
    art: deps.catalog.gameArt(row),
    walkthrough: row.walkthrough || null,
    /** The walkthrough files, in order: PDFs, pictures and plain text. */
    walkthroughs: deps.db.walkthroughs(row.id).map((w) => ({ file: w.file, title: w.title, kind: w.kind, size: w.size, addedAt: w.added_at, url: `/api/walkthroughs/${encodeURIComponent(w.file)}` })),
    status: row.status,
    build: row.build || null,
    // The game page is an iframe, which sends no header: this device's level rides along as a query.
    playUrl: row.status === 'installed' && row.build ? (row.family !== 'renpy' ? deps.accounts.assetUrl(row) : playPath(row) + (viewer()?.device ? `?adult=${viewer()!.device}` : '')) : null,
    family: row.family || 'renpy',
    /** What made the game, for other engines ("HTML (SugarCube 2.36.1)"). */
    engineLabel: row.engine_label || null,
    version: release?.version || row.version || null,
    detectedVersion: row.version || null,
    renpyVersion: row.renpy_version || null,
    engine: row.engine || null,
    sizeBytes: row.size_bytes,
    fileCount: row.file_count,
    screen: row.screen_w ? ([row.screen_w, row.screen_h] as [number, number]) : null,
    saveDir: row.save_dir || null,
    source: { archive: source.archive ?? null, size: source.size ?? null },
    canReinstall: !!source.archive && (await exists(join(deps.cfg.archivesDir, cleanRelPath(source.archive)))),
    recipe: recipe
      ? {
          id: recipe.id,
          links: recipe.links ?? {},
          continuesFrom: recipe.continuesFrom ?? [],
          status: release?.status ?? null,
        }
      : row.recipe_id
        ? { id: row.recipe_id, links: {}, continuesFrom: [], status: null }
        : null,
    update: update ? { version: update.version, date: update.date ?? null, status: update.status, archives: update.archives.map((archive) => archive.name) } : null,
    favoriteAt: row.favorite_at || null,
    finishedAt: row.finished_at || null,
    playTime: row.play_time,
    /** The person's status: playing, stalled, dropped, finished, or null when not set. */
    playStatus: row.play_status || null,
    rating: row.rating || null,
    notNowAt: row.not_now_at || null,
    /** How the game plays on a phone, curated in the recipe: great, playable or desktop. */
    phone: recipe?.phone ?? null,
    latestSave,
    createdAt: row.created_at,
    installedAt: row.installed_at || null,
    lastPlayedAt: row.last_played_at || null,
    saves,
    mods: { files: mods.files + mods.deleted, hash: mods.hash, applied: modded && row.build.endsWith(`.m${mods.hash}`) },
    job: job ? { id: job.id, type: job.type, status: job.status, stage: job.stage, progress: job.progress } : null,
  }
}

export function createGamesRouter(deps: GameDeps): Router {
  const { cfg, db, jobs, builds } = deps
  const router = Router({ caseSensitive: true, strict: true })

  const get = (req: Request): GameRow => {
    const g = db.getGame(assertSlug(req.params.id))
    if (!g || deps.catalog.content.hides(g)) throw new HttpError(404, 'Game not found')
    return g
  }

  router.get('/', async (_req, res) => {
    res.json({ games: await Promise.all(db.allGames().filter((r) => !deps.catalog.content.hides(r)).map((r) => toGame(r, deps))) })
  })

  router.get('/:id', async (req, res) => {
    res.json({ game: await toGame(get(req), deps) })
  })

  // ---- art: choices and uploads (DESIGN 0.7) ------------------------------------

  /** The game, when this person may see its pictures: below Shown an adult game's art does not exist. */
  const withArt = (req: Request): GameRow => {
    const g = get(req)
    if (deps.catalog.content.blurs(g) || !deps.catalog.art) throw new HttpError(404, 'Not found')
    return g
  }
  const kindOf = (value: unknown): ArtKind => {
    if (typeof value !== 'string' || !ART_KINDS.includes(value as ArtKind)) throw new HttpError(400, 'Choose grid, wide, hero, logo or icon')
    return value as ArtKind
  }
  /** Me: this person's own view. Everyone: the admin's default for the instance. */
  const scopeOf = (value: unknown): number => {
    const v = viewer()
    if (value === 'everyone') {
      if (v && v.user.role !== 'admin') throw new HttpError(403, 'Only an admin can choose art for everyone')
      return 0
    }
    if (value !== undefined && value !== 'me') throw new HttpError(400, 'Scope must be me or everyone')
    return v?.user.id ?? 0
  }

  router.get('/:id/art', async (req, res) => {
    const g = withArt(req)
    const subject = deps.catalog.gameSubject(g)
    const scope = scopeOf(undefined)
    if (req.query['kind'] === undefined) {
      res.json({ art: deps.catalog.art!.forSubject(subject), counts: Object.fromEntries(ART_KINDS.map((k) => [k, subject.pictures.filter((p) => p.kind === k).length])) })
      return
    }
    const kind = kindOf(req.query['kind'])
    res.json({ kind, candidates: await deps.catalog.art!.candidates(subject, kind, scope) })
  })

  router.put('/:id/art', async (req, res) => {
    const g = withArt(req)
    const kind = kindOf(req.body?.kind)
    const scope = scopeOf(req.body?.scope)
    const subject = deps.catalog.gameSubject(g)
    const picture = subject.pictures.find((p) => p.kind === kind && p.id === req.body?.candidate)
    if (!picture) throw new HttpError(404, 'That picture is not a choice for this game')
    // For everyone: a catalog picture or one uploaded for everyone. A personal upload is not on the others' lists.
    if (scope === 0 && picture.upload && !deps.catalog.art!.isShared(picture.id, g.id))
      throw new HttpError(409, 'Upload this picture for everyone first, then choose it for everyone.')
    deps.catalog.art!.choose(g.id, kind, req.body.candidate, scope)
    await deps.catalog.art!.ready(subject, scope)
    res.json({ art: deps.catalog.art!.forSubject(subject) })
  })

  router.delete('/:id/art', async (req, res) => {
    const g = withArt(req)
    const kind = kindOf(req.query['kind'])
    const scope = scopeOf(req.query['scope'])
    deps.catalog.art!.clearChoice(g.id, kind, scope)
    const subject = deps.catalog.gameSubject(g)
    await deps.catalog.art!.ready(subject, scope)
    res.json({ art: deps.catalog.art!.forSubject(subject) })
  })

  router.post('/:id/art/upload', express.raw({ type: () => true, limit: '16mb' }), async (req, res) => {
    const g = withArt(req)
    const kind = kindOf(req.query['kind'])
    const scope = scopeOf(req.query['scope'])
    const focalText = typeof req.query['focal'] === 'string' ? req.query['focal'] : ''
    const focal = /^(0(\.\d+)?|1(\.0+)?),(0(\.\d+)?|1(\.0+)?)$/.test(focalText) ? (focalText.split(',').map(Number) as [number, number]) : null
    if (focalText && !focal) throw new HttpError(400, 'The focal point is two numbers from 0 to 1, like 0.5,0.3')
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'No picture uploaded')
    const { id, warning } = await deps.catalog.art!.upload(g.id, kind, req.body, focal, scope)
    // An upload is made to be used: it becomes the choice at the scope it was uploaded for.
    deps.catalog.art!.choose(g.id, kind, id, scope)
    const subject = deps.catalog.gameSubject(g)
    await deps.catalog.art!.ready(subject, scope)
    res.json({ id, warning, art: deps.catalog.art!.forSubject(subject) })
  })

  /** Deletes one's own upload (scope me), or an admin's upload for everyone (scope everyone). */
  router.delete('/:id/art/uploads/:upload', async (req, res) => {
    const g = withArt(req)
    const kind = kindOf(req.query['kind'])
    const scope = scopeOf(req.query['scope'])
    if (!/^[0-9a-f]{64}$/.test(req.params.upload)) throw new HttpError(404, 'Picture not found')
    if (!deps.catalog.art!.removeUpload(g.id, kind, req.params.upload, scope)) throw new HttpError(404, 'Picture not found')
    const subject = deps.catalog.gameSubject(g)
    await deps.catalog.art!.ready(subject, scope)
    res.json({ art: deps.catalog.art!.forSubject(subject) })
  })

  router.put('/:id/favorite', async (req, res) => {
    const g = get(req)
    if (typeof req.body?.on !== 'boolean') throw new HttpError(400, 'On must be a boolean')
    const patch = { favorite_at: req.body.on ? deps.accounts.progress(g).favorite_at || new Date().toISOString() : '' }
    deps.accounts.setProgress(g.id, patch)
    res.json({ ok: true, game: await toGame(db.getGame(g.id)!, deps) })
  })

  /** Finished keeps finished_at in step with the status, which 3.x reads. */
  const setStatus = (g: GameRow, status: string) => {
    const previous = deps.accounts.progress(g).finished_at
    const patch = { play_status: status, finished_at: status === 'finished' ? previous || new Date().toISOString() : '' }
    deps.accounts.setProgress(g.id, patch)
  }

  router.put('/:id/finished', async (req, res) => {
    const g = get(req)
    if (typeof req.body?.on !== 'boolean') throw new HttpError(400, 'On must be a boolean')
    // Not finished (from 3.x) clears Finished only: Stalled or Dropped stay.
    const current = deps.accounts.progress(g).play_status
    if (req.body.on) setStatus(g, 'finished')
    else if (!current || current === 'finished') setStatus(g, '')
    res.json({ ok: true, game: await toGame(db.getGame(g.id)!, deps) })
  })

  router.put('/:id/status', async (req, res) => {
    const g = get(req)
    const status = req.body?.status ?? ''
    if (!['', 'playing', 'stalled', 'dropped', 'finished'].includes(status)) throw new HttpError(400, 'Status must be playing, stalled, dropped, finished or empty')
    setStatus(g, status)
    res.json({ ok: true, game: await toGame(db.getGame(g.id)!, deps) })
  })

  router.put('/:id/rating', async (req, res) => {
    const g = get(req)
    const rating = req.body?.rating ?? 0
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) throw new HttpError(400, 'Rating must be a whole number from 0 to 5')
    deps.accounts.setProgress(g.id, { rating })
    res.json({ ok: true, game: await toGame(db.getGame(g.id)!, deps) })
  })

  // Not now: the game leaves Up next until it is played again. DELETE undoes it.
  router.post('/:id/not-now', async (req, res) => {
    const g = get(req)
    deps.accounts.setProgress(g.id, { not_now_at: new Date().toISOString() })
    res.json({ ok: true, game: await toGame(db.getGame(g.id)!, deps) })
  })
  router.delete('/:id/not-now', async (req, res) => {
    const g = get(req)
    deps.accounts.setProgress(g.id, { not_now_at: '' })
    res.json({ ok: true, game: await toGame(db.getGame(g.id)!, deps) })
  })

  // The player reports visible, running time in seconds, in bounded increments.
  router.post('/:id/play-time', (req, res) => {
    const g = get(req)
    const seconds = req.body?.seconds
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 60) throw new HttpError(400, 'Seconds must be an integer from 1 to 60')
    const counted = deps.accounts.addPlayTime(g.id, seconds)
    if (counted) deps.accounts.setProgress(g.id, { play_time: deps.accounts.progress(g).play_time + counted })
    res.json({ ok: true })
  })

  router.post('/:id/played', (req, res) => {
    const id = get(req).id, patch = { last_played_at: new Date().toISOString() }
    deps.accounts.setProgress(id, patch)
    res.json({ ok: true })
  })

  /** Uninstalls (files go, saves and mods stay); `forget=1` also removes the library entry. */
  router.delete('/:id', async (req, res) => {
    const g = get(req)
    if (jobs.activeFor(g.id)) throw new HttpError(409, 'A job is running for this game')
    await builds.remove(g.id)
    if (req.query['forget'] === '1') {
      for (const w of db.walkthroughs(g.id)) await unlink(join(cfg.walkthroughsDir, w.file)).catch(() => {})
      deps.catalog.art?.forgetGame(g.id)
      db.raw.prepare('DELETE FROM walkthroughs WHERE game = ?').run(g.id)
      // Its finished jobs go with it: without the game, nothing tells whether they were about an
      // adult game. Saves stay, as always.
      jobs.clearFinished((j) => j.game !== g.id && parseJson<{ game?: unknown }>(j.result, {}).game !== g.id)
      db.deleteGame(g.id)
      res.json({ ok: true, forgotten: true })
      return
    }
    db.updateGame(g.id, { status: 'not_installed', build: '', size_bytes: 0, file_count: 0 })
    res.json({ ok: true, game: await toGame(db.getGame(g.id)!, deps) })
  })

  router.delete('/:id/download', async (req, res) => {
    const g = get(req)
    if (jobs.isBusy() || jobs.activeFor(g.id)) throw new HttpError(409, 'Wait for install jobs to finish before deleting a download')
    const source = parseJson<GameSource>(g.source, {})
    if (!source.archive) throw new HttpError(404, 'No download is known for this game')
    const rel = cleanRelPath(source.archive)
    await unlink(safeJoin(cfg.archivesDir, rel)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new HttpError(404, 'Download not found')
      throw error
    })
    db.deleteArchive(rel)
    res.json({ ok: true })
  })

  router.post('/:id/reinstall', async (req, res) => {
    const g = get(req)
    const src = parseJson<GameSource>(g.source, {})
    if (!src.archive) throw new HttpError(409, 'No source archive is known for this game. Add its archive to install it.')
    if (!(await exists(join(cfg.archivesDir, cleanRelPath(src.archive))))) throw new HttpError(409, `The source archive ${src.archive} is no longer in the archives folder`)
    if (jobs.activeFor(g.id)) throw new HttpError(409, 'A job is already running for this game')
    const id = jobs.enqueue('import', g.id, {
      source: { kind: 'archive', path: src.archive },
      game: g.id,
      recipeId: g.recipe_id || undefined,
      engine: typeof req.body?.engine === 'string' ? req.body.engine : undefined,
      reapplyMods: !!req.body?.reapplyMods,
      // Who started it: Choose artwork opens for them alone.
      by: viewer()?.user.id,
    })
    if (g.status !== 'installed') db.updateGame(g.id, { status: 'installing' })
    res.json({ jobId: id })
  })

  /**
   * Python bytecode caches compiled by the browser on a game's first start.
   * Stored with the current build, they spare later starts the compile.
   */
  router.put('/:id/cache', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
    const g = get(req)
    const name = cacheName(req.query['name'])
    if (req.query['build'] !== g.build || !g.build) throw new HttpError(409, 'Build changed')
    if (!Buffer.isBuffer(req.body) || req.body.length < 16) throw new HttpError(400, 'Empty cache')
    const path = safeJoin(join(builds.dir(g.id, g.build), 'cache'), name)
    await mkdir(dirname(path), { recursive: true })
    await writeFileAtomic(path, req.body)
    res.json({ ok: true })
  })

  /** A recipe for this game, filled in from the installed build, to contribute to the catalog. */
  router.get('/:id/recipe', async (req, res) => {
    const g = get(req)
    const src = parseJson<GameSource>(g.source, {})
    let sha256 = src.sha256 ?? ''
    if (!sha256 && src.archive) sha256 = db.getArchive(src.archive)?.sha256 ?? ''
    let hashJob: string | null = null
    if (!sha256 && src.archive && (await exists(join(cfg.archivesDir, src.archive)))) {
      const running = db.listJobs(100).find((j) => j.type === 'hash-archive' && (j.status === 'queued' || j.status === 'running') && j.params.includes(src.archive!))
      hashJob = running?.id ?? jobs.enqueue('hash-archive', '', { path: src.archive })
    }
    const existing = g.recipe_id ? deps.catalog.recipe(g.recipe_id) : null
    const recipe = {
      id: g.recipe_id || g.id,
      title: existing?.title ?? g.title,
      developer: existing?.developer ?? '',
      tags: existing?.tags ?? [],
      nsfw: existing?.nsfw ?? false,
      links: existing?.links ?? { website: '' },
      saveDir: g.save_dir || undefined,
      continuesFrom: existing?.continuesFrom,
      match: existing?.match,
      engine: existing?.engine ?? ((g.family || 'renpy') as 'renpy'),
      runtime: existing?.runtime,
      build: existing?.build,
      releases: [
        {
          version: g.version || 'unknown',
          madeWith: g.renpy_version || undefined,
          runtime: g.engine || undefined,
          status: 'untested',
          archives: src.archive ? [{ name: src.archive.split('/').pop(), size: src.size, sha256: sha256 || 'pending' }] : [],
          verified: { date: new Date().toISOString().slice(0, 10), renplay: deps.version, browsers: [], notes: '' },
        },
        ...(existing?.releases.filter((r) => r.version !== g.version) ?? []),
      ],
    }
    const yaml = `# yaml-language-server: $schema=${RECIPE_SCHEMA_URL}\n${YAML.stringify(JSON.parse(JSON.stringify(recipe)), { lineWidth: 0 })}`
    res.json({ yaml, sha256Pending: !sha256, hashJob })
  })

  // ---- walkthroughs --------------------------------------------------------

  /** A game's walkthrough file, or 404. */
  const walkthroughOf = (g: GameRow, file: string) => {
    const w = db.walkthroughs(g.id).find((x) => x.file === file)
    if (!w) throw new HttpError(404, 'Walkthrough not found')
    return w
  }

  // Several walkthrough files per game: PDFs, pictures and plain text. Not HTML: it would run as
  // part of Renplay's own page.
  router.post('/:id/walkthroughs', async (req, res) => {
    const g = get(req)
    // multer runs inside the handler and is awaited: as route middleware its stream callbacks would
    // lose the request's context, and with it who is asking (accounts-context.ts).
    await new Promise<void>((resolve, reject) => pdfs.single('file')(req, res, (error) => (error ? reject(error) : resolve())))
    const f = req.file
    if (!f) throw new HttpError(400, 'No file uploaded')
    const kind = walkthroughKind(f.buffer, f.originalname)
    if (!kind) throw new HttpError(400, 'Add a PDF, a picture (PNG, JPEG or WebP) or a plain text file')
    await mkdir(cfg.walkthroughsDir, { recursive: true })
    const name = `${g.id}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}.${kind.ext}`
    await writeFile(join(cfg.walkthroughsDir, name), f.buffer)
    const fallback = (f.originalname || 'Walkthrough').replace(/\.[a-z0-9]{1,5}$/i, '').trim().slice(0, 100) || 'Walkthrough'
    const title = typeof req.body?.title === 'string' && req.body.title.trim() ? req.body.title.trim().slice(0, 100) : fallback
    const position = (db.walkthroughs(g.id).at(-1)?.position ?? -1) + 1
    db.raw.prepare('INSERT INTO walkthroughs (file, game, title, kind, size, added_at, position) VALUES (?, ?, ?, ?, ?, ?, ?)').run(name, g.id, title, kind.kind, f.size, new Date().toISOString(), position)
    db.syncFirstWalkthrough(g.id)
    res.json({ ok: true, game: await toGame(db.getGame(g.id)!, deps) })
  })

  /** Renames a walkthrough, or moves it to another place in the list. */
  router.put('/:id/walkthroughs/:file', async (req, res) => {
    const g = get(req)
    const w = walkthroughOf(g, req.params.file)
    if (req.body?.title !== undefined) {
      if (typeof req.body.title !== 'string' || !req.body.title.trim()) throw new HttpError(400, 'A walkthrough needs a title')
      db.raw.prepare('UPDATE walkthroughs SET title = ? WHERE file = ?').run(req.body.title.trim().slice(0, 100), w.file)
    }
    if (req.body?.position !== undefined) {
      const list = db.walkthroughs(g.id).filter((x) => x.file !== w.file)
      const at = Number(req.body.position)
      if (!Number.isInteger(at) || at < 0) throw new HttpError(400, 'Position must be a whole number from 0')
      list.splice(Math.min(at, list.length), 0, w)
      list.forEach((x, i) => db.raw.prepare('UPDATE walkthroughs SET position = ? WHERE file = ?').run(i, x.file))
      db.syncFirstWalkthrough(g.id)
    }
    res.json({ ok: true, game: await toGame(db.getGame(g.id)!, deps) })
  })

  router.delete('/:id/walkthroughs/:file', async (req, res) => {
    const g = get(req)
    const w = walkthroughOf(g, req.params.file)
    db.raw.prepare('DELETE FROM walkthroughs WHERE file = ?').run(w.file)
    await unlink(join(cfg.walkthroughsDir, w.file)).catch(() => {})
    db.syncFirstWalkthrough(g.id)
    res.json({ ok: true, game: await toGame(db.getGame(g.id)!, deps) })
  })

  return router
}
