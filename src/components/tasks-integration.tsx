"use client";

import { useCallback, useEffect, useState } from "react";
import { MessengerApp } from "@/components/messenger-app";

const TOKEN_KEY = "tiny-messenger:v1:token";
type User = { id: string; name: string; nickname?: string | null };

async function api<T>(path: string, body: unknown, token = ""): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok) throw Error(payload.error?.message || "Не удалось подключить Tiny Messenger");
  return payload.data as T;
}

export function TasksConnect({ tasksOrigin }: { tasksOrigin: string }) {
  const [user, setUser] = useState<User | null>(null);
  const [taskName, setTaskName] = useState("");
  const [taskLogin, setTaskLogin] = useState("");
  const [state, setState] = useState("");
  const [confirmedToken, setConfirmedToken] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const load = useCallback(async () => {
    setError("");
    setUser(null);
    setConfirmedToken("");
    try {
      const value = new URLSearchParams(location.hash.slice(1)).get("state") || "";
      const preview = await api<{ name: string; login?: string }>("/api/integrations/tasks/preview", { state: value });
      setState(value);
      setTaskName(preview.name);
      setTaskLogin(preview.login || "");
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) return;
      const result = await api<{ user: User }>("/api/auth/session", { token }, token);
      setUser(result.user);
      setConfirmedToken(token);
    } catch (error) {
      setError((error as Error).message);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function approve() {
    setBusy(true);
    setError("");
    try {
      if (!window.opener) throw Error("Откройте подключение из настроек сервиса задач");
      if (!confirmedToken || localStorage.getItem(TOKEN_KEY) !== confirmedToken) {
        setUser(null);
        throw Error("Профиль изменился. Проверьте вход и подтвердите подключение заново.");
      }
      const result = await api<{ proof: string }>("/api/integrations/tasks/link", { state }, confirmedToken);
      window.opener.postMessage({ type: "tm:linked", proof: result.proof }, tasksOrigin);
      setSent(true);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="tasks-connect-page"><section>
    <h1>Подключить Tiny Messenger</h1>
    {taskName && <p>Аккаунт в «Задачах»: <strong>{taskName}</strong>{taskLogin && <span className="tasks-account-handle">@{taskLogin}</span>}</p>}
    {user ? <>
      <p>Профиль мессенджера: <strong>{user.name}</strong><span className="tasks-account-handle">{user.nickname ? "@" + user.nickname : "ID: " + user.id}</span></p>
      <p>В «Задачах» станут доступны ваши чаты и звонки. Пароль и постоянный токен не передаются.</p>
      <button className="primary-button" disabled={busy || sent || !state} onClick={() => void approve()}>{sent ? "Подтверждение отправлено" : busy ? "Подключаем…" : "Подключить этот профиль"}</button>
    </> : <>
      <p>Войдите в свой профиль Tiny Messenger, затем вернитесь сюда.</p>
      <a href="/" target="_blank" rel="noopener noreferrer">Открыть мессенджер</a>
      <button className="secondary-button" onClick={() => void load()}>Проверить вход</button>
    </>}
    {error && <p role="alert">{error}</p>}
    <button className="secondary-button" onClick={() => window.close()}>Отмена</button>
  </section></main>;
}

export function TasksEmbed({ tasksOrigin }: { tasksOrigin: string }) {
  const [credential, setCredential] = useState("");
  const [error, setError] = useState("");
  const [hostSound, setHostSound] = useState(false);

  useEffect(() => {
    let disposed = false, busy = false;
    async function receive(event: MessageEvent) {
      if (event.origin !== tasksOrigin || event.source !== window.parent || event.data?.type !== "tasks:login" || typeof event.data.assertion !== "string" || busy) return;
      busy = true;
      setCredential("");
      setError("");
      setHostSound(event.data.messageSound === "host");
      window.parent.postMessage({ type: "tm:unread", count: 0 }, tasksOrigin);
      try {
        const result = await api<{ token: string; user: User }>("/api/integrations/tasks/session", { assertion: event.data.assertion });
        let token = result.token;
        const existing = localStorage.getItem(TOKEN_KEY);
        if (existing) {
          try {
            const current = await api<{ user: User }>("/api/auth/session", { token: existing }, existing);
            if (current.user.id === result.user.id) token = existing;
          } catch { /* Restore an expired or different account using the confirmed link. */ }
        }
        if (!disposed) {
          if (localStorage.getItem(TOKEN_KEY) !== token) localStorage.setItem(TOKEN_KEY, token);
          setCredential(token);
        }
      } catch (error) {
        if (!disposed) setError((error as Error).message);
      } finally {
        busy = false;
      }
    }
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "tm:ready" }, tasksOrigin);
    return () => { disposed = true; window.removeEventListener("message", receive); };
  }, [tasksOrigin]);

  const unread = useCallback((count: number) => window.parent.postMessage({ type: "tm:unread", count }, tasksOrigin), [tasksOrigin]);
  const incoming = useCallback(() => window.parent.postMessage({ type: "tm:message-sound", id: crypto.randomUUID() }, tasksOrigin), [tasksOrigin]);
  return credential ? <MessengerApp key={credential} embedded onUnread={unread} onIncomingMessage={hostSound ? incoming : undefined} /> : <main className="tasks-connect-page"><section>
    <h1>Tiny Messenger</h1>
    <p role={error ? "alert" : "status"}>{error || "Открываем ваш профиль…"}</p>
    {error && <button className="primary-button" onClick={() => window.parent.postMessage({ type: "tm:ready" }, tasksOrigin)}>Повторить</button>}
  </section></main>;
}
