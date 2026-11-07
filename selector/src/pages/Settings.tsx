import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, ExternalLink, FileCode2, HardDrive, Package, RefreshCw, Upload } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import RecipeDialog from '../components/RecipeDialog'
import DocsLink from '../components/DocsLink'
import { Button, Confirm, Modal, Progress, Spinner, errorText, useToast } from '../components/ui'
import { LevelSeg, DeviceAdultRow } from '../components/AdultLadder'
import { Seg, SourceLabel, LanternSwitch } from '../lantern/controls'
import CatalogTags from '../components/CatalogTags'
import { useRoom } from '../lantern/Room'
import { api, del, post, put, type CatalogSource, type SystemInfo } from '../lib/api'
import { setLighterBackground, useLighterBackground } from '../lib/backdrop'
import { ago, bytes } from '../lib/format'
import { useAuth } from '../lib/auth'
import { adultLabels, adultLevels, type AdultLevel } from '../lib/adult'
import { useCatalog, useContent, useDefaults, useGames, useSetInstallationLevel, useSystem, type Defaults } from '../lib/queries'

function DiskBar({ label, disk }: { label: string; disk: { total: number; free: number } | null }) {
  if (!disk) return null
  const used = disk.total - disk.free
  return (
    <div>
      <div className="row between small" style={{ marginBottom: 6 }}>
        <span className="muted-2">{label}</span>
        <span className="muted">
          {bytes(disk.free)} free of {bytes(disk.total)}
        </span>
      </div>
      <Progress value={used / disk.total} />
    </div>
  )
}

const installationHint: Record<AdultLevel, string> = {
  off: 'Adult games are hidden for everyone and cannot be installed. Games already in the library stay, hidden.',
  blurred: 'Adult games show for everyone whose account allows it, without their pictures. Renplay never downloads their art.',
  shown: 'Adult games and their pictures show for everyone whose account allows it.',
}

function Setting({ title, hint, source, inline, children }: { title: string; hint?: ReactNode; source?: ReactNode; inline?: boolean; children: ReactNode }) {
  return (
    <div className={`setting ${inline ? 'inline' : ''}`}>
      <div className="l">
        <div className="t">{title}</div>
        {hint && <div className="d">{hint}</div>}
        {source}
      </div>
      <div className="c">{children}</div>
    </div>
  )
}

export default function Settings() {
  const { data } = useAuth()
  useRoom({ game: null, quiet: true })
  return data?.user.role === 'admin' ? <AdminSettings auth={data.auth} userName={data.user.name} /> : <BrowserSettings />
}

function BrowserSettings() {
  return (
    <div className="stack" style={{ gap: 18, maxWidth: 760 }}>
      <h1 className="h1">This browser</h1>
      <section className="panel stack">
        <DeviceAdultRow />
        <LighterBackground />
        <KeepCache />
      </section>
    </div>
  )
}

function LighterBackground() {
  const { on, from } = useLighterBackground()
  return (
    <Setting
      title="Lighter background"
      hint="A plain background instead of the game’s art behind each screen. It uses less data and battery. Until you choose, it follows this device’s reduced motion and data saver settings."
      inline
      source={<SourceLabel kind={from === 'chosen' ? 'here' : from === 'admin' ? 'admin' : 'def'} />}
    >
      <LanternSwitch checked={on} label="Lighter background" onChange={setLighterBackground} />
    </Setting>
  )
}

function KeepCache() {
  const [persisted, setPersisted] = useState<boolean | null>(null)
  return (
    <Setting title="Keep game cache" hint="Game data (not saves) is cached in the browser so games start instantly the next time. Ask the browser to keep that cache from being cleared automatically.">
      <Button
        size="sm"
        onClick={async () => {
          const ok = (await navigator.storage?.persist?.()) ?? false
          setPersisted(ok)
        }}
      >
        Keep game cache
      </Button>
      {persisted !== null && <span className="xs muted">{persisted ? 'The browser will keep the cache.' : 'The browser declined. It may still keep it.'}</span>}
    </Setting>
  )
}

const SECTIONS: Array<[string, string]> = [
  ['general', 'General'],
  ['browser', 'This browser'],
  ['about', 'About'],
]

function AdminSettings({ auth, userName }: { auth: boolean; userName: string }) {
  const { data: sys, isLoading } = useSystem()
  const { data: catalog } = useCatalog()
  const { data: games } = useGames()
  const installed = (games ?? []).filter((g) => g.status === 'installed')
  const [section, setSection] = useState('general')
  const [recipeFor, setRecipeFor] = useState('')
  const recipeGame = installed.find((g) => g.id === recipeFor)
  const [recipeOpen, setRecipeOpen] = useState(false)
  const [storageOpen, setStorageOpen] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  const { data: content } = useContent()
  const setInstallationLevel = useSetInstallationLevel()
  const [raiseTo, setRaiseTo] = useState<AdultLevel | null>(null)
  if (isLoading || !sys) return <Spinner />
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      toast(ok, 'success')
      void qc.invalidateQueries()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }
  return (
    <div>
      <h1 className="h1" style={{ marginBottom: 18 }}>Settings</h1>
      <div className="split">
        <nav className="side-nav" aria-label="Settings sections">
          <span className="grp">Server</span>
          {SECTIONS.map(([value, label]) => (
            <button key={value} onClick={() => setSection(value)} aria-current={section === value ? 'page' : undefined} className={section === value ? 'on' : ''}>
              {label}
            </button>
          ))}
          <span className="grp">People</span>
          <Link to="/settings/users">Users</Link>
          <Link to="/activity">Activity</Link>
        </nav>
        <div className="body stack" style={{ gap: 18 }}>
          <div className={section === 'general' ? 'stack' : 'hidden'} style={{ gap: 18 }}>
            {!auth && (
              <section className="panel">
                <Setting
                  title="Sign-in is off"
                  hint={`Everyone who opens this address plays as ${userName}. That is fine on a private network. Turn it on when more people or the internet can reach it.`}
                  source={sys?.setBy?.['RENPLAY_AUTH'] === 'server' ? <SourceLabel kind="server" label="RENPLAY_AUTH" /> : <SourceLabel kind="def" />}
                >
                  <Button size="sm" onClick={() => window.open('https://renplay.org/docs/accounts/', '_blank', 'noreferrer')}>
                    How to turn it on
                  </Button>
                </Setting>
              </section>
            )}
            {content && (
              <section className="panel">
                <h2 className="h3" style={{ marginBottom: 10 }}>Adult games</h2>
                <div className="ladder">
                  <div className="lrow">
                    <div className="l">
                      <div className="t">This installation</div>
                      <div className="d">{installationHint[content.installation.level]}</div>
                      {content.installation.fixed ? <SourceLabel kind="server" label={content.installation.variable} /> : content.installation.chosen ? <SourceLabel kind="here" /> : <SourceLabel kind="def" />}
                    </div>
                    <LevelSeg
                      label="This installation"
                      value={content.installation.level}
                      onChange={
                        content.installation.fixed
                          ? undefined
                          : (level) => {
                              if (level === content.installation.level) return
                              if (adultLevels.indexOf(level) > adultLevels.indexOf(content.installation.level)) setRaiseTo(level)
                              else void run(() => setInstallationLevel(level), 'Adult games level saved')
                            }
                      }
                    />
                  </div>
                </div>
                {content.starting && (
                  <p className="small muted" style={{ marginTop: 12 }}>
                    New people start at {adultLabels[content.starting.level]}, set with <code>{content.starting.variable}</code>. Change one person in <Link to="/settings/users" className="link">Users</Link>.
                  </p>
                )}
                {content.groups && (content.groups.oidc || content.groups.ldap) && (
                  <div className="small muted stack" style={{ marginTop: 10, gap: 6 }}>
                    <p>Sign-in groups set the highest level of their members, at each sign-in. They replace the setting in Users.</p>
                    <ul className="stack" style={{ gap: 4, paddingLeft: 18 }}>
                      {content.groups.oidc && Object.entries(content.groups.oidc.map).map(([group, level]) => <li key={`oidc-${group}`}>Single sign-on group <span className="muted-2">{group}</span>: {adultLabels[level]}</li>)}
                      {content.groups.ldap?.map && Object.entries(content.groups.ldap.map).map(([group, level]) => <li key={`ldap-${group}`}>LDAP group <span className="muted-2">{group}</span>: {adultLabels[level]}</li>)}
                      {content.groups.ldap && !content.groups.ldap.map && <li>LDAP entries that match <code>{content.groups.ldap.variable}</code>: Shown, others Off</li>}
                    </ul>
                    <p className="xs">Set with {[content.groups.oidc?.variable, content.groups.ldap?.variable].filter(Boolean).join(' and ')}.</p>
                  </div>
                )}
                <p style={{ marginTop: 'var(--s4)' }}>
                  <DocsLink path="start-here/adult-games/">Adult games</DocsLink>
                </p>
              </section>
            )}
            <Confirm open={!!raiseTo} onClose={() => setRaiseTo(null)} title={raiseTo === 'shown' ? 'Show adult games and their pictures?' : 'Show adult games without pictures?'} confirmLabel={raiseTo ? `Set to ${adultLabels[raiseTo]}` : 'Confirm'} onConfirm={() => void run(() => setInstallationLevel(raiseTo!), 'Adult games level saved').then(() => setRaiseTo(null))}>
              {raiseTo ? installationHint[raiseTo] : null}
            </Confirm>
            <section className="panel">
              <h2 className="h3 row" style={{ gap: 8, marginBottom: 12 }}>
                <HardDrive style={{ width: 18, height: 18 }} /> Storage
              </h2>
              <div className="list">
                <div className="stack" style={{ gap: 14 }}>
                  <DiskBar label="Games volume" disk={sys.disk.games} />
                  <DiskBar label="Data (saves, database)" disk={sys.disk.data} />
                  <p className="small muted">
                    {sys.library.installed} of {sys.library.games} games installed, {bytes(sys.library.bytes)} in total.
                  </p>
                  <div>
                    <Button size="sm" onClick={() => setStorageOpen(true)}>
                      Show what uses space
                    </Button>
                  </div>
                  <div className="stack xs muted" style={{ gap: 4, overflowWrap: 'anywhere' }}>
                    {(
                      [
                        ['Games', sys.paths.games, 'GAMES_DIR'],
                        ['Downloads', sys.paths.archives, 'ARCHIVES_DIR'],
                        ['Data', sys.paths.data, 'DATA_DIR'],
                      ] as const
                    ).map(([name, path, variable]) => (
                      <div key={name} className="row wrap" style={{ gap: 8 }}>
                        <span>
                          {name} <code>{path}</code>
                        </span>
                        {setBy(sys, variable)}
                      </div>
                    ))}
                  </div>
                </div>
                <Setting
                  title="Keep downloads"
                  hint="Keep downloads so games can be reinstalled. Off deletes only uploads through Renplay after a successful install. Files copied in are never deleted automatically."
                  inline
                  source={sys.keepDownloadsLocked ? <SourceLabel kind="server" label="RENPLAY_KEEP_DOWNLOADS" /> : <SourceLabel kind={sys.keepDownloadsChosen ? 'here' : 'def'} />}
                >
                  {!sys.keepDownloadsLocked ? (
                    <LanternSwitch checked={sys.keepDownloads} label="Keep downloads" onChange={(on) => void run(() => put('/api/system/downloads', { keepDownloads: on }), 'Download preference saved')} />
                  ) : (
                    <span className="xs muted">{sys.keepDownloads ? 'On' : 'Off'}</span>
                  )}
                </Setting>
                {sys.purging > 0 && <p className="xs muted">Deleting {sys.purging} removed item{sys.purging === 1 ? '' : 's'} in the background.</p>}
                {sys.orphans.length > 0 && <p className="xs amber">Folders in the games folder that belong to no game: {sys.orphans.join(', ')}. Renplay leaves them alone.</p>}
              </div>
            </section>

            <section className="panel">
              <h2 className="h3 row" style={{ gap: 8, marginBottom: 6 }}>
                <Package style={{ width: 18, height: 18 }} /> Ren’Py engines
              </h2>
              <p className="small muted">Games run on the official Ren’Py web engine of a matching version, downloaded the first time a game needs it and shared by all games that use it. Unused engines are removed automatically.</p>
              <div className="list tight small" style={{ marginTop: 10 }}>
                {sys.engines.installed.length === 0 && <p className="muted">None installed yet.</p>}
                {sys.engines.installed.map((e) => (
                  <div key={e.version} className="row between">
                    <span>Ren’Py {e.version}</span>
                    <span className="xs muted" style={{ textAlign: 'right' }}>
                      {bytes(e.bytes)} · {e.usedBy.length ? installed.filter((g) => g.engine === e.version).map((g) => g.title).join(', ') || 'Games are loading' : 'Unused'}
                    </span>
                  </div>
                ))}
              </div>
              <p className="xs muted" style={{ marginTop: 10 }}>
                {sys.engines.available.length ? `Available: ${sys.engines.available.map((e) => e.version).join(', ')}` : 'The engine index is unreachable.'} ·{' '}
                <a className="link-q" href="https://renplay.org/github/engines" target="_blank" rel="noreferrer">
                  Engines on GitHub
                </a>
              </p>
              {sys.engines.installed.some((e) => !e.usedBy.length) && (
                <div style={{ marginTop: 12 }}>
                  <Button size="sm" onClick={() => run(() => post('/api/system/prune'), 'Unused engines removed')}>
                    Remove unused engines
                  </Button>
                </div>
              )}
            </section>

            <section className="panel">
              <h2 className="h3" style={{ marginBottom: 6 }}>Saves</h2>
              <p className="small muted">Every save, autosave and persistent change is stored on the server when the game writes it, with previous versions kept. Export everything as a zip that works with desktop Ren’Py, or bring in the saves from a computer.</p>
              <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
                <Button size="sm" icon={<Download />} href="/api/saves-export">
                  Export all saves
                </Button>
                <Button size="sm" icon={<Upload />} to="/import-saves">
                  Import from a computer
                </Button>
              </div>
              {sys?.sync && (
                <div style={{ marginTop: 16 }}>
                  <Setting
                    title="Sync codes"
                    hint="Let people move a game’s saves to and from desktop or Android Ren’Py with a code, as Ren’Py’s own Upload Sync and Download Sync do. Saves leave this server only when someone asks for a code, encrypted, to Ren’Py’s sync server, which keeps them for an hour."
                    inline
                    source={<SourceLabel kind={sys.sync.chosen ? 'here' : 'def'} />}
                  >
                    <LanternSwitch checked={sys.sync.on} label="Sync codes" onChange={(on) => void run(() => put('/api/system/sync', { on }), on ? 'Sync codes are on' : 'Sync codes are off')} />
                  </Setting>
                </div>
              )}
              <SaveBackups />
            </section>

            <section className="panel">
              <h2 className="h3" style={{ marginBottom: 6 }}>Catalog</h2>
              <p className="small muted">
                Titles, art and install settings come from {catalog?.status.count ?? 0} recipes in the catalog{catalog?.status.fetchedAt ? `, updated ${ago(catalog.status.fetchedAt, true)}` : ''}.
              </p>
              {catalog?.status.sources && <CatalogSources sources={catalog.status.sources} label={(s) => setBy(sys, s.kind === 'folder' ? 'RENPLAY_RECIPES_DIR' : 'RENPLAY_CATALOG_URLS')} />}
              <div className="actions" style={{ marginTop: 12 }}>
                <Button size="sm" icon={<RefreshCw />} onClick={() => run(() => post('/api/catalog/refresh'), 'Catalog refreshed')}>
                  Refresh catalog
                </Button>
                <Button size="sm" variant="ghost" icon={<ExternalLink />} href="https://renplay.org/github/catalog" target="_blank" rel="noreferrer">
                  Catalog on GitHub
                </Button>
              </div>
              {installed.length > 0 && (
                <div style={{ borderTop: '1px solid var(--line)', marginTop: 14, paddingTop: 14 }}>
                  <p className="small muted" style={{ marginBottom: 10 }}>Add a game to the catalog: export a recipe filled in from its installation, then open a pull request, or keep it in Your recipes.</p>
                  <div className="actions">
                    <select aria-label="Choose a game" value={recipeFor} onChange={(e) => setRecipeFor(e.target.value)} className="input" style={{ maxWidth: 280 }}>
                      <option value="">Choose a game</option>
                      {installed.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.title}
                        </option>
                      ))}
                    </select>
                    <Button size="sm" icon={<FileCode2 />} disabled={!recipeGame} onClick={() => setRecipeOpen(true)}>
                      Export recipe
                    </Button>
                  </div>
                </div>
              )}
            </section>

            <DefaultsForEveryone />

            {recipeOpen && recipeGame && <RecipeDialog game={recipeGame} onClose={() => setRecipeOpen(false)} />}
            {storageOpen && <StorageSheet onClose={() => setStorageOpen(false)} />}
          </div>
          <section className={`${section === 'browser' ? '' : 'hidden'} panel stack`} style={{ gap: 14 }}>
            <h2 className="h3">This browser</h2>
            <LighterBackground />
            <KeepCache />
            <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
              <DeviceAdultRow />
            </div>
          </section>
          {section === 'about' && (
            <section className="panel stack" style={{ gap: 10 }}>
              <h2 className="h3">About Renplay</h2>
              <p className="small muted">Version {sys.version} · Made by the Renplay Team</p>
              <p className="small muted">Renplay is open source, under the MIT license. Game art belongs to its developers.</p>
              <div className="actions" style={{ gap: 16 }}>
                <DocsLink />
                <DocsLink path="troubleshooting/">Troubleshooting</DocsLink>
                <a className="link small" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }} href="https://renplay.org/releases" target="_blank" rel="noreferrer">Release notes ↗</a>
                <a className="link small" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }} href="https://renplay.org/github" target="_blank" rel="noreferrer">GitHub ↗</a>
                <a className="link small" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }} href="https://renplay.org/support" target="_blank" rel="noreferrer">Support ↗</a>
                <a className="link small" style={{ minHeight: 44, display: 'inline-flex', alignItems: 'center' }} href="https://github.com/renplay-org/renplay/blob/main/LICENSE" target="_blank" rel="noreferrer">License ↗</a>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

interface BackupInfo {
  dir: string | null
  keep: number
  files: Array<{ name: string; size: number; at: number }>
  last: number | null
  next: number | null
  running: boolean
  error: string | null
}

/** Where a server setting comes from: its variable on the server, or the default. */
function setBy(sys: SystemInfo | undefined, variable: string) {
  return sys?.setBy?.[variable] === 'server' ? <SourceLabel kind="server" label={variable} /> : <SourceLabel kind="def" />
}

/** Save backups: a daily zip of everyone's saves, the last few kept, and Back up now. */
function SaveBackups() {
  const qc = useQueryClient()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const { data } = useQuery({ queryKey: ['backups'], queryFn: () => api<BackupInfo>('/api/system/backups') })
  const { data: sys } = useSystem()
  if (!data) return null
  const now = async () => {
    setBusy(true)
    try {
      await post('/api/system/backups')
      toast('Saves backed up', 'success')
      void qc.invalidateQueries({ queryKey: ['backups'] })
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--line)' }} className="stack">
      <h3 style={{ fontWeight: 650 }}>Daily backups</h3>
      {setBy(sys, 'RENPLAY_BACKUP_DIR')}
      {data.dir ? (
        <>
          <p className="small muted">
            A zip of everyone’s saves goes to <code>{data.dir}</code> once a day, and the newest {data.keep} are kept.{' '}
            {data.last ? `The last one was ${ago(data.last)}.` : 'None yet.'} A server that sleeps when idle makes it the next time it runs.
          </p>
          {data.error && <p className="small" style={{ color: 'var(--amber)' }}>The last backup failed: {data.error}</p>}
          {data.files.length > 0 && (
            <div className="list tight">
              {data.files.slice(0, 5).map((f) => (
                <div key={f.name} className="row between small" style={{ minHeight: 'var(--hit)', gap: 12 }}>
                  <span className="muted-2">{new Date(f.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>
                  <span className="row" style={{ gap: 12 }}>
                    <span className="muted tnum">{bytes(f.size)}</span>
                    <a className="link" href={`/api/system/backups/${encodeURIComponent(f.name)}`}>
                      Download
                    </a>
                  </span>
                </div>
              ))}
            </div>
          )}
          <div>
            <Button size="sm" loading={busy || data.running} onClick={() => void now()}>
              Back up now
            </Button>
          </div>
        </>
      ) : (
        <p className="small muted">Save backups are off. Set RENPLAY_BACKUP_DIR to a folder to turn them on.</p>
      )}
    </div>
  )
}

/** Where recipes come from: each catalog, then Your recipes, with what each gives this person. */
function CatalogSources({ sources, label }: { sources: CatalogSource[]; label: (s: CatalogSource) => ReactNode }) {
  const name = (s: CatalogSource) => {
    if (s.kind === 'folder') return 'Your recipes'
    try {
      const u = new URL(s.location)
      return u.hostname === 'catalog.renplay.org' ? 'The Renplay catalog' : u.hostname
    } catch {
      return s.location
    }
  }
  return (
    <div className="list tight" style={{ marginTop: 12 }}>
      {sources.map((s) => (
        <div key={s.kind + s.location} className="stack" style={{ gap: 4, padding: '8px 0' }}>
          <div className="row between wrap" style={{ gap: 8 }}>
            <span style={{ fontWeight: 600 }}>{name(s)}</span>
            <span className="small muted tnum">
              {s.recipes} {s.recipes === 1 ? 'recipe' : 'recipes'}, {s.pictures} {s.pictures === 1 ? 'picture' : 'pictures'}
            </span>
          </div>
          {label(s)}
          {s.kind === 'folder' ? (
            <p className="xs muted">
              Recipe files in <code>{s.location}</code>, in the catalog’s format. A recipe there takes the place of the catalog’s recipe with the same id, so you can fix a game or add one without waiting for the catalog.
            </p>
          ) : (
            <p className="xs muted truncate">{s.location}</p>
          )}
          {s.problems.length > 0 && (
            <details className="xs">
              <summary className="amber" style={{ minHeight: 'var(--hit)', display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                {s.problems.length} {s.problems.length === 1 ? 'problem' : 'problems'}
              </summary>
              <ul className="stack" style={{ gap: 4, paddingLeft: 16 }}>
                {s.problems.map((p) => (
                  <li key={p} className="muted">
                    {p}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
    </div>
  )
}

interface StorageReport {
  games: Array<{ id: string; title: string; status: string; builds: Array<{ name: string; current: boolean; bytes: number }>; download: { name: string; bytes: number } | null; bytes: number }>
  engines: Array<{ version: string; bytes: number; used: boolean }>
  orphans: Array<{ name: string; bytes: number }>
  totals: { builds: number; downloads: number; engines: number }
  freeable: { downloads: number; engines: number }
}

/** What uses space, game by game, and what Renplay can free. */
function StorageSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const toast = useToast()
  const { data, isLoading } = useQuery({ queryKey: ['storage'], queryFn: () => api<StorageReport>('/api/system/storage') })
  const [confirm, setConfirm] = useState<StorageReport['games'][number] | null>(null)
  const refresh = async () => {
    await post('/api/system/storage/refresh')
    await qc.invalidateQueries({ queryKey: ['storage'] })
    void qc.invalidateQueries({ queryKey: ['system'] })
  }
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn()
      toast(ok, 'success')
      await refresh()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }
  return (
    <Modal open onClose={onClose} title="What uses space" wide fullPhone>
      {isLoading || !data ? (
        <Spinner />
      ) : (
        <div className="stack" style={{ gap: 20 }}>
          <p className="small muted">
            Games {bytes(data.totals.builds)}, downloads {bytes(data.totals.downloads)}, engines {bytes(data.totals.engines)}.
            {data.freeable.downloads + data.freeable.engines > 0
              ? ` Up to ${bytes(data.freeable.downloads + data.freeable.engines)} can be freed: downloads of installed games (add them again to reinstall) and engines no game uses.`
              : ''}
          </p>
          <section>
            <h3 className="small" style={{ fontWeight: 650, marginBottom: 6 }}>Games</h3>
            <div className="list tight">
              {data.games.map((g) => (
                <div key={g.id} className="row between wrap" style={{ gap: 8, minHeight: 'var(--hit)', padding: '6px 0' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{g.title}</div>
                    <div className="xs muted">
                      {[
                        g.builds.filter((b) => b.current).map((b) => `game ${bytes(b.bytes)}`)[0],
                        g.builds.some((b) => !b.current) && `other builds ${bytes(g.builds.filter((b) => !b.current).reduce((n, b) => n + b.bytes, 0))}`,
                        g.download && `download ${bytes(g.download.bytes)}`,
                      ]
                        .filter(Boolean)
                        .join(', ') || 'Nothing on disk'}
                    </div>
                  </div>
                  <span className="row" style={{ gap: 8 }}>
                    <span className="small muted tnum">{bytes(g.bytes)}</span>
                    {g.download && g.status === 'installed' && (
                      <Button size="sm" variant="ghost" onClick={() => setConfirm(g)}>
                        Delete download
                      </Button>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </section>
          {data.engines.length > 0 && (
            <section>
              <h3 className="small" style={{ fontWeight: 650, marginBottom: 6 }}>Engines</h3>
              <div className="list tight">
                {data.engines.map((e) => (
                  <div key={e.version} className="row between" style={{ minHeight: 'var(--hit)' }}>
                    <span>
                      Ren’Py {e.version} <span className="xs muted">{e.used ? 'in use' : 'no game uses it'}</span>
                    </span>
                    <span className="small muted tnum">{bytes(e.bytes)}</span>
                  </div>
                ))}
              </div>
              {data.freeable.engines > 0 && (
                <Button size="sm" style={{ marginTop: 8 }} onClick={() => void run(() => post('/api/system/prune'), 'Unused engines removed')}>
                  Remove unused engines
                </Button>
              )}
            </section>
          )}
          {data.orphans.length > 0 && (
            <section>
              <h3 className="small" style={{ fontWeight: 650, marginBottom: 6 }}>Folders of no game</h3>
              <p className="xs muted" style={{ marginBottom: 6 }}>In the games folder but not in the library. Renplay leaves them alone, delete them yourself if you do not need them.</p>
              <div className="list tight">
                {data.orphans.map((o) => (
                  <div key={o.name} className="row between" style={{ minHeight: 'var(--hit)' }}>
                    <code>{o.name}</code>
                    <span className="small muted tnum">{bytes(o.bytes)}</span>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
      <Confirm
        open={!!confirm}
        onClose={() => setConfirm(null)}
        danger
        title="Delete this download?"
        confirmLabel="Delete download"
        onConfirm={() => {
          const g = confirm!
          setConfirm(null)
          void run(() => del(`/api/games/${g.id}/download`), 'Download deleted')
        }}
      >
        Deletes {confirm?.download?.name}. Reinstalling {confirm?.title} will need the download again. The installed game and its saves are kept.
      </Confirm>
    </Modal>
  )
}

/** What everyone starts with until they choose: tags left out, Lighter background, text size, Rollback and Skip. */
function DefaultsForEveryone() {
  const qc = useQueryClient()
  const toast = useToast()
  const { data: d } = useDefaults()
  const { data: catalog } = useCatalog()
  if (!d) return null
  const save = async (patch: Partial<Defaults>) => {
    try {
      const next = await put<Defaults>('/api/defaults', { ...d, ...patch })
      qc.setQueryData(['defaults'], next)
      void qc.invalidateQueries({ queryKey: ['me-tags'] })
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }
  const tri = (v: boolean | null) => (v === null ? 'unset' : v ? 'on' : 'off')
  const fromTri = (v: string) => (v === 'unset' ? null : v === 'on')
  return (
    <section className="panel stack" style={{ gap: 14 }}>
      <div>
        <h2 className="h3">Defaults for everyone</h2>
        <p className="small muted" style={{ marginTop: 6 }}>What people start with until they choose their own. Each person can still change these for themselves.</p>
      </div>
      <div className="stack" style={{ gap: 8 }}>
        <div>
          <div style={{ fontWeight: 650 }}>Tags left out on the Catalog page</div>
          <p className="small muted" style={{ marginTop: 2 }}>Games with these tags are hidden in the catalog for people who have not chosen their own tags. A tap leaves a tag out, the next brings it back.</p>
        </div>
        {catalog && (
          <CatalogTags games={catalog.games} vocabulary={catalog.vocabulary} prefs={{ include: [], exclude: d.tagsExclude }} onChange={(next) => void save({ tagsExclude: next.exclude })} excludeOnly />
        )}
      </div>
      <Setting title="Lighter background" hint="For browsers where nobody chose. Each device follows its own reduced motion and data saver settings unless this says otherwise.">
        <Seg
          small
          label="Lighter background for everyone"
          value={tri(d.lighterBackground)}
          onChange={(v) => void save({ lighterBackground: fromTri(v) })}
          options={[
            { value: 'unset', label: 'Each device' },
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
        />
      </Setting>
      <Setting title="Text size in games" hint="Ren’Py’s text size in games where the person has not chosen one in the player’s Options.">
        <Seg
          small
          label="Text size for everyone"
          value={d.textSize === null ? 'unset' : String(d.textSize)}
          onChange={(v) => void save({ textSize: v === 'unset' ? null : Number(v) })}
          options={[
            { value: 'unset', label: 'As the game has it' },
            { value: '1.25', label: 'Large' },
            { value: '1.5', label: 'Larger' },
          ]}
        />
      </Setting>
      {(['rollback', 'skip'] as const).map((k) => (
        <Setting key={k} title={k === 'rollback' ? 'Rollback in games' : 'Skip in games'} hint={k === 'rollback' ? 'Go back to earlier lines even where a game turns it off, until a person chooses in Options.' : 'Skip read text even where a game turns it off, until a person chooses in Options.'}>
          <Seg
            small
            label={k === 'rollback' ? 'Rollback for everyone' : 'Skip for everyone'}
            value={d[k] ? 'on' : 'unset'}
            onChange={(v) => void save({ [k]: v === 'on' ? true : null })}
            options={[
              { value: 'unset', label: 'As the game has it' },
              { value: 'on', label: 'On' },
            ]}
          />
        </Setting>
      ))}
    </section>
  )
}
