export function localDateKey(value: string | Date) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function formatMessageDate(value: string, today: Date) {
  const date = new Date(value);
  const key = localDateKey(date);
  if (key === localDateKey(today)) return "Сегодня";
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === localDateKey(yesterday)) return "Вчера";
  const label = new Intl.DateTimeFormat("ru", { day: "numeric", month: "long" }).format(date);
  return date.getFullYear() === today.getFullYear() ? label : `${label} ${date.getFullYear()}`;
}
