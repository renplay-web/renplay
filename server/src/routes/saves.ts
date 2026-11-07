import express, { Router, type Request } from 'express'
import { readFile } from 'node:fs/promises'
import sharp from 'sharp'
import { rgbaToThumbHash } from 'thumbhash'
import { saveImport } from '../saves/import-upload.js'
import { viewer } from '../accounts-context.js'
import type { ContentMode } from '../content.js'
import type { Db, GameRow } from '../db.js'
import { readSaveMeta, readSaveScreenshot, slotInfo } from '../saves/savefile.js'
import type { SaveStore } from '../saves/store.js'
import { downloadSync, uploadSync } from '../saves/sync.js'
import { sha1 } from '../util/fsx.js'
import { HttpError, assertSlug, cleanRelPath, isSaveDirName } from '../util/paths.js'

/** Metadata cache shared with the library, keyed by store/dir/name/mtime/size. */
const metaCache = new Map<string, Awaited<ReturnType<typeof readSaveMeta>>>()

export async function cachedSaveMeta(store: SaveStore, dir: string, file: { name: string; mtimeMs: number; size: number }) {
  const key = `${store.root}/${dir}/${file.name}/${file.mtimeMs}/${file.size}`
  let meta = metaCache.get(key)
  if (meta === undefined) {
    meta = await readSaveMeta(await store.read(dir, file.name))
    metaCache.set(key, meta)
    if (metaCache.size > 5000) metaCache.delete(metaCache.keys().next().value!)
  }
  return meta
}

/** Scene hashes (thumbhash) of save pictures, keyed like the metadata. */
const hashCache = new Map<string, string | null>()

/**
 * A save picture as a thumbhash: a few dozen bytes that draw only a soft blur of its colours. Sent at
 * the Blurred level instead of the picture, the way art below Shown carries only its hash.
 */
export async function cachedSceneHash(store: SaveStore, dir: string, file: { name: string; mtimeMs: number; size: number }): Promise<string | null> {
  const key = `${store.root}/${dir}/${file.name}/${file.mtimeMs}/${file.size}`
  let hash = hashCache.get(key)
  if (hash === undefined) {
    hash = null
    try {
      const png = await readSaveScreenshot(await store.read(dir, file.name))
      if (png) {
        const { data, info } = await sharp(png).resize(100, 100, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
        hash = Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString('base64')
      }
    } catch {}
    hashCache.set(key, hash)
    if (hashCache.size > 5000) hashCache.delete(hashCache.keys().next().value!)
  }
  return hash
}

/** Sync codes are off until an admin turns them on: saves leave the server only then, and only when someone asks. */
export const syncCodesOn = (db: Db): boolean => db.getSetting<boolean>(SYNC_SETTING, false) === true
export const SYNC_SETTING = 'renpy_sync'

export function createSavesRouter(store: SaveStore, db: Db, content: ContentMode, syncServer = 'https://sync.renpy.org'): Router {
  const router = Router({ caseSensitive: true, strict: true })

  const game = (req: Request): GameRow => {
    const g = db.getGame(assertSlug(req.params.id))
    if (!g || content.hides(g)) throw new HttpError(404, 'Game not found')
    return g
  }
  const allowedDir = (dir: string): boolean => {
    if (dir === 'tokens' || dir === 'persistent') return true
    const games = db.allGames().filter((g) => g.save_dir === dir)
    // Restricted users may not discover an unclassified folder through another game's runtime.
    return games.length ? games.some((g) => !content.hides(g)) : !content.hides({ adult: 0, recipe_id: '' })
  }
  /** A deleted save's name, note and pin go with it, so a new save in the slot starts clean. */
  const forgetMeta = (dir: string, file: string) => {
    db.raw.prepare('DELETE FROM save_meta WHERE user_id = ? AND save_dir = ? AND file = ?').run(viewer()?.user.id ?? 1, dir, file)
  }

  const requireSaveDir = (g: GameRow): string => {
    if (!g.save_dir) throw new HttpError(409, 'The save folder of this game is not known yet. Start the game once, or set it in the game settings.')
    return g.save_dir
  }

  /**
   * Everything the in-game runtime needs before Ren'Py starts. ~/.renpy is one
   * central tree shared by all games, like on desktop: this game's save folder
   * and the shared folders come with their contents, every other folder only
   * as a listing (the runtime fetches those files if a game opens them).
   */
  router.get('/:id/boot', async (req, res) => {
    const g = game(req)
    const files: Array<{ path: string; data: string; mtime: number }> = []
    const lazy: Array<{ path: string; size: number; mtime: number }> = []
    if (g.save_dir) {
      for (const f of await store.list(g.save_dir)) {
        files.push({ path: `${g.save_dir}/${f.name}`, data: (await store.read(g.save_dir, f.name)).toString('base64'), mtime: f.mtimeMs })
      }
    }
    for (const t of await store.sharedFiles()) files.push({ path: t.name, data: t.data.toString('base64'), mtime: t.mtimeMs })
    for (const dir of await store.listDirs()) {
      if (dir === g.save_dir || !allowedDir(dir)) continue
      for (const f of await store.list(dir)) lazy.push({ path: `${dir}/${f.name}`, size: f.size, mtime: f.mtimeMs })
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json({ saveDir: g.save_dir || null, files, lazy, serverTime: Date.now() })
  })

  /**
   * Resolves a ~/.renpy-relative path to (folder, name). Any folder is allowed:
   * games read and write each other's folders like on desktop. The game's own
   * folder is only learned from config.save_directory (POST /save-dir), never
   * guessed from paths, since a write may belong to another game's folder.
   */
  const resolvePath = (_g: GameRow, raw: unknown): { dir: string; name: string } => {
    const rel = cleanRelPath(raw)
    const slash = rel.indexOf('/')
    if (slash === -1) throw new HttpError(400, 'Path must be inside a save folder')
    const top = rel.slice(0, slash)
    const name = rel.slice(slash + 1)
    if (!allowedDir(top)) throw new HttpError(404, 'Save folder not found')
    if (!isSaveDirName(top)) throw new HttpError(400, 'Invalid save folder')
    return { dir: top, name }
  }

  /** Raw read of any file in the central tree (lazy files in the runtime). */
  router.get('/:id/raw', async (req, res) => {
    game(req)
    const rel = cleanRelPath(req.query['path'])
    const slash = rel.indexOf('/')
    if (slash === -1) throw new HttpError(400, 'Invalid path')
    if (!allowedDir(rel.slice(0, slash))) throw new HttpError(404, 'Save folder not found')
    const data = await store.read(rel.slice(0, slash), rel.slice(slash + 1))
    res.setHeader('Cache-Control', 'no-store')
    // The version sent, so a device that loads it knows what it saw.
    res.setHeader('X-Renplay-Mtime', String((await store.stat(rel.slice(0, slash), rel.slice(slash + 1)))?.mtimeMs ?? 0))
    res.type('application/octet-stream').send(data)
  })

  router.put('/:id/file', express.raw({ type: () => true, limit: '64mb' }), async (req, res) => {
    const g = game(req)
    const { dir, name } = resolvePath(g, req.query['path'])
    const body = req.body as Buffer
    if (!Buffer.isBuffer(body)) throw new HttpError(400, 'Expected a binary body')
    const mtime = Number(req.header('x-mtime')) || undefined
    // The version the device last saw, for the conflict rule. Older runtimes send none.
    const rawBase = req.header('x-base')
    const base = rawBase !== undefined && /^\d+$/.test(rawBase) ? Number(rawBase) : undefined
    const rawUnanswered = req.header('x-unanswered')
    const unanswered = rawUnanswered && /^[0-9a-f]{1,8}:\d{1,9}$/.test(rawUnanswered) ? rawUnanswered : undefined
    const f = await store.write(dir, name, body, { mtimeMs: mtime, reason: 'game', base, unanswered })
    res.json({ ok: true, size: f.size, mtime: f.mtimeMs, sha1: sha1(body), ...(f.conflict ? { conflict: f.conflict } : {}) })
  })

  router.delete('/:id/file', async (req, res) => {
    const g = game(req)
    const { dir, name } = resolvePath(g, req.query['path'])
    const rawBase = req.header('x-base')
    const base = rawBase !== undefined && /^\d+$/.test(rawBase) ? Number(rawBase) : undefined
    const removed = await store.remove(dir, name, 'game-delete', base)
    // Another device saved it since this one last saw it: the save stays, and the device loads it.
    if (removed === 'changed') {
      res.status(409).json({ conflict: 'kept', mtime: (await store.stat(dir, name))?.mtimeMs ?? 0 })
      return
    }
    if (removed && name.endsWith('.save') && !name.includes('/')) forgetMeta(dir, name)
    res.json({ ok: true })
  })

  /** Reported by the runtime after Ren'Py starts (config.save_directory). */
  router.post('/:id/save-dir', async (req, res) => {
    const g = game(req)
    const sd = req.body?.saveDir
    if (!isSaveDirName(sd) || sd === 'tokens' || sd === 'persistent') throw new HttpError(400, 'Invalid save folder')
    if (sd !== g.save_dir) {
      // Reporting a folder must not relabel a hidden game's (or an orphaned) saves as safe.
      const existing = db.allGames().filter((other) => other.id !== g.id && other.save_dir === sd)
      if (existing.some((other) => content.hides(other)) || (!existing.length && !allowedDir(sd) && (await store.list(sd)).length)) throw new HttpError(404, 'Save folder not found')
    }
    let changed = false
    if (g.save_dir !== sd) {
      db.updateGame(g.id, { save_dir: sd })
      changed = true
    }
    const screen = req.body?.screen
    if (Array.isArray(screen) && screen.length === 2 && screen.every((n: unknown) => Number.isInteger(n) && (n as number) > 0 && (n as number) < 20000)) {
      if (g.screen_w !== screen[0] || g.screen_h !== screen[1]) db.updateGame(g.id, { screen_w: screen[0], screen_h: screen[1] })
    }
    res.json({ ok: true, changed, saveDir: changed ? sd : g.save_dir })
  })

  /** Save slots with metadata for the save browser. */
  router.get('/:id', async (req, res) => {
    const g = game(req)
    if (!g.save_dir) {
      res.json({ saveDir: null, slots: [], other: [], conflicts: [] })
      return
    }
    const files = await store.list(g.save_dir)
    const user = viewer()?.user.id ?? 1
    const notes = new Map((db.raw.prepare('SELECT file, title, note, pinned_at FROM save_meta WHERE user_id = ? AND save_dir = ?').all(user, g.save_dir) as Array<{ file: string; title: string; note: string; pinned_at: string }>).map((r) => [r.file, r]))
    const slots = []
    const other = []
    for (const f of files) {
      if (!f.name.endsWith('.save') || f.name.includes('/')) {
        other.push({ name: f.name, size: f.size, mtime: f.mtimeMs })
        continue
      }
      const info = slotInfo(f.name)
      const meta = await cachedSaveMeta(store, g.save_dir, f)
      slots.push({
        file: f.name,
        size: f.size,
        mtime: f.mtimeMs,
        kind: info.kind,
        label: info.label,
        page: info.page,
        slot: info.slot,
        name: meta?.name ?? '',
        ctime: meta?.ctime ? meta.ctime * 1000 : f.mtimeMs,
        renpyVersion: meta?.renpyVersion,
        gameVersion: meta?.gameVersion,
        runtime: meta?.runtime,
        // Blurred: the save's picture is the adult game's art and never leaves the server.
        screenshot: meta?.hasScreenshot && !content.blurs(g) ? `/api/saves/${g.id}/screenshot?user=${viewer()?.user.id ?? 1}&file=${encodeURIComponent(f.name)}&v=${f.mtimeMs}` : null,
        screenshotHash: meta?.hasScreenshot && content.blurs(g) ? await cachedSceneHash(store, g.save_dir, f) : null,
        valid: !!meta,
        title: notes.get(f.name)?.title || null,
        note: notes.get(f.name)?.note || null,
        pinnedAt: notes.get(f.name)?.pinned_at || null,
      })
    }
    slots.sort((a, b) => b.ctime - a.ctime)
    // Second versions the conflict rule kept in History during the last two weeks.
    const conflicts = await store.conflicts(g.save_dir, Date.now() - 14 * 24 * 3600_000)
    res.json({ saveDir: g.save_dir, slots, other, conflicts, sync: g.family === 'renpy' && syncCodesOn(db) })
  })

  // ---- Ren'Py Sync codes ------------------------------------------------------

  const syncGame = (req: Request): string => {
    const g = game(req)
    if (!syncCodesOn(db)) throw new HttpError(409, 'Sync codes are off. An admin can turn them on in Settings.')
    if (g.family !== 'renpy') throw new HttpError(409, 'Sync codes are for Ren’Py games.')
    return requireSaveDir(g)
  }

  /** Sends this person's saves of the game to Ren'Py's sync server and returns the code. */
  router.post('/:id/sync', async (req, res) => {
    res.json(await uploadSync(syncServer, store, syncGame(req), typeof req.body?.tz === 'string' ? req.body.tz : undefined))
  })

  /** Fetches the saves for a code made on another device. */
  router.post('/:id/sync/download', async (req, res) => {
    res.json(await downloadSync(syncServer, store, syncGame(req), req.body?.code))
  })

  /** A save's name, note and pin for this person. The save file itself is not touched. */
  router.put('/:id/meta', (req, res) => {
    const g = game(req)
    const saveDir = requireSaveDir(g)
    const file = cleanRelPath(req.query['file'])
    if (!file.endsWith('.save') || file.includes('/')) throw new HttpError(400, 'Choose a save file')
    const b = req.body ?? {}
    for (const [key, max] of [['title', 80], ['note', 500]] as const) {
      if (b[key] !== undefined && (typeof b[key] !== 'string' || b[key].length > max)) throw new HttpError(400, `The ${key === 'title' ? 'name' : 'note'} is text of up to ${max} characters`)
    }
    if (b.pinned !== undefined && typeof b.pinned !== 'boolean') throw new HttpError(400, 'Pinned must be true or false')
    const user = viewer()?.user.id ?? 1
    const row = (db.raw.prepare('SELECT title, note, pinned_at FROM save_meta WHERE user_id = ? AND save_dir = ? AND file = ?').get(user, saveDir, file) as { title: string; note: string; pinned_at: string } | undefined) ?? { title: '', note: '', pinned_at: '' }
    const next = {
      title: b.title !== undefined ? b.title.trim() : row.title,
      note: b.note !== undefined ? b.note.trim() : row.note,
      pinned_at: b.pinned === undefined ? row.pinned_at : b.pinned ? row.pinned_at || new Date().toISOString() : '',
    }
    if (!next.title && !next.note && !next.pinned_at) db.raw.prepare('DELETE FROM save_meta WHERE user_id = ? AND save_dir = ? AND file = ?').run(user, saveDir, file)
    else db.raw.prepare('INSERT INTO save_meta (user_id, save_dir, file, title, note, pinned_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (user_id, save_dir, file) DO UPDATE SET title = excluded.title, note = excluded.note, pinned_at = excluded.pinned_at').run(user, saveDir, file, next.title, next.note, next.pinned_at)
    res.json({ ok: true, title: next.title || null, note: next.note || null, pinnedAt: next.pinned_at || null })
  })

  router.get('/:id/screenshot', async (req, res) => {
    const g = game(req)
    if (content.blurs(g)) throw new HttpError(404, 'No screenshot')
    const name = cleanRelPath(req.query['file'])
    const png = await readSaveScreenshot(await store.read(requireSaveDir(g), name))
    if (!png) throw new HttpError(404, 'No screenshot')
    if (req.query['user'] !== undefined && req.query['user'] !== String(viewer()?.user.id ?? 1)) throw new HttpError(404, 'Screenshot not found')
    res.setHeader('Cache-Control', 'private, no-store')
    res.type('png').send(png)
  })

  router.get('/:id/download', async (req, res) => {
    const g = game(req)
    const name = cleanRelPath(req.query['file'])
    const data = await store.read(requireSaveDir(g), name)
    res.attachment(name.split('/').pop()!)
    res.type('application/octet-stream').send(data)
  })

  router.delete('/:id/slot', async (req, res) => {
    const g = game(req)
    const file = cleanRelPath(req.query['file'])
    const ok = await store.remove(requireSaveDir(g), file, 'user-delete')
    if (!ok) throw new HttpError(404, 'Save not found')
    forgetMeta(requireSaveDir(g), file)
    res.json({ ok: true })
  })

  router.get('/:id/export', async (req, res) => {
    const g = game(req)
    const dir = requireSaveDir(g)
    res.attachment(`${g.id}-saves-${new Date().toISOString().slice(0, 10)}.zip`)
    res.type('application/zip')
    await store.exportZip([dir], res, { includeTokens: req.query['tokens'] === '1' })
  })

  router.post('/:id/import', saveImport('files', async (req, res) => {
    const g = game(req)
    const dir = requireSaveDir(g)
    const files = (req.files as Express.Multer.File[] | undefined) ?? []
    if (!files.length) throw new HttpError(400, 'No files uploaded')
    // Process one bounded file at a time, never materialize the multipart request in memory.
    const report = { imported: [] as string[], skipped: [] as Array<{ name: string; reason: string }>, trustedKeys: 0 }
    for (const f of files) {
      const part = await store.importFiles(dir, [{ filename: Buffer.from(f.originalname, 'latin1').toString('utf-8'), data: await readFile(f.path) }])
      report.imported.push(...part.imported); report.skipped.push(...part.skipped); report.trustedKeys += part.trustedKeys
    }
    res.json(report)
  }))

  /** Copies a save to another game (e.g. carry the end of season 1 into season 2). */
  router.post('/:id/copy', async (req, res) => {
    const g = game(req)
    const target = db.getGame(assertSlug(req.body?.target))
    if (!target || content.hides(target)) throw new HttpError(404, 'Target game not found')
    const toDir = requireSaveDir(target)
    const name = await store.copySave(requireSaveDir(g), cleanRelPath(req.body?.file), toDir)
    res.json({ ok: true, file: name, target: target.id })
  })

  router.get('/:id/history', async (req, res) => {
    const g = game(req)
    const name = typeof req.query['file'] === 'string' ? cleanRelPath(req.query['file']) : undefined
    res.json({ versions: await store.history(requireSaveDir(g), name) })
  })

  router.post('/:id/history/restore', async (req, res) => {
    const g = game(req)
    const id = req.body?.id
    if (typeof id !== 'string') throw new HttpError(400, 'Missing version id')
    const f = await store.restoreVersion(requireSaveDir(g), id)
    res.json({ ok: true, file: f })
  })

  return router
}

/** All save folders (including ones without a game) as one zip. */
export function createSavesExportAll(store: SaveStore, db: Db, content: ContentMode) {
  return async (_req: Request, res: express.Response) => {
    // The export is of what this person may see. Hidden games' saves stay where they are.
    const dirs = new Set(content.visibleSaveDirs([...await store.listDirs(), ...db.allGames().map((g) => g.save_dir).filter(Boolean)]))
    res.attachment(`renplay-saves-${new Date().toISOString().slice(0, 10)}.zip`)
    res.type('application/zip')
    await store.exportZip([...dirs], res, { includeTokens: true })
  }
}
