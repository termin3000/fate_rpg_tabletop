'use client';

// ============================================================
// dice-palette — палитра цветов кубиков + хелперы градиентов
// ============================================================
//
// 10 цветов для кастомизации кубов. Каждый цвет → 3-цветный
// диагональный градиент (top / mid / bottom) для тела куба.
// Hex основного цвета хранится в store (diceColor / symbolColor),
// градиент выводится через derivePalette(hex).
//
// Ограничение: нельзя выбрать один цвет для куба И символа.
// UI блокирует занятый цвет (disabled). Store не запрещает напрямую,
// но UI гарантирует — setDiceColor игнорирует значение === symbolColor,
// и наоборот.
//
// Используется в:
//   • Dice2DCanvas — фон 2D-плиток (DICE_FACE_BG)
//   • Dice3DCanvas + DiceCase3D — CanvasTexture тела грани
//   • DiceStation — фон статичных плиток в кейсе
//   • SettingsDialog — палитра выбора (UI)
//   • DiceFaceSvg — цвет символа (+/−) и тени

// ── Палитра 10 цветов ──────────────────────────────────────────
// id — stable идентификатор для localStorage / network-синхронизации.
// hex — основной цвет (используется для граней и в палитре UI).
// name — русское название (для UI).
//
// По умолчанию: куб = синий (#1976d2), символ = белый (#f8fafc).
export interface DiceColorOption {
  id: string;
  name: string;
  hex: string;
}

export const DICE_COLORS: DiceColorOption[] = [
  { id: 'blue',    name: 'Синий',      hex: '#1976d2' },
  { id: 'red',     name: 'Красный',    hex: '#dc2626' },
  { id: 'green',   name: 'Зелёный',    hex: '#16a34a' },
  { id: 'yellow',  name: 'Жёлтый',     hex: '#ca8a04' },
  { id: 'white',   name: 'Белый',      hex: '#f8fafc' },
  { id: 'black',   name: 'Чёрный',     hex: '#0f172a' },
  { id: 'pink',    name: 'Розовый',    hex: '#db2777' },
  { id: 'purple',  name: 'Фиолетовый', hex: '#9333ea' },
  { id: 'teal',    name: 'Бирюзовый',  hex: '#0d9488' },
  { id: 'orange',  name: 'Оранжевый',  hex: '#ea580c' },
];

// Дефолты (соответствуют классическим синим кубам с белыми символами).
export const DEFAULT_DICE_COLOR = '#1976d2';
export const DEFAULT_SYMBOL_COLOR = '#f8fafc';

// ── Цветовые утилиты ───────────────────────────────────────────

/** Конвертация HEX (#rgb / #rrggbb) → {r, g, b} в 0..255. */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) {
    h = h.split('').map((c) => c + c).join('');
  }
  const num = parseInt(h, 16);
  if (!Number.isFinite(num) || h.length !== 6) {
    return { r: 0, g: 0, b: 0 };
  }
  return {
    r: (num >> 16) & 0xff,
    g: (num >> 8) & 0xff,
    b: num & 0xff,
  };
}

/** {r,g,b} в 0..255 → HEX (#rrggbb). */
function rgbToHex(r: number, g: number, b: number): string {
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return (
    '#' +
    [cl(r), cl(g), cl(b)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  );
}

/** Конвертация RGB → HSL (h в 0..360, s и l в 0..1). */
function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rN = r / 255;
  const gN = g / 255;
  const bN = b / 255;
  const max = Math.max(rN, gN, bN);
  const min = Math.min(rN, gN, bN);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rN) h = ((gN - bN) / d) % 6;
    else if (max === gN) h = (bN - rN) / d + 2;
    else h = (rN - gN) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s, l };
}

/** HSL → RGB (0..255). */
function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp >= 0 && hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return {
    r: (r + m) * 255,
    g: (g + m) * 255,
    b: (b + m) * 255,
  };
}

/**
 * Осветлить hex на delta (0..1, положительное = светлее).
 * Сохраняет hue и saturation.
 */
export function lightenHex(hex: string, delta: number): string {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const newL = Math.max(0, Math.min(1, l + delta));
  const { r: nr, g: ng, b: nb } = hslToRgb(h, s, newL);
  return rgbToHex(nr, ng, nb);
}

/**
 * Затемнить hex на delta (0..1, положительное = темнее).
 * Эквивалент lightenHex(-delta).
 */
export function darkenHex(hex: string, delta: number): string {
  return lightenHex(hex, -delta);
}

// ── Палитра грани ──────────────────────────────────────────────
//
// Градиент для тела куба. Аналогично классическим синим кубам:
//   top    = lighten(+8%)  — освещённая грань сверху-слева
//   mid    = hex           — базовый цвет
//   bottom = darken(-12%)  — тень снизу-справа
//
// isLight = true если базовый цвет светлый (l > 0.7). UI использует
// это для подсказки: на светлых кубах лучше тёмный символ, и наоборот.
export interface DicePalette {
  top: string;
  mid: string;
  bottom: string;
  /** true если куб светлый (l > 0.7) — символ должен быть тёмным. */
  isLight: boolean;
  /** true если куб очень тёмный (l < 0.18) — тень символа должна быть светлее. */
  isVeryDark: boolean;
}

export function derivePalette(hex: string): DicePalette {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  return {
    top: lightenHex(hex, 0.08),
    mid: hex,
    bottom: darkenHex(hex, 0.12),
    isLight: l > 0.7,
    isVeryDark: l < 0.18,
  };
}

/**
 * Подобрать "хороший" цвет символа для заданного цвета куба.
 * Используется как fallback при смене diceColor, если игрок явно
 * не выбрал symbolColor. UI всегда даёт игроку выбор — это лишь
 * умное значение по умолчанию.
 *
 *   • Светлый куб → тёмный символ (#0f172a)
 *   • Тёмный куб  → светлый символ (#f8fafc)
 *   • Средний куб → белый (классика)
 */
export function suggestSymbolColor(diceHex: string): string {
  const { r, g, b } = hexToRgb(diceHex);
  const { l } = rgbToHsl(r, g, b);
  if (l > 0.6) return '#0f172a';
  return '#f8fafc';
}

/**
 * Подобрать цвет тени символа. На тёмных кубах тень должна быть
 * светлее основного цвета (для контраста), на светлых — темнее.
 */
export function suggestSymbolShadow(diceHex: string): string {
  const pal = derivePalette(diceHex);
  if (pal.isVeryDark) {
    // Тёмный куб → тёмная тень невидна. Используем тёмную версию
    // самого куба (например, чёрный куб → тень = #050a14 rgba).
    return 'rgba(0, 0, 0, 0.85)';
  }
  if (pal.isLight) {
    // Светлый куб → тёмная тень от светлого символа.
    return 'rgba(0, 0, 0, 0.45)';
  }
  // Средний / насыщенный куб → классическая тёмно-синяя тень.
  return 'rgba(0, 10, 40, 0.55)';
}

/**
 * Найти опцию в палитре по hex. Возвращает undefined, если hex не
 * входит в стандартную палитру (кастомный цвет). UI использует это
 * чтобы подсветить выбранный цвет.
 */
export function findColorOption(hex: string): DiceColorOption | undefined {
  return DICE_COLORS.find((c) => c.hex.toLowerCase() === hex.toLowerCase());
}
