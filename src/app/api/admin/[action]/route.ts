import {adminTimeline,timelineUsers} from "@/lib/admin/timeline";
import {rootAdminRows} from "@/lib/admin/root-data";
import {ApiError, ok, route} from "@/lib/api";
import {authenticate} from "@/lib/auth";
import {read} from "@/lib/db";
import {identityStore} from "@/lib/replication/identity";
import {adminAllowed, adminDevices, adminUsers, adminOptions} from "@/lib/admin/protocol";
import {assertRateLimit} from "@/lib/rate-limit";
type Context = {params: Promise<{action: string}>};
export const GET = route<Context>(async (request, {params}) => {
  assertRateLimit(request);
  const user = await authenticate(request), {action} = await params;
  const admin = adminAllowed(user.id, process.env.TM_ADMIN_USER_IDS || "");
  if (action === "access") return ok({admin});
  if (!admin) throw new ApiError(403, "admin_required", "Доступ только для администратора");
  if (action === "users") {const options=adminOptions(new URL(request.url).searchParams);return ok(await read(tx => adminUsers({...identityStore(tx),adminRows:()=>rootAdminRows(tx)},options)));}
  if(action==="timeline"){const params=new URL(request.url).searchParams,ids=timelineUsers(params),options=adminOptions(params);if(!options.range)throw new ApiError(422,"missing_range","Выберите интервал");return ok(await read(tx=>adminTimeline(identityStore(tx),ids,options.range!)));}
  if (action === "devices") {
    const userId = new URL(request.url).searchParams.get("userId");
    if (!userId || !/^[0-9a-f-]{36}$/.test(userId)) throw new ApiError(422, "invalid_user", "Некорректный UUID");
    return ok(await read(tx => adminDevices(identityStore(tx), userId)));
  }
  throw new ApiError(404, "not_found", "Не найдено");
});
