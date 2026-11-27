package main

import (
	"context"
	"sort"
	"strings"
)

var optionIDRE = regexpMust(`^[A-Za-z0-9._~-]{1,64}$`)

func (sv *Service) createMessage(ctx context.Context, actor, body M, grouped bool) M {
	table := messageTable(grouped)
	text := strings.TrimSpace(s(body, "text"))
	kind := str(or(body["kind"], "text"))
	recipient := s(body, "toUserId")
	if grouped {
		kind = "text"
		recipient = s(body, "groupId")
	}
	files := list(body, "attachmentIds")
	if !validUUID(recipient) || !contains([]string{"text", "choice"}, kind) || truth(body["attachmentIds"]) && !isArray(body["attachmentIds"]) || len(files) > 4 || text == "" && len(files) == 0 || utf16len(text) > 16384 || truth(body["replyToId"]) && !validUUID(body["replyToId"]) {
		fail(422, "invalid_message", "Некорректное сообщение")
	}
	for _, id := range files {
		if !validUUID(id) {
			fail(422, "invalid_message", "Некорректное сообщение")
		}
	}
	var options A
	if kind == "choice" {
		options = list(body, "options")
		if len(options) != 2 {
			fail(422, "invalid_options", "Нужны варианты ответа")
		}
		seen := map[string]bool{}
		for _, v := range options {
			item := m(v)
			if !optionIDRE.MatchString(s(item, "id")) || strings.TrimSpace(s(item, "label")) == "" || runeCount(s(item, "label")) > 8 || seen[s(item, "id")] {
				fail(422, "invalid_options", "Некорректные варианты ответа")
			}
			seen[s(item, "id")] = true
		}
	}
	request := s(body, "clientRequestId")
	if truth(body["clientRequestId"]) && !validUUID(body["clientRequestId"]) {
		fail(422, "invalid_request_id", "Некорректный ID отправки")
	}
	sortedFiles := stringsOf(files)
	sort.Strings(sortedFiles)
	hashInput := O{{"recipient", recipient}, {"text", text}, {"kind", kind}, {"files", sortedFiles}}
	if kind == "choice" {
		hashInput = append(hashInput, Pair{"options", options})
	}
	if own(body, "replyToId") {
		hashInput = append(hashInput, Pair{"replyToId", body["replyToId"]})
	}
	requestHash := sha(encode(hashInput))
	return m(sv.rowsTransaction(ctx, false, func(r *Rows) any {
		if grouped {
			r.group(recipient, s(actor, "id"))
		} else if r.Get("users", recipient) == nil {
			fail(404, "recipient_not_found", "Получатель не найден")
		}
		if request != "" {
			if index := r.Get("requests:"+table+":"+s(actor, "id"), request); index != nil {
				original := r.row(table, s(index, "id"))
				if original == nil || s(original, "requestHash") != requestHash {
					fail(409, "message_request_conflict", "Идентификатор уже использован")
				}
				return r.messageRecord(original, s(actor, "id"), grouped, true)
			}
		}
		reply := s(body, "replyToId")
		if reply != "" {
			original := r.row(table, reply)
			if original == nil && !grouped {
				original = creationMessage(r.Get("states", reply))
				if original != nil && !visible(r.View(s(actor, "id"), s(original, "sentAt"), s(original, "id"))) {
					original = nil
				}
			}
			valid := original != nil
			if grouped {
				valid = valid && s(original, "groupId") == recipient
			} else {
				valid = valid && (s(original, "fromUserId") == s(actor, "id") || s(original, "toUserId") == s(actor, "id")) && (s(original, "fromUserId") == recipient || s(original, "toUserId") == recipient)
			}
			if !valid || r.row(table+"Deletion", reply, s(actor, "id")) != nil {
				fail(404, "reply_not_found", "Сообщение для ответа недоступно")
			}
		}
		attachments := []M{}
		chatKind := "peer"
		if grouped {
			chatKind = "group"
		}
		for _, v := range files {
			item := r.file(str(v))
			if item == nil || s(item, "uploaderId") != s(actor, "id") || s(item, "chatKind") != chatKind || s(item, "chatId") != recipient || s(item, "status") != "uploaded" || truth(item["messageId"]) || truth(item["groupMessageId"]) || s(item, "abandonAt") <= now() {
				fail(409, "attachment_not_ready", "Файл ещё не готов или относится к другому чату")
			}
			attachments = append(attachments, item)
		}
		if own(body, "clientSentAt") && !validUTC(body["clientSentAt"]) {
			fail(422, "invalid_timestamp", "Некорректное время отправки")
		}
		id := request
		if id == "" {
			id = uuid()
		}
		at := s(body, "clientSentAt")
		if at == "" {
			at = now()
		}
		base := M{"id": id, "fromUserId": actor["id"], "senderName": actor["name"], "text": text, "sentAt": at, "clientRequestId": nullable(request), "requestHash": requestHash, "replyToId": body["replyToId"]}
		if grouped {
			base["groupId"] = recipient
		} else {
			base["toUserId"] = recipient
			base["kind"] = kind
		}
		data := fullRow(table, base)
		r.put(table, data, false, false)
		if !grouped {
			r.clearConversation(s(actor, "id"), recipient)
			r.clearConversation(recipient, s(actor, "id"))
		}
		for position, v := range options {
			option := m(v)
			r.put("ChoiceOption", M{"messageId": id, "optionId": option["id"], "label": strings.TrimSpace(s(option, "label")), "position": position}, false, false)
		}
		for _, attachment := range attachments {
			field := "messageId"
			if grouped {
				field = "groupMessageId"
			}
			r.put("Attachment", M{"id": attachment["id"], "status": "attached", field: id}, false, true)
		}
		return r.messageRecord(data, s(actor, "id"), grouped, true)
	}))
}
func (sv *Service) modifyMessage(ctx context.Context, actor M, id string, body M, action string, grouped bool, mutation M) M {
	return m(sv.rowsTransaction(ctx, false, func(r *Rows) any {
		table := messageTable(grouped)
		hash := ""
		if mutation != nil {
			hash = sha(encode(encode(parseMutation(mutation))))
			key := s(mutation, "operationId")
			if previous := r.Get("row-requests", key); previous != nil {
				if s(previous, "hash") != hash {
					fail(409, "mutation_conflict", "ID операции уже использован")
				}
				return merge(get(previous, "receipt"), M{"replayed": true})
			}
			if r.Get("operations", key) != nil {
				fail(409, "mutation_conflict", "ID операции уже использован")
			}
			if s(mutation, "type") == "message.edit" {
				original := r.row(table, id)
				if original != nil {
					for _, field := range []string{"id", "fromUserId", "toUserId", "sentAt"} {
						if original[field] != get(mutation, "message")[field] {
							fail(409, "message_identity_conflict", "Нельзя менять участников или время сообщения")
						}
					}
				}
			}
			if s(mutation, "type") == "reaction.set" && s(get(mutation, "reaction"), "userId") != s(actor, "id") {
				fail(403, "mutation_not_allowed", "Нельзя менять чужую реакцию")
			}
		}
		data := r.row(table, id)
		r.messageRecord(data, s(actor, "id"), grouped, true)
		var result M
		switch action {
		case "edit":
			text := strings.TrimSpace(s(body, "text"))
			if s(data, "fromUserId") != s(actor, "id") || s(data, "kind") == "choice" || text == "" || utf16len(text) > 16384 {
				fail(403, "message_not_editable", "Можно менять только своё текстовое сообщение")
			}
			r.put(table, M{"id": id, "text": text, "editedAt": now()}, false, true)
		case "delete":
			scope := s(body, "scope")
			if !contains([]string{"me", "everyone"}, scope) {
				fail(422, "invalid_delete_scope", "Некорректный вид удаления")
			}
			if scope == "everyone" {
				if grouped && s(data, "fromUserId") != s(actor, "id") {
					fail(403, "not_message_author", "Удалить у всех можно только своё сообщение")
				}
				r.detachFiles(id)
				r.put(table, data, true, false)
			} else {
				r.put(table+"Deletion", M{"messageId": id, "userId": actor["id"]}, false, false)
			}
			result = M{"deleted": true, "id": id, "scope": scope}
		case "reaction":
			if !own(body, "emoji") || body["emoji"] != nil && !validEmoji(body["emoji"]) {
				fail(422, "invalid_reaction", "Некорректная реакция")
			}
			r.put(table+"Reaction", M{"messageId": id, "userId": actor["id"], "emoji": body["emoji"]}, body["emoji"] == nil, false)
			result = M{"reactions": r.messageRecord(data, s(actor, "id"), grouped, true)["reactions"]}
		case "answer":
			if grouped || s(data, "toUserId") != s(actor, "id") || s(data, "kind") != "choice" {
				fail(403, "not_a_choice", "Нет права ответа")
			}
			if truth(data["answerId"]) && s(data, "answerId") != s(body, "id") {
				fail(409, "already_answered", "Ответ уже выбран")
			}
			option := r.row("ChoiceOption", id, s(body, "id"))
			if option == nil {
				fail(422, "invalid_choice", "Такого варианта нет")
			}
			if !truth(data["answerId"]) {
				r.put(table, M{"id": id, "answerId": option["optionId"], "answerLabel": option["label"], "answeredAt": now()}, false, true)
			}
		}
		if mutation != nil {
			receipt := M{"operationId": mutation["operationId"], "messageId": id, "receivedAt": now(), "replayed": false, "status": "applied"}
			r.Put("row-requests", s(mutation, "operationId"), M{"hash": hash, "receipt": receipt})
			return receipt
		}
		if result != nil {
			return result
		}
		return M{"message": r.messageRecord(r.row(table, id), s(actor, "id"), grouped, true)}
	}))
}
func (sv *Service) groupReceipt(ctx context.Context, actor M, id, status string) M {
	if !contains([]string{"read", "delivered"}, status) {
		fail(422, "invalid_status", "Некорректный статус")
	}
	return m(sv.rowsTransaction(ctx, false, func(r *Rows) any {
		data := r.row("GroupMessage", id)
		r.messageRecord(data, s(actor, "id"), true, true)
		before := r.row("ReadState", s(actor, "id"), s(data, "groupId"))
		patch := M{"userId": actor["id"], "chatId": data["groupId"], "lastDeliveredAt": data["sentAt"]}
		if status == "read" {
			patch["lastReadAt"] = data["sentAt"]
		} else if before == nil {
			patch["lastReadAt"] = nil
		}
		r.put("ReadState", patch, false, before != nil)
		return M{"message": r.messageRecord(data, s(actor, "id"), true, true)}
	}))
}
