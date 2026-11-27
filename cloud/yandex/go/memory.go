package main

import (
	"context"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type memoryDB struct {
	mu      sync.Mutex
	buckets map[string]map[string]M
	views   map[string]map[string]M
	feed    map[string]map[string]M
}
type memoryTx struct {
	db       *memoryDB
	readOnly bool
}

func newMemoryDB() *memoryDB {
	return &memoryDB{buckets: map[string]map[string]M{}, views: map[string]map[string]M{}, feed: map[string]map[string]M{}}
}
func copyBuckets(input map[string]map[string]M) map[string]map[string]M {
	out := map[string]map[string]M{}
	for bucket, rows := range input {
		out[bucket] = map[string]M{}
		for key, value := range rows {
			out[bucket][key] = clone(value)
		}
	}
	return out
}
func (db *memoryDB) Transaction(ctx context.Context, ro bool, fn func(Tx) any) (any, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	temporary := &memoryDB{buckets: copyBuckets(db.buckets), views: copyBuckets(db.views), feed: copyBuckets(db.feed)}
	out, err := caught(func() any { return fn(&memoryTx{temporary, ro}) })
	if err == nil && !ro {
		db.buckets = temporary.buckets
		db.views = temporary.views
		db.feed = temporary.feed
	}
	return out, err
}
func (tx *memoryTx) writing() {
	if tx.readOnly {
		panic(fmt.Errorf("read-only transaction write"))
	}
}
func (tx *memoryTx) Get(bucket, key string) M {
	if value := tx.db.buckets[bucket][key]; value != nil {
		return clone(value)
	}
	return nil
}
func (tx *memoryTx) Put(bucket, key string, v M) {
	tx.writing()
	if tx.db.buckets[bucket] == nil {
		tx.db.buckets[bucket] = map[string]M{}
	}
	tx.db.buckets[bucket][key] = clone(v)
}
func (tx *memoryTx) Delete(bucket, key string) { tx.writing(); delete(tx.db.buckets[bucket], key) }
func (tx *memoryTx) Entries(bucket string, limit int) []Entry {
	keys := []string{}
	for key := range tx.db.buckets[bucket] {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if len(keys) > limit {
		keys = keys[:limit]
	}
	out := []Entry{}
	for _, key := range keys {
		out = append(out, Entry{key, tx.Get(bucket, key)})
	}
	return out
}
func (tx *memoryTx) Scan(bucket string, limit int) []M {
	out := []M{}
	for _, r := range tx.Entries(bucket, limit) {
		out = append(out, r.Value)
	}
	return out
}
func (tx *memoryTx) Prefix(bucket, prefix string, limit int) []M {
	out := []M{}
	for _, r := range tx.Entries(bucket, 100000) {
		if strings.HasPrefix(r.Key, prefix) && len(out) < limit {
			out = append(out, r.Value)
		}
	}
	return out
}
func (tx *memoryTx) PutView(user string, value M) {
	tx.writing()
	if tx.db.views[user] == nil {
		tx.db.views[user] = map[string]M{}
	}
	tx.db.views[user][s(value, "sentAt")+"\x00"+s(value, "id")] = clone(value)
}
func (tx *memoryTx) View(user, at, id string) M {
	if v := tx.db.views[user][at+"\x00"+id]; v != nil {
		return clone(v)
	}
	return nil
}
func (tx *memoryTx) Views(user string, limit int) []M {
	keys := []string{}
	for key := range tx.db.views[user] {
		keys = append(keys, key)
	}
	sort.Sort(sort.Reverse(sort.StringSlice(keys)))
	if len(keys) > limit {
		keys = keys[:limit]
	}
	out := []M{}
	for _, key := range keys {
		out = append(out, clone(tx.db.views[user][key]))
	}
	return out
}
func (tx *memoryTx) AddFeed(user, seq string, value M) {
	tx.writing()
	if tx.db.feed[user] == nil {
		tx.db.feed[user] = map[string]M{}
	}
	tx.db.feed[user][seq] = clone(value)
}
func (tx *memoryTx) Feed(user, after string, limit int) []M {
	keys := []uint64{}
	min, _ := strconv.ParseUint(after, 10, 64)
	for key := range tx.db.feed[user] {
		v, _ := strconv.ParseUint(key, 10, 64)
		if v > min {
			keys = append(keys, v)
		}
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i] < keys[j] })
	if len(keys) > limit {
		keys = keys[:limit]
	}
	out := []M{}
	for _, key := range keys {
		seq := strconv.FormatUint(key, 10)
		out = append(out, merge(M{"sequence": seq}, tx.db.feed[user][seq]))
	}
	return out
}
func (tx *memoryTx) Sequence() string {
	if v := s(tx.Get("meta", "sequence"), "value"); v != "" {
		return v
	}
	return "0"
}
func (tx *memoryTx) NextSequence() string { return nextSeq(tx) }
