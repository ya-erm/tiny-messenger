import { ApiError, ok, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { read } from "@/lib/db";
import { assertRateLimit } from "@/lib/rate-limit";
import { toUserRecord } from "@/lib/store";
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
    if (!rawQuery) {
      const rows = await read((db) => db.user.findMany({
        where: { id: { not: authenticated.id }, nickname: { not: null } },
        orderBy: { updatedAt: "desc" },
        take: 8,
      }));
      return ok({ users: rows.map((row) => publicUser(toUserRecord(row))) });
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

    // SQLite's LIKE folds case for ASCII only, so a Cyrillic name would not
    // match case-insensitively in SQL. The user table is small; rank in JS.
    const rows = await read((db) => db.user.findMany({ where: { id: { not: authenticated.id } } }));
    const users = rows
      .map(toUserRecord)
      .map((candidate) => ({ candidate, rank: searchRank(candidate, query) }))
      .filter(({ rank }) => Number.isFinite(rank))
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
  const user = await read((db) => db.user.findUnique({ where: { nickname } }));
  if (!user) throw new ApiError(404, "user_not_found", "Пользователь с таким ником не найден");
  return ok({ user: publicUser(toUserRecord(user)) });
});
