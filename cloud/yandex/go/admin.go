package main

import (
	"context"
	"net/url"
	"sort"
	"strings"
	"time"
	_ "time/tzdata"
)

func adminOptions(params url.Values) M {
	bad := func() {
		fail(422, "invalid_admin_range", "Проверьте часовой пояс и интервал (не больше года)")
	}
	zone := params.Get("timeZone")
	if zone == "" {
		zone = "UTC"
	}
	if len(zone) > 80 {
		bad()
	}
	if _, err := time.LoadLocation(zone); err != nil {
		bad()
	}
	from, to := params.Get("from"), params.Get("to")
	out := M{"timeZone": zone}
	if from == "" && to == "" {
		return out
	}
	if !validUTC(from) || !validUTC(to) || from > to || parseTime(to).Sub(parseTime(from)) > 366*24*time.Hour+2*time.Hour {
		bad()
	}
	out["range"] = M{"from": from, "to": to}
	return out
}
func timelineUserIDs(params url.Values) []string {
	ids := []string{}
	for _, id := range strings.Split(params.Get("users"), ",") {
		if id != "" {
			ids = append(ids, id)
		}
	}
	valid := len(ids) >= 1 && len(ids) <= 20 && len(uniq(ids)) == len(ids)
	for _, id := range ids {
		valid = valid && looseUUIDRE.MatchString(id)
	}
	if !valid {
		fail(422, "invalid_timeline_users", "Выберите от 1 до 20 пользователей")
	}
	return ids
}
func timelineEvent(input M) M {
	if input == nil || s(input, "id") == "" || utf16len(s(input, "id")) > 64 || s(input, "sessionId") == "" || utf16len(s(input, "sessionId")) > 64 || !contains([]string{"default", "vps-1", "yandex-1", "vps-direct"}, s(input, "channel")) || parseTime(s(input, "at")).IsZero() || parseTime(s(input, "receivedAt")).IsZero() {
		return nil
	}
	latency := input["latencyMs"]
	if !safeInteger(latency) {
		latency = nil
	}
	var version any
	if _, ok := input["appVersion"].(string); ok {
		version = truncateUTF16(s(input, "appVersion"), 64)
	}
	delta := parseTime(s(input, "at")).Sub(parseTime(s(input, "receivedAt")))
	return M{"id": input["id"], "at": input["at"], "receivedAt": input["receivedAt"], "sessionId": input["sessionId"], "channel": input["channel"], "reason": truncateUTF16(s(input, "reason"), 64), "appVersion": version, "latencyMs": latency, "delayed": delta > 120*time.Second || delta < -120*time.Second}
}
func timelineDevice(device, period M) M {
	inputs := A{device["current"]}
	inputs = append(inputs, list(device, "history")...)
	inputs = append(inputs, list(device, "sessions")...)
	for _, v := range list(device, "receipts") {
		inputs = append(inputs, get(m(v), "observation"))
	}
	events := map[string]M{}
	for _, v := range inputs {
		event := timelineEvent(m(v))
		if event == nil {
			continue
		}
		old := events[s(event, "id")]
		if old == nil || s(event, "receivedAt") < s(old, "receivedAt") {
			events[s(event, "id")] = event
		}
	}
	ordered := []M{}
	sessions := map[string]bool{}
	for _, event := range events {
		ordered = append(ordered, event)
		sessions[s(event, "sessionId")] = true
	}
	sort.Slice(ordered, func(i, j int) bool {
		return s(ordered[i], "at")+"|"+s(ordered[i], "id") < s(ordered[j], "at")+"|"+s(ordered[j], "id")
	})
	inside := []M{}
	context := map[string]M{}
	for _, event := range ordered {
		if s(event, "at") >= s(period, "from") && s(event, "at") <= s(period, "to") {
			inside = append(inside, event)
		}
	}
	close := func(a, b M) bool {
		return a != nil && b != nil && !truth(a["delayed"]) && !truth(b["delayed"]) && parseTime(s(b, "at")).Sub(parseTime(s(a, "at"))) <= 20*time.Minute
	}
	for session := range sessions {
		var before, after M
		selected := []M{}
		for _, event := range ordered {
			if s(event, "sessionId") != session {
				continue
			}
			at := s(event, "at")
			if at < s(period, "from") {
				before = event
			} else if at > s(period, "to") {
				if after == nil {
					after = event
				}
			} else {
				selected = append(selected, event)
			}
		}
		first, last := after, before
		if len(selected) > 0 {
			first = selected[0]
			last = selected[len(selected)-1]
		}
		if close(before, first) {
			context[s(before, "id")] = before
		}
		if close(last, after) {
			context[s(after, "id")] = after
		}
	}
	boundary := []M{}
	for _, v := range context {
		boundary = append(boundary, v)
	}
	sort.Slice(boundary, func(i, j int) bool { return s(boundary[i], "at") < s(boundary[j], "at") })
	capacity := max(0, 128-len(boundary))
	all := append([]M{}, boundary...)
	if capacity > 0 {
		all = append(all, inside[max(0, len(inside)-capacity):]...)
	}
	if len(all) > 128 {
		all = all[len(all)-128:]
	}
	sort.SliceStable(all, func(i, j int) bool { return s(all[i], "at") < s(all[j], "at") })
	current := get(device, "current")
	return M{"deviceId": device["deviceId"], "browser": truncateUTF16(s(current, "browser"), 64), "platform": truncateUTF16(s(current, "platform"), 64), "origin": truncateUTF16(s(current, "origin"), 200), "pwa": b(current, "pwa"), "events": records(all), "truncated": len(boundary)+len(inside) > 128}
}
func adminTimeline(tx Tx, ids []string, period M) M {
	truncated := false
	remaining, count := 6000, 0
	users := A{}
	for _, id := range ids {
		rows := tx.Prefix("device-telemetry", id+":", 33)
		if len(rows) > 8 {
			truncated = true
		}
		sort.SliceStable(rows, func(i, j int) bool { return s(rows[i], "lastSeenAt") > s(rows[j], "lastSeenAt") })
		devices := A{}
		for _, row := range rows[:min(8, len(rows))] {
			if remaining <= 0 || count >= 64 {
				truncated = true
				break
			}
			device := timelineDevice(row, period)
			if b(device, "truncated") {
				truncated = true
			}
			events := list(device, "events")
			if len(events) == 0 {
				continue
			}
			if len(events) > remaining {
				events = events[len(events)-remaining:]
				device["events"] = events
				truncated = true
			}
			remaining -= len(events)
			count++
			devices = append(devices, device)
		}
		users = append(users, M{"id": id, "devices": devices})
	}
	return M{"users": users, "truncated": truncated, "generatedAt": now()}
}
func adminDevices(tx Tx, id string) M {
	rows := tx.Prefix("device-telemetry", id+":", 257)
	devices := A{}
	for _, row := range rows[:min(256, len(rows))] {
		device := pick(row, "deviceId", "firstSeenAt", "lastSeenAt", "current", "sessions", "history")
		timeline := timelineDevice(merge(row, M{"current": nil, "history": A{}, "sessions": A{}}), M{"from": "1970-01-01T00:00:00.000Z", "to": "9999-12-31T23:59:59.999Z"})
		device["events"] = timeline["events"]
		devices = append(devices, device)
	}
	return M{"devices": devices, "truncated": len(rows) > 256}
}
func projectAdminRow(bucket string, value M, key string) M {
	data := get(value, "data")
	if data == nil {
		data = value
	}
	if bucket == "operations" {
		data = get(get(value, "operation"), "message")
	}
	if bucket == "states" {
		data = get(value, "archive")
	}
	row := pick(data, "id", "fromUserId", "toUserId", "groupId", "userId", "ownerId", "messageId", "groupMessageId", "status", "lastSeenAt")
	row["bucket"] = bucket
	row["at"] = data["sentAt"]
	row["opType"] = get(value, "operation")["type"]
	row["size"] = data["confirmedSize"]
	if row["size"] == nil {
		row["size"] = data["requestedSize"]
	}
	row["deletedVersion"] = value["deletedVersion"]
	row["aliveVersion"] = value["aliveVersion"]
	if bucket == "rows:Attachment" {
		row["userId"] = data["uploaderId"]
	}
	if bucket == "user-state" {
		row["userId"] = key
		row["contacts"] = list(value, "contacts")
	}
	return row
}
func adminUsers(tx Tx, options M) M {
	users := tx.Scan("users", 501)
	records := []M{}
	if reader, ok := tx.(adminReader); ok {
		records = reader.AdminRows()
	} else {
		for _, bucket := range []string{"rows:Message", "rows:GroupMessage", "operations", "states", "rows:GroupMember", "rows:Attachment", "device-telemetry", "user-state"} {
			for _, entry := range tx.Entries(bucket, 20001) {
				records = append(records, projectAdminRow(bucket, entry.Value, entry.Key))
			}
		}
	}
	out := summarizeAdmin(users[:min(500, len(users))], records, options)
	out["truncated"] = len(users) > 500 || len(records) >= 20001
	return out
}
func summarizeAdmin(users, records []M, options M) M {
	zone := s(options, "timeZone")
	if zone == "" {
		zone = "UTC"
	}
	loc, _ := time.LoadLocation(zone)
	period := get(options, "range")
	today := time.Now().In(loc).Format("2006-01-02")
	todayTime, _ := time.Parse("2006-01-02", today)
	windowStart := todayTime.AddDate(0, 0, -365).Format("2006-01-02")
	result := []M{}
	byID := map[string]M{}
	chats := map[string]map[string]bool{}
	daily, hourly := map[string]map[string]int{}, map[string]map[string]int{}
	slots := []string{}
	var origin time.Time
	if period != nil {
		from, to := parseTime(s(period, "from")), parseTime(s(period, "to"))
		if to.Sub(from) <= 48*time.Hour {
			local := from.In(loc)
			origin = from.Add(-time.Duration(local.Minute())*time.Minute - time.Duration(local.Second())*time.Second - time.Duration(local.Nanosecond()))
			for at := origin; !at.After(to); at = at.Add(time.Hour) {
				slots = append(slots, iso(at))
			}
		}
	}
	for _, user := range users {
		v := M{"id": user["id"], "name": user["name"], "nickname": nullable(user["nickname"]), "avatarUrl": nullable(user["avatarUrl"]), "avatarBackground": nullable(user["avatarBackground"]), "createdAt": user["createdAt"], "lastSeenAt": nil, "counters": M{"chats": 0, "messages": 0, "attachments": 0, "attachmentBytes": 0}, "daily": A{}, "hourly": A{}}
		result = append(result, v)
		byID[s(user, "id")] = v
	}
	chat := func(uid, id string) {
		if byID[uid] == nil {
			return
		}
		if chats[uid] == nil {
			chats[uid] = map[string]bool{}
		}
		chats[uid][id] = true
	}
	seen := func(uid, at string) {
		u := byID[uid]
		when := parseTime(at)
		if u != nil && !when.IsZero() && !when.After(time.Now().Add(5*time.Minute)) && (s(u, "lastSeenAt") == "" || at > s(u, "lastSeenAt")) {
			u["lastSeenAt"] = at
		}
	}
	messages, files := map[string]M{}, map[string]M{}
	for _, row := range records {
		bucket := s(row, "bucket")
		switch bucket {
		case "rows:Message", "rows:GroupMessage", "states", "operations":
			if bucket == "operations" && s(row, "opType") != "message.create" {
				continue
			}
			if s(row, "id") != "" && s(row, "fromUserId") != "" && !parseTime(s(row, "at")).IsZero() {
				prefix := "m:"
				if truth(row["groupId"]) {
					prefix = "g:"
				}
				messages[prefix+s(row, "id")] = row
			}
		case "device-telemetry":
			seen(s(row, "userId"), s(row, "lastSeenAt"))
		case "rows:GroupMember":
			if s(row, "deletedVersion") == "" || s(row, "deletedVersion") < s(row, "aliveVersion") {
				chat(s(row, "userId"), "g:"+s(row, "groupId"))
			}
		case "user-state":
			for _, v := range list(row, "contacts") {
				if s(m(v), "userId") != "" {
					chat(s(row, "userId"), "m:"+s(m(v), "userId"))
				}
			}
		case "rows:Attachment":
			if s(row, "id") != "" {
				files[s(row, "id")] = row
			}
		}
	}
	for _, row := range files {
		u := byID[s(row, "userId")]
		if u != nil && (truth(row["messageId"]) || truth(row["groupMessageId"])) && s(row, "status") != "deleted" {
			c := get(u, "counters")
			c["attachments"] = n(c["attachments"]) + 1
			c["attachmentBytes"] = n(c["attachmentBytes"]) + n(row["size"])
		}
	}
	for _, row := range messages {
		uid := s(row, "fromUserId")
		u := byID[uid]
		if u != nil {
			c := get(u, "counters")
			c["messages"] = n(c["messages"]) + 1
			seen(uid, s(row, "at"))
			day := parseTime(s(row, "at")).In(loc).Format("2006-01-02")
			if day >= windowStart && day <= today && (period == nil || s(row, "at") >= s(period, "from") && s(row, "at") <= s(period, "to")) {
				if daily[uid] == nil {
					daily[uid] = map[string]int{}
				}
				daily[uid][day]++
				if len(slots) > 0 {
					at := origin.Add(parseTime(s(row, "at")).Sub(origin) / time.Hour * time.Hour)
					if hourly[uid] == nil {
						hourly[uid] = map[string]int{}
					}
					hourly[uid][iso(at)]++
				}
			}
		}
		if truth(row["groupId"]) {
			chat(uid, "g:"+s(row, "groupId"))
		} else if truth(row["toUserId"]) {
			chat(uid, "m:"+s(row, "toUserId"))
			chat(s(row, "toUserId"), "m:"+uid)
		}
	}
	for _, u := range result {
		uid := s(u, "id")
		get(u, "counters")["chats"] = len(chats[uid])
		hours, days := A{}, A{}
		for _, at := range slots {
			hours = append(hours, M{"at": at, "count": hourly[uid][at]})
		}
		dayKeys := []string{}
		for day := range daily[uid] {
			dayKeys = append(dayKeys, day)
		}
		sort.Strings(dayKeys)
		for _, day := range dayKeys {
			days = append(days, M{"day": day, "count": daily[uid][day]})
		}
		u["hourly"], u["daily"] = hours, days
	}
	sort.SliceStable(result, func(i, j int) bool {
		return str(or(result[i]["lastSeenAt"], result[i]["createdAt"])) > str(or(result[j]["lastSeenAt"], result[j]["createdAt"]))
	})
	return M{"users": recordsOf(result), "timeZone": zone, "range": period, "windowStart": windowStart, "today": today, "generatedAt": now()}
}
func recordsOf(v []M) A { return records(v) }
func (sv *Service) admin(ctx context.Context, user M, action string, params url.Values) M {
	allowed := false
	for _, id := range strings.Split(s(sv.Config, "adminIDs"), ",") {
		if strings.TrimSpace(id) == s(user, "id") {
			allowed = true
		}
	}
	if action == "access" {
		return M{"admin": allowed}
	}
	if !allowed {
		fail(403, "admin_required", "Доступ только для администратора")
	}
	return m(sv.transaction(ctx, true, func(tx Tx) any {
		switch action {
		case "users":
			return adminUsers(tx, adminOptions(params))
		case "devices":
			if !looseUUIDRE.MatchString(params.Get("userId")) {
				fail(422, "invalid_user", "Некорректный UUID")
			}
			return adminDevices(tx, params.Get("userId"))
		case "timeline":
			ids := timelineUserIDs(params)
			options := adminOptions(params)
			period := get(options, "range")
			if period == nil {
				fail(422, "missing_range", "Выберите интервал")
			}
			return adminTimeline(tx, ids, period)
		}
		fail(404, "not_found", "Не найдено")
		return nil
	}))
}
