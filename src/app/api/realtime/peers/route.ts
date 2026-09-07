import { ok, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { read } from "@/lib/db";
import { assertRateLimit } from "@/lib/rate-limit";
import { involving, visibleTo } from "@/lib/store";

export const GET = route(async (request) => {
  assertRateLimit(request, true);
  const authenticated = await authenticate(request);
  const userIds = await read(async (db) => {
    const [contacts, pairs] = await Promise.all([
      db.contact.findMany({ where: { ownerId: authenticated.id }, select: { userId: true } }),
      db.message.findMany({
        where: { ...involving(authenticated.id), ...visibleTo(authenticated.id) },
        select: { fromUserId: true, toUserId: true },
        distinct: ["fromUserId", "toUserId"],
      }),
    ]);
    const ids = new Set(contacts.map((contact) => contact.userId));
    for (const pair of pairs) {
      ids.add(pair.fromUserId === authenticated.id ? pair.toUserId : pair.fromUserId);
    }
    return [...ids].sort();
  });

  return ok({ userIds });
});
