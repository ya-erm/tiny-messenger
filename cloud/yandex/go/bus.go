package main

import (
	"context"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

var busMu sync.Mutex
var busIDRE = regexpMust(`^[a-z0-9:-]{1,160}$`)

func (sv *Service) busConfig() M {
	config := get(sv.Config, "bus")
	if !b(config, "enabled") {
		return nil
	}
	return config
}
func makeFrame(from, to, kind, id string, payload M) M {
	return merge(M{"version": 1, "from": from, "to": to, "kind": kind, "id": id, "at": now()}, payload)
}
func parseFrame(input any, self string, peers []string) M {
	v := m(input)
	if raw, ok := input.(string); ok {
		v = m(decode(raw))
	}
	if n(v["version"]) != 1 || !contains([]string{"events", "ping", "pong"}, s(v, "kind")) || !originRE.MatchString(s(v, "from")) || s(v, "from") == self || !contains(peers, s(v, "from")) || s(v, "to") != self || !busIDRE.MatchString(s(v, "id")) || parseTime(s(v, "at")).IsZero() || len(encode(v)) > 240*1024 {
		invalid("replication bus frame")
	}
	if s(v, "kind") == "events" {
		if !isArray(v["events"]) || len(list(v, "events")) < 1 || len(list(v, "events")) > 5 {
			invalid("replication bus events")
		}
		for _, event := range list(v, "events") {
			if !contains([]string{"mutation", "row", "receipt", "user", "contact", "identity", "telemetry", "external"}, s(m(event), "type")) {
				invalid("replication bus events")
			}
		}
	}
	return v
}
func publishFrames(ctx context.Context, config M, address string, frames []M) {
	if len(frames) == 0 || len(frames) > 10 {
		invalid("queue batch")
	}
	if len(frames) > 1 {
		size := 0
		for _, frame := range frames {
			size += len(encode(frame))
		}
		if size > 128*1024 {
			middle := (len(frames) + 1) / 2
			publishFrames(ctx, config, address, frames[:middle])
			publishFrames(ctx, config, address, frames[middle:])
			return
		}
	}
	if s(config, "provider") != "ymq" {
		panicError("Unsupported replication bus provider")
	}
	endpoint := str(or(config["endpoint"], "https://message-queue.api.cloud.yandex.net"))
	u := validateEndpoint(endpoint)
	if u.Path == "" {
		u.Path = "/"
	}
	region := str(or(config["region"], "ru-central1"))
	data := url.Values{"Action": {"SendMessageBatch"}, "Version": {"2012-11-05"}, "QueueUrl": {address}}
	for i, frame := range frames {
		prefix := "SendMessageBatchRequestEntry." + strconv.Itoa(i+1) + "."
		data.Set(prefix+"Id", strconv.Itoa(i))
		data.Set(prefix+"MessageBody", encode(frame))
	}
	body := data.Encode()
	headers := map[string]string{"content-type": "application/x-www-form-urlencoded; charset=utf-8"}
	credentials := get(config, "credentials")
	signAWS("POST", u, headers, body, region, "sqs", s(credentials, "accessKeyId"), s(credentials, "secretAccessKey"), time.Now())
	bounded, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(bounded, "POST", u.String(), strings.NewReader(body))
	if err != nil {
		panic(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := storageHTTP.Do(req)
	if err != nil {
		panicError("Queue publish failed")
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 3*1024*1024+1))
	if err != nil || len(raw) > 3*1024*1024 || res.StatusCode < 200 || res.StatusCode >= 300 || strings.Contains(string(raw), "<BatchResultErrorEntry>") {
		panicError("Queue batch not fully accepted")
	}
}
func (sv *Service) flushBus(ctx context.Context) M {
	config := sv.busConfig()
	if config == nil {
		return M{"enabled": false}
	}
	busMu.Lock()
	defer busMu.Unlock()
	selection := m(sv.transaction(ctx, true, func(tx Tx) any {
		after := s(tx.Get("meta", "bus:published"), "sequence")
		if after == "" {
			after = str(or(config["bootstrapCursor"], "0"))
		}
		return M{"after": after, "events": records(tx.Feed(replicationFeed, after, 101))}
	}))
	events := list(selection, "events")
	selected := events[:min(100, len(events))]
	if len(selected) > 0 {
		for _, v := range list(config, "targets") {
			target := m(v)
			frames := []M{}
			for i := 0; i < len(selected); i += 5 {
				batch := selected[i:min(i+5, len(selected))]
				frames = append(frames, makeFrame(sv.ID, s(target, "installationId"), "events", "cloud:"+s(m(batch[0]), "sequence")+":"+s(m(batch[len(batch)-1]), "sequence"), M{"events": batch}))
			}
			for i := 0; i < len(frames); i += 10 {
				publishFrames(ctx, config, s(target, "address"), frames[i:min(i+10, len(frames))])
			}
		}
		last := s(m(selected[len(selected)-1]), "sequence")
		sv.transaction(ctx, false, func(tx Tx) any {
			previous := s(tx.Get("meta", "bus:published"), "sequence")
			if previous == "" {
				previous = s(selection, "after")
			}
			left, _ := strconv.ParseUint(last, 10, 64)
			right, _ := strconv.ParseUint(previous, 10, 64)
			if left > right {
				tx.Put("meta", "bus:published", M{"sequence": last})
			}
			return nil
		})
	}
	count := sv.flushTelemetry(ctx, config)
	return M{"enabled": true, "published": len(selected) + count, "hasMore": len(events) > len(selected) || count == 25}
}
func (sv *Service) flushTelemetry(ctx context.Context, config M) int {
	observations := a(sv.transaction(ctx, true, func(tx Tx) any {
		out := A{}
		for _, entry := range tx.Entries("telemetry-outbox", 25) {
			out = append(out, list(entry.Value, "items")...)
		}
		return out[:min(25, len(out))]
	}))
	if len(observations) == 0 {
		return 0
	}
	for _, v := range list(config, "targets") {
		target := m(v)
		frames := []M{}
		for i := 0; i < len(observations); i += 5 {
			events := A{}
			for _, observation := range observations[i:min(i+5, len(observations))] {
				events = append(events, M{"type": "telemetry", "observation": observation})
			}
			frames = append(frames, makeFrame(sv.ID, s(target, "installationId"), "events", "telemetry:"+s(m(observations[i]), "id"), M{"events": events}))
		}
		for i := 0; i < len(frames); i += 10 {
			publishFrames(ctx, config, s(target, "address"), frames[i:min(i+10, len(frames))])
		}
	}
	sv.transaction(ctx, false, func(tx Tx) any { acknowledgeObservations(tx, observations); return nil })
	return len(observations)
}
func (sv *Service) consumeFrames(ctx context.Context, inputs A) M {
	config := sv.busConfig()
	if config == nil {
		panicError("Replication bus disabled")
	}
	peers := []string{}
	for _, v := range list(config, "targets") {
		peers = append(peers, s(m(v), "installationId"))
	}
	pings := []M{}
	for _, input := range inputs {
		frame := parseFrame(input, sv.ID, peers)
		if s(frame, "kind") == "ping" {
			pings = append(pings, frame)
			continue
		}
		if s(frame, "kind") == "pong" {
			continue
		}
		rows := A{}
		for _, v := range list(frame, "events") {
			event := m(v)
			switch s(event, "type") {
			case "user", "contact":
				panicError("Directory creation events are not accepted from a broker")
			case "telemetry":
				sv.transaction(ctx, false, func(tx Tx) any { return storeObservation(tx, get(event, "observation"), false) })
			case "external":
				sv.transaction(ctx, false, func(tx Tx) any { return applyExternal(tx, get(event, "operation")) })
			case "identity":
				sv.transaction(ctx, false, func(tx Tx) any { return applyIdentity(tx, get(event, "operation")) })
			case "mutation":
				sv.importMutation(ctx, get(event, "operation"), s(frame, "from"))
			case "row":
				op := get(event, "operation")
				if s(op, "origin") != s(frame, "from") {
					panicError("Wrong row origin")
				}
				rows = append(rows, op)
			case "receipt":
				sv.importReceipt(ctx, event)
			}
		}
		if len(rows) > 0 {
			sv.rowsTransaction(ctx, false, func(r *Rows) any {
				for _, v := range rows {
					r.apply(m(v), false)
				}
				return nil
			})
		}
	}
	result := sv.flushBus(ctx)
	for _, ping := range pings {
		for _, v := range list(config, "targets") {
			target := m(v)
			if s(target, "installationId") == s(ping, "from") {
				publishFrames(ctx, config, s(target, "address"), []M{makeFrame(sv.ID, s(ping, "from"), "pong", s(ping, "id"), M{"pending": b(result, "hasMore")})})
			}
		}
	}
	return M{"processed": len(inputs)}
}
func (sv *Service) consumeQueue(ctx context.Context, event M) M {
	config := sv.busConfig()
	if config == nil || !isArray(event["messages"]) || len(list(event, "messages")) > 5 {
		invalid("queue event")
	}
	frames := A{}
	for _, v := range list(event, "messages") {
		message := m(v)
		details := get(message, "details")
		if s(get(message, "event_metadata"), "event_type") != "yandex.cloud.events.messagequeue.QueueMessage" || s(details, "queue_id") != s(config, "inboxArn") {
			panicError("Unexpected queue source")
		}
		body, ok := get(details, "message")["body"].(string)
		if !ok {
			panicError("Unexpected queue source")
		}
		frames = append(frames, body)
	}
	return sv.consumeFrames(ctx, frames)
}
