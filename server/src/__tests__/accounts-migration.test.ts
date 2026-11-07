import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, lstatSync, utimesSync, statSync, readlinkSync, cpSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Db } from '../db.js'

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, renameSync: vi.fn(fs.renameSync) }
})
const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const roots: string[] = []
afterEach(() => { vi.mocked(renameSync).mockImplementation(realFs.renameSync); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'renplay-migration-')); roots.push(root)
  const data = join(root, 'data'), saves = join(root, 'external-saves'), history = join(root, 'external-history')
  const db = Db.open(data)
  db.insertGame({ id: 'fixture', title: 'Fixture', save_dir: 'Fixture', last_played_at: '2026-01-01' })
  db.raw.exec(`DROP TABLE users; DROP TABLE identities; DROP TABLE sessions; DROP TABLE tokens; DROP TABLE user_games; DROP TABLE safe_games;
    ALTER TABLE games DROP COLUMN favorite_at; ALTER TABLE games DROP COLUMN finished_at; ALTER TABLE games DROP COLUMN play_time; ALTER TABLE games DROP COLUMN adult;
    DELETE FROM settings; PRAGMA user_version = 3`)
  db.close()
  for (const dir of [join(saves, 'Fixture'), join(history, 'Fixture', 'persistent')]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(saves, 'Fixture', 'persistent'), 'current')
  utimesSync(join(saves, 'Fixture', 'persistent'), 100000, 100000)
  writeFileSync(join(history, 'Fixture', 'persistent', '1__overwrite__abc'), 'old')
  return { data, saves, history }
}

describe('account folder migration failure recovery', () => {
  it('links the old save folders relatively, so a moved or restored data folder still opens in 2.11', () => {
    const root = mkdtempSync(join(tmpdir(), 'renplay-migration-')); roots.push(root)
    const data = join(root, 'data')
    const db = Db.open(data)
    db.raw.exec(`DROP TABLE users; DROP TABLE identities; DROP TABLE sessions; DROP TABLE tokens; DROP TABLE user_games; DROP TABLE safe_games;
      ALTER TABLE games DROP COLUMN favorite_at; ALTER TABLE games DROP COLUMN finished_at; ALTER TABLE games DROP COLUMN play_time; ALTER TABLE games DROP COLUMN adult;
      DELETE FROM settings; PRAGMA user_version = 3`)
    db.close()
    mkdirSync(join(data, 'saves', 'Fixture'), { recursive: true })
    writeFileSync(join(data, 'saves', 'Fixture', '1-1-LT1.save'), 'save')
    Db.open(data).close()
    for (const name of ['saves', 'save-history']) {
      expect(lstatSync(join(data, name)).isSymbolicLink()).toBe(true)
      expect(readlinkSync(join(data, name))).toBe(join('users', '1', name))
    }
    const moved = join(root, 'restored-elsewhere')
    cpSync(data, moved, { recursive: true, verbatimSymlinks: true })
    rmSync(data, { recursive: true })
    expect(readFileSync(join(moved, 'saves', 'Fixture', '1-1-LT1.save'), 'utf-8')).toBe('save')
  })

  it('migrates a populated v3 library with custom paths across filesystems using verified copies and keeps mtimes', () => {
    const f = fixture()
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (from === f.saves || from === f.history) throw Object.assign(new Error('Different volume'), { code: 'EXDEV' })
      return realFs.renameSync(from, to)
    })
    const db = Db.open(f.data, f)
    expect(db.raw.prepare('PRAGMA user_version').get()!.user_version).toBe(18)
    expect(db.getSetting('auth_default', '')).toBe('off')
    expect(db.raw.prepare('SELECT * FROM user_games').get()).toMatchObject({ user_id: 1, game: 'fixture', last_played_at: '2026-01-01' })
    expect(lstatSync(f.saves).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(f.saves, 'Fixture', 'persistent'), 'utf-8')).toBe('current')
    expect(statSync(join(f.saves, 'Fixture', 'persistent')).mtimeMs).toBe(100000000)
    expect(readFileSync(join(f.history, 'Fixture', 'persistent', '1__overwrite__abc'), 'utf-8')).toBe('old')
    const backup = new DatabaseSync(join(f.data, 'backups', 'pre-3.0', 'library.db'))
    expect(backup.prepare('PRAGMA user_version').get()!.user_version).toBe(3)
    backup.close(); db.close()
  })
  it('backs up both folders first, survives an actual mid-migration exception and resumes without duplicating or losing data', () => {
    const f = fixture()
    vi.mocked(renameSync).mockImplementation((from, to) => {
      if (from === f.history) throw Object.assign(new Error('Simulated crash'), { code: 'EIO' })
      return realFs.renameSync(from, to)
    })
    expect(() => Db.open(f.data, f)).toThrow('Simulated crash')
    expect(lstatSync(f.saves).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(f.data, 'backups', 'pre-3.0', 'save-history', 'Fixture', 'persistent', '1__overwrite__abc'), 'utf-8')).toBe('old')
    const interrupted = new DatabaseSync(join(f.data, 'library.db'))
    expect(interrupted.prepare('PRAGMA user_version').get()!.user_version).toBe(3); interrupted.close()
    vi.mocked(renameSync).mockImplementation(realFs.renameSync)
    let db = Db.open(f.data, f); db.close()
    db = Db.open(f.data, f)
    expect(db.raw.prepare('PRAGMA user_version').get()!.user_version).toBe(18)
    expect(readFileSync(join(f.saves, 'Fixture', 'persistent'), 'utf-8')).toBe('current')
    expect(readFileSync(join(f.history, 'Fixture', 'persistent', '1__overwrite__abc'), 'utf-8')).toBe('old')
    db.close()
  })
})
