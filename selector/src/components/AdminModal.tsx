import { useState, useEffect, useRef } from 'react'
import type { Game } from '../types'
import { useAdmin, type EditFormData } from '../hooks/useAdmin'

const PRESPLASH_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif']

interface Props {
  open: boolean
  onClose: () => void
  games: Game[]
  onChanged: () => void
}

export default function AdminModal({ open, onClose, games, onChanged }: Props) {
  const { update, remove, reorder, scan, uploadThumbnail, removeThumbnail, saving, error, clearError, gameToForm } = useAdmin()
  const [editing, setEditing] = useState<EditFormData | null>(null)
  const [editSlug, setEditSlug] = useState<string | null>(null)
  const [form, setForm] = useState<EditFormData>({ title: '', tags: '' })
  const [scanResult, setScanResult] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [orderedGames, setOrderedGames] = useState<Game[]>([])
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const dragOverIdx = useRef<number | null>(null)
  const [previewExtIdx, setPreviewExtIdx] = useState(0)
  const [previewFailed, setPreviewFailed] = useState(false)

  useEffect(() => {
    if (open) {
      setOrderedGames(games)
    }
  }, [games, open])

  useEffect(() => {
    setPreviewExtIdx(0)
    setPreviewFailed(false)
  }, [editSlug])

  useEffect(() => {
    if (!open) {
      setEditing(null)
      setEditSlug(null)
      setForm({ title: '', tags: '' })
      setScanResult(null)
      setDragIdx(null)
      dragOverIdx.current = null
      setPreviewExtIdx(0)
      setPreviewFailed(false)
      clearError()
    }
  }, [open, clearError])

  const editingGame = editSlug ? games.find(g => g.slug === editSlug) ?? null : null

  const startEdit = (g: Game) => {
    setEditSlug(g.slug)
    setEditing(gameToForm(g))
    setForm(gameToForm(g))
    clearError()
  }

  const cancelEdit = () => {
    setEditing(null)
    setEditSlug(null)
    setForm({ title: '', tags: '' })
    clearError()
  }

  const handleSave = async () => {
    if (!form.title.trim() || !editSlug) return
    const ok = await update(editSlug, form)
    if (ok) {
      cancelEdit()
      onChanged()
    }
  }

  const handleDelete = async (slug: string) => {
    if (!confirm(`Delete "${slug}"?`)) return
    const ok = await remove(slug)
    if (ok) onChanged()
  }

  const handleScan = async () => {
    setScanResult(null)
    const result = await scan()
    if (result) {
      const n = result.created.length
      setScanResult(n > 0 ? `Found ${n} new game(s): ${result.created.join(', ')}` : 'No new games found.')
      if (n > 0) onChanged()
    }
  }

  const handleUploadThumbnail = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file || !editSlug) return
    setUploading(true)
    const ok = await uploadThumbnail(editSlug, file)
    setUploading(false)
    if (ok) onChanged()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleRemoveThumbnail = async () => {
    if (!editSlug) return
    const ok = await removeThumbnail(editSlug)
    if (ok) onChanged()
  }

  // drag-and-drop
  const handleDragStart = (idx: number) => {
    setDragIdx(idx)
  }

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault()
    dragOverIdx.current = idx
  }

  const handleDragEnd = async () => {
    const from = dragIdx
    const to = dragOverIdx.current
    setDragIdx(null)
    dragOverIdx.current = null
    if (from === null || to === null || from === to) return

    const newOrder = [...orderedGames]
    const [moved] = newOrder.splice(from, 1)
    newOrder.splice(to, 0, moved)
    setOrderedGames(newOrder)

    const ok = await reorder(newOrder.map(g => g.slug))
    if (ok) onChanged()
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 pt-12 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-2xl border border-gray-700/50 bg-gray-900 p-6 shadow-2xl mx-4 mb-12">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold text-white">Manage Games</h2>
          <button onClick={onClose} className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-white transition-colors">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-2 text-sm text-red-400">
            {error}
          </div>
        )}

        {scanResult && (
          <div className="mb-4 rounded-lg border border-green-800/50 bg-green-900/20 px-4 py-2 text-sm text-green-400">
            {scanResult}
          </div>
        )}

        <div className="mb-6">
          <button
            onClick={handleScan}
            disabled={saving}
            className="flex items-center gap-2 rounded-xl border border-dashed border-gray-600 px-4 py-3 text-sm text-gray-400 hover:border-indigo-500/50 hover:text-indigo-300 transition-all w-full justify-center disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {saving ? 'Scanning...' : 'Scan for new games'}
          </button>
        </div>

        {editing && editSlug && (
          <div className="mb-6 rounded-xl border border-gray-700/50 bg-gray-800/60 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-300">
              Edit: {editing.title}
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-400 mb-1">Title</label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="Game Title"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-500/50 focus:outline-none"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">Tags (comma-separated)</label>
                <input
                  type="text"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="visual-novel, romance"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-500/50 focus:outline-none"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-2">Thumbnail</label>
                <div className="flex items-center gap-3">
                  <div className="w-20 h-12 rounded-lg overflow-hidden bg-gray-900 flex-shrink-0 flex items-center justify-center">
                    {previewFailed ? (
                      <span className="text-lg">🎮</span>
                    ) : (
                      <img
                        key={editingGame?.thumbnail ? 'custom' : `presplash-${previewExtIdx}`}
                        src={editingGame?.thumbnail ? `/api/thumbnails/${editingGame.thumbnail}` : `/play/${editSlug}/web-presplash.${PRESPLASH_EXTS[previewExtIdx]}`}
                        alt=""
                        className="w-full h-full object-cover"
                        onError={() => {
                          if (!editingGame?.thumbnail && previewExtIdx < PRESPLASH_EXTS.length - 1) {
                            setPreviewExtIdx(i => i + 1)
                          } else {
                            setPreviewFailed(true)
                          }
                        }}
                      />
                    )}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
                    onChange={handleUploadThumbnail}
                    className="hidden"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={uploading}
                    className="rounded-lg border border-gray-700 px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700 hover:text-white transition-colors disabled:opacity-40"
                  >
                    {uploading ? 'Uploading...' : 'Upload'}
                  </button>
                  {editingGame?.thumbnail && (
                    <button
                      onClick={handleRemoveThumbnail}
                      className="rounded-lg border border-red-900/50 px-3 py-1.5 text-xs text-red-400 hover:bg-red-900/30 hover:text-red-300 transition-colors"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={handleSave}
                disabled={saving || !form.title.trim()}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Saving...' : 'Update'}
              </button>
              <button
                onClick={cancelEdit}
                className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {orderedGames.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">
              No games found. Click "Scan for new games" after placing game files in the games directory.
            </p>
          ) : (
            orderedGames.map((g, idx) => (
              <div
                key={g.slug}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={(e) => handleDragOver(e, idx)}
                onDragEnd={handleDragEnd}
                className={`flex items-center gap-3 rounded-xl border px-4 py-3 transition-colors ${
                  dragIdx === idx
                    ? 'border-indigo-500/50 bg-indigo-900/20 opacity-50'
                    : 'border-gray-800 bg-gray-800/30'
                } ${dragOverIdx.current === idx && dragIdx !== idx ? 'border-t-indigo-400' : ''}`}
              >
                <div className="flex flex-col gap-0.5 flex-shrink-0 cursor-grab active:cursor-grabbing">
                  <button
                    onClick={async () => {
                      if (idx === 0) return
                      const newOrder = [...orderedGames]
                      const [moved] = newOrder.splice(idx, 1)
                      newOrder.splice(idx - 1, 0, moved)
                      setOrderedGames(newOrder)
                      const ok = await reorder(newOrder.map(g => g.slug))
                      if (ok) onChanged()
                    }}
                    disabled={idx === 0}
                    className={`rounded p-0.5 transition-colors ${
                      idx === 0 ? 'text-gray-700 cursor-not-allowed' : 'text-gray-500 hover:text-indigo-400'
                    }`}
                    title="Move up"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                    </svg>
                  </button>
                  <button
                    onClick={async () => {
                      if (idx === orderedGames.length - 1) return
                      const newOrder = [...orderedGames]
                      const [moved] = newOrder.splice(idx, 1)
                      newOrder.splice(idx + 1, 0, moved)
                      setOrderedGames(newOrder)
                      const ok = await reorder(newOrder.map(g => g.slug))
                      if (ok) onChanged()
                    }}
                    disabled={idx === orderedGames.length - 1}
                    className={`rounded p-0.5 transition-colors ${
                      idx === orderedGames.length - 1 ? 'text-gray-700 cursor-not-allowed' : 'text-gray-500 hover:text-indigo-400'
                    }`}
                    title="Move down"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-white truncate">{g.title}</p>
                  <p className="text-xs text-gray-500 truncate">
                    {g.slug}
                    {g.tags && g.tags.length > 0 && ` · ${g.tags.join(', ')}`}
                  </p>
                </div>
                <button
                  onClick={() => startEdit(g)}
                  className="rounded-lg p-2 text-gray-500 hover:bg-gray-700 hover:text-indigo-400 transition-colors"
                  title="Edit"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                  </svg>
                </button>
                <button
                  onClick={() => handleDelete(g.slug)}
                  className="rounded-lg p-2 text-gray-500 hover:bg-gray-700 hover:text-red-400 transition-colors"
                  title="Delete"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
