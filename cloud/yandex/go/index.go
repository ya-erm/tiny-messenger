package main

import (
	"context"
	"encoding/base64"
	"log"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type Response struct {
	StatusCode      int               `json:"statusCode"`
	Headers         map[string]string `json:"headers"`
	Body            string            `json:"body"`
	IsBase64Encoded bool              `json:"isBase64Encoded"`
}

var mutationTypes = []string{"message.create", "message.edit", "message.delete", "reaction.set"}
var capabilities = []string{"personal-text", "edits", "reactions", "deletions", "changes", "native-token", "groups", "quotes", "choices", "attachments", "registration", "contacts-write", "profile-write", "token-rotation", "device-telemetry", "yandex-login", "image-thumbnails", "admin-charts-v4"}
var limits = M{"name": 20, "nickname": 32, "avatarUrl": 500, "message": 16384, "option": 8, "optionId": 64, "choiceOptionsMin": 2, "choiceOptionsMax": 2, "tokenMin": 8, "tokenMax": 64, "pageSize": 100, "groupName": 40, "groupMembersMax": 50}

func productionConfig() M {
	origins := []string{}
	for _, v := range strings.Split(os.Getenv("TM_AUTH_ALLOWED_ORIGINS"), ",") {
		if v = strings.TrimSpace(v); v != "" {
			origins = append(origins, v)
		}
	}
	v := M{"clientId": os.Getenv("YANDEX_OAUTH_CLIENT_ID"), "clientSecret": os.Getenv("YANDEX_OAUTH_CLIENT_SECRET"), "sessionKey": os.Getenv("TM_WEB_SESSION_SECRET"), "origins": toA(origins), "allowedOrigins": os.Getenv("TM_ALLOWED_ORIGINS"), "peerID": env("TM_REPLICATION_PEER", "vps-1"), "replicationSecret": os.Getenv("TM_REPLICATION_SECRET"), "adminIDs": os.Getenv("TM_ADMIN_USER_IDS")}
	if raw := os.Getenv("TM_BUS_CONFIG"); raw != "" {
		v["bus"] = decode(raw)
	}
	return v
}
func parseBody(event M, maxBytes int) M {
	raw := s(event, "body")
	if raw == "" {
		raw = "{}"
	}
	if b(event, "isBase64Encoded") {
		decoded, err := base64.StdEncoding.DecodeString(raw)
		if err != nil {
			fail(400, "invalid_json", "Ожидался JSON")
		}
		raw = string(decoded)
	}
	if len(raw) > maxBytes {
		fail(413, "payload_too_large", "Запрос превышает 16 КиБ")
	}
	v, err := caught(func() any { return decode(raw) })
	if err != nil || m(v) == nil {
		fail(400, "invalid_json", "Ожидался JSON-объект")
	}
	return m(v)
}
func pageSize(v any) int {
	value := n(v)
	if text, ok := v.(string); ok {
		f, e := strconv.ParseFloat(text, 64)
		if e != nil {
			return 100
		}
		value = f
	}
	if value != float64(int(value)) {
		return 100
	}
	return max(1, min(100, int(value)))
}
func Handler(ctx context.Context, event M) (any, error) {
	config := productionConfig()
	id := env("TM_INSTALLATION_ID", "yandex-1")
	provider := func() *Service {
		db, err := productionDatabase(ctx)
		if err != nil {
			panic(err)
		}
		return &Service{Database: db, ID: id, Config: config}
	}
	if isArray(event["messages"]) && s(event, "httpMethod") == "" {
		value, err := caught(func() any { return provider().consumeQueue(ctx, event) })
		return value, err
	}
	return handleHTTP(ctx, event, config, id, provider), nil
}
func handleHTTP(ctx context.Context, event, config M, id string, provider func() *Service) (response Response) {
	started := time.Now()
	headers := map[string]string{}
	for k, v := range get(event, "headers") {
		headers[strings.ToLower(k)] = str(v)
	}
	origin := headers["origin"]
	allowed := []string{}
	for _, v := range strings.Split(s(config, "allowedOrigins"), ",") {
		allowed = append(allowed, strings.TrimSpace(v))
	}
	response.Headers = map[string]string{"content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-tm-installation-id": id, "vary": "Origin"}
	if origin != "" && contains(allowed, origin) {
		for k, v := range map[string]string{"access-control-allow-origin": origin, "access-control-allow-methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS", "access-control-allow-headers": "Authorization,Content-Type,X-API-Key,X-TM-Request-Id", "access-control-expose-headers": "X-TM-Installation-Id,Retry-After", "access-control-max-age": "600"} {
			response.Headers[k] = v
		}
	}
	path := "/"
	respond := func(status int, data M) {
		response.StatusCode = status
		response.Body = encode(M{"ok": true, "data": data})
		if status == 204 {
			response.Body = ""
		}
	}
	defer func() {
		if recovered := recover(); recovered != nil {
			response.StatusCode = 503
			code, message := "cloud_storage_unavailable", "Облачное хранилище временно недоступно"
			if e, ok := recovered.(*HTTPError); ok {
				response.StatusCode, code, message = e.Status, e.Code, e.Message
			} else {
				log.Printf(`{"event":"cloud-api-error","path":%s}`, quote(path))
			}
			if response.StatusCode == 503 || response.StatusCode == 429 {
				response.Headers["retry-after"] = "2"
			}
			response.Body = encode(M{"ok": false, "error": M{"code": code, "message": message}})
		}
		if os.Getenv("TM_LOG_TIMING") == "1" {
			log.Printf(`{"event":"cloud-api-timing","path":%s,"durationMs":%d}`, quote(path), time.Since(started).Milliseconds())
		}
	}()
	if origin != "" && !contains(allowed, origin) {
		fail(403, "origin_not_allowed", "Этот источник приложения не разрешён")
	}
	method := strings.ToUpper(s(event, "httpMethod"))
	if method == "" {
		method = strings.ToUpper(s(get(get(event, "requestContext"), "http"), "method"))
	}
	if method == "" {
		method = "GET"
	}
	if method == "OPTIONS" {
		respond(204, nil)
		return
	}
	rawURL := s(event, "url")
	if rawURL == "" {
		rawURL = s(event, "path")
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		panic(err)
	}
	path = strings.TrimSuffix(u.Path, "/")
	if path == "" {
		path = "/"
	}
	query := u.Query()
	for k, v := range get(event, "queryStringParameters") {
		query.Set(k, str(v))
	}
	if method == "GET" {
		switch path {
		case "/api/health":
			respond(200, M{"status": "healthy", "apiVersion": 1, "installationId": id, "time": now()})
			return
		case "/api/transport":
			respond(200, M{"installationId": id, "protocolVersion": 1, "rowReplicationVersion": 1, "mutationTypes": mutationTypes, "capabilities": capabilities, "voice": false, "files": true, "replication": s(config, "replicationSecret") != ""})
			return
		case "/api/config":
			respond(200, M{"apiVersion": 1, "limits": limits, "suggestedNames": A{}})
			return
		}
	}
	if method == "POST" && strings.HasPrefix(path, "/api/internal/replication/") {
		authorizePeer(headers, s(config, "replicationSecret"))
		if path == "/api/internal/replication/events" {
			body := parseBody(event, 256*1024)
			respond(200, provider().consumeFrames(ctx, A{body}))
			return
		}
		if path == "/api/internal/replication/exchange" {
			body := parseBody(event, 512*1024)
			respond(200, provider().exchange(ctx, body))
			return
		}
	}
	sv := provider()
	body := M{}
	if contains([]string{"POST", "PATCH", "PUT", "DELETE"}, method) {
		body = parseBody(event, 16384)
	}
	flush := func() {
		if _, e := caught(func() any { return sv.flushBus(ctx) }); e != nil {
			log.Print(`{"event":"cloud-bus","status":"publish_failed"}`)
		}
	}
	if path == "/api/auth/register" && method == "POST" {
		request := get(event, "requestContext")
		ip := s(get(request, "identity"), "sourceIp")
		if ip == "" {
			ip = s(get(request, "http"), "sourceIp")
		}
		if ip == "" {
			ip = "unknown"
		}
		data := sv.register(ctx, body, ip)
		flush()
		status := 201
		if b(data, "replayed") {
			status = 200
		}
		respond(status, data)
		return
	}
	token := strings.TrimSpace(regexpMust(`(?i)^Bearer\s+`).ReplaceAllString(headers["authorization"], ""))
	if token == "" {
		token = headers["x-api-key"]
	}
	if path == "/api/auth/session" && method == "POST" {
		token = strings.TrimSpace(s(body, "token"))
	}
	if strings.HasPrefix(path, "/api/auth/yandex/") {
		parts := strings.Split(path, "/")
		action := parts[len(parts)-1]
		var data M
		switch {
		case action == "config" && method == "GET":
			data = M{"enabled": yandexAvailable(sv.Config)}
		case action == "start" && method == "POST":
			if origin != "" && origin != s(body, "origin") {
				fail(403, "invalid_origin", "Источник входа не совпадает")
			}
			var actor M
			if s(body, "mode") == "link" {
				actor = sv.authenticate(ctx, token)
			}
			data = makeYandexFlow(sv.Config, body, actor)
		case action == "exchange" && method == "POST":
			data = exchangeYandex(ctx, sv.Config, body)
		case action == "finish" && method == "POST":
			var actor M
			if token != "" {
				actor = sv.authenticate(ctx, token)
			}
			data = m(sv.transaction(ctx, false, func(tx Tx) any { return finishYandex(tx, sv.Config, body, actor) }))
			flush()
		case action == "link" && method == "GET":
			actor := sv.authenticate(ctx, token)
			data = m(sv.transaction(ctx, true, func(tx Tx) any { return externalStatus(tx, s(actor, "id")) }))
		default:
			fail(404, "not_found", "Не найдено")
		}
		respond(200, data)
		return
	}
	if path == "/api/me/token" && method == "POST" {
		data := sv.rotateToken(ctx, token, body)
		flush()
		respond(200, data)
		return
	}
	user := sv.authenticate(ctx, token)
	if strings.HasPrefix(path, "/api/admin/") && method == "GET" {
		parts := strings.Split(path, "/")
		respond(200, sv.admin(ctx, user, parts[len(parts)-1], query))
		return
	}
	data, status := sv.route(ctx, user, body, path, method, headers, query)
	if contains([]string{"POST", "PATCH", "PUT", "DELETE"}, method) && !contains([]string{"/api/sync", "/api/changes", "/api/auth/session"}, path) {
		flush()
	}
	respond(status, data)
	return
}
