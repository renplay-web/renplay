import { DEFAULTS_KEY, keepaliveToken, readDefaults, type Defaults } from '../auth.js'
import type { SaveBackups } from '../backups.js'
import { SYNC_SETTING, syncCodesOn } from './saves.js'
import type { Catalog } from '../catalog.js'
import { keepDownloads } from '../downloads.js'
import { readdir, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { Router } from 'express'
import type { Builds } from '../builds.js'
import type { Config } from '../config.js'
import type { ContentMode } from '../content.js'
import { parseJson, type Db } from '../db.js'
import type { EngineStore } from '../engines.js'
import type { JobManager } from '../jobs.js'
import { HttpError, cleanRelPath, safeJoin } from '../util/paths.js'
import type { Purger } from '../util/purge.js'
import { dirSize } from '../util/fsx.js'

async function disk(path: string) {
  try {
    const s = await statfs(path)
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }
  } catch {
    return null
  }
}

/** Variables whose effect Settings shows, so it can say whether the server sets them. */
const PROVENANCE = ['RENPLAY_AUTH', 'GAMES_DIR', 'ARCHIVES_DIR', 'DATA_DIR', 'RENPLAY_BACKUP_DIR', 'RENPLAY_CATALOG_URLS', 'RENPLAY_RECIPES_DIR', 'RENPLAY_LOG_LEVEL', 'RENPLAY_SYNC_SERVER', 'RENPLAY_ENGINES_URL']

export function createSystemRouter(cfg: Config, db: Db, jobs: JobManager, engines: EngineStore, builds: Builds, purger: Purger, version: string, content: ContentMode, catalog: Catalog, backups: SaveBackups): Router {
  const router = Router({ caseSensitive: true, strict: true })

  router.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime(), version })
  })

  /**
   * Held open by the job runner (through the scale-to-zero proxy) to keep the
   * pod alive. Headers go out immediately: proxies give up on responses whose
   * headers take longer than their header timeout, but stream bodies fine.
   */
  router.get('/keepalive', (req, res) => {
    if (req.get('authorization') !== `Bearer ${keepaliveToken}`) throw new HttpError(401, 'Invalid keepalive token')
    const hold = Math.min(150, Math.max(0, Number(req.query['hold']) || 0))
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
    res.flushHeaders()
    const tick = setInterval(() => res.write('.'), 10_000)
    const done = setTimeout(() => {
      clearInterval(tick)
      res.end(jobs.isBusy() ? 'busy\n' : 'idle\n')
    }, hold * 1000)
    req.on('close', () => {
      clearInterval(tick)
      clearTimeout(done)
    })
  })

  // ---- defaults for everyone -------------------------------------------------------

  router.get('/defaults', (_req, res) => {
    res.json(readDefaults(db))
  })

  router.put('/defaults', (req, res) => {
    const b = req.body ?? {}
    const bool = (v: unknown, name: string) => {
      if (v === null || v === undefined) return null
      if (typeof v !== 'boolean') throw new HttpError(400, `${name} is true, false or empty`)
      return v
    }
    if (b.tagsExclude !== undefined && (!Array.isArray(b.tagsExclude) || b.tagsExclude.length > 60 || b.tagsExclude.some((t: unknown) => typeof t !== 'string' || !/^[a-z0-9-]{1,40}$/.test(t))))
      throw new HttpError(400, 'Tags are a list of tag ids')
    if (b.textSize !== undefined && b.textSize !== null && ![1, 1.25, 1.5].includes(b.textSize)) throw new HttpError(400, 'Text size is 1, 1.25, 1.5 or empty')
    const next: Defaults = {
      tagsExclude: [...new Set<string>(b.tagsExclude ?? [])],
      lighterBackground: bool(b.lighterBackground, 'Lighter background'),
      textSize: b.textSize ?? null,
      rollback: bool(b.rollback, 'Rollback'),
      skip: bool(b.skip, 'Skip'),
    }
    db.setSetting(DEFAULTS_KEY, next)
    res.json(next)
  })

  // ---- storage -----------------------------------------------------------------

  /**
   * What uses space, game by game (the build played, other builds such as mods, the download), the
   * engines, and folders of no game, with what could be freed. Counted at most once a minute.
   */
  let storage: { at: number; body: unknown; level: string } | null = null
  // One count at a time for each level: a second request waits for the one running.
  let counting: { level: string; body: Promise<unknown> } | null = null
  router.get('/system/storage', async (_req, res) => {
    const level = content.viewerLevel()
    if (storage && storage.level === level && Date.now() - storage.at < 60_000) {
      res.json(storage.body)
      return
    }
    if (counting?.level !== level) {
      const body = countStorage().finally(() => {
        if (counting?.body === body) counting = null
      })
      counting = { level, body }
    }
    const body = await counting.body
    storage = { at: Date.now(), body, level }
    res.json(body)
  })
  const archiveAt = (archive: string) => {
    try {
      return safeJoin(cfg.archivesDir, cleanRelPath(archive))
    } catch {
      return null
    }
  }
  async function countStorage() {
    const games = []
    for (const g of db.allGames().filter((x) => !content.hides(x))) {
      const folders = await readdir(join(cfg.gamesDir, g.id), { withFileTypes: true }).catch(() => [])
      const builds = []
      for (const f of folders.filter((d) => d.isDirectory())) builds.push({ name: f.name, current: f.name === g.build, bytes: (await dirSize(join(cfg.gamesDir, g.id, f.name))).bytes })
      const archive = parseJson<{ archive?: string }>(g.source, {}).archive
      const at = archive ? archiveAt(archive) : null
      const st = at ? await stat(at).catch(() => null) : null
      const download = st?.isFile() ? { name: archive!, bytes: st.size } : null
      const buildBytes = builds.reduce((n, b) => n + b.bytes, 0)
      games.push({ id: g.id, title: catalog.recipe(g.recipe_id)?.title || g.title, status: g.status, builds, download, bytes: buildBytes + (download?.bytes ?? 0) })
    }
    games.sort((a, b) => b.bytes - a.bytes)
    const installed = await engines.installed()
    const used = new Set(db.allGames().filter((g) => g.status === 'installed' && g.engine).map((g) => g.engine))
    const { orphans } = await builds.verify()
    const orphanSizes = []
    for (const name of orphans) orphanSizes.push({ name, bytes: (await dirSize(join(cfg.gamesDir, name))).bytes })
    const enginesOut = installed.map((e) => ({ version: e.version, bytes: e.bytes, used: used.has(e.version) }))
    const body = {
      games,
      engines: enginesOut,
      orphans: orphanSizes,
      totals: {
        builds: games.reduce((n, g) => n + g.builds.reduce((m, b) => m + b.bytes, 0), 0),
        downloads: games.reduce((n, g) => n + (g.download?.bytes ?? 0), 0),
        engines: enginesOut.reduce((n, e) => n + e.bytes, 0),
      },
      // What Renplay can free: downloads of installed games (they can be added again), engines no game
      // uses. Folders of no game are listed, never deleted by Renplay.
      freeable: {
        downloads: games.filter((g) => g.status === 'installed').reduce((n, g) => n + (g.download?.bytes ?? 0), 0),
        engines: enginesOut.filter((e) => !e.used).reduce((n, e) => n + e.bytes, 0),
      },
    }
    return body
  }

  router.post('/system/storage/refresh', (_req, res) => {
    storage = null
    counting = null
    res.json({ ok: true })
  })

  // ---- Sync codes ------------------------------------------------------------

  router.put('/system/sync', (req, res) => {
    if (typeof req.body?.on !== 'boolean') throw new HttpError(400, 'Expected { on: true or false }')
    db.setSetting(SYNC_SETTING, req.body.on)
    res.json({ on: req.body.on })
  })

  // ---- save backups ---------------------------------------------------------

  router.get('/system/backups', async (_req, res) => {
    res.json(await backups.info())
  })

  router.post('/system/backups', async (_req, res) => {
    if (!backups.dir) throw new HttpError(409, 'Save backups are off. Set RENPLAY_BACKUP_DIR to a folder to turn them on.')
    const name = await backups.run()
    res.json({ ok: true, name, ...(await backups.info()) })
  })

  router.get('/system/backups/:name', (req, res, next) => {
    const path = backups.path(req.params.name)
    if (!path) throw new HttpError(404, 'Backup not found')
    res.download(path, req.params.name, (err) => err && next(new HttpError(404, 'Backup not found')))
  })

  router.get('/system', async (_req, res) => {
    const games = db.allGames().filter((g) => !content.hides(g))
    const used = new Map<string, string[]>()
    for (const g of games) if (g.engine && g.status === 'installed') used.set(g.engine, [...(used.get(g.engine) ?? []), g.title])
    const installed = await engines.installed()
    const available = await engines.available().catch(() => [])
    const { orphans } = await builds.verify()
    res.json({
      version,
      sync: { on: syncCodesOn(db), server: cfg.syncServer, chosen: db.getSetting<unknown>(SYNC_SETTING, null) !== null },
      // Where each value comes from: a variable on the server, or the default. No values of secrets.
      setBy: Object.fromEntries(PROVENANCE.map((name) => [name, process.env[name]?.trim() ? 'server' : 'default'])),
      keepDownloadsChosen: db.getSetting<unknown>('keep_downloads', null) !== null,
      engines: {
        installed: installed.map((e) => ({ ...e, usedBy: used.get(e.version) ?? [] })),
        available: available.map((e) => ({ version: e.version, renpy: e.renpy, bytes: Object.values(e.files).reduce((n, f) => n + f.size, 0) })),
        index: cfg.enginesUrl,
      },
      disk: { games: await disk(cfg.gamesDir), data: await disk(cfg.dataDir) },
      library: {
        games: games.length,
        installed: games.filter((g) => g.status === 'installed').length,
        bytes: games.reduce((n, g) => n + (g.size_bytes || 0), 0),
      },
      orphans,
      purging: purger.pending(),
      paths: { games: cfg.gamesDir, archives: cfg.archivesDir, data: cfg.dataDir },
      deleteArchives: !keepDownloads(cfg, db),
      keepDownloads: keepDownloads(cfg, db),
      keepDownloadsLocked: cfg.keepDownloadsLocked,
      busy: jobs.isBusy(),
    })
  })

  router.put('/system/downloads', (req, res) => {
    if (cfg.keepDownloadsLocked) throw new HttpError(409, 'Download retention is set by the server configuration')
    if (typeof req.body?.keepDownloads !== 'boolean') throw new HttpError(400, 'Keep downloads must be a boolean')
    db.setSetting('keep_downloads', req.body.keepDownloads)
    res.json({ ok: true })
  })

  /** Removes engines no installed game uses. */
  router.post('/system/prune', async (_req, res) => {
    const used = new Set(db.allGames().filter((g) => g.status === 'installed' && g.engine).map((g) => g.engine))
    res.json({ removed: await engines.prune(used) })
  })

  router.post('/system/engines/refresh', async (_req, res) => {
    res.json({ engines: (await engines.available(true)).map((e) => e.version) })
  })

  // ---- jobs ---------------------------------------------------------------

  router.get('/jobs', (req, res) => {
    const pageNumber = (value: unknown, fallback: number): number => {
      if (typeof value !== 'string' || !/^\d+$/.test(value)) return fallback
      const n = Number(value)
      return Number.isSafeInteger(n) ? n : fallback
    }
    const limit = Math.max(1, Math.min(200, pageNumber(req.query['limit'], 30)))
    const offset = pageNumber(req.query['offset'], 0)
    // Off: hidden jobs are left out before paging, so pages, the total and busy only count what this person may see.
    const visible = content.viewerLevel() === 'off' ? db.listJobs(Number.MAX_SAFE_INTEGER, 0).filter((j) => !catalog.jobHidden(j)) : null
    const page = visible ? visible.slice(offset, offset + limit) : db.listJobs(limit, offset)
    res.json({
      jobs: page.map((j) => ({
        id: j.id,
        type: j.type,
        game: j.game,
        status: j.status,
        stage: j.stage,
        progress: j.progress,
        message: j.message,
        error: j.error || null,
        params: safeParams(j.params),
        result: j.status === 'done' ? safeJson(j.result) : null,
        createdAt: j.created_at,
        startedAt: j.started_at || null,
        finishedAt: j.finished_at || null,
      })),
      busy: visible ? visible.some((j) => j.status === 'running') : jobs.isBusy(),
      total: visible ? visible.length : db.countJobs(),
    })
  })

  /** The job, unless it belongs to a game that does not exist for this person. */
  const visibleJob = (id: string) => {
    const j = db.getJob(id)
    if (!j || catalog.jobHidden(j)) throw new HttpError(404, 'Job not found')
    return j
  }

  router.get('/jobs/:id/log', (req, res) => {
    const j = visibleJob(req.params.id)
    res.type('text/plain').send(jobs.getLog(j.id))
  })

  router.post('/jobs/:id/cancel', (req, res) => {
    visibleJob(req.params.id)
    if (!jobs.cancel(req.params.id)) throw new HttpError(409, 'Job is not running or queued')
    res.json({ ok: true })
  })

  router.post('/jobs/:id/retry', (req, res) => {
    visibleJob(req.params.id)
    const id = jobs.retry(req.params.id)
    if (!id) throw new HttpError(409, 'Job cannot be retried')
    res.json({ jobId: id })
  })

  router.delete('/jobs', (_req, res) => {
    // An admin at Off clears what they can see. The jobs about hidden games stay.
    jobs.clearFinished(content.viewerLevel() === 'off' ? (j) => catalog.jobHidden(j) : undefined)
    res.json({ ok: true })
  })

  return router
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

function safeParams(s: string): unknown {
  const p = safeJson(s) as Record<string, any> | null
  if (!p) return null
  return { source: p.source, game: p.game, path: p.path, by: typeof p.by === 'number' ? p.by : undefined }
}
