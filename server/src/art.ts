import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'
import { rgbaToThumbHash } from 'thumbhash'
import { viewer } from './accounts-context.js'
import type { Config } from './config.js'
import type { ContentMode } from './content.js'
import type { Db, GameRow } from './db.js'
import { MAX_IMAGE_PIXELS, PixelBudget } from './pipeline/image-memory.js'
import { exists, writeFileAtomic } from './util/fsx.js'
import { HttpError } from './util/paths.js'
import { catalogHosts, fetchPublic } from './util/net.js'
import { readLocalFile } from './recipes-local.js'

/**
 * The art system (DESIGN 0.4). A game has five formats in SteamGridDB's shapes. The catalog links
 * pictures, a person or an admin may choose another one or upload their own, and this module makes
 * every format from what there is, in Jan's order: real art in the shape, a crop at the focal
 * point, a composition, the picture whole on its glow. Everything it serves is made here, cached by
 * content in the data folder, and served by the instance itself. Made pictures contain no text: the
 * interface draws the logo or the title where a composition leaves room for it.
 */

export type ArtKind = 'grid' | 'wide' | 'hero' | 'logo' | 'icon'
export const ART_KINDS: readonly ArtKind[] = ['grid', 'wide', 'hero', 'logo', 'icon']
type Shaped = Exclude<ArtKind, 'logo'>
/** The formats at 1x. A logo has no shape: any transparent picture. */
export const SHAPES: Record<Shaped, readonly [number, number]> = { grid: [600, 900], wide: [920, 430], hero: [1920, 620], icon: [512, 512] }
const LOGO_WIDTH = 640
/** Raised when the making changes, so every picture is made again. */
const ART_VERSION = 3
const MAX_SOURCE_BYTES = 16 << 20
/** A crop must keep this share of the picture, unless the recipe gives a focal point. */
export const MIN_CROP = 0.6
/** The icon cut from a grid: this share of the grid's short side. */
const ICON_SHARE = 0.62

/** A picture as the catalog's schema 4 index publishes it. */
export interface CatalogImage {
  kind: ArtKind
  url: string
  source: string
  sha256?: string
  width?: number
  height?: number
  thumbhash?: string
  tint?: string
  focal?: [number, number]
  dark?: boolean
  default?: boolean
  sgdb?: number
  asset?: string
  by?: string
  byUrl?: string
}

export type Credit = { by: string; byUrl?: string; asset?: string } | { store: 'Steam' | 'itch.io' } | { renplay: true } | { developer: true } | { upload: true }

/** One picture that can fill a format: from the catalog or uploaded. */
export interface Picture {
  /** The original's sha256, or a hash of its address when the catalog gives none. */
  id: string
  kind: ArtKind
  url: string | null
  /** Index URL the catalog image came from, for relative addresses. */
  base?: string
  width: number
  height: number
  thumbhash: string | null
  tint: string | null
  focal: [number, number] | null
  dark: boolean
  /** The sha256 to check a download against. */
  sha256: string | null
  source: string
  credit: Credit
  upload: boolean
  default: boolean
}

export type Made = null | 'crop' | 'composed' | 'glow' | 'whole'
type Mode = 'resize' | 'crop' | 'cut' | 'poster' | 'across' | 'glow' | 'whole'
const MADE: Record<Mode, Made> = { resize: null, crop: 'crop', cut: 'crop', poster: 'composed', across: 'composed', glow: 'glow', whole: 'whole' }

export interface Plan {
  kind: ArtKind
  mode: Mode
  source: Picture
}

/** A format as the API sends it. Below Shown an adult game's formats carry only `thumbhash` and `tint`. */
export interface ArtOut {
  url1x: string | null
  url2x: string | null
  width: number
  height: number
  thumbhash: string | null
  tint: string | null
  made: Made
  source: string
  credit: Credit
  dark?: boolean
}
export type ArtSet = Partial<Record<ArtKind, ArtOut | { thumbhash: string | null; tint: string | null }>>

interface MadeRow {
  key: string
  file1x: string
  file2x: string
  width: number
  height: number
  thumbhash: string
  tint: string
  made: string
  adult: number
  /** A logo of dark lettering, inverted on ink. */
  dark: number
  created_at: number
}

/** Whether the picture has its format's shape, within 2 percent. */
export function inShape(kind: ArtKind, p: { width: number; height: number }): boolean {
  if (kind === 'logo') return true
  const [w, h] = SHAPES[kind]
  return Math.abs(p.width / p.height - w / h) <= (w / h) * 0.02
}

/** The share of a picture a crop to the format keeps. */
export function keeps(kind: Shaped, p: { width: number; height: number }): number {
  const a = p.width / p.height
  const [w, h] = SHAPES[kind]
  const t = w / h
  return Math.min(a / t, t / a)
}

/**
 * How a format is made from the chosen pictures (DESIGN 0.4):
 * 1. real art in the shape, resized,
 * 2. a crop at the focal point: always when the recipe gives one, else when it keeps 60 percent,
 * 3. a composition: a wide from a poster puts the poster at the left on its glow, a grid from a
 *    wide picture puts it across the upper half, a hero is the picture enlarged and blurred,
 * 4. the picture whole on its glow.
 * The icon is cut from the grid. A logo is never made: without one the interface draws the title.
 */
export function planFormat(kind: ArtKind, chosen: Partial<Record<ArtKind, Picture>>): Plan | null {
  const own = chosen[kind]
  if (kind === 'logo') return own ? { kind, mode: 'resize', source: own } : null
  if (own && inShape(kind, own)) return { kind, mode: 'resize', source: own }
  if (kind === 'icon') {
    // An icon of another shape is cropped to its largest square. The cut, a closer square, is for an
    // icon made from the grid or another format.
    if (own) return { kind, mode: 'crop', source: own }
    const from = chosen.grid ?? chosen.wide ?? chosen.hero
    return from ? { kind, mode: 'cut', source: from } : null
  }
  const others = (['grid', 'wide', 'hero'] as const).filter((k) => k !== kind).map((k) => chosen[k]).filter((p): p is Picture => !!p)
  const from = own ?? others.sort((a, b) => keeps(kind, b) - keeps(kind, a) || b.width * b.height - a.width * a.height)[0]
  if (!from) return null
  if (from.focal || keeps(kind, from) >= MIN_CROP) return { kind, mode: 'crop', source: from }
  if (kind === 'hero') return { kind, mode: 'glow', source: from }
  const aspect = from.width / from.height
  if (kind === 'wide' && aspect <= 0.8) return { kind, mode: 'poster', source: from }
  if (kind === 'grid' && aspect >= 1.8) return { kind, mode: 'across', source: from }
  return { kind, mode: 'whole', source: from }
}

function planKey(plan: Plan, focal: [number, number] | null): string {
  return createHash('sha256').update(JSON.stringify({ v: ART_VERSION, kind: plan.kind, mode: plan.mode, src: plan.source.id, focal })).digest('hex').slice(0, 40)
}

const hex = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')

/** ThumbHash and tint of a picture, from a copy at most 100 pixels wide or high. */
export async function hashOf(data: Buffer): Promise<{ thumbhash: string; tint: string }> {
  const { data: rgba, info } = await sharp(data, { failOn: 'none', limitInputPixels: MAX_IMAGE_PIXELS })
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const thumbhash = Buffer.from(rgbaToThumbHash(info.width, info.height, rgba)).toString('base64')
  return { thumbhash, tint: tintOf(rgba) }
}

/**
 * The tint: the most vivid hue that covers enough of the picture, never near white or black,
 * lifted a little so it glows on ink. The same method as the catalog build, so a picture made
 * here has the tint its source has in the index.
 */
export function tintOf(rgba: Uint8Array | Buffer): string {
  const bins = Array.from({ length: 12 }, () => ({ w: 0, r: 0, g: 0, b: 0 }))
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3]! < 128) continue
    const r = rgba[i]! / 255
    const g = rgba[i + 1]! / 255
    const b = rgba[i + 2]! / 255
    const mx = Math.max(r, g, b)
    const d = mx - Math.min(r, g, b)
    if (d < 0.08 || mx < 0.12) continue
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4
    h = (h + 6) % 6
    const bin = bins[Math.floor(h * 2) % 12]!
    const w = (d / mx) * Math.min(1, mx * 1.5)
    bin.w += w
    bin.r += r * w
    bin.g += g * w
    bin.b += b * w
  }
  const best = bins.reduce((a, b) => (b.w > a.w ? b : a), bins[0]!)
  if (!best.w) return '#5a5a7a'
  let r = best.r / best.w
  let g = best.g / best.w
  let b = best.b / best.w
  const mx = Math.max(r, g, b)
  if (mx < 0.45) {
    const f = 0.45 / mx
    r *= f
    g *= f
    b *= f
  }
  return `#${hex(r * 255)}${hex(g * 255)}${hex(b * 255)}`
}

/** Whether a transparent picture is dark lettering: the visible pixels average under a third of full brightness. */
export async function isDarkLettering(data: Buffer): Promise<boolean> {
  const { data: rgba } = await sharp(data, { failOn: 'none' }).resize(200, 200, { fit: 'inside' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  let sum = 0
  let weight = 0
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    const a = rgba[i + 3]! / 255
    if (a < 0.5) continue
    sum += (a * (0.2126 * rgba[i]! + 0.7152 * rgba[i + 1]! + 0.0722 * rgba[i + 2]!)) / 255
    weight += a
  }
  return weight > 0 && sum / weight < 0.33
}

/**
 * Where the picture matters: the recipe's or uploader's focal point, else sharp's attention guess.
 * sharp reports the point in the picture scaled to cover the square it was asked for.
 */
export async function focalOf(data: Buffer, size: { width: number; height: number }, given: [number, number] | null, top = 1): Promise<[number, number]> {
  if (given) return given
  const box = 160
  // `top` limits the search to the upper share of the picture (the icon looks above a poster's title).
  const region = { left: 0, top: 0, width: size.width, height: Math.max(1, Math.round(size.height * top)) }
  const { info } = await sharp(data, { failOn: 'none', limitInputPixels: MAX_IMAGE_PIXELS })
    .extract(region)
    .resize(box, box, { fit: 'cover', position: sharp.strategy.attention })
    .toBuffer({ resolveWithObject: true })
  const x = (info as { attentionX?: number }).attentionX
  const y = (info as { attentionY?: number }).attentionY
  if (typeof x !== 'number' || typeof y !== 'number') return [0.5, 0.5 * top]
  const scale = Math.max(box / region.width, box / region.height)
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  return [clamp(x / (size.width * scale)), clamp(y / (size.height * scale))]
}

/**
 * Posters carry their title in the lower part (Dear Devere, most visual novels), and attention
 * loves lettering, so the icon cut from a picture that is not clearly wide looks for its subject in
 * the top 60 percent.
 */
const ICON_SEARCH = 0.6

/** The largest rectangle of the given aspect (or the given width) around the focal point, inside the picture. */
function cropRect(w: number, h: number, aspect: number, focal: [number, number], side?: number) {
  let cw = side ?? (w / h > aspect ? h * aspect : w)
  let ch = side ?? cw / aspect
  cw = Math.max(1, Math.min(w, Math.round(cw)))
  ch = Math.max(1, Math.min(h, Math.round(ch)))
  const left = Math.round(Math.min(w - cw, Math.max(0, focal[0] * w - cw / 2)))
  const top = Math.round(Math.min(h - ch, Math.max(0, focal[1] * h - ch / 2)))
  return { left, top, width: cw, height: ch }
}

/** The picture enlarged to fill the frame, blurred and darkened: the glow behind compositions. */
async function glow(data: Buffer, w: number, h: number, brightness: number): Promise<Buffer> {
  // Blurred small, then enlarged: smooth at any size, and cheap.
  const small = await sharp(data, { failOn: 'none', limitInputPixels: MAX_IMAGE_PIXELS })
    .resize(Math.max(8, Math.round(w / 16)), Math.max(8, Math.round(h / 16)), { fit: 'cover' })
    .blur(2.5)
    .png()
    .toBuffer()
  return sharp(small)
    .resize(w, h, { fit: 'fill', kernel: 'cubic' })
    .modulate({ brightness })
    .removeAlpha()
    .png()
    .toBuffer()
}

/** Makes one format at one scale. */
async function makeAt(plan: Plan, data: Buffer, meta: { width: number; height: number }, focal: [number, number], scale: 1 | 2): Promise<Buffer> {
  const input = () => sharp(data, { failOn: 'none', limitInputPixels: MAX_IMAGE_PIXELS })
  if (plan.kind === 'logo') {
    const width = Math.min(LOGO_WIDTH * scale, meta.width)
    return input().resize({ width }).webp({ quality: 90, alphaQuality: 100 }).toBuffer()
  }
  const [fw, fh] = SHAPES[plan.kind]
  const W = fw * scale
  const H = fh * scale
  const webp = (s: ReturnType<typeof sharp>) => s.webp({ quality: 82 }).toBuffer()
  switch (plan.mode) {
    case 'resize':
      return webp(input().resize(W, H, { fit: 'cover' }))
    case 'crop':
    case 'cut': {
      const side = plan.mode === 'cut' ? Math.round(ICON_SHARE * Math.min(meta.width, meta.height)) : undefined
      const rect = cropRect(meta.width, meta.height, W / H, focal, side)
      return webp(input().extract(rect).resize(W, H, { fit: 'cover' }))
    }
    case 'glow':
      return webp(sharp(await glow(data, W, H, 0.75)))
    case 'poster': {
      const pad = Math.round(H * 0.07)
      const ph = H - 2 * pad
      const pw = Math.round(ph * (meta.width / meta.height))
      const poster = await input().resize(pw, ph, { fit: 'cover' }).png().toBuffer()
      return webp(sharp(await glow(data, W, H, 0.5)).composite([{ input: poster, left: pad, top: pad }]))
    }
    case 'across': {
      const pw = W
      const ph = Math.round(W / (meta.width / meta.height))
      const picture = await input().resize(pw, ph, { fit: 'cover' }).png().toBuffer()
      const top = Math.max(0, Math.round((H / 2 - ph) / 2))
      return webp(sharp(await glow(data, W, H, 0.5)).composite([{ input: picture, left: 0, top }]))
    }
    case 'whole': {
      const inner = await input().resize(Math.round(W * 0.88), Math.round(H * 0.88), { fit: 'inside' }).png().toBuffer()
      const m = await sharp(inner).metadata()
      return webp(sharp(await glow(data, W, H, 0.5)).composite([{ input: inner, left: Math.round((W - m.width!) / 2), top: Math.round((H - m.height!) / 2) }]))
    }
  }
}

/**
 * A 2x picture only when the source has the detail for it (at least 1.5 source pixels per 1x
 * pixel). Otherwise the 2x address is the 1x picture: enlarging adds nothing the browser cannot.
 */
export function needs2x(plan: Plan, meta: { width: number; height: number }, focal: [number, number] = [0.5, 0.5]): boolean {
  const detail = (): number => {
    if (plan.kind === 'logo') return meta.width / LOGO_WIDTH
    const [W, H] = SHAPES[plan.kind]
    switch (plan.mode) {
      case 'resize': return meta.width / W
      case 'crop': return cropRect(meta.width, meta.height, W / H, focal).width / W
      case 'cut': return (ICON_SHARE * Math.min(meta.width, meta.height)) / W
      case 'poster': return meta.height / (H * 0.86)
      case 'across': return meta.width / W
      case 'whole': return Math.min(meta.width / (W * 0.88), meta.height / (H * 0.88))
      case 'glow': return 0
    }
  }
  return detail() >= 1.5
}

/** A failed download waits this long before the next try. */
const RETRY_AFTER = 15 * 60_000
/** Uploads kept per person (or for everyone), game and format. */
const MAX_UPLOADS = 10
/** Uploads up to this many pixels are taken and scaled down to what the making allows. */
const UPLOAD_PIXELS = 4 * MAX_IMAGE_PIXELS

function creditOf(img: CatalogImage): Credit {
  const https = (u: unknown) => (typeof u === 'string' && /^https:\/\//i.test(u) ? u : undefined)
  if (img.source === 'sgdb' && img.by) return { by: img.by, byUrl: https(img.byUrl), asset: https(img.asset) }
  if (img.source === 'steam') return { store: 'Steam' }
  if (img.source === 'itch') return { store: 'itch.io' }
  if (img.source === 'renplay') return { renplay: true }
  return { developer: true }
}

/** The catalog's pictures of a recipe, in the order of the index. */
export function catalogPictures(art: CatalogImage[] | undefined, base?: string): Picture[] {
  return (art ?? []).filter((a) => ART_KINDS.includes(a.kind) && typeof a.url === 'string' && a.url).map((a) => ({
    id: a.sha256 && /^[0-9a-f]{64}$/i.test(a.sha256) ? a.sha256.toLowerCase() : `url-${createHash('sha256').update(a.url).digest('hex').slice(0, 40)}`,
    kind: a.kind,
    url: a.url,
    base,
    width: a.width ?? 0,
    height: a.height ?? 0,
    thumbhash: a.thumbhash ?? null,
    tint: a.tint ?? null,
    focal: Array.isArray(a.focal) && a.focal.length === 2 ? [Number(a.focal[0]), Number(a.focal[1])] : null,
    dark: a.dark === true,
    sha256: a.sha256 ? a.sha256.toLowerCase() : null,
    source: a.source,
    credit: creditOf(a),
    upload: false,
    default: a.default === true,
  }))
}

export interface ArtSubject {
  /** The library game, or null for a catalog recipe outside the library. */
  game: string | null
  /** The recipe, which names the subject in problems (so they can be kept from people below Shown). */
  recipe?: string | null
  adult: boolean
  pictures: Picture[]
}

const EVERYONE = 0

export class ArtStore {
  private readonly dir: string
  private readonly sources: string
  private readonly budget = new PixelBudget()
  private readonly pending = new Map<string, Promise<MadeRow | null>>()
  private readonly downloads = new Map<string, Promise<Buffer>>()
  private readonly failed = new Map<string, { at: number; message: string }>()
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(
    private readonly cfg: Config,
    private readonly db: Db,
    private readonly content: ContentMode,
    private readonly concurrency = Math.max(1, Math.min(4, cfg.imageConcurrency || 2)),
  ) {
    this.dir = join(cfg.dataDir, 'art')
    this.sources = join(cfg.dataDir, 'art', 'src')
  }

  // ---- choosing ----------------------------------------------------------------

  /** The scope a choice is read for: the person, then everyone. */
  private viewerScope(): number {
    return viewer()?.user.id ?? EVERYONE
  }

  /** Deletes an upload and the choices of it. Its file goes with the next clean-up once nothing uses it. */
  removeUpload(game: string, kind: ArtKind, id: string, scope: number): boolean {
    const gone = this.db.raw.prepare('DELETE FROM art_uploads WHERE id = ? AND game = ? AND kind = ? AND scope = ?').run(id, game, kind, scope).changes > 0
    if (!gone) return false
    // A picture uploaded for everyone may be anyone's choice. A personal one only its owner's.
    if (scope === EVERYONE) this.db.raw.prepare('DELETE FROM art_choices WHERE game = ? AND kind = ? AND candidate = ?').run(game, kind, id)
    else this.db.raw.prepare('DELETE FROM art_choices WHERE game = ? AND kind = ? AND candidate = ? AND scope = ?').run(game, kind, id, scope)
    return true
  }

  /** A game forgotten: its choices and uploads go, their files with the next clean-up. */
  forgetGame(game: string): void {
    this.db.raw.prepare('DELETE FROM art_choices WHERE game = ?').run(game)
    this.db.raw.prepare('DELETE FROM art_uploads WHERE game = ?').run(game)
  }

  /** A person removed: their own choices and uploads go. Choices for everyone stay. */
  forgetPerson(id: number): void {
    if (id === EVERYONE) return
    this.db.raw.prepare('DELETE FROM art_choices WHERE scope = ?').run(id)
    this.db.raw.prepare('DELETE FROM art_uploads WHERE scope = ?').run(id)
  }

  /** True when an upload was made for everyone. */
  isShared(id: string, game: string): boolean {
    return !!this.db.raw.prepare('SELECT 1 FROM art_uploads WHERE id = ? AND game = ? AND scope = 0').get(id, game)
  }

  uploads(game: string, scope: number): Picture[] {
    const rows = this.db.raw.prepare('SELECT * FROM art_uploads WHERE game = ? AND (scope = ? OR scope = 0) ORDER BY created_at').all(game, scope) as unknown as Array<{ id: string; kind: ArtKind; width: number; height: number; focal: string; thumbhash: string; tint: string; scope: number }>
    return rows.map((u) => ({
      id: u.id, kind: u.kind, url: null, width: u.width, height: u.height, thumbhash: u.thumbhash, tint: u.tint,
      focal: u.focal ? (JSON.parse(u.focal) as [number, number]) : null, dark: false, sha256: u.id, source: 'upload',
      credit: { upload: true }, upload: true, default: false,
    }))
  }

  /** The chosen picture of each format: the person's choice, the admin's choice for everyone, the catalog's default. */
  chosen(subject: ArtSubject, scope: number): Partial<Record<ArtKind, Picture>> {
    const out: Partial<Record<ArtKind, Picture>> = {}
    const choices = subject.game
      ? (this.db.raw.prepare('SELECT kind, scope, candidate FROM art_choices WHERE game = ? AND (scope = ? OR scope = 0)').all(subject.game, scope) as unknown as Array<{ kind: ArtKind; scope: number; candidate: string }>)
      : []
    for (const kind of ART_KINDS) {
      const of = subject.pictures.filter((p) => p.kind === kind)
      const pick = (s: number) => of.find((p) => p.id === choices.find((c) => c.kind === kind && c.scope === s)?.candidate)
      const picked = (scope !== EVERYONE ? pick(scope) : undefined) ?? pick(EVERYONE) ?? of.find((p) => p.default && !p.upload) ?? of.find((p) => !p.upload && inShapeKnown(p)) ?? of.find((p) => !p.upload)
      if (picked) out[kind] = picked
    }
    return out
  }

  plans(subject: ArtSubject, scope: number): Partial<Record<ArtKind, Plan>> {
    const chosen = this.chosen(subject, scope)
    const out: Partial<Record<ArtKind, Plan>> = {}
    for (const kind of ART_KINDS) {
      const plan = planFormat(kind, chosen)
      // A catalog image without its size is measured when it is downloaded.
      if (plan && plan.source.width > 0 && plan.source.height > 0) out[kind] = plan
      else if (plan) void this.measure(plan.source, subject.adult).catch(() => {})
    }
    return out
  }

  /**
   * The formats as one person sees them. Below Shown an adult game's art is its hashes and tints
   * only, and nothing of it is made or downloaded. Formats not made yet carry their source's hash
   * and are made in the background.
   */
  forSubject(subject: ArtSubject, opts: { scope?: number; blurred?: boolean } = {}): ArtSet {
    const scope = opts.scope ?? this.viewerScope()
    const blurred = opts.blurred ?? (subject.adult && this.content.viewerLevel() !== 'shown')
    const out: ArtSet = {}
    for (const [kind, plan] of Object.entries(this.plans(subject, scope)) as Array<[ArtKind, Plan]>) {
      const key = planKey(plan, plan.source.focal)
      const row = this.db.raw.prepare('SELECT * FROM art_made WHERE key = ?').get(key) as unknown as MadeRow | undefined
      if (blurred) {
        out[kind] = { thumbhash: row?.thumbhash ?? plan.source.thumbhash, tint: row?.tint ?? plan.source.tint }
        continue
      }
      if (!row) void this.ensure(plan, subject.adult).catch(() => {})
      out[kind] = {
        url1x: row ? `/api/art/${row.file1x}` : null,
        url2x: row ? `/api/art/${row.file2x}` : null,
        width: row?.width ?? (kind === 'logo' ? plan.source.width : SHAPES[kind as Shaped][0]),
        height: row?.height ?? (kind === 'logo' ? plan.source.height : SHAPES[kind as Shaped][1]),
        thumbhash: row?.thumbhash ?? plan.source.thumbhash,
        tint: row?.tint ?? plan.source.tint,
        made: MADE[plan.mode],
        source: plan.source.source,
        credit: plan.source.credit,
        ...(kind === 'logo' && (plan.source.dark || row?.dark) ? { dark: true } : {}),
      }
    }
    return out
  }

  /**
   * Every candidate for one format, each made at the format's size by the same pipeline, so what
   * the picker shows is what the tile will be. For a person at Shown only.
   */
  async candidates(subject: ArtSubject, kind: ArtKind, scope: number): Promise<Array<{ id: string; current: boolean; everyone: boolean; mine: boolean; inShape: boolean; width: number; height: number; source: string; credit: Credit; upload: boolean; ownUpload: boolean; sharedUpload: boolean; preview: ArtOut | null }>> {
    const chosen = this.chosen(subject, scope)
    // For everyone: only what an admin chose for everyone, not the catalog default.
    const everyone = subject.game ? (this.db.raw.prepare('SELECT candidate FROM art_choices WHERE game = ? AND kind = ? AND scope = 0').get(subject.game, kind) as { candidate: string } | undefined)?.candidate : undefined
    const choice = subject.game ? (this.db.raw.prepare('SELECT candidate FROM art_choices WHERE game = ? AND kind = ? AND scope = ?').get(subject.game, kind, scope) as { candidate: string } | undefined)?.candidate : undefined
    // Made side by side (the making slots still limit how many at once), so one slow picture does
    // not hold up the list.
    return Promise.all(subject.pictures.filter((x) => x.kind === kind).map(async (p) => {
      const plan = planFormat(kind, { ...chosen, [kind]: p })
      let preview: ArtOut | null = null
      if (plan && p.width > 0) {
        const row = await this.ensure(plan, subject.adult).catch(() => null)
        if (row) preview = { url1x: `/api/art/${row.file1x}`, url2x: `/api/art/${row.file2x}`, width: row.width, height: row.height, thumbhash: row.thumbhash, tint: row.tint, made: MADE[plan.mode], source: p.source, credit: p.credit }
      }
      const uploadAt = (s: number) => !!(p.upload && subject.game && this.db.raw.prepare('SELECT 1 FROM art_uploads WHERE id = ? AND game = ? AND kind = ? AND scope = ?').get(p.id, subject.game, kind, s))
      return { id: p.id, current: chosen[kind]?.id === p.id, everyone: everyone === p.id, mine: choice === p.id, inShape: p.width > 0 && inShape(kind, p), width: p.width, height: p.height, source: p.source, credit: p.credit, upload: p.upload, ownUpload: scope !== EVERYONE && uploadAt(scope), sharedUpload: uploadAt(EVERYONE), preview }
    }))
  }

  /** Makes every format of a subject for one scope now, so the answer to a choice has its pictures. */
  async ready(subject: ArtSubject, scope: number): Promise<void> {
    await Promise.all(Object.values(this.plans(subject, scope)).map((plan) => this.ensure(plan, subject.adult).catch(() => null)))
  }

  choose(game: string, kind: ArtKind, candidate: string, scope: number): void {
    this.db.raw.prepare('INSERT INTO art_choices (game, kind, scope, candidate) VALUES (?, ?, ?, ?) ON CONFLICT (game, kind, scope) DO UPDATE SET candidate = excluded.candidate').run(game, kind, scope, candidate)
  }

  clearChoice(game: string, kind: ArtKind, scope: number): void {
    this.db.raw.prepare('DELETE FROM art_choices WHERE game = ? AND kind = ? AND scope = ?').run(game, kind, scope)
  }

  /**
   * Stores an uploaded picture for one game and format. A picture of another size is accepted
   * and placed with the focal point crop, so the answer carries a warning with its size.
   */
  async upload(game: string, kind: ArtKind, input: Buffer, focal: [number, number] | null, scope: number): Promise<{ id: string; warning: { width: number; height: number } | null }> {
    let data = input
    if (data.length > MAX_SOURCE_BYTES) throw new HttpError(413, 'Pictures can be up to 16 MB')
    if (!isImage(data)) throw new HttpError(400, 'Upload a WebP, PNG or JPEG picture')
    let meta = await sharp(data, { failOn: 'error', limitInputPixels: UPLOAD_PIXELS }).metadata().catch(() => null)
    if (!meta?.width || !meta.height) throw new HttpError(400, 'This picture cannot be read')
    if (meta.width * meta.height > UPLOAD_PIXELS) throw new HttpError(413, 'Pictures can be up to 64 megapixels')
    if (kind === 'logo' && !meta.hasAlpha) throw new HttpError(400, 'A logo needs a transparent background. Upload a PNG with transparency.')
    // A phone photo stands upright by a tag the rest of the pipeline does not read, and a camera
    // picture can be larger than the making allows: both are turned and scaled once, here.
    const turned = (meta.orientation ?? 1) > 1
    const pixels = meta.width * meta.height
    if (turned || pixels > MAX_IMAGE_PIXELS) {
      const scale = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / pixels))
      data = await this.budget.run(Math.min(pixels, MAX_IMAGE_PIXELS), async () => {
        const s = sharp(data, { failOn: 'error', limitInputPixels: UPLOAD_PIXELS }).rotate()
        const sized = scale < 1 ? s.resize(Math.floor((turned && (meta!.orientation ?? 1) >= 5 ? meta!.height! : meta!.width!) * scale)) : s
        return meta!.format === 'jpeg' ? sized.jpeg({ quality: 92 }).toBuffer() : sized.webp({ quality: 92, alphaQuality: 100 }).toBuffer()
      })
      meta = await sharp(data, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).metadata()
    }
    const id = createHash('sha256').update(data).digest('hex')
    const kept = this.db.raw.prepare('SELECT COUNT(*) n FROM art_uploads WHERE game = ? AND kind = ? AND scope = ? AND id != ?').get(game, kind, scope, id) as { n: number }
    if (kept.n >= MAX_UPLOADS) throw new HttpError(409, `You can keep ${MAX_UPLOADS} pictures of each kind for a game. Delete one of them first.`)
    await mkdir(this.sources, { recursive: true })
    const path = join(this.sources, id)
    if (!(await exists(path))) await writeFileAtomic(path, data)
    const { thumbhash, tint } = await this.budget.run(meta.width * meta.height, () => hashOf(data))
    this.db.raw.prepare('INSERT OR REPLACE INTO art_uploads (id, game, kind, scope, width, height, focal, thumbhash, tint, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, game, kind, scope, meta.width, meta.height, focal ? JSON.stringify(focal) : '', thumbhash, tint, Date.now())
    const warning = kind === 'logo' || inShape(kind, { width: meta.width, height: meta.height }) ? null : { width: meta.width, height: meta.height }
    return { id, warning }
  }

  // ---- making -------------------------------------------------------------------

  /** Makes a plan's format once, at 1x and 2x, sharing the work between concurrent callers. */
  ensure(plan: Plan, adult: boolean): Promise<MadeRow | null> {
    const focal = plan.source.focal
    const key = planKey(plan, focal)
    const row = this.db.raw.prepare('SELECT * FROM art_made WHERE key = ?').get(key) as unknown as MadeRow | undefined
    if (row) {
      if (adult && !row.adult) this.db.raw.prepare('UPDATE art_made SET adult = 1 WHERE key = ?').run(key)
      return Promise.resolve(row)
    }
    // An installation below Shown never downloads an adult game's pictures.
    if (adult && this.content.level !== 'shown') return Promise.resolve(null)
    const running = this.pending.get(key)
    if (running) return running
    const job = this.slot(() => this.make(plan, key, adult)).finally(() => this.pending.delete(key))
    this.pending.set(key, job)
    return job
  }

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) await new Promise<void>((resolve) => this.queue.push(resolve))
    this.active++
    try {
      return await fn()
    } finally {
      this.active--
      this.queue.shift()?.()
    }
  }

  private async make(plan: Plan, key: string, adult: boolean): Promise<MadeRow> {
    const data = await this.original(plan.source)
    const meta = await sharp(data, { failOn: 'none', limitInputPixels: MAX_IMAGE_PIXELS }).metadata()
    if (!meta.width || !meta.height) throw new Error('not a picture')
    const size = { width: meta.width, height: meta.height }
    const [W, H] = plan.kind === 'logo' ? [LOGO_WIDTH, LOGO_WIDTH] : SHAPES[plan.kind]
    const pixels = Math.max(size.width * size.height, W * H * 4)
    return this.budget.run(Math.min(pixels, MAX_IMAGE_PIXELS), async () => {
      const top = plan.mode === 'cut' && size.height >= size.width * 0.75 ? ICON_SEARCH : 1
      const focal = plan.mode === 'crop' || plan.mode === 'cut' ? await focalOf(data, size, plan.source.focal, top) : ([0.5, 0.5] as [number, number])
      const one = await makeAt(plan, data, size, focal, 1)
      const two = needs2x(plan, size, focal) ? await makeAt(plan, data, size, focal, 2) : one
      const file1x = await this.write(one)
      const file2x = two === one ? file1x : await this.write(two)
      const outMeta = await sharp(one).metadata()
      const { thumbhash, tint } = await hashOf(one)
      const dark = plan.kind === 'logo' && (await isDarkLettering(one)) ? 1 : 0
      const row: MadeRow = { key, file1x, file2x, width: outMeta.width!, height: outMeta.height!, thumbhash, tint, made: MADE[plan.mode] ?? '', adult: adult ? 1 : 0, dark, created_at: Date.now() }
      this.db.raw.prepare('INSERT OR REPLACE INTO art_made (key, file1x, file2x, width, height, thumbhash, tint, made, adult, dark, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(row.key, row.file1x, row.file2x, row.width, row.height, row.thumbhash, row.tint, row.made, row.adult, row.dark, row.created_at)
      return row
    })
  }

  private async write(webp: Buffer): Promise<string> {
    const file = `${createHash('sha256').update(webp).digest('hex').slice(0, 32)}.webp`
    await mkdir(this.dir, { recursive: true })
    const path = join(this.dir, file)
    if (!(await exists(path))) await writeFileAtomic(path, webp)
    return file
  }

  /** The original picture: from the cache, else downloaded once (also when several formats ask at once). */
  private original(p: Picture): Promise<Buffer> {
    const running = this.downloads.get(p.id)
    if (running) return running
    // A download that failed is not tried again for a while, however many pages ask for it.
    const failed = this.failed.get(p.id)
    if (failed && Date.now() - failed.at < RETRY_AFTER) return Promise.reject(new Error(failed.message))
    const job = this.load(p)
      .then((data) => (this.failed.delete(p.id), data), (e: Error) => {
        this.failed.set(p.id, { at: Date.now(), message: e.message })
        throw e
      })
      .finally(() => this.downloads.delete(p.id))
    this.downloads.set(p.id, job)
    return job
  }

  /** Reads or downloads an original, checked against the catalog's sha256. */
  private async load(p: Picture): Promise<Buffer> {
    const path = join(this.sources, p.id)
    if (await exists(path)) return readFile(path)
    if (p.upload || !p.url) throw new Error('the uploaded picture is gone')
    if (p.url.startsWith('local:')) {
      // A picture in Your recipes: read from the folder and checked like a download.
      const data = await readLocalFile(this.cfg.recipesDir, p.url)
      if (data.length > MAX_SOURCE_BYTES || !isImage(data)) throw new Error('not a WebP, PNG, JPEG or GIF picture under 16 MB')
      if (p.sha256 && p.sha256 !== createHash('sha256').update(data).digest('hex')) throw new Error('the picture changed since the recipes were read')
      await mkdir(this.sources, { recursive: true })
      await writeFileAtomic(path, data)
      return data
    }
    const url = new URL(p.url, p.base)
    // Uncompressed, and read only up to the limit: a small compressed answer cannot grow in memory.
    // Only from the public internet (or the catalog's own host), redirects included.
    const res = await fetchPublic(url, {
      signal: AbortSignal.timeout(30_000),
      headers: { 'user-agent': 'Renplay (https://renplay.org)', 'accept-encoding': 'identity' },
      allowHosts: catalogHosts(this.cfg.catalogUrls ?? []),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const encoding = res.headers.get('content-encoding')
    if (encoding && encoding !== 'identity') throw new Error('the picture was sent compressed')
    const length = Number(res.headers.get('content-length') ?? 0)
    if (length > MAX_SOURCE_BYTES) throw new Error('the picture is over 16 MB')
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of res.body ?? []) {
      total += chunk.length
      if (total > MAX_SOURCE_BYTES) {
        await res.body?.cancel().catch(() => {})
        throw new Error('the picture is over 16 MB')
      }
      chunks.push(Buffer.from(chunk))
    }
    const data = Buffer.concat(chunks)
    if (data.length > MAX_SOURCE_BYTES || !isImage(data)) throw new Error('not a WebP, PNG, JPEG or GIF picture under 16 MB')
    const sha256 = createHash('sha256').update(data).digest('hex')
    if (p.sha256 && p.sha256 !== sha256) throw new Error('the picture changed since the catalog checked it')
    await mkdir(this.sources, { recursive: true })
    await writeFileAtomic(path, data)
    return data
  }

  /** Measures a catalog image the index gives no size for (schema 3 covers in local folders). */
  private async measure(p: Picture, adult: boolean): Promise<void> {
    if (adult && this.content.level !== 'shown') return
    const known = this.db.raw.prepare('SELECT width, height FROM art_measured WHERE id = ?').get(p.id) as { width: number; height: number } | undefined
    if (known) return
    const data = await this.original(p)
    const meta = await sharp(data, { failOn: 'none', limitInputPixels: MAX_IMAGE_PIXELS }).metadata().catch(() => null)
    if (!meta?.width || !meta.height) throw new Error('not a picture')
    const { thumbhash, tint } = await hashOf(data)
    this.db.raw.prepare('INSERT OR REPLACE INTO art_measured (id, width, height, thumbhash, tint) VALUES (?, ?, ?, ?, ?)').run(p.id, meta.width, meta.height, thumbhash, tint)
  }

  /** Fills in sizes and hashes measured earlier, for pictures the index gives none for. */
  complete(pictures: Picture[]): Picture[] {
    return pictures.map((p) => {
      if (p.width > 0 && p.height > 0 && p.thumbhash) return p
      const m = this.db.raw.prepare('SELECT width, height, thumbhash, tint FROM art_measured WHERE id = ?').get(p.id) as { width: number; height: number; thumbhash: string; tint: string } | undefined
      return m ? { ...p, width: p.width || m.width, height: p.height || m.height, thumbhash: p.thumbhash ?? m.thumbhash, tint: p.tint ?? m.tint } : p
    })
  }

  // ---- keeping the cache ------------------------------------------------------------

  /**
   * Makes every format of every subject for everyone, and for each person who chose something, so
   * pages open with their pictures. Then forgets what nothing uses. Errors are returned, not thrown.
   */
  async sync(subjects: ArtSubject[]): Promise<string[]> {
    const started = Date.now()
    const errors = new Set<string>()
    const used = new Map<string, boolean>()
    const sources = new Set<string>()
    const name = (subject: ArtSubject) => subject.recipe ?? subject.game ?? 'a catalog game'
    for (const given of subjects) {
      let subject = given
      const scopes = [EVERYONE, ...(subject.game ? (this.db.raw.prepare('SELECT DISTINCT scope FROM art_choices WHERE game = ? AND scope != 0').all(subject.game) as Array<{ scope: number }>).map((r) => r.scope) : [])]
      // Chosen pictures the index gives no size for are measured first, so they can be placed.
      for (const scope of scopes) {
        for (const p of Object.values(this.chosen(subject, scope))) {
          if (p.width > 0 && p.height > 0) continue
          sources.add(p.id)
          try {
            await this.measure(p, subject.adult)
          } catch (e) {
            errors.add(`${p.kind} of ${name(subject)} (${p.url ?? 'an upload'}): ${(e as Error).message}`)
          }
        }
      }
      subject = { ...subject, pictures: this.complete(subject.pictures) }
      for (const scope of scopes) {
        for (const plan of Object.values(this.plans(subject, scope))) {
          const key = planKey(plan, plan.source.focal)
          used.set(key, (used.get(key) ?? false) || subject.adult)
          sources.add(plan.source.id)
          try {
            await this.ensure(plan, subject.adult)
          } catch (e) {
            errors.add(`${plan.kind} of ${name(subject)} (${plan.source.url ?? 'an upload'}): ${(e as Error).message}`)
          }
        }
      }
    }
    for (const row of this.db.raw.prepare('SELECT id FROM art_uploads').all() as Array<{ id: string }>) sources.add(row.id)
    await this.prune(used, sources, started)
    return [...errors]
  }

  /** Forgets made pictures and originals nothing uses. Anything made since `since` stays: a request may be about to send it. */
  private async prune(used: Map<string, boolean>, sources: Set<string>, since: number): Promise<void> {
    for (const row of this.db.raw.prepare('SELECT key, created_at FROM art_made').all() as Array<{ key: string; created_at: number }>) {
      if (used.has(row.key)) this.db.raw.prepare('UPDATE art_made SET adult = ? WHERE key = ?').run(used.get(row.key) ? 1 : 0, row.key)
      else if (row.created_at < since) this.db.raw.prepare('DELETE FROM art_made WHERE key = ?').run(row.key)
    }
    const files = new Set((this.db.raw.prepare('SELECT file1x, file2x FROM art_made').all() as Array<{ file1x: string; file2x: string }>).flatMap((r) => [r.file1x, r.file2x]))
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith('.webp') || files.has(name)) continue
      const st = await stat(join(this.dir, name)).catch(() => null)
      if (st && st.mtimeMs < since) await rm(join(this.dir, name), { force: true })
    }
    for (const name of await readdir(this.sources).catch(() => [] as string[])) {
      if (sources.has(name)) continue
      const st = await stat(join(this.sources, name)).catch(() => null)
      if (st && st.mtimeMs < since) await rm(join(this.sources, name), { force: true })
    }
  }

  /**
   * Whether this request may read a made picture (node and nginx's auth subrequest alike). A
   * picture of an adult game is for people at Shown only, and only on a device at Shown.
   */
  canRead(file: string): boolean {
    const rows = this.db.raw.prepare('SELECT adult FROM art_made WHERE file1x = ? OR file2x = ?').all(file, file) as Array<{ adult: number }>
    if (!rows.length) return false
    return rows.some((r) => !r.adult) || this.content.viewerLevel() === 'shown'
  }

  file(name: string): string {
    if (!/^[0-9a-f]{32}\.webp$/.test(name)) throw new HttpError(404, 'Not found')
    return join(this.dir, name)
  }
}

/** A catalog picture the index gave no size for is placed once it is measured. */
function inShapeKnown(p: Picture): boolean {
  return p.width > 0 && p.height > 0 && inShape(p.kind, p)
}

function isImage(b: Buffer): boolean {
  const head = b.subarray(0, 12).toString('latin1')
  return (head.startsWith('RIFF') && head.slice(8) === 'WEBP') || head.startsWith('\x89PNG') || (b[0] === 0xff && b[1] === 0xd8) || head.startsWith('GIF8')
}
