import { ApiError, ok, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { write } from "@/lib/db";
import { assertRateLimit } from "@/lib/rate-limit";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const DELETE = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_user_id", "Некорректный UUID");
  await write(async (tx) => {
    const { count } = await tx.contact.deleteMany({ where: { ownerId: authenticated.id, userId: id } });
    if (count === 0) throw new ApiError(404, "contact_not_found", "Контакт не найден");
  });
  return ok({ deleted: true });
});
