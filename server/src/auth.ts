import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto'
import { mkdir, rename, writeFile, symlink, lstat } from 'node:fs/promises'
import { dirname as pathDirname, relative as pathRelative } from 'node:path'
import { join } from 'node:path'
import express, { Router, type Request, type Response } from 'express'
import type { Config } from './config.js'
import { legacyMirror, lowestLevel, parseAdultLevel, type AdultLevel, type ContentMode } from './content.js'
import type { Db, GameRow } from './db.js'
import { parseJson } from './db.js'
import { viewer, viewers, type User, type Viewer } from './accounts-context.js'
import { SaveStore, SHARED_DIRS } from './saves/store.js'
import { readZipEntries } from './saves/savefile.js'
import { saveImport } from './saves/import-upload.js'
import { HttpError, cleanRelPath, isSaveDirName } from './util/paths.js'
import { SignInProviders, signInRandom, type ExternalIdentity } from './sign-in-providers.js'
import { fetchAvatar, storeAvatar } from './avatars.js'
import { always, log } from './util/log.js'

// Measured locally at 207 ms (N=65536: 105 ms); explicit 128 MiB work factor.
const PASSWORD_PREFIX = 'scrypt$1$131072$8$1$'
const scrypt = (password: string, salt: string, N: number) => new Promise<Buffer>((resolve, reject) => {
  scryptCallback(password, salt, 64, { N, r: 8, p: 1, maxmem: 256 << 20 }, (error, key) => error ? reject(error) : resolve(key))
})
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const random = () => randomBytes(32).toString('base64url')
const DAYS30 = 30 * 86400_000
export const keepaliveToken = random()

/**
 * Defaults for everyone: what a person starts with until they choose. Each value is null when the
 * admin leaves it to Renplay's own default.
 */
export interface Defaults {
  /** Tags left out on the Catalog page. */
  tagsExclude: string[]
  /** Lighter background on browsers that did not choose. */
  lighterBackground: boolean | null
  /** Ren'Py text size in games where the person did not choose one. */
  textSize: number | null
  rollback: boolean | null
  skip: boolean | null
}
export const DEFAULTS_KEY = 'defaults_for_everyone'
export function readDefaults(db: Db): Defaults {
  const d = db.getSetting<Partial<Defaults>>(DEFAULTS_KEY, {})
  return {
    tagsExclude: Array.isArray(d.tagsExclude) ? d.tagsExclude.filter((t) => typeof t === 'string') : [],
    lighterBackground: typeof d.lighterBackground === 'boolean' ? d.lighterBackground : null,
    textSize: typeof d.textSize === 'number' && [1, 1.25, 1.5].includes(d.textSize) ? d.textSize : null,
    rollback: typeof d.rollback === 'boolean' ? d.rollback : null,
    skip: typeof d.skip === 'boolean' ? d.skip : null,
  }
}

/** An account as the API sends it: never its PIN's hash or lock. */
export function publicUser<T extends Partial<User>>(u: T): Omit<T, 'pin_hash' | 'pin_failures' | 'pin_locked_until'> & { hasPin: boolean } {
  const { pin_hash, pin_failures: _f, pin_locked_until: _l, ...rest } = u
  return { ...rest, hasPin: !!pin_hash }
}

export async function passwordHash(password: unknown): Promise<string> {
  if (typeof password !== 'string' || password.length < 10 || password.length > 1024) throw new HttpError(400, 'Use a password with 10 to 1024 characters')
  const salt = randomBytes(16).toString('hex')
  return `${PASSWORD_PREFIX}${salt}$${(await scrypt(password, salt, 131072)).toString('hex')}`
}
async function passwordMatches(password: unknown, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || password.length > 1024) return false
  const parts = encoded.split('$')
  const [salt, key] = parts.length === 1 ? encoded.split(':') : parts.slice(5)
  const N = parts.length === 1 ? 16384 : Number(parts[2])
  if (parts.length !== 1 && (parts.length !== 7 || parts[0] !== 'scrypt' || parts[1] !== '1' || parts[3] !== '8' || parts[4] !== '1' || ![16384, 65536, 131072].includes(N))) return false
  if (!salt || !key || !/^[0-9a-f]{128}$/.test(key)) return false
  const actual = await scrypt(password, salt, N)
  const expected = Buffer.from(key, 'hex')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
function equal(a: string, b: string): boolean { return timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b))) }
function username(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$/.test(value)) throw new HttpError(400, 'Use 2 to 64 letters, numbers, dots, dashes or underscores for the username')
  return value.toLowerCase()
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) throw new HttpError(400, 'Enter a name with at most 100 characters')
  return value.trim()
}

/** A closed player allowlist makes new management endpoints admin-only by default. */
export function playerRoute(method: string, path: string): boolean {
  if (/^\/api\/me(?:\/|$)/.test(path) || /^\/api\/avatars\/[a-f0-9]{64}\.webp$/.test(path) && ['GET', 'HEAD'].includes(method)) return true
  if (/^\/api\/saves(?:\/|$)/.test(path) || path === '/api/saves-export' || path === '/api/saves-import') return true
  if ((method === 'GET' || method === 'HEAD') && (/^\/g\//.test(path) || /^\/api\/(art|walkthroughs)\//.test(path) || ['/api/games', '/api/catalog', '/api/content'].includes(path) || /^\/api\/games\/[^/]+(?:\/art)?$/.test(path))) return true
  // A player chooses and uploads art for their own view (the route refuses everyone).
  if ((method === 'GET' || method === 'HEAD') && (path === '/api/history' || path === '/api/widget' || path === '/api/defaults')) return true
  return /^(PUT \/api\/games\/[^/]+\/(favorite|finished|art|status|rating)|POST \/api\/games\/[^/]+\/(played|play-time|art\/upload|not-now)|DELETE \/api\/games\/[^/]+\/(art|not-now|art\/uploads\/[0-9a-f]{64}))$/.test(`${method} ${path}`)
}

export class Accounts {
  readonly enabled: boolean
  readonly providers: SignInProviders
  private readonly oidcFlows = new Map<string, { nonce: string; verifier: string; expires: number; session?: string; user?: number; bearer?: boolean }>()
  private setupCode = randomBytes(9).toString('hex').toUpperCase()
  private attempts = 10
  private setupGrant = ''
  private readonly signingKey = random()
  private readonly stores = new Map<number, SaveStore>()
  private readonly removing = new Set<number>()
  private readonly limits = new Map<string, { count: number; until: number }>()
  private readonly sessionCache = new Map<string, { id: number; expires: number; touched: number; checked: number }>()
  private dummyPassword = ''
  constructor(readonly db: Db, readonly cfg: Config, private readonly content: ContentMode) {
    this.enabled = (cfg.auth || db.getSetting('auth_default', 'on')) === 'on'
    this.providers = new SignInProviders(cfg)
  }
  get unclaimed(): boolean { return !this.db.raw.prepare('SELECT 1 FROM identities WHERE user_id = 1').get() && !this.db.raw.prepare("SELECT 1 FROM settings WHERE key = 'owner_claim'").get() }
  user(id: number): User {
    const u = this.db.raw.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as User | undefined
    if (!u) throw new HttpError(404, 'User not found')
    return u
  }
  current(): User {
    const user = viewer()?.user
    if (!user) throw new HttpError(401, 'Sign in to Renplay')
    return user
  }
  /** Only an upgraded single-user installation may attribute pre-account browser saves. */
  get legacySaveOwner(): number | null {
    return this.db.getSetting<string>('auth_default', 'on') === 'off' ? 1 : null
  }
  store(id = this.current().id): SaveStore {
    this.user(id)
    let s = this.stores.get(id)
    if (!s) {
      const root = join(this.cfg.dataDir, 'users', String(id))
      s = new SaveStore(join(root, 'saves'), join(root, 'save-history'), this.cfg.saveHistoryVersions)
      s.pinned = (saveDir, rel) => !!this.db.raw.prepare("SELECT 1 FROM save_meta WHERE user_id = ? AND save_dir = ? AND file = ? AND pinned_at != ''").get(id, saveDir, rel)
      this.stores.set(id, s)
    }
    return s
  }
  async tag(u: User): Promise<void> {
    const root = join(this.cfg.dataDir, 'users', String(u.id))
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'user.json'), JSON.stringify({ id: u.id, name: u.name, created: u.created_at }) + '\n')
  }
  async init(): Promise<void> {
    // A process interrupted during copying keeps all saves and can retry after restart.
    this.db.raw.prepare("DELETE FROM settings WHERE key = 'owner_claim'").run()
    this.dummyPassword = await passwordHash(random())
    await this.providers.init()
    if (this.enabled && !this.cfg.authLocal && !this.cfg.oidcIssuer && !this.cfg.ldapUrl) throw new Error('No sign-in provider is enabled. Enable RENPLAY_AUTH_LOCAL or configure OIDC or LDAP.')
    if (this.enabled && !this.cfg.authLocal && !this.cfg.admins.length && !this.cfg.oidcAdminGroup && !this.cfg.ldapAdminFilter) throw new Error('SSO-only sign-in needs RENPLAY_ADMINS or an admin group or filter.')
    if (!!this.cfg.adminUsername !== !!this.cfg.adminPassword) throw new Error('Set both RENPLAY_ADMIN_USERNAME and RENPLAY_ADMIN_PASSWORD (or its _FILE variant)')
    if (this.unclaimed && this.cfg.adminUsername) await this.claim(this.cfg.adminUsername, this.cfg.adminUsername, this.cfg.adminPassword)
    if (this.enabled && this.cfg.authLocal && this.unclaimed) always('sign-in', `Setup code: ${this.setupCode}`)
    if (!this.enabled && this.user(this.cfg.authUser).disabled) throw new Error('RENPLAY_AUTH_USER is disabled')
    for (const u of this.db.raw.prepare('SELECT * FROM users').all() as unknown as User[]) await this.tag(u)
    for (const [legacy, target] of [[this.cfg.savesDir, this.store(1).root], [this.cfg.saveHistoryDir, this.store(1).historyRoot]]) {
      await mkdir(target!, { recursive: true })
      if (!await lstat(legacy!).catch(() => null)) { await mkdir(join(legacy!, '..'), { recursive: true }); await symlink(pathRelative(pathDirname(legacy!), target!), legacy!, 'dir') }
    }
  }
  /** Writes a person's ceiling and choice, and the 3.x columns a downgrade to 3.2 still reads. */
  private writeLevels(id: number, patch: { ceiling?: AdultLevel; choice?: AdultLevel }): void {
    const u = this.user(id)
    const ceiling = patch.ceiling ?? parseAdultLevel(u.adult_ceiling) ?? this.cfg.adultDefault
    const choice = patch.choice ?? parseAdultLevel(u.adult_choice) ?? this.cfg.adultDefault
    const mirror = legacyMirror(ceiling, choice, this.content.level)
    const prefs = { ...parseJson<Record<string, unknown>>(u.prefs, {}), adultPictures: mirror.adultPictures }
    this.db.raw.prepare('UPDATE users SET adult_ceiling = ?, adult_choice = ?, adult_access = ?, prefs = ? WHERE id = ?').run(ceiling, choice, mirror.adultAccess, JSON.stringify(prefs), id)
  }
  private invalidate(): void { this.sessionCache.clear() }
  private async claim(raw: unknown, display: unknown, password: unknown): Promise<void> {
    const login = username(raw), displayName = name(display), encoded = await passwordHash(password)
    if (!this.unclaimed) throw new HttpError(409, 'The owner account is already claimed')
    if (this.db.raw.prepare('SELECT 1 FROM users WHERE username = ? AND id != 1').get(login)) throw new HttpError(409, 'That username is taken')
    this.db.raw.exec('BEGIN IMMEDIATE')
    try {
      this.db.raw.prepare('UPDATE users SET username = ?, name = ? WHERE id = 1').run(login, displayName)
      this.writeLevels(1, { ceiling: 'shown', choice: 'shown' })
      this.db.raw.prepare("INSERT INTO identities VALUES ('local', ?, 1, ?)").run(login, encoded)
      this.db.raw.exec('COMMIT')
    } catch (e) { this.db.raw.exec('ROLLBACK'); throw e }
    await this.tag(this.user(1))
    this.setupGrant = ''; this.setupCode = ''
  }
  private limit(key: string): void {
    const now = Date.now()
    for (const [k, value] of this.limits) if (value.until <= now) this.limits.delete(k)
    const bucket = this.limits.get(key) ?? { count: 0, until: now + 60_000 }
    if (++bucket.count > 10) throw new HttpError(429, 'Too many tries. Wait a minute.')
    this.limits.set(key, bucket)
  }
  private secure(req: Request): boolean { return req.secure || this.cfg.publicUrl.startsWith('https://') }
  private cookie(req: Request, res: Response, value: string): void {
    res.cookie('renplay_session', value, { httpOnly: true, sameSite: 'lax', secure: this.secure(req), path: '/', maxAge: value ? DAYS30 : 0 })
  }
  private newSession(req: Request, res: Response, id: number): void {
    log('sign-in', `Signed in: ${this.user(id).username}`)
    const token = random(), now = Date.now()
    this.db.raw.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?)').run(hash(token), id, now, now, now + DAYS30, (req.get('user-agent') ?? '').slice(0, 200))
    this.cookie(req, res, token)
    this.db.raw.prepare('INSERT OR REPLACE INTO device_people VALUES (?, ?, ?)').run(this.device(req, res), id, now)
  }
  /**
   * This browser, for Who is playing: a cookie of its own that outlives sign-out, stored hashed.
   * Given a response, a browser without one gets one. Without, it is '' then.
   */
  private device(req: Request, res?: Response): string {
    let token = req.get('cookie')?.match(/(?:^|;\s*)renplay_device=([A-Za-z0-9_-]{40,64})(?:;|$)/)?.[1]
    if (!token) {
      if (!res) return ''
      token = random()
      res.cookie('renplay_device', token, { httpOnly: true, sameSite: 'lax', secure: this.secure(req), path: '/', maxAge: 400 * 86400_000 })
    }
    return hash(token)
  }
  private session(key: string): Viewer | null {
    const now = Date.now()
    let cached = this.sessionCache.get(key)
    if (!cached || now - cached.checked > 5000) {
      const s = this.db.raw.prepare('SELECT * FROM sessions WHERE hash = ?').get(key) as { user_id: number; expires_at: number; touched_at: number } | undefined
      if (!s || s.expires_at <= now) { this.sessionCache.delete(key); return null }
      cached = { id: s.user_id, expires: s.expires_at, touched: s.touched_at, checked: now }
      if (this.sessionCache.size > 10000) this.sessionCache.clear()
      this.sessionCache.set(key, cached)
    }
    if (cached.expires <= now) return null
    const u = this.user(cached.id)
    if (u.disabled) return null
    if (now - cached.touched >= 300_000) {
      this.db.raw.prepare('UPDATE sessions SET touched_at = ?, expires_at = ? WHERE hash = ?').run(now, now + DAYS30, key)
      cached.touched = now; cached.expires = now + DAYS30
    }
    return { user: u, session: key, bearer: false }
  }
  private requireLiveLink(user: number, session: string, bearer = false): void {
    const row = bearer
      ? this.db.raw.prepare('SELECT user_id FROM tokens WHERE hash = ?').get(session)
      : this.db.raw.prepare('SELECT user_id FROM sessions WHERE hash = ? AND expires_at > ?').get(session, Date.now())
    const liveUser = this.db.raw.prepare('SELECT disabled FROM users WHERE id = ?').get(user)
    if (!this.enabled || !row || row.user_id !== user || !liveUser || liveUser.disabled) throw new HttpError(401, 'Sign in to the same account before linking')
  }
  private authenticate(req: Request, res: Response): Viewer | null {
    if (!this.enabled) return { user: this.user(this.cfg.authUser), session: `off-${this.cfg.authUser}`, bearer: false }
    const bearer = req.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]
    if (bearer) {
      const row = this.db.raw.prepare('SELECT user_id FROM tokens WHERE hash = ?').get(hash(bearer)) as { user_id: number } | undefined
      if (!row) return null
      const u = this.user(row.user_id)
      return u.disabled ? null : { user: u, session: hash(bearer), bearer: true }
    }
    const token = req.get('cookie')?.match(/(?:^|;\s*)renplay_session=([^;]+)/)?.[1]
    if (!token) return null
    const found = this.session(hash(token))
    if (found) this.cookie(req, res, token)
    return found
  }
  /** Cookie authentication does not constrain body type: raw, multipart and empty deletes work. */
  csrf(req: Request): void {
    if (!this.enabled || ['GET', 'HEAD', 'OPTIONS'].includes(req.method) || viewer()?.bearer) return
    const site = req.get('sec-fetch-site')
    if (site === 'same-origin' || site === 'none') return
    const origin = req.get('origin')
    if (site !== 'cross-site' && origin && [this.cfg.publicUrl && new URL(this.cfg.publicUrl).origin, `${req.protocol}://${req.get('host')}`].includes(origin)) return
    throw new HttpError(403, 'This request must come from this Renplay')
  }
  readonly middleware: express.RequestHandler = (req, res, next) => {
    if (req.path === '/api/health' || req.path === '/api/keepalive' || req.path.startsWith('/engine/') || req.path === '/renplay/runtime.js') return next()
    if (!req.path.startsWith('/api/') && !req.path.startsWith('/g/')) return next()
    res.setHeader('Cache-Control', 'private, no-store')
    // Sandboxed HTML assets have no cookies. Their capability resolves to a live session.
    const signed = req.path.match(/^\/g\/([^/]+)\/([^/]+)\/s\/([^/]+)\/game\//)
    let v: Viewer | null
    if (signed) {
      v = this.verifyAsset(signed[3]!, signed[1]!, signed[2]!)
      res.locals.verifiedAsset = !!v
      req.url = req.url.replace(`/s/${signed[3]}/game/`, '/game/')
    } else v = this.authenticate(req, res)
    if (req.path.startsWith('/api/auth/') && req.path !== '/api/auth/check') {
      const proceed = () => { try { this.csrf(req); next() } catch (e) { next(e) } }
      return v ? viewers.run(v, proceed) : proceed()
    }
    if (!v) return next(new HttpError(401, 'Sign in to Renplay'))
    // This device's level: a header on API calls, a query on the game page. It can only narrow.
    const device = parseAdultLevel(req.get('x-renplay-adult')) ?? parseAdultLevel(typeof req.query['adult'] === 'string' ? req.query['adult'] : undefined)
    if (device === 'off' || device === 'blurred') v = { ...v, device }
    viewers.run(v, () => {
      try {
        this.csrf(req)
        const runtimeUser = req.get('x-renplay-user')
        if (runtimeUser !== undefined && runtimeUser !== String(v.user.id)) throw new HttpError(401, 'You were signed out')
        if (req.path !== '/api/auth/check' && v.user.role !== 'admin' && !playerRoute(req.method, req.path)) throw new HttpError(403, 'Only an admin can do this')
        next()
      } catch (e) { next(e) }
    })
  }
  assetUrl(game: GameRow): string {
    const v = viewer()
    if (!v) throw new HttpError(401, 'Sign in to Renplay')
    const signature = createHmac('sha256', this.signingKey).update(`${v.session}\n${game.id}\n${game.build}`).digest('base64url')
    return `/g/${game.id}/${game.build}/s/${v.session}.${signature}/game/${game.entry.split('/').map(encodeURIComponent).join('/')}`
  }
  private verifyAsset(token: string, game: string, build: string): Viewer | null {
    const [session, signature] = token.split('.')
    if (!session || !signature) return null
    const expected = createHmac('sha256', this.signingKey).update(`${session}\n${game}\n${build}`).digest('base64url')
    if (!equal(expected, signature)) return null
    if (!this.enabled) return session === `off-${this.cfg.authUser}` ? { user: this.user(this.cfg.authUser), session, bearer: false } : null
    const tokenUser = this.db.raw.prepare('SELECT user_id FROM tokens WHERE hash = ?').get(session) as { user_id: number } | undefined
    if (tokenUser) { const user = this.user(tokenUser.user_id); return user.disabled ? null : { user, session, bearer: true } }
    return this.session(session)
  }
  progress(row: GameRow): GameRow {
    const u = this.db.raw.prepare('SELECT favorite_at, finished_at, last_played_at, play_time, play_status, rating, not_now_at FROM user_games WHERE user_id = ? AND game = ?').get(this.current().id, row.id)
    return { ...row, favorite_at: '', finished_at: '', last_played_at: '', play_time: 0, play_status: '', rating: 0, not_now_at: '', ...u }
  }
  setProgress(game: string, patch: Partial<Pick<GameRow, 'favorite_at' | 'finished_at' | 'last_played_at' | 'play_time' | 'play_status' | 'rating' | 'not_now_at'>>): void {
    const id = this.current().id
    this.db.raw.prepare('INSERT OR IGNORE INTO user_games (user_id, game) VALUES (?, ?)').run(id, game)
    for (const [key, value] of Object.entries(patch)) this.db.raw.prepare(`UPDATE user_games SET ${key} = ? WHERE user_id = ? AND game = ?`).run(value, id, game)
    if (patch.last_played_at) this.db.raw.prepare('UPDATE games SET last_played_at = MAX(last_played_at, ?) WHERE id = ?').run(patch.last_played_at, game)
  }
  private guardLastAdmin(target: User, patch: { role?: string; disabled?: boolean }, removing = false): void {
    if (target.role !== 'admin' || target.disabled || (!removing && patch.role !== 'player' && patch.disabled !== true)) return
    const { n } = this.db.raw.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }
    if (n <= 1) throw new HttpError(409, 'Keep at least one enabled admin')
  }
  /**
   * Signs a person out everywhere but `except`. Their PIN goes too, and other browsers forget them,
   * so whoever held a session or a token cannot come back with a PIN they set.
   */
  private revoke(id: number, except = '', keepDevice = ''): void {
    this.db.raw.prepare('DELETE FROM sessions WHERE user_id = ? AND hash != ?').run(id, except)
    this.db.raw.prepare("UPDATE users SET pin_hash = '', pin_failures = 0, pin_locked_until = 0 WHERE id = ?").run(id)
    this.db.raw.prepare('DELETE FROM device_people WHERE user_id = ? AND device != ?').run(id, keepDevice)
    this.invalidate()
  }
  /**
   * Copies saves between accounts. `visibleOnly` is for the admin's copy action, which copies what
   * the admin may see. Merging and claiming the owner account move every save, always.
   */
  private async copy(from: number, to: number, game?: string, visibleOnly = false): Promise<number> {
    if (from === to) throw new HttpError(400, 'Choose two different users')
    this.user(from); this.user(to)
    const source = this.store(from), target = this.store(to)
    let dirs: string[]
    if (game) {
      const g = this.db.getGame(game)
      if (!g?.save_dir || (visibleOnly && this.content.hides(g))) throw new HttpError(404, 'Game save folder not found')
      dirs = [g.save_dir, 'tokens']
    } else {
      const all = await source.listDirs()
      dirs = [...(visibleOnly ? this.content.visibleSaveDirs(all) : all), ...SHARED_DIRS]
    }
    let copied = 0
    for (const dir of dirs) for (const file of await source.list(dir)) {
      const data = await source.read(dir, file.name)
      if (dir === 'tokens' && file.name === 'security_keys.txt') await target.mergeSecurityKeys(data.toString('utf-8'))
      // A copy lands as copied. What it replaces stays in History for at least 30 days.
      else await target.write(dir, file.name, data, { reason: 'user-copy', mtimeMs: file.mtimeMs })
      copied++
    }
    return copied
  }
  private mergeProgress(from: number, to: number): void {
    this.db.raw.prepare(`INSERT INTO user_games (user_id, game, favorite_at, finished_at, last_played_at, play_time, play_status, rating, not_now_at)
      SELECT ?, game, favorite_at, finished_at, last_played_at, play_time, play_status, rating, not_now_at FROM user_games WHERE user_id = ?
      ON CONFLICT(user_id, game) DO UPDATE SET favorite_at = MAX(user_games.favorite_at, excluded.favorite_at), finished_at = MAX(user_games.finished_at, excluded.finished_at), last_played_at = MAX(user_games.last_played_at, excluded.last_played_at), play_time = MAX(user_games.play_time, excluded.play_time),
        play_status = CASE WHEN user_games.play_status = '' THEN excluded.play_status ELSE user_games.play_status END, rating = MAX(user_games.rating, excluded.rating), not_now_at = MAX(user_games.not_now_at, excluded.not_now_at)`).run(to, from)
    // Finished stays in step with finished_at: a game either account finished is finished.
    this.db.raw.prepare("UPDATE user_games SET play_status = 'finished' WHERE user_id = ? AND finished_at IS NOT NULL AND finished_at != '' AND play_status != 'finished'").run(to)
    this.db.raw.prepare("UPDATE user_games SET finished_at = ? WHERE user_id = ? AND play_status = 'finished' AND (finished_at IS NULL OR finished_at = '')").run(new Date().toISOString(), to)
    // The play history moves with the person, and their names, notes and pins of saves where the
    // other person has none for the same file.
    this.db.raw.prepare('UPDATE play_sessions SET user_id = ? WHERE user_id = ?').run(to, from)
    this.db.raw.prepare('INSERT OR IGNORE INTO save_meta (user_id, save_dir, file, title, note, pinned_at) SELECT ?, save_dir, file, title, note, pinned_at FROM save_meta WHERE user_id = ?').run(to, from)
    // Their art choices and uploads too, where the other person has none for the same game and format.
    this.db.raw.prepare('INSERT OR IGNORE INTO art_uploads (id, game, kind, scope, width, height, focal, thumbhash, tint, created_at) SELECT id, game, kind, ?, width, height, focal, thumbhash, tint, created_at FROM art_uploads WHERE scope = ?').run(to, from)
    this.db.raw.prepare('INSERT OR IGNORE INTO art_choices (game, kind, scope, candidate) SELECT game, kind, ?, candidate FROM art_choices WHERE scope = ?').run(to, from)
  }

  /**
   * Records played seconds as a session (one that ended in the last ten minutes goes on, else a new
   * one starts) and returns the seconds counted.
   */
  addPlayTime(game: string, seconds: number, now = Date.now()): number {
    const id = this.current().id
    const last = this.db.raw.prepare('SELECT id, ended_at FROM play_sessions WHERE user_id = ? AND game = ? AND ended_at >= ? ORDER BY ended_at DESC LIMIT 1').get(id, game, now - 10 * 60_000) as { id: number; ended_at: number } | undefined
    // A session grows by at most the time that passed since its last report (and a little slack), so
    // two open windows or a repeated report never count more time than there was.
    if (last) {
      const counted = Math.max(0, Math.min(seconds, Math.ceil((now - last.ended_at) / 1000) + 5))
      this.db.raw.prepare('UPDATE play_sessions SET ended_at = ?, seconds = seconds + ? WHERE id = ?').run(now, counted, last.id)
      return counted
    }
    this.db.raw.prepare('INSERT INTO play_sessions (user_id, game, started_at, ended_at, seconds) VALUES (?, ?, ?, ?, ?)').run(id, game, now - seconds * 1000, now, seconds)
    return seconds
  }
  private managed(id: number) {
    const identities = this.db.raw.prepare('SELECT provider FROM identities WHERE user_id = ?').all(id)
    const oidc = identities.some(i => i.provider === this.providers.oidcProvider), ldap = identities.some(i => i.provider === this.providers.ldapProvider)
    const u = this.user(id)
    return { roleManaged: !(u.role === 'admin' && u.admin_source === 'manual') && !!(oidc && this.cfg.oidcAdminGroup || ldap && this.cfg.ldapAdminFilter), adultManaged: !!(oidc && this.cfg.oidcAdultGroups || ldap && (this.cfg.ldapAdultGroups || this.cfg.ldapAdultFilter)) }
  }
  private methodAvailable(id: number, provider: string, subject: string, removingLocal = ''): boolean {
    if (provider === 'local') return this.cfg.authLocal
    if (provider === this.providers.oidcProvider) return !!this.cfg.oidcIssuer
    if (provider !== this.providers.ldapProvider || !this.cfg.ldapUrl) return false
    const metadata = this.db.raw.prepare('SELECT username FROM identity_metadata WHERE provider = ? AND subject = ?').get(provider, subject)
    if (!metadata) return false
    const login = String(metadata.username).toLowerCase().slice(0, 64)
    const local = this.db.raw.prepare("SELECT user_id FROM identities WHERE provider = 'local' AND subject = ?").get(login)
    return login === removingLocal || !local || !this.cfg.authLocal && local.user_id === id
  }
  private async external(identity: ExternalIdentity, linking?: { user: number; session: string; bearer?: boolean }): Promise<number> {
    const existing = this.db.raw.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').get(identity.provider, identity.subject) as { user_id: number } | undefined
    if (linking && existing && existing.user_id !== linking.user) throw new HttpError(409, 'That sign-in belongs to another account. Accounts are never merged automatically.')
    if (existing && this.user(existing.user_id).disabled) throw new HttpError(403, 'This account is disabled')
    if (!existing && !linking && identity.provider === this.providers.oidcProvider && !this.cfg.oidcAutoCreate) throw new HttpError(403, 'Ask an admin to link this sign-in to an account first')
    let id = linking?.user ?? existing?.user_id
    const newOwner = id === undefined && identity.admin && this.unclaimed
    this.db.raw.exec('BEGIN IMMEDIATE')
    try {
      if (newOwner) {
        id = 1
        const ownerLogin = this.db.raw.prepare('SELECT 1 FROM users WHERE username = ? AND id != 1').get(identity.username) ? `sso-${signInRandom().slice(0, 12)}` : identity.username.slice(0, 64)
        this.db.raw.prepare('UPDATE users SET username = ?, name = ? WHERE id = 1').run(ownerLogin, identity.name.slice(0, 100))
        this.writeLevels(1, { ceiling: 'shown', choice: 'shown' })
      } else if (id === undefined) {
        // Display names and emails are never used to match or merge accounts.
        const login = identity.username.toLowerCase().replace(/[^a-z0-9._-]/g, '-').slice(0, 48) || 'player'
        const unique = this.db.raw.prepare('SELECT 1 FROM users WHERE username = ?').get(login) ? `${login}-${signInRandom().slice(0, 8)}` : login
        id = Number(this.db.raw.prepare('INSERT INTO users (username, name, role, created_at) VALUES (?, ?, ?, ?)').run(unique, identity.name.slice(0, 100), identity.admin ? 'admin' : 'player', new Date().toISOString()).lastInsertRowid)
        // The sign-in group's level, or the starting level for new people (the first admin starts at shown).
        const ceiling = identity.ceiling ?? (identity.admin ? 'shown' : this.cfg.adultDefault)
        this.writeLevels(id, { ceiling, choice: ceiling })
      }
      if (linking) this.requireLiveLink(linking.user, linking.session, linking.bearer)
      if (!existing) this.db.raw.prepare('INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)').run(identity.provider, identity.subject, id!)
      this.db.raw.prepare('INSERT INTO identity_metadata VALUES (?, ?, ?) ON CONFLICT(provider, subject) DO UPDATE SET username = excluded.username').run(identity.provider, identity.subject, identity.username)
      const u = this.user(id!)
      const manuallyAssigned = !newOwner && (linking !== undefined || existing !== undefined) && u.role === 'admin' && u.admin_source === 'manual'
      const sameGrant = u.admin_provider === identity.provider && u.admin_subject === identity.subject
      if (!manuallyAssigned && (identity.roleManaged || identity.admin || sameGrant)) {
        if (u.role === 'admin' && !identity.admin && !u.disabled) {
          const { n } = this.db.raw.prepare("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }
          if (n <= 1) console.warn(`sign-in: Last enabled admin ${id!} lost the sign-in provider admin grant. Restore provider group membership or configure RENPLAY_ADMINS without an admin group or filter to recover access.`)
        }
        this.db.raw.prepare('UPDATE users SET role = ?, admin_source = ?, admin_provider = ?, admin_subject = ? WHERE id = ?').run(identity.admin ? 'admin' : 'player', identity.roleManaged ? 'provider' : 'allowlist', identity.provider, identity.subject, id!)
      }
      // A configured sign-in group replaces the hand setting and is recomputed at each sign-in.
      if (identity.adultManaged) this.writeLevels(id!, { ceiling: identity.ceiling! })
      if (u.disabled) throw new HttpError(403, 'This account is disabled')
      this.db.raw.exec('COMMIT')
    } catch (e) { this.db.raw.exec('ROLLBACK'); throw e }
    if (identity.picture && !this.user(id!).avatar_uploaded) {
      try {
        const picture = typeof identity.picture === 'string' ? await fetchAvatar(identity.picture) : identity.picture
        const avatar = await storeAvatar(this.cfg.dataDir, picture)
        this.db.raw.prepare('UPDATE users SET avatar = ? WHERE id = ? AND avatar_uploaded = 0').run(avatar, id!)
      } catch { /* An unavailable provider picture must not prevent sign-in. */ }
    }
    this.invalidate(); await this.tag(this.user(id!))
    return id!
  }
  private beginOidc(req: Request, res: Response, linking = false): string {
    if (!this.enabled || !this.cfg.oidcIssuer) throw new HttpError(403, 'Single sign-on is off')
    this.limit(`oidc:${req.ip}`)
    for (const [key, flow] of this.oidcFlows) if (flow.expires < Date.now()) this.oidcFlows.delete(key)
    if (this.oidcFlows.size >= 10000) throw new HttpError(429, 'Too many sign-in attempts')
    const state = signInRandom(), nonce = signInRandom(), verifier = signInRandom()
    this.oidcFlows.set(hash(state), { nonce, verifier, expires: Date.now() + 600000, ...(linking ? { session: viewer()!.session, user: this.current().id, bearer: viewer()!.bearer } : {}) })
    res.cookie('renplay_oidc', state, { httpOnly: true, sameSite: 'lax', secure: this.secure(req), path: '/api/auth/oidc', maxAge: 600000 })
    return this.providers.authorization(state, nonce, verifier)
  }
  router(): Router {
    const r = Router({ caseSensitive: true, strict: true })
    r.get('/auth/providers', (_req, res) => res.json({ enabled: this.enabled, setup: this.enabled && this.cfg.authLocal && this.unclaimed, local: this.cfg.authLocal || !!this.cfg.ldapUrl, oidc: this.cfg.oidcIssuer ? this.cfg.oidcName : null, ldap: !!this.cfg.ldapUrl }))
    r.get('/auth/oidc/start', (req, res) => res.redirect(this.beginOidc(req, res)))
    r.get('/auth/oidc/callback', async (req, res) => {
      if (!this.enabled || !this.cfg.oidcIssuer) throw new HttpError(403, 'Single sign-on is off')
      const state = typeof req.query.state === 'string' ? req.query.state : ''
      const cookie = req.get('cookie')?.match(/(?:^|;\s*)renplay_oidc=([^;]+)/)?.[1]
      const flow = this.oidcFlows.get(hash(state))
      this.oidcFlows.delete(hash(state))
      res.clearCookie('renplay_oidc', { path: '/api/auth/oidc' })
      if (!state || cookie !== state || !flow || flow.expires < Date.now() || typeof req.query.code !== 'string') throw new HttpError(401, 'This sign-in request expired or does not match. Try again.')
      if (flow.user && (viewer()?.session !== flow.session || this.current().id !== flow.user)) throw new HttpError(401, 'Sign in to the same account before linking')
      let identity: ExternalIdentity
      try { identity = await this.providers.oidc(req.query.code, flow.nonce, flow.verifier) } catch { throw new HttpError(401, 'Single sign-on failed. Try again.') }
      const id = await this.external(identity, flow.user ? { user: flow.user, session: flow.session!, bearer: flow.bearer } : undefined)
      if (!flow.user) this.newSession(req, res, id)
      res.redirect(flow.user ? '/account' : '/')
    })
    r.post('/me/identities/oidc', (req, res) => res.json({ url: this.beginOidc(req, res, true) }))
    r.post('/me/identities/ldap', async (req, res) => {
      if (!this.cfg.ldapUrl) throw new HttpError(403, 'LDAP is off')
      this.limit(`ip:${req.ip}`)
      this.limit(`ldap:${String(req.body?.username).toLowerCase()}`)
      const initiating = viewer()!
      const identity = await this.providers.ldap(req.body?.username, req.body?.password)
      await this.external(identity, { user: initiating.user.id, session: initiating.session, bearer: initiating.bearer })
      res.json({ ok: true })
    })
    r.get('/me/identities', (_req, res) => {
      const id = this.current().id, methods = this.db.raw.prepare('SELECT provider, subject FROM identities WHERE user_id = ?').all(id)
      res.json({ identities: methods.map(i => ({ ...i, name: i.provider === 'local' ? 'Password' : String(i.provider).startsWith('oidc:') ? this.cfg.oidcName : 'LDAP', available: this.methodAvailable(id, String(i.provider), String(i.subject)), removable: methods.some(other => (other.provider !== i.provider || other.subject !== i.subject) && this.methodAvailable(id, String(other.provider), String(other.subject), i.provider === 'local' ? String(i.subject) : '')) })) })
    })
    r.delete('/me/identities', (req, res) => {
      const id = this.current().id, provider = req.body?.provider, subject = req.body?.subject
      const methods = this.db.raw.prepare('SELECT provider, subject FROM identities WHERE user_id = ?').all(id)
      if (typeof provider !== 'string' || typeof subject !== 'string' || !methods.some(i => i.provider === provider && i.subject === subject)) throw new HttpError(404, 'Linked sign-in not found')
      const remaining = methods.filter(i => i.provider !== provider || i.subject !== subject).filter(i => this.methodAvailable(id, String(i.provider), String(i.subject), provider === 'local' ? subject : ''))
      if (!remaining.length) throw new HttpError(409, 'Keep at least one enabled way to sign in')
      const u = this.user(id)
      const roleManaged = u.admin_source !== 'manual' && u.admin_provider === provider && u.admin_subject === subject
      const adultManaged = provider === this.providers.oidcProvider && !!this.cfg.oidcAdultGroups || provider === this.providers.ldapProvider && !!(this.cfg.ldapAdultGroups || this.cfg.ldapAdultFilter)
      if (roleManaged) { this.guardLastAdmin(u, { role: 'player' }); this.db.raw.prepare("UPDATE users SET role = 'player', admin_source = 'manual', admin_provider = '', admin_subject = '' WHERE id = ?").run(id) }
      if (adultManaged) this.writeLevels(id, { ceiling: 'off' })
      this.db.raw.prepare('DELETE FROM identities WHERE user_id = ? AND provider = ? AND subject = ?').run(id, provider, subject)
      this.db.raw.prepare('DELETE FROM identity_metadata WHERE provider = ? AND subject = ?').run(provider, subject)
      this.revoke(id, viewer()!.session, this.device(req)); res.json({ ok: true })
    })
    r.post('/me/avatar', express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '2mb' }), async (req, res) => {
      if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'Upload a JPEG, PNG or WebP picture')
      const avatar = await storeAvatar(this.cfg.dataDir, req.body)
      this.db.raw.prepare('UPDATE users SET avatar = ?, avatar_uploaded = 1 WHERE id = ?').run(avatar, this.current().id)
      res.json({ avatar })
    })
    r.get('/avatars/:file', (req, res) => {
      if (!/^[a-f0-9]{64}\.webp$/.test(req.params.file)) throw new HttpError(404, 'Picture not found')
      res.sendFile(join(this.cfg.dataDir, 'avatars', req.params.file))
    })
    r.post('/auth/setup/verify', (req, res) => {
      if (!this.enabled || !this.cfg.authLocal || !this.unclaimed) throw new HttpError(409, 'Setup is complete')
      if (this.attempts <= 0) throw new HttpError(429, 'Restart Renplay to get a new setup code')
      this.attempts--
      if (typeof req.body?.code !== 'string' || !equal(req.body.code, this.setupCode)) throw new HttpError(403, 'That setup code is wrong')
      this.setupGrant ||= random()
      res.json({ grant: this.setupGrant })
    })
    r.post('/auth/setup', async (req, res) => {
      if (!this.enabled || !this.setupGrant || typeof req.body?.grant !== 'string' || !equal(this.setupGrant, req.body.grant)) throw new HttpError(403, 'Enter the setup code first')
      await this.claim(req.body.username, req.body.name || req.body.username, req.body.password)
      this.newSession(req, res, 1)
      res.json({ ok: true })
    })
    r.post('/auth/login', async (req, res) => {
      if (!this.enabled || !this.cfg.authLocal && !this.cfg.ldapUrl) throw new HttpError(403, 'Password sign-in is off')
      this.limit(`ip:${req.ip}`)
      const login = typeof req.body?.username === 'string' ? req.body.username.toLowerCase().slice(0, 64) : ''
      this.limit(`user:${login}`)
      const row = this.db.raw.prepare("SELECT user_id, password FROM identities WHERE provider = 'local' AND subject = ?").get(login) as { user_id: number; password: string } | undefined
      // With local sign-in off, a reserved name can use only its explicitly linked LDAP identity.
      if ((!row || !this.cfg.authLocal) && this.cfg.ldapUrl) {
        const identity = await this.providers.ldap(req.body?.username, req.body?.password)
        if (row) {
          const linked = this.db.raw.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').get(identity.provider, identity.subject)
          if (linked?.user_id !== row.user_id) throw new HttpError(401, 'The username or password is wrong')
        }
        const id = await this.external(identity)
        this.newSession(req, res, id); res.json({ ok: true }); return
      }
      const valid = this.cfg.authLocal && await passwordMatches(req.body?.password, row?.password ?? this.dummyPassword)
      if (!valid || !row || this.user(row.user_id).disabled) throw new HttpError(401, 'The username or password is wrong')
      if (!row.password.startsWith(PASSWORD_PREFIX)) {
        const upgraded = await passwordHash(req.body.password)
        // A concurrent password reset must not be undone by this upgrade.
        const result = this.db.raw.prepare("UPDATE identities SET password = ? WHERE provider = 'local' AND subject = ? AND password = ?").run(upgraded, login, row.password)
        if (!result.changes) throw new HttpError(401, 'The username or password is wrong')
      } else if (this.db.raw.prepare("SELECT password FROM identities WHERE provider = 'local' AND subject = ?").get(login)?.password !== row.password) {
        throw new HttpError(401, 'The username or password is wrong')
      }
      if (this.user(row.user_id).disabled) throw new HttpError(401, 'The username or password is wrong')
      this.newSession(req, res, row.user_id)
      res.json({ ok: true })
    })
    // ---- PINs: switching to a person on a device that is already signed in ------------------

    /** Sets (4 to 8 digits) or clears this person's PIN. Admins always use their full sign-in. */
    r.put('/me/pin', async (req, res) => {
      const u = this.current()
      if (!this.enabled) throw new HttpError(409, 'Sign-in is off, so there is no one to switch between')
      if (viewer()?.bearer) throw new HttpError(403, 'Set your PIN in the browser')
      const pin = req.body?.pin
      if (pin === '' || pin === null) {
        this.db.raw.prepare("UPDATE users SET pin_hash = '', pin_failures = 0, pin_locked_until = 0 WHERE id = ?").run(u.id)
        res.json({ hasPin: false })
        return
      }
      if (u.role === 'admin') throw new HttpError(409, 'Admins switch in with their full sign-in, so an admin account has no PIN')
      if (typeof pin !== 'string' || !/^\d{4,8}$/.test(pin)) throw new HttpError(400, 'A PIN has 4 to 8 digits')
      const salt = randomBytes(16).toString('hex')
      const encoded = `${PASSWORD_PREFIX}${salt}$${(await scrypt(pin, salt, 131072)).toString('hex')}`
      this.db.raw.prepare('UPDATE users SET pin_hash = ?, pin_failures = 0, pin_locked_until = 0 WHERE id = ?').run(encoded, u.id)
      res.json({ hasPin: true })
    })

    /** The people this browser may switch to: those who signed in on it before and have a PIN. */
    r.get('/auth/switch', (req, res) => {
      const me = this.current()
      const device = this.enabled && !viewer()?.bearer ? this.device(req) : ''
      const people = device
        ? this.db.raw.prepare("SELECT u.id, u.name, u.avatar FROM device_people d JOIN users u ON u.id = d.user_id WHERE d.device = ? AND u.id != ? AND u.disabled = 0 AND u.role != 'admin' AND u.pin_hash != '' ORDER BY d.seen_at DESC LIMIT 20").all(device, me.id)
        : []
      res.json({ people })
    })

    /**
     * Switches this device to another person by their PIN, ending the current session. Five wrong
     * PINs lock switching to that person for 15 minutes.
     */
    r.post('/auth/switch', async (req, res) => {
      this.current()
      if (!this.enabled) throw new HttpError(409, 'Sign-in is off, so there is no one to switch between')
      if (viewer()?.bearer) throw new HttpError(403, 'Switch people in the browser')
      this.limit(`ip:${req.ip}`)
      const id = Number(req.body?.user), pin = String(req.body?.pin ?? ''), device = this.device(req)
      const target = Number.isInteger(id) && device
        ? (this.db.raw.prepare('SELECT u.* FROM users u JOIN device_people d ON d.user_id = u.id WHERE u.id = ? AND d.device = ?').get(id, device) as unknown as User | undefined)
        : undefined
      // Anyone who cannot be switched to here gets the same answer after the same wait, so it says
      // nothing about who exists or has a PIN.
      if (!target || target.disabled || target.role === 'admin' || !target.pin_hash) {
        await passwordMatches(pin, this.dummyPassword)
        throw new HttpError(403, 'That PIN is not right')
      }
      const now = Date.now()
      if (target.pin_locked_until > now) throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil((target.pin_locked_until - now) / 60_000)} minutes.`)
      // Each try counts before its PIN is checked (nothing runs in between), so tries sent at the
      // same time cannot get past the limit. The right PIN clears the count.
      const failures = target.pin_failures + 1, locked = failures >= 5
      this.db.raw.prepare('UPDATE users SET pin_failures = ?, pin_locked_until = ? WHERE id = ?').run(locked ? 0 : failures, locked ? now + 15 * 60_000 : 0, target.id)
      if (!(await passwordMatches(pin, target.pin_hash))) throw new HttpError(locked ? 429 : 403, locked ? 'Too many wrong PINs. Try again in 15 minutes.' : 'That PIN is not right')
      this.db.raw.prepare('UPDATE users SET pin_failures = 0, pin_locked_until = 0 WHERE id = ?').run(target.id)
      // The person who was here is signed out on this device: back again takes their PIN or sign-in.
      if (viewer()?.session) this.db.raw.prepare('DELETE FROM sessions WHERE hash = ?').run(viewer()!.session)
      this.invalidate()
      this.newSession(req, res, target.id)
      res.json({ ok: true, user: publicUser(this.user(target.id)) })
    })

    r.post('/auth/logout', (req, res) => {
      if (viewer()?.session) this.db.raw.prepare('DELETE FROM sessions WHERE hash = ?').run(viewer()!.session)
      this.invalidate(); this.cookie(req, res, '')
      res.json({ ok: true })
    })
    r.get('/me', (_req, res) => res.json({ user: publicUser(this.current()), auth: this.enabled, unclaimed: this.unclaimed, hasPassword: !!this.db.raw.prepare("SELECT 1 FROM identities WHERE user_id = ? AND provider = 'local'").get(this.current().id) }))
    r.put('/me', async (req, res) => {
      this.db.raw.prepare('UPDATE users SET name = ? WHERE id = ?').run(name(req.body?.name), this.current().id)
      await this.tag(this.user(this.current().id)); res.json({ ok: true })
    })
    r.post('/me/password', async (req, res) => {
      const u = this.current()
      const identity = this.db.raw.prepare("SELECT password FROM identities WHERE provider = 'local' AND user_id = ?").get(u.id) as { password: string } | undefined
      if (!identity || !await passwordMatches(req.body?.current, identity.password)) throw new HttpError(403, 'The current password is wrong')
      const encoded = await passwordHash(req.body?.password)
      this.db.raw.prepare("UPDATE identities SET password = ? WHERE provider = 'local' AND user_id = ?").run(encoded, u.id)
      this.revoke(u.id, viewer()!.session, this.device(req)); res.json({ ok: true })
    })
    // Tag preferences: the tags this person includes and leaves out on the Catalog page, kept with
    // their account so every device shows the same catalog.
    r.get('/me/tags', (_req, res) => {
      const tags = parseJson<{ tags?: { include?: string[]; exclude?: string[] } }>(this.current().prefs, {}).tags
      // Until a person chooses, the admin's default for everyone.
      if (!tags) {
        const d = readDefaults(this.db)
        res.json({ include: [], exclude: d.tagsExclude, source: d.tagsExclude.length ? 'admin' : 'default' })
        return
      }
      res.json({ include: tags.include ?? [], exclude: tags.exclude ?? [], source: 'you' })
    })
    r.put('/me/tags', (req, res) => {
      const list = (v: unknown): string[] => {
        if (!Array.isArray(v) || v.length > 60 || v.some((t) => typeof t !== 'string' || !/^[a-z0-9-]{1,40}$/.test(t))) throw new HttpError(400, 'Tags are lists of tag ids')
        return [...new Set(v as string[])]
      }
      const include = list(req.body?.include ?? [])
      const exclude = list(req.body?.exclude ?? []).filter((t) => !include.includes(t))
      const u = this.current()
      const prefs = { ...parseJson<Record<string, unknown>>(u.prefs, {}), tags: { include, exclude } }
      this.db.raw.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(prefs), u.id)
      res.json({ include, exclude, source: 'you' })
    })
    r.get('/me/adult', (_req, res) => {
      const u = this.current()
      const ceiling = parseAdultLevel(u.adult_ceiling) ?? this.cfg.adultDefault
      const choice = parseAdultLevel(u.adult_choice) ?? this.cfg.adultDefault
      res.json({
        installation: { level: this.content.level, fixed: this.content.locked, chosen: this.content.chosen },
        ceiling: { level: ceiling, managed: this.managed(u.id).adultManaged ? 'group' : null },
        choice,
        effective: lowestLevel(this.content.level, ceiling, choice),
      })
    })
    r.put('/me/adult', (req, res) => {
      const level = parseAdultLevel(req.body?.level)
      if (!level) throw new HttpError(400, 'Choose Off, Blurred or Shown')
      const u = this.current()
      const ceiling = parseAdultLevel(u.adult_ceiling) ?? this.cfg.adultDefault
      if (lowestLevel(level, ceiling) !== level) throw new HttpError(409, `Your account allows at most ${ceiling}`)
      this.writeLevels(u.id, { choice: level })
      res.json({ ok: true, choice: level })
    })
    r.get('/me/sessions', (_req, res) => res.json({ sessions: this.db.raw.prepare('SELECT hash AS id, created_at, touched_at, expires_at, label FROM sessions WHERE user_id = ? AND expires_at > ?').all(this.current().id, Date.now()).map((s) => ({ ...s, current: s.id === viewer()?.session })) }))
    r.delete('/me/sessions', (req, res) => { this.revoke(this.current().id, viewer()!.session, this.device(req)); res.json({ ok: true }) })
    r.delete('/me/sessions/:id', (req, res) => { this.db.raw.prepare('DELETE FROM sessions WHERE user_id = ? AND hash = ?').run(this.current().id, req.params.id); this.invalidate(); res.json({ ok: true }) })
    r.get('/me/tokens', (_req, res) => res.json({ tokens: this.db.raw.prepare('SELECT id, name, created_at FROM tokens WHERE user_id = ?').all(this.current().id) }))
    r.post('/me/tokens', (req, res) => {
      const token = random(), id = randomBytes(12).toString('hex')
      this.db.raw.prepare('INSERT INTO tokens VALUES (?, ?, ?, ?, ?)').run(hash(token), id, this.current().id, name(req.body?.name), Date.now())
      res.json({ id, token })
    })
    r.delete('/me/tokens/:id', (req, res) => { this.db.raw.prepare('DELETE FROM tokens WHERE user_id = ? AND id = ?').run(this.current().id, req.params.id); res.json({ ok: true }) })
    r.get('/users', async (_req, res) => {
      const users = await Promise.all((this.db.raw.prepare('SELECT * FROM users').all() as unknown as User[]).map(async (u) => {
        // Counts follow the admin's own level: an Off admin's counts leave hidden games' saves out.
        const store = this.store(u.id), dirs = this.content.visibleSaveDirs(await store.listDirs())
        const files = await Promise.all(dirs.map((dir) => store.list(dir)))
        return { ...publicUser(u), games: files.filter((entries) => entries.length > 0).length, saves: files.reduce((n, entries) => n + entries.length, 0), protected: u.id === 1 || u.id === this.cfg.authUser, ...this.managed(u.id) }
      }))
      res.json({ users, adultDefault: this.cfg.adultDefault })
    })
    r.post('/users', async (req, res) => {
      const login = username(req.body?.username), display = name(req.body?.name || login), encoded = await passwordHash(req.body?.password)
      if (this.db.raw.prepare('SELECT 1 FROM users WHERE username = ?').get(login)) throw new HttpError(409, 'That username is taken')
      const role = req.body?.role ?? 'player'
      if (!['admin', 'player'].includes(role)) throw new HttpError(400, 'Choose Admin or Player')
      const ceiling = req.body?.adultCeiling === undefined ? this.cfg.adultDefault : parseAdultLevel(req.body?.adultCeiling)
      if (!ceiling) throw new HttpError(400, 'Choose Off, Blurred or Shown for the adult games ceiling')
      this.db.raw.exec('BEGIN IMMEDIATE')
      let id: number
      try {
        id = Number(this.db.raw.prepare('INSERT INTO users (username, name, role, created_at) VALUES (?, ?, ?, ?)').run(login, display, role, new Date().toISOString()).lastInsertRowid)
        // The ceiling an admin chooses here is also where the person's own choice starts.
        this.writeLevels(id, { ceiling, choice: ceiling })
        this.db.raw.prepare("INSERT INTO identities VALUES ('local', ?, ?, ?)").run(login, id, encoded)
        this.db.raw.exec('COMMIT')
      } catch (e) { this.db.raw.exec('ROLLBACK'); throw e }
      await this.tag(this.user(id)); res.status(201).json({ user: publicUser(this.user(id)) })
    })
    r.put('/users/:id', async (req, res) => {
      const target = this.user(Number(req.params.id)), b = req.body ?? {}
      if (this.removing.has(target.id)) throw new HttpError(409, 'This account is being archived')
      if (b.role !== undefined && !['admin', 'player'].includes(b.role)) throw new HttpError(400, 'Choose Admin or Player')
      if (b.disabled !== undefined && typeof b.disabled !== 'boolean') throw new HttpError(400, 'disabled must be a boolean')
      const ceiling = b.adultCeiling === undefined ? undefined : parseAdultLevel(b.adultCeiling) ?? undefined
      if (b.adultCeiling !== undefined && !ceiling) throw new HttpError(400, 'Choose Off, Blurred or Shown for the adult games ceiling')
      const choice = b.adultChoice === undefined ? undefined : parseAdultLevel(b.adultChoice) ?? undefined
      if (b.adultChoice !== undefined && !choice) throw new HttpError(400, 'Choose Off, Blurred or Shown for the adult games choice')
      const managed = this.managed(target.id)
      if (b.role !== undefined && managed.roleManaged || ceiling !== undefined && managed.adultManaged) throw new HttpError(409, 'This permission is set by the sign-in provider')
      this.guardLastAdmin(target, b)
      this.db.raw.prepare('UPDATE users SET name = ?, role = ?, disabled = ? WHERE id = ?').run(b.name === undefined ? target.name : name(b.name), b.role ?? target.role, b.disabled === undefined ? target.disabled : Number(b.disabled), target.id)
      if (ceiling !== undefined || choice !== undefined) this.writeLevels(target.id, { ceiling, choice })
      if (b.role !== undefined) this.db.raw.prepare("UPDATE users SET admin_source = 'manual', admin_provider = '', admin_subject = '' WHERE id = ?").run(target.id)
      this.invalidate(); await this.tag(this.user(target.id)); res.json({ user: publicUser(this.user(target.id)) })
    })
    r.post('/users/:id/password', async (req, res) => {
      const target = this.user(Number(req.params.id)), encoded = await passwordHash(req.body?.password)
      this.db.raw.prepare("UPDATE identities SET password = ? WHERE provider = 'local' AND user_id = ?").run(encoded, target.id)
      this.revoke(target.id); res.json({ ok: true })
    })
    r.post('/users/:id/saves/copy', async (req, res) => res.json({ copied: await this.copy(Number(req.params.id), Number(req.body?.target), req.body?.game, true) }))
    r.get('/users/:id/saves/export', async (req, res) => {
      const id = this.user(Number(req.params.id)).id, store = this.store(id)
      res.attachment(`renplay-user-${id}-saves.zip`).type('application/zip')
      await store.exportZip(this.content.visibleSaveDirs(await store.listDirs()), res, { includeTokens: true })
    })
    r.post('/users/:id/saves/import', saveImport('file', async (req, res) => {
      const target = this.store(this.user(Number(req.params.id)).id)
      if (!req.file) throw new HttpError(400, 'Upload a save folder zip')
      const entries = await readZipEntries(req.file.path, () => true, 128 << 20)
      const files = [...entries].map(([path, data]) => {
        const rel = cleanRelPath(path), slash = rel.indexOf('/'), dir = rel.slice(0, slash)
        if (slash < 1 || !isSaveDirName(dir)) throw new HttpError(400, 'Zip entries must be inside save folders')
        return { dir, file: rel.slice(slash + 1), data }
      })
      for (const f of files) {
        if (f.dir === 'tokens' && f.file === 'security_keys.txt') await target.mergeSecurityKeys(f.data.toString('utf-8'))
        else await target.write(f.dir, f.file, f.data, { reason: 'user-import' })
      }
      res.json({ imported: files.length })
    }))
    const remove = async (id: number) => {
      const u = this.user(id)
      if (id === 1 || id === this.cfg.authUser) throw new HttpError(409, 'The no-sign-in account must stay')
      if (this.removing.has(id)) throw new HttpError(409, 'This account is being archived')
      this.guardLastAdmin(u, {}, true)
      const store = this.store(id), source = join(this.cfg.dataDir, 'users', String(id))
      const destination = join(this.cfg.dataDir, 'users-removed', `${id}-${Date.now()}`)
      this.removing.add(id)
      // Reserve the removal synchronously: two concurrent removals cannot both pass the last-admin check.
      this.db.raw.prepare('UPDATE users SET disabled = 1 WHERE id = ?').run(id)
      this.invalidate()
      try {
        await store.pauseWrites()
        await mkdir(join(this.cfg.dataDir, 'users-removed'), { recursive: true })
        await rename(source, destination)
        this.db.raw.exec('BEGIN IMMEDIATE')
        try {
          this.db.raw.prepare('DELETE FROM identity_metadata WHERE (provider, subject) IN (SELECT provider, subject FROM identities WHERE user_id = ?)').run(id)
          for (const table of ['sessions', 'tokens', 'identities', 'user_games', 'play_sessions', 'save_meta', 'device_people']) this.db.raw.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(id)
          // Their own art choices and uploads. Choices for everyone stay.
          for (const table of ['art_choices', 'art_uploads']) this.db.raw.prepare(`DELETE FROM ${table} WHERE scope = ?`).run(id)
          this.db.raw.prepare('DELETE FROM users WHERE id = ?').run(id)
          this.db.raw.exec('COMMIT')
        } catch (error) {
          this.db.raw.exec('ROLLBACK')
          await rename(destination, source)
          throw error
        }
        this.invalidate(); this.stores.delete(id)
      } catch (error) {
        this.db.raw.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(u.disabled, id)
        store.resumeWrites()
        throw error
      } finally { this.removing.delete(id) }
    }
    r.post('/me/claim-owner', async (_req, res) => {
      const u = this.current(), { session, bearer } = viewer()!
      if (u.role !== 'admin') throw new HttpError(403, 'Only an admin can claim the owner account')
      if (!this.unclaimed) throw new HttpError(409, 'The owner account is already claimed')
      if (u.id === 1) throw new HttpError(409, 'Use the setup code to choose the owner password')
      if (u.id === this.cfg.authUser) throw new HttpError(409, 'Choose the owner as RENPLAY_AUTH_USER before claiming it')
      const reservation = random()
      this.db.raw.exec('BEGIN IMMEDIATE')
      try {
        if (!this.unclaimed) throw new HttpError(409, 'The owner account is already claimed')
        this.db.setSetting('owner_claim', reservation)
        this.db.raw.exec('COMMIT')
      } catch (error) { this.db.raw.exec('ROLLBACK'); throw error }
      try {
        await this.copy(u.id, 1)
        this.db.raw.exec('BEGIN IMMEDIATE')
        try {
          // The copy can take a while. Check again that the claimant is still signed in, enabled
          // and an admin, and carry over their permissions as they are now, so a role or grant
          // removed meanwhile is not restored through the owner account.
          this.requireLiveLink(u.id, session, bearer)
          const now = this.db.raw.prepare('SELECT * FROM users WHERE id = ?').get(u.id) as unknown as User | undefined
          if (!now || now.disabled || now.role !== 'admin') throw new HttpError(403, 'Only an admin can claim the owner account')
          this.mergeProgress(u.id, 1)
          this.db.raw.prepare('UPDATE users SET username = ? WHERE id = ?').run(`archived-${u.id}-${randomBytes(4).toString('hex')}`, u.id)
          this.db.raw.prepare("UPDATE users SET username = ?, name = ?, role = 'admin', avatar = ?, avatar_uploaded = ?, admin_source = ?, admin_provider = ?, admin_subject = ? WHERE id = 1").run(now.username, now.name, now.avatar, now.avatar_uploaded, now.admin_source, now.admin_provider, now.admin_subject)
          this.writeLevels(1, { ceiling: parseAdultLevel(now.adult_ceiling) ?? this.cfg.adultDefault, choice: parseAdultLevel(now.adult_choice) ?? this.cfg.adultDefault })
          this.db.raw.prepare('UPDATE identities SET user_id = 1 WHERE user_id = ?').run(u.id)
          this.db.raw.prepare('UPDATE sessions SET user_id = 1 WHERE hash = ?').run(session)
          this.db.raw.prepare('UPDATE tokens SET user_id = 1 WHERE hash = ?').run(session)
          this.db.raw.exec('COMMIT')
        } catch (e) { this.db.raw.exec('ROLLBACK'); throw e }
        await remove(u.id)
        await this.tag(this.user(1)); this.setupCode = ''; this.setupGrant = ''; this.invalidate()
        res.json({ ok: true })
      } finally {
        this.db.raw.prepare("DELETE FROM settings WHERE key = 'owner_claim' AND value = ?").run(JSON.stringify(reservation))
      }
    })
    r.post('/users/:id/merge', async (req, res) => {
      const id = Number(req.params.id), target = Number(req.body?.target)
      if (id === 1 || id === this.cfg.authUser) throw new HttpError(409, 'The no-sign-in account must stay')
      this.guardLastAdmin(this.user(id), {}, true)
      const copied = await this.copy(id, target)
      this.mergeProgress(id, target)
      await remove(id); res.json({ copied })
    })
    r.delete('/users/:id', async (req, res) => { await remove(Number(req.params.id)); res.json({ ok: true }) })
    r.post('/games/:id/safe', (req, res) => {
      const g = this.db.getGame(req.params.id)
      if (!g || this.content.hides(g)) throw new HttpError(404, 'Game not found')
      if (g.recipe_id) throw new HttpError(409, 'Only games without a recipe can be marked safe')
      if (typeof req.body?.safe !== 'boolean') throw new HttpError(400, 'Safe must be a boolean')
      if (req.body.safe) this.db.raw.prepare('INSERT OR IGNORE INTO safe_games VALUES (?)').run(g.id)
      else this.db.raw.prepare('DELETE FROM safe_games WHERE game = ?').run(g.id)
      res.json({ ok: true })
    })
    return r
  }
}
