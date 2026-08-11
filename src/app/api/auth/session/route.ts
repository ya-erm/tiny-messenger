import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticateToken, publicUser } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rate-limit";

export const POST = route(async (request) => {
  assertRateLimit(request);
  const body = await readJson(request);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) throw new ApiError(422, "missing_token", "Введите токен");
  const user = await authenticateToken(token);
  return ok({ user: publicUser(user) });
});
