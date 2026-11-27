package main

import (
	"context"
	"github.com/ydb-platform/ydb-go-sdk/v3"
	"os"
	"testing"
	"time"
)

// Read-only integration check; configuration must be explicitly supplied locally.
func TestLiveYDBReadOnly(t *testing.T) {
	path := os.Getenv("TM_GO_LIVE_CONFIG")
	if path == "" {
		t.Skip("no explicit live configuration")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	config := m(decode(string(raw)))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	driver, err := ydb.Open(ctx, s(config, "connectionString"), ydb.WithAccessTokenCredentials(s(config, "token")))
	if err != nil {
		t.Fatal(err)
	}
	defer driver.Close(context.Background())
	db := &ydbStore{driver}
	_, err = db.Transaction(ctx, true, func(tx Tx) any {
		user := tx.Get("users", s(config, "userId"))
		if user == nil {
			t.Fatal("test user missing")
		}
		return user
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestLiveYDBAdapterRoundTrip(t *testing.T) {
	if os.Getenv("TM_GO_LIVE_ALLOW_WRITES") != "1" {
		t.Skip("no explicit isolated write opt-in")
	}
	path := os.Getenv("TM_GO_LIVE_CONFIG")
	if path == "" {
		t.Skip("no explicit live configuration")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	config := m(decode(string(raw)))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	driver, err := ydb.Open(ctx, s(config, "connectionString"), ydb.WithAccessTokenCredentials(s(config, "token")))
	if err != nil {
		t.Fatal(err)
	}
	defer driver.Close(context.Background())
	db := &ydbStore{driver}
	namespace := "@go-adapter-test:" + uuid()
	at := now()
	defer func() {
		_, err := db.Transaction(context.Background(), false, func(tx Tx) any {
			tx.Delete(namespace, "one")
			tx.Delete(namespace, "two")
			real := tx.(*ydbTx)
			real.exec(`DECLARE $user AS Utf8;DELETE FROM tm_views WHERE user_id=$user;`, M{"user": namespace})
			real.exec(`DECLARE $user AS Utf8;DELETE FROM tm_feed WHERE user_id=$user;`, M{"user": namespace})
			return nil
		})
		if err != nil {
			t.Error("test cleanup failed", err)
		}
	}()
	_, err = db.Transaction(ctx, false, func(tx Tx) any {
		tx.Put(namespace, "one", M{"name": "Привет"})
		tx.Put(namespace, "two", M{"name": "<>&"})
		tx.PutView(namespace, M{"id": "message", "sentAt": at, "text": "Текст"})
		tx.AddFeed(namespace, "7", M{"type": "test"})
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Transaction(ctx, true, func(tx Tx) any {
		if s(tx.Get(namespace, "one"), "name") != "Привет" || len(tx.Scan(namespace, 5)) != 2 || len(tx.Prefix(namespace, "on", 5)) != 1 || len(tx.Views(namespace, 5)) != 1 || tx.View(namespace, at, "message") == nil || len(tx.Feed(namespace, "0", 5)) != 1 {
			t.Fatal("adapter round trip mismatch")
		}
		rows := tx.(*ydbTx).AdminRows()
		if len(rows) == 0 {
			t.Fatal("empty admin projection")
		}
		sv := &Service{Database: db, ID: "test-cloud", Config: M{}}
		r := newRows(tx, sv)
		user := tx.Get("users", s(config, "userId"))
		for _, view := range r.Views(s(user, "id"), 100) {
			if b(view, "_row") && visible(view) {
				r.messageRecord(r.row("Message", s(view, "id")), s(user, "id"), false, true)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

type rollbackDB struct{ Database }

func (db rollbackDB) Transaction(ctx context.Context, ro bool, fn func(Tx) any) (any, error) {
	return db.Database.Transaction(ctx, ro, func(tx Tx) any {
		result := fn(tx)
		if !ro {
			panicError("intentional registration rollback")
		}
		return result
	})
}
func TestLiveRegistrationRollback(t *testing.T) {
	if os.Getenv("TM_GO_LIVE_ALLOW_WRITES") != "1" {
		t.Skip("no explicit isolated write opt-in")
	}
	path := os.Getenv("TM_GO_LIVE_CONFIG")
	if path == "" {
		t.Skip("no explicit live configuration")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	config := m(decode(string(raw)))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	driver, err := ydb.Open(ctx, s(config, "connectionString"), ydb.WithAccessTokenCredentials(s(config, "token")))
	if err != nil {
		t.Fatal(err)
	}
	defer driver.Close(context.Background())
	db := &ydbStore{driver}
	sv := &Service{Database: rollbackDB{db}, ID: "test-go-rollback", Config: M{}}
	id, token := uuid(), randomToken()
	_, err = caught(func() any {
		return sv.register(ctx, M{"name": "Проверка Go", "clientRequestId": id, "registrationToken": token}, "synthetic-registration")
	})
	if err == nil || err.Error() != "intentional registration rollback" {
		t.Fatalf("registration failed before rollback: %v", err)
	}
	_, err = db.Transaction(ctx, true, func(tx Tx) any {
		if tx.Get("users", id) != nil || tx.Get("registration-requests", id) != nil || tx.Get("tokens", sha(token)) != nil {
			t.Fatal("registration partially committed")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
