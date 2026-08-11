import WebSocket, { WebSocketServer } from "ws";

const host = process.env.WS_HOST || "0.0.0.0";
const port = Number(process.env.WS_PORT || 3001);
const upstream = process.env.WS_UPSTREAM || "http://127.0.0.1:3000";
const inboxLimit = Math.min(Math.max(Number(process.env.WS_INBOX_LIMIT || 10), 1), 50);
const pollIntervalMs = Math.max(Number(process.env.WS_POLL_INTERVAL_MS || 2000), 500);
const weatherCacheTtlMs = 10 * 60_000;
const ratesCacheTtlMs = 60 * 60_000;
const weatherCache = new Map();
let ratesCache;

function tokenFromUpgrade(request) {
  const apiKey = request.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim()) return apiKey.trim();
  const authorization = request.headers.authorization;
  if (typeof authorization === "string" && authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return "";
}

async function rest(token, path, init = {}) {
  const response = await fetch(`${upstream}${path}`, {
    ...init,
    signal: AbortSignal.timeout(7000),
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": token,
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({
    ok: false,
    error: { code: "invalid_response", message: "REST вернул некорректный JSON" },
  }));
  if (!response.ok || !body.ok) {
    const error = new Error(body.error?.message || `REST ${response.status}`);
    error.code = body.error?.code || `http_${response.status}`;
    error.status = response.status;
    throw error;
  }
  return body.data;
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function safeRequestId(value) {
  return typeof value === "string" ? value.slice(0, 64) : "";
}

function safeString(value, maxLength) {
  return typeof value === "string" && value.length <= maxLength ? value : "";
}

async function publicJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(7000) });
  if (!response.ok) throw new Error(`Upstream HTTP ${response.status}`);
  return response.json();
}

function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Некорректное поле ${field}`);
  return number;
}

async function dashboardWeather(latitude, longitude) {
  const lat = finiteNumber(latitude, "latitude");
  const lon = finiteNumber(longitude, "longitude");
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    throw Object.assign(new Error("Некорректные координаты"), { code: "invalid_coordinates" });
  }
  const cacheKey = `${lat.toFixed(4)},${lon.toFixed(4)}`;
  const cached = weatherCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat.toFixed(4));
  url.searchParams.set("longitude", lon.toFixed(4));
  url.searchParams.set("current", "temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m");
  url.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max");
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "4");
  const source = await publicJson(url);
  const current = source.current || {};
  const daily = source.daily || {};
  const four = (values, field) => {
    if (!Array.isArray(values) || values.length < 4) throw new Error(`Некорректное поле ${field}`);
    return values.slice(0, 4).map((value) => finiteNumber(value, field));
  };
  const data = {
    temperature: finiteNumber(current.temperature_2m, "temperature_2m"),
    apparent: finiteNumber(current.apparent_temperature, "apparent_temperature"),
    wind: finiteNumber(current.wind_speed_10m, "wind_speed_10m"),
    humidity: finiteNumber(current.relative_humidity_2m, "relative_humidity_2m"),
    code: finiteNumber(current.weather_code, "weather_code"),
    minTemp: four(daily.temperature_2m_min, "temperature_2m_min"),
    maxTemp: four(daily.temperature_2m_max, "temperature_2m_max"),
    dailyCode: four(daily.weather_code, "daily.weather_code"),
    rainChance: four(daily.precipitation_probability_max, "precipitation_probability_max"),
  };
  if (!weatherCache.has(cacheKey) && weatherCache.size >= 32) {
    weatherCache.delete(weatherCache.keys().next().value);
  }
  weatherCache.set(cacheKey, { data, expiresAt: Date.now() + weatherCacheTtlMs });
  return data;
}

async function dashboardRates() {
  if (ratesCache && ratesCache.expiresAt > Date.now()) return ratesCache.data;
  const pairs = ["EUR", "USD", "RUB"];
  const values = await Promise.all(pairs.map(async (currency) => {
    const source = await publicJson(`https://fxapi.app/api/${currency}/RSD.json`);
    const rate = finiteNumber(source.rate, `${currency}/RSD`);
    if (rate <= 0) throw new Error(`Некорректный курс ${currency}/RSD`);
    return rate;
  }));
  const data = { eurRsd: values[0], usdRsd: values[1], rubRsd: values[2] };
  ratesCache = { data, expiresAt: Date.now() + ratesCacheTtlMs };
  return data;
}

const sockets = new Set();
const wss = new WebSocketServer({ host, port, path: "/ws", maxPayload: 16_384 });

wss.on("connection", async (socket, request) => {
  let timer;
  let state;
  socket.on("close", () => {
    if (state) state.closed = true;
    if (timer) clearInterval(timer);
    sockets.delete(socket);
  });

  const token = tokenFromUpgrade(request);
  if (!token) {
    socket.close(1008, "missing_token");
    return;
  }

  state = {
    token,
    userId: "",
    pendingHash: "",
    syncing: false,
    closed: false,
    messagesInWindow: 0,
    windowStartedAt: Date.now(),
  };
  sockets.add(socket);

  async function sendSnapshot() {
    const inbox = await rest(token, `/api/messages?box=inbox&limit=${inboxLimit}`);
    // The ESP8266 needs only the inbox presentation fields. REST keeps the
    // complete PublicMessage contract; the persistent WSS channel uses this
    // lean projection so repeated snapshots fit without heap fragmentation.
    const messages = inbox.messages.map((message) => ({
      id: message.id,
      fromUserId: message.fromUserId,
      senderName: message.senderName,
      text: message.text,
      kind: message.kind,
      ...(Array.isArray(message.options) ? { options: message.options } : {}),
      status: message.status,
      sentAt: message.sentAt,
    }));
    sendJson(socket, {
      type: "inbox_snapshot",
      ok: true,
      data: { messages },
      serverTime: new Date().toISOString(),
    });
  }

  async function sync(forceSnapshot = false) {
    if (state.closed || state.syncing || socket.readyState !== WebSocket.OPEN) return;
    state.syncing = true;
    try {
      const pending = await rest(token, "/api/messages/poll", {
        method: "POST",
        body: JSON.stringify({ limit: inboxLimit }),
      });
      const pendingHash = JSON.stringify(pending.messages.map((message) => [
        message.id,
        message.status,
        message.answer?.id || "",
      ]));
      if (forceSnapshot || pendingHash !== state.pendingHash) {
        state.pendingHash = pendingHash;
        await sendSnapshot();
      }
    } catch (error) {
      sendJson(socket, {
        type: "error",
        error: { code: error.code || "sync_failed", message: error.message || "Ошибка синхронизации" },
      });
      if (error.status === 401) socket.close(1008, "invalid_token");
    } finally {
      state.syncing = false;
    }
  }

  try {
    const me = await rest(token, "/api/me");
    state.userId = me.user.id;
    socket.on("message", handleMessage);
    timer = setInterval(() => void sync(false), pollIntervalMs);
    sendJson(socket, { type: "ready", protocol: 1, userId: state.userId });
    await sync(true);
  } catch (error) {
    sendJson(socket, {
      type: "error",
      error: { code: error.code || "authentication_failed", message: error.message || "Ошибка авторизации" },
    });
    socket.close(1008, "invalid_token");
    return;
  }

  async function handleMessage(data, isBinary) {
    if (isBinary || data.length > 16_384) {
      socket.close(1009, "payload_too_large");
      return;
    }
    const now = Date.now();
    if (now - state.windowStartedAt >= 60_000) {
      state.windowStartedAt = now;
      state.messagesInWindow = 0;
    }
    if (++state.messagesInWindow > 60) {
      socket.close(1008, "rate_limited");
      return;
    }

    let frame;
    try {
      frame = JSON.parse(data.toString("utf8"));
    } catch {
      sendJson(socket, { type: "error", error: { code: "invalid_json", message: "Ожидался JSON" } });
      return;
    }
    const requestId = safeRequestId(frame.requestId);
    try {
      let syncInboxAfter = true;
      if (frame.type === "refresh") {
        await sync(true);
        syncInboxAfter = false;
      } else if (frame.type === "dashboard_refresh") {
        const includeWeather = frame.weather !== false;
        const includeRates = frame.rates !== false;
        if (!includeWeather && !includeRates) {
          throw Object.assign(new Error("Не выбраны данные dashboard"), { code: "empty_dashboard_request" });
        }
        const [weather, rates] = await Promise.all([
          includeWeather ? dashboardWeather(frame.latitude, frame.longitude) : undefined,
          includeRates ? dashboardRates() : undefined,
        ]);
        sendJson(socket, {
          type: "dashboard_snapshot",
          requestId,
          ok: true,
          ...(weather ? { weather } : {}),
          ...(rates ? { rates } : {}),
          serverTime: new Date().toISOString(),
        });
        syncInboxAfter = false;
      } else if (frame.type === "read") {
        const messageId = safeString(frame.messageId, 128);
        if (!messageId) throw Object.assign(new Error("Некорректный messageId"), { code: "invalid_message_id" });
        await rest(token, `/api/messages/${encodeURIComponent(messageId)}/status`, {
          method: "PATCH",
          body: JSON.stringify({ status: "read" }),
        });
      } else if (frame.type === "answer") {
        const messageId = safeString(frame.messageId, 128);
        const optionId = safeString(frame.id, 128);
        if (!messageId || !optionId) throw Object.assign(new Error("Некорректный ответ"), { code: "invalid_answer" });
        await rest(token, `/api/messages/${encodeURIComponent(messageId)}/answer`, {
          method: "POST",
          body: JSON.stringify({ id: optionId }),
        });
      } else if (frame.type === "send") {
        const toUserId = safeString(frame.toUserId, 128);
        const text = safeString(frame.text, 4096);
        if (!toUserId || !text) throw Object.assign(new Error("Некорректное сообщение"), { code: "invalid_message" });
        await rest(token, "/api/messages", {
          method: "POST",
          body: JSON.stringify({ toUserId, kind: "text", text }),
        });
        const readMessageId = safeString(frame.readMessageId, 128);
        if (readMessageId) {
          await rest(token, `/api/messages/${encodeURIComponent(readMessageId)}/status`, {
            method: "PATCH",
            body: JSON.stringify({ status: "read" }),
          });
        }
      } else {
        throw Object.assign(new Error("Неизвестный тип события"), { code: "unknown_event" });
      }
      sendJson(socket, { type: "ack", requestId, action: frame.type, ok: true });
      if (syncInboxAfter) await sync(true);
    } catch (error) {
      sendJson(socket, {
        type: "ack",
        requestId,
        action: typeof frame.type === "string" ? frame.type : "unknown",
        ok: false,
        error: { code: error.code || "request_failed", message: error.message || "Ошибка запроса" },
      });
    }
  }

});

const heartbeat = setInterval(() => {
  for (const socket of sockets) {
    if (socket.isAlive === false) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 25_000);

wss.on("connection", (socket) => {
  socket.isAlive = true;
  socket.on("pong", () => { socket.isAlive = true; });
});

wss.on("listening", () => {
  console.log(`Tiny Messenger WebSocket gateway listening on ${host}:${port}/ws`);
});

function shutdown() {
  clearInterval(heartbeat);
  for (const socket of sockets) socket.close(1001, "server_shutdown");
  wss.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
