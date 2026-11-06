import { ok, readJson, route } from "@/lib/api";
import { assertRateLimit } from "@/lib/rate-limit";
import { unlinkAccount } from "@/lib/tasks-integration";

export const POST = route(async request => {
  assertRateLimit(request);
  const body = await readJson(request);
  return ok(await unlinkAccount(body.assertion));
});
