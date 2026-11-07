import { mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { migrateAccountFolders } from './accounts-migration.js'
import { log } from './util/log.js'

export type GameStatus = 'installed' | 'not_installed' | 'installing'

export interface GameSource {
  /** Path relative to the archives dir. */
  archive?: string
  size?: number
  sha256?: string
}

export interface BuildOptions {
  optimizeImages?: boolean
  imageQuality?: number
}

export interface WalkthroughRow {
  /** The file in the walkthroughs folder, named by Renplay. */
  file: string
  game: string
  title: string
  kind: 'pdf' | 'image' | 'text'
  size: number
  added_at: string
  position: number
}

export interface GameRow {
  id: string
  title: string
  recipe_id: string
  version: string
  /** Version of the engine the game was made with (for Ren'Py games, the Ren'Py version). */
  renpy_version: string
  /** Ren'Py runtime the game is built with; empty for other engines. */
  engine: string
  /** What made the game: renpy, html… (family.ts). */
  family: string
  /** What made it, for people: "HTML (SugarCube 2.36.1)"; empty for Ren'Py. */
  engine_label: string
  /** The page or file the game starts from, inside its build's game/; empty for Ren'Py. */
  entry: string
  /** Current build directory name, `<build>` or `<build>.m<modhash>`. */
  build: string
  status: GameStatus
  size_bytes: number
  file_count: number
  screen_w: number
  screen_h: number
  save_dir: string
  source: string
  build_options: string
  walkthrough: string
  created_at: string
  installed_at: string
  last_played_at: string
  favorite_at: string
  finished_at: string
  play_time: number
  /** The person's status (user_games): playing, stalled, dropped, finished, or '' when not set. */
  play_status?: string
  /** The person's rating, 1 to 5, or 0 for none (user_games). */
  rating?: number
  /** When the person said Not now: the game leaves Up next until it is played again (user_games). */
  not_now_at?: string
  /** 1 when the game's recipe is adult: the last thing the catalog said, kept for when it can no longer say (content.ts). */
  adult: number
  updated_at: string
}

export interface JobRow {
  id: string
  type: string
  game: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted'
  stage: string
  progress: number
  message: string
  params: string
  result: string
  error: string
  log: string
  created_at: string
  started_at: string
  finished_at: string
}

export interface ArchiveRow {
  path: string
  size: number
  mtime_ms: number
  sha256: string
  info: string
  scanned_at: string
}

const now = () => new Date().toISOString()

const SCHEMA = `
  CREATE TABLE games (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    recipe_id       TEXT NOT NULL DEFAULT '',
    version         TEXT NOT NULL DEFAULT '',
    renpy_version   TEXT NOT NULL DEFAULT '',
    engine          TEXT NOT NULL DEFAULT '',
    build           TEXT NOT NULL DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'not_installed',
    size_bytes      INTEGER NOT NULL DEFAULT 0,
    file_count      INTEGER NOT NULL DEFAULT 0,
    screen_w        INTEGER NOT NULL DEFAULT 0,
    screen_h        INTEGER NOT NULL DEFAULT 0,
    save_dir        TEXT NOT NULL DEFAULT '',
    source          TEXT NOT NULL DEFAULT '{}',
    build_options   TEXT NOT NULL DEFAULT '{}',
    walkthrough     TEXT NOT NULL DEFAULT '',
    created_at      TEXT NOT NULL,
    installed_at    TEXT NOT NULL DEFAULT '',
    last_played_at  TEXT NOT NULL DEFAULT '',
    updated_at      TEXT NOT NULL
  );
  CREATE INDEX games_save_dir ON games(save_dir);
  CREATE TABLE jobs (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    game        TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL,
    stage       TEXT NOT NULL DEFAULT '',
    progress    REAL NOT NULL DEFAULT 0,
    message     TEXT NOT NULL DEFAULT '',
    params      TEXT NOT NULL DEFAULT '{}',
    result      TEXT NOT NULL DEFAULT '{}',
    error       TEXT NOT NULL DEFAULT '',
    log         TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL,
    started_at  TEXT NOT NULL DEFAULT '',
    finished_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX jobs_status ON jobs(status);
  CREATE TABLE archives (
    path       TEXT PRIMARY KEY,
    size       INTEGER NOT NULL,
    mtime_ms   INTEGER NOT NULL,
    sha256     TEXT NOT NULL DEFAULT '',
    info       TEXT NOT NULL DEFAULT '{}',
    scanned_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

export class Db {
  readonly raw: DatabaseSync

  constructor(path: string, folders?: { saves: string; history: string }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA journal_mode = WAL')
    this.raw.exec('PRAGMA synchronous = NORMAL')
    this.raw.exec('PRAGMA busy_timeout = 5000')
    try {
    const v = (this.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    const oldSaves = folders?.saves ?? join(dirname(path), 'saves'), oldHistory = folders?.history ?? join(dirname(path), 'save-history')
    const upgraded = v > 0 || path !== ':memory:' && (existsSync(oldSaves) || existsSync(oldHistory))
    if (upgraded && v < 7 && path !== ':memory:') migrateAccountFolders(this.raw, dirname(path), oldSaves, oldHistory)
    if (v === 0) this.raw.exec(SCHEMA)
    // 2.2: title, tags and cover come from the catalog; nothing is set by hand.
    if (v === 1) this.raw.exec('ALTER TABLE games DROP COLUMN save_dir_locked; ALTER TABLE games DROP COLUMN tags; ALTER TABLE games DROP COLUMN cover;')
    if (v < 2) this.raw.exec('PRAGMA user_version = 2')
    // 2.6: games of other engines (docs.renplay.org/engines). engine stays the Ren'Py runtime version.
    if (v < 3) {
      this.raw.exec(
        "ALTER TABLE games ADD COLUMN family TEXT NOT NULL DEFAULT 'renpy'; ALTER TABLE games ADD COLUMN engine_label TEXT NOT NULL DEFAULT ''; ALTER TABLE games ADD COLUMN entry TEXT NOT NULL DEFAULT ''; PRAGMA user_version = 3",
      )
    }
    // 2.10: favourites belong to the library entry, not its installed build.
    if (v < 4) this.raw.exec("ALTER TABLE games ADD COLUMN favorite_at TEXT NOT NULL DEFAULT ''; PRAGMA user_version = 4")
    // 2.11: reading progress survives uninstall and rebuilds; saves are untouched.
    if (v < 5) this.raw.exec("BEGIN; ALTER TABLE games ADD COLUMN finished_at TEXT NOT NULL DEFAULT ''; ALTER TABLE games ADD COLUMN play_time INTEGER NOT NULL DEFAULT 0; PRAGMA user_version = 5; COMMIT")
    // 2.12: adult games can be switched off install-wide. A library that existed before keeps showing them.
    if (v < 6) {
      this.raw.exec('BEGIN; ALTER TABLE games ADD COLUMN adult INTEGER NOT NULL DEFAULT 0')
      if (v > 0) this.raw.exec("INSERT OR IGNORE INTO settings (key, value) VALUES ('adult_games', '\"allow\"')")
      this.raw.exec('PRAGMA user_version = 6; COMMIT')
    }
    if (v < 7) {
      this.raw.exec(`BEGIN;
        CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','player')), adult_access INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, prefs TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id INTEGER NOT NULL REFERENCES users(id), password TEXT NOT NULL DEFAULT '', PRIMARY KEY(provider, subject));
        CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, user_id INTEGER NOT NULL REFERENCES users(id), name TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS user_games (user_id INTEGER NOT NULL REFERENCES users(id), game TEXT NOT NULL, favorite_at TEXT NOT NULL DEFAULT '', finished_at TEXT NOT NULL DEFAULT '', last_played_at TEXT NOT NULL DEFAULT '', play_time INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id, game));
        CREATE TABLE IF NOT EXISTS safe_games (game TEXT PRIMARY KEY);
        INSERT OR IGNORE INTO users (id, username, name, role, adult_access, created_at) VALUES (1, 'owner', 'Owner', 'admin', 1, '${now()}');
        INSERT OR IGNORE INTO user_games (user_id, game, favorite_at, finished_at, last_played_at, play_time) SELECT 1, id, favorite_at, finished_at, last_played_at, play_time FROM games;
        INSERT OR IGNORE INTO settings (key, value) VALUES ('auth_default', '${JSON.stringify(upgraded ? 'off' : 'on')}');
        PRAGMA user_version = 7; COMMIT;
      `)
    }
    // Upload ownership is separate from the scan cache: rescans must not claim copied files.
    if (v < 8) this.raw.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS uploaded_archives (path TEXT PRIMARY KEY, identity TEXT NOT NULL);
      PRAGMA user_version = 8; COMMIT;
    `)
    if (v < 9) {
      const columns = this.raw.prepare('PRAGMA table_info(users)').all().map(c => c.name)
      this.raw.exec('BEGIN')
      if (!columns.includes('avatar')) this.raw.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT ''")
      if (!columns.includes('avatar_uploaded')) this.raw.exec('ALTER TABLE users ADD COLUMN avatar_uploaded INTEGER NOT NULL DEFAULT 0')
      this.raw.exec('PRAGMA user_version = 9; COMMIT')
    }
    if (v < 10) {
      const columns = this.raw.prepare('PRAGMA table_info(users)').all().map(c => c.name)
      this.raw.exec('BEGIN')
      if (!columns.includes('admin_source')) this.raw.exec("ALTER TABLE users ADD COLUMN admin_source TEXT NOT NULL DEFAULT 'manual'")
      if (!columns.includes('admin_provider')) this.raw.exec("ALTER TABLE users ADD COLUMN admin_provider TEXT NOT NULL DEFAULT ''")
      if (!columns.includes('admin_subject')) this.raw.exec("ALTER TABLE users ADD COLUMN admin_subject TEXT NOT NULL DEFAULT ''")
      this.raw.exec(`CREATE TABLE IF NOT EXISTS identity_metadata (provider TEXT NOT NULL, subject TEXT NOT NULL, username TEXT NOT NULL, PRIMARY KEY(provider, subject));
        PRAGMA user_version = 10; COMMIT;`)
    }
    // 4.0: three adult levels. The 3.x access becomes the ceiling. The choice keeps what the person
    // saw: their 3.x picture preference (show, hide-pictures, hide-games), where hide-pictures was
    // also the default. adult_access and prefs stay written (content.ts legacyMirror) so a
    // downgrade to 3.2 reads the same levels.
    if (v < 11) {
      const columns = this.raw.prepare('PRAGMA table_info(users)').all().map(c => c.name)
      this.raw.exec('BEGIN')
      if (!columns.includes('adult_ceiling')) this.raw.exec("ALTER TABLE users ADD COLUMN adult_ceiling TEXT NOT NULL DEFAULT ''")
      if (!columns.includes('adult_choice')) this.raw.exec("ALTER TABLE users ADD COLUMN adult_choice TEXT NOT NULL DEFAULT ''")
      this.raw.exec(`UPDATE users SET
        adult_ceiling = CASE adult_access WHEN 1 THEN 'shown' ELSE 'off' END,
        adult_choice = CASE
          WHEN adult_access != 1 THEN 'off'
          WHEN (CASE WHEN json_valid(prefs) THEN json_extract(prefs, '$.adultPictures') END) = 'show' THEN 'shown'
          WHEN (CASE WHEN json_valid(prefs) THEN json_extract(prefs, '$.adultPictures') END) = 'hide-games' THEN 'off'
          ELSE 'blurred' END
        WHERE adult_ceiling = ''`)
      // A new database has only the owner, who starts at shown like any first admin.
      if (v === 0) this.raw.exec("UPDATE users SET adult_choice = 'shown' WHERE id = 1 AND adult_ceiling = 'shown'")
      this.raw.exec('PRAGMA user_version = 11; COMMIT')
    }
    // 4.0: the art cache (art.ts). Made pictures by the key of their source and method, the
    // choices of each person (scope = user id) and of the admin for everyone (scope 0), uploads,
    // and the sizes of catalog pictures the index gave none for. Choices and uploads outlive a
    // removed game, like saves.
    if (v < 12) this.raw.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS art_made (key TEXT PRIMARY KEY, file1x TEXT NOT NULL, file2x TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, thumbhash TEXT NOT NULL, tint TEXT NOT NULL, made TEXT NOT NULL DEFAULT '', adult INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS art_made_file1x ON art_made (file1x);
      CREATE INDEX IF NOT EXISTS art_made_file2x ON art_made (file2x);
      CREATE TABLE IF NOT EXISTS art_choices (game TEXT NOT NULL, kind TEXT NOT NULL, scope INTEGER NOT NULL, candidate TEXT NOT NULL, PRIMARY KEY (game, kind, scope));
      CREATE TABLE IF NOT EXISTS art_uploads (id TEXT NOT NULL, game TEXT NOT NULL, kind TEXT NOT NULL, scope INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, focal TEXT NOT NULL DEFAULT '', thumbhash TEXT NOT NULL, tint TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (id, game, kind, scope));
      CREATE TABLE IF NOT EXISTS art_measured (id TEXT PRIMARY KEY, width INTEGER NOT NULL, height INTEGER NOT NULL, thumbhash TEXT NOT NULL, tint TEXT NOT NULL);
      PRAGMA user_version = 12; COMMIT;`)
    // 4.0: a made logo knows whether it is dark lettering, so it is inverted on ink even when the
    // catalog does not say so. Pictures made before are made again (art.ts ART_VERSION).
    if (v < 13) {
      const columns = this.raw.prepare('PRAGMA table_info(art_made)').all().map(c => c.name)
      this.raw.exec('BEGIN')
      if (!columns.includes('dark')) this.raw.exec('ALTER TABLE art_made ADD COLUMN dark INTEGER NOT NULL DEFAULT 0')
      this.raw.exec('PRAGMA user_version = 13; COMMIT')
    }
    // 4.0: each person's status, rating and Not now for a game, and their play sessions for
    // History. A finished game becomes the status Finished, and finished_at stays in step so a
    // downgrade to 3.2 still shows it finished.
    if (v < 14) {
      const columns = this.raw.prepare('PRAGMA table_info(user_games)').all().map(c => c.name)
      this.raw.exec('BEGIN')
      if (!columns.includes('play_status')) this.raw.exec("ALTER TABLE user_games ADD COLUMN play_status TEXT NOT NULL DEFAULT ''")
      if (!columns.includes('rating')) this.raw.exec('ALTER TABLE user_games ADD COLUMN rating INTEGER NOT NULL DEFAULT 0')
      if (!columns.includes('not_now_at')) this.raw.exec("ALTER TABLE user_games ADD COLUMN not_now_at TEXT NOT NULL DEFAULT ''")
      this.raw.exec(`UPDATE user_games SET play_status = 'finished' WHERE finished_at != '' AND play_status = '';
        CREATE TABLE IF NOT EXISTS play_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, game TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, seconds INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS play_sessions_user ON play_sessions (user_id, ended_at);
        PRAGMA user_version = 14; COMMIT;`)
    }
    // 4.0: several walkthrough files per game, each with a title and a place in the list. The 3.x
    // walkthrough becomes the first, and games.walkthrough stays the first file so 3.2 finds it.
    if (v < 15) this.raw.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS walkthroughs (file TEXT PRIMARY KEY, game TEXT NOT NULL, title TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS walkthroughs_game ON walkthroughs (game, position);
      INSERT OR IGNORE INTO walkthroughs (file, game, title, kind, added_at, position) SELECT walkthrough, id, 'Walkthrough', 'pdf', COALESCE(NULLIF(installed_at, ''), '${now()}'), 0 FROM games WHERE walkthrough != '';
      PRAGMA user_version = 15; COMMIT;`)
    // 4.0: each person's name, note and pin for a save file. A pinned save keeps every version
    // in its history (saves/store.ts). The file itself is untouched.
    if (v < 16) this.raw.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS save_meta (user_id INTEGER NOT NULL, save_dir TEXT NOT NULL, file TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', pinned_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (user_id, save_dir, file));
      PRAGMA user_version = 16; COMMIT;`)
    // 4.1: a PIN to switch to a person on a device that is already signed in.
    if (v < 17) {
      const columns = this.raw.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
      this.raw.exec('BEGIN')
      if (!columns.includes('pin_hash')) this.raw.exec("ALTER TABLE users ADD COLUMN pin_hash TEXT NOT NULL DEFAULT ''")
      if (!columns.includes('pin_failures')) this.raw.exec('ALTER TABLE users ADD COLUMN pin_failures INTEGER NOT NULL DEFAULT 0')
      if (!columns.includes('pin_locked_until')) this.raw.exec('ALTER TABLE users ADD COLUMN pin_locked_until INTEGER NOT NULL DEFAULT 0')
      this.raw.exec('PRAGMA user_version = 17; COMMIT')
    }
    // 4.1: the people who signed in on each browser (its cookie, hashed), the only ones Who is playing offers there.
    if (v < 18) this.raw.exec(`BEGIN;
      CREATE TABLE IF NOT EXISTS device_people (device TEXT NOT NULL, user_id INTEGER NOT NULL, seen_at INTEGER NOT NULL, PRIMARY KEY (device, user_id));
      PRAGMA user_version = 18; COMMIT;`)
    } catch (error) { this.raw.close(); throw error }
  }

  /**
   * Opens library.db. The database of renplay 1.x / 2.0 (renplay.db) described
   * the old build layout and is dropped; saves live in files and are untouched.
   */
  static open(dataDir: string, folders?: { saves: string; history: string }): Db {
    for (const old of ['renplay.db', 'renplay.db-wal', 'renplay.db-shm']) {
      const p = join(dataDir, old)
      if (existsSync(p)) {
        rmSync(p, { force: true })
        if (old === 'renplay.db') log('server', 'Removed the old library database (renplay.db)')
      }
    }
    return new Db(join(dataDir, 'library.db'), folders)
  }

  // ---- games -------------------------------------------------------------

  allGames(): GameRow[] {
    return this.raw.prepare('SELECT * FROM games ORDER BY title COLLATE NOCASE').all() as unknown as GameRow[]
  }

  getGame(id: string): GameRow | null {
    return (this.raw.prepare('SELECT * FROM games WHERE id = ?').get(id) as unknown as GameRow) ?? null
  }

  insertGame(row: Partial<GameRow> & { id: string; title: string }): void {
    const full: Record<string, SQLInputValue> = { created_at: now(), updated_at: now(), ...(row as Record<string, SQLInputValue>) }
    const keys = Object.keys(full)
    this.raw.prepare(`INSERT INTO games (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...keys.map((k) => full[k]!))
  }

  updateGame(id: string, updates: Partial<GameRow>): boolean {
    const entries = Object.entries(updates).filter(([k, v]) => k !== 'id' && v !== undefined)
    if (!entries.length) return !!this.getGame(id)
    entries.push(['updated_at', now()])
    const res = this.raw
      .prepare(`UPDATE games SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...entries.map(([, v]) => v as SQLInputValue), id)
    return Number(res.changes) > 0
  }

  /** A game's walkthrough files, in their order. */
  walkthroughs(game: string): WalkthroughRow[] {
    return this.raw.prepare('SELECT * FROM walkthroughs WHERE game = ? ORDER BY position, added_at').all(game) as unknown as WalkthroughRow[]
  }

  /** Keeps games.walkthrough the first file, which Renplay 3.x reads. */
  syncFirstWalkthrough(game: string): void {
    this.raw.prepare('UPDATE games SET walkthrough = ? WHERE id = ?').run(this.walkthroughs(game)[0]?.file ?? '', game)
  }

  deleteGame(id: string): boolean {
    this.raw.exec('BEGIN IMMEDIATE')
    try {
      this.raw.prepare('DELETE FROM user_games WHERE game = ?').run(id)
      this.raw.prepare('DELETE FROM safe_games WHERE game = ?').run(id)
      const removed = Number(this.raw.prepare('DELETE FROM games WHERE id = ?').run(id).changes) > 0
      this.raw.exec('COMMIT')
      return removed
    } catch (error) { this.raw.exec('ROLLBACK'); throw error }
  }

  gameBySaveDir(saveDir: string): GameRow | null {
    return (this.raw.prepare('SELECT * FROM games WHERE save_dir = ? LIMIT 1').get(saveDir) as unknown as GameRow) ?? null
  }

  gamesBySaveDir(saveDir: string): GameRow[] {
    return this.raw.prepare('SELECT * FROM games WHERE save_dir = ? ORDER BY created_at, id').all(saveDir) as unknown as GameRow[]
  }

  gameByRecipe(recipeId: string): GameRow | null {
    return (this.raw.prepare('SELECT * FROM games WHERE recipe_id = ? LIMIT 1').get(recipeId) as unknown as GameRow) ?? null
  }

  // ---- jobs --------------------------------------------------------------

  insertJob(job: Pick<JobRow, 'id' | 'type' | 'game' | 'params'>): void {
    this.raw
      .prepare("INSERT INTO jobs (id, type, game, status, params, created_at) VALUES (?, ?, ?, 'queued', ?, ?)")
      .run(job.id, job.type, job.game, job.params, now())
  }

  getJob(id: string): JobRow | null {
    return (this.raw.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as unknown as JobRow) ?? null
  }

  countJobs(): number {
    return (this.raw.prepare('SELECT COUNT(*) AS total FROM jobs').get() as { total: number }).total
  }

  listJobs(limit = 50, offset = 0): JobRow[] {
    return this.raw
      .prepare("SELECT * FROM jobs ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END, created_at DESC, id DESC LIMIT ? OFFSET ?")
      .all(limit, offset) as unknown as JobRow[]
  }

  updateJob(id: string, updates: Partial<JobRow>): void {
    const entries = Object.entries(updates).filter(([k, v]) => k !== 'id' && v !== undefined)
    if (!entries.length) return
    this.raw.prepare(`UPDATE jobs SET ${entries.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...entries.map(([, v]) => v as SQLInputValue), id)
  }

  /** Deletes finished jobs: all of them, or those `keep` does not keep. */
  deleteFinishedJobs(keep?: (job: JobRow) => boolean): void {
    if (!keep) {
      this.raw.exec("DELETE FROM jobs WHERE status IN ('done','failed','cancelled','interrupted')")
      return
    }
    const rows = this.raw.prepare("SELECT * FROM jobs WHERE status IN ('done','failed','cancelled','interrupted')").all() as unknown as JobRow[]
    const remove = this.raw.prepare('DELETE FROM jobs WHERE id = ?')
    for (const j of rows) if (!keep(j)) remove.run(j.id)
  }

  // ---- archives ----------------------------------------------------------

  getArchive(path: string): ArchiveRow | null {
    return (this.raw.prepare('SELECT * FROM archives WHERE path = ?').get(path) as unknown as ArchiveRow) ?? null
  }

  upsertArchive(a: { path: string; size: number; mtime_ms: number; sha256?: string; info?: string }): void {
    this.raw
      .prepare(
        `INSERT INTO archives (path, size, mtime_ms, sha256, info, scanned_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms,
           sha256 = excluded.sha256, info = excluded.info, scanned_at = excluded.scanned_at`,
      )
      .run(a.path, a.size, a.mtime_ms, a.sha256 ?? '', a.info ?? '{}', now())
  }

  markUploadedArchive(path: string, identity: string): void {
    this.raw.prepare('INSERT OR REPLACE INTO uploaded_archives (path, identity) VALUES (?, ?)').run(path, identity)
  }

  isUploadedArchive(path: string, identity: string): boolean {
    return !!this.raw.prepare('SELECT 1 FROM uploaded_archives WHERE path = ? AND identity = ?').get(path, identity)
  }

  deleteArchive(path: string): void {
    this.raw.prepare('DELETE FROM archives WHERE path = ?').run(path)
    this.raw.prepare('DELETE FROM uploaded_archives WHERE path = ?').run(path)
  }

  allArchives(): ArchiveRow[] {
    return this.raw.prepare('SELECT * FROM archives ORDER BY path').all() as unknown as ArchiveRow[]
  }

  // ---- settings ----------------------------------------------------------

  getSetting<T>(key: string, fallback: T): T {
    const row = this.raw.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row ? parseJson<T>(row.value, fallback) : fallback
  }

  setSetting(key: string, value: unknown): void {
    this.raw
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }

  close(): void {
    this.raw.close()
  }
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}
