import { Link } from 'react-router-dom'
import { Check, ExternalLink, Plus } from 'lucide-react'
import { Frame } from '../lantern/art'
import { Pill, TagPill } from '../lantern/controls'
import { BetaBadge } from './ui'
import type { Recipe } from '../lib/api'
import { stateLabel, gameTags } from '../lib/tags'
import { recipeLinks } from '../lib/links'
import { useCatalog } from '../lib/queries'

/** A catalog recipe, as the sheet a catalog tile opens: what it is, where to get it, how it installs. */
export default function RecipeCard({ recipe: r }: { recipe: Recipe }) {
  const { data: catalog } = useCatalog()
  const latest = r.releases[0]
  const broken = latest?.status === 'broken'
  const links = recipeLinks(r.links)
  const tags = gameTags(r, catalog?.vocabulary ?? {})
  const primary = tags.filter((t) => t.group !== 'content')
  return (
    <div>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <div style={{ width: 110, flex: 'none' }}>
          <Frame game={r} kind="grid" />
        </div>
        <div className="grow">
          <h2 className="h2">{r.title}</h2>
          <p className="small muted-2" style={{ marginTop: 3 }}>
            {[r.developer && `By ${r.developer}`, r.state && stateLabel[r.state], latest?.version].filter(Boolean).join(' · ')}
          </p>
          <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
            {r.free === true && <TagPill tone="green">Free</TagPill>}
            {r.fromYourRecipes && <TagPill>From your recipes</TagPill>}
            <BetaBadge engine={r.engine} />
            {broken && <TagPill tone="red">Does not work</TagPill>}
            {r.local && (
              <Link to={`/game/${r.local.id}`}>
                <TagPill tone="pink">
                  <Check /> In your library
                </TagPill>
              </Link>
            )}
          </div>
        </div>
      </div>
      {r.summary && (
        <p className="small muted-2" style={{ marginTop: 14, lineHeight: 1.55 }}>
          {r.summary}
        </p>
      )}
      {!!primary.length && (
        <div className="row wrap" style={{ gap: 6, marginTop: 10 }}>
          {primary.map((t) => (
            <span key={t.id} className="tag">
              {t.label}
            </span>
          ))}
        </div>
      )}
      {broken && (
        <p className="small amber" style={{ marginTop: 12 }}>
          This release does not work in Renplay. Check the developer’s downloads for a newer one.
        </p>
      )}
      {!r.local && (
        <div className="list" style={{ marginTop: 14 }}>
          <div>
            <div className="h3">Play it in Renplay</div>
            <ol className="small muted-2" style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
              <li>Get {latest?.archives[0]?.name ? <b>{latest.archives[0].name}</b> : 'the PC download'} from the developer.</li>
              <li>Add the download on the Add games page, or copy it into the downloads folder.</li>
              <li>Renplay recognizes it and installs it. Your saves carry over.</li>
            </ol>
          </div>
        </div>
      )}
      <div className="actions" style={{ marginTop: 16 }}>
        {r.local ? (
          <Pill variant="p" size="sm" to={`/game/${r.local.id}`}>
            Open in your library
          </Pill>
        ) : (
          <Pill variant="p" size="sm" to="/add" icon={<Plus />}>
            Add the download
          </Pill>
        )}
        {links.map(([k, label, url]) => (
          <Pill key={k} variant="s" size="sm" href={url} target="_blank" rel="noreferrer" icon={<ExternalLink />}>
            {label}
          </Pill>
        ))}
      </div>
    </div>
  )
}
