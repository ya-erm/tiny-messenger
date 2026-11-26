import { createBusTransport } from "../shared/bus-transport.mjs";
import { makeBusFrame, parseBusFrame, BUS_BATCH } from "../shared/bus-format.mjs";
import { REPLICATION_FEED } from "../shared/replication.mjs";
const pending = new WeakMap();
function configuration(environment) {
  const value = environment.TM_BUS_CONFIG ? JSON.parse(environment.TM_BUS_CONFIG) : undefined;
  if (!value?.enabled) return undefined;
  return value;
}
export async function flushCloudBus(service, environment = process.env) {
  const config = configuration(environment);
  if (!config) return { enabled: false };
  if (pending.has(service)) return pending.get(service);
  const run = (async () => {
    const stateKey = "bus:published";
    const { after, events } = await service.rows.database.transaction(async (tx) => {
      const after = (await tx.get("meta", stateKey))?.sequence || config.bootstrapCursor || "0";
      return { after, events: await tx.feed(REPLICATION_FEED, after, 101) };
    }, { readOnly: true });
    if (!events.length) return { enabled: true, published: 0, hasMore: false };
    const selected = events.slice(0,100), transport = createBusTransport(config);
    for (const target of config.targets) {
      const frames = [];
      for (let index = 0; index < selected.length; index += BUS_BATCH) {
        const batch = selected.slice(index,index+BUS_BATCH);
        frames.push(makeBusFrame(service.installationId,target.installationId,"events","cloud:"+batch[0].sequence+":"+batch.at(-1).sequence,{events:batch}));
      }
      for (let index = 0; index < frames.length; index += 10) await transport.publish(target.address,frames.slice(index,index+10));
    }
    const last = selected.at(-1).sequence;
    await service.rows.database.transaction(async (tx) => {
      const previous = (await tx.get("meta", stateKey))?.sequence || after;
      if (BigInt(last) > BigInt(previous)) await tx.put("meta",stateKey,{sequence:last});
    });
    return { enabled: true, published: selected.length, hasMore: events.length > selected.length };
  })();
  pending.set(service,run);
  try { return await run; } finally { pending.delete(service); }
}
// Queue trigger and a future MQTT webhook both call this function with the
// same frames. An exception is intentional: the provider must retry delivery.
export async function consumeCloudFrames(service, frames, environment = process.env) {
  const config = configuration(environment);
  if (!config) throw Error("Replication bus disabled");
  const peers = config.targets.map((target) => target.installationId), pings = [];
  for (const input of frames) {
    const frame = parseBusFrame(input,service.installationId,peers);
    if (frame.kind === "ping") { pings.push(frame); continue; }
    if (frame.kind === "pong") continue;
    for (const event of frame.events) {
      if(event.type==="user"||event.type==="contact")throw Error("Directory creation events are exported by this installation, not accepted from a broker");
      else if (event.type === "mutation") await service.importMutation(event.operation,frame.from);
      else if (event.type === "row") {
        if (event.operation.origin !== frame.from) throw Error("Wrong row origin");
      } else if (event.type === "receipt") await service.importReceipt(event);
    }
    const rows = frame.events.filter((event) => event.type === "row").map((event) => event.operation);
    if (rows.length) await service.rows.importMany(rows);
  }
  const result = await flushCloudBus(service,environment);
  const transport = createBusTransport(config);
  for (const ping of pings) {
    const target = config.targets.find((target) => target.installationId === ping.from);
    await transport.publish(target.address,[makeBusFrame(service.installationId,ping.from,"pong",ping.id,{ pending: Boolean(result.hasMore) })]);
  }
  return { processed: frames.length };
}
export async function consumeQueueEvent(event, service, environment = process.env) {
  const config = configuration(environment);
  if (!config || !Array.isArray(event.messages) || event.messages.length > 5) throw Error("Invalid queue event");
  const frames=[];
  for (const message of event.messages) {
    if (message.event_metadata?.event_type !== "yandex.cloud.events.messagequeue.QueueMessage"
      || message.details?.queue_id !== config.inboxArn || typeof message.details?.message?.body !== "string") throw Error("Unexpected queue source");
    frames.push(message.details.message.body);
  }
  return consumeCloudFrames(service,frames,environment);
}
