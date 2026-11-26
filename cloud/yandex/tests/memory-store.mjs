// Transactional test double. Cloud completion is separately verified against YDB.
export function memoryStore() {
  let state = { kv: new Map(), views: new Map(), feed: new Map() };
  let queue = Promise.resolve();
  return {
    transaction(callback, { readOnly = false } = {}) {
      const run = async () => {
        const draft = structuredClone(state);
        const key = (bucket, id) => bucket + "\0" + id;
        const store = {
          async get(bucket, id) { return structuredClone(draft.kv.get(key(bucket, id))); },
          async put(bucket, id, value) { draft.kv.set(key(bucket, id), structuredClone(value)); },
          async scan(bucket, limit = 100) { return [...draft.kv].filter(([id]) => id.startsWith(bucket + "\0")).slice(0, limit).map(([, value]) => structuredClone(value)); },
          async scanEntries(bucket, limit = 100) { return [...draft.kv].filter(([id]) => id.startsWith(bucket + "\0")).slice(0, limit).map(([id, value]) => ({ key: id.slice(bucket.length + 1), value: structuredClone(value) })); },
          async putView(userId, message) { draft.views.set(key(userId, message.id), structuredClone(message)); },
          async getView(userId, sentAt, id) { const row = draft.views.get(key(userId, id)); return row?.sentAt === sentAt ? structuredClone(row) : undefined; },
          async views(userId, limit = 100) { return [...draft.views].filter(([id]) => id.startsWith(userId + "\0")).map(([, message]) => structuredClone(message))
            .sort((a, b) => b.sentAt.localeCompare(a.sentAt) || b.id.localeCompare(a.id)).slice(0, limit); },
          async addFeed(userId, sequence, value) { draft.feed.set(key(userId, sequence), { sequence: String(sequence), ...structuredClone(value) }); },
          async feed(userId, after, limit) { return [...draft.feed].filter(([id, row]) => id.startsWith(userId + "\0") && BigInt(row.sequence) > BigInt(after))
            .map(([, row]) => structuredClone(row)).sort((a, b) => Number(BigInt(a.sequence) - BigInt(b.sequence))).slice(0, limit); },
          async sequence() { return (await store.get("meta", "sequence"))?.value || "0"; },
          async nextSequence() { const sequence = String(BigInt(await store.sequence()) + 1n); await store.put("meta", "sequence", { value: sequence }); return sequence; },
        };
        const result = await callback(store);
        if (!readOnly) state = draft;
        return result;
      };
      const result = queue.then(run); queue = result.catch(() => {}); return result;
    },
  };
}
