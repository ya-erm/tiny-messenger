import { randomUUID } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { createToken, hashToken, publicUser } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { write } from "@/lib/db";
import { animalProfileByName, randomAnimalProfile } from "@/lib/names";
import { assertRateLimit } from "@/lib/rate-limit";
import { toUserRecord } from "@/lib/store";
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
  const user = await write(async (tx) => {
    if (nickname && await tx.user.findUnique({ where: { nickname }, select: { id: true } })) {
      throw new ApiError(409, "nickname_taken", "Этот ник уже занят");
    }
    return tx.user.create({
      data: {
        id: randomUUID(),
        name,
        nickname: nickname || null,
        avatarUrl: animalProfile?.avatarUrl || null,
        tokenHash: hashToken(token),
        createdAt: now,
        updatedAt: now,
      },
    });
  });

  return ok({ user: publicUser(toUserRecord(user)), token }, { status: 201 });
});
