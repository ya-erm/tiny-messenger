"use client";
import {useEffect, useRef, useState} from "react";
import {completeYandex, startYandex, yandexConfig, yandexLinkStatus} from "@/lib/yandex-client";

export function YandexAccount({token = "", userId, selectedAvatar, onSelectAvatar, onAvatarAvailable, disabled = false}: {token?: string; userId?: string; selectedAvatar?: string; onSelectAvatar?: (url: string) => void; onAvatarAvailable?: (url: string | undefined) => void; disabled?: boolean}) {
  const [enabled, setEnabled] = useState(false);
  const [link, setLink] = useState<{linked: boolean; label?: string; conflict?: boolean; avatarUrl?: string | null}>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void yandexConfig().then(async config => {
      if (!alive) return;
      setEnabled(config.enabled);
      if (config.enabled && token) {
        try { const status = await yandexLinkStatus(token); if (alive) {setLink(status);onAvatarAvailable?.(status.avatarUrl || undefined);} }
        catch { if (alive) setError("Не удалось проверить привязку. Попробуйте позже."); }
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [token, onAvatarAvailable]);
  function openYandex() {
    setBusy(true);setError("");
    void startYandex(token ? "link" : "login",token,userId).catch(reason=>{setError((reason as Error).message);setBusy(false);});
  }
  if (!enabled) return null;
  return <div className={token ? "settings-section yandex-section" : "yandex-login-section"}>
    {token ? <span className="field-label">Яндекс ID</span> : null}
    {link?.linked ? <>
      <div className="yandex-account-row">
        {link.avatarUrl ? <span className="yandex-avatar" aria-hidden="true">
          <span>Я</span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img key={link.avatarUrl} src={link.avatarUrl} alt="" className="yandex-avatar-image" width={40} height={40} referrerPolicy="no-referrer" onError={event=>{event.currentTarget.hidden=true;}} />
        </span> : null}
        <div className="yandex-account-copy">
          <strong>{link.label || "Аккаунт привязан"}</strong>
          {!link.avatarUrl && !link.conflict ? <span className="yandex-avatar-hint">{link.avatarUrl === null ? "Фото в Яндекс ID не задано" : "Обновите данные, чтобы получить фото"}</span> : null}
          <div className="yandex-account-actions">
            {link.avatarUrl && onSelectAvatar ? <button type="button" className="text-action" disabled={disabled || busy || !!link.conflict || selectedAvatar === link.avatarUrl} onClick={()=>onSelectAvatar(link.avatarUrl!)}>{selectedAvatar === link.avatarUrl ? "Фото выбрано" : "Выбрать фото"}</button> : null}
            <button type="button" className="text-action" disabled={disabled || busy || !!link.conflict} onClick={openYandex}>{busy ? "Открываем…" : "Обновить"}</button>
          </div>
        </div>
      </div>
      {link.conflict ? <p className="inline-error" role="alert">Конфликт привязок. Используйте резервный токен.</p> : null}
    </> : <>
      {token ? <p className="form-hint">Привяжите аккаунт для входа без токена.</p> : null}
      <button type="button" className="secondary-button wide" disabled={disabled || busy || !!token && !link} onClick={openYandex}>{busy ? "Открываем Яндекс…" : token ? "Привязать Яндекс ID" : "Войти через Яндекс"}</button>
    </>}
    {error ? <p className="inline-error" role="alert">{error}</p> : null}
  </div>;
}
export function YandexCallback() {
  const started = useRef(false);
  const [error, setError] = useState("");
  function finish() { setError(""); void completeYandex().catch(reason => setError((reason as Error).message)); }
  useEffect(() => { if (!started.current) { started.current = true; finish(); } }, []);
  return <main className="welcome-shell"><section className="welcome-card" aria-live="polite">
    <h1>Вход через Яндекс</h1>
    {error ? <><p className="inline-error" role="alert">{error}</p><button type="button" className="secondary-button" onClick={finish}>Повторить</button><p><a href="/">Вернуться в Messenger</a></p></> : <p>Проверяем подтверждение…</p>}
  </section></main>;
}
