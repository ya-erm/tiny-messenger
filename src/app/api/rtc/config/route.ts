import { createHmac } from "node:crypto";
import { ok, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rate-limit";

function urls(value: string | undefined) {
  return (value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const user = await authenticate(request);
  const iceServers: RTCIceServer[] = [];
  const stunUrls = urls(process.env.RTC_STUN_URLS);
  if (stunUrls.length) iceServers.push({ urls: stunUrls });

  const turnUrls = urls(process.env.RTC_TURN_URLS);
  const turnSecret = process.env.RTC_TURN_SECRET?.trim();
  if (turnUrls.length && turnSecret) {
    const expiresAt = Math.floor(Date.now() / 1000) + 60 * 60;
    const username = `${expiresAt}:${user.id}`;
    const credential = createHmac("sha1", turnSecret).update(username).digest("base64");
    iceServers.push({ urls: turnUrls, username, credential });
  }

  return ok({ iceServers, iceCandidatePoolSize: 1 });
});
