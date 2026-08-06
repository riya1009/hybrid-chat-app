import { useEffect, useState } from 'react'

/** Tracks a MediaStream's live audio level (roughly 0–1) via the Web Audio API's
 * AnalyserNode, for a "someone is speaking" indicator. Purely a read-only tap on the
 * stream — doesn't play or otherwise affect it, so it's safe to use alongside whatever
 * element is actually rendering the audio. */
export function useAudioLevel(stream) {
  const [level, setLevel] = useState(0)

  useEffect(() => {
    if (!stream || stream.getAudioTracks().length === 0) {
      setLevel(0)
      return
    }

    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 256
    analyser.smoothingTimeConstant = 0.6
    source.connect(analyser)

    const data = new Uint8Array(analyser.frequencyBinCount)
    let rafId

    function tick() {
      analyser.getByteFrequencyData(data)
      const average = data.reduce((sum, v) => sum + v, 0) / data.length
      setLevel(Math.min(1, average / 70))
      rafId = requestAnimationFrame(tick)
    }
    tick()

    return () => {
      cancelAnimationFrame(rafId)
      source.disconnect()
      analyser.disconnect()
      ctx.close().catch(() => {})
    }
  }, [stream])

  return level
}
