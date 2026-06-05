import { Router } from 'express'
import type { SaveData, FsStorage } from '../saves/fs.js'
import type { Database } from '../db/index.js'

export function createSavesRouter(storage: FsStorage, db: Database): Router {
  const router = Router()

  function resolveSaveDir(gameSlug: string): string | null {
    const game = db.getGame(gameSlug)
    if (!game || !game.save_dir) return null
    return game.save_dir
  }

  router.get('/:gameId', async (req, res) => {
    const safeGame = req.params['gameId']!.replace(/[^a-zA-Z0-9._-]/g, '_')
    const saveDir = resolveSaveDir(safeGame)

    const data = await storage.getSaves(saveDir)
    if (!data) {
      res.json({ entries: [] })
      return
    }
    res.json(data)
  })

  async function handlePut(req: any, res: any) {
    const safeGame = req.params['gameId']!.replace(/[^a-zA-Z0-9._-]/g, '_')
    const saveDir = resolveSaveDir(safeGame)

    const body = req.body as SaveData
    if (!body || !Array.isArray(body.entries)) {
      res.status(400).json({ error: 'Invalid save data' })
      return
    }

    try {
      await storage.putSaves(saveDir, body)
      res.json({ ok: true })
    } catch (err) {
      console.error('Failed to write saves:', err)
      res.status(500).json({ error: 'Failed to save' })
    }
  }

  router.put('/:gameId', handlePut)
  router.post('/:gameId', handlePut)

  return router
}
