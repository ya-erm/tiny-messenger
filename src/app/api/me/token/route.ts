import { ApiError, ok, route } from "@/lib/api";
import { authenticate, createToken, hashToken } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rate-limit";
import { updateStore } from "@/lib/store";

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const token = createToken();
  const tokenHash = hashToken(token);
  await updateStore((store) => {
    if (store.users.some((user) => user.tokenHash === tokenHash && user.id !== authenticated.id)) {
      throw new ApiError(409, "token_taken", "Такой токен уже используется");
    }
    const user = store.users.find((candidate) => candidate.id === authenticated.id);
    if (!user) throw new ApiError(404, "user_not_found", "Пользователь не найден");
    user.tokenHash = tokenHash;
    user.updatedAt = new Date().toISOString();
  });
  return ok({ token });
});
