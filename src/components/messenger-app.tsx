"use client";

import Image from "next/image";
import { FormEvent, Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { LIMITS } from "@/lib/constants";
import { animalNames } from "@/lib/names";
import type { PublicContact, PublicMessage, PublicUser } from "@/lib/types";

const TOKEN_KEY = "tiny-messenger:v1:token";

const AVATAR_PRESETS = [
  { name: "Без изображения", url: "" },
  { name: "Янтарь", url: "https://api.dicebear.com/9.x/shapes/svg?seed=amber" },
  { name: "Лагуна", url: "https://api.dicebear.com/9.x/shapes/svg?seed=lagoon" },
  { name: "Орбита", url: "https://api.dicebear.com/9.x/shapes/svg?seed=orbit" },
  { name: "Мята", url: "https://api.dicebear.com/9.x/shapes/svg?seed=mint" },
  { name: "Коралл", url: "https://api.dicebear.com/9.x/shapes/svg?seed=coral" },
  { name: "Сумерки", url: "https://api.dicebear.com/9.x/shapes/svg?seed=twilight" },
  { name: "Мозаика", url: "https://api.dicebear.com/9.x/shapes/svg?seed=mosaic" },
  { name: "Комета", url: "https://api.dicebear.com/9.x/shapes/svg?seed=comet" },
] as const;

type ApiEnvelope<T> = { ok: true; data: T } | { ok: false; error: { message: string } };
type Peer = { id: string; name: string; avatarUrl?: string; saved: boolean };

async function fetchApi<T>(path: string, init: RequestInit = {}, token = "") {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const payload = (await response.json()) as ApiEnvelope<T>;
  if (!payload.ok) throw new Error(payload.error.message);
  return payload.data;
}

function Glyph({ name }: { name: "plus" | "settings" | "copy" | "back" | "send" | "user" | "refresh" | "eye" | "eyeOff" }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.15.38.37.72.66 1 .3.29.69.43 1.1.4h.1v4h-.1c-.41-.03-.8.11-1.1.4-.29.28-.51.62-.66 1Z" /></>,
    copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" /></>,
    back: <path d="m15 18-6-6 6-6" />,
    send: <><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 9a7 7 0 0 1 11.7-2.6L20 12M4 12l2.2 5.6A7 7 0 0 0 17.9 15" /></>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
    eyeOff: <><path d="m3 3 18 18" /><path d="M10.6 6.2A11.6 11.6 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-2.1 2.8M6.5 6.5C3.6 8.2 2 12 2 12s3.5 6 10 6a10 10 0 0 0 4.1-.8" /><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" /></>,
  };
  return <svg className="glyph" viewBox="0 0 24 24" aria-hidden="true">{paths[name]}</svg>;
}

function shortId(id: string) {
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("ru", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function Avatar({ name, avatarUrl, className }: { name: string; avatarUrl?: string; className: string }) {
  return (
    <span className={className} aria-hidden="true">
      <span>{name.slice(0, 1).toUpperCase()}</span>
      {avatarUrl ? (
        <Image
          key={avatarUrl}
          className="avatar-image"
          src={avatarUrl}
          alt=""
          fill
          sizes="43px"
          unoptimized
          onError={(event) => { event.currentTarget.hidden = true; }}
        />
      ) : null}
    </span>
  );
}

function StatusTicks({ message }: { message: PublicMessage }) {
  const double = message.status !== "sent";
  const active = message.status === "read" || message.status === "answered";
  const label = {
    sent: "Отправлено",
    delivered: "Доставлено",
    read: "Прочитано",
    answered: "Получен ответ",
  }[message.status];

  return (
    <span className={`ticks ${double ? "ticks-double" : ""} ${active ? "ticks-active" : ""}`} title={label} aria-label={label}>
      <svg viewBox={double ? "0 0 17 11" : "0 0 13 11"} aria-hidden="true">
        {double ? <path d="m1.5 5.7 3 3 6.2-7" /> : null}
        <path d={double ? "m5.5 5.7 3 3 6.2-7" : "m1.5 5.7 3 3 6.2-7"} />
      </svg>
    </span>
  );
}

function QuestionOptions({
  message,
  outgoing,
  onAnswer,
}: {
  message: PublicMessage;
  outgoing: boolean;
  onAnswer: (messageId: string, optionId: string) => void;
}) {
  if (message.kind !== "choice" || !message.options) return null;
  const canAnswer = !outgoing && !message.answer;

  return (
    <div className={`question-options ${canAnswer ? "interactive" : "readonly"}`}>
      {message.options.map((option) => {
        const selected = message.answer?.id === option.id;
        return canAnswer ? (
          <button key={option.id} type="button" onClick={() => onAnswer(message.id, option.id)}>
            <span>{option.label}</span>
          </button>
        ) : (
          <span key={option.id} className={`question-option ${selected ? "selected" : ""}`}>
            <span>{option.label}</span>
          </span>
        );
      })}
    </div>
  );
}

function AnswerBubble({ message, currentUserId, currentUserName, peerName }: { message: PublicMessage; currentUserId: string; currentUserName: string; peerName: string }) {
  if (!message.answer) return null;
  const outgoing = message.toUserId === currentUserId;
  const answererName = outgoing ? currentUserName : peerName;

  return (
    <article
      className={`message-row answer-message ${outgoing ? "outgoing" : "incoming"}`}
      aria-label={`Ответ: ${message.answer.label}`}
    >
      <div className="message-bubble">
        <span className="answer-sender">{answererName}</span>
        <div className="reply-preview">
          <strong>{message.senderName}</strong>
          <p>{message.text}</p>
        </div>
        <p className="answer-text">{message.answer.label}</p>
        <footer><time>{formatTime(message.answer.answeredAt)}</time></footer>
      </div>
    </article>
  );
}

export function MessengerApp() {
  const [token, setToken] = useState("");
  const [user, setUser] = useState<PublicUser | null>(null);
  const [phase, setPhase] = useState<"loading" | "welcome" | "ready">("loading");
  const [contacts, setContacts] = useState<PublicContact[]>([]);
  const [messages, setMessages] = useState<PublicMessage[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [contactFormDefaultId, setContactFormDefaultId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const request = useCallback(async <T,>(path: string, init: RequestInit = {}, explicitToken?: string) => {
    const currentToken = explicitToken ?? token;
    return fetchApi<T>(path, init, currentToken);
  }, [token]);

  useEffect(() => {
    const savedToken = window.localStorage.getItem(TOKEN_KEY);
    if (!savedToken) {
      setPhase("welcome");
      return;
    }
    fetchApi<{ user: PublicUser }>("/api/auth/session", {
      method: "POST",
      body: JSON.stringify({ token: savedToken }),
    }, savedToken)
      .then(({ user: restored }) => {
        setToken(savedToken);
        setUser(restored);
        setPhase("ready");
      })
      .catch(() => {
        window.localStorage.removeItem(TOKEN_KEY);
        setPhase("welcome");
        setNotice("Сохранённый токен больше не подходит. Введите актуальный.");
      });
  }, []);

  const refreshState = useCallback(async () => {
    if (!token) return;
    const data = await request<{ contacts: PublicContact[]; messages: PublicMessage[] }>("/api/sync", {
      method: "POST",
      body: JSON.stringify({ limit: 100 }),
    });
    setContacts(data.contacts);
    setMessages(data.messages);
  }, [request, token]);

  useEffect(() => {
    if (phase !== "ready" || !token) return;
    void refreshState().catch((error: Error) => setNotice(error.message));
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refreshState().catch(() => undefined);
      }
    }, 5000);
    return () => window.clearInterval(interval);
  }, [phase, token, refreshState]);

  const peers = useMemo<Peer[]>(() => {
    const result = new Map<string, Peer>();
    for (const contact of contacts) result.set(contact.userId, {
      id: contact.userId,
      name: contact.user.name,
      avatarUrl: contact.user.avatarUrl,
      saved: true,
    });
    for (const message of messages) {
      const id = message.fromUserId === user?.id ? message.toUserId : message.fromUserId;
      if (!result.has(id)) {
        result.set(id, {
          id,
          name: message.fromUserId === id ? message.senderName : shortId(id),
          saved: false,
        });
      }
    }
    return Array.from(result.values()).sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }, [contacts, messages, user?.id]);

  useEffect(() => {
    if (!selectedId && peers.length) setSelectedId(peers[0].id);
  }, [peers, selectedId]);

  const selectedPeer = peers.find((peer) => peer.id === selectedId) || null;
  const conversation = messages.filter(
    (message) =>
      selectedId &&
      ((message.fromUserId === user?.id && message.toUserId === selectedId) ||
        (message.toUserId === user?.id && message.fromUserId === selectedId)),
  );

  function saveSession(nextUser: PublicUser, nextToken: string) {
    window.localStorage.setItem(TOKEN_KEY, nextToken);
    setToken(nextToken);
    setUser(nextUser);
    setPhase("ready");
    setNotice("");
  }

  async function register(name: string) {
    setBusy(true);
    try {
      const data = await request<{ user: PublicUser; token: string }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ name }),
      }, "");
      saveSession(data.user, data.token);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function login(existingToken: string) {
    setBusy(true);
    try {
      const cleanToken = existingToken.trim();
      const data = await request<{ user: PublicUser }>("/api/auth/session", {
        method: "POST",
        body: JSON.stringify({ token: cleanToken }),
      }, cleanToken);
      saveSession(data.user, cleanToken);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function logout() {
    window.localStorage.removeItem(TOKEN_KEY);
    setToken("");
    setUser(null);
    setContacts([]);
    setMessages([]);
    setSelectedId(null);
    setShowSettings(false);
    setPhase("welcome");
  }

  async function addContact(userId: string) {
    setBusy(true);
    try {
      const data = await request<{ contact: PublicContact }>("/api/contacts", {
        method: "POST",
        body: JSON.stringify({ userId: userId.trim() }),
      });
      await refreshState();
      setSelectedId(data.contact.userId);
      setContactFormDefaultId(null);
      setNotice("Контакт добавлен");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage(input: { text: string; kind: "text" | "choice"; left: string; right: string }) {
    if (!selectedId) return;
    setBusy(true);
    try {
      await request("/api/messages", {
        method: "POST",
        body: JSON.stringify({
          toUserId: selectedId,
          text: input.text,
          kind: input.kind,
          ...(input.kind === "choice" ? { options: [
            { id: "1", label: input.left },
            { id: "2", label: input.right },
          ] } : {}),
        }),
      });
      await refreshState();
    } catch (error) {
      setNotice((error as Error).message);
      throw error;
    } finally {
      setBusy(false);
    }
  }

  async function markRead(messageId: string) {
    try {
      await request(`/api/messages/${messageId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status: "read" }),
      });
      await refreshState();
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  async function answer(messageId: string, optionId: string) {
    try {
      await request(`/api/messages/${messageId}/answer`, {
        method: "POST",
        body: JSON.stringify({ id: optionId }),
      });
      await refreshState();
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  if (phase === "loading") return <LoadingScreen />;
  if (phase === "welcome" || !user) {
    return <WelcomeScreen busy={busy} notice={notice} onRegister={register} onLogin={login} />;
  }

  return (
    <main className="app-shell">
      <div className={`messenger ${selectedPeer ? "has-conversation" : ""}`}>
        <aside className="sidebar">
          <header className="sidebar-header">
            <div className="brand"><span className="brand-mark">tm</span><span>Tiny Messenger</span></div>
            <button className="icon-button" onClick={() => setShowSettings(true)} aria-label="Настройки"><Glyph name="settings" /></button>
          </header>
          <div className="profile-strip">
            <Avatar name={user.name} avatarUrl={user.avatarUrl} className="avatar" />
            <div className="profile-details">
              <strong>{user.name}</strong>
              <div className="profile-id-row">
                <code>{user.id}</code>
                <button type="button" onClick={() => { void navigator.clipboard.writeText(user.id); setNotice("UUID скопирован"); }} aria-label="Скопировать UUID" title="Скопировать UUID"><Glyph name="copy" /></button>
              </div>
            </div>
          </div>
          <div className="contacts-title"><span>Диалоги</span><button className="small-icon-button" onClick={() => setContactFormDefaultId("")} aria-label="Добавить контакт"><Glyph name="plus" /></button></div>
          <div className="contact-list">
            {peers.length === 0 ? <div className="empty-sidebar"><Glyph name="user" /><p>Добавьте друга по UUID, чтобы написать первым.</p></div> : peers.map((peer) => {
              const last = [...messages].reverse().find((message) => message.fromUserId === peer.id || message.toUserId === peer.id);
              const unread = messages.filter((message) => message.fromUserId === peer.id && message.toUserId === user.id && !message.readAt).length;
              return <button key={peer.id} className={`contact-row ${selectedId === peer.id ? "selected" : ""}`} onClick={() => setSelectedId(peer.id)}>
                <Avatar name={peer.name} avatarUrl={peer.avatarUrl} className="contact-avatar" />
                <span className="contact-copy"><strong>{peer.name}</strong><small>{last?.text || (peer.saved ? shortId(peer.id) : "Не сохранён")}</small></span>
                {unread > 0 && <span className="unread-badge">{unread}</span>}
              </button>;
            })}
          </div>
          <button className="add-contact-button" onClick={() => setContactFormDefaultId("")}><Glyph name="plus" /> Новый контакт</button>
        </aside>

        <section className="conversation-panel">
          {selectedPeer ? <>
            <header className="conversation-header">
              <button className="mobile-back" onClick={() => setSelectedId(null)} aria-label="Назад"><Glyph name="back" /></button>
              <Avatar name={selectedPeer.name} avatarUrl={selectedPeer.avatarUrl} className="contact-avatar large" />
              <div className="conversation-title"><strong>{selectedPeer.name}</strong><span>{selectedPeer.id}</span></div>
              {!selectedPeer.saved && <button className="text-button" onClick={() => setContactFormDefaultId(selectedPeer.id)}>Сохранить</button>}
            </header>
            <div className="message-stream">
              {conversation.length === 0 && <div className="conversation-empty"><div className="tiny-device"><span>160 × 80</span><i /></div><h2>Начните с короткого</h2><p>Сообщение должно удобно читаться на небольшом экране.</p></div>}
              {conversation.map((message) => {
                const outgoing = message.fromUserId === user.id;
                return <Fragment key={message.id}>
                  <article className={`message-row ${outgoing ? "outgoing" : "incoming"}`}>
                    <div className="message-bubble">
                      {!outgoing && <span className="message-sender">{message.senderName}</span>}
                      <p>{message.text}{message.kind === "text" ? <span className="inline-message-meta"><time>{formatTime(message.sentAt)}</time>{outgoing && <StatusTicks message={message} />}</span> : null}</p>
                      <QuestionOptions message={message} outgoing={outgoing} onAnswer={answer} />
                      {!outgoing && !message.readAt && message.kind === "text" && <button className="read-button" onClick={() => markRead(message.id)}>Отметить прочитанным</button>}
                      {message.kind === "choice" ? <footer><time>{formatTime(message.sentAt)}</time>{outgoing && <StatusTicks message={message} />}</footer> : null}
                    </div>
                  </article>
                  <AnswerBubble message={message} currentUserId={user.id} currentUserName={user.name} peerName={selectedPeer.name} />
                </Fragment>;
              })}
            </div>
            <Composer busy={busy} onSend={sendMessage} />
          </> : <div className="no-conversation"><span className="brand-mark big">tm</span><h2>Ваши короткие сообщения</h2><p>Выберите диалог или добавьте контакт.</p></div>}
        </section>
      </div>

      {contactFormDefaultId !== null && <ContactDialog defaultId={contactFormDefaultId} busy={busy} onClose={() => setContactFormDefaultId(null)} onSubmit={addContact} />}
      {showSettings && <SettingsDialog user={user} token={token} request={request} onUser={setUser} onToken={(value) => { window.localStorage.setItem(TOKEN_KEY, value); setToken(value); }} onLogout={logout} onClose={() => setShowSettings(false)} setNotice={setNotice} />}
      {notice && <button className="toast" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
    </main>
  );
}

function LoadingScreen() {
  return <main className="loading-screen"><span className="brand-mark big pulse">tm</span><p>Открываем канал…</p></main>;
}

function WelcomeScreen({ busy, notice, onRegister, onLogin }: { busy: boolean; notice: string; onRegister: (name: string) => void; onLogin: (token: string) => void }) {
  const [mode, setMode] = useState<"new" | "login">("new");
  const [name, setName] = useState("");
  const [loginToken, setLoginToken] = useState("");
  const [suggestion, setSuggestion] = useState<string>(animalNames[0]);

  function generateName() {
    const alternatives = animalNames.filter((candidate) => candidate !== suggestion);
    const generated = alternatives[Math.floor(Math.random() * alternatives.length)] ?? animalNames[0];
    setSuggestion(generated);
    setName(generated);
  }

  return <main className="welcome-shell">
    <section className="welcome-copy"><div className="brand light"><span className="brand-mark">tm</span><span>Tiny Messenger</span></div><div><span className="eyebrow">80 × 160 пикселей</span><h1>Маленький экран.<br />Важные сообщения.</h1><p>Личный мессенджер для браузера и устройства с тремя кнопками. Без регистрации и публичных профилей.</p></div><div className="feature-line"><span>✓</span> Только UUID и секретный токен</div></section>
    <section className="welcome-card">
      <div className="mode-tabs"><button className={mode === "new" ? "active" : ""} onClick={() => setMode("new")}>Я здесь впервые</button><button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>У меня есть токен</button></div>
      {mode === "new" ? (
        <form onSubmit={(event) => { event.preventDefault(); void onRegister(name); }}>
          <span className="step-label">Ваше имя на устройстве</span>
          <h2>Как вас показать?</h2>
          <p className="form-hint">Если оставить пустым, имя придумаем сами.</p>
          <div className="field-label">
            <div className="field-label-row">
              <label htmlFor="welcome-name">Короткое имя</label>
              <button className="generate-name-button" type="button" onClick={generateName}>
                <Glyph name="refresh" /> Другое имя
              </button>
            </div>
            <input id="welcome-name" autoFocus value={name} maxLength={LIMITS.name} onChange={(event) => setName(event.target.value)} placeholder={suggestion} />
          </div>
          <div className="character-count">{Array.from(name).length} / {LIMITS.name}</div>
          <button className="primary-button wide" disabled={busy}>{busy ? "Создаём…" : "Создать мой канал"}</button>
        </form>
      ) : (
        <form onSubmit={(event) => { event.preventDefault(); void onLogin(loginToken); }}>
          <span className="step-label">Вход без пароля</span>
          <h2>Вернём ваши диалоги</h2>
          <p className="form-hint">Введите секретный токен, сохранённый в другом браузере или на устройстве.</p>
          <label className="field-label">Секретный токен<input autoFocus required value={loginToken} onChange={(event) => setLoginToken(event.target.value)} placeholder="msg_…" autoComplete="off" /></label>
          <button className="primary-button wide login-button" disabled={busy}>{busy ? "Проверяем…" : "Войти по токену"}</button>
        </form>
      )}
      {notice && <p className="inline-error">{notice}</p>}
    </section>
  </main>;
}

function Composer({ busy, onSend }: { busy: boolean; onSend: (input: { text: string; kind: "text" | "choice"; left: string; right: string }) => Promise<void> }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<"text" | "choice">("text");
  const [left, setLeft] = useState("Да");
  const [right, setRight] = useState("Нет");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !text.trim()) return;
    try {
      await onSend({ text, kind, left, right });
      setText("");
    } catch { /* The parent displays the API error. */ }
  }
  return <form className="composer" onSubmit={submit}>
    <div className="template-switch"><button type="button" className={kind === "text" ? "active" : ""} onClick={() => setKind("text")}>Текст</button><button type="button" className={kind === "choice" ? "active" : ""} onClick={() => setKind("choice")}>Вопрос</button><span>{Array.from(text).length}/{LIMITS.message}</span></div>
    <div className="composer-line"><textarea rows={1} required value={text} maxLength={LIMITS.message} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder={kind === "choice" ? "Задайте короткий вопрос…" : "Короткое сообщение…"} /><button className="send-button" disabled={busy || !text.trim()} aria-label="Отправить"><Glyph name="send" /></button></div>
    {kind === "choice" && <div className="option-fields"><label><span>Вариант 1 <small>{Array.from(left).length}/{LIMITS.option}</small></span><input required value={left} maxLength={LIMITS.option} onChange={(event) => setLeft(event.target.value)} /></label><label><span>Вариант 2 <small>{Array.from(right).length}/{LIMITS.option}</small></span><input required value={right} maxLength={LIMITS.option} onChange={(event) => setRight(event.target.value)} /></label></div>}
  </form>;
}

function ContactDialog({ defaultId, busy, onClose, onSubmit }: { defaultId: string; busy: boolean; onClose: () => void; onSubmit: (id: string) => void }) {
  const [id, setId] = useState(defaultId);
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="modal-card" onSubmit={(event) => { event.preventDefault(); void onSubmit(id); }}><button type="button" className="modal-close" onClick={onClose}>×</button><span className="step-label">Новый диалог</span><h2>Добавить контакт</h2><p className="form-hint">Попросите друга прислать UUID. Имя и изображение загрузятся из его профиля.</p><label className="field-label">UUID<input required value={id} onChange={(event) => setId(event.target.value)} placeholder="xxxxxxxx-xxxx-…" /></label><button className="primary-button wide contact-submit-button" disabled={busy}>{busy ? "Добавляем…" : "Добавить"}</button></form></div>;
}

function SettingsDialog({ user, token, request, onUser, onToken, onLogout, onClose, setNotice }: { user: PublicUser; token: string; request: <T>(path: string, init?: RequestInit) => Promise<T>; onUser: (user: PublicUser) => void; onToken: (token: string) => void; onLogout: () => void; onClose: () => void; setNotice: (message: string) => void }) {
  const [name, setName] = useState(user.name);
  const [avatarUrl, setAvatarUrl] = useState(user.avatarUrl ?? "");
  const [showToken, setShowToken] = useState(false);
  const [confirmTokenReset, setConfirmTokenReset] = useState(false);
  const [busy, setBusy] = useState(false);

  async function updateProfile() {
    setBusy(true);
    try {
      const data = await request<{ user: PublicUser }>("/api/me", {
        method: "PATCH",
        body: JSON.stringify({ name, avatarUrl }),
      });
      onUser(data.user);
      setAvatarUrl(data.user.avatarUrl ?? "");
      setNotice("Профиль обновлён");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function resetToken() {
    setBusy(true);
    try {
      const data = await request<{ token: string }>("/api/me/token", { method: "POST", body: "{}" });
      onToken(data.token);
      setShowToken(true);
      setConfirmTokenReset(false);
      setNotice("Новый токен создан. Обновите его на остальных устройствах.");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const profileChanged = name.trim() !== user.name || avatarUrl.trim() !== (user.avatarUrl ?? "");

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card settings-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <button type="button" className="modal-close" onClick={onClose} aria-label="Закрыть">×</button>
        <span className="step-label">Профиль и устройство</span>
        <h2 id="settings-title">Ваши настройки</h2>

        <div className="settings-section">
          <label className="field-label">Имя
            <div className="inline-field">
              <input value={name} maxLength={LIMITS.name} onChange={(event) => setName(event.target.value)} />
              <button type="button" className="secondary-button" disabled={busy || !profileChanged} onClick={updateProfile}>Сохранить</button>
            </div>
          </label>
          <div className="field-label avatar-field">Изображение
            <div className="avatar-presets" role="group" aria-label="Готовые изображения профиля">
              {AVATAR_PRESETS.map((preset) => {
                const selected = avatarUrl.trim() === preset.url;
                return (
                  <button
                    key={preset.name}
                    type="button"
                    className={selected ? "selected" : ""}
                    aria-pressed={selected}
                    aria-label={preset.name}
                    title={preset.name}
                    onClick={() => setAvatarUrl(preset.url)}
                  >
                    <Avatar name={name || user.name} avatarUrl={preset.url || undefined} className="avatar avatar-preset" />
                  </button>
                );
              })}
            </div>
            <span className="avatar-custom-label">Своя ссылка</span>
            <div className="inline-field avatar-url-field">
              <Avatar name={name || user.name} avatarUrl={avatarUrl.trim() || undefined} className="avatar avatar-preview" />
              <input aria-label="Ссылка на своё изображение" type="url" value={avatarUrl} maxLength={LIMITS.avatarUrl} onChange={(event) => setAvatarUrl(event.target.value)} placeholder="https://example.com/avatar.jpg" />
            </div>
          </div>
          <label className="field-label">Ваш UUID
            <div className="copy-field">
              <code>{user.id}</code>
              <button type="button" onClick={() => { void navigator.clipboard.writeText(user.id); setNotice("UUID скопирован"); }} aria-label="Скопировать UUID" title="Скопировать UUID"><Glyph name="copy" /></button>
            </div>
          </label>
        </div>

        <div className="settings-section token-section">
          <label className="field-label">Секретный токен
            <div className="copy-field">
              <code>{showToken ? token : "•".repeat(Math.min(token.length, 20))}</code>
              <button type="button" onClick={() => setShowToken((visible) => !visible)} aria-label={showToken ? "Скрыть токен" : "Показать токен"} title={showToken ? "Скрыть токен" : "Показать токен"}><Glyph name={showToken ? "eyeOff" : "eye"} /></button>
              <button type="button" onClick={() => { void navigator.clipboard.writeText(token); setNotice("Токен скопирован"); }} aria-label="Скопировать токен" title="Скопировать токен"><Glyph name="copy" /></button>
            </div>
          </label>
          <p className="form-hint">Он работает как пароль и API-ключ. Никому не показывайте без необходимости.</p>

          <div className="account-actions">
            <button type="button" className="danger-link" onClick={() => setConfirmTokenReset(true)}>Сбросить токен</button>
            <button type="button" className="danger-link" onClick={onLogout}>Выйти из этого браузера</button>
          </div>

          {confirmTokenReset ? (
            <div className="token-reset-confirmation" role="alert">
              <strong>Сбросить секретный токен?</strong>
              <p>Старый токен сразу перестанет работать. Устройство и другие браузеры потеряют доступ, пока вы не укажете им новый токен. В этом браузере новый токен сохранится автоматически.</p>
              <div>
                <button type="button" className="cancel-button" disabled={busy} onClick={() => setConfirmTokenReset(false)}>Отмена</button>
                <button type="button" className="danger-button" disabled={busy} onClick={resetToken}>{busy ? "Сбрасываем…" : "Да, сбросить"}</button>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
