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
    {token ? <>
      <strong>Яндекс ID</strong>
      <p className="form-hint">{link?.linked ? link.conflict ? "Обнаружен конфликт привязок. Используйте резервный токен." : `Привязан${link.label ? ": " + link.label : ""}. Можно входить без токена.` : "Привяжите Яндекс ID, чтобы входить в этот аккаунт без токена."}</p>
    </> : null}
    {link?.linked ? <>
      {link.avatarUrl ? <div className="yandex-avatar-row">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={link.avatarUrl} alt="Фото профиля Яндекс ID" className="yandex-avatar-image" width={48} height={48} referrerPolicy="no-referrer" />
        <div className="yandex-avatar-copy"><span>Фото из Яндекс ID</span>
          {onSelectAvatar ? <button type="button" className="text-action" disabled={disabled || busy || !!link.conflict || selectedAvatar === link.avatarUrl} onClick={()=>onSelectAvatar(link.avatarUrl!)}>{selectedAvatar === link.avatarUrl ? "Выбрано" : "Выбрать для профиля"}</button> : null}
        </div>
      </div> : <p className="form-hint yandex-avatar-empty">{link.avatarUrl === null ? "В Яндекс ID нет фото. Добавьте его и обновите данные." : "Фото ещё не получено. Обновите данные Яндекса."}</p>}
      <button type="button" className="text-action yandex-refresh" disabled={disabled || busy || !!link.conflict} onClick={openYandex}>{busy ? "Открываем Яндекс…" : "Обновить данные"}</button>
    </> : <button type="button" className="secondary-button wide" disabled={disabled || busy || !!token && !link} onClick={openYandex}>{busy ? "Открываем Яндекс…" : token ? "Привязать Яндекс ID" : "Войти через Яндекс"}</button>}
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
