// Persisted jobs are in SQLite; this loop is only a bounded delivery pump.
export function startMessagePushDispatch(upstream) {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running || !process.env.WEB_PUSH_VAPID_PRIVATE_KEY) return;
    running = true;
    try {
      const result = await fetch(`${upstream}/api/internal/push/dispatch`, {
        method: "POST", headers: { "x-messenger-internal-token": process.env.MESSENGER_INTERNAL_TOKEN || "" },
        signal: AbortSignal.timeout(120_000),
      });
      if (!result.ok) console.error(JSON.stringify({ event: "push-dispatch", status: result.status }));
    } catch { console.error(JSON.stringify({ event: "push-dispatch", status: "unavailable" })); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 1000);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
