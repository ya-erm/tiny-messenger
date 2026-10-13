"use client";

import type { EmojiMartData } from "@emoji-mart/data";
import { useEffect, useId, useMemo, useState } from "react";
import { isReactionEmoji, POPULAR_REACTIONS, QUICK_REACTIONS, reactionLabel, type ReactionOption } from "@/lib/reactions";

const CATEGORY_LABELS: Record<string, string> = {
  popular: "Популярные",
  people: "Смайлики и люди",
  nature: "Животные и природа",
  foods: "Еда и напитки",
  activity: "Спорт и увлечения",
  places: "Путешествия",
  objects: "Предметы",
  symbols: "Символы",
  flags: "Флаги",
};

const SEARCH_TERMS: Record<string, string> = {
  "сердце": "heart", "кот": "cat", "кошка": "cat", "собака": "dog",
  "смех": "laugh", "улыбка": "smile", "цветок": "flower", "цветы": "flower",
  "солнце": "sun", "звезда": "star", "флаг": "flag", "пицца": "pizza",
  "кофе": "coffee", "торт": "cake", "подарок": "gift", "деньги": "money",
};

export function ReactionPicker({ ownEmoji, disabled, onSelect }: {
  ownEmoji?: string;
  disabled: boolean;
  onSelect: (emoji: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [category, setCategory] = useState("popular");
  const [query, setQuery] = useState("");
  const [skin, setSkin] = useState(0);
  const [catalog, setCatalog] = useState<EmojiMartData | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const expandedId = useId();

  useEffect(() => {
    if (!expanded || catalog) return;
    let cancelled = false;
    // The full catalog stays in a separate chunk until the picker is expanded.
    void import("@emoji-mart/data/sets/15/native.json")
      .then((module) => { if (!cancelled) { setCatalog(module.default); setLoadError(false); } })
      .catch(() => { if (!cancelled) setLoadError(true); });
    return () => { cancelled = true; };
  }, [catalog, expanded, loadAttempt]);

  const normalizedQuery = query.trim().toLocaleLowerCase("ru");
  const pastedEmoji = isReactionEmoji(query.trim()) ? query.trim() : null;
  const catalogByNative = useMemo(() => new Map(
    Object.values(catalog?.emojis ?? {}).map((item) => [item.skins[0].native, item]),
  ), [catalog]);
  const options = useMemo(() => {
    if (pastedEmoji) return [{ emoji: pastedEmoji, label: reactionLabel(pastedEmoji) }];
    const matches = (option: ReactionOption) => `${option.label} ${option.keywords ?? ""}`.toLocaleLowerCase("ru").includes(normalizedQuery);
    if (!catalog || (!normalizedQuery && category === "popular")) {
      return POPULAR_REACTIONS.filter(matches)
        .filter((option) => normalizedQuery || !QUICK_REACTIONS.some((quick) => quick.emoji === option.emoji))
        .map((option) => {
          const variant = catalogByNative.get(option.emoji)?.skins[skin];
          return variant ? { ...option, emoji: variant.native } : option;
        });
    }
    const ids = normalizedQuery ? Object.keys(catalog.emojis)
      : catalog.categories.find((item) => item.id === category)?.emojis ?? [];
    const terms = [normalizedQuery, SEARCH_TERMS[normalizedQuery]].filter(Boolean);
    const found = ids.flatMap((id): ReactionOption[] => {
      const item = catalog.emojis[id];
      if (!item) return [];
      const native = (item.skins[skin] ?? item.skins[0]).native;
      const popular = POPULAR_REACTIONS.find((option) => option.emoji === item.skins[0].native);
      const searchable = `${item.id} ${item.name} ${item.keywords.join(" ")} ${popular?.label ?? ""} ${popular?.keywords ?? ""}`.toLocaleLowerCase("ru");
      const words = searchable.split(/[\s_-]+/);
      if (normalizedQuery && !terms.some((term) => term.split(/\s+/).every((part) => words.some((word) =>
        term === SEARCH_TERMS[normalizedQuery] ? word === part : word.startsWith(part),
      )))) return [];
      return [{ emoji: native, label: popular?.label ?? item.name }];
    });
    return found;
  }, [catalog, catalogByNative, category, normalizedQuery, pastedEmoji, skin]);

  const emojiButton = ({ emoji, label }: ReactionOption) => <button
    key={emoji}
    type="button"
    role="menuitemradio"
    aria-checked={ownEmoji === emoji}
    aria-label={`${ownEmoji === emoji ? "Снять" : "Отправить"} реакцию: ${label}`}
    title={label}
    disabled={disabled}
    onClick={() => onSelect(emoji)}
  ><span aria-hidden="true">{emoji}</span></button>;

  return <div className="reaction-picker">
    <div className="reaction-quick" role="group" aria-label="Быстрые реакции">
      {QUICK_REACTIONS.map((option) => {
        const variant = catalogByNative.get(option.emoji)?.skins[skin];
        return emojiButton(variant ? { ...option, emoji: variant.native } : option);
      })}
      <button
        type="button"
        role="menuitem"
        className="reaction-expand"
        aria-label={expanded ? "Свернуть эмодзи" : "Все эмодзи"}
        aria-expanded={expanded}
        aria-controls={expandedId}
        onClick={() => setExpanded((current) => !current)}
      ><svg viewBox="0 0 24 24" aria-hidden="true"><path d={expanded ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg></button>
    </div>
    {expanded ? <div id={expandedId} className="reaction-expanded">
      <input
        className="reaction-search"
        aria-label="Поиск эмодзи"
        placeholder="Поиск или вставьте любой эмодзи"
        value={query}
        maxLength={64}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Text fields keep their own cursor keys and Tab navigation.
          if (event.key !== "Escape") event.stopPropagation();
          if (event.key === "Enter" && pastedEmoji && !disabled) {
            event.preventDefault();
            onSelect(pastedEmoji);
          }
        }}
      />
      <div className="reaction-catalog-controls" onKeyDown={(event) => { if (event.key !== "Escape") event.stopPropagation(); }}>
        <div className="reaction-select"><select aria-label="Категория эмодзи" value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="popular">Популярные</option>
          {catalog?.categories.map(({ id }) => <option key={id} value={id}>{CATEGORY_LABELS[id] ?? id}</option>)}
        </select></div>
        <div className="reaction-select"><select aria-label="Оттенок кожи" value={skin} onChange={(event) => setSkin(Number(event.target.value))}>
          {["🖐️", "🖐🏻", "🖐🏼", "🖐🏽", "🖐🏾", "🖐🏿"].map((emoji, index) => <option key={index} value={index}>{emoji}</option>)}
        </select></div>
      </div>
      <div className="reaction-grid" role="group" aria-label="Все эмодзи">
        {options.map(emojiButton)}
      </div>
      {!options.length ? <p className="reaction-hint">Ничего не найдено. Можно вставить любой эмодзи.</p> : null}
      {!catalog && !loadError ? <p className="reaction-hint" role="status">Загружаем полный каталог…</p> : null}
      {loadError ? <button type="button" onClick={() => { setLoadError(false); setLoadAttempt((current) => current + 1); }}>Повторить загрузку каталога</button> : null}
    </div> : null}
  </div>;
}
