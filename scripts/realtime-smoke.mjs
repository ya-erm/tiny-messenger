import assert from "node:assert/strict";
import WebSocket from "ws";

const baseUrl = process.env.TEST_BASE_URL || "http://127.0.0.1:3107";
const wsUrl = process.env.TEST_WS_URL || "ws://127.0.0.1:3107/ws";

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function api(endpoint, init = {}) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw new Error(`${response.status}: ${JSON.stringify(payload)}`);
  return payload.data;
}

class Probe {
  constructor(socket) {
    this.socket = socket;
    this.frames = [];
    this.waiters = new Set();
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString("utf8"));
      const waiter = [...this.waiters].find((candidate) => candidate.predicate(frame));
      if (waiter) {
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else this.frames.push(frame);
    });
  }

  send(frame) {
    this.socket.send(JSON.stringify({ requestId: crypto.randomUUID(), ...frame }));
  }

  waitFor(predicate, timeoutMs = 8_000) {
    const index = this.frames.findIndex(predicate);
    if (index >= 0) return Promise.resolve(this.frames.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: undefined };
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error(`Realtime event timeout; queued=${JSON.stringify(this.frames)}`));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  close() {
    this.socket.close(1000, "test_close");
  }
}

async function connect(token, instanceId = crypto.randomUUID(), duplicateToken = "") {
  const socket = new WebSocket(wsUrl, { headers: { Origin: new URL(baseUrl).origin } });
  const probe = new Probe(socket);
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const authentication = { type: "authenticate", token, client: "web", clientId: crypto.randomUUID(), instanceId, capabilities: ["presence", "voice"] };
  probe.send(authentication);
  if (duplicateToken) probe.send({ ...authentication, token: duplicateToken });
  const ready = await probe.waitFor((frame) => frame.type === "ready");
  assert.equal(ready.protocol, 2);
  return probe;
}

const aliceAccount = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "RTC Алиса" }) });
const bobAccount = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "RTC Борис" }) });
const charlieAccount = await api("/api/auth/register", { method: "POST", body: JSON.stringify({ name: "RTC Чарли" }) });
await api("/api/contacts", {
  method: "POST",
  headers: { Authorization: `Bearer ${aliceAccount.token}` },
  body: JSON.stringify({ userId: bobAccount.user.id }),
});
const unreadMessage = await api("/api/messages", {
  method: "POST",
  headers: { Authorization: `Bearer ${bobAccount.token}` },
  body: JSON.stringify({ toUserId: aliceAccount.user.id, text: "Presence остаётся read-only", kind: "text" }),
});
assert.equal(unreadMessage.message.status, "sent");
const alice = await connect(aliceAccount.token, crypto.randomUUID(), aliceAccount.token);
let bob = await connect(bobAccount.token);
const charlie = await connect(charlieAccount.token);
await delay(100);
assert.equal(alice.frames.filter((frame) => frame.type === "ready").length, 0, "duplicate authenticate must not add the socket twice");

alice.send({ type: "presence_subscribe", userIds: [bobAccount.user.id, charlieAccount.user.id] });
const presence = await alice.waitFor((frame) => frame.type === "presence_snapshot");
assert.deepEqual(presence.items.map((item) => item.userId), [bobAccount.user.id]);
assert.equal(presence.items[0].online, true);
assert.equal(presence.items[0].voiceAvailable, true);
const messageAfterPresence = await api(`/api/messages/${unreadMessage.message.id}`, {
  headers: { Authorization: `Bearer ${bobAccount.token}` },
});
assert.equal(messageAfterPresence.message.status, "sent", "presence lookup must not mark messages delivered");

const supersededPresenceRequestId = crypto.randomUUID();
const latestPresenceRequestId = crypto.randomUUID();
alice.send({ type: "presence_subscribe", requestId: supersededPresenceRequestId, userIds: [bobAccount.user.id] });
alice.send({ type: "presence_subscribe", requestId: latestPresenceRequestId, userIds: [] });
await alice.waitFor((frame) => frame.type === "ack" && frame.requestId === supersededPresenceRequestId);
await alice.waitFor((frame) => frame.type === "ack" && frame.requestId === latestPresenceRequestId);
const latestPresence = await alice.waitFor((frame) => frame.type === "presence_snapshot" && frame.items.length === 0);
assert.deepEqual(latestPresence.items, [], "the latest coalesced presence subscription must win");

alice.send({ type: "voice_start", peerUserId: bobAccount.user.id });
const aliceStarted = await alice.waitFor((frame) => frame.type === "voice_session");
const invite = await bob.waitFor((frame) => frame.type === "voice_invite");
assert.equal(aliceStarted.session.peerUserId, bobAccount.user.id);
assert.equal(invite.session.accepted, false);

bob.send({ type: "voice_accept", sessionId: invite.session.id });
const bobJoined = await bob.waitFor((frame) => frame.type === "voice_session" && frame.session.owner);
const aliceJoined = await alice.waitFor((frame) => frame.type === "voice_session" && frame.session.participants.some((participant) => participant.userId === bobAccount.user.id && participant.state === "joined"));
assert.equal(aliceJoined.session.id, bobJoined.session.id);
assert.ok(bobJoined.session.resumeToken);

const aliceNegotiation = await alice.waitFor((frame) => frame.type === "voice_negotiate");
const bobNegotiation = await bob.waitFor((frame) => frame.type === "voice_negotiate");
assert.equal(aliceNegotiation.revision, bobNegotiation.revision);
const offerer = aliceNegotiation.role === "offerer" ? alice : bob;
const answerer = offerer === alice ? bob : alice;
const invalidRoleRequestId = crypto.randomUUID();
answerer.send({
  type: "rtc_offer",
  requestId: invalidRoleRequestId,
  sessionId: invite.session.id,
  revision: aliceNegotiation.revision,
  description: { type: "offer", sdp: "v=0\r\n" },
});
const invalidRole = await answerer.waitFor((frame) => frame.type === "ack" && frame.requestId === invalidRoleRequestId);
assert.equal(invalidRole.ok, false);
assert.equal(invalidRole.error.code, "invalid_rtc_role");
offerer.send({
  type: "rtc_offer",
  sessionId: invite.session.id,
  revision: aliceNegotiation.revision,
  description: { type: "offer", sdp: "v=0\r\n" },
});
const relayedOffer = await answerer.waitFor((frame) => frame.type === "rtc_offer");
assert.equal(relayedOffer.description.sdp, "v=0\r\n");

const staleRequestId = crypto.randomUUID();
offerer.send({
  type: "rtc_ice",
  requestId: staleRequestId,
  sessionId: invite.session.id,
  revision: aliceNegotiation.revision - 1,
  candidate: { candidate: "candidate:stale" },
});
const staleCandidate = await offerer.waitFor((frame) => frame.type === "ack" && frame.requestId === staleRequestId);
assert.equal(staleCandidate.ok, false);
assert.equal(staleCandidate.error.code, "stale_revision");

const futureRestartRequestId = crypto.randomUUID();
offerer.send({
  type: "rtc_restart",
  requestId: futureRestartRequestId,
  sessionId: invite.session.id,
  revision: aliceNegotiation.revision + 1,
});
const futureRestart = await offerer.waitFor((frame) => frame.type === "ack" && frame.requestId === futureRestartRequestId);
assert.equal(futureRestart.ok, false);
assert.equal(futureRestart.error.code, "future_revision");

const bobOtherTab = await connect(bobAccount.token);
await bobOtherTab.waitFor((frame) => frame.type === "voice_session" && !frame.session.owner);
const ownerConflictRequestId = crypto.randomUUID();
bobOtherTab.send({ type: "voice_join", requestId: ownerConflictRequestId, sessionId: invite.session.id });
const ownerConflict = await bobOtherTab.waitFor((frame) => frame.type === "ack" && frame.requestId === ownerConflictRequestId);
assert.equal(ownerConflict.ok, false);
assert.equal(ownerConflict.error.code, "voice_owner_conflict");
bobOtherTab.close();

alice.send({ type: "rtc_restart", sessionId: invite.session.id, revision: aliceNegotiation.revision });
bob.send({ type: "rtc_restart", sessionId: invite.session.id, revision: bobNegotiation.revision });
const aliceRestart = await alice.waitFor((frame) => frame.type === "voice_negotiate");
const bobRestart = await bob.waitFor((frame) => frame.type === "voice_negotiate");
assert.equal(aliceRestart.revision, aliceNegotiation.revision + 1);
assert.equal(bobRestart.revision, aliceRestart.revision);
await delay(100);
assert.equal(alice.frames.filter((frame) => frame.type === "voice_negotiate").length, 0, "simultaneous restart must be coalesced");
assert.equal(bob.frames.filter((frame) => frame.type === "voice_negotiate").length, 0, "simultaneous restart must be coalesced");

const bobInstanceId = crypto.randomUUID();
bob.close();
await alice.waitFor((frame) => frame.type === "voice_session" && frame.session.participants.some((participant) => participant.userId === bobAccount.user.id && participant.state === "reconnecting"));
bob = await connect(bobAccount.token, bobInstanceId);
await bob.waitFor((frame) => frame.type === "voice_session" && !frame.session.owner);
bob.send({ type: "voice_resume", sessionId: invite.session.id, resumeToken: bobJoined.session.resumeToken, mediaLost: false });
await bob.waitFor((frame) => frame.type === "voice_session" && frame.session.owner);

bob.send({ type: "voice_leave", sessionId: invite.session.id });
await alice.waitFor((frame) => frame.type === "voice_session" && frame.session.participants.some((participant) => participant.userId === bobAccount.user.id && participant.state === "away"));
bob.send({ type: "voice_join", sessionId: invite.session.id });
await bob.waitFor((frame) => frame.type === "voice_session" && frame.session.owner);
const rejoined = await alice.waitFor((frame) => frame.type === "voice_session" && frame.session.participants.some((participant) => participant.userId === bobAccount.user.id && participant.state === "joined"));
assert.equal(rejoined.session.accepted, true);

bob.send({ type: "voice_leave", sessionId: invite.session.id });
await alice.waitFor((frame) => frame.type === "voice_session" && frame.session.participants.some((participant) => participant.userId === bobAccount.user.id && participant.state === "away"));
alice.send({ type: "voice_leave", sessionId: invite.session.id });
await alice.waitFor((frame) => frame.type === "voice_session_ended" && frame.sessionId === invite.session.id);

alice.send({ type: "voice_start", peerUserId: bobAccount.user.id });
const secondSession = await alice.waitFor((frame) => frame.type === "voice_session" && frame.session.id !== invite.session.id);
await bob.waitFor((frame) => frame.type === "voice_invite" && frame.session.id === secondSession.session.id);
bob.send({ type: "voice_decline", sessionId: secondSession.session.id });
const declinedForAlice = await alice.waitFor((frame) => frame.type === "voice_session_ended" && frame.sessionId === secondSession.session.id);
const declinedForBob = await bob.waitFor((frame) => frame.type === "voice_session_ended" && frame.sessionId === secondSession.session.id);
assert.equal(declinedForAlice.reason, "declined");
assert.equal(declinedForBob.reason, "declined");

alice.close();
bob.close();
charlie.close();
console.log("Realtime presence/voice smoke passed");
