import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { assertRateLimit } from "@/lib/rate-limit";
import { updateStore } from "@/lib/store";
import { cleanNickname, cleanString, validHttpUrl, validLength, validNickname } from "@/lib/validation";

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const user = await authenticate(request);
  return ok({ user: publicUser(user) });
});

export const PATCH = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const body = await readJson(request);
  const name = cleanString(body.name);
  const nicknameSupplied = Object.hasOwn(body, "nickname");
  const nickname = nicknameSupplied ? cleanNickname(body.nickname) : authenticated.nickname;
  const avatarUrl = cleanString(body.avatarUrl);
  if (!validLength(name, 1, LIMITS.name)) {
    throw new ApiError(422, "invalid_name", `Имя должно содержать от 1 до ${LIMITS.name} символов`);
  }
  if (avatarUrl && (!validLength(avatarUrl, 1, LIMITS.avatarUrl) || !validHttpUrl(avatarUrl))) {
    throw new ApiError(422, "invalid_avatar_url", "Адрес аватарки должен быть корректным HTTP(S)-URL");
  }
  if (nickname && !validNickname(nickname)) {
    throw new ApiError(
      422,
      "invalid_nickname",
      `Ник: до ${LIMITS.nickname} строчных латинских букв, цифр или символов _ . -`,
    );
  }
  const user = await updateStore((store) => {
    const item = store.users.find((candidate) => candidate.id === authenticated.id);
    if (!item) throw new ApiError(404, "user_not_found", "Пользователь не найден");
    if (
      nickname &&
      store.users.some((candidate) => candidate.id !== authenticated.id && candidate.nickname === nickname)
    ) {
      throw new ApiError(409, "nickname_taken", "Этот ник уже занят");
    }
    item.name = name;
    item.nickname = nickname || undefined;
    item.avatarUrl = avatarUrl || undefined;
    item.updatedAt = new Date().toISOString();
    return item;
  });
  return ok({ user: publicUser(user) });
});
