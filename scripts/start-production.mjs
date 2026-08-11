import { spawn } from "node:child_process";

const children = new Set();
let stopping = false;

function start(label, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  children.add(child);
  child.on("exit", (code, signal) => {
    children.delete(child);
    if (stopping) return;
    console.error(`${label} exited (${signal || code})`);
    stopping = true;
    for (const running of children) running.kill("SIGTERM");
    process.exitCode = code || 1;
  });
  return child;
}

start("Next.js", process.execPath, ["server.js"]);
start("WebSocket gateway", process.execPath, ["scripts/ws-gateway.mjs"], {
  WS_UPSTREAM: process.env.WS_UPSTREAM || "http://127.0.0.1:3000",
});

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
