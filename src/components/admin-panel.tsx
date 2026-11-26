"use client";
import {useEffect, useState} from "react";
import {fetchChannel, transportStatus} from "@/lib/client-transport";
import type {ChannelObservation} from "@/lib/replication/telemetry-protocol";
type User = {id: string; name: string; nickname: string | null; createdAt: string};
type Device = {deviceId: string; firstSeenAt: string; lastSeenAt: string; current: ChannelObservation; sessions: ChannelObservation[]; history: ChannelObservation[]};
async function request<T>(path: string, signal?: AbortSignal): Promise<T> {
  const token = localStorage.getItem("tiny-messenger:v1:token") || "";
  if (!token) throw Error("Войдите в Messenger под аккаунтом администратора.");
  const response = await fetchChannel("/api/admin/" + path, {cache: "no-store", headers: {Authorization: "Bearer " + token}, signal});
  const data = await response.json();
  if (!response.ok || !data.ok) throw Error(data.error?.message || "Не удалось загрузить данные");
  return data.data;
}
const date = (value: string) => new Date(value).toLocaleString("ru-RU");
const channel = (value: string) => ({"vps-1": "pro-vm", "yandex-1": "ya", "vps-direct": "vm", default: "По умолчанию", auto: "Авто"}[value] || value);
export function AdminPanel() {
  const [users, setUsers] = useState<User[]>([]), [selected, setSelected] = useState("");
  const [devices, setDevices] = useState<Device[]>([]), [error, setError] = useState("");
  const [query, setQuery] = useState(""), [revision, setRevision] = useState(0), [busy, setBusy] = useState(true), [deviceBusy, setDeviceBusy] = useState(false);
  const [source, setSource] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true); setError("");
    void request<{users: User[]; truncated: boolean}>("users", controller.signal).then(data => {
      if (controller.signal.aborted) return;
      setUsers(data.users); setSource(transportStatus().alias);
      if (data.truncated) setError("Показаны первые 500 аккаунтов.");
    }).catch(reason => {if (!controller.signal.aborted) setError((reason as Error).message);}).finally(() => {if (!controller.signal.aborted) setBusy(false);});
    return () => controller.abort();
  }, [revision]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setDeviceBusy(true); setDevices([]);
    void request<{devices: Device[]}>("devices?userId=" + encodeURIComponent(selected), controller.signal).then(data => {
      if (!controller.signal.aborted) {setDevices(data.devices); setSource(transportStatus().alias);}
    }).catch(reason => {if (!controller.signal.aborted) setError((reason as Error).message);}).finally(() => {if (!controller.signal.aborted) setDeviceBusy(false);});
    return () => controller.abort();
  }, [selected, revision]);
  const visible = users.filter(user => (user.name + " " + (user.nickname || "") + " " + user.id).toLowerCase().includes(query.toLowerCase()));
  const current = users.find(user => user.id === selected);
  return <main className="admin-shell">
    <header className="admin-header"><div><a href="/">← Messenger</a><h1>Администрирование</h1><p>Пользователи и устройства · канал {source || "…"}</p></div><button className="secondary-button" disabled={busy || deviceBusy} onClick={() => {setError(""); setRevision(value => value + 1);}}>Обновить</button></header>
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
    <div className="admin-columns"><section className="admin-users"><label className="field-label">Поиск пользователя<input value={query} onChange={event => setQuery(event.target.value)} placeholder="Имя, ник или UUID" /></label>
      <p>{busy ? "Загружаем…" : `Аккаунтов: ${users.length}`}</p>
      {visible.map(user => <button key={user.id} className={`admin-user ${selected === user.id ? "active" : ""}`} onClick={() => {setError(""); setSelected(user.id);}}><strong>{user.name}</strong><span>{user.nickname ? "@" + user.nickname : user.id}</span></button>)}
    </section><section className="admin-detail">
      {current ? <><h2>{current.name}{current.nickname ? " · @" + current.nickname : ""}</h2><code>{current.id}</code><p>Создан: {date(current.createdAt)}</p>
        <p>Устройств: {deviceBusy ? "…" : devices.length}. Один браузер на разных зеркалах учитывается отдельно. Активность приходит при открытии и переключении канала, затем примерно раз в 15 минут.</p>
        {!deviceBusy && !devices.length ? <p>Устройства ещё не присылали сведения.</p> : null}
        {devices.map(device => <article className="admin-device" key={device.deviceId}>
          <h3>{device.current.platform} · {device.current.browser}{device.current.pwa ? " · PWA" : ""}</h3>
          <code>{device.deviceId}</code><p>Канал: <strong>{channel(device.current.channel)}</strong> · режим {channel(device.current.mode)} · {device.current.latencyMs === null ? "Задержка неизвестна" : device.current.latencyMs + " мс"}</p>
          <p>Версия {device.current.appVersion} · {device.current.origin}<br />Последний отчёт: {date(device.lastSeenAt)}</p>
          <details><summary>История переключений ({device.history.length})</summary><div className="admin-table-scroll"><table><thead><tr><th>Время</th><th>Канал</th><th>Причина</th><th>Задержка</th></tr></thead><tbody>{[...device.history].reverse().map(event => <tr key={event.id}><td>{date(event.at)}</td><td>{channel(event.channel)}</td><td>{event.reason}</td><td>{event.latencyMs === null ? "—" : event.latencyMs + " мс"}</td></tr>)}</tbody></table></div></details>
          <details><summary>Последние вкладки ({device.sessions.length})</summary>{device.sessions.map(session => <p key={session.sessionId}><code>{session.sessionId.slice(0, 8)}</code> · {channel(session.channel)} · {date(session.at)}</p>)}</details>
        </article>)}
      </> : <p>Выберите пользователя, чтобы увидеть устройства и историю каналов.</p>}
    </section></div>
  </main>;
}
