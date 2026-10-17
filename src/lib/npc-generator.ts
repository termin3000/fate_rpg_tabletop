// ── NPC Quick Generator ──────────────────────────────────────
// Russian name parts + archetypes + fantasy race/culture name
// presets for fast GM improvisation.
// All content is in Russian.

import { DEFAULT_SETTINGS } from '@/lib/types';

export type NPCGender = 'male' | 'female';

export type NamePreset =
  | 'russian'
  | 'elven'
  | 'dwarven'
  | 'goblin'
  | 'human_western'
  | 'human_eastern'
  | 'orcish'
  | 'draconic';

export interface NamePresetOption {
  id: NamePreset;
  label: string;
  icon: string;
}

export const NAME_PRESETS: NamePresetOption[] = [
  { id: 'russian', label: 'Русские (современные)', icon: '🇷🇺' },
  { id: 'elven', label: 'Эльфийские', icon: '🧝' },
  { id: 'dwarven', label: 'Дворфийские', icon: '⛏️' },
  { id: 'goblin', label: 'Гоблинские', icon: '👺' },
  { id: 'human_western', label: 'Человеческие (западное фэнтези)', icon: '⚔️' },
  { id: 'human_eastern', label: 'Человеческие (восточное фэнтези)', icon: '🏯' },
  { id: 'orcish', label: 'Орочьи', icon: '👹' },
  { id: 'draconic', label: 'Драконьи', icon: '🐉' },
];

export interface NPCArchetype {
  name: string;
  /** Concept template — `{region}` is replaced with a random region. */
  concept: string;
  aspects: string[];
  /** Skill name → value (Fate ladder). */
  skills: Record<string, number>;
}

export interface GeneratedNPC {
  name: string;
  type: 'npc';
  concept: string;
  aspects: string[];
  skills: Array<{ name: string; value: number }>;
  fatePoints: number;
  refresh: number;
  /** Display-only metadata (archetype name and gender) for the UI. */
  archetype: string;
  gender: NPCGender;
}

export interface GenerateNPCOptions {
  /** Archetype name. `undefined` → random. */
  archetype?: string;
  /** Gender. `undefined` → random. */
  gender?: NPCGender;
  /** Name culture/race preset. `undefined` → random Russian. */
  namePreset?: NamePreset;
}

// ── Russian name parts (default) ─────────────────────────────
const FIRST_NAMES_MALE = [
  'Александр', 'Дмитрий', 'Максим', 'Сергей', 'Андрей',
  'Алексей', 'Артём', 'Илья', 'Кирилл', 'Михаил',
  'Николай', 'Павел', 'Роман', 'Владимир', 'Виктор',
  'Олег', 'Игорь', 'Денис', 'Антон', 'Вадим',
];

const FIRST_NAMES_FEMALE = [
  'Анна', 'Мария', 'Елена', 'Ольга', 'Наталья',
  'Татьяна', 'Ирина', 'Светлана', 'Юлия', 'Екатерина',
  'Алёна', 'Виктория', 'Дарья', 'Ксения', 'Полина',
  'Анастасия', 'София', 'Валерия', 'Маргарита', 'Вера',
];

const LAST_NAMES_MALE = [
  'Иванов', 'Петров', 'Сидоров', 'Кузнецов', 'Смирнов',
  'Попов', 'Васильев', 'Соколов', 'Михайлов', 'Новиков',
  'Фёдоров', 'Морозов', 'Волков', 'Алексеев', 'Лебедев',
  'Семёнов', 'Егоров', 'Павлов', 'Козлов', 'Степанов',
];

const LAST_NAMES_FEMALE = [
  'Иванова', 'Петрова', 'Сидорова', 'Кузнецова', 'Смирнова',
  'Попова', 'Васильева', 'Соколова', 'Михайлова', 'Новикова',
  'Фёдорова', 'Морозова', 'Волкова', 'Алексеева', 'Лебедева',
  'Семёнова', 'Егорова', 'Павлова', 'Козлова', 'Степанова',
];

// ── Fantasy syllable tables ──────────────────────────────────
// Each culture has prefix + suffix arrays for first names
// (with male/female distinction where applicable) and last names.
// The generator picks 1–2 prefixes and 1–2 suffixes, capitalizes
// the first letter, and joins them into a believable name.

interface SyllableTable {
  firstPrefixMale: string[];
  firstPrefixFemale: string[];
  firstSuffixMale: string[];
  firstSuffixFemale: string[];
  lastPrefix: string[];
  lastSuffix: string[];
  /** Number of prefix+suffix pairs to combine for first name (default 1) */
  firstComplexity?: 1 | 2;
  /** Number of prefix+suffix pairs to combine for last name (default 1) */
  lastComplexity?: 1 | 2;
}

const ELVEN: SyllableTable = {
  firstPrefixMale: [
    'аэл', 'тар', 'кэл', 'фар', 'ило', 'нир', 'сэр', 'вас',
    'аэ', 'лор', 'гил', 'эро', 'фин', 'кир', 'аму', 'нэ',
  ],
  firstPrefixFemale: [
    'аэл', 'ти', 'кэл', 'фар', 'ило', 'нир', 'сэр', 'вас',
    'аэ', 'лор', 'гил', 'эр', 'фин', 'кир', 'аму', 'нэ',
  ],
  firstSuffixMale: [
    'ион', 'иан', 'от', 'аэл', 'орис', 'андил', 'увиил', 'арон',
    'дир', 'фин', 'дан', 'вэн', 'нор', 'дар', 'мир', 'таль',
  ],
  firstSuffixFemale: [
    'иэль', 'ия', 'вэн', 'аэ', 'ирис', 'андил', 'увиил', 'эт',
    'иэль', 'я', 'вэн', 'на', 'дил', 'риэль', 'мир', 'тиэль',
  ],
  lastPrefix: [
    'звёзд', 'лун', 'серебр', 'свет', 'зар', 'тен', 'шёп', 'сия',
    'вечн', 'серебр', 'зелён', 'звёзд', 'лун', 'золот', 'тум', 'выс',
  ],
  lastSuffix: [
    'лист', 'цвет', 'песнь', 'ветр', 'пады', 'тень', 'танц', 'ткач',
    'шаг', 'лук', 'серд', 'клин', 'шёпот', 'ход', 'песнь', 'иск',
  ],
  firstComplexity: 2,
};

const DWARVEN: SyllableTable = {
  firstPrefixMale: [
    'тор', 'грим', 'дур', 'бар', 'брон', 'кор', 'гун', 'трейн',
    'бал', 'два', 'муг', 'грам', 'тор', 'бра', 'кал', 'ор',
  ],
  firstPrefixFemale: [
    'ти', 'гри', 'дур', 'бар', 'дис', 'хел', 'хильд', 'бран',
    'бри', 'даг', 'рун', 'вал', 'гун', 'тора', 'кал', 'ор',
  ],
  firstSuffixMale: [
    'ин', 'ун', 'ак', 'ек', 'ум', 'ар', 'орн', 'риг',
    'дан', 'гар', 'дум', 'дрик', 'мунд', 'бак', 'грум', 'нар',
  ],
  firstSuffixFemale: [
    'а', 'ия', 'ин', 'ун', 'дис', 'илла', 'рун', 'хильд',
    'на', 'ра', 'да', 'ва', 'ла', 'ка', 'та', 'га',
  ],
  lastPrefix: [
    'желез', 'кам', 'золот', 'стал', 'глуб', 'тёмн', 'огн', 'гром',
    'скал', 'руд', 'наков', 'кузн', 'молот', 'уголь', 'гор', 'мифр',
  ],
  lastSuffix: [
    'кузн', 'молот', 'серд', 'кулак', 'шлем', 'гиб', 'лом', 'кам',
    'рук', 'плеч', 'щит', 'пасть', 'кирк', 'наков', 'челюсть', 'круж',
  ],
};

const GOBLIN: SyllableTable = {
  firstPrefixMale: [
    'сни', 'гри', 'сли', 'кра', 'зит', 'мук', 'тра', 'глип',
    'фрик', 'нак', 'гак', 'скек', 'врик', 'фут', 'плит', 'кри',
  ],
  firstPrefixFemale: [
    'сни', 'гри', 'сли', 'кра', 'зит', 'мук', 'тра', 'глип',
    'фрик', 'нак', 'гик', 'скек', 'врик', 'фит', 'плит', 'кри',
  ],
  firstSuffixMale: [
    'к', 'т', 'г', 'кик', 'нак', 'тч', 'зик', 'гриб',
    'ч', 'к', 'кс', 'нк', 'ррик', 'ззик', 'тч', 'нк',
  ],
  firstSuffixFemale: [
    'а', 'и', 'ка', 'чи', 'на', 'кси', 'ка', 'зи',
    'ла', 'ни', 'ки', 'ри', 'ти', 'ми', 'пи', 'ви',
  ],
  lastPrefix: [
    'гряз', 'гнил', 'кор', 'слиз', 'черв', 'крыс', 'бородав', 'лич',
    'тиной', 'плесн', 'гно', 'болот', 'парш', 'жаб', 'вон', 'топ',
  ],
  lastSuffix: [
    'клык', 'когт', 'глаз', 'рыл', 'шку', 'зуб', 'ногт', 'ух',
    'брюх', 'хреб', 'кишк', 'нос', 'подбор', 'язык', 'лап', 'пасть',
  ],
};

const HUMAN_WESTERN: SyllableTable = {
  firstPrefixMale: [
    'ал', 'бран', 'гар', 'ро', 'эд', 'вил', 'тео', 'дал',
    'джон', 'сэм', 'тир', 'джам', 'роб', 'эри', 'алд', 'кор',
  ],
  firstPrefixFemale: [
    'ал', 'бран', 'сил', 'ро', 'эл', 'вил', 'кэ', 'дал',
    'цер', 'лин', 'ари', 'май', 'сан', 'эли', 'из', 'кат',
  ],
  firstSuffixMale: [
    'рик', 'вин', 'ион', 'дред', 'он', 'ард', 'эн', 'нор',
    'ис', 'ас', 'ор', 'ан', 'рик', 'иан', 'эл', 'ум',
  ],
  firstSuffixFemale: [
    'ия', 'вин', 'вэн', 'дред', 'а', 'ис', 'на', 'риэль',
    'а', 'ис', 'т', 'эл', 'ис', 'да', 'ра', 'энн',
  ],
  lastPrefix: [
    'чёрн', 'бур', 'желез', 'сер', 'зимн', 'дик', 'выс', 'мрачн',
    'строг', 'кам', 'ворон', 'волч', 'ал', 'тёмн', 'север', 'терн',
  ],
  lastSuffix: [
    'лес', 'кузн', 'нос', 'кам', 'страж', 'смотр', 'плащ', 'кров',
    'пол', 'хран', 'огн', 'грив', 'холд', 'креп', 'клык', 'греб',
  ],
};

const HUMAN_EASTERN: SyllableTable = {
  firstPrefixMale: [
    'чэнь', 'цзянь', 'лун', 'вэй', 'сяо', 'кай', 'фэн', 'мин',
    'шэнь', 'хао', 'чжэнь', 'цзюнь', 'тянь', 'бао', 'линь', 'и',
  ],
  firstPrefixFemale: [
    'мэй', 'линь', 'хуа', 'ся', 'юнь', 'сюэ', 'лань', 'суй',
    'цзинь', 'чи', 'лиль', 'цю', 'минь', 'ин', 'вань', 'фэн',
  ],
  firstSuffixMale: [
    'вэй', 'лун', 'хуа', 'мин', 'тао', 'дэ', 'кунь', 'жан',
    'шэн', 'чэн', 'жэнь', 'тянь', 'сянь', 'фан', 'чжай', 'шань',
  ],
  firstSuffixFemale: [
    'лин', 'мэй', 'сянь', 'эр', 'лань', 'хуа', 'инь', 'нин',
    'шуан', 'чэнь', 'чжу', 'жо', 'синь', 'цинь', 'фэй', 'жу',
  ],
  lastPrefix: [
    'бай', 'хэй', 'лун', 'фэн', 'юнь', 'тянь', 'цзинь', 'му',
    'шуй', 'хо', 'тан', 'сун', 'лю', 'чжао', 'хань', 'цинь',
  ],
  lastSuffix: [
    'вэй', 'линь', 'фэн', 'юнь', 'шань', 'хэ', 'чуань', 'мин',
    'тянь', 'дао', 'сюань', 'чэнь', 'шэн', 'ци', 'синь', 'юань',
  ],
};

const ORCISH: SyllableTable = {
  firstPrefixMale: [
    'гру', 'тхр', 'гаш', 'муг', 'рок', 'дру', 'кра', 'гор',
    'скар', 'ур', 'заг', 'брак', 'хур', 'зуг', 'грум', 'брог',
  ],
  firstPrefixFemale: [
    'гру', 'тхр', 'гаш', 'муг', 'рок', 'дру', 'кра', 'гор',
    'скар', 'ур', 'заг', 'брик', 'хур', 'зуг', 'грам', 'брок',
  ],
  firstSuffixMale: [
    'тхак', 'гул', 'нак', 'дак', 'гаш', 'тук', 'рот', 'гар',
    'рак', 'зон', 'муг', 'дум', 'нар', 'жул', 'рак', 'гот',
  ],
  firstSuffixFemale: [
    'га', 'ка', 'ра', 'на', 'ша', 'за', 'та', 'гра',
    'ла', 'ма', 'да', 'ва', 'ха', 'на', 'за', 'та',
  ],
  lastPrefix: [
    'кров', 'кост', 'череп', 'желез', 'кам', 'смерт', 'кров', 'огн',
    'мяс', 'клык', 'гриз', 'боев', 'ярост', 'гиб', 'шрам', 'манг',
  ],
  lastSuffix: [
    'давил', 'разрыв', 'баш', 'крошил', 'рыв', 'лом', 'поед', 'выл',
    'терз', 'молот', 'убийц', 'топт', 'кулак', 'гиб', 'клык', 'бивень',
  ],
};

const DRACONIC: SyllableTable = {
  firstPrefixMale: [
    'зир', 'кри', 'вора', 'таль', 'ксан', 'драк', 'мор', 'шир',
    'аэ', 'нит', 'баэл', 'зеф', 'арк', 'векс', 'мир', 'рит',
  ],
  firstPrefixFemale: [
    'зир', 'кри', 'вора', 'таль', 'ксан', 'драк', 'мор', 'шир',
    'аэ', 'нит', 'баэл', 'зеф', 'арк', 'векс', 'мит', 'рит',
  ],
  firstSuffixMale: [
    'ион', 'акс', 'от', 'ир', 'ис', 'ус', 'ар', 'ат',
    'нак', 'гор', 'вакс', 'тус', 'никс', 'рион', 'ксас', 'дан',
  ],
  firstSuffixFemale: [
    'ия', 'икс', 'эт', 'ир', 'ис', 'ия', 'ара', 'ат',
    'накс', 'гор', 'векс', 'тис', 'никс', 'рион', 'ксас', 'на',
  ],
  lastPrefix: [
    'солнц', 'бур', 'пепл', 'чеш', 'плам', 'клык', 'когт', 'крыл',
    'золот', 'ноч', 'звёзд', 'лун', 'желез', 'гром', 'кров', 'угл',
  ],
  lastSuffix: [
    'рожд', 'крыл', 'гиб', 'когт', 'огн', 'чеш', 'клык', 'зуб',
    'клейм', 'ярост', 'гнев', 'рык', 'плам', 'серд', 'бур', 'раж',
  ],
};

const SYLLABLE_TABLES: Record<NamePreset, SyllableTable> = {
  russian: {
    firstPrefixMale: [],
    firstPrefixFemale: [],
    firstSuffixMale: [],
    firstSuffixFemale: [],
    lastPrefix: [],
    lastSuffix: [],
  },
  elven: ELVEN,
  dwarven: DWARVEN,
  goblin: GOBLIN,
  human_western: HUMAN_WESTERN,
  human_eastern: HUMAN_EASTERN,
  orcish: ORCISH,
  draconic: DRACONIC,
};

// ── NPC archetypes ───────────────────────────────────────────
export const NPC_ARCHETYPES: NPCArchetype[] = [
  {
    name: 'Воин',
    concept: 'Опытный боец из {region}',
    aspects: ['Я никогда не сдаюсь', 'Мой меч — моё слово', 'Шрамы рассказывают историю'],
    skills: { 'Бой': 4, 'Атлетика': 3, 'Телосложение': 3, 'Воля': 2 },
  },
  {
    name: 'Маг',
    concept: 'Таинственный чародей из {region}',
    aspects: ['Знание — сила', 'Тайны древних рун', 'Цена магии'],
    skills: { 'Знания': 4, 'Воля': 3, 'Эмпатия': 2, 'Расследование': 2 },
  },
  {
    name: 'Плут',
    concept: 'Ловкий вор из {region}',
    aspects: ['Тень в ночи', 'Быстрые руки', 'Никто не замечает'],
    skills: { 'Скрытность': 4, 'Воровство': 3, 'Обман': 3, 'Внимательность': 2 },
  },
  {
    name: 'Дипломат',
    concept: 'Убедительный переговорщик из {region}',
    aspects: ['Слово лечит', 'Друзья везде', 'Я знаю подход'],
    skills: { 'Взаимопонимание': 4, 'Обман': 3, 'Эмпатия': 3, 'Контакты': 2 },
  },
  {
    name: 'Следопыт',
    concept: 'Одинокий охотник из {region}',
    aspects: ['Дитя леса', 'Глаз орла', 'Следы не врут'],
    skills: { 'Внимательность': 4, 'Атлетика': 3, 'Скрытность': 2, 'Выживание': 3 },
  },
  {
    name: 'Купец',
    concept: 'Богатый торговец из {region}',
    aspects: ['Золото решает всё', 'Сделка есть сделка', 'Товар всегда найдёт покупателя'],
    skills: { 'Ресурсы': 4, 'Обман': 3, 'Контакты': 3, 'Взаимопонимание': 2 },
  },
  {
    name: 'Жрец',
    concept: 'Преданный служитель веры из {region}',
    aspects: ['Вера двигает горы', 'Свет изгоняет тьму', 'Молитва не пуста'],
    skills: { 'Воля': 4, 'Эмпатия': 3, 'Знания': 2, 'Взаимопонимание': 2 },
  },
  {
    name: 'Наёмник',
    concept: 'Ветеран бесчисленных битв из {region}',
    aspects: ['За правильную цену', 'Война — моя профессия', 'Товарищи важнее золота'],
    skills: { 'Бой': 3, 'Стрельба': 3, 'Телосложение': 3, 'Атлетика': 2 },
  },
];

// ── Aspect pools for variety ──────────────────────────────────
// Each archetype has a pool of possible aspects. During generation,
// 3 are randomly picked (without replacement) so NPCs feel unique.
const ASPECT_POOLS: Record<string, string[]> = {
  'Воин': [
    'Я никогда не сдаюсь',
    'Мой меч — моё слово',
    'Шрамы рассказывают историю',
    'Первым в бой, последним — из боя',
    'Защищу любого, кто стоит за моей спиной',
    'Гнев — моё оружие',
    'Живой щит',
    'Кровь на руках, честь в сердце',
    'Битва — лучший учитель',
    'Не отступаю ни на шаг',
    'Сила решает всё',
    'Сталь крепче слов',
  ],
  'Маг': [
    'Знание — сила',
    'Тайны древних рун',
    'Цена магии',
    'Реальность — лишь иллюзия',
    'Книги мудрее людей',
    'Магия требует жертв',
    'Прикосновение к хаосу',
    'Арканы повинуются мне',
    'Загадочный незнакомец',
    'Тьма внутри',
    'Искусство невозможного',
    'Запретное влечёт',
  ],
  'Плут': [
    'Тень в ночи',
    'Быстрые руки',
    'Никто не замечает',
    'Улыбка открывает любые двери',
    'Карманы других — мой запасной кошелёк',
    'Путаю следы',
    'Всегда есть план Б',
    'Тихие шаги, громкие дела',
    'Доверяй интуиции',
    'Невидимый среди толпы',
    'Ловкость рук и ничего более',
    'Больше удачи, чем ума',
  ],
  'Дипломат': [
    'Слово лечит',
    'Друзья везде',
    'Я знаю подход',
    'Переговоры вместо мечей',
    'Улыбка — моё оружие',
    'Долг перед союзниками',
    'Хитрее змеи, мягче шёлка',
    'Враг моего врага — мой друг',
    'Каждый что-то должен',
    'Искусство компромисса',
    'Слово не воробей',
    'Политика — вторая натура',
  ],
  'Следопыт': [
    'Дитя леса',
    'Глаз орла',
    'Следы не врут',
    'Дикая природа — мой дом',
    'Слышу шёпот ветра',
    'Ни один зверь не уйдёт',
    'Охотник и добыча',
    'Земля говорит со мной',
    'Тропа через чащу',
    'Тишина — лучший советчик',
    'Звериный инстинкт',
    'Выживание любой ценой',
  ],
  'Купец': [
    'Золото решает всё',
    'Сделка есть сделка',
    'Товар всегда найдёт покупателя',
    'Прибыль превыше всего',
    'Долги нужно отдавать',
    'Информация стоит дороже золота',
    'Торг уместен всегда',
    'Щедрость — инвестиция',
    'Караван не ждёт',
    'Монеты не лгут',
    'Каждый имеет свою цену',
    'Золото — лучший аргумент',
  ],
  'Жрец': [
    'Вера двигает горы',
    'Свет изгоняет тьму',
    'Молитва не пуста',
    'Божья воля выше мирской',
    'Исцеление души и тела',
    'Ересь не пройдёт',
    'Священный долг',
    'Служу высшей цели',
    'Благословение на устах',
    'Терпение и смирение',
    'Милость свыше',
    'Даже во тьме есть свет',
  ],
  'Наёмник': [
    'За правильную цену',
    'Война — моя профессия',
    'Товарищи важнее золота',
    'Выживший рассказывает',
    'Клинок в наём',
    'Деньги вперёд',
    'Битва — моё призвание',
    'Живём сегодня, платят завтра',
    'Честь — роскошь для богатых',
    'Не спрашивай, просто плати',
    'Сталь не лжёт',
    'Война кормит',
  ],
};

const REGIONS = [
  'северных земель',
  'южных королевств',
  'восточных пустошей',
  'западных островов',
  'горных крепостей',
  'лесных деревень',
  'морских портов',
  'столицы',
];

// ── Helpers ──────────────────────────────────────────────────
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Generate a name from a syllable table.
 * For complexity=2: picks prefix+suffix twice and joins them.
 */
function generateSyllableName(
  table: SyllableTable,
  gender: NPCGender,
  kind: 'first' | 'last',
): string {
  if (kind === 'first') {
    const prefixes = gender === 'male' ? table.firstPrefixMale : table.firstPrefixFemale;
    const suffixes = gender === 'male' ? table.firstSuffixMale : table.firstSuffixFemale;
    const complexity = table.firstComplexity ?? 1;

    if (prefixes.length === 0 || suffixes.length === 0) {
      // Fallback to Russian
      return pick(gender === 'male' ? FIRST_NAMES_MALE : FIRST_NAMES_FEMALE);
    }

    if (complexity === 2) {
      return capitalize(pick(prefixes) + pick(suffixes) + pick(prefixes) + pick(suffixes));
    }
    return capitalize(pick(prefixes) + pick(suffixes));
  }

  // Last name
  const prefixes = table.lastPrefix;
  const suffixes = table.lastSuffix;
  const complexity = table.lastComplexity ?? 1;

  if (prefixes.length === 0 || suffixes.length === 0) {
    return pick(gender === 'male' ? LAST_NAMES_MALE : LAST_NAMES_FEMALE);
  }

  if (complexity === 2) {
    return capitalize(pick(prefixes) + pick(suffixes) + pick(prefixes) + pick(suffixes));
  }
  return capitalize(pick(prefixes) + pick(suffixes));
}

/**
 * Generate a full name based on the selected name preset.
 */
function generateName(preset: NamePreset, gender: NPCGender): string {
  if (preset === 'russian') {
    const first = pick(gender === 'male' ? FIRST_NAMES_MALE : FIRST_NAMES_FEMALE);
    const last = pick(gender === 'male' ? LAST_NAMES_MALE : LAST_NAMES_FEMALE);
    return `${first} ${last}`;
  }

  const table = SYLLABLE_TABLES[preset];
  const first = generateSyllableName(table, gender, 'first');
  const last = generateSyllableName(table, gender, 'last');
  return `${first} ${last}`;
}

// ── Generator ────────────────────────────────────────────────

/**
 * Generate a complete random NPC.
 * Pass `options.archetype` and/or `options.gender` to pin them;
 * leave undefined for random selection.
 */
export function generateNPC(options?: GenerateNPCOptions): GeneratedNPC {
  const gender: NPCGender =
    options?.gender ?? (Math.random() < 0.5 ? 'male' : 'female');

  const namePreset: NamePreset = options?.namePreset ?? 'russian';
  const name = generateName(namePreset, gender);

  const archetype =
    NPC_ARCHETYPES.find((a) => a.name === options?.archetype) ??
    pick(NPC_ARCHETYPES);

  const region = pick(REGIONS);
  const concept = archetype.concept.replace('{region}', region);

  // Pick aspects from the pool (random without replacement) for variety
  const pool = ASPECT_POOLS[archetype.name];
  let aspects: string[];
  if (pool && pool.length > 0) {
    // Shuffle and take 3
    const shuffled = [...pool].sort(() => Math.random() - 0.5);
    aspects = shuffled.slice(0, 3);
  } else {
    aspects = [...archetype.aspects];
  }

  // Build the FULL skill list: every adventure base skill is present (0 if
  // the archetype doesn't level it), plus any archetype-only skills. This
  // ensures NPCs can be selected for ANY skill in opposed rolls / checks —
  // previously only leveled skills were stored, which blocked VS rolls.
  const skillMap = new Map<string, number>();
  for (const baseName of DEFAULT_SETTINGS.baseSkills) {
    skillMap.set(baseName, 0);
  }
  for (const [skillName, value] of Object.entries(archetype.skills)) {
    skillMap.set(skillName, value);
  }
  const skills = Array.from(skillMap.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);

  // NPCs share the standard 3 / 3 fate-point / refresh economy.
  const refresh = 3;
  const fatePoints = 3;

  return {
    name,
    type: 'npc',
    concept,
    aspects,
    skills,
    fatePoints,
    refresh,
    archetype: archetype.name,
    gender,
  };
}

/**
 * Generate multiple NPCs at once.
 */
export function generateMultipleNPCs(
  count: number,
  options?: GenerateNPCOptions,
): GeneratedNPC[] {
  const result: GeneratedNPC[] = [];
  for (let i = 0; i < count; i++) {
    result.push(generateNPC(options));
  }
  return result;
}
