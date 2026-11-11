import assets from "@/lib/emoji-assets.json";

const known = new Set(assets);
export const EMOJI_ASSET_BASE = "/emoji/twemoji-17.0.3/";

export function emojiAsset(value: string) {
  const code = (text: string) => [...text].map((character) => character.codePointAt(0)!.toString(16)).join("-");
  const exact = code(value);
  const presentation = code(value.replace(/\ufe0f/g, ""));
  const key = known.has(exact) ? exact : known.has(presentation) ? presentation : null;
  return key ? EMOJI_ASSET_BASE + key + ".svg" : null;
}
