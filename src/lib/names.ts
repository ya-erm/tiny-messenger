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
] as const;

const animalAvatars = animalAvatarFiles.map(({ name, file }) => ({
  name,
  url: `${AVATAR_BASE_URL}/${file}`,
}));

interface AnimalProfileSource {
  name: string;
  avatarFile?: string;
}

const animalProfiles: readonly AnimalProfileSource[] = [
  { name: "Сонная альпака" },
  { name: "Хитрый корсак" },
  { name: "Юркий геккон" },
  { name: "Тихая выдра" },
  { name: "Синий кит" },
  { name: "Бодрый енот", avatarFile: "15-raccoon.png" },
  { name: "Мудрая сова", avatarFile: "22-owl.png" },
  { name: "Рыжая лиса", avatarFile: "20-fox.png" },
  { name: "Белый барс" },
  { name: "Важный тапир" },
  { name: "Крошка лори" },
  { name: "Зебра в кедах" },
  { name: "Квокка Инна" },
  { name: "Смелый манул" },
  { name: "Панда Боря", avatarFile: "07-panda.png" },
  { name: "Лама Люся" },
  { name: "Кот Барсик", avatarFile: "19-gray-cat.png" },
  { name: "Фенек Федя" },
  { name: "Выдра Нюра" },
  { name: "Ёжик Жора", avatarFile: "16-hedgehog.png" },
] as const;

const animalNames = animalProfiles.map((profile) => profile.name);

export interface AnimalProfile {
  name: string;
  avatarUrl?: string;
}

function publicAnimalProfile(profile: AnimalProfileSource): AnimalProfile {
  return {
    name: profile.name,
    ...(profile.avatarFile ? { avatarUrl: `${AVATAR_BASE_URL}/${profile.avatarFile}` } : {}),
  };
}

export function animalProfileByName(name: string): AnimalProfile | undefined {
  const profile = animalProfiles.find((candidate) => candidate.name === name);
  return profile ? publicAnimalProfile(profile) : undefined;
}

export function randomAnimalProfile(excludedName?: string): AnimalProfile {
  const alternatives = excludedName
    ? animalProfiles.filter((profile) => profile.name !== excludedName)
    : animalProfiles;
  const profile = alternatives[Math.floor(Math.random() * alternatives.length)] ?? animalProfiles[0];
  return publicAnimalProfile(profile);
}

export function randomAnimalName(excludedName?: string) {
  return randomAnimalProfile(excludedName).name;
}

export { animalAvatars, animalNames };
