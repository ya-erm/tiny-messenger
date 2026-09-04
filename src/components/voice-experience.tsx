"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RealtimeClient } from "@/realtime/realtime-client";
import type {
  PresenceItem,
  RealtimeConnectionState,
  ServerRealtimeEvent,
  VoiceSessionSnapshot,
} from "@/realtime/protocol";

type VoiceAction = { kind: "start"; peerUserId: string } | { kind: "accept" | "join"; sessionId: string };
type AudioElementWithSink = HTMLAudioElement & { setSinkId?: (deviceId: string) => Promise<void> };
type MediaDevicesWithOutputPicker = MediaDevices & { selectAudioOutput?: () => Promise<MediaDeviceInfo> };

export interface VoicePeer {
  id: string;
  name: string;
}

export interface VoiceExperienceController {
  connectionState: RealtimeConnectionState;
  presence: ReadonlyMap<string, PresenceItem>;
  session: VoiceSessionSnapshot | null;
  invitation: VoiceSessionSnapshot | null;
  muted: boolean;
  rtcState: RTCPeerConnectionState | "idle" | "preparing";
  requestStart: (peer: VoicePeer) => void;
  requestJoin: (sessionId: string) => void;
  requestAccept: (sessionId: string) => void;
  decline: (sessionId: string) => void;
  leave: () => void;
  toggleMute: () => void;
  closeSetup: () => void;
  confirmSetup: () => void;
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
  const [rtcState, setRtcState] = useState<RTCPeerConnectionState | "idle" | "preparing">("idle");
  const [setupAction, setSetupAction] = useState<VoiceAction | null>(null);
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
      setSetupAction(action);
    } catch (error) {
      setRtcState("idle");
      onNotice((error as Error).name === "NotAllowedError"
        ? "Разрешите доступ к микрофону, чтобы начать звонок"
        : (error as Error).message);
    } finally {
      setSetupBusy(false);
    }
  }, [ensureMedia, onNotice]);

  const confirmSetup = useCallback(() => {
    if (!setupAction) return;
    const frame = setupAction.kind === "start"
      ? { type: "voice_start", peerUserId: setupAction.peerUserId }
      : { type: setupAction.kind === "accept" ? "voice_accept" : "voice_join", sessionId: setupAction.sessionId };
    setSetupAction(null);
    setRtcState("connecting");
    void request(frame).catch((error: Error) => {
      setRtcState("idle");
      if (!sessionRef.current?.owner) stopMedia();
      onNotice(error.message);
    });
  }, [onNotice, request, setupAction, stopMedia]);

  const closeSetup = useCallback(() => {
    setSetupAction(null);
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

  return useMemo(() => ({
    connectionState,
    presence,
    session,
    invitation,
    muted,
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
    closeSetup,
    confirmSetup,
    setupOpen: Boolean(setupAction),
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
    audioInputs, audioOutputs, closeSetup, confirmSetup, connectionState, inputDeviceId, invitation,
    audioBlocked, muted, outputDeviceId, outputPickerAvailable, outputSelectable, prepare, presence,
    onNotice, request, requestOutputDevice, resumeAudio, rtcState, session, setInputDevice, setOutputDevice,
    setupAction, setupBusy, stopMedia,
  ]);
}

export function VoiceExperienceUi({ voice }: { voice: VoiceExperienceController }) {
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
      <span className={`voice-live-dot ${voice.rtcState === "connected" ? "connected" : ""}`} />
      <span className="voice-dock-copy"><strong>{voice.session.peerName}</strong><small>{stateLabel}</small></span>
      {!voice.session.owner ? <button type="button" onClick={() => voice.requestJoin(voice.session!.id)}>Вернуться</button> : null}
      {voice.audioBlocked ? <button type="button" onClick={voice.resumeAudio}>Включить звук</button> : null}
      {voice.session.owner ? <>
        <button type="button" className={voice.muted ? "voice-muted" : ""} onClick={voice.toggleMute}>{voice.muted ? "Включить микрофон" : "Выкл. микрофон"}</button>
        <button type="button" className="voice-leave" onClick={voice.leave}>Выйти</button>
      </> : null}
    </aside> : null}
    {voice.invitation && !voice.session ? <div className="voice-overlay" role="dialog" aria-modal="true" aria-labelledby="voice-invite-title">
      <section className="voice-card">
        <span className="voice-rings" aria-hidden="true">◉</span>
        <h2 id="voice-invite-title">{voice.invitation.peerName} зовёт в голосовой чат</h2>
        <p>Комната останется доступной для повторного входа, пока в ней находится один из вас.</p>
        <div className="voice-card-actions">
          <button type="button" className="secondary-button" onClick={() => voice.decline(voice.invitation!.id)}>Отклонить</button>
          <button type="button" className="primary-button" onClick={() => voice.requestAccept(voice.invitation!.id)}>Подключиться</button>
        </div>
      </section>
    </div> : null}
    {voice.setupOpen ? <div className="voice-overlay" role="dialog" aria-modal="true" aria-labelledby="voice-setup-title">
      <section className="voice-card voice-setup-card">
        <h2 id="voice-setup-title">Настройка звука</h2>
        <p>Проверьте устройства перед подключением.</p>
        <label>Микрофон<select value={voice.inputDeviceId} onChange={(event) => voice.setInputDevice(event.target.value)}>
          <option value="">Системный по умолчанию</option>
          {voice.audioInputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Микрофон ${index + 1}`}</option>)}
        </select></label>
        <label>Динамики<select value={voice.outputDeviceId} disabled={!voice.outputSelectable} onChange={(event) => voice.setOutputDevice(event.target.value)}>
          <option value="">Системные по умолчанию</option>
          {voice.audioOutputs.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Выход ${index + 1}`}</option>)}
        </select></label>
        {voice.outputPickerAvailable ? <button type="button" className="voice-output-picker" onClick={voice.requestOutputDevice}>Выбрать аудиовыход…</button> : null}
        {!voice.outputSelectable ? <small>Вывод звука управляется системой.</small> : null}
        <div className="voice-card-actions">
          <button type="button" className="secondary-button" onClick={voice.closeSetup}>Отмена</button>
          <button type="button" className="primary-button" disabled={voice.setupBusy} onClick={voice.confirmSetup}>Подключиться</button>
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
