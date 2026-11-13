"use client";

import { type RefObject, useLayoutEffect } from "react";

function fit(field: HTMLTextAreaElement) {
  field.style.height = "auto";
  const style = getComputedStyle(field);
  const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
  const maximum = parseFloat(style.maxHeight) || 120;
  const needed = field.scrollHeight + border;
  field.style.height = `${Math.min(needed, maximum)}px`;
  field.style.overflowY = needed > maximum ? "auto" : "hidden";
}

export function useGrowingTextarea(ref: RefObject<HTMLTextAreaElement | null>, text: string) {
  useLayoutEffect(() => { if (ref.current) fit(ref.current); }, [ref, text]);
  useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      fit(field);
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [ref]);
}
