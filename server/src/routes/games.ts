import { Router, type Request, type Response } from 'express'
import type { Database, GameRow } from '../db/index.js'
import { param } from './v1.js'

export function createGamesRouter(db: Database): Router {
  const router = Router()

  router.get('/', (_req, res) => {
    const rows = db.allGames()
    const games = rows.map(toGame)
    res.json({ games })
  })

  router.get('/:slug', (req, res) => {
    const slug = param(req.params.slug)
    const row = db.getGame(slug)
    if (!row) {
      res.status(404).json({ error: 'Game not found' })
      return
    }
    res.json({ game: toGame(row) })
  })

  router.put('/:slug', async (req, res) => {
    const slug = param(req.params.slug)
    const { title, tags } = req.body

    const updates: Partial<GameRow> = {}
    if (title !== undefined) updates.title = title
    if (tags !== undefined) updates.tags = JSON.stringify(Array.isArray(tags) ? tags : [])

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ error: 'No fields to update' })
      return
    }

    const ok = db.updateGame(slug, updates)
    if (!ok) {
      res.status(404).json({ error: 'Game not found' })
      return
    }
    await db.save()

    const updated = db.getGame(slug)
    res.json({ ok: true, game: updated ? toGame(updated) : null })
  })

  router.delete('/:slug', async (req, res) => {
    const slug = param(req.params.slug)
    const ok = db.deleteGame(slug)
    if (!ok) {
      res.status(404).json({ error: 'Game not found' })
      return
    }
    await db.save()
    res.json({ ok: true })
  })

  router.post('/:slug/move', async (req, res) => {
    const slug = param(req.params.slug)
    const { direction } = req.body
    const game = db.getGame(slug)
    if (!game) {
      res.status(404).json({ error: 'Game not found' })
      return
    }

    let neighbor: GameRow | null = null
    if (direction === 'up') {
      neighbor = db.getGameAbove(game.sort_order)
    } else if (direction === 'down') {
      neighbor = db.getGameBelow(game.sort_order)
    } else {
      res.status(400).json({ error: 'Invalid direction, use "up" or "down"' })
      return
    }

    if (!neighbor) {
      res.json({ ok: true })
      return
    }

    db.updateGame(slug, { sort_order: neighbor.sort_order })
    db.updateGame(neighbor.slug, { sort_order: game.sort_order })
    await db.save()

    res.json({ ok: true })
  })

  return router
}

function toGame(row: GameRow) {
  return {
    slug: row.slug,
    title: row.title,
    tags: JSON.parse(row.tags || '[]'),
    thumbnail: row.thumbnail || undefined,
  }
}


