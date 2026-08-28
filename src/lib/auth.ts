import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { readStore } from "@/lib/store";
import type { PublicUser, UserRecord } from "@/lib/types";
import { ApiError } from "@/lib/api";

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

export function createToken() {
  return `msg_${randomBytes(12).toString("base64url")}`;
}

export function publicUser(user: UserRecord): PublicUser {
  return {
    id: user.id,
    name: user.name,
    ...(user.nickname ? { nickname: user.nickname } : {}),
    ...(user.avatarUrl ? { avatarUrl: user.avatarUrl } : {}),
    createdAt: user.createdAt,
  };
}

export async function authenticateToken(token: string) {
  const store = await readStore();
  const user = store.users.find((item) => item.tokenHash === hashToken(token));
  if (!user) throw new ApiError(401, "invalid_token", "Токен не найден или был заменён");
  return user;
}

export function tokenFromRequest(request: Request) {
  const authorization = request.headers.get("authorization");
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return request.headers.get("x-api-key")?.trim() || "";
}

export async function authenticate(request: Request) {
  const token = tokenFromRequest(request);
  if (!token) throw new ApiError(401, "missing_token", "Передайте Bearer-токен или X-API-Key");
  return authenticateToken(token);
}
