import { useQueryClient } from '@tanstack/react-query'
import { Check, ExternalLink, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import Card from '../lantern/Tile'
import { Pill, Seg, TagPill } from '../lantern/controls'
import { useRoom } from '../lantern/Room'
import Sheet from '../lantern/Sheet'
import RecipeCard from '../components/RecipeCard'
import CatalogTags, { matchesTags, useTagPrefs } from '../components/CatalogTags'
import { Button, Empty, Spinner, errorText } from '../components/ui'
import type { Recipe } from '../lib/api'
import { ago } from '../lib/format'
import { post } from '../lib/api'
import { useCatalog } from '../lib/queries'
import { matchesSearch, stateLabel } from '../lib/tags'

const REQUEST_URL = 'https://renplay.org/catalog/request'

/** One catalog entry: the grid tile with In your library and Free pills, opening the recipe sheet. */
function RecipeTile({ recipe: r, onOpen }: { recipe: Recipe; onOpen: () => void }) {
  const extra = r.local ? (
    <span className="corner">
      <TagPill tone="dark">
        <Check />
        <span className="lbl">In your library</span>
      </TagPill>
    </span>
  ) : r.free === true ? (
    <span className="corner">
      <TagPill tone="dark">Free</TagPill>
    </span>
  ) : undefined
  return (
    <Card
      game={r}
      href={r.local ? `/game/${r.local.id}` : `/catalog?game=${r.id}`}
      meta={
        <span className="truncate">
          {[r.developer, r.state && stateLabel[r.state]].filter(Boolean).join(' · ')}
          {r.engine && r.engine !== 'renpy' ? ' · Beta' : ''}
        </span>
      }
      extra={extra}
      // Not installed recipes open the sheet instead of travelling.
      onClick={r.local ? undefined : (e) => { e.preventDefault(); onOpen() }}
    />
  )
}

export default function Catalog() {
  const { data, isLoading, error, refetch } = useCatalog()
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const [tagPrefs, setTagPrefs] = useTagPrefs()
  const [limit, setLimit] = useState(36)
  const [filter, setFilter] = useState('all')
  const [sheetFor, setSheetFor] = useState<Recipe | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  useRoom({ game: null, quiet: true })
  if (isLoading) return <Spinner />
  if (error || !data)
    return (
      <Empty title="Could not load the catalog" action={<Button onClick={() => void refetch()}>Retry</Button>}>
        {errorText(error)}
      </Empty>
    )
  const all = data.games
  const vocabulary = data.vocabulary
  // Search and the segment first, so the tag counts say how many of these games have each tag.
  const shown = all.filter((g) => matchesSearch(g, search, vocabulary) && (filter === 'all' || (filter === 'free' ? g.free === true || (g.free === undefined && g.nsfw === false) : g.state === 'completed')))
  const filtered = shown.filter((g) => matchesTags(g, tagPrefs, vocabulary))
  const sheet = sheetFor && all.find((r) => r.id === sheetFor.id)
  return (
    <div>
      <div className="row between wrap" style={{ gap: 12 }}>
        <div>
          <h1 className="h1">Catalog</h1>
          <p className="lead" style={{ marginTop: 6 }}>
            Games tested in Renplay. Get one from its developer and add the download, Renplay recognizes it and uses the right settings.
          </p>
        </div>
        <div className="actions">
          <Button size="sm" loading={refreshing} icon={<RefreshCw />} onClick={async () => {
            setRefreshing(true)
            try {
              await post('/api/catalog/refresh')
              await refetch()
              void qc.invalidateQueries({ queryKey: ['archives'] })
            } finally {
              setRefreshing(false)
            }
          }}>
            Refresh
          </Button>
          <Pill variant="s" size="sm" href={REQUEST_URL} target="_blank" rel="noreferrer" icon={<ExternalLink />}>
            Request a game
          </Pill>
        </div>
      </div>
      {(() => {
        // A catalog that could not be read, or recipe files of your own with problems: said apart.
        const sources = data.status.sources
        const unreachable = sources ? sources.some((s) => s.kind === 'catalog' && s.problems.length > 0) : data.status.errors.length > 0
        const local = sources?.find((s) => s.kind === 'folder')?.problems.length ?? 0
        return (
          <>
            {unreachable && (
              <p className="small amber" style={{ marginTop: 10 }}>
                Could not reach the catalog. Last updated {ago(data.status.fetchedAt)}.
              </p>
            )}
            {local > 0 && (
              <p className="small amber" style={{ marginTop: 16 }}>
                {local === 1 ? 'A file in Your recipes has a problem' : `${local} files in Your recipes have problems`}. <Link to="/settings" className="link">Settings</Link> says which.
              </p>
            )}
          </>
        )
      })()}
      <div className="toolbar" style={{ marginTop: 14 }}>
        <input aria-label="Search the catalog" placeholder="Search the catalog" value={search} onChange={(e) => { setSearch(e.target.value); setLimit(36) }} className="input" />
        <Seg
          small
          value={filter}
          onChange={(value) => {
            setFilter(value)
            setLimit(36)
          }}
          options={[
            { value: 'all', label: `All ${filtered.length}` },
            { value: 'free', label: 'Free' },
            { value: 'completed', label: 'Completed' },
          ]}
        />
      </div>
      <CatalogTags
        games={shown}
        vocabulary={vocabulary}
        prefs={tagPrefs}
        onChange={(next) => {
          setTagPrefs(next)
          setLimit(36)
        }}
      />
      {!filtered.length ? (
        <Empty title="No games match" action={<Button onClick={() => { setSearch(''); setTagPrefs({ include: [], exclude: [] }); setFilter('all') }}>Clear filters</Button>}>
          Nothing in the catalog matches. Try a different search or tag.
        </Empty>
      ) : (
        <div className="grid" data-row>
          {filtered.slice(0, limit).map((r) => (
            <RecipeTile key={r.id} recipe={r} onOpen={() => setSheetFor(r)} />
          ))}
        </div>
      )}
      <p className="small muted" style={{ marginTop: 18 }}>
        Showing {Math.min(limit, filtered.length)} of {filtered.length}
        {data.status.fetchedAt ? ` · Updated ${ago(data.status.fetchedAt, true)}` : ''}
      </p>
      {filtered.length > limit && (
        <div className="center" style={{ marginTop: 14 }}>
          <Button onClick={() => setLimit(limit + 36)}>Show more</Button>
        </div>
      )}
      {sheet && (
        <Sheet open onClose={() => setSheetFor(null)} wide>
          <RecipeCard recipe={sheet} />
        </Sheet>
      )}
    </div>
  )
}
