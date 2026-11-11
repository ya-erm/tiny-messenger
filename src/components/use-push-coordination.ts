"use client";

import { useEffect, useRef } from "react";
import type { AttachmentRequest } from "@/components/attachments";

// Presence is insufficient: only a visible, focused view with recent human
// activity asks for a short push grace period. Lost connections expire in 15s.
export function usePushActivity(userId: string | undefined, visible: boolean, request: AttachmentRequest) {
  const refreshRef = useRef<() => void>(() => {});
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  useEffect(() => {
    if (!userId) return;
    const deviceId = crypto.randomUUID();
    let lastActivity = document.hasFocus() ? Date.now() : 0;
    let lastSent = 0;
    let previous = false;
    const send = (force = false) => {
      const active = visibleRef.current && document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastActivity < 30_000;
      if (!force && active === previous && (!active || Date.now() - lastSent < 10_000)) return;
      previous = active; lastSent = Date.now();
      void request("/api/push/activity", { method: "POST", keepalive: true, body: JSON.stringify({ deviceId, active }) }).catch(() => {});
    };
    const gesture = (event: Event) => { if (event.isTrusted) { lastActivity = Date.now(); send(); } };
    const focus = () => { if (document.hasFocus()) lastActivity = Date.now(); send(true); };
    const hidden = () => send(true);
    const pagehide = () => { lastActivity = 0; send(true); };
    for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) window.addEventListener(name, gesture, { passive: true });
    window.addEventListener("focus", focus); window.addEventListener("blur", hidden);
    window.addEventListener("pagehide", pagehide); document.addEventListener("visibilitychange", focus);
    refreshRef.current = () => send(true);
    const timer = window.setInterval(() => send(), 5000);
    send(true);
    return () => {
      refreshRef.current = () => {};
      clearInterval(timer);
      for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) window.removeEventListener(name, gesture);
      window.removeEventListener("focus", focus); window.removeEventListener("blur", hidden);
      window.removeEventListener("pagehide", pagehide); document.removeEventListener("visibilitychange", focus);
      void request("/api/push/activity", { method: "POST", keepalive: true, body: JSON.stringify({ deviceId, active: false }) }).catch(() => {});
    };
  }, [request, userId]);
  // A collapsed host iframe must expire immediately even when its document
  // remains visible. Triggering visibility through the ref also avoids a new ID.
  useEffect(() => { refreshRef.current(); }, [visible]);
}

export function usePushNotificationSync(userId: string | undefined, cursor: string, request: AttachmentRequest) {
  useEffect(() => {
    if (!userId || !("serviceWorker" in navigator)) return;
    let cancelled = false;
    const sync = async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        if (!registration?.active || cancelled) return;
        const result = await request<{ state: unknown }>("/api/push/state");
        if (!cancelled) registration.active.postMessage({ type: "notification_state", state: result.state });
      } catch { /* Push/sync may be unavailable offline; ordinary chat still works. */ }
    };
    void sync();
    const onVisibility = () => { if (document.visibilityState === "visible") void sync(); };
    document.addEventListener("visibilitychange", onVisibility);
    navigator.serviceWorker.addEventListener("controllerchange", sync);
    return () => { cancelled = true; document.removeEventListener("visibilitychange", onVisibility); navigator.serviceWorker.removeEventListener("controllerchange", sync); };
  }, [cursor, request, userId]);
}
