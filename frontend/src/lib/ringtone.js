/**
 * Synthesized ringback (caller) and ringtone (callee) sounds via the Web Audio API —
 * no audio files to bundle/license. Each `play*()` call schedules a repeating tone
 * pattern and returns a `stop()` function; callers are responsible for stopping it
 * once the call connects, is declined, or ends.
 */

let audioCtx = null

function getAudioContext() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)()
  return audioCtx
}

/** Browsers only let an AudioContext actually produce sound after a real user gesture
 * (click/keypress/tap) on the page — otherwise it starts (or stays) "suspended" and
 * scheduled tones are silently dropped, no error. An *incoming* call's ringtone is
 * triggered by a WebSocket message, not a click, so without this it can be silently
 * blocked — this is what made desktop calls silent while a click-initiated outgoing call
 * happened to work. Call this once at app startup: it listens for the very first
 * interaction with the page (which happens long before any call, e.g. clicking into a
 * chat) and resumes the shared context right then, so it's already unlocked by the time
 * a ringtone actually needs to play. */
export function unlockAudioOnFirstInteraction() {
  const unlock = () => {
    getAudioContext().resume?.().catch(() => {})
    window.removeEventListener('pointerdown', unlock)
    window.removeEventListener('keydown', unlock)
  }
  window.addEventListener('pointerdown', unlock)
  window.addEventListener('keydown', unlock)
}

function beep(ctx, frequency, startTime, duration, peakGain = 0.15) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.value = frequency
  // Ramp the gain up/down instead of a hard on/off, so it doesn't click/pop.
  gain.gain.setValueAtTime(0, startTime)
  gain.gain.linearRampToValueAtTime(peakGain, startTime + 0.02)
  gain.gain.setValueAtTime(peakGain, Math.max(startTime + 0.02, startTime + duration - 0.02))
  gain.gain.linearRampToValueAtTime(0, startTime + duration)
  osc.connect(gain).connect(ctx.destination)
  osc.start(startTime)
  osc.stop(startTime + duration)
}

function startLoop(scheduleOneCycle, cycleMs) {
  const ctx = getAudioContext()
  ctx.resume?.().catch(() => {}) // no-op if already running or blocked; next gesture will unblock it
  let stopped = false
  let timeoutId = null

  function tick() {
    if (stopped) return
    scheduleOneCycle(ctx)
    timeoutId = setTimeout(tick, cycleMs)
  }
  tick()

  return () => {
    stopped = true
    clearTimeout(timeoutId)
  }
}

/** The caller hears this while waiting for the other side to answer — a steady
 * dual-tone beep, similar to a standard telephone ringback. */
export function playRingback() {
  return startLoop((ctx) => {
    const now = ctx.currentTime
    beep(ctx, 440, now, 1.2)
    beep(ctx, 480, now, 1.2)
  }, 3000)
}

/** The callee hears this while a call is incoming — a brighter double-beep "ring-ring",
 * deliberately distinct from the ringback so each side's role is audibly obvious. */
export function playIncomingRing() {
  return startLoop((ctx) => {
    const now = ctx.currentTime
    beep(ctx, 587.33, now, 0.35, 0.18)
    beep(ctx, 587.33, now + 0.45, 0.35, 0.18)
  }, 1600)
}
