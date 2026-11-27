package main

import (
	"context"
	"net/url"
	"os/exec"
	"sort"
	"strings"
	"testing"
)

func comparable(v any) any {
	switch x := v.(type) {
	case M:
		out := M{}
		for k, value := range x {
			if contains([]string{"time", "receivedAt", "createdAt", "updatedAt", "editedAt", "answeredAt", "syncedAt", "generatedAt", "firstSeenAt", "lastSeenAt", "cursor", "sequence", "linkedAt"}, k) {
				continue
			}
			if k == "message" && own(x, "code") {
				continue
			}
			if k == "deletedMessageIds" {
				ids := stringsOf(a(value))
				sort.Strings(ids)
				out[k] = toA(ids)
			} else {
				out[k] = comparable(value)
			}
		}
		return out
	case A:
		out := A{}
		for _, value := range x {
			out = append(out, comparable(value))
		}
		return out
	}
	return v
}
func TestNodeHTTPCompatibility(t *testing.T) {
	ctx := context.Background()
	cmd := exec.Command("node", "../tests/go-reference.mjs")
	raw, err := cmd.Output()
	if err != nil {
		if e, ok := err.(*exec.ExitError); ok {
			t.Fatal(string(e.Stderr))
		}
		t.Fatal(err)
	}
	fixture := m(decode(string(raw)))
	db := newMemoryDB()
	_, err = db.Transaction(ctx, false, func(tx Tx) any {
		for _, v := range list(fixture, "seed") {
			entry := m(v)
			tx.Put(s(entry, "bucket"), s(entry, "key"), get(entry, "value"))
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	config := M{"allowedOrigins": "https://tm.example", "adminIDs": "00000000-0000-4000-8000-000000000001", "peerID": "vps-1"}
	sv := &Service{Database: db, ID: "test-cloud", Config: config}
	for i, value := range list(fixture, "steps") {
		step := m(value)
		event := get(step, "event")
		response := handleHTTP(ctx, event, config, sv.ID, func() *Service { return sv })
		var body any
		if response.Body != "" {
			body = decode(response.Body)
		}
		actual := M{"status": response.StatusCode, "body": body}
		expected := get(step, "expected")
		if !equal(comparable(actual), comparable(expected)) {
			if response.StatusCode == 503 {
				_, e := caught(func() any {
					u, _ := url.Parse(s(event, "url"))
					actor := sv.authenticate(ctx, strings.TrimPrefix(s(get(event, "headers"), "authorization"), "Bearer "))
					out, _ := sv.route(ctx, actor, parseBody(event, 16384), u.Path, s(event, "httpMethod"), nil, u.Query())
					return out
				})
				t.Logf("route error: %v", e)
			}
			t.Fatalf("step %d %s %s\nactual %s\nexpected %s", i, s(event, "httpMethod"), s(event, "url"), encode(comparable(actual)), encode(comparable(expected)))
		}
	}
}
func TestWireEncoding(t *testing.T) {
	input := M{"protocolVersion": 1, "operationId": "00000000-0000-4000-8000-000000000001", "actorId": "00000000-0000-4000-8000-000000000002", "deviceId": "00000000-0000-4000-8000-000000000003", "occurredAt": "2026-01-01T00:00:00.000Z", "type": "reaction.set", "reaction": M{"messageId": "00000000-0000-4000-8000-000000000004", "userId": "00000000-0000-4000-8000-000000000002", "emoji": "👩🏽‍💻"}}
	encoded := encode(parseMutation(input))
	cmd := exec.Command("node", "--input-type=module", "-e", `import{serializeMutation}from '../shared/protocol.mjs';console.log(serializeMutation(JSON.parse(process.argv[1])))`, encoded)
	raw, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(raw)) != encoded {
		t.Fatal("protocol wire encoding differs")
	}
	text := "<>&\u2028\u2029\n\t\x00😀"
	if encode(text) != `"<>&`+"\u2028\u2029"+`\n\t\u0000😀"` {
		t.Fatal("non JS string escaping")
	}
}
