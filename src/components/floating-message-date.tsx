"use client";

import { type RefObject, useLayoutEffect } from "react";

// The actual day heading is sticky. This controller only controls visibility;
// it never creates a second copy or animates the heading's scroll position.
export function MessageDatePinning({ streamRef, scope }: {
  streamRef: RefObject<HTMLDivElement | null>;
  scope: string;
}) {
  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    let lastTop = stream.scrollTop;
    let armedUntil = 0;
    let frame = 0;
    let timer = 0;
    const measure = () => {
      frame = 0;
      const viewport = stream.getBoundingClientRect();
      const headings = Array.from(stream.querySelectorAll<HTMLElement>(".message-date-separator"));
      const top = viewport.top + (headings[0] ? parseFloat(getComputedStyle(headings[0]).top) || 0 : 0);
      const states = headings.map((heading) => {
        const group = heading.parentElement!;
        const naturalTop = group.getBoundingClientRect().top + (parseFloat(getComputedStyle(group).paddingTop) || 0);
        return { heading, pinned: naturalTop < top - .5 };
      });
      for (const { heading, pinned } of states) heading.classList.toggle("is-pinned", pinned);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const hide = () => {
      window.clearTimeout(timer);
      stream.classList.remove("date-scrolling-up");
    };
    const arm = () => { armedUntil = performance.now() + 1500; };
    const onKey = (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home", " "].includes(event.key)) arm();
    };
    const onScroll = () => {
      const top = stream.scrollTop;
      const delta = top - lastTop;
      lastTop = top;
      if (Math.abs(delta) >= .5) {
        if (delta < 0 && performance.now() <= armedUntil) {
          arm();
          stream.classList.add("date-scrolling-up");
          window.clearTimeout(timer);
          timer = window.setTimeout(hide, 1200);
        } else hide();
      }
      schedule();
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(stream);
    if (stream.firstElementChild) resize.observe(stream.firstElementChild);
    const mutation = new MutationObserver(schedule);
    mutation.observe(stream, { childList: true, subtree: true });
    stream.addEventListener("scroll", onScroll, { passive: true });
    stream.addEventListener("wheel", arm, { passive: true });
    stream.addEventListener("touchstart", arm, { passive: true });
    stream.addEventListener("pointerdown", arm, { passive: true });
    stream.addEventListener("keydown", onKey);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      hide();
      resize.disconnect();
      mutation.disconnect();
      stream.querySelectorAll(".message-date-separator.is-pinned").forEach((heading) => heading.classList.remove("is-pinned"));
      stream.removeEventListener("scroll", onScroll);
      stream.removeEventListener("wheel", arm);
      stream.removeEventListener("touchstart", arm);
      stream.removeEventListener("pointerdown", arm);
      stream.removeEventListener("keydown", onKey);
    };
  }, [scope, streamRef]);
  return null;
}
