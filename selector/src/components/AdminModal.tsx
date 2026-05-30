import { useState, useEffect } from 'react'
import type { Game } from '../types'
import { useAdmin, type GameFormData } from '../hooks/useAdmin'

interface Props {
  open: boolean
  onClose: () => void
  games: Game[]
  onChanged: () => void
}

export default function AdminModal({ open, onClose, games, onChanged }: Props) {
  const { create, update, remove, saving, error, clearError, emptyForm, gameToForm } = useAdmin()
  const [editing, setEditing] = useState<GameFormData | null>(null)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<GameFormData>(emptyForm)

  useEffect(() => {
    if (!open) {
      setEditing(null)
      setAdding(false)
      setForm(emptyForm)
      clearError()
    }
  }, [open, clearError])

  const startAdd = () => {
    setAdding(true)
    setForm(emptyForm)
    clearError()
  }

  const startEdit = (g: Game) => {
    setEditing(gameToForm(g))
    setForm(gameToForm(g))
    clearError()
  }

  const handleSave = async () => {
    if (!form.title.trim() || !form.slug.trim()) return
    let ok: boolean
    if (editing) {
      ok = await update(editing.slug, form)
    } else {
      ok = await create(form)
    }
    if (ok) {
      setEditing(null)
      setAdding(false)
      setForm(emptyForm)
      onChanged()
    }
  }

  const handleDelete = async (slug: string) => {
    if (!confirm(`Delete "${slug}"?`)) return
    const ok = await remove(slug)
    if (ok) onChanged()
  }

  if (!open) return null

  const showForm = editing || adding

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

        {!showForm && (
          <div className="mb-6">
            <button
              onClick={startAdd}
              className="flex items-center gap-2 rounded-xl border border-dashed border-gray-600 px-4 py-3 text-sm text-gray-400 hover:border-indigo-500/50 hover:text-indigo-300 transition-all w-full justify-center"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
              </svg>
              Add Game
            </button>
          </div>
        )}

        {showForm && (
          <div className="mb-6 rounded-xl border border-gray-700/50 bg-gray-800/60 p-4 space-y-3">
            <h3 className="text-sm font-semibold text-gray-300">
              {editing ? `Edit: ${editing.title}` : 'New Game'}
            </h3>

            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  Slug <span className="text-indigo-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.slug}
                  onChange={(e) => setForm({ ...form, slug: e.target.value })}
                  placeholder="my-game"
                  disabled={!!editing}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-500/50 focus:outline-none disabled:opacity-40"
                />
              </div>
              <div className="col-span-2 sm:col-span-1">
                <label className="block text-xs font-medium text-gray-400 mb-1">
                  Title <span className="text-indigo-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm({ ...form, title: e.target.value })}
                  placeholder="My Game"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-500/50 focus:outline-none"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">Author (optional)</label>
                <input
                  type="text"
                  value={form.author}
                  onChange={(e) => setForm({ ...form, author: e.target.value })}
                  placeholder="Author Name"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-500/50 focus:outline-none"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">Description (optional)</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="A short description..."
                  rows={2}
                  className="w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-500/50 focus:outline-none resize-none"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-gray-500 mb-1">Tags (optional, comma-separated)</label>
                <input
                  type="text"
                  value={form.tags}
                  onChange={(e) => setForm({ ...form, tags: e.target.value })}
                  placeholder="visual-novel, romance"
                  className="w-full rounded-lg border border-gray-700 bg-gray-900/60 px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-indigo-500/50 focus:outline-none"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={handleSave}
                disabled={saving || !form.title.trim() || !form.slug.trim()}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Saving...' : editing ? 'Update' : 'Create'}
              </button>
              <button
                onClick={() => { setEditing(null); setAdding(false); setForm(emptyForm); clearError() }}
                className="rounded-lg border border-gray-700 px-4 py-2 text-sm text-gray-400 hover:bg-gray-800 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="space-y-2">
          {games.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-500">No games yet. Add one above.</p>
          ) : (
            games.map((g) => (
              <div
                key={g.slug}
                className="flex items-center gap-3 rounded-xl border border-gray-800 bg-gray-800/30 px-4 py-3"
              >
                <div className="flex flex-col gap-0.5 flex-shrink-0">
                  <button
                    onClick={async () => {
                      await fetch(`/api/games/${encodeURIComponent(g.slug)}/move`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ direction: 'up' }),
                      })
                      onChanged()
                    }}
                    className="rounded p-0.5 text-gray-500 hover:text-indigo-400 transition-colors"
                    title="Move up"
                  >
                    <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
                    </svg>
                  </button>
                  <button
                    onClick={async () => {
                      await fetch(`/api/games/${encodeURIComponent(g.slug)}/move`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ direction: 'down' }),
                      })
                      onChanged()
                    }}
                    className="rounded p-0.5 text-gray-500 hover:text-indigo-400 transition-colors"
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
