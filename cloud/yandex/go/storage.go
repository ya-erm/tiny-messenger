package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

func env(name, fallback string) string {
	v := os.Getenv(name)
	if v == "" {
		return fallback
	}
	return v
}
func envInt(name string, fallback, maximum int64) int64 {
	raw := env(name, strconv.FormatInt(fallback, 10))
	v, e := strconv.ParseInt(raw, 10, 64)
	if e != nil || v <= 0 || v > maximum {
		panicError("Invalid attachment limit")
	}
	return v
}

type FileSettings struct {
	Endpoint, Region, Bucket, AccessKey, Secret, Prefix                         string
	Enabled                                                                     bool
	MaxFile, MaxFiles, MaxPending, Quota, UploadTTL, DownloadTTL, UnattachedTTL int64
}

func fileSettings() FileSettings {
	v := FileSettings{Endpoint: env("ATTACHMENTS_S3_ENDPOINT", "https://storage.yandexcloud.net"), Region: env("ATTACHMENTS_S3_REGION", "ru-central1"), Bucket: env("ATTACHMENTS_S3_BUCKET", ""), AccessKey: env("ATTACHMENTS_S3_ACCESS_KEY_ID", ""), Secret: env("ATTACHMENTS_S3_SECRET_ACCESS_KEY", ""), Prefix: env("ATTACHMENTS_S3_PREFIX", "")}
	validateEndpoint(v.Endpoint)
	if v.Prefix != "" && !regexpMust(`^[a-z0-9-]+(?:/[a-z0-9-]+)*$`).MatchString(v.Prefix) {
		panicError("Invalid attachment prefix")
	}
	v.Enabled = v.Bucket != "" && v.AccessKey != "" && v.Secret != ""
	if v.Enabled && v.Bucket == os.Getenv("LITESTREAM_BUCKET") {
		panicError("Attachments require a separate bucket")
	}
	v.MaxFile = envInt("ATTACHMENTS_MAX_FILE_BYTES", 50*1024*1024, 5*1024*1024*1024)
	v.MaxFiles = envInt("ATTACHMENTS_MAX_FILES_PER_MESSAGE", 4, 10)
	v.MaxPending = envInt("ATTACHMENTS_MAX_PENDING", 4, 20)
	v.Quota = envInt("ATTACHMENTS_USER_QUOTA_BYTES", 1024*1024*1024, 9007199254740991)
	v.UploadTTL = envInt("ATTACHMENTS_UPLOAD_TTL_SECONDS", 600, 1800)
	v.DownloadTTL = envInt("ATTACHMENTS_DOWNLOAD_TTL_SECONDS", 3600, 86400)
	v.UnattachedTTL = envInt("ATTACHMENTS_UNATTACHED_TTL_HOURS", 24, 9007199254740991) * 3600000
	return v
}
func (v FileSettings) limits() M {
	return M{"enabled": v.Enabled, "maxFileBytes": v.MaxFile, "maxFilesPerMessage": v.MaxFiles, "maxPending": v.MaxPending, "userQuotaBytes": v.Quota, "thumbnails": true}
}
func (v FileSettings) objectKey(kind, id string) string {
	prefix := ""
	if v.Prefix != "" {
		prefix = v.Prefix + "/"
	}
	return prefix + kind + "/" + id
}
func validateEndpoint(endpoint string) *url.URL {
	u, err := url.Parse(endpoint)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		panicError("Invalid storage endpoint")
	}
	return u
}
func awsEscape(v string) string { return strings.ReplaceAll(url.QueryEscape(v), "+", "%20") }
func canonicalQuery(values url.Values) string {
	pairs := []string{}
	for k, vs := range values {
		for _, v := range vs {
			pairs = append(pairs, awsEscape(k)+"="+awsEscape(v))
		}
	}
	sort.Strings(pairs)
	return strings.Join(pairs, "&")
}
func awsPath(path string) string {
	parts := strings.Split(path, "/")
	for i, v := range parts {
		parts[i] = awsEscape(v)
	}
	return strings.Join(parts, "/")
}
func hmacBytes(key []byte, value string) []byte {
	h := hmac.New(sha256.New, key)
	h.Write([]byte(value))
	return h.Sum(nil)
}
func signatureKey(secret, day, region, service string) []byte {
	key := []byte("AWS4" + secret)
	for _, v := range []string{day, region, service, "aws4_request"} {
		key = hmacBytes(key, v)
	}
	return key
}
func canonicalHeaders(headers map[string]string) (string, string) {
	keys := []string{}
	for k := range headers {
		keys = append(keys, strings.ToLower(k))
	}
	sort.Strings(keys)
	var value strings.Builder
	for _, k := range keys {
		value.WriteString(k + ":" + strings.Join(strings.Fields(headers[k]), " ") + "\n")
	}
	return value.String(), strings.Join(keys, ";")
}
func signAWS(method string, u *url.URL, headers map[string]string, body, region, service, access, secret string, at time.Time) {
	date := at.UTC().Format("20060102T150405Z")
	day := date[:8]
	headers["host"] = u.Host
	headers["x-amz-date"] = date
	canonical, signed := canonicalHeaders(headers)
	scope := day + "/" + region + "/" + service + "/aws4_request"
	request := strings.Join([]string{method, u.EscapedPath(), canonicalQuery(u.Query()), canonical, signed, sha(body)}, "\n")
	signature := hex.EncodeToString(hmacBytes(signatureKey(secret, day, region, service), "AWS4-HMAC-SHA256\n"+date+"\n"+scope+"\n"+sha(request)))
	headers["authorization"] = "AWS4-HMAC-SHA256 Credential=" + access + "/" + scope + ", SignedHeaders=" + signed + ", Signature=" + signature
}
func (v FileSettings) objectURL(key string) *url.URL {
	u := validateEndpoint(v.Endpoint)
	u.Path = strings.TrimSuffix(u.Path, "/") + "/" + v.Bucket + "/" + key
	u.RawPath = awsPath(u.Path)
	return u
}
func (v FileSettings) presign(method, key string, headers map[string]string, query url.Values, expires int64, at time.Time) string {
	if !v.Enabled {
		fail(503, "attachments_unconfigured", "Отправка файлов пока не настроена")
	}
	u := v.objectURL(key)
	headers["host"] = u.Host
	canonical, signed := canonicalHeaders(headers)
	date := at.UTC().Format("20060102T150405Z")
	day := date[:8]
	scope := day + "/" + v.Region + "/s3/aws4_request"
	query.Set("X-Amz-Algorithm", "AWS4-HMAC-SHA256")
	query.Set("X-Amz-Credential", v.AccessKey+"/"+scope)
	query.Set("X-Amz-Date", date)
	query.Set("X-Amz-Expires", strconv.FormatInt(expires, 10))
	query.Set("X-Amz-SignedHeaders", signed)
	request := strings.Join([]string{method, u.EscapedPath(), canonicalQuery(query), canonical, signed, "UNSIGNED-PAYLOAD"}, "\n")
	sig := hex.EncodeToString(hmacBytes(signatureKey(v.Secret, day, v.Region, "s3"), "AWS4-HMAC-SHA256\n"+date+"\n"+scope+"\n"+sha(request)))
	query.Set("X-Amz-Signature", sig)
	u.RawQuery = canonicalQuery(query)
	return u.String()
}

type FileStorage interface {
	Upload(string, string, int64, string, string) M
	Download(string, string, string, string, bool) M
	Head(context.Context, string, string) M
	Freeze(context.Context, string, string, string, string, string)
}
type S3Storage struct{ Settings FileSettings }

func (v S3Storage) Upload(id, key string, size int64, contentType, expiresAt string) M {
	at := time.Now()
	seconds := int64(parseTime(expiresAt).Sub(at).Seconds())
	if seconds <= 0 {
		fail(410, "upload_expired", "Срок загрузки истёк. Выберите файл заново.")
	}
	headers := map[string]string{"content-length": strconv.FormatInt(size, 10), "content-type": contentType, "x-amz-meta-upload-id": id}
	link := v.Settings.presign("PUT", key, headers, url.Values{}, seconds, at)
	return M{"url": link, "method": "PUT", "headers": M{"Content-Type": contentType, "x-amz-meta-upload-id": id}, "expiresAt": expiresAt}
}
func (v S3Storage) Download(id, key, name, contentType string, preview bool) M {
	disposition := "attachment"
	if preview {
		disposition = "inline"
	}
	disposition += "; filename=\"download\"; filename*=UTF-8''" + awsEscape(name)
	responseType := "application/octet-stream"
	if preview {
		responseType = contentType
	}
	q := url.Values{"response-content-disposition": {disposition}, "response-content-type": {responseType}, "response-cache-control": {"private, max-age=3600"}}
	at := time.Now()
	link := v.Settings.presign("GET", key, map[string]string{}, q, v.Settings.DownloadTTL, at)
	return M{"url": link, "expiresAt": iso(at.Add(time.Duration(v.Settings.DownloadTTL) * time.Second))}
}

var storageHTTP = &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func (v S3Storage) request(ctx context.Context, method, key string, headers map[string]string) (*http.Response, []byte) {
	settings := v.Settings
	if !settings.Enabled {
		fail(503, "attachments_unconfigured", "Отправка файлов пока не настроена")
	}
	u := settings.objectURL(key)
	headers["x-amz-content-sha256"] = sha("")
	signAWS(method, u, headers, "", settings.Region, "s3", settings.AccessKey, settings.Secret, time.Now())
	var response *http.Response
	var raw []byte
	_, err := caught(func() any {
		for attempt := 0; attempt < 2; attempt++ {
			req, e := http.NewRequestWithContext(ctx, method, u.String(), nil)
			if e != nil {
				panic(e)
			}
			for k, val := range headers {
				req.Header.Set(k, val)
			}
			res, e := storageHTTP.Do(req)
			if e != nil {
				if attempt == 0 {
					continue
				}
				panic(e)
			}
			response = res
			raw, e = io.ReadAll(io.LimitReader(res.Body, 1024*1024))
			res.Body.Close()
			if e != nil {
				panic(e)
			}
			if res.StatusCode >= 500 && attempt == 0 {
				continue
			}
			if res.StatusCode >= 200 && res.StatusCode < 300 || res.StatusCode == 404 {
				return nil
			}
			panicError("storage request failed")
		}
		if response == nil {
			panicError("storage request failed")
		}
		return nil
	})
	if err != nil {
		fail(502, "attachment_storage_unavailable", "Хранилище файлов временно недоступно. Попробуйте ещё раз.")
	}
	return response, raw
}
func (v S3Storage) Head(ctx context.Context, id, key string) M {
	res, _ := v.request(ctx, "HEAD", key, map[string]string{})
	if res.StatusCode == 404 {
		return nil
	}
	size, err := strconv.ParseInt(res.Header.Get("Content-Length"), 10, 64)
	if err != nil {
		fail(502, "attachment_storage_unavailable", "Хранилище файлов временно недоступно")
	}
	return M{"ContentLength": size, "ContentType": res.Header.Get("Content-Type"), "ETag": res.Header.Get("ETag"), "Metadata": M{"upload-id": res.Header.Get("x-amz-meta-upload-id"), "source-etag": res.Header.Get("x-amz-meta-source-etag")}}
}
func (v S3Storage) Freeze(ctx context.Context, id, source, destination, etag, contentType string) {
	headers := map[string]string{"x-amz-copy-source": awsPath(v.Settings.Bucket + "/" + source), "x-amz-copy-source-if-match": etag, "x-amz-metadata-directive": "REPLACE", "x-amz-meta-upload-id": id, "x-amz-meta-source-etag": strings.Trim(etag, "\""), "content-type": contentType, "content-disposition": "attachment", "cache-control": "private, max-age=0", "x-amz-storage-class": "STANDARD"}
	res, raw := v.request(ctx, "PUT", destination, headers)
	if res.StatusCode == 404 || strings.Contains(string(raw), "<Error>") {
		fail(502, "attachment_storage_unavailable", "Хранилище файлов временно недоступно")
	}
}
func formatInt(v int) string { return fmt.Sprint(v) }
