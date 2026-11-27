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
