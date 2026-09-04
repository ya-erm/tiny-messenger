export type RealtimeConnectionState = "connecting" | "online" | "offline";

export interface PresenceItem {
  userId: string;
  online: boolean;
  voiceAvailable: boolean;
  lastSeenAt?: string;
}

export interface VoiceParticipant {
  userId: string;
  state: "invited" | "away" | "reconnecting" | "joined";
}

export interface VoiceSessionSnapshot {
  id: string;
  peerUserId: string;
  peerName: string;
  initiatorId: string;
  stateVersion: number;
  accepted: boolean;
  owner: boolean;
  resumeToken?: string;
  participants: VoiceParticipant[];
  createdAt: string;
}

export type ServerRealtimeEvent =
  | { type: "ready"; protocol: 2; userId: string; connectionId: string; heartbeatIntervalMs: number }
  | { type: "ack"; requestId: string; action: string; ok: boolean; error?: { code?: string; message: string } }
  | { type: "error"; error: { code?: string; message: string } }
  | { type: "presence_snapshot"; items: PresenceItem[] }
  | { type: "presence_changed"; item: PresenceItem }
  | { type: "voice_invite"; session: VoiceSessionSnapshot }
  | { type: "voice_session"; session: VoiceSessionSnapshot }
  | { type: "voice_session_ended"; sessionId: string; reason: string }
  | { type: "voice_negotiate"; sessionId: string; revision: number; role: "offerer" | "answerer" }
  | { type: "rtc_offer"; sessionId: string; revision: number; description: RTCSessionDescriptionInit }
  | { type: "rtc_answer"; sessionId: string; revision: number; description: RTCSessionDescriptionInit }
  | { type: "rtc_ice"; sessionId: string; revision: number; candidate: RTCIceCandidateInit }
  | { type: "server_shutdown" };

export function parseServerEvent(value: string): ServerRealtimeEvent | null {
  if (value.length > 65_536) return null;
  try {
    const parsed = JSON.parse(value) as { type?: unknown };
    return parsed && typeof parsed === "object" && typeof parsed.type === "string"
      ? parsed as ServerRealtimeEvent
      : null;
  } catch {
    return null;
  }
}
