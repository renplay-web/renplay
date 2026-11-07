import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type App } from '../app.js'
import sharp from 'sharp'
import yazl from 'yazl'
import { readZipEntries } from '../saves/savefile.js'

/** A minimal Ren'Py save holding a text, and the text back from one. */
const renpySave = (text: string) =>
  new Promise<Buffer>((resolve) => {
    const z = new yazl.ZipFile()
    z.addBuffer(Buffer.from('pickled-log'), 'log')
    z.addBuffer(Buffer.from(JSON.stringify({ _save_name: text, _ctime: 1700000000 })), 'json')
    z.addBuffer(Buffer.from('8.5.3'), 'renpy_version')
    z.end()
    const chunks: Buffer[] = []
    z.outputStream.on('data', (c: Buffer) => chunks.push(c))
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
  })
const saveText = async (data: Buffer) => JSON.parse((await readZipEntries(data, (n) => n === 'json')).get('json')!.toString())._save_name as string
import { loadConfig } from '../config.js'
import { Db } from '../db.js'

describe('status, rating, Not now and play history', () => {
  let root = ''
  let app: App

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'renplay-progress-'))
    process.env['DATA_DIR'] = join(root, 'data')
    process.env['GAMES_DIR'] = join(root, 'games')
    process.env['RENPLAY_AUTH'] = 'off'
    process.env['RENPLAY_CATALOG_URLS'] = 'http://127.0.0.1:9/none'
    process.env['RENPLAY_ENGINES_URL'] = 'http://127.0.0.1:9/none'
    const cfg = loadConfig()
    const db = Db.open(cfg.dataDir)
    db.setSetting('catalog_cache', { at: Date.now(), games: [{ id: 'story', title: 'A Story', engine: 'renpy', phone: 'great', releases: [] }, { id: 'adult', title: 'Adult', nsfw: true, engine: 'renpy', releases: [] }], vocabulary: {}, adultGames: 'shown' })
    db.insertGame({ id: 'story', title: 'story', recipe_id: 'story', status: 'installed' })
    db.insertGame({ id: 'adult', title: 'Adult', recipe_id: 'adult', adult: 1, status: 'installed' })
    db.close()
    app = await createApp(cfg, { startJobs: false })
  })
  afterAll(() => {
    app?.close()
    rmSync(root, { recursive: true, force: true })
    for (const k of ['DATA_DIR', 'GAMES_DIR', 'RENPLAY_AUTH', 'RENPLAY_CATALOG_URLS', 'RENPLAY_ENGINES_URL']) delete process.env[k]
  })

  const game = async (id = 'story') => (await request(app.app).get(`/api/games/${id}`).expect(200)).body.game

  it('keeps a status, with Finished in step with finished_at for Renplay 3.x', async () => {
    expect(await game()).toMatchObject({ playStatus: null, rating: null, notNowAt: null, phone: 'great' })
    await request(app.app).put('/api/games/story/status').send({ status: 'stalled' }).expect(200)
    expect(await game()).toMatchObject({ playStatus: 'stalled', finishedAt: null })
    await request(app.app).put('/api/games/story/status').send({ status: 'finished' }).expect(200)
    const finished = await game()
    expect(finished.playStatus).toBe('finished')
    expect(finished.finishedAt).toMatch(/^\d{4}-/)
    // The 3.x switch is the same thing.
    await request(app.app).put('/api/games/story/finished').send({ on: false }).expect(200)
    expect(await game()).toMatchObject({ playStatus: null, finishedAt: null })
    await request(app.app).put('/api/games/story/finished').send({ on: true }).expect(200)
    expect((await game()).playStatus).toBe('finished')
    await request(app.app).put('/api/games/story/status').send({ status: 'bored' }).expect(400)
    await request(app.app).put('/api/games/story/status').send({ status: '' }).expect(200)
  })

  it('keeps a rating from 1 to 5, and 0 clears it', async () => {
    await request(app.app).put('/api/games/story/rating').send({ rating: 4 }).expect(200)
    expect((await game()).rating).toBe(4)
    for (const rating of [6, -1, 2.5, '3']) await request(app.app).put('/api/games/story/rating').send({ rating }).expect(400)
    await request(app.app).put('/api/games/story/rating').send({ rating: 0 }).expect(200)
    expect((await game()).rating).toBeNull()
  })

  it('takes a game out of Up next with Not now, and DELETE undoes it', async () => {
    await request(app.app).post('/api/games/story/not-now').expect(200)
    expect((await game()).notNowAt).toMatch(/^\d{4}-/)
    await request(app.app).delete('/api/games/story/not-now').expect(200)
    expect((await game()).notNowAt).toBeNull()
  })

  it('turns play time into sessions and shows them by day, per game and in totals', async () => {
    // Reports 30 seconds apart, as the player sends them.
    for (let i = 0; i < 3; i++) {
      await request(app.app).post('/api/games/story/play-time').send({ seconds: 30 }).expect(200)
      app.db.raw.prepare("UPDATE play_sessions SET started_at = started_at - 30000, ended_at = ended_at - 30000 WHERE game = 'story'").run()
    }
    await request(app.app).post('/api/games/adult/play-time').send({ seconds: 20 }).expect(200)
    // A report more than ten minutes after the last one starts a new session.
    app.db.raw.prepare("UPDATE play_sessions SET started_at = started_at - 3600000, ended_at = ended_at - 3600000 WHERE game = 'story'").run()
    await request(app.app).post('/api/games/story/play-time').send({ seconds: 10 }).expect(200)
    const history = (await request(app.app).get('/api/history').expect(200)).body
    expect(history.totals).toMatchObject({ seconds: 120, sessions: 3, games: 2 })
    expect(history.games.map((g: { id: string; seconds: number }) => [g.id, g.seconds])).toEqual([['story', 100], ['adult', 20]])
    expect(history.games[0]).toMatchObject({ title: 'A Story', sessions: 2 })
    const sessions = history.days.flatMap((d: { sessions: Array<{ game: string; seconds: number }> }) => d.sessions)
    expect(sessions.map((s: { game: string; seconds: number }) => s.seconds).sort((a: number, b: number) => a - b)).toEqual([10, 20, 90])
    // One game's history, for its game page.
    expect((await request(app.app).get('/api/history?game=story').expect(200)).body.totals).toMatchObject({ seconds: 100, sessions: 2, games: 1 })
    // Off: the adult game's sessions are not in the history, and come back with the level.
    await request(app.app).put('/api/content').send({ level: 'off' }).expect(200)
    const off = (await request(app.app).get('/api/history').expect(200)).body
    expect(off.totals).toMatchObject({ seconds: 100, games: 1 })
    expect(JSON.stringify(off)).not.toContain('adult')
    await request(app.app).put('/api/content').send({ level: 'blurred' }).expect(200)
    const blurred = (await request(app.app).get('/api/history').expect(200)).body
    expect(blurred.totals.games).toBe(2)
    expect(JSON.stringify(blurred)).not.toContain('/api/art/')
    await request(app.app).put('/api/content').send({ level: 'shown' }).expect(200)
  })

  it('never counts more play time than passed: two windows, repeated reports', async () => {
    app.db.raw.prepare("DELETE FROM play_sessions WHERE game = 'third'").run()
    app.db.insertGame({ id: 'third', title: 'Third', status: 'installed', save_dir: 'Third-1' })
    const before = (await request(app.app).get('/api/games/third').expect(200)).body.game.playTime ?? 0
    for (let i = 0; i < 4; i++) await request(app.app).post('/api/games/third/play-time').send({ seconds: 60 }).expect(200)
    const session = app.db.raw.prepare("SELECT seconds FROM play_sessions WHERE game = 'third'").get() as { seconds: number }
    expect(session.seconds).toBeLessThanOrEqual(60 + 3 * 6)
    expect((await request(app.app).get('/api/games/third').expect(200)).body.game.playTime - before).toBe(session.seconds)
  })

  it('groups play by the person’s own days', async () => {
    app.db.raw.prepare("INSERT INTO play_sessions (user_id, game, started_at, ended_at, seconds) VALUES (1, 'third', ?, ?, 600)").run(Date.UTC(2026, 0, 1, 23, 30), Date.UTC(2026, 0, 1, 23, 40))
    const days = async (tz: string) => (await request(app.app).get(`/api/history?game=third&days=90&tz=${encodeURIComponent(tz)}`).expect(200)).body.days.map((d: { day: string }) => d.day)
    expect(await days('Asia/Tokyo')).toContain('2026-01-02')
    expect(await days('UTC')).toContain('2026-01-01')
    expect(await days('Not/AZone')).toBeTruthy()
    app.db.raw.prepare("DELETE FROM play_sessions WHERE game = 'third'").run()
  })

  it('clears only Finished when a 3.x client marks a game not finished', async () => {
    await request(app.app).put('/api/games/third/status').send({ status: 'dropped' }).expect(200)
    await request(app.app).put('/api/games/third/finished').send({ on: false }).expect(200)
    expect((await request(app.app).get('/api/games/third').expect(200)).body.game.playStatus).toBe('dropped')
  })

  it('moves the play history along when one person is merged into another', async () => {
    const other = (await request(app.app).post('/api/users').send({ username: 'second', name: 'Second', password: 'second-password-1' }).expect(201)).body.user
    app.db.raw.prepare("INSERT INTO play_sessions (user_id, game, started_at, ended_at, seconds) VALUES (?, 'story', 1000, 2000, 60)").run(other.id)
    app.db.raw.prepare("INSERT INTO user_games (user_id, game, rating, play_status) VALUES (?, 'story', 5, 'dropped')").run(other.id)
    await request(app.app).post(`/api/users/${other.id}/merge`).send({ target: 1 }).expect(200)
    expect((app.db.raw.prepare('SELECT COUNT(*) n FROM play_sessions WHERE user_id = ?').get(other.id) as { n: number }).n).toBe(0)
    expect((await request(app.app).get('/api/history').expect(200)).body.totals.seconds).toBe(180)
    expect(await game()).toMatchObject({ rating: 5, playStatus: 'dropped' })
  })

  it('keeps Finished in step with finished_at when people are merged', async () => {
    await request(app.app).put('/api/games/third/status').send({ status: 'playing' }).expect(200)
    const other = (await request(app.app).post('/api/users').send({ username: 'third-person', name: 'Third', password: 'third-password-1' }).expect(201)).body.user
    app.db.raw.prepare("INSERT INTO user_games (user_id, game, play_status, finished_at) VALUES (?, 'third', 'finished', '2026-01-01T00:00:00.000Z')").run(other.id)
    await request(app.app).post(`/api/users/${other.id}/merge`).send({ target: 1 }).expect(200)
    expect((await request(app.app).get('/api/games/third').expect(200)).body.game).toMatchObject({ playStatus: 'finished', finishedAt: '2026-01-01T00:00:00.000Z' })
  })
})

describe('names, notes and pins of saves', () => {
  let root = ''
  let app: App

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'renplay-savemeta-'))
    process.env['DATA_DIR'] = join(root, 'data')
    process.env['GAMES_DIR'] = join(root, 'games')
    process.env['RENPLAY_AUTH'] = 'off'
    process.env['RENPLAY_CATALOG_URLS'] = 'http://127.0.0.1:9/none'
    process.env['RENPLAY_ENGINES_URL'] = 'http://127.0.0.1:9/none'
    const cfg = loadConfig()
    const db = Db.open(cfg.dataDir)
    db.insertGame({ id: 'story', title: 'Story', status: 'installed', save_dir: 'Story-1' })
    db.close()
    app = await createApp(cfg, { startJobs: false })
    await app.saves.write('Story-1', '1-1-LT1.save', Buffer.from('a save'))
  })
  afterAll(() => {
    app?.close()
    rmSync(root, { recursive: true, force: true })
    for (const k of ['DATA_DIR', 'GAMES_DIR', 'RENPLAY_AUTH', 'RENPLAY_CATALOG_URLS', 'RENPLAY_ENGINES_URL']) delete process.env[k]
  })

  it('names, notes and pins a save for this person, and the file stays as it was', async () => {
    const before = (await app.saves.read('Story-1', '1-1-LT1.save')).toString()
    await request(app.app).put('/api/saves/story/meta?file=1-1-LT1.save').send({ title: 'Before the storm', note: 'Choose the lake next time.', pinned: true }).expect(200)
    const slot = (await request(app.app).get('/api/saves/story').expect(200)).body.slots.find((s: { file: string }) => s.file === '1-1-LT1.save')
    expect(slot).toMatchObject({ title: 'Before the storm', note: 'Choose the lake next time.' })
    expect(slot.pinnedAt).toMatch(/^\d{4}-/)
    expect((await app.saves.read('Story-1', '1-1-LT1.save')).toString()).toBe(before)
    // A pinned save keeps its history.
    expect(app.saves.pinned('Story-1', '1-1-LT1.save')).toBe(true)
    await request(app.app).put('/api/saves/story/meta?file=1-1-LT1.save').send({ pinned: false }).expect(200)
    expect(app.saves.pinned('Story-1', '1-1-LT1.save')).toBe(false)
    await request(app.app).put('/api/saves/story/meta?file=1-1-LT1.save').send({ title: 'x'.repeat(81) }).expect(400)
    await request(app.app).put('/api/saves/story/meta?file=../x.save').send({ title: 'x' }).expect(400)
    // Clearing everything removes the row.
    await request(app.app).put('/api/saves/story/meta?file=1-1-LT1.save').send({ title: '', note: '' }).expect(200)
    expect((app.db.raw.prepare('SELECT COUNT(*) n FROM save_meta').get() as { n: number }).n).toBe(0)
  })

  it('keeps a save another device changed when an old delete arrives, and a deleted save forgets its name', async () => {
    await app.saves.write('Story-1', '6-1-LT1.save', Buffer.from('first'))
    const seen = (await app.saves.stat('Story-1', '6-1-LT1.save'))!.mtimeMs
    await app.saves.write('Story-1', '6-1-LT1.save', Buffer.from('another device'), { mtimeMs: seen + 5000 })
    const kept = await request(app.app).delete('/api/saves/story/file?path=Story-1/6-1-LT1.save').set('x-base', String(seen)).expect(409)
    expect(kept.body).toMatchObject({ conflict: 'kept', mtime: seen + 5000 })
    expect((await app.saves.read('Story-1', '6-1-LT1.save')).toString()).toBe('another device')
    await request(app.app).put('/api/saves/story/meta?file=6-1-LT1.save').send({ title: 'Before the finale', pinned: true }).expect(200)
    await request(app.app).delete('/api/saves/story/slot?file=6-1-LT1.save').expect(200)
    expect(app.db.raw.prepare("SELECT COUNT(*) n FROM save_meta WHERE file = '6-1-LT1.save'").get()).toEqual({ n: 0 })
    // The raw read says which version it sent.
    await app.saves.write('Story-1', '7-1-LT1.save', Buffer.from('x'), { mtimeMs: seen })
    expect((await request(app.app).get('/api/saves/story/raw?path=Story-1/7-1-LT1.save').expect(200)).headers['x-renplay-mtime']).toBe(String(seen))
  })

  it('chooses for everyone only a picture everyone has: a personal upload is refused', async () => {
    const pngOf = (color: string) => sharp({ create: { width: 600, height: 900, channels: 3, background: color } }).png().toBuffer()
    const mine = (await request(app.app).post('/api/games/story/art/upload?kind=grid&scope=me').set('content-type', 'image/png').send(await pngOf('#335')).expect(200)).body
    const id = mine.id ?? mine.candidate ?? mine.picture
    expect(id).toBeTruthy()
    await request(app.app).put('/api/games/story/art').send({ kind: 'grid', candidate: id, scope: 'me' }).expect(200)
    expect((await request(app.app).put('/api/games/story/art').send({ kind: 'grid', candidate: id, scope: 'everyone' }).expect(409)).body.error).toContain('for everyone first')
    const shared = (await request(app.app).post('/api/games/story/art/upload?kind=grid&scope=everyone').set('content-type', 'image/png').send(await pngOf('#553')).expect(200)).body
    await request(app.app).put('/api/games/story/art').send({ kind: 'grid', candidate: shared.id ?? shared.candidate ?? shared.picture, scope: 'everyone' }).expect(200)
  })

  it('deletes one’s own upload, and forgets a game’s art with the game', async () => {
    const pngOf = (color: string) => sharp({ create: { width: 600, height: 900, channels: 3, background: color } }).png().toBuffer()
    const mine = (await request(app.app).post('/api/games/story/art/upload?kind=grid&scope=me').set('content-type', 'image/png').send(await pngOf('#713')).expect(200)).body.id
    const listed = (await request(app.app).get('/api/games/story/art?kind=grid').expect(200)).body.candidates.find((c: { id: string }) => c.id === mine)
    expect(listed).toMatchObject({ upload: true, ownUpload: true, sharedUpload: false })
    await request(app.app).delete(`/api/games/story/art/uploads/${mine}?kind=grid&scope=everyone`).expect(404)
    await request(app.app).delete(`/api/games/story/art/uploads/${mine}?kind=grid&scope=me`).expect(200)
    await request(app.app).delete(`/api/games/story/art/uploads/${mine}?kind=grid&scope=me`).expect(404)
    await request(app.app).delete('/api/games/story/art/uploads/not-an-id?kind=grid&scope=me').expect(404)
    expect(app.db.raw.prepare("SELECT COUNT(*) n FROM art_choices WHERE candidate = ?").get(mine)).toEqual({ n: 0 })
    app.db.insertGame({ id: 'gone', title: 'Gone', status: 'not_installed', save_dir: 'Gone-1' })
    await request(app.app).post('/api/games/gone/art/upload?kind=grid&scope=me').set('content-type', 'image/png').send(await pngOf('#317')).expect(200)
    await request(app.app).delete('/api/games/gone?forget=1').expect(200)
    expect(app.db.raw.prepare("SELECT COUNT(*) n FROM art_uploads WHERE game = 'gone'").get()).toEqual({ n: 0 })
  })

  it('says who started an install, so Choose artwork opens for them alone', async () => {
    const id = app.jobs.enqueue('import', 'story', { source: { kind: 'archive', path: 'story.zip' }, by: 1 })
    const job = (await request(app.app).get('/api/jobs').expect(200)).body.jobs.find((j: { id: string }) => j.id === id)
    expect(job.params).toEqual({ source: { kind: 'archive', path: 'story.zip' }, by: 1 })
    app.db.raw.prepare('DELETE FROM jobs WHERE id = ?').run(id)
  })

  it('keeps each person’s tag preferences for the catalog', async () => {
    expect((await request(app.app).get('/api/me/tags').expect(200)).body).toEqual({ include: [], exclude: [], source: 'default' })
    expect((await request(app.app).put('/api/me/tags').send({ include: ['romance', 'romance'], exclude: ['horror', 'romance'] }).expect(200)).body).toEqual({ include: ['romance'], exclude: ['horror'], source: 'you' })
    expect((await request(app.app).get('/api/me/tags').expect(200)).body).toEqual({ include: ['romance'], exclude: ['horror'], source: 'you' })
    await request(app.app).put('/api/me/tags').send({ include: ['Not A Tag'] }).expect(400)
    await request(app.app).put('/api/me/tags').send({ exclude: 'horror' }).expect(400)
    // The 3.x picture preference stays beside it, for a downgrade.
    expect(JSON.parse((app.db.raw.prepare('SELECT prefs FROM users WHERE id = 1').get() as { prefs: string }).prefs)).toMatchObject({ tags: { include: ['romance'] } })
  })

  it('tells a device about a conflict and lists it with the saves', async () => {
    const put = (body: string, mtime: number, base?: number) => {
      const r = request(app.app).put('/api/saves/story/file?path=Story-1/3-1-LT1.save').set('content-type', 'application/octet-stream').set('x-mtime', String(mtime))
      return (base === undefined ? r : r.set('x-base', String(base))).send(Buffer.from(body)).expect(200)
    }
    const now = Date.now()
    const a = (await put('a', now - 30_000, 0)).body
    expect(a.conflict).toBeUndefined()
    await put('b', now - 20_000, a.mtime)
    expect((await put('older', now - 25_000, a.mtime)).body).toMatchObject({ conflict: 'kept' })
    expect((await app.saves.read('Story-1', '3-1-LT1.save')).toString()).toBe('b')
    // Without the header (a runtime from 3.x) the write is delivered as before.
    expect((await put('c', now - 10_000)).body.conflict).toBeUndefined()
    const listed = (await request(app.app).get('/api/saves/story').expect(200)).body.conflicts
    expect(listed).toEqual([expect.objectContaining({ file: '3-1-LT1.save' })])
  })

  it('imports a computer’s Ren’Py folder: newer copies take the slot, older ones go to History', async () => {
    const index = (await request(app.app).get('/api/saves-import').expect(200)).body
    expect(index.games['Story-1']).toEqual({ id: 'story', title: 'Story' })
    const server = index.dirs['Story-1']
    expect(Object.keys(server)).toEqual(expect.arrayContaining(['1-1-LT1.save', '3-1-LT1.save']))
    await app.saves.write('Story-1', 'persistent', Buffer.from('web persistent'))
    const persistent = (await app.saves.stat('Story-1', 'persistent'))!.mtimeMs
    const files: Array<[string, string, number]> = [
      ['Story-1/1-1-LT1.save', 'older on the computer', server['1-1-LT1.save'].mtime - 60_000],
      ['Story-1/3-1-LT1.save', 'newer on the computer', server['3-1-LT1.save'].mtime + 1000],
      ['Story-1/9-1-LT1.save', 'only on the computer', Date.now() - 5000],
      ['Story-1/persistent', 'desktop persistent', persistent - 60_000],
      ['Later-7/1-1-LT1.save', 'a game added later', Date.now() - 5000],
      ['Story-1/sync/1-1-LT1.save', 'a sync copy', Date.now() - 5000],
      ['tokens/security_keys.txt', 'signing-key ' + 'ab'.repeat(32), Date.now()],
    ]
    // Saves are Ren'Py save files (zips with a log), the persistent data and keys are plain.
    const bodyOf = async (path: string, body: string) => (path.endsWith('.save') ? renpySave(body) : Buffer.from(body))
    let r = request(app.app).post('/api/saves-import').field('meta', JSON.stringify(files.map(([path, , mtime]) => ({ path, mtime }))))
    for (const [path, body] of files) r = r.attach('files', await bodyOf(path, body), path.split('/').pop()!)
    const report = (await r.expect(200)).body
    expect(report).toMatchObject({ added: 2, replaced: 1, kept: 2, same: 0, skipped: ['Story-1/sync/1-1-LT1.save'] })
    expect((await app.saves.read('Story-1', '1-1-LT1.save')).toString()).toBe('a save')
    expect(await saveText(await app.saves.read('Story-1', '3-1-LT1.save'))).toBe('newer on the computer')
    expect((await app.saves.read('Story-1', 'persistent')).toString()).toBe('web persistent')
    expect(await saveText(await app.saves.read('Later-7', '1-1-LT1.save'))).toBe('a game added later')
    const kept = (await app.saves.history('Story-1')).filter((v) => v.reason === 'conflict').map((v) => v.name)
    expect(kept).toEqual(expect.arrayContaining(['1-1-LT1.save', 'persistent', '3-1-LT1.save']))
    // The same folder again changes nothing.
    let again = request(app.app).post('/api/saves-import').field('meta', JSON.stringify([{ path: 'Story-1/3-1-LT1.save', mtime: 1 }]))
    again = again.attach('files', await app.saves.read('Story-1', '3-1-LT1.save'), '3-1-LT1.save')
    expect((await again.expect(200)).body).toMatchObject({ added: 0, replaced: 0, kept: 0, same: 1 })
    // A broken or empty file never takes a save's place, and a bad entry in the list writes nothing.
    let broken = request(app.app).post('/api/saves-import').field('meta', JSON.stringify([{ path: 'Story-1/3-1-LT1.save', mtime: Date.now() }]))
    broken = broken.attach('files', Buffer.alloc(0), '3-1-LT1.save')
    expect((await broken.expect(200)).body).toMatchObject({ added: 0, replaced: 0, skipped: ['Story-1/3-1-LT1.save'] })
    expect(await saveText(await app.saves.read('Story-1', '3-1-LT1.save'))).toBe('newer on the computer')
    await request(app.app).post('/api/saves-import').field('meta', JSON.stringify([{ path: 'Story-1/8-1-LT1.save', mtime: 1 }, null])).attach('files', await renpySave('x'), '8-1-LT1.save').attach('files', Buffer.from('y'), 'y.save').expect(400)
    expect(await app.saves.stat('Story-1', '8-1-LT1.save')).toBeNull()
    // A path out of the save folders, and a list that does not match the files.
    await request(app.app).post('/api/saves-import').field('meta', JSON.stringify([{ path: '../escape.save', mtime: 1 }])).attach('files', Buffer.from('x'), 'escape.save').expect(400)
    await request(app.app).post('/api/saves-import').field('meta', '[]').attach('files', Buffer.from('x'), 'x.save').expect(400)
  })
})
