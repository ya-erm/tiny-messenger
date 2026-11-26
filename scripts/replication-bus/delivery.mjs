// Optional direct delivery uses the same envelope as a broker. A lost HTTP
// response may replay a frame through the broker; receivers deduplicate it.
export async function publishToTarget(transport, target, frames, fetcher = fetch) {
  if (!frames.length) return { route: "none" };
  if (target.direct) {
    const url = new URL(target.direct.url);
    if (url.protocol !== "https:" || url.username || url.password || typeof target.direct.secret !== "string" || target.direct.secret.length < 32)
      throw Error("Invalid direct replication target");
    try {
      for (const frame of frames) {
        const response = await fetcher(url, { method: "POST", headers: { "content-type": "application/json", "x-tm-replication-key": target.direct.secret },
          body: JSON.stringify(frame), signal: AbortSignal.timeout(8000), redirect: "error" });
        if (!response.ok) { await response.body?.cancel(); throw Error("Direct replication unavailable"); }
        const result = await response.json();
        if (result.ok !== true || result.data?.processed !== 1) throw Error("Invalid direct replication acknowledgement");
      }
      return { route: "direct" };
    } catch {
      // Retain the original IDs and replay the entire batch if an earlier
      // request may have committed before its acknowledgement was lost.
    }
  }
  await transport.publish(target.address, frames);
  return { route: "broker" };
}
