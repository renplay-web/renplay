import { createHash } from 'node:crypto'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { basename, extname, sep } from 'node:path'
import sharp from 'sharp'
import YAML from 'yaml'
import type { CatalogImage } from './art.js'
import { normalizeRecipe, type Recipe, type Vocabulary } from './catalog.js'
import { MAX_IMAGE_PIXELS } from './pipeline/image-memory.js'
import { cleanRelPath, safeJoin } from './util/paths.js'

/*
 * Your recipes: a folder of recipe files, in the catalog's own format (recipes/<id>.yaml in
 * renplay-org/catalog), read like one more catalog. A recipe here with the id of a catalog recipe
 * takes its place, so one entry can be fixed without a fork. Art and patches may be files in the
 * folder (art: [{ kind: grid, file: art/my-game/grid.png }], patches under patches/<id>/), checked
 * and hashed here as the catalog's build does.
 */

export interface LocalRecipes {
  games: Recipe[]
  /** A file that could not be read, or a part of one that was left out. */
  problems: Array<{ file: string; message: string; recipe?: string }>
}

/** Groups whose tags show as chips in Renplay 2.9 and older (the index's `tags`). */
const CHIP_GROUPS = new Set(['play', 'story'])
const KINDS = new Set(['grid', 'wide', 'hero', 'logo', 'icon'])
const MB = 1024 * 1024

/** Reads a file in the folder, refusing links that lead out of it and files over `max` bytes. */
async function readInside(dir: string, rel: string, max: number): Promise<Buffer> {
  const root = await realpath(dir)
  const path = await realpath(safeJoin(dir, cleanRelPath(rel)))
  if (!path.startsWith(root + sep)) throw new Error('it is outside the folder')
  if ((await stat(path)).size > max) throw new Error(`it is larger than ${max / MB} MB`)
  return readFile(path)
}

export async function readLocalRecipes(dir: string, vocabulary: Vocabulary): Promise<LocalRecipes> {
  const out: LocalRecipes = { games: [], problems: [] }
  const names = await readdir(dir).catch(() => [] as string[])
  for (const file of names.filter((n) => /\.ya?ml$/i.test(n) && !n.startsWith('_') && !n.startsWith('.')).sort()) {
    // Problems name the recipe the file is for, so one about an adult game shows only where it is shown.
    const id = basename(file, extname(file))
    const problem = (message: string) => out.problems.push({ file, message, recipe: id })
    let r: any
    try {
      r = YAML.parse((await readInside(dir, file, MB)).toString('utf8'))
    } catch (e) {
      problem(`not valid YAML: ${(e as Error).message.split('\n')[0]}`)
      continue
    }
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      problem('not a recipe')
      continue
    }
    if (r.id !== id) {
      problem(`the id must be ${id}, the file's name`)
      continue
    }
    if (typeof r.title !== 'string' || !r.title.trim()) {
      problem('a recipe needs a title')
      continue
    }
    if (!Array.isArray(r.releases)) {
      problem('a recipe needs releases, even an empty list')
      continue
    }
    const releases = r.releases.filter((x: unknown) => x && typeof x === 'object' && !Array.isArray(x))
    if (releases.length < r.releases.length) problem('a release that is not a list of fields was left out')
    for (const key of ['build', 'saveDir'] as const) {
      const ok = key === 'build' ? r.build && typeof r.build === 'object' && !Array.isArray(r.build) : typeof r.saveDir === 'string'
      if (r[key] !== undefined && !ok) {
        problem(`${key} was left out: it is not in the catalog's format`)
        delete r[key]
      }
    }
    const recipe: Recipe = { ...normalizeRecipe({ ...r, releases, engine: typeof r.engine === 'string' ? r.engine : 'renpy' }), _origin: 'local' }
    // Adult unless it says otherwise: a copied adult recipe without its nsfw line stays out at Off.
    if (typeof r.nsfw !== 'boolean') {
      recipe.nsfw = true
      problem('it has no nsfw line, so it counts as an adult game')
    }
    // Tags as the catalog's build publishes them: ids, and the chip labels older clients read.
    if (Array.isArray(r.tags)) {
      const ids = r.tags.filter((t: unknown): t is string => typeof t === 'string')
      const unknown = ids.filter((t: string) => !vocabulary[t])
      if (unknown.length) problem(`unknown tags left out: ${unknown.join(', ')}`)
      const known = ids.filter((t: string) => vocabulary[t])
      recipe.tagIds = known
      recipe.tags = known.filter((t: string) => CHIP_GROUPS.has(vocabulary[t]!.group)).map((t: string) => vocabulary[t]!.label.toLowerCase())
    }
    // Art: addresses as they are, files in the folder hashed and measured.
    if (Array.isArray(r.art)) {
      const art: CatalogImage[] = []
      for (const a of r.art) {
        if (!a || typeof a !== 'object' || !KINDS.has(a.kind)) {
          problem('a picture without a known kind (grid, wide, hero, logo or icon) was left out')
          continue
        }
        if (typeof a.file === 'string') {
          try {
            const rel = cleanRelPath(a.file)
            const data = await readInside(dir, rel, 16 * MB)
            const meta = await sharp(data, { failOn: 'error', limitInputPixels: MAX_IMAGE_PIXELS }).metadata()
            if (!meta.width || !meta.height) throw new Error('not a picture')
            const { file: _f, ...rest } = a
            art.push({ ...rest, url: `local:${rel}`, source: a.source ?? 'developer', sha256: createHash('sha256').update(data).digest('hex'), width: meta.width, height: meta.height })
          } catch (e) {
            problem(`picture ${a.file} left out: ${(e as Error).message}`)
          }
        } else if (typeof a.url === 'string' && /^https?:\/\//.test(a.url)) art.push({ source: 'developer', ...a })
        else problem('a picture needs a file in this folder or an http(s) url')
      }
      recipe.art = art
    }
    // Patches: files under patches/<id>/, as in the catalog.
    if (Array.isArray(r.build?.patches)) {
      const patches = []
      for (const p of r.build.patches) {
        try {
          if (typeof p?.path !== 'string' || typeof p?.file !== 'string') throw new Error('a patch needs a path and a file')
          const rel = cleanRelPath(`patches/${id}/${p.file}`)
          const data = await readInside(dir, rel, 64 * MB)
          patches.push({ path: p.path, url: `local:${rel}`, sha256: createHash('sha256').update(data).digest('hex') })
        } catch (e) {
          problem(`patch left out: ${(e as Error).message}`)
        }
      }
      recipe.build = { ...r.build, patches }
    }
    out.games.push(recipe)
  }
  return out
}

/** Reads a file a local recipe names (`local:<path in the folder>`). */
export function readLocalFile(dir: string, url: string): Promise<Buffer> {
  return readInside(dir, url.slice('local:'.length), 64 * MB)
}
