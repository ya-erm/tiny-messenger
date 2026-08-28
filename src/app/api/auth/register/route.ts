import { randomUUID } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { createToken, hashToken, publicUser } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { animalProfileByName, randomAnimalProfile } from "@/lib/names";
import { assertRateLimit } from "@/lib/rate-limit";
import { updateStore } from "@/lib/store";
import { cleanNickname, cleanString, validLength, validNickname } from "@/lib/validation";

export const POST = route(async (request) => {
  assertRateLimit(request);
  const body = await readJson(request);
  const suppliedName = cleanString(body.name);
  const animalProfile = suppliedName ? animalProfileByName(suppliedName) : randomAnimalProfile();
  const name = suppliedName || animalProfile?.name || randomAnimalProfile().name;
  const nickname = cleanNickname(body.nickname);
  if (!validLength(name, 1, LIMITS.name)) {
    throw new ApiError(422, "invalid_name", `Имя должно быть не длиннее ${LIMITS.name} символов`);
  }
  if (nickname && !validNickname(nickname)) {
    throw new ApiError(
      422,
      "invalid_nickname",
      `Ник: до ${LIMITS.nickname} строчных латинских букв, цифр или символов _ . -`,
    );
  }

  const token = createToken();
  const now = new Date().toISOString();
  const user = await updateStore((store) => {
    if (nickname && store.users.some((candidate) => candidate.nickname === nickname)) {
      throw new ApiError(409, "nickname_taken", "Этот ник уже занят");
    }
    const item = {
      id: randomUUID(),
      name,
      ...(nickname ? { nickname } : {}),
      ...(animalProfile?.avatarUrl ? { avatarUrl: animalProfile.avatarUrl } : {}),
      tokenHash: hashToken(token),
      createdAt: now,
      updatedAt: now,
    };
    store.users.push(item);
    return item;
  });

  return ok({ user: publicUser(user), token }, { status: 201 });
});
