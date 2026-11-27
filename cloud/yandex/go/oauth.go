package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var sessionKeyRE = regexp.MustCompile(`^[a-f0-9]{64,}$`)
var challengeRE = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
var verifierRE = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
var controlRE = regexp.MustCompile(`[\x00-\x1f\x7f]`)

func shaURL(v string) string {
	h := sha256.Sum256([]byte(v))
	return base64.RawURLEncoding.EncodeToString(h[:])
}
func configOrigins(config M) []string { return stringsOf(list(config, "origins")) }
func yandexAvailable(config M) bool {
	return s(config, "clientId") != "" && s(config, "clientSecret") != "" && sessionKeyRE.MatchString(s(config, "sessionKey")) && len(configOrigins(config)) > 0
}
func sign(prefix string, value M, key string) string {
	data := base64.RawURLEncoding.EncodeToString([]byte(encode(value)))
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(prefix + data))
	return prefix + data + "." + base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}
func verify(prefix, token, key string) M {
	bad := func() {
		fail(401, "invalid_token", "Недействительное подтверждение входа")
	}
	if !strings.HasPrefix(token, prefix) || len(token) > 4096 || !sessionKeyRE.MatchString(key) {
		bad()
	}
	parts := strings.Split(strings.TrimPrefix(token, prefix), ".")
	if len(parts) != 2 {
		bad()
	}
	h := hmac.New(sha256.New, []byte(key))
	h.Write([]byte(prefix + parts[0]))
	provided, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(provided, h.Sum(nil)) {
		bad()
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		bad()
	}
	value, e := caught(func() any { return decode(string(data)) })
	if e != nil {
		bad()
	}
	v := m(value)
	if n(v["v"]) != 1 || !safeInteger(v["exp"]) || n(v["exp"]) <= float64(time.Now().Unix()) {
		fail(401, "invalid_token", "Срок подтверждения входа истёк")
	}
	return v
}
func safeInteger(v any) bool {
	switch v.(type) {
	case int, int64, uint64, float64, json.Number:
	default:
		return false
	}
	x := n(v)
	return x >= -9007199254740991 && x <= 9007199254740991 && x == float64(int64(x))
}
func webClaims(token string, config M) M {
	v := verify("tmw_", token, s(config, "sessionKey"))
	if s(v, "userId") == "" || !hashRE.MatchString(s(v, "generation")) || !safeInteger(v["iat"]) || n(v["exp"])-n(v["iat"]) > 30*86400 || n(v["iat"]) > float64(time.Now().Unix()+60) {
		fail(401, "invalid_token", "Недействительная сессия")
	}
	return v
}
func makeWebSession(user, config M) string {
	at := time.Now().Unix()
	return sign("tmw_", M{"v": 1, "userId": user["id"], "generation": sha(s(user, "tokenHash")), "iat": at, "exp": at + 30*86400, "id": uuid()}, s(config, "sessionKey"))
}
func makeYandexFlow(config, body, user M) M {
	if !yandexAvailable(config) {
		fail(503, "yandex_not_configured", "Вход через Яндекс ещё не настроен")
	}
	if !contains([]string{"login", "link"}, s(body, "mode")) || !challengeRE.MatchString(s(body, "challenge")) || !contains(configOrigins(config), s(body, "origin")) {
		fail(422, "invalid_yandex_flow", "Некорректный запрос входа")
	}
	if s(body, "mode") == "link" && user == nil {
		fail(401, "missing_token", "Сначала войдите в существующий аккаунт")
	}
	flow := M{"v": 1, "id": uuid(), "mode": body["mode"], "challenge": body["challenge"], "redirectUri": s(body, "origin") + "/auth/yandex/callback/", "actorId": "", "actorGeneration": "", "at": now(), "exp": time.Now().Unix() + 600}
	if user != nil {
		flow["actorId"] = user["id"]
		flow["actorGeneration"] = sha(s(user, "tokenHash"))
	}
	state := sign("tmyf_", flow, s(config, "sessionKey"))
	q := url.Values{"response_type": {"code"}, "client_id": {s(config, "clientId")}, "redirect_uri": {s(flow, "redirectUri")}, "scope": {"login:info login:avatar"}, "force_confirm": {"yes"}, "state": {state}, "code_challenge": {s(flow, "challenge")}, "code_challenge_method": {"S256"}}
	return M{"url": "https://oauth.yandex.ru/authorize?" + q.Encode(), "state": state}
}
func verifierMatches(v M, verifier string) bool {
	return verifierRE.MatchString(verifier) && shaURL(verifier) == s(v, "challenge")
}

var externalHTTP = &http.Client{Timeout: 6 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func fetchJSON(ctx context.Context, method, address string, headers map[string]string, body string) M {
	req, err := http.NewRequestWithContext(ctx, method, address, strings.NewReader(body))
	if err != nil {
		panic(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := externalHTTP.Do(req)
	if err != nil {
		panic(err)
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		panicError("upstream request failed")
	}
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1024*1024))
	if err != nil {
		panic(err)
	}
	return m(decode(string(raw)))
}
func exchangeYandex(ctx context.Context, config, body M) M {
	if !yandexAvailable(config) {
		fail(503, "yandex_not_configured", "Вход через Яндекс ещё не настроен")
	}
	flow := verify("tmyf_", s(body, "state"), s(config, "sessionKey"))
	redirectOK := false
	for _, origin := range configOrigins(config) {
		if s(flow, "redirectUri") == origin+"/auth/yandex/callback/" {
			redirectOK = true
		}
	}
	if !verifierMatches(flow, s(body, "verifier")) || utf16len(s(body, "code")) < 4 || utf16len(s(body, "code")) > 2048 || !redirectOK {
		fail(400, "invalid_yandex_flow", "Подтверждение входа не совпадает с запросом")
	}
	value, err := caught(func() any {
		grant := fetchJSON(ctx, "POST", "https://oauth.yandex.ru/token", map[string]string{"Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + base64.StdEncoding.EncodeToString([]byte(s(config, "clientId")+":"+s(config, "clientSecret")))}, url.Values{"grant_type": {"authorization_code"}, "code": {s(body, "code")}, "code_verifier": {s(body, "verifier")}}.Encode())
		if s(grant, "access_token") == "" {
			panicError("grant")
		}
		return fetchJSON(ctx, "GET", "https://login.yandex.ru/info?format=json", map[string]string{"Authorization": "OAuth " + s(grant, "access_token")}, "")
	})
	if err != nil {
		fail(502, "yandex_exchange_failed", "Яндекс не подтвердил вход. Начните вход ещё раз.")
	}
	info := m(value)
	if utf16len(s(info, "psuid")) < 8 || utf16len(s(info, "psuid")) > 256 || truth(info["client_id"]) && s(info, "client_id") != s(config, "clientId") {
		fail(502, "yandex_identity_invalid", "Не удалось проверить аккаунт Яндекса")
	}
	label := controlRE.ReplaceAllString(str(or(info["display_name"], or(info["login"], "Яндекс"))), "")
	label = truncateUTF16(label, 80)
	exp := time.Now().Unix() + 180
	if int64(n(flow["exp"])) < exp {
		exp = int64(n(flow["exp"]))
	}
	proof := merge(flow, M{"id": uuid(), "subjectHash": sha("yandex\x00" + s(config, "clientId") + "\x00" + s(info, "psuid")), "label": label, "exp": exp})
	if info["is_avatar_empty"] == true {
		proof["avatarUrl"] = nil
	} else if info["is_avatar_empty"] == false {
		avatarID := s(info, "default_avatar_id")
		if avatarID != "" && len(avatarID) <= 400 && regexpMust(`^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*$`).MatchString(avatarID) {
			proof["avatarUrl"] = "https://avatars.yandex.net/get-yapic/" + avatarID + "/islands-200"
		}
	}
	return M{"proof": sign("tmyv_", proof, s(config, "sessionKey"))}
}
func truncateUTF16(v string, limit int) string {
	r := []rune{}
	used := 0
	for _, c := range v {
		width := 1
		if c > 0xffff {
			width = 2
		}
		if used+width > limit {
			break
		}
		r = append(r, c)
		used += width
	}
	return string(r)
}
func finishYandex(tx Tx, config, body, actor M) M {
	proof := verify("tmyv_", s(body, "proof"), s(config, "sessionKey"))
	if !verifierMatches(proof, s(body, "verifier")) || !hashRE.MatchString(s(proof, "subjectHash")) || !contains([]string{"login", "link"}, s(proof, "mode")) {
		fail(400, "invalid_yandex_flow", "Подтверждение входа не совпадает с запросом")
	}
	owners := externalOwners(tx, s(proof, "subjectHash"))
	if s(proof, "mode") == "login" {
		if len(owners) > 1 {
			fail(409, "yandex_link_conflict", "У Яндекс ID конфликт привязок. Войдите по резервному токену.")
		}
		if len(owners) == 0 {
			fail(404, "yandex_not_linked", "Этот Яндекс ID ещё не привязан в данном канале. Сначала привяжите его в настройках существующего аккаунта.")
		}
		user := tx.Get("users", owners[0])
		if user == nil {
			fail(409, "yandex_account_pending", "Аккаунт ещё синхронизируется")
		}
		recordYandexProfile(tx, proof, s(user, "id"))
		return M{"token": makeWebSession(user, config), "user": publicUser(user)}
	}
	if actor == nil || s(actor, "id") != s(proof, "actorId") || sha(s(actor, "tokenHash")) != s(proof, "actorGeneration") {
		fail(403, "yandex_actor_changed", "Аккаунт изменился во время привязки. Начните заново.")
	}
	user := tx.Get("users", s(actor, "id"))
	if user == nil || sha(s(user, "tokenHash")) != s(proof, "actorGeneration") {
		fail(403, "yandex_actor_changed", "Сессия изменилась. Начните привязку заново.")
	}
	for _, owner := range owners {
		if owner != s(actor, "id") {
			fail(409, "yandex_already_linked", "Этот Яндекс ID уже связан с другим аккаунтом Messenger")
		}
	}
	current := tx.Get("external-users", s(actor, "id"))
	if current != nil && !b(current, "deleted") && s(current, "subjectHash") != s(proof, "subjectHash") {
		fail(409, "another_yandex_linked", "К аккаунту уже привязан другой Яндекс ID")
	}
	if b(body, "checkOnly") {
		return M{"canLink": true, "userId": actor["id"]}
	}
	recordYandexProfile(tx, proof, s(actor, "id"))
	return M{"linked": true, "userId": actor["id"]}
}
func recordYandexProfile(tx Tx, proof M, userID string) {
	current := tx.Get("external-users", userID)
	profile := withExternalProfile(current, tx.Get("external-profile", userID))
	op := M{"version": 1, "id": proof["id"], "userId": userID, "provider": "yandex", "subjectHash": proof["subjectHash"], "at": proof["at"], "deleted": false, "label": proof["label"]}
	if own(proof, "avatarUrl") {
		op["avatarUrl"] = proof["avatarUrl"]
	} else if own(profile, "avatarUrl") {
		op["avatarUrl"] = profile["avatarUrl"]
	}
	if current != nil && !b(current, "deleted") && s(current, "subjectHash") == s(proof, "subjectHash") && s(current, "label") == s(proof, "label") && (!own(proof, "avatarUrl") || equal(profile["avatarUrl"], proof["avatarUrl"])) {
		return
	}
	if current != nil && identityOrder(current) > identityOrder(op) {
		return
	}
	applyExternal(tx, op)
	if s(tx.Get("external-users", userID), "id") != s(op, "id") {
		fail(409, "yandex_link_superseded", "Привязка уже была изменена. Начните заново.")
	}
	appendReplication(tx, "external:"+s(op, "id"), M{"type": "external", "operation": op})
}
