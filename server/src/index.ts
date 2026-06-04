import express from 'express'
import { createSavesRouter } from './routes/saves.js'
import { createGamesRouter } from './routes/games.js'
import { createV1Router } from './routes/v1.js'
import { mkdir } from 'node:fs/promises'
import { FsStorage } from './saves/fs.js'
import { Database } from './db/index.js'

const PORT = parseInt(process.env['PORT'] || '3000', 10)
const SAVES_DIR = process.env['SAVES_DIR'] || '/data/saves'
const DATA_DIR = process.env['DATA_DIR'] || '/data'
const GAMES_DIR = process.env['GAMES_DIR'] || '/games'

async function main() {
  const db = await Database.open(DATA_DIR)

  await mkdir(`${DATA_DIR}/thumbnails`, { recursive: true })
  await mkdir(`${DATA_DIR}/walkthroughs`, { recursive: true })

  const app = express()
  app.use(express.json({ limit: '50mb' }))

  const saveStorage = new FsStorage(SAVES_DIR)
  app.use('/api/saves', createSavesRouter(saveStorage, db))

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() })
  })

  app.use('/api/games', createGamesRouter(db))

  app.use('/api/v1', createV1Router(db, `${DATA_DIR}/thumbnails`, GAMES_DIR))

  app.get('/api/saves/sync-client.js', (_req, res) => {
    res.type('text/javascript').send('// served by nginx directly')
  })

  // Scan games on startup
  const scanResult = await db.scanLibrary(GAMES_DIR)
  if (scanResult.created.length > 0) {
    console.log(`Auto-scanned ${scanResult.created.length} new game(s): ${scanResult.created.join(', ')}`)
  }
  await db.save()

  app.listen(PORT, () => {
    console.log(`server listening on port ${PORT}`)
    console.log(`  SAVES_DIR=${SAVES_DIR}`)
    console.log(`  DATA_DIR=${DATA_DIR}`)
    console.log(`  GAMES_DIR=${GAMES_DIR}`)
  })
}

main().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
