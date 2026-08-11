import { ApiError, ok, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore } from "@/lib/store";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_user_id", "Некорректный UUID");
  const store = await readStore();
  const user = store.users.find((candidate) => candidate.id === id);
  if (!user) throw new ApiError(404, "user_not_found", "Пользователь не найден");
  return ok({ user: publicUser(user) });
});
