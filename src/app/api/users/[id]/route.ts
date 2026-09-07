import { ApiError, ok, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { read } from "@/lib/db";
import { assertRateLimit } from "@/lib/rate-limit";
import { toUserRecord } from "@/lib/store";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_user_id", "Некорректный UUID");
  const user = await read((db) => db.user.findUnique({ where: { id } }));
  if (!user) throw new ApiError(404, "user_not_found", "Пользователь не найден");
  return ok({ user: publicUser(toUserRecord(user)) });
});
