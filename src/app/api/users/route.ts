import { ApiError, ok, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore } from "@/lib/store";
import { cleanNickname, cleanString, validLength, validNickname } from "@/lib/validation";

const MAX_SEARCH_QUERY_LENGTH = Math.max(36, LIMITS.name, LIMITS.nickname + 1);

function searchRank(candidate: { id: string; name: string; nickname?: string }, query: string) {
  const id = candidate.id.toLowerCase();
  const name = candidate.name.toLocaleLowerCase("ru");
  const nickname = candidate.nickname?.toLowerCase() ?? "";

  if (id === query || nickname === query || name === query) return 0;
  if (id.startsWith(query) || nickname.startsWith(query) || name.startsWith(query)) return 1;
  if (id.includes(query) || nickname.includes(query) || name.includes(query)) return 2;
  return Number.POSITIVE_INFINITY;
}

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const searchParams = new URL(request.url).searchParams;
  const hasQuery = searchParams.has("query");
  const rawQuery = cleanString(searchParams.get("query"));
  const nickname = cleanNickname(searchParams.get("nickname"));

  if (hasQuery) {
    const store = await readStore();
    if (!rawQuery) {
      const users = store.users
        .filter((candidate) => candidate.id !== authenticated.id && candidate.nickname)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 8)
        .map(publicUser);
      return ok({ users });
    }

    if (!validLength(rawQuery, 1, MAX_SEARCH_QUERY_LENGTH)) {
      throw new ApiError(
        400,
        "invalid_user_query",
        `Поисковый запрос должен быть не длиннее ${MAX_SEARCH_QUERY_LENGTH} символов`,
      );
    }
    const query = rawQuery.replace(/^@/, "").toLocaleLowerCase("ru");
    if (!query) throw new ApiError(400, "invalid_user_query", "Введите имя, ник или UUID");

    const users = store.users
      .map((candidate) => ({ candidate, rank: searchRank(candidate, query) }))
      .filter(({ candidate, rank }) => candidate.id !== authenticated.id && Number.isFinite(rank))
      .sort((left, right) => {
        return left.rank - right.rank
          || left.candidate.name.localeCompare(right.candidate.name, "ru")
          || (left.candidate.nickname ?? "").localeCompare(right.candidate.nickname ?? "", "en")
          || left.candidate.id.localeCompare(right.candidate.id, "en");
      })
      .map(({ candidate }) => publicUser(candidate));
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
