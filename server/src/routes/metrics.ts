import { Router } from 'express'
import { readdir, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { viewer } from '../accounts-context.js'
import type { SaveBackups } from '../backups.js'
import type { Catalog } from '../catalog.js'
import type { Config } from '../config.js'
import type { ContentMode } from '../content.js'
import type { Db } from '../db.js'
import type { JobManager } from '../jobs.js'

/*
 * For dashboards. /api/metrics is the Prometheus text format, for admins: counts about the whole
 * server, never a game's title. /api/widget is JSON for Homepage's custom API widget and the like,
 * for anyone, about the library and the person asking, with their adult level applied. Both take a
 * personal access token (Account, Access tokens) as a bearer token, so a dashboard needs no other
 * secret.
 */

/** Save files per person, counted at most once a minute. */
let saveCount: { at: number; n: number } | null = null
async function countSaves(dataDir: string): Promise<number> {
  if (saveCount && Date.now() - saveCount.at < 60_000) return saveCount.n
  let n = 0
  const users = join(dataDir, 'users')
  for (const user of await readdir(users).catch(() => [] as string[])) {
    for (const dir of await readdir(join(users, user, 'saves')).catch(() => [] as string[])) {
      n += (await readdir(join(users, user, 'saves', dir)).catch(() => [] as string[])).filter((f) => f.endsWith('.save')).length
    }
  }
  saveCount = { at: Date.now(), n }
  return n
}

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

export function createMetricsRouter(cfg: Config, db: Db, jobs: JobManager, catalog: Catalog, backups: SaveBackups, content: ContentMode, version: string): Router {
  const router = Router()

  router.get('/metrics', async (_req, res) => {
    const lines: string[] = []
    const metric = (name: string, type: 'gauge' | 'counter', help: string, values: Array<[Record<string, string>, number]>) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`)
      for (const [labels, value] of values) {
        const l = Object.entries(labels).map(([k, v]) => `${k}="${esc(v)}"`).join(',')
        lines.push(`${name}${l ? `{${l}}` : ''} ${Number.isFinite(value) ? value : 0}`)
      }
    }
    const games = db.allGames()
    const byStatus = new Map<string, number>()
    for (const g of games) byStatus.set(g.status, (byStatus.get(g.status) ?? 0) + 1)
    const jobRows = db.raw.prepare("SELECT status, COUNT(*) n FROM jobs WHERE status IN ('running', 'queued') GROUP BY status").all() as Array<{ status: string; n: number }>
    const play = db.raw.prepare('SELECT COUNT(*) n, COALESCE(SUM(seconds), 0) s FROM play_sessions').get() as { n: number; s: number }
    const people = db.raw.prepare('SELECT COUNT(*) n FROM users WHERE disabled = 0').get() as { n: number }
    const backup = await backups.info()
    const status = catalog.status()
    metric('renplay_info', 'gauge', 'Renplay version.', [[{ version }, 1]])
    metric('renplay_games', 'gauge', 'Games in the library by status.', [...byStatus].map(([s, n]) => [{ status: s }, n]))
    metric('renplay_people', 'gauge', 'People with an account that is not disabled.', [[{}, people.n]])
    metric('renplay_jobs', 'gauge', 'Installs and other jobs running or waiting.', ['running', 'queued'].map((s) => [{ status: s }, jobRows.find((r) => r.status === s)?.n ?? 0]))
    metric('renplay_save_files', 'gauge', 'Save files across everyone.', [[{}, await countSaves(cfg.dataDir)]])
    metric('renplay_play_sessions_total', 'counter', 'Play sessions recorded.', [[{}, play.n]])
    metric('renplay_play_seconds_total', 'counter', 'Seconds played, across everyone.', [[{}, play.s]])
    metric('renplay_catalog_recipes', 'gauge', 'Recipes in the catalog.', [[{}, status.count]])
    metric('renplay_catalog_updated_seconds', 'gauge', 'When the catalog was last updated, in Unix seconds.', [[{}, Math.floor(status.fetchedAt / 1000)]])
    metric('renplay_backup_last_seconds', 'gauge', 'When the last save backup was written, in Unix seconds (0 for none).', [[{}, backup.last ? Math.floor(backup.last / 1000) : 0]])
    const disks: Array<[Record<string, string>, number]> = []
    const sizes: Array<[Record<string, string>, number]> = []
    for (const [volume, path] of [['games', cfg.gamesDir], ['data', cfg.dataDir]] as const) {
      const s = await statfs(path).catch(() => null)
      if (!s) continue
      disks.push([{ volume }, s.bavail * s.bsize])
      sizes.push([{ volume }, s.blocks * s.bsize])
    }
    metric('renplay_disk_free_bytes', 'gauge', 'Free space on a volume.', disks)
    metric('renplay_disk_size_bytes', 'gauge', 'Size of a volume.', sizes)
    res.type('text/plain; version=0.0.4; charset=utf-8').send(lines.join('\n') + '\n')
  })

  router.get('/widget', (_req, res) => {
    const me = viewer()?.user.id ?? 1
    const visible = db.allGames().filter((g) => !content.hides(g))
    const recent = db.raw
      .prepare("SELECT game, last_played_at FROM user_games WHERE user_id = ? AND last_played_at != '' ORDER BY last_played_at DESC LIMIT 20")
      .all(me) as Array<{ game: string; last_played_at: string }>
    const titles = new Map(visible.map((g) => [g.id, catalog.recipe(g.recipe_id)?.title || g.title]))
    const played = recent.filter((r) => titles.has(r.game)).slice(0, 5).map((r) => ({ id: r.game, title: titles.get(r.game)!, playedAt: r.last_played_at }))
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const today = db.raw.prepare('SELECT game, COALESCE(SUM(seconds), 0) s FROM play_sessions WHERE user_id = ? AND started_at >= ? GROUP BY game').all(me, midnight.getTime()) as Array<{ game: string; s: number }>
    const installing = db.raw.prepare("SELECT game FROM jobs WHERE type = 'import' AND status IN ('running', 'queued')").all() as Array<{ game: string }>
    res.json({
      version,
      games: visible.length,
      installed: visible.filter((g) => g.status === 'installed').length,
      installing: installing.filter((j) => !j.game || titles.has(j.game)).length,
      playedTodayMinutes: Math.round(today.filter((t) => titles.has(t.game)).reduce((n, t) => n + t.s, 0) / 60),
      lastPlayed: played[0]?.title ?? null,
      recent: played,
    })
  })

  return router
}
