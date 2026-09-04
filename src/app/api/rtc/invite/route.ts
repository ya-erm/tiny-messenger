import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { sendPushToUser } from "@/lib/push";
import { readStore } from "@/lib/store";

function validInternalToken(value: string) {
  const expected = process.env.MESSENGER_INTERNAL_TOKEN || "";
  if (!value || !expected) return false;
  return timingSafeEqual(
    createHash("sha256").update(value).digest(),
    createHash("sha256").update(expected).digest(),
  );
}

export const POST = route(async (request) => {
  if (!validInternalToken(request.headers.get("x-internal-token") || "")) {
    throw new ApiError(404, "not_found", "Маршрут не найден");
  }
  const body = await readJson(request);
  const peerUserId = typeof body.peerUserId === "string" ? body.peerUserId : "";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const fromUserId = typeof body.fromUserId === "string" ? body.fromUserId : "";
  const fromName = typeof body.fromName === "string" ? body.fromName.slice(0, 80) : "Собеседник";
  const store = await readStore();
  if (!peerUserId || !sessionId || !fromUserId || !store.users.some((user) => user.id === peerUserId)) {
    throw new ApiError(400, "invalid_invite", "Некорректное приглашение в звонок");
  }
  await sendPushToUser(peerUserId, {
    kind: "voice_invite",
    sessionId,
    fromUserId,
    title: "Входящий голосовой чат",
    body: `${fromName} ждёт вас в голосовом чате`,
    tag: `voice-${sessionId}`,
    url: `/id/${encodeURIComponent(fromUserId)}?voice=${encodeURIComponent(sessionId)}`,
  });
  return ok({ sent: true });
});
