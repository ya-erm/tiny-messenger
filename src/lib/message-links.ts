export type MessageTextPart = { text: string; href?: string };

function trimLink(value: string) {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const counts: Record<string, number> = {};
  for (const character of value) counts[character] = (counts[character] ?? 0) + 1;
  let end = value.length;
  while (end > 0) {
    const character = value[end - 1];
    if (/[.,!?;:…]/u.test(character)) { end--; continue; }
    const opening = pairs[character];
    if (!opening || (counts[character] ?? 0) <= (counts[opening] ?? 0)) break;
    counts[character]--;
    end--;
  }
  return value.slice(0, end);
}

export function messageTextParts(text: string): MessageTextPart[] {
  const parts: MessageTextPart[] = [];
  const pattern = /(?:https?:\/\/|www\.)[^\s<>"`«»“”]+/giu;
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > 0 && /[\p{L}\p{N}_@]/u.test(text[match.index - 1])) continue;
    let value = trimLink(match[0]);
    if (text[match.index - 1] === "'") value = value.replace(/'$/u, "");
    let url: URL;
    try { url = new URL(/^www\./i.test(value) ? `https://${value}` : value); } catch { continue; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
    if (/^www\./i.test(match[0]) && !url.hostname.includes(".")) continue;
    if (match.index > from) parts.push({ text: text.slice(from, match.index) });
    parts.push({ text: value, href: url.href });
    from = match.index + value.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from) });
  return parts;
}
