import { randomUUID } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { read, write } from "@/lib/db";
import { publicGroup } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { groupInclude, memberOf, toGroupRecord } from "@/lib/store";
import { cleanString, isUuid, validLength } from "@/lib/validation";

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const rows = await read((db) => db.group.findMany({
    where: memberOf(authenticated.id),
    include: groupInclude,
    orderBy: { updatedAt: "desc" },
  }));
  return ok({ groups: rows.map((row) => publicGroup(toGroupRecord(row))) });
});

export const POST = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const body = await readJson(request);
  const name = cleanString(body.name);
  const rawMemberIds = Array.isArray(body.memberIds) ? body.memberIds : [];

  if (!validLength(name, 1, LIMITS.groupName)) {
    throw new ApiError(422, "invalid_name", `Название группы: от 1 до ${LIMITS.groupName} символов`);
  }
  if (rawMemberIds.some((id) => !isUuid(id))) {
    throw new ApiError(422, "invalid_member_id", "Все участники должны быть указаны корректным UUID");
  }
  const memberIds = [...new Set([authenticated.id, ...rawMemberIds as string[]])];
  if (memberIds.length < 2) {
    throw new ApiError(422, "invalid_members", "Добавьте хотя бы одного участника, кроме себя");
  }
  if (memberIds.length > LIMITS.groupMembersMax) {
    throw new ApiError(422, "too_many_members", `В группе не может быть больше ${LIMITS.groupMembersMax} участников`);
  }

  const group = await write(async (tx) => {
    const known = await tx.user.count({ where: { id: { in: memberIds } } });
    if (known !== memberIds.length) {
      throw new ApiError(404, "user_not_found", "Один или несколько участников не найдены");
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    await tx.group.create({
      data: { id, name, ownerId: authenticated.id, createdAt: now, updatedAt: now },
    });
    // One row at a time so `seq` follows the requested order (owner first).
    for (const userId of memberIds) {
      await tx.groupMember.create({ data: { groupId: id, userId } });
    }
    const row = await tx.group.findUniqueOrThrow({ where: { id }, include: groupInclude });
    return publicGroup(toGroupRecord(row));
  });
  return ok({ group }, { status: 201 });
});
