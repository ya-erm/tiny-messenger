// Provider-independent wire format. Authentication/TLS belong to the transport;
// operation validation, idempotency and persistence belong to each receiver.
export const BUS_VERSION = 1;
export const BUS_MAX_BYTES = 240 * 1024;
export const BUS_BATCH = 5;
export const BUS_ACTIVE_GRACE_MS = 120_000;
export const BUS_ACTIVE_PROBE_MS = 60_000;
export const BUS_IDLE_PROBE_MS = 1800_000;
export function busProbeInterval(now = Date.now()) {
  const health = busHealth();
  const awaitingProof = health.confirmedAt <= health.failedAt || health.probeAt > health.confirmedAt;
  return awaitingProof || health.activityAt > 0 && now - health.activityAt < BUS_ACTIVE_GRACE_MS ? BUS_ACTIVE_PROBE_MS : BUS_IDLE_PROBE_MS;
}
export function parseBusFrame(value, self, peers) {
  const frame = typeof value === "string" ? JSON.parse(value) : value;
  if (!frame || frame.version !== BUS_VERSION || !["events", "ping", "pong"].includes(frame.kind)
    || !/^[a-z0-9-]{1,64}$/.test(frame.from) || frame.from === self || !peers.includes(frame.from) || frame.to !== self
    || typeof frame.id !== "string" || !/^[a-z0-9:-]{1,160}$/.test(frame.id) || !Number.isFinite(Date.parse(frame.at))
    || Buffer.byteLength(JSON.stringify(frame)) > BUS_MAX_BYTES) throw Error("Invalid replication bus frame");
  if (frame.kind === "events" && (!Array.isArray(frame.events) || frame.events.length < 1 || frame.events.length > BUS_BATCH
    || frame.events.some((event) => !["mutation", "row", "receipt", "user", "contact", "identity"].includes(event?.type)))) throw Error("Invalid replication bus events");
  return frame;
}
export function makeBusFrame(from, to, kind, id, payload = {}) {
  return { version: BUS_VERSION, from, to, kind, id, at: new Date().toISOString(), ...payload };
}
export function busHealth() {
  return globalThis.__tinyMessengerBusHealth ||= { listenerAt: 0, confirmedAt: 0, failedAt: 0, receivedAt: 0, activityAt: 0, probeAt: 0 };
}
export function isBusHealthy(now = Date.now()) {
  const health = busHealth();
  return health.listenerAt > 0 && health.confirmedAt > 0 && now - health.listenerAt < 45_000 && now - health.confirmedAt < busProbeInterval(now) + 65_000 && health.failedAt < health.confirmedAt;
}
