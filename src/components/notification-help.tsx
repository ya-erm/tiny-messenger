"use client";

import { useEffect, useState } from "react";

export function NotificationHelp({ status, busy, canEnable, onCheck, onEnable, onBack }: {
  status: string;
  busy: boolean;
  canEnable: boolean;
  onCheck: () => Promise<void>;
  onEnable: () => Promise<void>;
  onBack: () => void;
}) {
  const [environment, setEnvironment] = useState({ yandex: false, android: false, framed: false, host: "этот сайт" });
  useEffect(() => {
    setEnvironment({
      yandex: /YaBrowser/i.test(navigator.userAgent),
      android: /Android/i.test(navigator.userAgent),
      framed: window.parent !== window,
      host: window.location.host,
    });
  }, []);

  return <div className="notification-help">
    <p>Сайт не может самостоятельно снять запрет браузера или телефона. Разрешение нужно изменить в их настройках.</p>
    {environment.framed ? <p className="notification-help-note">Для настройки откройте Tiny Messenger отдельной вкладкой: браузеры ограничивают запрос уведомлений во встроенном чате.</p> : null}
    <a href="/" target="_blank" rel="noopener noreferrer">Открыть Tiny Messenger отдельной вкладкой</a>
    <section className="settings-section">
      <h3>{environment.yandex ? "1. В Яндекс Браузере" : "1. В браузере"}</h3>
      {environment.yandex && environment.android ? <ol>
        <li>Откройте <strong>{environment.host}</strong> обычной вкладкой того же Яндекс Браузера, из которого установили приложение.</li>
        <li>В меню браузера откройте <strong>Настройки → Уведомления → Уведомления от сайтов</strong>.</li>
        <li>В списке «Заблокированы» или «Разрешены» найдите <strong>{environment.host}</strong> и выберите <strong>Разрешить</strong>.</li>
        <li>Если браузер запрещает всем сайтам запрашивать уведомления, включите общий переключатель «Уведомления» в этом же разделе.</li>
      </ol> : <ol>
        <li>Откройте <strong>{environment.host}</strong> обычной вкладкой того же браузера, в котором установлено приложение.</li>
        <li>Нажмите значок рядом с адресом сайта или откройте настройки разрешений сайтов в меню браузера.</li>
        <li>Найдите «Уведомления» для этого сайта и разрешите их. Если доступен только сброс запрета, сбросьте его и снова нажмите «Включить» в Tiny Messenger.</li>
      </ol>}
      {environment.yandex ? <a href="https://yandex.ru/support/browser-mobile-android-phone/ru/personal-settings/notifications" target="_blank" rel="noopener noreferrer">Инструкция Яндекс Браузера</a> : null}
    </section>
    {environment.android ? <section className="settings-section">
      <h3>2. В настройках Android</h3>
      <ol>
        <li>Откройте <strong>Настройки телефона → Приложения → {environment.yandex ? "Яндекс Браузер" : "ваш браузер"} → Уведомления</strong>.</li>
        <li>Включите разрешение уведомлений. Если Tiny Messenger есть в списке приложений отдельно, проверьте разрешение и для него.</li>
      </ol>
      <p>Названия пунктов могут отличаться в разных версиях Android и браузера.</p>
    </section> : null}
    <section className="settings-section">
      <h3>{environment.android ? "3. Вернитесь в Tiny Messenger" : "2. Вернитесь в Tiny Messenger"}</h3>
      <p>После изменения настроек проверьте разрешение, затем включите подписку на уведомления.</p>
      <p role="status" aria-live="polite"><strong>{status}</strong></p>
      <div className="notification-help-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={() => { void onCheck(); }}>{busy ? "Проверяем…" : "Проверить разрешение"}</button>
        {canEnable ? <button type="button" className="primary-button" disabled={busy} onClick={() => { void onEnable(); }}>Включить уведомления</button> : null}
        <button type="button" className="secondary-button" onClick={onBack}>К настройкам</button>
      </div>
    </section>
  </div>;
}
