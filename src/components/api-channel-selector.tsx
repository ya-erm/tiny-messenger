"use client";
import { useEffect, useId, useState } from "react";
import { API_CHANNELS, CHANNEL_OPTIONS, ROUTE_EVENT, transportStatus, checkChannels, selectedMode, CHANNEL_EVENT, CHANNEL_KEY, chooseChannel, type ChannelId } from "@/lib/client-transport";
import { queuedMutations, retryQueuedMutations, STORAGE_EVENT } from "@/lib/client-storage";

export function ApiChannelSelector({ userId }: { userId?: string }) {
  const selectId = useId();
  const [channel, setChannel] = useState<ChannelId>("default");
  const [activeAlias,setActiveAlias]=useState("");
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(0);
  const [checking, setChecking] = useState(false);
  const [measurements, setMeasurements] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    const update = () => {
      setChannel(selectedMode());setActiveAlias(transportStatus().alias);
      if (userId) void queuedMutations(userId).then((rows) => {
        if (!cancelled) { setPending(rows.filter((row) => row.state !== "accepted").length); setFailed(rows.filter((row) => row.state === "failed").length); }
      }).catch(() => {});
    };
    const storage = (event: StorageEvent) => { if (event.key === CHANNEL_KEY) update(); };
    update(); window.addEventListener(ROUTE_EVENT,update); window.addEventListener(CHANNEL_EVENT, update); window.addEventListener(STORAGE_EVENT, update); window.addEventListener("storage", storage);
    return () => { cancelled = true; window.removeEventListener(ROUTE_EVENT,update);window.removeEventListener(CHANNEL_EVENT, update); window.removeEventListener(STORAGE_EVENT, update); window.removeEventListener("storage", storage); };
  }, [userId]);
  async function measure() {
    setChecking(true);
    try{const values=(await checkChannels()).map(item=>[item.channel,item.ok?`${item.latencyMs} мс`:"Нет ответа"]);setMeasurements(Object.fromEntries(values));}finally{setChecking(false);}
  }
  return <section className="settings-section api-channel-settings" aria-label="Канал связи">
    <label className="field-label" htmlFor={selectId}>Канал связи</label>
    <div className="api-channel-controls">
      <div className="api-channel-select">
      <select id={selectId} value={channel} onChange={(event) => { const id = event.target.value as ChannelId; chooseChannel(id); setChannel(id); }}>
        {CHANNEL_OPTIONS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </div>
      <button type="button" className="secondary-button" disabled={checking} onClick={() => { void measure(); }}>{checking ? "Проверяем…" : "Проверить"}</button>
    </div>
    {["auto","default"].includes(channel)?<p className="form-hint" role="status">Используется: {activeAlias||"Определяем…"}</p>:null}
    <ul className="api-channel-measurements" aria-live="polite">{API_CHANNELS.map((item) => <li key={item.id}><span>{item.name}</span><span>{measurements[item.id] || "Не проверен"}</span></li>)}</ul>
    {pending > 0 ? <div className="api-channel-queue" role="status">На устройстве ожидают отправки: {pending}{failed ? `, с ошибкой: ${failed}` : ""}.
      <button type="button" className="secondary-button" onClick={() => { if (userId) void retryQueuedMutations(userId); }}>Повторить отправку</button>
    </div> : null}
  </section>;
}
