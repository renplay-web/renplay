import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import yazl from 'yazl'
import { archiveIdentity } from '../archive-origin.js'
import { createApp, type App } from '../app.js'
import { loadConfig } from '../config.js'
import { renderPage } from '../routes/play.js'
import { cleanRelPath, safeJoin } from '../util/paths.js'

function zipBuffer(entries: Record<string, Buffer | string>): Promise<Buffer> {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile()
    for (const [k, v] of Object.entries(entries)) z.addBuffer(Buffer.from(v), k)
    z.end()
    const chunks: Buffer[] = []
    z.outputStream.on('data', (c: Buffer) => chunks.push(c))
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/** The relevant parts of Ren'Py 8.5's web index.html. */
const TEMPLATE = `<!doctype html><html><head><title>Ren'Py Web Game</title><meta name="viewport" content="width=device-width">
<link rel="manifest" href="manifest.json" crossorigin="use-credentials" />
<link rel="icon" href="icons/icon-72x72.png" sizes="72x72" type="image/png" />
</head><body><img id="presplash" src="web-presplash.jpg">
<script>
  window.gameZipURL = 'game.zip';
  if (navigator.serviceWorker) { navigator.serviceWorker.register('./service-worker.js', { updateViaCache: 'all' }); }
</script>
<script src="renpy-pre.js"></script>
<script async type="text/javascript" src="renpy.js"></script>
</body></html>`

describe('HTTP API', () => {
  let app: App
  let root: string
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'renplay-api-'))
    // An installed engine pack and one installed build.
    const engine = join(root, 'games', '_renplay', 'engines', '8.5.3')
    mkdirSync(engine, { recursive: true })
    writeFileSync(join(engine, 'index.html'), TEMPLATE)
    writeFileSync(join(engine, '.ready'), '{}')
    const build = join(root, 'games', 'fixture-game', 'b1')
    mkdirSync(build, { recursive: true })
    writeFileSync(join(build, 'game.zip'), await zipBuffer({ 'game/script.rpyc': 'x', 'game/renpyweb_remote_files.txt': 'images/a b.png\nimage 1920,1080\n' }))
    writeFileSync(join(build, 'assets.pack'), 'xxpng0123456789')
    writeFileSync(join(build, 'assets.json'), JSON.stringify({ 'images/a b.png': [2, 3], 'movies/m.webm': [5, 10] }))
    process.env['DATA_DIR'] = join(root, 'data')
    process.env['GAMES_DIR'] = join(root, 'games')
    process.env['RENPLAY_CATALOG_URLS'] = 'http://127.0.0.1:9/none'
    process.env['RENPLAY_ENGINES_URL'] = 'http://127.0.0.1:9/none'
    // A leftover database of renplay 2.0 is dropped.
    mkdirSync(join(root, 'data'), { recursive: true })
    writeFileSync(join(root, 'data', 'renplay.db'), 'old')
    app = await createApp(loadConfig(), { startJobs: false })
    app.db.insertGame({ id: 'fixture-game', title: 'Fixture Game', status: 'installed', engine: '8.5.3', build: 'b1', save_dir: 'MyGame-1234567890', screen_w: 1920, screen_h: 1080 })
  })
  afterAll(() => app?.close())

  it('replaced the old database', () => {
    expect(() => readFileSync(join(root, 'data', 'renplay.db'))).toThrow()
    expect(readFileSync(join(root, 'data', 'library.db')).length).toBeGreaterThan(0)
  })

  it('lists games by id with their play URL', async () => {
    const res = await request(app.app).get('/api/games').expect(200)
    expect(res.body.games[0]).toMatchObject({ id: 'fixture-game', title: 'Fixture Game', status: 'installed', engine: '8.5.3', playUrl: '/g/fixture-game/b1/', screen: [1920, 1080] })
  })

  it('exposes catalog vocabulary, metadata and matched display versions', async () => {
    const recipe = { id: 'metadata-game', title: 'Metadata Game', engine: 'renpy', free: true, cover: { url: 'cover.png', sfw: true }, tags: ['sci-fi'], tagIds: ['sci-fi'], content: ['violence'], state: 'completed', summary: 'A journey through time.', releases: [
      { version: '0.9.24', status: 'playable', archives: [] },
      { version: '0.9.23', status: 'verified', archives: [{ name: 'Metadata-Ch4Up7Public-pc.zip' }] },
    ] }
    const vocabulary = { 'sci-fi': { label: 'Sci-fi', group: 'story' } }
    app.catalog.stop()
    app.db.setSetting('catalog_cache', { at: Date.now(), vocabulary, games: [recipe, { id: 'legacy-game', title: 'Legacy', tags: ['romance'], releases: [] }] })
    await app.catalog.init()
    app.db.insertGame({ id: 'metadata-game', title: 'Internal', recipe_id: recipe.id, version: 'Ch4Up7Public', source: JSON.stringify({ archive: 'folder/Metadata-Ch4Up7Public-pc.zip' }) })
    app.db.insertGame({ id: 'legacy-game', title: 'Legacy', recipe_id: 'legacy-game', version: '.510b' })
    const catalog = (await request(app.app).get('/api/catalog').expect(200)).body
    expect(catalog.vocabulary).toEqual(vocabulary)
    expect(catalog.games.find((g: { id: string }) => g.id === recipe.id)).toMatchObject({ free: true, tagIds: ['sci-fi'], local: { version: '0.9.23', detectedVersion: 'Ch4Up7Public' } })
    const game = (await request(app.app).get('/api/games/metadata-game').expect(200)).body.game
    expect(game.createdAt).toBe(app.db.getGame('metadata-game')!.created_at)
    expect(game).toMatchObject({ free: true, tags: ['sci-fi'], tagIds: ['sci-fi'], content: ['violence'], state: 'completed', summary: recipe.summary, version: '0.9.23', detectedVersion: 'Ch4Up7Public', recipe: { status: 'verified' }, update: { version: '0.9.24' } })
    const legacy = (await request(app.app).get('/api/games/legacy-game').expect(200)).body.game
    expect(legacy).toMatchObject({ tags: ['romance'], tagIds: [], content: [], state: null, summary: null, version: '.510b', detectedVersion: '.510b', favoriteAt: null })
    app.db.deleteGame('metadata-game')
    app.db.deleteGame('legacy-game')
  })

  it('sets and clears favourites, preserving them on uninstall but not forget', async () => {
    app.db.insertGame({ id: 'favorite-game', title: 'Favorite', status: 'installed' })
    const path = '/api/games/favorite-game'
    expect((await request(app.app).get(path).expect(200)).body.game.favoriteAt).toBeNull()
    await request(app.app).put(`${path}/favorite`).send({ on: 'true' }).expect(400)
    await request(app.app).put(`${path}/favorite`).send({}).expect(400)
    await request(app.app).put('/api/games/missing/favorite').send({ on: true }).expect(404)
    const set = (await request(app.app).put(`${path}/favorite`).send({ on: true }).expect(200)).body
    expect(set.ok).toBe(true)
    const timestamp = set.game.favoriteAt
    expect(new Date(timestamp).toISOString()).toBe(timestamp)
    expect((await request(app.app).put(`${path}/favorite`).send({ on: true }).expect(200)).body.game.favoriteAt).toBe(timestamp)
    expect((await request(app.app).delete(path).expect(200)).body.game).toMatchObject({ status: 'not_installed', favoriteAt: timestamp })
    expect((await request(app.app).put(`${path}/favorite`).send({ on: false }).expect(200)).body.game.favoriteAt).toBeNull()
    await request(app.app).put(`${path}/favorite`).send({ on: true }).expect(200)
    await request(app.app).delete(`${path}?forget=1`).expect(200)
    expect(app.db.getGame('favorite-game')).toBeNull()
  })

  it('stores finished state and measured play time without changing saves', async () => {
    app.db.insertGame({ id: 'progress-game', title: 'Progress', save_dir: 'Progress-123' })
    const path = '/api/games/progress-game'
    expect((app.db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(18)
    expect((await request(app.app).get(path)).body.game).toMatchObject({ playTime: 0, finishedAt: null, latestSave: null })
    for (const on of [undefined, 'true', 1]) await request(app.app).put(`${path}/finished`).send({ on }).expect(400)
    await request(app.app).put('/api/games/missing/finished').send({ on: true }).expect(404)
    const timestamp = (await request(app.app).put(`${path}/finished`).send({ on: true }).expect(200)).body.game.finishedAt
    expect(new Date(timestamp).toISOString()).toBe(timestamp)
    expect((await request(app.app).put(`${path}/finished`).send({ on: true })).body.game.finishedAt).toBe(timestamp)
    for (const seconds of [-1, 0, 61, 1.5, '10', null]) await request(app.app).post(`${path}/play-time`).send({ seconds }).expect(400)
    await request(app.app).post('/api/games/missing/play-time').send({ seconds: 10 }).expect(404)
    await request(app.app).post(`${path}/play-time`).send({ seconds: 15 }).expect(200)
    // The next report comes ten seconds later, as the player sends them.
    app.db.raw.prepare('UPDATE play_sessions SET started_at = started_at - 10000, ended_at = ended_at - 10000').run()
    await request(app.app).post(`${path}/play-time`).send({ seconds: 10 }).expect(200)
    expect((await request(app.app).delete(path).expect(200)).body.game).toMatchObject({ playTime: 25, finishedAt: timestamp })
    expect((await request(app.app).put(`${path}/finished`).send({ on: false })).body.game.finishedAt).toBeNull()
    app.db.deleteGame('progress-game')
  })

  it('includes the newest valid save in the library and refreshes changed metadata', async () => {
    app.db.insertGame({ id: 'latest-game', title: 'Latest', save_dir: 'Latest-123' })
    const save = (name: string, ctime: number) => zipBuffer({ log: 'pickle', json: JSON.stringify({ _save_name: name, _ctime: ctime, _game_runtime: 42 }), 'screenshot.png': 'png' })
    await app.saves.write('Latest-123', '1-1-LT1.save', await save('First scene', 100))
    await app.saves.write('Latest-123', 'auto-1-LT1.save', await save('Next scene', 200))
    await app.saves.write('Latest-123', 'quick-1-LT1.save', Buffer.from('broken'))
    await app.saves.write('Latest-123', '_internal.save', await save('Internal', 999))
    const latest = async () => (await request(app.app).get('/api/games').expect(200)).body.games.find((game: { id: string }) => game.id === 'latest-game')
    expect(await latest()).toMatchObject({ playTime: 0, latestSave: { file: 'auto-1-LT1.save', name: 'Next scene', ctime: 200000, runtime: 42 } })
    expect((await latest()).latestSave.screenshot).toContain('/api/saves/latest-game/screenshot?user=1&file=auto-1-LT1.save')
    await app.saves.write('Latest-123', '1-1-LT1.save', await save('A newer scene', 300))
    expect((await latest()).latestSave).toMatchObject({ file: '1-1-LT1.save', name: 'A newer scene', ctime: 300000 })
    await app.saves.remove('Latest-123', '1-1-LT1.save', 'user-delete')
    expect((await latest()).latestSave.name).toBe('Next scene')
    app.db.deleteGame('latest-game')
    rmSync(join(app.saves.root, 'Latest-123'), { recursive: true, force: true })
  })

  it('paginates jobs with a total and stable ordering for equal timestamps', async () => {
    for (let i = 0; i < 5; i++) {
      app.db.insertJob({ id: `page-${i}`, type: 'test', game: '', params: '{}' })
      app.db.updateJob(`page-${i}`, { status: 'done', created_at: '2026-11-04T12:00:00.000Z' })
    }
    const first = (await request(app.app).get('/api/jobs?limit=2').expect(200)).body
    expect(first.total).toBe(5)
    expect(first.busy).toBe(false)
    expect(first.jobs.map((j: { id: string }) => j.id)).toEqual(['page-4', 'page-3'])
    expect((await request(app.app).get('/api/jobs?limit=2&offset=2').expect(200)).body.jobs.map((j: { id: string }) => j.id)).toEqual(['page-2', 'page-1'])
    expect((await request(app.app).get('/api/jobs?limit=2&offset=4').expect(200)).body.jobs).toHaveLength(1)
    expect((await request(app.app).get('/api/jobs?limit=2&offset=5').expect(200)).body.jobs).toEqual([])
    for (const query of ['limit=-1&offset=-2', 'limit=NaN&offset=no', 'limit=1.5&offset=2.5', 'limit=Infinity']) {
      expect((await request(app.app).get(`/api/jobs?${query}`).expect(200)).body.jobs).toHaveLength(5)
    }
    expect((await request(app.app).get('/api/jobs?limit=0').expect(200)).body.jobs).toHaveLength(1)
    await request(app.app).delete('/api/jobs').expect(200)
  })

  it('refuses an install into a game that is not in the library before doing any work', async () => {
    const res = await request(app.app)
      .post('/api/imports')
      .send({ source: { kind: 'archive', path: 'whatever.zip' }, game: 'no-such-game' })
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/not in the library/)
  })

  it('offers a reinstall only while the archive is in the archives folder', async () => {
    mkdirSync(join(root, 'games', '_archives'), { recursive: true })
    writeFileSync(join(root, 'games', '_archives', 'Fixture-1.0-pc.zip'), 'zip')
    app.db.updateGame('fixture-game', { source: JSON.stringify({ archive: 'Fixture-1.0-pc.zip', size: 3 }) })
    const canReinstall = async () => (await request(app.app).get('/api/games').expect(200)).body.games[0].canReinstall
    expect(await canReinstall()).toBe(true)
    await request(app.app).delete('/api/archives?path=Fixture-1.0-pc.zip').expect(200)
    expect(await canReinstall()).toBe(false)
  })

  it('serves an HTML game’s page with the runtime and its stored localStorage first', async () => {
    const page = '<!doctype html><html><head><title>Story</title><script>window.gameScript = 1</script></head><body></body></html>'
    const other = '<p>credits</p>'
    const wasm = '\0asm'
    const build = join(root, 'games', 'twine-story', 'h1')
    mkdirSync(build, { recursive: true })
    writeFileSync(join(build, 'assets.pack'), page + other + wasm)
    writeFileSync(join(build, 'assets.json'), JSON.stringify({ 'Story Page.html': [0, page.length], 'credits.html': [page.length, other.length], 'Build/Game.wasm.br': [page.length + other.length, wasm.length] }))
    app.db.insertGame({ id: 'twine-story', title: 'Story', status: 'installed', build: 'h1', family: 'html', engine_label: 'HTML (SugarCube 2.36.1)', entry: 'Story Page.html', save_dir: 'story' })
    await app.saves.write('story', 'localStorage.json', Buffer.from(JSON.stringify({ 'story.saves': '{"slots":[1]}' })))

    const g = (await request(app.app).get('/api/games/twine-story').expect(200)).body.game
    expect(g).toMatchObject({ family: 'html', engineLabel: 'HTML (SugarCube 2.36.1)' })
    expect(g.playUrl).toMatch(/^\/g\/twine-story\/h1\/s\/[^/]+\/game\/Story%20Page.html$/)
    expect((await request(app.app).get('/g/twine-story/h1/').expect(302)).headers.location).toBe('/g/twine-story/h1/game/Story%20Page.html')

    const res = await request(app.app).get('/g/twine-story/h1/game/Story%20Page.html').expect(200)
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.headers['access-control-allow-origin']).toBe('*')
    const at = (s: string) => res.text.indexOf(s)
    expect(at('window.__renplay=')).toBeGreaterThan(at('<head>'))
    expect(at('window.__renplay=')).toBeLessThan(at('window.gameScript'))
    expect(at("renplay:' + type")).toBeGreaterThan(at('window.__renplay='))
    expect(res.text).toContain('"story.saves":"{\\"slots\\":[1]}"')
    // The in-memory IndexedDB comes first, then the runtime that installs it.
    expect(at('window.__renplayIDB')).toBeGreaterThan(at('window.__renplay='))
    expect(at('window.__renplayIDB')).toBeLessThan(at("renplay:' + type"))
    // Other pages of the game are plain files.
    const plain = await request(app.app).get('/g/twine-story/h1/game/credits.html').expect(200)
    expect(plain.text).toBe(other)
    expect(plain.headers['content-type']).toBe('text/html; charset=utf-8')
    // Unity names files .wasm.br; served as they are, they need the type underneath.
    const unity = await request(app.app).get('/g/twine-story/h1/game/Build/Game.wasm.br').expect(200)
    expect(unity.headers['content-type']).toBe('application/wasm')
    expect(unity.headers['content-encoding']).toBeUndefined()
    await app.saves.remove('story', 'localStorage.json', 'test')
    // The startup check knows HTML builds have no game.zip.
    const checked = await app.builds.verify()
    expect(checked.missing).not.toContain('twine-story')
    expect(app.db.getGame('twine-story')?.status).toBe('installed')
    await request(app.app).get('/api/games/twine-story/files').expect(409)
  })

  it('renders the game page from the engine template', async () => {
    const res = await request(app.app).get('/g/fixture-game/b1/').expect(200)
    expect(res.text).toContain('<title>Fixture Game</title>')
    expect(res.text).toContain('window.__renplay=')
    expect(res.text).toContain('src="/engine/8.5.3/renpy-pre.js"')
    expect(res.text).toContain('src="/engine/8.5.3/web-presplash.jpg"')
    expect(res.text).not.toMatch(/src="[^"]*renpy\.js"/)
    expect(res.text).not.toContain('manifest.json')
    expect(res.text).not.toMatch(/navigator\.serviceWorker\.register\(/)
    expect(res.text.indexOf('__renplayLate')).toBeGreaterThan(res.text.indexOf('renpy-pre.js'))
    await request(app.app).get('/g/fixture-game/old/').expect(302)
  })

  it('serves mod builds with fallback to the base build', async () => {
    const mod = join(root, 'games', 'fixture-game', 'b1.mabc')
    mkdirSync(mod, { recursive: true })
    writeFileSync(join(mod, 'game.zip'), 'modded')
    app.db.updateGame('fixture-game', { build: 'b1.mabc' })
    try {
      expect((await request(app.app).get('/g/fixture-game/b1.mabc/game.zip').responseType('blob').expect(200)).body.toString()).toBe('modded')
      expect((await request(app.app).get('/g/fixture-game/b1.mabc/game/images/a%20b.png').responseType('blob').expect(200)).body.toString()).toBe('png')
    } finally {
      app.db.updateGame('fixture-game', { build: 'b1' })
    }
  })

  it('serves streamed files from the pack, with byte ranges', async () => {
    const r = await request(app.app).get('/g/fixture-game/b1/game/images/a%20b.png').responseType('blob').expect(200)
    expect(r.body.toString()).toBe('png')
    expect(r.headers['content-type']).toBe('image/png')
    expect(r.headers['cache-control']).toBe('private, no-store')
    const part = await request(app.app).get('/g/fixture-game/b1/game/movies/m.webm').set('Range', 'bytes=2-4').responseType('blob').expect(206)
    expect(part.body.toString()).toBe('234')
    expect(part.headers['content-range']).toBe('bytes 2-4/10')
    await request(app.app).get('/g/fixture-game/b1/game/movies/m.webm').set('Range', 'bytes=20-').expect(416)
    await request(app.app).get('/g/fixture-game/b1/game/missing.png').expect(404)
    await request(app.app).get('/g/fixture-game/b1/game/..%2F..%2Fsecret').expect(400)
  })

  it('stores bytecode caches for the current build only', async () => {
    const put = (name: string, build = 'b1') => request(app.app).put(`/api/games/fixture-game/cache?build=${build}&name=${encodeURIComponent(name)}`).set('content-type', 'application/octet-stream').send(Buffer.alloc(64, 1))
    await put('bytecode-312.rpyb').expect(200)
    await put('rpyc/chapters/week1.rpyc').expect(200)
    await put('bytecode-312.rpyb', 'old').expect(409)
    await put('evil.py').expect(400)
    await put('rpyc/../../b1/game.zip').expect(400)
    const page = await request(app.app).get('/g/fixture-game/b1/').expect(200)
    const caches = JSON.parse(page.text.match(/"caches":(\[[^\]]*\])/)![1]!).map((c: { name: string }) => c.name).sort()
    expect(caches).toEqual(['bytecode-312.rpyb', 'rpyc/chapters/week1.rpyc'])
  })

  it('stores saves written by the game and serves them back at boot', async () => {
    const save = await zipBuffer({ log: 'x', json: '{"_save_name":"From test"}', 'screenshot.png': 'png' })
    await request(app.app).put('/api/saves/fixture-game/file?path=MyGame-1234567890/1-1-LT1.save').set('content-type', 'application/octet-stream').set('x-mtime', '1700000000000').send(save).expect(200)
    await request(app.app).put('/api/saves/fixture-game/file?path=tokens/security_keys.txt').set('content-type', 'application/octet-stream').send(Buffer.from('signing-key A B\n')).expect(200)
    // Another game's folder is part of the shared tree but only listed at boot.
    await request(app.app).put('/api/saves/fixture-game/file?path=Season1-1/9-9-LT1.save').set('content-type', 'application/octet-stream').send(Buffer.from('s1')).expect(200)

    const boot = (await request(app.app).get('/api/saves/fixture-game/boot').expect(200)).body
    expect(boot.saveDir).toBe('MyGame-1234567890')
    expect(boot.files.map((f: any) => f.path).sort()).toEqual(['MyGame-1234567890/1-1-LT1.save', 'tokens/security_keys.txt'])
    expect(boot.lazy).toEqual([expect.objectContaining({ path: 'Season1-1/9-9-LT1.save', size: 2 })])

    const slots = (await request(app.app).get('/api/saves/fixture-game').expect(200)).body
    expect(slots.slots).toEqual([expect.objectContaining({ file: '1-1-LT1.save', name: 'From test', kind: 'manual' })])
  })

  it('learns the screen size and save folder from the running game', async () => {
    app.db.updateGame('fixture-game', { screen_w: 0, screen_h: 0 })
    await request(app.app).post('/api/saves/fixture-game/save-dir').send({ saveDir: 'MyGame-1234567890', screen: [1280, 720] }).expect(200)
    expect((await request(app.app).get('/api/games/fixture-game')).body.game.screen).toEqual([1280, 720])
  })

  it('exports a recipe', async () => {
    const res = await request(app.app).get('/api/games/fixture-game/recipe').expect(200)
    expect(res.body.yaml).toMatch(/^# yaml-language-server: \$schema=https:\/\/catalog\.renplay\.org\/recipe\.schema\.json\nid: fixture-game\n/)
    expect(res.body.yaml).toContain('saveDir: MyGame-1234567890')
    expect(res.body.yaml).toContain('engine: renpy')
    expect(res.body.yaml).toContain('runtime: 8.5.3')
  })

  it('refuses unsafe paths', async () => {
    await request(app.app).put('/api/saves/fixture-game/file?path=../../etc/passwd').send(Buffer.from('x')).expect(400)
    await request(app.app).get('/api/saves/..%2F..%2Fx/boot').expect(400)
    await request(app.app).get('/g/fixture-game/b1/..%2F..%2F_renplay/engines/8.5.3/.ready').expect(400)
  })

  it('creates uploads at /api/uploads without a trailing slash', async () => {
    const r = await request(app.app).post('/api/uploads').send({ name: 'Game-1.0-pc.zip', size: 10 }).expect(200)
    expect(r.body.id).toMatch(/^u/)
    await request(app.app).put(`/api/uploads/${r.body.id}?offset=0`).set('Content-Type', 'application/octet-stream').send(Buffer.from('0123456789')).expect(200)
    expect(app.db.isUploadedArchive('Game-1.0-pc.zip', archiveIdentity(statSync(join(root, 'games', '_renplay', 'uploads', `${r.body.id}.part`))))).toBe(false)
    const completed = await request(app.app).post(`/api/uploads/${r.body.id}/complete`).expect(200)
    const path = completed.body.path
    expect(app.db.isUploadedArchive(path, archiveIdentity(statSync(join(root, 'games', '_archives', path))))).toBe(true)
  })

  it('keeps saves when a game is uninstalled', async () => {
    await request(app.app).delete('/api/games/fixture-game').expect(200)
    const g = (await request(app.app).get('/api/games/fixture-game')).body.game
    expect(g).toMatchObject({ status: 'not_installed', playUrl: null })
    expect(g.saves.count).toBe(1)
  })
})

describe('paths', () => {
  it('rejects traversal', () => {
    for (const bad of ['../a', 'a/../../b', '/etc/passwd', 'C:/x', 'a\0b', '']) expect(() => cleanRelPath(bad)).toThrow()
    expect(cleanRelPath('./game//images/a.png')).toBe('game/images/a.png')
    expect(() => safeJoin('/base', '../x')).toThrow()
  })
})

describe('renderPage', () => {
  it('uses the build presplash and lists caches', () => {
    const html = renderPage(TEMPLATE, { id: 's', build: 'b', title: 'T <x>', engine: '8.5.3', saveDir: null, screen: null, caches: [{ name: 'bytecode-312.rpyb', v: '1' }], presplash: 'web-presplash.webp', runtimeVersion: 'v' })
    expect(html).toContain('<title>T &lt;x&gt;</title>')
    expect(html).toContain('src="web-presplash.webp"')
    expect(html).toContain('"caches":[{"name":"bytecode-312.rpyb","v":"1"}]')
    expect(html).toContain('viewport-fit=cover')
  })
})
