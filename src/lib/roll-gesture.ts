// ============================================================
// roll-gesture.ts — вычисление параметров броска из drag-жеста
// ============================================================
//
// Когда игрок тащит кубы из кейса (DiceStation) на центральную карту
// (GameCanvas) и отпускает — мы вычисляем параметры броска из ВЕКТОРА
// ДВИЖЕНИЯ в момент отпускания (а не из позиции drop'а):
//
//   • originSide: 'near' (ближний край, +Z) или 'far' (дальний, -Z)
//     Логика "куда махнул — туда и полетят":
//       dy < 0 (махнул ВВЕРХ) → 'near' (кубы появятся снизу, полетят ВПЕРЁД)
//       dy > 0 (махнул ВНИЗ)  → 'far'  (кубы появятся сверху, полетят НА ИГРОКА)
//     Это даёт интуитивное ощущение "направил руку — туда кубы и улетели".
//
//   • originX: латеральный офсет точки спавна стакана (в физ. единицах).
//     Берётся из боковой компоненты вектора движения (dx):
//       махнул вправо → originX > 0 (стакан появляется правее центра)
//       махнул влево   → originX < 0 (стакан появляется левее центра)
//     Масштаб ±2.5 физ. единиц.
//
//   • swingVelocity: скорость взмаха в пикселях/мс (модуль вектора).
//     Вычисляется из истории позиций курсора за последние ~300мс.
//     0 = очень медленно, 2+ = очень быстро.
//
//   • presetId: пресет физики броска в physics-service.
//     В Auto-режиме:
//       • чисто боковой взмах (|dx| >> |dy|) → 'scatter' (веер вбок)
//       • иначе — мапится из velocity (gentle→normal→power)
//         'lob' (Навес) НЕ выдаётся автоматически — только вручную (UI кнопка).
//     В Manual-режиме — выбранный пользователем кнопкой в UI.
//
// Это даёт бесшовное ощущение: "берёшь кубы, и куда направил движение
// руки с кубами — туда они и полетят, когда отпустишь их".

// ─── Preset IDs (должны совпадать с THROW_PRESETS в physics-service) ──────
// Сами пресеты определены в mini-services/physics-service/index.ts (LOCKED).
// Здесь — только строковые ID + человекочитаемые метаданные для UI.
export type ThrowPresetId = 'gentle' | 'normal' | 'power' | 'lob' | 'scatter';

export interface ThrowPresetMeta {
  id: ThrowPresetId;
  /** Человекочитаемое название (RU). */
  label: string;
  /** Короткое описание для тултипа. */
  hint: string;
  /** Lucide-иконка (имя, импортируется в компоненте). */
  icon: 'feather' | 'scale' | 'zap' | 'arrow-up' | 'wind';
  /** Акцентный цвет (hex) для UI-кнопок и DragOverlay. */
  color: string;
  /** Порядок "силы" — 0=самый слабый, 4=самый мощный. Используется
   *  для auto-маппинга скорости в пресет. */
  powerRank: number;
}

/** Метаданные всех 5 пресетов (синхронизировано с THROW_PRESETS). */
export const THROW_PRESETS_META: ThrowPresetMeta[] = [
  {
    id: 'gentle',
    label: 'Мягкий',
    hint: 'Кубики почти не подлетают, мягко катятся по столу',
    icon: 'feather',
    color: '#3498db',
    powerRank: 0,
  },
  {
    id: 'normal',
    label: 'Обычный',
    hint: 'Заметная дуга, 2–3 отскока. Универсальный бросок',
    icon: 'scale',
    color: '#27ae60',
    powerRank: 1,
  },
  {
    id: 'power',
    label: 'Силовой',
    hint: 'Мощный бросок от себя. Кубики летят далеко, сильно кувыркаются',
    icon: 'zap',
    color: '#e67e22',
    powerRank: 2,
  },
  {
    id: 'lob',
    label: 'Навес',
    hint: 'Высокий подскок, кубики падают сверху вниз (как в нардах)',
    icon: 'arrow-up',
    color: '#9b59b6',
    powerRank: 3,
  },
  {
    id: 'scatter',
    label: 'Веер',
    hint: 'Большой разброс по X — кубики разлетаются в разные стороны',
    icon: 'wind',
    color: '#16a085',
    powerRank: 4,
  },
];

/** Быстрый lookup метаданных по id. */
export function getPresetMeta(id: string | undefined | null): ThrowPresetMeta {
  if (id) {
    const found = THROW_PRESETS_META.find((p) => p.id === id);
    if (found) return found;
  }
  // default — 'power' (стандартный бросок, выбранный пользователем)
  return THROW_PRESETS_META.find((p) => p.id === 'power')!;
}

// ─── Пороги скорости (px/ms) для auto-маппинга в пресет ──────────────────
// Калибровка на типичные движения мыши/пальца при drag:
//   ~0.2 px/ms  — медленный осторожный взмах (200px за 1с)
//   ~0.8 px/ms  — обычный уверенный взмах (800px за 1с)
//   ~1.5 px/ms  — сильный размах (1500px за 1с)
//   ~2.5 px/ms  — очень резкий взмах (2500px за 1с)
//
// В Auto-режиме скорость мапится в PROGRESSION силы:
//   gentle → normal → power  (и ВЫШЕ НЕ ПРЕДЕЛ — power это потолок)
//
// ВАЖНО: 'lob' (Навес) НЕ входит в auto-прогрессию!
// Раньше быстрый взмах (>= 1.5) автоматически давал 'lob' — высокий
// подскок. Но это контр-интуитивно: игрок ожидает что СИЛЬНЫЙ бросок =
// плоский мощный полёт (как 'power'), а не подбрасывание вверх. Жалоба:
// "когда пытаюсь сделать сильный бросок, всегда получается навес".
// Теперь: быстрый взмах → 'power' (плоский, быстрый, далеко). 'lob'
// доступен ТОЛЬКО вручную (кнопка пресета в UI) — для тех, кто хочет
// спец-эффект "подбросил сверху".
//
// (scatter НЕ включён в auto-прогрессию — он выдаётся только при
//  чисто боковом взмахе, см. computeRollGestureFromVector.)
const VELOCITY_THRESHOLDS = {
  gentle: 0.30,   // < 0.30 → gentle
  normal: 0.80,   // < 0.80 → normal
  // >= 0.80 → power  (СИЛЬНЫЙ бросок = плоский, НЕ навес!)
} as const;

/**
 * Мапит скорость взмаха (px/ms) в presetId.
 *
 * Прогрессия силы: чем быстрее взмах — тем "мощнее" пресет, но потолок =
 * 'power'. 'lob' (Навес) НЕ выдаётся автоматически по скорости — только
 * вручную через UI. Это чтобы сильный бросок ощущался как плоский мощный
 * полёт, а не как подбрасывание вверх.
 * scatter выдаётся только при чисто боковом взмахе (computeRollGesture*).
 *
 * @param velocity  модуль скорости в пикселях/мс
 * @returns ThrowPresetId
 */
export function velocityToPreset(velocity: number): ThrowPresetId {
  if (velocity < VELOCITY_THRESHOLDS.gentle) return 'gentle';
  if (velocity < VELOCITY_THRESHOLDS.normal) return 'normal';
  return 'power';   // >= 0.80 → power (СИЛЬНЫЙ = плоский, НЕ навес!)
}

/**
 * Нормализует скорость в 0..1 для power meter в DragOverlay.
 * 0 = очень медленно, 1 = очень быстро (>2.5 px/ms).
 */
export function normalizeVelocity(velocity: number): number {
  const MAX = 2.5;
  return Math.max(0, Math.min(1, velocity / MAX));
}

// ─── Velocity-based impulse scaling (для реалистичности броска) ──────────────
//
// Скорость взмаха (px/ms) маппится в МНОЖОЖИТЕЛЬ импульса броска. Чем быстрее
// игрок отпустил кубы — тем сильнее ГОРИЗОНТАЛЬНЫЙ импульс и кручение.
// Медленный отпуск → кубы почти не получают импульс, мягко падают
// на месте ("поставил"). Быстрый flick → кубы летят далеко и быстро ("бросил
// с размаху").
//
// ВАЖНО — ЛОГИКА ДУГИ (почему сильный бросок = ПЛОСКИЙ, а не навес):
//   Вертикальный масштаб (vy, дуга) УБЫВАЕТ с ростом скорости:
//     медленный отпуск → 0.70 (заметная дуга, кубы мягко подлетают)
//     быстрый flick    → 0.55 (плоская дуга, мощный прямой полёт)
//   Это даёт реалистичное ощущение: "сильно бросил = полетел плоско и далеко",
//   а не "сильно бросил = подбросил высоко". Подбрасывание (навес) — это
//   ДРУГОЙ тип броска, доступный только вручную (preset 'lob').
//
//   Горизонтальный и угловой масштабы РАСТУТ с ростом скорости (быстрее =
//   дальше летят и сильнее кувыркаются).
//
// Калибровка на типичные скорости drag-жеста:
//   0.0 px/ms — отпустил без движения (просто клик) → минимальный импульс
//   0.3 px/ms — осторожный медленный перенос → лёгкий импульс
//   0.8 px/ms — обычный уверенный перенос → средний импульс
//   1.5 px/ms — быстрый взмах → сильный импульс
//   2.5+ px/ms — резкий flick → почти полная сила пресета
//
// Диапазоны scale:
//   HORIZONTAL: 0.05 .. 0.95  — горизонтальный импульс (vx, vz)
//     0.05 = кубы почти на месте (медленный отпуск)
//     0.95 = почти полная сила пресета (быстрый flick)
//   VERTICAL: 0.70 .. 0.55    — вертикальный импульс (vy, дуга броска)
//     0.70 = заметная дуга при медленном отпускании (кубы подлетают)
//     0.55 = плоская дуга при быстром броске (мощный прямой полёт)
//     (УБЫВАЕТ с ростом скорости — сильный бросок = плоский, НЕ навес!)
//   ANGULAR: 0.30 .. 1.00    — кручение в полёте
//     0.30 = лёгкое кручение
//     1.00 = полное кручение пресета
//
// Формула: scale = lerp(min, max, smoothstep(0, MAX, velocity))
// smoothstep даёт плавный рост (без линейной "robotic" прогрессии).

const VELOCITY_SCALE_MAX = 2.5;  // px/ms — выше этого scale = max

// smoothstep: 0 при t<=0, 1 при t>=1, плавный S-переход между.
function smoothstep(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x * x * (3 - 2 * x);
}

/**
 * Масштаб горизонтального импульса (vx, vz) из скорости взмаха.
 * 0.05 (медленно) .. 0.95 (быстро).
 */
export function velocityToHorizontalScale(velocity: number): number {
  const t = velocity / VELOCITY_SCALE_MAX;
  return 0.05 + (0.95 - 0.05) * smoothstep(t);
}

/**
 * Масштаб вертикального импульса (vy, дуга) из скорости взмаха.
 * УБЫВАЕТ: 1.00 (медленно) → 0.80 (быстро).
 * Медленный отпуск = более высокая дуга (кубы подлетают выше), быстрый flick =
 * плоская дуга (мощный прямой полёт). Это даёт ощущение "сильно бросил = плоско",
 * а не "сильно бросил = подбросил" (навес).
 *
 * v3l: диапазон поднят с 0.70→0.55 до 1.00→0.80. Раньше при типичном drag-flick
 * (swingVelocity≈1.0) verticalScale≈0.65 → vy слишком мал для видимого отскока
 * (высота отскока 0.028 единиц = невидимо при top-down камере). Теперь 0.93 →
 * отскок 0.058 единиц (видно). Lob не возвращается: preset capped на 'power'.
 */
export function velocityToVerticalScale(velocity: number): number {
  const t = velocity / VELOCITY_SCALE_MAX;
  // УБЫВАЮЩИЙ: при t=0 → 1.00, при t=1 → 0.80. Сильный бросок = площе.
  return 1.00 + (0.80 - 1.00) * smoothstep(t);
}

/**
 * Масштаб углового кручения (angvel) из скорости взмаха.
 * 0.30 (медленно) .. 1.00 (быстро).
 */
export function velocityToAngularScale(velocity: number): number {
  const t = velocity / VELOCITY_SCALE_MAX;
  return 0.30 + (1.00 - 0.30) * smoothstep(t);
}

export interface RollGesture {
  /** 'near' = со стороны игрока (ближний край, +Z), 'far' = с противоположного.
   *  Вычисляется из НАПРАВЛЕНИЯ ЖЕСТА: махнул вверх/вправо/влево → 'near'
   *  (кубы появляются снизу, летят в сторону жеста), махнул вниз → 'far'
   *  (появляются сверху, летят вниз). */
  originSide: 'near' | 'far';
  /** Латеральный X-офсет в физ. единицах (примерно ±2.5).
   *  Вычисляется ИЗ НАПРАВЛЕНИЯ ЖЕСТА: махнул вправо → originX < 0 (стакан
   *  появляется СЛЕВА, кубы летят вправо — стакан на противоположной стороне
   *  от направления полёта). Это даёт ощущение "махнул вправо — кубы вылетели
   *  слева и полетели вправо через арену". */
  originX: number;
  /** Угол направления броска в радианах (передаётся в physics-service).
   *  Конвенция: 0 = вперёд (−Z, вглубь экрана), π/2 = вправо (+X),
   *  π = назад (+Z, на игрока), −π/2 = влево (−X).
   *  Вычисляется из вектора движения: θ = atan2(dx, −dy).
   *    dx>0, dy=0 (вправо) → π/2 ✓
   *    dx=0, dy<0 (вверх)  → 0 ✓
   *    dx=0, dy>0 (вниз)   → π ✓
   *    dx<0, dy=0 (влево)  → −π/2 ✓
   *  undefined для кнопка-броска (нет жеста → direction по умолчанию 0). */
  directionAngle?: number;
  /** Скорость взмаха в px/мс (модуль). 0 если не вычислена. */
  swingVelocity?: number;
  /** Пресет физики броска. Если undefined — caller использует default ('power')
   *  или выбранный вручную. */
  presetId?: ThrowPresetId;
  /** Направление броска для UI (стрелка в DragOverlay).
   *  Вычисляется из вектора движения в момент отпускания. */
  direction?: 'up' | 'down' | 'left' | 'right' | 'up-left' | 'up-right' | 'down-left' | 'down-right';
  /** ── Drop-позиция в screen-координатах (clientX/Y) ──
   *  Точная точка где игрок отпустил кубы на карте. Пробрасывается до
   *  Dice3DPhysicsCanvas, который позиционирует МАЛЕНЬКУЮ арену (1.5×1.0)
   *  прямо на этой точке — кубы появляются чуть ниже и падают рядом с
   *  точкой drop'а. Без этого кубы спавнятся с края большой арены (вся
   *  карта) и выглядят как "появились со стороны".
   *
   *  undefined для кнопка-броска (нет drop-точки → используется большая
   *  арена = вся карта, старое поведение). */
  dropX?: number;
  dropY?: number;
  /** ── Абсолютная позиция спавна на арене (drag-roll "token placement" mode) ──
   *  Когда оба spawnX и spawnZ заданы (в физ. единицах, центр арены = (0,0)),
   *  physics-service спавнит стакан В ЭТОЙ ТОЧКЕ арены — кубы появляются
   *  ровно под курсором. Это поведение как у размещения токена: "отпустил
   *  в точке → там и появился".
   *
   *  Вычисляется из drop-позиции (clientX/Y) и screen-прямоугольника карты:
   *    spawnX = (relX*2 - 1) * arenaHalfW   (relX = (dropX - mapLeft) / mapW)
   *    spawnZ = (relY*2 - 1) * arenaHalfH   (relY = (dropY - mapTop)  / mapH)
   *
   *  Coordinate mapping (camera at +Z, looking at -Z):
   *    screen left   → -arenaHalfW (physics -X)
   *    screen right  → +arenaHalfW (physics +X)
   *    screen top    → -arenaHalfH (physics -Z, "far")
   *    screen bottom → +arenaHalfH (physics +Z, "near" = player side)
   *
   *  undefined для кнопка-броска → physics-service использует edge-based
   *  позицию (originSide + originX). */
  spawnX?: number;
  spawnZ?: number;
  /** ── Начальные ориентации кубиков (drag-roll "in-hand rotation" mode) ──
   *  Массив кватернионов [x, y, z, w] — по одному на кубик (обычно 4 шт.).
   *  Захватываются из 3D-оверлея в момент отпускания drag — кубы вращались
   *  всё время, пока игрок их тащил, и их текущая ориентация и есть
   *  "случайная стартовая точка" для броска.
   *
   *  Когда задан, physics-service ПРОПУСКАЕТ фазу перемешивания (SHAKE) —
   *  кубы сразу получают импульс броска с этими ориентациями. Это даёт
   *  БЕСШОВНЫЙ бросок: "тащил → отпустил → кубы сразу полетели", без
   *  заметной задержки на shake-анимацию. Случайность результата
   *  обеспечивается тем, что ориентации случайны (зависят от того, сколько
   *  времени игрок их тащил).
   *
   *  undefined для кнопка-броска/VS/mass → physics-service использует
   *  фазу перемешивания (SHAKE_DURATION_MS = 120мс) со случайными
   *  стартовыми ориентациями. */
  initialQuats?: Array<[number, number, number, number]>;
  /** ── Начальные угловые скорости кубиков (Вариант A — продолжение вращения) ──
   *  Массив векторов [wx, wy, wz] (рад/с, world space) — по одному на кубик.
   *  Захватываются из постоянного DiceCanvasHost в момент отпускания drag:
   *  кубы вращались процедурно (HeldDiceController, ось+скорость), и их
   *  ТЕКУЩАЯ угловая скорость передаётся в physics-service.
   *
   *  Когда задан (вместе с initialQuats), physics-service при release
   *  использует ЭТУ угловую скорость (body.setAngvel) вместо throwSpin
   *  пресета → брошенные кубы ПРОДОЛЖАЮТ вращение удерживаемых (та же
   *  ось + скорость). Буквально "те же кубы полетели".
   *
   *  undefined для кнопка-броска/VS/mass → physics-service использует
   *  throwSpin пресета (angMin..angMax × angularScale). */
  initialAngularVelocity?: Array<[number, number, number]>;
  /** ── 2D-режим (diceMode='2d') — drag-handoff для локальной 2D-физики ──
   *  Поля зеркалируют initialQuats/initialAngularVelocity, но для 2D-плиток.
   *  Захватываются из HeldDice2DController в момент отпускания drag.
   *
   *  initialFaces — текущие грани (＋/−/○) удерживаемых 2D-плиток. Кубы
   *    кувыркались всё время drag'а — их грани и есть стартовая точка для
   *    2D-физики (бесшовный handoff).
   *  initialPositions2D — позиции плиток на карте (px, map-local).
   *  initialVelocities2D — скорости плиток (px/с, из velocity tracker).
   *
   *  undefined для кнопка-броска/VS/mass → 2D-движок использует случайные
   *  стартовые грани и spawn-позицию из spawnX/spawnZ/dropX/dropY. */
  initialFaces?: Array<1 | 0 | -1>;
  initialPositions2D?: Array<{ x: number; y: number }>;
  initialVelocities2D?: Array<{ vx: number; vy: number }>;
}

// ─── Масштаб относительной X-координаты в физ. единицы ───────────────────
// originX ±2.5 — комфортный диапазон, чтобы стакан не прилипал к стенам арены.
const ORIGIN_X_SCALE = 2.5;

// ─── Порог "бокового взмаха" — когда |dx| сильно превышает |dy| ──────────
// Если игрок ЯВНО махнул почти горизонтально (|dx| > 5 * |dy|) И дистанция
// бокового движения значительная (>120px) — это "веерный" бросок вбок,
// выбираем scatter preset. Иначе — обычная прогрессия силы.
//
// Порог строгий намеренно: кейс с кубами находится СЛЕВА от карты, поэтому
// ЛЮБОЙ обычный перенос из кейса на карту даёт dx > 0. Мы не хотим, чтобы
// каждый такой перенос становился scatter — только если игрок реально
// "махнул вбок" уже находясь над картой (быстрое горизонтальное движение
// в момент отпускания).
const LATERAL_RATIO = 5.0;
const LATERAL_MIN_DX = 120;  // px — минимальная боковая дистанция для scatter

/**
 * Определяет направление броска из знаков dx/dy для UI-индикатора.
 * Возвращает 8-направленную стрелку (up/down/left/right + диагонали).
 */
export function directionFromDelta(dx: number, dy: number): RollGesture['direction'] {
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  if (adx < 1 && ady < 1) return 'up';  // нет движения — default "вперёд"
  const horizontal = adx > ady * 1.5;
  const vertical = ady > adx * 1.5;
  const goingRight = dx > 0;
  const goingDown = dy > 0;
  if (horizontal) return goingRight ? 'right' : 'left';
  if (vertical) return goingDown ? 'down' : 'up';
  // диагональ
  if (goingRight && goingDown) return 'down-right';
  if (goingRight && !goingDown) return 'up-right';
  if (!goingRight && goingDown) return 'down-left';
  return 'up-left';
}

/**
 * Вычисляет параметры броска из ВЕКТОРА ДВИЖЕНИЯ (dx, dy).
 *
 * Это ключевая функция для жест-броска: "в какую сторону махнул — туда и
 * полетят кубы". Маппит 2D вектор движения мыши/пальца в параметры, которые
 * понимает physics-service:
 *
 *   • directionAngle: угол направления полёта (радианы).
 *       θ = atan2(dx, −dy) — угол от −Z (вперёд) по часовой стрелке.
 *       dx>0, dy=0 (махнул ВПРАВО) → θ=π/2 → кубы летят ВПРАВО (+X).
 *       dx=0, dy<0 (махнул ВВЕРХ)  → θ=0    → кубы летят ВПЕРЁД (−Z).
 *       dx=0, dy>0 (махнул ВНИЗ)   → θ=π    → кубы летят НАЗАД (+Z).
 *       dx<0, dy=0 (махнул ВЛЕВО)  → θ=−π/2 → кубы летят ВЛЕВО (−X).
 *       (диагонали дают промежуточные углы)
 *       Physics-service вращает импульс на этот угол — кубы РЕАЛЬНО летят
 *       в сторону жеста, а не просто "вперёд как всегда".
 *
 *   • originSide: сторона спавна стакана (near/far).
 *       cos(θ) >= 0 (полёт вперёд/вбок) → 'near' (ближний край, +Z = низ).
 *       cos(θ) < 0  (полёт назад)       → 'far'  (дальний край, −Z = верх).
 *       Кубы появляются с краю, противоположного направлению полёта по Z.
 *
 *   • originX: латеральный офсет стакана (противоположно полёту по X).
 *       originX = −sin(θ) × ORIGIN_X_SCALE.
 *       Махнул вправо (θ=π/2, sin=+1) → originX=−2.5 (стакан СЛЕВА, кубы
 *       летят ВПРАВО через арену). Махнул влево (θ=−π/2, sin=−1) → originX=+2.5.
 *       Махнул вверх/вниз (sin=0) → originX=0 (стакан по центру).
 *
 *   • presetId: из скорости (сила броска) + боковой мах → 'scatter' (веер).
 *
 *   • direction (UI): 8-направленная стрелка для DragOverlay.
 *
 * ВАЖНО: physics-service теперь принимает direction (угол) и ВРАЩАЕТ импульс.
 * Это даёт НАСТОЯЩЕЕ ощущение броска: "махнул вправо — кубы полетели вправо".
 *
 * @param dx  изменение X за последние ~180мс движения
 * @param dy  изменение Y за последние ~180мс движения
 * @param canvasWidth  ширина canvas (не используется для direction, но
 *                     сохранён для обратной совместимости)
 * @param velocity  модуль скорости (px/ms) — для решения о scatter preset
 * @returns RollGesture с directionAngle, originSide, originX, direction, presetId
 */
export function computeRollGestureFromVector(
  dx: number,
  dy: number,
  canvasWidth: number,
  velocity: number,
): RollGesture {
  // direction для UI-индикатора (стрелка в DragOverlay) — из вектора движения.
  const direction = directionFromDelta(dx, dy);

  // presetId: если игрок ЯВНО махнул почти горизонтально (|dx| > 5*|dy| И
  // |dx| > 120px) → 'scatter' (веерный бросок вбок). Иначе — мапим из velocity.
  // Строгий порог нужен чтобы обычный перенос из кейса (слева от карты) не
  // превращался в scatter — только реальное "махнул вбок над картой".
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const isLateralSwipe = adx > LATERAL_RATIO * ady && adx > LATERAL_MIN_DX;
  const presetId = isLateralSwipe ? 'scatter' : velocityToPreset(velocity);

  // ── directionAngle: угол направления полёта (радианы) ──
  // θ = atan2(dx, −dy) — угол от −Z (вперёд) по часовой стрелке.
  //   dx>0, dy=0 (вправо) → π/2 ✓
  //   dx=0, dy<0 (вверх)  → 0 ✓
  //   dx=0, dy>0 (вниз)   → π ✓
  //   dx<0, dy=0 (влево)  → −π/2 ✓
  // Порог MIN_DRAG_DIST: если вектор слишком короткий (< 6px) —
  // считаем что жест слабый, directionAngle=0 (вперёд, как кнопка-бросок).
  // Это избегает ложного "бокового" броска при дрожании мыши на месте.
  const MIN_DRAG_DIST = 6;
  const dragDist = Math.sqrt(dx * dx + dy * dy);
  const directionAngle = dragDist >= MIN_DRAG_DIST
    ? Math.atan2(dx, -dy)
    : 0;

  // ── originSide: сторона спавна по Z (противоположно полёту по Z) ──
  // cos(θ) >= 0 (полёт вперёд/вбок, θ ∈ [−π/2, π/2]) → 'near' (ближний край).
  // cos(θ) < 0  (полёт назад, θ ∈ (π/2, 3π/2))       → 'far'  (дальний край).
  const cosTheta = Math.cos(directionAngle);
  const originSide: 'near' | 'far' = cosTheta >= 0 ? 'near' : 'far';

  // ── originX: латеральный офсет (противоположно полёту по X) ──
  // sin(θ) > 0 (полёт вправо, θ ∈ (0, π)) → originX < 0 (стакан слева).
  // sin(θ) < 0 (полёт влево, θ ∈ (−π, 0)) → originX > 0 (стакан справа).
  // sin(θ) = 0 (полёт вперёд/назад)       → originX = 0.
  // Масштаб ORIGIN_X_SCALE (±2.5 физ. единиц) — стакан уходит к краю арены.
  const sinTheta = Math.sin(directionAngle);
  const originX = -sinTheta * ORIGIN_X_SCALE;

  // canvasWidth не используется для direction, но сохраняем в сигнатуре
  // для обратной совместимости (вдруг кто-то вызывает напрямую).
  void canvasWidth;

  return { originSide, originX, directionAngle, direction, presetId };
}

/**
 * Вычисляет originSide и originX из ПОЗИЦИИ DROP'А относительно изображения карты.
 *
 * Это даёт "отпустил здесь — здесь и появились кубы":
 *   • dropY в нижней половине карты → originSide='near' (кубы появляются снизу)
 *   • dropY в верхней половине → originSide='far' (кубы появляются сверху)
 *   • dropX правее центра → originX > 0 (стакан правее)
 *   • dropX левее центра → originX < 0 (стакан левее)
 *
 * @param dropX  clientX точки отпускания
 * @param dropY  clientY точки отпускания
 * @param mapRect  экранный прямоугольник ИЗОБРАЖЕНИЯ карты (не viewport!)
 *                 {left, top, width, height} — из getMapScreenRect()
 * @returns { originSide, originX } или null если drop вне карты
 */
export function computeOriginFromDropPosition(
  dropX: number,
  dropY: number,
  mapRect: { left: number; top: number; width: number; height: number },
): { originSide: 'near' | 'far'; originX: number } | null {
  const centerX = mapRect.left + mapRect.width / 2;
  const centerY = mapRect.top + mapRect.height / 2;

  // Проверка: drop должен быть внутри прямоугольника карты (с небольшим запасом).
  const margin = 20;
  if (dropX < mapRect.left - margin || dropX > mapRect.left + mapRect.width + margin) return null;
  if (dropY < mapRect.top - margin || dropY > mapRect.top + mapRect.height + margin) return null;

  // originSide: нижняя половина → 'near', верхняя → 'far'.
  // 'near' = +Z (ближний край, сторона игрока) → кубы летят ВПЕРЁД (−Z, вглубь).
  // 'far' = −Z (дальний край) → кубы летят НА ИГРОКА (+Z).
  const originSide: 'near' | 'far' = dropY >= centerY ? 'near' : 'far';

  // originX: относительная X-координата (−1..+1) → масштаб в физ. единицы.
  const relX = (dropX - centerX) / (mapRect.width / 2);
  const originX = Math.max(-ORIGIN_X_SCALE, Math.min(ORIGIN_X_SCALE, relX * ORIGIN_X_SCALE));

  return { originSide, originX };
}

// ─── Legacy: вычисление gesture из ПОЗИЦИИ drop'а ─────────────────────────
// ОСТАВЛЕНО для backward-compat (вдруг кто-то ещё вызывает), но БОЛЬШЕ НЕ
// ИСПОЛЬЗУЕТСЯ в RollGestureProvider — теперь gesture вычисляется из вектора
// движения (см. computeRollGestureFromVector). Старая логика "нижняя/верхняя
// половина canvas → near/far" противоречила интуиции "куда махнул — туда и
// полетят", поэтому была заменена.
/**
 * @deprecated Используйте computeRollGestureFromVector.
 */
export function computeRollGesture(
  dropX: number,
  dropY: number,
  canvasRect: { left: number; top: number; width: number; height: number },
): RollGesture {
  const centerX = canvasRect.left + canvasRect.width / 2;
  const centerY = canvasRect.top + canvasRect.height / 2;
  const originSide: 'near' | 'far' = dropY >= centerY ? 'near' : 'far';
  const relX = (dropX - centerX) / (canvasRect.width / 2);
  const originX = Math.max(-ORIGIN_X_SCALE, Math.min(ORIGIN_X_SCALE, relX * ORIGIN_X_SCALE));
  return { originSide, originX };
}

// ─── Velocity tracker (ring buffer последних N сэмплов) ───────────────────
// Хранит {x, y, t} за последние ~300мс. Скорость = distance/time между
// самым старым и самым свежим сэмплом в окне.

export interface VelocitySample {
  x: number;
  y: number;
  t: number;  // performance.now()
}

// Окно 180мс — захватывает только ФИНАЛЬНОЕ движение в момент отпускания,
// а не весь перенос из кейса на карту. Это даёт более точный вектор
// "куда махнул в последний момент" — именно он определяет направление броска.
const VELOCITY_WINDOW_MS = 180;
const VELOCITY_MAX_SAMPLES = 30;
const VELOCITY_MIN_SAMPLES = 2;  // всегда храним минимум 2, чтобы скорость можно было вычислить

/**
 * Lightweight ring buffer для трекинга скорости курсора.
 * Не класс, а функции над массивом — чтобы можно было хранить в ref.
 */
export function createVelocityTracker(): VelocitySample[] {
  return [];
}

/**
 * Добавить сэмпл в tracker. Удаляет старые (>windowMs).
 * Возвращает обновлённый массив (новый — для иммутабельности).
 */
export function pushVelocitySample(
  samples: VelocitySample[],
  x: number,
  y: number,
  now: number = performance.now(),
): VelocitySample[] {
  const next = [...samples, { x, y, t: now }];
  // обрезаем по длине
  while (next.length > VELOCITY_MAX_SAMPLES) next.shift();
  // обрезаем по времени — но оставляем минимум VELOCITY_MIN_SAMPLES,
  // чтобы скорость всегда можно было вычислить даже при редких событиях
  const cutoff = now - VELOCITY_WINDOW_MS;
  while (next.length > VELOCITY_MIN_SAMPLES && next[0].t < cutoff) next.shift();
  return next;
}

/**
 * Вычисляет скорость (px/ms) из истории сэмплов.
 * Берёт самый старый и самый свежий сэмпл в окне, считает distance/time.
 * Возвращает 0 если < 2 сэмплов или интервал < 16мс (защита от деления на 0).
 */
export function computeVelocity(samples: VelocitySample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  if (dt < 16) return 0;  // < 1 кадр — недостаточно данных
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  return dist / dt;
}

/**
 * Вычисляет ВЕКТОР ДВИЖЕНИЯ (dx, dy) из истории сэмплов.
 * Берёт самый старый и самый свежий сэмпл в окне — это даёт суммарный
 * вектор перемещения за последние ~300мс. Именно этот вектор определяет
 * направление броска ("куда махнул — туда и полетят").
 *
 * Возвращает {dx, dy, dt} или null если < 2 сэмплов.
 */
export function computeDragVector(
  samples: VelocitySample[],
): { dx: number; dy: number; dt: number } | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  if (dt < 16) return null;  // < 1 кадр — недостаточно данных
  return {
    dx: last.x - first.x,
    dy: last.y - first.y,
    dt,
  };
}

/**
 * Удобная обёртка: вычисляет gesture напрямую из history сэмплов.
 * Используется в onDragEnd RollGestureProvider.
 *
 * @param samples  ring buffer позиций курсора
 * @param canvasWidth  ширина canvas (для масштабирования originX)
 * @returns RollGesture | null (null если недостаточно данных)
 */
export function gestureFromSamples(
  samples: VelocitySample[],
  canvasWidth: number,
): RollGesture | null {
  const vec = computeDragVector(samples);
  if (!vec) return null;
  const velocity = Math.sqrt(vec.dx * vec.dx + vec.dy * vec.dy) / vec.dt;
  return computeRollGestureFromVector(vec.dx, vec.dy, canvasWidth, velocity);
}

// ─── Token-placement gesture: spawn at drop point, drag vector only for impulse ───
//
// Это НОВЫЙ подход к drag-броску: кубы появляются РОВНО В ТОЙ ТОЧКЕ, где
// курсор отпустили (как размещение токена). Вектор движения (drag) задаёт
// только НАПРАВЛЕНИЕ и СИЛУ импульса — кубы могут слегка откатиться в
// сторону жеста, но основной спавн точно под курсором.
//
// Контраст со старым подходом (computeRollGestureFromVector):
//   СТАРЫЙ: spawn на противоположном краю арены, кубы летят через арену.
//   НОВЫЙ:  spawn ПОД КУРСОРОМ, кубы лишь слегка отскакивают в сторону жеста.
//
// Эта функция — основная для drag-roll. Старая сохранена для обратной
// совместимости (используется в live preview).

/**
 * Вычисляет absolute spawn-позицию на арене из drop-позиции курсора.
 *
 * @param dropX  clientX точки отпускания
 * @param dropY  clientY точки отпускания
 * @param mapRect  экранный прямоугольник изображения карты {left, top, width, height}
 * @param arenaHalfW  половина ширины арены (физ. единицы) — из naturalWidth карты
 * @param arenaHalfH  половина высоты арены (физ. единицы) — из naturalHeight карты
 * @returns { spawnX, spawnZ } в физ. единицах (центр арены = (0,0)),
 *          или null если drop вне карты.
 */
export function computeSpawnFromDropPosition(
  dropX: number,
  dropY: number,
  mapRect: { left: number; top: number; width: number; height: number },
  arenaHalfW: number,
  arenaHalfH: number,
): { spawnX: number; spawnZ: number } | null {
  // Drop должен быть внутри прямоугольника карты (с запасом).
  const margin = 20;
  if (dropX < mapRect.left - margin || dropX > mapRect.left + mapRect.width + margin) return null;
  if (dropY < mapRect.top - margin || dropY > mapRect.top + mapRect.height + margin) return null;

  // Относительные координаты внутри карты (0..1).
  const relX = (dropX - mapRect.left) / mapRect.width;
  const relY = (dropY - mapRect.top) / mapRect.height;

  // Маппинг в физ. единицы:
  //   relX=0 (left)   → -arenaHalfW
  //   relX=1 (right)  → +arenaHalfW
  //   relY=0 (top)    → -arenaHalfH  (far, верх экрана = -Z)
  //   relY=1 (bottom) → +arenaHalfH  (near, низ экрана = +Z, сторона игрока)
  const spawnX = (relX * 2 - 1) * arenaHalfW;
  const spawnZ = (relY * 2 - 1) * arenaHalfH;

  // Safety clamp — cup must stay inside arena (with margin for cup half-size).
  // physics-service также клампит, но лучше сделать это здесь для UI-консистентности.
  const SAFE_MARGIN = 0.8;  // ~CUP_HALF_W + запас
  const clampedX = Math.max(-arenaHalfW + SAFE_MARGIN, Math.min(arenaHalfW - SAFE_MARGIN, spawnX));
  const clampedZ = Math.max(-arenaHalfH + SAFE_MARGIN, Math.min(arenaHalfH - SAFE_MARGIN, spawnZ));

  return { spawnX: clampedX, spawnZ: clampedZ };
}

/**
 * Полный gesture для drag-roll: spawn AT drop point + impulse from drag vector.
 *
 * Логика:
 *   • spawnX/spawnZ — из ПОЗИЦИИ DROP'А (где отпустил). Кубы появляются ровно
 *     под курсором — как размещение токена.
 *   • directionAngle — из ВЕКТОРА ДВИЖЕНИЯ (куда махнул). Кубы слегка
 *     отскакивают в сторону жеста. Если вектор короткий (< 6px) — direction=0
 *     (кубы просто падают на месте, без бокового импульса).
 *   • presetId — из скорости взмаха (gentle/normal/power) + scatter для
 *     чисто бокового маха. 'lob' НЕ выдаётся автоматически — только вручную.
 *   • direction (UI) — из вектора движения (стрелка в DragOverlay).
 *   • originSide/originX — вычисляются из drop-позиции (для UI live preview).
 *
 * @param dropX  clientX точки отпускания
 * @param dropY  clientY точки отпускания
 * @param mapRect  экранный прямоугольник изображения карты
 * @param arenaHalfW  половина ширины арены (физ. единицы)
 * @param arenaHalfH  половина высоты арены (физ. единицы)
 * @param dx  изменение X за последние ~180мс движения (drag vector X)
 * @param dy  изменение Y за последние ~180мс движения (drag vector Y)
 * @param velocity  модуль скорости (px/ms)
 * @returns RollGesture | null (null если drop вне карты)
 */
export function computeRollGestureFromDrop(
  dropX: number,
  dropY: number,
  mapRect: { left: number; top: number; width: number; height: number },
  arenaHalfW: number,
  arenaHalfH: number,
  dx: number,
  dy: number,
  velocity: number,
): RollGesture | null {
  // 1) Абсолютная spawn-позиция из drop-точки.
  const spawn = computeSpawnFromDropPosition(dropX, dropY, mapRect, arenaHalfW, arenaHalfH);
  if (!spawn) return null;

  // 2) originSide + originX — для UI (live preview) и fallback (если physics-service
  //    не поддерживает spawnX/spawnZ, например старая версия). Берём из drop-позиции.
  const origin = computeOriginFromDropPosition(dropX, dropY, mapRect);
  if (!origin) return null;

  // 3) direction (UI-стрелка) — из вектора движения.
  const direction = directionFromDelta(dx, dy);

  // 4) presetId — из скорости + боковой мах → scatter.
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const isLateralSwipe = adx > LATERAL_RATIO * ady && adx > LATERAL_MIN_DX;
  const presetId = isLateralSwipe ? 'scatter' : velocityToPreset(velocity);

  // 5) directionAngle — из вектора движения (для импульса physics-service).
  // Порог MIN_DRAG_DIST: короткий вектор → directionAngle=0 (без бокового
  // импульса, кубы просто падают на месте). Это для случаев "отпустил без маха".
  const MIN_DRAG_DIST = 6;
  const dragDist = Math.sqrt(dx * dx + dy * dy);
  const directionAngle = dragDist >= MIN_DRAG_DIST
    ? Math.atan2(dx, -dy)
    : 0;

  return {
    originSide: origin.originSide,
    originX: origin.originX,
    directionAngle,
    direction,
    presetId,
    dropX,
    dropY,
    spawnX: spawn.spawnX,
    spawnZ: spawn.spawnZ,
  };
}
