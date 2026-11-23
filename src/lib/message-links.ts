export type MessageTextPart = { text: string; href?: string };

// Shared messages can point to applications, but must not execute inline code
// or navigate to browser-internal/local resources in the recipient's context.
const blockedSchemes = new Set([
  "javascript:", "vbscript:", "data:", "blob:", "file:", "filesystem:",
  "about:", "chrome:", "chrome-extension:", "edge:", "resource:", "moz-extension:", "view-source:",
]);

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
  // Consume a boundary so a long word without ':' is scanned only once.
  const pattern = /(^|[^a-z\d+.-])((?:[a-z][a-z\d+.-]*:|www\.)[^\s<>"`«»“”]+)/giu;
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index + match[1].length;
    if (index > 0 && /[\p{L}\p{N}_@]/u.test(text[index - 1])) continue;
    let value = trimLink(match[2]);
    if (text[index - 1] === "'") value = value.replace(/'$/u, "");
    if (/^[a-z]:[\\/](?![\\/])/i.test(value)) continue;
    // A www host may include a numeric port; www.app:open is instead a URI.
    const webAddress = /^www\./i.test(value) && !/^[a-z][a-z\d+.-]*:(?!\d+(?:[/?#]|$))/i.test(value);
    let url: URL;
    try { url = new URL(webAddress ? `https://${value}` : value); } catch { continue; }
    if (blockedSchemes.has(url.protocol)) continue;
    if (["http:", "https:"].includes(url.protocol) && (url.username || url.password)) continue;
    if (webAddress && !url.hostname.includes(".")) continue;
    if (index > from) parts.push({ text: text.slice(from, index) });
    parts.push({ text: value, href: url.href });
    from = index + value.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from) });
  return parts;
}
