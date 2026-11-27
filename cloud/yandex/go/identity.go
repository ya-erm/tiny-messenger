package main

import (
	"context"
	"regexp"
	"sort"
	"strings"
	"time"
)

var nicknameRE = regexp.MustCompile(`^[a-z0-9_.-]{1,32}$`)
var colorRE = regexp.MustCompile(`(?i)^#[0-9a-f]{6}$`)
var tokenRE = regexp.MustCompile(`^msg_[A-Za-z0-9_-]{16}$`)
var uuidV4RE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

func publicUser(user M) M {
	out := pick(user, "id", "name", "createdAt")
	for _, k := range []string{"nickname", "avatarUrl", "avatarBackground"} {
		if truth(user[k]) {
			out[k] = user[k]
		}
	}
	return out
}
func parseUser(v M) M {
	if v == nil || !validUUID(v["id"]) || runeCount(s(v, "name")) < 1 || runeCount(s(v, "name")) > 20 || !validUTC(v["createdAt"]) || !validUTC(v["updatedAt"]) || !hashRE.MatchString(s(v, "tokenHash")) {
		invalid("replicated user")
	}
	if v["nickname"] != nil && !nicknameRE.MatchString(s(v, "nickname")) {
		invalid("replicated user")
	}
	if v["avatarUrl"] != nil && (utf16len(s(v, "avatarUrl")) > 500 || !(strings.HasPrefix(s(v, "avatarUrl"), "http://") || strings.HasPrefix(s(v, "avatarUrl"), "https://"))) {
		invalid("replicated user")
	}
	if v["avatarBackground"] != nil && !colorRE.MatchString(s(v, "avatarBackground")) {
		invalid("replicated user")
	}
	return pick(v, "id", "name", "nickname", "avatarUrl", "avatarBackground", "tokenHash", "createdAt", "updatedAt")
}
func parseContact(v M) M {
	if v == nil || !validUUID(v["id"]) || !validUUID(v["ownerId"]) || !validUUID(v["userId"]) || s(v, "ownerId") == s(v, "userId") || !validUTC(v["at"]) || !validUTC(v["createdAt"]) {
		invalid("contact operation")
	}
	if _, ok := v["deleted"].(bool); !ok {
		invalid("contact operation")
	}
	return v
}
func parseIdentity(v M) M {
	if v == nil || n(v["version"]) != 1 || !validUUID(v["id"]) || !validUUID(v["userId"]) || !validUTC(v["at"]) || !contains([]string{"token", "profile"}, s(v, "kind")) {
		invalid("identity operation")
	}
	if s(v, "kind") == "token" {
		if !hashRE.MatchString(s(v, "tokenHash")) || !hashRE.MatchString(s(v, "previousTokenHash")) || s(v, "tokenHash") == s(v, "previousTokenHash") {
			invalid("credential change")
		}
		return pick(v, "version", "id", "userId", "at", "kind", "tokenHash", "previousTokenHash")
	}
	p := get(v, "profile")
	if !validUTC(v["nicknameAt"]) || s(v, "nicknameAt") > s(v, "at") || p == nil {
		invalid("profile change")
	}
	parseUser(merge(p, M{"id": v["userId"], "createdAt": v["at"], "updatedAt": v["at"], "tokenHash": strings.Repeat("0", 64)}))
	return merge(pick(v, "version", "id", "userId", "at", "kind", "nicknameAt"), M{"profile": M{"name": p["name"], "nickname": nullable(p["nickname"]), "avatarUrl": nullable(p["avatarUrl"]), "avatarBackground": nullable(p["avatarBackground"])}})
}
func nullable(v any) any {
	if truth(v) {
		return v
	}
	return nil
}
func identityOrder(v M) string { return s(v, "at") + "|" + s(v, "id") }
func nextIdentityTime(previous M) string {
	t := time.Now()
	if p := parseTime(s(previous, "at")).Add(time.Millisecond); p.After(t) {
		t = p
	}
	return iso(t)
}
func applyIdentity(tx Tx, input M) bool {
	op := parseIdentity(input)
	if saved := tx.Get("identity-operations", s(op, "id")); saved != nil {
		if !equal(saved, op) {
			panicError("Identity operation ID conflict")
		}
		return false
	}
	user := tx.Get("users", s(op, "userId"))
	if user == nil {
		panicError("Identity user missing")
	}
	state := copyMap(tx.Get("identity-state", s(user, "id")))
	previous := get(state, s(op, "kind"))
	tx.Put("identity-operations", s(op, "id"), op)
	if previous != nil && identityOrder(previous) >= identityOrder(op) {
		return false
	}
	state[s(op, "kind")] = op
	tx.Put("identity-state", s(user, "id"), state)
	updated := copyMap(user)
	if s(op, "at") > s(user, "updatedAt") {
		updated["updatedAt"] = op["at"]
	}
	if s(op, "kind") == "token" {
		updated["tokenHash"] = op["tokenHash"]
		tx.Put("tokens", s(op, "tokenHash"), M{"userId": user["id"]})
		tx.Put("users", s(user, "id"), updated)
	} else {
		updated = merge(updated, get(op, "profile"))
		reconcileNicknames(tx, updated, state)
	}
	return true
}
func reconcileNicknames(tx Tx, replacement, state M) {
	users := tx.Scan("users", 10001)
	if len(users) >= 10001 {
		panicError("Identity registry capacity")
	}
	states := map[string]M{}
	for _, e := range tx.Entries("identity-state", 10001) {
		states[e.Key] = e.Value
	}
	claims := map[string]M{}
	for _, e := range tx.Entries("nickname-claims", 10001) {
		claims[e.Key] = e.Value
	}
	type claim struct {
		user         M
		nickname, at string
	}
	items := []claim{}
	winners := map[string]string{}
	for _, u := range users {
		id := s(u, "id")
		st := states[id]
		user := u
		if id == s(replacement, "id") {
			st = state
			user = replacement
		}
		profile := get(st, "profile")
		nickname := s(u, "nickname")
		at := s(u, "createdAt")
		if profile != nil {
			nickname = s(get(profile, "profile"), "nickname")
			at = s(profile, "nicknameAt")
		} else if c := claims[id]; s(c, "nickname") == nickname && c != nil {
			at = s(c, "at")
		}
		items = append(items, claim{user, nickname, at})
		order := at + "|" + id
		if nickname != "" && (winners[nickname] == "" || order < winners[nickname]) {
			winners[nickname] = order
		}
	}
	for _, item := range items {
		next := copyMap(item.user)
		next["nickname"] = nil
		if item.nickname != "" && winners[item.nickname] == item.at+"|"+s(item.user, "id") {
			next["nickname"] = item.nickname
		}
		tx.Put("users", s(next, "id"), next)
	}
}
func panicError(v string) { panic(&internalError{v}) }

type internalError struct{ message string }

func (e *internalError) Error() string { return e.message }

type Service struct {
	Storage  FileStorage
	Database Database
	ID       string
	Config   M
}

func (sv *Service) transaction(ctx context.Context, ro bool, fn func(Tx) any) any {
	v, err := sv.Database.Transaction(ctx, ro, fn)
	if err != nil {
		panic(err)
	}
	return v
}
func (sv *Service) authenticateTx(tx Tx, token string) M {
	if token == "" {
		fail(401, "missing_token", "Укажите токен")
	}
	var user M
	if strings.HasPrefix(token, "tmw_") {
		claims := webClaims(token, sv.Config)
		user = tx.Get("users", s(claims, "userId"))
		if user == nil || sha(s(user, "tokenHash")) != s(claims, "generation") {
			fail(401, "invalid_token", "Токен недействителен")
		}
	} else {
		h := sha(token)
		index := tx.Get("tokens", h)
		if index != nil {
			user = tx.Get("users", s(index, "userId"))
		}
		if user == nil || s(user, "tokenHash") != h {
			fail(401, "invalid_token_in_channel", "Токен пока не известен этому каналу")
		}
	}
	return user
}
func (sv *Service) authenticate(ctx context.Context, token string) M {
	return m(sv.transaction(ctx, true, func(tx Tx) any { return sv.authenticateTx(tx, token) }))
}
func (sv *Service) rotateToken(ctx context.Context, token string, body M) M {
	stable := own(body, "operationId") || own(body, "replacementToken")
	id, replacement := uuid(), randomToken()
	if stable {
		if !uuidV4RE.MatchString(s(body, "operationId")) || !tokenRE.MatchString(s(body, "replacementToken")) {
			fail(422, "invalid_token_change", "Некорректный запрос замены токена")
		}
		id, replacement = s(body, "operationId"), s(body, "replacementToken")
	}
	if own(body, "changedAt") && !validUTC(body["changedAt"]) {
		fail(422, "invalid_token_change", "Некорректное время операции")
	}
	var session M
	if strings.HasPrefix(token, "tmw_") {
		session = webClaims(token, sv.Config)
	}
	callerHash, newHash := sha(token), sha(replacement)
	return m(sv.transaction(ctx, false, func(tx Tx) any {
		if receipt := tx.Get("identity-operations", id); receipt != nil {
			user := tx.Get("users", s(receipt, "userId"))
			valid := s(receipt, "previousTokenHash") == callerHash
			if session != nil {
				valid = s(receipt, "userId") == s(session, "userId") && sha(s(receipt, "previousTokenHash")) == s(session, "generation")
			}
			if s(receipt, "kind") != "token" || !valid || s(receipt, "tokenHash") != newHash || s(user, "tokenHash") != newHash || own(body, "changedAt") && s(receipt, "at") != s(body, "changedAt") {
				fail(409, "token_change_conflict", "Замена токена конфликтует с другой операцией")
			}
			return M{"token": replacement}
		}
		var index M
		if session != nil {
			index = M{"userId": session["userId"]}
		} else {
			index = tx.Get("tokens", callerHash)
		}
		user := tx.Get("users", s(index, "userId"))
		valid := s(user, "tokenHash") == callerHash
		if session != nil {
			valid = sha(s(user, "tokenHash")) == s(session, "generation")
		}
		if user == nil || !valid {
			fail(401, "invalid_token", "Токен недействителен")
		}
		if parseTime(s(body, "changedAt")).After(time.Now().Add(5 * time.Minute)) {
			fail(422, "invalid_token_change", "Проверьте часы устройства")
		}
		if s(user, "tokenHash") == newHash || tx.Get("tokens", newHash) != nil {
			fail(409, "token_taken", "Такой токен уже используется")
		}
		state := tx.Get("identity-state", s(user, "id"))
		previous := get(state, "token")
		if previous == nil {
			previous = M{"at": user["createdAt"]}
		}
		at := s(body, "changedAt")
		if at == "" {
			at = nextIdentityTime(previous)
		}
		op := M{"version": 1, "id": id, "userId": user["id"], "kind": "token", "at": at, "tokenHash": newHash, "previousTokenHash": user["tokenHash"]}
		applyIdentity(tx, op)
		if s(tx.Get("users", s(user, "id")), "tokenHash") != newHash {
			fail(409, "token_change_conflict", "Уже применена более новая замена токена")
		}
		appendReplication(tx, "identity:"+id, M{"type": "identity", "operation": op})
		return M{"token": replacement}
	}))
}
func (sv *Service) updateProfile(ctx context.Context, actor, body M) M {
	return m(sv.transaction(ctx, false, func(tx Tx) any {
		user := tx.Get("users", s(actor, "id"))
		if user == nil || s(user, "tokenHash") != s(actor, "tokenHash") {
			fail(401, "invalid_token", "Токен недействителен")
		}
		state := tx.Get("identity-state", s(user, "id"))
		at := nextIdentityTime(get(state, "profile"))
		p := M{"name": clean(body["name"]), "nickname": nullable(user["nickname"]), "avatarUrl": nullable(clean(body["avatarUrl"])), "avatarBackground": nullable(user["avatarBackground"])}
		if own(body, "nickname") {
			p["nickname"] = nullable(strings.ToLower(strings.TrimPrefix(clean(body["nickname"]), "@")))
		}
		if own(body, "avatarBackground") {
			p["avatarBackground"] = nullable(clean(body["avatarBackground"]))
		}
		if truth(p["nickname"]) {
			for _, u := range tx.Scan("users", 10001) {
				if s(u, "id") != s(user, "id") && s(u, "nickname") == s(p, "nickname") {
					fail(409, "nickname_taken", "Этот ник уже занят")
				}
			}
		}
		nicknameAt := at
		if nullable(p["nickname"]) == nullable(user["nickname"]) {
			nicknameAt = s(get(state, "profile"), "nicknameAt")
			if nicknameAt == "" {
				nicknameAt = s(tx.Get("nickname-claims", s(user, "id")), "at")
			}
			if nicknameAt == "" {
				nicknameAt = s(user, "createdAt")
			}
		}
		op := M{"version": 1, "id": uuid(), "userId": user["id"], "kind": "profile", "at": at, "nicknameAt": nicknameAt, "profile": p}
		_, err := caught(func() any { return parseIdentity(op) })
		if err != nil {
			fail(422, "invalid_profile", "Проверьте имя, ник и аватарку")
		}
		applyIdentity(tx, op)
		appendReplication(tx, "identity:"+s(op, "id"), M{"type": "identity", "operation": op})
		tx.AddFeed(s(user, "id"), tx.NextSequence(), M{"type": "snapshot.required"})
		return M{"user": tx.Get("users", s(user, "id"))}
	}))
}
func parseExternal(v M) M {
	if n(v["version"]) != 1 || !validUUID(v["id"]) || !validUUID(v["userId"]) || !hashRE.MatchString(s(v, "subjectHash")) || s(v, "provider") != "yandex" || !validUTC(v["at"]) {
		invalid("external link")
	}
	if _, ok := v["deleted"].(bool); !ok {
		invalid("external link")
	}
	if _, ok := v["label"].(string); !ok || utf16len(s(v, "label")) > 80 {
		invalid("external link")
	}
	return pick(v, "version", "id", "userId", "subjectHash", "provider", "at", "deleted", "label")
}
func applyExternal(tx Tx, input M) bool {
	op := parseExternal(input)
	if saved := tx.Get("external-operations", s(op, "id")); saved != nil {
		if !equal(saved, op) {
			panicError("External operation ID conflict")
		}
		return false
	}
	if tx.Get("users", s(op, "userId")) == nil {
		panicError("External user missing")
	}
	index := copyMap(tx.Get("external-subjects", s(op, "subjectHash")))
	claims := copyMap(get(index, "claims"))
	old := get(claims, s(op, "userId"))
	if old == nil || identityOrder(op) > identityOrder(old) {
		claims[s(op, "userId")] = op
	}
	tx.Put("external-subjects", s(op, "subjectHash"), M{"claims": claims})
	current := tx.Get("external-users", s(op, "userId"))
	if current == nil || identityOrder(op) > identityOrder(current) {
		tx.Put("external-users", s(op, "userId"), op)
	}
	tx.Put("external-operations", s(op, "id"), op)
	return true
}
func externalOwners(tx Tx, hash string) []string {
	out := []string{}
	for id, value := range get(tx.Get("external-subjects", hash), "claims") {
		op := m(value)
		current := tx.Get("external-users", id)
		if !b(op, "deleted") && s(current, "id") == s(op, "id") && !b(current, "deleted") {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}
func externalStatus(tx Tx, id string) M {
	link := tx.Get("external-users", id)
	if link == nil || b(link, "deleted") {
		return M{"linked": false}
	}
	return M{"linked": true, "label": link["label"], "conflict": len(externalOwners(tx, s(link, "subjectHash"))) > 1, "linkedAt": link["at"]}
}
