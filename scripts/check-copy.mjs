#!/usr/bin/env node
// Checks the writing rule in text people read: no semicolons, em dashes, en dashes or ellipses in
// the interface, the docs, server messages and logs, and the changelog's Unreleased section. Code
// is left alone: only strings and text that read as sentences are checked.
// Usage: node scripts/check-copy.mjs [--docs] (exits 1 and lists each place that breaks the rule).
// The docs are checked with --docs, which CI adds once the docs follow the rule.
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const problems = []

const files = (dir, ext) => {
  const out = []
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (n === 'node_modules' || n === '__tests__' || n.startsWith('.')) continue
      if (statSync(p).isDirectory()) walk(p)
      else if (ext.test(n)) out.push(p)
    }
  }
  walk(join(root, dir))
  return out
}

// A semicolon between words, as in prose ("off; adult"), not code ("a; b()" or "BEGIN; COMMIT").
const semicolon = /[a-z)]; [a-z]/
const dashes = /[—–…]/
const breaks = (text) => /[A-Za-z]{3}/.test(text) && (dashes.test(text) || semicolon.test(text))
const report = (file, line, text) => problems.push(`${relative(root, file)}:${line}: ${text.trim().slice(0, 120)}`)

// Strings in code that are known not to be prose.
// A match that runs between two template strings holds code, which prose never does.
const allowed = [/autoplay; fullscreen/, /\b(var|let|const|function|return|import|throw new|await)\s/, /=>/]

/** Strings and JSX text in the interface. */
for (const file of files('selector/src', /\.(tsx|ts)$/)) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return
    const texts = []
    for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) texts.push(m[1] ?? m[2] ?? m[3] ?? '')
    if (file.endsWith('.tsx')) for (const m of line.matchAll(/(?<![=-])>([^<>{}]+)</g)) texts.push(m[1])
    for (const t of texts) if (breaks(t) && !allowed.some((a) => a.test(t))) report(file, i + 1, t)
  })
}

/** Messages the server sends to people or writes to its log. */
for (const file of files('server/src', /\.ts$/)) {
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/(?:HttpError\(\d+, |log\(['"][\w-]+['"], |console\.(?:warn|error)\(|throw new Error\()(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)) {
      if (breaks(m[2])) report(file, i + 1, m[2])
    }
  })
}

/** Prose in the docs, outside code. */
if (process.argv.includes('--docs')) for (const file of files('docs/site/src/content/docs', /\.mdx?$/)) {
  let fenced = false
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
    if (fenced || /^\s*(<|import |\|?\s*-{3})/.test(line)) return
    const prose = line.replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']').replace(/<[^>]+>/g, '')
    if (breaks(prose)) report(file, i + 1, prose)
  })
}

/** The changelog's Unreleased section (released sections predate the rule). */
{
  const file = join(root, 'CHANGELOG.md')
  const lines = readFileSync(file, 'utf8').split('\n')
  const start = lines.findIndex((l) => l.startsWith('## [Unreleased]'))
  for (let i = start + 1; i < lines.length && !lines[i].startsWith('## ['); i++) {
    const prose = lines[i].replace(/`[^`]*`/g, '')
    if (breaks(prose)) report(file, i + 1, prose)
  }
}

if (problems.length) {
  console.error(`The writing rule (no semicolons, em or en dashes, or ellipses in text people read) is broken in ${problems.length} ${problems.length === 1 ? 'place' : 'places'}:`)
  for (const p of problems) console.error(`  ${p}`)
  process.exit(1)
}
console.log('Copy follows the writing rule.')
