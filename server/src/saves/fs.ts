import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname, relative, isAbsolute } from 'node:path'

export interface SaveEntry {
  name: string
  data: string
}

export interface SaveData {
  entries: SaveEntry[]
}

export class FsStorage {
  constructor(private baseDir: string) {}

  async getSaves(saveDir: string | null): Promise<SaveData | null> {
    try {
      const root = saveDir ? join(this.baseDir, saveDir) : this.baseDir
      const entries = await this.walkDir(root, root)
      return { entries }
    } catch {
      return null
    }
  }

  private async walkDir(base: string, dir: string): Promise<SaveEntry[]> {
    const result: SaveEntry[] = []
    let names
    try {
      names = await readdir(dir, { withFileTypes: true })
    } catch {
      return result
    }
    for (const entry of names) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        result.push(...await this.walkDir(base, full))
      } else if (entry.isFile() && !entry.name.startsWith('.')) {
        const buf = await readFile(full)
        const rel = full.substring(base.length + 1)
        result.push({ name: rel, data: buf.toString('base64') })
      }
    }
    return result
  }

  async putSaves(saveDir: string | null, data: SaveData): Promise<void> {
    const dir = saveDir || ''
    await Promise.all(data.entries.map(async (entry) => {
      const safe = entry.name.replace(/[^a-zA-Z0-9._\/-]/g, '_')
      const full = dir ? join(this.baseDir, dir, safe) : join(this.baseDir, safe)
      const rel = relative(this.baseDir, full)
      if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Path traversal detected')
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, Buffer.from(entry.data, 'base64'))
    }))
  }
}
