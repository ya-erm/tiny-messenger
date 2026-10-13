import { ApiError, ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { write } from "@/lib/db";
import { assertRateLimit } from "@/lib/rate-limit";
import { isReactionEmoji } from "@/lib/reactions";
import { involving, memberOf, visibleTo } from "@/lib/store";
import { isUuid } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export function messageReactionHandler(kind: "direct" | "group") {
  return route<Context>(async (request, { params }) => {
    assertRateLimit(request, true);
    const user = await authenticate(request);
    const { id } = await params;
    if (!isUuid(id)) throw new ApiError(400, "invalid_message_id", "Некорректный UUID сообщения");
    const { emoji } = await readJson(request);
    if (emoji !== null && !isReactionEmoji(emoji)) {
      throw new ApiError(422, "invalid_reaction", "Передайте один эмодзи или null, чтобы снять реакцию");
    }

    const reactions = await write(async (tx) => {
      const found = kind === "direct"
        ? await tx.message.findFirst({
          where: { id, ...involving(user.id), ...visibleTo(user.id) },
          select: { id: true },
        })
        : await tx.groupMessage.findFirst({
          where: { id, group: memberOf(user.id), ...visibleTo(user.id) },
          select: { id: true },
        });
      if (!found) throw new ApiError(404, "message_not_found", "Сообщение не найдено");

      const key = { messageId: id, userId: user.id };
      if (kind === "direct") {
        if (emoji === null) {
          await tx.messageReaction.deleteMany({ where: key });
        } else {
          await tx.messageReaction.upsert({
            where: { messageId_userId: key }, create: { ...key, emoji }, update: { emoji },
          });
        }
        return tx.messageReaction.findMany({
          where: { messageId: id }, select: { userId: true, emoji: true }, orderBy: { userId: "asc" },
        });
      }
      if (emoji === null) {
        await tx.groupMessageReaction.deleteMany({ where: key });
      } else {
        await tx.groupMessageReaction.upsert({
          where: { messageId_userId: key }, create: { ...key, emoji }, update: { emoji },
        });
      }
      return tx.groupMessageReaction.findMany({
        where: { messageId: id }, select: { userId: true, emoji: true }, orderBy: { userId: "asc" },
      });
    });
    return ok({ reactions });
  });
}
