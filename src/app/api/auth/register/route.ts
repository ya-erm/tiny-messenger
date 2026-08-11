import { randomUUID } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { createToken, hashToken, publicUser } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { randomAnimalName } from "@/lib/names";
import { assertRateLimit } from "@/lib/rate-limit";
import { updateStore } from "@/lib/store";
import { cleanString, validLength } from "@/lib/validation";

export const POST = route(async (request) => {
  assertRateLimit(request);
  const body = await readJson(request);
  const suppliedName = cleanString(body.name);
  const name = suppliedName || randomAnimalName();
  if (!validLength(name, 1, LIMITS.name)) {
    throw new ApiError(422, "invalid_name", `Имя должно быть не длиннее ${LIMITS.name} символов`);
  }

  const token = createToken();
  const now = new Date().toISOString();
  const user = await updateStore((store) => {
    const item = {
      id: randomUUID(),
      name,
      tokenHash: hashToken(token),
      createdAt: now,
      updatedAt: now,
    };
    store.users.push(item);
    return item;
  });

  return ok({ user: publicUser(user), token }, { status: 201 });
});
