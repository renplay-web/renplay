import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeEach, describe, expect, it } from 'vitest'
import yazl from 'yazl'
import { readSaveMeta, readZipEntries, slotInfo } from '../saves/savefile.js'
import { SaveStore, fnv } from '../saves/store.js'

function zip(entries: Record<string, Buffer | string>): Promise<Buffer> {
  return new Promise((resolve) => {
    const z = new yazl.ZipFile()
    for (const [k, v] of Object.entries(entries)) z.addBuffer(Buffer.from(v), k)
    z.end()
    const chunks: Buffer[] = []
    z.outputStream.on('data', (c: Buffer) => chunks.push(c))
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

const saveFile = (name: string) =>
  zip({ log: 'pickled-log', json: JSON.stringify({ _save_name: name, _ctime: 1700000000, _renpy_version: [8, 5, 3, 1] }), extra_info: name, 'screenshot.png': 'PNGDATA', renpy_version: '8.5.3' })

describe('SaveStore', () => {
  let store: SaveStore
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'saves-'))
    store = new SaveStore(join(root, 'saves'), join(root, 'history'), 3)
  })

  it('writes, keeps history on overwrite, and restores', async () => {
    await store.write('Game-1', '1-1-LT1.save', Buffer.from('v1'))
    await store.write('Game-1', '1-1-LT1.save', Buffer.from('v2'))
    await store.write('Game-1', '1-1-LT1.save', Buffer.from('v2')) // identical: no new version
    expect((await store.read('Game-1', '1-1-LT1.save')).toString()).toBe('v2')
    const hist = await store.history('Game-1', '1-1-LT1.save')
    expect(hist).toHaveLength(1)
    await store.restoreVersion('Game-1', hist[0]!.id)
    expect((await store.read('Game-1', '1-1-LT1.save')).toString()).toBe('v1')
  })

  it('prunes history to the configured number of versions', async () => {
    for (let i = 0; i < 6; i++) await store.write('G', 'persistent', Buffer.from(`v${i}`))
    expect((await store.history('G', 'persistent')).length).toBe(3)
  })

  it('keeps every version of a pinned save', async () => {
    store.pinned = (dir, rel) => dir === 'Game-1' && rel === 'pinned.save'
    for (let i = 0; i < 6; i++) {
      await store.write('Game-1', 'pinned.save', Buffer.from(`v${i}`))
      await store.write('Game-1', 'other.save', Buffer.from(`v${i}`))
    }
    expect(await store.history('Game-1', 'pinned.save')).toHaveLength(5)
    expect(await store.history('Game-1', 'other.save')).toHaveLength(3)
  })

  it('applies the conflict rule when another device saved the same slot in between', async () => {
    const t = Date.now() - 60_000
    const first = await store.write('G', '1-1-LT1.save', Buffer.from('desktop'), { mtimeMs: t, base: 0 })
    expect(first.conflict).toBeUndefined()
    // A phone that saw the desktop's copy just overwrites it, as before.
    const phone = await store.write('G', '1-1-LT1.save', Buffer.from('phone'), { mtimeMs: t + 10_000, base: first.mtimeMs })
    expect(phone.conflict).toBeUndefined()
    // The desktop, still on its own copy, saves later: its copy is newer and takes the slot, the
    // phone's goes to History as a conflict.
    const later = await store.write('G', '1-1-LT1.save', Buffer.from('desktop later'), { mtimeMs: t + 20_000, base: first.mtimeMs })
    expect(later.conflict).toBe('replaced')
    expect((await store.read('G', '1-1-LT1.save')).toString()).toBe('desktop later')
    // A device that played offline delivers an older copy: the slot keeps the newer one.
    const offline = await store.write('G', '1-1-LT1.save', Buffer.from('offline'), { mtimeMs: t + 5_000, base: first.mtimeMs })
    expect(offline).toMatchObject({ conflict: 'kept', mtimeMs: later.mtimeMs })
    expect((await store.read('G', '1-1-LT1.save')).toString()).toBe('desktop later')
    const conflicts = await store.conflicts('G', 0)
    expect(conflicts.map((c) => c.file)).toEqual(['1-1-LT1.save', '1-1-LT1.save'])
    const kept: string[] = []
    for (const v of (await store.history('G', '1-1-LT1.save')).filter((v) => v.reason === 'conflict')) {
      await store.restoreVersion('G', v.id)
      kept.push((await store.read('G', '1-1-LT1.save')).toString())
    }
    expect(kept.sort()).toEqual(['offline', 'phone'])
    // A device that knew no file, while another created it.
    await store.write('G', '2-1-LT1.save', Buffer.from('one'), { base: 0 })
    expect((await store.write('G', '2-1-LT1.save', Buffer.from('two'), { base: 0 })).conflict).toBe('replaced')
    // The same bytes with an older time leave the server's time alone.
    const slotTime = (await store.stat('G', '1-1-LT1.save'))!.mtimeMs
    const slotNow = (await store.read('G', '1-1-LT1.save')).toString()
    expect((await store.write('G', '1-1-LT1.save', Buffer.from(slotNow), { mtimeMs: slotTime - 50_000, base: 0 })).mtimeMs).toBe(slotTime)
    expect((await store.stat('G', '1-1-LT1.save'))!.mtimeMs).toBe(slotTime)
    // No base (older runtimes, imports, restores) and the persistent file: the rule does not apply.
    expect((await store.write('G', '2-1-LT1.save', Buffer.from('three'))).conflict).toBeUndefined()
    await store.write('G', 'persistent', Buffer.from('p1'), { base: 0 })
    expect((await store.write('G', 'persistent', Buffer.from('p2'), { base: 0 })).conflict).toBeUndefined()
  })

  it('knows its own upload whose answer was lost: no conflict with itself', async () => {
    const first = await store.write('G', '8-1-LT1.save', Buffer.from('one'), { base: 0 })
    // The next upload landed, but its answer did not come back, so the device still has the old base.
    await store.write('G', '8-1-LT1.save', Buffer.from('two'), { base: first.mtimeMs, mtimeMs: first.mtimeMs + 5000 })
    const third = await store.write('G', '8-1-LT1.save', Buffer.from('three'), { base: first.mtimeMs, mtimeMs: first.mtimeMs + 9000, unanswered: fnv(Buffer.from('two')) })
    expect(third.conflict).toBeUndefined()
    expect((await store.history('G', '8-1-LT1.save')).map((v) => v.reason)).not.toContain('conflict')
    // Another device's copy is still a conflict.
    const fourth = await store.write('G', '8-1-LT1.save', Buffer.from('four'), { base: first.mtimeMs, mtimeMs: first.mtimeMs + 12000, unanswered: fnv(Buffer.from('two')) })
    expect(fourth.conflict).toBe('replaced')
    expect(fnv(new Uint8Array([1, 2, 3]))).toMatch(/^[0-9a-f]+:3$/)
  })

  it('keeps the only copy of something for 30 days, however many versions follow', async () => {
    await store.write('G', 'auto-1-LT1.save', Buffer.from('desktop'), { mtimeMs: Date.now() - 60_000, base: 0 })
    await store.write('G', 'auto-1-LT1.save', Buffer.from('phone'), { mtimeMs: Date.now() - 30_000, base: 0 })
    for (let i = 0; i < 10; i++) await store.write('G', 'auto-1-LT1.save', Buffer.from(`turn ${i}`))
    const reasons = (await store.history('G', 'auto-1-LT1.save')).map((v) => v.reason)
    expect(reasons.filter((r) => r === 'conflict')).toHaveLength(1)
    expect(reasons.filter((r) => r === 'game' || r === 'overwrite')).toHaveLength(2)
  })

  it('never moves a save’s time into the future, and leaves a save another device changed when deleting', async () => {
    await store.write('G', '5-1-LT1.save', Buffer.from('same'))
    await store.write('G', '5-1-LT1.save', Buffer.from('same'), { mtimeMs: Date.UTC(2107, 0, 1) })
    expect((await store.stat('G', '5-1-LT1.save'))!.mtimeMs).toBeLessThanOrEqual(Date.now() + 60_000)
    const seen = (await store.stat('G', '5-1-LT1.save'))!.mtimeMs
    await store.write('G', '5-1-LT1.save', Buffer.from('another device'), { mtimeMs: seen + 5000 })
    expect(await store.remove('G', '5-1-LT1.save', 'game-delete', seen)).toBe('changed')
    expect((await store.read('G', '5-1-LT1.save')).toString()).toBe('another device')
    expect(await store.remove('G', '5-1-LT1.save', 'game-delete', seen + 5000)).toBe(true)
  })

  it('keeps a version when a save is deleted', async () => {
    await store.write('G', 'auto-1-LT1.save', Buffer.from('x'))
    expect(await store.remove('G', 'auto-1-LT1.save')).toBe(true)
    expect(await store.list('G')).toEqual([])
    expect((await store.history('G'))[0]?.reason).toBe('delete')
  })

  it('rejects path traversal and junk names', async () => {
    await expect(store.write('G', '../evil', Buffer.from('x'))).rejects.toThrow()
    await expect(store.write('../x', 'a', Buffer.from('x'))).rejects.toThrow()
    await expect(store.write('G', 'persistent.new', Buffer.from('x'))).rejects.toThrow()
  })

  it('imports single saves, persistent files and bundles in common layouts', async () => {
    const a = await saveFile('Alpha')
    const r1 = await store.importFiles('Game-1', [
      { filename: '1-1-LT1.save', data: a },
      { filename: 'persistent', data: Buffer.from('p') },
      { filename: 'notes.txt', data: Buffer.from('?') },
    ])
    expect(r1.imported).toEqual(['1-1-LT1.save', 'persistent'])
    expect(r1.skipped).toHaveLength(1)

    // Desktop layout: RenPy/<save dir>/..., plus another game's folder.
    const bundle = await zip({ 'Game-1/2-1-LT1.save': await saveFile('Beta'), 'Other-9/1-1-LT1.save': await saveFile('Nope') })
    const r2 = await store.importFiles('Game-1', [{ filename: 'saves.zip', data: bundle }])
    expect(r2.imported).toEqual(['2-1-LT1.save'])

    // A zip of loose files at the root.
    const flat = await zip({ '3-1-LT1.save': await saveFile('Gamma') })
    expect((await store.importFiles('Game-1', [{ filename: 'x.zip', data: flat }])).imported).toEqual(['3-1-LT1.save'])

    // An invalid .save is refused.
    const bad = await store.importFiles('Game-1', [{ filename: '9-9-LT1.save', data: Buffer.from('not a zip') }])
    expect(bad.imported).toEqual([])
  })

  it('merges security keys from another device', async () => {
    const text = 'signing-key AAAA BBBB\nverifying-key CCCC\n'
    const r = await store.importFiles('G', [{ filename: 'security_keys.txt', data: Buffer.from(text) }])
    expect(r.trustedKeys).toBe(2)
    const keys = readFileSync(join(root, 'saves', 'tokens', 'security_keys.txt'), 'utf-8')
    expect(keys).toBe('verifying-key BBBB\nverifying-key CCCC\n')
    expect(await store.mergeSecurityKeys(text)).toBe(0)
  })

  it('copies a save into another folder without overwriting', async () => {
    await store.write('S1', '5-2-LT1.save', Buffer.from('end of s1'))
    await store.write('S2', '5-2-LT1.save', Buffer.from('s2 save'))
    const name = await store.copySave('S1', '5-2-LT1.save', 'S2')
    expect(name).toBe('5-1-LT1.save')
    expect((await store.read('S2', name)).toString()).toBe('end of s1')
    expect((await store.read('S2', '5-2-LT1.save')).toString()).toBe('s2 save')
  })

  it('exports a desktop-compatible zip', async () => {
    await store.write('G', '1-1-LT1.save', Buffer.from('x'))
    await store.mergeSecurityKeys('verifying-key ZZZZ')
    const out = new PassThrough()
    const chunks: Buffer[] = []
    out.on('data', (c) => chunks.push(c))
    await store.exportZip(['G'], out, { includeTokens: true })
    const entries = await readZipEntries(Buffer.concat(chunks), () => true)
    expect([...entries.keys()].sort()).toEqual(['G/1-1-LT1.save', 'tokens/security_keys.txt'])
  })
})

describe('save files', () => {
  it('reads metadata', async () => {
    const meta = await readSaveMeta(await saveFile('Chapter 2'))
    expect(meta).toMatchObject({ name: 'Chapter 2', ctime: 1700000000, renpyVersion: '8.5.3.1', hasScreenshot: true })
  })

  it('names slots', () => {
    expect(slotInfo('3-2-LT1.save')).toMatchObject({ kind: 'manual', page: '3', slot: '2' })
    expect(slotInfo('auto-4-LT1.save').kind).toBe('auto')
    expect(slotInfo('quick-1-LT1.save').kind).toBe('quick')
    expect(slotInfo('_reload-1-LT1.save').kind).toBe('internal')
  })
})
