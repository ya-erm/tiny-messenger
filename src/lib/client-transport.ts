export const CHANNEL_KEY = "tiny-messenger:v2:channel";
export const CHANNEL_EVENT = "tiny-messenger:channel";
export type ChannelId = "default" | "vps-1" | "yandex-1";
export const API_CHANNELS = [
  { id: "default", name: "По умолчанию", origin: "https://api.tm.ya-erm.ru" },
  { id: "vps-1", name: "VPS", origin: "https://ch-1.api.tm.ya-erm.ru" },
  { id: "yandex-1", name: "Яндекс Облако", origin: "https://ch-2.api.tm.ya-erm.ru" },
] as const;
// The same Yandex installation is also reachable while its custom-domain
// quota/certificate is being configured. Never fail over to another contour.
export const YANDEX_GATEWAY_ORIGIN = "https://d5dbsbpos3rfligv4k7h.nnekmrav.apigw.yandexcloud.net";
let gatewayUntil = 0;
export function selectedChannel(): ChannelId {
  if (typeof window === "undefined") return "default";
  try {
    const value = window.localStorage.getItem(CHANNEL_KEY);
    return API_CHANNELS.some((channel) => channel.id === value) ? value as ChannelId : "default";
  } catch { return "default"; }
}
export function chooseChannel(id: ChannelId) {
  window.localStorage.setItem(CHANNEL_KEY, id);
  window.dispatchEvent(new Event(CHANNEL_EVENT));
}
export function channelUrl(path: string, channel = selectedChannel()): string {
  if (!path.startsWith("/api/")) throw new Error("Ожидался путь API Messenger");
  // Voice and its existing notifications continue using the VPS.
  const pinned = /^\/api\/(?:rtc|realtime|integrations|push)(?:\/|$)/.test(path);
  const target = API_CHANNELS.find((item) => item.id === (pinned ? "vps-1" : channel))!;
  if (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname) && target.id !== "yandex-1") return path;
  return target.origin + path;
}
export async function fetchChannel(path: string, init: RequestInit = {}, channel = selectedChannel()) {
  const url = channelUrl(path, channel);
  const cloud = channel === "yandex-1" && url.startsWith(API_CHANNELS[2].origin + "/");
  if (!cloud) return fetch(url, init);
  if (gatewayUntil > Date.now()) return fetch(YANDEX_GATEWAY_ORIGIN + path, init);
  try {
    return await fetch(url, { ...init, signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(4000)]) : AbortSignal.timeout(4000) });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    const response = await fetch(YANDEX_GATEWAY_ORIGIN + path, init);
    gatewayUntil = Date.now() + 5 * 60_000;
    return response;
  }
}
