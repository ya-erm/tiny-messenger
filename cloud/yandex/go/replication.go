package main

import (
	"context"
	"crypto/subtle"
	"strconv"
)

func authorizePeer(headers map[string]string, secret string) {
	supplied := headers["x-tm-replication-key"]
	if len(secret) < 32 || len(supplied) != len(secret) || subtle.ConstantTimeCompare([]byte(secret), []byte(supplied)) != 1 {
		fail(401, "peer_unauthorized", "Недоступно")
	}
}
func (sv *Service) importDirectory(ctx context.Context, directory M) {
	for _, key := range []string{"users", "contacts", "receipts"} {
		if !isArray(directory[key]) || len(list(directory, key)) > 500 {
			fail(422, "invalid_directory", "Некорректный справочник")
		}
	}
	for _, v := range list(directory, "users") {
		input := m(v)
		if !looseUUIDRE.MatchString(s(input, "id")) || s(input, "name") == "" || !hashRE.MatchString(s(input, "tokenHash")) {
			fail(422, "invalid_directory_user", "Некорректный пользователь")
		}
		base := nonnull(input, "id", "name", "nickname", "avatarUrl", "avatarBackground", "tokenHash", "createdAt", "updatedAt")
		sv.transaction(ctx, false, func(tx Tx) any {
			user := copyMap(base)
			if claim := get(input, "nicknameClaim"); claim != nil {
				tx.Put("nickname-claims", s(user, "id"), claim)
			}
			previous := tx.Get("users", s(user, "id"))
			identity := tx.Get("identity-state", s(user, "id"))
			if previous != nil && get(identity, "token") != nil {
				user["tokenHash"] = previous["tokenHash"]
			}
			if previous != nil && get(identity, "profile") != nil {
				for _, key := range []string{"name", "nickname", "avatarUrl", "avatarBackground"} {
					if previous[key] != nil {
						user[key] = previous[key]
					} else {
						delete(user, key)
					}
				}
			}
			if previous != nil && s(previous, "updatedAt") > s(user, "updatedAt") {
				user["updatedAt"] = previous["updatedAt"]
			}
			if !equal(previous, user) {
				tx.Put("users", s(user, "id"), user)
			}
			if previous == nil || s(previous, "tokenHash") != s(user, "tokenHash") {
				tx.Put("tokens", s(user, "tokenHash"), M{"userId": user["id"]})
			}
			for _, operation := range get(input, "identity") {
				applyIdentity(tx, m(operation))
			}
			if external := get(input, "externalIdentity"); external != nil {
				applyExternal(tx, external)
			}
			return nil
		})
	}
	sv.transaction(ctx, false, func(tx Tx) any { reconcileNicknames(tx, nil, nil); return nil })
	for _, v := range list(directory, "contacts") {
		state := m(v)
		sv.transaction(ctx, false, func(tx Tx) any {
			if tx.Get("users", s(state, "userId")) == nil || !isArray(state["contacts"]) || len(list(state, "contacts")) > 500 {
				fail(422, "invalid_directory_contacts", "Некорректные контакты")
			}
			before := copyMap(tx.Get("user-state", s(state, "userId")))
			if !equal(list(before, "contacts"), list(state, "contacts")) {
				before["contacts"] = state["contacts"]
				tx.Put("user-state", s(state, "userId"), before)
				tx.AddFeed(s(state, "userId"), tx.NextSequence(), M{"type": "snapshot.required"})
			}
			return nil
		})
	}
	for _, v := range list(directory, "receipts") {
		sv.importReceipt(ctx, m(v))
	}
}
func parseCursor(value any) string {
	v := str(value)
	if !sequenceRE.MatchString(v) {
		invalid("replication cursor")
	}
	if _, err := strconv.ParseUint(v, 10, 64); err != nil {
		invalid("replication cursor")
	}
	return v
}
func (sv *Service) exchange(ctx context.Context, body M) M {
	v, err := caught(func() any { return parseCursor(body["after"]) })
	if err != nil {
		fail(422, "invalid_peer_cursor", "Некорректный курсор")
	}
	after := str(v)
	if n(body["protocolVersion"]) != 1 || s(body, "sourceId") != str(or(sv.Config["peerID"], "vps-1")) || s(body, "targetId") != sv.ID || !isArray(body["operations"]) || len(list(body, "operations")) > 5 || own(body, "rows") && (!isArray(body["rows"]) || len(list(body, "rows"))+len(list(body, "operations")) > 5) {
		fail(422, "invalid_peer_envelope", "Некорректный пакет репликации")
	}
	if len(list(body, "rows")) > 0 && n(body["rowProtocolVersion"]) != 1 {
		fail(409, "row_protocol_mismatch", "Нужна совместимая версия обмена")
	}
	if own(body, "telemetryAcks") && (!isArray(body["telemetryAcks"]) || len(list(body, "telemetryAcks")) > 5) {
		fail(422, "invalid_telemetry_ack", "Некорректное подтверждение")
	}
	if len(list(body, "telemetryAcks")) > 0 {
		events := A{}
		for _, v := range list(body, "telemetryAcks") {
			events = append(events, parseObservation(m(v)))
		}
		sv.transaction(ctx, false, func(tx Tx) any { acknowledgeObservations(tx, events); return nil })
	}
	if own(body, "telemetry") && (!isArray(body["telemetry"]) || len(list(body, "telemetry")) > 5) {
		fail(422, "invalid_telemetry_batch", "Некорректный пакет устройств")
	}
	if directory := get(body, "directory"); directory != nil {
		sv.importDirectory(ctx, directory)
	}
	for _, v := range list(body, "telemetry") {
		sv.transaction(ctx, false, func(tx Tx) any { return storeObservation(tx, m(v), false) })
	}
	for _, v := range list(body, "operations") {
		sv.importMutation(ctx, m(v), s(body, "sourceId"))
	}
	for _, v := range list(body, "rows") {
		if s(m(v), "origin") != s(body, "sourceId") {
			fail(422, "row_origin_mismatch", "Неверный источник изменения")
		}
	}
	if len(list(body, "rows")) > 0 {
		sv.rowsTransaction(ctx, false, func(r *Rows) any {
			for _, v := range list(body, "rows") {
				r.apply(m(v), false)
			}
			return nil
		})
	}
	return m(sv.transaction(ctx, true, func(tx Tx) any {
		min, _ := strconv.ParseUint(after, 10, 64)
		current, _ := strconv.ParseUint(tx.Sequence(), 10, 64)
		if min > current {
			fail(409, "peer_cursor_ahead", "Курсор опережает журнал")
		}
		events := tx.Feed(replicationFeed, after, 6)
		more := len(events) > 5
		if more {
			events = events[:5]
		}
		for len(events) > 1 && len(encode(events)) > 420*1024 {
			events = events[:len(events)-1]
			more = true
		}
		protocol := int(n(body["userProtocolVersion"]))
		for _, event := range events {
			switch s(event, "type") {
			case "user", "contact":
				if protocol < 1 || protocol > 4 {
					fail(409, "user_protocol_unavailable", "Нужна совместимая версия обмена аккаунтами")
				}
			case "identity":
				if protocol < 2 || protocol > 4 {
					fail(409, "identity_protocol_unavailable", "Нужна совместимая версия обмена профилями")
				}
			case "telemetry":
				if protocol < 3 || protocol > 4 {
					fail(409, "telemetry_protocol_unavailable", "Нужна совместимая версия обмена")
				}
			case "external":
				if protocol != 4 {
					fail(409, "external_protocol_unavailable", "Нужна совместимая версия обмена аккаунтами")
				}
			}
		}
		telemetry := A{}
		if protocol == 3 || protocol == 4 {
			for _, item := range tx.Entries("telemetry-outbox", 5) {
				telemetry = append(telemetry, list(item.Value, "items")...)
			}
			if len(telemetry) > 5 {
				telemetry = telemetry[:5]
			}
		}
		ids := []string{}
		add := func(id string) {
			if id != "" && !contains(ids, id) {
				ids = append(ids, id)
			}
		}
		for _, v := range telemetry {
			add(s(m(v), "userId"))
		}
		for _, event := range events {
			switch s(event, "type") {
			case "telemetry":
				add(s(get(event, "observation"), "userId"))
			case "external", "identity":
				add(s(get(event, "operation"), "userId"))
			case "user":
				add(s(get(event, "user"), "id"))
			case "contact":
				add(s(get(event, "contact"), "ownerId"))
				add(s(get(event, "contact"), "userId"))
			}
		}
		for _, event := range events {
			if s(event, "type") == "mutation" {
				operation := get(event, "operation")
				add(s(operation, "actorId"))
				if s(operation, "type") == "message.create" {
					add(s(get(operation, "message"), "fromUserId"))
					add(s(get(operation, "message"), "toUserId"))
				}
			}
		}
		for _, event := range events {
			if s(event, "type") == "receipt" {
				add(s(event, "userId"))
				add(s(event, "peerId"))
			}
		}
		for _, event := range events {
			if s(event, "type") == "row" {
				patch := get(get(event, "operation"), "patch")
				for _, key := range []string{"fromUserId", "toUserId", "ownerId", "uploaderId", "userId", "peerId"} {
					add(s(patch, key))
				}
			}
		}
		users := A{}
		for _, id := range ids {
			user := tx.Get("users", id)
			if user != nil {
				identity := tx.Get("identity-state", id)
				if identity == nil {
					identity = M{}
				}
				users = append(users, merge(user, M{"identity": identity, "externalIdentity": withExternalProfile(tx.Get("external-users", id), tx.Get("external-profile", id))}))
			}
		}
		cursor := after
		if len(events) > 0 {
			cursor = s(events[len(events)-1], "sequence")
		}
		return M{"users": users, "userProtocolVersion": 4, "rowProtocolVersion": 1, "protocolVersion": 1, "sourceId": sv.ID, "targetId": body["sourceId"], "events": records(events), "telemetry": telemetry, "cursor": cursor, "hasMore": more}
	}))
}
