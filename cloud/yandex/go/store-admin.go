package main

import (
	"strconv"
	"strings"
)

type adminReader interface{ AdminRows() []M }

func (tx *ydbTx) AdminRows() []M {
	fields := []string{"bucket", "key", "id", "fromUserId", "toUserId", "groupId", "userId", "at", "lastSeenAt", "opType", "status", "messageId", "groupMessageId", "size", "deletedVersion", "aliveVersion", "contacts"}
	paths := map[string][]string{"id": {"data.id", "operation.message.id", "archive.id"}, "fromUserId": {"data.fromUserId", "operation.message.fromUserId", "archive.fromUserId"}, "toUserId": {"data.toUserId", "operation.message.toUserId", "archive.toUserId"}, "groupId": {"data.groupId", "archive.groupId"}, "userId": {"data.userId", "data.uploaderId", "userId"}, "at": {"data.sentAt", "operation.message.sentAt", "archive.sentAt"}, "lastSeenAt": {"lastSeenAt"}, "opType": {"operation.type"}, "status": {"data.status"}, "messageId": {"data.messageId"}, "groupMessageId": {"data.groupMessageId"}, "size": {"data.confirmedSize", "data.requestedSize"}, "deletedVersion": {"deletedVersion"}, "aliveVersion": {"aliveVersion"}}
	projections := []string{"bucket", "key"}
	for _, field := range fields[2:] {
		if field == "contacts" {
			projections = append(projections, `COALESCE(CAST(JSON_QUERY(CAST(body AS Json),'$.contacts') AS Utf8),'[]'u) AS contacts`)
			continue
		}
		expressions := []string{}
		for _, path := range paths[field] {
			expressions = append(expressions, `JSON_VALUE(CAST(body AS Json),'$.`+path+`')`)
		}
		expressions = append(expressions, `''u`)
		projections = append(projections, "COALESCE("+strings.Join(expressions, ",")+") AS "+field)
	}
	sql := "SELECT " + strings.Join(projections, ",") + ` FROM tm_kv WHERE bucket IN ('rows:Message'u,'rows:GroupMessage'u,'operations'u,'states'u,'rows:GroupMember'u,'rows:Attachment'u,'device-telemetry'u,'user-state'u) ORDER BY bucket,key LIMIT 20001;`
	rows := tx.rows(sql, M{}, fields...)
	for _, row := range rows {
		if s(row, "bucket") == "user-state" {
			row["userId"] = row["key"]
			row["contacts"] = decode(s(row, "contacts"))
		}
		if raw := s(row, "size"); raw != "" {
			size, _ := strconv.ParseFloat(raw, 64)
			row["size"] = size
		}
	}
	return rows
}
