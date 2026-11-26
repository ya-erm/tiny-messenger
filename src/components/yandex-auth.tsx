"use client";
import {useEffect, useRef, useState} from "react";
import {completeYandex, startYandex, yandexConfig, yandexLinkStatus} from "@/lib/yandex-client";

export function YandexAccount({token = "", userId}: {token?: string; userId?: string}) {
  const [enabled, setEnabled] = useState(false);
  const [link, setLink] = useState<{linked: boolean; label?: string; conflict?: boolean}>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    void yandexConfig().then(async config => {
      if (!alive) return;
      setEnabled(config.enabled);
      if (config.enabled && token) {
        try { const status = await yandexLinkStatus(token); if (alive) setLink(status); }
        catch { if (alive) setError("Не удалось проверить привязку. Попробуйте позже."); }
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, [token]);
  if (!enabled) return null;
  return <div className={token ? "settings-section yandex-section" : "yandex-login-section"}>
    {token ? <>
      <strong>Яндекс ID</strong>
      <p className="form-hint">{link?.linked ? link.conflict ? "Обнаружен конфликт привязок. Используйте резервный токен." : `Привязан${link.label ? ": " + link.label : ""}. Можно входить без токена.` : "Привяжите Яндекс ID, чтобы входить в этот аккаунт без токена."}</p>
    </> : null}
    {!link?.linked ? <button type="button" className="secondary-button wide" disabled={busy || !!token && !link} onClick={() => {
      setBusy(true); setError("");
      void startYandex(token ? "link" : "login", token, userId).catch(reason => {setError((reason as Error).message); setBusy(false);});
    }}>{busy ? "Открываем Яндекс…" : token ? "Привязать Яндекс ID" : "Войти через Яндекс"}</button> : null}
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
