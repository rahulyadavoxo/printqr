import { useEffect, useState } from 'react'
import storyUrl from '../assets/header-print-shop-story.svg'
import mascotUrl from '../assets/header-printer-mascot.svg'

/** Android app top bar: shop story (10s) -> fades into dots -> printer mascot (10s) -> dots -> loop.
 *  Each picture is mounted fresh, so its own 10s animation starts from the beginning. */
const SCENES = [storyUrl, mascotUrl]
const SCENE_MS = 10000
const FADE_MS = 700
const DOTS_MS = 1300

export default function BarStory() {
  const reduce = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  const [scene, setScene] = useState(0)
  const [phase, setPhase] = useState<'in' | 'out' | 'dots'>('in')

  useEffect(() => {
    if (reduce) return
    let t: number
    if (phase === 'in') t = window.setTimeout(() => setPhase('out'), SCENE_MS - FADE_MS)
    else if (phase === 'out') t = window.setTimeout(() => setPhase('dots'), FADE_MS)
    else t = window.setTimeout(() => { setScene((s) => (s + 1) % SCENES.length); setPhase('in') }, DOTS_MS)
    return () => window.clearTimeout(t)
  }, [phase, reduce])

  return (
    <div className="bar-story m-only" aria-hidden="true">
      {phase === 'dots'
        ? <span className="bs-dots"><i /><i /><i /></span>
        : <img key={scene} className={`bs-img${phase === 'out' ? ' is-out' : ''}`} src={SCENES[scene]} alt="" width={186} height={52} />}
    </div>
  )
}
