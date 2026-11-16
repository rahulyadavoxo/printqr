let ctx: AudioContext | null = null

/** Short "ding ding" for a new order. Browsers allow sound only after the user has tapped once on the page. */
export function ding() {
  try {
    ctx = ctx || new AudioContext()
    const now = ctx.currentTime
    ;[0, 0.25].forEach((t, i) => {
      const o = ctx!.createOscillator()
      const g = ctx!.createGain()
      o.type = 'sine'
      o.frequency.value = i ? 1320 : 880
      g.gain.setValueAtTime(0.0001, now + t)
      g.gain.exponentialRampToValueAtTime(0.4, now + t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.22)
      o.connect(g).connect(ctx!.destination)
      o.start(now + t)
      o.stop(now + t + 0.25)
    })
  } catch {
    /* ignore */
  }
}

export function unlockAudio() {
  try {
    ctx = ctx || new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
  } catch {
    /* ignore */
  }
}
