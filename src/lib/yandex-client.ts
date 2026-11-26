import {API_CHANNELS, fetchChannel, type ChannelId} from "./client-transport";
import {cacheProfile} from "./client-storage";
import type {PublicUser} from "./types";

const FLOW_KEY = "tiny-messenger:v1:yandex-flow";
const TOKEN_KEY = "tiny-messenger:v1:token";
type Flow = {state: string; verifier: string; mode: "link" | "login"; userId?: string; returnPath: string; proof?: string; code?: string};
class YandexError extends Error {
  constructor(message: string, readonly code = "", readonly status = 0) { super(message); }
}
async function call<T>(action: string, body?: unknown, token = "", channel?: ChannelId): Promise<T> {
  const response = await fetchChannel("/api/auth/yandex/" + action, {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: {...(body === undefined ? {} : {"Content-Type": "application/json"}), ...(token ? {Authorization: "Bearer " + token} : {})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  }, channel);
  const value = await response.json();
  if (!response.ok || !value.ok) throw new YandexError(value.error?.message || "Не удалось выполнить вход через Яндекс", value.error?.code, response.status);
  return value.data as T;
}
export const yandexConfig = () => call<{enabled: boolean}>("config");
export const yandexLinkStatus = (token: string) => call<{linked: boolean; label?: string; conflict?: boolean}>("link", undefined, token);
function base64url(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
export async function startYandex(mode: "link" | "login", token = "", userId?: string) {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const result = await call<{url: string; state: string}>("start", {mode, origin: location.origin, challenge}, token);
  const returnPath = location.pathname + location.search + location.hash;
  sessionStorage.setItem(FLOW_KEY, JSON.stringify({state: result.state, verifier, mode, userId, returnPath} satisfies Flow));
  location.assign(result.url);
}
export async function completeYandex() {
  const query = new URLSearchParams(location.search);
  const state = query.get("state"), code = query.get("code"), providerError = query.has("error");
  history.replaceState(null, "", location.pathname);
  let flow: Flow;
  try { flow = JSON.parse(sessionStorage.getItem(FLOW_KEY) || "null"); } catch { throw new Error("Не найден запрос входа. Начните вход заново."); }
  if (!flow || state && state !== flow.state) throw new Error("Подтверждение не соответствует запросу. Начните вход в этом браузере заново.");
  if (providerError) throw new Error("Вход через Яндекс отменён.");
  if (!flow.proof) {
    if (state === flow.state && code) {flow.code = code; sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow));}
    if (!flow.code) throw new Error("Не найден код подтверждения. Начните вход заново.");
    // A safe read resolves the cloud gateway fallback before consuming the one-use code.
    await yandexConfig();
    const result = await call<{proof: string}>("exchange", {state: flow.state, code: flow.code, verifier: flow.verifier});
    flow.proof = result.proof;
    delete flow.code;
    sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow));
  }
  const body = {proof: flow.proof, verifier: flow.verifier};
  const channels = API_CHANNELS.filter(channel => channel.id !== "default");
  if (flow.mode === "login") {
    const results = await Promise.allSettled(channels.map(channel => call<{user: PublicUser; token: string}>("finish", body, "", channel.id)));
    const successful = results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
    const conflict = results.some(result => result.status === "rejected" && result.reason instanceof YandexError && result.reason.code === "yandex_link_conflict");
    if (conflict || new Set(successful.map(result => result.user.id)).size > 1) throw new Error("Обнаружен конфликт привязок. Войдите по резервному токену.");
    if (!successful.length) {
      const known = results.find(result => result.status === "rejected" && result.reason instanceof YandexError && result.reason.status === 404);
      if (known?.status === "rejected") throw known.reason;
      throw new Error("Каналы временно недоступны. Повторите попытку.");
    }
    const result = successful[0];
    localStorage.setItem(TOKEN_KEY, result.token);
    await cacheProfile(result.token, result.user).catch(() => {});
  } else {
    const token = localStorage.getItem(TOKEN_KEY) || "";
    if (!token) throw new Error("Вы вышли из аккаунта. Войдите по токену и повторите привязку.");
    // Reachable replicas can reject a known conflicting binding before a local commit.
    const checks = await Promise.allSettled(channels.map(channel => call<{canLink: boolean; userId: string}>("finish", {...body, checkOnly: true}, token, channel.id)));
    for (const result of checks) {
      if (result.status === "rejected" && result.reason instanceof YandexError && ["yandex_already_linked", "another_yandex_linked", "yandex_actor_changed"].includes(result.reason.code)) throw result.reason;
      if (result.status === "fulfilled" && result.value.userId !== flow.userId) throw new Error("Аккаунт изменился. Повторите привязку.");
    }
    await call("finish", body, token);
  }
  sessionStorage.removeItem(FLOW_KEY);
  const returnPath = flow.returnPath?.startsWith("/") && !flow.returnPath.startsWith("//") && !flow.returnPath.startsWith("/auth/") ? flow.returnPath : "/";
  const destination = new URL(returnPath, location.origin);
  location.replace(destination.origin === location.origin ? destination.href : "/");
}
