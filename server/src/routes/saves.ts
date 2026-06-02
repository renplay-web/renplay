import { Router } from 'express'
import type { SaveData, FsStorage } from '../saves/fs.js'

export function createSavesRouter(storage: FsStorage): Router {
  const router = Router()

  router.get('/:gameId', async (req, res) => {
    const safeGame = req.params['gameId']!.replace(/[^a-zA-Z0-9._-]/g, '_')

    const data = await storage.getSaves(safeGame)
    if (!data) {
      res.json({ entries: [] })
      return
    }
    res.json(data)
  })

  function handlePut(req: any, res: any) {
    const safeGame = req.params['gameId']!.replace(/[^a-zA-Z0-9._-]/g, '_')

    const body = req.body as SaveData
    if (!body || !Array.isArray(body.entries)) {
      res.status(400).json({ error: 'Invalid save data' })
      return
    }

    storage.putSaves(safeGame, body).then(() => {
      res.json({ ok: true })
    })
  }

  router.put('/:gameId', handlePut)
  router.post('/:gameId', handlePut)

  return router
}
