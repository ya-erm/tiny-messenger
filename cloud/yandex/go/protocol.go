package main

import (
	_ "embed"
	"sort"
	"strings"
)

//go:embed emojis.json
var emojiJSON string

//go:embed row-tables.json
var rowTablesJSON string

//go:embed animals.json
var animalsJSON string
var emojiSet = func() map[string]bool {
	out := map[string]bool{}
	for _, v := range a(decode(emojiJSON)) {
		out[str(v)] = true
	}
	return out
}()
var rowTables = m(decode(rowTablesJSON))
var animalProfiles = a(decode(animalsJSON))

func validEmoji(v any) bool { return emojiSet[str(v)] }
func exactKeys(v M, keys ...string) bool {
	if len(v) != len(keys) {
		return false
	}
	for _, k := range keys {
		if !own(v, k) {
			return false
		}
	}
	return true
}
func parseMutation(v M) M {
	bad := func(message string) { fail(422, "invalid_mutation", message) }
	if v == nil {
		bad("Ожидался объект мутации")
	}
	if n(v["protocolVersion"]) != 1 {
		bad("Неподдерживаемая версия протокола мутаций")
	}
	for _, k := range []string{"operationId", "actorId", "deviceId"} {
		if !validUUID(v[k]) {
			bad("Некорректный UUID мутации")
		}
	}
	if !validUTC(v["occurredAt"]) {
		bad("Ожидалось UTC-время с миллисекундами")
	}
	kind := s(v, "type")
	entity := "message"
	if kind == "message.delete" {
		entity = "deletion"
	}
	if kind == "reaction.set" {
		entity = "reaction"
	}
	if !exactKeys(v, "protocolVersion", "operationId", "actorId", "deviceId", "occurredAt", "type", entity) {
		bad("Некорректные поля мутации")
	}
	p := get(v, entity)
	switch kind {
	case "message.delete":
		if !exactKeys(p, "messageId", "scope") || !validUUID(p["messageId"]) || !contains([]string{"me", "everyone"}, s(p, "scope")) {
			bad("Некорректная область удаления")
		}
	case "reaction.set":
		if !exactKeys(p, "messageId", "userId", "emoji") || !validUUID(p["messageId"]) || !validUUID(p["userId"]) || s(p, "userId") != s(v, "actorId") || p["emoji"] != nil && !validEmoji(p["emoji"]) {
			bad("Некорректная реакция")
		}
	case "message.create", "message.edit":
		if !exactKeys(p, "id", "fromUserId", "toUserId", "kind", "text", "sentAt") {
			bad("Некорректные поля мутации")
		}
		if s(p, "kind") != "text" || strings.TrimSpace(s(p, "text")) == "" || len(s(p, "text")) > 16384 {
			bad("Некорректное текстовое сообщение")
		}
		for _, k := range []string{"id", "fromUserId", "toUserId"} {
			if !validUUID(p[k]) {
				bad("Некорректный UUID мутации")
			}
		}
		if !validUTC(p["sentAt"]) {
			bad("Ожидалось UTC-время с миллисекундами")
		}
		if s(v, "actorId") != s(p, "fromUserId") || s(v, "actorId") == s(p, "toUserId") || kind == "message.create" && s(v, "occurredAt") != s(p, "sentAt") {
			bad("Автор, получатель или время сообщения не согласованы")
		}
	default:
		bad("Неподдерживаемый тип мутации")
	}
	return clone(v)
}
func mutationMessageID(v M) string {
	switch s(v, "type") {
	case "message.delete":
		return s(get(v, "deletion"), "messageId")
	case "reaction.set":
		return s(get(v, "reaction"), "messageId")
	}
	return s(get(v, "message"), "id")
}
func mutationOrder(v M) string { return s(v, "occurredAt") + "|" + s(v, "operationId") }

type Projection struct {
	Message   M
	EditedAt  string
	Deleted   bool
	Hidden    []string
	Reactions A
	Statuses  map[string]string
}

func reduceOperations(operations A) Projection {
	unique := map[string]M{}
	for _, v := range operations {
		op := m(v)
		id := s(op, "operationId")
		if previous := unique[id]; previous != nil && encode(previous) != encode(op) {
			panicError("Conflicting operation ID")
		}
		unique[id] = op
	}
	ordered := []M{}
	p := Projection{Hidden: []string{}, Reactions: A{}, Statuses: map[string]string{}}
	for id, op := range unique {
		ordered = append(ordered, op)
		p.Statuses[id] = "pending"
	}
	sort.Slice(ordered, func(i, j int) bool { return mutationOrder(ordered[i]) < mutationOrder(ordered[j]) })
	var creation M
	for _, op := range ordered {
		if s(op, "type") == "message.create" {
			creation = op
			break
		}
	}
	if creation == nil {
		return p
	}
	original := get(creation, "message")
	p.Message = original
	p.Statuses[s(creation, "operationId")] = "applied"
	var lastEdit M
	reactions := map[string]M{}
	hidden := map[string]bool{}
	for _, op := range ordered {
		id := s(op, "operationId")
		if id == s(creation, "operationId") {
			continue
		}
		actor := s(op, "actorId")
		if mutationMessageID(op) != s(original, "id") || actor != s(original, "fromUserId") && actor != s(original, "toUserId") || s(op, "type") == "message.create" {
			p.Statuses[id] = "rejected"
			continue
		}
		switch s(op, "type") {
		case "message.edit":
			next := get(op, "message")
			valid := actor == s(original, "fromUserId")
			for _, k := range []string{"fromUserId", "toUserId", "sentAt", "kind"} {
				valid = valid && s(next, k) == s(original, k)
			}
			if !valid {
				p.Statuses[id] = "rejected"
				continue
			}
			if lastEdit != nil {
				p.Statuses[s(lastEdit, "operationId")] = "superseded"
			}
			p.Message = next
			lastEdit = op
			p.EditedAt = s(op, "occurredAt")
		case "message.delete":
			if s(get(op, "deletion"), "scope") == "everyone" {
				p.Deleted = true
			} else {
				hidden[actor] = true
			}
		case "reaction.set":
			if s(get(op, "reaction"), "userId") != actor {
				p.Statuses[id] = "rejected"
				continue
			}
			if previous := reactions[actor]; previous != nil {
				p.Statuses[s(previous, "operationId")] = "superseded"
			}
			reactions[actor] = op
		}
		p.Statuses[id] = "applied"
	}
	for id := range hidden {
		p.Hidden = append(p.Hidden, id)
	}
	sort.Strings(p.Hidden)
	ids := []string{}
	for id := range reactions {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		op := reactions[id]
		if get(op, "reaction")["emoji"] != nil {
			p.Reactions = append(p.Reactions, M{"userId": id, "emoji": get(op, "reaction")["emoji"]})
		}
	}
	return p
}
func rowKey(table string, data M) string {
	keys := A{}
	for _, k := range list(get(rowTables, table), "keys") {
		keys = append(keys, data[str(k)])
	}
	return encode(keys)
}
func rowBucket(table string) string { return "rows:" + table }
func rowVersion(op M) string {
	seq := s(op, "sequence")
	return s(op, "at") + "|" + s(op, "origin") + "|" + strings.Repeat("0", max(0, 20-len(seq))) + seq + "|" + s(op, "id")
}
func rowDeleted(state M) bool {
	deleted := s(state, "deletedVersion")
	return deleted != "" && (contains([]string{"Message", "GroupMessage", "Group"}, s(state, "table")) || deleted >= s(state, "aliveVersion"))
}
func effectiveRow(state M) M {
	data := get(state, "data")
	if s(state, "table") == "Attachment" {
		data = merge(M{"thumbnailKey": nil, "thumbnailSize": nil}, data)
		if truth(data["messageId"]) || truth(data["groupMessageId"]) {
			data["status"] = "attached"
		}
	}
	return data
}
func fullRow(table string, data M) M {
	out := M{}
	for _, k := range list(get(rowTables, table), "fields") {
		out[str(k)] = data[str(k)]
	}
	return out
}

var rowIDRE = regexpMust(`^[0-9a-f-]{32,36}$`)
var originRE = regexpMust(`^[a-z0-9-]{1,64}$`)
var sequenceRE = regexpMust(`^(0|[1-9][0-9]{0,19})$`)

func parseRow(op M) M {
	table := s(op, "table")
	p := get(op, "patch")
	if n(op["version"]) != 1 || !own(rowTables, table) || !rowIDRE.MatchString(s(op, "id")) || !originRE.MatchString(s(op, "origin")) || !sequenceRE.MatchString(s(op, "sequence")) || !validUTC(op["at"]) || p == nil {
		invalid("row operation")
	}
	if _, ok := op["deleted"].(bool); !ok {
		invalid("row operation")
	}
	fields := stringsOf(list(get(rowTables, table), "fields"))
	for k, v := range p {
		if !contains(fields, k) {
			invalid("row fields")
		}
		if v != nil {
			if _, ok := v.(string); !ok && !safeInteger(v) {
				invalid("row fields")
			}
		}
	}
	if s(op, "key") != rowKey(table, p) || len(encode(op)) > 48*1024 {
		invalid("row fields")
	}
	for _, key := range a(decode(s(op, "key"))) {
		if _, ok := key.(string); !ok || utf16len(str(key)) > 128 {
			invalid("row key")
		}
	}
	return op
}
func mergeRow(previous, op M) M {
	version := rowVersion(op)
	state := clone(previous)
	if state == nil {
		state = M{"table": op["table"], "key": op["key"], "data": M{}, "versions": M{}, "aliveVersion": "", "createdVersion": version}
	}
	if s(state, "table") != s(op, "table") || s(state, "key") != s(op, "key") {
		panicError("Mismatched row identity")
	}
	data, versions := get(state, "data"), get(state, "versions")
	if b(op, "deleted") {
		if version > s(state, "deletedVersion") {
			state["deletedVersion"] = version
		}
		for k, v := range get(op, "patch") {
			if !own(data, k) {
				data[k] = v
			}
		}
		return state
	}
	if version > s(state, "aliveVersion") {
		state["aliveVersion"] = version
	}
	if version < s(state, "createdVersion") {
		state["createdVersion"] = version
	}
	patch := copyMap(get(op, "patch"))
	if s(state, "table") == "Message" && truth(data["answerId"]) {
		incoming := ""
		if truth(patch["answerId"]) && s(patch, "answeredAt") != "" {
			incoming = s(patch, "answeredAt") + "|" + version
		}
		old := s(data, "answeredAt") + "|" + s(versions, "answerId")
		for _, k := range []string{"answerId", "answerLabel", "answeredAt"} {
			if incoming != "" && incoming < old {
				data[k] = patch[k]
				versions[k] = version
			}
			delete(patch, k)
		}
	}
	for k, v := range patch {
		if s(state, "table") == "ReadState" && contains([]string{"lastReadAt", "lastDeliveredAt"}, k) {
			if !own(data, k) || v != nil && (data[k] == nil || str(v) > str(data[k])) {
				data[k] = v
			}
			if version > s(versions, k) {
				versions[k] = version
			}
			continue
		}
		if version > s(versions, k) {
			data[k] = v
			versions[k] = version
		}
	}
	return state
}
