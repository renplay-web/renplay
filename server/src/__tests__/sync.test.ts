import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import yazl from 'yazl'
import { createApp, type App } from '../app.js'
import { loadConfig } from '../config.js'
import { Db } from '../db.js'
import { secretboxDecrypt, secretboxEncrypt } from '../saves/hydrogen.js'
import { readZipEntries } from '../saves/savefile.js'
import { hashGame, keyAndHash, normalizeSyncCode } from '../saves/sync.js'

// Made by Ren'Py 8.5.3's own renpy.encryption.secretbox_encrypt and renpy.store._sync in the web
// engine, with the key bytes 0 to 31 and the messages (i * 7 + 3) % 256.
const KEY = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const message = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + 3) % 256))
const RENPY = {
  17: 'dab88054339c8f233ac54fc1ba06c8e1247190c9980126a92eb09a11d4c76ae7973cae13944a144ba58c476bcdc5d3418ec05de28d',
  55: '5f2fa5132ed5a88989126242e262a6093b6037f4de692ac944301db151c87d1f0bc850a2f04aaf54c700bfddc6f9b010f4c29e38b0fb808e4e7c66902598be8924bf34c2e86a12bed661c8d3a156cfe71ba43ba194d1e3874d155b',
}

describe('Ren’Py Sync encryption', () => {
  it('opens what Ren’Py sealed, and refuses a changed byte', () => {
    for (const [n, box] of Object.entries(RENPY)) expect(secretboxDecrypt(Buffer.from(box, 'hex'), KEY).equals(message(Number(n)))).toBe(true)
    const bad = Buffer.from(RENPY[55], 'hex')
    bad[40]! ^= 1
    expect(() => secretboxDecrypt(bad, KEY)).toThrow('Decryption failed')
  })

  it('round-trips messages of every length, including whole and partial blocks', () => {
    for (const n of [0, 1, 15, 16, 17, 55, 1000, 70_000]) expect(secretboxDecrypt(secretboxEncrypt(message(n), KEY), KEY).equals(message(n))).toBe(true)
  })

  it('derives Ren’Py’s key, address and game hash from a code', () => {
    const { key, hash } = keyAndHash('ABCDE-12345', 'DearDevere-1581812927')
    expect(key.toString('hex')).toBe('0a5e5705f10c27f90dca48f4fc0cd27beb2009e71fbd816052166c0a76a20bbd')
    expect(hash).toBe('6e901a75a84b58bd8bffcab1a89df723db12f34377675b823b3aa8882b99c172')
    expect(hashGame('DearDevere-1581812927')).toBe('b517153ac35fb17d638649136f417128574603afe17e7f2390c38e8c3934878d')
    expect(normalizeSyncCode(' abcde12345 ')).toBe('ABCDE-12345')
    expect(normalizeSyncCode('ABCDE-1234')).toBeNull()
    expect(normalizeSyncCode('ABCDE-1234!')).toBeNull()
  })
})

describe('Sync codes', () => {
  let root = ''
  let app: App
  let server: Server
  const kept = new Map<string, Buffer>()
  const zipOf = (entries: Record<string, [string | Buffer, number]>) =>
    new Promise<Buffer>((resolve) => {
      const z = new yazl.ZipFile()
      for (const [name, [body, mtime]] of Object.entries(entries)) z.addBuffer(Buffer.from(body), name, { mtime: new Date(mtime), compress: false })
      z.end()
      const chunks: Buffer[] = []
      z.outputStream.on('data', (c: Buffer) => chunks.push(c))
      z.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    })

  beforeAll(async () => {
    // A stand-in for sync.renpy.org: PUT keeps a body under its address, GET returns it.
    server = createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0]!
      if (req.method === 'PUT') {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => (kept.set(path, Buffer.concat(chunks)), res.end('OK')))
      } else if (kept.has(path)) res.end(kept.get(path))
      else (res.statusCode = 404), res.end('Not found')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    root = mkdtempSync(join(tmpdir(), 'renplay-sync-'))
    process.env['DATA_DIR'] = join(root, 'data')
    process.env['GAMES_DIR'] = join(root, 'games')
    process.env['RENPLAY_AUTH'] = 'off'
    process.env['RENPLAY_SYNC_SERVER'] = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
    process.env['RENPLAY_CATALOG_URLS'] = 'http://127.0.0.1:9/none'
    process.env['RENPLAY_ENGINES_URL'] = 'http://127.0.0.1:9/none'
    const cfg = loadConfig()
    const db = Db.open(cfg.dataDir)
    db.insertGame({ id: 'story', title: 'Story', status: 'installed', save_dir: 'Story-1', family: 'renpy' })
    db.insertGame({ id: 'page', title: 'Page', status: 'installed', save_dir: 'Page-1', family: 'html' })
    db.close()
    app = await createApp(cfg, { startJobs: false })
    const t = Date.now() - 600_000
    for (const [name, at] of [['1-1-LT1.save', t], ['quick-1-LT1.save', t + 1000], ['quick-2-LT1.save', t + 2000], ['auto-1-LT1.save', t + 3000], ['_reload-1-LT1.save', t + 4000], ['persistent', t]] as const)
      await app.saves.write('Story-1', name, Buffer.from(`web ${name}`), { mtimeMs: at })
  })
  afterAll(() => {
    app?.close()
    server?.close()
    rmSync(root, { recursive: true, force: true })
    for (const k of ['DATA_DIR', 'GAMES_DIR', 'RENPLAY_AUTH', 'RENPLAY_SYNC_SERVER', 'RENPLAY_CATALOG_URLS', 'RENPLAY_ENGINES_URL']) delete process.env[k]
  })

  it('is off until an admin turns it on, and only for Ren’Py games', async () => {
    expect((await request(app.app).get('/api/saves/story').expect(200)).body.sync).toBe(false)
    expect((await request(app.app).post('/api/saves/story/sync').expect(409)).body.error).toContain('turn them on in Settings')
    expect(kept.size).toBe(0)
    await request(app.app).put('/api/system/sync').send({ on: true }).expect(200)
    expect((await request(app.app).get('/api/system').expect(200)).body.sync.on).toBe(true)
    expect((await request(app.app).get('/api/saves/story').expect(200)).body.sync).toBe(true)
    expect((await request(app.app).get('/api/saves/page').expect(200)).body.sync).toBe(false)
    await request(app.app).post('/api/saves/page/sync').expect(409)
  })

  it('sends what Ren’Py sends, encrypted, under the code’s address', async () => {
    const { code, saves, expiresAt } = (await request(app.app).post('/api/saves/story/sync').expect(200)).body
    expect(normalizeSyncCode(code)).toBe(code)
    expect(saves).toBe(2)
    expect(expiresAt).toBeGreaterThan(Date.now() + 3500_000)
    const { key, hash } = keyAndHash(code, 'Story-1')
    const box = kept.get(`/api/sync/v1/${hash}`)!
    expect(box).toBeTruthy()
    const entries = await readZipEntries(secretboxDecrypt(box, key), () => true)
    // The persistent data and the saves, without autosaves, quick saves after the first, or files starting with _.
    expect([...entries.keys()].sort()).toEqual(['1-1-LT1.save', 'persistent', 'quick-1-LT1.save', 'save_directory'])
    expect(entries.get('save_directory')!.toString()).toBe('Story-1')
  })

  it('writes zip times as the clock time of the person’s time zone', async () => {
    const { code } = (await request(app.app).post('/api/saves/story/sync').send({ tz: 'Asia/Tokyo' }).expect(200)).body
    const { key, hash } = keyAndHash(code, 'Story-1')
    const times = new Map<string, number>()
    await readZipEntries(secretboxDecrypt(kept.get(`/api/sync/v1/${hash}`)!, key), () => true, 64 << 20, times)
    const saved = (await app.saves.stat('Story-1', '1-1-LT1.save'))!.mtimeMs
    const tokyo = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(saved)
    const written = new Date(times.get('1-1-LT1.save')!)
    expect(`${String(written.getHours()).padStart(2, '0')}:${String(written.getMinutes()).padStart(2, '0')}`).toBe(tokyo)
  })

  it('brings saves from a code made elsewhere: newer ones take the slot, the persistent data waits in the sync folder', async () => {
    const now = Date.now()
    // A save's own time decides, not the zip's (the other device's local time): here the zip times
    // say the opposite of the saves.
    const save = (text: string, at: number) => zipOf({ log: ['x', at], json: [JSON.stringify({ _save_name: text, _ctime: at / 1000 }), at] })
    const plain = await zipOf({
      save_directory: ['Story-1', now],
      persistent: ['desktop persistent', now - 1000],
      '1-1-LT1.save': [await save('desktop newer', now - 2000), now - 9 * 3600_000],
      'quick-1-LT1.save': [await save('desktop older', now - 3_600_000), now],
      '3-1-LT1.save': [await save('desktop only', now - 2000), now],
      '4-1-LT1.save': ['not a save', now],
    })
    const { key, hash } = keyAndHash('QWERT-67890', 'Story-1')
    kept.set(`/api/sync/v1/${hash}`, secretboxEncrypt(plain, key))
    const report = (await request(app.app).post('/api/saves/story/sync/download').send({ code: 'qwert67890' }).expect(200)).body
    expect(report).toEqual({ added: 1, replaced: 1, kept: 1, same: 0 })
    expect((await readZipEntries(await app.saves.read('Story-1', '1-1-LT1.save'), (n) => n === 'json')).get('json')!.toString()).toContain('desktop newer')
    expect(await app.saves.stat('Story-1', '4-1-LT1.save')).toBeNull()
    expect((await app.saves.read('Story-1', 'quick-1-LT1.save')).toString()).toBe('web quick-1-LT1.save')
    expect((await app.saves.read('Story-1', 'persistent')).toString()).toBe('web persistent')
    expect((await app.saves.read('Story-1', 'sync/persistent')).toString()).toBe('desktop persistent')
    expect((await app.saves.history('Story-1')).filter((v) => v.reason === 'conflict').map((v) => v.name).sort()).toEqual(['1-1-LT1.save', 'quick-1-LT1.save'])
  })

  it('says plainly when a code is wrong, gone or for another game', async () => {
    expect((await request(app.app).post('/api/saves/story/sync/download').send({ code: 'nope' }).expect(400)).body.error).toContain('ten letters and numbers')
    expect((await request(app.app).post('/api/saves/story/sync/download').send({ code: 'ZZZZZ-99999' }).expect(404)).body.error).toContain('Codes work for an hour')
    // Sealed for another save folder under this game's address.
    const { hash } = keyAndHash('ASDFG-11111', 'Story-1')
    kept.set(`/api/sync/v1/${hash}`, secretboxEncrypt(await zipOf({ save_directory: ['Other-2', Date.now()] }), keyAndHash('ASDFG-11111', 'Other-2').key))
    expect((await request(app.app).post('/api/saves/story/sync/download').send({ code: 'ASDFG-11111' }).expect(409)).body.error).toContain('did not work for this game')
    await request(app.app).put('/api/system/sync').send({ on: false }).expect(200)
    await request(app.app).post('/api/saves/story/sync/download').send({ code: 'QWERT-67890' }).expect(409)
  })
})
