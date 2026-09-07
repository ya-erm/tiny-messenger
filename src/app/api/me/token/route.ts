import { ApiError, ok, route } from "@/lib/api";
import { authenticate, createToken, hashToken } from "@/lib/auth";
import { write } from "@/lib/db";
import { assertRateLimit } from "@/lib/rate-limit";

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const token = createToken();
  const tokenHash = hashToken(token);
  await write(async (tx) => {
    const collision = await tx.user.findFirst({
      where: { tokenHash, id: { not: authenticated.id } },
      select: { id: true },
    });
    if (collision) throw new ApiError(409, "token_taken", "Такой токен уже используется");
    const user = await tx.user.findUnique({ where: { id: authenticated.id }, select: { id: true } });
    if (!user) throw new ApiError(404, "user_not_found", "Пользователь не найден");
    await tx.user.update({
      where: { id: authenticated.id },
      data: { tokenHash, updatedAt: new Date().toISOString() },
    });
  });
  return ok({ token });
});
