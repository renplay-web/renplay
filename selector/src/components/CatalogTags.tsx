import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Chip, Pill } from '../lantern/controls'
import Sheet from '../lantern/Sheet'
import { api, put, type Vocabulary } from '../lib/api'
import { gameTags } from '../lib/tags'

export interface TagPrefs {
  include: string[]
  exclude: string[]
}

type Tagged = Parameters<typeof gameTags>[0]
type State = 'off' | 'include' | 'exclude'

const GROUPS: Array<[string, string]> = [
  ['play', 'Play'],
  ['story', 'Story'],
  ['art', 'Art'],
  ['protagonist', 'Protagonist'],
  ['content', 'Content'],
]

/** Whether a game passes the tags: every included one, none of the left out ones. */
export function matchesTags(game: Tagged, prefs: TagPrefs, vocabulary: Vocabulary): boolean {
  if (!prefs.include.length && !prefs.exclude.length) return true
  const ids = new Set(gameTags(game, vocabulary).map((t) => t.id))
  return prefs.include.every((t) => ids.has(t)) && !prefs.exclude.some((t) => ids.has(t))
}

/**
 * The tags this person includes and leaves out on the Catalog page, kept with their account. The
 * answer comes from the server, changes are saved after a short pause.
 */
export function useTagPrefs(): [TagPrefs, (next: TagPrefs) => void] {
  const qc = useQueryClient()
  const { data } = useQuery({ queryKey: ['me-tags'], queryFn: () => api<TagPrefs>('/api/me/tags'), staleTime: 60_000 })
  const [local, setLocal] = useState<TagPrefs | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const set = (next: TagPrefs) => {
    setLocal(next)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void put<TagPrefs>('/api/me/tags', next).then((saved) => qc.setQueryData(['me-tags'], saved)).catch(() => {})
    }, 600)
  }
  return [local ?? data ?? { include: [], exclude: [] }, set]
}

function stateOf(prefs: TagPrefs, id: string): State {
  return prefs.include.includes(id) ? 'include' : prefs.exclude.includes(id) ? 'exclude' : 'off'
}

function withState(prefs: TagPrefs, id: string, state: State): TagPrefs {
  const include = prefs.include.filter((t) => t !== id)
  const exclude = prefs.exclude.filter((t) => t !== id)
  if (state === 'include') include.push(id)
  if (state === 'exclude') exclude.push(id)
  return { include, exclude }
}

/**
 * Tag chips for the catalog: a tap includes a tag, the next leaves it out, the next clears it.
 * All tags opens every tag by group, with how many of the games shown have it.
 */
export default function CatalogTags({ games, vocabulary, prefs, onChange, excludeOnly = false }: { games: Tagged[]; vocabulary: Vocabulary; prefs: TagPrefs; onChange: (next: TagPrefs) => void; excludeOnly?: boolean }) {
  const [all, setAll] = useState(false)
  const counts = new Map<string, { id: string; label: string; group: string; count: number }>()
  for (const g of games) for (const t of gameTags(g, vocabulary)) {
    const e = counts.get(t.id) ?? { id: t.id, label: t.label, group: t.group, count: 0 }
    e.count++
    counts.set(t.id, e)
  }
  const chosen = [...prefs.include, ...prefs.exclude]
  // The row: chosen tags first, then the most common play and story tags.
  const common = [...counts.values()].filter((t) => (t.group === 'play' || t.group === 'story') && t.count >= 2 && !chosen.includes(t.id)).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
  const label = (id: string) => counts.get(id)?.label ?? vocabulary[id]?.label ?? id
  // Leaving out only (the defaults for everyone): off and left out.
  const next = (id: string): State => (excludeOnly ? (stateOf(prefs, id) === 'exclude' ? 'off' : 'exclude') : ({ off: 'include', include: 'exclude', exclude: 'off' } as const)[stateOf(prefs, id)])
  const chip = (id: string, n?: number) => {
    const state = stateOf(prefs, id)
    return (
      <Chip
        key={id}
        on={state === 'include'}
        ex={state === 'exclude'}
        n={n}
        aria-label={`${label(id)}, ${state === 'include' ? 'included' : state === 'exclude' ? 'left out' : 'any'}`}
        onClick={() => onChange(withState(prefs, id, next(id)))}
      >
        {label(id)}
      </Chip>
    )
  }
  return (
    <>
      <div className="chips wrap" style={{ marginBottom: 16 }}>
        {chosen.map((id) => chip(id, counts.get(id)?.count ?? 0))}
        {common.slice(0, Math.max(0, 8 - chosen.length)).map((t) => chip(t.id, t.count))}
        <Chip onClick={() => setAll(true)}>All tags</Chip>
        {chosen.length > 0 && <Chip onClick={() => onChange({ include: [], exclude: [] })}>Clear tags</Chip>}
      </div>
      {all && (
        <Sheet open onClose={() => setAll(false)} title="Tags" wide fullPhone>
          <p className="small muted" style={{ marginBottom: 16 }}>
            {excludeOnly
              ? 'Games with a tag left out here are hidden in the catalog for everyone who has not chosen their own tags.'
              : 'Include a tag to see only games that have it. Leave one out to hide games that have it. Your choices are kept for next time, on every device.'}
          </p>
          <div className="stack" style={{ gap: 20 }}>
            {GROUPS.map(([group, title]) => {
              const tags = [...counts.values()].filter((t) => t.group === group).sort((a, b) => a.label.localeCompare(b.label))
              if (!tags.length) return null
              return (
                <section key={group}>
                  <h3 className="small" style={{ fontWeight: 650, marginBottom: 6 }}>{title}</h3>
                  <div className="list tight">
                    {tags.map((t) => {
                      const state = stateOf(prefs, t.id)
                      return (
                        <div key={t.id} className="row between" style={{ gap: 12, minHeight: 'var(--hit)' }}>
                          <span>
                            {t.label} <span className="muted tnum">{t.count}</span>
                          </span>
                          <span className="row" style={{ gap: 6 }}>
                            {!excludeOnly && <Pill variant={state === 'include' ? 'p' : 'q'} size="sm" aria-pressed={state === 'include'} onClick={() => onChange(withState(prefs, t.id, state === 'include' ? 'off' : 'include'))}>
                              Include
                            </Pill>}
                            <Pill variant={state === 'exclude' ? 'd' : 'q'} size="sm" aria-pressed={state === 'exclude'} onClick={() => onChange(withState(prefs, t.id, state === 'exclude' ? 'off' : 'exclude'))}>
                              Leave out
                            </Pill>
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </section>
              )
            })}
          </div>
        </Sheet>
      )}
    </>
  )
}
