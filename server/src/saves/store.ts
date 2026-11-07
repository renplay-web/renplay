import { mkdir, readFile, readdir, rename, rm, stat, unlink, utimes } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Writable } from 'node:stream'
import yazl from 'yazl'
import { sha1, walkFiles, writeFileAtomic } from '../util/fsx.js'
import { HttpError, cleanRelPath, isSaveDirName, safeJoin } from '../util/paths.js'
import { isRenpySave, isZip, readZipEntries } from './savefile.js'

export const TOKENS_DIR = 'tokens'
/** Top-level ~/.renpy folders shared by every game: save-signing keys and MultiPersistent data. */
export const SHARED_DIRS = [TOKENS_DIR, 'persistent'] as const
const MAX_FILE = 64 << 20

export interface SaveFile {
  /** Path relative to the save directory. */
  name: string
  size: number
  mtimeMs: number
}

export interface HistoryVersion {
  id: string
  name: string
  size: number
  savedAt: number
  reason: string
}

function isJunk(name: string): boolean {
  const b = basename(name)
  return b.startsWith('.') || b.endsWith('.tmp') || b.endsWith('.new') || b === 'text.txt'
}

/**
 * Server-side save storage. Layout:
 *   <root>/<save_directory>/<file>     current files, as Ren'Py wrote them
 *   <root>/tokens/security_keys.txt    shared save-signing keys
 *   <historyRoot>/<save_directory>/<file>/<ts>__<reason>__<sha>   previous versions
 */
export class SaveStore {
  private static locks = new Map<string, Promise<unknown>>()
  private acceptingWrites = true

  /** Whether a save is pinned: its history keeps every version. Set by the owner of the store. */
  pinned: (saveDir: string, rel: string) => boolean = () => false

  constructor(
    readonly root: string,
    readonly historyRoot: string,
    private readonly keepVersions = 20,
  ) {}

  private dir(saveDir: string): string {
    if (!isSaveDirName(saveDir)) throw new HttpError(400, 'Invalid save directory')
    return safeJoin(this.root, saveDir)
  }

  /** Drain accepted writes before archiving an account; stale requests may not recreate its folder. */
  async pauseWrites(): Promise<void> {
    this.acceptingWrites = false
    await Promise.all([...SaveStore.locks].filter(([key]) => key.startsWith(this.root + '/')).map(([, operation]) => operation.catch(() => {})))
  }

  resumeWrites(): void { this.acceptingWrites = true }

  /** Serializes operations on one file. */
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    if (!this.acceptingWrites) throw new HttpError(409, 'This account is being archived')
    const prev = SaveStore.locks.get(key) ?? Promise.resolve()
    const next = prev.catch(() => {}).then(fn)
    SaveStore.locks.set(key, next)
    try {
      return await next
    } finally {
      if (SaveStore.locks.get(key) === next) SaveStore.locks.delete(key)
    }
  }

  async list(saveDir: string): Promise<SaveFile[]> {
    const files = await walkFiles(this.dir(saveDir))
    return files.filter((f) => !isJunk(f.rel)).map((f) => ({ name: f.rel, size: f.size, mtimeMs: Math.floor(f.mtimeMs) }))
  }

  async listDirs(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      return entries
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !(SHARED_DIRS as readonly string[]).includes(e.name))
        .map((e) => e.name)
    } catch {
      return []
    }
  }

  async read(saveDir: string, name: string): Promise<Buffer> {
    const p = safeJoin(this.dir(saveDir), cleanRelPath(name))
    try {
      return await readFile(p)
    } catch {
      throw new HttpError(404, 'Save file not found')
    }
  }

  async stat(saveDir: string, name: string): Promise<SaveFile | null> {
    try {
      const st = await stat(safeJoin(this.dir(saveDir), cleanRelPath(name)))
      return st.isFile() ? { name, size: st.size, mtimeMs: Math.floor(st.mtimeMs) } : null
    } catch {
      return null
    }
  }

  /**
   * Writes a file, keeping the copy it replaces in History. `base` is the server's version (mtime)
   * the writer last saw, 0 for none. When a save has changed since (another device saved it), the
   * conflict rule applies: the copy saved later stays in the slot and the other goes to History as
   * a conflict. `conflict` says which: `kept` (the server's copy stayed) or `replaced`.
   */
  async write(saveDir: string, name: string, data: Buffer, opts: { mtimeMs?: number; reason?: string; base?: number; everyKind?: boolean; unanswered?: string } = {}): Promise<SaveFile & { conflict?: 'kept' | 'replaced' }> {
    const rel = cleanRelPath(name)
    if (isJunk(rel)) throw new HttpError(400, 'Refusing temporary file')
    if (data.length > MAX_FILE) throw new HttpError(413, 'Save file too large')
    const full = safeJoin(this.dir(saveDir), rel)
    return this.locked(full, async () => {
      let old: Buffer | null = null
      let oldMtime = 0
      try {
        old = await readFile(full)
        oldMtime = Math.floor((await stat(full)).mtimeMs)
      } catch {}
      if (old && old.equals(data)) {
        // The same bytes from a writer that tracks versions (a device, an import) never move the
        // server's time back: an older copy of the same save is still the same save.
        if (opts.base !== undefined && opts.mtimeMs && opts.mtimeMs < oldMtime) return { name: rel, size: data.length, mtimeMs: oldMtime }
        if (opts.mtimeMs) await utimes(full, new Date(), new Date(clampMtime(opts.mtimeMs))).catch(() => {})
        return { name: rel, size: data.length, mtimeMs: opts.mtimeMs ? clampMtime(opts.mtimeMs) : Date.now() }
      }
      const mtime = clampMtime(opts.mtimeMs)
      // Only saves, unless asked (an import): Ren'Py merges its persistent data itself while it runs.
      // A millisecond either way is the same version, because file times are stored in seconds as
      // floating point.
      // The server's copy came from this same device when it matches an upload whose answer was lost.
      const own = !!old && !!opts.unanswered && fnv(old) === opts.unanswered
      if (old && !own && opts.base !== undefined && (opts.everyKind || rel.endsWith('.save')) && Math.abs(oldMtime - opts.base) > 1) {
        if (mtime < oldMtime) {
          await this.snapshot(saveDir, rel, data, 'conflict')
          return { name: rel, size: old.length, mtimeMs: oldMtime, conflict: 'kept' as const }
        }
        await this.snapshot(saveDir, rel, old, 'conflict')
        await writeFileAtomic(full, data, new Date(mtime))
        return { name: rel, size: data.length, mtimeMs: mtime, conflict: 'replaced' as const }
      }
      if (old) await this.snapshot(saveDir, rel, old, opts.reason ?? 'overwrite')
      await writeFileAtomic(full, data, new Date(mtime))
      return { name: rel, size: data.length, mtimeMs: mtime }
    })
  }

  /**
   * Deletes a file, keeping it in History. With `base` (the version the deleting device last saw),
   * a save another device has changed since is left alone: the answer is `changed`.
   */
  async remove(saveDir: string, name: string, reason = 'delete', base?: number): Promise<boolean | 'changed'> {
    const rel = cleanRelPath(name)
    const full = safeJoin(this.dir(saveDir), rel)
    return this.locked(full, async () => {
      let old: Buffer
      try {
        old = await readFile(full)
      } catch {
        return false
      }
      if (base !== undefined && rel.endsWith('.save') && Math.abs(Math.floor((await stat(full)).mtimeMs) - base) > 1) return 'changed' as const
      await this.snapshot(saveDir, rel, old, reason)
      await unlink(full)
      return true
    })
  }

  private historyDir(saveDir: string, rel: string): string {
    return safeJoin(safeJoin(this.historyRoot, saveDir), rel.replace(/\//g, '__'))
  }

  private async snapshot(saveDir: string, rel: string, data: Buffer, reason: string): Promise<void> {
    if (!isSaveDirName(saveDir)) return
    const dir = this.historyDir(saveDir, rel)
    await mkdir(dir, { recursive: true })
    const id = `${Date.now()}__${reason.replace(/[^a-z-]/g, '')}__${sha1(data).slice(0, 10)}`
    await writeFileAtomic(join(dir, id), data)
    // Prune old versions, except of a pinned save. A version that is the only copy of something (the
    // older of two, a deleted save, what an import or restore replaced) stays at least 30 days
    // however many versions follow it.
    if (this.pinned(saveDir, rel)) return
    const versions = (await readdir(dir)).filter((n) => !n.startsWith('.')).sort()
    const excess = versions.length - this.keepVersions
    if (excess <= 0) return
    const recent = Date.now() - KEEP_ONLY_COPIES
    const prunable = versions.filter((v) => {
      const [ts, why] = v.split('__')
      return !(ONLY_COPIES.has(why ?? '') && Number(ts) > recent)
    })
    for (const v of prunable.slice(0, excess)) await unlink(join(dir, v)).catch(() => {})
  }

  async history(saveDir: string, name?: string): Promise<HistoryVersion[]> {
    const base = safeJoin(this.historyRoot, this.validated(saveDir))
    let files: string[]
    try {
      files = await readdir(base)
    } catch {
      return []
    }
    const out: HistoryVersion[] = []
    for (const f of files) {
      const rel = f.replace(/__/g, '/')
      if (name && rel !== name) continue
      const dir = join(base, f)
      let versions: string[] = []
      try {
        versions = await readdir(dir)
      } catch {
        continue
      }
      for (const v of versions) {
        const [ts, reason] = v.split('__')
        const st = await stat(join(dir, v)).catch(() => null)
        if (!st) continue
        out.push({ id: `${f}/${v}`, name: rel, size: st.size, savedAt: Number(ts), reason: reason ?? '' })
      }
    }
    return out.sort((a, b) => b.savedAt - a.savedAt)
  }

  /** Versions kept by the conflict rule since a time, newest first, read from History's names alone. */
  async conflicts(saveDir: string, since: number): Promise<Array<{ id: string; file: string; at: number }>> {
    const base = safeJoin(this.historyRoot, this.validated(saveDir))
    const out: Array<{ id: string; file: string; at: number }> = []
    for (const f of await readdir(base).catch(() => [] as string[])) {
      for (const v of await readdir(join(base, f)).catch(() => [] as string[])) {
        const [ts, reason] = v.split('__')
        if (reason === 'conflict' && Number(ts) >= since) out.push({ id: `${f}/${v}`, file: f.replace(/__/g, '/'), at: Number(ts) })
      }
    }
    return out.sort((a, b) => b.at - a.at)
  }

  async restoreVersion(saveDir: string, id: string): Promise<SaveFile> {
    const [fileKey, version] = id.split('/')
    if (!fileKey || !version || version.includes('..') || fileKey.includes('..')) throw new HttpError(400, 'Invalid version id')
    const src = safeJoin(safeJoin(this.historyRoot, this.validated(saveDir)), `${fileKey}/${version}`)
    let data: Buffer
    try {
      data = await readFile(src)
    } catch {
      throw new HttpError(404, 'Version not found')
    }
    return this.write(saveDir, fileKey.replace(/__/g, '/'), data, { reason: 'restore' })
  }

  private validated(saveDir: string): string {
    if (!isSaveDirName(saveDir)) throw new HttpError(400, 'Invalid save directory')
    return saveDir
  }

  // ---- shared tokens ------------------------------------------------------

  /** Files of the shared folders, as paths relative to ~/.renpy. */
  async sharedFiles(): Promise<Array<{ name: string; data: Buffer; mtimeMs: number }>> {
    const out = []
    for (const dir of SHARED_DIRS) {
      for (const f of await walkFiles(join(this.root, dir))) {
        if (!isJunk(f.rel)) out.push({ name: `${dir}/${f.rel}`, data: await readFile(f.full), mtimeMs: Math.floor(f.mtimeMs) })
      }
    }
    return out
  }

  /** Copies a save into another save folder, picking a free slot name if needed. */
  async copySave(fromDir: string, name: string, toDir: string): Promise<string> {
    const rel = cleanRelPath(name)
    const data = await this.read(fromDir, rel)
    const existing = new Set((await this.list(toDir)).map((f) => f.name))
    let target = rel
    if (existing.has(target)) {
      const m = rel.match(/^(.*?)-(\d+)-(LT\d+\.save)$/)
      const page = m && !/^(auto|quick)$/.test(m[1]!) ? m[1]! : '1'
      const suffix = m?.[3] ?? 'LT1.save'
      let n = 1
      while (existing.has(`${page}-${n}-${suffix}`)) n++
      target = `${page}-${n}-${suffix}`
    }
    await this.write(toDir, target, data, { reason: 'copy' })
    return target
  }

  /**
   * Merges a security_keys.txt from another device into the shared one, so
   * saves signed there load without Ren'Py's "untrusted save" prompt.
   */
  async mergeSecurityKeys(text: string): Promise<number> {
    const path = join(this.root, TOKENS_DIR, 'security_keys.txt')
    return this.locked(path, async () => {
      let current = ''
      try {
        current = await readFile(path, 'utf-8')
      } catch {}
      const have = new Set(current.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
      const add: string[] = []
      for (const raw of text.split(/\r?\n/)) {
        // Ren'Py stores "signing-key <sk> <vk>" and "verifying-key <vk>" lines. Only
        // the verifying keys are needed to trust saves made on that device.
        const parts = raw.trim().split(/\s+/)
        const vk = parts[0] === 'signing-key' ? parts[2] : parts[0] === 'verifying-key' ? parts[1] : undefined
        if (!vk || !/^[A-Za-z0-9+/=]+$/.test(vk)) continue
        const line = `verifying-key ${vk}`
        if (!have.has(line) && !current.includes(vk)) {
          have.add(line)
          add.push(line)
        }
      }
      if (!add.length) return 0
      const next = (current && !current.endsWith('\n') ? current + '\n' : current) + add.join('\n') + '\n'
      if (current) await this.snapshot(TOKENS_DIR, 'security_keys.txt', Buffer.from(current), 'merge-keys')
      await writeFileAtomic(path, next)
      return add.length
    })
  }

  // ---- export / import ----------------------------------------------------

  async exportZip(saveDirs: string[], out: Writable, opts: { includeTokens?: boolean } = {}): Promise<void> {
    const zip = new yazl.ZipFile()
    zip.outputStream.pipe(out)
    for (const sd of saveDirs) {
      for (const f of await this.list(sd)) {
        zip.addFile(safeJoin(this.dir(sd), f.name), `${sd}/${f.name}`, { mtime: new Date(f.mtimeMs) })
      }
    }
    if (opts.includeTokens) {
      for (const t of await this.sharedFiles()) zip.addBuffer(t.data, t.name, { mtime: new Date(t.mtimeMs) })
    }
    zip.end()
    await new Promise<void>((resolve, reject) => {
      out.on('finish', resolve)
      out.on('close', resolve)
      out.on('error', reject)
    })
  }

  /**
   * Imports save data from uploaded files. Each upload may be a single save,
   * a `persistent` file, a `security_keys.txt`, or a zip bundle in any common
   * layout (Ren'Py web export, desktop save folder, `game/saves`, renplay export).
   */
  async importFiles(saveDir: string, uploads: Array<{ filename: string; data: Buffer }>): Promise<ImportReport> {
    const report: ImportReport = { imported: [], skipped: [], trustedKeys: 0 }
    for (const up of uploads) {
      const base = basename(up.filename.replace(/\\/g, '/'))
      if (base.endsWith('.save') || base === 'persistent') {
        await this.importOne(saveDir, base, up.data, report)
      } else if (base === 'security_keys.txt') {
        report.trustedKeys += await this.mergeSecurityKeys(up.data.toString('utf-8'))
      } else if (isZip(up.data)) {
        await this.importBundle(saveDir, up.filename, up.data, report)
      } else {
        report.skipped.push({ name: up.filename, reason: 'Not a Ren\u2019Py save, persistent file, or zip' })
      }
    }
    return report
  }

  private async importOne(saveDir: string, name: string, data: Buffer, report: ImportReport): Promise<void> {
    if (name.endsWith('.save') && !(await isRenpySave(data))) {
      report.skipped.push({ name, reason: 'Not a valid Ren\u2019Py save file' })
      return
    }
    await this.write(saveDir, name, data, { reason: 'import' })
    report.imported.push(name)
  }

  private async importBundle(saveDir: string, filename: string, data: Buffer, report: ImportReport): Promise<void> {
    const entries = await readZipEntries(data, () => true, 512 << 20)
    const names = [...entries.keys()]
    // A zipped-up *single* save (its members at the root) is itself a save file.
    if (names.includes('log') && names.includes('renpy_version') && !names.some((n) => n.endsWith('.save'))) {
      await this.importOne(saveDir, basename(filename).replace(/\.zip$/i, '') + (filename.endsWith('.save') ? '' : '.save'), data, report)
      return
    }
    // Group candidate files by their parent folder.
    const groups = new Map<string, Array<[string, Buffer]>>()
    for (const [n, buf] of entries) {
      const clean = n.replace(/\\/g, '/')
      const b = basename(clean)
      if (b === 'security_keys.txt') {
        report.trustedKeys += await this.mergeSecurityKeys(buf.toString('utf-8'))
        continue
      }
      if (!(b.endsWith('.save') || b === 'persistent')) continue
      const parent = dirname(clean) === '.' ? '' : basename(dirname(clean))
      if (!groups.has(parent)) groups.set(parent, [])
      groups.get(parent)!.push([b, buf])
    }
    if (!groups.size) {
      report.skipped.push({ name: filename, reason: 'No save files found in zip' })
      return
    }
    // Prefer the folder named after this game's save directory; then root/"saves"; then a single folder.
    let chosen: Array<[string, Buffer]> | undefined = groups.get(saveDir)
    if (!chosen) {
      const generic = ['', 'saves'].map((k) => groups.get(k)).find(Boolean)
      if (generic) chosen = generic
      else if (groups.size === 1) chosen = [...groups.values()][0]
    }
    if (!chosen) {
      report.skipped.push({
        name: filename,
        reason: `Zip contains saves for other games (${[...groups.keys()].join(', ')}), none for ${saveDir}`,
      })
      return
    }
    for (const [n, buf] of chosen) await this.importOne(saveDir, n, buf, report)
  }

  /** Moves a whole save directory aside (used when a game is forgotten with its saves). */
  async archiveDir(saveDir: string): Promise<void> {
    const src = this.dir(saveDir)
    const dest = safeJoin(this.historyRoot, `.deleted/${saveDir}.${Date.now()}`)
    await mkdir(dirname(dest), { recursive: true })
    await rename(src, dest).catch(async () => {
      await rm(src, { recursive: true, force: true })
    })
  }
}

export interface ImportReport {
  imported: string[]
  skipped: Array<{ name: string; reason: string }>
  trustedKeys: number
}

/** History reasons whose version is the only copy of something. */
const ONLY_COPIES = new Set(['conflict', 'delete', 'game-delete', 'user-delete', 'import', 'restore', 'sync', 'copy', 'user-copy'])
const KEEP_ONLY_COPIES = 30 * 24 * 3600_000

/** The runtime's FNV-1a hash of a file, as it names an upload: "<hex>:<length>". */
export function fnv(data: Uint8Array): string {
  let h = 0x811c9dc5
  for (let i = 0; i < data.length; i++) {
    h ^= data[i]!
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}:${data.length}`
}

function clampMtime(ms?: number): number {
  const now = Date.now()
  if (!ms || !Number.isFinite(ms) || ms <= 0 || ms > now + 60_000) return now
  return Math.floor(ms)
}
