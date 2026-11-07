import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Db } from '../db.js'

it('forgets personal progress and safe overrides with a library entry, never carrying them onto a reused game id', () => {
  const db = new Db(':memory:')
  try {
    db.insertGame({ id: 'story', title: 'Story' })
    db.raw.prepare('INSERT INTO safe_games VALUES (?)').run('story')
    db.raw.prepare('INSERT INTO user_games (user_id, game, favorite_at) VALUES (1, ?, ?)').run('story', '2026-01-01')
    expect(db.deleteGame('story')).toBe(true)
    db.insertGame({ id: 'story', title: 'Another story' })
    expect(db.raw.prepare('SELECT * FROM user_games').all()).toEqual([])
    expect(db.raw.prepare('SELECT * FROM safe_games').all()).toEqual([])
  } finally { db.close() }
})

it('migrates existing local admin assignments without changing roles or identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'renplay-db-')), path = join(root, 'library.db')
  let db = new Db(path)
  try {
    db.raw.prepare("INSERT INTO identities VALUES ('local', 'owner', 1, 'existing hash')").run()
    db.raw.exec("ALTER TABLE users DROP COLUMN admin_source; ALTER TABLE users DROP COLUMN admin_provider; ALTER TABLE users DROP COLUMN admin_subject; DROP TABLE identity_metadata; PRAGMA user_version = 9")
    db.close(); db = new Db(path)
    expect(db.raw.prepare('SELECT role, admin_source, admin_provider, admin_subject FROM users WHERE id = 1').get()).toMatchObject({ role: 'admin', admin_source: 'manual', admin_provider: '', admin_subject: '' })
    expect(db.raw.prepare('SELECT * FROM identities').get()).toMatchObject({ provider: 'local', subject: 'owner', user_id: 1, password: 'existing hash' })
    db.close(); db = new Db(path)
    expect(db.raw.prepare('SELECT admin_source FROM users WHERE id = 1').get()!.admin_source).toBe('manual')
  } finally { db.close(); rmSync(root, { recursive: true, force: true }) }
})

it('migrates version 7 without claiming old archives as uploads', () => {
  const root = mkdtempSync(join(tmpdir(), 'renplay-db-'))
  const path = join(root, 'library.db')
  let db = new Db(path)
  try {
    db.upsertArchive({ path: 'old.zip', size: 123, mtime_ms: 456 })
    db.raw.exec('DROP TABLE uploaded_archives; PRAGMA user_version = 7')
    db.close()
    db = new Db(path)
    expect(db.getArchive('old.zip')).toMatchObject({ size: 123, mtime_ms: 456 })
    expect(db.raw.prepare('SELECT * FROM uploaded_archives').all()).toEqual([])
    expect(db.raw.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 18 })
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})

it('migrates version 4 progress without changing existing library metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'renplay-db-'))
  const path = join(root, 'library.db')
  let db = new Db(path)
  try {
    db.insertGame({ id: 'story', title: 'Story', save_dir: 'Story-123', favorite_at: '2026-01-01', last_played_at: '2026-01-02' })
    db.raw.exec('ALTER TABLE games DROP COLUMN adult; ALTER TABLE games DROP COLUMN play_time; ALTER TABLE games DROP COLUMN finished_at; PRAGMA user_version = 4')
    db.close()
    db = new Db(path)
    expect(db.getGame('story')).toMatchObject({ save_dir: 'Story-123', favorite_at: '2026-01-01', last_played_at: '2026-01-02', finished_at: '', play_time: 0 })
    expect(db.raw.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 18 })
    db.close()
    db = new Db(path)
    expect(db.getGame('story')?.play_time).toBe(0)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
