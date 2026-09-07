import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { read, write } from "@/lib/db";
import { assertRateLimit } from "@/lib/rate-limit";
import { showConversationForUser, toUserRecord } from "@/lib/store";
import type { PublicContact } from "@/lib/types";
import { cleanNickname, cleanString, isUuid, validNickname } from "@/lib/validation";

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const rows = await read((db) => db.contact.findMany({
    where: { ownerId: authenticated.id },
    include: { user: true },
  }));
  const contacts = rows
    .map((contact): PublicContact => ({
      userId: contact.userId,
      user: publicUser(toUserRecord(contact.user)),
      createdAt: contact.createdAt,
      updatedAt: contact.updatedAt,
    }))
    .sort((a, b) => a.user.name.localeCompare(b.user.name, "ru"));
  return ok({ contacts });
});

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const body = await readJson(request);
  const identifier = cleanString(body.identifier);
  const suppliedUserId = cleanString(body.userId);
  const userId = suppliedUserId || (isUuid(identifier) ? identifier : "");
  const suppliedNickname = cleanNickname(body.nickname);
  const nickname = suppliedNickname || (userId ? "" : cleanNickname(identifier.replace(/^@/, "")));
  if (userId && !isUuid(userId)) {
    throw new ApiError(422, "invalid_user_id", "Укажите корректный UUID контакта");
  }
  if (!userId && !validNickname(nickname)) {
    throw new ApiError(422, "invalid_contact", "Укажите корректный UUID или ник контакта");
  }

  const contact = await write(async (tx) => {
    const target = await tx.user.findUnique({ where: userId ? { id: userId } : { nickname } });
    if (!target) throw new ApiError(404, "user_not_found", "Пользователь не найден");
    if (target.id === authenticated.id) {
      throw new ApiError(422, "self_contact", "Себя добавлять не нужно");
    }
    const now = new Date().toISOString();
    const item = await tx.contact.upsert({
      where: { ownerId_userId: { ownerId: authenticated.id, userId: target.id } },
      create: { ownerId: authenticated.id, userId: target.id, createdAt: now, updatedAt: now },
      update: { updatedAt: now },
    });
    await showConversationForUser(tx, authenticated.id, target.id);
    return {
      userId: item.userId,
      user: publicUser(toUserRecord(target)),
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    } satisfies PublicContact;
  });
  return ok({ contact }, { status: 201 });
});
