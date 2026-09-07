import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { read, write } from "@/lib/db";
import { publicGroup } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { findGroupForMember, groupInclude, toGroupRecord } from "@/lib/store";
import { cleanString, isUuid, validAvatarBackground, validHttpUrl, validLength } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export const GET = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_group_id", "Некорректный UUID группы");
  const group = await read((db) => findGroupForMember(db, id, authenticated.id));
  if (!group) throw new ApiError(404, "group_not_found", "Группа не найдена");
  return ok({ group: publicGroup(group) });
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

  const group = await write(async (tx) => {
    const item = await findGroupForMember(tx, id, authenticated.id);
    if (!item) throw new ApiError(404, "group_not_found", "Группа не найдена");
    if (item.ownerId !== authenticated.id) {
      throw new ApiError(403, "not_group_owner", "Изменять группу может только её владелец");
    }
    const row = await tx.group.update({
      where: { id },
      data: {
        ...(name !== undefined ? { name } : {}),
        ...(avatarUrlSupplied ? { avatarUrl: avatarUrl || null } : {}),
        ...(avatarBackgroundSupplied ? { avatarBackground: avatarBackground || null } : {}),
        updatedAt: new Date().toISOString(),
      },
      include: groupInclude,
    });
    return publicGroup(toGroupRecord(row));
  });
  return ok({ group });
});

export const DELETE = route<Context>(async (request, { params }) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const { id } = await params;
  if (!isUuid(id)) throw new ApiError(400, "invalid_group_id", "Некорректный UUID группы");

  const result = await write(async (tx) => {
    const group = await findGroupForMember(tx, id, authenticated.id);
    if (!group) throw new ApiError(404, "group_not_found", "Группа не найдена");
    await tx.groupMember.deleteMany({ where: { groupId: id, userId: authenticated.id } });
    const remaining = group.memberIds.filter((memberId) => memberId !== authenticated.id);
    if (remaining.length === 0) {
      // Members and messages go with the group (cascade).
      await tx.group.delete({ where: { id } });
      return { deleted: true };
    }
    await tx.group.update({
      where: { id },
      data: {
        ...(group.ownerId === authenticated.id ? { ownerId: remaining[0] } : {}),
        updatedAt: new Date().toISOString(),
      },
    });
    return { deleted: false };
  });

  return ok({ left: true, ...result });
});
