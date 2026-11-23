"use client";

import { type RefObject, useEffect, useState } from "react";
import { formatMessageDate, localDateKey } from "@/lib/message-dates";

export function FloatingMessageDate({ streamRef, scope, today }: {
  streamRef: RefObject<HTMLDivElement | null>;
  scope: string;
  today: Date;
}) {
  const [badge, setBadge] = useState<{ value: string; visible: boolean } | null>(null);
  useEffect(() => {
    const stream = streamRef.current;
    setBadge(null);
    if (!stream) return;
    let lastTop = stream.scrollTop;
    let armedUntil = 0;
    let frame = 0;
    let timer = 0;
    const hide = () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      frame = 0;
      setBadge((previous) => previous?.visible ? { ...previous, visible: false } : previous);
    };
    const measure = () => {
      frame = 0;
      const viewport = stream.getBoundingClientRect();
      const row = Array.from(stream.querySelectorAll<HTMLElement>("[data-message-date]"))
        .find((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.bottom > viewport.top + 8 && bounds.top < viewport.bottom;
        });
      const value = row?.dataset.messageDate;
      if (!row || !value || stream.scrollTop <= 1) { hide(); return; }
      const heading = row.previousElementSibling;
      if (heading?.classList.contains("message-date-separator")) {
        const bounds = heading.getBoundingClientRect();
        // Let the real heading take over when it occupies the badge's space.
        if (bounds.bottom > viewport.top + 6 && bounds.top < viewport.top + 48) { hide(); return; }
      }
      setBadge((previous) => previous?.visible && previous.value === value ? previous : { value, visible: true });
      window.clearTimeout(timer);
      timer = window.setTimeout(hide, 1200);
    };
    const arm = () => { armedUntil = performance.now() + 1500; };
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home", " "].includes(event.key)) arm();
    };
    const onScroll = () => {
      const top = stream.scrollTop;
      const delta = top - lastTop;
      lastTop = top;
      if (Math.abs(delta) < .5) return;
      if (delta > 0 || performance.now() > armedUntil) { hide(); return; }
      // Keep touch inertia armed, without showing for automatic positioning.
      arm();
      if (!frame) frame = requestAnimationFrame(measure);
    };
    stream.addEventListener("scroll", onScroll, { passive: true });
    stream.addEventListener("wheel", arm, { passive: true });
    stream.addEventListener("touchstart", arm, { passive: true });
    stream.addEventListener("pointerdown", arm, { passive: true });
    stream.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      stream.removeEventListener("scroll", onScroll);
      stream.removeEventListener("wheel", arm);
      stream.removeEventListener("touchstart", arm);
      stream.removeEventListener("pointerdown", arm);
      stream.removeEventListener("keydown", onKey);
    };
  }, [scope, streamRef]);

  return badge ? <div className={`message-floating-date ${badge.visible ? "visible" : ""}`} aria-hidden="true">
    <time dateTime={localDateKey(badge.value)}>{formatMessageDate(badge.value, today)}</time>
  </div> : null;
}
