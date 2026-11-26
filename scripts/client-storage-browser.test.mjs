import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const settings = Object.fromEntries((await readFile(new URL('../deploy/release.env', import.meta.url), 'utf8')).trim().split('\n').map(line => line.split('=')));
const ts = require(settings.MESSENGER_DEPENDENCIES_DIR + '/typescript');
const modules = new Map();
for (const file of ['client-storage', 'client-transport', 'mutations/protocol', 'reactions']) {
  const code = await readFile(new URL('../src/lib/' + file + '.ts', import.meta.url), 'utf8');
  modules.set('/' + file + '.mjs', ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replaceAll('"./mutations/protocol"', '"./mutations/protocol.mjs"').replaceAll('"../reactions"', '"../reactions.mjs"').replaceAll('"emoji-regex"', '"/emoji-regex.mjs"'));
}
modules.set('/emoji-regex.mjs', await readFile(settings.MESSENGER_DEPENDENCIES_DIR + '/emoji-regex/index.mjs', 'utf8'));
const server = createServer((req, res) => { const code = modules.get(req.url); res.setHeader('Content-Type', code ? 'text/javascript' : 'text/html'); res.end(code || '<title>Client storage test</title>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  const proof = await page.evaluate(async () => {
    const s = await import('/client-storage.mjs');
    const t = await import('/client-transport.mjs');
    const check = (condition, text) => { if (!condition) throw Error(text); };
    const actorId = crypto.randomUUID(), peerId = crypto.randomUUID(), deviceId = crypto.randomUUID();
    const user = { id: actorId, name: 'Test', createdAt: new Date().toISOString() };
    const now = new Date().toISOString();
    const base = { protocolVersion: 1, operationId: crypto.randomUUID(), actorId, deviceId, occurredAt: now };
    const operation = { ...base, type: 'message.create', message: { id: crypto.randomUUID(), fromUserId: actorId, toUserId: peerId, kind: 'text', text: 'Durable', sentAt: now } };
    const snapshot = { contacts: [{ userId: peerId, name: 'Peer' }], groups: [], groupMessages: [], messages: [], hiddenPeerIds: [], readStates: [], syncedAt: now, installationId: 'yandex-1', cursor: 'yandex-1:1' };
    await s.cacheProfile('test-token-secret', user);
    check((await s.cachedProfile('test-token-secret')).id === actorId, 'cached profile');
    check(!await s.cachedProfile('different-token'), 'token isolation');
    await s.saveSnapshot(actorId, 'yandex-1', snapshot);
    await s.queueMutation(actorId, 'yandex-1', operation, user.name);
    await s.queueMutation(actorId, 'yandex-1', operation, user.name);
    check((await s.queuedMutations(actorId)).length === 1, 'durable idempotent queue');
    let conflict = false;
    try { await s.queueMutation(actorId, 'yandex-1', { ...operation, message: { ...operation.message, text: 'Collision' } }, user.name); } catch { conflict = true; }
    check(conflict, 'same ID with another body rejected');
    let local = await s.readCachedSnapshot(actorId, 'yandex-1');
    check(local.messages[0].localState === 'queued', 'queued state visible');
    let calls = 0;
    await s.flushMutations(actorId, async (sent, channel) => { calls++; check(channel === 'yandex-1', 'queue pins destination'); check(sent.operationId === operation.operationId, 'stable operation'); throw Error('lost confirmation'); });
    check((await s.storedMutation(operation.operationId)).state === 'queued', 'lost response retained');
    await s.retryQueuedMutations(actorId);
    await s.flushMutations(actorId, async sent => { calls++; check(sent.operationId === operation.operationId, 'stable retry'); return { status: 'applied' }; });
    await s.flushMutations(actorId, async () => { throw Error('accepted operation resent'); });
    check(calls === 2 && (await s.storedMutation(operation.operationId)).state === 'accepted', 'confirmation persisted');
    const incoming = { ...operation.message, status: 'sent', reactions: [], senderName: user.name };
    const applied = s.applyCloudChanges(snapshot, { installationId: 'yandex-1', cursor: 'yandex-1:2', changes: [{ type: 'message', message: incoming }, { type: 'receipts', read: [incoming.id] }, { type: 'receipts', delivered: [incoming.id] }] });
    check(applied.snapshot.messages[0].status === 'read', 'read receipt monotonic');
    await s.saveSnapshot(actorId, 'yandex-1', applied.snapshot);
    await s.saveSnapshot(actorId, 'vps-1', { ...snapshot, installationId: 'vps-1', messages: [{ ...incoming, id: crypto.randomUUID(), text: 'VPS retained' }] });
    check((await s.readCachedSnapshot(actorId, 'yandex-1')).messages.length === 2, 'history survives channel switch');
    await s.hideCachedMessages(actorId, [incoming.id]);
    check(!(await s.readCachedSnapshot(actorId, 'vps-1')).messages.some(m => m.id === incoming.id), 'deletion does not resurrect across caches');
    check(!await s.readCachedSnapshot(crypto.randomUUID(), 'yandex-1'), 'account isolation');
    const switchedUser = crypto.randomUUID(), deletedId = crypto.randomUUID();
    await s.saveSnapshot(switchedUser, 'vps-1', { ...snapshot, installationId: 'vps-1', messages: [{ ...incoming, id: deletedId }] });
    await s.saveSnapshot(switchedUser, 'yandex-1', { ...snapshot, contacts: [], deletedMessageIds: [deletedId] });
    const switched = await s.readCachedSnapshot(switchedUser, 'yandex-1');
    check(!switched.messages.some(message => message.id === deletedId), 'full snapshot deletion dominates stale other-contour cache');
    check(switched.contacts.length === 0, 'removed contact is not restored from another contour');
    const groupId = crypto.randomUUID(), groupMessageId = crypto.randomUUID(), replyId = crypto.randomUUID();
    const group = { id: groupId, name: 'Replicated group', ownerId: actorId, members: [], createdAt: now, updatedAt: now };
    const groupMessage = { id: groupMessageId, groupId, fromUserId: actorId, senderName: 'Test', text: 'Original', sentAt: now, status: 'sent', reactions: [] };
    let rich = s.applyCloudChanges(snapshot, { installationId: 'yandex-1', cursor: 'yandex-1:3', changes: [
      { type: 'group', group }, { type: 'group.message', message: groupMessage },
      { type: 'group.message', message: { ...groupMessage, id: replyId, text: 'Reply', replyToId: groupMessageId } }
    ] }).snapshot;
    check(rich.groups.length === 1 && rich.groupMessages.length === 2, 'group feed materialized');
    rich = s.applyCloudChanges(rich, { installationId: 'yandex-1', cursor: 'yandex-1:4', changes: [
      { type: 'group.message.delete', id: groupMessageId }
    ] }).snapshot;
    check(rich.groupMessages[0].reply.available === false && !rich.groupMessages[0].reply.text, 'deleted quote content removed');
    const groupCacheUser = crypto.randomUUID();
    await s.saveSnapshot(groupCacheUser, 'vps-1', { ...rich, installationId: 'vps-1' });
    const revoked = s.applyCloudChanges(rich, { installationId: 'yandex-1', cursor: 'yandex-1:5', changes: [{ type: 'group.remove', id: groupId }] }).snapshot;
    await s.saveSnapshot(groupCacheUser, 'yandex-1', revoked);
    const revokedCache = await s.readCachedSnapshot(groupCacheUser, 'yandex-1');
    check(!revokedCache.groups.length && !revokedCache.groupMessages.length, 'revoked group not restored from another channel cache');
    t.chooseChannel('yandex-1');
    check(t.channelUrl('/api/messages').startsWith('https://ch-2.api.tm.'), 'cloud chosen');
    check(t.channelUrl('/api/rtc/config') === '/api/rtc/config', 'voice pinned to local VPS in development');
    const aliasUser = crypto.randomUUID();
    await s.saveSnapshot(aliasUser, 'default', { ...snapshot, installationId: 'vps-1', messages: [{ ...incoming, id: crypto.randomUUID(), text: 'Alias VPS' }] });
    await s.saveSnapshot(aliasUser, 'default', { ...snapshot, messages: [{ ...incoming, id: crypto.randomUUID(), text: 'Alias cloud' }] });
    check((await s.readCachedSnapshot(aliasUser, 'default')).messages.length === 2, 'default DNS flip retains both installation histories');
    check((await s.channelSnapshot(aliasUser, 'default')).installationId === 'yandex-1', 'cursor follows most recent alias installation');
    const originalFetch = window.fetch;
    const requests = [];
    window.fetch = async (url) => {
      requests.push(String(url));
      if (String(url).startsWith(t.YANDEX_GATEWAY_ORIGIN)) return new Response('{"ok":true}');
      throw new TypeError('unreachable');
    };
    try {
      await t.fetchChannel('/api/health', {}, 'yandex-1');
      check(requests.length === 2 && requests[1].startsWith(t.YANDEX_GATEWAY_ORIGIN), 'same cloud gateway fallback');
      await t.fetchChannel('/api/health', {}, 'yandex-1');
      check(requests.length === 3, 'working gateway remembered');
      let failed = false;
      try { await t.fetchChannel('/api/rtc/config', {}, 'yandex-1'); } catch { failed = true; }
      check(failed && requests.at(-1) === '/api/rtc/config', 'voice never falls back to cloud');
      const before = requests.length;
      try { await t.fetchChannel('/api/sync', {}, 'vps-1'); } catch {}
      check(requests.length === before + 1, 'no silent cross-contour failover');
    } finally { window.fetch = originalFetch; }
    return { userId: actorId, operationId: operation.operationId };
  });
  await page.reload();
  const persisted = await page.evaluate(async proof => {
    const s = await import('/client-storage.mjs');
    return (await s.storedMutation(proof.operationId))?.state === 'accepted' && (await s.queuedMutations(proof.userId)).length === 1;
  }, proof);
  assert.equal(persisted, true);
  console.log(JSON.stringify({ nativeIndexedDb: true, durableQueue: true, stableRetry: true, channelIsolation: true, historyMerge: true, deletionDominates: true, fullSnapshotTombstones: true, contactRemoval: true, groupFeed: true, quotePrivacy: true, groupRevocation: true, browserReload: true }));
  await context.close();
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
