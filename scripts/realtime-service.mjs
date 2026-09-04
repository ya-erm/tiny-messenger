import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

const AUTH_TIMEOUT_MS = 5_000;
const RECONNECT_GRACE_MS = 45_000;
const INVITE_TTL_MS = 60 * 60_000;
const SESSION_TTL_MS = 12 * 60 * 60_000;
const CONTROL_FRAMES_PER_MINUTE = 120;
const SIGNAL_FRAMES_PER_MINUTE = 600;
const MAX_ICE_CANDIDATES_PER_REVISION = 256;

function send(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function safeString(value, length = 128) {
  return typeof value === "string" && value.length > 0 && value.length <= length ? value : "";
}

function roomKey(first, second) {
  return [first, second].sort().join(":");
}

class RealtimeStore {
  constructor(file) {
    this.file = file;
    this.queue = Promise.resolve();
  }

  async read() {
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const value = JSON.parse(await readFile(this.file, "utf8"));
      if (value?.version === 1 && value.presence && Array.isArray(value.sessions)) return value;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return { version: 1, presence: {}, sessions: [] };
  }

  async write(data) {
    this.queue = this.queue.then(async () => {
      const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(this.file), { recursive: true });
      try {
        const handle = await open(temporary, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(data, null, 2)}\n`, "utf8");
        await handle.sync();
        await handle.close();
        await rename(temporary, this.file);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    });
    await this.queue;
  }
}

export class RealtimeService {
  constructor({ upstream, dataFile = process.env.MESSENGER_REALTIME_FILE }) {
    this.upstream = upstream;
    const defaultFile = path.join(process.cwd(), "data", "realtime.json");
    this.store = new RealtimeStore(path.resolve(dataFile || defaultFile));
    this.data = { version: 1, presence: {}, sessions: [] };
    this.connections = new Map();
    this.connectionsByUser = new Map();
    this.owners = new Map();
    this.revisions = new Map();
    this.negotiations = new Map();
    this.callStarts = new Map();
    this.disconnectTimers = new Map();
    this.stopping = false;
    this.serverInstanceId = randomUUID();
    process.env.MESSENGER_INTERNAL_TOKEN ||= randomBytes(32).toString("base64url");
    this.ready = this.restore();
    this.sweepTimer = setInterval(() => void this.sweepExpiredSessions(), 60_000);
    this.sweepTimer.unref();
  }

  async restore() {
    this.data = await this.store.read();
    const now = Date.now();
    this.data.sessions = this.data.sessions.filter((session) => Date.parse(session.hardExpiresAt) > now);
    for (const session of this.data.sessions) session.joinedUserIds = [];
    await this.store.write(this.data);
  }

  claimConnection({ socket, request }) {
    const legacyToken = request.headers["x-api-key"] || request.headers.authorization;
    if (legacyToken) return false;
    void this.handleBrowserConnection(socket, request);
    return true;
  }

  async rest(token, endpoint, init = {}) {
    const response = await fetch(`${this.upstream}${endpoint}`, {
      ...init,
      signal: AbortSignal.timeout(7_000),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...init.headers,
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw Object.assign(new Error(payload?.error?.message || `REST ${response.status}`), {
        code: payload?.error?.code || "request_failed",
      });
    }
    return payload.data;
  }

  validOrigin(request) {
    const origin = request.headers.origin;
    if (!origin) return true;
    const configured = process.env.WS_ALLOWED_ORIGIN?.trim();
    if (configured) return origin === configured;
    try {
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  }

  async handleBrowserConnection(socket, request) {
    await this.ready;
    if (!this.validOrigin(request)) {
      socket.close(1008, "origin_not_allowed");
      return;
    }
    const authenticationTimer = setTimeout(() => socket.close(1008, "authentication_timeout"), AUTH_TIMEOUT_MS);
    authenticationTimer.unref();
    socket.once("close", () => clearTimeout(authenticationTimer));
    let authenticating = false;
    const authenticate = async (raw, isBinary) => {
      if (authenticating) return;
      authenticating = true;
      socket.off("message", authenticate);
      if (isBinary || raw.length > 16_384) {
        socket.close(1009, "payload_too_large");
        return;
      }
      let frame;
      try { frame = JSON.parse(raw.toString("utf8")); } catch { socket.close(1008, "invalid_authentication"); return; }
      if (frame.type !== "authenticate" || frame.client !== "web") {
        socket.close(1008, "authentication_required");
        return;
      }
      const token = safeString(frame.token, 256);
      const instanceId = safeString(frame.instanceId, 128);
      if (!token || !instanceId) {
        socket.close(1008, "invalid_authentication");
        return;
      }
      try {
        const { user } = await this.rest(token, "/api/me");
        clearTimeout(authenticationTimer);
        if (socket.readyState !== WebSocket.OPEN) return;
        this.addConnection(socket, {
          connectionId: randomUUID(), token, userId: user.id, userName: user.name,
          instanceId, subscriptions: new Set(), capabilities: new Set(frame.capabilities || []),
          frameQueue: Promise.resolve(), rateWindowStartedAt: Date.now(), controlFrames: 0,
          signalFrames: 0, candidateRevisionKey: "", candidateCount: 0,
          presenceUpdatePromise: null, pendingPresenceSubscription: null,
        });
      } catch {
        socket.close(1008, "invalid_token");
      }
    };
    socket.on("message", authenticate);
  }

  addConnection(socket, state) {
    if (this.connections.has(socket)) return;
    this.connections.set(socket, state);
    const userConnections = this.connectionsByUser.get(state.userId) || new Set();
    const wasOffline = userConnections.size === 0;
    userConnections.add(socket);
    this.connectionsByUser.set(state.userId, userConnections);
    const offlineTimer = this.disconnectTimers.get(`presence:${state.userId}`);
    if (offlineTimer) clearTimeout(offlineTimer);
    this.disconnectTimers.delete(`presence:${state.userId}`);
    socket.on("message", (raw, isBinary) => {
      state.frameQueue = state.frameQueue
        .then(() => this.handleFrame(socket, raw, isBinary))
        .catch(() => socket.close(1011, "realtime_handler_failed"));
    });
    socket.once("close", () => this.removeConnection(socket));
    send(socket, {
      type: "ready", protocol: 2, userId: state.userId, connectionId: state.connectionId,
      serverInstanceId: this.serverInstanceId, heartbeatIntervalMs: 25_000,
    });
    if (wasOffline) this.publishPresence(state.userId, true);
    for (const session of this.sessionsFor(state.userId)) {
      const event = session.acceptedUserIds.includes(state.userId) ? "voice_session" : "voice_invite";
      send(socket, { type: event, session: this.snapshot(session, state.userId, socket) });
    }
  }

  removeConnection(socket) {
    const state = this.connections.get(socket);
    if (!state) return;
    this.connections.delete(socket);
    const userConnections = this.connectionsByUser.get(state.userId);
    userConnections?.delete(socket);
    if (userConnections?.size === 0) {
      this.connectionsByUser.delete(state.userId);
      if (this.stopping) return;
      const disconnectedAt = new Date().toISOString();
      const timer = setTimeout(() => {
        this.data.presence[state.userId] = disconnectedAt;
        void this.store.write(this.data);
        this.publishPresence(state.userId, false);
      }, 10_000);
      timer.unref();
      this.disconnectTimers.set(`presence:${state.userId}`, timer);
    }
    if (this.stopping) return;
    for (const [key, owner] of this.owners) {
      if (owner.socket !== socket) continue;
      owner.socket = null;
      owner.disconnectedAt = Date.now();
      const session = this.data.sessions.find((item) => key.startsWith(`${item.id}:`));
      if (session) this.broadcastSession(session);
      const timer = setTimeout(() => this.expireOwner(key), RECONNECT_GRACE_MS);
      timer.unref();
      this.disconnectTimers.set(`owner:${key}`, timer);
    }
  }

  presenceItem(userId) {
    const connections = this.connectionsByUser.get(userId);
    return {
      userId,
      online: Boolean(connections?.size),
      voiceAvailable: Boolean([...connections || []].some((socket) => this.connections.get(socket)?.capabilities.has("voice"))),
      ...(this.data.presence[userId] ? { lastSeenAt: this.data.presence[userId] } : {}),
    };
  }

  publishPresence(userId, online) {
    const item = this.presenceItem(userId);
    item.online = online;
    for (const [socket, connection] of this.connections) {
      if (connection.subscriptions.has(userId)) send(socket, { type: "presence_changed", item });
    }
  }

  async allowedPresenceUserIds(connection, requestedUserIds) {
    const peers = await this.rest(connection.token, "/api/realtime/peers");
    const allowed = new Set(peers.userIds);
    for (const session of this.sessionsFor(connection.userId)) {
      for (const participantId of session.participantIds) {
        if (participantId !== connection.userId) allowed.add(participantId);
      }
    }
    return requestedUserIds.filter((userId) => allowed.has(userId));
  }

  queuePresenceSubscription(connection, socket, requestedUserIds, requestId) {
    const pending = connection.pendingPresenceSubscription;
    if (pending) {
      pending.requestedUserIds = requestedUserIds;
      pending.requestIds.push(requestId);
    } else {
      connection.pendingPresenceSubscription = { requestedUserIds, requestIds: [requestId] };
    }
    if (connection.presenceUpdatePromise) return;

    const update = this.drainPresenceSubscriptions(connection, socket);
    connection.presenceUpdatePromise = update;
    const finish = () => {
      if (connection.presenceUpdatePromise !== update) return;
      connection.presenceUpdatePromise = null;
    };
    void update.then(finish, finish);
  }

  async drainPresenceSubscriptions(connection, socket) {
    while (this.connections.get(socket) === connection && connection.pendingPresenceSubscription) {
      const subscription = connection.pendingPresenceSubscription;
      connection.pendingPresenceSubscription = null;
      try {
        const userIds = await this.allowedPresenceUserIds(connection, subscription.requestedUserIds);
        if (this.connections.get(socket) !== connection) return;
        if (!connection.pendingPresenceSubscription) {
          connection.subscriptions = new Set(userIds);
          send(socket, { type: "presence_snapshot", items: userIds.map((id) => this.presenceItem(id)) });
        }
        for (const requestId of subscription.requestIds) {
          send(socket, { type: "ack", requestId, action: "presence_subscribe", ok: true });
        }
      } catch (error) {
        if (this.connections.get(socket) !== connection) return;
        for (const requestId of subscription.requestIds) {
          send(socket, {
            type: "ack",
            requestId,
            action: "presence_subscribe",
            ok: false,
            error: { code: error.code || "request_failed", message: error.message || "Ошибка запроса" },
          });
        }
      }
    }
  }

  sessionsFor(userId) {
    return this.data.sessions.filter((session) => session.participantIds.includes(userId));
  }

  ownerKey(sessionId, userId) {
    return `${sessionId}:${userId}`;
  }

  snapshot(session, userId, socket) {
    const peerUserId = session.participantIds.find((id) => id !== userId);
    const ownOwner = this.owners.get(this.ownerKey(session.id, userId));
    return {
      id: session.id,
      peerUserId,
      peerName: session.participantNames[peerUserId],
      initiatorId: session.initiatorId,
      stateVersion: session.stateVersion,
      accepted: session.acceptedUserIds.includes(userId),
      owner: ownOwner?.socket === socket,
      ...(ownOwner?.socket === socket ? { resumeToken: ownOwner.resumeToken } : {}),
      participants: session.participantIds.map((participantId) => {
        const accepted = session.acceptedUserIds.includes(participantId);
        const joined = session.joinedUserIds.includes(participantId);
        const owner = this.owners.get(this.ownerKey(session.id, participantId));
        return {
          userId: participantId,
          state: !accepted ? "invited" : !joined ? "away" : owner?.socket ? "joined" : "reconnecting",
        };
      }),
      createdAt: session.createdAt,
    };
  }

  sendSessionTo(session, userId) {
    for (const socket of this.connectionsByUser.get(userId) || []) {
      send(socket, { type: "voice_session", session: this.snapshot(session, userId, socket) });
    }
  }

  broadcastSession(session) {
    for (const userId of session.participantIds) this.sendSessionTo(session, userId);
  }

  acquireOwner(session, userId, socket) {
    const key = this.ownerKey(session.id, userId);
    const current = this.owners.get(key);
    if (current?.socket && current.socket !== socket) {
      throw Object.assign(new Error("Голосовой чат уже открыт в другой вкладке"), { code: "voice_owner_conflict" });
    }
    const owner = current || { resumeToken: randomBytes(24).toString("base64url") };
    owner.socket = socket;
    owner.disconnectedAt = undefined;
    this.owners.set(key, owner);
    const timer = this.disconnectTimers.get(`owner:${key}`);
    if (timer) clearTimeout(timer);
    this.disconnectTimers.delete(`owner:${key}`);
    if (!session.joinedUserIds.includes(userId)) session.joinedUserIds.push(userId);
  }

  async mutateSession(session) {
    session.stateVersion += 1;
    session.updatedAt = new Date().toISOString();
    await this.store.write(this.data);
    this.broadcastSession(session);
    this.maybeNegotiate(session);
  }

  maybeNegotiate(session, preferredOfferer) {
    const owners = session.participantIds.map((userId) => this.owners.get(this.ownerKey(session.id, userId)));
    if (owners.some((owner) => !owner?.socket)) return;
    const revision = (this.revisions.get(session.id) || 0) + 1;
    this.revisions.set(session.id, revision);
    const offererId = preferredOfferer || [...session.participantIds].sort()[0];
    this.negotiations.set(session.id, { revision, offererId });
    session.participantIds.forEach((userId, index) => send(owners[index].socket, {
      type: "voice_negotiate", sessionId: session.id, revision,
      role: userId === offererId ? "offerer" : "answerer",
    }));
  }

  async handleFrame(socket, raw, isBinary) {
    const connection = this.connections.get(socket);
    if (!connection) return;
    if (isBinary || raw.length > 65_536) { socket.close(1009, "payload_too_large"); return; }
    let frame;
    try { frame = JSON.parse(raw.toString("utf8")); } catch { send(socket, { type: "error", error: { code: "invalid_json", message: "Ожидался JSON" } }); return; }
    const requestId = safeString(frame.requestId, 64);
    try {
      this.consumeFrameRate(connection, frame.type);
      if (frame.type === "presence_subscribe") {
        const requestedUserIds = Array.isArray(frame.userIds)
          ? [...new Set(frame.userIds.filter((id) => safeString(id)))].slice(0, 200)
          : [];
        this.queuePresenceSubscription(connection, socket, requestedUserIds, requestId);
        return;
      } else if (frame.type === "voice_start") {
        await this.startVoice(connection, socket, safeString(frame.peerUserId));
      } else if (["voice_accept", "voice_join"].includes(frame.type)) {
        await this.joinVoice(connection, socket, safeString(frame.sessionId), frame.type === "voice_accept");
      } else if (frame.type === "voice_resume") {
        await this.resumeVoice(connection, socket, frame);
      } else if (frame.type === "voice_decline") {
        await this.declineVoice(connection, safeString(frame.sessionId));
      } else if (frame.type === "voice_leave") {
        await this.leaveVoice(connection, socket, safeString(frame.sessionId));
      } else if (["rtc_offer", "rtc_answer", "rtc_ice"].includes(frame.type)) {
        this.relayRtc(connection, socket, frame);
      } else if (frame.type === "rtc_restart") {
        const session = this.requireSession(connection.userId, safeString(frame.sessionId));
        this.requireOwner(session, connection.userId, socket);
        const requestedRevision = Number(frame.revision);
        const currentRevision = this.revisions.get(session.id);
        if (!Number.isInteger(requestedRevision) || currentRevision === undefined) {
          throw Object.assign(new Error("Устаревшая ревизия WebRTC"), { code: "stale_revision" });
        }
        if (requestedRevision > currentRevision) {
          throw Object.assign(new Error("Некорректная ревизия WebRTC"), { code: "future_revision" });
        }
        if (requestedRevision < currentRevision) {
          send(socket, { type: "ack", requestId, action: frame.type, ok: true });
          return;
        }
        const peerIsConnected = session.participantIds.every((userId) =>
          this.owners.get(this.ownerKey(session.id, userId))?.socket);
        if (!peerIsConnected) {
          throw Object.assign(new Error("Собеседник переподключается"), { code: "peer_reconnecting" });
        }
        this.maybeNegotiate(session, connection.userId);
      } else {
        throw Object.assign(new Error("Неизвестный тип события"), { code: "unknown_event" });
      }
      send(socket, { type: "ack", requestId, action: frame.type, ok: true });
    } catch (error) {
      send(socket, { type: "ack", requestId, action: frame.type || "unknown", ok: false, error: { code: error.code || "request_failed", message: error.message || "Ошибка запроса" } });
    }
  }

  consumeFrameRate(connection, type) {
    const now = Date.now();
    if (now - connection.rateWindowStartedAt >= 60_000) {
      connection.rateWindowStartedAt = now;
      connection.controlFrames = 0;
      connection.signalFrames = 0;
    }
    if (type === "rtc_ice") {
      connection.signalFrames += 1;
      if (connection.signalFrames > SIGNAL_FRAMES_PER_MINUTE) {
        throw Object.assign(new Error("Слишком много WebRTC-событий"), { code: "realtime_rate_limited" });
      }
      return;
    }
    connection.controlFrames += 1;
    if (connection.controlFrames > CONTROL_FRAMES_PER_MINUTE) {
      throw Object.assign(new Error("Слишком много команд"), { code: "realtime_rate_limited" });
    }
  }

  requireSession(userId, sessionId) {
    const session = this.data.sessions.find((item) => item.id === sessionId && item.participantIds.includes(userId));
    if (!session) throw Object.assign(new Error("Голосовая сессия не найдена"), { code: "voice_session_not_found" });
    return session;
  }

  requireOwner(session, userId, socket) {
    if (this.owners.get(this.ownerKey(session.id, userId))?.socket !== socket) {
      throw Object.assign(new Error("Эта вкладка не управляет звонком"), { code: "not_voice_owner" });
    }
  }

  async startVoice(connection, socket, peerUserId) {
    if (!peerUserId || peerUserId === connection.userId) throw Object.assign(new Error("Некорректный собеседник"), { code: "invalid_peer" });
    const activeForUser = this.data.sessions.find((session) => session.joinedUserIds.includes(connection.userId));
    if (activeForUser && !activeForUser.participantIds.includes(peerUserId)) throw Object.assign(new Error("Сначала выйдите из текущего голосового чата"), { code: "already_in_voice" });
    const peerBusy = this.data.sessions.some((session) => session.joinedUserIds.includes(peerUserId) && !session.participantIds.includes(connection.userId));
    if (peerBusy) throw Object.assign(new Error("Собеседник сейчас в другом голосовом чате"), { code: "peer_busy" });
    let session = this.data.sessions.find((item) => item.roomKey === roomKey(connection.userId, peerUserId));
    if (session) {
      if (!session.acceptedUserIds.includes(connection.userId)) throw Object.assign(new Error("Сначала примите приглашение"), { code: "accept_required" });
      this.acquireOwner(session, connection.userId, socket);
      await this.mutateSession(session);
      return;
    }
    const pendingForPeer = this.data.sessions.some((item) =>
      item.participantIds.includes(peerUserId) && !item.acceptedUserIds.includes(peerUserId));
    if (pendingForPeer) throw Object.assign(new Error("У собеседника уже есть входящий звонок"), { code: "peer_has_pending_invite" });
    const now = Date.now();
    const recentStarts = (this.callStarts.get(connection.userId) || []).filter((timestamp) => now - timestamp < 60 * 60_000);
    if (recentStarts.length >= 10 || recentStarts.filter((timestamp) => now - timestamp < 60_000).length >= 3) {
      throw Object.assign(new Error("Слишком много попыток звонка. Попробуйте позже"), { code: "voice_rate_limited" });
    }
    recentStarts.push(now);
    this.callStarts.set(connection.userId, recentStarts);
    const { user: peer } = await this.rest(connection.token, `/api/users/${encodeURIComponent(peerUserId)}`);
    session = {
      id: randomUUID(), roomKey: roomKey(connection.userId, peerUserId),
      participantIds: [connection.userId, peerUserId],
      participantNames: { [connection.userId]: connection.userName, [peerUserId]: peer.name },
      initiatorId: connection.userId, acceptedUserIds: [connection.userId], joinedUserIds: [connection.userId],
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
      inviteExpiresAt: new Date(now + INVITE_TTL_MS).toISOString(), hardExpiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
      stateVersion: 1,
    };
    this.data.sessions.push(session);
    this.acquireOwner(session, connection.userId, socket);
    await this.store.write(this.data);
    this.sendSessionTo(session, connection.userId);
    const targetSockets = this.connectionsByUser.get(peerUserId) || new Set();
    for (const target of targetSockets) send(target, { type: "voice_invite", session: this.snapshot(session, peerUserId, target) });
    if (targetSockets.size === 0) void this.pushInvite(session, peerUserId);
    else {
      const pushTimer = setTimeout(() => {
        const pending = this.data.sessions.find((item) => item.id === session.id);
        if (pending && !pending.acceptedUserIds.includes(peerUserId)) {
          void this.pushInvite(pending, peerUserId);
        }
      }, 5_000);
      pushTimer.unref();
    }
  }

  async pushInvite(session, peerUserId) {
    try {
      const response = await fetch(`${this.upstream}/api/rtc/invite`, {
        method: "POST",
        signal: AbortSignal.timeout(7_000),
        headers: { "Content-Type": "application/json", "X-Internal-Token": process.env.MESSENGER_INTERNAL_TOKEN },
        body: JSON.stringify({ peerUserId, sessionId: session.id, fromUserId: session.initiatorId, fromName: session.participantNames[session.initiatorId] }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.warn("Failed to send voice invite push", error instanceof Error ? error.message : "unknown error");
    }
  }

  async joinVoice(connection, socket, sessionId, accept) {
    const session = this.requireSession(connection.userId, sessionId);
    if (!session.acceptedUserIds.includes(connection.userId)) {
      if (!accept) throw Object.assign(new Error("Сначала примите приглашение"), { code: "accept_required" });
      session.acceptedUserIds.push(connection.userId);
      session.acceptedAt ||= new Date().toISOString();
    }
    this.acquireOwner(session, connection.userId, socket);
    await this.mutateSession(session);
  }

  async resumeVoice(connection, socket, frame) {
    const session = this.requireSession(connection.userId, safeString(frame.sessionId));
    const owner = this.owners.get(this.ownerKey(session.id, connection.userId));
    if (!owner || !safeString(frame.resumeToken, 128) || owner.resumeToken !== frame.resumeToken) {
      throw Object.assign(new Error("Срок восстановления звонка истёк"), { code: "resume_expired" });
    }
    owner.socket = socket;
    owner.disconnectedAt = undefined;
    const timerKey = `owner:${this.ownerKey(session.id, connection.userId)}`;
    const timer = this.disconnectTimers.get(timerKey);
    if (timer) clearTimeout(timer);
    this.disconnectTimers.delete(timerKey);
    this.broadcastSession(session);
    if (frame.mediaLost) this.maybeNegotiate(session, connection.userId);
  }

  async declineVoice(connection, sessionId) {
    const session = this.requireSession(connection.userId, sessionId);
    if (session.acceptedUserIds.includes(connection.userId)) throw Object.assign(new Error("Звонок уже принят"), { code: "already_accepted" });
    await this.endSession(session, "declined");
  }

  async leaveVoice(connection, socket, sessionId) {
    const session = this.requireSession(connection.userId, sessionId);
    this.requireOwner(session, connection.userId, socket);
    session.joinedUserIds = session.joinedUserIds.filter((id) => id !== connection.userId);
    this.owners.delete(this.ownerKey(session.id, connection.userId));
    if (session.joinedUserIds.length === 0) await this.endSession(session, "empty");
    else await this.mutateSession(session);
  }

  relayRtc(connection, socket, frame) {
    const session = this.requireSession(connection.userId, safeString(frame.sessionId));
    this.requireOwner(session, connection.userId, socket);
    const revision = Number(frame.revision);
    const negotiation = this.negotiations.get(session.id);
    if (!Number.isInteger(revision) || revision !== negotiation?.revision) throw Object.assign(new Error("Устаревшая ревизия WebRTC"), { code: "stale_revision" });
    if (frame.type === "rtc_offer" || frame.type === "rtc_answer") {
      if (!frame.description || JSON.stringify(frame.description).length > 32_768) throw Object.assign(new Error("Некорректное SDP"), { code: "invalid_sdp" });
      const shouldOffer = connection.userId === negotiation.offererId;
      if ((frame.type === "rtc_offer") !== shouldOffer) {
        throw Object.assign(new Error("Некорректная роль WebRTC"), { code: "invalid_rtc_role" });
      }
    } else if (!frame.candidate || JSON.stringify(frame.candidate).length > 2_048) {
      throw Object.assign(new Error("Некорректный ICE candidate"), { code: "invalid_ice" });
    } else {
      const candidateKey = `${session.id}:${revision}`;
      if (connection.candidateRevisionKey !== candidateKey) {
        connection.candidateRevisionKey = candidateKey;
        connection.candidateCount = 0;
      }
      connection.candidateCount += 1;
      if (connection.candidateCount > MAX_ICE_CANDIDATES_PER_REVISION) {
        throw Object.assign(new Error("Слишком много ICE candidates"), { code: "ice_limit_exceeded" });
      }
    }
    const peerId = session.participantIds.find((id) => id !== connection.userId);
    const peerOwner = this.owners.get(this.ownerKey(session.id, peerId));
    if (!peerOwner?.socket) throw Object.assign(new Error("Собеседник переподключается"), { code: "peer_reconnecting" });
    const payload = { type: frame.type, sessionId: session.id, revision };
    if (frame.description) payload.description = frame.description;
    if (frame.candidate) payload.candidate = frame.candidate;
    send(peerOwner.socket, payload);
  }

  async expireOwner(key) {
    const owner = this.owners.get(key);
    if (!owner || owner.socket) return;
    this.owners.delete(key);
    const [sessionId, userId] = key.split(":");
    const session = this.data.sessions.find((item) => item.id === sessionId);
    if (!session) return;
    session.joinedUserIds = session.joinedUserIds.filter((id) => id !== userId);
    if (session.joinedUserIds.length === 0) await this.endSession(session, "reconnect_timeout");
    else await this.mutateSession(session);
  }

  async endSession(session, reason) {
    this.data.sessions = this.data.sessions.filter((item) => item.id !== session.id);
    this.revisions.delete(session.id);
    this.negotiations.delete(session.id);
    for (const userId of session.participantIds) {
      this.owners.delete(this.ownerKey(session.id, userId));
      for (const socket of this.connectionsByUser.get(userId) || []) send(socket, { type: "voice_session_ended", sessionId: session.id, reason });
    }
    await this.store.write(this.data);
  }

  async sweepExpiredSessions() {
    await this.ready;
    const now = Date.now();
    const expired = this.data.sessions.filter((session) =>
      Date.parse(session.hardExpiresAt) <= now
      || (!session.acceptedAt && Date.parse(session.inviteExpiresAt) <= now));
    for (const session of expired) await this.endSession(session, "expired");
    for (const [userId, timestamps] of this.callStarts) {
      const recent = timestamps.filter((timestamp) => now - timestamp < 60 * 60_000);
      if (recent.length) this.callStarts.set(userId, recent);
      else this.callStarts.delete(userId);
    }
  }

  async shutdown() {
    await this.ready;
    this.stopping = true;
    clearInterval(this.sweepTimer);
    for (const timer of this.disconnectTimers.values()) clearTimeout(timer);
    this.disconnectTimers.clear();
    for (const socket of this.connections.keys()) send(socket, { type: "server_shutdown" });
    await this.store.write(this.data);
  }
}

export function verifyInternalToken(value) {
  const expected = process.env.MESSENGER_INTERNAL_TOKEN || "";
  if (!value || !expected) return false;
  const first = createHash("sha256").update(value).digest();
  const second = createHash("sha256").update(expected).digest();
  return timingSafeEqual(first, second);
}
