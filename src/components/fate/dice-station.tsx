'use client';

// ============================================================
// DiceStation — единый блок «набор кубиков на столе»
// ============================================================
//
// В левой панели лежит 4 настоящих 3D-кубика как физические
// объекты (вид сверху, с небольшим наклоном для 3D-объёма).
// Под ними — кнопка управления броском и последний результат.
//
// ── ДВА РЕЖИМА КНОПКИ ──
// 1. rollMode=false (сцена): одна большая кнопка.
//    • Обычное состояние: синяя «Настройки броска».
//    • Приглашение к mass-roll: оранжевая «Приглашение к броску».
//    • Есть результат mass-roll: зелёная с ✓.
//    Клик → открывает RollToolPanel (onOpenRollMenu).
//
// 2. rollMode=true (панель броска открыта): ДВЕ кнопки поменьше.
//    • «←Назад» — возвращает к блоку сцены (onBack).
//    • Динамическая кнопка броска (3 состояния):
//      a) IDLE — синяя «Бросить»: кубы НЕ брошены. Клик → emitRandomThrowGesture.
//      b) IN-FLIGHT — оранжевая «Вернуть кубы» DISABLED: физика летит,
//         результат ещё не зафиксирован. Кнопка неактивна.
//      c) SETTLED — оранжевая «Вернуть кубы» ACTIVE: кубы на столе, результат
//         в логе. Клик → requestLiveRollExit() → return-анимация → dismiss.
//
//    Переход IDLE → IN-FLIGHT инициируется КАК кликом по кнопке, ТАК и
//    drag-броском (RollGestureProvider → roll-gesture-bus → handleRoll →
//    liveRollStage с pendingPhysics). Состояние кнопки обновляется реактивно
//    из store (liveRollStage, pendingPhysics).
//
// ── DRAG ИЗ КЕЙСА ──
// Когда RollToolPanel открыт (rollMode=true) И на столе НЕТ живых кубов
// (liveRollStage пуст или exiting) — кубы в кейсе становятся draggable.
// Игрок "берёт" их мышью и тащит на центральную карту. При drop — gesture
// вычисляется в RollGestureProvider и эмитится через roll-gesture-bus.
//
// Если на столе УЖЕ есть кубы от предыдущего броска — drag отключён.
// Это prevents «схватить кубы из пустого кейса» (нелогичное действие) и
// дублирование 8 кубов на карте (4 ghost + 4 held). Для нового броска
// игрок жмёт «Вернуть кубы» (если кубы на столе) → кубы уходят в кейс
// (return-анимация) → кнопка снова синяя «Бросить» → новый бросок.
//
// DROP НА КЕЙС: если игрок отпускает кубы над DiceStation (зона
// DROPPABLE_CASE_ID), кубы "возвращаются в кейс" — бросок отменяется.

import { Dices, Zap, WifiOff, Hand, ArrowDownToLine, ArrowLeft, Dice5, RotateCcw, Loader2 } from 'lucide-react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useFateStore } from '@/lib/store';
import { useDicePhysics } from '@/hooks/use-dice-physics';
import { DRAGGABLE_ID, DROPPABLE_CASE_ID } from '@/components/fate/roll-gesture-provider';
import { emitRandomThrowGesture } from '@/lib/roll-gesture-bus';
import { DiceFaceSvg } from './dice-face-svg';
import type { FudgeFace } from '@/lib/dice-2d-physics';
import { derivePalette, suggestSymbolShadow } from '@/lib/dice-palette';
import { DiceCustomizerButton } from './dice-customizer-button';
// DiceCase3D — настоящие 3D кубики в кейсе (Three.js / R3F).
// Динамический импорт — R3F/Three.js тяжёлые, не нужны на SSR.
// Рендерится ТОЛЬКО когда diceMode === '3d' (см. условный рендер ниже).
// В режиме 2D — статичные 2D-плитки (тот же стиль, но без WebGL).
const DiceCase3D = dynamic(() => import('./dice-case-3d').then((m) => m.DiceCase3D), {
  ssr: false,
  loading: () => null,
});

// ── Палитра 2D-плиток (совпадает с Dice2DCanvas и 3D-кубиками) ──────────
// Раньше была жёстко зашитая сине-белая палитра. Теперь кубики кастомизируются:
// цвет тела и символа берутся из store (diceColor, symbolColor).
// ВАЖНО: сам компонент не строит градиент здесь — он строит его через useMemo
// ниже, потому что useFateStore реактивно обновляет цвет при смене палитры.

// ── Конвертация number → FudgeFace (1/+1, 0, -1) ──
function toFudgeFace(v: number): FudgeFace {
  if (v > 0) return 1;
  if (v < 0) return -1;
  return 0;
}

export interface DiceStationProps {
  /** Вызывается при клике на «Настройки броска» — открывает RollToolPanel. */
  onOpenRollMenu: () => void;
  /** Вызывается при клике «←Назад» — закрывает RollToolPanel, возврат к сцене. */
  onBack?: () => void;
  /** Активно ли приглашение к mass-roll (оранжевая пульсация + бейдж «!»). */
  hasMyMassRollRequest?: boolean;
  /** Есть ли завершённый mass-roll результат (мягкая зелёная подсветка + «✓»). */
  hasMyMassRollResult?: boolean;
  /** RollToolPanel открыт (rollMode активен). Когда true — показываем две кнопки
   *  («←Назад» и «Бросить») вместо одной большой. */
  rollModeActive?: boolean;
}

export function DiceStation({
  onOpenRollMenu,
  onBack,
  hasMyMassRollRequest = false,
  hasMyMassRollResult = false,
  rollModeActive = false,
}: DiceStationProps) {
  const physics = useDicePhysics();
  const lastDiceResult = useFateStore((s) => s.lastDiceResult);
  const liveRollStage = useFateStore((s) => s.liveRollStage);
  const liveRollExiting = useFateStore((s) => s.liveRollExiting);
  const diceMode = useFateStore((s) => s.diceMode);
  const setDiceMode = useFateStore((s) => s.setDiceMode);
  const requestLiveRollExit = useFateStore((s) => s.requestLiveRollExit);
  // ── Network: detect if this is a player with no assigned characters ──
  // When a network player opens the roll panel but hasn't been assigned a
  // character yet (assignment still in flight from the host), we must NOT
  // enable the drag — otherwise the player drags dice, handleRoll bails with
  // "no character", and the held-dice bridge leaves dice briefly on the table.
  // Showing a clear "waiting for assignment" hint guides the player instead.
  const isNetworkActive = useFateStore((s) => s.isNetworkActive);
  const networkRole = useFateStore((s) => s.networkRole);
  const networkMyPeerId = useFateStore((s) => s.networkMyPeerId);
  const playerAssignments = useFateStore((s) => s.playerAssignments);
  const isPlayerWithoutAssignment = isNetworkActive
    && networkRole === 'player'
    && !!networkMyPeerId
    && (playerAssignments[networkMyPeerId]?.length ?? 0) === 0;
  // ── Кастомизация: цвет тела куба и символа из store ──
  const diceColor = useFateStore((s) => s.diceColor);
  const symbolColor = useFateStore((s) => s.symbolColor);
  const diceFaceBg = useMemo(() => {
    const p = derivePalette(diceColor);
    return `linear-gradient(135deg, ${p.top} 0%, ${p.mid} 50%, ${p.bottom} 100%)`;
  }, [diceColor]);
  const symbolShadow = useMemo(
    () => suggestSymbolShadow(diceColor),
    [diceColor],
  );

  // ── Состояние кнопки броска (когда rollMode активен) ──
  //   • IDLE     — кубы НЕ брошены → синяя «Бросить» → emitRandomThrowGesture.
  //   • IN-FLIGHT — физика летит (pendingPhysics set) → оранжевая «Вернуть кубы» DISABLED.
  //   • SETTLED   — кубы на столе, результат зафиксирован → оранжевая «Вернуть кубы» ACTIVE
  //                → requestLiveRollExit() → return-анимация → dismiss.
  //
  // hasLiveDice = liveRollStage активен И не exiting (кубы на столе / в полёте).
  // pendingPhysics — признак того, что физика ещё не финализирована (кубы в полёте).
  const hasLiveDice = !!liveRollStage && !liveRollExiting;
  const hasPendingPhysics = !!(
    liveRollStage?.pendingPhysics ||
    liveRollStage?.pending2DPhysics ||
    (liveRollStage?.pendingPhysicsSessions && liveRollStage.pendingPhysicsSessions.length > 0)
  );
  // diceInFlight = кубы в полёте (физика активна). Кнопка disabled.
  // diceSettled  = кубы на столе, но физика уже финализирована. Кнопка активна "Вернуть кубы".
  const diceInFlight = hasLiveDice && hasPendingPhysics;
  const diceSettled = hasLiveDice && !hasPendingPhysics;

  // ── Draggable tray ──
  // drag разрешён ТОЛЬКО когда rollMode активен, на столе нет живых кубов,
  // И НЕТ активной exit-анимации (liveRollExiting). Во время exit-анимации
  // (450мс после "Вернуть кубы") buffer ещё содержит кадры старых кубов.
  // Если разрешить drag в этом окне — triggerReturnToCase2D захватит stale
  // позиции и ghost-кубы (indices 4-7) полетят из центра карты в кейс
  // ("4 куба поднимаются в центре и исчезают").
  // ДОПОЛНИТЕЛЬНО: drag отключён для сетевого игрока без назначенного
  // персонажа — иначе он притащит кубы на стол, handleRoll вернётся с ошибкой
  // "Выберите персонажа", а bridge-mode оставит кубы видимыми ~400мс.
  const dragEnabled = rollModeActive && !hasLiveDice && !liveRollExiting && !isPlayerWithoutAssignment;

  const { attributes, listeners, setNodeRef: setDragNodeRef, isDragging } = useDraggable({
    id: DRAGGABLE_ID,
    disabled: !dragEnabled,
  });

  // ── Droppable: кубы можно "вернуть в кейс", отпустив их над DiceStation ──
  // Активен только когда dragEnabled (rollMode + нет живых кубов).
  const { setNodeRef: setDropNodeRef, isOver: isCaseOver } = useDroppable({
    id: DROPPABLE_CASE_ID,
    disabled: !dragEnabled,
  });

  const hasRoll = !!liveRollStage;
  const connected = physics.connected;

  // ── Is the current liveRollStage a LOCAL roll (initiated by this viewer)?
  //    The dice case / station should only visually empty out for the player
  //    who actually threw the dice. Remote viewers (GM watching a player's
  //    roll, or another player) keep their own dice in the case.
  //    • Offline → every roll is local.
  //    • Online + roller's peerId === my peerId → local (my PC).
  //    • Online + participant.peerId == null AND I'm host → local (GM rolling NPC).
  //    • Otherwise → someone else's broadcast roll → NOT local.
  const isLocalRoll = (() => {
    if (!hasRoll) return false;
    if (!isNetworkActive) return true;
    const rollerPeerId = liveRollStage?.participants?.[0]?.peerId;
    if (rollerPeerId != null && networkMyPeerId != null && rollerPeerId === networkMyPeerId) {
      return true;
    }
    if (rollerPeerId == null && networkRole === 'host') {
      return true;
    }
    return false;
  })();

  // ── Начальные грани для display-кубов в кейсе ──
  // На первой загрузке (пока не было бросков) lastDiceResult пуст →
  // показываем СЛУЧАЙНЫЕ грани вместо всех пустых (0). useMemo гарантирует
  // что грани генерируются ОДИН РАЗ (при первом рендере) и не меняются
  // при каждом re-render. Как только происходит реальный бросок —
  // lastDiceResult заполняется и перебивает initialRandomDice.
  const initialRandomDice = useMemo(() => {
    const faces: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = Math.random();
      faces.push(r < 1 / 3 ? 1 : r < 2 / 3 ? 0 : -1);
    }
    return faces;
  }, []);

  const dice = lastDiceResult.length === 4
    ? lastDiceResult
    : initialRandomDice;

  const diceSum = dice.reduce((a, b) => a + b, 0);
  const sumStr = diceSum > 0 ? '+' + diceSum : String(diceSum);

  const lastLabel =
    diceSum >= 4 ? 'Стиль!' :
    diceSum >= 1 ? 'Успех' :
    diceSum === 0 ? 'Ничья' :
    diceSum >= -3 ? 'Провал' :
    'Катастрофа';

  // caseRolling = a LOCAL throw is in progress (dice have left the case).
  // Remote rolls (broadcast from another player) must NOT fade this viewer's
  // case — only the roller's own case empties.
  const caseRolling = hasRoll && isLocalRoll && !liveRollExiting;

  // ── Обработчик «Бросить» (idle state) ──
  // Эмитит синтетический gesture со случайными spawnX/spawnZ/direction/velocity.
  // RollToolPanel ловит его через onRollGesture → handleRoll(gesture) →
  // executeDiceRoll → physics-service бросает из случайной точки.
  // Сразу после клика liveRollStage получает pendingPhysics → кнопка
  // реактивно становится оранжевой «Вернуть кубы» (disabled).
  const handleRandomThrow = () => {
    if (diceInFlight) return;  // защита от double-click
    emitRandomThrowGesture();
  };

  // ── Обработчик «Вернуть кубы» (settled state) ──
  // Запускает return-анимацию через requestLiveRollExit() → exiting=true →
  // RollStageOverlay играет фазу 'exit' (450мс) → dismissLiveRoll →
  // liveRollStage=null → кнопка реактивно становится синей «Бросить».
  // Попутно clearSharedDiceBuffer (в RollStageOverlay useEffect) уберёт кубы с карты.
  const handleReturnToCase = () => {
    if (!diceSettled) return;
    requestLiveRollExit();
  };

  // ── Обработчик «←Назад» ──
  const handleBack = () => {
    onBack?.();
  };

  // Стили большой кнопки (когда rollMode=false):
  // 1. hasMyMassRollRequest — ОРАНЖЕВАЯ пульсация + «Приглашение к броску»
  // 2. hasMyMassRollResult — мягкая зелёная подсветка + «✓»
  // 3. Иначе — обычная акцентная (синяя) + «Настройки броска»
  const buttonClass = `fate-dice-station__roll-btn ${
    hasMyMassRollRequest ? 'fate-invite-pulse-orange' : ''
  }`;
  const buttonStyle: React.CSSProperties = hasMyMassRollRequest
    ? { background: 'linear-gradient(135deg, #e67e22, #f39c12)' }
    : hasMyMassRollResult
      ? { background: 'linear-gradient(135deg, #27ae60, #2ecc71)' }
      : {}; // default — CSS class fate-dice-station__roll-btn

  const buttonTitle = hasMyMassRollRequest
    ? 'Вас приглашают к броску! Нажмите, чтобы открыть меню броска.'
    : hasMyMassRollResult
      ? 'У вас есть результаты броска — нажмите, чтобы посмотреть или сделать корректировки'
      : connected
        ? 'Открыть меню броска (проверка / VS / совместный / массовый)'
        : 'Открыть меню броска (physics offline — будет использован 2D режим)';

  // Классы для tray когда dragEnabled:
  // - cursor: grab (или grabbing когда тащат)
  // - лёгкая пульсация "схвати меня" через fate-dice-station__tray--drag-ready
  // - opacity: 0.4 когда тащат (кубы "ушли" с кейса)
  // - подсветка зелёным когда курсор над кейсом во время drag (верни кубы)
  const trayClass = `fate-dice-station__tray${
    dragEnabled ? ' fate-dice-station__tray--drag-ready' : ''
  }${isDragging ? ' fate-dice-station__tray--dragging' : ''
  }${isCaseOver ? ' fate-dice-station__tray--case-over' : ''}`;

  // Compose both refs: tray is BOTH draggable (setDragNodeRef) AND droppable
  // (setDropNodeRef). dnd-kit supports combining these.
  const setTrayRef = (node: HTMLElement | null) => {
    setDragNodeRef(node);
    setDropNodeRef(node);
  };

  return (
    <div className="fate-dice-station">
      <div className="fate-dice-station__header">
        <Dices size={13} className="fate-dice-station__icon" />
        <span className="fate-dice-station__title">Набор кубиков</span>
        {dragEnabled && (
          <span
            className="fate-dice-station__drag-hint"
            title="Перетащите кубы на карту, чтобы бросить"
          >
            <Hand size={11} />
            <span className="ml-0.5">тащи</span>
          </span>
        )}
        {/* ── "Waiting for assignment" hint for network players ──
            When a network player opens the roll panel but the GM hasn't
            assigned them a character yet, the drag is disabled and this
            pulsing amber badge explains WHY — instead of leaving the player
            confused about why the "тащи" hint is gone and the "Бросить"
            button seems to do nothing. */}
        {rollModeActive && isPlayerWithoutAssignment && (
          <span
            className="fate-dice-station__wait-hint"
            title="Мастер ещё не назначил вам персонажа. Когда назначит — вы сможете бросать кубы."
          >
            <span className="size-1.5 rounded-full bg-amber-400 animate-pulse" />
            жду персонажа
          </span>
        )}
        {/* ── Переключатель 2D / 3D режима прямо в шапке кейса ──
            Маленький бейдж-кнопка: показывает текущий режим и переключает
            по клику. 3D — оранжевый акцент (физика Rapier3D), 2D — синий
            (мгновенный Math.random). Полное описание режимов — в диалоге
            настроек (вкладка «Сцена»), здесь только быстрое переключение. */}
        <button
          type="button"
          className={`fate-dice-station__badge fate-dice-station__badge--toggle fate-dice-station__badge--${
            diceMode === '3d' ? '3d' : '2d'
          }`}
          onClick={() => setDiceMode(diceMode === '3d' ? '2d' : '3d')}
          aria-pressed={diceMode === '3d'}
          title={
            diceMode === '3d'
              ? 'Режим: 3D физика (Rapier3D). Нажмите, чтобы переключиться на 2D (мгновенный бросок).'
              : 'Режим: 2D (мгновенный бросок). Нажмите, чтобы переключиться на 3D физику (Rapier3D).'
          }
        >
          {diceMode === '3d' ? '3D' : '2D'}
        </button>
        {/* ── Быстрый доступ к настройке цветов кубов прямо из кейса ──
            Открывает Popover с DiceColorPicker (та же панель что и во вкладке
            «Сцена» диалога настроек). На кнопке — два мини-свотча текущих
            цветов (тело + символ), чтобы игрок видел палитру не открывая пикер.
            Кнопка живёт в шапке — отдельной от tray с drag-listeners, поэтому
            клик по ней не запускает перетаскивание кубов.
            Тот же компонент DiceCustomizerButton используется и в главном header
            (variant='toolbar') — единый UX в обоих местах. */}
        <DiceCustomizerButton variant="station" />
      </div>

      <div
        ref={setTrayRef}
        className={trayClass}
        {...(dragEnabled ? attributes : {})}
        {...(dragEnabled ? listeners : {})}
        role={dragEnabled ? 'button' : undefined}
        aria-label={dragEnabled ? 'Перетащите кубы на карту для броска' : undefined}
        title={dragEnabled ? 'Перетащите кубы на карту для броска' : (hasLiveDice ? 'Кубы на столе — нажмите «Вернуть кубы» чтобы убрать их в кейс' : undefined)}
      >
        <div className="fate-dice-station__tray-inner">
          {/* ── Режим-зависимый рендер кейса ──
              • 3D-режим: настоящие 3D кубики (DiceCase3D) — WebGL-сцена с
                4 физическими кубиками, вид сверху с наклоном. Кубики лежат
                на «подносе», лёгкое покачивание. Тот же стиль что и на карте.
              • 2D-режим: статичные 2D-плитки — 4 синих плитки с белыми
                SVG-символами. Без WebGL, мгновенный рендер. Тот же стиль
                что и у 2D-бросков на карте.

              Оба режима используют ОДНУ палитру (BLUE_TOP/MID/BOTTOM + белые
                символы) — единый визуальный язык. В будущем редактор кубов
                будет менять общую палитру — оба режима подхватят её.

              caseRolling / isDragging → кубы «исчезают» (fading):
                • 3D: DiceCase3D rolling=true (scale→0 анимация)
                • 2D: fate-dice-station__case-tile--fading (opacity 0.35 + scale 0.92) */}
          {diceMode === '3d' ? (
            <div className="fate-dice-station__case-3d">
              <DiceCase3D
                dice={dice}
                rolling={caseRolling || isDragging}
                returning={false}
              />
            </div>
          ) : (
            <div className="fate-dice-station__case-tiles">
              {dice.map((v, i) => {
                const face = toFudgeFace(v);
                return (
                  <div
                    key={i}
                    className={`fate-dice-station__case-tile${
                      caseRolling || isDragging ? ' fate-dice-station__case-tile--fading' : ''
                    }`}
                    style={{
                      background: diceFaceBg,
                    }}
                  >
                    {/* Виньетка для объёма (как у 3D-текстур и 2D-плиток на карте) */}
                    <div
                      aria-hidden="true"
                      className="fate-dice-station__case-tile-vignette"
                    />
                    {/* SVG-символ грани (идеально центрирован) */}
                    <div className="fate-dice-station__case-tile-symbol">
                      <DiceFaceSvg
                        face={face}
                        size="100%"
                        symbolColor={symbolColor}
                        shadowColor={symbolShadow}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="fate-dice-station__glass" />
        <div className="fate-dice-station__result">
          <span className="fate-dice-station__result-sum">{sumStr}</span>
          <span className="fate-dice-station__result-label">{lastLabel}</span>
        </div>
        {/* ── Индикатор "верни в кейс" (когда курсор над tray во время drag) ── */}
        {isCaseOver && !isDragging && (
          <div className="fate-dice-station__case-overlay">
            <ArrowDownToLine size={18} />
            <span>вернуть</span>
          </div>
        )}
        {/* ── Индикатор "кубы на столе" (когда liveRollStage активен, drag отключён) ── */}
        {rollModeActive && hasLiveDice && !isDragging && (
          <div className="fate-dice-station__live-badge" title="Кубы на столе — нажмите «Вернуть кубы» чтобы убрать их в кейс">
            <span className="size-1.5 rounded-full bg-amber-400 animate-pulse" />
            на столе
          </div>
        )}
      </div>

      {/* ── КНОПКИ УПРАВЛЕНИЯ ──
          rollMode=false → одна большая кнопка (Настройки броска / Приглашение).
          rollMode=true  → две кнопки поменьше: «←Назад» и динамическая кнопка
                          броска (3 состояния: idle/in-flight/settled). */}
      {rollModeActive ? (
        <div className="fate-dice-station__dual-buttons">
          <button
            type="button"
            onClick={handleBack}
            className="fate-dice-station__btn-back"
            title="Вернуться к списку персонажей"
          >
            <ArrowLeft size={14} />
            <span>Назад</span>
          </button>
          {/* ── Динамическая кнопка броска ──
              • IDLE     → синяя «Бросить» (active) → emitRandomThrowGesture.
              • IN-FLIGHT → оранжевая «Вернуть кубы» (disabled, spinner).
              • SETTLED  → оранжевая «Вернуть кубы» (active) → requestLiveRollExit. */}
          <button
            type="button"
            onClick={diceSettled ? handleReturnToCase : handleRandomThrow}
            disabled={diceInFlight || isPlayerWithoutAssignment}
            className={`fate-dice-station__btn-throw${
              diceInFlight || diceSettled ? '' : ' fate-dice-station__btn-throw--idle'
            }${diceInFlight ? ' fate-dice-station__btn-throw--disabled' : ''}${
              isPlayerWithoutAssignment ? ' fate-dice-station__btn-throw--disabled' : ''
            }`}
            title={
              isPlayerWithoutAssignment
                ? 'Мастер ещё не назначил вам персонажа — дождитесь назначения'
                : diceInFlight
                  ? 'Кубы в полёте — дождитесь результата'
                  : diceSettled
                    ? 'Вернуть кубы в кейс (возврат с анимацией)'
                    : 'Бросить кубики из случайной точки со случайной силой'
            }
          >
            {isPlayerWithoutAssignment ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                <span>Жду персонажа</span>
              </>
            ) : diceInFlight ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                <span>Вернуть кубы</span>
              </>
            ) : diceSettled ? (
              <>
                <RotateCcw className="size-4" />
                <span>Вернуть кубы</span>
              </>
            ) : (
              <>
                <Dice5 className="size-4" />
                <span>Бросить</span>
              </>
            )}
            {diceMode === '3d' && !connected && !diceInFlight && !diceSettled && (
              <span
                className="fate-dice-station__offline"
                title="Physics service недоступен — бросок будет в 2D режиме"
              >
                <WifiOff size={11} /> offline
              </span>
            )}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpenRollMenu}
          className={buttonClass}
          title={buttonTitle}
          style={buttonStyle}
        >
          <Zap size={16} />
          <span>
            {hasMyMassRollRequest ? 'Приглашение к броску' : 'Настройки броска'}
          </span>
          {hasMyMassRollRequest && (
            <span className="fate-invite-badge" aria-label="Приглашение к броску">!</span>
          )}
          {hasMyMassRollResult && !hasMyMassRollRequest && (
            <span
              className="fate-invite-badge"
              aria-label="Результаты броска"
              style={{ background: 'rgba(255,255,255,0.3)' }}
            >✓</span>
          )}
          {diceMode === '3d' && !connected && (
            <span
              className="fate-dice-station__offline"
              title="Physics service недоступен — броски будут в 2D режиме"
            >
              <WifiOff size={11} /> offline
            </span>
          )}
        </button>
      )}
    </div>
  );
}
