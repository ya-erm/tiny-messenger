import { createServer } from "node:http";

import next from "next";

import { RealtimeService } from "./realtime-service.mjs";
import { attachWebSocketTransport } from "./ws-gateway.mjs";

function positivePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${value}`);
  }
  return port;
}

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = positivePort(process.env.PORT || 3000);
const server = createServer();
const app = next({ dev, hostname, port, httpServer: server });
const upstream = `http://127.0.0.1:${port}`;
const realtime = new RealtimeService({ upstream });

await app.prepare();

const handle = app.getRequestHandler();
const handleNextUpgrade = app.getUpgradeHandler();

// Next.js 16.3 otherwise adds a second, unfiltered Upgrade listener on the
// first HTTP request. This server owns Upgrade routing so /ws is handled once,
// while framework-owned paths (notably dev HMR) are delegated back to Next.js.
if (!("didWebSocketSetup" in app)) {
  throw new Error("Unsupported Next.js custom server: Upgrade setup changed");
}
app.didWebSocketSetup = true;

const websocket = attachWebSocketTransport(server, {
  upstream,
  onConnection: (connection) => realtime.claimConnection(connection),
  onUnhandledUpgrade: handleNextUpgrade,
});

server.on("request", (request, response) => {
  void handle(request, response).catch((error) => {
    console.error(`Failed to handle ${request.method || "HTTP"} ${request.url || "/"}`, error);
    if (!response.headersSent) response.statusCode = 500;
    if (!response.writableEnded) response.end("Internal Server Error");
  });
});

const listenError = await new Promise((resolve) => {
  function onError(error) {
    resolve(error);
  }
  server.once("error", onError);
  server.listen(port, hostname, () => {
    server.off("error", onError);
    resolve(null);
  });
});

if (listenError) {
  console.error("Failed to start Tiny Messenger", listenError);
  await Promise.allSettled([realtime.shutdown(), websocket.close(), app.close()]);
  process.exit(1);
}

console.log(`Tiny Messenger listening on http://${hostname}:${port} (WebSocket: /ws)`);

let stopping = false;

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`Received ${signal}, shutting down`);

  const forceExitTimer = setTimeout(() => {
    console.error("Graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  const closeHttp = new Promise((resolve) => server.close(resolve));
  await Promise.allSettled([realtime.shutdown(), closeHttp, websocket.close(), app.close()]);
  clearTimeout(forceExitTimer);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
