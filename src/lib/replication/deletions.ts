import "server-only";
import { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
// Tombstones are authoritative even if a browser has only cached the other
// contour. Absence from a truncated message page is not enough to infer this.
export async function deletionIdsForUser(db: Db, userId: string) {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT DISTINCT d.entityId AS id FROM MutationOperation d
    JOIN MutationOperation c ON c.entityId = d.entityId AND c.type = 'message.create'
    WHERE d.type = 'message.delete' AND d.status IN ('applied', 'superseded') AND c.status != 'rejected'
      AND (json_extract(c.body, '$.message.fromUserId') = ${userId} OR json_extract(c.body, '$.message.toUserId') = ${userId})
      AND (json_extract(d.body, '$.deletion.scope') = 'everyone' OR d.actorId = ${userId})
  `);
  return rows.map((row) => row.id);
}
