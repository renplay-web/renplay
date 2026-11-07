import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import yazl from 'yazl'
import { createApp, type App } from '../app.js'
import { loadConfig, type Config } from '../config.js'
import { groupCeiling, legacyMirror, parseAdultGroups, parseAdultLevel } from '../content.js'
import { adultFlag } from '../pipeline/import.js'
import { Db } from '../db.js'
import { readZipEntries } from '../saves/savefile.js'
import { groupCns } from '../sign-in-providers.js'
import { mockOidc, signInFixture, site } from './sign-in-fixture.js'

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

const TEMPLATE = `<!doctype html><html><head><title>Ren'Py Web Game</title><meta name="viewport" content="width=device-width">
</head><body><img id="presplash" src="web-presplash.jpg">
<script src="renpy-pre.js"></script>
<script async type="text/javascript" src="renpy.js"></script>
</body></html>`

describe('adult level configuration', () => {
  const ENV = ['RENPLAY_ADULT_DEFAULT', 'RENPLAY_OIDC_ADULT_GROUPS', 'RENPLAY_OIDC_ADULT_GROUP', 'RENPLAY_LDAP_ADULT_GROUPS', 'RENPLAY_LDAP_ADULT_FILTER', 'RENPLAY_ADULT_GAMES', 'DATA_DIR', 'GAMES_DIR']
  function config(env: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'renplay-levels-cfg-'))
    for (const k of ENV) delete process.env[k]
    Object.assign(process.env, { DATA_DIR: join(root, 'data'), GAMES_DIR: join(root, 'games'), ...env })
    const cfg = loadConfig()
    for (const k of ENV) delete process.env[k]
    rmSync(root, { recursive: true, force: true })
    return cfg
  }

  it('parses group=level mappings and takes the highest matching level', () => {
    expect(parseAdultGroups('adults=shown,mods=blurred', 'RENPLAY_OIDC_ADULT_GROUPS')).toEqual({ adults: 'shown', mods: 'blurred' })
    expect(parseAdultGroups('', 'RENPLAY_OIDC_ADULT_GROUPS')).toBeNull()
    expect(parseAdultGroups('adults', 'RENPLAY_OIDC_ADULT_GROUPS')).toBeNull()
    expect(parseAdultGroups('adults=many,mods=blurred', 'RENPLAY_OIDC_ADULT_GROUPS')).toEqual({ mods: 'blurred' })
    expect(parseAdultGroups('kids=off', 'RENPLAY_OIDC_ADULT_GROUPS')).toEqual({ kids: 'off' })
    expect(groupCeiling({ adults: 'shown', mods: 'blurred' }, ['mods'])).toBe('blurred')
    expect(groupCeiling({ adults: 'shown', mods: 'blurred' }, ['mods', 'adults'])).toBe('shown')
    expect(groupCeiling({ adults: 'shown', kids: 'off' }, ['kids', 'adults'])).toBe('shown')
    expect(groupCeiling({ adults: 'shown' }, ['other'])).toBe('off')
    expect(groupCeiling({ adults: 'shown' }, [])).toBe('off')
    // OIDC matches the groups claim exactly.
    expect(groupCeiling({ Adults: 'shown' }, ['adults'])).toBe('off')
  })

  it('reads RENPLAY_ADULT_DEFAULT as a level, with the 3.x aliases, defaulting to off', () => {
    expect(config({}).adultDefault).toBe('off')
    expect(config({ RENPLAY_ADULT_DEFAULT: 'blurred' }).adultDefault).toBe('blurred')
    expect(config({ RENPLAY_ADULT_DEFAULT: 'allow' }).adultDefault).toBe('shown')
    expect(config({ RENPLAY_ADULT_DEFAULT: 'block' }).adultDefault).toBe('off')
    expect(config({ RENPLAY_ADULT_DEFAULT: 'nonsense' }).adultDefault).toBe('off')
  })

  it('reads the sign-in group variables and their 3.x aliases', () => {
    expect(config({}).oidcAdultGroups).toBeNull()
    expect(config({ RENPLAY_OIDC_ADULT_GROUPS: 'adults=shown,mods=blurred' }).oidcAdultGroups).toEqual({ adults: 'shown', mods: 'blurred' })
    expect(config({ RENPLAY_OIDC_ADULT_GROUPS: 'adults=shown' }).oidcAdultGroupsVariable).toBe('RENPLAY_OIDC_ADULT_GROUPS')
    const alias = config({ RENPLAY_OIDC_ADULT_GROUP: 'adults' })
    expect(alias.oidcAdultGroups).toEqual({ adults: 'shown' })
    expect(alias.oidcAdultGroupsVariable).toBe('RENPLAY_OIDC_ADULT_GROUP')
    // The new variable wins over the alias.
    expect(config({ RENPLAY_OIDC_ADULT_GROUPS: 'mods=blurred', RENPLAY_OIDC_ADULT_GROUP: 'adults' }).oidcAdultGroups).toEqual({ mods: 'blurred' })
    expect(config({ RENPLAY_LDAP_ADULT_GROUPS: 'renplay-adults=shown' }).ldapAdultGroups).toEqual({ 'renplay-adults': 'shown' })
    expect(config({}).ldapAdultGroups).toBeNull()
  })

  it('extracts group cns from memberOf DNs, unescaped', () => {
    expect(groupCns('cn=renplay-adults,ou=groups,dc=example,dc=org')).toEqual(['renplay-adults'])
    expect(groupCns(['cn=Adults,ou=groups,dc=x', 'cn=mods,ou=groups,dc=x'])).toEqual(['Adults', 'mods'])
    expect(groupCns(['CN=upper,dc=x', 'ou=not-a-group,dc=x', 'uid=person,dc=x'])).toEqual(['upper'])
    expect(groupCns('cn=with\\, comma,dc=x')).toEqual(['with, comma'])
    expect(groupCns(undefined)).toEqual([])
    expect(groupCns(42)).toEqual([])
    // LDAP matching is case-insensitive on both sides (sign-in-providers lowercases both).
    expect(groupCeiling({ 'renplay-adults': 'shown' }, ['RENPLAY-Adults'.toLowerCase()])).toBe('shown')
  })
})

describe('OIDC sign-in groups set the ceiling', () => {
  let provider: Awaited<ReturnType<typeof mockOidc>>, app: Awaited<ReturnType<typeof signInFixture>>
  afterEach(async () => { app?.cleanup(); await provider?.close(); vi.restoreAllMocks() })
  async function start(patch: Partial<Config> = {}) {
    provider = await mockOidc()
    app = await signInFixture({ oidcIssuer: provider.issuer, oidcClientId: 'renplay', publicUrl: 'http://localhost:8080', ...patch })
    return request.agent(app.app)
  }
  async function callback(agent: ReturnType<typeof request.agent>) {
    const start = await agent.get('/api/auth/oidc/start').expect(302)
    const result = await fetch(start.headers.location, { redirect: 'manual' })
    const url = new URL(result.headers.get('location')!)
    return agent.get(url.pathname + url.search)
  }

  it('recomputes the ceiling from the groups claim at every sign-in, off when nothing matches', async () => {
    const agent = await start({ oidcAdultGroups: { adults: 'shown', mods: 'blurred' }, oidcAdultGroupsVariable: 'RENPLAY_OIDC_ADULT_GROUPS' })
    provider.setClaims({ groups: ['mods', 'adults'] })
    await callback(agent)
    expect((await agent.get('/api/me')).body.user).toMatchObject({ adult_ceiling: 'shown', adult_choice: 'shown' })
    provider.setClaims({ groups: ['mods'] })
    await callback(agent)
    // The choice stays; the ceiling is recomputed and caps it.
    expect((await agent.get('/api/me')).body.user).toMatchObject({ adult_ceiling: 'blurred', adult_choice: 'shown' })
    provider.setClaims({ groups: [] })
    await callback(agent)
    expect((await agent.get('/api/me')).body.user).toMatchObject({ adult_ceiling: 'off', adult_choice: 'shown' })
  })

  it('replaces the hand setting and locks it in Users while the mapping is configured', async () => {
    const owner = await start({ oidcAdultGroups: { adults: 'shown' }, oidcAdultGroupsVariable: 'RENPLAY_OIDC_ADULT_GROUPS', adminUsername: 'admin', adminPassword: 'local password' })
    await owner.post('/api/auth/login').set(site).send({ username: 'admin', password: 'local password' }).expect(200)
    await owner.post('/api/users').set(site).send({ username: 'player', password: 'player password', adultCeiling: 'shown' }).expect(201)
    const player = request.agent(app.app)
    await player.post('/api/auth/login').set(site).send({ username: 'player', password: 'player password' }).expect(200)
    expect((await player.get('/api/me')).body.user).toMatchObject({ adult_ceiling: 'shown' })
    // Linking the sign-in replaces the hand-set ceiling with the group's level.
    const linked = await player.post('/api/me/identities/oidc').set(site).send({}).expect(200)
    const auth = await fetch(linked.body.url, { redirect: 'manual' })
    const url = new URL(auth.headers.get('location')!)
    provider.setClaims({ groups: [] })
    await player.get(url.pathname + url.search).expect(302)
    expect((await player.get('/api/me')).body.user).toMatchObject({ adult_ceiling: 'off' })
    expect((await owner.get('/api/users')).body.users.find((u: { username: string }) => u.username === 'player')).toMatchObject({ adultManaged: true })
    await owner.put('/api/users/2').set(site).send({ adultCeiling: 'shown' }).expect(409)
  })
})

describe('migration from 3.x, and back', () => {
  it('turns 3.x access into ceilings and the 3.x picture preference into choices, and keeps the 3.x columns readable', () => {
    const root = mkdtempSync(join(tmpdir(), 'renplay-levels-mig-'))
    const path = join(root, 'library.db')
    // A 3.2 database: users with and without adult access, the install question answered.
    let db = new Db(path)
    db.raw.exec(`ALTER TABLE users DROP COLUMN adult_ceiling; ALTER TABLE users DROP COLUMN adult_choice; PRAGMA user_version = 10`)
    // 3.x hid pictures unless a person chose Show, so no preference means Blurred.
    db.raw.prepare(`INSERT INTO users (username, name, role, adult_access, prefs, created_at) VALUES
      ('yes', 'Yes', 'player', 1, '{"adultPictures":"show"}', '2026-01-01'),
      ('hidden', 'Hidden', 'player', 1, '{"adultPictures":"hide-pictures"}', '2026-01-01'),
      ('nogames', 'No games', 'player', 1, '{"adultPictures":"hide-games"}', '2026-01-01'),
      ('broken', 'Broken', 'player', 1, 'not json', '2026-01-01'),
      ('no', 'No', 'player', 0, '{"adultPictures":"show"}', '2026-01-01')`).run()
    db.raw.prepare('UPDATE users SET adult_access = 1 WHERE id = 1').run()
    db.setSetting('adult_games', 'block')
    db.close()
    db = new Db(path)
    const user = (username: string) => db.raw.prepare('SELECT * FROM users WHERE username = ?').get(username) as { adult_ceiling: string; adult_choice: string }
    expect(user('owner')).toMatchObject({ adult_ceiling: 'shown', adult_choice: 'blurred' })
    expect(user('yes')).toMatchObject({ adult_ceiling: 'shown', adult_choice: 'shown' })
    expect(user('hidden')).toMatchObject({ adult_ceiling: 'shown', adult_choice: 'blurred' })
    expect(user('nogames')).toMatchObject({ adult_ceiling: 'shown', adult_choice: 'off' })
    expect(user('broken')).toMatchObject({ adult_ceiling: 'shown', adult_choice: 'blurred' })
    expect(user('no')).toMatchObject({ adult_ceiling: 'off', adult_choice: 'off' })
    expect((db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(18)
    // Downgrading to 3.2 reads the columns 4.0 keeps in step: access, the picture
    // preference and the allow/block install setting (covered by legacyMirror in content.test).
    const cols = db.raw.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
    expect(cols).toContain('adult_access')
    expect(cols).toContain('prefs')
    expect(db.getSetting('adult_games', '')).toBe('block')
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
})

/**
 * Every route addressed to a game, at every level. The count canary walks the
 * app's registered routes: a route added later fails the canary until it is
 * classified here.
 */
describe('the levels on every route', () => {
  let root = ''
  let app: App
  let zip = Buffer.alloc(0)
  let archivesDir = ''
  /** The made grid of each game: the picture routes the levels guard. */
  let adultPic = ''
  let safePic = ''
  let fullCatalog: unknown = null
  /** After Off, adult recipes come back with the next full index. Offline, the test puts it back. */
  const restoreCatalog = async () => {
    app.db.setSetting('catalog_cache', fullCatalog)
    await app.catalog.init()
    app.catalog.stop()
  }
  let gamesDir = ''

  beforeAll(async () => {
    zip = await zipBuffer({ 'game/script.rpyc': 'x', 'game/renpyweb_remote_files.txt': 'images/a.png\nimage 16,16\n' })
    root = mkdtempSync(join(tmpdir(), 'renplay-levels-routes-'))
    process.env['DATA_DIR'] = join(root, 'data')
    process.env['GAMES_DIR'] = join(root, 'games')
    process.env['RENPLAY_CATALOG_URLS'] = 'http://127.0.0.1:9/none'
    process.env['RENPLAY_ENGINES_URL'] = 'http://127.0.0.1:9/none'
    const cfg = loadConfig()
    // An installed engine, three builds, saves, archives, covers and walkthroughs.
    const engine = join(cfg.enginesDir, '8.5.3')
    mkdirSync(engine, { recursive: true })
    writeFileSync(join(engine, 'index.html'), TEMPLATE)
    writeFileSync(join(engine, '.ready'), '{}')
    for (const id of ['adult', 'safe', 'adult-two']) {
      const build = join(cfg.gamesDir, id, 'b1')
      mkdirSync(build, { recursive: true })
      writeFileSync(join(build, 'game.zip'), zip)
      writeFileSync(join(build, 'assets.pack'), 'xxpng0123456789')
      writeFileSync(join(build, 'assets.json'), JSON.stringify({ 'images/a.png': [2, 3] }))
      mkdirSync(join(cfg.savesDir, `${id}-1`), { recursive: true })
      writeFileSync(join(cfg.savesDir, `${id}-1`, '1-1.save'), 'x')
    }
    // A save with a real picture, for its hash at Blurred.
    const shot = await sharp({ create: { width: 384, height: 216, channels: 3, background: '#c42' } }).png().toBuffer()
    writeFileSync(join(cfg.savesDir, 'adult-1', '2-1.save'), await zipBuffer({ json: JSON.stringify({ _save_name: 'A picture', _ctime: 1700000000 }), 'screenshot.png': shot, log: 'x', renpy_version: '8.5.3' }))
    // Each recipe's grid is in the art cache's originals already: made without any download.
    const grids: Record<string, { sha256: string }> = {}
    mkdirSync(join(cfg.dataDir, 'art', 'src'), { recursive: true })
    for (const id of ['adult', 'safe']) {
      const data = await sharp({ create: { width: 600, height: 900, channels: 3, background: id === 'adult' ? '#a33' : '#3a3' } }).png().toBuffer()
      const sha256 = createHash('sha256').update(data).digest('hex')
      writeFileSync(join(cfg.dataDir, 'art', 'src', sha256), data)
      grids[id] = { sha256 }
    }
    mkdirSync(cfg.walkthroughsDir, { recursive: true })
    for (const id of ['adult', 'safe']) writeFileSync(join(cfg.walkthroughsDir, `${id}.pdf`), '%PDF-1.4 fixture')
    mkdirSync(cfg.archivesDir, { recursive: true })
    archivesDir = cfg.archivesDir
    gamesDir = cfg.gamesDir
    for (const name of ['adult.zip', 'safe.zip', 'adult2.zip']) writeFileSync(join(cfg.archivesDir, name), '1234')
    const db = Db.open(cfg.dataDir)
    const recipe = (id: string, nsfw: boolean) => ({ id, title: id, nsfw, engine: 'renpy', saveDir: `${id}-1`, art: [{ kind: 'grid', url: `https://art.example/${id}.png`, source: 'steam', sha256: grids[id]!.sha256, width: 600, height: 900, thumbhash: '1QcSHQRnh493V4dIh4eXh1h4kJUI', tint: '#aa3333' }], releases: [{ version: '1', status: 'verified', archives: [{ name: `${id}.zip`, size: 4 }] }] })
    fullCatalog = { at: Date.now(), games: [recipe('adult', true), recipe('safe', false)], vocabulary: {}, adultGames: 'shown' }
    db.setSetting('catalog_cache', fullCatalog)
    db.insertGame({ id: 'adult', title: 'Adult', recipe_id: 'adult', adult: 1, status: 'installed', build: 'b1', engine: '8.5.3', save_dir: 'adult-1', walkthrough: 'adult.pdf' })
    db.insertGame({ id: 'safe', title: 'Safe', recipe_id: 'safe', status: 'installed', build: 'b1', engine: '8.5.3', save_dir: 'safe-1', walkthrough: 'safe.pdf' })
    for (const id of ['adult', 'safe']) db.raw.prepare("INSERT INTO walkthroughs (file, game, title, kind, added_at) VALUES (?, ?, 'Walkthrough', 'pdf', '2026-01-01')").run(`${id}.pdf`, id)
    db.insertGame({ id: 'adult-two', title: 'Adult Two', recipe_id: '', adult: 1, status: 'installed', build: 'b1', engine: '8.5.3', save_dir: 'adult-two-1', source: JSON.stringify({ archive: 'adult2.zip' }) })
    db.insertJob({ id: 'j-adult-failed', type: 'import', game: 'adult', params: '{}' })
    db.insertJob({ id: 'j-adult-queued', type: 'import', game: 'adult', params: '{}' })
    db.insertJob({ id: 'j-safe', type: 'import', game: 'safe', params: '{}' })
    db.updateJob('j-adult-failed', { status: 'failed' })
    db.close()
    app = await createApp(cfg, { startJobs: false })
    await app.catalog.syncArt()
    const grid = (id: string) => (app.catalog.gameArt(app.db.getGame(id)!) as Record<string, { url1x: string }>)['grid']!.url1x
    adultPic = grid('adult')
    safePic = grid('safe')
    expect(adultPic).toMatch(/^\/api\/art\/[0-9a-f]{32}\.webp$/)
  })
  afterAll(async () => {
    while (app.jobs.isBusy()) await new Promise((resolve) => setTimeout(resolve, 50))
    app?.close()
    rmSync(root, { recursive: true, force: true })
    for (const k of ['DATA_DIR', 'GAMES_DIR', 'RENPLAY_CATALOG_URLS', 'RENPLAY_ENGINES_URL']) delete process.env[k]
  })

  const exportedNames = async () => {
    const response = await request(app.app).get('/api/saves-export').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => cb(null, Buffer.concat(chunks)))
    }).expect(200)
    return [...(await readZipEntries(response.body, () => true, 128 << 20)).keys()]
  }

  const setLevel = async (level: string) => {
    expect((await request(app.app).put('/api/content').send({ level })).body.installation.level).toBe(level)
  }

  /**
   * Every registered route, with what the levels do on it. A route added later changes this list,
   * and the test fails until it is classified here (and, for a new kind, tested below).
   * person: the person's own account and actions, nothing about any game.
   * game: addressed to one game, 404 at Off, no art at Blurred (the matrix below calls each).
   * list: lists and counts, adult games left out at Off and without art at Blurred.
   * tool: admin tools that name games or downloads, filtered by the admin's own level.
   * none: says nothing about any game.
   */
  const ROUTES: Array<[route: string, kind: 'person' | 'game' | 'list' | 'tool' | 'none']> = [
    ['GET /auth/providers', 'none'], ['GET /auth/oidc/start', 'person'], ['GET /auth/oidc/callback', 'person'],
    ['POST /me/identities/oidc', 'person'], ['POST /me/identities/ldap', 'person'], ['GET /me/identities', 'person'], ['DELETE /me/identities', 'person'],
    ['POST /me/avatar', 'person'], ['GET /avatars/:file', 'person'], ['POST /auth/setup/verify', 'none'], ['POST /auth/setup', 'person'],
    ['POST /auth/login', 'person'], ['POST /auth/logout', 'person'], ['GET /me', 'person'], ['PUT /me', 'person'], ['POST /me/password', 'person'],
    ['GET /me/adult', 'person'], ['PUT /me/adult', 'person'], ['GET /me/tags', 'person'], ['PUT /me/tags', 'person'], ['PUT /me/pin', 'person'], ['GET /auth/switch', 'person'], ['POST /auth/switch', 'person'],
    // Dashboards: metrics are counts for admins, never titles. The widget lists only what the person may see.
    ['GET /metrics', 'tool'], ['GET /widget', 'list'], ['GET /me/sessions', 'person'], ['DELETE /me/sessions', 'person'], ['DELETE /me/sessions/:id', 'person'],
    ['GET /me/tokens', 'person'], ['POST /me/tokens', 'person'], ['DELETE /me/tokens/:id', 'person'],
    ['GET /users', 'tool'], ['POST /users', 'person'], ['PUT /users/:id', 'person'], ['POST /users/:id/password', 'person'],
    ['POST /users/:id/saves/copy', 'tool'], ['GET /users/:id/saves/export', 'tool'], ['POST /users/:id/saves/import', 'person'],
    ['POST /me/claim-owner', 'person'], ['POST /users/:id/merge', 'person'], ['DELETE /users/:id', 'person'], ['POST /games/:id/safe', 'game'],
    ['GET /api/auth/check', 'game'], ['GET /g/:id/:build/,/g/:id/:build/index.html', 'game'],
    ['GET /^\\/g\\/([a-z0-9][a-z0-9._-]*)\\/([a-z0-9]+)(?:\\.m[a-z0-9]+)?\\/game\\/(.+)$/', 'game'],
    ['GET /^\\/g\\/([a-z0-9][a-z0-9._-]*)\\/([a-z0-9]+)(?:\\.m([a-z0-9]+))?\\/(.+)$/', 'game'],
    // A save backup is the server's full copy of everyone's saves: never filtered, saves are sacred.
    ['GET /system/backups', 'tool'], ['POST /system/backups', 'tool'], ['GET /system/backups/:name', 'tool'], ['PUT /system/sync', 'none'], ['GET /system/storage', 'tool'], ['GET /defaults', 'none'], ['PUT /defaults', 'none'], ['POST /system/storage/refresh', 'none'],
    ['GET /health', 'none'], ['GET /keepalive', 'none'], ['GET /system', 'list'], ['PUT /system/downloads', 'none'], ['POST /system/prune', 'none'],
    ['POST /system/engines/refresh', 'none'], ['GET /jobs', 'list'], ['GET /jobs/:id/log', 'tool'], ['POST /jobs/:id/cancel', 'tool'],
    ['POST /jobs/:id/retry', 'tool'], ['DELETE /jobs', 'tool'], ['GET /', 'none'], ['PUT /', 'none'], ['GET /api/saves-export', 'list'],
    // The guided import: the index leaves out adult save folders at Off, the import writes this person's saves.
    ['GET /', 'list'], ['POST /', 'person'],
    ['PUT /:id/status', 'game'], ['PUT /:id/rating', 'game'], ['POST /:id/not-now', 'game'], ['DELETE /:id/not-now', 'game'], ['GET /', 'list'],
    ['GET /api/art/:file', 'game'], ['GET /:id/art', 'game'], ['PUT /:id/art', 'game'], ['DELETE /:id/art', 'game'], ['POST /:id/art/upload', 'game'],
    ['GET /:id/files', 'game'], ['GET /:id/files/raw', 'game'], ['PUT /:id/files/raw', 'game'], ['DELETE /:id/files/raw', 'game'],
    ['POST /:id/files/revert', 'game'], ['POST /:id/files/upload', 'game'], ['POST /:id/files/apply', 'game'], ['POST /:id/files/reset', 'game'],
    ['GET /', 'list'], ['GET /:id', 'game'], ['PUT /:id/favorite', 'game'], ['PUT /:id/finished', 'game'], ['POST /:id/play-time', 'game'],
    ['POST /:id/played', 'game'], ['DELETE /:id', 'game'], ['DELETE /:id/download', 'game'], ['POST /:id/reinstall', 'game'],
    ['PUT /:id/cache', 'game'], ['GET /:id/recipe', 'game'], ['POST /:id/walkthroughs', 'game'], ['PUT /:id/walkthroughs/:file', 'game'], ['DELETE /:id/walkthroughs/:file', 'game'], ['DELETE /:id/art/uploads/:upload', 'game'],
    ['GET /archives', 'list'], ['POST /archives/inspect', 'tool'], ['POST /archives/hash', 'tool'], ['DELETE /archives', 'tool'],
    ['POST /imports', 'tool'], ['POST /uploads', 'person'], ['GET /uploads/:id', 'person'], ['PUT /uploads/:id', 'person'],
    ['POST /uploads/:id/complete', 'person'], ['DELETE /uploads/:id', 'person'], ['GET /catalog', 'list'], ['POST /catalog/refresh', 'list'],
  ]

  it('registers exactly the routes this file classifies', () => {
    const list = (stack: any[]): string[] => (stack ?? []).flatMap((layer: any) => layer.route ? Object.keys(layer.route.methods).map((m) => `${m.toUpperCase()} ${String(layer.route.path)}`) : layer.handle?.stack ? list(layer.handle.stack) : [])
    expect(list((app.app as any).router.stack).sort()).toEqual(ROUTES.map(([route]) => route).sort())
  })

  it('at blurred adult games are there with titles, but no picture route returns a byte of their art', async () => {
    await setLevel('blurred')
    // Lists contain them, without any picture URL.
    const games = (await request(app.app).get('/api/games')).body.games
    expect(games.map((g: { id: string }) => g.id)).toEqual(['adult', 'adult-two', 'safe'])
    const adult = games.find((g: { id: string }) => g.id === 'adult')
    expect(adult).toMatchObject({ title: 'adult' })
    // Every format is its hash and tint only: no address, no size, no credit.
    for (const format of Object.values(adult.art)) expect(Object.keys(format as object).sort()).toEqual(['thumbhash', 'tint'])
    expect(adult.art.grid.thumbhash).toBeTruthy()
    // A recipe-less game marked adult in the library is an adult game to the interface too.
    expect(games.find((g: { id: string }) => g.id === 'adult-two')).toMatchObject({ nsfw: true })
    expect(JSON.stringify(games.filter((g: { nsfw: boolean }) => g.nsfw))).not.toContain('/api/art/')
    expect(JSON.stringify(games.find((g: { id: string }) => g.id === 'safe').art)).toContain(safePic)
    const catalogGames = (await request(app.app).get('/api/catalog')).body.games
    expect(catalogGames.map((g: { id: string }) => g.id)).toContain('adult')
    expect(JSON.stringify(catalogGames.find((g: { id: string }) => g.id === 'adult').art)).not.toContain('/api/art/')
    // The catalog's own picture addresses never go out: only the art the server made.
    expect(JSON.stringify(catalogGames)).not.toContain('art.example')
    expect((await request(app.app).get('/api/archives')).body.archives.map((a: { name: string }) => a.name)).toContain('adult.zip')
    expect((await request(app.app).get('/api/jobs')).body.jobs.map((j: { id: string }) => j.id)).toContain('j-adult-failed')
    const sys = (await request(app.app).get('/api/system')).body
    expect(sys.library).toMatchObject({ games: 3, installed: 3 })
    expect(sys.engines.installed[0].usedBy).toContain('Adult')
    expect(await exportedNames()).toContain('adult-1/1-1.save')
    expect(await exportedNames()).toContain('adult-two-1/1-1.save')

    // The art routes refuse, with the same 404 as an unknown file.
    for (const path of [adultPic, '/api/saves/adult/screenshot?file=1-1.save', '/api/games/adult/art', '/api/games/adult/art?kind=grid']) {
      await request(app.app).get(path).expect(404)
    }
    await request(app.app).get('/api/auth/check').set('X-Original-URI', adultPic).expect(403)
    await request(app.app).put('/api/games/adult/art').send({ kind: 'grid', candidate: 'any', scope: 'me' }).expect(404)
    await request(app.app).post('/api/games/adult/art/upload?kind=grid').set('content-type', 'image/png').send(Buffer.from('x')).expect(404)
    await request(app.app).delete('/api/games/adult/art?kind=grid').expect(404)
    // Safe games keep their pictures at every level.
    await request(app.app).get(safePic).expect(200)
    // An art error about an adult game without a recipe names it only at Shown.
    ;(app.catalog as unknown as { errors: Array<{ text: string; recipe?: string }> }).errors.push({ text: 'grid of adult-two (an upload): the uploaded picture is gone', recipe: 'adult-two' })
    expect(JSON.stringify((await request(app.app).get('/api/catalog').expect(200)).body.status.errors)).not.toContain('adult-two')
    // Saves list without picture URLs. A save's picture is its hash only, as art is.
    const saves = (await request(app.app).get('/api/saves/adult').expect(200)).body
    expect(JSON.stringify(saves)).not.toContain('screenshot?')
    const pictured = saves.slots.find((s: { file: string }) => s.file === '2-1.save')
    expect(pictured).toMatchObject({ screenshot: null, screenshotHash: expect.stringMatching(/^[A-Za-z0-9+/]{8,64}={0,2}$/) })
    expect((await request(app.app).get('/api/games/adult')).body.game.latestSave).toMatchObject({ file: '2-1.save', screenshot: null, screenshotHash: pictured.screenshotHash })

    // The game itself still plays: the page renders with the engine's presplash, and its files stream.
    const page = await request(app.app).get('/g/adult/b1/').expect(200)
    expect(page.text).toContain('/engine/8.5.3/web-presplash.jpg')
    await request(app.app).get('/g/adult/b1/game.zip').expect(200)
    await request(app.app).get('/g/adult/b1/game/images/a.png').expect(200)
    await request(app.app).get('/api/auth/check').set('X-Original-URI', '/g/adult/b1/game.zip').expect(204)
    await request(app.app).get('/api/walkthroughs/adult.pdf').expect(200)

    // Management routes see the game like any other.
    const reads: string[] = [
      '/api/games/adult', '/api/games/adult/recipe', '/api/games/adult/files',
      '/api/games/adult/files/raw?path=game/script.rpyc',
      '/api/saves/adult/boot', '/api/saves/adult/raw?path=adult-1/1-1.save', '/api/saves/adult/download?file=1-1.save',
      '/api/saves/adult/export', '/api/saves/adult/history', '/api/jobs/j-adult-failed/log',
    ]
    for (const path of reads) await request(app.app).get(path).expect(200)
    const writes: Array<[method: string, path: string, body?: unknown, raw?: 'raw']> = [
      ['put', '/api/games/adult/favorite', { on: true }], ['put', '/api/games/adult/finished', { on: true }],
      ['post', '/api/games/adult/played'], ['post', '/api/games/adult/play-time', { seconds: 5 }],
      ['put', '/api/games/adult/cache?name=bytecode-8.rpyb&build=b1', undefined, 'raw'],
      ['post', '/api/saves/adult/save-dir', { saveDir: 'adult-1' }],
      ['post', '/api/saves/adult/copy', { target: 'safe', file: '1-1.save' }],
      ['put', '/api/saves/adult/file?path=adult-1/x.save', undefined, 'raw'],
      ['delete', '/api/saves/adult/slot?file=x.save'],
      ['put', '/api/saves/adult/file?path=adult-1/x.save', undefined, 'raw'],
      ['delete', '/api/saves/adult/file?path=adult-1/x.save'],
      ['put', '/api/games/adult/files/raw?path=game/mod.txt', undefined, 'raw'],
      ['delete', '/api/games/adult/files/raw?path=game/mod.txt'],
      ['post', '/api/games/adult/files/revert', { path: 'game/script.rpyc' }],
      ['post', '/api/jobs/j-adult-queued/cancel'], ['post', '/api/jobs/j-adult-failed/retry'],
    ]
    for (const [method, path, body, raw] of writes) {
      const call = (request(app.app) as any)[method](path)
      const response = await (raw ? call.set('content-type', 'application/octet-stream').send(Buffer.from('mod content!!')) : call.send(body))
      expect(response.status, `${method} ${path}`).not.toBe(404)
    }
    // Destructive verbs on the second adult game, once the retried install has finished
    // (a download cannot be deleted while a job runs, whatever the level).
    await expect.poll(() => app.jobs.isBusy()).toBe(false)
    await request(app.app).delete('/api/games/adult-two/download').expect(200)
    await request(app.app).delete('/api/games/adult-two').expect(200)
    expect(app.db.getGame('adult-two')).toMatchObject({ status: 'not_installed' })
    await expect.poll(() => app.jobs.isBusy()).toBe(false)
  })

  it('at shown every picture route answers again', async () => {
    await setLevel('shown')
    const pic = await request(app.app).get(adultPic).expect(200)
    expect(pic.headers['cache-control']).toBe('private, max-age=31536000, immutable')
    await request(app.app).get('/api/auth/check').set('X-Original-URI', adultPic).expect(204)
    const adult = (await request(app.app).get('/api/games/adult')).body.game
    expect(adult.art.grid).toMatchObject({ url1x: adultPic, width: 600, height: 900, made: null, credit: { store: 'Steam' } })
    expect((await request(app.app).get('/api/games/adult/art?kind=grid').expect(200)).body.candidates).toHaveLength(1)
    // A mod upload is checked at the level of the person asking, including this device's: multer
    // runs inside the handler, where the request still knows who is asking.
    const upload = (device?: string) => {
      const r = request(app.app).post('/api/games/adult/files/upload').field('dir', 'game').attach('files', Buffer.from('init python:\n    pass\n'), 'zz_mod.rpy')
      return device ? r.set('X-Renplay-Adult', device) : r
    }
    await upload('off').expect(404)
    expect((await upload().expect(200)).body.written).toEqual(['game/zz_mod.rpy'])
    // The save's real picture, and no hash.
    const pictured = (await request(app.app).get('/api/saves/adult').expect(200)).body.slots.find((s: { file: string }) => s.file === '2-1.save')
    expect(pictured.screenshot).toContain('/api/saves/adult/screenshot?')
    expect(pictured.screenshotHash).toBeNull()
    await request(app.app).get(pictured.screenshot).expect(200)
  })

  it('at off hides adult games from lists and refuses every route addressed to one with 404', async () => {
    await setLevel('off')
    // The dashboard widget lists only what the person may see.
    for (const g of ['adult', 'safe']) app.db.raw.prepare("INSERT OR REPLACE INTO user_games (user_id, game, last_played_at) VALUES (1, ?, ?)").run(g, new Date().toISOString())
    const widget = (await request(app.app).get('/api/widget').expect(200)).body
    expect(widget.recent.map((r: { id: string }) => r.id)).toEqual(['safe'])
    expect(JSON.stringify(widget)).not.toMatch(/"adult/)
    // Import from a computer skips an adult game's save folder at Off.
    const hiddenSave = await zipBuffer({ log: 'x', json: JSON.stringify({ _save_name: 'x', _ctime: 1700000000 }) })
    const imported = await request(app.app).post('/api/saves-import').field('meta', JSON.stringify([{ path: 'adult-1/9-9-LT1.save', mtime: Date.now() }])).attach('files', hiddenSave, '9-9-LT1.save').expect(200)
    expect(imported.body).toMatchObject({ added: 0, same: 0, skipped: ['adult-1/9-9-LT1.save'] })
    // The blurred test deleted the download of the recipe-less adult game. Put it back: at Off it
    // must stay hidden because a hidden game was installed from it, though no recipe names it.
    writeFileSync(join(archivesDir, 'adult2.zip'), '1234')
    // Lists leave adult games out.
    expect((await request(app.app).get('/api/games')).body.games.map((g: { id: string }) => g.id)).toEqual(['safe'])
    expect((await request(app.app).get('/api/catalog')).body.games.map((g: { id: string }) => g.id)).toEqual(['safe'])
    expect((await request(app.app).get('/api/archives')).body.archives.map((a: { name: string }) => a.name)).toEqual(['safe.zip'])
    expect((await request(app.app).get('/api/jobs')).body.jobs.map((j: { id: string }) => j.id)).toEqual(['j-safe'])
    const sys = (await request(app.app).get('/api/system')).body
    expect(sys.library).toMatchObject({ games: 1, installed: 1 })
    expect(sys.engines.installed[0].usedBy).toEqual(['Safe'])
    const names = await exportedNames()
    expect(names.some((n) => n.startsWith('adult'))).toBe(false)
    expect(names.some((n) => n.startsWith('safe-1/'))).toBe(true)

    // Every route addressed to an adult game gets the 404 an unknown game gets.
    const gone: Array<[string, string, unknown?]> = [
      ['get', '/api/games/adult'], ['get', '/api/games/adult/recipe'],
      ['put', '/api/games/adult/favorite', { on: true }], ['put', '/api/games/adult/finished', { on: true }],
      ['post', '/api/games/adult/played'], ['post', '/api/games/adult/play-time', { seconds: 5 }],
      ['put', '/api/games/adult/cache?name=bytecode-8.rpyb&build=b1'], ['delete', '/api/games/adult'],
      ['delete', '/api/games/adult/download'], ['post', '/api/games/adult/reinstall'],
      ['post', '/api/games/adult/walkthroughs'], ['put', '/api/games/adult/walkthroughs/adult.pdf', { title: 'x' }], ['delete', '/api/games/adult/walkthroughs/adult.pdf'],
      ['get', '/api/games/adult/files'], ['get', '/api/games/adult/files/raw?path=game/script.rpyc'],
      ['put', '/api/games/adult/files/raw?path=game/mod.txt'], ['delete', '/api/games/adult/files/raw?path=game/mod.txt'],
      ['post', '/api/games/adult/files/revert', { path: 'game/script.rpyc' }], ['post', '/api/games/adult/files/upload'],
      ['post', '/api/games/adult/files/apply'], ['post', '/api/games/adult/files/reset'],
      ['get', '/api/saves/adult'], ['get', '/api/saves/adult/boot'], ['get', '/api/saves/adult/raw?path=adult-1/1-1.save'],
      ['put', '/api/saves/adult/file?path=adult-1/x.save'], ['delete', '/api/saves/adult/file?path=adult-1/x.save'],
      ['post', '/api/saves/adult/save-dir', { saveDir: 'adult-1' }],
      ['get', '/api/saves/adult/screenshot?file=1-1.save'], ['get', '/api/saves/adult/download?file=1-1.save'],
      ['delete', '/api/saves/adult/slot?file=1-1.save'], ['get', '/api/saves/adult/export'],
      ['post', '/api/saves/adult/import'], ['post', '/api/saves/adult/copy', { target: 'safe', file: '1-1.save' }],
      ['get', '/api/saves/adult/history'], ['post', '/api/saves/adult/history/restore', { id: 'none' }],
      ['post', '/api/saves/adult/sync'], ['post', '/api/saves/adult/sync/download', { code: 'ABCDE-12345' }],
      ['put', '/api/saves/adult/meta?file=1-1.save', { title: 'x' }],
      ['get', '/g/adult/b1/'], ['get', '/g/adult/b1/index.html'], ['get', '/g/adult/b1/game.zip'], ['get', '/g/adult/b1/game/images/a.png'],
      ['get', adultPic], ['get', '/api/walkthroughs/adult.pdf'],
      ['get', '/api/games/adult/art'], ['get', '/api/games/adult/art?kind=grid'], ['put', '/api/games/adult/art', { kind: 'grid', candidate: 'x' }],
      ['put', '/api/games/adult/status', { status: 'playing' }], ['put', '/api/games/adult/rating', { rating: 4 }],
      ['post', '/api/games/adult/not-now'], ['delete', '/api/games/adult/not-now'],
      ['delete', '/api/games/adult/art?kind=grid'], ['post', '/api/games/adult/art/upload?kind=grid'], ['delete', `/api/games/adult/art/uploads/${'a'.repeat(64)}?kind=grid`],
      ['get', '/api/jobs/j-adult-failed/log'], ['post', '/api/jobs/j-adult-failed/retry'], ['post', '/api/jobs/j-adult-queued/cancel'],
      ['post', '/api/imports', { source: { kind: 'archive', path: 'adult.zip' } }],
      ['post', '/api/imports', { source: { kind: 'archive', path: 'safe.zip' }, recipeId: 'adult' }],
      ['post', '/api/archives/inspect', { path: 'adult.zip' }], ['post', '/api/archives/hash', { path: 'adult.zip' }],
      ['post', '/api/archives/inspect', { path: 'adult2.zip' }], ['post', '/api/archives/hash', { path: 'adult2.zip' }],
      ['post', '/api/imports', { source: { kind: 'archive', path: 'adult2.zip' } }],
      ['delete', '/api/archives?path=adult.zip'], ['delete', '/api/archives?path=adult2.zip'],
      // The recipe-less adult game and the nginx subrequest too.
      ['get', '/api/games/adult-two'], ['get', '/g/adult-two/b1/game.zip'],
    ]
    for (const [method, path, body] of gone) {
      const response = await (request(app.app) as any)[method](path).send(body)
      expect(response.status, `${method} ${path}`).toBe(404)
    }
    for (const uri of ['/g/adult/b1/game.zip', '/g/adult/b1/game/images/a.png', adultPic, '/api/walkthroughs/adult.pdf']) {
      await request(app.app).get('/api/auth/check').set('X-Original-URI', uri).expect(403)
    }
    // Safe games are never affected at any level.
    await request(app.app).get('/api/games/safe').expect(200)
    await request(app.app).get(safePic).expect(200)
    await request(app.app).get('/g/safe/b1/').expect(200)
    // Installed games stay installed, saves untouched.
    expect(app.db.getGame('adult')).toMatchObject({ status: 'installed', adult: 1 })
  })

  it('applies this device\'s level from the header or the query, and never lets it raise anything', async () => {
    await setLevel('shown')
    await restoreCatalog()
    expect((await request(app.app).get('/api/games/adult')).body.game.art.grid.url1x).toBe(adultPic)
    const ids = async (device?: string) => (await request(app.app).get('/api/games').set(device ? { 'x-renplay-adult': device } : {})).body.games.map((g: { id: string }) => g.id)
    expect(await ids()).toContain('adult')
    expect(await ids('off')).not.toContain('adult')
    const blurred = (await request(app.app).get('/api/games/adult').set('x-renplay-adult', 'blurred')).body.game
    expect(blurred).toMatchObject({ playUrl: '/g/adult/b1/?adult=blurred' })
    expect(blurred.art.grid.url1x).toBeUndefined()
    await request(app.app).get('/api/games/adult').set('x-renplay-adult', 'off').expect(404)
    await request(app.app).get(adultPic).set('x-renplay-adult', 'blurred').expect(404)
    // The game page, an iframe without headers, takes it as a query, and keeps it across a redirect.
    writeFileSync(join(gamesDir, 'adult', 'b1', 'web-presplash.jpg'), 'presplash')
    expect((await request(app.app).get('/g/adult/b1/').expect(200)).text).toContain('src="web-presplash.jpg"')
    expect((await request(app.app).get('/g/adult/b1/?adult=blurred').expect(200)).text).toContain('/engine/8.5.3/web-presplash.jpg')
    expect((await request(app.app).get('/g/adult/old/?adult=blurred').expect(302)).headers.location).toBe('/g/adult/b1/?adult=blurred')
    // A device cannot raise: an installation at Blurred stays Blurred whatever the header says.
    await setLevel('blurred')
    expect((await request(app.app).get('/api/games/adult').set('x-renplay-adult', 'shown')).body.game.art.grid.url1x).toBeUndefined()
    await setLevel('shown')
  })

  it('withholds the presplash below Shown, directly and for nginx', async () => {
    await setLevel('shown')
    writeFileSync(join(gamesDir, 'adult', 'b1', 'web-presplash.jpg'), 'presplash')
    await request(app.app).get('/g/adult/b1/web-presplash.jpg').expect(200)
    await request(app.app).get('/api/auth/check').set('X-Original-URI', '/g/adult/b1/web-presplash.jpg').expect(204)
    await setLevel('blurred')
    await request(app.app).get('/g/adult/b1/web-presplash.jpg').expect(404)
    await request(app.app).get('/api/auth/check').set('X-Original-URI', '/g/adult/b1/web-presplash.jpg').expect(403)
    // The game itself still plays, with its walkthrough: those are the game, not its library art.
    await request(app.app).get('/g/adult/b1/game.zip').expect(200)
    await request(app.app).get('/api/walkthroughs/adult.pdf').expect(200)
    // The file browser sends the game's files, but not its pictures and videos on their own.
    writeFileSync(join(gamesDir, 'adult', 'b1', 'cover.png'), 'png')
    await request(app.app).get('/api/games/adult/files/raw?path=game/script.rpyc').expect(200)
    await request(app.app).get('/api/games/adult/files/raw?path=game/images/a.png').expect(404)
    await setLevel('shown')
  })

  it('clears only the finished jobs an Off admin can see, and a forgotten game takes its jobs along', async () => {
    await setLevel('shown')
    app.db.insertJob({ id: 'j-clear-adult', type: 'import', game: 'adult', params: '{}' })
    app.db.insertJob({ id: 'j-clear-safe', type: 'import', game: 'safe', params: '{}' })
    for (const id of ['j-clear-adult', 'j-clear-safe']) app.db.updateJob(id, { status: 'done' })
    await setLevel('off')
    await request(app.app).delete('/api/jobs').expect(200)
    expect(app.db.getJob('j-clear-adult')).not.toBeNull()
    expect(app.db.getJob('j-clear-safe')).toBeNull()
    await setLevel('shown')
    app.db.insertGame({ id: 'gone-soon', title: 'Gone soon', status: 'installed', adult: 1 })
    app.db.insertJob({ id: 'j-gone', type: 'import', game: 'gone-soon', params: '{}' })
    app.db.insertJob({ id: 'j-gone-first', type: 'import', game: '', params: '{}' })
    app.db.updateJob('j-gone', { status: 'done' })
    app.db.updateJob('j-gone-first', { status: 'done', result: JSON.stringify({ game: 'gone-soon' }) })
    await request(app.app).delete('/api/games/gone-soon?forget=1').expect(200)
    expect(app.db.getJob('j-gone')).toBeNull()
    expect(app.db.getJob('j-gone-first')).toBeNull()
    expect(app.db.getJob('j-clear-adult')).not.toBeNull()
  })

  it('hides jobs about adult games at Off even without a game, before paging and counting', async () => {
    await setLevel('shown')
    // A job this person may see, so a page always has something in it.
    app.db.insertJob({ id: 'j-visible', type: 'import', game: 'safe', params: '{}' })
    app.db.updateJob('j-visible', { status: 'done' })
    app.db.insertJob({ id: 'j-first-install', type: 'import', game: '', params: JSON.stringify({ source: { kind: 'archive', path: 'adult.zip' } }) })
    app.db.insertJob({ id: 'j-hash', type: 'hash-archive', game: '', params: JSON.stringify({ path: 'adult2.zip' }) })
    app.db.insertJob({ id: 'j-by-recipe', type: 'import', game: '', params: JSON.stringify({ source: { kind: 'archive', path: 'other.zip' }, recipeId: 'adult' }) })
    app.db.insertJob({ id: 'j-forgotten', type: 'import', game: 'gone', params: '{}' })
    app.db.updateJob('j-forgotten', { result: JSON.stringify({ recipe: 'adult' }) })
    for (const id of ['j-first-install', 'j-hash', 'j-by-recipe', 'j-forgotten']) app.db.updateJob(id, { status: 'failed', error: `about ${id}` })
    const all = (await request(app.app).get('/api/jobs?limit=200')).body
    await setLevel('off')
    writeFileSync(join(archivesDir, 'adult2.zip'), '1234')
    const visible = (await request(app.app).get('/api/jobs?limit=200')).body
    const ids = visible.jobs.map((j: { id: string }) => j.id)
    for (const id of ['j-first-install', 'j-hash', 'j-by-recipe', 'j-forgotten']) {
      expect(ids).not.toContain(id)
      await request(app.app).get(`/api/jobs/${id}/log`).expect(404)
    }
    expect(visible.total).toBe(ids.length)
    expect(visible.total).toBeLessThan(all.total)
    // Pages are cut from the visible jobs, so a page is never short of what exists.
    const first = (await request(app.app).get('/api/jobs?limit=1')).body
    expect(first.jobs).toHaveLength(1)
    expect(first.total).toBe(visible.total)
    await setLevel('shown')
  })

  it('keeps the Users tools to what an Off admin may see, and never drops a save', async () => {
    await setLevel('shown')
    const count = async () => (await request(app.app).get('/api/users')).body.users.find((u: { id: number }) => u.id === 1).saves
    const shownSaves = await count()
    await setLevel('off')
    expect(await count()).toBeLessThan(shownSaves)
    const zip = (await request(app.app).get('/api/users/1/saves/export').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => cb(null, Buffer.concat(chunks)))
    }).expect(200)).body
    const names = [...(await readZipEntries(zip, () => true, 128 << 20)).keys()]
    expect(names.some((n) => n.startsWith('adult'))).toBe(false)
    const other = (await request(app.app).post('/api/users').send({ username: 'reader', name: 'Reader', password: 'reader-password-1' })).body.user
    await request(app.app).post('/api/users/1/saves/copy').send({ target: other.id, game: 'adult' }).expect(404)
    await request(app.app).post('/api/games/adult-two/safe').send({ safe: true }).expect(404)
    await setLevel('shown')
  })

  it('keeps catalog problems about adult games from people below Shown', async () => {
    // A level change refreshes the catalog, which resets its problems, so they are set after each change.
    const problems = () => { (app.catalog as unknown as { errors: Array<{ text: string; recipe?: string }> }).errors = [{ text: 'cover of adult (https://example.org/a.png): HTTP 404', recipe: 'adult' }, { text: 'https://catalog.example: timeout' }] }
    await setLevel('shown')
    await new Promise((resolve) => setTimeout(resolve, 50))
    problems()
    expect((await request(app.app).get('/api/catalog')).body.status.errors).toHaveLength(2)
    expect((await request(app.app).get('/api/catalog').set('x-renplay-adult', 'blurred')).body.status.errors).toEqual(['https://catalog.example: timeout'])
    const off = (await request(app.app).get('/api/catalog').set('x-renplay-adult', 'off')).body.status
    expect(off.errors).toEqual(['https://catalog.example: timeout'])
    expect(off.count).toBe((await request(app.app).get('/api/catalog').set('x-renplay-adult', 'off')).body.games.length)
  })

  it('writes the 3.2 columns with the installation level, so a downgrade never shows more', async () => {
    await setLevel('blurred')
    const owner = app.db.raw.prepare('SELECT adult_access, prefs FROM users WHERE id = 1').get() as { adult_access: number; prefs: string }
    expect(JSON.parse(owner.prefs).adultPictures).toBe('hide-pictures')
    expect(app.db.getSetting('adult_games', '')).toBe('allow')
    await setLevel('shown')
    expect(JSON.parse((app.db.raw.prepare('SELECT prefs FROM users WHERE id = 1').get() as { prefs: string }).prefs).adultPictures).toBe('show')
  })
})

describe('review fixes outside the routes', () => {
  it('marks an install adult from its recipe at once, and keeps a recipe-less game\'s mark', () => {
    const catalog = { isAdultId: (id: string) => id === 'adult' }
    expect(adultFlag(catalog, 'adult', null)).toBe(1)
    expect(adultFlag(catalog, 'safe', { adult: 1 } as never)).toBe(0)
    expect(adultFlag(catalog, '', { adult: 1 } as never)).toBe(1)
    expect(adultFlag(catalog, '', null)).toBe(0)
  })

  it('reads a group mapping without one valid entry as everyone at Off, never as no mapping', () => {
    process.env['RENPLAY_OIDC_ADULT_GROUPS'] = 'adults=shwon'
    process.env['RENPLAY_LDAP_ADULT_GROUPS'] = 'nonsense'
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const cfg = loadConfig()
      expect(cfg.oidcAdultGroups).toEqual({})
      expect(cfg.ldapAdultGroups).toEqual({})
      expect(groupCeiling(cfg.oidcAdultGroups!, ['adults'])).toBe('off')
    } finally {
      delete process.env['RENPLAY_OIDC_ADULT_GROUPS']
      delete process.env['RENPLAY_LDAP_ADULT_GROUPS']
      error.mockRestore()
      warn.mockRestore()
    }
  })

  it('projects the installation level into the 3.2 picture preference', () => {
    expect(legacyMirror('shown', 'shown', 'blurred')).toEqual({ adultAccess: 1, adultPictures: 'hide-pictures' })
    expect(legacyMirror('shown', 'shown', 'off')).toEqual({ adultAccess: 1, adultPictures: 'hide-games' })
    expect(legacyMirror('shown', 'shown')).toEqual({ adultAccess: 1, adultPictures: 'show' })
  })
})
