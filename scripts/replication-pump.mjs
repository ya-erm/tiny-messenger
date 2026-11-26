// The VPS wakes the function only when necessary. No cloud cron, idle worker,
// SDK connection or dedicated replica consumes cloud resources between calls.
export function startReplication(upstream) {
  if (!process.env.TM_REPLICATION_CONFIG) return () => {};
  let stopped = false, running = false;
  const controller = new AbortController();
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const response = await fetch(`${upstream}/api/internal/replication`, { method: "POST",
        headers: { "x-messenger-internal-token": process.env.MESSENGER_INTERNAL_TOKEN || "" },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(35_000)]) });
      if (!response.ok) console.error(JSON.stringify({ event: "replication-pump", status: response.status }));
      await response.body?.cancel();
    } catch { if (!stopped) console.error(JSON.stringify({ event: "replication-pump", status: "unavailable" })); }
    finally { running = false; }
  };
  const timer = setInterval(() => void tick(), 2000); timer.unref();
  void tick();
  return () => { stopped = true; clearInterval(timer); controller.abort(); };
}
