"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="fatal-error">
      <div className="fatal-card">
        <span className="brand-mark">tm</span>
        <h1>Что-то пошло не так</h1>
        <p>Перезагрузите приложение — ваши ключи остаются в этом браузере.</p>
        <button className="primary-button" onClick={reset}>Попробовать снова</button>
      </div>
    </main>
  );
}
