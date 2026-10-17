// ============================================================
// dice-2d-physics.ts — лёгкий 2D-движок для бросков Fudge-кубиков
// ============================================================
//
// Полный аналог 3D-физики (physics-service на Rapier3D), но полностью
// локальный в браузере: гравитации нет (вид сверху / top-down), кости
// «катятся» по плоской карте — отскакивают от невидимых стен, трение
// их останавливает. Во время качения символ на грани мелькает
// (＋ / − / ○) — это и есть «кувыркание». При остановке символ
// фиксируется и становится результатом броска.
//
// Преимущества 2D-режима:
//   • Нулевая задержка (нет socket.io round-trip к physics-service).
//   • Не требует WebGL / Three.js / внешнего мини-сервиса.
//   • Работает на старых ноутбуках / слабых GPU.
//   • Тот же UX, что и 3D: drag-бросок, button-бросок, возврат в кейс.
//
// Архитектурно — чистые функции: step(state, dt, bounds) → state.
// Состояние хранит caller (Dice2DCanvas через useRef). Рендер —
// абсолютно-позиционированные div-плитки поверх карты.

export type FudgeFace = 1 | 0 | -1;

// ── Seeded PRNG (mulberry32) ───────────────────────────────────────────────
// Используется для ДЕТЕРМИНИРОВАННОГО реплея 2D-физики на remote-клиентах.
// Когда GM бросает кубы, генерируется seed → передаётся в pending2DPhysics.
// Каждый peer создаёт PRNG с тем же seed → та же последовательность случайных
// чисел → те же позиции/грани/скорости → анимация синхронизирована.
//
// mulberry32: быстрый, детерминированный, good-enough quality для игры.
// Возвращает функцию () => number в диапазоне [0, 1).
export type RngFn = () => number;

export function createRng(seed: number): RngFn {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Глобальный Math.random fallback (для backwards-compat — когда seed не задан).
const mathRng: RngFn = () => Math.random();

export interface Die2DState {
  /** Индекс кости (0-3 для single, 0-7 для VS). */
  i: number;
  /** Позиция на карте в px (0,0 = верх-лево карты). */
  x: number;
  y: number;
  /** Скорость в px/с. */
  vx: number;
  vy: number;
  /** Наклон плитки в рад (визуальный «кувырок»). */
  rotation: number;
  /** Угловая скорость в рад/с (затухает). */
  spin: number;
  /** Видимая грань (＋=1, −=-1, ○=0). */
  face: FudgeFace;
  /** Кувыркается ли (меняет face пока скорость > порога). */
  tumbling: boolean;
  /** Таймер ниже порога скорости (мс). */
  settleTimer: number;
  /** Зафиксирована ли (результат броска). */
  settled: boolean;
  /** Прозрачность (1 во время полёта, 0 при return-to-case fade). */
  alpha: number;
  /** Аккумулятор смены грани (с). */
  tumbleAccum: number;
  /** Пресет броска (gentle/normal/power/lob/scatter). */
  presetId: string;
}

export interface Die2DTransform {
  i: number;
  x: number;
  y: number;
  rotation: number;
  face: FudgeFace;
  tumbling: boolean;
  settled: boolean;
  alpha: number;
}

export interface Snapshot2DFrame {
  t: number;
  dice: Die2DTransform[];
}

export interface Physics2DBounds {
  w: number;
  h: number;
}

// ── Пресеты броска (зеркало 3D physics-service пресетов) ────────────────
// Каждый пресет определяет:
//   • speedMul — множитель к скорости из gesture (gentle = медленно, power = быстро)
//   • friction — трение каждый кадр (1 = нет трения, 0.95 = сильное)
//   • spinMul — множитель к угловой скорости (визуальный «кувырок»)
//   • settleThreshold — порог скорости (px/с) ниже которого начинается settle-таймер
//   • settleDelay — сколько мс ниже порога до фиксации
//   • tumbleInterval — как часто (с) меняется face во время качения
//   • spread — разброс стартовых направлений (рад, для «веера»)
export interface Preset2D {
  speedMul: number;
  friction: number;
  spinMul: number;
  settleThreshold: number;
  settleDelay: number;
  tumbleInterval: number;
  spread: number;
}

export const PRESETS_2D: Record<string, Preset2D> = {
  // Мягкий бросок — кубы падают рядом, быстро останавливаются.
  gentle: {
    speedMul: 0.45,
    friction: 0.90,
    spinMul: 0.6,
    settleThreshold: 35,
    settleDelay: 100,
    tumbleInterval: 0.09,
    spread: 0.55,
  },
  // Обычный бросок — средняя дистанция, умеренное качение.
  normal: {
    speedMul: 0.75,
    friction: 0.93,
    spinMul: 1.0,
    settleThreshold: 28,
    settleDelay: 120,
    tumbleInterval: 0.08,
    spread: 0.70,
  },
  // Силовой бросок — кубы летят далеко, дольше кувыркаются.
  power: {
    speedMul: 1.35,
    friction: 0.95,
    spinMul: 1.6,
    settleThreshold: 22,
    settleDelay: 150,
    tumbleInterval: 0.07,
    spread: 0.90,
  },
  // Навес — медленно, но дольше кувыркается (имитация подброса).
  lob: {
    speedMul: 0.6,
    friction: 0.94,
    spinMul: 1.2,
    settleThreshold: 30,
    settleDelay: 180,
    tumbleInterval: 0.06,
    spread: 0.60,
  },
  // Веер — боковой разброс (для жест-броска вбок).
  scatter: {
    speedMul: 0.9,
    friction: 0.93,
    spinMul: 1.4,
    settleThreshold: 25,
    settleDelay: 140,
    tumbleInterval: 0.075,
    spread: 1.20,
  },
};

export function getPreset2D(id?: string): Preset2D {
  if (id && PRESETS_2D[id]) return PRESETS_2D[id];
  return PRESETS_2D.normal;
}

// Размер кости в px (используется для отскоков от границ).
export const DIE_SIZE_2D = 56;
const DIE_MARGIN = DIE_SIZE_2D / 2 + 4;

const FACES: FudgeFace[] = [1, 0, -1];

function randFace(rng: RngFn = mathRng): FudgeFace {
  return FACES[Math.floor(rng() * 3)];
}

// ── Спавн кубиков ────────────────────────────────────────────────────────

export interface Spawn2DOpts {
  /** Стартовая позиция на карте в px (центр стакана). */
  spawnX: number;
  spawnY: number;
  /** Направление полёта в рад (0=вправо, π/2=вниз, screen-coords). */
  direction: number;
  /** Базовая скорость в px/с (масштабируется пресетом). */
  speed: number;
  /** Пресет броска. */
  presetId?: string;
  /** Количество кубиков (по умолчанию 4). */
  count?: number;
  /** Стартовый индекс (для multi-session: session[i] → i*4). */
  baseIndex?: number;
  /** Начальные грани (из drag-контроллера — бесшовный handoff).
   *  Если заданы — НЕ кувыркаются первые ~100мс (кубы уже «трясли» в руке). */
  initialFaces?: FudgeFace[];
  /** Начальные позиции (для бесшовного handoff из drag-контроллера). */
  initialPositions?: Array<{ x: number; y: number }>;
  /** Начальные скорости (для бесшовного handoff). */
  initialVelocities?: Array<{ vx: number; vy: number }>;
  /** PRNG для детерминированного реплея (seeded). Если не задан — Math.random. */
  rng?: RngFn;
}

export function spawnDice2D(opts: Spawn2DOpts): Die2DState[] {
  const presetId = opts.presetId ?? 'normal';
  const preset = getPreset2D(presetId);
  const count = opts.count ?? 4;
  const baseIndex = opts.baseIndex ?? 0;
  const baseSpeed = opts.speed * preset.speedMul;
  const useInitial = !!(opts.initialFaces && opts.initialFaces.length >= count);
  const rng = opts.rng ?? mathRng;

  const dice: Die2DState[] = [];
  for (let k = 0; k < count; k++) {
    // Лёгкий разброс по направлению (веер) — каждый куб летит чуть в свою сторону.
    const spreadRad = (rng() - 0.5) * preset.spread;
    const dir = opts.direction + spreadRad;
    // Лёгкий разброс по скорости (±10%).
    const speed = baseSpeed * (0.9 + rng() * 0.2);

    // Стартовая позиция: либо из initialPositions (drag-handoff), либо вокруг спавна.
    let x = opts.spawnX;
    let y = opts.spawnY;
    if (opts.initialPositions && opts.initialPositions[k]) {
      x = opts.initialPositions[k].x;
      y = opts.initialPositions[k].y;
    } else {
      // Смещение вокруг центра стакана — кубы распределены по кругу,
      // каждый со своим углом. Радиус достаточно большой, чтобы кубы
      // НЕ перекрывались при спавне (radius > DIE_SIZE_2D / sqrt(2)
      // гарантирует что соседние кубы на расстоянии > DIE_SIZE_2D).
      // Раньше было ±14px — кубы начинались в одной точке и collision
      // detection не успевала их растолкнуть.
      const angle = (k / count) * Math.PI * 2 + rng() * 0.25;
      const radius = DIE_SIZE_2D * 0.85 + rng() * 6;
      x += Math.cos(angle) * radius;
      y += Math.sin(angle) * radius;
    }

    // Скорость: либо из initialVelocities (drag-handoff), либо из direction+speed.
    let vx: number;
    let vy: number;
    if (opts.initialVelocities && opts.initialVelocities[k]) {
      // ── Drag-handoff: бесшовный бросок из drag-контроллера ──
      // Раньше: initialVelocities использовались КАК ЕСТЬ (raw cursor velocity).
      //   Проблема: если курсор замедлился перед отпусканием (или игрок
      //   остановился на мгновение), velocity ≈ 0 → кубы не летят («нет
      //   импульса броска»). Все 4 куба получали ОДИНАКОВУЮ скорость →
      //   летели кучей без разброса.
      //
      //   Фикс: BLEND cursor velocity + base velocity (direction × preset speed).
      //   • base (75%) — НАПРАВЛЕНИЕ броска из gesture-вектора (куда махнул).
      //     Доминирует: пользователь ожидает что кубы летят ПО НАПРАВЛЕНИЮ
      //     жеста, а не по instantaneous cursor velocity (которая может
      //     дрожать/искривляться в последний момент).
      //   • cursor (25%) — добавляет «рукопожатие»: быстрый flick → кубы
      //     летят быстрее, медленный отпуск → base доминирует.
      //
      //   v3k: было 60/40 — cursor доминировал при быстром flick, и если
      //   cursor direction слегка отличался от gesture direction (пользователь
      //   махнул вправо, но в последний момент чуть сдвинул курсор вверх) —
      //   кубы летели ВВЕРХ-ВПРАВО вместо ВПРАВО. 75/25 фиксит это: gesture
      //   direction (из overall drag vector) — более стабильный сигнал.
      const cvx = opts.initialVelocities[k].vx;
      const cvy = opts.initialVelocities[k].vy;
      const baseVx = Math.cos(dir) * speed;
      const baseVy = Math.sin(dir) * speed;
      vx = baseVx * 0.75 + cvx * 0.25;
      vy = baseVy * 0.75 + cvy * 0.25;
      // ── Radial kick для drag-throws — МИНИМАЛЬНЫЙ (12%) ──
      // v3k: было 35% — СЛИШКОМ СИЛЬНО для drag-throws. Кубы в руке уже
      // разложены 2×2 (±18px от центра). 35% radial kick добавлял ~945px/s
      // боковой скорости (при base 2700px/s) → куб TL летел ВВЕРХ-ВПРАВО
      // вместо ВПРАВО, куб BL — ВНИЗ-ВПРАВО. Пользователь видел "кубы летят
      // не туда" (4 куба разлетаются крестом вместо того чтобы лететь вместе).
      //
      // 12% — достаточно чтобы кубы НЕ перекрывались в полёте (минимальный
      // diverging kick), но НЕ уводит их сильно от направления жеста.
      // Для button-throw (без initialVelocities) остаётся 35% — там кубы
      // спавнятся из одной точки и НУЖЕН сильный radial kick для разлёта.
      const radialKick = speed * 0.12;
      let radialAng: number;
      if (opts.initialPositions && opts.initialPositions[k]) {
        const rdx = opts.initialPositions[k].x - opts.spawnX;
        const rdy = opts.initialPositions[k].y - opts.spawnY;
        const rlen = Math.hypot(rdx, rdy);
        if (rlen > 0.1) {
          radialAng = Math.atan2(rdy, rdx);
        } else {
          // Куб точно в центре — fallback на компасный угол.
          radialAng = (k / count) * Math.PI * 2;
        }
      } else {
        radialAng = (k / count) * Math.PI * 2;
      }
      vx += Math.cos(radialAng) * radialKick;
      vy += Math.sin(radialAng) * radialKick;
    } else {
      // Базовая скорость по направлению броска.
      const baseVx = Math.cos(dir) * speed;
      const baseVy = Math.sin(dir) * speed;
      // Радиальная компонента — каждый куб получает velocity НАРУЖУ от
      // центра стакана (вдоль своего spawn-угла). Это гарантирует, что
      // кубы расходятся с самого первого кадра. Без этого кубы с
      // одинаковой forward-velocity остаются перекрытыми (collision
      // detection не успевает — они двигаются параллельно).
      // 35% от base speed — заметный, но не доминирующий radial kick.
      const radialKick = speed * 0.35;
      const spawnAngle = (k / count) * Math.PI * 2;
      vx = baseVx + Math.cos(spawnAngle) * radialKick;
      vy = baseVy + Math.sin(spawnAngle) * radialKick;
    }

    // Грань: либо из initialFaces (drag-handoff), либо случайная.
    const face = useInitial && opts.initialFaces![k] !== undefined
      ? opts.initialFaces![k]
      : randFace(rng);

    // Угловая скорость: пропорциональна скорости (быстрее катится = быстрее крутится).
    const spin = (rng() < 0.5 ? -1 : 1) * (2 + speed * 0.01) * preset.spinMul;
    // Стартовый наклон — случайный.
    const rotation = rng() * Math.PI * 2;

    dice.push({
      i: baseIndex + k,
      x,
      y,
      vx,
      vy,
      rotation,
      spin,
      face,
      // Если есть initialFaces — кубы УЖЕ кувыркались в руке. Всё равно
      // продолжаем кувыркание в полёте (физика). Они остановятся по трению.
      tumbling: true,
      settleTimer: 0,
      settled: false,
      alpha: 1,
      tumbleAccum: 0,
      presetId,
    });
  }
  return dice;
}

// ── Шаг физики (dt в секундах) ───────────────────────────────────────────

export function stepDie2D(d: Die2DState, dt: number, bounds: Physics2DBounds, rng: RngFn = mathRng): Die2DState {
  if (d.settled) {
    // Замороженная кость — только alpha может менётся (return-to-case fade).
    return d;
  }

  let { x, y, vx, vy, rotation, spin, face, tumbling, settleTimer, alpha, tumbleAccum, settled } = d;
  const preset = getPreset2D(d.presetId);

  // Движение.
  x += vx * dt;
  y += vy * dt;

  // Отскоки от границ карты (с запасом под размер кости).
  if (x < DIE_MARGIN) {
    x = DIE_MARGIN;
    vx = -vx * 0.55;
    spin *= 0.8;
  } else if (x > bounds.w - DIE_MARGIN) {
    x = bounds.w - DIE_MARGIN;
    vx = -vx * 0.55;
    spin *= 0.8;
  }
  if (y < DIE_MARGIN) {
    y = DIE_MARGIN;
    vy = -vy * 0.55;
    spin *= 0.8;
  } else if (y > bounds.h - DIE_MARGIN) {
    y = bounds.h - DIE_MARGIN;
    vy = -vy * 0.55;
    spin *= 0.8;
  }

  // Трение.
  vx *= preset.friction;
  vy *= preset.friction;

  // Вращение (затухает).
  rotation += spin * dt;
  spin *= 0.96;

  // Кувыркание: меняем face периодически пока скорость > порога.
  const speed = Math.hypot(vx, vy);
  if (tumbling) {
    if (speed > preset.settleThreshold) {
      tumbleAccum += dt;
      if (tumbleAccum >= preset.tumbleInterval) {
        tumbleAccum = 0;
        face = randFace(rng);
      }
      settleTimer = 0;
    } else {
      settleTimer += dt * 1000;
      if (settleTimer >= preset.settleDelay) {
        tumbling = false;
        settled = true;
        // face остаётся каким был — это результат броска.
      }
    }
  }

  return {
    ...d,
    x,
    y,
    vx,
    vy,
    rotation,
    spin,
    face,
    tumbling,
    settleTimer,
    alpha,
    tumbleAccum,
    settled,
  };
}

// ── Коллизии между кубиками ──────────────────────────────────────────────
// Проблема: без коллизий кубики имеют тенденцию сваливаться в одну кучу
// (особенно при броске из одной точки). Это выглядит неестественно и
// закрывает символы друг друга.
//
// Решение: после шага физики для всех кубиков вызываем resolveDiceCollisions.
// Для каждой пары (i, j) проверяем дистанцию между центрами. Если она
// меньше minDist (DIE_SIZE_2D × 0.92 — лёгкое перекрытие допустимо для
// естественности), раздвигаем кубики вдоль нормали и применяем упругое
// столкновение (коэффициент восстановления ~0.45 — не идеально упругое,
// энергия теряется).
//
// Сложность: O(n²). Для 4 кубиков = 6 пар — пренебрежимо. Для 8 (VS) = 28 пар
// — тоже быстро. Не оптимизируем.
//
// ВАЖНО: settled кубики тоже участвуют в коллизиях (как препятствия) —
// движущийся куб отскакивает от зафиксированного. Это prevents "наезд"
// нового броска на старые кубы. Но settled кубы не двигаются (они
// "приклеены" к столу).

// Минимальная дистанция между центрами кубиков (px). Равна DIE_SIZE_2D —
// кубы могут касаться рёбрами, но НЕ перекрываться. Раньше было 0.94×
// (допускало 6% перекрытия) — визуально кубы "наползали" друг на друга.
// С строго DIE_SIZE_2D между кубами всегда есть чёткая граница (касание).
const COLLISION_MIN_DIST = DIE_SIZE_2D;
// Коэффициент восстановления (restitution). 0 = абсолютно неупругое
// (кубы слипаются), 1 = абсолютно упругое (кубы разлетаются с той же
// скоростью). 0.55 — заметный отскок, но энергия теряется.
const COLLISION_RESTITUTION = 0.55;
// Доля импульса, передаваемая в spin (вращение). 0.18 — заметный spin
// при касании, делает коллизию "живой" (куб крутится от удара).
const COLLISION_SPIN_TRANSFER = 0.18;
// Минимальный разделительный импульс (px/с) — применяется даже если
// кубы не сближаются (velAlongNormal ≈ 0), но перекрыты. Без этого
// кубы, летящие параллельно с одинаковой скоростью, оставались бы
// перекрытыми forever — positional correction раздвигает их, но
// на следующем кадре они снова сходятся. Разделительный импульс
// даёт им небольшую diverging velocity вдоль нормали.
const COLLISION_SEPARATION_KICK = 80;

export function resolveDiceCollisions(dice: Die2DState[], rng: RngFn = mathRng): Die2DState[] {
  if (dice.length < 2) return dice;

  // Много итераций для стабильности. При множественных перекрытиях
  // (3+ куба в куче) парные разрешения конфликтуют — pair (0,1) толкает
  // их apart, но pair (1,2) толкает die 1 обратно к die 0. 8 итераций
  // достаточно чтобы收敛 к стабильному разделению.
  const ITERATIONS = 8;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < dice.length; i++) {
      for (let j = i + 1; j < dice.length; j++) {
        const a = dice[i];
        const b = dice[j];

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distSq = dx * dx + dy * dy;
        const minDist = COLLISION_MIN_DIST;

        // Быстрый reject (squared distance).
        if (distSq >= minDist * minDist) continue;
        // Если оба settled — пропускаем (нечего раздвигать, оба приклеены).
        // Post-settle separation в ServerDiceStage2D обрабатывает этот случай.
        if (a.settled && b.settled) continue;

        const dist = Math.sqrt(distSq);
        // Защита от деления на 0 (кубы точно в одной точке — редкость,
        // но возможна при спавне). Берём случайное направление.
        let nx: number, ny: number;
        if (dist < 0.001) {
          const angle = rng() * Math.PI * 2;
          nx = Math.cos(angle);
          ny = Math.sin(angle);
        } else {
          nx = dx / dist;
          ny = dy / dist;
        }

        // Глубина перекрытия.
        const overlap = minDist - dist;

        // ── Позиционная коррекция ──
        // Усиливаем коррекцию: 1.2× overlap вместо 1.0× — кубы раздвигаются
        // чуть сильнее, компенсируя re-overlap на следующем кадре из-за
        // forward velocity. Без этого кубы "дрейфуют" обратно друг к другу.
        const correctionFactor = 1.2;
        if (a.settled) {
          dice[j] = { ...b, x: b.x + nx * overlap * correctionFactor, y: b.y + ny * overlap * correctionFactor };
        } else if (b.settled) {
          dice[i] = { ...a, x: a.x - nx * overlap * correctionFactor, y: a.y - ny * overlap * correctionFactor };
        } else {
          const half = (overlap * correctionFactor) / 2;
          dice[i] = { ...a, x: a.x - nx * half, y: a.y - ny * half };
          dice[j] = { ...b, x: b.x + nx * half, y: b.y + ny * half };
        }

        // ── Импульсная коррекция скоростей ──
        const aCur = dice[i];
        const bCur = dice[j];

        // Относительная скорость b относительно a.
        const rvx = bCur.vx - aCur.vx;
        const rvy = bCur.vy - aCur.vy;
        // Проекция на нормаль (nx, ny направлен от a к b).
        const velAlongNormal = rvx * nx + rvy * ny;

        // Применяем импульс если:
        // 1. Кубы сближаются (velAlongNormal < 0) — стандартный отскок.
        // 2. Кубы перекрыты, но движутся параллельно (|velAlongNormal| < 10) —
        //    даём разделительный "пинок" вдоль нормали.
        const isApproaching = velAlongNormal < -10;
        const isParallelOverlap = Math.abs(velAlongNormal) <= 10;

        if (isApproaching || isParallelOverlap) {
          const bounceImpulse = isApproaching
            ? -(1 + COLLISION_RESTITUTION) * velAlongNormal / 2
            : 0;
          // Разделительный "пинок" — пропорционален depth overlap.
          // Сильнее при глубоком перекрытии. Растёт с итерацией —
          // если кубы не разделились за первые итерации, пинаем сильнее.
          const kickMagnitude = COLLISION_SEPARATION_KICK * (overlap / DIE_SIZE_2D) * ((iter + 1) / ITERATIONS);
          const separationKick = overlap > 2 ? kickMagnitude : 0;
          const totalImpulse = bounceImpulse + separationKick;

          if (aCur.settled) {
            dice[j] = {
              ...bCur,
              vx: bCur.vx + (totalImpulse) * nx,
              vy: bCur.vy + (totalImpulse) * ny,
              spin: bCur.spin + (nx * bCur.vy - ny * bCur.vx) * COLLISION_SPIN_TRANSFER,
            };
          } else if (bCur.settled) {
            dice[i] = {
              ...aCur,
              vx: aCur.vx - (totalImpulse) * nx,
              vy: aCur.vy - (totalImpulse) * ny,
              spin: aCur.spin - (nx * aCur.vy - ny * aCur.vx) * COLLISION_SPIN_TRANSFER,
            };
          } else {
            dice[i] = {
              ...aCur,
              vx: aCur.vx - (totalImpulse) * nx,
              vy: aCur.vy - (totalImpulse) * ny,
              spin: aCur.spin - (nx * aCur.vy - ny * aCur.vx) * COLLISION_SPIN_TRANSFER,
            };
            dice[j] = {
              ...bCur,
              vx: bCur.vx + (totalImpulse) * nx,
              vy: bCur.vy + (totalImpulse) * ny,
              spin: bCur.spin + (nx * bCur.vy - ny * bCur.vx) * COLLISION_SPIN_TRANSFER,
            };
          }

          // Пробуждаем кувыркание если куб был почти settled.
          const aFinal = dice[i];
          const bFinal = dice[j];
          if (!aFinal.settled && aFinal.tumbling === false) {
            dice[i] = { ...aFinal, tumbling: true, settleTimer: 0 };
          }
          if (!bFinal.settled && bFinal.tumbling === false) {
            dice[j] = { ...bFinal, tumbling: true, settleTimer: 0 };
          }
          // Если settled куб получил сильный удар — разблокируем.
          if (aFinal.settled) {
            const speed = Math.hypot(dice[i].vx, dice[i].vy);
            if (speed > 60) {
              dice[i] = { ...dice[i], settled: false, tumbling: true, settleTimer: 0 };
            }
          }
          if (bFinal.settled) {
            const speed = Math.hypot(dice[j].vx, dice[j].vy);
            if (speed > 60) {
              dice[j] = { ...dice[j], settled: false, tumbling: true, settleTimer: 0 };
            }
          }
        }
      }
    }
  }

  return dice;
}

// ── Конвертация RollGesture → 2D-параметры ───────────────────────────────
// RollGesture хранит spawnX/spawnZ в физ. единицах (центр арены = 0,0).
// Для 2D нужны пиксели относительно карты (0,0 = верх-лево).

export function physToPx(
  phys: number,
  mapSize: number,
  arenaHalf: number,
): number {
  // phys ∈ [-arenaHalf, +arenaHalf] → px ∈ [0, mapSize]
  return mapSize / 2 + (phys / arenaHalf) * (mapSize / 2);
}

// ── Проверка «все кубики зафиксированы» ──────────────────────────────────

export function allSettled(dice: Die2DState[]): boolean {
  return dice.length > 0 && dice.every((d) => d.settled);
}

// ── Снятие результатов (faces) ────────────────────────────────────────────

export function getFaces(dice: Die2DState[]): FudgeFace[] {
  return dice.map((d) => d.face);
}

// ── Конвертация состояния → трансформы для рендера ────────────────────────

export function toTransforms(dice: Die2DState[]): Die2DTransform[] {
  return dice.map((d) => ({
    i: d.i,
    x: d.x,
    y: d.y,
    rotation: d.rotation,
    face: d.face,
    tumbling: d.tumbling,
    settled: d.settled,
    alpha: d.alpha,
  }));
}
