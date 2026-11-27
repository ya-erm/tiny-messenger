package main

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

func TestNodeConflictAndIdentityCompatibility(t *testing.T) {
	raw, err := exec.Command("node", "../tests/go-protocol-reference.mjs").Output()
	if err != nil {
		t.Fatal(err)
	}
	f := m(decode(string(raw)))
	for i, v := range list(f, "rows") {
		fixture := m(v)
		var state M
		for _, op := range list(fixture, "operations") {
			state = mergeRow(state, parseRow(m(op)))
		}
		if !equal(state, fixture["expected"]) {
			t.Fatalf("row conflict case %d differs", i)
		}
	}
	for i, v := range list(f, "native") {
		fixture := m(v)
		p := reduceOperations(list(fixture, "operations"))
		actual := M{"message": p.Message, "editedAt": nullable(p.EditedAt), "deleted": p.Deleted, "hiddenFor": p.Hidden, "reactions": p.Reactions, "statuses": p.Statuses}
		if !equal(actual, fixture["expected"]) {
			t.Fatalf("native conflict case %d differs", i)
		}
	}
	db := newMemoryDB()
	_, err = db.Transaction(context.Background(), false, func(tx Tx) any {
		user := get(f, "user")
		tx.Put("users", s(user, "id"), user)
		for _, op := range list(f, "identity") {
			applyIdentity(tx, m(op))
		}
		if actual := tx.Get("users", s(user, "id")); !equal(actual, f["identityExpected"]) {
			t.Fatalf("identity mismatch: %s", encode(actual))
		}
		for _, op := range list(f, "identity") {
			if applyIdentity(tx, m(op)) {
				t.Fatal("identity replay applied")
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	claims := webClaims(s(f, "session"), get(f, "config"))
	if s(claims, "userId") != s(get(f, "user"), "id") {
		t.Fatal("Node web session rejected")
	}
	state := verify("tmyf_", s(get(f, "flow"), "state"), s(get(f, "config"), "sessionKey"))
	if s(state, "actorGeneration") != sha(s(get(f, "user"), "tokenHash")) {
		t.Fatal("Node link flow differs")
	}
	session := makeWebSession(get(f, "user"), get(f, "config"))
	node := `import{webSessionClaims}from'../shared/yandex-protocol.mjs';console.log(webSessionClaims(process.argv[1],{sessionKey:process.argv[2]}).userId)`
	out, err := exec.Command("node", "--input-type=module", "-e", node, session, s(get(f, "config"), "sessionKey")).Output()
	if err != nil || strings.TrimSpace(string(out)) != s(get(f, "user"), "id") {
		t.Fatal("Go web session rejected by Node", err)
	}
}
func TestTransactionsRollbackAndReadOnly(t *testing.T) {
	db := newMemoryDB()
	ctx := context.Background()
	_, err := db.Transaction(ctx, false, func(tx Tx) any { tx.Put("test", "x", M{"value": 1}); panicError("rollback"); return nil })
	if err == nil {
		t.Fatal("missing error")
	}
	_, err = db.Transaction(ctx, true, func(tx Tx) any {
		if tx.Get("test", "x") != nil {
			t.Fatal("partial commit")
		}
		tx.Put("test", "x", M{})
		return nil
	})
	if err == nil {
		t.Fatal("read-only write allowed")
	}
}
func TestStrictJSONAndMissingRows(t *testing.T) {
	if clone(nil) != nil || encode(M(nil)) != "null" {
		t.Fatal("missing row became a present object")
	}
	for _, raw := range []string{`{} {}`, `{"x":1}false`, `[1,`} {
		_, err := caught(func() any { return decode(raw) })
		if err == nil {
			t.Fatal("invalid JSON accepted", raw)
		}
	}
	for _, v := range []any{nil, true, "1", M{}, A{}, 1.5} {
		if safeInteger(v) {
			t.Fatal("not a safe number", v)
		}
	}
}

func TestYandexAvatarCompatibilityAndReplication(t *testing.T) {
	raw, err := exec.Command("node", "../tests/go-protocol-reference.mjs").Output()
	if err != nil {
		t.Fatal(err)
	}
	fixture := m(decode(string(raw)))
	ctx := context.Background()
	db := newMemoryDB()
	user := get(fixture, "user")
	sv := &Service{Database: db, ID: "test-cloud", Config: get(fixture, "config")}
	sv.transaction(ctx, false, func(tx Tx) any {
		tx.Put("users", s(user, "id"), user)
		result := finishYandex(tx, sv.Config, get(fixture, "avatarProof"), user)
		if !b(result, "linked") {
			t.Fatal("link missing")
		}
		return nil
	})
	sv.transaction(ctx, true, func(tx Tx) any {
		link := tx.Get("external-users", s(user, "id"))
		receipt := tx.Get("external-operations", s(link, "id"))
		if len(receipt) != 8 || own(receipt, "avatarUrl") {
			t.Fatal("legacy receipt was extended")
		}
		status := externalStatus(tx, s(user, "id"))
		if s(status, "avatarUrl") != "https://avatars.yandex.net/get-yapic/123/test-photo/islands-200" {
			t.Fatal("provider picture missing")
		}
		if own(tx.Get("users", s(user, "id")), "avatarUrl") {
			t.Fatal("Messenger picture automatically replaced")
		}
		feed := tx.Feed(replicationFeed, "0", 5)
		if len(feed) != 1 || s(get(feed[0], "operation"), "avatarUrl") != "https://avatars.yandex.net/get-yapic/123/test-photo/islands-200" {
			t.Fatal("picture absent from replication event")
		}
		return nil
	})
	replica := newMemoryDB()
	sv.transaction(ctx, true, func(tx Tx) any {
		link := tx.Get("external-users", s(user, "id"))
		operation := withExternalProfile(link, tx.Get("external-profile", s(user, "id")))
		_, err := replica.Transaction(ctx, false, func(other Tx) any {
			other.Put("users", s(user, "id"), user)
			applyExternal(other, link)
			applyExternal(other, operation)
			applyExternal(other, link)
			if s(externalStatus(other, s(user, "id")), "avatarUrl") != s(operation, "avatarUrl") {
				t.Fatal("metadata lost after legacy receipt replay")
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return nil
	})
}

func TestLegacyYandexLinkCanRecordEmptyPhoto(t *testing.T) {
	ctx := context.Background()
	db := newMemoryDB()
	id := "11111111-1111-4111-8111-111111111111"
	sv := &Service{Database: db, ID: "test", Config: M{}}
	sv.transaction(ctx, false, func(tx Tx) any {
		tx.Put("users", id, M{"id": id})
		old := M{"version": 1, "id": "22222222-2222-4222-8222-222222222222", "userId": id, "subjectHash": strings.Repeat("a", 64), "provider": "yandex", "at": "2026-01-01T00:00:00.000Z", "deleted": false, "label": "Test"}
		applyExternal(tx, old)
		recordYandexProfile(tx, M{"id": "33333333-3333-4333-8333-333333333333", "subjectHash": old["subjectHash"], "at": "2026-01-02T00:00:00.000Z", "label": "Test", "avatarUrl": nil}, id)
		status := externalStatus(tx, id)
		if !own(status, "avatarUrl") || status["avatarUrl"] != nil {
			t.Fatal("empty provider photo remained unknown")
		}
		return nil
	})
}
