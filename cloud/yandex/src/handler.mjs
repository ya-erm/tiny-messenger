import {adminAllowed,adminUsers,adminDevices} from "../shared/admin-protocol.mjs";
import {yandexAvailable,makeYandexFlow,exchangeYandexCode} from "../shared/yandex-protocol.mjs";
import {externalStatus,finishYandex} from "../shared/yandex-service.mjs";
import {appendReplication} from "./replication.mjs";
import { consumeQueueEvent, consumeCloudFrames, flushCloudBus } from "./bus.mjs";
import { randomUUID } from "node:crypto";
import { createFileService } from "./row-files.mjs";
import { createService, publicUser, HttpError } from "./service.mjs";
import { authorizePeer, createReplication } from "./replication.mjs";
import { REPLICATION_MAX_BYTES } from "../shared/replication.mjs";
import { connectYdb } from "./store-ydb.mjs";

const mutationTypes = ["message.create", "message.edit", "message.delete", "reaction.set"];
const limits = { name: 20, nickname: 32, avatarUrl: 500, message: 16384, option: 8, optionId: 64,
  choiceOptionsMin: 2, choiceOptionsMax: 2, tokenMin: 8, tokenMax: 64, pageSize: 100, groupName: 40, groupMembersMax: 50 };
let servicePromise;
async function getService() {
  servicePromise ||= connectYdb(process.env.YDB_CONNECTION_STRING).then((database) => {
    const service = createService(database, process.env.TM_INSTALLATION_ID || "yandex-1");
    service.exchange = createReplication(database, service, process.env);
    service.files = createFileService(service.rows);
    return service;
  });
  try { return await servicePromise; } catch (error) { servicePromise = undefined; throw error; }
}
function parseBody(event, maxBytes = 16384) {
  const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : event.body || "{}";
  if (Buffer.byteLength(raw) > maxBytes) throw new HttpError(413, "payload_too_large", "Запрос превышает 16 КиБ");
  let body;
  try { body = JSON.parse(raw); } catch { throw new HttpError(400, "invalid_json", "Ожидался JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "invalid_json", "Ожидался JSON-объект");
  return body;
}
const pageSize = (value) => Number.isInteger(Number(value)) ? Math.max(1, Math.min(100, Number(value))) : 100;

// Factory is used by the HTTP contract tests with the exact same service code.
export function createHandler(serviceProvider = getService, configuration = process.env) {
  return async (event, context = {}) => {
    if (Array.isArray(event.messages) && !event.httpMethod) return consumeQueueEvent(event,await serviceProvider(),configuration);
    const started = Date.now();
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value]));
    const origin = headers.origin;
    const allowed = (configuration.TM_ALLOWED_ORIGINS || "").split(",").map((item) => item.trim());
    const responseHeaders = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
      "x-tm-installation-id": configuration.TM_INSTALLATION_ID || "yandex-1", vary: "Origin" };
    if (origin && allowed.includes(origin)) Object.assign(responseHeaders, { "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
      "access-control-allow-headers": "Authorization,Content-Type,X-API-Key,X-TM-Request-Id", "access-control-expose-headers": "X-TM-Installation-Id,Retry-After", "access-control-max-age": "600" });
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
        installationId: configuration.TM_INSTALLATION_ID || "yandex-1", protocolVersion: 1, rowReplicationVersion: 1, mutationTypes,
        capabilities: ["personal-text", "edits", "reactions", "deletions", "changes", "native-token", "groups", "quotes", "choices", "attachments", "registration", "contacts-write", "profile-write", "token-rotation", "device-telemetry", "yandex-login", "image-thumbnails"], voice: false, files: true, replication: Boolean(configuration.TM_REPLICATION_SECRET) } });
      if (path === "/api/config" && method === "GET") return response(200, { ok: true, data: { apiVersion: 1, limits, suggestedNames: [] } });
      if (path === "/api/internal/replication/events" && method === "POST") {
        authorizePeer(headers,configuration);
        const frame=parseBody(event,256*1024);
        return response(200,{ok:true,data:await consumeCloudFrames(await serviceProvider(),[frame],configuration)});
      }
      if (path === "/api/internal/replication/exchange" && method === "POST") {
        authorizePeer(headers, configuration);
        const body = parseBody(event, REPLICATION_MAX_BYTES);
        const service = await serviceProvider();
        return response(200, { ok: true, data: await service.exchange(body) });
      }
      const service = await serviceProvider();
      const body = ["POST", "PATCH", "PUT", "DELETE"].includes(method) ? parseBody(event) : {};
      if(path==="/api/auth/register"&&method==="POST"){
        const data=await service.registration.register(body,event.requestContext?.identity?.sourceIp||event.requestContext?.http?.sourceIp||"unknown");
        try{await flushCloudBus(service,configuration);}catch{console.warn(JSON.stringify({event:"cloud-bus",status:"publish_failed"}));}
        return response(data.replayed?200:201,{ok:true,data});
      }
      const token = path === "/api/auth/session" && method === "POST" ? String(body.token || "").trim()
        : String(headers.authorization || "").replace(/^Bearer\s+/i, "").trim() || headers["x-api-key"] || "";
      if(path.startsWith("/api/auth/yandex/")){
       const action=path.split("/").at(-1),config=service.yandexConfig;let data;
       if(action==="config"&&method==="GET")data={enabled:yandexAvailable(config)};
       else if(action==="start"&&method==="POST"){if(origin&&origin!==body.origin)throw new HttpError(403,"invalid_origin","Источник входа не совпадает");const actor=body.mode==="link"?await service.authenticate(token):undefined;data=makeYandexFlow(config,body,actor);}
       else if(action==="exchange"&&method==="POST")data=await exchangeYandexCode(config,body);
       else if(action==="finish"&&method==="POST"){const actor=token?await service.authenticate(token):undefined;data=await service.database.transaction(tx=>finishYandex(config,tx,body,actor,operation=>appendReplication(tx,"external:"+operation.id,{type:"external",operation})));if(data.user)data={...data,user:publicUser(data.user)};}
       else if(action==="link"&&method==="GET"){const actor=await service.authenticate(token);data=await service.database.transaction(tx=>externalStatus(tx,actor.id),{readOnly:true});}
       else throw new HttpError(404,"not_found","Не найдено");
       if(action==="finish")try{await flushCloudBus(service,configuration);}catch{console.warn(JSON.stringify({event:"cloud-bus",status:"publish_failed"}));}
       return response(200,{ok:true,data});
      }
      if(path==="/api/me/token"&&method==="POST"){const data=await service.identity.token(token,body);try{await flushCloudBus(service,configuration);}catch{console.warn(JSON.stringify({event:"cloud-bus",status:"publish_failed"}));}return response(200,{ok:true,data});}
      const user = await service.authenticate(token);
      if(path.startsWith("/api/admin/")&&method==="GET"){
        const admin=adminAllowed(user.id,configuration.TM_ADMIN_USER_IDS||""),action=path.split("/").at(-1);
        if(action==="access")return response(200,{ok:true,data:{admin}});
        if(!admin)throw new HttpError(403,"admin_required","Доступ только для администратора");
        if(action==="devices"&&!/^[0-9a-f-]{36}$/.test(url.searchParams.get("userId")||""))throw new HttpError(422,"invalid_user","Некорректный UUID");
        if(!["users","devices"].includes(action))throw new HttpError(404,"not_found","Не найдено");
        const data=await service.database.transaction(tx=>action==="users"?adminUsers(tx):adminDevices(tx,url.searchParams.get("userId")),{readOnly:true});
        return response(200,{ok:true,data});
      }
      let data;
      let status = 200;
      if ((path === "/api/auth/session" && method === "POST") || (path === "/api/me" && method === "GET")) data = { user: publicUser(user) };
      else if(path==="/api/client/telemetry"&&method==="POST")data=await service.telemetry(user,body);
      else if(path==="/api/me"&&method==="PATCH"){const updated=await service.identity.profile(user,body);data={user:publicUser(updated.user)};}
      else if(path==="/api/contacts"&&method==="POST"){data=await service.registration.contact(user,body);status=201;}
      else if(/^\/api\/contacts\/[0-9a-f-]+$/.test(path)&&method==="DELETE")data=await service.registration.contact(user,{userId:path.split("/").at(-1)},true);
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
      else if (path === "/api/changes" && method === "POST") data = await service.changes(user, body.cursor, pageSize(body.limit ?? 100), body.extended === true);
      else if (path === "/api/mutations" && method === "POST") {
        data = await service.mutate(user, body);
        status = data.status === "pending" ? 202 : data.replayed ? 200 : 201;
      } else if (path === "/api/groups" && method === "POST") {
        data = await service.rows.modifyGroup(user, headers["x-tm-request-id"], body, "create"); status = 201;
      } else if (/^\/api\/groups\/[0-9a-f-]+(?:\/members)?$/.test(path)) {
        const id = path.split("/")[3], memberAction = path.endsWith("/members");
        if (method === "GET" && !memberAction) data = { group: await service.rows.database.transaction((tx) => service.rows.group(tx, id, user.id), { readOnly: true }) };
        else if (memberAction && ["POST", "DELETE"].includes(method) || !memberAction && ["PATCH", "DELETE"].includes(method))
          data = await service.rows.modifyGroup(user, id, body, memberAction ? method === "POST" ? "add" : "remove" : method === "PATCH" ? "edit" : "leave");
        else throw new HttpError(405, "method_not_allowed", "Метод не поддерживается");
      } else if (path === "/api/group-messages" && method === "POST") {
        data = { message: await service.rows.createMessage(user, body, true) }; status = 201;
      } else if (path === "/api/group-messages" && method === "GET") {
        const groupId = url.searchParams.get("groupId");
        data = await service.rows.database.transaction(async (tx) => {
          await service.rows.group(tx, groupId, user.id);
          const messages = [];
          for (const index of (await tx.views("@group:" + groupId, pageSize(url.searchParams.get("limit") || 100))).filter((item) => !item.deleted).reverse()) {
            try { messages.push(await service.rows.messageRecord(tx, await service.rows.row(tx, "GroupMessage", [index.id]), user.id, true)); }
            catch (error) { if (!(error instanceof HttpError) || ![404, 425].includes(error.status)) throw error; }
          }
          return { messages };
        }, { readOnly: true });
      } else if (/^\/api\/group-messages\/[0-9a-f-]+(?:\/(?:reaction|status))?$/.test(path)) {
        const id = path.split("/")[3], action = path.split("/")[4];
        if (method === "GET" && !action) data = { message: await service.rows.getMessage(user.id, id, true),
          group: await service.rows.database.transaction(async (tx) => service.rows.group(tx, (await service.rows.row(tx, "GroupMessage", [id])).groupId, user.id), { readOnly: true }) };
        else if (action === "status" && method === "PATCH") data = await service.rows.groupReceipt(user, id, body.status);
        else if (action === "reaction" && method === "PUT" || !action && ["PATCH", "DELETE"].includes(method))
          data = await service.rows.modifyMessage(user, id, body, action === "reaction" ? "reaction" : method === "PATCH" ? "edit" : "delete", true);
        else throw new HttpError(405, "method_not_allowed", "Метод не поддерживается");
      } else if (path === "/api/messages" && method === "POST") {
        if ((body.kind || "text") === "text" && !body.replyToId && !body.attachmentIds?.length) {
          const at = body.clientSentAt || new Date().toISOString(), id = body.clientRequestId || randomUUID();
          const operation = { protocolVersion: 1, operationId: id, actorId: user.id, deviceId: "00000000-0000-4000-8000-000000000000", occurredAt: at,
            type: "message.create", message: { id, fromUserId: user.id, toUserId: body.toUserId, kind: "text", text: String(body.text || "").trim(), sentAt: at } };
          await service.mutate(user, operation); data = { message: await service.message(user, id) };
        } else data = { message: await service.rows.createMessage(user, body) };
        status = 201;
      } else if ((path === "/api/messages" || path === "/api/group-messages") && method === "DELETE") {
        if (!Array.isArray(body.ids) || !body.ids.length || body.ids.length > 100) throw new HttpError(422, "invalid_message_ids", "Некорректные ID сообщений");
        for (const id of body.ids) {
          if (path === "/api/group-messages") await service.rows.modifyMessage(user, id, body, "delete", true);
          else if (await service.rows.database.transaction((tx) => service.rows.state(tx, "Message", [id]), { readOnly: true })) await service.rows.modifyMessage(user, id, body, "delete");
          else await service.mutate(user, { protocolVersion: 1, operationId: randomUUID(), actorId: user.id, deviceId: "00000000-0000-4000-8000-000000000000", occurredAt: new Date().toISOString(), type: "message.delete", deletion: { messageId: id, scope: body.scope } });
        }
        data = { deletedIds: body.ids, scope: body.scope };
      } else if (/^\/api\/messages\/[0-9a-f-]+(?:\/(?:reaction|answer))?$/.test(path) && !["GET"].includes(method)) {
        const id = path.split("/")[3], action = path.split("/")[4];
        if (!(action === "answer" && method === "POST" || action === "reaction" && method === "PUT" || !action && ["PATCH", "DELETE"].includes(method))) throw new HttpError(405, "method_not_allowed", "Метод не поддерживается");
        const rich = await service.rows.database.transaction((tx) => service.rows.state(tx, "Message", [id]), { readOnly: true });
        if (rich) data = await service.rows.modifyMessage(user, id, body, action === "answer" ? "answer" : action === "reaction" ? "reaction" : method === "PATCH" ? "edit" : "delete");
        else {
          const message = await service.message(user, id);
          const base = { protocolVersion: 1, operationId: randomUUID(), actorId: user.id, deviceId: "00000000-0000-4000-8000-000000000000", occurredAt: new Date().toISOString() };
          if (action === "answer") throw new HttpError(403, "not_a_choice", "Нет права ответа");
          const operation = action === "reaction" ? { ...base, type: "reaction.set", reaction: { messageId: id, userId: user.id, emoji: body.emoji } }
            : method === "DELETE" ? { ...base, type: "message.delete", deletion: { messageId: id, scope: body.scope } }
            : { ...base, type: "message.edit", message: { id, fromUserId: message.fromUserId, toUserId: message.toUserId, kind: "text", text: body.text, sentAt: message.sentAt } };
          await service.mutate(user, operation);
          data = method === "DELETE" ? { deleted: true, id, scope: body.scope }
            : action === "reaction" ? { reactions: (await service.message(user, id)).reactions } : { message: await service.message(user, id) };
        }
      } else if (path === "/api/messages" && method === "GET") {
        const snapshot = await service.snapshot(user, pageSize(url.searchParams.get("limit") || 100));
        data = { messages: snapshot.messages.filter((message) => (!url.searchParams.has("contactId")
          || [message.fromUserId, message.toUserId].includes(url.searchParams.get("contactId")))
          && (url.searchParams.get("box") !== "inbox" || message.toUserId === user.id)
          && (url.searchParams.get("box") !== "sent" || message.fromUserId === user.id)) };
      } else if (/^\/api\/messages\/[0-9a-f-]+$/.test(path) && method === "GET") data = { message: await service.message(user, path.split("/").at(-1)) };
      else if (/^\/api\/messages\/[0-9a-f-]+\/status$/.test(path) && method === "PATCH") data = { message: await service.receipt(user, path.split("/").at(-2), body.status) };
      else if (path === "/api/push" && method === "GET") data = { configured: false, publicKey: "", subscriptionCount: 0 };
      else if (path === "/api/attachments/config" && method === "GET") data = { limits: service.files.limits() };
      else if (path === "/api/attachments/uploads" && method === "POST") { data = await service.files.create(user, body); status = 201; }
      else if (/^\/api\/attachments\/uploads\/[0-9a-f-]+(?:\/complete)?$/.test(path)) {
        const id = path.split("/")[4];
        if (path.endsWith("/complete") && method === "POST") data = await service.files.complete(user, id);
        else if (!path.endsWith("/complete") && method === "DELETE") data = await service.files.cancel(user, id);
        else throw new HttpError(405, "method_not_allowed", "Метод не поддерживается");
      } else if (/^\/api\/attachments\/[0-9a-f-]+\/url$/.test(path) && method === "GET") {
        const mode=url.searchParams.get("mode")||"download";if(!["preview","download","thumbnail"].includes(mode))throw new HttpError(422,"invalid_attachment_mode","Неизвестный режим файла");
        data=await service.files.link(user,path.split("/")[3],mode!=="download",mode==="thumbnail");
      }
      else if (path === "/api/groups" && method === "GET") data = { groups: (await service.snapshot(user, 1)).groups };
      else throw new HttpError(501, "channel_capability_unavailable", "Это действие пока доступно только через Канал 1");
      if (["POST","PATCH","PUT","DELETE"].includes(method) && !["/api/sync","/api/changes","/api/auth/session"].includes(path)) {
        try { await flushCloudBus(service,configuration); }
        catch { console.warn(JSON.stringify({event:"cloud-bus",status:"publish_failed"})); }
      }
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
