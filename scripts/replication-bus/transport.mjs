import { createYmqTransport } from "./ymq.mjs";
// New providers implement publish/receive/acknowledge. They never read a DB or
// interpret a mutation. MQTT can publish the same frame to one shared topic;
// every installation must have its own ordinary (not shared) subscription.
export function createBusTransport(configuration, fetcher) {
  if (configuration.provider === "ymq") return createYmqTransport(configuration, fetcher);
  throw Error("Unsupported replication bus provider");
}
