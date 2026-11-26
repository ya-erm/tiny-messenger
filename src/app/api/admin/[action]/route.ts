import {rootAdminRows} from "@/lib/admin/root-data";
import {ApiError, ok, route} from "@/lib/api";
import {authenticate} from "@/lib/auth";
import {read} from "@/lib/db";
import {identityStore} from "@/lib/replication/identity";
import {adminAllowed, adminDevices, adminUsers} from "@/lib/admin/protocol";
import {assertRateLimit} from "@/lib/rate-limit";
type Context = {params: Promise<{action: string}>};
export const GET = route<Context>(async (request, {params}) => {
  assertRateLimit(request);
  const user = await authenticate(request), {action} = await params;
  const admin = adminAllowed(user.id, process.env.TM_ADMIN_USER_IDS || "");
  if (action === "access") return ok({admin});
  if (!admin) throw new ApiError(403, "admin_required", "Доступ только для администратора");
  if (action === "users") return ok(await read(tx => adminUsers({...identityStore(tx),adminRows:()=>rootAdminRows(tx)})));
  if (action === "devices") {
    const userId = new URL(request.url).searchParams.get("userId");
    if (!userId || !/^[0-9a-f-]{36}$/.test(userId)) throw new ApiError(422, "invalid_user", "Некорректный UUID");
    return ok(await read(tx => adminDevices(identityStore(tx), userId)));
  }
  throw new ApiError(404, "not_found", "Не найдено");
});
