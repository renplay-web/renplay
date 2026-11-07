import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Upload } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import Sheet from '../lantern/Sheet'
import { ArtPicture, Frame, creditText } from '../lantern/art'
import { Pill, Seg } from '../lantern/controls'
import { api, del, type ArtCredit, type ArtFormat, type ArtKind, type Game } from '../lib/api'
import { useAuth } from '../lib/auth'
import { errorText, useToast } from './ui'

interface Candidate {
  id: string
  current: boolean
  everyone: boolean
  mine: boolean
  inShape: boolean
  width: number
  height: number
  source: string
  credit: ArtCredit
  upload: boolean
  /** Uploaded by this person, and so theirs to delete. */
  ownUpload: boolean
  /** Uploaded for everyone, which an admin may delete. */
  sharedUpload: boolean
  preview: ArtFormat | null
}

const KINDS: Array<{ value: ArtKind; label: string }> = [
  { value: 'grid', label: 'Grid' },
  { value: 'wide', label: 'Wide' },
  { value: 'hero', label: 'Hero' },
  { value: 'logo', label: 'Logo' },
  { value: 'icon', label: 'Icon' },
]
/** The size each format wants, as the upload tile says it. */
export const UPLOAD_SIZE: Record<ArtKind, string> = {
  grid: '600 × 900, or 1200 × 1800',
  wide: '920 × 430, or 1840 × 860',
  hero: '1920 × 620, or 3840 × 1240',
  logo: 'A transparent PNG',
  icon: 'A square, 512 × 512 or larger',
}
const WHERE: Record<ArtKind, string> = {
  grid: 'The library tile and the game page poster',
  wide: 'Up next on the library home',
  hero: 'The top of the game page, and the room behind every screen',
  logo: 'The title on the game page and while the game loads',
  icon: 'Rows such as History',
}
const MADE: Record<string, string> = { crop: 'cropped to fit', composed: 'composed on its glow', glow: 'blurred into a background', whole: 'whole on its glow' }

/** One line on where a candidate came from and how it fits. */
function about(c: Candidate, kind: ArtKind): ReactNode {
  const made = c.preview?.made ? `, ${MADE[c.preview.made]}` : ''
  const size = kind === 'logo' ? `${c.width} × ${c.height}` : c.inShape ? `${c.width} × ${c.height}` : `${c.width} × ${c.height}${made}`
  return (
    <>
      {c.upload ? 'Uploaded' : creditText(c.credit)} · {size}
    </>
  )
}

/**
 * A format where it appears, drawn by the same components as the applied art: the 2:3 tile with
 * its title, the wide tile, the stage's hero, the logo on that hero, the icon in a row.
 */
function Placement({ game, kind, format, ring }: { game: Game; kind: ArtKind; format: ArtFormat | null; ring?: boolean }) {
  const cls = ring ? 'ring' : undefined
  if (kind === 'grid' || kind === 'wide')
    return (
      <div className={`card ${kind === 'wide' ? 'wide' : ''}`.trim()}>
        <Frame game={{ title: game.title, art: format ? { [kind]: format } : {} }} kind={kind} hidden={false} className={cls} />
        <div className="ct">{game.title}</div>
      </div>
    )
  if (kind === 'icon')
    return (
      <div className="prow">
        <Frame game={{ title: game.title, art: format ? { icon: format } : {} }} kind="sq" hidden={false} className={cls} />
        <div className="grow">
          <div className="t">{game.title}</div>
          <div className="m">History and other rows</div>
        </div>
      </div>
    )
  // The hero, and the logo shown on the game's own hero, where it will sit.
  const hero = kind === 'hero' ? format : (game.art.hero ?? null)
  return (
    <div className={`frame hero ${cls ?? ''}`.trim()} style={{ position: 'relative' }}>
      {hero ? <ArtPicture format={hero} /> : null}
      {kind === 'logo' && (
        <div className="pk-logo">
          {format?.url1x ? <img src={format.url1x} alt="" className={format.dark ? 'inv' : ''} /> : <span>{game.title}</span>}
        </div>
      )}
    </div>
  )
}

/**
 * The art picker (DESIGN 0.7): one format at a time, every candidate as it will look in place,
 * a preview on hover or focus and a choice on a tap or Enter. A choice changes what this person
 * sees, an admin can choose for everyone. Uploads of another size are placed with a crop at the
 * point the uploader taps.
 */
export default function ArtPicker({ game, open, onClose, initialKind = 'grid', step = false }: { game: Game; open: boolean; onClose: () => void; initialKind?: ArtKind; step?: boolean }) {
  const admin = useAuth().data?.user.role === 'admin'
  const qc = useQueryClient()
  const toast = useToast()
  const [kind, setKind] = useState<ArtKind>(initialKind)
  // After an install (the Choose artwork step) an admin chooses for everyone (DESIGN 0.8).
  const [scope, setScope] = useState<'me' | 'everyone'>(step && admin ? 'everyone' : 'me')
  const [previewing, setPreviewing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [file, setFile] = useState<{ blob: File; url: string } | null>(null)
  const [focal, setFocal] = useState<[number, number]>([0.5, 0.4])
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) setKind(initialKind)
  }, [open, initialKind])
  useEffect(() => () => {
    if (file) URL.revokeObjectURL(file.url)
  }, [file])
  const list = useQuery({
    queryKey: ['art', game.id, kind],
    enabled: open,
    queryFn: () => api<{ candidates: Candidate[] }>(`/api/games/${game.id}/art?kind=${kind}`).then((r) => r.candidates),
  })
  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: ['art', game.id] }), qc.invalidateQueries({ queryKey: ['game', game.id] }), qc.invalidateQueries({ queryKey: ['games'] })])
  }
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await refresh()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setBusy(false)
    }
  }
  const choose = (c: Candidate) => run(() => api(`/api/games/${game.id}/art`, { method: 'PUT', json: { kind, candidate: c.id, scope } }))
  const useDefault = () => run(() => del(`/api/games/${game.id}/art?kind=${kind}&scope=${scope}`))
  const upload = () =>
    file &&
    run(async () => {
      const r = await api<{ warning: { width: number; height: number } | null }>(`/api/games/${game.id}/art/upload?kind=${kind}&scope=${scope}&focal=${focal.map((v) => v.toFixed(3)).join(',')}`, {
        method: 'POST',
        body: file.blob,
        headers: { 'content-type': file.blob.type || 'application/octet-stream' },
      })
      setFile(null)
      if (r.warning) toast(`This picture is ${r.warning.width} × ${r.warning.height}, not ${UPLOAD_SIZE[kind].split(',')[0]}. It is placed with a crop at the point you chose.`)
    })

  const candidates = list.data ?? []
  const uploads = candidates.filter((c) => c.upload)
  const uploadName = (c: Candidate) => (uploads.length > 1 ? `Your upload ${uploads.indexOf(c) + 1}` : 'Your upload')
  // Each upload once, at the scope it was made for: one's own, or for everyone when an admin.
  const removable = uploads.filter((c) => c.ownUpload || (admin && c.sharedUpload))
  const remove = (c: Candidate) =>
    run(() => del(`/api/games/${game.id}/art/uploads/${c.id}?kind=${kind}&scope=${c.ownUpload ? 'me' : 'everyone'}`))
  const current = candidates.find((c) => c.current) ?? null
  const shown = candidates.find((c) => c.id === previewing) ?? current

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={step ? `Choose artwork for ${game.title}` : `Art for ${game.title}`}
      wide="xl"
      fullPhone
      footer={
        step ? (
          <div className="pk-foot">
            <p className="hint small muted">{game.recipe ? 'The catalog’s pictures are picked already.' : 'This game is not in the catalog yet, so it starts with its title. Pick or upload a picture.'} You can change it later on the game’s page, under Details.</p>
            <Pill variant="p" onClick={onClose}>
              Keep this art
            </Pill>
            <Pill variant="q" onClick={onClose}>
              Skip for now
            </Pill>
          </div>
        ) : undefined
      }
    >
      <div className="pk-head">
        <Seg small scroll label="Format" value={kind} onChange={(k) => { setKind(k); setPreviewing(null); setFile(null) }} options={KINDS} />
      </div>
      <div className={`picker ${kind === 'grid' || kind === 'icon' ? 'side' : 'top'}`}>
        <div className="prev" aria-live="polite">
          <div className="plabel">
            <span className="grow">{WHERE[kind]}</span>
            <span className={`pill ${previewing && previewing !== current?.id ? 'vio' : ''}`}>{previewing && previewing !== current?.id ? 'Previewing' : 'Chosen'}</span>
          </div>
          <div className="pin">
            <Placement game={game} kind={kind} format={shown?.preview ?? null} ring />
          </div>
          {shown && <div className="pwhere">{about(shown, kind)}</div>}
        </div>
        <div className="pk-body">
          <div className="grp-h">
            Choices<span className="muted">Shown as they will look</span>
          </div>
          {list.isPending ? (
            <p className="small muted">Loading</p>
          ) : (
            <div className="choices" role="radiogroup" aria-label={`Choices for the ${kind}`}>
              {candidates.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="radio"
                  aria-checked={c.current}
                  aria-disabled={busy}
                  className={`choice ${kind}-c ${c.current ? 'on' : ''} ${previewing === c.id && !c.current ? 'previewing' : ''}`}
                  onMouseEnter={() => setPreviewing(c.id)}
                  onMouseLeave={() => setPreviewing(null)}
                  onFocus={() => setPreviewing(c.id)}
                  onBlur={() => setPreviewing(null)}
                  onClick={() => !busy && void choose(c)}
                >
                  <div style={{ position: 'relative' }}>
                    <span className="chk" aria-hidden="true">
                      <Check />
                    </span>
                    <Placement game={game} kind={kind} format={c.preview} ring={c.current || previewing === c.id} />
                  </div>
                  <div className="cl">
                    {c.upload ? uploadName(c) : c.source === 'sgdb' ? 'SteamGridDB' : c.source === 'steam' ? 'Steam' : c.source === 'itch' ? 'itch.io' : c.source === 'renplay' ? 'Renplay' : 'The developer'}
                    {c.everyone && <span className="pill">For everyone</span>}
                    {c.mine && <span className="pill">Your choice</span>}
                    {!c.inShape && kind !== 'logo' && (
                      <span className="warn">
                        <AlertTriangle /> Another shape
                      </span>
                    )}
                  </div>
                  <div className="cs">{about(c, kind)}</div>
                </button>
              ))}
            </div>
          )}

          {removable.length > 0 && (
            <>
              <div className="grp-h">Your uploads</div>
              <div className="list tight">
                {removable.map((c) => (
                  <div key={c.id} className="row between small" style={{ minHeight: 'var(--hit)', gap: 12 }}>
                    <span>
                      {uploadName(c)}
                      <span className="muted">
                        {' '}
                        · {c.width} × {c.height}
                        {!c.ownUpload ? ' · For everyone' : ''}
                      </span>
                    </span>
                    <Pill variant="q" size="sm" onClick={() => !busy && void remove(c)} aria-disabled={busy}>
                      Delete
                    </Pill>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="grp-h">Your own picture</div>
          {file ? (
            <div className="stack" style={{ gap: 12 }}>
              <p className="small muted-2">Tap the part that matters. If the picture has another shape, Renplay crops around this point.</p>
              <div
                className="pk-focal"
                role="button"
                tabIndex={0}
                aria-label="Choose the point that matters"
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setFocal([Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))])
                }}
                onKeyDown={(e) => {
                  const step = 0.05
                  const move: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
                  const d = move[e.key]
                  if (!d) return
                  e.preventDefault()
                  setFocal(([x, y]) => [Math.min(1, Math.max(0, x + d[0])), Math.min(1, Math.max(0, y + d[1]))])
                }}
              >
                <img src={file.url} alt="" />
                <span className="focal" style={{ left: `${focal[0] * 100}%`, top: `${focal[1] * 100}%` }} />
              </div>
              <div className="actions">
                <Pill variant="p" onClick={() => !busy && void upload()} aria-disabled={busy}>
                  Use this picture
                </Pill>
                <Pill variant="q" onClick={() => setFile(null)}>
                  Cancel
                </Pill>
              </div>
            </div>
          ) : (
            <button type="button" className={`choice upload ${kind}-c`} onClick={() => !busy && input.current?.click()} aria-disabled={busy}>
              <div className={`frame ${kind === 'wide' ? 'wide' : kind === 'hero' || kind === 'logo' ? 'hero' : kind === 'icon' ? 'sq' : ''}`.trim()}>
                <div className="up">
                  <Upload />
                  Upload your own
                  <span className="sz">{UPLOAD_SIZE[kind]}</span>
                </div>
              </div>
              <div className="cs">Another size is accepted too, with a warning, and placed with a crop at a point you choose.</div>
            </button>
          )}
          <input
            ref={input}
            type="file"
            accept={kind === 'logo' ? 'image/png' : 'image/webp,image/png,image/jpeg'}
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (!f) return
              if (f.size > 16 << 20) return void toast('Pictures can be up to 16 MB', 'error')
              setFocal([0.5, 0.4])
              setFile({ blob: f, url: URL.createObjectURL(f) })
            }}
          />

          {step && (
            <>
              <div className="grp-h">The other formats</div>
              <div className="list tight">
                {KINDS.filter((k) => k.value !== kind).map((k) => {
                  const f = game.art[k.value]
                  return (
                    <div key={k.value} className="row between" style={{ gap: 12, minHeight: 'var(--hit)' }}>
                      <span className="grow">
                        <span style={{ display: 'block', fontWeight: 600 }}>{k.label}</span>
                        <span className="xs muted">{f ? <>{creditText(f.credit)}{f.made ? ', fitted by Renplay' : ''}</> : k.value === 'logo' ? 'The title in text' : 'Not available yet'}</span>
                      </span>
                      <Pill variant="s" size="sm" onClick={() => { setKind(k.value); setPreviewing(null); setFile(null) }}>
                        Change
                      </Pill>
                    </div>
                  )
                })}
              </div>
            </>
          )}

          <div className="who">
            {admin ? (
              <>
                <span>Showing to</span>
                <Seg small label="Showing to" value={scope} onChange={setScope} options={[{ value: 'me', label: 'You' }, { value: 'everyone', label: 'Everyone' }]} />
              </>
            ) : (
              <span>Your choice changes only what you see. The admin sets the default for everyone.</span>
            )}
            <span className="grow" />
            <Pill variant="q" size="sm" onClick={() => !busy && void useDefault()} aria-disabled={busy}>
              Use the default
            </Pill>
            {admin && <span className="xs">Everyone sets this server’s default for every person, over the catalog’s. Each person’s own choice still wins for them.</span>}
          </div>
        </div>
      </div>
    </Sheet>
  )
}
