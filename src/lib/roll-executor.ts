// ============================================================
// roll-executor.ts — унифицированный исполнитель броска кубиков
// ============================================================
//
// Ветвит 2D (Math.random) vs 3D (server Rapier3D physics) в зависимости
// от настроек. Используется всеми диалогами броска (RollToolPanel,
// QuickRollDialog, CharacterRollDialog и т.д.) чтобы не дублировать
// логику ветвления.
//
// Важно: при 3D режиме вызывается runRollWithPhysics, который создаёт
// LiveRollEvent с pendingPhysics и ставит его в очередь overlay.
// После финализации физики promise резолвится реальными значениями
// кубиков. Caller использует результат для addLogEntry и (опционально)
// для построения финального summary-события (opposed/cooperative/mass).
//
// При 2D режиме (или physics offline) используется performRoll из
// fate-dice.ts — мгновенный Math.random, без анимации.

import { useFateStore } from '@/lib/store';
import { useDicePhysics } from '@/hooks/use-dice-physics';
import {
  performRoll,
  getRollResult,
} from '@/lib/fate-dice';
import type { LiveRollEvent, LiveRollParticipant, RollResult } from '@/lib/types';

export interface DiceRollRequest {
  /** Персонаж, который бросает (для overlay). */
  characterName: string;
  characterId?: string;
  /** Навык (для overlay и подсчёта total). */
  skillName?: string;
  skillValue: number;
  /** Ситуативный бонус (модификатор GM). */
  manualBonus?: number;
  /** Сложность (для вычисления label). null = без сложности. */
  difficulty?: number | null;
  /** Результат противника (для opposed — вычисляет win/lose/tie). */
  opponentTotal?: number | null;
  /** Роль участника в overlay. */
  role?: LiveRollParticipant['role'];
  /** ID приключения (для лога). */
  adventureId?: string;
  /** Кто инициировал бросок (имя игрока). */
  rolledBy?: string;
  /** PeerId of the player who controls this character (for per-player dice
   *  colors in mass rolls). Null/undefined for host-side NPCs. */
  peerId?: string | null;
  /** Dice colors snapshot for this participant (optional — if absent,
   *  enqueueLiveRoll resolves from peerDiceColors map or local store). */
  diceColor?: string;
  symbolColor?: string;
  /** Заголовок события (для overlay). */
  title?: string;
  /** Контекст действия (check/attack/overcome/...). */
  actionContext?: LiveRollEvent['actionContext'];
}

export interface DiceRollOutcome {
  /** Реальные значения кубиков (-1/0/1 каждый, 4 штуки). */
  dice: number[];
  /** Сумма кубиков без бонусов. */
  diceSum: number;
  /** Полный total = diceSum + skillValue + manualBonus. */
  total: number;
  /** Лейбл результата («Успех», «Провал», «Ничья» и т.д.). */
  label: string;
  /** Тип результата (fail/tie/success/great). */
  type: RollResult['type'];
  /** ID события overlay (если был создан physics event). */
  eventId?: string;
  /** ID участника в overlay. */
  participantId?: string;
  /** Был ли использован 3D physics. */
  usedPhysics: boolean;
}

/**
 * Определяет, доступен ли 3D physics режим прямо сейчас.
 * Проверяет настройку diceMode и соединение с physics-сервисом.
 */
export function useDiceMode(): {
  mode: '3d' | '2d';
  physicsConnected: boolean;
  /** true, если можно использовать 3D physics прямо сейчас. */
  canUsePhysics: boolean;
  /** true, если можно использовать 2D physics (локальную) прямо сейчас. */
  canUse2DPhysics: boolean;
} {
  const mode = useFateStore((s) => s.diceMode);
  const physics = useDicePhysics();
  return {
    mode,
    physicsConnected: physics.connected,
    // v3j: canUsePhysics = mode === '3d' (без проверки connected).
    // Раньше было `mode === '3d' && physics.connected` — но connected
    // становится true только после async-коннекта (1-2с после загрузки
    // страницы). Если пользователь бросал сразу — canUsePhysics=false →
    // fallback на 2D Math.random, 3D физика не запускалась. Жалоба:
    // «физика сломалась». Теперь: в 3D режиме ВСЕГДА пытаемся 3D.
    // executeDiceRoll ловит ошибку коннекта и падает на 2D fallback.
    canUsePhysics: mode === '3d',
    // 2D-режим: локальная физика, всегда доступна (нет внешних зависимостей).
    canUse2DPhysics: mode === '2d',
  };
}

/**
 * Resolves the LOCAL roller's dice colors + peerId from the store.
 *
 * WHY: Every roll must carry the roller's chosen dice palette so that remote
 * viewers (GM + other players) render the tumbling dice in THAT player's
 * colors — not the viewer's own. Without this stamping, the participant is
 * created with `diceColor: undefined`, and `enqueueLiveRoll` on the remote
 * side falls back to the *viewer's* local colors (e.g. the GM's blue dice),
 * which defeats the whole point of per-player dice customization.
 *
 * Callers may still override per-participant (e.g. mass rolls where the GM
 * rolls for several PCs each owned by a different player) by setting
 * `diceColor`/`symbolColor`/`peerId` explicitly on the DiceRollRequest —
 * this helper only fills in the gaps.
 */
function resolveLocalRollerColors(): {
  diceColor: string;
  symbolColor: string;
  peerId: string | null;
} {
  const s = useFateStore.getState();
  return {
    diceColor: s.diceColor,
    symbolColor: s.symbolColor,
    peerId: s.networkMyPeerId ?? null,
  };
}

/**
 * Выполняет бросок 4dF с ветвлением 2D/3D.
 *
 * При 3D: создаёт LiveRollEvent с pendingPhysics, enqueue'ит в overlay,
 * ждёт финализации физики, возвращает реальные dice.
 * При 2D: мгновенно performRoll, без overlay-события (caller строит
 * summary-событие отдельно если нужно).
 *
 * presetId по умолчанию 'power' (стандартный силовой бросок).
 */
export async function executeDiceRoll(
  req: DiceRollRequest,
  opts: {
    canUsePhysics: boolean;
    presetId?: string;
    /** How long to keep the 3D dice visible on the table after the physics
     *  result arrives, BEFORE dismissing the overlay. Default 4000ms — кубы
     *  полежат на столе 4 секунды, результат хорошо видно. */
    holdBeforeDismissMs?: number;
    /** Вызывается СРАЗУ после получения результата физики (ДО hold-таймера).
     *  В этот момент кубики ещё лежат на столе — пользователь видит результат
     *  на гранях И одновременно запись в логе. Если callback вернёт Promise,
     *  он дожидается его выполнения перед началом hold-таймера.
     *
     *  Используется для записи в лог ДО исчезновения кубов: передайте сюда
     *  функцию, которая вызывает addLogEntry. */
    onResult?: (outcome: DiceRollOutcome) => void | Promise<void>;
    /** Жест-бросок: направление (near/far) и латеральный офсет, вычисленные
     *  из drop координат на canvas. Пробрасывается в runRollWithPhysics →
     *  physics-service. Если не передан — defaults (near, originX=0).
     *
     *  direction — угол в радианах (0=вперёд, π/2=вправо, π=назад, −π/2=влево).
     *  Physics-service вращает импульс на этот угол — кубы летят в сторону жеста.
     *  Только для drag-броска; undefined для кнопка-броска.
     *
     *  dropX/dropY — точные screen-координаты точки отпускания. Пробрасываются
     *  до Dice3DPhysicsCanvas, который позиционирует маленькую арену прямо
     *  на этой точке. Без этого кубы спавнятся с края большой арены (вся
     *  карта) — выглядят как "появились со стороны".
     *
     *  spawnX/spawnZ — АБСОЛЮТНАЯ позиция спавна на арене (в физ. единицах,
     *  центр арены = (0,0)). Когда оба заданы, physics-service ставит стакан
     *  В ЭТОЙ ТОЧКЕ — кубы появляются ровно под курсором (как размещение
     *  токена). Переопределяет edge-based расчёт из originSide/originX.
     *  undefined для кнопка-броска → edge-based позиция.
     *
     *  swingVelocity — скорость взмаха в px/ms в момент отпускания. Только
     *  для drag-броска. Physics-service масштабирует импульс броска
     *  (horizontal + vertical + angular) от этой скорости: медленный отпуск
     *  → кубы мягко падают на месте, быстрый flick → кубы летят дальше с
     *  дугой. undefined для кнопка-броска → используется полный импульс
     *  пресета (без масштабирования).
     *
     *  initialQuats — массив кватернионов [x,y,z,w] (по одному на кубик),
     *  захваченных из 3D-оверлея в момент отпускания. Кубы вращались всё
     *  время drag'а — их текущие ориентации и есть "случайная стартовая
     *  точка" для броска. Когда задан, physics-service ПРОПУСКАЕТ фазу
     *  перемешивания (SHAKE_DURATION_MS) → бросок становится бесшовным.
     *  undefined для кнопка-броска → используется фаза перемешивания. */
    origin?: { originSide?: 'near' | 'far'; originX?: number; direction?: number; dropX?: number; dropY?: number; spawnX?: number; spawnZ?: number; swingVelocity?: number; initialQuats?: Array<[number, number, number, number]>; initialAngularVelocity?: Array<[number, number, number]> };
    /** ── 2D-режим (diceMode='2d') ──
     *  Если canUse2DPhysics=true — вызывается runRollWith2DPhysics вместо
     *  performRoll. origin2D — параметры 2D-броска в пикселях относительно
     *  карты (НЕ в физ. единицах как origin для 3D):
     *    spawnX/spawnY — стартовая позиция на карте в px.
     *    direction — угол в screen-coords (0=вправо, π/2=вниз).
     *    speed — базовая скорость в px/с (масштабируется пресетом).
     *    initialFaces — грани удерживаемых 2D-плиток (drag-handoff).
     *    initialPositions/initialVelocities — для бесшовного handoff.
     *    dropX/dropY — screen-координаты (для конвертации в map-local px).
     *    presetId — пресет броска. */
    canUse2DPhysics?: boolean;
    origin2D?: {
      spawnX?: number;
      spawnY?: number;
      direction?: number;
      speed?: number;
      initialFaces?: Array<1 | 0 | -1>;
      initialPositions?: Array<{ x: number; y: number }>;
      initialVelocities?: Array<{ vx: number; vy: number }>;
      dropX?: number;
      dropY?: number;
      presetId?: string;
    };
  },
): Promise<DiceRollOutcome> {
  const presetId = opts.presetId ?? 'power';
  const skillValue = req.skillValue ?? 0;
  const manualBonus = req.manualBonus ?? 0;
  const difficulty = req.difficulty ?? null;
  const opponentTotal = req.opponentTotal ?? null;

  // ── 2D путь (fallback или выключенный 3D) ──
  // Если canUse2DPhysics=true — запускаем ЛОКАЛЬНУЮ 2D-физику с анимацией
  // (полный аналог 3D, но без physics-service). Иначе (true fallback когда
  // 3D не подключился и 2D выключен) — мгновенный performRoll без анимации.
  if (!opts.canUsePhysics) {
    if (opts.canUse2DPhysics) {
      // ── 2D-физика с анимацией ──
      const participantId = `phys2d-${req.characterId ?? 'roller'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const eventId = `roll2d-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const modifiers: { label: string; value: number }[] = [];
      if (req.skillName && skillValue) {
        modifiers.push({ label: req.skillName, value: skillValue });
      }
      if (manualBonus !== 0) {
        modifiers.push({
          label: manualBonus > 0 ? 'ситуативный' : 'штраф',
          value: manualBonus,
        });
      }

      const eventSkeleton: Omit<LiveRollEvent, 'pending2DPhysics'> = {
        id: eventId,
        type: 'simple',
        rolledBy: req.rolledBy || req.characterName,
        rolledAt: Date.now(),
        title: req.title || req.skillName || 'Бросок кубиков',
        actionContext: req.actionContext ?? 'check',
        difficulty,
        verdict: undefined,
        verdictType: undefined,
        participants: [{
          id: participantId,
          characterName: req.characterName,
          characterId: req.characterId,
          peerId: req.peerId ?? null,
          diceColor: req.diceColor,
          symbolColor: req.symbolColor,
          skillName: req.skillName,
          skillValue: skillValue || undefined,
          manualBonus,
          dice: [0, 0, 0, 0],
          diceSum: 0,
          total: 0,
          resultLabel: '...',
          resultType: 'tie',
          role: req.role ?? 'roller',
          modifiers: modifiers.length > 0 ? modifiers : undefined,
        }],
        adventureId: req.adventureId,
      };

      const runRollWith2DPhysics = useFateStore.getState().runRollWith2DPhysics;
      let result2D;
      try {
        const preset2D = opts.origin2D?.presetId ?? presetId;
        result2D = await runRollWith2DPhysics(eventSkeleton, preset2D, opts.origin2D);
      } catch (physics2DErr) {
        console.warn('[roll-executor] 2D physics failed, falling back to instant performRoll:', (physics2DErr as Error).message);
        const r = performRoll(skillValue + manualBonus, difficulty, opponentTotal);
        return {
          dice: r.dice,
          diceSum: r.dice.reduce<number>((sum, d) => sum + d, 0),
          total: r.total,
          label: r.label,
          type: r.type,
          usedPhysics: false,
        };
      }

      const diceSum2D = result2D.dice.reduce<number>((sum, d) => sum + d, 0);
      const total2D = diceSum2D + skillValue + manualBonus;
      const { label: label2D, type: type2D } = getRollResult(total2D, difficulty, opponentTotal);

      const outcome2D: DiceRollOutcome = {
        dice: result2D.dice,
        diceSum: diceSum2D,
        total: total2D,
        label: label2D,
        type: type2D,
        eventId: result2D.eventId,
        participantId: result2D.participantId,
        usedPhysics: true,
      };

      if (opts.onResult) {
        await opts.onResult(outcome2D);
      }

      // Dismiss overlay after hold (как в 3D).
      // ВАЖНО: после holdMs2D ожидания ПЕРЕ-проверяем, что НАШ event всё ещё
      // на сцене. Если за эти 4с event был.dismiss'нут (пользователь кликнул ✕,
      // нажал Esc, кликнул кейс, или сработал safety-net) и на сцене уже стоит
      // СЛЕДУЮЩИЙ бросок — НЕ вызываем requestLiveRollExit, иначе мы погасим
      // чужой (новый) бросок. Это fixes баг «преждевременное исчезновение
      // 2D кубов»: старый бросок's timer не должен снимать новый бросок.
      const holdMs2D = opts.holdBeforeDismissMs ?? 4000;
      const store2D = useFateStore.getState();
      if (store2D.liveRollStage?.id === result2D.eventId) {
        await new Promise((r) => setTimeout(r, holdMs2D));
        // RE-CHECK after wait: only dismiss if OUR event is still on stage.
        const stillOurs = useFateStore.getState().liveRollStage?.id === result2D.eventId
          && !useFateStore.getState().liveRollExiting;
        if (stillOurs) {
          store2D.requestLiveRollExit();
          await new Promise((r) => setTimeout(r, 250));
        }
      }

      return outcome2D;
    }

    // ── True fallback: мгновенный performRoll (без анимации) ──
    const r = performRoll(skillValue + manualBonus, difficulty, opponentTotal);
    return {
      dice: r.dice,
      diceSum: r.dice.reduce<number>((sum, d) => sum + d, 0),
      total: r.total,
      label: r.label,
      type: r.type,
      usedPhysics: false,
    };
  }

  // ── 3D путь (server Rapier3D physics) ──
  const participantId = `phys-${req.characterId ?? 'roller'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const eventId = `roll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Build modifiers array — applyPhysicsResult computes total as
  // diceSum + sum(modifiers.values) + fateBonus. So skill value and
  // manual bonus MUST be in modifiers for the overlay to show correct total.
  const modifiers: { label: string; value: number }[] = [];
  if (req.skillName && skillValue) {
    modifiers.push({ label: req.skillName, value: skillValue });
  }
  if (manualBonus !== 0) {
    modifiers.push({
      label: manualBonus > 0 ? 'ситуативный' : 'штраф',
      value: manualBonus,
    });
  }

  // Stamp the local roller's dice palette so it travels with the event.
  // Remote viewers then render the tumbling dice in THIS player's colors
  // instead of falling back to their own. (See resolveLocalRollerColors.)
  const localRoller = resolveLocalRollerColors();

  const eventSkeleton: Omit<LiveRollEvent, 'pendingPhysics'> = {
    id: eventId,
    type: 'simple',
    rolledBy: req.rolledBy || req.characterName,
    rolledAt: Date.now(),
    title: req.title || req.skillName || 'Бросок кубиков',
    actionContext: req.actionContext ?? 'check',
    difficulty,
    verdict: undefined,
    verdictType: undefined,
    participants: [{
      id: participantId,
      characterName: req.characterName,
      characterId: req.characterId,
      peerId: req.peerId ?? localRoller.peerId,
      diceColor: req.diceColor ?? localRoller.diceColor,
      symbolColor: req.symbolColor ?? localRoller.symbolColor,
      skillName: req.skillName,
      skillValue: skillValue || undefined,
      manualBonus,
      dice: [0, 0, 0, 0],
      diceSum: 0,
      total: 0,
      resultLabel: '...',
      resultType: 'tie',
      role: req.role ?? 'roller',
      modifiers: modifiers.length > 0 ? modifiers : undefined,
    }],
    adventureId: req.adventureId,
  };

  const runRollWithPhysics = useFateStore.getState().runRollWithPhysics;
  let result;
  try {
    result = await runRollWithPhysics(eventSkeleton, presetId, opts.origin);
  } catch (physicsErr) {
    // v3j: 3D физика недоступна (сервис упал / коннект отвалился / таймаут).
    // Падаем на 2D fallback чтобы бросок ВСЕГДА завершался.
    console.warn('[roll-executor] 3D physics failed, falling back to 2D:', (physicsErr as Error).message);
    const r = performRoll(skillValue + manualBonus, difficulty, opponentTotal);
    return {
      dice: r.dice,
      diceSum: r.dice.reduce<number>((sum, d) => sum + d, 0),
      total: r.total,
      label: r.label,
      type: r.type,
      usedPhysics: false,
    };
  }

  const diceSum = result.dice.reduce((a, b) => a + b, 0);
  const total = diceSum + skillValue + manualBonus;
  const { label, type } = getRollResult(total, difficulty, opponentTotal);

  // ── Строим outcome ДО hold-таймера ──
  const outcome: DiceRollOutcome = {
    dice: result.dice,
    diceSum,
    total,
    label,
    type,
    eventId: result.eventId,
    participantId: result.participantId,
    usedPhysics: true,
  };

  // ── onResult callback: лог пишется ПОКА КУБЫ ЕЩЁ НА СТОЛЕ ──
  // Вызывается СРАЗУ после получения результата физики, ДО hold-таймера.
  // Пользователь видит результат на гранях кубов И одновременно запись в
  // логе. После callback'а кубы ещё лежат holdMs (4с) — только потом
  // исчезают. Это решает запрос "результаты записываются в лог до
  // исчезновения кубов со стола".
  if (opts.onResult) {
    await opts.onResult(outcome);
  }

  // ── Dismiss overlay after physics result ──
  // КРИТИЧНО для последовательных бросков (VS / mass): если overlay
  // продолжает показывать текущее событие, следующий executeDiceRoll
  // поставит новое событие в очередь — ServerDiceStage для него не
  // смонтируется, и physics-бросок не начнётся (promise зависнет до
  // safety-timeout 10s → fallback [0,0,0,0]).
  //
  // holdBeforeDismissMs: пауза ПЕРЕД dismiss, чтобы пользователь увидел
  // результат на самих кубах (грани) + в полоске. Default 4000мс — кубы
  // полежат на столе 4 секунды, результат хорошо видно. Раньше было 1.2с —
  // слишком быстро, кубы пропадали "мгновенно".
  //
  // ── RE-CHECK after wait (fix premature dismissal) ──
  // После holdMs ожидания ПЕРЕ-проверяем, что НАШ event всё ещё на сцене.
  // Если за эти 4с event был.dismiss'нут (пользователь кликнул ✕ / Esc /
  // кейс, или сработал safety-net) и на сцене уже стоит СЛЕДУЮЩИЙ бросок —
  // НЕ вызываем requestLiveRollExit, иначе мы погасим чужой (новый) бросок.
  const holdMs = opts.holdBeforeDismissMs ?? 4000;
  const store = useFateStore.getState();
  if (store.liveRollStage?.id === result.eventId) {
    // Держим кубики на столе holdMs (компактная полоска видна), потом exit.
    await new Promise((r) => setTimeout(r, holdMs));
    // RE-CHECK: only dismiss if OUR event is still on stage and not exiting.
    const stillOurs = useFateStore.getState().liveRollStage?.id === result.eventId
      && !useFateStore.getState().liveRollExiting;
    if (stillOurs) {
      store.requestLiveRollExit();
      // Даём overlay 250мс на exit-анимацию и unmount ServerDiceStage
      // перед тем как вернуть управление caller'у (который может сразу
      // запустить следующий бросок).
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return outcome;
}

/**
 * Execute multiple dice rolls SEQUENTIALLY (for VS / mass / cooperative).
 * Each roll gets its own physics animation (overlay event).
 * Returns array of outcomes in same order as requests.
 *
 * Используется для:
 * - VS: [roller, opponent]
 * - Mass roll: [participant1, participant2, ...]
 * - Cooperative: [leader] (helpers add passive +1, no roll)
 */
export async function executeDiceRollsSequential(
  requests: DiceRollRequest[],
  opts: {
    canUsePhysics: boolean;
    presetId?: string;
    /** Hold each throw's dice on the table before dismissing (for VS). */
    holdBeforeDismissMs?: number;
  },
): Promise<DiceRollOutcome[]> {
  const results: DiceRollOutcome[] = [];
  for (let i = 0; i < requests.length; i++) {
    // Для каждого последующего участника передаём opponentTotal
    // предыдущего (если есть) — но только если это opposed (2 участника).
    // Для mass roll каждый бросает независимо.
    const req = requests[i];
    // Каждый бросок в последовательности (VS/mass) показывается 1.2с —
    // пользователь видит результат каждого участника перед следующим.
    // Последний бросок тоже 1.2с, после него caller строит summary-event.
    const hold = opts.holdBeforeDismissMs ?? 1200;
    const outcome = await executeDiceRoll(req, { ...opts, holdBeforeDismissMs: hold });
    results.push(outcome);
  }
  return results;
}

/**
 * Execute a SIMULTANEOUS VS roll — both roller and opponent throw at the
 * SAME time from opposite sides of the arena (roller from 'near', opponent
 * from 'far'). Dice fly toward each other and land in the center.
 *
 * Это заменяет последовательный VS бросок (executeDiceRollsSequential) для
 * режима 3D физики. Преимущества:
 *   - ОБА набора кубиков видны на столе ОДНОВРЕМЕННО — результат виден по
 *     кубам (ролик слева/снизу, оппонент справа/сверху).
 *   - Не нужно окно с результатом — итог в логе, кубы на столе.
 *   - Быстрее: один overlay-event вместо двух последовательных.
 *
 * Возвращает массив из 2 outcomes: [roller, opponent].
 *
 * Для 2D режима: fallback на executeDiceRollsSequential (последовательный).
 */
export async function executeVSRollSimultaneous(
  rollerRequest: DiceRollRequest,
  opponentRequest: DiceRollRequest,
  opts: {
    canUsePhysics: boolean;
    presetId?: string;
    /** Hold dice on the table after BOTH settle, before dismissing overlay. */
    holdBeforeDismissMs?: number;
    /** Вызывается СРАЗУ после получения результатов физики для ОБЕИХ сторон
     *  (ДО hold-таймера). В этот момент кубики обоих игроков ещё лежат на
     *  столе — пользователь видит результат на гранях И одновременно запись
     *  в логе. Передайте сюда функцию, которая вызывает addLogEntry для VS
     *  броска (с обоими участниками). */
    onResult?: (outcomes: { roller: DiceRollOutcome; opponent: DiceRollOutcome }) => void | Promise<void>;
  },
): Promise<{ roller: DiceRollOutcome; opponent: DiceRollOutcome }> {
  // ── 2D fallback: sequential (no simultaneous animation in 2D) ──
  if (!opts.canUsePhysics) {
    const [opp, roll] = await Promise.all([
      executeDiceRoll(opponentRequest, { canUsePhysics: false }),
      executeDiceRoll({ ...rollerRequest, opponentTotal: null }, { canUsePhysics: false }),
    ]);
    // Recompute roller's label with opponentTotal now known
    const { label, type } = getRollResult(
      roll.total,
      rollerRequest.difficulty ?? null,
      opp.total,
    );
    return {
      opponent: opp,
      roller: { ...roll, label, type },
    };
  }

  // ── 3D: simultaneous VS via runVSRollWithPhysics ──
  const rollerParticipantId = `phys-roller-${rollerRequest.characterId ?? 'roller'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const opponentParticipantId = `phys-opp-${opponentRequest.characterId ?? 'opp'}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const eventId = `vs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const presetId = opts.presetId ?? 'power';

  // Build modifiers for each participant
  const buildModifiers = (req: DiceRollRequest): { label: string; value: number }[] => {
    const mods: { label: string; value: number }[] = [];
    if (req.skillName && req.skillValue) {
      mods.push({ label: req.skillName, value: req.skillValue });
    }
    if (req.manualBonus && req.manualBonus !== 0) {
      mods.push({
        label: req.manualBonus > 0 ? 'ситуативный' : 'штраф',
        value: req.manualBonus,
      });
    }
    return mods;
  };

  // Stamp the local roller's dice palette so it travels with the event.
  // Both participants in a VS roll are thrown on THIS machine, so we use the
  // local palette as the default; requests may still override per-participant.
  const localRoller = resolveLocalRollerColors();

  const rollerP = {
    id: rollerParticipantId,
    characterName: rollerRequest.characterName,
    characterId: rollerRequest.characterId,
    peerId: rollerRequest.peerId ?? localRoller.peerId,
    diceColor: rollerRequest.diceColor ?? localRoller.diceColor,
    symbolColor: rollerRequest.symbolColor ?? localRoller.symbolColor,
    skillName: rollerRequest.skillName,
    skillValue: rollerRequest.skillValue || undefined,
    manualBonus: rollerRequest.manualBonus ?? 0,
    dice: [0, 0, 0, 0],
    diceSum: 0,
    total: 0,
    resultLabel: '...',
    resultType: 'tie' as const,
    role: 'roller' as const,
    modifiers: buildModifiers(rollerRequest).length > 0 ? buildModifiers(rollerRequest) : undefined,
  };

  const opponentP = {
    id: opponentParticipantId,
    characterName: opponentRequest.characterName,
    characterId: opponentRequest.characterId,
    peerId: opponentRequest.peerId ?? localRoller.peerId,
    diceColor: opponentRequest.diceColor ?? localRoller.diceColor,
    symbolColor: opponentRequest.symbolColor ?? localRoller.symbolColor,
    skillName: opponentRequest.skillName,
    skillValue: opponentRequest.skillValue || undefined,
    manualBonus: opponentRequest.manualBonus ?? 0,
    dice: [0, 0, 0, 0],
    diceSum: 0,
    total: 0,
    resultLabel: '...',
    resultType: 'tie' as const,
    role: 'opponent' as const,
    modifiers: buildModifiers(opponentRequest).length > 0 ? buildModifiers(opponentRequest) : undefined,
  };

  const eventSkeleton: Omit<LiveRollEvent, 'pendingPhysics' | 'pendingPhysicsSessions'> = {
    id: eventId,
    type: 'opposed',
    rolledBy: rollerRequest.rolledBy || rollerRequest.characterName,
    rolledAt: Date.now(),
    title: rollerRequest.skillName || 'Противостояние',
    actionContext: 'attack',
    opponentKind: opponentRequest.characterId ? 'named' : 'unnamed',
    difficulty: null,
    verdict: undefined,
    verdictType: undefined,
    opponent: opponentP,
    participants: [rollerP, opponentP],
    adventureId: rollerRequest.adventureId,
  };

  const runVSRollWithPhysics = useFateStore.getState().runVSRollWithPhysics;
  const results = await runVSRollWithPhysics(eventSkeleton, [
    { participantId: rollerParticipantId, presetId, originSide: 'near' },
    { participantId: opponentParticipantId, presetId, originSide: 'far' },
  ]);

  // results is in participants order: [roller, opponent]
  const rollerResult = results[0] ?? { dice: [0, 0, 0, 0], total: 0, eventId, participantId: rollerParticipantId };
  const opponentResult = results[1] ?? { dice: [0, 0, 0, 0], total: 0, eventId, participantId: opponentParticipantId };

  // Build outcomes
  const rollerDiceSum = rollerResult.dice.reduce((a, b) => a + b, 0);
  const rollerTotal = rollerDiceSum + (rollerRequest.skillValue ?? 0) + (rollerRequest.manualBonus ?? 0);
  const opponentDiceSum = opponentResult.dice.reduce((a, b) => a + b, 0);
  const opponentTotal = opponentDiceSum + (opponentRequest.skillValue ?? 0) + (opponentRequest.manualBonus ?? 0);

  const { label: rollerLabel, type: rollerType } = getRollResult(
    rollerTotal,
    rollerRequest.difficulty ?? null,
    opponentTotal,
  );
  const { label: opponentLabel, type: opponentType } = getRollResult(
    opponentTotal,
    null,
    rollerTotal,
  );

  // ── Строим outcomes ДО hold-таймера ──
  const outcomes: { roller: DiceRollOutcome; opponent: DiceRollOutcome } = {
    roller: {
      dice: rollerResult.dice,
      diceSum: rollerDiceSum,
      total: rollerTotal,
      label: rollerLabel,
      type: rollerType,
      eventId,
      participantId: rollerParticipantId,
      usedPhysics: true,
    },
    opponent: {
      dice: opponentResult.dice,
      diceSum: opponentDiceSum,
      total: opponentTotal,
      label: opponentLabel,
      type: opponentType,
      eventId,
      participantId: opponentParticipantId,
      usedPhysics: true,
    },
  };

  // ── onResult callback: лог пишется ПОКА КУБЫ ЕЩЁ НА СТОЛЕ ──
  // Вызывается СРАЗУ после получения результатов физики для обеих сторон,
  // ДО hold-таймера. Пользователь видит кубы обоих игроков на столе И
  // одновременно запись в логе с результатом VS броска.
  if (opts.onResult) {
    await opts.onResult(outcomes);
  }

  // ── Hold dice on table, then dismiss overlay ──
  // VS бросок: кубики обоих игроков лежат на столе, результат сравнения
  // виден на гранях + в полоске. 4 секунды — хватает чтобы сравнить.
  const holdMs = opts.holdBeforeDismissMs ?? 4000;
  const store = useFateStore.getState();
  if (store.liveRollStage?.id === eventId) {
    await new Promise((r) => setTimeout(r, holdMs));
    store.requestLiveRollExit();
    await new Promise((r) => setTimeout(r, 250));
  }

  return outcomes;
}

// ─────────────────────────────────────────────────────────────
// SILENT roll executor — for NPC rolls (no physics, no overlay)
// ─────────────────────────────────────────────────────────────

/**
 * Выполняет бросок 4dF «молча»: чистый performRoll из fate-dice.ts,
 * БЕЗ physics-service, БЕЗ overlay-события, БЕЗ runRollWithPhysics.
 *
 * Используется для NPC-бросков в массовых сценариях (executeMassRollSimultaneous
 * с canUsePhysics=false) и в любых контекстах где нужен быстрый Math.random
 * без 3D-анимации — например, фоновые NPC-защиты в массовых атаках.
 *
 * Возвращает DiceRollOutcome с usedPhysics: false. eventId/participantId
 * отсутствуют (overlay-событие не создавалось).
 */
export function executeDiceRollSilent(req: DiceRollRequest): DiceRollOutcome {
  const skillValue = req.skillValue ?? 0;
  const manualBonus = req.manualBonus ?? 0;
  const difficulty = req.difficulty ?? null;
  const opponentTotal = req.opponentTotal ?? null;

  const r = performRoll(skillValue + manualBonus, difficulty, opponentTotal);
  return {
    dice: r.dice,
    diceSum: r.dice.reduce<number>((sum, d) => sum + d, 0),
    total: r.total,
    label: r.label,
    type: r.type,
    usedPhysics: false,
  };
}

// ─────────────────────────────────────────────────────────────
// ZONAL MASS ROLL — N participants throwing simultaneously
// ─────────────────────────────────────────────────────────────

/**
 * Compute lateral X offsets and originSide for N participants throwing
 * simultaneously on the same arena. Each participant gets a (x, side) slot
 * so their dice spawn in different zones and don't overlap on the table.
 *
 * Layout strategy:
 *   N=1: single center slot.
 *   N=2: two slots on the near edge, spread ±1.2 in X.
 *   N=3: three slots on the near edge, spread -1.6 / 0 / +1.6.
 *   N=4: 2x2 grid — 2 near + 2 far, ±1.2 in X.
 *   N=5: plus-shape — 4 corners (±1.6, near+far) + center (0, near).
 *   N>5: distribute along the near edge with step 1.2:
 *        x = (i - (N-1)/2) * 1.2, side = 'near'.
 *
 * Returns array of {x, side} in participant-index order (length === n).
 */
export function computeZonalLayout(n: number): Array<{ x: number; side: 'near' | 'far' }> {
  const N = Math.max(1, Math.floor(n));
  if (N === 1) {
    return [{ x: 0, side: 'near' }];
  }
  if (N === 2) {
    return [
      { x: -1.2, side: 'near' },
      { x: 1.2, side: 'near' },
    ];
  }
  if (N === 3) {
    return [
      { x: -1.6, side: 'near' },
      { x: 0, side: 'near' },
      { x: 1.6, side: 'near' },
    ];
  }
  if (N === 4) {
    return [
      { x: -1.2, side: 'near' },
      { x: 1.2, side: 'near' },
      { x: -1.2, side: 'far' },
      { x: 1.2, side: 'far' },
    ];
  }
  if (N === 5) {
    return [
      { x: -1.6, side: 'near' },
      { x: 1.6, side: 'near' },
      { x: -1.6, side: 'far' },
      { x: 1.6, side: 'far' },
      { x: 0, side: 'near' },
    ];
  }
  // N > 5: spread along near edge with step 1.2
  const layout: Array<{ x: number; side: 'near' | 'far' }> = [];
  for (let i = 0; i < N; i++) {
    const x = (i - (N - 1) / 2) * 1.2;
    layout.push({ x, side: 'near' });
  }
  return layout;
}

/**
 * Execute a SIMULTANEOUS MASS roll — N participants throw at the SAME time
 * from different lateral slots on the arena. Each participant's dice spawn
 * at a distinct (originX, originSide) position so dice don't overlap.
 *
 * This is the N-participant generalization of `executeVSRollSimultaneous`
 * (which is locked to 2). It uses `runMassRollWithPhysics` (which supports
 * arbitrary N) and the `computeZonalLayout` helper to assign slots.
 *
 * Layout per N is documented in `computeZonalLayout`.
 *
 * Для 2D fallback (canUsePhysics=false): все N бросков выполняются как
 * `executeDiceRollSilent` параллельно (Promise.all), без анимации.
 *
 * `opts.onResult(outcomes)` вызывается СРАЗУ после получения результатов
 * физики для ВСЕХ участников (ДО hold-таймера) — в этот момент кубики
 * всех участников ещё лежат на столе, и лог можно записать пока они видны.
 */
export async function executeMassRollSimultaneous(
  requests: DiceRollRequest[],
  opts: {
    canUsePhysics: boolean;
    presetId?: string;
    holdBeforeDismissMs?: number;
    onResult?: (outcomes: DiceRollOutcome[]) => void | Promise<void>;
  },
): Promise<DiceRollOutcome[]> {
  const N = requests.length;

  // ── 2D fallback: all silent, in parallel ──
  if (!opts.canUsePhysics || N === 0) {
    const outcomes = requests.map((req) => executeDiceRollSilent(req));
    if (opts.onResult) {
      await opts.onResult(outcomes);
    }
    return outcomes;
  }

  // ── 3D: simultaneous zonal mass roll via runMassRollWithPhysics ──
  // ── Preset selection for mass rolls ──
  // При N≥3 участниках (12+ кубиков одновременно в одном world) пресет 'power'
  // (vy=3-4.5, vz=3.5-5.0) слишком агрессивен — CCD не успевает ловить пол,
  // кубики tunnel-ят (16 × 6 = 96 tunnel events за 2с), safety-freeze срабатывает
  // на каждом кубике. Хотя safety-freeze теперь snap'ит к грани (без дрожания),
  // лучше вообще избежать туннелирования — используем 'normal' для N≥3.
  // 'normal' (vy=2.6-3.4, vz=2.6-3.4) — заметная дуга, 2-3 отскока, но без
  // экстремальных скоростей → CCD стабильно ловит пол → кубики реально
  // отскакивают и катаются → результат читается по настоящей физике.
  // Для N=1,2 (одиночный/VS) — 'power' как раньше (1-2 сессии = 4-8 кубиков,
  // CCD справляется).
  const defaultPresetForN = N >= 3 ? 'normal' : 'power';
  const presetId = opts.presetId ?? defaultPresetForN;
  const eventId = `mass-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const layout = computeZonalLayout(N);
  const now = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);

  // Build modifiers per request
  const buildModifiers = (req: DiceRollRequest): { label: string; value: number }[] => {
    const mods: { label: string; value: number }[] = [];
    if (req.skillName && req.skillValue) {
      mods.push({ label: req.skillName, value: req.skillValue });
    }
    if (req.manualBonus && req.manualBonus !== 0) {
      mods.push({
        label: req.manualBonus > 0 ? 'ситуативный' : 'штраф',
        value: req.manualBonus,
      });
    }
    return mods;
  };

  // Stamp the local roller's palette as the default for any participant that
  // doesn't carry its own colors. Mass rolls initiated by the GM roll for
  // several PCs at once — each PC's request SHOULD set peerId + colors (see
  // mass-roll-inline buildRequest), but if it doesn't, we fall back to the
  // local viewer's palette so the dice are never colorless on remote clients.
  const localRoller = resolveLocalRollerColors();

  // Build participants array — one entry per request
  const participants = requests.map((req, i) => {
    const participantId = `phys-mass-${i}-${req.characterId ?? 'p'}-${now}-${rand}`;
    const mods = buildModifiers(req);
    return {
      id: participantId,
      characterName: req.characterName,
      characterId: req.characterId,
      // Per-player dice colors: carry peerId + color snapshot so the overlay
      // renders each participant's dice in their own palette. enqueueLiveRoll
      // will resolve from peerDiceColors if colors aren't set here directly.
      peerId: req.peerId ?? localRoller.peerId,
      diceColor: req.diceColor ?? localRoller.diceColor,
      symbolColor: req.symbolColor ?? localRoller.symbolColor,
      skillName: req.skillName,
      skillValue: req.skillValue || undefined,
      manualBonus: req.manualBonus ?? 0,
      dice: [0, 0, 0, 0],
      diceSum: 0,
      total: 0,
      resultLabel: '...',
      resultType: 'tie' as const,
      // role: 'defender' if explicitly requested, otherwise 'roller'.
      // (mass-roll сценарии обычно все — 'roller'; defender используется
      // в массовых защитах где N защитников бросают одновременно.)
      role: (req.role === 'defender' ? 'defender' : 'roller') as
        | 'roller'
        | 'opponent'
        | 'helper'
        | 'attacker'
        | 'defender',
      modifiers: mods.length > 0 ? mods : undefined,
    };
  });

  const eventSkeleton: Omit<LiveRollEvent, 'pendingPhysics' | 'pendingPhysicsSessions'> = {
    id: eventId,
    type: 'mass',
    rolledBy: requests[0]?.rolledBy || requests[0]?.characterName || 'GM',
    rolledAt: now,
    title: `Массовый бросок (${N})`,
    actionContext: 'mass',
    difficulty: null,
    verdict: undefined,
    verdictType: undefined,
    participants,
    adventureId: requests[0]?.adventureId,
  };

  // Build sessions array — one per participant, with computed (originX, originSide)
  const sessions = participants.map((p, i) => {
    const slot = layout[i] ?? { x: 0, side: 'near' as const };
    return {
      participantId: p.id,
      presetId,
      originSide: slot.side,
      originX: slot.x,
    };
  });

  const runMassRollWithPhysics = useFateStore.getState().runMassRollWithPhysics;
  const results = await runMassRollWithPhysics(eventSkeleton, sessions);

  // Build outcomes in participant order
  const outcomes: DiceRollOutcome[] = participants.map((p, i) => {
    const req = requests[i];
    const result = results[i] ?? { dice: [0, 0, 0, 0], total: 0, eventId, participantId: p.id };
    const diceSum = result.dice.reduce((a, b) => a + b, 0);
    const total = diceSum + (req.skillValue ?? 0) + (req.manualBonus ?? 0);
    // For mass roll: difficulty/opponent are not used (no per-participant
    // verdict) — but pass them through if the request had them so the
    // label is informative (e.g. "Успех (+2)" vs difficulty).
    const { label, type } = getRollResult(
      total,
      req.difficulty ?? null,
      req.opponentTotal ?? null,
    );
    return {
      dice: result.dice,
      diceSum,
      total,
      label,
      type,
      eventId,
      participantId: p.id,
      usedPhysics: true,
    };
  });

  // ── onResult callback: лог пишется ПОКА КУБЫ ЕЩЁ НА СТОЛЕ ──
  // Вызывается СРАЗУ после получения результатов физики для всех N
  // участников, ДО hold-таймера. Кубики всех участников ещё лежат на
  // столе в своих зонах — пользователь видит результаты на гранях И
  // одновременно записи в логе.
  if (opts.onResult) {
    await opts.onResult(outcomes);
  }

  // ── Hold dice on table, then dismiss overlay ──
  // Mass бросок: кубики всех N участников лежат на столе в своих зонах.
  // 4 секунды — хватает оценить результаты всех участников.
  const holdMs = opts.holdBeforeDismissMs ?? 4000;
  const store = useFateStore.getState();
  if (store.liveRollStage?.id === eventId) {
    await new Promise((r) => setTimeout(r, holdMs));
    store.requestLiveRollExit();
    await new Promise((r) => setTimeout(r, 250));
  }

  return outcomes;
}
