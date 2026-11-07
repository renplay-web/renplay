import { useEffect, useRef, useState } from 'react'
import { useAdultView } from '../lib/adult'
import { useGame, useJobs } from '../lib/queries'
import ArtPicker from './ArtPicker'
import { useAuth } from '../lib/auth'

const OFFERED = (game: string) => `renplay:art-step:${game}`

/**
 * The Choose artwork step (DESIGN 0.8): opens once when an install finishes, on the device of the
 * admin who installed it. Below Shown an adult game's art is not offered, so the step stays closed.
 */
export default function ChooseArtwork() {
  const { data } = useJobs()
  const active = useRef<Set<string> | null>(null)
  const [id, setId] = useState<string | null>(null)
  const { data: game } = useGame(id ?? undefined)
  const view = useAdultView()
  const me = useAuth().data?.user.id
  useEffect(() => {
    const jobs = data?.jobs ?? []
    const now = new Set(jobs.filter((j) => j.type === 'import' && (j.status === 'running' || j.status === 'queued')).map((j) => j.id))
    // The first answer only sets the baseline: installs that finished before this page opened are not offered.
    if (active.current) {
      for (const jobId of active.current) {
        const job = jobs.find((j) => j.id === jobId)
        // Only for whoever started the install (installs from before 4.0.2 do not say).
        if (job?.params?.by !== undefined && job.params.by !== me) continue
        const game = job?.status === 'done' ? (job.result?.game as string | undefined) ?? job.game : undefined
        if (!game || localStorage.getItem(OFFERED(game))) continue
        localStorage.setItem(OFFERED(game), '1')
        setId(game)
      }
    }
    active.current = now
  }, [data, me])
  if (!game || (game.nsfw && view !== 'shown')) return null
  return <ArtPicker game={game} open step onClose={() => setId(null)} />
}
