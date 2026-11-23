import { Fragment } from "react";
import { EmojiText } from "@/components/emoji";
import { messageTextParts } from "@/lib/message-links";

export function MessageText({ text, disabled = false }: { text: string; disabled?: boolean }) {
  if (disabled) return <EmojiText text={text} />;
  return messageTextParts(text).map((part, index) => part.href
    ? <a key={index} className="message-link" href={part.href} target="_blank" rel="noopener noreferrer"><EmojiText text={part.text} /></a>
    : <Fragment key={index}><EmojiText text={part.text} /></Fragment>);
}
