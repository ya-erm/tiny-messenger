package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"

	"github.com/ydb-platform/ydb-go-sdk/v3"
	"github.com/ydb-platform/ydb-go-sdk/v3/query"
	yc "github.com/ydb-platform/ydb-go-yc-metadata"
)

type dbFailure struct{ err error }
type ydbStore struct{ driver *ydb.Driver }
type ydbTx struct {
	ctx   context.Context
	actor query.TxActor
}

var databaseMu sync.Mutex
var database Database

func productionDatabase(ctx context.Context) (Database, error) {
	databaseMu.Lock()
	defer databaseMu.Unlock()
	if database != nil {
		return database, nil
	}
	driver, err := ydb.Open(ctx, os.Getenv("YDB_CONNECTION_STRING"), yc.WithCredentials(), yc.WithInternalCA())
	if err != nil {
		return nil, err
	}
	database = &ydbStore{driver}
	return database, nil
}
func caught(fn func() any) (out any, err error) {
	defer func() {
		if v := recover(); v != nil {
			switch x := v.(type) {
			case dbFailure:
				err = x.err
			case error:
				err = x
			default:
				err = fmt.Errorf("internal transaction error")
			}
		}
	}()
	out = fn()
	return
}
func (db *ydbStore) Transaction(ctx context.Context, readOnly bool, fn func(Tx) any) (out any, err error) {
	var logical error
	mode := query.WithSerializableReadWrite()
	if readOnly {
		mode = query.WithSnapshotReadOnly()
	}
	err = db.driver.Query().DoTx(ctx, func(ctx context.Context, actor query.TxActor) (callbackErr error) {
		defer func() {
			if r := recover(); r != nil {
				switch v := r.(type) {
				case dbFailure:
					callbackErr = v.err
				case error:
					logical = v
					callbackErr = v
				default:
					logical = fmt.Errorf("internal transaction error")
					callbackErr = logical
				}
			}
		}()
		out = fn(&ydbTx{ctx, actor})
		return nil
	}, query.WithTxSettings(query.TxSettings(mode)), query.WithIdempotent())
	if err != nil && logical != nil {
		return nil, logical
	}
	return
}
func (tx *ydbTx) parameters(values M) query.ExecuteOption {
	params := ydb.ParamsBuilder()
	for name, value := range values {
		switch v := value.(type) {
		case string:
			params = params.Param("$" + name).Text(v)
		case uint64:
			params = params.Param("$" + name).Uint64(v)
		case int:
			params = params.Param("$" + name).Uint64(uint64(v))
		default:
			panic(fmt.Errorf("invalid database parameter"))
		}
	}
	return query.WithParameters(params.Build())
}
func (tx *ydbTx) rows(sql string, params M, columns ...string) []M {
	result, err := tx.actor.Query(tx.ctx, sql, tx.parameters(params))
	if err != nil {
		panic(dbFailure{err})
	}
	defer result.Close(tx.ctx)
	rows := []M{}
	for {
		set, err := result.NextResultSet(tx.ctx)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			panic(dbFailure{err})
		}
		for {
			row, err := set.NextRow(tx.ctx)
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				panic(dbFailure{err})
			}
			dest := make([]any, len(columns))
			values := make([]string, len(columns))
			var seq uint64
			for i, name := range columns {
				if name == "seq" {
					dest[i] = &seq
				} else {
					dest[i] = &values[i]
				}
			}
			if err = row.Scan(dest...); err != nil {
				panic(dbFailure{err})
			}
			value := M{}
			for i, name := range columns {
				if name == "seq" {
					value[name] = strconv.FormatUint(seq, 10)
				} else {
					value[name] = values[i]
				}
			}
			rows = append(rows, value)
		}
	}
	return rows
}
func (tx *ydbTx) exec(sql string, params M) {
	if err := tx.actor.Exec(tx.ctx, sql, tx.parameters(params)); err != nil {
		panic(dbFailure{err})
	}
}
func (tx *ydbTx) Get(bucket, key string) M {
	rows := tx.rows(`DECLARE $bucket AS Utf8;DECLARE $key AS Utf8;SELECT body FROM tm_kv WHERE bucket=$bucket AND key=$key;`, M{"bucket": bucket, "key": key}, "body")
	if len(rows) == 0 {
		return nil
	}
	return m(decode(s(rows[0], "body")))
}
func (tx *ydbTx) Put(bucket, key string, value M) {
	tx.exec(`DECLARE $bucket AS Utf8;DECLARE $key AS Utf8;DECLARE $body AS Utf8;UPSERT INTO tm_kv (bucket,key,body) VALUES ($bucket,$key,$body);`, M{"bucket": bucket, "key": key, "body": encode(value)})
}
func (tx *ydbTx) Delete(bucket, key string) {
	tx.exec(`DECLARE $bucket AS Utf8;DECLARE $key AS Utf8;DELETE FROM tm_kv WHERE bucket=$bucket AND key=$key;`, M{"bucket": bucket, "key": key})
}
func (tx *ydbTx) Entries(bucket string, limit int) []Entry {
	rows := tx.rows(`DECLARE $bucket AS Utf8;DECLARE $limit AS Uint64;SELECT key,body FROM tm_kv WHERE bucket=$bucket ORDER BY key LIMIT $limit;`, M{"bucket": bucket, "limit": limit}, "key", "body")
	out := []Entry{}
	for _, row := range rows {
		out = append(out, Entry{s(row, "key"), m(decode(s(row, "body")))})
	}
	return out
}
func (tx *ydbTx) Scan(bucket string, limit int) []M {
	out := []M{}
	for _, row := range tx.Entries(bucket, limit) {
		out = append(out, row.Value)
	}
	return out
}
func (tx *ydbTx) Prefix(bucket, prefix string, limit int) []M {
	rows := tx.rows(`DECLARE $bucket AS Utf8;DECLARE $prefix AS Utf8;DECLARE $upper AS Utf8;DECLARE $limit AS Uint64;SELECT body FROM tm_kv WHERE bucket=$bucket AND key >= $prefix AND key < $upper ORDER BY key LIMIT $limit;`, M{"bucket": bucket, "prefix": prefix, "upper": prefix + "\uffff", "limit": limit}, "body")
	out := []M{}
	for _, r := range rows {
		out = append(out, m(decode(s(r, "body"))))
	}
	return out
}
func (tx *ydbTx) PutView(user string, message M) {
	tx.exec(`DECLARE $user AS Utf8;DECLARE $at AS Utf8;DECLARE $id AS Utf8;DECLARE $body AS Utf8;UPSERT INTO tm_views (user_id,sent_at,message_id,body) VALUES ($user,$at,$id,$body);`, M{"user": user, "at": s(message, "sentAt"), "id": s(message, "id"), "body": encode(message)})
}
func (tx *ydbTx) View(user, at, id string) M {
	rows := tx.rows(`DECLARE $user AS Utf8;DECLARE $at AS Utf8;DECLARE $id AS Utf8;SELECT body FROM tm_views WHERE user_id=$user AND sent_at=$at AND message_id=$id;`, M{"user": user, "at": at, "id": id}, "body")
	if len(rows) == 0 {
		return nil
	}
	return m(decode(s(rows[0], "body")))
}
func (tx *ydbTx) Views(user string, limit int) []M {
	rows := tx.rows(`DECLARE $user AS Utf8;DECLARE $limit AS Uint64;SELECT body FROM tm_views WHERE user_id=$user ORDER BY sent_at DESC,message_id DESC LIMIT $limit;`, M{"user": user, "limit": limit}, "body")
	out := []M{}
	for _, r := range rows {
		out = append(out, m(decode(s(r, "body"))))
	}
	return out
}
func (tx *ydbTx) AddFeed(user, sequence string, value M) {
	seq, e := strconv.ParseUint(sequence, 10, 64)
	if e != nil {
		panic(e)
	}
	tx.exec(`DECLARE $user AS Utf8;DECLARE $seq AS Uint64;DECLARE $body AS Utf8;UPSERT INTO tm_feed (user_id,seq,body) VALUES ($user,$seq,$body);`, M{"user": user, "seq": seq, "body": encode(value)})
}
func (tx *ydbTx) Feed(user, after string, limit int) []M {
	seq, e := strconv.ParseUint(after, 10, 64)
	if e != nil {
		panic(e)
	}
	rows := tx.rows(`DECLARE $user AS Utf8;DECLARE $after AS Uint64;DECLARE $limit AS Uint64;SELECT seq,body FROM tm_feed WHERE user_id=$user AND seq > $after ORDER BY seq LIMIT $limit;`, M{"user": user, "after": seq, "limit": limit}, "seq", "body")
	out := []M{}
	for _, r := range rows {
		out = append(out, merge(M{"sequence": s(r, "seq")}, m(decode(s(r, "body")))))
	}
	return out
}
func (tx *ydbTx) Sequence() string {
	if value := s(tx.Get("meta", "sequence"), "value"); value != "" {
		return value
	}
	return "0"
}
func (tx *ydbTx) NextSequence() string { return nextSeq(tx) }
