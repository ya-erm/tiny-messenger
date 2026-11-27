package main

import (
	"context"
	"strings"
	"testing"
)

type fakeFiles struct{ objects map[string]M }

func (f *fakeFiles) Upload(id, key string, size int64, contentType, expires string) M {
	return M{"url": "https://storage.example/upload", "method": "PUT", "headers": M{"Content-Type": contentType, "x-amz-meta-upload-id": id}, "expiresAt": expires}
}
func (f *fakeFiles) Download(id, key, name, contentType string, preview bool) M {
	return M{"url": "https://storage.example/" + key, "expiresAt": now()}
}
func (f *fakeFiles) Head(ctx context.Context, id, key string) M { return clone(f.objects[key]) }
func (f *fakeFiles) Freeze(ctx context.Context, id, source, destination, etag, contentType string) {
	sourceObject := f.objects[source]
	if sourceObject == nil || s(sourceObject, "ETag") != etag {
		panicError("bad source")
	}
	f.objects[destination] = M{"ContentLength": sourceObject["ContentLength"], "ContentType": contentType, "ETag": "\"final\"", "Metadata": M{"upload-id": id, "source-etag": strings.Trim(etag, "\"")}}
}
func TestFilesLifecycleAccessAndThumbnail(t *testing.T) {
	t.Setenv("ATTACHMENTS_S3_BUCKET", "test-bucket")
	t.Setenv("ATTACHMENTS_S3_ACCESS_KEY_ID", "synthetic-access")
	t.Setenv("ATTACHMENTS_S3_SECRET_ACCESS_KEY", "synthetic-secret")
	ctx := context.Background()
	db := newMemoryDB()
	files := &fakeFiles{objects: map[string]M{}}
	sv := &Service{Database: db, ID: "test-cloud", Config: M{}, Storage: files}
	actor, peer, outsider := M{}, M{}, M{}
	for i, u := range []M{actor, peer, outsider} {
		u["id"] = "00000000-0000-4000-8000-00000000000" + formatInt(i+1)
		u["name"] = "Тест"
		u["createdAt"] = now()
		u["updatedAt"] = now()
		u["tokenHash"] = sha(formatInt(i))
		_, err := db.Transaction(ctx, false, func(tx Tx) any { tx.Put("users", s(u, "id"), u); return nil })
		if err != nil {
			t.Fatal(err)
		}
	}
	id := "00000000-0000-4000-8000-000000000011"
	body := M{"chatKind": "peer", "chatId": peer["id"], "size": 42, "name": "Картинка.png", "contentType": "image/png", "thumbnailSize": 12, "clientRequestId": id}
	created := sv.createFile(ctx, actor, body)
	if !b(get(created, "attachment"), "hasThumbnail") && get(created, "thumbnailUpload") == nil {
		t.Fatal("thumbnail URL absent")
	}
	if sv.createFile(ctx, actor, body)["attachment"] == nil {
		t.Fatal("upload retry failed")
	}
	settings := fileSettings()
	stage, key := settings.objectKey("staging", id), settings.objectKey("attachments", id)
	files.objects[stage] = M{"ContentLength": 42, "ContentType": "image/png", "ETag": "\"source\"", "Metadata": M{"upload-id": id}}
	files.objects[stage+thumbnailSuffix] = M{"ContentLength": 12, "ContentType": "image/webp", "ETag": "\"thumb\"", "Metadata": M{"upload-id": id + "-thumbnail"}}
	completed := sv.completeFile(ctx, actor, id)
	if !b(get(completed, "attachment"), "hasThumbnail") {
		t.Fatal("thumbnail not confirmed")
	}
	sv.completeFile(ctx, actor, id)
	_, err := caught(func() any { return sv.fileLink(ctx, peer, id, true, false) })
	if he, ok := err.(*HTTPError); !ok || he.Status != 404 {
		t.Fatal("unattached file became readable", err)
	}
	sv.createMessage(ctx, actor, M{"toUserId": peer["id"], "text": "Файл", "attachmentIds": A{id}, "clientRequestId": "00000000-0000-4000-8000-000000000012"}, false)
	if url := s(sv.fileLink(ctx, peer, id, true, false), "url"); !strings.HasSuffix(url, key) {
		t.Fatal("wrong final file link")
	}
	if url := s(sv.fileLink(ctx, peer, id, true, true), "url"); !strings.HasSuffix(url, key+thumbnailSuffix) {
		t.Fatal("wrong thumbnail link")
	}
	for _, action := range []func() any{func() any { return sv.fileLink(ctx, outsider, id, true, false) }, func() any { return sv.cancelFile(ctx, actor, id) }} {
		_, err := caught(action)
		if _, ok := err.(*HTTPError); !ok {
			t.Fatal("access/lifecycle not guarded", err)
		}
	}
	sv.modifyMessage(ctx, actor, "00000000-0000-4000-8000-000000000012", M{"scope": "everyone"}, "delete", false, nil)
	_, err = caught(func() any { return sv.fileLink(ctx, peer, id, true, false) })
	if he, ok := err.(*HTTPError); !ok || he.Status != 404 {
		t.Fatal("deleted message attachment readable", err)
	}
}
