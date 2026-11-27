package main

import (
	"context"
	"net/url"
	"strings"
)

const browserDevice = "00000000-0000-4000-8000-000000000000"

var userPathRE = regexpMust(`^/api/users/[0-9a-f-]+$`)
var contactPathRE = regexpMust(`^/api/contacts/[0-9a-f-]+$`)
var groupPathRE = regexpMust(`^/api/groups/[0-9a-f-]+(?:/members)?$`)
var groupMessagePathRE = regexpMust(`^/api/group-messages/[0-9a-f-]+(?:/(?:reaction|status))?$`)
var messagePathRE = regexpMust(`^/api/messages/[0-9a-f-]+(?:/(?:reaction|answer))?$`)
var statusPathRE = regexpMust(`^/api/messages/[0-9a-f-]+/status$`)
var uploadPathRE = regexpMust(`^/api/attachments/uploads/[0-9a-f-]+(?:/complete)?$`)
var filePathRE = regexpMust(`^/api/attachments/[0-9a-f-]+/url$`)

func (sv *Service) route(ctx context.Context, user, body M, path, method string, headers map[string]string, query url.Values) (M, int) {
	parts := strings.Split(path, "/")
	last := parts[len(parts)-1]
	uid := s(user, "id")
	switch {
	case path == "/api/auth/session" && method == "POST" || path == "/api/me" && method == "GET":
		return M{"user": publicUser(user)}, 200
	case path == "/api/client/telemetry" && method == "POST":
		return sv.telemetry(ctx, user, body), 200
	case path == "/api/me" && method == "PATCH":
		return M{"user": publicUser(get(sv.updateProfile(ctx, user, body), "user"))}, 200
	case path == "/api/contacts" && method == "POST":
		return sv.contact(ctx, user, body, false), 201
	case contactPathRE.MatchString(path) && method == "DELETE":
		return sv.contact(ctx, user, M{"userId": last}, true), 200
	case path == "/api/contacts" && method == "GET":
		contacts := sv.transaction(ctx, true, func(tx Tx) any { return list(tx.Get("user-state", uid), "contacts") })
		return M{"contacts": contacts}, 200
	case (path == "/api/users" || userPathRE.MatchString(path)) && method == "GET":
		id, nick, search := query.Get("id"), query.Get("nickname"), strings.ToLower(query.Get("query"))
		if path != "/api/users" {
			id = last
		}
		values := a(sv.transaction(ctx, true, func(tx Tx) any {
			out := A{}
			for _, candidate := range tx.Scan("users", 1000) {
				if s(candidate, "id") == uid || id != "" && s(candidate, "id") != id || nick != "" && s(candidate, "nickname") != nick {
					continue
				}
				if search != "" && !strings.Contains(strings.ToLower(s(candidate, "id")), search) && !strings.Contains(strings.ToLower(s(candidate, "name")), search) && !strings.Contains(strings.ToLower(s(candidate, "nickname")), search) {
					continue
				}
				out = append(out, publicUser(candidate))
				if len(out) == 30 {
					break
				}
			}
			return out
		}))
		if id != "" || nick != "" {
			if len(values) == 0 {
				fail(404, "user_not_found", "Пользователь не найден")
			}
			return M{"user": values[0]}, 200
		}
		return M{"users": values}, 200
	case path == "/api/sync" && method == "POST":
		limit := 100
		if body["limit"] != nil {
			limit = pageSize(body["limit"])
		}
		return sv.snapshot(ctx, user, limit), 200
	case path == "/api/changes" && method == "POST":
		limit := 100
		if body["limit"] != nil {
			limit = pageSize(body["limit"])
		}
		return sv.changes(ctx, user, s(body, "cursor"), limit, body["extended"] == true), 200
	case path == "/api/mutations" && method == "POST":
		data := sv.mutate(ctx, user, body, "")
		status := 201
		if s(data, "status") == "pending" {
			status = 202
		} else if b(data, "replayed") {
			status = 200
		}
		return data, status
	case path == "/api/groups" && method == "POST":
		return sv.modifyGroup(ctx, user, headers["x-tm-request-id"], body, "create"), 201
	case groupPathRE.MatchString(path):
		id := parts[3]
		members := last == "members"
		if method == "GET" && !members {
			return M{"group": sv.rowsTransaction(ctx, true, func(r *Rows) any { return r.group(id, uid) })}, 200
		}
		action := ""
		if members && method == "POST" {
			action = "add"
		} else if members && method == "DELETE" {
			action = "remove"
		} else if !members && method == "PATCH" {
			action = "edit"
		} else if !members && method == "DELETE" {
			action = "leave"
		}
		if action != "" {
			return sv.modifyGroup(ctx, user, id, body, action), 200
		}
		fail(405, "method_not_allowed", "Метод не поддерживается")
	case path == "/api/group-messages" && method == "POST":
		return M{"message": sv.createMessage(ctx, user, body, true)}, 201
	case path == "/api/group-messages" && method == "GET":
		id := query.Get("groupId")
		limit := 100
		if query.Get("limit") != "" {
			limit = pageSize(query.Get("limit"))
		}
		out := sv.rowsTransaction(ctx, true, func(r *Rows) any {
			r.group(id, uid)
			messages := A{}
			indices := r.Views("@group:"+id, limit)
			for i := len(indices) - 1; i >= 0; i-- {
				index := indices[i]
				if b(index, "deleted") {
					continue
				}
				v, err := caught(func() any { return r.messageRecord(r.row("GroupMessage", s(index, "id")), uid, true, true) })
				if err != nil {
					he, ok := err.(*HTTPError)
					if !ok || he.Status != 404 && he.Status != 425 {
						panic(err)
					}
					continue
				}
				messages = append(messages, v)
			}
			return M{"messages": messages}
		})
		return m(out), 200
	case groupMessagePathRE.MatchString(path):
		id := parts[3]
		action := ""
		if len(parts) > 4 {
			action = parts[4]
		}
		if method == "GET" && action == "" {
			return m(sv.rowsTransaction(ctx, true, func(r *Rows) any {
				data := r.row("GroupMessage", id)
				return M{"message": r.messageRecord(data, uid, true, true), "group": r.group(s(data, "groupId"), uid)}
			})), 200
		}
		if action == "status" && method == "PATCH" {
			return sv.groupReceipt(ctx, user, id, s(body, "status")), 200
		}
		modify := ""
		if action == "reaction" && method == "PUT" {
			modify = "reaction"
		} else if action == "" && method == "PATCH" {
			modify = "edit"
		} else if action == "" && method == "DELETE" {
			modify = "delete"
		}
		if modify != "" {
			return sv.modifyMessage(ctx, user, id, body, modify, true, nil), 200
		}
		fail(405, "method_not_allowed", "Метод не поддерживается")
	case path == "/api/messages" && method == "POST":
		if str(or(body["kind"], "text")) == "text" && !truth(body["replyToId"]) && len(list(body, "attachmentIds")) == 0 {
			at := str(or(body["clientSentAt"], now()))
			id := str(or(body["clientRequestId"], uuid()))
			operation := M{"protocolVersion": 1, "operationId": id, "actorId": uid, "deviceId": browserDevice, "occurredAt": at, "type": "message.create", "message": M{"id": id, "fromUserId": uid, "toUserId": body["toUserId"], "kind": "text", "text": strings.TrimSpace(s(body, "text")), "sentAt": at}}
			sv.mutate(ctx, user, operation, "")
			return M{"message": sv.message(ctx, user, id)}, 201
		}
		return M{"message": sv.createMessage(ctx, user, body, false)}, 201
	case (path == "/api/messages" || path == "/api/group-messages") && method == "DELETE":
		ids := list(body, "ids")
		if !isArray(body["ids"]) || len(ids) == 0 || len(ids) > 100 {
			fail(422, "invalid_message_ids", "Некорректные ID сообщений")
		}
		for _, v := range ids {
			id := str(v)
			grouped := path == "/api/group-messages"
			rich := m(sv.rowsTransaction(ctx, true, func(r *Rows) any { return r.state("Message", id) }))
			if grouped || rich != nil {
				sv.modifyMessage(ctx, user, id, body, "delete", grouped, nil)
			} else {
				sv.mutate(ctx, user, M{"protocolVersion": 1, "operationId": uuid(), "actorId": uid, "deviceId": browserDevice, "occurredAt": now(), "type": "message.delete", "deletion": M{"messageId": v, "scope": body["scope"]}}, "")
			}
		}
		return M{"deletedIds": ids, "scope": body["scope"]}, 200
	case messagePathRE.MatchString(path) && method != "GET":
		id := parts[3]
		action := ""
		if len(parts) > 4 {
			action = parts[4]
		}
		if !(action == "answer" && method == "POST" || action == "reaction" && method == "PUT" || action == "" && contains([]string{"PATCH", "DELETE"}, method)) {
			fail(405, "method_not_allowed", "Метод не поддерживается")
		}
		modify := "edit"
		if action == "answer" {
			modify = "answer"
		} else if action == "reaction" {
			modify = "reaction"
		} else if method == "DELETE" {
			modify = "delete"
		}
		if rich := m(sv.rowsTransaction(ctx, true, func(r *Rows) any { return r.state("Message", id) })); rich != nil {
			return sv.modifyMessage(ctx, user, id, body, modify, false, nil), 200
		}
		message := sv.message(ctx, user, id)
		if action == "answer" {
			fail(403, "not_a_choice", "Нет права ответа")
		}
		operation := M{"protocolVersion": 1, "operationId": uuid(), "actorId": uid, "deviceId": browserDevice, "occurredAt": now()}
		if action == "reaction" {
			operation["type"] = "reaction.set"
			operation["reaction"] = M{"messageId": id, "userId": uid, "emoji": body["emoji"]}
		} else if method == "DELETE" {
			operation["type"] = "message.delete"
			operation["deletion"] = M{"messageId": id, "scope": body["scope"]}
		} else {
			operation["type"] = "message.edit"
			operation["message"] = M{"id": id, "fromUserId": message["fromUserId"], "toUserId": message["toUserId"], "kind": "text", "text": body["text"], "sentAt": message["sentAt"]}
		}
		sv.mutate(ctx, user, operation, "")
		if method == "DELETE" {
			return M{"deleted": true, "id": id, "scope": body["scope"]}, 200
		}
		if action == "reaction" {
			return M{"reactions": sv.message(ctx, user, id)["reactions"]}, 200
		}
		return M{"message": sv.message(ctx, user, id)}, 200
	case path == "/api/messages" && method == "GET":
		limit := 100
		if query.Get("limit") != "" {
			limit = pageSize(query.Get("limit"))
		}
		snapshot := sv.snapshot(ctx, user, limit)
		out := A{}
		for _, v := range list(snapshot, "messages") {
			message := m(v)
			if query.Has("contactId") && s(message, "fromUserId") != query.Get("contactId") && s(message, "toUserId") != query.Get("contactId") {
				continue
			}
			if query.Get("box") == "inbox" && s(message, "toUserId") != uid || query.Get("box") == "sent" && s(message, "fromUserId") != uid {
				continue
			}
			out = append(out, message)
		}
		return M{"messages": out}, 200
	case messagePathRE.MatchString(path) && len(parts) == 4 && method == "GET":
		return M{"message": sv.message(ctx, user, last)}, 200
	case statusPathRE.MatchString(path) && method == "PATCH":
		return M{"message": sv.receipt(ctx, user, parts[3], s(body, "status"))}, 200
	case path == "/api/push" && method == "GET":
		return M{"configured": false, "publicKey": "", "subscriptionCount": 0}, 200
	case path == "/api/attachments/config" && method == "GET":
		return M{"limits": fileSettings().limits()}, 200
	case path == "/api/attachments/uploads" && method == "POST":
		return sv.createFile(ctx, user, body), 201
	case uploadPathRE.MatchString(path):
		id := parts[4]
		if last == "complete" && method == "POST" {
			return sv.completeFile(ctx, user, id), 200
		}
		if last != "complete" && method == "DELETE" {
			return sv.cancelFile(ctx, user, id), 200
		}
		fail(405, "method_not_allowed", "Метод не поддерживается")
	case filePathRE.MatchString(path) && method == "GET":
		mode := query.Get("mode")
		if mode == "" {
			mode = "download"
		}
		if !contains([]string{"preview", "download", "thumbnail"}, mode) {
			fail(422, "invalid_attachment_mode", "Неизвестный режим файла")
		}
		return sv.fileLink(ctx, user, parts[3], mode != "download", mode == "thumbnail"), 200
	case path == "/api/groups" && method == "GET":
		return M{"groups": sv.snapshot(ctx, user, 1)["groups"]}, 200
	}
	fail(501, "channel_capability_unavailable", "Это действие пока доступно только через Канал 1")
	return nil, 501
}
