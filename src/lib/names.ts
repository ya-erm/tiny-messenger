import { LIMITS } from "@/lib/constants";

const AVATAR_BASE_URL = "https://storage.yandexcloud.net/tiny-messenger/avatars";

const animalAvatarFiles = [
  { name: "Лев", file: "01-lion.png" },
  { name: "Поросёнок", file: "02-pig.png" },
  { name: "Слон", file: "03-elephant.png" },
  { name: "Обезьяна", file: "04-monkey.png" },
  { name: "Чёрный кот", file: "05-black-cat.png" },
  { name: "Тигр", file: "06-tiger.png" },
  { name: "Панда", file: "07-panda.png" },
  { name: "Лягушка", file: "08-frog.png" },
  { name: "Мышь", file: "09-mouse.png" },
  { name: "Коала", file: "10-koala.png" },
  { name: "Кролик", file: "11-rabbit.png" },
  { name: "Медведь", file: "12-bear.png" },
  { name: "Пингвин", file: "13-penguin.png" },
  { name: "Собака", file: "14-dog.png" },
  { name: "Енот", file: "15-raccoon.png" },
  { name: "Ёж", file: "16-hedgehog.png" },
  { name: "Далматин", file: "17-dalmatian.png" },
  { name: "Бегемот", file: "18-hippo.png" },
  { name: "Серый кот", file: "19-gray-cat.png" },
  { name: "Лиса", file: "20-fox.png" },
  { name: "Олень", file: "21-deer.png" },
  { name: "Сова", file: "22-owl.png" },
  { name: "Ленивец", file: "23-sloth.png" },
  { name: "Коза", file: "24-goat.png" },
  { name: "Цыплёнок", file: "25-chick.png" },
  { name: "Альпака", file: "26-alpaca.png" },
  { name: "Корсак", file: "27-corsac.png" },
  { name: "Геккон", file: "28-gecko.png" },
  { name: "Выдра", file: "29-otter.png" },
  { name: "Кит", file: "30-whale.png" },
  { name: "Снежный барс", file: "31-snow-leopard.png" },
  { name: "Тапир", file: "32-tapir.png" },
  { name: "Толстый лори", file: "33-slow-loris.png" },
  { name: "Зебра", file: "34-zebra.png" },
  { name: "Квокка", file: "35-quokka.png" },
  { name: "Манул", file: "36-pallas-cat.png" },
  { name: "Лама", file: "37-llama.png" },
  { name: "Фенек", file: "38-fennec.png" },
  { name: "Капибара", file: "39-capybara.png" },
  { name: "Красная панда", file: "40-red-panda.png" },
  { name: "Аксолотль", file: "41-axolotl.png" },
  { name: "Сурикат", file: "42-meerkat.png" },
  { name: "Утконос", file: "43-platypus.png" },
  { name: "Хамелеон", file: "44-chameleon.png" },
  { name: "Тукан", file: "45-toucan.png" },
  { name: "Тюлень", file: "46-seal.png" },
  { name: "Белый медведь", file: "47-polar-bear.png" },
  { name: "Крокодил", file: "48-crocodile.png" },
  { name: "Белка", file: "49-squirrel.png" },
  { name: "Летучая мышь", file: "50-bat.png" },
] as const;

const animalAvatars = animalAvatarFiles.map(({ name, file }) => ({
  name,
  url: `${AVATAR_BASE_URL}/${file}`,
}));

type GrammaticalGender = "masculine" | "feminine";

interface AnimalProfileSource {
  canonicalName: string;
  noun: string;
  gender: GrammaticalGender;
  avatarFile: string;
}

const adjectives = [
  { masculine: "Сонный", feminine: "Сонная" },
  { masculine: "Бодрый", feminine: "Бодрая" },
  { masculine: "Тихий", feminine: "Тихая" },
  { masculine: "Юркий", feminine: "Юркая" },
  { masculine: "Хитрый", feminine: "Хитрая" },
  { masculine: "Мудрый", feminine: "Мудрая" },
  { masculine: "Добрый", feminine: "Добрая" },
  { masculine: "Смелый", feminine: "Смелая" },
  { masculine: "Важный", feminine: "Важная" },
  { masculine: "Рыжий", feminine: "Рыжая" },
  { masculine: "Белый", feminine: "Белая" },
  { masculine: "Синий", feminine: "Синяя" },
  { masculine: "Малый", feminine: "Малая" },
  { masculine: "Шустрый", feminine: "Шустрая" },
  { masculine: "Милый", feminine: "Милая" },
  { masculine: "Славный", feminine: "Славная" },
  { masculine: "Дикий", feminine: "Дикая" },
  { masculine: "Ловкий", feminine: "Ловкая" },
  { masculine: "Верный", feminine: "Верная" },
  { masculine: "Злой", feminine: "Злая" },
] as const;

const animalProfiles: readonly AnimalProfileSource[] = [
  { canonicalName: "Смелый лев", noun: "лев", gender: "masculine", avatarFile: "01-lion.png" },
  { canonicalName: "Злой поросёнок", noun: "поросёнок", gender: "masculine", avatarFile: "02-pig.png" },
  { canonicalName: "Добрый слон", noun: "слон", gender: "masculine", avatarFile: "03-elephant.png" },
  { canonicalName: "Юркая обезьяна", noun: "обезьяна", gender: "feminine", avatarFile: "04-monkey.png" },
  { canonicalName: "Кот Уголёк", noun: "кот Уголёк", gender: "masculine", avatarFile: "05-black-cat.png" },
  { canonicalName: "Хитрый тигр", noun: "тигр", gender: "masculine", avatarFile: "06-tiger.png" },
  { canonicalName: "Панда Боря", noun: "панда", gender: "feminine", avatarFile: "07-panda.png" },
  { canonicalName: "Лягушка Клава", noun: "лягушка", gender: "feminine", avatarFile: "08-frog.png" },
  { canonicalName: "Мышка Нора", noun: "мышка", gender: "feminine", avatarFile: "09-mouse.png" },
  { canonicalName: "Коала Коля", noun: "коала", gender: "feminine", avatarFile: "10-koala.png" },
  { canonicalName: "Кролик Родя", noun: "кролик", gender: "masculine", avatarFile: "11-rabbit.png" },
  { canonicalName: "Медведь Потап", noun: "медведь", gender: "masculine", avatarFile: "12-bear.png" },
  { canonicalName: "Пингвин Пиня", noun: "пингвин", gender: "masculine", avatarFile: "13-penguin.png" },
  { canonicalName: "Пёс Рекс", noun: "пёс", gender: "masculine", avatarFile: "14-dog.png" },
  { canonicalName: "Бодрый енот", noun: "енот", gender: "masculine", avatarFile: "15-raccoon.png" },
  { canonicalName: "Ёжик Жора", noun: "ёж", gender: "masculine", avatarFile: "16-hedgehog.png" },
  { canonicalName: "Далматин Дима", noun: "далматин", gender: "masculine", avatarFile: "17-dalmatian.png" },
  { canonicalName: "Бегемот Боря", noun: "бегемот", gender: "masculine", avatarFile: "18-hippo.png" },
  { canonicalName: "Кот Барсик", noun: "кот Барсик", gender: "masculine", avatarFile: "19-gray-cat.png" },
  { canonicalName: "Рыжая лиса", noun: "лиса", gender: "feminine", avatarFile: "20-fox.png" },
  { canonicalName: "Олень Север", noun: "олень", gender: "masculine", avatarFile: "21-deer.png" },
  { canonicalName: "Мудрая сова", noun: "сова", gender: "feminine", avatarFile: "22-owl.png" },
  { canonicalName: "Ленивец Лёня", noun: "ленивец", gender: "masculine", avatarFile: "23-sloth.png" },
  { canonicalName: "Коза Зоя", noun: "коза", gender: "feminine", avatarFile: "24-goat.png" },
  { canonicalName: "Цыплёнок Цыпа", noun: "цыплёнок", gender: "masculine", avatarFile: "25-chick.png" },
  { canonicalName: "Сонная альпака", noun: "альпака", gender: "feminine", avatarFile: "26-alpaca.png" },
  { canonicalName: "Хитрый корсак", noun: "корсак", gender: "masculine", avatarFile: "27-corsac.png" },
  { canonicalName: "Юркий геккон", noun: "геккон", gender: "masculine", avatarFile: "28-gecko.png" },
  { canonicalName: "Выдра Нюра", noun: "выдра", gender: "feminine", avatarFile: "29-otter.png" },
  { canonicalName: "Синий кит", noun: "кит", gender: "masculine", avatarFile: "30-whale.png" },
  { canonicalName: "Белый барс", noun: "барс", gender: "masculine", avatarFile: "31-snow-leopard.png" },
  { canonicalName: "Важный тапир", noun: "тапир", gender: "masculine", avatarFile: "32-tapir.png" },
  { canonicalName: "Крошка лори", noun: "лори", gender: "masculine", avatarFile: "33-slow-loris.png" },
  { canonicalName: "Зебра в кедах", noun: "зебра", gender: "feminine", avatarFile: "34-zebra.png" },
  { canonicalName: "Квокка Инна", noun: "квокка", gender: "feminine", avatarFile: "35-quokka.png" },
  { canonicalName: "Смелый манул", noun: "манул", gender: "masculine", avatarFile: "36-pallas-cat.png" },
  { canonicalName: "Лама Люся", noun: "лама", gender: "feminine", avatarFile: "37-llama.png" },
  { canonicalName: "Фенек Федя", noun: "фенек", gender: "masculine", avatarFile: "38-fennec.png" },
  { canonicalName: "Капибара Капа", noun: "капибара", gender: "feminine", avatarFile: "39-capybara.png" },
  { canonicalName: "Панда Поля", noun: "панда Поля", gender: "feminine", avatarFile: "40-red-panda.png" },
  { canonicalName: "Аксолотль Акси", noun: "аксолотль", gender: "masculine", avatarFile: "41-axolotl.png" },
  { canonicalName: "Сурикат Сёма", noun: "сурикат", gender: "masculine", avatarFile: "42-meerkat.png" },
  { canonicalName: "Утконос Платон", noun: "утконос", gender: "masculine", avatarFile: "43-platypus.png" },
  { canonicalName: "Хамелеон Хома", noun: "хамелеон", gender: "masculine", avatarFile: "44-chameleon.png" },
  { canonicalName: "Тукан Тоша", noun: "тукан", gender: "masculine", avatarFile: "45-toucan.png" },
  { canonicalName: "Тюлень Тёма", noun: "тюлень", gender: "masculine", avatarFile: "46-seal.png" },
  { canonicalName: "Мишка Полюс", noun: "мишка Полюс", gender: "masculine", avatarFile: "47-polar-bear.png" },
  { canonicalName: "Крокодил Кузя", noun: "крокодил", gender: "masculine", avatarFile: "48-crocodile.png" },
  { canonicalName: "Белка Боня", noun: "белка", gender: "feminine", avatarFile: "49-squirrel.png" },
  { canonicalName: "Мышка Луна", noun: "мышка Луна", gender: "feminine", avatarFile: "50-bat.png" },
];

function namesForProfile(profile: AnimalProfileSource) {
  return Array.from(new Set([
    profile.canonicalName,
    ...adjectives.map((forms) => `${forms[profile.gender]} ${profile.noun}`),
  ])).filter((name) => Array.from(name).length <= LIMITS.name);
}

const animalNames = animalProfiles.map((profile) => profile.canonicalName);

export interface AnimalProfile {
  name: string;
  avatarUrl?: string;
}

function publicAnimalProfile(profile: AnimalProfileSource, name = profile.canonicalName): AnimalProfile {
  return {
    name,
    avatarUrl: `${AVATAR_BASE_URL}/${profile.avatarFile}`,
  };
}

export function animalProfileByName(name: string): AnimalProfile | undefined {
  const profile = animalProfiles.find((candidate) => namesForProfile(candidate).includes(name));
  return profile ? publicAnimalProfile(profile, name) : undefined;
}

export function randomAnimalProfile(excludedName?: string): AnimalProfile {
  let profileIndex = Math.floor(Math.random() * animalProfiles.length);
  let profile = animalProfiles[profileIndex] ?? animalProfiles[0];
  let names = namesForProfile(profile).filter((name) => name !== excludedName);

  if (!names.length) {
    profileIndex = (profileIndex + 1) % animalProfiles.length;
    profile = animalProfiles[profileIndex] ?? animalProfiles[0];
    names = namesForProfile(profile);
  }

  const name = names[Math.floor(Math.random() * names.length)] ?? profile.canonicalName;
  return publicAnimalProfile(profile, name);
}

export function randomAnimalName(excludedName?: string) {
  return randomAnimalProfile(excludedName).name;
}

export { animalAvatars, animalNames };
