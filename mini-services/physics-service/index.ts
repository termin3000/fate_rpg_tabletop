// ============================================================================
// Fate RPG VTT — Server-Authoritative Physics Service
// ====================================================
//
// Бросает Fate-кубики в настоящей 3D-физике (Rapier3D) и стримит
// трансформы всем подключённым клиентам через socket.io. Результат
// броска определяется ТОЛЬКО физикой — какая грань легла вверх, тот
// символ и виден. Никакой подмены текстур.
//
// АРХИТЕКТУРА
// -----------
//   Client → `dice:roll` → создаёт 4 rigid body в арене → launch impulse
//   Server: fixed step 1/60, accumulator, sleep detection
//   Server → `dice:transform` (30 Hz): [{i, p:[x,y,z], q:[x,y,z,w]}]
//   Server → `dice:result` (после settle): {dice:[-1..1]×4, total}
//
// СИМВОЛЫ НА ГРАНЯХ (фиксированы при создании, противоположные пары):
//   +X / -X  →  "+"  (2 грани)
//   +Y / -Y  →  "-"  (2 грани)
//   +Z / -Z  →  ""   (2 грани — пустая, = 0)
//   Распределение: P(+) = P(-) = P(0) = 1/3 ✓
//
// Порт: 3006 (Caddy route через XTransformPort=3006)
//
// ============================================================================
// ⚠️  PHYSICS IS LOCKED — НЕ ТРОГАТЬ БЕЗ ЯВНОГО УКАЗАНИЯ ПОЛЬЗОВАТЕЛЯ  ⚠️
// ============================================================================
//
// ВНИМАНИЕ: шапка файла переведена с блочного комментария (slash-star ... star-slash)
// на построчные `//`. Причина: внутри блочного комментария последовательность
// "star-slash" (например в VIRTUAL_FLOOR_xxx / GROUND_xxx, записанных через слэш)
// ПРЕЖДЕВРЕМЕННО ЗАКРЫВАЕТ комментарий, оставшийся хвост становится кодом,
// парсер падает с "Unexpected )" и сервис физики крашится на старте (crash-loop).
// Построчные `//` не имеют закрывающего маркера — уронить файл таким способом
// больше невозможно. См. инцидент 2026-08-03 в /tmp/physics.log.
//
// Параметры физики ниже (RESTITUTION, FRICTION, LINEAR_DAMPING, ANGULAR_DAMPING,
// VIRTUAL_FLOOR-семейство, GROUND_Y_DAMP_PER_STEP, GROUND_CONTACT-семейство,
// бросковые импульсы в THROW_PRESETS и т.д.) — это РЕЗУЛЬТАТ ДЛИТЕЛЬНОЙ
// НАСТРОЙКИ (v1 → v3i). Они дают живую, «настоящую» физику броска: кубики
// отскакивают 1-3 раза, скользят, катаются и замирают за ~1.5с. Пользователь
// подтвердил, что текущее поведение его устраивает.
//
// ИСТОРИЯ РЕГРЕССИЙ (НЕ ПОВТОРЯТЬ):
//   - v3g/h: «оптимизация» против spinning-top добавила GROUND_ANG_DAMP=0.92
//     каждый шаг (1/120с) → 0.92^120 ≈ 4.5e-5 за секунду → кубики замирали
//     мгновенно при контакте с полом. Жалоба: «падают как из масла».
//   - Аналогично: повышение FRICTION до 0.42 + LINEAR_DAMPING до 0.35 убивало
//     отскоки и скольжение.
//   - v3j (НАРУШЕНИЕ LOCK): cron webDevReview добавил GROUND_XZ_DAMP_PER_STEP=0.970
//     (гасил X/Z angular velocity на полу) + поднял FRICTION до 0.50 + снизил
//     angMin/angMax во всех пресетах на ~40% + EDGE_THRESHOLD 0.90→0.78.
//     Результат: кубы перестали отскакивать, «скользят над столом».
//     Жалоба: «почему опять сломалась физика? Почему кубы просто скользят
//     над столом? Сколько можно уже её ломать?»
//     ФИКС v3k: ПОЛНЫЙ ОТКАТ v3j → v3i. GROUND_XZ_DAMP_PER_STEP удалён.
//
// ⚠️⚠️⚠️  АБСОЛЮТНЫЙ ЗАПРЕТ ДЛЯ АГЕНТОВ (включая cron webDevReview):  ⚠️⚠️⚠️
//   1. НЕ МЕНЯТЬ константы физики (RESTITUTION, FRICTION, DAMPING, VIRTUAL_FLOOR, GROUND)
//   2. НЕ ДОБАВЛЯТЬ новые damping-блоки в tickSim (особенно X/Z angular damping)
//   3. НЕ «ОПТИМИЗИРОВАТЬ» бросковые пресеты (angMin/angMax, vy/vz)
//   4. НЕ МЕНЯТЬ EDGE_THRESHOLD, SETTLE_STABILITY_MS, MAX_NUDGES
//   5. ЛЮБЫЕ изменения требуют ЯВНОГО запроса пользователя: «поменяй физику так-то»
//
//   Если в логах видны force-tip / snap-rest — это НОРМАЛЬНО для редких
//   бросков на ребро, а не баг, который нужно фиксить изменением констант.
//   Любое «улучшение» физики без явного запроса = РЕГРЕССИЯ.
//
//   Тесты: см. /tmp/test-roll.mjs (прямые socket-тесты на :3006).
//   Критерий успеха: 4 кубика, 1-2 отскока каждый, settle за ~1.5с.
// ============================================================================

import { createServer } from "http";
import { Server, type Socket } from "socket.io";
import RAPIER from "@dimforge/rapier3d-compat";

const PORT = 3006;

// ---------------------------------------------------------------------------
// Константы физики
// ---------------------------------------------------------------------------

// ── SUB-STEPPING для CCD ──
// STEP=1/120 (вместо 1/60) — вдвое меньший шаг симуляции. При броске с
// vy=4.5м/с + g=-14, скорость удара о пол ~4.5м/с. За шаг 1/60 куб проходит
// 7.5см (это 1/3 стороны куба 0.44) → CCD cuboid-vs-cuboid в Rapier мог
// пропускать коллизию → куб туннелировал сквозь пол → safety net морозил
// куб после 6 ложных коррекций (куб НЕ отскакивал, а замирал).
// За шаг 1/120 куб проходит 3.75см — CCD стабильно ловит пол → реальные
// отскоки. TickSim делает 2 шага за tick (acc накапливается по ~1/60с).
// CPU нагрузка удваивается, но это допустимо (4 кубика × 30 snapshotHz).
const STEP = 1 / 120;                 // фиксированный шаг симуляции (sub-step для CCD)
// v3l: SNAPSHOT_HZ 30 → 60. При 30Hz снапшоты пропускали пики отскоков
// (bounce длится ~110ms = 3 снапшота, пик между ними). 60Hz = 6 снапшотов
// за отскок → пик ловится, рендерер интерполирует плавную дугу отскока.
// Симуляция уже на 120Hz, так что 60Hz снапшотов не нагружает CPU.
const SNAPSHOT_HZ = 60;               // частота стриминга трансформов
const SNAPSHOT_INTERVAL = 1 / SNAPSHOT_HZ;
const SETTLE_TIMEOUT_MS = 3500;       // мягкий таймаут — после 3.5с финализируем даже если кубики ещё двигаются (нормальные броски <2.2с, force-tip at 2.5с + 0.5с fall = 3с)
const SETTLE_STABILITY_MS = 220;      // 220мс стабильного покоя → уверенный settle
const MAX_SESSION_MS = 7000;          // hard limit: 7с — абсолютный потолок (раньше было 11с)
const MIN_ROLL_MS = 1200;             // минимум 1.2с броска — не читаем результат в воздухе
// ── SPINNING-IN-PLACE DETECTION ──
// ПРОБЛЕМА: кубик бросается с ω=12-20 рад/с (power preset). Если он приземляется
// на ребро/угол и начинает вращаться вокруг вертикальной оси (как волчок),
// angular damping (0.35) слишком медленно его останавливает:
//   ω(t) = ω₀ × e^(-damping×t) → при ω₀=20, damping=0.35 нужно ~14с до ω<0.3
// allSlow никогда не становится true → nudge не срабатывает (требует allSlow) →
// soft timeout не срабатывает (требует allSlow) → ждём hard timeout (7с).
// Визуально: кубик крутится 7с потом исчезает. Пользователь: "кубы просто
// вращаются бесконечно пока не пропадут".
//
// РЕШЕНИЕ: после SPINNING_DETECT_MS (2.5с) проверяем каждый кубик — если у
// него низкая линейная скорость (стоит на месте) но высокая угловая (вращается
// как волчок), применяем forceTipDie: убиваем angvel + сильный hop + сильный
// tip torque. Кубик падает на грань и быстро успокаивается.
const SPINNING_DETECT_MS = 2500;      // через 2.5с начинаем ловить spinning-in-place
// v3f: порог поднят 1.0 → 4.0. При throwSpin 14-20 и damping 0.45 остаточный
// spin к 2.5с = ~3-5 рад/с (нормальное успокоение). Порог 4.0 пропускает это,
// ловит только настоящих "волчков" (куб на ребре, ω_Y > 4).
const SPINNING_ANG_THRESHOLD = 4.0;   // |ω_Y| > 4.0 рад/с при низкой linvel = spinning-top
const SPINNING_LIN_THRESHOLD = 0.15;  // |v| < 0.15 м/с = кубик стоит на месте
// v3f: force-tip только для Y-dominant spin (настоящий волчок на ребре).
// Tumble вокруг X/Z (кувыркание при успокоении) — нормальное поведение,
// friction его останавливает. Y-spin на ребре friction почти не тормозит
// (контакт в одной точке, нет рычага) → нужен force-tip.
// Требуем |ω_Y| > 4 И |ω_Y| > |ω_XZ| × 1.5 (Y доминирует).
// Арена теперь ПРЯМОУГОЛЬНАЯ — arenaHalfW (X) и arenaHalfH (Z) устанавливаются
// per-roll из размера карты клиента. Это позволяет бортикам точно повторять
// контур карты (прямоугольное изображение → прямоугольная арена).
// Default 4.0×4.0 (квадрат 8×8) — для обратной совместимости.
const DEFAULT_ARENA_HALF = 4.0;        // дефолт для обеих сторон (квадрат)
const MIN_ARENA_HALF = 3.0;            // минимум — просторная арена для маленьких карт
const MAX_ARENA_HALF = 8.0;            // максимум — огромная карта
// ВАЖНО: стены должны быть ВЫШЕ максимальной высоты подскока кубика.
// При vy=5.6 (power preset) пик = v²/(2g) = 31.36/28 ≈ 1.12м + старт ~0.25м = ~1.37м.
// При vy=7.8 (lob preset) пик = 60.84/28 ≈ 2.17м + старт = ~2.42м.
// WALL_HEIGHT=2.6 даёт запас для lob + размер куба + случайные отскоки.
// Раньше было 1.1м → кубы перелетали стены и исчезали за границей карты.
const WALL_HEIGHT = 2.6;              // стены высокие — кубы НЕ перелетают
const WALL_THICKNESS = 1.0;           // толстые стены — защита от tunneling
const CEILING_Y = 3.2;                // невидимый потолок — абсолютный предел по Y
const FLOOR_HALF_THICK = 5.0;         // ОЧЕНЬ толстый пол (10 единиц глубиной) — куб не провалится
const DIE_HALF = 0.22;                // половина размера кубика (side = 0.44)
// OUT_OF_BOUNDS теперь вычисляется динамически от currentArenaHalf + запас.
// См. getOutOfBounds(). Константа оставлена как fallback.
const OUT_OF_BOUNDS_MARGIN = 1.0;     // запас за стенами до safety reset
const GRAVITY = -14.0;                // земное — настоящий «бросок», не лунное подрагивание

// ── ФАЗА 1: Хаотичное вращение на месте (220мс, очень быстрая) ──
// Кубики появляются ТЕСНЫМ кластером в позиции "руки" (ближний край +Z),
// получают ОЧЕНЬ ВЫСОКОЕ хаотичное кручение (32-54 рад/с по всем осям) и
// минимальную линейную скорость → крутятся на месте, НЕ разлетаясь.
//
// Время перемешивания сокращено до 220мс (было 500мс, до этого 1с).
// Пользователь воспринимал длинную фазу как "кубы висят, потом начинают
// крутиться". Теперь фаза достаточно короткая, чтобы быть "моментальным
// перемешиванием в руке" — кубы появляются, БЫСТРО прокручиваются (видно
// кручение с первого снапшота благодаря acc=STEP), и сразу бросаются.
//
// Скорость кручения УВЕЛИЧЕНА (32-54 рад/с, было 20-36) — за один шаг
// симуляции (1/60с) куб поворачивается на 0.53-0.90 рад = 30-52°.
// Первый снапшот уже показывает заметно повёрнутые кости → нет "висят".
//
// После SHAKE_DURATION_MS (220мс) стенки становятся sensor, и каждый
// кубик получает ИМПУЛЬС ВПЕРЁД (−Z, от игрока) + ВВЕРХ (+Y, дуга броска)
// + дополнительное кручение → кубики летят вперёд, падают на стол,
// отскакивают и катятся.
const HAND_Z_FACTOR = 0.62;           // позиция стакана: +arenaHalfH * 0.62 (ближний край)
const SHAKE_DURATION_MS = 120;        // 120мс перемешивания (было 220мс) — минимальная фаза "в руке", чтобы кубики НЕ казались "висящими над столом"
const CUP_HALF_W = 0.62;              // полудиаметр стакана по X — вмещает кластер 4 кубиков
const CUP_HALF_D = 0.62;              // полудиаметр стакана по Z
const CUP_HALF_H = 0.50;              // высота стенок стакана (от y=0 до y=1.0)
const CUP_WALL_T = 0.05;              // полутолщина стенок стакана
const CUP_SHAKE_AMP = 0.10;           // чуть больше (было 0.08) — заметнее за короткую фазу
const CUP_SHAKE_FREQ = 38.0;          // чуть ниже (было 44) — ~6 Гц, 1.3 цикла за 220мс (видно)
const CUP_TILT_AMP = 0.10;            // чуть больше (было 0.08) — заметнее наклон
const CUP_WALL_RESTITUTION = 0.35;    // стенки умеренно упругие
const DIE_INITIAL_ANG_MIN = 32.0;     // УВЕЛИЧЕНО (было 20) — заметное кручение с первого шага
const DIE_INITIAL_ANG_MAX = 54.0;     // УВЕЛИЧЕНО (было 36)
const DIE_INITIAL_LIN_MIN = 0.08;     // минимальная линейная скорость — кубики почти стоят
const DIE_INITIAL_LIN_MAX = 0.25;

// ── ФАЗА 2: Бросок от себя (throw) ────────────────────────────
// После перемешивания кубики переключаются в dynamic и получают импульс:
// ВПЕРЁД (−Z, вглубь экрана, от игрока) + ВВЕРХ (+Y, дуга броска).
// Падают на стол, отскакивают и катятся.
const THROW_VY = 3.0;                 // подскок вверх — заметная дуга броска
const THROW_VZ_MIN = 2.6;             // бросок ВПЕРЁД (−Z, от игрока)
const THROW_VZ_MAX = 3.4;
const THROW_VX_MIN = -0.35;           // лёгкий разброс по X
const THROW_VX_MAX = 0.35;
const THROW_ANG_MIN = 10.0;           // сильное кручение в полёте
const THROW_ANG_MAX = 16.0;

// ── ПРЕСЕТЫ БРОСКА (для A/B теста зрелищности) ─────────────────
// Каждый пресет меняет силу/угол/кручение броска. presetId передаётся
// клиентом в dice:roll. По умолчанию используется 'normal'.
interface ThrowPreset {
  name: string;          // человекочитаемое название
  vyMin: number;         // вертикальная компонента импульса — диапазон (per-die вариация)
  vyMax: number;         //   разный vy → кубики пикуют на разной высоте, не сталкиваются в воздухе
  vzMin: number;         // горизонтальная (вперёд) — диапазон
  vzMax: number;
  vxMin: number;         // боковой разброс — диапазон
  vxMax: number;
  angMin: number;        // угловая скорость (кручение в полёте)
  angMax: number;
  shakeAmpMul: number;   // множитель амплитуды тряски стакана в фазе 1
  shakeFreqMul: number;  // множитель частоты тряски
  spreadBias: number;    // направленный боковой импульс по сетке: внешние кубики (±0.24 X) получают
                         //   spreadBias * sign(basePos.x) — формирует fan-паттерн, кубики НЕ летят в одной колонне
}

const THROW_PRESETS: Record<string, ThrowPreset> = {
  // 1. Мягкий — кубики почти не подлетают, мягко катятся по столу.
  //    Минимум отскоков, слабое кручение. Спокойный бросок.
  gentle: {
    name: 'Мягкий',
    vyMin: 1.0, vyMax: 1.6, vzMin: 1.6, vzMax: 2.2, vxMin: -0.2, vxMax: 0.2,
    angMin: 7.0, angMax: 11.0,
    shakeAmpMul: 0.6, shakeFreqMul: 0.85,
    spreadBias: 0.3,
  },
  // 2. Обычный — текущие значения по умолчанию. Заметная дуга, 2-3 отскока.
  normal: {
    name: 'Обычный',
    vyMin: 2.6, vyMax: 3.4, vzMin: 2.6, vzMax: 3.4, vxMin: -0.35, vxMax: 0.35,
    angMin: 11.0, angMax: 16.0,
    shakeAmpMul: 1.0, shakeFreqMul: 1.0,
    spreadBias: 0.5,
  },
  // 3. Силовой — мощный бросок от себя. Кубики летят далеко, сильно
  //    кувыркаются, отскакивают выше. Эффект "бросил со всей силы".
  //    ВАЖНО: скорости СНИЖЕНЫ для предотвращения tunneling сквозь пол.
  //    При vy=5.6 + vz=6.2 → |v|=8.35 м/с, за шаг 1/60 = 0.139м ( > половины
  //    куба 0.22 → CCD cuboid-vs-cuboid не всегда ловил → кубы проваливались
  //    сквозь пол, safety net телепортировал их обратно → видно "дёрганье").
  //    Теперь vyMax=3.8, vzMax=4.4 → |v|=5.8 м/с, шаг=0.097м — CCD стабильно
  //    ловит пол, tunneling почти не возникает. Бросок всё ещё мощный и
  //    зрелищный (дуга ~0.8м, 2-3 отскока), но без артефактов.
  //    Даже если tunneling возникает — virtual floor ловит его плавно
  //    (без snap/teleport). spreadBias=1.2 → fan-паттерн сохранён.
  power: {
    name: 'Силовой',
    vyMin: 2.6, vyMax: 3.8, vzMin: 3.0, vzMax: 4.4, vxMin: -1.0, vxMax: 1.0,
    angMin: 14.0, angMax: 20.0,
    shakeAmpMul: 1.4, shakeFreqMul: 1.2,
    spreadBias: 1.2,
  },
  // 4. Навес — высокий подскок, маленькая скорость вперёд. Кубики
  //    подлетают почти вертикально и падают сверху вниз. Эффект "кидает
  //    сверху" (как в нардах). Резкие удары о стол.
  lob: {
    name: 'Навес',
    vyMin: 6.0, vyMax: 7.8, vzMin: 1.0, vzMax: 1.8, vxMin: -0.3, vxMax: 0.3,
    angMin: 16.0, angMax: 24.0,
    shakeAmpMul: 1.1, shakeFreqMul: 1.3,
    spreadBias: 0.4,
  },
  // 5. Веер — большой разброс по X. Кубики разлетаются в разные стороны,
  //    как веер. Эффект "раскидал по столу". Хорошо для демонстрации
  //    физики столкновений между кубиками.
  scatter: {
    name: 'Веер',
    vyMin: 2.4, vyMax: 3.2, vzMin: 2.4, vzMax: 3.0, vxMin: -1.8, vxMax: 1.8,
    angMin: 15.0, angMax: 22.0,
    shakeAmpMul: 1.3, shakeFreqMul: 1.1,
    spreadBias: 1.5,
  },
};

function getPreset(id: string | undefined | null): ThrowPreset {
  if (id && THROW_PRESETS[id]) return THROW_PRESETS[id];
  return THROW_PRESETS.power;   // «Силовой» — стандартный бросок (выбран пользователем как наиболее зрелищный)
}
// v3i: ВОЗВРАТ К НОРМАЛЬНОЙ ФИЗИКЕ. v3g/h сделал кубики «масляными» —
// они перестали отскакивать и скользить, падали и мгновенно замирали.
// Жалоба пользователя: «не отскакивают от стола, падают как будто из масла».
// Причина: GROUND_ANG_DAMP_PER_STEP=0.92 каждый шаг (1/120с) → за секунду
// 0.92^120≈4.5e-5, т.е. ω и горизонтальная v умирали мгновенно при контакте.
// Возврат к значениям близким к оригинальным (RESTITUTION 0.32, FRICTION 0.32,
// LINEAR_DAMPING 0.18), с мягкой коррекцией под текущий setup:
const RESTITUTION = 0.36;             // v3i: 0.28→0.36 — заметный отскок 2-3 подпрыгивания
const FRICTION = 0.34;                // v3i: 0.42→0.34 — низкое трение, кубик скользит и катится
const LINEAR_DAMPING = 0.22;          // v3i: 0.35→0.22 — умеренное затухание, живая дуга броска
const ANGULAR_DAMPING = 0.42;         // v3i: 0.45→0.42 — чуть мягче, дольше кувыркание в полёте
// ── VIRTUAL FLOOR — плавная коррекция пенетрации (без snap/teleport/freeze) ──
// Cuboid-vs-cuboid CCD в Rapier ненадёжен для вращающихся кубиков → они
// проваливаются сквозь пол. Вместо подсчёта туннелей и мгновенного
// snap'а (видимый эффект «магнитится к столу»), мы применяем ПЛАВНУЮ
// коррекцию каждый кадр:
//   - Если центр кубика ниже DIE_HALF: поднять до DIE_HALF (1 кадр, невидимо при 60fps)
//   - Если движется вниз: затормозить vy и дать малый отскок (0.28*|vy|, макс 1.8)
//   - Угловая скорость СОХРАНЯЕТСЯ — кубик продолжает кувыркаться
//   - Нет tunnelCount, нет frozen флага, нет snap ориентации
// Кубик отскакивает через RESTITUTION (0.32) когда CCD ловит пол; virtual
// floor ловит остальное. Settle detection + nudge обрабатывают рёбра.
const VIRTUAL_FLOOR_Y = DIE_HALF;
const VIRTUAL_FLOOR_BOUNCE = 0.36;     // v3i: 0.28→0.36 — совпадает с RESTITUTION (заметный отскок)
const VIRTUAL_FLOOR_MAX_BOUNCE = 2.6;  // v3i: 1.8→2.6 — позволяем сильный первый отскок
const VIRTUAL_FLOOR_FRICTION = 0.82;   // v3i: 0.75→0.82 — мягче трение об пол при импакте (сохраняет горизонталь)
// v3i: GROUND ANGULAR DAMPING — ТОЛЬКО Y-ОСЬ (spinning-top проблема).
// ПРОБЛЕМА v3h: GROUND_ANG_DAMP_PER_STEP=0.92 гасил ВСЁ — ω (X/Y/Z) И
// горизонтальную v каждый шаг → кубик замирал мгновенно, как в масле.
// РЕШЕНИЕ v3i: гасим ТОЛЬКО Y-ось (вертикальная ось = "spinning top").
// X/Z кувыркание (красивый tumble на полу) и линейная скорость НЕ трогаются —
// их гасит естественный Rapier friction (0.34) + linearDamping (0.22).
// Per-step 0.988 → per-second = 0.988^120 ≈ 0.235. Y-spin 8 → 1.88 за 1с,
// → 0.44 за 2с. Spinning-top (|ω_Y|>4) почти никогда не доживает до 2.5с
// (порог forceTipDie). Если доживёт — forceTipDie на 2.5с его поймает.
const GROUND_Y_DAMP_PER_STEP = 0.988;     // v3i: только Y-ось, мягко (0.92→0.988)
const GROUND_CONTACT_Y = DIE_HALF + 0.10; // v3i: 0.15→0.10 — уже "на полу", не триггерим во время активного отскока
const GROUND_CONTACT_VY = 0.6;            // v3i: 0.5→0.6 — чуть мягче триггер
// ── IMPACT-BOUNCE (v3l: fix «нет отскока при edge/corner landing») ──
// Rapier's restitution для cuboid-vs-cuboid надёжна ТОЛЬКО при flat-landing
// (центр ≈ DIE_HALF=0.22). При edge/corner-посадке (центр 0.28-0.38) solver
// гасит вертикальную скорость почти до нуля ДО того, как куб достигнет
// VIRTUAL_FLOOR_Y (0.215). Результат: куб «шлёпается» на ребро и замирает
// без отскока. Жалоба: «нет нормальной анимации того как кубы падают и отскакивают».
//
// Фикс: IMPACT_FLOOR_Y = DIE_HALF + 0.20 = 0.42. Это диапазон center.y при
// edge/corner-посадке (flat=0.22, edge 45°=0.31, corner=0.38). Когда куб
// в этом диапазоне И был в быстром спуске (prevVy < IMPACT_MIN_VY) И
// внезапно затормозился (|v.y| < IMPACT_DECEL_VY) — это момент импакта.
// Применяем отскок = |prevVy| × IMPACT_BOUNCE_SCALE (с тем же множителем
// что и VIRTUAL_FLOOR_BOUNCE = 0.36, чтобы отскок выглядел естественно).
//
// IMPACT_BOUNCE_COOLDOWN_MS = 250 — анти-спам: после отскока кубик летит
// вверх, падает, и при следующем касании снова триггерится. Без кулдауна
// был бы chain-bounce каждый кадр. 250мс ≈ время полёта при bounceVy=1.0.
const IMPACT_FLOOR_Y = DIE_HALF + 0.20;   // 0.42 — диапазон edge/corner-посадки
const IMPACT_MIN_VY = -1.0;               // prevVy < -1.0 м/с = был быстрый спуск
const IMPACT_DECEL_VY = 0.9;              // |v.y| < 0.9 = внезапно затормозился (импакт)
// IMPACT_BOUNCE_SCALE = 0.70 — выше RESTITUTION (0.36), потому что prevVy уже
// частично погашен Rapier solver'ом ДО детекции импакта. Реальная impact velocity
// при падении с пика 0.5 единиц = sqrt(2×14×0.3) ≈ 2.9 м/с. Но к моменту когда
// наш код видит "быстрый спуск → внезапная остановка", prevVy уже ~1.3-1.7
// (solver начал гасить ещё до триггера). Scale 0.70 × prevVy 1.5 = 1.05 м/с
// отскок → высота 1.05²/28 = 0.039 единиц = ВИДНО.
const IMPACT_BOUNCE_SCALE = 0.70;
const IMPACT_MAX_BOUNCE = 2.8;            // потолок отскока (м/с)
const IMPACT_BOUNCE_COOLDOWN_MS = 200;    // анти-спам между отскоками
const IMPACT_DEBUG_LOG = false;           // true = логировать каждый impact-bounce (для отладки)
const EDGE_THRESHOLD = 0.90;          // dot product верхней грани с +Y; ниже = на ребре/угле (~26° наклон)
const MAX_NUDGES = 2;                 // v3g: 5→2 — не делаем 5 раундов слабых тычков. После 2 попыток на soft timeout сразу снапаем к ближайшей грани.
// CONTACT_SKIN — «контактный слой» коллайдера. solver считает кубики "в контакте"
// когда их поверхности сблизились на это расстояние, и применяет позиционную коррекцию.
// 0.06 (6 см) было СЛИШКОМ много для куба 44 см — кубики "слипались" даже при зазоре 6 см,
// solver мягко подтягивал их друг к другу вместо того, чтобы растолкнуть. 
// 0.015 (1.5 см) — реалистичный контактный слой: кубики считаются "в контакте" только
// когда почти касаются. Это позволяет solver'у расталкивать их при реальных столкновениях.
const CONTACT_SKIN = 0.015;
const SOFT_CCD_PREDICTION = 0.8;      // мягкий CCD с большим горизонтом предсказания

// 6 локальных нормалей граней cuboid-коллайдера Rapier
// (порядок: +X, -X, +Y, -Y, +Z, -Z)
const FACE_NORMALS: Array<[number, number, number]> = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

// Символ для каждой грани (по индексу выше). Противоположные пары — одинаковые.
//   face 0 (+X), face 1 (-X) → "+1"
//   face 2 (+Y), face 3 (-Y) → "-1"
//   face 4 (+Z), face 5 (-Z) → "0"  (пустая грань)
const FACE_SYMBOLS: number[] = [1, 1, -1, -1, 0, 0];

// ---------------------------------------------------------------------------
// Утилиты
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString();
}
function log(...args: unknown[]): void {
  console.log(`[${ts()}]`, ...args);
}
function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min);
}
function rndSigned(min: number, max: number): number {
  return Math.random() < 0.5 ? -rnd(min, max) : rnd(min, max);
}

// Векторное скалярное произведение (без зависимостей, для чтения верхней грани)
function dot3(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  return ax * bx + ay * by + az * bz;
}

// Применить кватернион (x,y,z,w) к вектору (vx,vy,vz)
function rotateVec(
  qx: number, qy: number, qz: number, qw: number,
  vx: number, vy: number, vz: number,
): [number, number, number] {
  // v' = q * v * q^-1; для unit quaternion q^-1 = conjugate(q)
  // Формула: v' = v + 2*w*(u × v) + 2*(u × (u × v)), где u = (qx,qy,qz)
  const ux = qx, uy = qy, uz = qz;
  // u × v
  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  // 2*w*(u × v)
  const a = 2 * qw;
  // u × (u × v) = (u·v)u - (u·u)v
  const uv = ux * vx + uy * vy + uz * vz;
  const uu = ux * ux + uy * uy + uz * uz;
  const b = 2;
  return [
    vx + a * cx + b * (uv * ux - uu * vx),
    vy + a * cy + b * (uv * uy - uu * vy),
    vz + a * cz + b * (uv * uz - uu * vz),
  ];
}

// Кватернион, поворачивающий вектор A на вектор B (unit quaternion)
function quaternionFromTo(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): [number, number, number, number] {
  const dot = ax * bx + ay * by + az * bz;
  if (dot > 0.9999) return [0, 0, 0, 1];           // already aligned
  if (dot < -0.9999) {
    // 180° rotation around any axis perpendicular to A
    let px = 1, py = 0, pz = 0;
    if (Math.abs(ax) > 0.9) { px = 0; py = 1; }
    return [px, py, pz, 0];
  }
  let kx = ay * bz - az * by;
  let ky = az * bx - ax * bz;
  let kz = ax * by - ay * bx;
  const klen = Math.sqrt(kx * kx + ky * ky + kz * kz);
  if (klen > 0.0001) { kx /= klen; ky /= klen; kz /= klen; }
  const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
  const s = Math.sin(angle / 2);
  const c = Math.cos(angle / 2);
  return [kx * s, ky * s, kz * s, c];
}

// Какая грань кубика сейчас смотрит вверх (max dot product с +Y)
// и насколько чётко (dot: 1.0 = идеально, 0.707 = на ребре, 0.577 = на угле)
function getUpFaceAlignment(
  qx: number, qy: number, qz: number, qw: number,
): { idx: number; dot: number } {
  let bestIdx = 2;
  let bestDot = -Infinity;
  for (let i = 0; i < 6; i++) {
    const [nx, ny, nz] = FACE_NORMALS[i];
    const [wx, wy, wz] = rotateVec(qx, qy, qz, qw, nx, ny, nz);
    if (wy > bestDot) {
      bestDot = wy;
      bestIdx = i;
    }
  }
  return { idx: bestIdx, dot: bestDot };
}

// Snap die rotation so that faceIdx points straight up (+Y).
// Last-resort: если куб застрял на ребре после MAX_NUDGES толчков.
function snapDieToFaceUp(body: any, faceIdx: number): void {
  const [nx, ny, nz] = FACE_NORMALS[faceIdx];
  const [qx, qy, qz, qw] = quaternionFromTo(nx, ny, nz, 0, 1, 0);
  try {
    body.setRotation({ x: qx, y: qy, z: qz, w: qw }, true);
    body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  } catch {}
}

// ---------------------------------------------------------------------------
// Сессия броска
// ---------------------------------------------------------------------------

interface DieBody {
  body: any; // RAPIER.RigidBody
  collider: any; // RAPIER.Collider — храним явно, чтобы удалить при cleanup
  index: number;
  nudgeCount: number;    // сколько раз толкали куб, чтобы слезть с ребра
  lastNudgeAt: number;   // timestamp последнего толчка (мс)
  tunnelCount: number;   // сколько раз проваливался сквозь пол (для safety net)
  lastTunnelAt: number;  // timestamp последнего tunneling-а (мс)
  // ── Frozen flag — кубик уже «заморожен» safety-freeze'ом ──
  // Когда safety-freeze срабатывает (tunnel #6), кубик получает:
  //   1) snap ориентации к ближайшей грани (face up)
  //   2) v = 0 (останавливается)
  //   3) высокий damping (любой solver-jitter мгновенно затухает)
  //   4) frozen = true (кубик больше НЕ обрабатывается safety-net'ом
  //      и считается «slow» в settle detection)
  // Без этого флага кубик на ребре после safety-freeze дрожит ~9 секунд
  // пока nudge-цикл (5×300мс) и hard-timeout (11с) его не выровняют.
  frozen: boolean;
  // ── Процедурное вращение в фазе 1 (kinematic) ──
  // Пока released=false, кубик kinematic и вращается процедурно:
  // body.setNextKinematicRotation() каждый кадр с кватернионом, который
  // крутится вокруг хаотичной оси. Это даёт ровно "секунду хаотично
  // вращаются на месте" — без разлёта от столкновений.
  // При releaseDice() кубик переключается в dynamic и получает импульс.
  spinAxis: [number, number, number];  // нормированная ось вращения
  spinSpeed: number;                    // рад/с
  spinQuat: { x: number; y: number; z: number; w: number };  // текущая ориентация
  basePos: { x: number; y: number; z: number };  // стартовая позиция (центр вращения)
  // ── Impact-bounce tracking (v3l: fix «нет отскока при edge/corner landing») ──
  // Rapier's restitution для cuboid-vs-cuboid надёжна ТОЛЬКО при flat-landing
  // (центр куба ≈ DIE_HALF=0.22). При edge/corner-посадке (центр 0.28-0.38)
  // solver гасит вертикальную скорость почти до нуля ДО того, как куб достигнет
  // VIRTUAL_FLOOR_Y — и virtual floor не срабатывает (триггер center < 0.215).
  // Результат: куб «шлёпается» на ребро и замирает без отскока.
  //
  // Фикс: отслеживаем prevVy каждый кадр. Когда куб был в быстром спуске
  // (prevVy < -1.2) и внезапно затормозился (|v.y| < 0.4) рядом с полом
  // (p.y < IMPACT_FLOOR_Y) — это момент edge/corner-импакта. Применяем
  // отскок на основе prevVy (каким была скорость ДО удара). Это даёт
  // видимый отскок даже когда Rapier solver всё погасил.
  prevVy: number;         // y-velocity предыдущего кадра (м/с)
  lastImpactBounceAt: number;  // timestamp последнего impact-bounce (мс) — анти-спам
}

interface RollSession {
  id: string;
  numDice: number;
  dice: DieBody[];
  startedAt: number;
  firstSleepAt: number | null;  // когда впервые все уснули
  finalized: boolean;
  resultEmitted: boolean;
  collisionGroup: number;       // битовая маска группы коллизий для изоляции сессий
  // Буфер накопленных трансформов для следующего снапшота
  pendingSnapshot: boolean;
  // Фаза броска: false = перемешивание (shake), true = брошены (throw).
  // Переключается в releaseDice() после SHAKE_DURATION_MS.
  released: boolean;
  releasedAt: number;           // когда кубики были брошены (мс)
  // Стакан (невидимый kinematic-контейнер для перемешивания).
  // 4 стенки-коллайдера на одном kinematic-теле. Стенки осциллируют
  // (тряска) → dynamic-кубики внутри сталкиваются и перемешиваются.
  // После перемешивания коллайдеры становятся sensor → кубики вылетают.
  cupBody: any;                 // RAPIER.RigidBody (kinematicPositionBased)
  cupColliders: any[];          // RAPIER.Collider[] (4 стенки)
  cupBaseX: number;             // базовая позиция стакана (для осцилляции)
  cupBaseY: number;
  cupBaseZ: number;
  // Пресет броска (gentle/normal/power/lob/scatter). Определяет силу,
  // угол и кручение импульса броска, а также множители тряски стакана.
  preset: ThrowPreset;
  // Сторона арены, откуда бросают кубики. 'near' = ближний край (+Z,
  // сторона игрока) — бросок ВПЕРЁД (−Z, вглубь экрана). 'far' = дальний
  // край (−Z) — бросок НА ИГРОКА (+Z). Используется для одновременного VS
  // броска: ролик бросает с near, оппонент с far → кубы летят навстречу
  // друг другу и приземляются в центре арены.
  originSide: 'near' | 'far';
  // ── Латеральный X-офсет точки спавна стакана ──
  // По умолчанию 0 (центр арены). Используется для zonal mass-roll: когда
  // N игроков бросают одновременно, каждому назначается свой originX
  // (например -1.6 / 0 / +1.6), чтобы их стаканы (и зоны приземления
  // кубиков) разошлись по X и кубики не пересекались.
  // ВАЖНО: это только spawn-position. Латеральный импульс броска (vx)
  // остаётся нулевым — кубики летят ВПЕРЁД (как обычно), просто из
  // смещённой стартовой позиции.
  originX?: number;
  // ── Направление броска (drag-roll gesture direction) ──
  // Угол в радианах, 0 = вперёд (−Z, вглубь экрана), π/2 = вправо (+X),
  // π = назад (+Z, на игрока), −π/2 = влево (−X). Когда параметр задан
  // (только для drag-броска), импульс броска вращается на этот угол —
  // кубики летят В НАПРАВЛЕНИИ ЖЕСТА. spawn-position (originSide/originX)
  // ставится на противоположную сторону от направления полёта, чтобы
  // кубы появлялись с противоположного края и летели через арену.
  //
  // По умолчанию undefined → импульс определяется originSide (near → −Z,
  // far → +Z), как раньше. Это сохраняет обратную совместимость для
  // кнопка-броска, VS и mass-roll.
  direction?: number;
  // ── Абсолютная позиция спавна стакана (drag-roll "token placement" mode) ──
  // Когда ОБА поля spawnX и spawnZ заданы (как числа) — cup появляется В
  // ЭТОЙ ТОЧКЕ арены (в физ. единицах, центр арены = (0,0)). Это переопределяет
  // edge-based расчёт cupX/cupZ из originSide/originX.
  //
  // Логика: "тащишь кубы на карту → отпускаешь в точке (X,Y) → кубы
  // появляются ИМЕННО ТАМ". Как размещение токена — бросил в точку, там и
  // появился. Импульс броска (если direction задан) по-прежнему вращается
  // на угол жеста — кубы могут слегка откатиться в сторону жеста, но
  // основной спавн — точно под курсором.
  //
  // Если только один из spawnX/spawnZ задан — используем edge-based для
  // недостающей оси (по умолчанию: cupX=originX, cupZ=±edge).
  // Если ОБА undefined — оригинальная логика (originSide + originX).
  spawnX?: number;
  spawnZ?: number;
  // ── Скорость взмаха в момент отпускания (drag-roll realism mode) ──
  // В пикселях/мс (модуль вектора скорости курсора). Только для drag-броска.
  // Когда задана — releaseDice() масштабирует импульс броска от этой скорости:
  //   • horizontal (vx, vz): lerp(0.05, 0.95, smoothstep(v/2.5))
  //     — медленный отпуск → почти нет бокового импульса (кубы на месте)
  //     — быстрый flick → почти полная сила пресета (кубы летят дальше)
  //   • vertical (vy, дуга): lerp(0.40, 1.00, smoothstep(v/2.5))
  //     — медленно → минимальная дуга (кубы не clip'нут пол)
  //     — быстро → полная дуга пресета (nice arc)
  //   • angular (spin): lerp(0.30, 1.00, smoothstep(v/2.5))
  //     — медленно → лёгкое кручение
  //     — быстро → полное кручение пресета
  // Это даёт реалистичное ощущение: "медленно отпустил = поставил, быстро
  // отпустил = бросил с размаху". undefined → scale=1.0 (полный импульс
  // пресета, как для кнопка-броска/VS/mass).
  swingVelocity?: number;
  // ── Начальные ориентации кубиков (drag-roll "in-hand rotation" mode) ──
  // Массив кватернионов [x, y, z, w] — по одному на кубик. Когда задан
  // (только для drag-броска), кубики спавнятся с ЭТИМИ ориентациями (вместо
  // случайных), и фаза перемешивания (SHAKE_DURATION_MS) ПРОПУСКАЕТСЯ —
  // releaseDice() вызывается немедленно.
  //
  // Логика: игрок "держит" кубы мышкой и они ВРАЩАЮТСЯ во время drag
  // (рендерится 3D-оверлей с 4 крутящимися кубами). При отпускании текущие
  // ориентации захватываются и передаются сюда. Поскольку кубы вращались
  // произвольное время (зависит от того, сколько тащил игрок), ориентации
  // получаются случайными → результат броска становится случайным БЕЗ
  // отдельной фазы перемешивания. Это даёт БЕСШОВНЫЙ бросок: "тащил →
  // отпустил → кубы сразу полетели", без заметной задержки на shake.
  //
  // undefined для кнопка-броска/VS/mass → используется фаза перемешивания
  // (SHAKE_DURATION_MS = 120мс) со случайными стартовыми ориентациями.
  initialQuats?: Array<[number, number, number, number]>;
  // ── Начальные угловые скорости кубиков (Вариант A — продолжение вращения) ──
  // Массив векторов [wx, wy, wz] (рад/с, world space) — по одному на кубик.
  // Когда задан (вместе с initialQuats), releaseDice использует ЭТИ угловые
  // скорости (body.setAngvel) вместо throwSpin пресета → брошенные кубы
  // ПРОДОЛЖАЮТ вращение удерживаемых (та же ось+скорость). Буквально "те же
  // кубы полетели" — визуально бесшовный handoff из drag-фазы в бросок.
  // undefined → throwSpin пресета (angMin..angMax × angularScale).
  initialAngularVelocity?: Array<[number, number, number]>;
}

const sessions = new Map<string, RollSession>();
let world: any = null;
let simRunning = false;
let lastTickTime = 0;
let acc = 0;
let lastSnapshotTime = 0;
let io: Server | null = null;
let nextCollisionGroup = 1;       // инкрементится для каждой новой сессии (1..30, потом заново)

// ── Динамический прямоугольный размер арены ───────────────────
// currentArenaHalfW (X) и currentArenaHalfH (Z) — половины сторон прямоугольной
// арены. Меняются при броске, если клиент передаёт arenaHalfW/arenaHalfH.
// При смене размера — rebuildWorld(). Это позволяет ставить физические стены
// ТОЧНО по контуру карты клиента (прямоугольное изображение → прямоугольная
// арена того же соотношения сторон).
let currentArenaHalfW = DEFAULT_ARENA_HALF;
let currentArenaHalfH = DEFAULT_ARENA_HALF;

// Текущая граница out-of-bounds (чуть дальше стен) — для safety reset.
function getOutOfBounds(): number {
  return Math.max(currentArenaHalfW, currentArenaHalfH) + OUT_OF_BOUNDS_MARGIN;
}

// Ограничить arenaHalf в разумных пределах (защита от мусорных значений).
function clampArenaHalf(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_ARENA_HALF;
  return Math.max(MIN_ARENA_HALF, Math.min(MAX_ARENA_HALF, v));
}

// ---------------------------------------------------------------------------
// Арена (пол + 4 невысокие стены) — создаётся с заданным размером arenaHalf.
// Размер определяется размером карты клиента: arenaHalf = max(W,H) / 500.
// Стены ставятся ТОЧНО по контуру карты → кубики не вылетают за её границы.
// ---------------------------------------------------------------------------

function buildArena(rapierWorld: any, arenaHalfW: number, arenaHalfH: number): void {
  const AHW = arenaHalfW;
  const AHH = arenaHalfH;
  const RAPIER_NS = RAPIER as any;
  // Пол — ОЧЕНЬ толстый прямоугольный cuboid (half-thickness 5.0, верх на y=0).
  // Размер AHW × AHH (+ запас под стены). Даже при tunneling куб остаётся
  // внутри пола и выталкивается наверх.
  const floorHalfW = AHW + WALL_THICKNESS;
  const floorHalfH = AHH + WALL_THICKNESS;
  const floorBody = rapierWorld.createRigidBody(
    RAPIER_NS.RigidBodyDesc.fixed().setTranslation(0, -FLOOR_HALF_THICK, 0)
  );
  const floorCol = RAPIER_NS.ColliderDesc.cuboid(floorHalfW, FLOOR_HALF_THICK, floorHalfH);
  floorCol.setFriction(FRICTION);
  floorCol.setRestitution(RESTITUTION);
  // Контактный слой на полу — 5см (больше чем CONTACT_SKIN=0.015 на кубиках).
  // Solver начинает позиционную коррекцию ЕЩЁ ДО того, как куб провалится
  // в пол. Это компенсирует случаи, когда CCD чуть-чуть опаздывает: куб
  // «цепляется» за контактный слой и реальный отскок происходит через
  // solver, а не через safety net.
  try { floorCol.setContactSkin(0.05); } catch {}
  rapierWorld.createCollider(floorCol, floorBody);

  // 4 высокие стены по периметру (толстые, чтобы не было tunneling).
  // Стены на ±AHW (X) и ±AHH (Z) — РОВНО по контуру карты клиента.
  // Far/near стены (±Z) длиной 2*AHW; left/right стены (±X) длиной 2*AHH.
  const WT = WALL_THICKNESS; // half-thickness стен
  const wallConfigs: Array<[number, number, number, number]> = [
    // [x, z, halfSizeX, halfSizeZ]
    [0, AHH + WT, AHW + WT, WT],    // far +Z
    [0, -(AHH + WT), AHW + WT, WT], // near -Z
    [AHW + WT, 0, WT, AHH + WT],    // right +X
    [-(AHW + WT), 0, WT, AHH + WT], // left -X
  ];
  for (const [x, z, hsx, hsz] of wallConfigs) {
    const wb = rapierWorld.createRigidBody(
      RAPIER_NS.RigidBodyDesc.fixed().setTranslation(x, WALL_HEIGHT / 2, z)
    );
    const wc = RAPIER_NS.ColliderDesc.cuboid(hsx, WALL_HEIGHT / 2, hsz);
    wc.setFriction(FRICTION);
    wc.setRestitution(RESTITUTION);
    rapierWorld.createCollider(wc, wb);
  }

  // Невидимый потолок на CEILING_Y — абсолютный предел. Даже если куб
  // по какой-то причине набирает vy > 7.8 (мешок пресетов, баг, сторонний
  // импульс), потолок ловит его и не даёт улететь в бесконечность.
  // Потолок — sensor=false (реальная коллизия), низкое трение, умеренный
  // отскок вниз — кубик отскакивает обратно на стол.
  const ceilBody = rapierWorld.createRigidBody(
    RAPIER_NS.RigidBodyDesc.fixed().setTranslation(0, CEILING_Y + 0.5, 0)
  );
  const ceilHalfW = AHW + WALL_THICKNESS;
  const ceilHalfH = AHH + WALL_THICKNESS;
  const ceilCol = RAPIER_NS.ColliderDesc.cuboid(ceilHalfW, 0.5, ceilHalfH);
  ceilCol.setFriction(FRICTION);
  ceilCol.setRestitution(RESTITUTION);
  rapierWorld.createCollider(ceilCol, ceilBody);
}

// ---------------------------------------------------------------------------
// Создание кубиков для сессии
// ---------------------------------------------------------------------------

function spawnDiceForSession(session: RollSession): void {
  const RAPIER_NS = RAPIER as any;

  // Collision groups в Rapier — 16-битные маски (membership | filter).
  // Каждый кубик сессии состоит в группе `session.collisionGroup` и фильтрует
  // коллизии только с этой же группой + базовой ареной (группа 0x8000).
  const groupBit = 1 << session.collisionGroup;     // бит участия (1..30)
  const arenaBit = 1 << 0;                          // арена — бит 0
  const diceMask = groupBit | arenaBit;             // кубик сталкивается с собой и ареной
  const diceGroup = (diceMask << 16) | groupBit;    // packing: membership | filter
  // Стенки стакана: membership = groupBit, filter = groupBit.
  // Стенки сталкиваются ТОЛЬКО с кубиками этой сессии (не с ареной, не с
  // другими сессиями). Это изолирует параллельные броски.
  const cupGroup = (groupBit << 16) | groupBit;

  // ── Позиция стакана ("рука" игрока) ──
  // DRAG-ROLL "TOKEN PLACEMENT" MODE: когда клиент передал spawnX и spawnZ
  // (абсолютные координаты на арене), cup появляется В ЭТОЙ ТОЧКЕ. Это даёт
  // поведение как у размещения токена: "отпустил кубы в точке (X,Y) → кубы
  // появились ИМЕННО ТАМ". originSide/originX в этом режиме игнорируются
  // (они нужны только для edge-based режима — кнопка/VS/mass-roll).
  //
  // originSide='near' (default): ближний край +Z — бросок ВПЕРЁД (−Z).
  // originSide='far': дальний край −Z — бросок НА ИГРОКА (+Z).
  // Это позволяет двум игрокам бросать одновременно навстречу друг другу
  // (VS roll): ролик с near, оппонент с far. Кубы встречаются в центре.
  //
  // originX — латеральный офсет стакана по X (для zonal mass-roll).
  // Когда N игроков бросают одновременно, каждый получает свой originX
  // (-1.6 / 0 / +1.6 и т.д.), чтобы стаканы разошлись по X. Бросок всё
  // равно ВПЕРЁД (vx=0), просто из смещённой стартовой позиции.
  const sideSign = session.originSide === 'far' ? -1 : 1;
  const hasSpawnX = typeof session.spawnX === 'number' && Number.isFinite(session.spawnX as number);
  const hasSpawnZ = typeof session.spawnZ === 'number' && Number.isFinite(session.spawnZ as number);
  // Clamp spawn position so cup stays INSIDE the arena (with safety margin
  // for cup half-size — cup walls shouldn't poke through arena walls).
  const CUP_MARGIN = CUP_HALF_W + 0.10;  // 0.62 + 0.10 = 0.72
  const clampSpawnX = (v: number): number => Math.max(-currentArenaHalfW + CUP_MARGIN, Math.min(currentArenaHalfW - CUP_MARGIN, v));
  const clampSpawnZ = (v: number): number => Math.max(-currentArenaHalfH + CUP_MARGIN, Math.min(currentArenaHalfH - CUP_MARGIN, v));
  const cupX = hasSpawnX
    ? clampSpawnX(session.spawnX as number)
    : (session.originX ?? 0);
  const cupZ = hasSpawnZ
    ? clampSpawnZ(session.spawnZ as number)
    : (currentArenaHalfH * HAND_Z_FACTOR * sideSign);
  const cupY = CUP_HALF_H;  // центр тела = середина стенок (стенки от y=0 до y=2*HALF_H)

  // ── Создаём стакан: 1 kinematic-тело + 4 стенки-коллайдера ──
  // Стенки — compound-коллайдеры на одном теле, с локальным оффсетом.
  // Дно НЕ нужно — кубики лежат на полу арены (y=0). Стакан открыт сверху
  // (кубики могут подскакивать, но стенки высокие — не вылетают).
  const cupBodyDesc = RAPIER_NS.RigidBodyDesc.kinematicPositionBased()
    .setTranslation(cupX, cupY, cupZ);
  const cupBody = world.createRigidBody(cupBodyDesc);
  const cupColliders: any[] = [];

  // Конфиг стенок: [localX, localZ, halfSizeX, halfSizeZ]
  // Стенки чуть длиннее снаружи (стыки перекрываются — без щелей).
  const wallConfigs: Array<[number, number, number, number]> = [
    [ CUP_HALF_W, 0,             CUP_WALL_T, CUP_HALF_D + CUP_WALL_T],  // +X wall (right)
    [-CUP_HALF_W, 0,             CUP_WALL_T, CUP_HALF_D + CUP_WALL_T],  // -X wall (left)
    [0,  CUP_HALF_D, CUP_HALF_W + CUP_WALL_T, CUP_WALL_T],              // +Z wall (near/player)
    [0, -CUP_HALF_D, CUP_HALF_W + CUP_WALL_T, CUP_WALL_T],              // -Z wall (far/table)
  ];
  for (const [lx, lz, hsx, hsz] of wallConfigs) {
    const wc = RAPIER_NS.ColliderDesc.cuboid(hsx, CUP_HALF_H, hsz);
    wc.setTranslation(lx, 0, lz);  // локальный оффсет от центра тела стакана
    wc.setFriction(FRICTION);
    wc.setRestitution(CUP_WALL_RESTITUTION);
    try { wc.setCollisionGroups(cupGroup); } catch {}
    const col = world.createCollider(wc, cupBody);
    cupColliders.push(col);
  }
  session.cupBody = cupBody;
  session.cupColliders = cupColliders;
  session.cupBaseX = cupX;
  session.cupBaseY = cupY;
  session.cupBaseZ = cupZ;

  // ── Создаём кубики — KINEMATIC, в линии 2×2 с зазором ──
  // Кубики появляются в позиции "руки" (ближний край +Z), разложенные
  // сеткой 2×2 с зазором (НЕ пересекаются). Каждый кубик — KINEMATIC и
  // вращается ПРОЦЕДУРНО вокруг хаотичной оси (applySpin каждый кадр).
  // Это даёт ровно "секунду хаотично вращаются на месте" — без разлёта
  // от столкновений, кубики стоят на своих позициях и крутятся.
  //
  // При releaseDice() кубики переключаются в dynamic, получают импульс
  // вперёд + вверх и кручение → летят, падают, катаются.
  const gap = 0.04;  // зазор между кубиками (полные 0.44 + 0.04 = 0.48 шаг)
  const step = DIE_HALF * 2 + gap;

  for (let i = 0; i < session.numDice; i++) {
    // Сетка 2×2: центры на ±step/2 по X и Z
    const col = i % 2;   // 0 или 1
    const row = Math.floor(i / 2);  // 0 или 1
    const startX = cupX + (col - 0.5) * step;
    const startY = DIE_HALF + 0.03;  // чуть выше пола
    const startZ = cupZ + (row - 0.5) * step;

    // KINEMATIC — кубик вращается процедурно, не подчиняется физике.
    // При releaseDice() переключим в dynamic.
    const bodyDesc = RAPIER_NS.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(startX, startY, startZ)
      .setCcdEnabled(true)
      .setSoftCcdPrediction(SOFT_CCD_PREDICTION);

    const body = world.createRigidBody(bodyDesc);

    const colDesc = RAPIER_NS.ColliderDesc.cuboid(DIE_HALF, DIE_HALF, DIE_HALF);
    colDesc.setFriction(FRICTION);
    colDesc.setRestitution(RESTITUTION);
    colDesc.setDensity(0.5);
    try { colDesc.setContactSkin(CONTACT_SKIN); } catch {}
    try { colDesc.setCollisionGroups(diceGroup); } catch {}
    const collider = world.createCollider(colDesc, body);

    // Хаотичная ось вращения (нормированная) + скорость.
    // 10-18 рад/с ≈ 1.6-2.9 оборота/сек → заметное кувыркание на месте.
    let ax = rndSigned(0.3, 1.0);
    let ay = rndSigned(0.3, 1.0);
    let az = rndSigned(0.3, 1.0);
    const alen = Math.sqrt(ax*ax + ay*ay + az*az) || 1;
    ax /= alen; ay /= alen; az /= alen;

    // ── Стартовая ориентация ──
    // DRAG-ROLL "in-hand rotation" MODE: если клиент передал initialQuats
    // (массив кватернионов, по одному на кубик), используем ЭТУ ориентацию
    // вместо случайной. Кубы вращались в руке игрока во время drag — их
    // текущая ориентация и есть "случайная стартовая точка".
    // При initialQuats фаза перемешивания (SHAKE_DURATION_MS) пропускается
    // (см. tick-цикл ниже), releaseDice() вызывается немедленно.
    //
    // Без initialQuats (кнопка-бросок/VS/mass) — случайная стартовая
    // ориентация, как раньше. Фаза перемешивания активна.
    const providedQuat = session.initialQuats && i < session.initialQuats.length
      ? session.initialQuats[i]
      : null;
    let startQuat: { x: number; y: number; z: number; w: number };
    if (providedQuat
        && typeof providedQuat[0] === 'number'
        && typeof providedQuat[1] === 'number'
        && typeof providedQuat[2] === 'number'
        && typeof providedQuat[3] === 'number'
        && Number.isFinite(providedQuat[0])
        && Number.isFinite(providedQuat[1])
        && Number.isFinite(providedQuat[2])
        && Number.isFinite(providedQuat[3])) {
      // Нормируем (на случай если клиент передал ненормированный кват)
      const qx = providedQuat[0], qy = providedQuat[1], qz = providedQuat[2], qw = providedQuat[3];
      const qlen = Math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw) || 1;
      startQuat = { x: qx/qlen, y: qy/qlen, z: qz/qlen, w: qw/qlen };
    } else {
      // Случайная стартовая ориентация — чтобы кубики выглядели "брошенными в руку"
      const q0x = rndSigned(0, 1), q0y = rndSigned(0, 1), q0z = rndSigned(0, 1), q0w = rndSigned(0, 1);
      const q0len = Math.sqrt(q0x*q0x + q0y*q0y + q0z*q0z + q0w*q0w) || 1;
      startQuat = { x: q0x/q0len, y: q0y/q0len, z: q0z/q0len, w: q0w/q0len };
    }
    body.setRotation(startQuat, true);

    session.dice.push({
      body, collider, index: i,
      nudgeCount: 0, lastNudgeAt: 0, tunnelCount: 0, lastTunnelAt: 0,
      frozen: false,
      spinAxis: [ax, ay, az],
      spinSpeed: rnd(DIE_INITIAL_ANG_MIN, DIE_INITIAL_ANG_MAX),
      spinQuat: startQuat,
      basePos: { x: startX, y: startY, z: startZ },
      prevVy: 0, lastImpactBounceAt: 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Бросок: открыть стакан (стенки → sensor) и дать кубикам импульс
// вперёд (−Z, от игрока) + вверх (+Y, дуга). Кубики уже dynamic и
// кувыркаются от перемешивания — applyImpulse добавляет бросок к их
// существующей скорости. Падают на стол, отскакивают и катятся.
// ---------------------------------------------------------------------------

function releaseDice(session: RollSession): void {
  session.released = true;
  session.releasedAt = Date.now();

  // Открываем стакан — стенки становятся sensor (коллизия отключена,
  // кубики вылетают насквозь). Тело стакана удалим при cleanup сессии.
  for (const col of session.cupColliders) {
    try { col.setSensor(true); } catch {}
  }

  // ── Velocity-based impulse scale (вычисляется ОДИН РАЗ до цикла) ──
  // session.swingVelocity (px/ms) — скорость взмаха в момент отпускания.
  // Когда задана, масштабируем компоненты импульса от скорости через
  // smoothstep для плавного роста:
  //   • horizontal (vx, vz): 0.05 .. 0.95 (медленно = на месте, быстро = летят)
  //   • vertical (vy, дуга): 0.70 .. 0.55 (УБЫВАЕТ! медленно = дуга, быстро = площе)
  //   • angular (spin): 0.30 .. 1.00 (медленно = лёгкое кручение, быстро = полное)
  //
  // ВАЖНО — ПОЧЕМУ ВЕРТИКАЛЬ УБЫВАЕТ (fix жалобы "сильный бросок = навес"):
  //   Раньше verticalScale рос с скоростью (0.40→1.00) И velocityToPreset()
  //   на быстром взмахе выдавал 'lob' (vy=6-7.8). Двойной эффект: быстрый
  //   взмах ВСЕГДА давал навес. Теперь: preset capped на 'power' (lob только
  //   вручную), и verticalScale УБЫВАЕТ — быстрый бросок = ПЛОСКИЙ мощный
  //   полёт, медленный = мягкая дуга. Реалистично: "сильно бросил = полетел
  //   плоско и далеко", а не "подбросил высоко".
  //
  // Если swingVelocity НЕ задана → scale=1.0 (кнопка-бросок/VS/mass — полный
  // импульс пресета). Для drop-mode без velocity сохранён fallback 0.30.
  const hasVelocityGlobal = typeof session.swingVelocity === 'number'
                            && Number.isFinite(session.swingVelocity)
                            && (session.swingVelocity as number) >= 0;
  const smoothstep = (t: number): number => {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
  };
  const VELOCITY_SCALE_MAX = 2.5;  // px/ms — выше этого scale = max
  const velNorm = hasVelocityGlobal
    ? smoothstep((session.swingVelocity as number) / VELOCITY_SCALE_MAX)
    : 1.0;
  const isDropModeGlobal = typeof session.spawnX === 'number'
                           && typeof session.spawnZ === 'number';
  const horizontalScale = hasVelocityGlobal
    ? 0.30 + (1.00 - 0.30) * velNorm
    : (isDropModeGlobal ? 0.30 : 1.0);  // fallback: drop-mode без velocity → 0.30, иначе 1.0
  // ── v3m (fix «медленно летят вперёд, кувыркаясь»): ──
  // Раньше было `0.05 + 0.90 * velNorm`. При типичном drag-flick (v=1.0 px/ms)
  // velNorm ≈ 0.35 → horizontalScale ≈ 0.37 → forward impulse только 37% от
  // пресета → кубы летели МЕДЛЕННО вперёд при нормальном броске. Жалоба:
  // «у 3D кубов опять сломалась физика — они просто медленно летят вперёд,
  // кувыркаясь».
  //
  // Теперь: `0.30 + 0.70 * velNorm`. При v=1.0 → 0.55 (было 0.37) — кубы
  // получают 55% пресета вместо 37%, заметно бодрее. При v=0 (медленный
  // отпуск) → 0.30 (было 0.05) — даже медленный бросок получает минимум 30%
  // импульса, не «камни падают». При v=2.5 (fast flick) → 1.00 (как было).
  // «Сильно бросил = далеко полетели» сохраняется.
  // verticalScale УБЫВАЕТ с ростом скорости: 1.00 (медленно) → 0.80 (быстро).
  // Сильный бросок = площе (мощный прямой полёт), медленный = более высокая дуга.
  //
  // v3l (fix «нет нормальной анимации падения и отскока»):
  //   Раньше было 0.70 → 0.55. При swingVelocity=1.0 (типичный drag-flick)
  //   velNorm≈0.35, verticalScale≈0.65 → vy = 3.8×0.65 = 2.47 м/с →
  //   пиковая высота 2.47²/28 = 0.218 единиц, импакт v≈2.47 →
  //   отскок = 2.47×0.36 = 0.89 м/с → высота отскока 0.89²/28 = 0.028 единиц.
  //   0.028 единиц при камере на высоте 12 = НЕВИДИМО. Жалоба: «нет нормальной
  //   анимации того как кубы падают и отскакивают».
  //
  //   Теперь 1.00 → 0.80. При swingVelocity=1.0 → verticalScale≈0.93 →
  //   vy = 3.8×0.93 = 3.53 м/с → пик 0.446, импакт 3.53 →
  //   отскок = 3.53×0.36 = 1.27 м/с → высота отскока 1.27²/28 = 0.058 единиц.
  //   0.058 единиц = ВИДНЫЙ отскок (в 2 раза выше порога видимости 0.03).
  //
  //   Lob НЕ возвращается: preset автоматически не выдаёт 'lob' (capped на
  //   'power', vyMax=3.8). Даже при verticalScale=1.0 пик = 3.8²/28 = 0.515
  //   единиц — это умеренная дуга, а не навес (lob = vy 6+ → пик > 1.2).
  //   «Сильный = площе» сохраняется: fast (v=2.5) → 0.80, slow (v=0) → 1.00.
  const verticalScale = hasVelocityGlobal
    ? 1.00 + (0.80 - 1.00) * velNorm
    : 1.0;
  const angularScale = hasVelocityGlobal
    ? 0.30 + (1.00 - 0.30) * velNorm
    : 1.0;

  // Переключаем кубики из KINEMATIC в DYNAMIC и даём импульс броска.
  // Рапир: body.setBodyType(RAPIER.RigidBodyType.Dynamic, true).
  // После переключения кубик подчиняется физике: gravity, collisions, etc.
  // Используем index-based цикл (i), чтобы сопоставлять кубику его элемент
  // из session.initialAngularVelocity[i] (Вариант A — продолжение вращения).
  const RAPIER_NS = RAPIER as any;
  const dynType = RAPIER_NS.RigidBodyType.dynamic;
  for (let i = 0; i < session.dice.length; i++) {
    const d = session.dice[i];
    try { d.body.setBodyType(dynType, true); } catch {}
    d.body.wakeUp(true);

    // Сохраняем текущую ориентацию (из spinQuat) — кубик летит с тем
    // кручением, которое накопил за секунду вращения. Плюс добавляем
    // импульс линейный (вперёд + вверх) и угловой (доп. кручение в полёте).
    // Параметры импульса берутся из пресета броска (gentle/normal/power/lob/scatter).
    //
    // ── Fan-паттерн (fix «слипания»): ──
    // Кубики стартуют в сетке 2×2 с центрами на ±0.24 X (col 0 = слева, col 1 = справа).
    // Добавляем направленный боковой импульс: sign(basePos.x) * spreadBias.
    //   - Левый кубик (x=-0.24) → дополнительный импульс −spreadBias (влево)
    //   - Правый кубик (x=+0.24) → дополнительный импульс +spreadBias (вправо)
    // Это заставляет внешние кубики разлетаться в стороны → НЕ сваливаются в кучу.
    // + vyMin/vyMax диапазон → кубики пикуют на разной высоте → нет mid-air столкновений.
    const mass = d.body.mass();
    const p = session.preset;
    const gridXSign = d.basePos.x === 0 ? 0 : (d.basePos.x > 0 ? 1 : -1);
    const spreadX = gridXSign * p.spreadBias;
    // Направление броска по Z зависит от originSide:
    //   'near' → −Z (вглубь экрана, от игрока) — как было раньше
    //   'far'  → +Z (на игрока, из глубины экрана)
    // Это позволяет двум игрокам бросать навстречу друг другу (VS roll).
    const zSign = session.originSide === 'far' ? +1 : -1;

    // ── DRAG-ROLL: вращение импульса по направлению жеста ──
    // Когда session.direction задан (drag-бросок), вращаем импульс на этот
    // угол. Кубы летят В НАПРАВЛЕНИИ ЖЕСТА: махнул вправо → кубы вправо,
    // махнул вверх → вперёд, махнул вниз → назад, махнул влево → влево.
    //
    // Конвенция угла (сверху, CCW от −Z):
    //   θ = 0     → вперёд (−Z)
    //   θ = π/2   → вправо (+X)
    //   θ = π     → назад (+Z)
    //   θ = −π/2  → влево (−X)
    //
    // Rotation matrix (в плоскости XZ, вокруг оси Y):
    //   new_vx = base_vx · cos(θ) − base_vz · sin(θ)
    //   new_vz = base_vx · sin(θ) + base_vz · cos(θ)
    //
    // Базовый импульс ВСЕГДА "вперёд" (base_vz < 0) — direction сам задаёт
    // итоговое направление. zSign/originSide при drag-roll не нужен для
    // импульса (он уже учтён в direction), но продолжает работать для
    // spawn-position (стакан стоит на нужном краю арены).
    //
    // Если direction НЕ задан (кнопка-бросок, VS, mass-roll) — оригинальная
    // логика с zSign сохраняется (обратная совместимость).
    //
    // ── VELOCITY-BASED IMPULSE SCALING (drag-roll realism mode) ──
    // horizontalScale, verticalScale, angularScale вычислены ОДИН РАЗ до
    // цикла (см. выше) из session.swingVelocity через smoothstep. Они дают:
    //   медленный отпуск → кубы мягко падают с дугой на месте ("поставил")
    //   быстрый flick → кубы летят далеко, ПЛОСКО и с кручением ("бросил с размаху")
    // ВАЖНО: verticalScale УБЫВАЕТ с скоростью (0.70→0.55) — сильный бросок =
    // ПЛОСКИЙ, а не навес. 'lob' пресет НЕ выдаётся автоматически по скорости.
    // Если swingVelocity НЕ задана → все scale = 1.0 (кнопка-бросок/VS/mass).
    const hasDirection = typeof session.direction === 'number'
                         && Number.isFinite(session.direction)
                         && Math.abs(session.direction) > 0.001;
    let impX: number;
    let impZ: number;
    if (hasDirection) {
      const theta = session.direction as number;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      // Базовый "вперёд" импульс (отрицательный Z). magnitude из пресета.
      const forwardMag = mass * rnd(p.vzMin, p.vzMax) * horizontalScale;
      const baseVz = -forwardMag;
      // Латеральный импульс (fan-паттерн + случайный из пресета).
      const baseVx = mass * (rnd(p.vxMin, p.vxMax) + spreadX) * horizontalScale;
      // Вращаем (baseVx, baseVz) на угол θ вокруг Y.
      impX = baseVx * cosT - baseVz * sinT;
      impZ = baseVx * sinT + baseVz * cosT;
    } else {
      // Оригинальная логика (кнопка/VS/mass) — без вращения.
      impX = mass * (rnd(p.vxMin, p.vxMax) + spreadX) * horizontalScale;
      impZ = zSign * mass * rnd(p.vzMin, p.vzMax) * horizontalScale;
    }
    // Вертикальный импульс (vy) — масштабируется от velocity отдельно.
    // Это даёт "медленно → низкая дуга, быстро → высокая дуга".
    d.body.applyImpulse({
      x: impX,
      y: mass * rnd(p.vyMin, p.vyMax) * verticalScale,
      z: impZ,
    }, true);

    // ── Реалистичное кручение броска (НЕ переносим SHAKE-спин!) ──
    // SHAKE-спин (d.spinSpeed = 32-54 рад/с) нужен ТОЛЬКО для визуального
    // "трясём стакан в руке" в фазе 1 (kinematic, 120мс). При переносе в
    // dynamic тело он делает кубики "волчками": вращаются на месте 2.5с,
    // потом force-tip телепортирует их вверх и они падают отвесно →
    // пользователь видит "кубы просто вращаются на месте и падают".
    //
    // Реальный бросок кубика рукой = 5-20 рад/с. Берём angMin/angMax из
    // пресета (power: 12-20, normal: 10-16, gentle: 5-9, lob: 16-26).
    // С таким кручением кубик кувыркается в полёте, приземляется на грань
    // и успокаивается за 1.5-2с БЕЗ force-tip.
    //
    // angularScale от velocity: медленный отпуск → лёгкое кручение (кубы
    // почти не кувыркаются, просто падают), быстрый flick → полное кручение
    // пресета (кубы кувыркаются в полёте как настоящий бросок).
    //
    // ── ВАРИАНТ A: initialAngularVelocity — продолжение вращения held-dice ──
    // Если клиент передал initialAngularVelocity[i] (drag-бросок, кубы
    // вращались в HeldDiceController), используем ЭТУ угловую скорость вместо
    // throwSpin пресета. Брошенные кубы ПРОДОЛЖАЮТ вращение удерживаемых
    // (та же ось + скорость) → бесшовный handoff "те же кубы полетели".
    // Иначе — throwSpin пресета (как раньше).
    const providedAngVel = session.initialAngularVelocity
      && i < session.initialAngularVelocity.length
      ? session.initialAngularVelocity[i]
      : null;
    if (providedAngVel) {
      // ── v3m (fix «медленно летят вперёд, кувыркаясь»): масштабируем
      //   providedAngVel на angularScale. ──
      // Раньше: providedAngVel использовался КАК ЕСТЬ (8-14 рад/с от
      // held-dice). При медленном drag (angularScale=0.30) кубы получали
      // ПОЛНУЮ угловую скорость 8-14 рад/с, но МАЛЫЙ linear impulse →
      // «только кувыркаются на месте, еле летят».
      //
      // Теперь: providedAngVel × angularScale — медленный drag = лёгкое
      // кручение (2.4-4.2 рад/с), быстрый flick = полное (8-14 рад/с).
      // Это соответствует логике preset throwSpin (который тоже масштабируется
      // angularScale). Кувыркание соответствует силе броска.
      d.body.setAngvel({
        x: providedAngVel[0] * angularScale,
        y: providedAngVel[1] * angularScale,
        z: providedAngVel[2] * angularScale,
      }, true);
    } else {
      const throwSpin = rnd(p.angMin, p.angMax) * angularScale;
      d.body.setAngvel({
        x: d.spinAxis[0] * throwSpin,
        y: d.spinAxis[1] * throwSpin,
        z: d.spinAxis[2] * throwSpin,
      }, true);
    }
    try { d.body.setLinearDamping(LINEAR_DAMPING); } catch {}
    try { d.body.setAngularDamping(ANGULAR_DAMPING); } catch {}
  }
  log(`[release] Session ${session.id} → cup opened, dice thrown (preset=${session.preset.name}, vy=[${session.preset.vyMin}-${session.preset.vyMax}]×${verticalScale.toFixed(2)}, vz=[${session.preset.vzMin}-${session.preset.vzMax}]×${horizontalScale.toFixed(2)}, throwSpin=[${session.preset.angMin}-${session.preset.angMax}]×${angularScale.toFixed(2)} rad/s, swingVel=${session.swingVelocity !== undefined ? session.swingVelocity.toFixed(2) + 'px/ms' : 'none'}, shake=${SHAKE_DURATION_MS}ms)`);
}

// ---------------------------------------------------------------------------
// Перемешивание: трясём стакан. Стенки (kinematic) осциллируют — двигаются
// по X/Y/Z и наклоняются. Dynamic-кубики внутри сталкиваются со стенками
// и друг с другом → РЕАЛЬНОЕ перемешивание граней через физику.
// Кубики не управляются процедурно — их движение определяется только
// столкновениями. Это и есть "перемешать в руке".
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Процедурное вращение kinematic-кубиков в фазе 1.
// Каждый кадр: поворачиваем кватернион кубика вокруг его хаотичной оси на
// spinSpeed * dt. Позиция остаётся неизменной → кубик КРУТИТСЯ НА МЕСТЕ.
// Это ровно то, что просил пользователь: "секунду хаотично вращаются на месте".
// ---------------------------------------------------------------------------

function applySpin(session: RollSession, dtSec: number): void {
  for (const d of session.dice) {
    // Угол поворота за этот кадр
    const angle = d.spinSpeed * dtSec;
    const half = angle * 0.5;
    const s = Math.sin(half);
    const c = Math.cos(half);
    // Дельта-кватернион: вращение вокруг d.spinAxis на angle
    const dqx = d.spinAxis[0] * s;
    const dqy = d.spinAxis[1] * s;
    const dqz = d.spinAxis[2] * s;
    const dqw = c;

    // Новый кватернион = dq * q (премножение — вращение в world space)
    const q = d.spinQuat;
    const nx = dqx * q.w + dqy * q.z - dqz * q.y + dqw * q.x;
    const ny = -dqx * q.z + dqy * q.w + dqz * q.x + dqw * q.y;
    const nz = dqx * q.y - dqy * q.x + dqz * q.w + dqw * q.z;
    const nw = -dqx * q.x - dqy * q.y - dqz * q.z + dqw * q.w;
    // Нормируем (на случай численного дрейфа)
    const nlen = Math.sqrt(nx*nx + ny*ny + nz*nz + nw*nw) || 1;
    d.spinQuat = { x: nx/nlen, y: ny/nlen, z: nz/nlen, w: nw/nlen };

    // Применяем к kinematic-телу: позиция фиксирована, только вращение
    d.body.setNextKinematicTranslation({ x: d.basePos.x, y: d.basePos.y, z: d.basePos.z });
    d.body.setNextKinematicRotation(d.spinQuat);
  }

  // Стакан тоже чуть-чуть трясём для атмосферы (визуально невидим, но
  // добавляет лёгкое движение — рука "держит" кубики). Малая амплитуда.
  // Множители пресета позволяют усилить/ослабить тряску для разных бросков.
  const t = (Date.now() - session.startedAt) / 1000;
  const p = session.preset;
  const amp = CUP_SHAKE_AMP * p.shakeAmpMul;
  const f = CUP_SHAKE_FREQ * p.shakeFreqMul;
  const ox = Math.sin(t * f) * amp;
  const oy = Math.sin(t * f * 1.7 + 0.9) * amp * 0.4;
  const oz = Math.cos(t * f * 0.85 + 0.4) * amp;
  session.cupBody.setNextKinematicTranslation({
    x: session.cupBaseX + ox,
    y: session.cupBaseY + oy,
    z: session.cupBaseZ + oz,
  });
  const tiltX = Math.sin(t * f * 0.72 + 0.3) * CUP_TILT_AMP * p.shakeAmpMul;
  const tiltZ = Math.cos(t * f * 0.81 + 1.1) * CUP_TILT_AMP * p.shakeAmpMul;
  const tiltY = Math.sin(t * f * 0.45) * CUP_TILT_AMP * p.shakeAmpMul * 0.3;
  const cx = Math.cos(tiltX * 0.5), sx = Math.sin(tiltX * 0.5);
  const cy = Math.cos(tiltY * 0.5), sy = Math.sin(tiltY * 0.5);
  const cz = Math.cos(tiltZ * 0.5), sz = Math.sin(tiltZ * 0.5);
  session.cupBody.setNextKinematicRotation({
    x: sx * cy * cz,
    y: sy * cx * cz + cy * sx * sz,
    z: sy * sx * cz - cy * cx * sz,
    w: cy * cx * cz - sy * sx * sz,
  });
}

// ---------------------------------------------------------------------------
// Nudge a die that's resting on an edge/corner — apply a small hop + torque
// to tip it onto a face. Physics will resolve the new state naturally.
//
// v2 (THIS): stronger nudge. v1's hopUp=0.05 (6cm) + tipTorque=0.006 (4 rad/s)
// was too weak — dice on edges (center of mass above pivot) couldn't be tipped
// over. After 5× weak nudges, dice were STILL on edges (dot 0.7-0.89) → hard
// timeout. Now: hopUp=0.12 (12cm — enough to clear the edge), tipTorque=0.018
// (12 rad/s — 2× the torque needed to rotate 45° in 0.1s for a 0.04kg die).
// ---------------------------------------------------------------------------

function nudgeDieOffEdge(d: DieBody): void {
  const angle = Math.random() * Math.PI * 2;
  // Stronger hop + torque to actually tip dice off edges (v1 was too weak)
  const hopUp = 0.12;       // ~2.8 m/s upward for a 0.04kg die → ~12cm hop (clears edge)
  const hopLat = 0.024;     // 2× lateral drift (was 0.012) — pushes die off the pivot point
  const tipTorque = 0.018;  // ~12 rad/s angular velocity change — 2× the torque needed for 45° tip
  try {
    d.body.applyImpulse(
      { x: Math.cos(angle) * hopLat, y: hopUp, z: Math.sin(angle) * hopLat },
      true,
    );
    d.body.applyTorqueImpulse(
      { x: Math.cos(angle) * tipTorque, y: 0, z: Math.sin(angle) * tipTorque },
      true,
    );
    d.body.wakeUp();
  } catch {}
}

// ── FORCE-TIP — агрессивное прекращение spinning-in-place ──
// nudgeDieOffEdge слишком слаб для кубика, вращающегося как волчок (ω>1 рад/с):
// маленький hop (6см) + слабый tip torque (4 рад/с) не могут преодолеть
// гироскопический эффект быстрого вращения. Кубик просто продолжает крутиться.
//
// forceTipDie:
//   1. ПОЛНОСТЬЮ обнуляет угловую скорость (убивает spinning)
//   2. Даёт сильный upward hop (~50см) — кубик подлетает и падает
//   3. Даёт сильный tip torque (~12 рад/с) — кубик кувыркается в воздухе
//   4. Приземляется на случайную грань (не на ребро)
//
// Это «emergency» мера — применяется только к кубикам, которые крутятся >2.5с.
// Нормальные броски (кубик падает на грань за 1-2с) НЕ затрагиваются.
// snapToNearestFace — deterministic snap die to its nearest face-up orientation.
// Used at soft timeout when nudge failed (die still on edge). Single-frame
// rotation change, invisible at 30fps. Reflects actual physics orientation
// (not random) — reads current rotation, finds closest face, snaps it up.
function snapToNearestFace(d: DieBody): void {
  const curRot = d.body.rotation();
  const { idx, dot } = getUpFaceAlignment(curRot.x, curRot.y, curRot.z, curRot.w);
  const [nx, ny, nz] = FACE_NORMALS[idx];
  const [qx, qy, qz, qw] = quaternionFromTo(nx, ny, nz, 0, 1, 0);
  try {
    d.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    d.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    const t = d.body.translation();
    const minY = DIE_HALF + 0.02;
    const newY = Math.max(t.y, minY);
    d.body.setTranslation({ x: t.x, y: newY, z: t.z }, true);
    d.body.setRotation({ x: qx, y: qy, z: qz, w: qw }, true);
    d.body.wakeUp();
  } catch {}
}

function forceTipDie(d: DieBody): void {
  // ── KILL-AND-DROP approach (v3) ──
  //
  // HISTORY of this function (don't repeat past mistakes):
  //
  // v1 (kill + applyImpulse + tip torque): Die hopped, spun at 14 rad/s from
  //   the torque, landed on edge, immediately spun up again. 4× cycles.
  //
  // v2 (lift-and-drop 1.2m + tumble 3-7 rad/s on X/Z + ±1.0 rad/s on Y):
  //   BROKEN. The tumble (3-7 rad/s) was DIRECTLY detected as spinning on the
  //   next check (0.5s later). Worse, the Y component (±1 rad/s) was a direct
  //   vertical spin — the very "spinning top" we were trying to kill. And
  //   contact dynamics converted X/Z tumble to Y spin on landing. Result:
  //   5× force-tip cycles each leaving the die at 4-5 rad/s → hard timeout.
  //   Logs (roll-1785758068422-0jyj5y): w=12.81 → 4.76 → 5.62 → 2.97 → 5.01.
  //
  // v3a (lift-and-drop 0.5m + random Euler rotation + tiny tumble 0.4-0.8):
  //   PARTIAL. Spinning was fixed (no more 5× force-tip cycles), BUT random
  //   Euler rotation put dice near edges ~57% of the time. After force-tip,
  //   dice landed on edges (dot 0.7-0.89) → 5× weak nudge cycles → still
  //   slow (5-7s). Logs (dual-test-8): force-tip #1 → nudge #2,3,4,5.
  //
  // v3e (THIS): kill spin + snap to face-up rotation AT CURRENT POSITION.
  //   NO teleport up. Die just stops spinning and is face-up where it is.
  //   Gravity drops it the remaining distance to the table (usually <5cm
  //   since it was spinning on the table surface). Nearly invisible at 30fps.
  //
  //   v3d (previous) teleported the die UP 0.18m then dropped it — user saw
  //   "кубы висят в воздухе а потом тупо падают" (dice hang in the air then
  //   just fall). The upward teleport was the visible "hang", and the drop
  //   was the "fall". v3e removes the teleport entirely:
  //     1. Kill angular velocity (stop spinning)
  //     2. Kill linear velocity (stop drifting)
  //     3. Snap to a RANDOM FACE-UP rotation (single-frame change at 30fps)
  //     4. Ensure y >= DIE_HALF + 0.02 (2cm clearance if on edge)
  //     5. Tiny tumble 0.3-0.5 рад/с (below SPINNING_ANG_THRESHOLD=1.0)
  //   Die drops ≤2cm and lands flat. No visible "pop" or "hang".
  //
  //   NOTE: с фиксом throw-spin (presets now use angMin/angMax 14-20 для
  //   power вместо SHAKE spinSpeed 32-54), force-tip срабатывает РЕДКО —
  //   только для настоящих edge cases (кубик застрял на углу и крутится).
  //
  //   v3f (THIS): snap to NEAREST face-up (deterministic), NOT random.
  //   v3e used Math.floor(Math.random()*6) which made the result partially
  //   random — the die could land showing any face regardless of physics.
  //   v3f reads the current orientation via getUpFaceAlignment and snaps
  //   THAT face straight up. The result reflects the die's actual physics
  //   orientation at the moment of force-tip. Deterministic + fair.

  const angle = Math.random() * Math.PI * 2;

  // 1. Kill ALL velocities — stop the spinning top completely
  try { d.body.setAngvel({ x: 0, y: 0, z: 0 }, true); } catch {}
  try { d.body.setLinvel({ x: 0, y: 0, z: 0 }, true); } catch {}

  // 2. Snap to the NEAREST FACE-UP rotation at the CURRENT position.
  //    Read current orientation → find which face is most "up" → snap
  //    that face to perfectly up. Deterministic: reflects real physics.
  //    No teleport up — die stays where it is. If it was on an edge at
  //    y≈0.22, we nudge it up just 2cm to clear the edge pivot point.
  const t = d.body.translation();
  const curRot = d.body.rotation();
  const { idx: faceIdx } = getUpFaceAlignment(curRot.x, curRot.y, curRot.z, curRot.w);
  const [nx, ny, nz] = FACE_NORMALS[faceIdx];
  const [qx, qy, qz, qw] = quaternionFromTo(nx, ny, nz, 0, 1, 0);
  try {
    // Only lift if below resting height + 2cm clearance. If the die is
    // already airborne (y > 0.24), leave it — gravity will bring it down.
    const minY = DIE_HALF + 0.02;  // 0.24
    const newY = Math.max(t.y, minY);
    d.body.setTranslation({ x: t.x, y: newY, z: t.z }, true);
    d.body.setRotation({ x: qx, y: qy, z: qz, w: qw }, true);
  } catch {}

  // 3. TINY tumble (0.3-0.5 рад/с) — barely visible natural rotation.
  //    Below SPINNING_ANG_THRESHOLD (1.0) → doesn't re-trigger force-tip.
  //    X/Z axis only, NO Y component → no "spinning top" effect.
  const tumbleSpeed = 0.3 + Math.random() * 0.2;  // 0.3-0.5 рад/с
  const tax = Math.cos(angle);
  const taz = Math.sin(angle);
  try {
    d.body.setAngvel({
      x: tax * tumbleSpeed,
      y: 0,
      z: taz * tumbleSpeed,
    }, true);
  } catch {}

  // 4. Tiny horizontal drift (0.05-0.1 m/s) — prevents dice from overlapping.
  //    Friction stops it in <0.2s. Very small to avoid tipping torque.
  const driftSpeed = 0.05 + Math.random() * 0.05;
  try {
    d.body.setLinvel({
      x: Math.cos(angle) * driftSpeed,
      y: 0,
      z: Math.sin(angle) * driftSpeed,
    }, true);
  } catch {}

  d.body.wakeUp();
}

// ---------------------------------------------------------------------------
// Post-settle separation — разводим кубики, которые проникли друг в друга.
//
// ПРОБЛЕМА: для массовых бросков коллизия между сессиями отключена (каждая
// сессия в своей collision-группе). Внутри сессии 4 кубика тоже могут
// «сложиться» в одну точку если solver не успел разрешить пенетрацию до
// settle. Визуально кубики «слипаются» — центры ближе DIE_SIZE (0.44).
//
// РЕШЕНИЕ: ОДИН проход (single pass) позиционной коррекции ПОСЛЕ того как
// кубики замерли, ПЕРЕД финализацией.
//   • Для каждой пары (i,j) с dist < DIE_SIZE — раздвинуть по горизонтали
//   • Каждый кубик сдвигается на half-overlap + 1мм зазор
//   • Ориентация СОХРАНЯЕТСЯ (face-up результат НЕ меняется)
//   • Скорости обнуляются (кубик не «улетает» после развода)
//   • Однократный проход — НЕ итеративный (избегаем цепного эффекта:
//     развели A↔B, A наехало на C, C наехало на D… бесконечное движение)
//
// Цепной эффект невозможен: после развода скорости = 0, кубики не двигаются.
// Если A и C оказались в пенетрации после развода A↔B — это остаётся как есть
// (один проход, не переназначается). Это лучше чем бесконечное движение.
//
// КРОСС-СЕССИОННАЯ проверка: когда сессия X финализируется, её кубики
// проверяются также против кубиков ДРУГИХ активных сессий (которые ещё не
// финализированы). Двигаются ТОЛЬКО кубики сессии X (направленный развод),
// чужие кубики не трогаем → нет цепного эффекта между сессиями.
// ---------------------------------------------------------------------------

const SEPARATION_MIN_OVERLAP = 0.008;  // 8мм — игнорируем микропенетрации (solver jitter 1-3мм)
const SEPARATION_GAP = 0.002;          // +2мм зазор после развода (чтобы не касались)

function separateOverlappingDice(session: RollSession): boolean {
  const dice = session.dice;
  if (dice.length < 2) return false;
  const minDist = DIE_HALF * 2;  // 0.44 — минимум между центрами
  let separated = false;

  // ── ВНУТРИ-СЕССИОННЫЙ проход: пары (i, j) в этой сессии ──
  // Оба кубика двигаются симметрично (по half-overlap каждый).
  for (let i = 0; i < dice.length; i++) {
    for (let j = i + 1; j < dice.length; j++) {
      const a = dice[i].body.translation();
      const b = dice[j].body.translation();
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const distSq = dx * dx + dz * dz;  // только горизонталь (кубы на столе)
      if (distSq >= minDist * minDist) continue;
      const dist = Math.sqrt(distSq) || 0.0001;
      const overlap = minDist - dist;
      if (overlap < SEPARATION_MIN_OVERLAP) continue;
      // Ось развода (горизонтальная). Если кубики стоят в одной точке (dist≈0) —
      // выбираем случайное направление.
      let ax = dx / dist;
      let az = dz / dist;
      if (dist < 0.01) {
        const ang = Math.random() * Math.PI * 2;
        ax = Math.cos(ang);
        az = Math.sin(ang);
      }
      const halfSep = overlap / 2 + SEPARATION_GAP;
      try {
        // Двигаем оба кубика (симметрично), сохраняем Y и ориентацию
        dice[i].body.setTranslation({
          x: a.x - ax * halfSep,
          y: Math.max(a.y, DIE_HALF),
          z: a.z - az * halfSep,
        }, true);
        dice[j].body.setTranslation({
          x: b.x + ax * halfSep,
          y: Math.max(b.y, DIE_HALF),
          z: b.z + az * halfSep,
        }, true);
        // Обнуляем скорости — кубик не должен «уехать» после развода
        dice[i].body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        dice[j].body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        dice[i].body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        dice[j].body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        separated = true;
      } catch {}
    }
  }

  // ── КРОСС-СЕССИОННЫЙ проход: кубики этой сессии vs чужие активные ──
  // Двигаем ТОЛЬКО кубики текущей сессии (направленный развод).
  // Чужие кубики не трогаем — они ещё могут двигаться (своё settle pending).
  for (const other of sessions.values()) {
    if (other === session || other.finalized) continue;
    for (const myDie of dice) {
      for (const otherDie of other.dice) {
        const a = myDie.body.translation();
        const b = otherDie.body.translation();
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const distSq = dx * dx + dz * dz;
        if (distSq >= minDist * minDist) continue;
        const dist = Math.sqrt(distSq) || 0.0001;
        const overlap = minDist - dist;
        if (overlap < SEPARATION_MIN_OVERLAP) continue;
        let ax = dx / dist;
        let az = dz / dist;
        if (dist < 0.01) {
          const ang = Math.random() * Math.PI * 2;
          ax = Math.cos(ang);
          az = Math.sin(ang);
        }
        // Двигаем только СВОЙ кубик ОТ чужого (на полный overlap + gap)
        const fullSep = overlap + SEPARATION_GAP;
        try {
          myDie.body.setTranslation({
            x: a.x - ax * fullSep,
            y: Math.max(a.y, DIE_HALF),
            z: a.z - az * fullSep,
          }, true);
          myDie.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          myDie.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          separated = true;
        } catch {}
      }
    }
  }

  if (separated) {
    log(`[separate] Session ${session.id} — развели слепленные кубики (single pass)`);
  }
  return separated;
}

// ---------------------------------------------------------------------------
// Settle detection — кубики замерли И верхняя грань чётко смотрит вверх
// ---------------------------------------------------------------------------

function checkSettled(session: RollSession, now: number): boolean {
  // Hard timeout — независимо ни от чего финализируем.
  // НЕ делаем snap ориентации! readResult() читает ближайшую грань через
  // getUpFaceAlignment (max dot product) — результат корректен даже если
  // куб на ребре. Snap был виден как "магнитится к столу" — убран.
  if (now - session.startedAt > MAX_SESSION_MS) {
    // Hard timeout — разводим слепленные кубики ПЕРЕД снапшотом,
    // чтобы клиент увидел финальные разделённые позиции.
    separateOverlappingDice(session);
    emitSnapshot(session);
    return true;
  }

  // Минимальная продолжительность броска — кубики должны успеть упасть и покувыркаться
  if (now - session.startedAt < MIN_ROLL_MS) return false;

  // ── SPINNING-IN-PLACE DETECTION ──
  // Кубик может приземлиться на ребро/угол и вращаться как волчок (low linvel,
  // high angvel). angular damping (0.35) слишком медленно останавливает это.
  // После SPINNING_DETECT_MS — forceTipDie: убиваем angvel + сильный tip.
  if (now - session.startedAt > SPINNING_DETECT_MS) {
    for (const d of session.dice) {
      if (!d.body.isDynamic()) continue;
      const v = d.body.linvel();
      const a = d.body.angvel();
      const linSq = v.x * v.x + v.y * v.y + v.z * v.z;
      // v3f: detect Y-dominant spin (true spinning-top on edge), NOT X/Z tumble.
      // A die resting on a face with residual X/Z tumble stops in <1s via
      // friction (full contact area = strong torque arm). A die on an EDGE
      // spinning around Y barely decelerates (point contact = no torque arm).
      // Only force-tip the latter.
      const ySpin = Math.abs(a.y);
      const xzSpin = Math.sqrt(a.x * a.x + a.z * a.z);
      if (linSq < SPINNING_LIN_THRESHOLD * SPINNING_LIN_THRESHOLD &&
          ySpin > SPINNING_ANG_THRESHOLD &&
          ySpin > xzSpin * 1.5) {
        if (d.nudgeCount < MAX_NUDGES && now - d.lastNudgeAt > 400) {
          forceTipDie(d);
          d.nudgeCount++;
          d.lastNudgeAt = now;
          log(`[force-tip] Session ${session.id} die ${d.index} spinning-top (wY=${ySpin.toFixed(2)} rad/s, wXZ=${xzSpin.toFixed(2)}), force-tip #${d.nudgeCount}`);
          session.firstSleepAt = null;
        }
      }
    }
  }

  // v3h: settle check — только LINEAR rest, не angular.
  // ПРОБЛЕМА: кубик на ребре НИКОГДА не имеет |ω| < 0.3 — gravity создаёт
  // torque на ребре, die постоянно микрокачается. Старый check (|ω| < 0.3)
  // никогда не выполнялся для edge-landers → ждали soft timeout 3.5с.
  // РЕШЕНИЕ: требуем только |v| < SETTLE_LIN_THRESHOLD (0.5 м/с). Angular
  // rest не нужен — force-tip (выше) уже обработал spinning-tops (Y-spin>4).
  // ПОРОГ 0.5 (не 0.15): кубик на ребре микроколеблется — gravity tip'ает,
  // ground damping замедляет, gravity снова tip'ает. Равновесие ~0.15-0.3
  // м/с. Порог 0.15 пропускал это → ждали 3.5с. 0.5 м/с = 5см/с = визуально
  // статично. snapToNearestFace фиксит ориентацию, результат детерминирован.
  const SETTLE_LIN_THRESHOLD = 0.5;
  let allSlow = true;
  let anyMovingLinear = false;
  for (const d of session.dice) {
    if (!d.body.isDynamic()) continue;  // kinematic = замерший
    const v = d.body.linvel();
    const linSq = v.x * v.x + v.y * v.y + v.z * v.z;
    if (linSq > SETTLE_LIN_THRESHOLD * SETTLE_LIN_THRESHOLD) {
      allSlow = false;
      anyMovingLinear = true;
    }
  }

  if (allSlow) {
    if (session.firstSleepAt === null) {
      session.firstSleepAt = now;
    } else if (now - session.firstSleepAt >= SETTLE_STABILITY_MS) {
      // v3h: кубики замерли (220мс покоя). Если кто-то на ребре — SNAP к
      // ближайшей грани немедленно (1 кадр, невидимо). Не делаем слабые
      // nudge (они не работают — die 0 dot=0.643 после 2 тычков всё ещё на
      // ребре). Ground damping уже остановил кручение → кубик реально стоит
      // на ребре → snap детерминированно даёт ближайшую грань.
      let snappedAny = false;
      for (const d of session.dice) {
        const r = d.body.rotation();
        const { dot } = getUpFaceAlignment(r.x, r.y, r.z, r.w);
        if (dot < EDGE_THRESHOLD) {
          snapToNearestFace(d);
          snappedAny = true;
          log(`[snap-rest] Session ${session.id} die ${d.index} at rest on edge (dot=${dot.toFixed(3)}) → snapped to nearest face`);
        }
      }
      if (snappedAny) {
        separateOverlappingDice(session);
      }
      // All dice now face-up (either naturally or via snap) → finalize.
      separateOverlappingDice(session);
      emitSnapshot(session);
      return true;
    }
  } else if (anyMovingLinear) {
    // Кубик ещё катится по столу → сбрасываем таймер покоя.
    // Если кубик только крутится на месте (low linvel, high angvel) — НЕ сбрасываем,
    // force-tip (выше) уже обработал этот случай.
    session.firstSleepAt = null;
  }

  // Soft timeout — если SETTLE_TIMEOUT_MS прошло, финализируем.
  // v3g: если кубик на ребре — SNAP к ближайшей грани немедленно (один кадр),
  // не 5 раундов слабых тычков. Снап детерминированный (ближайшая грань =
  // то, что физика уже почти решила). Невидимо при 30fps.
  if (now - session.startedAt > SETTLE_TIMEOUT_MS) {
    let snappedAny = false;
    for (const d of session.dice) {
      const r = d.body.rotation();
      const { dot } = getUpFaceAlignment(r.x, r.y, r.z, r.w);
      if (dot < EDGE_THRESHOLD) {
        snapToNearestFace(d);
        snappedAny = true;
        log(`[snap] Session ${session.id} die ${d.index} on edge (dot=${dot.toFixed(3)}) at soft timeout → snapped to nearest face`);
      }
    }
    if (snappedAny) {
      // Snap может чуть изменить позиции — разводим слепленные кубики.
      separateOverlappingDice(session);
    }
    separateOverlappingDice(session);
    emitSnapshot(session);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Чтение результата
// ---------------------------------------------------------------------------

function readResult(session: RollSession): { dice: number[]; total: number } {
  const dice: number[] = [];
  let total = 0;
  for (const d of session.dice) {
    const r = d.body.rotation(); // {x,y,z,w}
    const { idx, dot } = getUpFaceAlignment(r.x, r.y, r.z, r.w);
    const value = FACE_SYMBOLS[idx];
    dice.push(value);
    total += value;
    if (dot < EDGE_THRESHOLD) {
      log(`[warn] Session ${session.id} die ${d.index} result=${value} but alignment=${dot.toFixed(3)} (on edge!)`);
    }
  }
  return { dice, total };
}

// ---------------------------------------------------------------------------
// Сбор и отправка снапшота трансформов
// ---------------------------------------------------------------------------

function emitSnapshot(session: RollSession): void {
  if (!io) return;
  const dicePayload = session.dice.map((d) => {
    const p = d.body.translation();
    const r = d.body.rotation();
    return {
      i: d.index,
      p: [Number(p.x.toFixed(4)), Number(p.y.toFixed(4)), Number(p.z.toFixed(4))],
      q: [Number(r.x.toFixed(4)), Number(r.y.toFixed(4)), Number(r.z.toFixed(4)), Number(r.w.toFixed(4))],
    };
  });
  io.emit("dice:transform", {
    sessionId: session.id,
    t: Date.now(),
    dice: dicePayload,
  });
}

// ---------------------------------------------------------------------------
// Финализация сессии
// ---------------------------------------------------------------------------

function finalizeSession(session: RollSession): void {
  if (session.finalized) return;
  session.finalized = true;

  const { dice, total } = readResult(session);
  session.resultEmitted = true;

  if (io) {
    io.emit("dice:result", {
      sessionId: session.id,
      dice,
      total,
      t: Date.now(),
    });
    log(`Session ${session.id} finalized: dice=[${dice.join(",")}] total=${total}`);
  }

  // Удаляем тела из мира. ВАЖНО: явно удаляем collider ПЕРЕД body.
  // В rapier3d-compat removeRigidBody не всегда корректно очищает collider
  // из broadphase → после ~12 бросков накапливаются ghost-collider'ы
  // → CCD начинает сбоить → кубы проваливаются сквозь пол (tunneling).
  for (const d of session.dice) {
    try { if (d.collider) world.removeCollider(d.collider, true); } catch {}
    try { world.removeRigidBody(d.body); } catch {}
  }
  session.dice = [];
  // Удаляем стакан (стенки + тело)
  for (const col of session.cupColliders) {
    try { world.removeCollider(col, true); } catch {}
  }
  try { if (session.cupBody) world.removeRigidBody(session.cupBody); } catch {}
  session.cupColliders = [];
  session.cupBody = null;
  sessions.delete(session.id);

  // Если сессий больше нет — останавливаем симуляцию и воссоздаём world
  // для гарантированно чистого состояния. Это предотвращает накопление
  // ghost-collider'ов в broadphase после многих бросков.
  if (sessions.size === 0) {
    simRunning = false;
    log("No active sessions — simulation paused, rebuilding world for clean state.");
    rebuildWorld();
  }
}

// Отмена сессии (клиент закрыл оверлей до settle)
function cancelSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;
  for (const d of session.dice) {
    try { if (d.collider) world.removeCollider(d.collider, true); } catch {}
    try { world.removeRigidBody(d.body); } catch {}
  }
  session.dice = [];
  // Удаляем стакан (стенки + тело)
  for (const col of session.cupColliders) {
    try { world.removeCollider(col, true); } catch {}
  }
  try { if (session.cupBody) world.removeRigidBody(session.cupBody); } catch {}
  session.cupColliders = [];
  session.cupBody = null;
  sessions.delete(sessionId);
  log(`Session ${sessionId} cancelled.`);
  if (sessions.size === 0) {
    simRunning = false;
    log("No active sessions after cancel — rebuilding world for clean state.");
    rebuildWorld();
  }
}

// ---------------------------------------------------------------------------
// Симуляция (fixed timestep + accumulator)
// ---------------------------------------------------------------------------

function tickSim(): void {
  if (!simRunning || !world) return;

  const now = performance.now();
  const dt = (now - lastTickTime) / 1000;
  lastTickTime = now;

  // ── Стабильный fixed-timestep accumulator (БЕЗ потери времени) ──
  // Раньше было Math.min(dt, 0.05) — это ОТБРАСЫВАЛО реальное время при
  // лагах event loop (GC, socket flush, console.log). Симуляция навсегда
  // отставала на величину лага → кубики "замедлялись" и дёргались.
  //
  // Теперь: clamp до 0.25с (защита от абсурда после паузы), но НЕ отбрасываем
  // время — позволяем acc накапливаться и отрабатываем catch-up шагами.
  // Макс 5 шагов за tick (~83мс) — достаточно чтобы поймать умеренный лаг
  // за один tick. При большем отставании — догоняем за 2-3 tick'а.
  // CCD всё ещё работает: 5 шагов × v_max(6.7м/с) × STEP(1/60) = 0.56м —
  // это чуть больше стороны куба (0.44), но CCD с SOFT_CCD_PREDICTION=0.8
  // имеет горизонт 0.8м → ловит пол. Plus, при больших скоростях куб уже
  // в воздухе (не у пола) → tunneling не страшен.
  const clampedDt = Math.min(dt, 0.25);
  acc += clampedDt;

  // ── Фаза 1 (spin): процедурное вращение / переход к броску (release) ──
  // Для каждой активной неотпущенной сессии: если прошло < SHAKE_DURATION_MS —
  // крутим kinematic-кубики процедурно (applySpin — кватернион обновляется
  // каждый кадр, позиция фиксирована → вращение на месте). Если время вышло —
  // переключаем кубики в dynamic и даём импульс броска (releaseDice).
  // Это должно произойти ДО world.step(), чтобы setNextKinematic*
  // применились в текущем шаге.
  //
  // DRAG-ROLL "in-hand rotation" MODE: если session.initialQuats задан
  // (кубы уже вращались в руке игрока во время drag) — фаза перемешивания
  // ПРОПУСКАЕТСЯ. releaseDice() вызывается немедленно на первом tick'е.
  // Это даёт БЕСШОВНЫЙ бросок: "тащил → отпустил → кубы сразу полетели",
  // без заметной задержки на shake. Случайность результата обеспечивается
  // тем, что ориентации кубов в момент отпускания случайны (зависят от того,
  // сколько времени игрок их тащил).
  {
    const nowMs = Date.now();
    for (const session of sessions.values()) {
      if (session.finalized || session.released) continue;
      // Drag-roll с initialQuats → немедленный release, без shake.
      if (session.initialQuats && session.initialQuats.length > 0) {
        releaseDice(session);
        continue;
      }
      const elapsed = nowMs - session.startedAt;
      if (elapsed >= SHAKE_DURATION_MS) {
        releaseDice(session);
      } else {
        applySpin(session, clampedDt);
      }
    }
  }

  // ── Catch-up шаги: отрабатываем накопленное время БЕЗ потери ──
  // Макс 5 шагов за tick (~83мс симуляции). Если acc больше — остаток
  // переносится на следующий tick (постепенный догон). Только при
  // экстремальном отставании (acc > 10 шагов = 167мс) — clamp к 5 шагам,
  // чтобы избежать spiral of death. Это редчайший случай (GC пауза >150мс).
  let stepped = 0;
  // ── Sub-stepping: при STEP=1/120, один tick (1/60с) даёт 2 шага. ──
  // Лимит 10 шагов (= 83мс симуляции, столько же сколько 5 шагов при 1/60)
  // — защита от spiral of death при лагах event loop.
  while (acc >= STEP && stepped < 10) {
    world.step();
    acc -= STEP;
    stepped++;
  }
  // Защита от spiral of death: если после 10 шагов acc всё ещё огромный —
  // обрезаем (83мс симуляции). Это лучше чем сброс к 0 (видимый скачок):
  // мы теряем немного времени, но плавно.
  if (acc > STEP * 10) acc = STEP * 10;

  // ── VIRTUAL FLOOR: плавная коррекция пенетрации (без snap/teleport/freeze) ──
  //
  // ПРОБЛЕМА: cuboid-vs-cuboid CCD в Rapier ненадёжен для вращающихся кубиков.
  // Кубик, брошенный с vy=3-4.5 м/с и кручением 10-22 рад/с, часто ПРОБИВАЕТ
  // пол при ударе — CCD не успевает поймать коллизию из-за сложной геометрии
  // вращающегося cuboid. Solver потом выталкивает куб обратно, но если
  // пенетрация > 5см, срабатывал safety-freeze: мгновенный SNAP ориентации
  // к ближайшей грани + TELEPORT на y=DIE_HALF + обнуление скоростей +
  // экстремальный damping=30.
  //
  // Пользователь видел это как: «кубы висят над столом а потом магнитятся
  // к нему» — кубик летит/проникает, потом ВНЕЗАПНО щёлкает в face-up грань
  // на высоте стола. Это НЕ похоже на настоящий бросок.
  //
  // РЕШЕНИЕ: полностью убрать safety-freeze и tunnelCount. Вместо этого —
  // ПЛАВНАЯ коррекция каждый кадр:
  //   1. Если центр кубика ниже VIRTUAL_FLOOR_Y (DIE_HALF=0.22):
  //      - Поднять до VIRTUAL_FLOOR_Y + 0.002 (1 кадр, невидимо при 60fps)
  //   2. Если движется вниз (vy < 0):
  //      - Дать отскок: vy = min(|vy| * 0.28, 1.8) м/с вверх
  //      - Затормозить горизонталь: vx,vz *= 0.75 (трение о пол)
  //   3. Угловая скорость СОХРАНЯЕТСЯ — кубик продолжает кувыркаться
  //
  // Кубик отскакивает через RESTITUTION (0.32) когда CCD ловит пол; virtual
  // floor ловит пенетрации которые CCD пропустил. Отскок 0.28 (совпадает с
  // RESTITUTION) → визуально неотличимо от реального отскока. Без snap,
  // без freeze, без teleport — кубик просто плавно отскакивает и катится.
  //
  // Settle detection срабатывает естественно когда скорости падают ниже
  // порога (0.15 м/с, 0.3 рад/с). Nudge обрабатывает кубики на рёбрах.
  // readResult() читает ближайшую грань через getUpFaceAlignment — результат
  // корректен даже если куб на ребре (без snap).
  for (const session of sessions.values()) {
    if (session.finalized) continue;
    if (!session.released) continue;  // фаза перемешивания — кубики в стакане
    for (const d of session.dice) {
      if (!d.body.isDynamic()) continue;  // kinematic (фаза перемешивания)
      const p = d.body.translation();
      const v = d.body.linvel();

      // ── Track previous vy for impact-bounce detection (v3l) ──
      // prevVy = y-velocity из ПРЕДЫДУЩЕГО кадра. Нужен для определения момента
      // импакта: куб летел вниз быстро (prevVy < -1.2) → внезапно затормозился
      // (|v.y| < 0.5) = коснулся пола. Сохраняем ТЕКУЩУЮ скорость для следующего
      // кадра ПОСЛЕ чтения предыдущей.
      const prevVy = d.prevVy;
      d.prevVy = v.y;

      // ── Virtual floor — плавная коррекция пенетрации ──
      // Триггер: проникновение > 5мм (p.y < DIE_HALF - 0.005) И движется вниз
      // (v.y < -0.1). Это исключает микрокоррекции при solver-jitter (1-2мм)
      // когда кубик уже покоится на столе — иначе virtual floor будил бы кубик
      // каждый кадр и мешал settle detection.
      if (p.y < VIRTUAL_FLOOR_Y - 0.005 && v.y < -0.1) {
        try {
          // Поднять до уровня покоя (1 кадр — невидимо при 60fps)
          d.body.setTranslation({ x: p.x, y: VIRTUAL_FLOOR_Y + 0.002, z: p.z }, true);
          // Отскок вверх + трение горизонталей. Угловая скорость сохраняется.
          const bounceVy = Math.min(Math.abs(v.y) * VIRTUAL_FLOOR_BOUNCE, VIRTUAL_FLOOR_MAX_BOUNCE);
          d.body.setLinvel({
            x: v.x * VIRTUAL_FLOOR_FRICTION,
            y: bounceVy,
            z: v.z * VIRTUAL_FLOOR_FRICTION,
          }, true);
          d.body.wakeUp(true);
          // Записываем отскок как lastImpactBounceAt — кулдаун чтобы след.
          // кадр не триггерил impact-bounce повторно (куб уже летит вверх).
          d.lastImpactBounceAt = Date.now();
        } catch {}
      }

      // ── IMPACT-BOUNCE (v3l): edge/corner landing detection ──
      // ПРОБЛЕМА: Rapier's restitution для cuboid-vs-cuboid надёжна ТОЛЬКО при
      // flat-landing (центр ≈ 0.22). При edge/corner-посадке (центр 0.28-0.38)
      // solver гасит вертикальную скорость почти до нуля ДО того, как куб
      // достигнет VIRTUAL_FLOOR_Y (0.215). Куб «шлёпается» на ребро и замирает
      // без отскока. VIRTUAL_FLOOR не срабатывает (куб не ниже 0.215).
      //
      // ФИКС: отслеживаем prevVy. Если куб БЫЛ в быстром спуске (prevVy < -1.2)
      // и внезапно затормозился (|v.y| < 0.5) рядом с полом (p.y < 0.42) — это
      // момент edge/corner-импакта. Применяем отскок на основе prevVy (скорость
      // ДО удара), потому что v.y уже погашена solver'ом.
      //
      // Условия:
      //   1. prevVy < IMPACT_MIN_VY (-1.2) — был быстрый спуск
      //   2. |v.y| < IMPACT_DECEL_VY (0.5) — внезапно затормозился (импакт!)
      //   3. p.y < IMPACT_FLOOR_Y (0.42) — рядом с полом (edge/corner диапазон)
      //   4. p.y >= VIRTUAL_FLOOR_Y - 0.05 (0.17) — НЕ глубоко под полом
      //      (это зона virtual floor, она уже дала отскок)
      //   5. nowMs - lastImpactBounceAt > COOLDOWN (250мс) — анти-спам
      //
      // Отскок = |prevVy| × IMPACT_BOUNCE_SCALE (0.42). Чуть выше RESTITUTION
      // (0.36) — компенсация потери энергии на tumble (часть энергии ушла в
      // вращение при edge-контакте). Визуально отскок выглядит естественно.
      const nowMs = Date.now();
      if (
        prevVy < IMPACT_MIN_VY
        && Math.abs(v.y) < IMPACT_DECEL_VY
        && p.y < IMPACT_FLOOR_Y
        && p.y >= VIRTUAL_FLOOR_Y - 0.05
        && nowMs - d.lastImpactBounceAt > IMPACT_BOUNCE_COOLDOWN_MS
      ) {
        try {
          const impactSpeed = Math.abs(prevVy);
          const bounceVy = Math.min(impactSpeed * IMPACT_BOUNCE_SCALE, IMPACT_MAX_BOUNCE);
          // Только если отскок ощутимый (>0.3 м/с → высота >0.006 единиц).
          // Меньше — не тратим кадр на setLinvel (куб всё равно не увидит).
          if (bounceVy > 0.3) {
            // Лифт: приподнимаем куб на 0.04 единицы от пола. Без этого Rapier
            // solver на следующем тике (1/120с) снова "схватывает" контакт и
            // гасит отскок (contact normal force > bounce impulse). 0.04 единиц
            // = 4см — достаточно чтобы разорвать контакт, но незаметно при 60fps.
            d.body.setTranslation({ x: p.x, y: Math.max(p.y, VIRTUAL_FLOOR_Y + 0.04), z: p.z }, true);
            d.body.setLinvel({
              x: v.x * VIRTUAL_FLOOR_FRICTION,
              y: bounceVy,
              z: v.z * VIRTUAL_FLOOR_FRICTION,
            }, true);
            d.lastImpactBounceAt = nowMs;
            d.body.wakeUp(true);
            if (IMPACT_DEBUG_LOG) {
              log(`[impact-bounce] die ${d.index}: prevVy=${prevVy.toFixed(2)} → v.y=${v.y.toFixed(2)}, p.y=${p.y.toFixed(3)}, bounceVy=${bounceVy.toFixed(2)}`);
            }
          }
        } catch {}
      }

      // ── v3i: GROUND DAMPING — Y-AXIS ONLY (spinning-top fix) ──
      // Когда кубик НА ПОЛУ (p.y < GROUND_CONTACT_Y) И не отскакивает вверх
      // (|v.y| < GROUND_CONTACT_VY), мягко гасим ТОЛЬКО Y-вращение
      // (вертикальная ось = "spinning top" эффект). X/Z кувыркание и
      // горизонтальная скорость НЕ трогаются — их гасит естественный Rapier
      // friction (0.34) + linearDamping (0.22). Это возвращает живую физику:
      // кубик отскакивает, скользит, катится — а не падает «как в масле».
      // Spinning-top safety-net (forceTipDie на 2.5с) ловит редкие случаи,
      // когда Y-spin всё ещё велик.
      //
      // ⚠️ LOCK v3k: X/Z damping УДАЛЁН. v3j добавил GROUND_XZ_DAMP_PER_STEP=0.970
      //    для «остановки tumble» — это нарушило LOCK и вызвало регрессию
      //    «кубы скользят над столом». X/Z angular damping НЕВОЗВРАТНО удалён.
      //    Любая попытка вернуть X/Z ground damping = нарушение LOCK.
      if (p.y < GROUND_CONTACT_Y && Math.abs(v.y) < GROUND_CONTACT_VY) {
        try {
          const a = d.body.angvel();
          if (Math.abs(a.y) > 0.05) {  // нет смысла умножать почти-ноль
            d.body.setAngvel({
              x: a.x,                          // сохраняем X-tumble (красивое кувыркание)
              y: a.y * GROUND_Y_DAMP_PER_STEP,  // мягко гасим Y-spin
              z: a.z,                          // сохраняем Z-tumble
            }, true);
          }
          // Линейную скорость НЕ трогаем — Rapier friction сам остановит.
        } catch {}
      }

      // Если куб вылетел за горизонтальные границы стола — возвращаем в центр.
      // getOutOfBounds() = currentArenaHalf + 1.0 (запас за стенами). На практике
      // почти никогда не срабатывает: стены ловят куб раньше. Это последний рубеж.
      const oob = getOutOfBounds();
      if (Math.abs(p.x) > oob || Math.abs(p.z) > oob) {
        try {
          d.body.setTranslation({ x: 0, y: DIE_HALF + 0.5, z: 0 }, true);
          d.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
          d.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
          d.body.wakeUp(true);
          log(`[safety] Session ${session.id} die ${d.index} was out of bounds (x=${p.x.toFixed(2)},z=${p.z.toFixed(2)}), reset to center`);
        } catch {}
      }
      // ── Y-ceiling safety net ──
      // Даже с невидимым потолком на CEILING_Y куб может оказаться ВЫШЕ него
      // (если импульс был экстремальным или CCD пропустил коллизию). В таком
      // случае принудительно возвращаем куб под потолок с нисходящей скоростью —
      // он падает обратно на стол. Без этого куб мог улететь «в бесконечность»
      // и никогда не вернуться (результат броска завис бы на 11с hard-timeout).
      if (p.y > CEILING_Y + 0.5) {
        try {
          d.body.setTranslation({ x: p.x, y: CEILING_Y - 0.3, z: p.z }, true);
          d.body.setLinvel({
            x: v.x * 0.3,
            y: -1.5,   // вниз — падает обратно на стол
            z: v.z * 0.3,
          }, true);
          d.body.wakeUp(true);
          log(`[safety-ceil] Session ${session.id} die ${d.index} above ceiling (y=${p.y.toFixed(2)}), pushed below to y=${(CEILING_Y - 0.3).toFixed(2)} with vy=-1.5`);
        } catch {}
      }
    }
  }

  // Снапшоты на 30 Hz
  const nowSec = now / 1000;
  if (nowSec - lastSnapshotTime >= SNAPSHOT_INTERVAL) {
    lastSnapshotTime = nowSec;
    for (const session of sessions.values()) {
      if (!session.finalized) emitSnapshot(session);
    }
  }

  // Settle detection для каждой активной сессии
  const nowMs = Date.now();
  for (const session of sessions.values()) {
    if (session.finalized) continue;
    if (checkSettled(session, nowMs)) {
      finalizeSession(session);
    }
  }

  // Планируем следующий тик (если ещё есть активные сессии)
  if (simRunning && sessions.size > 0) {
    setTimeout(tickSim, 1000 / 60);
  } else {
    simRunning = false;
    log("Simulation loop stopped (no active sessions).");
  }
}

function startSimIfNeeded(): void {
  if (simRunning) return;
  simRunning = true;
  lastTickTime = performance.now();
  // ── PRIME acc = STEP ──
  // Раньше acc = 0 → первый tick имел acc < STEP → world.step() НЕ вызывался
  // → первый снапшот содержал СТАТИЧНОЕ начальное состояние кубиков (до
  // любого вращения). Клиент получал "замороженные" кубы и ждал ~110мс
  // (RENDER_DELAY_MS) + ещё 33мс (до второго снапшота) прежде чем увидеть
  // движение. Это воспринималось как "кубы висят секунду без движения".
  //
  // Теперь acc = STEP → первый tick немедленно вызывает world.step() один
  // раз → setNextKinematicRotation из applySpin применяется → первый
  // снапшот показывает кубики УЖЕ слегка повёрнутыми. Движение видно с
  // самого первого кадра.
  acc = STEP;
  lastSnapshotTime = 0;
  log("Simulation loop started.");
  setTimeout(tickSim, 0);
}

// ---------------------------------------------------------------------------
// Rebuild world — воссоздаёт Rapier world с чистым состоянием.
// Вызывается когда нет активных сессий (после finalize/cancel), чтобы
// гарантировать что broadphase не содержит ghost-collider'ов от
// предыдущих бросков. Это критично для CCD: после ~12 бросков без
// rebuild кубы начинают tunneling-ить сквозь пол.
// ---------------------------------------------------------------------------
let rollCounter = 0;  // сколько бросков обработано (для логирования)

function rebuildWorld(): void {
  rollCounter = 0;
  try {
    if (world) {
      // free() освобождает WASM-память world и всех его компонент
      // (broadphase, narrowphase, body set, collider set, и т.д.)
      (world as any).free?.();
    }
  } catch (e) {
    log(`[rebuild] error freeing old world: ${e}`);
  }
  const RAPIER_NS = RAPIER as any;
  world = new RAPIER_NS.World({ x: 0, y: GRAVITY, z: 0 });
  world.timestep = STEP;
  buildArena(world, currentArenaHalfW, currentArenaHalfH);
  log(`[rebuild] world recreated with fresh broadphase/narrowphase (arenaHalfW=${currentArenaHalfW.toFixed(2)}, arenaHalfH=${currentArenaHalfH.toFixed(2)}).`);
}

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  log("Initializing Rapier WASM...");
  await RAPIER.init();
  log("Rapier initialized.");

  const RAPIER_NS = RAPIER as any;
  world = new RAPIER_NS.World({ x: 0, y: GRAVITY, z: 0 });
  world.timestep = STEP;
  // Не трогаем integrationParameters — значения по умолчанию в rapier3d-compat
  // адекватные. Кастомные настройки могут ломать sleeping (проверено).
  buildArena(world, currentArenaHalfW, currentArenaHalfH);
  log("Arena built.");

  const httpServer = createServer();
  io = new Server(httpServer, {
    cors: { origin: "*" },
    // socket.io имеет свой ping/pong; оставляем дефолт
  });

  io.on("connection", (socket: Socket) => {
    log(`Socket connected: ${socket.id}`);
    // ВАЖНО: socket.onAny с JSON.stringify был убран — он выполнял синхронную
    // сериализацию КАЖДОГО входящего события (включая частые dice:transform
    // echo при отладке), что вызывало микро-лаги event loop → плавность
    // физики падала "время от времени". Теперь логируем только关键евые события.

    // Запрос броска
    socket.on("dice:roll", (payload: any) => {
      const { sessionId, numDice, arenaHalfW, arenaHalfH, arenaHalf, presetId, originSide, originX, direction, spawnX, spawnZ, swingVelocity, initialQuats, initialAngularVelocity } = payload ?? {};
      if (!sessionId || typeof sessionId !== "string") {
        log(`Invalid dice:roll payload from ${socket.id}:`, payload);
        socket.emit("dice:error", { error: "invalid payload", sessionId: null });
        return;
      }
      if (sessions.has(sessionId)) {
        log(`Session ${sessionId} already exists — ignoring duplicate roll.`);
        return;
      }
      const n = Math.max(1, Math.min(8, Math.floor(numDice ?? 4)));

      // ── Динамический прямоугольный размер арены ──
      // Клиент передаёт arenaHalfW/arenaHalfH (половины сторон карты в физ.ед),
      // вычисленные из naturalWidth/naturalHeight фонового изображения.
      // Для обратной совместимости принимаем и старый arenaHalf (квадрат).
      // Если размер отличается от текущего — перестраиваем мир.
      const reqW = clampArenaHalf(typeof arenaHalfW === "number" ? arenaHalfW
                                 : (typeof arenaHalf === "number" ? arenaHalf : DEFAULT_ARENA_HALF));
      const reqH = clampArenaHalf(typeof arenaHalfH === "number" ? arenaHalfH
                                 : (typeof arenaHalf === "number" ? arenaHalf : DEFAULT_ARENA_HALF));
      const sizeChanged = Math.abs(reqW - currentArenaHalfW) > 0.05
                       || Math.abs(reqH - currentArenaHalfH) > 0.05;
      if (sizeChanged) {
        if (sessions.size === 0) {
          currentArenaHalfW = reqW;
          currentArenaHalfH = reqH;
          log(`[arena] size changed: W=${currentArenaHalfW.toFixed(2)} H=${currentArenaHalfH.toFixed(2)} → rebuild world`);
          rebuildWorld();
        } else {
          log(`[arena] size change requested (W=${reqW.toFixed(2)},H=${reqH.toFixed(2)}) but ${sessions.size} active sessions — keeping W=${currentArenaHalfW.toFixed(2)},H=${currentArenaHalfH.toFixed(2)}`);
        }
      }

      // Выделяем бит коллизионной группы (1..30, потом заново с 1)
      const collisionGroup = nextCollisionGroup;
      nextCollisionGroup = (nextCollisionGroup % 30) + 1;

      const session: RollSession = {
        id: sessionId,
        numDice: n,
        dice: [],
        startedAt: Date.now(),
        firstSleepAt: null,
        finalized: false,
        resultEmitted: false,
        collisionGroup,
        pendingSnapshot: false,
        released: false,       // фаза перемешивания активна
        releasedAt: 0,
        cupBody: null,
        cupColliders: [],
        cupBaseX: 0,
        cupBaseY: 0,
        cupBaseZ: 0,
        preset: getPreset(presetId),
        originSide: originSide === 'far' ? 'far' : 'near',
        originX: typeof originX === "number" && Number.isFinite(originX) ? originX : 0,
        direction: typeof direction === "number" && Number.isFinite(direction) ? direction : undefined,
        spawnX: typeof spawnX === "number" && Number.isFinite(spawnX) ? spawnX : undefined,
        spawnZ: typeof spawnZ === "number" && Number.isFinite(spawnZ) ? spawnZ : undefined,
        swingVelocity: typeof swingVelocity === "number" && Number.isFinite(swingVelocity) && swingVelocity >= 0
          ? swingVelocity : undefined,
        // initialQuats — массив [x,y,z,w] кватернионов (по одному на кубик).
        // Валидируем: должен быть массивом массивов из 4 чисел. При невалидном
        // значении → undefined (сессия идёт через обычный shake-путь).
        initialQuats: Array.isArray(initialQuats) && initialQuats.length > 0
          ? initialQuats
              .map((q: any) => Array.isArray(q) && q.length === 4
                ? [Number(q[0]), Number(q[1]), Number(q[2]), Number(q[3])] as [number, number, number, number]
                : null)
              .filter((q: any) => q !== null
                  && Number.isFinite(q[0]) && Number.isFinite(q[1])
                  && Number.isFinite(q[2]) && Number.isFinite(q[3]))
          : undefined,
        // initialAngularVelocity — массив [wx,wy,wz] (рад/с, world space).
        // Валидируем: массив массивов из 3 чисел. При невалидном → undefined.
        initialAngularVelocity: Array.isArray(initialAngularVelocity) && initialAngularVelocity.length > 0
          ? initialAngularVelocity
              .map((w: any) => Array.isArray(w) && w.length === 3
                ? [Number(w[0]), Number(w[1]), Number(w[2])] as [number, number, number]
                : null)
              .filter((w: any) => w !== null
                  && Number.isFinite(w[0]) && Number.isFinite(w[1]) && Number.isFinite(w[2]))
          : undefined,
      };
      sessions.set(sessionId, session);
      spawnDiceForSession(session);
      rollCounter++;
      log(`Roll started: session=${sessionId} numDice=${n} preset=${session.preset.name} origin=${session.originSide} originX=${session.originX?.toFixed(2) ?? '0'} direction=${session.direction !== undefined ? session.direction.toFixed(2) + 'rad' : 'none'} spawn=${session.spawnX !== undefined && session.spawnZ !== undefined ? `(${session.spawnX.toFixed(2)},${session.spawnZ.toFixed(2)})` : 'edge'} swingVel=${session.swingVelocity !== undefined ? session.swingVelocity.toFixed(2) + 'px/ms' : 'none'} initialQuats=${session.initialQuats ? `${session.initialQuats.length} dice (skip shake)` : 'none'} (roll #${rollCounter} since last rebuild)`);

      // Подтверждение клиенту — включаем arenaHalfW/H, чтобы клиент знал
      // актуальный размер арены (для рендера визуальных бортиков).
      io?.emit("dice:rolled", {
        sessionId, numDice: n,
        arenaHalfW: Number(currentArenaHalfW.toFixed(3)),
        arenaHalfH: Number(currentArenaHalfH.toFixed(3)),
        t: Date.now(),
      });

      startSimIfNeeded();
    });

    // Отмена броска (клиент закрыл оверлей)
    socket.on("dice:cancel", (payload: any) => {
      const { sessionId } = payload ?? {};
      if (!sessionId) return;
      cancelSession(sessionId);
    });

    socket.on("disconnect", () => {
      log(`Socket disconnected: ${socket.id}`);
      // Не отменяем активные сессии — пусть досимулируют, результат
      // понадобится при переподключении. В реальном мультиплеере тут
      // была бы логика таймаута.
    });
  });

  // HTTP health + debug endpoint
  httpServer.on("request", (req, res) => {
    if (req.method !== "GET") return;
    // Используем pathname (без query) — Caddy проксирует с ?XTransformPort=...,
    // и эти query не должны влиять на маршрутизацию endpoint'ов.
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    if (pathname === "/" || pathname === "/health") {
      let activeBodies = 0;
      for (const s of sessions.values()) activeBodies += s.dice.length;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        service: "fate-rpg-physics",
        port: PORT,
        uptimeSec: Math.round(process.uptime()),
        activeSessions: sessions.size,
        activeBodies,
        simRunning,
        arenaHalfW: Number(currentArenaHalfW.toFixed(3)),
        arenaHalfH: Number(currentArenaHalfH.toFixed(3)),
      }));
      return;
    }
    // /debug/sessions — показать текущие скорости кубиков во всех сессиях
    if (pathname === "/debug/sessions") {
      const out: any[] = [];
      for (const s of sessions.values()) {
        const diceInfo = s.dice.map((d) => {
          const p = d.body.translation();
          const v = d.body.linvel();
          const a = d.body.angvel();
          const r = d.body.rotation();
          const upFaceAlign = getUpFaceAlignment(r.x, r.y, r.z, r.w);
          return {
            i: d.index,
            pos: [p.x, p.y, p.z],
            linVel: [v.x, v.y, v.z],
            angVel: [a.x, a.y, a.z],
            linMag: Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z),
            angMag: Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z),
            isSleeping: d.body.isSleeping(),
            upFace: upFaceAlign.idx,
            upFaceSymbol: FACE_SYMBOLS[upFaceAlign.idx],
            upFaceDot: Number(upFaceAlign.dot.toFixed(4)),
            onEdge: upFaceAlign.dot < EDGE_THRESHOLD,
            nudgeCount: d.nudgeCount,
          };
        });
        out.push({
          id: s.id,
          numDice: s.numDice,
          startedAt: s.startedAt,
          elapsedMs: Date.now() - s.startedAt,
          firstSleepAt: s.firstSleepAt,
          finalized: s.finalized,
          dice: diceInfo,
        });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions: out }, null, 2));
      return;
    }
  });

  httpServer.listen(PORT, "0.0.0.0", () => {
    log(`Physics service listening on 0.0.0.0:${PORT}`);
    log(`Health: http://localhost:${PORT}/health`);
  });

  // Graceful shutdown
  const shutdown = (sig: string) => {
    log(`Received ${sig}, shutting down...`);
    try { httpServer.close(); } catch {}
    try { io?.close(); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal error in physics service:", err);
  process.exit(1);
});
