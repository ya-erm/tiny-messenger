import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate, publicUser } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore, updateStore } from "@/lib/store";
import type { PublicContact } from "@/lib/types";
import { cleanNickname, cleanString, isUuid, validNickname } from "@/lib/validation";

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const store = await readStore();
  const contacts = store.contacts
    .filter((contact) => contact.ownerId === authenticated.id)
    .flatMap((contact): PublicContact[] => {
      const user = store.users.find((candidate) => candidate.id === contact.userId);
      return user ? [{ ...contact, user: publicUser(user) }] : [];
    })
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

  const contact = await updateStore((store) => {
    const target = store.users.find((user) => userId ? user.id === userId : user.nickname === nickname);
    if (!target) throw new ApiError(404, "user_not_found", "Пользователь не найден");
    if (target.id === authenticated.id) {
      throw new ApiError(422, "self_contact", "Себя добавлять не нужно");
    }
    const existing = store.contacts.find(
      (item) => item.ownerId === authenticated.id && item.userId === target.id,
    );
    const now = new Date().toISOString();
    if (existing) {
      existing.updatedAt = now;
      return { ...existing, user: publicUser(target) };
    }
    const item = { ownerId: authenticated.id, userId: target.id, createdAt: now, updatedAt: now };
    store.contacts.push(item);
    return { ...item, user: publicUser(target) };
  });
  return ok({ contact }, { status: 201 });
});
