package main

import (
	"context"
	"sort"
	"strings"
)

func withReceipt(tx Tx, message M) M {
	receipt := tx.Get("receipts", s(message, "toUserId")+":"+s(message, "fromUserId"))
	status := str(or(message["status"], "sent"))
	if truth(message["answer"]) {
		status = "answered"
	} else if contains(stringsOf(list(receipt, "read")), s(message, "id")) {
		status = "read"
	} else if contains(stringsOf(list(receipt, "delivered")), s(message, "id")) {
		status = "delivered"
	}
	return merge(message, M{"status": status})
}
func (sv *Service) snapshot(ctx context.Context, user M, limit int) M {
	return m(sv.rowsTransaction(ctx, true, func(r *Rows) any {
		id := s(user, "id")
		state := r.Get("user-state", id)
		views := r.Views(id, limit)
		messages := A{}
		for i := len(views) - 1; i >= 0; i-- {
			message := views[i]
			if !visible(message) {
				continue
			}
			if b(message, "_row") {
				record := r.row("Message", s(message, "id"))
				if record != nil {
					messages = append(messages, r.messageRecord(record, id, false, true))
				}
			} else {
				messages = append(messages, withReceipt(r, bare(message)))
			}
		}
		rich := r.snapshot(id, limit)
		known := map[string]bool{}
		for _, v := range list(rich, "groups") {
			known[s(m(v), "id")] = true
		}
		for _, v := range list(state, "groups") {
			group := m(v)
			if r.state("Group", s(group, "id")) != nil {
				known[s(group, "id")] = true
			}
		}
		groups, groupMessages := A{}, A{}
		for _, v := range list(state, "groups") {
			if !known[s(m(v), "id")] {
				groups = append(groups, v)
			}
		}
		groups = append(groups, list(rich, "groups")...)
		for _, v := range list(state, "groupMessages") {
			if !known[s(m(v), "groupId")] {
				groupMessages = append(groupMessages, v)
			}
		}
		groupMessages = append(groupMessages, list(rich, "groupMessages")...)
		deleted := A{}
		for _, v := range r.Scan("deleted:"+id, 10000) {
			deleted = append(deleted, v["id"])
		}
		return M{"user": publicUser(user), "contacts": list(state, "contacts"), "groups": groups, "groupMessages": groupMessages, "hiddenPeerIds": list(state, "hiddenPeerIds"), "readStates": list(state, "readStates"), "messages": messages, "deletedMessageIds": deleted, "installationId": sv.ID, "cursor": sv.ID + ":" + r.Sequence(), "syncedAt": now()}
	}))
}
func (sv *Service) message(ctx context.Context, user M, id string) M {
	return m(sv.rowsTransaction(ctx, true, func(r *Rows) any {
		if r.state("Message", id) != nil {
			return r.messageRecord(r.row("Message", id), s(user, "id"), false, true)
		}
		state := r.Get("states", id)
		original := creationMessage(state)
		if original == nil {
			original = get(state, "archive")
		}
		if original == nil || s(original, "fromUserId") != s(user, "id") && s(original, "toUserId") != s(user, "id") {
			fail(404, "message_not_found", "Сообщение не найдено")
		}
		view := r.View(s(user, "id"), s(original, "sentAt"), id)
		if !visible(view) {
			fail(404, "message_not_found", "Сообщение не найдено")
		}
		return withReceipt(r, bare(view))
	}))
}

var cursorRE = regexpMust(`^\d{1,20}$`)

func (sv *Service) changes(ctx context.Context, user M, after string, limit int, extended bool) M {
	if !strings.HasPrefix(after, sv.ID+":") {
		fail(409, "cursor_installation_mismatch", "Нужен снимок этого контура")
	}
	seq := strings.TrimPrefix(after, sv.ID+":")
	if !cursorRE.MatchString(seq) {
		fail(422, "invalid_cursor", "Некорректный курсор")
	}
	return m(sv.transaction(ctx, true, func(tx Tx) any {
		changes := tx.Feed(s(user, "id"), seq, limit+1)
		for _, change := range changes {
			if s(change, "type") == "snapshot.required" || !extended && contains([]string{"group", "group.remove", "group.message", "group.message.delete", "conversation.hidden"}, s(change, "type")) {
				fail(409, "snapshot_required", "Нужен новый снимок")
			}
		}
		hasMore := len(changes) > limit
		if hasMore {
			changes = changes[:limit]
		}
		cursor := seq
		if len(changes) > 0 {
			cursor = s(changes[len(changes)-1], "sequence")
		}
		return M{"user": publicUser(user), "installationId": sv.ID, "cursor": sv.ID + ":" + cursor, "changes": records(changes), "hasMore": hasMore}
	}))
}
func (sv *Service) mutate(ctx context.Context, user, value M, source string) M {
	operation := parseMutation(value)
	if s(operation, "actorId") != s(user, "id") {
		fail(403, "mutation_actor_mismatch", "Нельзя изменить данные другого пользователя")
	}
	id := mutationMessageID(operation)
	if source == "" && s(operation, "type") != "message.create" {
		rich := sv.rowsTransaction(ctx, true, func(r *Rows) any { return r.state("Message", id) })
		if m(rich) != nil {
			action := "reaction"
			body := M{"emoji": get(operation, "reaction")["emoji"]}
			if s(operation, "type") == "message.edit" {
				action = "edit"
				body = M{"text": get(operation, "message")["text"]}
			} else if s(operation, "type") == "message.delete" {
				action = "delete"
				body = M{"scope": get(operation, "deletion")["scope"]}
			}
			return sv.modifyMessage(ctx, user, id, body, action, false, operation)
		}
	}
	return m(sv.rowsTransaction(ctx, false, func(r *Rows) any {
		opID := s(operation, "operationId")
		if r.Get("row-requests", opID) != nil {
			fail(409, "mutation_conflict", "ID операции уже использован")
		}
		original := r.Get("operations", opID)
		state := copyMap(r.Get("states", id))
		if !own(state, "operations") {
			state["operations"] = A{}
		}
		if original != nil {
			if encode(parseMutation(get(original, "operation"))) != encode(operation) {
				fail(409, "mutation_conflict", "ID операции уже использован")
			}
			status := reduceOperations(list(state, "operations")).Statuses[opID]
			if status == "" {
				status = "pending"
			}
			return M{"operationId": opID, "messageId": id, "receivedAt": original["receivedAt"], "replayed": true, "status": status}
		}
		if truth(state["archive"]) {
			fail(409, "archived_message_read_only", "Эта часть истории пока доступна только для чтения")
		}
		if s(operation, "type") == "message.create" {
			if creationMessage(state) != nil {
				fail(409, "message_id_conflict", "Сообщение уже существует")
			}
			if r.Get("users", s(get(operation, "message"), "toUserId")) == nil {
				fail(404, "recipient_not_found", "Получатель не найден")
			}
			state["senderName"] = user["name"]
		}
		operations := append(list(state, "operations"), operation)
		if len(encode(operations)) > 1024*1024 {
			fail(413, "message_journal_full", "Достигнут лимит истории изменений прототипа")
		}
		projection := reduceOperations(operations)
		status := projection.Statuses[opID]
		if status == "rejected" && source == "" {
			fail(403, "mutation_not_allowed", "Нет прав на изменение сообщения")
		}
		received := now()
		receipt := M{"operation": operation, "receivedAt": received}
		if source != "" {
			receipt["sourceId"] = source
		}
		r.Put("operations", opID, receipt)
		if source == "" {
			appendReplication(r, "operation:"+opID, M{"type": "mutation", "operation": operation})
		}
		state["operations"] = operations
		r.Put("states", id, state)
		if projection.Message != nil {
			seq := r.NextSequence()
			message := projection.Message
			for _, viewer := range []string{s(message, "fromUserId"), s(message, "toUserId")} {
				hidden := projection.Deleted || contains(projection.Hidden, viewer)
				view := M{}
				if hidden {
					view = merge(pick(message, "id", "sentAt", "fromUserId", "toUserId"), M{"deleted": true})
					r.Put("deleted:"+viewer, id, M{"id": id})
				} else {
					view = merge(message, M{"senderName": state["senderName"], "reactions": projection.Reactions})
					if projection.EditedAt != "" {
						view["editedAt"] = projection.EditedAt
					}
					view = withReceipt(r, view)
				}
				r.PutView(viewer, view)
				event := M{"type": "message", "message": view}
				if hidden {
					event = M{"type": "message.delete", "id": id}
				}
				r.AddFeed(viewer, seq, event)
				if s(operation, "type") == "message.create" {
					peer := s(message, "fromUserId")
					if viewer == peer {
						peer = s(message, "toUserId")
					}
					r.clearConversation(viewer, peer)
				}
			}
		}
		return M{"operationId": opID, "messageId": id, "receivedAt": received, "replayed": false, "status": status}
	}))
}
func (sv *Service) importMutation(ctx context.Context, value M, source string) M {
	op := parseMutation(value)
	actor := m(sv.transaction(ctx, true, func(tx Tx) any { return tx.Get("users", s(op, "actorId")) }))
	if actor == nil {
		fail(409, "peer_actor_missing", "Сначала передайте пользователя")
	}
	return sv.mutate(ctx, actor, op, source)
}
func mergeIDs(values ...A) []string {
	out := []string{}
	for _, v := range values {
		out = append(out, stringsOf(v)...)
	}
	out = uniq(out)
	sort.Strings(out)
	return out
}
func (sv *Service) importReceipt(ctx context.Context, receipt M) {
	if len(list(receipt, "delivered")) > 5000 || len(list(receipt, "read")) > 5000 || !isArray(receipt["delivered"]) || !isArray(receipt["read"]) {
		fail(422, "invalid_peer_receipt", "Некорректное прочтение")
	}
	sv.transaction(ctx, false, func(tx Tx) any {
		key := s(receipt, "userId") + ":" + s(receipt, "peerId")
		before := tx.Get("receipts", key)
		read := mergeIDs(list(before, "read"), list(receipt, "read"))
		delivered := mergeIDs(list(before, "delivered"), list(receipt, "delivered"), toA(read))
		next := M{"delivered": delivered, "read": read}
		if equal(before, next) {
			return nil
		}
		tx.Put("receipts", key, next)
		seq := tx.NextSequence()
		for _, viewer := range []string{s(receipt, "userId"), s(receipt, "peerId")} {
			tx.AddFeed(viewer, seq, merge(next, M{"type": "receipts"}))
		}
		return nil
	})
}
func (sv *Service) receipt(ctx context.Context, user M, id, status string) M {
	if !contains([]string{"delivered", "read"}, status) {
		fail(422, "invalid_status", "Некорректный статус")
	}
	return m(sv.transaction(ctx, false, func(tx Tx) any {
		views := []M{}
		var message M
		for _, view := range tx.Views(s(user, "id"), 100) {
			if visible(view) {
				views = append(views, view)
				if s(view, "id") == id && s(view, "toUserId") == s(user, "id") {
					message = view
				}
			}
		}
		if message == nil {
			fail(404, "message_not_found", "Входящее сообщение не найдено")
		}
		key := s(user, "id") + ":" + s(message, "fromUserId")
		before := tx.Get("receipts", key)
		known := A{}
		for _, view := range views {
			if s(view, "fromUserId") == s(message, "fromUserId") && s(view, "sentAt") <= s(message, "sentAt") {
				known = append(known, view["id"])
			}
		}
		delivered := mergeIDs(list(before, "delivered"), known)
		read := stringsOf(list(before, "read"))
		if status == "read" {
			read = mergeIDs(list(before, "read"), known)
		}
		next := M{"delivered": delivered, "read": read}
		if !equal(next, before) {
			tx.Put("receipts", key, next)
			hash := sha(encode(O{{"delivered", delivered}, {"read", read}}))
			appendReplication(tx, "receipt:"+key+":"+hash, merge(next, M{"type": "receipt", "userId": user["id"], "peerId": message["fromUserId"]}))
			seq := tx.NextSequence()
			for _, viewer := range []string{s(user, "id"), s(message, "fromUserId")} {
				tx.AddFeed(viewer, seq, merge(next, M{"type": "receipts"}))
			}
		}
		result := bare(message)
		result["status"] = "delivered"
		if contains(read, id) {
			result["status"] = "read"
		}
		return result
	}))
}
func toA(values []string) A {
	out := A{}
	for _, v := range values {
		out = append(out, v)
	}
	return out
}
func isArray(v any) bool {
	switch v.(type) {
	case A, []any, []string, []M:
		return true
	}
	return false
}
