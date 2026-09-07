import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { isGroupMember, publicGroup } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore, updateStore } from "@/lib/store";
import { cleanString, isUuid, validAvatarBackground, validHttpUrl, validLength } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_group_id", "Некорректный UUID группы");
  const store = await readStore();
  const group = store.groups.find((candidate) => candidate.id === id);
  if (!group || !isGroupMember(group, authenticated.id)) {
    throw new ApiError(404, "group_not_found", "Группа не найдена");
  }
  return ok({ group: publicGroup(group, store.users) });
});

export const PATCH = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_group_id", "Некорректный UUID группы");
  const body = await readJson(request);
  const nameSupplied = Object.hasOwn(body, "name");
  const avatarUrlSupplied = Object.hasOwn(body, "avatarUrl");
  const avatarBackgroundSupplied = Object.hasOwn(body, "avatarBackground");
  const name = nameSupplied ? cleanString(body.name) : undefined;
  const avatarUrl = avatarUrlSupplied ? cleanString(body.avatarUrl) : undefined;
  const avatarBackground = avatarBackgroundSupplied ? cleanString(body.avatarBackground) : undefined;

  if (name !== undefined && !validLength(name, 1, LIMITS.groupName)) {
    throw new ApiError(422, "invalid_name", `Название группы: от 1 до ${LIMITS.groupName} символов`);
  }
  if (avatarUrl && (!validLength(avatarUrl, 1, LIMITS.avatarUrl) || !validHttpUrl(avatarUrl))) {
    throw new ApiError(422, "invalid_avatar_url", "Адрес аватарки должен быть корректным HTTP(S)-URL");
  }
  if (avatarBackground && !validAvatarBackground(avatarBackground)) {
    throw new ApiError(422, "invalid_avatar_background", "Фон аватарки должен быть цветом в формате #RRGGBB");
  }

  const group = await updateStore((store) => {
    const item = store.groups.find((candidate) => candidate.id === id);
    if (!item || !isGroupMember(item, authenticated.id)) {
      throw new ApiError(404, "group_not_found", "Группа не найдена");
    }
    if (item.ownerId !== authenticated.id) {
      throw new ApiError(403, "not_group_owner", "Изменять группу может только её владелец");
    }
    if (name !== undefined) item.name = name;
    if (avatarUrlSupplied) item.avatarUrl = avatarUrl || undefined;
    if (avatarBackgroundSupplied) item.avatarBackground = avatarBackground || undefined;
    item.updatedAt = new Date().toISOString();
    return publicGroup(item, store.users);
  });
  return ok({ group });
});

export const DELETE = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_group_id", "Некорректный UUID группы");

  const result = await updateStore((store) => {
    const group = store.groups.find((candidate) => candidate.id === id);
    if (!group || !isGroupMember(group, authenticated.id)) {
      throw new ApiError(404, "group_not_found", "Группа не найдена");
    }
    group.memberIds = group.memberIds.filter((memberId) => memberId !== authenticated.id);
    if (group.memberIds.length === 0) {
      store.groups = store.groups.filter((candidate) => candidate.id !== id);
      store.groupMessages = store.groupMessages.filter((message) => message.groupId !== id);
      return { deleted: true };
    }
    if (group.ownerId === authenticated.id) {
      group.ownerId = group.memberIds[0];
    }
    group.updatedAt = new Date().toISOString();
    return { deleted: false };
  });

  return ok({ left: true, ...result });
});
