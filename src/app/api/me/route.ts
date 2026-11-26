import { recordIdentity, identityStore } from "@/lib/replication/identity";
import { nextIdentityTime } from "@/lib/replication/identity-protocol";
import { recordNicknameClaim } from "@/lib/replication/users";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { write } from "@/lib/db";
import { assertRateLimit } from "@/lib/rate-limit";
import { toUserRecord } from "@/lib/store";
import { cleanNickname, cleanString, validAvatarBackground, validHttpUrl, validLength, validNickname } from "@/lib/validation";

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
  const avatarBackgroundSupplied = Object.hasOwn(body, "avatarBackground");
  const avatarBackground = avatarBackgroundSupplied
    ? cleanString(body.avatarBackground)
    : authenticated.avatarBackground;
  if (!validLength(name, 1, LIMITS.name)) {
    throw new ApiError(422, "invalid_name", `Имя должно содержать от 1 до ${LIMITS.name} символов`);
  }
  if (avatarUrl && (!validLength(avatarUrl, 1, LIMITS.avatarUrl) || !validHttpUrl(avatarUrl))) {
    throw new ApiError(422, "invalid_avatar_url", "Адрес аватарки должен быть корректным HTTP(S)-URL");
  }
  if (avatarBackground && !validAvatarBackground(avatarBackground)) {
    throw new ApiError(422, "invalid_avatar_background", "Фон аватарки должен быть цветом в формате #RRGGBB");
  }
  if (nickname && !validNickname(nickname)) {
    throw new ApiError(
      422,
      "invalid_nickname",
      `Ник: до ${LIMITS.nickname} строчных латинских букв, цифр или символов _ . -`,
    );
  }
  const user = await write(async (tx) => {
    const item = await tx.user.findUnique({ where: { id: authenticated.id }, select: { id: true, tokenHash:true } });
    if (!item) throw new ApiError(404, "user_not_found", "Пользователь не найден");
    if(item.tokenHash!==authenticated.tokenHash)throw new ApiError(401,"invalid_token","Токен недействителен");
    if (nickname) {
      const taken = await tx.user.findFirst({
        where: { nickname, id: { not: authenticated.id } },
        select: { id: true },
      });
      if (taken) throw new ApiError(409, "nickname_taken", "Этот ник уже занят");
    }
    const store=identityStore(tx),state=await store.get("identity-state",authenticated.id)||{},claim=await store.get("nickname-claims",authenticated.id);
    const updatedAt=nextIdentityTime(state.profile);
    const nicknameAt=(nickname||null)!==(authenticated.nickname||null)?updatedAt:state.profile?.nicknameAt||claim?.at||authenticated.createdAt;
    await recordIdentity(tx,authenticated.id,{kind:"profile",at:updatedAt,nicknameAt,profile:{name,nickname:nickname||null,avatarUrl:avatarUrl||null,avatarBackground:avatarBackground||null}});
    if(nicknameSupplied)await recordNicknameClaim(tx,authenticated.id,nickname||null,nicknameAt);
    return tx.user.findUniqueOrThrow({where:{id:authenticated.id}});
  });
  return ok({ user: publicUser(toUserRecord(user)) });
});
