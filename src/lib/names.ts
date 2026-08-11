const animalNames = [
  "Сонная альпака",
  "Хитрый корсак",
  "Юркий геккон",
  "Тихая выдра",
  "Синий кит",
  "Бодрый енот",
  "Мудрая сова",
  "Рыжая лиса",
  "Белый барс",
  "Важный тапир",
  "Крошка лори",
  "Зебра в кедах",
  "Квокка Инна",
  "Смелый манул",
  "Панда Боря",
  "Лама Люся",
  "Кот Барсик",
  "Фенек Федя",
  "Выдра Нюра",
  "Ёжик Жора",
] as const;

export function randomAnimalName() {
  return animalNames[Math.floor(Math.random() * animalNames.length)];
}

export { animalNames };
