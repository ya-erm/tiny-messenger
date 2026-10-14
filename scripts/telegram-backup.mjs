import { createReadStream } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { exportDatabase, exportDatabasePair } from "./sqlite-json-backup.mjs";

const compareSqlite = process.argv[2] === "--compare-sqlite";
if (process.argv.length > 3 || (process.argv[2] && !compareSqlite)) {
  console.error("Usage: node scripts/telegram-backup.mjs [--compare-sqlite]");
  process.exit(1);
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
if (!/^\d+:[\w-]+$/.test(token ?? "") || !/^\d+$/.test(chatId ?? "")) {
  console.error("Telegram backup secrets are missing or invalid");
  process.exit(1);
}

async function telegram(method, options) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", signal: AbortSignal.timeout(120_000), ...options,
    });
  } catch {
    // Network exceptions may contain the token-bearing URL. Never log them.
    throw new Error("Telegram request failed or timed out; delivery may be unknown");
  }
  let result;
  try { result = await response.json(); } catch { throw new Error(`Invalid Telegram response (HTTP ${response.status})`); }
  if (!response.ok || !result.ok) throw new Error(`Telegram rejected ${method} (HTTP ${response.status})`);
  return result.result;
}

async function sendArchive(file, summary) {
  const size = (await stat(file)).size;
  if (size > 49 * 1024 * 1024) throw new Error("Backup exceeds Telegram's file limit; local archive retained");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  const boundary = `tm-${randomBytes(24).toString("hex")}`;
  const records = Object.values(summary.counts).reduce((a, b) => a + b, 0);
  const users = summary.counts.User ?? 0;
  const messages = (summary.counts.Message ?? 0) + (summary.counts.GroupMessage ?? 0);
  const fields = {
    chat_id: chatId, disable_notification: "true",
    caption: [
      summary.createdAt,
      `${records} записей (users: ${users}, messages: ${messages})`,
      summary.comparison?.trim(),
    ].filter(Boolean).join("\n"),
  };
  const prefix = Buffer.from(Object.entries(fields).map(([name, value]) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  ).join("") + `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${path.basename(file)}"\r\nContent-Type: application/gzip\r\n\r\n`);
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  async function* body() {
    yield prefix;
    yield* createReadStream(file);
    yield suffix;
  }
  const message = await telegram("sendDocument", {
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(prefix.length + size + suffix.length) },
    body: body(), duplex: "half",
  });
  if (String(message.chat.id) !== chatId || message.document?.file_size !== size) throw new Error("Telegram document confirmation does not match archive");
  return { messageId: message.message_id, sha256, bytes: size };
}

try {
  const directory = process.env.BACKUP_DIRECTORY || "/backups";
  const prefix = path.join(directory, `tiny-messenger-${new Date().toISOString().replaceAll(":", "-")}`);
  const database = process.env.BACKUP_DATABASE || "/data/messenger.db";
  let summary;
  let files;
  if (compareSqlite) {
    const pair = await exportDatabasePair(database, prefix);
    summary = { ...pair.summary, comparison: `Один снимок: JSON.gz ${pair.summary.bytes} байт; DB.gz ${pair.sqliteBytes} байт\n` };
    files = [pair.jsonFile, pair.sqliteFile];
    console.log(JSON.stringify({ event: "backup_comparison", jsonBytes: pair.summary.bytes, sqliteBytes: pair.sqliteBytes, databaseBytes: pair.databaseBytes }));
  } else {
    files = [`${prefix}.json.gz`];
    summary = await exportDatabase(database, files[0]);
  }
  for (const file of files) {
    const delivered = await sendArchive(file, summary);
    console.log(JSON.stringify({ event: "backup_delivered", file: path.basename(file), ...summary, ...delivered }));
  }
  // Prune only after successful delivery. Failures keep the newest archive.
  for (const name of await readdir(directory)) {
    if (!/^tiny-messenger-.*\.(json|db)\.gz$/.test(name)) continue;
    const candidate = path.join(directory, name);
    if ((await stat(candidate)).mtimeMs < Date.now() - 14 * 86400_000) await rm(candidate);
  }
} catch (error) {
  const reason = String(error.message).replaceAll(token, "[redacted]");
  console.error(JSON.stringify({ event: "backup_failed", reason }));
  try {
    await telegram("sendMessage", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, disable_notification: true, text: `Tiny Messenger: бэкап не завершён. ${reason}` }),
    });
  } catch { console.error("Could not deliver backup failure notification"); }
  process.exitCode = 1;
}
