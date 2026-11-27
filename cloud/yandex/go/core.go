package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

type M map[string]any
type A []any
type Entry struct {
	Key   string
	Value M
}
type Pair struct {
	Key   string
	Value any
}
type O []Pair

func m(v any) M {
	if v == nil {
		return nil
	}
	if x, ok := v.(M); ok {
		return x
	}
	if x, ok := v.(map[string]any); ok {
		return M(x)
	}
	return nil
}
func a(v any) A {
	if x, ok := v.([]any); ok {
		return x
	}
	if x, ok := v.(A); ok {
		return x
	}
	return A{}
}
func str(v any) string {
	if x, ok := v.(string); ok {
		return x
	}
	return ""
}
func s(v M, k string) string { return str(v[k]) }
func n(v any) float64 {
	switch x := v.(type) {
	case json.Number:
		f, _ := x.Float64()
		return f
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	case uint64:
		return float64(x)
	}
	return 0
}
func own(v M, k string) bool { _, ok := v[k]; return ok }
func truth(v any) bool {
	switch x := v.(type) {
	case nil:
		return false
	case bool:
		return x
	case string:
		return x != ""
	case json.Number:
		return n(x) != 0
	case float64:
		return x != 0
	case int:
		return x != 0
	}
	return true
}
func b(v M, k string) bool { return truth(v[k]) }
func or(v, fallback any) any {
	if truth(v) {
		return v
	}
	return fallback
}
func get(v M, k string) M  { return m(v[k]) }
func list(v M, k string) A { return a(v[k]) }
func copyMap(v M) M {
	x := M{}
	for k, item := range v {
		x[k] = item
	}
	return x
}
func merge(values ...M) M {
	x := M{}
	for _, v := range values {
		for k, item := range v {
			x[k] = item
		}
	}
	return x
}
func pick(v M, keys ...string) M {
	out := M{}
	for _, k := range keys {
		if x, ok := v[k]; ok {
			out[k] = x
		}
	}
	return out
}
func nonnull(v M, keys ...string) M {
	out := M{}
	for _, k := range keys {
		if x, ok := v[k]; ok && x != nil {
			out[k] = x
		}
	}
	return out
}
func stringsOf(v A) []string {
	out := []string{}
	for _, x := range v {
		out = append(out, str(x))
	}
	return out
}
func contains(values []string, value string) bool {
	for _, x := range values {
		if x == value {
			return true
		}
	}
	return false
}
func uniq(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range values {
		if !seen[v] {
			out = append(out, v)
			seen[v] = true
		}
	}
	return out
}
func records(values []M) A {
	out := A{}
	for _, v := range values {
		out = append(out, v)
	}
	return out
}
func now() string            { return time.Now().UTC().Format("2006-01-02T15:04:05.000Z") }
func iso(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

var uuidRE = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
var utcRE = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$`)
var hashRE = regexp.MustCompile(`^[a-f0-9]{64}$`)

func validUUID(v any) bool { return uuidRE.MatchString(str(v)) }
func validUTC(v any) bool {
	value := str(v)
	if !utcRE.MatchString(value) {
		return false
	}
	t, e := time.Parse(time.RFC3339Nano, value)
	return e == nil && iso(t) == value
}
func parseTime(v string) time.Time { t, _ := time.Parse(time.RFC3339Nano, v); return t }
func uuid() string {
	v := make([]byte, 16)
	if _, err := rand.Read(v); err != nil {
		panic(err)
	}
	v[6] = v[6]&15 | 64
	v[8] = v[8]&63 | 128
	h := hex.EncodeToString(v)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}
func randomToken() string {
	v := make([]byte, 12)
	if _, e := rand.Read(v); e != nil {
		panic(e)
	}
	return "msg_" + base64.RawURLEncoding.EncodeToString(v)
}
func sha(v string) string   { x := sha256.Sum256([]byte(v)); return hex.EncodeToString(x[:]) }
func clean(v any) string    { return strings.Join(strings.Fields(str(v)), " ") }
func utf16len(v string) int { return len(utf16.Encode([]rune(v))) }
func decode(raw string) any {
	var v any
	d := json.NewDecoder(strings.NewReader(raw))
	d.UseNumber()
	if err := d.Decode(&v); err != nil {
		panic(err)
	}
	var trailing any
	if err := d.Decode(&trailing); err != io.EOF {
		panic(fmt.Errorf("invalid trailing JSON"))
	}
	return normalize(v)
}
func normalize(v any) any {
	switch x := v.(type) {
	case map[string]any:
		r := M{}
		for k, value := range x {
			r[k] = normalize(value)
		}
		return r
	case []any:
		r := A{}
		for _, value := range x {
			r = append(r, normalize(value))
		}
		return r
	}
	return v
}

// Protocol receipts in the Node implementation reconstruct specific field order.
// Preserve that wire order while using ordinary maps for internal computation.
func wireKeys(v M) []string {
	if own(v, "protocolVersion") && own(v, "operationId") {
		entity := "message"
		if s(v, "type") == "message.delete" {
			entity = "deletion"
		}
		if s(v, "type") == "reaction.set" {
			entity = "reaction"
		}
		return []string{"protocolVersion", "operationId", "actorId", "deviceId", "occurredAt", "type", entity}
	}
	if n(v["version"]) == 1 && own(v, "previousTokenHash") {
		return []string{"version", "id", "userId", "at", "kind", "tokenHash", "previousTokenHash"}
	}
	if n(v["version"]) == 1 && s(v, "kind") == "profile" && own(v, "nicknameAt") {
		return []string{"version", "id", "userId", "at", "kind", "nicknameAt", "profile"}
	}
	if s(v, "provider") == "yandex" && own(v, "subjectHash") && own(v, "deleted") {
		return []string{"version", "id", "userId", "subjectHash", "provider", "at", "deleted", "label", "avatarUrl"}
	}
	if len(v) == 4 && own(v, "name") && own(v, "nickname") && own(v, "avatarUrl") && own(v, "avatarBackground") {
		return []string{"name", "nickname", "avatarUrl", "avatarBackground"}
	}
	if len(v) == 6 && s(v, "kind") == "text" && own(v, "sentAt") && own(v, "toUserId") {
		return []string{"id", "fromUserId", "toUserId", "kind", "text", "sentAt"}
	}
	if len(v) == 3 && own(v, "messageId") && own(v, "emoji") && own(v, "userId") {
		return []string{"messageId", "userId", "emoji"}
	}
	if len(v) == 2 && own(v, "messageId") && own(v, "scope") {
		return []string{"messageId", "scope"}
	}
	if own(v, "sessionId") && own(v, "latencyMs") && own(v, "sequence") && own(v, "receivedAt") {
		return []string{"id", "userId", "deviceId", "sessionId", "sequence", "at", "mode", "channel", "reason", "latencyMs", "browser", "platform", "pwa", "appVersion", "origin", "receivedAt", "installationId"}
	}
	keys := make([]string, 0, len(v))
	for k := range v {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
func quote(v string) string {
	var out strings.Builder
	out.WriteByte('"')
	for _, r := range v {
		switch r {
		case '"', '\\':
			out.WriteByte('\\')
			out.WriteRune(r)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 32 {
				fmt.Fprintf(&out, `\u%04x`, r)
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
	return out.String()
}
func encode(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return quote(x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	case json.Number:
		f, e := strconv.ParseFloat(string(x), 64)
		if e != nil || math.IsInf(f, 0) || math.IsNaN(f) {
			return "null"
		}
		if f == 0 {
			return "0"
		}
		return strconv.FormatFloat(f, 'f', -1, 64)
	case int:
		return strconv.Itoa(x)
	case uint64:
		return strconv.FormatUint(x, 10)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		if math.IsNaN(x) || math.IsInf(x, 0) {
			return "null"
		}
		if x == 0 {
			return "0"
		}
		return strconv.FormatFloat(x, 'f', -1, 64)
	case M:
		if x == nil {
			return "null"
		}
		parts := []string{}
		for _, k := range wireKeys(x) {
			if value, ok := x[k]; ok {
				parts = append(parts, quote(k)+":"+encode(value))
			}
		}
		return "{" + strings.Join(parts, ",") + "}"
	case O:
		parts := []string{}
		for _, p := range x {
			parts = append(parts, quote(p.Key)+":"+encode(p.Value))
		}
		return "{" + strings.Join(parts, ",") + "}"
	case A:
		parts := []string{}
		for _, v := range x {
			parts = append(parts, encode(v))
		}
		return "[" + strings.Join(parts, ",") + "]"
	case []M:
		return encode(records(x))
	case []string:
		parts := []string{}
		for _, v := range x {
			parts = append(parts, quote(v))
		}
		return "[" + strings.Join(parts, ",") + "]"
	}
	raw, e := json.Marshal(v)
	if e != nil {
		panic(e)
	}
	return encode(normalizeFromJSON(raw))
}
func normalizeFromJSON(raw []byte) any {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		panic(err)
	}
	return normalize(v)
}
func clone(v M) M {
	if v == nil {
		return nil
	}
	return m(decode(encode(v)))
}
func equal(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return bytes.Equal(left, right)
}
func runeCount(v string) int { return utf8.RuneCountInString(v) }

type HTTPError struct {
	Status        int
	Code, Message string
}

func (e *HTTPError) Error() string          { return e.Code }
func fail(status int, code, message string) { panic(&HTTPError{status, code, message}) }
func invalid(message string)                { panic(fmt.Errorf("Invalid %s", message)) }

type Tx interface {
	Get(string, string) M
	Put(string, string, M)
	Delete(string, string)
	Scan(string, int) []M
	Entries(string, int) []Entry
	Prefix(string, string, int) []M
	View(string, string, string) M
	Views(string, int) []M
	PutView(string, M)
	Feed(string, string, int) []M
	AddFeed(string, string, M)
	Sequence() string
	NextSequence() string
}
type Database interface {
	Transaction(context.Context, bool, func(Tx) any) (any, error)
}

func nextSeq(tx Tx) string {
	previous, e := strconv.ParseUint(or(tx.Get("meta", "sequence")["value"], "0").(string), 10, 64)
	if e != nil || previous == math.MaxUint64 {
		panic(fmt.Errorf("sequence overflow"))
	}
	v := strconv.FormatUint(previous+1, 10)
	tx.Put("meta", "sequence", M{"value": v})
	return v
}

func regexpMust(v string) *regexp.Regexp { return regexp.MustCompile(v) }
