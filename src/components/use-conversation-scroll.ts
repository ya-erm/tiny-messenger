"use client";

import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

type ScrollMessage = { id: string; fromUserId: string; sentAt: string };
type Anchor = { messageId: string } | "latest" | null;

export function useConversationScroll(
  streamRef: RefObject<HTMLDivElement | null>,
  scope: string | null,
  messages: readonly ScrollMessage[],
  userId: string | undefined,
  readAt: string,
  active: boolean,
) {
  const position = useRef<{ scope: string | null; anchor: Anchor }>({ scope: null, anchor: null });
  const align = useCallback(() => {
    const stream = streamRef.current;
    const anchor = position.current.anchor;
    if (!stream || !anchor || !stream.clientHeight) return;
    if (anchor === "latest") {
      stream.scrollTo({ top: stream.scrollHeight, behavior: "instant" });
      return;
    }
    const row = Array.from(stream.querySelectorAll<HTMLElement>("[data-message-id]"))
      .find((element) => element.dataset.messageId === anchor.messageId);
    if (!row) return;
    const padding = parseFloat(getComputedStyle(stream).paddingTop) || 0;
    stream.scrollTo({
      top: stream.scrollTop + row.getBoundingClientRect().top - stream.getBoundingClientRect().top - padding,
      behavior: "instant",
    });
  }, [streamRef]);

  useLayoutEffect(() => {
    if (position.current.scope === scope) return;
    // Snapshot the unread target once, before opening the chat advances its
    // read watermark. Polling/read receipts must not choose a different row.
    const unread = messages.find((message) => message.fromUserId !== userId && message.sentAt > readAt);
    position.current = { scope, anchor: scope ? (unread ? { messageId: unread.id } : "latest") : null };
    if (active) align();
  }, [scope, messages, userId, readAt, active, align]);

  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!scope || !active || !stream) return;
    let frame = 0;
    const schedule = () => {
      if (!frame && position.current.anchor) frame = requestAnimationFrame(() => { frame = 0; align(); });
    };
    const release = () => { position.current.anchor = null; cancelAnimationFrame(frame); frame = 0; };
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) release();
    };
    // Observe content as well as the scrollport: a thumbnail/font can finish
    // loading after the initial paint, and the keyboard can resize the stream.
    const observer = new ResizeObserver(schedule);
    observer.observe(stream);
    if (stream.firstElementChild) observer.observe(stream.firstElementChild);
    stream.addEventListener("load", schedule, true);
    stream.addEventListener("pointerdown", release, { passive: true });
    stream.addEventListener("touchstart", release, { passive: true });
    stream.addEventListener("wheel", release, { passive: true });
    stream.addEventListener("keydown", onKey);
    align();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      stream.removeEventListener("load", schedule, true);
      stream.removeEventListener("pointerdown", release);
      stream.removeEventListener("touchstart", release);
      stream.removeEventListener("wheel", release);
      stream.removeEventListener("keydown", onKey);
    };
  }, [scope, active, align, streamRef]);

  return useCallback(() => {
    position.current.anchor = "latest";
    align();
  }, [align]);
}
