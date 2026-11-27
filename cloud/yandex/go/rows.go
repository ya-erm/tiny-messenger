package main

import (
	"context"
	"sort"
	"strings"
)

type Rows struct {
	Tx
	Service      *Service
	messages     map[string]bool
	groups       map[string][]string
	snapshots    map[string]bool
	memberships  map[string]M
	messageCache map[string]M
	receipts     map[string]M
	marks        map[string][]M
}

func newRows(tx Tx, sv *Service) *Rows {
	return &Rows{Tx: tx, Service: sv, messages: map[string]bool{}, groups: map[string][]string{}, snapshots: map[string]bool{}, memberships: map[string]M{}, messageCache: map[string]M{}, receipts: map[string]M{}, marks: map[string][]M{}}
}
func (sv *Service) rowsTransaction(ctx context.Context, ro bool, fn func(*Rows) any) any {
	return sv.transaction(ctx, ro, func(tx Tx) any {
		r := newRows(tx, sv)
		result := fn(r)
		if !ro {
			r.flush()
		}
		return result
	})
}
func (r *Rows) state(table string, keys ...string) M { return r.Get(rowBucket(table), encode(keys)) }
func (r *Rows) row(table string, keys ...string) M {
	state := r.state(table, keys...)
	if state == nil || rowDeleted(state) {
		return nil
	}
	data := effectiveRow(state)
	for _, field := range list(get(rowTables, table), "fields") {
		if !own(data, str(field)) {
			return nil
		}
	}
	return data
}
func (r *Rows) children(table, parent string) []M {
	out := []M{}
	prefix := strings.TrimSuffix(encode([]string{parent}), "]") + ","
	for _, state := range r.Prefix(rowBucket(table), prefix, 1000) {
		if !rowDeleted(state) {
			out = append(out, get(state, "data"))
		}
	}
	return out
}
func (r *Rows) members(id string) []M {
	prefix := strings.TrimSuffix(encode([]string{id}), "]") + ","
	states := []M{}
	for _, state := range r.Prefix(rowBucket("GroupMember"), prefix, 1000) {
		if !rowDeleted(state) {
			states = append(states, state)
		}
	}
	sort.SliceStable(states, func(i, j int) bool { return s(states[i], "aliveVersion") < s(states[j], "aliveVersion") })
	out := []M{}
	for _, state := range states {
		out = append(out, get(state, "data"))
	}
	return out
}
func (r *Rows) membership(id string) M {
	if value, ok := r.memberships[id]; ok {
		return value
	}
	v := M{"data": r.row("Group", id), "members": records(r.members(id))}
	r.memberships[id] = v
	return v
}
func (r *Rows) checkGroup(id, viewer string) M {
	v := r.membership(id)
	found := viewer == ""
	for _, member := range list(v, "members") {
		if s(m(member), "userId") == viewer {
			found = true
		}
	}
	if get(v, "data") == nil || !found {
		fail(404, "group_not_found", "Группа не найдена")
	}
	return v
}
func (r *Rows) group(id, viewer string) M {
	v := r.checkGroup(id, viewer)
	if get(v, "public") != nil {
		return get(v, "public")
	}
	people := A{}
	for _, member := range list(v, "members") {
		if u := r.Get("users", s(m(member), "userId")); u != nil {
			people = append(people, publicUser(u))
		}
	}
	result := nonnull(get(v, "data"), "id", "name", "ownerId", "createdAt", "updatedAt", "avatarUrl", "avatarBackground")
	result["members"] = people
	v["public"] = result
	return result
}
func (r *Rows) file(id string) M { return r.row("Attachment", id) }
func attachmentPreview(contentType string) any {
	if contains([]string{"image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"}, contentType) {
		return "image"
	}
	if contains([]string{"video/mp4", "video/webm", "video/ogg"}, contentType) {
		return "video"
	}
	return nil
}

func fileInfo(data M) M {
	size := data["confirmedSize"]
	if size == nil {
		size = data["requestedSize"]
	}
	return M{"hasThumbnail": truth(data["thumbnailKey"]), "id": data["id"], "originalName": data["originalName"], "contentType": data["contentType"], "size": n(size), "preview": attachmentPreview(s(data, "contentType"))}
}
func messageTable(grouped bool) string {
	if grouped {
		return "GroupMessage"
	}
	return "Message"
}
func (r *Rows) messageRecord(data M, viewer string, grouped, resolveReply bool) M {
	if data == nil {
		fail(404, "message_not_found", "Сообщение не найдено")
	}
	table := messageTable(grouped)
	if grouped {
		r.checkGroup(s(data, "groupId"), viewer)
	} else if viewer != s(data, "fromUserId") && viewer != s(data, "toUserId") {
		fail(404, "message_not_found", "Сообщение не найдено")
	}
	id := s(data, "id")
	if r.row(table+"Deletion", id, viewer) != nil {
		fail(404, "message_not_found", "Сообщение не найдено")
	}
	cacheKey := table + ":" + id
	result := r.messageCache[cacheKey]
	if result == nil {
		reactions := r.children(table+"Reaction", id)
		sort.Slice(reactions, func(i, j int) bool { return s(reactions[i], "userId") < s(reactions[j], "userId") })
		rx := A{}
		for _, item := range reactions {
			rx = append(rx, pick(item, "userId", "emoji"))
		}
		attachments := A{}
		for _, item := range r.Scan("files-of:"+id, 10) {
			f := r.file(s(item, "id"))
			if s(f, "status") == "attached" && (s(f, "messageId") == id || s(f, "groupMessageId") == id) {
				attachments = append(attachments, fileInfo(f))
			}
		}
		status := "sent"
		if grouped {
			groupID := s(data, "groupId")
			marks, ok := r.marks[groupID]
			if !ok {
				marks = []M{}
				for _, member := range list(r.membership(groupID), "members") {
					uid := s(m(member), "userId")
					marks = append(marks, M{"userId": uid, "mark": r.row("ReadState", uid, groupID)})
				}
				r.marks[groupID] = marks
			}
			read, delivered, count := true, true, 0
			for _, entry := range marks {
				if s(entry, "userId") == s(data, "fromUserId") {
					continue
				}
				count++
				mark := get(entry, "mark")
				read = read && s(mark, "lastReadAt") >= s(data, "sentAt")
				delivered = delivered && s(mark, "lastDeliveredAt") >= s(data, "sentAt")
			}
			if count > 0 && read {
				status = "read"
			} else if count > 0 && delivered {
				status = "delivered"
			}
		} else {
			key := s(data, "toUserId") + ":" + s(data, "fromUserId")
			receipt, ok := r.receipts[key]
			if !ok {
				receipt = r.Get("receipts", key)
				r.receipts[key] = receipt
			}
			if contains(stringsOf(list(receipt, "read")), id) {
				status = "read"
			} else if contains(stringsOf(list(receipt, "delivered")), id) {
				status = "delivered"
			}
		}
		result = pick(data, "id", "fromUserId", "senderName", "text", "sentAt")
		if grouped {
			result["groupId"] = data["groupId"]
		} else {
			result["toUserId"] = data["toUserId"]
			result["kind"] = data["kind"]
		}
		for _, key := range []string{"editedAt", "replyToId"} {
			if truth(data[key]) {
				result[key] = data[key]
			}
		}
		if len(attachments) > 0 {
			result["attachments"] = attachments
		}
		result["reactions"] = rx
		result["status"] = status
		if !grouped && s(data, "kind") == "choice" {
			options := r.children("ChoiceOption", id)
			sort.Slice(options, func(i, j int) bool { return n(options[i]["position"]) < n(options[j]["position"]) })
			opts := A{}
			for _, item := range options {
				opts = append(opts, M{"id": item["optionId"], "label": item["label"]})
			}
			if len(opts) != 2 {
				fail(425, "message_pending", "Варианты ответа ещё синхронизируются")
			}
			result["options"] = opts
			if truth(data["answerId"]) {
				result["answer"] = M{"id": data["answerId"], "label": data["answerLabel"], "answeredAt": data["answeredAt"]}
				result["status"] = "answered"
			}
		}
		r.messageCache[cacheKey] = result
	}
	result = copyMap(result)
	if truth(data["replyToId"]) && resolveReply {
		var target M
		_, err := caught(func() any {
			original := r.row(table, s(data, "replyToId"))
			if original != nil && (grouped && s(original, "groupId") == s(data, "groupId") || !grouped && samePeers(original, data)) {
				target = r.messageRecord(original, viewer, grouped, false)
			} else if !grouped {
				original = creationMessage(r.Get("states", s(data, "replyToId")))
				if original != nil && samePeers(original, data) {
					v := r.View(viewer, s(original, "sentAt"), s(original, "id"))
					if visible(v) {
						target = v
					}
				}
			}
			return nil
		})
		if err != nil {
			if _, ok := err.(*HTTPError); !ok {
				panic(err)
			}
		}
		reply := M{"id": data["replyToId"], "available": target != nil}
		if target != nil {
			text := s(target, "text")
			if text == "" && len(list(target, "attachments")) > 0 {
				text = s(m(list(target, "attachments")[0]), "originalName")
			}
			if text == "" {
				text = "Вложение"
			}
			runes := []rune(text)
			if len(runes) > 180 {
				runes = runes[:180]
			}
			reply["senderName"] = target["senderName"]
			reply["text"] = string(runes)
		}
		result["reply"] = reply
	}
	return result
}
func samePeers(a, b M) bool {
	return s(a, "fromUserId") == s(b, "fromUserId") && s(a, "toUserId") == s(b, "toUserId") || s(a, "fromUserId") == s(b, "toUserId") && s(a, "toUserId") == s(b, "fromUserId")
}
func creationMessage(state M) M {
	for _, v := range list(state, "operations") {
		op := m(v)
		if s(op, "type") == "message.create" {
			return get(op, "message")
		}
	}
	return nil
}
func visible(v M) bool { return v != nil && !b(v, "deleted") && !b(v, "hidden") }
func bare(v M) M {
	out := copyMap(v)
	for _, k := range []string{"hidden", "deleted", "_row"} {
		delete(out, k)
	}
	return out
}
func (r *Rows) refreshMessage(id string, grouped bool) {
	table := messageTable(grouped)
	item := r.state(table, id)
	if item == nil {
		return
	}
	data := get(item, "data")
	if s(data, "sentAt") == "" || s(data, "fromUserId") == "" || grouped && s(data, "groupId") == "" || !grouped && s(data, "toUserId") == "" {
		return
	}
	audience := []string{s(data, "fromUserId"), s(data, "toUserId")}
	if grouped {
		audience = []string{}
		for _, member := range r.members(s(data, "groupId")) {
			audience = append(audience, s(member, "userId"))
		}
		r.PutView("@group:"+s(data, "groupId"), M{"id": id, "sentAt": data["sentAt"], "groupId": data["groupId"], "deleted": rowDeleted(item)})
	} else {
		r.Put("states", id, M{"archive": pick(data, "id", "sentAt", "fromUserId", "toUserId"), "rich": true})
	}
	for _, viewer := range audience {
		var message M
		if !rowDeleted(item) {
			v, err := caught(func() any { return r.messageRecord(data, viewer, grouped, true) })
			if err != nil {
				he, ok := err.(*HTTPError)
				if !ok {
					panic(err)
				}
				if he.Status == 425 {
					continue
				}
			} else {
				message = m(v)
			}
		}
		seq := r.NextSequence()
		if message != nil {
			if !grouped {
				r.PutView(viewer, merge(message, M{"_row": true}))
			}
			kind := "message"
			if grouped {
				kind = "group.message"
			}
			r.AddFeed(viewer, seq, M{"type": kind, "message": message})
		} else {
			r.Put("deleted:"+viewer, id, M{"id": id})
			if !grouped {
				r.PutView(viewer, merge(pick(data, "id", "sentAt", "fromUserId", "toUserId"), M{"deleted": true}))
			}
			kind := "message.delete"
			if grouped {
				kind = "group.message.delete"
			}
			r.AddFeed(viewer, seq, M{"type": kind, "id": id})
		}
	}
}
func (r *Rows) refreshGroup(id string, extra []string) {
	v := r.membership(id)
	ids := []string{}
	for _, member := range list(v, "members") {
		ids = append(ids, s(m(member), "userId"))
	}
	var value M
	if get(v, "data") != nil {
		value = r.group(id, "")
	}
	for _, viewer := range uniq(append(extra, ids...)) {
		event := M{"type": "group.remove", "id": id}
		if value != nil && contains(ids, viewer) {
			event = M{"type": "group", "group": value}
		}
		r.AddFeed(viewer, r.NextSequence(), event)
	}
}
func (r *Rows) flush() {
	groups, messages, snapshots := r.groups, r.messages, r.snapshots
	r.groups = map[string][]string{}
	r.messages = map[string]bool{}
	r.snapshots = map[string]bool{}
	for _, id := range sortedKeysGroups(groups) {
		r.refreshGroup(id, groups[id])
	}
	ids := []string{}
	for key := range messages {
		ids = append(ids, key)
	}
	sort.Strings(ids)
	for _, key := range ids {
		r.refreshMessage(key[2:], messages[key])
	}
	ids = []string{}
	for id := range snapshots {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		r.AddFeed(id, r.NextSequence(), M{"type": "snapshot.required"})
	}
}
func sortedKeysGroups(v map[string][]string) []string {
	out := []string{}
	for k := range v {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
func (r *Rows) dirtyMessage(id string, grouped bool) {
	if id != "" {
		prefix := "m:"
		if grouped {
			prefix = "g:"
		}
		r.messages[prefix+id] = grouped
	}
}
func (r *Rows) dirtyGroup(id, viewer string) {
	if _, ok := r.groups[id]; !ok {
		r.groups[id] = []string{}
	}
	if viewer != "" {
		r.groups[id] = uniq(append(r.groups[id], viewer))
	}
}
func (r *Rows) apply(input M, local bool) M {
	op := parseRow(input)
	table, key := s(op, "table"), s(op, "key")
	old := r.Get(rowBucket(table), key)
	next := mergeRow(old, op)
	if equal(old, next) {
		return next
	}
	r.Put(rowBucket(table), key, next)
	if local {
		appendReplication(r, "row:"+s(op, "origin")+":"+s(op, "id"), M{"type": "row", "operation": op})
	}
	data := get(next, "data")
	if contains([]string{"Message", "GroupMessage"}, table) && truth(data["clientRequestId"]) {
		r.Put("requests:"+table+":"+s(data, "fromUserId"), s(data, "clientRequestId"), M{"id": data["id"]})
	}
	r.memberships = map[string]M{}
	r.messageCache = map[string]M{}
	r.receipts = map[string]M{}
	r.marks = map[string][]M{}
	switch table {
	case "Attachment":
		r.Put("files-by:"+s(data, "uploaderId"), s(data, "id"), M{"id": data["id"]})
		if truth(data["clientRequestId"]) {
			r.Put("file-request:"+s(data, "uploaderId"), s(data, "clientRequestId"), M{"id": data["id"]})
		}
		before := get(old, "data")
		for _, field := range []string{"messageId", "groupMessageId"} {
			grouped := field == "groupMessageId"
			for _, id := range uniq([]string{s(before, field), s(data, field)}) {
				if id != "" {
					r.Put("files-of:"+id, s(data, "id"), M{"id": data["id"]})
					r.dirtyMessage(id, grouped)
				}
			}
		}
	case "HiddenConversation":
		owner, peer := s(data, "ownerId"), s(data, "peerId")
		metadata := copyMap(r.Get("user-state", owner))
		hidden := []string{}
		for _, id := range stringsOf(list(metadata, "hiddenPeerIds")) {
			if id != peer {
				hidden = append(hidden, id)
			}
		}
		if !rowDeleted(next) {
			hidden = append(hidden, peer)
		}
		metadata["hiddenPeerIds"] = hidden
		r.Put("user-state", owner, metadata)
		r.AddFeed(owner, r.NextSequence(), M{"type": "conversation.hidden", "id": peer, "hidden": !rowDeleted(next)})
	case "Group":
		r.dirtyGroup(s(data, "id"), "")
	case "GroupMember":
		r.Put("groups-of:"+s(data, "userId"), s(data, "groupId"), M{"groupId": data["groupId"], "deleted": rowDeleted(next)})
		r.dirtyGroup(s(data, "groupId"), s(data, "userId"))
		if !rowDeleted(next) && (old == nil || rowDeleted(old)) {
			r.snapshots[s(data, "userId")] = true
		}
	case "Message", "GroupMessage":
		r.dirtyMessage(s(data, "id"), table == "GroupMessage")
	case "ChoiceOption", "MessageReaction", "MessageDeletion", "GroupMessageReaction", "GroupMessageDeletion":
		r.dirtyMessage(s(data, "messageId"), strings.HasPrefix(table, "GroupMessage"))
	case "ReadState":
		for _, member := range r.members(s(data, "chatId")) {
			r.snapshots[s(member, "userId")] = true
		}
	}
	return next
}
func (r *Rows) put(table string, data M, deleted, patch bool) M {
	seq := r.NextSequence()
	p := data
	if !patch {
		p = fullRow(table, data)
	}
	op := M{"version": 1, "id": uuid(), "origin": r.Service.ID, "sequence": seq, "at": now(), "table": table, "key": rowKey(table, data), "patch": p, "deleted": deleted}
	return r.apply(op, true)
}
func (r *Rows) clearConversation(owner, peer string) {
	previous := r.state("HiddenConversation", owner, peer)
	metadata := r.Get("user-state", owner)
	if previous != nil && !rowDeleted(previous) || contains(stringsOf(list(metadata, "hiddenPeerIds")), peer) {
		r.put("HiddenConversation", M{"ownerId": owner, "peerId": peer, "hiddenAt": now()}, true, false)
	}
}
func (r *Rows) detachFiles(id string) {
	for _, index := range r.Scan("files-of:"+id, 10) {
		item := r.file(s(index, "id"))
		if item != nil && (s(item, "messageId") == id || s(item, "groupMessageId") == id) {
			r.put("Attachment", M{"id": item["id"], "messageId": nil, "groupMessageId": nil}, false, true)
		}
	}
}
func (r *Rows) snapshot(viewer string, limit int) M {
	groups, messages := A{}, A{}
	for _, item := range r.Scan("groups-of:"+viewer, 1000) {
		if b(item, "deleted") {
			continue
		}
		v, err := caught(func() any { return r.group(s(item, "groupId"), viewer) })
		if err != nil {
			if _, ok := err.(*HTTPError); ok {
				continue
			}
			panic(err)
		}
		groups = append(groups, v)
		indices := r.Views("@group:"+s(item, "groupId"), limit)
		for i := len(indices) - 1; i >= 0; i-- {
			index := indices[i]
			if b(index, "deleted") {
				continue
			}
			v, err := caught(func() any { return r.messageRecord(r.row("GroupMessage", s(index, "id")), viewer, true, true) })
			if err != nil {
				if _, ok := err.(*HTTPError); ok {
					continue
				}
				panic(err)
			}
			messages = append(messages, v)
		}
	}
	sort.Slice(messages, func(i, j int) bool {
		left, right := m(messages[i]), m(messages[j])
		return s(left, "sentAt")+"|"+s(left, "id") < s(right, "sentAt")+"|"+s(right, "id")
	})
	if len(messages) > limit {
		messages = messages[len(messages)-limit:]
	}
	return M{"groups": groups, "groupMessages": messages}
}
