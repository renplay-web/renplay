import express from 'express'
import { createSavesRouter } from './routes/saves.js'
import { createGamesRouter } from './routes/games.js'
import { FsStorage } from './storage/fs.js'
import { Database } from './storage/db.js'

const PORT = parseInt(process.env['PORT'] || '3000', 10)
const SAVES_DIR = process.env['SAVES_DIR'] || '/data/saves'
const DATA_DIR = process.env['DATA_DIR'] || '/data'

async function main() {
  const db = await Database.open(DATA_DIR)

  const app = express()
  app.use(express.json({ limit: '50mb' }))

  const saveStorage = new FsStorage(SAVES_DIR)
  app.use('/api/saves', createSavesRouter(saveStorage))

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() })
  })

  app.use('/api/games', createGamesRouter(db))

  app.get('/api/saves/sync-client.js', (_req, res) => {
    res.type('text/javascript').send('// served by nginx directly')
  })

  app.listen(PORT, () => {
    console.log(`save-sync listening on port ${PORT}`)
    console.log(`  SAVES_DIR=${SAVES_DIR}`)
    console.log(`  DATA_DIR=${DATA_DIR}`)
  })
}

main().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
