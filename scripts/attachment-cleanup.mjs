// Only metadata and S3 commands pass through this loop; never file contents.
export function startAttachmentCleanup(upstream) {
  let running = false;
  let stopped = false;
  const run = async () => {
    if (running || stopped || !process.env.ATTACHMENTS_S3_BUCKET) return;
    running = true;
    try {
      const response = await fetch(`${upstream}/api/internal/attachments/cleanup`, {
        method: "POST",
        headers: { "x-messenger-internal-token": process.env.MESSENGER_INTERNAL_TOKEN || "" },
        signal: AbortSignal.timeout(240_000),
      });
      if (!response.ok) console.error(JSON.stringify({ event: "attachment-cleanup", status: response.status }));
    } catch {
      console.error(JSON.stringify({ event: "attachment-cleanup", status: "unavailable" }));
    } finally { running = false; }
  };
  const first = setTimeout(() => void run(), 30_000);
  const interval = setInterval(() => void run(), 300_000);
  first.unref(); interval.unref();
  return () => { stopped = true; clearTimeout(first); clearInterval(interval); };
}
