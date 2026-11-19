import { createService, publicUser, HttpError } from "./service.mjs";
import { connectYdb } from "./store-ydb.mjs";

const mutationTypes = ["message.create", "message.edit", "message.delete", "reaction.set"];
const limits = { name: 20, nickname: 32, avatarUrl: 500, message: 16384, option: 8, optionId: 64,
  choiceOptionsMin: 2, choiceOptionsMax: 2, tokenMin: 8, tokenMax: 64, pageSize: 100, groupName: 40, groupMembersMax: 50 };
let servicePromise;
async function getService() {
  servicePromise ||= connectYdb(process.env.YDB_CONNECTION_STRING).then((database) => createService(database, process.env.TM_INSTALLATION_ID || "yandex-1"));
  try { return await servicePromise; } catch (error) { servicePromise = undefined; throw error; }
}
function parseBody(event) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "{}";
  if (Buffer.byteLength(raw) > 16384) throw new HttpError(413, "payload_too_large", "Запрос превышает 16 КиБ");
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, "invalid_json", "Ожидался JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_json", "Ожидался JSON-объект");
  return body;
}
const pageSize = (value) => Number.isInteger(Number(value)) ? Math.max(1, Math.min(100, Number(value))) : 100;

// Factory is used by the HTTP contract tests with the exact same service code.
export function createHandler(serviceProvider = getService, configuration = process.env) {
  return async (event, context = {}) => {
    const started = Date.now();
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const origin = headers.origin;
    const allowed = (configuration.TM_ALLOWED_ORIGINS || "https://tm.ya-erm.ru").split(",").map((item) => item.trim());
    const responseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-tm-installation-id": configuration.TM_INSTALLATION_ID || "yandex-1", vary: "Origin" };
    if (origin && allowed.includes(origin)) Object.assign(responseHeaders, { "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "Authorization,Content-Type,X-API-Key", "access-control-expose-headers": "X-TM-Installation-Id,Retry-After", "access-control-max-age": "600" });
    const response = (statusCode, value) => ({ statusCode, headers: responseHeaders, isBase64Encoded: false,
      body: statusCode === 204 ? "" : JSON.stringify(value) });
    let path = "/";
    try {
      if (origin && !allowed.includes(origin)) throw new HttpError(403, "origin_not_allowed", "Этот источник приложения не разрешён");
      const method = (event.httpMethod || event.requestContext?.http?.method || "GET").toUpperCase();
      if (method === "OPTIONS") return response(204);
      const url = new URL(event.url || event.path || "/", "https://prototype.invalid");
      path = url.pathname.replace(/\/$/, "") || "/";
      for (const [key, value] of Object.entries(event.queryStringParameters || {})) if (value !== undefined) url.searchParams.set(key, value);
      if (path === "/api/health" && method === "GET") return response(200, { ok: true, data: {
        status: "healthy", apiVersion: 1, installationId: configuration.TM_INSTALLATION_ID || "yandex-1", time: new Date().toISOString() } });
      if (path === "/api/transport" && method === "GET") return response(200, { ok: true, data: {
        installationId: configuration.TM_INSTALLATION_ID || "yandex-1", protocolVersion: 1, mutationTypes,
        capabilities: ["personal-text", "edits", "reactions", "deletions", "changes", "native-token"], voice: false, files: false, replication: false } });
      if (path === "/api/config" && method === "GET") return response(200, { ok: true, data: { apiVersion: 1, limits, suggestedNames: [] } });
      const service = await serviceProvider();
      const body = ["POST", "PATCH", "PUT", "DELETE"].includes(method) ? parseBody(event) : {};
      const token = path === "/api/auth/session" && method === "POST" ? String(body.token || "").trim()
        : String(headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || headers["x-api-key"] || "";
      const user = await service.authenticate(token);
      let data;
      let status = 200;
      if ((path === "/api/auth/session" && method === "POST") || (path === "/api/me" && method === "GET")) data = { user: publicUser(user) };
      else if (path === "/api/contacts" && method === "GET") data = { contacts: await service.contacts(user) };
      else if ((path === "/api/users" || /^\/api\/users\/[0-9a-f-]+$/.test(path)) && method === "GET") {
        const filters = Object.fromEntries(url.searchParams);
        if (path !== "/api/users") filters.id = path.split("/").at(-1);
        const users = await service.users(user, filters);
        if (filters.id || filters.nickname) {
          if (!users[0]) throw new HttpError(404, "user_not_found", "Пользователь не найден");
          data = { user: users[0] };
        } else data = { users };
      }
      else if (path === "/api/sync" && method === "POST") data = await service.snapshot(user, pageSize(body.limit ?? 100));
      else if (path === "/api/changes" && method === "POST") data = await service.changes(user, body.cursor, pageSize(body.limit ?? 100));
      else if (path === "/api/mutations" && method === "POST") {
        data = await service.mutate(user, body);
        status = data.status === "pending" ? 202 : data.replayed ? 200 : 201;
      } else if (path === "/api/messages" && method === "GET") {
        const snapshot = await service.snapshot(user, pageSize(url.searchParams.get("limit") || 100));
        data = { messages: snapshot.messages.filter((message) => (!url.searchParams.has("contactId")
          || [message.fromUserId, message.toUserId].includes(url.searchParams.get("contactId")))
          && (url.searchParams.get("box") !== "inbox" || message.toUserId === user.id)
          && (url.searchParams.get("box") !== "sent" || message.fromUserId === user.id)) };
      } else if (/^\/api\/messages\/[0-9a-f-]+$/.test(path) && method === "GET") data = { message: await service.message(user, path.split("/").at(-1)) };
      else if (/^\/api\/messages\/[0-9a-f-]+\/status$/.test(path) && method === "PATCH") data = { message: await service.receipt(user, path.split("/").at(-2), body.status) };
      else if (path === "/api/push" && method === "GET") data = { configured: false, publicKey: "", subscriptionCount: 0 };
      else if (path === "/api/attachments/config" && method === "GET") data = { limits: { enabled: false, maxFileBytes: 52428800, maxFilesPerMessage: 4, maxPending: 4, userQuotaBytes: 1073741824 } };
      else if (path === "/api/groups" && method === "GET") data = { groups: (await service.snapshot(user, 1)).groups };
      else throw new HttpError(501, "channel_capability_unavailable", "В этом контуре пока доступны личные текстовые сообщения; выберите VPS для остальных действий");
      return response(status, { ok: true, data });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 503;
      if (status === 503) console.error(JSON.stringify({ event: "cloud-api-error", requestId: context.requestId, path, name: error.name, code: error.code }));
      if (status === 503 || status === 429) responseHeaders["retry-after"] = "2";
      return response(status, { ok: false, error: { code: error instanceof HttpError ? error.code : "cloud_storage_unavailable",
        message: error instanceof HttpError ? error.message : "Облачное хранилище временно недоступно" } });
    } finally {
      if (configuration.TM_LOG_TIMING === "1") console.info(JSON.stringify({ event: "cloud-api-timing", path, durationMs: Date.now() - started }));
    }
  };
}
export const handler = createHandler();
