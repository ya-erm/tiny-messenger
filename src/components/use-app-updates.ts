"use client";
import { useEffect, useRef } from "react";
import { createUpdateChecker } from "@/lib/app-updates";

const CHECK_INTERVAL = 5 * 60_000;
const RELOAD_KEY = "tiny-messenger:v1:update-reload";
export function reloadApplication() {
  window.location.reload();
}
export function useAppUpdates(paused: boolean) {
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const applyRef = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    const controller = new AbortController();
    let disposed = false;
    let lastCheck = 0;
    const checker = createUpdateChecker({
      currentVersion: process.env.NEXT_PUBLIC_APP_VERSION || "",
      loadVersion: async () => {
        // Version belongs to the web client, independently of the selected API contour.
        const response = await fetch("/api/version", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
        if (!response.ok) return undefined;
        const body = await response.json();
        return body.ok && typeof body.data?.version === "string" ? body.data.version : undefined;
      },
      canReload: () => !disposed && !pausedRef.current && document.visibilityState === "visible"
        && !document.querySelector('[role="dialog"], .modal-backdrop, .attachment-drafts')
        && !Array.from(document.querySelectorAll("textarea")).some((input) => input.value.length > 0)
        && !document.activeElement?.matches('input, textarea, [contenteditable="true"]'),
      rememberReload: (version) => {
        try {
          const previous = JSON.parse(sessionStorage.getItem(RELOAD_KEY) || "null");
          if (previous?.version === version && Date.now() - previous.at < CHECK_INTERVAL) return false;
          sessionStorage.setItem(RELOAD_KEY, JSON.stringify({ version, at: Date.now() }));
          return true;
        } catch { return false; }
      },
      reload: reloadApplication,
    });
    const check = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastCheck < 60000) return;
      lastCheck = Date.now(); void checker.check();
    };
    applyRef.current = checker.apply;
    check();
    const poll = window.setInterval(check, CHECK_INTERVAL);
    const idle = window.setInterval(checker.apply, 15000);
    document.addEventListener("visibilitychange", check); window.addEventListener("pageshow", check); window.addEventListener("online", check);
    return () => {
      disposed = true; controller.abort(); applyRef.current = undefined;
      window.clearInterval(poll); window.clearInterval(idle);
      document.removeEventListener("visibilitychange", check); window.removeEventListener("pageshow", check); window.removeEventListener("online", check);
    };
  }, []);
  useEffect(() => { if (!paused) applyRef.current?.(); }, [paused]);
}
