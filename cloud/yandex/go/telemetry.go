package main

import (
	"context"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

var telemetryModes = []string{"auto", "default", "vps-1", "yandex-1", "vps-direct"}
var telemetryReasons = []string{"startup", "manual", "latency", "unavailable", "primary", "primary-restored", "primary-fallback", "heartbeat", "resume"}

func parseObservation(v M) M {
	for _, k := range []string{"id", "userId", "deviceId", "sessionId"} {
		if !validUUID(v[k]) {
			invalid("channel observation")
		}
	}
	if !safeInteger(v["sequence"]) || n(v["sequence"]) < 1 || !validUTC(v["at"]) || !validUTC(v["receivedAt"]) || !contains(telemetryModes, s(v, "mode")) || !contains(telemetryModes, s(v, "channel")) || s(v, "channel") == "auto" || !contains(telemetryReasons, s(v, "reason")) {
		invalid("channel observation")
	}
	if _, ok := v["pwa"].(bool); !ok {
		invalid("channel observation")
	}
	if v["latencyMs"] != nil && (!safeInteger(v["latencyMs"]) || n(v["latencyMs"]) < 0 || n(v["latencyMs"]) > 120000) {
		invalid("channel observation")
	}
	for _, key := range []string{"browser", "platform", "appVersion", "installationId"} {
		if _, ok := v[key].(string); !ok || utf16len(s(v, key)) > 64 {
			invalid("device metadata")
		}
	}
	origin := s(v, "origin")
	u, err := url.Parse(origin)
	if err != nil || utf16len(origin) > 200 || u.Host == "" || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || origin != u.Scheme+"://"+u.Host || u.Scheme != "https" && (u.Scheme != "http" || u.Hostname() != "localhost" && u.Hostname() != "127.0.0.1") {
		invalid("device origin")
	}
	return pick(v, "id", "userId", "deviceId", "sessionId", "sequence", "at", "mode", "channel", "reason", "latencyMs", "browser", "platform", "pwa", "appVersion", "origin", "receivedAt", "installationId")
}
func observationOrder(v M) string {
	seq := strconv.FormatInt(int64(n(v["sequence"])), 10)
	return strings.Repeat("0", max(0, 16-len(seq))) + seq + "|" + s(v, "at") + "|" + s(v, "id")
}
func sortedObservations(values map[string]M, limit int, tail bool) A {
	out := []M{}
	for _, v := range values {
		out = append(out, v)
	}
	sort.SliceStable(out, func(i, j int) bool { return observationOrder(out[i]) < observationOrder(out[j]) })
	if tail {
		if len(out) > limit {
			out = out[len(out)-limit:]
		}
	} else {
		sort.SliceStable(out, func(i, j int) bool { return observationOrder(out[i]) > observationOrder(out[j]) })
		if len(out) > limit {
			out = out[:limit]
		}
	}
	return records(out)
}
func storeObservation(tx Tx, input M, enforce bool) bool {
	event := parseObservation(input)
	key := s(event, "userId") + ":" + s(event, "deviceId")
	if tx.Get("users", s(event, "userId")) == nil {
		panicError("Telemetry user missing")
	}
	previous := tx.Get("device-telemetry", key)
	if previous == nil {
		devices := tx.Prefix("device-telemetry", s(event, "userId")+":", 257)
		if enforce && len(devices) >= 64 {
			panicError("Device limit reached")
		}
		if len(devices) >= 256 {
			return false
		}
	}
	var older M
	for _, v := range list(previous, "receipts") {
		if s(m(v), "id") == s(event, "id") {
			older = get(m(v), "observation")
			break
		}
	}
	if older == nil {
		for _, v := range list(previous, "history") {
			if s(m(v), "id") == s(event, "id") {
				older = m(v)
				break
			}
		}
	}
	if older == nil && s(get(previous, "current"), "id") == s(event, "id") {
		older = get(previous, "current")
	}
	if older != nil {
		fingerprint := func(v M) string { return encode(merge(v, M{"receivedAt": "", "installationId": ""})) }
		if fingerprint(older) != fingerprint(event) {
			panicError("Telemetry event ID conflict")
		}
		if s(older, "receivedAt")+"|"+s(older, "installationId") <= s(event, "receivedAt")+"|"+s(event, "installationId") {
			return false
		}
	}
	latest := get(previous, "current")
	if latest == nil || s(latest, "id") == s(event, "id") || observationOrder(event) > observationOrder(latest) {
		latest = event
	}
	sessions, history, receipts := map[string]M{}, map[string]M{}, map[string]M{}
	for _, v := range list(previous, "sessions") {
		sessions[s(m(v), "sessionId")] = m(v)
	}
	session := sessions[s(event, "sessionId")]
	if session == nil || s(session, "id") == s(event, "id") || observationOrder(event) > observationOrder(session) {
		sessions[s(event, "sessionId")] = event
	}
	for _, v := range list(previous, "history") {
		history[s(m(v), "id")] = m(v)
	}
	if s(event, "reason") != "heartbeat" {
		history[s(event, "id")] = event
	}
	for _, v := range list(previous, "receipts") {
		receipts[s(m(v), "id")] = get(m(v), "observation")
	}
	receipts[s(event, "id")] = event
	receiptList := A{}
	for _, v := range sortedObservations(receipts, 32, true) {
		receiptList = append(receiptList, M{"id": m(v)["id"], "observation": v})
	}
	first := s(event, "receivedAt")
	if s(previous, "firstSeenAt") != "" && s(previous, "firstSeenAt") < first {
		first = s(previous, "firstSeenAt")
	}
	tx.Put("device-telemetry", key, M{"userId": event["userId"], "deviceId": event["deviceId"], "firstSeenAt": first, "lastSeenAt": latest["receivedAt"], "current": latest, "sessions": sortedObservations(sessions, 8, false), "history": sortedObservations(history, 128, true), "receipts": receiptList})
	return true
}
func queueObservation(tx Tx, event M) {
	key := s(event, "userId") + ":" + s(event, "deviceId")
	old := tx.Get("telemetry-outbox", key)
	items := A{}
	for _, v := range list(old, "items") {
		if s(m(v), "id") != s(event, "id") {
			items = append(items, v)
		}
	}
	items = append(items, event)
	if len(items) > 32 {
		items = items[len(items)-32:]
	}
	tx.Put("telemetry-outbox", key, M{"items": items})
}
func acknowledgeObservations(tx Tx, events A) {
	ids, keys := map[string]bool{}, map[string]bool{}
	for _, v := range events {
		event := m(v)
		ids[s(event, "id")] = true
		keys[s(event, "userId")+":"+s(event, "deviceId")] = true
	}
	for key := range keys {
		old := tx.Get("telemetry-outbox", key)
		if old == nil {
			continue
		}
		items := A{}
		for _, v := range list(old, "items") {
			if !ids[s(m(v), "id")] {
				items = append(items, v)
			}
		}
		if len(items) > 0 {
			tx.Put("telemetry-outbox", key, M{"items": items})
		} else {
			tx.Delete("telemetry-outbox", key)
		}
	}
}
func (sv *Service) telemetry(ctx context.Context, actor, body M) M {
	value, err := caught(func() any {
		return parseObservation(merge(body, M{"userId": actor["id"], "receivedAt": now(), "installationId": sv.ID}))
	})
	if err != nil {
		fail(422, "invalid_telemetry", "Некорректные данные устройства")
	}
	event := m(value)
	return m(sv.transaction(ctx, false, func(tx Tx) any {
		if storeObservation(tx, event, true) {
			queueObservation(tx, event)
		}
		return M{"accepted": true, "id": event["id"]}
	}))
}
