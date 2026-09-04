import assert from "node:assert/strict";
import WebSocket from "ws";

const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:3107";
const wsUrl = process.env.TEST_WS_URL || "ws://127.0.0.1:3107/ws";

async function api(path, { token, ...init } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-API-Key": token } : {}),
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${JSON.stringify(body)}`);
  return body.data;
}

function waitFor(socket, predicate, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("WebSocket event timeout"));
    }, timeoutMs);
    function onMessage(data) {
      const frame = JSON.parse(data.toString("utf8"));
      if (!predicate(frame)) return;
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(frame);
    }
    socket.on("message", onMessage);
  });
}

const alice = await api("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "WS Алиса" }),
});
const bob = await api("/api/auth/register", {
  method: "POST",
  body: JSON.stringify({ name: "WS Боря" }),
});

const socket = new WebSocket(wsUrl, { headers: { "X-API-Key": bob.token } });
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
const ready = await waitFor(socket, (frame) => frame.type === "ready");
assert.equal(ready.protocol, 1);
await waitFor(socket, (frame) => frame.type === "inbox_snapshot");

const dashboardSnapshotPromise = waitFor(
  socket,
  (frame) => frame.type === "dashboard_snapshot" && frame.requestId === "dashboard-1",
  12_000,
);
const dashboardAckPromise = waitFor(
  socket,
  (frame) => frame.type === "ack" && frame.requestId === "dashboard-1",
  12_000,
);
socket.send(JSON.stringify({
  type: "dashboard_refresh",
  requestId: "dashboard-1",
  weather: true,
  rates: true,
  latitude: 44.8176,
  longitude: 20.4633,
}));
const dashboard = await dashboardSnapshotPromise;
assert.equal(dashboard.ok, true);
assert.equal(Number.isFinite(dashboard.weather.temperature), true);
assert.equal(Number.isFinite(dashboard.weather.apparent), true);
assert.equal(Array.isArray(dashboard.weather.minTemp), true);
assert.equal(dashboard.weather.minTemp.length, 4);
assert.equal(dashboard.weather.maxTemp.length, 4);
assert.equal(dashboard.weather.dailyCode.length, 4);
assert.equal(dashboard.weather.rainChance.length, 4);
assert.equal(Number.isFinite(dashboard.rates.eurRsd), true);
assert.equal((await dashboardAckPromise).ok, true);

const created = await api("/api/messages", {
  token: alice.token,
  method: "POST",
  body: JSON.stringify({ toUserId: bob.user.id, kind: "text", text: "WS проверка" }),
});
const snapshot = await waitFor(
  socket,
  (frame) => frame.type === "inbox_snapshot" &&
    Array.isArray(frame.data?.messages) &&
    frame.data.messages.some((message) => message.id === created.message.id),
  10_000,
);
assert.equal(snapshot.data.messages.find((message) => message.id === created.message.id).status, "delivered");

socket.send(JSON.stringify({ type: "read", requestId: "read-1", messageId: created.message.id }));
const ack = await waitFor(socket, (frame) => frame.type === "ack" && frame.requestId === "read-1");
assert.equal(ack.ok, true);
const read = await api(`/api/messages/${created.message.id}`, { token: bob.token });
assert.equal(read.message.status, "read");

const choice = await api("/api/messages", {
  token: alice.token,
  method: "POST",
  body: JSON.stringify({
    toUserId: bob.user.id,
    kind: "choice",
    text: "Выбери вариант",
    options: [{ id: "yes", label: "Да" }, { id: "no", label: "Нет" }],
  }),
});
await waitFor(
  socket,
  (frame) => frame.type === "inbox_snapshot" &&
    frame.data?.messages?.some((message) => message.id === choice.message.id),
  10_000,
);
socket.send(JSON.stringify({
  type: "answer",
  requestId: "answer-1",
  messageId: choice.message.id,
  id: "no",
}));
const answerAck = await waitFor(
  socket,
  (frame) => frame.type === "ack" && frame.requestId === "answer-1",
);
assert.equal(answerAck.ok, true);
const answered = await api(`/api/messages/${choice.message.id}`, { token: bob.token });
assert.equal(answered.message.status, "answered");
assert.equal(answered.message.answer.id, "no");

const incoming = await api("/api/messages", {
  token: alice.token,
  method: "POST",
  body: JSON.stringify({ toUserId: bob.user.id, kind: "text", text: "Нужен ответ" }),
});
await waitFor(
  socket,
  (frame) => frame.type === "inbox_snapshot" &&
    frame.data?.messages?.some((message) => message.id === incoming.message.id),
  10_000,
);
socket.send(JSON.stringify({
  type: "send",
  requestId: "send-1",
  toUserId: alice.user.id,
  text: "Хорошо",
  readMessageId: incoming.message.id,
}));
const sendAck = await waitFor(
  socket,
  (frame) => frame.type === "ack" && frame.requestId === "send-1",
);
assert.equal(sendAck.ok, true);
const sourceAfterReply = await api(`/api/messages/${incoming.message.id}`, { token: bob.token });
assert.equal(sourceAfterReply.message.status, "read");
const aliceInbox = await api("/api/messages?box=inbox&limit=10", { token: alice.token });
assert.equal(aliceInbox.messages.some((message) => message.text === "Хорошо"), true);

socket.close();
console.log("WebSocket smoke test passed: dashboard + inbox/push + read/answer/send");
