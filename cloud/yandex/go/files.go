package main

import (
	"context"
	"math"
	"strconv"
	"strings"
	"time"
)

const thumbnailSuffix = ".thumbnail.webp"

var fileNameRE = regexpMust(`[\\/\x00-\x1f\x7f]`)
var mimeRE = regexpMust(`^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$`)
var looseUUIDRE = regexpMust(`^[0-9a-f-]{36}$`)

func (r *Rows) fileAccess(user, kind, id string) {
	if kind == "group" {
		r.group(id, user)
	} else if kind != "peer" || id == user || r.Get("users", id) == nil {
		fail(404, "chat_not_found", "Чат не найден")
	}
}
func (sv *Service) fileStorage() FileStorage {
	if sv.Storage != nil {
		return sv.Storage
	}
	return S3Storage{fileSettings()}
}
func (sv *Service) createFile(ctx context.Context, actor, body M) M {
	settings := fileSettings()
	if !settings.Enabled && sv.Storage == nil {
		fail(503, "attachments_unconfigured", "Файлы пока не настроены")
	}
	size := n(body["size"])
	if raw, ok := body["size"].(string); ok {
		parsed, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
		if err != nil {
			size = math.NaN()
		} else {
			size = parsed
		}
	}
	name := strings.TrimSpace(fileNameRE.ReplaceAllString(s(body, "name"), "_"))
	request := s(body, "clientRequestId")
	chatID, kind := s(body, "chatId"), s(body, "chatKind")
	if !own(body, "size") || size < 0 || size > float64(settings.MaxFile) || size != float64(int64(size)) || name == "" || len(name) > 255 || !looseUUIDRE.MatchString(request) || !looseUUIDRE.MatchString(chatID) {
		fail(422, "invalid_attachment", "Некорректные параметры файла")
	}
	contentType := strings.ToLower(strings.TrimSpace(strings.Split(s(body, "contentType"), ";")[0]))
	if !mimeRE.MatchString(contentType) {
		contentType = "application/octet-stream"
	}
	var thumb any
	if body["thumbnailSize"] != nil {
		if !safeInteger(body["thumbnailSize"]) || n(body["thumbnailSize"]) < 1 || n(body["thumbnailSize"]) > 102400 || attachmentPreview(contentType) != "image" {
			fail(422, "invalid_thumbnail", "Некорректные параметры миниатюры")
		}
		thumb = body["thumbnailSize"]
	}
	item := m(sv.rowsTransaction(ctx, false, func(r *Rows) any {
		r.fileAccess(s(actor, "id"), kind, chatID)
		if prior := r.Get("file-request:"+s(actor, "id"), request); prior != nil {
			old := r.file(s(prior, "id"))
			if old == nil || s(old, "chatKind") != kind || s(old, "chatId") != chatID || s(old, "originalName") != name || n(old["requestedSize"]) != size || s(old, "contentType") != contentType || n(old["thumbnailSize"]) != n(thumb) {
				fail(409, "upload_request_conflict", "Идентификатор уже использован")
			}
			if !contains([]string{"pending", "uploaded", "attached"}, s(old, "status")) {
				fail(409, "upload_not_available", "Загрузка недоступна")
			}
			return old
		}
		pending := 0
		reserved := float64(0)
		for _, ref := range r.Scan("files-by:"+s(actor, "id"), 10000) {
			old := r.file(s(ref, "id"))
			if old != nil {
				if contains([]string{"pending", "verifying", "uploaded"}, s(old, "status")) {
					pending++
				}
				reserved += n(old["reservedBytes"])
			}
		}
		if int64(pending) >= settings.MaxPending {
			fail(429, "too_many_uploads", "Слишком много незавершённых загрузок")
		}
		if reserved+size+n(thumb) > float64(settings.Quota) {
			fail(413, "attachment_quota_exceeded", "Недостаточно места")
		}
		if r.state("Attachment", request) != nil {
			fail(409, "upload_request_conflict", "Идентификатор уже использован")
		}
		at := time.Now()
		data := M{"id": request, "uploaderId": actor["id"], "clientRequestId": request, "chatKind": kind, "chatId": chatID, "stagingKey": settings.objectKey("staging", request), "objectKey": settings.objectKey("attachments", request), "originalName": name, "contentType": contentType, "requestedSize": size, "thumbnailSize": thumb, "reservedBytes": size + n(thumb), "status": "pending", "createdAt": iso(at), "expiresAt": iso(at.Add(time.Duration(settings.UploadTTL) * time.Second)), "abandonAt": iso(at.Add(time.Duration(settings.UnattachedTTL) * time.Millisecond))}
		return get(r.put("Attachment", data, false, false), "data")
	}))
	result := M{"attachment": fileInfo(item), "upload": nil, "thumbnailUpload": nil}
	if s(item, "status") == "pending" {
		storage := sv.fileStorage()
		result["upload"] = storage.Upload(s(item, "id"), s(item, "stagingKey"), int64(n(item["requestedSize"])), s(item, "contentType"), s(item, "expiresAt"))
		if truth(item["thumbnailSize"]) {
			result["thumbnailUpload"] = storage.Upload(s(item, "id")+"-thumbnail", s(item, "stagingKey")+thumbnailSuffix, int64(n(item["thumbnailSize"])), "image/webp", s(item, "expiresAt"))
		}
	}
	return result
}
func (sv *Service) completeFile(ctx context.Context, actor M, id string) M {
	lease := uuid()
	item := m(sv.rowsTransaction(ctx, false, func(r *Rows) any {
		old := r.file(id)
		if old == nil || s(old, "uploaderId") != s(actor, "id") {
			fail(404, "attachment_not_found", "Файл не найден")
		}
		r.fileAccess(s(actor, "id"), s(old, "chatKind"), s(old, "chatId"))
		if contains([]string{"uploaded", "attached"}, s(old, "status")) {
			return old
		}
		if !contains([]string{"pending", "verifying"}, s(old, "status")) || !parseTime(s(old, "abandonAt")).After(time.Now()) {
			fail(410, "upload_expired", "Загрузка истекла")
		}
		if s(old, "status") == "verifying" && parseTime(s(old, "leaseUntil")).After(time.Now()) {
			fail(409, "upload_verifying", "Файл уже проверяется")
		}
		return get(r.put("Attachment", M{"id": id, "status": "verifying", "leaseToken": lease, "leaseUntil": iso(time.Now().Add(30 * time.Second))}, false, true), "data")
	}))
	if contains([]string{"uploaded", "attached"}, s(item, "status")) {
		return M{"attachment": fileInfo(item)}
	}
	result, err := caught(func() any {
		storage := sv.fileStorage()
		final := storage.Head(ctx, id, s(item, "objectKey"))
		sourceEtag := s(item, "sourceEtag")
		if final == nil {
			source := storage.Head(ctx, id, s(item, "stagingKey"))
			if source == nil {
				fail(409, "upload_missing", "Файл ещё не загружен")
			}
			if n(source["ContentLength"]) != n(item["requestedSize"]) || s(source, "ContentType") != s(item, "contentType") || s(get(source, "Metadata"), "upload-id") != id || s(source, "ETag") == "" {
				fail(422, "attachment_mismatch", "Параметры файла не совпадают")
			}
			sourceEtag = s(source, "ETag")
			sv.rowsTransaction(ctx, false, func(r *Rows) any { return r.put("Attachment", M{"id": id, "sourceEtag": sourceEtag}, false, true) })
			storage.Freeze(ctx, id, s(item, "stagingKey"), s(item, "objectKey"), sourceEtag, s(item, "contentType"))
			final = storage.Head(ctx, id, s(item, "objectKey"))
		}
		if final == nil || s(final, "ETag") == "" || sourceEtag == "" || n(final["ContentLength"]) != n(item["requestedSize"]) || s(final, "ContentType") != s(item, "contentType") || s(get(final, "Metadata"), "upload-id") != id || s(get(final, "Metadata"), "source-etag") != strings.Trim(sourceEtag, "\"") {
			fail(422, "attachment_mismatch", "Не удалось подтвердить файл")
		}
		thumbKey := sv.completeThumbnail(ctx, id, item, storage)
		return sv.rowsTransaction(ctx, false, func(r *Rows) any {
			current := r.file(id)
			if s(current, "leaseToken") != lease || s(current, "status") != "verifying" {
				fail(409, "upload_changed", "Загрузка изменилась")
			}
			value := r.put("Attachment", M{"id": id, "status": "uploaded", "confirmedSize": n(final["ContentLength"]), "thumbnailKey": thumbKey, "reservedBytes": n(final["ContentLength"]) + n(item["thumbnailSize"]), "etag": final["ETag"], "leaseToken": nil, "leaseUntil": nil}, false, true)
			return M{"attachment": fileInfo(get(value, "data"))}
		})
	})
	if err != nil {
		sv.rowsTransaction(ctx, false, func(r *Rows) any {
			if current := r.file(id); s(current, "leaseToken") == lease {
				r.put("Attachment", M{"id": id, "status": "pending", "leaseToken": nil, "leaseUntil": nil}, false, true)
			}
			return nil
		})
		panic(err)
	}
	return m(result)
}
func (sv *Service) completeThumbnail(ctx context.Context, id string, item M, storage FileStorage) any {
	size := n(item["thumbnailSize"])
	if size == 0 {
		return nil
	}
	uploadID, key := id+"-thumbnail", s(item, "objectKey")+thumbnailSuffix
	final := storage.Head(ctx, uploadID, key)
	if final == nil {
		source := storage.Head(ctx, uploadID, s(item, "stagingKey")+thumbnailSuffix)
		if source == nil {
			return nil
		}
		if n(source["ContentLength"]) != size || s(source, "ContentType") != "image/webp" || s(get(source, "Metadata"), "upload-id") != uploadID || s(source, "ETag") == "" {
			fail(422, "thumbnail_mismatch", "Параметры миниатюры не совпадают")
		}
		storage.Freeze(ctx, uploadID, s(item, "stagingKey")+thumbnailSuffix, key, s(source, "ETag"), "image/webp")
		final = storage.Head(ctx, uploadID, key)
	}
	if s(final, "ETag") == "" || n(final["ContentLength"]) != size || s(final, "ContentType") != "image/webp" || s(get(final, "Metadata"), "upload-id") != uploadID || s(get(final, "Metadata"), "source-etag") == "" {
		fail(422, "thumbnail_mismatch", "Не удалось подтвердить миниатюру")
	}
	return key
}
func (sv *Service) cancelFile(ctx context.Context, actor M, id string) M {
	sv.rowsTransaction(ctx, false, func(r *Rows) any {
		data := r.file(id)
		if data == nil || s(data, "uploaderId") != s(actor, "id") {
			fail(404, "attachment_not_found", "Файл не найден")
		}
		if s(data, "status") == "attached" || truth(data["messageId"]) || truth(data["groupMessageId"]) {
			fail(409, "attachment_attached", "Файл уже отправлен")
		}
		return r.put("Attachment", M{"id": id, "status": "failed", "leaseToken": nil, "leaseUntil": nil}, false, true)
	})
	return M{"cancelled": true}
}
func (sv *Service) fileLink(ctx context.Context, actor M, id string, preview, thumbnail bool) M {
	data := m(sv.rowsTransaction(ctx, true, func(r *Rows) any {
		item := r.file(id)
		if item == nil || s(item, "status") != "attached" {
			fail(404, "attachment_not_found", "Файл недоступен")
		}
		grouped := truth(item["groupMessageId"])
		messageID := s(item, "messageId")
		if grouped {
			messageID = s(item, "groupMessageId")
		}
		if messageID == "" {
			fail(404, "attachment_not_found", "Файл недоступен")
		}
		message := r.row(messageTable(grouped), messageID)
		r.messageRecord(message, s(actor, "id"), grouped, true)
		if !grouped {
			peer := s(message, "fromUserId")
			if peer == s(actor, "id") {
				peer = s(message, "toUserId")
			}
			if r.row("HiddenConversation", s(actor, "id"), peer) != nil {
				fail(404, "attachment_not_found", "Файл недоступен")
			}
		}
		return item
	}))
	if preview && attachmentPreview(s(data, "contentType")) == nil {
		fail(422, "preview_unavailable", "Для файла доступно только скачивание")
	}
	key, contentType := s(data, "objectKey"), s(data, "contentType")
	if thumbnail && truth(data["thumbnailKey"]) {
		key, contentType = s(data, "thumbnailKey"), "image/webp"
	}
	return sv.fileStorage().Download(id, key, s(data, "originalName"), contentType, preview)
}
