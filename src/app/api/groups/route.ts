import { randomUUID } from "node:crypto";
import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { LIMITS } from "@/lib/constants";
import { isGroupMember, publicGroup } from "@/lib/domain";
import { assertRateLimit } from "@/lib/rate-limit";
import { readStore, updateStore } from "@/lib/store";
import type { GroupRecord } from "@/lib/types";
import { cleanString, isUuid, validLength } from "@/lib/validation";

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const store = await readStore();
  const groups = store.groups
    .filter((group) => isGroupMember(group, authenticated.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((group) => publicGroup(group, store.users));
  return ok({ groups });
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

  const group = await updateStore((store) => {
    const missing = memberIds.filter((id) => !store.users.some((user) => user.id === id));
    if (missing.length > 0) {
      throw new ApiError(404, "user_not_found", "Один или несколько участников не найдены");
    }
    const now = new Date().toISOString();
    const item: GroupRecord = {
      id: randomUUID(),
      name,
      ownerId: authenticated.id,
      memberIds,
      createdAt: now,
      updatedAt: now,
    };
    store.groups.push(item);
    return publicGroup(item, store.users);
  });
  return ok({ group }, { status: 201 });
});
