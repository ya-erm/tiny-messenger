"use client";

import { useEffect, useRef } from "react";

// iOS can resize/pan only the visual viewport when the keyboard opens. Keep
// this app window inside it; pinch zoom retains its normal browser behavior.
export function useMobileViewport(enabled: boolean) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const shell = ref.current;
    if (!enabled || !shell) return;
    const mobile = window.matchMedia("(max-width: 800px)");
    const viewport = window.visualViewport;
    let frame = 0;
    let fullHeight = window.innerHeight;
    let width = window.innerWidth;
    let keyboard = false;
    const reset = () => {
      shell.style.removeProperty("--tm-viewport-height");
      shell.style.removeProperty("--tm-viewport-top");
      shell.style.removeProperty("--tm-safe-bottom");
      delete shell.dataset.keyboardOpen;
    };
    const update = () => {
      frame = 0;
      if (!mobile.matches) { reset(); return; }
      if (viewport && Math.abs(viewport.scale - 1) > 0.05) return;
      const height = viewport?.height || window.innerHeight;
      if (Math.abs(width - window.innerWidth) > 50) { fullHeight = window.innerHeight; keyboard = false; }
      width = window.innerWidth;
      fullHeight = Math.max(fullHeight, window.innerHeight, height);
      const active = document.activeElement;
      const editing = active instanceof HTMLElement && (active.matches("input, textarea") || active.isContentEditable);
      keyboard = fullHeight - height > 100 && (editing || keyboard);
      shell.style.setProperty("--tm-viewport-height", `${height}px`);
      shell.style.setProperty("--tm-viewport-top", `${viewport?.offsetTop || 0}px`);
      if (keyboard) shell.style.setProperty("--tm-safe-bottom", "0px");
      else shell.style.removeProperty("--tm-safe-bottom");
      shell.dataset.keyboardOpen = String(keyboard);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    window.addEventListener("resize", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    mobile.addEventListener("change", schedule);
    document.addEventListener("focusin", schedule);
    document.addEventListener("focusout", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      mobile.removeEventListener("change", schedule);
      document.removeEventListener("focusin", schedule);
      document.removeEventListener("focusout", schedule);
      reset();
    };
  }, [enabled]);
  return ref;
}
