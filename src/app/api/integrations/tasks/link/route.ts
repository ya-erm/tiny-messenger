import { ok, readJson, route } from "@/lib/api";
import { authenticate } from "@/lib/auth";
import { assertRateLimit } from "@/lib/rate-limit";
import { approveConnection } from "@/lib/tasks-integration";

export const POST = route(async request => {
  assertRateLimit(request);
  const body = await readJson(request);
  const user = await authenticate(request);
  return ok(await approveConnection(body.state, user));
});
