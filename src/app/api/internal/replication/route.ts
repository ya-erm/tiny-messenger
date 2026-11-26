import { timingSafeEqual } from "node:crypto";
import { ApiError, ok, route } from "@/lib/api";
import { publishLocalBus } from "@/lib/replication/bus";
import { synchronizeInstallations } from "@/lib/replication/synchronize";
export const POST = route(async (request) => {
  const expected = Buffer.from(process.env.MESSENGER_INTERNAL_TOKEN || "");
  const actual = Buffer.from(request.headers.get("x-messenger-internal-token") || "");
  if (!expected.length || expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new ApiError(401, "unauthorized", "Недоступно");
  const sync=await synchronizeInstallations();
  const bus=await publishLocalBus();
  return ok({ ...sync as object, bus });
});
