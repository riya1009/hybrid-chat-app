import { useEffect, useRef } from 'react'
import { Mic, MicOff, Video, VideoOff, PhoneOff, Check, X } from 'lucide-react'
import Avatar from './Avatar'
import { playIncomingRing, playRingback } from '../lib/ringtone'
import { useAudioLevel } from '../hooks/useAudioLevel'

/** Attaches a stream to a <video>/<audio> element and explicitly calls .play() —
 * relying on just the `autoplay` HTML attribute is unreliable once `srcObject` is set
 * imperatively via JS after the element has already mounted (our case, always). If the
 * browser blocks it (no recent-enough user gesture on this page), retries once on the
 * next real interaction instead of staying silent forever with no visible error. */
function useStreamPlayback(ref, stream) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.srcObject = stream || null
    if (!stream) return

    function retry() {
      el.play().catch(() => {})
    }
    el.play().catch((err) => {
      console.warn('Media autoplay blocked — will retry on next click/keypress', err)
      window.addEventListener('pointerdown', retry, { once: true })
      window.addEventListener('keydown', retry, { once: true })
    })

    return () => {
      window.removeEventListener('pointerdown', retry)
      window.removeEventListener('keydown', retry)
    }
  }, [ref, stream])
}

function VideoTile({ stream, muted, mirror }) {
  const ref = useRef(null)
  useStreamPlayback(ref, stream)

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={muted}
      className={`h-full w-full object-cover ${mirror ? 'scale-x-[-1]' : ''}`}
    />
  )
}

/** Always-mounted, invisible — the one and only element that actually plays back the
 * remote party's audio, regardless of whether video is also being shown. Without this,
 * an audio-only call has no element consuming `remoteStream` at all (the video tile only
 * mounts when there's video to show), so nothing plays — see the "can't hear each other"
 * fix this was added for. When video *is* shown, the video tile is muted so audio is only
 * ever played through this single element, never doubled up. */
function RemoteAudioSink({ stream }) {
  const ref = useRef(null)
  useStreamPlayback(ref, stream)

  return <audio ref={ref} autoPlay className="hidden" />
}

const WAVEFORM_BAR_WEIGHTS = [0.35, 0.65, 1, 0.65, 0.35]

/** A small animated "someone is speaking" indicator, driven by the live audio level of
 * the given stream — shown during audio-only calls the same way WhatsApp shows a
 * waveform/pulse while the other person talks. */
function VoiceWaveform({ stream }) {
  const level = useAudioLevel(stream)
  return (
    <div className="flex h-8 items-end gap-1" aria-hidden="true">
      {WAVEFORM_BAR_WEIGHTS.map((weight, i) => (
        <div
          key={i}
          className="w-1.5 rounded-full bg-emerald-400 transition-[height] duration-100"
          style={{ height: `${6 + level * 26 * weight}px` }}
        />
      ))}
    </div>
  )
}

export default function CallOverlay({
  callState,
  incomingCallVideo,
  localStream,
  remoteStream,
  isMuted,
  isCameraOn,
  peer,
  onAccept,
  onDecline,
  onHangUp,
  onToggleMute,
  onToggleCamera,
}) {
  // Ringback for the caller ("outgoing"), a ring for the callee ("incoming") — stops itself
  // automatically the moment callState moves on to "connected" or back to "idle".
  useEffect(() => {
    let stop = null
    if (callState === 'outgoing') stop = playRingback()
    else if (callState === 'incoming') stop = playIncomingRing()
    return () => stop?.()
  }, [callState])

  if (callState === 'idle') return null

  const remoteHasVideo = !!remoteStream?.getVideoTracks().some((t) => t.enabled)
  const localHasVideo = !!localStream?.getVideoTracks().some((t) => t.enabled)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-slate-950/95 text-white backdrop-blur">
      {/* Always mounted so audio plays regardless of whether video is shown — see the
          component's own doc comment for why this must not be conditional on remoteHasVideo. */}
      <RemoteAudioSink stream={remoteStream} />

      <div className="relative min-h-0 flex-1">
        {callState === 'connected' && remoteHasVideo ? (
          <VideoTile stream={remoteStream} muted />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <Avatar name={peer?.name} color={peer?.avatar_color} size={112} />
            <div className="text-xl font-medium">{peer?.name}</div>
            <div className="text-white/60">
              {callState === 'outgoing' && 'Calling…'}
              {callState === 'incoming' && (incomingCallVideo ? 'Incoming video call' : 'Incoming call')}
              {callState === 'connected' && 'Call connected'}
            </div>
            {callState === 'connected' && <VoiceWaveform stream={remoteStream} />}
          </div>
        )}

        {callState === 'connected' && localHasVideo && (
          <div className="absolute bottom-6 right-6 h-40 w-28 overflow-hidden rounded-xl border border-white/20 shadow-lg sm:h-48 sm:w-36">
            <VideoTile stream={localStream} muted mirror />
          </div>
        )}
      </div>

      <div className="flex items-center justify-center gap-4 pb-10 pt-4">
        {callState === 'incoming' ? (
          <>
            <button
              onClick={onDecline}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 transition hover:bg-red-600"
              title="Decline"
            >
              <X size={26} />
            </button>
            <button
              onClick={onAccept}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 transition hover:bg-emerald-600"
              title="Accept"
            >
              <Check size={26} />
            </button>
          </>
        ) : (
          <>
            <button
              onClick={onToggleMute}
              className={`flex h-12 w-12 items-center justify-center rounded-full transition ${
                isMuted ? 'bg-white text-slate-900' : 'bg-white/15 text-white hover:bg-white/25'
              }`}
              title={isMuted ? 'Unmute' : 'Mute'}
            >
              {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
            </button>
            <button
              onClick={onToggleCamera}
              className={`flex h-12 w-12 items-center justify-center rounded-full transition ${
                !isCameraOn ? 'bg-white text-slate-900' : 'bg-white/15 text-white hover:bg-white/25'
              }`}
              title={isCameraOn ? 'Turn camera off' : 'Turn camera on'}
            >
              {isCameraOn ? <Video size={20} /> : <VideoOff size={20} />}
            </button>
            <button
              onClick={onHangUp}
              className="flex h-14 w-14 items-center justify-center rounded-full bg-red-500 transition hover:bg-red-600"
              title="Hang up"
            >
              <PhoneOff size={24} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
