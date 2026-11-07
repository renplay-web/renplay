import Sheet from './Sheet'
import SceneCard from './SceneCard'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Copy, Download, FileArchive, History, MoreHorizontal, PencilLine, Pin, Play, Trash2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, del, post, slotName, type Game, type SaveSlot } from '../lib/api'
import { ago, bytes, dateTime, duration, timeZone } from '../lib/format'
import { useGames, useSaves } from '../lib/queries'
import { Seg } from '../lantern/controls'
import { Button, Confirm, Empty, MenuItem, Modal, Spinner, errorText, useToast } from './ui'

type Kind = 'all' | 'manual' | 'auto' | 'quick'

export default function SaveGallery({ game }: { game: Game }) {
  const [editing, setEditing] = useState<{ slot: SaveSlot; title: string; note: string } | null>(null)
  /** A save's name, note and pin for this person. */
  const saveMeta = async (slot: SaveSlot, body: { title?: string; note?: string; pinned?: boolean }, ok: string) => {
    try {
      await api(`/api/saves/${game.id}/meta?file=${encodeURIComponent(slot.file)}`, { method: 'PUT', json: body })
      toast(ok, 'success')
      refresh()
    } catch (e) {
      toast(errorText(e), 'error')
    }
  }
  const { data, isLoading } = useSaves(game.id)
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const fileRef = useRef<HTMLInputElement>(null)
  const [kind, setKind] = useState<Kind>('all')
  const [importing, setImporting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState<SaveSlot | null>(null)
  const [copying, setCopying] = useState<SaveSlot | null>(null)
  const [history, setHistory] = useState<SaveSlot | 'all' | null>(null)
  const [syncing, setSyncing] = useState(false)
  // Conflicts this browser was already told about.
  const seenKey = `renplay:conflicts-seen:${game.id}`
  const [conflictsSeen, setConflictsSeen] = useState(() => Number(localStorage.getItem(seenKey)) || 0)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['saves', game.id] })
    void qc.invalidateQueries({ queryKey: ['games'] })
    void qc.invalidateQueries({ queryKey: ['game', game.id] })
  }

  const onImport = async (files: FileList | null) => {
    if (!files?.length) return
    setImporting(true)
    try {
      const fd = new FormData()
      for (const f of Array.from(files)) fd.append('files', f, f.name)
      const res = await fetch(`/api/saves/${game.id}/import`, { method: 'POST', body: fd })
      const r = await res.json()
      if (!res.ok) throw new Error(r.error || 'Import failed')
      const parts = [`Imported ${r.imported.length} file${r.imported.length === 1 ? '' : 's'}`]
      if (r.trustedKeys) parts.push(`trusted ${r.trustedKeys} device key${r.trustedKeys === 1 ? '' : 's'}`)
      if (r.skipped.length) parts.push(`skipped ${r.skipped.length}: ${r.skipped.map((s: any) => s.reason).join('. ')}`)
      toast(parts.join(', '), r.imported.length ? 'success' : 'error')
      refresh()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setImporting(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  if (!game.saveDir)
    return (
      <Empty title="Save folder not known yet">
        Start the game once. Renplay learns where it saves from Ren’Py itself. You can also set it in the Details tab.
      </Empty>
    )

  const slots = (data?.slots ?? []).filter((s) => s.kind !== 'internal' && (kind === 'all' || s.kind === kind))
  const counts = (data?.slots ?? []).reduce<Record<string, number>>((m, s) => ((m[s.kind] = (m[s.kind] ?? 0) + 1), m), {})
  const conflicts = (data?.conflicts ?? []).filter((c) => c.at > conflictsSeen)
  const conflictFiles = new Set(conflicts.map((c) => c.file)).size
  const conflictSlot = conflicts.length ? data?.slots.find((s) => s.file === conflicts[0]!.file) : undefined
  const conflictName = conflictSlot ? conflictSlot.title || conflictSlot.name || conflictSlot.label : conflicts[0]?.file
  const seeConflicts = () => {
    const at = conflicts[0]!.at
    localStorage.setItem(seenKey, String(at))
    setConflictsSeen(at)
  }

  return (
    <div>
      {conflicts.length > 0 && (
        <div className="notice amber row wrap" style={{ marginBottom: 16, gap: 12 }}>
          <div className="grow" style={{ minWidth: 220 }}>
            {conflictFiles === 1 ? (
              <>
                <b>Two versions of {conflictName}.</b> Another device saved it too. The copy saved later is in the slot and the other is kept in History.
              </>
            ) : (
              <>
                <b>{conflictFiles} saves changed on two devices.</b> The copy saved later is in each slot and the other is kept in History.
              </>
            )}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => (seeConflicts(), setHistory(conflictFiles === 1 && conflictSlot ? conflictSlot : 'all'))}>
              Show in History
            </Button>
            <Button size="sm" variant="ghost" onClick={seeConflicts}>
              OK
            </Button>
          </div>
        </div>
      )}
      <div className="toolbar" style={{ position: 'static', margin: 0, padding: '0 0 14px' }}>
        <Seg<Kind>
          small
          scroll
          value={kind}
          onChange={setKind}
          options={(['all', 'manual', 'auto', 'quick'] as Kind[]).map((k) => ({
            value: k,
            label: k === 'all' ? 'All' : `${k[0]!.toUpperCase()}${k.slice(1)}${counts[k] ? ` ${counts[k]}` : ''}`,
          }))}
        />
        <span className="grow" />
        <input ref={fileRef} type="file" multiple accept=".save,.zip,application/zip" className="hidden" onChange={(e) => void onImport(e.target.files)} />
        <Button size="sm" icon={<Upload />} loading={importing} onClick={() => fileRef.current?.click()}>
          Import
        </Button>
        <Button size="sm" icon={<FileArchive />} href={`/api/saves/${game.id}/export`}>
          Export all
        </Button>
        <Button size="sm" variant="ghost" icon={<History />} onClick={() => setHistory('all')}>
          History
        </Button>
        {data?.sync && (
          <Button size="sm" variant="ghost" icon={<ArrowLeftRight />} onClick={() => setSyncing(true)}>
            Sync code
          </Button>
        )}
      </div>

      {isLoading ? (
        <Spinner />
      ) : !slots.length ? (
        <Empty title="No saves yet">
          Saves you make in the game are stored on the server as soon as you make them. You can also import saves from the desktop version (single <code>.save</code> files or a zip of the save folder).
        </Empty>
      ) : (
        <div className="saves">
          {slots.map((s) => (
            <div key={s.file} className={`save ${s.pinnedAt ? 'pinned' : ''}`.trim()}>
              <button
                className="relative block w-full"
                onClick={() => game.playUrl && navigate(`/play/${game.id}?resume=${encodeURIComponent(slotName(s.file))}`)}
                disabled={!game.playUrl}
                title={game.playUrl ? 'Load this save' : 'Install the game to load saves'}
                aria-label={game.playUrl ? `Load ${s.name || s.label}` : 'Install the game to load saves'}
              >
                <SceneCard game={game} save={s} play={!!game.playUrl} />
              </button>
              <div className="b row" style={{ gap: 8 }}>
                <div className="grow">
                  <div className="n">
                    {s.pinnedAt && <Pin className="pin" aria-label="Pinned" />}
                    <span className="truncate">{s.title || s.name || <span className="muted">Untitled</span>}</span>
                  </div>
                  {s.note && <p className="note">{s.note}</p>}
                  <div className="m" title={dateTime(s.ctime)}>
                    {ago(s.ctime)}
                    {duration(s.runtime) ? ` · ${duration(s.runtime)} played` : ''}
                  </div>
                </div>
                <Sheet
                  trigger={(toggle) => (
                    <button onClick={toggle} className="ib" style={{ width: 36, height: 36, marginRight: -6 }} aria-label="Save actions">
                      <MoreHorizontal />
                    </button>
                  )}
                >
                  {(close) => (
                    <>
                      <MenuItem icon={<Play />} disabled={!game.playUrl} onClick={() => { close(); navigate(`/play/${game.id}?resume=${encodeURIComponent(slotName(s.file))}`) }}>Load</MenuItem>
                      <MenuItem icon={<Pin />} onClick={() => { close(); void saveMeta(s, { pinned: !s.pinnedAt }, s.pinnedAt ? 'Unpinned' : 'Pinned. Every previous version is kept.') }}>
                        {s.pinnedAt ? 'Unpin' : 'Pin'}
                      </MenuItem>
                      <MenuItem icon={<PencilLine />} onClick={() => { close(); setEditing({ slot: s, title: s.title ?? '', note: s.note ?? '' }) }}>
                        Name and note
                      </MenuItem>
                      <MenuItem icon={<Download />} onClick={() => (close(), window.open(`/api/saves/${game.id}/download?file=${encodeURIComponent(s.file)}`))}>
                        Download
                      </MenuItem>
                      <MenuItem icon={<Copy />} onClick={() => (close(), setCopying(s))}>
                        Copy to another game
                      </MenuItem>
                      <MenuItem icon={<History />} onClick={() => (close(), setHistory(s))}>
                        Previous versions
                      </MenuItem>
                      <MenuItem icon={<Trash2 />} danger onClick={() => (close(), setConfirmDelete(s))}>
                        Delete
                      </MenuItem>
                    </>
                  )}
                </Sheet>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="xs muted" style={{ marginTop: 20 }}>
        Every save is stored on the server. Overwrites and deletes keep a previous version you can restore from History. A pinned save keeps all of them.
      </p>

      <Modal
        open={!!editing}
        onClose={() => setEditing(null)}
        title="Name and note"
        footer={
          <Button variant="primary" onClick={() => { const e = editing!; setEditing(null); void saveMeta(e.slot, { title: e.title, note: e.note }, 'Saved') }}>
            Save
          </Button>
        }
      >
        <div className="stack" style={{ gap: 12 }}>
          <p className="small muted">Only you see these. The save itself does not change.</p>
          <label className="block small muted-2">
            Name
            <input className="input" style={{ marginTop: 8, width: '100%' }} maxLength={80} placeholder={editing?.slot.name || 'Untitled'} value={editing?.title ?? ''} onChange={(e) => setEditing((x) => (x ? { ...x, title: e.target.value } : x))} />
          </label>
          <label className="block small muted-2">
            Note
            <textarea className="input" style={{ marginTop: 8, width: '100%', minHeight: 96, paddingTop: 10 }} maxLength={500} value={editing?.note ?? ''} onChange={(e) => setEditing((x) => (x ? { ...x, note: e.target.value } : x))} />
          </label>
        </div>
      </Modal>

      <Confirm
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        title="Delete save?"
        danger
        confirmLabel="Delete"
        onConfirm={async () => {
          const s = confirmDelete!
          setConfirmDelete(null)
          try {
            await del(`/api/saves/${game.id}/slot?file=${encodeURIComponent(s.file)}`)
            toast('Save deleted. It can be restored from History.', 'success')
            refresh()
          } catch (e) {
            toast(errorText(e), 'error')
          }
        }}
      >
        {confirmDelete?.name || confirmDelete?.label} will be removed from the game. A copy stays in the save history.
      </Confirm>

      {copying && <CopyDialog game={game} slot={copying} onClose={() => setCopying(null)} />}
      {syncing && <SyncDialog game={game} onClose={() => setSyncing(false)} onDownloaded={refresh} />}
      {history && <HistoryDialog game={game} file={history === 'all' ? undefined : history.file} onClose={() => setHistory(null)} onRestored={refresh} />}
    </div>
  )
}

function CopyDialog({ game, slot, onClose }: { game: Game; slot: SaveSlot; onClose: () => void }) {
  const { data: games } = useGames()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const targets = (games ?? []).filter((g) => g.id !== game.id && g.saveDir)
  return (
    <Modal open onClose={onClose} title="Copy save to another game">
      <p className="small muted" style={{ marginBottom: 14 }}>
        For sequels that continue from an earlier season. The save keeps its slot if it is free, otherwise it goes into the next free slot.
      </p>
      <div className="stack" style={{ gap: 8 }}>
        {targets.length === 0 && <p className="small muted">No other game with a known save folder.</p>}
        {targets.map((g) => (
          <button
            key={g.id}
            disabled={!!busy}
            onClick={async () => {
              setBusy(g.id)
              try {
                const r = await post<{ file: string }>(`/api/saves/${game.id}/copy`, { file: slot.file, target: g.id })
                toast(`Copied to ${g.title} as ${r.file}`, 'success')
                onClose()
              } catch (e) {
                toast(errorText(e), 'error')
              } finally {
                setBusy(null)
              }
            }}
            className="row between panel flat"
            style={{ width: '100%', textAlign: 'left', padding: '12px 16px' }}
          >
            <span className="small">{g.title}</span>
            {busy === g.id ? <Spinner /> : <span className="xs muted">{g.saveDir}</span>}
          </button>
        ))}
      </div>
    </Modal>
  )
}

function HistoryDialog({ game, file, onClose, onRestored }: { game: Game; file?: string; onClose: () => void; onRestored: () => void }) {
  const toast = useToast()
  const { data, isLoading } = useQuery({
    queryKey: ['history', game.id, file],
    queryFn: () => api<{ versions: Array<{ id: string; name: string; size: number; savedAt: number; reason: string }> }>(`/api/saves/${game.id}/history${file ? `?file=${encodeURIComponent(file)}` : ''}`),
  })
  const reason = (r: string) =>
    ({ overwrite: 'Replaced in game', game: 'Replaced in game', 'game-delete': 'Deleted in game', 'user-delete': 'Deleted here', import: 'Replaced by import', restore: 'Before a restore', copy: 'Replaced by a copy', conflict: 'Older of two versions' })[r] ?? r
  return (
    <Modal open onClose={onClose} title={file ? `Previous versions of ${file}` : 'Save history'} wide fullPhone>
      {isLoading ? (
        <Spinner />
      ) : !data?.versions.length ? (
        <p className="small muted">No previous versions yet.</p>
      ) : (
        <div className="list tight">
          {data.versions.slice(0, 200).map((v) => (
            <div key={v.id} className="row between small" style={{ gap: 12 }}>
              <div className="grow">
                <div className="truncate">{v.name}</div>
                <div className="xs muted">
                  {reason(v.reason)} · {dateTime(v.savedAt)} · {bytes(v.size)}
                </div>
              </div>
              <Button
                size="sm"
                onClick={async () => {
                  try {
                    await post(`/api/saves/${game.id}/history/restore`, { id: v.id })
                    toast(`Restored ${v.name}`, 'success')
                    onRestored()
                  } catch (e) {
                    toast(errorText(e), 'error')
                  }
                }}
              >
                Restore
              </Button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

/** Ren'Py 8.1 added Sync. Older versions of a game have no Upload Sync or Download Sync. */
function hasSync(version: string | null | undefined): boolean {
  const [major = 0, minor = 0] = (version ?? '').split('.').map(Number)
  return !version || major > 8 || (major === 8 && minor >= 1)
}

/** Move saves with a Ren'Py Sync code, both ways. */
function SyncDialog({ game, onClose, onDownloaded }: { game: Game; onClose: () => void; onDownloaded: () => void }) {
  const toast = useToast()
  const [made, setMade] = useState<{ code: string; saves: number; expiresAt: number } | null>(null)
  const [making, setMaking] = useState(false)
  const [code, setCode] = useState('')
  const [fetching, setFetching] = useState(false)
  const make = async () => {
    setMaking(true)
    try {
      setMade(await post(`/api/saves/${game.id}/sync`, { tz: timeZone() }))
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setMaking(false)
    }
  }
  const fetchCode = async () => {
    setFetching(true)
    try {
      const r = await post<{ added: number; replaced: number; kept: number; same: number }>(`/api/saves/${game.id}/sync/download`, { code })
      const parts = [r.added && `${r.added} new`, r.replaced && `${r.replaced} newer`, r.kept && `${r.kept} older, kept in History`].filter(Boolean)
      toast(parts.length ? `Saves brought in: ${parts.join(', ')}.` : 'These saves were already here.', 'success')
      setCode('')
      onDownloaded()
    } catch (e) {
      toast(errorText(e), 'error')
    } finally {
      setFetching(false)
    }
  }
  return (
    <Modal open onClose={onClose} title="Move saves with a Sync code" fullPhone>
      <div className="stack" style={{ gap: 24 }}>
        {!hasSync(game.renpyVersion) && (
          <p className="notice amber small">
            This version of {game.title} was made with Ren’Py {game.renpyVersion}, which has no Sync. Codes work with games made with Ren’Py 8.1 or newer.
          </p>
        )}
        <section className="stack" style={{ gap: 10 }}>
          <h3 style={{ fontWeight: 650 }}>To another device</h3>
          {made ? (
            <>
              <div className="code" style={{ userSelect: 'all' }}>{made.code}</div>
              <p className="small muted">
                On your computer or Android phone, open {game.title}, choose Download Sync on its save or load screen and type the code. It works until{' '}
                {new Date(made.expiresAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.
              </p>
            </>
          ) : (
            <>
              <p className="small muted">
                Renplay sends your saves of {game.title}, encrypted, to Ren’Py’s sync server and shows a code. Only someone with the code can open them, and
                the server deletes them after an hour.
              </p>
              <div>
                <Button variant="primary" loading={making} onClick={() => void make()}>
                  Make a code
                </Button>
              </div>
            </>
          )}
        </section>
        <section className="stack" style={{ gap: 10, paddingTop: 20, borderTop: '1px solid var(--line)' }}>
          <h3 style={{ fontWeight: 650 }}>From another device</h3>
          <p className="small muted">On the other device choose Upload Sync on the game’s save or load screen, then type its code here. Never use a code someone else made.</p>
          <form
            className="row wrap"
            style={{ gap: 8 }}
            onSubmit={(e) => {
              e.preventDefault()
              void fetchCode()
            }}
          >
            <input
              className="input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCDE-12345"
              aria-label="Sync code"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={11}
              style={{ width: 180, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', letterSpacing: '0.08em' }}
            />
            <Button type="submit" loading={fetching} disabled={code.replace(/-/g, '').trim().length !== 10}>
              Bring in the saves
            </Button>
          </form>
        </section>
      </div>
    </Modal>
  )
}
