import { createHash, randomBytes } from 'node:crypto'
import yazl from 'yazl'
import { HttpError } from '../util/paths.js'
import { secretboxDecrypt, secretboxEncrypt } from './hydrogen.js'
import { readSaveMeta, readZipEntries } from './savefile.js'
import type { SaveStore } from './store.js'

/*
 * Ren'Py Sync, as renpy/common/00sync.rpy does it (Ren'Py 8.1 and newer): a code like ABCDE-12345,
 * a key and an address hashed from the code and the game's save folder, the saves zipped and
 * encrypted with libhydrogen's secretbox, and kept by the sync server for an hour. Renplay makes
 * and reads the same codes, so saves move between Renplay and desktop or Android Ren'Py.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const SIZE_LIMIT = 10 << 20
export const SYNC_LIFETIME = 3600_000

function sha256Rounds(data: Buffer, rounds: number): Buffer {
  let hashed = data
  for (let i = 0; i < rounds; i++) hashed = createHash('sha256').update(hashed).digest()
  return hashed
}

export function newSyncCode(): string {
  let n = randomBytes(8).readBigUInt64LE()
  let code = ''
  for (let i = 0; i < 10; i++) {
    if (i === 5) code += '-'
    code += DIGITS[Number(n % 36n)]
    n /= 36n
  }
  return code
}

/** A code as typed, with or without the dash, in either case. Null when it cannot be one. */
export function normalizeSyncCode(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const plain = input.trim().toUpperCase().replace(/-/g, '')
  if (plain.length !== 10 || [...plain].some((c) => !DIGITS.includes(c))) return null
  return `${plain.slice(0, 5)}-${plain.slice(5)}`
}

/** The 32-byte key and the address hash for a code and a save folder. */
export function keyAndHash(code: string, saveDir: string): { key: Buffer; hash: string } {
  const key = sha256Rounds(Buffer.from(code + saveDir, 'utf8'), 10_000)
  return { key, hash: sha256Rounds(key, 10_000).toString('hex') }
}

export function hashGame(saveDir: string): string {
  return sha256Rounds(Buffer.from(saveDir, 'utf8'), 10_000).toString('hex')
}

/** What Ren'Py sends: the persistent data and the saves, newest first, without autosaves or quick saves after the first. */
function syncable(name: string): boolean {
  if (name.includes('/') || !name.endsWith('.save')) return false
  return !name.startsWith('_') && !name.startsWith('auto-') && (!name.startsWith('quick-') || name.startsWith('quick-1-'))
}

function zip(entries: Array<{ name: string; data: Buffer; mtime: number }>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile()
    for (const e of entries) z.addBuffer(e.data, e.name, { mtime: new Date(e.mtime), compress: false })
    z.end()
    const chunks: Buffer[] = []
    z.outputStream.on('data', (c: Buffer) => chunks.push(c))
    z.outputStream.on('error', reject)
    z.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

/**
 * A time moved so that, written as the server's local time (as zip files store it), it shows the
 * clock time of the time zone `tz`. Unknown zones keep the server's own.
 */
function localIn(tz: string | undefined): (ms: number) => number {
  let format: Intl.DateTimeFormat | null = null
  if (tz && tz.length <= 64) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    } catch {}
  }
  return (ms) => {
    if (!format) return ms
    const p = Object.fromEntries(format.formatToParts(ms).map((x) => [x.type, Number(x.value)]))
    return new Date(p['year']!, p['month']! - 1, p['day']!, p['hour']!, p['minute']!, p['second']!).getTime()
  }
}

/** Reads a response body up to a limit, never more. */
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  if (Number(res.headers.get('content-length')) > limit) throw new HttpError(413, 'That sync is too large.')
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of res.body ?? []) {
    total += chunk.length
    if (total > limit) throw new HttpError(413, 'That sync is too large.')
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  } catch {
    throw new HttpError(502, 'Ren’Py’s sync server did not answer. Try again in a moment.')
  }
}

/** Packs this person's saves of one game, sends them and returns the code. */
export async function uploadSync(server: string, store: SaveStore, saveDir: string, tz?: string): Promise<{ code: string; saves: number; expiresAt: number }> {
  const files = (await store.list(saveDir)).filter((f) => syncable(f.name)).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const entries: Array<{ name: string; data: Buffer; mtime: number }> = [{ name: 'save_directory', data: Buffer.from(saveDir, 'utf8'), mtime: Date.now() }]
  let total = 0
  const persistent = await store.stat(saveDir, 'persistent')
  if (persistent && persistent.size < SIZE_LIMIT) {
    total += persistent.size
    entries.push({ name: 'persistent', data: await store.read(saveDir, 'persistent'), mtime: persistent.mtimeMs })
  }
  let saves = 0
  for (const f of files) {
    total += f.size
    if (total > SIZE_LIMIT) break
    entries.push({ name: f.name, data: await store.read(saveDir, f.name), mtime: f.mtimeMs })
    saves++
  }
  if (!saves && !persistent) throw new HttpError(409, 'There are no saves to send yet.')
  const code = newSyncCode()
  const { key, hash } = keyAndHash(code, saveDir)
  // Zip times are local times without a zone. Desktop Ren'Py reads them as its own, so they are
  // written in the person's time zone, as their browser gives it.
  const local = localIn(tz)
  const box = secretboxEncrypt(await zip(entries.map((e) => ({ ...e, mtime: local(e.mtime) }))), key)
  const res = await call(`${server}/api/sync/v1/${hash}?game=${hashGame(saveDir)}`, { method: 'PUT', body: new Uint8Array(box) })
  if (!res.ok) throw new HttpError(502, `Ren’Py’s sync server did not take the saves (${(await res.text().catch(() => '')).slice(0, 200) || res.status}).`)
  return { code, saves, expiresAt: Date.now() + SYNC_LIFETIME }
}

/**
 * Fetches a code's saves and writes them: each save into its slot with the rule for two devices
 * (the newer copy stays, the other goes to History), the persistent data into the sync folder,
 * where Ren'Py merges it with this one at the next start, as desktop Ren'Py does.
 */
export async function downloadSync(server: string, store: SaveStore, saveDir: string, input: unknown): Promise<{ added: number; replaced: number; kept: number; same: number }> {
  const code = normalizeSyncCode(input)
  if (!code) throw new HttpError(400, 'A Sync code has ten letters and numbers, like ABCDE-12345.')
  const { key, hash } = keyAndHash(code, saveDir)
  const res = await call(`${server}/api/sync/v1/${hash}`, { method: 'GET' })
  if (res.status === 404) throw new HttpError(404, 'No saves for this game with that code. Codes work for an hour.')
  if (!res.ok) throw new HttpError(502, `Ren’Py’s sync server did not send the saves (${res.status}).`)
  const box = await readCapped(res, SIZE_LIMIT * 2)
  let plain: Buffer
  try {
    plain = secretboxDecrypt(box, key)
  } catch {
    throw new HttpError(409, 'That code did not work for this game.')
  }
  const times = new Map<string, number>()
  const entries = await readZipEntries(plain, (n) => n === 'save_directory' || n === 'persistent' || syncable(n), SIZE_LIMIT * 2, times)
  if (entries.get('save_directory')?.toString('utf8') !== saveDir) throw new HttpError(409, 'The sync belongs to a different game.')
  const report = { added: 0, replaced: 0, kept: 0, same: 0 }
  for (const [name, data] of entries) {
    if (name === 'save_directory') continue
    const mtime = times.get(name)
    if (name === 'persistent') {
      await store.write(saveDir, 'sync/persistent', data, { mtimeMs: mtime, reason: 'sync' })
      continue
    }
    // The zip's times are the other device's local time, so the save's own time decides which copy
    // is newer. A broken or empty file never takes a save's place.
    const meta = await readSaveMeta(data)
    if (!meta) continue
    const before = await store.stat(saveDir, name)
    const written = await store.write(saveDir, name, data, { mtimeMs: meta.ctime ? meta.ctime * 1000 : mtime, reason: 'sync', base: 0 })
    if (written.conflict === 'kept') report.kept++
    else if (written.conflict === 'replaced') report.replaced++
    else if (before) report.same++
    else report.added++
  }
  return report
}
