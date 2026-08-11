import { ApiError, ok, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rate-limit";
import { updateStore } from "@/lib/store";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const DELETE = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_user_id", "Некорректный UUID");
  await updateStore((store) => {
    const index = store.contacts.findIndex(
      (candidate) => candidate.ownerId === authenticated.id && candidate.userId === id,
    );
    if (index < 0) throw new ApiError(404, "contact_not_found", "Контакт не найден");
    store.contacts.splice(index, 1);
  });
  return ok({ deleted: true });
});
