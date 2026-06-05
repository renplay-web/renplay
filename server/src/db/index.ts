import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'
import AdmZip from 'adm-zip'
export interface GameRow {
  slug: string
  title: string
  tags: string
  thumbnail: string
  walkthrough: string
  sort_order: number
  created_at: string
  updated_at: string
  save_dir: string
}

export class Database {
  private db!: SqlJsDatabase
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private pendingSaveResolvers: Array<() => void> = []

  private constructor(private dbPath: string) {}

  static async open(dataDir: string): Promise<Database> {
    const dbPath = join(dataDir, 'renplay.db')
    await mkdir(dirname(dbPath), { recursive: true })

    const SQL = await initSqlJs()
    const inst = new Database(dbPath)

    try {
      const buf = await readFile(dbPath)
      inst.db = new SQL.Database(buf)
    } catch {
      inst.db = new SQL.Database()
    }

    inst.migrate()
    return inst
  }

  private migrate(): void {
    const raw = this.db.exec("PRAGMA user_version")[0]?.values[0]?.[0]
    const version = typeof raw === 'number' ? raw : 0

    if (version < 1) {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS games (
          slug        TEXT PRIMARY KEY,
          title       TEXT NOT NULL,
          author      TEXT DEFAULT '',
          description TEXT DEFAULT '',
          tags        TEXT DEFAULT '[]',
          thumbnail   TEXT DEFAULT '',
          sort_order  INTEGER DEFAULT 0,
          created_at  TEXT DEFAULT (datetime('now')),
          updated_at  TEXT DEFAULT (datetime('now'))
        )
      `)
      this.db.run('PRAGMA user_version = 1')
    }

    if (version < 2) {
      try { this.db.run('ALTER TABLE games DROP COLUMN author') } catch {}
      try { this.db.run('ALTER TABLE games DROP COLUMN description') } catch {}
      try { this.db.run("ALTER TABLE games ADD COLUMN thumbnail TEXT DEFAULT ''") } catch {}
      this.db.run('PRAGMA user_version = 2')
    }

    if (version < 3) {
      try { this.db.run("ALTER TABLE games ADD COLUMN walkthrough TEXT DEFAULT ''") } catch {}
      this.db.run('PRAGMA user_version = 3')
    }

    if (version < 4) {
      try { this.db.run("ALTER TABLE games ADD COLUMN save_dir TEXT DEFAULT ''") } catch {}
      this.db.run('PRAGMA user_version = 4')
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `)
  }

  allGames(): GameRow[] {
    const stmt = this.db.prepare('SELECT * FROM games ORDER BY sort_order ASC, title ASC')
    const rows: GameRow[] = []
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as GameRow)
    }
    stmt.free()
    return rows
  }

  getGame(slug: string): GameRow | null {
    const stmt = this.db.prepare('SELECT * FROM games WHERE slug = ?')
    stmt.bind([slug])
    if (stmt.step()) {
      const row = stmt.getAsObject() as unknown as GameRow
      stmt.free()
      return row
    }
    stmt.free()
    return null
  }

  createGame(row: Omit<GameRow, 'sort_order' | 'created_at' | 'updated_at'>): void {
    const result = this.db.exec('SELECT COALESCE(MAX(sort_order), -1) + 1 FROM games')
    const sortOrder = (result[0]?.values[0]?.[0] ?? 0) as number

    this.db.run(
      `INSERT INTO games (slug, title, tags, thumbnail, walkthrough, sort_order, save_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [row.slug, row.title, row.tags, row.thumbnail, row.walkthrough, sortOrder, row.save_dir || ''],
    )
  }

  updateGame(slug: string, updates: Partial<GameRow>): boolean {
    const existing = this.getGame(slug)
    if (!existing) return false

    const merged = { ...existing, ...updates, updated_at: new Date().toISOString() }
    this.db.run(
      `UPDATE games SET title=?, tags=?, thumbnail=?, walkthrough=?, sort_order=?, save_dir=?, updated_at=? WHERE slug=?`,
      [
        merged.title,
        merged.tags,
        merged.thumbnail,
        merged.walkthrough,
        merged.sort_order,
        merged.save_dir || '',
        merged.updated_at,
        slug,
      ],
    )
    return true
  }

  deleteGame(slug: string): boolean {
    const existing = this.getGame(slug)
    if (!existing) return false
    this.db.run('DELETE FROM games WHERE slug = ?', [slug])
    return true
  }

  reorderGames(slugs: string[]): void {
    this.db.run('BEGIN TRANSACTION')
    try {
      slugs.forEach((slug, idx) => {
        this.db.run("UPDATE games SET sort_order = ?, updated_at = datetime('now') WHERE slug = ?", [idx, slug])
      })
      this.db.run('COMMIT')
    } catch (e) {
      this.db.run('ROLLBACK')
      throw e
    }
  }

  getGameAbove(sortOrder: number): GameRow | null {
    const stmt = this.db.prepare('SELECT * FROM games WHERE sort_order < ? ORDER BY sort_order DESC LIMIT 1')
    stmt.bind([sortOrder])
    if (stmt.step()) {
      const row = stmt.getAsObject() as unknown as GameRow
      stmt.free()
      return row
    }
    stmt.free()
    return null
  }

  getGameBelow(sortOrder: number): GameRow | null {
    const stmt = this.db.prepare('SELECT * FROM games WHERE sort_order > ? ORDER BY sort_order ASC LIMIT 1')
    stmt.bind([sortOrder])
    if (stmt.step()) {
      const row = stmt.getAsObject() as unknown as GameRow
      stmt.free()
      return row
    }
    stmt.free()
    return null
  }

  async scanLibrary(gamesDir: string): Promise<{ created: string[] }> {
    let entries: string[]
    try {
      entries = await readdir(gamesDir)
    } catch {
      return { created: [] }
    }

    const results = await Promise.allSettled(entries.map(async (entry) => {
      const fullPath = join(gamesDir, entry)
      let stats
      try { stats = await stat(fullPath) } catch { return null }
      if (!stats.isDirectory()) return null

      const slug = entry.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase()
      if (!slug || this.getGame(slug)) return null

      const [title, saveDir] = await Promise.all([
        this.detectTitle(fullPath),
        this.detectSaveDir(fullPath),
      ])
      return { slug, title: title || entry, saveDir: saveDir || '' }
    }))

    const created: string[] = []
    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value) continue
      const { slug, title, saveDir } = result.value
      if (this.getGame(slug)) continue
      this.createGame({ slug, title, tags: '[]', thumbnail: '', walkthrough: '', save_dir: saveDir })
      created.push(slug)
    }

    return { created }
  }

  private async detectTitle(gameDir: string): Promise<string | null> {
    try {
      const indexHtml = join(gameDir, 'index.html')
      const html = await readFile(indexHtml, 'utf-8')
      const match = html.match(/<title>([^<]*)<\/title>/i)
      if (match) return match[1].trim()
    } catch {}
    return null
  }

  private async detectSaveDir(gameDir: string): Promise<string | null> {
    try {
      const zipPath = join(gameDir, 'game.zip')
      const zip = new AdmZip(zipPath)
      const entry = zip.getEntry('game/saves/navigation.json')
      if (!entry) return null
      const data = JSON.parse(entry.getData().toString('utf-8'))
      return data?.build?.directory_name || null
    } catch {
      return null
    }
  }

  async save(): Promise<void> {
    return new Promise((resolve) => {
      this.pendingSaveResolvers.push(resolve)
      if (this.saveTimer) clearTimeout(this.saveTimer)
      this.saveTimer = setTimeout(async () => {
        this.saveTimer = null
        const resolvers = this.pendingSaveResolvers.splice(0)
        try {
          const buf = this.db.export()
          await writeFile(this.dbPath, buf)
        } finally {
          resolvers.forEach((r) => r())
        }
      }, 100)
    })
  }
}
