"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicGroupMessage, PublicMessage } from "@/lib/types";

const SOUND_KEY = "tiny-messenger:v1:message-sound";
type AudioWindow = Window & { webkitAudioContext?: typeof AudioContext };
type SoundMessage = Pick<PublicMessage, "id" | "fromUserId" | "sentAt">;
type Cursor = { at: string; ids: Set<string> };

function soundPreference() {
  try { return window.localStorage.getItem(SOUND_KEY) !== "off"; }
  catch { return true; }
}

// Keep only IDs at the latest timestamp. Older history, edits and overlapping
// sync responses cannot replay a notification; equal-timestamp arrivals work.
function advance(cursor: Cursor, messages: SoundMessage[], userId: string) {
  let incoming = false;
  let latest = cursor.at;
  const ids = new Set(cursor.ids);
  for (const message of messages) {
    if ((message.sentAt > cursor.at || (message.sentAt === cursor.at && !cursor.ids.has(message.id)))
      && message.fromUserId !== userId) incoming = true;
    if (message.sentAt > latest) { latest = message.sentAt; ids.clear(); }
    if (message.sentAt === latest) ids.add(message.id);
  }
  cursor.at = latest;
  cursor.ids = ids;
  return incoming;
}

export function useMessageSound(userId: string | undefined, onIncoming?: () => void) {
  const [enabled, setEnabled] = useState(true);
  const enabledRef = useRef(true);
  const contextRef = useRef<AudioContext | null>(null);
  const cursorRef = useRef<{ userId: string; direct: Cursor; group: Cursor } | null>(null);

  const closeAudio = useCallback(() => {
    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  }, []);

  const unlock = useCallback(() => {
    if (!enabledRef.current || onIncoming) return;
    try {
      if (!contextRef.current || contextRef.current.state === "closed") {
        const Constructor = window.AudioContext || (window as AudioWindow).webkitAudioContext;
        if (!Constructor) return;
        contextRef.current = new Constructor();
      }
      if (contextRef.current.state !== "running") void contextRef.current.resume().catch(() => undefined);
    } catch { /* Audio support or autoplay policy must not interrupt messaging. */ }
  }, [onIncoming]);

  useEffect(() => {
    const apply = () => {
      const next = soundPreference();
      enabledRef.current = next;
      setEnabled(next);
      if (!next) closeAudio();
    };
    const storage = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === SOUND_KEY || event.key === null)) apply();
    };
    apply();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("click", unlock);
    window.addEventListener("keydown", unlock);
    window.addEventListener("storage", storage);
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("storage", storage);
      closeAudio();
    };
  }, [closeAudio, unlock]);

  const choose = useCallback((next: boolean) => {
    enabledRef.current = next;
    setEnabled(next);
    try { window.localStorage.setItem(SOUND_KEY, next ? "on" : "off"); } catch { /* Still usable for this session. */ }
    if (next) unlock();
    else closeAudio();
  }, [closeAudio, unlock]);

  const observe = useCallback((messages: PublicMessage[], groups: PublicGroupMessage[], syncedAt: string) => {
    if (!userId) return;
    let cursors = cursorRef.current;
    if (!cursors || cursors.userId !== userId) {
      cursors = { userId, direct: { at: syncedAt, ids: new Set() }, group: { at: syncedAt, ids: new Set() } };
      advance(cursors.direct, messages, userId);
      advance(cursors.group, groups, userId);
      cursorRef.current = cursors;
      return; // The first successful sync is history, including unread messages.
    }
    const direct = advance(cursors.direct, messages, userId);
    const group = advance(cursors.group, groups, userId);
    if ((!direct && !group) || !enabledRef.current) return;
    if (onIncoming) {
      onIncoming();
      return;
    }
    const context = contextRef.current;
    // Drop blocked/muted sounds instead of queuing them for the next gesture.
    if (!context || context.state !== "running") return;
    try {
      const start = context.currentTime + 0.01;
      for (const [offset, frequency] of [[0, 740], [0.12, 988]]) {
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0.0001, start + offset);
        gain.gain.exponentialRampToValueAtTime(0.1, start + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.16);
        oscillator.connect(gain).connect(context.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(start + offset);
        oscillator.stop(start + offset + 0.18);
      }
    } catch { /* A disappearing audio device must not fail a successful sync. */ }
  }, [onIncoming, userId]);

  return { enabled, choose, observe };
}
