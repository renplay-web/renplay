import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js'

export interface GameRow {
  slug: string
  title: string
  author: string
  description: string
  tags: string
  sort_order: number
  created_at: string
  updated_at: string
}

export class Database {
  private db!: SqlJsDatabase

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
    this.db.run(`
      CREATE TABLE IF NOT EXISTS games (
        slug        TEXT PRIMARY KEY,
        title       TEXT NOT NULL,
        author      TEXT DEFAULT '',
        description TEXT DEFAULT '',
        tags        TEXT DEFAULT '[]',
        sort_order  INTEGER DEFAULT 0,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
      )
    `)

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
      `INSERT INTO games (slug, title, author, description, tags, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [row.slug, row.title, row.author, row.description, row.tags, sortOrder],
    )
  }

  updateGame(slug: string, updates: Partial<GameRow>): boolean {
    const existing = this.getGame(slug)
    if (!existing) return false

    const merged = { ...existing, ...updates, updated_at: new Date().toISOString() }
    this.db.run(
      `UPDATE games SET title=?, author=?, description=?, tags=?, sort_order=?, updated_at=? WHERE slug=?`,
      [
        merged.title,
        merged.author,
        merged.description,
        merged.tags,
        merged.sort_order,
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

  async save(): Promise<void> {
    const buf = this.db.export()
    await writeFile(this.dbPath, buf)
  }
}
