"use client";

import { Fragment, useState } from "react";
import emojiRegex from "emoji-regex";
import { emojiAsset } from "@/lib/emoji-assets";

export function Emoji({ value, decorative = false }: { value: string; decorative?: boolean }) {
  const src = emojiAsset(value);
  const [failedSource, setFailedSource] = useState("");
  if (!src || src === failedSource) return <span aria-hidden={decorative || undefined}>{value}</span>;
  return <span className="emoji-art" aria-hidden={decorative || undefined}>
    <img src={src} alt="" width={24} height={24} loading="lazy" decoding="async" draggable={false} onError={() => setFailedSource(src)} />
    {/* Keep the Unicode text in the DOM for selection, copying and assistive
        technology; the artwork overlays it without depending on OS fonts. */}
    <span className="emoji-art-native">{value}</span>
  </span>;
}

export function EmojiText({ text }: { text: string }) {
  const result = [];
  let from = 0;
  for (const match of text.matchAll(emojiRegex())) {
    const index = match.index;
    if (index > from) result.push(<Fragment key={`text-${from}`}>{text.slice(from, index)}</Fragment>);
    result.push(<Emoji key={`emoji-${index}`} value={match[0]} />);
    from = index + match[0].length;
  }
  if (!from) return text;
  if (from < text.length) result.push(<Fragment key={`text-${from}`}>{text.slice(from)}</Fragment>);
  return result;
}
