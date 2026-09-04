import { parseServerEvent, type RealtimeConnectionState, type ServerRealtimeEvent } from "@/realtime/protocol";

const INSTALLATION_KEY = "tiny-messenger:v1:installation";
const TAB_KEY = "tiny-messenger:v1:tab";

function stableBrowserId(storage: Storage, key: string) {
  const saved = storage.getItem(key);
  if (saved) return saved;
  const id = crypto.randomUUID();
  storage.setItem(key, id);
  return id;
}

type EventListener = (event: ServerRealtimeEvent) => void;
type StateListener = (state: RealtimeConnectionState) => void;
type PendingRequest = {
  resolve: () => void;
  reject: (error: RealtimeRequestError) => void;
  timer: number;
};

export class RealtimeRequestError extends Error {
  constructor(message: string, public code = "request_failed") {
    super(message);
  }
}

export class RealtimeClient {
  private socket: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private retryTimer: number | undefined;
  private ready = false;
  private eventListeners = new Set<EventListener>();
  private stateListeners = new Set<StateListener>();
  private queue: string[] = [];
  private pendingRequests = new Map<string, PendingRequest>();

  constructor(private token: string) {}

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.socket?.close(1000, "client_close");
    this.socket = null;
    this.ready = false;
    this.queue = [];
    this.rejectPendingRequests(new RealtimeRequestError("Соединение закрыто", "connection_closed"));
    this.setState("offline");
  }

  subscribe(listener: EventListener) {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  subscribeState(listener: StateListener) {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  send(frame: Record<string, unknown>) {
    const payload = JSON.stringify(frame);
    if (this.ready && this.socket?.readyState === WebSocket.OPEN) this.socket.send(payload);
    else if (this.queue.length < 50) this.queue.push(payload);
  }

  request(frame: Record<string, unknown>, timeoutMs = 10_000) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new RealtimeRequestError("Нет соединения с сервером", "realtime_offline"));
    }
    const requestId = crypto.randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new RealtimeRequestError("Сервер не подтвердил команду", "request_timeout"));
      }, timeoutMs);
      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.socket?.send(JSON.stringify({ ...frame, requestId }));
    });
  }

  private setState(state: RealtimeConnectionState) {
    for (const listener of this.stateListeners) listener(state);
  }

  private connect() {
    if (this.stopped) return;
    this.setState("connecting");
    this.ready = false;
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${window.location.host}/ws`);
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        type: "authenticate",
        requestId: crypto.randomUUID(),
        token: this.token,
        client: "web",
        clientId: stableBrowserId(window.localStorage, INSTALLATION_KEY),
        instanceId: stableBrowserId(window.sessionStorage, TAB_KEY),
        capabilities: ["presence", "voice"],
      }));
    });

    socket.addEventListener("message", (message) => {
      if (typeof message.data !== "string") return;
      const event = parseServerEvent(message.data);
      if (!event) return;
      if (event.type === "ack") {
        const pending = this.pendingRequests.get(event.requestId);
        if (pending) {
          window.clearTimeout(pending.timer);
          this.pendingRequests.delete(event.requestId);
          if (event.ok) pending.resolve();
          else pending.reject(new RealtimeRequestError(
            event.error?.message || "Команда не выполнена",
            event.error?.code,
          ));
          return;
        }
      }
      if (event.type === "ready" && event.protocol === 2) {
        this.ready = true;
        this.retry = 0;
        this.setState("online");
        for (const payload of this.queue.splice(0)) socket.send(payload);
      }
      for (const listener of this.eventListeners) listener(event);
    });

    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.ready = false;
      this.rejectPendingRequests(new RealtimeRequestError("Соединение потеряно", "connection_lost"));
      this.setState("offline");
      if (this.stopped) return;
      const delay = Math.min(20_000, 500 * 2 ** this.retry) * (0.8 + Math.random() * 0.4);
      this.retry += 1;
      this.retryTimer = window.setTimeout(() => this.connect(), delay);
    });

    socket.addEventListener("error", () => socket.close());
  }

  private rejectPendingRequests(error: RealtimeRequestError) {
    for (const pending of this.pendingRequests.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}
