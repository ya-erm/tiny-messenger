import { ApiError, ok, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore } from "@/lib/store";
import { cleanNickname, validNickname } from "@/lib/validation";

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const searchParams = new URL(request.url).searchParams;
  const query = cleanNickname(searchParams.get("query"));
  const nickname = cleanNickname(searchParams.get("nickname"));

  if (query) {
    if (!validNickname(query)) {
      throw new ApiError(
        400,
        "invalid_nickname_query",
        `Поиск: до ${LIMITS.nickname} строчных латинских букв, цифр или символов _ . -`,
      );
    }
    const store = await readStore();
    const users = store.users
      .filter(
        (candidate) =>
          candidate.id !== authenticated.id &&
          candidate.nickname?.includes(query),
      )
      .sort((left, right) => {
        const leftNickname = left.nickname ?? "";
        const rightNickname = right.nickname ?? "";
        const leftRank = leftNickname === query ? 0 : leftNickname.startsWith(query) ? 1 : 2;
        const rightRank = rightNickname === query ? 0 : rightNickname.startsWith(query) ? 1 : 2;
        return leftRank - rightRank || leftNickname.localeCompare(rightNickname, "en");
      })
      .map(publicUser);
    return ok({ users });
  }

  if (!validNickname(nickname)) {
    throw new ApiError(
      400,
      "invalid_nickname",
      `Ник: до ${LIMITS.nickname} строчных латинских букв, цифр или символов _ . -`,
    );
  }
  const store = await readStore();
  const user = store.users.find((candidate) => candidate.nickname === nickname);
  if (!user) throw new ApiError(404, "user_not_found", "Пользователь с таким ником не найден");
  return ok({ user: publicUser(user) });
});
