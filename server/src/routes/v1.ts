import { Router, type Request, type Response } from 'express'
import multer from 'multer'
import { unlink } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from '../db/index.js'

const MB = 1024 * 1024

export function createV1Router(db: Database, thumbnailsDir: string, gamesDir: string): Router {
  const router = Router()

  const upload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        mkdirSync(thumbnailsDir, { recursive: true })
        cb(null, thumbnailsDir)
      },
      filename: (req, file, cb) => {
        const slug = param(req.params.slug)
        const ext = file.mimetype.split('/')[1] || 'jpg'
        cb(null, `${slug}.${ext}`)
      },
    }),
    limits: { fileSize: 10 * MB, files: 1 },
    fileFilter: (_req, file, cb) => {
      const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
      if (allowed.includes(file.mimetype)) {
        cb(null, true)
      } else {
        cb(new Error(`Unsupported image type: ${file.mimetype}`))
      }
    },
  })

  const walkthroughUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => {
        const walkthroughsDir = join(thumbnailsDir, '..', 'walkthroughs')
        mkdirSync(walkthroughsDir, { recursive: true })
        cb(null, walkthroughsDir)
      },
      filename: (req, _file, cb) => {
        const slug = param(req.params.slug)
        cb(null, `${slug}.pdf`)
      },
    }),
    limits: { fileSize: 50 * MB, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === 'application/pdf') {
        cb(null, true)
      } else {
        cb(new Error('Only PDF files are allowed'))
      }
    },
  })

  router.post('/scan-library', async (req: Request, res: Response) => {
    const result = await db.scanLibrary(gamesDir)
    await db.save()
    res.json({ ok: true, ...result })
  })

  router.post('/games/:slug/thumbnail', (req: Request, res: Response) => {
    upload.single('thumbnail')(req, res, async (err) => {
      if (err) {
        const message = err instanceof multer.MulterError ? err.message : err.message
        res.status(400).json({ error: message })
        return
      }

      const slug = param(req.params.slug)
      const game = db.getGame(slug)
      if (!game) {
        res.status(404).json({ error: 'Game not found' })
        return
      }

      const file = req.file
      if (!file) {
        res.status(400).json({ error: 'No file uploaded' })
        return
      }

      if (game.thumbnail) {
        try { await unlink(join(thumbnailsDir, game.thumbnail)) } catch {}
      }

      db.updateGame(slug, { thumbnail: file.filename } as any)
      await db.save()

      res.json({ ok: true, thumbnail: file.filename })
    })
  })

  router.put('/games/reorder', async (req: Request, res: Response) => {
    const { slugs } = req.body
    if (!Array.isArray(slugs) || slugs.length === 0) {
      res.status(400).json({ error: 'slugs array is required' })
      return
    }
    db.reorderGames(slugs)
    await db.save()
    res.json({ ok: true })
  })

  router.delete('/games/:slug/thumbnail', async (req: Request, res: Response) => {
    const slug = param(req.params.slug)
    const game = db.getGame(slug)
    if (!game) {
      res.status(404).json({ error: 'Game not found' })
      return
    }

    if (game.thumbnail) {
      try {
        await unlink(join(thumbnailsDir, game.thumbnail))
      } catch {}
    }

    db.updateGame(slug, { thumbnail: '' } as any)
    await db.save()

    res.json({ ok: true })
  })

  router.post('/games/:slug/walkthrough', (req: Request, res: Response) => {
    walkthroughUpload.single('walkthrough')(req, res, async (err) => {
      if (err) {
        const message = err instanceof multer.MulterError ? err.message : err.message
        res.status(400).json({ error: message })
        return
      }

      const slug = param(req.params.slug)
      const game = db.getGame(slug)
      if (!game) {
        res.status(404).json({ error: 'Game not found' })
        return
      }

      const file = req.file
      if (!file) {
        res.status(400).json({ error: 'No file uploaded' })
        return
      }

      const walkthroughsDir = join(thumbnailsDir, '..', 'walkthroughs')
      if (game.walkthrough) {
        try { await unlink(join(walkthroughsDir, game.walkthrough)) } catch {}
      }

      db.updateGame(slug, { walkthrough: file.filename } as any)
      await db.save()

      res.json({ ok: true, walkthrough: file.filename })
    })
  })

  router.delete('/games/:slug/walkthrough', async (req: Request, res: Response) => {
    const slug = param(req.params.slug)
    const game = db.getGame(slug)
    if (!game) {
      res.status(404).json({ error: 'Game not found' })
      return
    }

    const walkthroughsDir = join(thumbnailsDir, '..', 'walkthroughs')
    if (game.walkthrough) {
      try {
        await unlink(join(walkthroughsDir, game.walkthrough))
      } catch {}
    }

    db.updateGame(slug, { walkthrough: '' } as any)
    await db.save()

    res.json({ ok: true })
  })

  return router
}

export function param(val: string | string[] | undefined): string {
  return Array.isArray(val) ? val[0]! : val ?? ''
}
