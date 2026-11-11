// HTTPS S3 double for isolated integration tests. Fake credentials only.
import { createServer as httpsServer } from "node:https";
import { createServer as httpServer } from "node:http";
import { readFileSync } from "node:fs";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const access = "attachment-test-access";
const secret = "attachment-test-secret-only";
const bucket = "attachments-test";
const objects = new Map();
const calls = [];
let fault;
const encode = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const hash = (v) => createHash("sha256").update(v).digest("hex");
const hmac = (key, value, encoding) => createHmac("sha256", key).update(value).digest(encoding);
const xml = (value) => String(value).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
function valid(request, url) {
  const auth = request.headers.authorization || "";
  const presigned = url.searchParams.has("X-Amz-Signature");
  const credential = presigned ? url.searchParams.get("X-Amz-Credential") : /Credential=([^,]+)/.exec(auth)?.[1];
  const headers = presigned ? url.searchParams.get("X-Amz-SignedHeaders") : /SignedHeaders=([^,]+)/.exec(auth)?.[1];
  const signature = presigned ? url.searchParams.get("X-Amz-Signature") : /Signature=([a-f0-9]+)/.exec(auth)?.[1];
  if (!credential || !headers || !signature) return false;
  const [key, day, region, service, end] = credential.split("/");
  if (key !== access || region !== "ru-central1" || service !== "s3" || end !== "aws4_request") return false;
  const date = presigned ? url.searchParams.get("X-Amz-Date") : request.headers["x-amz-date"];
  if (!date) return false;
  if (presigned) {
    const parsed = Date.parse(date.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));
    if (Date.now() > parsed + Number(url.searchParams.get("X-Amz-Expires")) * 1000 || parsed > Date.now() + 60_000) return false;
  }
  const query = [...url.searchParams].filter(([k]) => k !== "X-Amz-Signature").map(([k, v]) => [encode(k), encode(v)]).sort(([a, av], [b, bv]) => a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0).map(([k, v]) => k + "=" + v).join("&");
  const canonicalHeaders = headers.split(";").map((key) => `${key}:${String(request.headers[key] || "").trim().replace(/\s+/g, " ")}\n`).join("");
  const payloadHash = presigned ? "UNSIGNED-PAYLOAD" : request.headers["x-amz-content-sha256"] || hash("");
  const canonical = [request.method, url.pathname, query, canonicalHeaders, headers, payloadHash].join("\n");
  const scope = [day, region, service, end].join("/");
  const signingKey = hmac(hmac(hmac(hmac("AWS4" + secret, day), region), service), end);
  const computed = hmac(signingKey, ["AWS4-HMAC-SHA256", date, scope, hash(canonical)].join("\n"), "hex");
  return signature.length === computed.length && timingSafeEqual(Buffer.from(signature), Buffer.from(computed));
}
function response(res, status, code) {
  res.writeHead(status, { "Content-Type": "application/xml" });
  res.end(`<Error><Code>${code}</Code></Error>`);
}
async function handle(req, res) {
  const url = new URL(req.url, `https://${req.headers.host}`);
  if (["https://tm.ya-erm.ru", "https://tm.attachments.test"].includes(req.headers.origin)) {
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,PUT");
    res.setHeader("Access-Control-Allow-Headers", "content-type,content-length,x-amz-meta-upload-id,range");
    res.setHeader("Access-Control-Expose-Headers", "ETag,Content-Length,Content-Type,Content-Range");
  }
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }
  if (!valid(req, url)) { response(res, 403, "SignatureDoesNotMatch"); return; }
  if (!url.pathname.startsWith(`/${bucket}`)) { response(res, 404, "NoSuchBucket"); return; }
  const key = decodeURIComponent(url.pathname.slice(bucket.length + 2));
  const op = req.headers["x-amz-copy-source"] ? "COPY" : req.method;
  calls.push({ operation: op, key });
  if (fault?.operation === op && (!fault.prefix || key.startsWith(fault.prefix)) && (!fault.existing || objects.has(key))) {
    if (--fault.count <= 0) fault = undefined;
    response(res, 503, "ServiceUnavailable"); return;
  }
  if (url.searchParams.get("list-type") === "2") {
    const prefix = url.searchParams.get("prefix") || "";
    const after = url.searchParams.get("start-after") || "";
    const items = [...objects.entries()].filter(([k]) => k.startsWith(prefix) && k > after).sort(([a], [b]) => a.localeCompare(b)).slice(0, 100);
    res.setHeader("Content-Type", "application/xml");
    res.end(`<ListBucketResult><Name>${bucket}</Name><IsTruncated>false</IsTruncated>${items.map(([k, v]) => `<Contents><Key>${xml(k)}</Key><Size>${v.body.length}</Size><LastModified>${v.createdAt}</LastModified><ETag>${xml(v.etag)}</ETag></Contents>`).join("")}</ListBucketResult>`); return;
  }
  if (req.method === "DELETE") { objects.delete(key); res.writeHead(204); res.end(); return; }
  if (req.method === "PUT") {
    if (op === "COPY") {
      const sourceKey = decodeURIComponent(req.headers["x-amz-copy-source"]).replace(new RegExp(`^/?${bucket}/`), "");
      const source = objects.get(sourceKey);
      if (!source) { response(res, 404, "NoSuchKey"); return; }
      if (source.etag !== req.headers["x-amz-copy-source-if-match"]) { response(res, 412, "PreconditionFailed"); return; }
      const metadata = Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-amz-meta-")));
      const copied = { ...source, metadata, type: req.headers["content-type"], createdAt: new Date().toISOString() };
      objects.set(key, copied); res.setHeader("Content-Type", "application/xml");
      res.end(`<CopyObjectResult><ETag>${xml(source.etag)}</ETag><LastModified>${copied.createdAt}</LastModified></CopyObjectResult>`); return;
    }
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) { response(res, 413, "EntityTooLarge"); return; } chunks.push(chunk); }
    const body = Buffer.concat(chunks);
    const etag = '"' + createHash("md5").update(body).digest("hex") + '"';
    objects.set(key, { body, etag, type: req.headers["content-type"], metadata: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k.startsWith("x-amz-meta-"))), createdAt: new Date().toISOString() });
    res.setHeader("ETag", etag); res.writeHead(200); res.end(); return;
  }
  const object = objects.get(key);
  if (!object) { response(res, 404, "NoSuchKey"); return; }
  res.setHeader("Content-Type", url.searchParams.get("response-content-type") || object.type);
  res.setHeader("Content-Length", object.body.length);
  res.setHeader("ETag", object.etag);
  for (const [k, v] of Object.entries(object.metadata)) res.setHeader(k, v);
  if (url.searchParams.has("response-content-disposition")) res.setHeader("Content-Disposition", url.searchParams.get("response-content-disposition"));
  res.writeHead(200); res.end(req.method === "HEAD" ? undefined : object.body);
}
const options = { cert: readFileSync(process.env.TEST_S3_CERT), key: readFileSync(process.env.TEST_S3_KEY) };
for (const host of ["127.0.0.1", process.env.TEST_S3_BRIDGE].filter(Boolean)) {
  httpsServer(options, (req, res) => void handle(req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); })).listen(3112, host);
}
httpServer(async (req, res) => {
  if (req.method === "POST") {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body.failNext) fault = { operation: body.failNext, count: body.count || 2, prefix: body.prefix, existing: body.existing };
    if (body.key && objects.has(body.key)) Object.assign(objects.get(body.key), body.patch || {});
  }
  res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ calls, objects: [...objects].map(([key, v]) => ({ key, size: v.body.length, metadata: v.metadata })) }));
}).listen(3113, "127.0.0.1");
console.log("Isolated fake S3 ready");
