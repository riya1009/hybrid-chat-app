import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'

// STUN alone can't traverse restrictive/symmetric NATs — common on mobile carrier networks —
// where no direct path between peers exists at all, no matter how many candidates are tried.
// TURN relays media through a third-party server as a last resort so the call still connects.
// These are the Open Relay Project's public, no-signup-required TURN credentials
// (https://www.metered.ca/tools/openrelay/) — free and shared, so it comes with modest
// bandwidth limits and no uptime guarantee, but that's an appropriate trade-off here: it only
// gets used as a fallback when direct/STUN connectivity fails, not as the primary path.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:openrelay.metered.ca:80' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
]

function describeMediaError(err) {
  if (err?.name === 'NotAllowedError') return 'Microphone/camera permission was denied.'
  if (err?.name === 'NotFoundError') return 'No microphone/camera found on this device.'
  if (err?.name === 'NotReadableError') return 'Microphone/camera is already in use by another app.'
  return err?.message || 'Could not access the microphone/camera.'
}

/**
 * One RTCPeerConnection per open 1:1 chat, carrying both an opportunistic
 * text data-channel (the P2P fast-path from README_fastapi.md) and, on
 * demand, a voice/video call — signaled entirely over the FastAPI WebSocket
 * relay (see useWebSocket's sendSignal/onSignal), no third-party broker.
 *
 * Uses the "perfect negotiation" pattern (see webrtc.org/perfect-negotiation)
 * so either side can add/remove tracks (call start, camera toggle) without
 * the two peers' offers colliding: the lower user-id is the "polite" side
 * and always yields to an incoming offer instead of asserting its own.
 */
export function useWebRTC({ peerId, peerOnline, sendSignal, onSignal, onP2PMessage }) {
  const { user } = useAuth()
  const polite = user.id < peerId

  const pcRef = useRef(null)
  const dcRef = useRef(null)
  const makingOfferRef = useRef(false)
  const ignoreOfferRef = useRef(false)
  const pendingOfferRef = useRef(null) // buffered SDP offer while an incoming call awaits accept/decline
  const localStreamRef = useRef(null)
  const connectFailureTimerRef = useRef(null)

  const [p2pConnected, setP2pConnected] = useState(false)
  const [callState, setCallState] = useState('idle') // idle | outgoing | incoming | connected
  // Mirrors `callState` synchronously (refs aren't subject to React's render/effect-flush
  // lag the way a value captured in a closure is). The signaling handler below is recreated
  // by an effect that only re-runs after React actually flushes the state update — on a fast
  // enough network, an SDP offer for a just-announced incoming call could theoretically be
  // processed by a handler that still closes over the *previous* render's `callState` ('idle'
  // instead of 'incoming'), skipping the "wait for Accept" buffering entirely and
  // auto-answering with no local media ever attached. Reading a ref instead is immune to that
  // lag regardless of which render's closure ends up running.
  const callStateRef = useRef('idle')
  const [incomingCallVideo, setIncomingCallVideo] = useState(false)
  const [localStream, setLocalStream] = useState(null)
  const [remoteStream, setRemoteStream] = useState(null)
  const [isMuted, setIsMuted] = useState(false)
  const [isCameraOn, setIsCameraOn] = useState(false)
  const [callError, setCallError] = useState(null)

  const setCallStateBoth = useCallback((next) => {
    callStateRef.current = next
    setCallState(next)
  }, [])

  const setupDataChannel = useCallback(
    (channel) => {
      dcRef.current = channel
      channel.onopen = () => setP2pConnected(true)
      channel.onclose = () => setP2pConnected(false)
      channel.onmessage = (evt) => {
        const data = JSON.parse(evt.data)
        onP2PMessage({ ...data, sender_id: peerId, delivered_via: 'p2p', viaP2P: true })
      }
    },
    [onP2PMessage, peerId]
  )

  const endCallLocal = useCallback(() => {
    const pc = pcRef.current
    if (pc) {
      pc.getSenders().forEach((sender) => {
        if (sender.track && (sender.track.kind === 'audio' || sender.track.kind === 'video')) {
          try {
            pc.removeTrack(sender)
          } catch {
            /* already removed */
          }
        }
      })
    }
    localStreamRef.current?.getTracks().forEach((t) => t.stop())
    localStreamRef.current = null
    clearTimeout(connectFailureTimerRef.current)
    connectFailureTimerRef.current = null
    setLocalStream(null)
    setRemoteStream(null)
    setCallStateBoth('idle')
    setIsMuted(false)
    setIsCameraOn(false)
    pendingOfferRef.current = null
  }, [setCallStateBoth])

  // Split from acceptCall itself because of a real race: the "incoming call" UI appears the
  // instant the call-invite control message arrives, but the actual SDP offer is a separate
  // message sent slightly later (the caller has to acquire mic/camera and let
  // onnegotiationneeded fire first). A fast tap on Accept can land *before* the offer has
  // arrived — acceptRequestedRef records that intent, and whichever of "the offer arrives" or
  // "the user taps Accept" happens second is what actually triggers performAccept. Without
  // this, tapping Accept too quickly silently did nothing (pendingOfferRef.current was still
  // null), which is exactly "the receive button doesn't work" — it wasn't broken, it just had
  // nothing to accept yet and never retried.
  const acceptRequestedRef = useRef(false)

  // Signaling (SDP offer/answer) completing is not the same thing as the call actually
  // connecting — this app has no TURN server, only STUN, so on a restrictive/symmetric NAT
  // (common on mobile data) ICE can fail to find any usable path entirely. Without this,
  // the UI just says "Call connected" forever with silent, empty audio/video and no way to
  // tell "network couldn't connect" apart from "something's actually broken" — which is
  // exactly what reads as "the receive button doesn't work." This gives it a hard deadline
  // to prove the connection is real before treating it as failed.
  const armConnectFailureWatch = useCallback(() => {
    clearTimeout(connectFailureTimerRef.current)
    connectFailureTimerRef.current = setTimeout(() => {
      const pc = pcRef.current
      if (pc && pc.connectionState !== 'connected') {
        setCallError(
          'Call failed to connect — this can happen on restrictive networks. Try switching networks (e.g. Wi-Fi instead of mobile data) and calling again.'
        )
        sendSignal({ control: 'call-end' })
        endCallLocal()
      }
    }, 12000)
  }, [sendSignal, endCallLocal])

  const performAccept = useCallback(async () => {
    const pc = pcRef.current
    if (!pc || !pendingOfferRef.current) return
    acceptRequestedRef.current = false
    setCallError(null)

    try {
      // getUserMedia has to be the very first awaited thing here, before touching the peer
      // connection at all. Some mobile browsers (notably iOS Safari) only treat a permission
      // prompt as tied to "a real tap just happened" for a brief window — awaiting
      // setRemoteDescription first can cross that window, so the mic/camera prompt either
      // never appears or gets auto-rejected with no visible sign why. Tapping Accept, from
      // the user's perspective, would then look exactly like the button doing nothing.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: incomingCallVideo })
      localStreamRef.current = stream
      setLocalStream(stream)
      setIsCameraOn(incomingCallVideo)

      await pc.setRemoteDescription(pendingOfferRef.current)
      pendingOfferRef.current = null
      stream.getTracks().forEach((track) => pc.addTrack(track, stream))

      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      sendSignal({ description: pc.localDescription })
      setCallStateBoth('connected')
      armConnectFailureWatch()
    } catch (err) {
      console.error('acceptCall failed', err)
      setCallError(describeMediaError(err))
      sendSignal({ control: 'call-end' })
      endCallLocal()
    }
  }, [incomingCallVideo, sendSignal, endCallLocal, setCallStateBoth, armConnectFailureWatch])

  // Create / tear down the RTCPeerConnection as the peer comes online/offline.
  useEffect(() => {
    if (!peerOnline) {
      pcRef.current?.close()
      pcRef.current = null
      dcRef.current = null
      setP2pConnected(false)
      return
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    pcRef.current = pc

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) sendSignal({ candidate })
    }

    pc.ontrack = (evt) => {
      setRemoteStream(evt.streams[0] || null)
    }

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        clearTimeout(connectFailureTimerRef.current)
        connectFailureTimerRef.current = null
      } else if (pc.connectionState === 'failed') {
        pc.restartIce?.()
      }
    }

    pc.ondatachannel = (evt) => setupDataChannel(evt.channel)

    pc.onnegotiationneeded = async () => {
      try {
        makingOfferRef.current = true
        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        sendSignal({ description: pc.localDescription })
      } catch (err) {
        console.error('negotiation failed', err)
      } finally {
        makingOfferRef.current = false
      }
    }

    // Deterministic initiator avoids both sides creating a data channel.
    if (!polite) {
      setupDataChannel(pc.createDataChannel('chat'))
    }

    return () => {
      pc.close()
      pcRef.current = null
      dcRef.current = null
      setP2pConnected(false)
      clearTimeout(connectFailureTimerRef.current)
      connectFailureTimerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peerOnline, polite])

  // Signaling: SDP description / ICE candidates / call control messages.
  useEffect(() => {
    // The WebSocket layer fires each incoming "signal" message as soon as it arrives,
    // without waiting for the previous one to finish — over a real network, an offer
    // and the ICE candidates that follow it can arrive close enough together that two
    // invocations of this (async) handler overlap. Without serializing them, an ICE
    // candidate can start processing before the offer's setRemoteDescription has
    // resolved, hitting "addIceCandidate: remote description was null". Queue them on
    // a promise chain instead so each message is fully handled before the next starts.
    let chain = Promise.resolve()

    return onSignal((data) => {
      chain = chain.then(() => handleSignal(data)).catch((err) => console.error('signal handling failed', err))
    })

    async function handleSignal(data) {
      const pc = pcRef.current
      if (!pc) return

      if (data.control === 'call-invite') {
        pendingOfferRef.current = null
        setIncomingCallVideo(!!data.video)
        setCallStateBoth('incoming')
        return
      }
      if (data.control === 'call-decline' || data.control === 'call-end') {
        endCallLocal()
        return
      }

      if (data.description) {
        const isOffer = data.description.type === 'offer'
        const collision = isOffer && (makingOfferRef.current || pc.signalingState !== 'stable')
        ignoreOfferRef.current = !polite && collision
        if (ignoreOfferRef.current) return

        // An incoming call offer waits for the user to accept/decline before we touch the
        // connection. Reads callStateRef (not the `callState` closed over by this effect)
        // because this handler can otherwise run against a stale 'idle' snapshot for the
        // brief window before React flushes the 'incoming' state update from the
        // call-invite branch above — see callStateRef's own comment for why that matters.
        if (isOffer && callStateRef.current === 'incoming') {
          pendingOfferRef.current = data.description
          if (acceptRequestedRef.current) await performAccept()
          return
        }

        if (collision && polite) {
          await Promise.all([
            pc.setLocalDescription({ type: 'rollback' }),
            pc.setRemoteDescription(data.description),
          ])
        } else {
          await pc.setRemoteDescription(data.description)
        }

        if (isOffer) {
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          sendSignal({ description: pc.localDescription })
        }
      } else if (data.candidate) {
        try {
          await pc.addIceCandidate(data.candidate)
        } catch (err) {
          if (!ignoreOfferRef.current) console.error('addIceCandidate failed', err)
        }
      }
    }
  }, [onSignal, polite, endCallLocal, sendSignal, performAccept])

  const sendP2P = useCallback((message) => {
    if (dcRef.current?.readyState === 'open') {
      dcRef.current.send(JSON.stringify(message))
      return true
    }
    return false
  }, [])

  const startCall = useCallback(
    async (withVideo) => {
      if (!pcRef.current || callStateRef.current !== 'idle') return
      setCallError(null)
      setCallStateBoth('outgoing')
      sendSignal({ control: 'call-invite', video: withVideo })

      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: withVideo })
        localStreamRef.current = stream
        setLocalStream(stream)
        setIsCameraOn(withVideo)
        stream.getTracks().forEach((track) => pcRef.current.addTrack(track, stream))
        setCallStateBoth('connected')
        armConnectFailureWatch()
      } catch (err) {
        // Without this, a denied mic/camera permission left the call stuck on "Calling…"
        // forever with no audio ever sent and no visible error — the callee would just see
        // it silently ring out. Tell the peer to stop ringing and surface why to this side.
        console.error('startCall failed', err)
        setCallError(describeMediaError(err))
        sendSignal({ control: 'call-end' })
        endCallLocal()
      }
    },
    [sendSignal, endCallLocal, setCallStateBoth, armConnectFailureWatch]
  )

  const acceptCall = useCallback(() => {
    acceptRequestedRef.current = true
    if (pendingOfferRef.current) performAccept()
    // else: the offer hasn't arrived yet — handleSignal calls performAccept the moment it does.
  }, [performAccept])

  const declineCall = useCallback(() => {
    sendSignal({ control: 'call-decline' })
    endCallLocal()
  }, [sendSignal, endCallLocal])

  const hangUp = useCallback(() => {
    sendSignal({ control: 'call-end' })
    endCallLocal()
  }, [sendSignal, endCallLocal])

  const toggleMute = useCallback(() => {
    const track = localStreamRef.current?.getAudioTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    setIsMuted(!track.enabled)
  }, [])

  const toggleCamera = useCallback(async () => {
    const pc = pcRef.current
    if (!pc || !localStreamRef.current) return

    if (isCameraOn) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0]
      const sender = pc.getSenders().find((s) => s.track === videoTrack)
      if (sender) pc.removeTrack(sender)
      videoTrack?.stop()
      localStreamRef.current = new MediaStream(localStreamRef.current.getAudioTracks())
      setLocalStream(localStreamRef.current)
      setIsCameraOn(false)
    } else {
      // Unlike startCall/performAccept, this had no error handling at all — a denied/busy
      // camera threw an unhandled rejection and `isCameraOn` just never flipped, with no
      // visible sign anything happened. That's exactly "the camera button doesn't work."
      try {
        const videoStream = await navigator.mediaDevices.getUserMedia({ video: true })
        const videoTrack = videoStream.getVideoTracks()[0]
        localStreamRef.current.addTrack(videoTrack)
        pc.addTrack(videoTrack, localStreamRef.current)
        setLocalStream(new MediaStream(localStreamRef.current.getTracks()))
        setIsCameraOn(true)
      } catch (err) {
        console.error('toggleCamera failed', err)
        setCallError(describeMediaError(err))
      }
    }
  }, [isCameraOn])

  // Safety net: if the peer drops offline mid-call, end the call locally too.
  useEffect(() => {
    if (!peerOnline && callState !== 'idle') endCallLocal()
  }, [peerOnline, callState, endCallLocal])

  const clearCallError = useCallback(() => setCallError(null), [])

  return {
    p2pConnected,
    sendP2P,
    callState,
    incomingCallVideo,
    localStream,
    remoteStream,
    isMuted,
    isCameraOn,
    callError,
    clearCallError,
    startCall,
    acceptCall,
    declineCall,
    hangUp,
    toggleMute,
    toggleCamera,
  }
}
