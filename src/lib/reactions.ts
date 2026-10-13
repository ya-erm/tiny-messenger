import emojiRegex from "emoji-regex";

export interface ReactionOption {
  emoji: string;
  label: string;
  keywords?: string;
}

export const QUICK_REACTIONS: ReactionOption[] = [
  { emoji: "❤️", label: "Любовь", keywords: "сердце нравится" },
  { emoji: "😄", label: "Радость", keywords: "улыбка смех весело" },
  { emoji: "🔥", label: "Огонь" },
  { emoji: "👍", label: "Нравится", keywords: "да хорошо согласен" },
  { emoji: "👎", label: "Не нравится", keywords: "нет плохо" },
  { emoji: "👀", label: "Глаза", keywords: "смотрю наблюдаю" },
  { emoji: "👌", label: "Отлично", keywords: "ок хорошо" },
  { emoji: "💯", label: "Сто процентов", keywords: "100 согласен" },
];

export const POPULAR_REACTIONS: ReactionOption[] = [
  ...QUICK_REACTIONS,
  { emoji: "😍", label: "Влюблённость", keywords: "любовь сердце" },
  { emoji: "✅", label: "Готово", keywords: "галочка да" },
  { emoji: "💔", label: "Разбитое сердце", keywords: "грусть любовь" },
  { emoji: "😭", label: "Слёзы", keywords: "плач грусть" },
  { emoji: "🤔", label: "Размышление", keywords: "думаю вопрос" },
  { emoji: "😎", label: "Круто", keywords: "очки" },
  { emoji: "🤦", label: "Фейспалм", keywords: "facepalm" },
  { emoji: "😒", label: "Недовольство" },
  { emoji: "😮", label: "Удивление" },
  { emoji: "😱", label: "Испуг", keywords: "страх" },
  { emoji: "🤮", label: "Тошнота" },
  { emoji: "🙂", label: "Улыбка" },
  { emoji: "🥴", label: "Замешательство" },
  { emoji: "🌚", label: "Луна" },
  { emoji: "😡", label: "Злость", keywords: "гнев" },
  { emoji: "😈", label: "Чертёнок" },
  { emoji: "🤡", label: "Клоун" },
  { emoji: "🫠", label: "Тающий смайлик" },
  { emoji: "🤷", label: "Не знаю", keywords: "не уверен без понятия" },
  { emoji: "🙏", label: "Спасибо", keywords: "пожалуйста молитва" },
  { emoji: "🤝", label: "Рукопожатие", keywords: "согласен договорились" },
  { emoji: "👏", label: "Аплодисменты", keywords: "хлопки браво" },
  { emoji: "🎉", label: "Праздник", keywords: "поздравляю" },
  { emoji: "🗿", label: "Моаи" },
  { emoji: "💩", label: "Какашка" },
  { emoji: "➕", label: "Плюс" },
  { emoji: "➖", label: "Минус" },
  { emoji: "😂", label: "Смешно", keywords: "смех слёзы" },
  { emoji: "😢", label: "Грусть", keywords: "слёзы" },
  { emoji: "🥰", label: "Нежность", keywords: "любовь сердечки" },
  { emoji: "😘", label: "Поцелуй" },
  { emoji: "😉", label: "Подмигивание" },
  { emoji: "😏", label: "Ухмылка" },
  { emoji: "😴", label: "Сон", keywords: "сплю устал" },
  { emoji: "🤯", label: "Взрыв мозга", keywords: "шок удивление" },
  { emoji: "🫡", label: "Салют", keywords: "есть уважение" },
];

export function reactionLabel(emoji: string) {
  return POPULAR_REACTIONS.find((option) => option.emoji === emoji)?.label ?? emoji;
}

export function isReactionEmoji(value: unknown): value is string {
  // Match the entire string once, so flags, skin tones and ZWJ sequences are
  // accepted as one emoji, while text, multiple emoji and partial matches fail.
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  return emojiRegex().exec(value)?.[0] === value;
}
