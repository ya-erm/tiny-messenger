"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RealtimeClient } from "@/realtime/realtime-client";
import type {
  PresenceItem,
  RealtimeConnectionState,
  ServerRealtimeEvent,
  VoiceSessionSnapshot,
} from "@/realtime/protocol";

type VoiceAction = { kind: "start"; peerUserId: string } | { kind: "accept" | "join"; sessionId: string };
type RingtoneMode = "incoming" | "outgoing" | "outgoingOnce";
type AudioElementWithSink = HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
type MediaDevicesWithOutputPicker = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };
type WindowWithWebkitAudio = Window & { webkitAudioContext?: typeof AudioContext };

export interface VoicePeer {
  id: string;
  name: string;
  avatarUrl?: string;
  avatarBackground?: string;
}

export interface VoiceExperienceController {
  connectionState: RealtimeConnectionState;
  presence: ReadonlyMap<string, PresenceItem>;
  session: VoiceSessionSnapshot | null;
  sessionPeer: VoicePeer | null;
  invitation: VoiceSessionSnapshot | null;
  muted: boolean;
  remoteVolume: number;
  ringtone: RingtoneMode | null;
  rtcState: RTCPeerConnectionState | "idle" | "preparing";
  requestStart: (peer: VoicePeer) => void;
  requestJoin: (sessionId: string) => void;
  requestAccept: (sessionId: string) => void;
  decline: (sessionId: string) => void;
  leave: () => void;
  toggleMute: () => void;
  setRemoteVolume: (volume: number) => void;
  openSetup: () => void;
  closeSetup: () => void;
  setupOpen: boolean;
  setupBusy: boolean;
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  inputDeviceId: string;
  outputDeviceId: string;
  setInputDevice: (deviceId: string) => void;
  setOutputDevice: (deviceId: string) => void;
  outputSelectable: boolean;
  outputPickerAvailable: boolean;
  requestOutputDevice: () => void;
  audioBlocked: boolean;
  resumeAudio: () => void;
  remoteAudioRef: React.RefObject<HTMLAudioElement | null>;
}

const INPUT_KEY = "tiny-messenger:v1:audio-input";
const OUTPUT_KEY = "tiny-messenger:v1:audio-output";
const VOLUME_KEY = "tiny-messenger:v1:remote-volume";
const DEFAULT_REMOTE_VOLUME = 1;
const RTC_CONFIGURATION_CACHE_MS = 5 * 60_000;
const RESTART_DELAYS_MS = [0, 3_000, 10_000, 25_000] as const;
const SILENT_ACK_ERRORS = new Set([
  "connection_lost",
  "peer_reconnecting",
  "realtime_offline",
  "request_timeout",
  "stale_revision",
  "future_revision",
]);

function VoiceControlIcon({ name }: { name: "microphone" | "microphoneOff" | "volume" | "volumeOff" | "settings" | "hangUp" }) {
  const paths = {
    microphone: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></>,
    microphoneOff: <><path d="M9 9V6a3 3 0 0 1 5.8-1M15 10.5V11a3 3 0 0 1-4.8 2.4M5 11a7 7 0 0 0 11.7 5.2M19 11a7 7 0 0 1-.5 2.6M12 18v3M9 21h6M3 3l18 18" /></>,
    volume: <><path d="M5 9H2v6h3l5 4V5L5 9Z" /><path d="M14 9a4 4 0 0 1 0 6M17 6a8 8 0 0 1 0 12" /></>,
    volumeOff: <><path d="M5 9H2v6h3l5 4V5L5 9ZM15 10l5 5M20 10l-5 5" /></>,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.15.38.37.72.66 1 .3.29.69.43 1.1.4h.1v4h-.1c-.41-.03-.8.11-1.1.4-.29.28-.51.62-.66 1Z" /></>,
    hangUp: <path d="M5.6 15.8c4.3-3 8.5-3 12.8 0M7.2 14.8l-1.7 4.1-3.2-1.3.7-3a2 2 0 0 1 1-1.3c5.3-3.3 10.7-3.3 16 0a2 2 0 0 1 1 1.3l.7 3-3.2 1.3-1.7-4.1" />,
  };
  return <svg className="voice-control-icon" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function VoicePeerAvatar({ peer, connected }: { peer: VoicePeer; connected: boolean }) {
  return <span className="voice-peer-avatar-shell" aria-hidden="true">
    <span
      className="voice-peer-avatar"
      style={peer.avatarBackground ? { backgroundColor: peer.avatarBackground } : undefined}
    >
      <span>{peer.name.slice(0, 1).toUpperCase()}</span>
      {peer.avatarUrl ? <Image
        key={peer.avatarUrl}
        className="avatar-image"
        src={peer.avatarUrl}
        alt=""
        fill
        sizes="38px"
        unoptimized
        onError={(event) => { event.currentTarget.hidden = true; }}
      /> : null}
    </span>
    <span className={`voice-live-dot ${connected ? "connected" : ""}`} />
  </span>;
}

function scheduleTone(context: AudioContext, output: GainNode, start: number, frequency: number, duration: number) {
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequency, start);
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(0.13, start + 0.07);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(envelope).connect(output);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playRingtonePhrase(context: AudioContext, output: GainNode, mode: RingtoneMode) {
  const start = context.currentTime + 0.02;
  if (mode === "incoming") {
    scheduleTone(context, output, start, 659.25, 0.48);
    scheduleTone(context, output, start + 0.34, 783.99, 0.62);
    return;
  }
  scheduleTone(context, output, start, 440, 0.42);
  scheduleTone(context, output, start + 0.46, 554.37, 0.5);
}

function useRingtone(mode: RingtoneMode | null) {
  const contextRef = useRef<AudioContext | null>(null);

  const getContext = useCallback(() => {
    if (contextRef.current && contextRef.current.state !== "closed") return contextRef.current;
    const AudioContextConstructor = window.AudioContext
      || (window as WindowWithWebkitAudio).webkitAudioContext;
    contextRef.current = AudioContextConstructor ? new AudioContextConstructor() : null;
    return contextRef.current;
  }, []);

  useEffect(() => {
    const unlock = () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      void getContext()?.resume().catch(() => undefined);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [getContext]);

  useEffect(() => {
    if (!mode) return;
    const context = getContext();
    if (!context) return;
    let cancelled = false;
    let started = false;
    let starting = false;
    let interval: number | undefined;
    let stopTimer: number | undefined;
    let output: GainNode | null = null;
    const stopPlayback = () => {
      if (interval !== undefined) window.clearInterval(interval);
      interval = undefined;
      if (!output) return;
      const currentOutput = output;
      output = null;
      const now = context.currentTime;
      currentOutput.gain.cancelScheduledValues(now);
      currentOutput.gain.setValueAtTime(Math.max(currentOutput.gain.value, 0.0001), now);
      currentOutput.gain.exponentialRampToValueAtTime(0.0001, now + 0.06);
      window.setTimeout(() => currentOutput.disconnect(), 80);
    };
    const start = async () => {
      if (cancelled || started || starting) return;
      starting = true;
      await context.resume().catch(() => undefined);
      starting = false;
      if (cancelled || context.state !== "running") return;
      started = true;
      output = context.createGain();
      output.gain.value = mode === "incoming" ? 0.72 : 0.52;
      output.connect(context.destination);
      const play = () => { if (!cancelled && output) playRingtonePhrase(context, output, mode); };
      play();
      if (mode !== "outgoingOnce") {
        interval = window.setInterval(play, mode === "incoming" ? 3_000 : 3_800);
      }
      stopTimer = window.setTimeout(stopPlayback, mode === "outgoingOnce" ? 1_200 : 30_000);
    };
    const retryAfterInteraction = () => { void start(); };
    window.addEventListener("pointerdown", retryAfterInteraction);
    window.addEventListener("keydown", retryAfterInteraction);
    void start();
    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", retryAfterInteraction);
      window.removeEventListener("keydown", retryAfterInteraction);
      if (stopTimer !== undefined) window.clearTimeout(stopTimer);
      stopPlayback();
    };
  }, [getContext, mode]);

  useEffect(() => () => {
    const context = contextRef.current;
    contextRef.current = null;
    void context?.close();
  }, []);
}

function requestId() {
  return crypto.randomUUID();
}

function microphoneConstraints(deviceId: string): MediaTrackConstraints {
  return {
    ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

export function useVoiceExperience({
  token,
  userId,
  peers,
  enabled,
  onNotice,
}: {
  token: string;
  userId: string;
  peers: VoicePeer[];
  enabled: boolean;
  onNotice: (message: string) => void;
}): VoiceExperienceController {
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>("connecting");
  const [presence, setPresence] = useState<Map<string, PresenceItem>>(new Map());
  const [session, setSession] = useState<VoiceSessionSnapshot | null>(null);
  const [invitation, setInvitation] = useState<VoiceSessionSnapshot | null>(null);
  const [muted, setMuted] = useState(false);
  const [remoteVolume, setRemoteVolumeState] = useState(DEFAULT_REMOTE_VOLUME);
  const [rtcState, setRtcState] = useState<RTCPeerConnectionState | "idle" | "preparing">("idle");
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [inputDeviceId, setInputDeviceIdState] = useState("");
  const [outputDeviceId, setOutputDeviceIdState] = useState("");
  const [audioBlocked, setAudioBlocked] = useState(false);
  const clientRef = useRef<RealtimeClient | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const revisionRef = useRef(0);
  const sessionRef = useRef<VoiceSessionSnapshot | null>(null);
  const pendingIceRef = useRef<RTCIceCandidateInit[]>([]);
  const rtcConfigurationRef = useRef<{ value: RTCConfiguration; expiresAt: number } | null>(null);
  const restartAttemptsRef = useRef(0);
  const restartTimerRef = useRef<number | undefined>(undefined);
  const restartFailureNotifiedRef = useRef(false);
  const peersRef = useRef(peers);
  const eventHandlerRef = useRef<(event: ServerRealtimeEvent) => Promise<void>>(async () => undefined);
  const eventQueueRef = useRef<Promise<void>>(Promise.resolve());

  const outputSelectable = typeof navigator !== "undefined"
    && typeof HTMLMediaElement !== "undefined"
    && typeof (HTMLMediaElement.prototype as AudioElementWithSink).setSinkId === "function";
  const outputPickerAvailable = typeof navigator !== "undefined"
    && typeof (navigator.mediaDevices as MediaDevicesWithOutputPicker | undefined)?.selectAudioOutput === "function";

  useEffect(() => { peersRef.current = peers; }, [peers]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => {
    const storedVolume = window.localStorage.getItem(VOLUME_KEY);
    const savedVolume = storedVolume === null ? Number.NaN : Number(storedVolume);
    if (Number.isFinite(savedVolume) && savedVolume >= 0 && savedVolume <= 1) {
      setRemoteVolumeState(savedVolume);
      if (remoteAudioRef.current) remoteAudioRef.current.volume = savedVolume;
    }
  }, []);
  const peerIds = useMemo(() => peers.map((peer) => peer.id).sort().join(","), [peers]);

  const send = useCallback((frame: Record<string, unknown>) => {
    clientRef.current?.send({ ...frame, requestId: requestId() });
  }, []);

  const request = useCallback((frame: Record<string, unknown>) => {
    const client = clientRef.current;
    return client ? client.request(frame) : Promise.reject(new Error("Нет соединения с сервером"));
  }, []);

  const loadDevices = useCallback(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    setAudioInputs(devices.filter((device) => device.kind === "audioinput"));
    setAudioOutputs(devices.filter((device) => device.kind === "audiooutput"));
  }, []);

  const stopMedia = useCallback(() => {
    if (restartTimerRef.current !== undefined) window.clearTimeout(restartTimerRef.current);
    restartTimerRef.current = undefined;
    restartAttemptsRef.current = 0;
    restartFailureNotifiedRef.current = false;
    localStreamRef.current?.getTracks().forEach((track) => track.stop());
    localStreamRef.current = null;
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    revisionRef.current = 0;
    pendingIceRef.current = [];
    setRtcState("idle");
    setMuted(false);
    setAudioBlocked(false);
  }, []);

  const ensureMedia = useCallback(async (preferredInputId = inputDeviceId) => {
    const current = localStreamRef.current?.getAudioTracks()[0];
    if (current?.readyState === "live") return localStreamRef.current as MediaStream;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: microphoneConstraints(preferredInputId),
      video: false,
    });
    localStreamRef.current = stream;
    const track = stream.getAudioTracks()[0];
    track.addEventListener("ended", () => {
      if (localStreamRef.current?.getAudioTracks()[0] !== track) return;
      setRtcState("idle");
      onNotice("Микрофон отключён. Нажмите «Вернуться», чтобы подключиться снова.");
    }, { once: true });
    await loadDevices();
    return stream;
  }, [inputDeviceId, loadDevices, onNotice]);

  const applyOutput = useCallback(async (deviceId: string) => {
    const audio = remoteAudioRef.current as AudioElementWithSink | null;
    if (!audio?.setSinkId) return;
    await audio.setSinkId(deviceId);
  }, []);

  const createPeerConnection = useCallback(async (sessionId: string, revision: number) => {
    const previousConnection = peerConnectionRef.current;
    peerConnectionRef.current = null;
    previousConnection?.close();
    pendingIceRef.current = [];
    if (restartTimerRef.current !== undefined) window.clearTimeout(restartTimerRef.current);
    restartTimerRef.current = undefined;
    const cachedConfiguration = rtcConfigurationRef.current;
    let configuration: RTCConfiguration;
    if (cachedConfiguration && cachedConfiguration.expiresAt > Date.now()) {
      configuration = cachedConfiguration.value;
    } else {
      configuration = await fetch("/api/rtc/config", {
        headers: { Authorization: `Bearer ${token}` },
      }).then(async (response) => {
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error?.message || "Не удалось получить настройки звонка");
        return payload.data as RTCConfiguration;
      });
      rtcConfigurationRef.current = { value: configuration, expiresAt: Date.now() + RTC_CONFIGURATION_CACHE_MS };
    }
    const stream = await ensureMedia();
    const connection = new RTCPeerConnection(configuration);
    peerConnectionRef.current = connection;
    revisionRef.current = revision;
    for (const track of stream.getTracks()) connection.addTrack(track, stream);
    connection.addEventListener("track", (event) => {
      if (peerConnectionRef.current !== connection) return;
      const [remoteStream] = event.streams;
      if (!remoteAudioRef.current || !remoteStream) return;
      remoteAudioRef.current.srcObject = remoteStream;
      void applyOutput(outputDeviceId).catch(() => undefined);
      void remoteAudioRef.current.play().catch(() => {
        setAudioBlocked(true);
        onNotice("Нажмите на панель звонка, чтобы включить звук");
      });
    });
    connection.addEventListener("icecandidate", (event) => {
      if (!event.candidate || peerConnectionRef.current !== connection) return;
      send({
        type: "rtc_ice",
        sessionId,
        revision,
        candidate: event.candidate.toJSON(),
      });
    });
    const scheduleRestart = () => {
      if (peerConnectionRef.current !== connection || connection.connectionState !== "failed") return;
      if (restartTimerRef.current !== undefined) return;
      const attempt = restartAttemptsRef.current;
      if (attempt >= RESTART_DELAYS_MS.length) {
        if (!restartFailureNotifiedRef.current) {
          restartFailureNotifiedRef.current = true;
          onNotice("Не удалось восстановить голосовую связь. Попробуйте войти в чат заново.");
        }
        return;
      }
      restartAttemptsRef.current += 1;
      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = undefined;
        if (peerConnectionRef.current !== connection || sessionRef.current?.id !== sessionId) return;
        void request({ type: "rtc_restart", sessionId, revision }).catch((error: Error & { code?: string }) => {
          if (!SILENT_ACK_ERRORS.has(error.code || "")) onNotice(error.message);
          scheduleRestart();
        });
      }, RESTART_DELAYS_MS[attempt]);
    };
    connection.addEventListener("connectionstatechange", () => {
      if (peerConnectionRef.current !== connection) return;
      setRtcState(connection.connectionState);
      if (connection.connectionState === "connected") {
        restartAttemptsRef.current = 0;
        restartFailureNotifiedRef.current = false;
        if (restartTimerRef.current !== undefined) window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = undefined;
        return;
      }
      if (connection.connectionState === "failed") scheduleRestart();
    });
    return connection;
  }, [applyOutput, ensureMedia, onNotice, outputDeviceId, request, send, token]);

  const handleRealtimeEvent = useCallback(async (event: ServerRealtimeEvent) => {
    if (event.type === "ready") {
      const current = sessionRef.current;
      if (current?.owner && current.resumeToken && localStreamRef.current) {
        send({ type: "voice_resume", sessionId: current.id, resumeToken: current.resumeToken, mediaLost: false });
      }
      return;
    }
    if (event.type === "presence_snapshot") {
      setPresence(new Map(event.items.map((item) => [item.userId, item])));
      return;
    }
    if (event.type === "presence_changed") {
      setPresence((current) => new Map(current).set(event.item.userId, event.item));
      return;
    }
    if (event.type === "voice_invite") {
      setInvitation(event.session);
      return;
    }
    if (event.type === "voice_session") {
      const current = sessionRef.current;
      if (!current || current.id !== event.session.id || current.stateVersion <= event.session.stateVersion) {
        sessionRef.current = event.session;
        setSession(event.session);
      }
      if (event.session.accepted) setInvitation(null);
      return;
    }
    if (event.type === "voice_session_ended") {
      if (sessionRef.current?.id === event.sessionId) {
        stopMedia();
        sessionRef.current = null;
        setSession(null);
      }
      setInvitation((current) => current?.id === event.sessionId ? null : current);
      return;
    }
    if (event.type === "voice_negotiate") {
      const connection = await createPeerConnection(event.sessionId, event.revision);
      setRtcState("connecting");
      if (event.role === "offerer") {
        const description = await connection.createOffer();
        await connection.setLocalDescription(description);
        send({ type: "rtc_offer", sessionId: event.sessionId, revision: event.revision, description });
      }
      return;
    }
    if (event.type === "rtc_offer" && event.revision >= revisionRef.current) {
      const connection = event.revision === revisionRef.current && peerConnectionRef.current
        ? peerConnectionRef.current
        : await createPeerConnection(event.sessionId, event.revision);
      await connection.setRemoteDescription(event.description);
      for (const candidate of pendingIceRef.current.splice(0)) await connection.addIceCandidate(candidate);
      const description = await connection.createAnswer();
      await connection.setLocalDescription(description);
      send({ type: "rtc_answer", sessionId: event.sessionId, revision: event.revision, description });
      return;
    }
    if (event.type === "rtc_answer" && event.revision === revisionRef.current && peerConnectionRef.current) {
      await peerConnectionRef.current.setRemoteDescription(event.description);
      for (const candidate of pendingIceRef.current.splice(0)) await peerConnectionRef.current.addIceCandidate(candidate);
      return;
    }
    if (event.type === "rtc_ice" && event.revision === revisionRef.current) {
      if (peerConnectionRef.current?.remoteDescription) await peerConnectionRef.current.addIceCandidate(event.candidate);
      else pendingIceRef.current.push(event.candidate);
      return;
    }
    if (event.type === "ack" && !event.ok) {
      if (event.action === "presence_subscribe") {
        setPresence(new Map());
        return;
      }
      if (!SILENT_ACK_ERRORS.has(event.error?.code || "")) {
        onNotice(event.error?.message || "Команда звонка не выполнена");
      }
    }
    if (event.type === "error") onNotice(event.error.message);
  }, [createPeerConnection, onNotice, send, stopMedia]);

  useEffect(() => { eventHandlerRef.current = handleRealtimeEvent; }, [handleRealtimeEvent]);

  useEffect(() => {
    if (!enabled || !token || !userId) return;
    const client = new RealtimeClient(token);
    clientRef.current = client;
    const unsubscribeEvent = client.subscribe((event) => {
      eventQueueRef.current = eventQueueRef.current
        .then(() => eventHandlerRef.current(event))
        .catch((error: Error) => onNotice(error.message));
    });
    const unsubscribeState = client.subscribeState(setConnectionState);
    client.start();
    return () => {
      unsubscribeEvent();
      unsubscribeState();
      client.stop();
      clientRef.current = null;
      stopMedia();
    };
  }, [enabled, onNotice, stopMedia, token, userId]);

  useEffect(() => {
    if (connectionState === "online") {
      send({ type: "presence_subscribe", userIds: peersRef.current.map((peer) => peer.id) });
    }
  }, [connectionState, peerIds, send]);

  useEffect(() => {
    if (!("mediaDevices" in navigator)) return;
    const refresh = () => { void loadDevices(); };
    navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [loadDevices]);

  useEffect(() => {
    if (!session?.owner || !("wakeLock" in navigator)) return;
    let released = false;
    let sentinel: WakeLockSentinel | null = null;
    const acquire = async () => {
      if (released || document.visibilityState !== "visible") return;
      sentinel = await navigator.wakeLock.request("screen").catch(() => null);
    };
    const handleVisibility = () => { if (document.visibilityState === "visible") void acquire(); };
    void acquire();
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      void sentinel?.release();
    };
  }, [session?.owner]);

  const prepare = useCallback(async (action: VoiceAction) => {
    setSetupBusy(true);
    setRtcState("preparing");
    try {
      const savedInput = window.localStorage.getItem(INPUT_KEY) || "";
      const savedOutput = window.localStorage.getItem(OUTPUT_KEY) || "";
      setInputDeviceIdState(savedInput);
      setOutputDeviceIdState(savedOutput);
      await ensureMedia(savedInput);
      const frame = action.kind === "start"
        ? { type: "voice_start", peerUserId: action.peerUserId }
        : { type: action.kind === "accept" ? "voice_accept" : "voice_join", sessionId: action.sessionId };
      setRtcState("connecting");
      await request(frame);
    } catch (error) {
      setRtcState("idle");
      if (!sessionRef.current?.owner) stopMedia();
      onNotice((error as Error).name === "NotAllowedError"
        ? "Разрешите доступ к микрофону, чтобы начать звонок"
        : (error as Error).message);
    } finally {
      setSetupBusy(false);
    }
  }, [ensureMedia, onNotice, request, stopMedia]);

  const openSetup = useCallback(() => {
    const savedInput = window.localStorage.getItem(INPUT_KEY) || "";
    const savedOutput = window.localStorage.getItem(OUTPUT_KEY) || "";
    setInputDeviceIdState(savedInput);
    setOutputDeviceIdState(savedOutput);
    setSetupOpen(true);
    setSetupBusy(true);
    void ensureMedia(savedInput).catch((error: Error) => {
      onNotice(error.name === "NotAllowedError"
        ? "Разрешите доступ к микрофону, чтобы выбрать устройство"
        : error.message);
    }).finally(() => setSetupBusy(false));
  }, [ensureMedia, onNotice]);

  const closeSetup = useCallback(() => {
    setSetupOpen(false);
    if (!sessionRef.current?.owner) stopMedia();
  }, [stopMedia]);

  const setInputDevice = useCallback((deviceId: string) => {
    setInputDeviceIdState(deviceId);
    window.localStorage.setItem(INPUT_KEY, deviceId);
    void navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints(deviceId), video: false }).then(async (stream) => {
      const nextTrack = stream.getAudioTracks()[0];
      const sender = peerConnectionRef.current?.getSenders().find((candidate) => candidate.track?.kind === "audio");
      if (sender) await sender.replaceTrack(nextTrack);
      const previous = localStreamRef.current;
      localStreamRef.current = stream;
      previous?.getTracks().forEach((track) => track.stop());
    }).catch((error: Error) => onNotice(error.message));
  }, [onNotice]);

  const setOutputDevice = useCallback((deviceId: string) => {
    setOutputDeviceIdState(deviceId);
    window.localStorage.setItem(OUTPUT_KEY, deviceId);
    void applyOutput(deviceId).catch(() => onNotice("Браузер не смог переключить аудиовыход"));
  }, [applyOutput, onNotice]);

  const setRemoteVolume = useCallback((volume: number) => {
    const nextVolume = Math.min(1, Math.max(0, volume));
    setRemoteVolumeState(nextVolume);
    if (remoteAudioRef.current) remoteAudioRef.current.volume = nextVolume;
    window.localStorage.setItem(VOLUME_KEY, String(nextVolume));
  }, []);

  const requestOutputDevice = useCallback(() => {
    const picker = (navigator.mediaDevices as MediaDevicesWithOutputPicker).selectAudioOutput;
    if (!picker) return;
    void picker.call(navigator.mediaDevices).then((device) => {
      setAudioOutputs((current) => current.some((item) => item.deviceId === device.deviceId) ? current : [...current, device]);
      setOutputDevice(device.deviceId);
    }).catch((error: Error) => {
      if (error.name !== "NotAllowedError") onNotice(error.message);
    });
  }, [onNotice, setOutputDevice]);

  const resumeAudio = useCallback(() => {
    void remoteAudioRef.current?.play().then(() => setAudioBlocked(false)).catch((error: Error) => onNotice(error.message));
  }, [onNotice]);

  const peerState = session?.participants.find((participant) => participant.userId === session.peerUserId)?.state;
  const peerPresence = session ? presence.get(session.peerUserId) : undefined;
  const sessionPeer = useMemo(() => {
    if (!session) return null;
    return peers.find((peer) => peer.id === session.peerUserId)
      ?? { id: session.peerUserId, name: session.peerName };
  }, [peers, session]);
  const ringtone = setupBusy
    ? null
    : invitation && !session
      ? "incoming"
      : session?.owner && session.initiatorId === userId && peerState === "invited"
        ? peerPresence?.online && peerPresence.voiceAvailable ? "outgoing" : "outgoingOnce"
        : null;

  return useMemo(() => ({
    connectionState,
    presence,
    session,
    sessionPeer,
    invitation,
    muted,
    remoteVolume,
    ringtone,
    rtcState,
    requestStart: (peer: VoicePeer) => { void prepare({ kind: "start", peerUserId: peer.id }); },
    requestJoin: (sessionId: string) => { void prepare({ kind: "join", sessionId }); },
    requestAccept: (sessionId: string) => { void prepare({ kind: "accept", sessionId }); },
    decline: (sessionId: string) => {
      void request({ type: "voice_decline", sessionId }).catch((error: Error) => onNotice(error.message));
    },
    leave: () => {
      if (!session) return;
      const sessionId = session.id;
      void request({ type: "voice_leave", sessionId }).then(() => {
        if (sessionRef.current && sessionRef.current.id !== sessionId) return;
        sessionRef.current = null;
        stopMedia();
        setSession(null);
      }).catch((error: Error & { code?: string }) => {
        if (error.code === "not_voice_owner" || error.code === "voice_session_not_found") {
          if (sessionRef.current?.id !== sessionId) return;
          sessionRef.current = null;
          stopMedia();
          setSession(null);
          return;
        }
        onNotice(error.message);
      });
    },
    toggleMute: () => {
      const track = localStreamRef.current?.getAudioTracks()[0];
      if (!track) return;
      track.enabled = !track.enabled;
      setMuted(!track.enabled);
    },
    setRemoteVolume,
    openSetup,
    closeSetup,
    setupOpen,
    setupBusy,
    audioInputs,
    audioOutputs,
    inputDeviceId,
    outputDeviceId,
    setInputDevice,
    setOutputDevice,
    outputSelectable,
    outputPickerAvailable,
    requestOutputDevice,
    audioBlocked,
    resumeAudio,
    remoteAudioRef,
  }), [
    audioInputs, audioOutputs, closeSetup, connectionState, inputDeviceId, invitation,
    audioBlocked, muted, outputDeviceId, outputPickerAvailable, outputSelectable, prepare, presence, remoteVolume,
    onNotice, openSetup, request, requestOutputDevice, resumeAudio, rtcState, session, setInputDevice, setOutputDevice,
    sessionPeer, setRemoteVolume, setupBusy, setupOpen, stopMedia, ringtone,
  ]);
}

export function VoiceExperienceUi({ voice }: { voice: VoiceExperienceController }) {
  useRingtone(voice.ringtone);
  const peerState = voice.session?.participants.find((participant) => participant.userId === voice.session?.peerUserId)?.state;
  const stateLabel = voice.rtcState === "connected"
    ? "Связь установлена"
    : peerState === "joined"
      ? "Соединяем…"
      : peerState === "reconnecting"
        ? "Собеседник переподключается…"
        : "Ждём собеседника…";

  return <>
    <audio ref={voice.remoteAudioRef} autoPlay playsInline />
    {voice.session ? <aside className="voice-dock" aria-label="Текущий голосовой чат">
      {voice.sessionPeer ? <VoicePeerAvatar peer={voice.sessionPeer} connected={voice.rtcState === "connected"} /> : null}
      <span className="voice-dock-copy"><strong>{voice.session.peerName}</strong><small>{stateLabel}</small></span>
      {!voice.session.owner ? <button type="button" onClick={() => voice.requestJoin(voice.session!.id)}>Вернуться</button> : null}
      {voice.audioBlocked ? <button type="button" onClick={voice.resumeAudio}>Включить звук</button> : null}
      {voice.session.owner ? <>
        <button
          type="button"
          className="voice-control-button"
          onClick={voice.openSetup}
          aria-label="Настройки звука"
          data-tooltip="Настройки звука"
        >
          <VoiceControlIcon name="settings" />
        </button>
        {!voice.audioBlocked ? <label className="voice-volume-control" data-tooltip={`Громкость собеседника: ${Math.round(voice.remoteVolume * 100)}%`}>
          <VoiceControlIcon name={voice.remoteVolume === 0 ? "volumeOff" : "volume"} />
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={voice.remoteVolume}
            onChange={(event) => voice.setRemoteVolume(event.currentTarget.valueAsNumber)}
            aria-label="Громкость собеседника"
            aria-valuetext={`${Math.round(voice.remoteVolume * 100)}%`}
          />
        </label> : null}
        <button
          type="button"
          className={`voice-control-button ${voice.muted ? "voice-muted" : ""}`}
          onClick={voice.toggleMute}
          aria-label={voice.muted ? "Микрофон выключен. Включить" : "Микрофон включён. Выключить"}
          aria-pressed={voice.muted}
          data-tooltip={voice.muted ? "Микрофон выключен · включить" : "Микрофон включён · выключить"}
        >
          <VoiceControlIcon name={voice.muted ? "microphoneOff" : "microphone"} />
        </button>
        <button
          type="button"
          className="voice-control-button voice-leave"
          onClick={voice.leave}
          aria-label="Выйти из голосового чата"
          data-tooltip="Выйти из голосового чата"
        >
          <VoiceControlIcon name="hangUp" />
        </button>
      </> : null}
    </aside> : null}
    {voice.invitation && !voice.session ? <div className="voice-overlay" role="dialog" aria-modal="true" aria-labelledby="voice-invite-title">
      <section className="voice-card">
        <span className="voice-rings" aria-hidden="true">◉</span>
        <h2 id="voice-invite-title">{voice.invitation.peerName} зовёт в голосовой чат</h2>
        <p>Комната останется доступной для повторного входа, пока в ней находится один из вас.</p>
        <div className="voice-card-actions">
          <button type="button" className="secondary-button" onClick={() => voice.decline(voice.invitation!.id)}>Отклонить</button>
          <button type="button" className="primary-button" disabled={voice.setupBusy} onClick={() => voice.requestAccept(voice.invitation!.id)}>{voice.setupBusy ? "Подключаем…" : "Подключиться"}</button>
        </div>
      </section>
    </div> : null}
    {voice.setupOpen ? <div className="voice-overlay" role="dialog" aria-modal="true" aria-labelledby="voice-setup-title">
      <section className="voice-card voice-setup-card">
        <h2 id="voice-setup-title">Настройка звука</h2>
        <p>Выберите устройства для голосового чата.</p>
        <label>Микрофон<span className="voice-device-select">
          <VoiceControlIcon name="microphone" />
          <select value={voice.inputDeviceId} onChange={(event) => voice.setInputDevice(event.target.value)}>
            <option value="">Системный по умолчанию</option>
            {voice.audioInputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Микрофон ${index + 1}`}</option>)}
          </select>
        </span></label>
        <label>Динамики<span className="voice-device-select">
          <VoiceControlIcon name="volume" />
          <select value={voice.outputDeviceId} disabled={!voice.outputSelectable} onChange={(event) => voice.setOutputDevice(event.target.value)}>
            <option value="">Системные по умолчанию</option>
            {voice.audioOutputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Выход ${index + 1}`}</option>)}
          </select>
        </span></label>
        {voice.outputPickerAvailable ? <button type="button" className="voice-output-picker" onClick={voice.requestOutputDevice}>Выбрать аудиовыход…</button> : null}
        {!voice.outputSelectable ? <small>Вывод звука управляется системой.</small> : null}
        <div className="voice-card-actions">
          <button type="button" className="primary-button" disabled={voice.setupBusy} onClick={voice.closeSetup}>{voice.setupBusy ? "Проверяем…" : "Готово"}</button>
        </div>
      </section>
    </div> : null}
  </>;
}

export function formatPresence(item?: PresenceItem) {
  if (!item) return "Статус неизвестен";
  if (item.online) return "В сети";
  if (!item.lastSeenAt) return "Не в сети";
  const minutes = Math.max(1, Math.round((Date.now() - new Date(item.lastSeenAt).getTime()) / 60_000));
  if (minutes < 60) return `Был(а) в сети ${minutes} мин. назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Был(а) в сети ${hours} ч. назад`;
  return `Был(а) в сети ${new Intl.DateTimeFormat("ru", { day: "numeric", month: "short" }).format(new Date(item.lastSeenAt))}`;
}
