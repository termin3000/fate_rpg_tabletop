'use client';

// ============================================================
// RollGestureProvider — DnD-обёртка для жест-броска кубиков
// ============================================================
//
// Игрок "берёт" кубы из кейса (DiceStation, левый сайдбар) и тащит
// их на центральную карту (GameCanvas). При отпускании мы вычисляем
// gesture из ДВУХ источников:
//
//   1. ПОЗИЦИЯ DROP'А (где отпустил) → spawnX, spawnZ (ABSOLUTE spawn point)
//      Кубы появляются РОВНО В ТОЙ ТОЧКЕ, где курсор отпустили —
//      как размещение токена: "отпустил здесь — здесь и появились".
//      Это решает жалобу "кубы бросаются не из той позиции, где находился
//      курсор". Больше не "слайд справа" — кубы появляются под курсором.
//
//   2. ВЕКТОР ДВИЖЕНИЯ (куда махнул) → directionAngle (impulse rotation)
//      • скорость взмаха → preset (gentle/normal/power/lob)
//      • чисто боковой взмах → 'scatter' (веер вбок)
//      • направление → стрелка в DragOverlay + directionAngle для импульса
//      Это даёт "как сильно махнул — так сильно и бросил".
//
//   3. ВРАЩЕНИЕ ВО ВРЕМЯ DRAG (in-hand rotation) → initialQuats
//      Пока игрок тащит кубы, в DragOverlay рендерятся 4 НАСТОЯЩИХ 3D-кубика,
//      которые непрерывно вращаются (как "перемешиваются в руке"). При
//      отпускании их ТЕКУЩИЕ ориентации (кватернионы) захватываются и
//      передаются в physics-service как initialQuats. Это даёт БЕСШОВНЫЙ
//      бросок: "тащил → отпустил → кубы сразу полетели", БЕЗ отдельной
//      фазы перемешивания (SHAKE_DURATION_MS = 120мс) на сервере.
//      Случайность результата обеспечивается тем, что ориентации кубов
//      в момент отпускания случайны (зависят от того, сколько времени
//      игрок их тащил).
//
// physics-service при spawnX/spawnZ !== undefined ставит стакан В ЭТОЙ ТОЧКЕ
// арены и масштабирует горизонтальный импульс в 0.30 раз (кубы слегка
// отскакивают в сторону жеста, но остаются у drop-точки).
//
// DragOverlay: под курсором летят 4 ВРАЩАЮЩИХСЯ 3D-кубика (DiceDragOverlay3D)
// + power meter (вертикальный бар, заполняется по скорости взмаха)
// + стрелка направления броска + индикатор стороны (near/far) и латерального
// офсета (X).
//
// DROP НА КЕЙС: если игрок отпускает кубы над DiceStation (зона
// DROPPABLE_CASE_ID), кубы "возвращаются в кейс" — бросок отменяется,
// никакой физики не запускается. Это позволяет "передумать" бросать
// и положить кубы обратно.
//
// ВАЖНО: drag активен ТОЛЬКО когда RollToolPanel открыт (rollMode=true
// в scene-panel). Кубы в кейсе "оживают" — cursor:grab, лёгкая пульсация.
// Если панель закрыта — кубы статичные, drag не запускается.

import { useState, useCallback, useRef, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragMoveEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import { Dices, ArrowUp, ArrowDown, ArrowLeft, ArrowRight,
  ArrowUpLeft, ArrowUpRight, ArrowDownLeft, ArrowDownRight } from 'lucide-react';
import {
  computeRollGestureFromDrop,
  computeRollGestureFromVector,
  computeOriginFromDropPosition,
  computeDragVector,
  velocityToPreset,
  normalizeVelocity,
  getPresetMeta,
  pushVelocitySample,
  computeVelocity,
  createVelocityTracker,
  type VelocitySample,
  type ThrowPresetId,
  type RollGesture,
} from '@/lib/roll-gesture';
import { emitRollGesture } from '@/lib/roll-gesture-bus';
import { getMapScreenRect, getMapViewport } from '@/lib/map-viewport-registry';
import {
  setDragActive,
  setDragCursor,
  clearSharedDiceBuffer,
  getHeldDiceController,
  triggerReturnToCase,
} from '@/lib/held-dice-bus';
import {
  clearShared2DDiceBuffer,
  getHeldDice2DController,
  getPhysics2DActive,
  triggerReturnToCase2D,
} from '@/lib/held-dice-2d-bus';
import { useFateStore } from '@/lib/store';

// ВАРИАНТ A: DiceDragOverlay3D (отдельный маленький канвас с вращающимися
// кубами) УБРАН. Кубы теперь рендерятся в ПОСТОЯННОМ Dice3DPhysicsCanvas
// (DiceCanvasHost в MapPanel) через HeldDiceController. DragOverlay здесь
// содержит только HTML-индикаторы (power meter, стрелка направления,
// "в кейс").

const DRAGGABLE_ID = 'dice-tray';
const DROPPABLE_ID = 'roll-target';
// Drop-зона "вернуть кубы в кейс" — DiceStation регистрируется как
// droppable с этим ID. При drop сюда бросок отменяется (кубы "кладутся
// обратно в кейс").
const DROPPABLE_CASE_ID = 'dice-case-return';

interface RollGestureProviderProps {
  children: ReactNode;
}

/** Live-preview gesture во время drag (показываем стрелку под курсором). */
interface LivePreview {
  direction: RollGesture['direction'];
  originSide: 'near' | 'far';
  originX: number;
  presetId: ThrowPresetId;
}

// Карта direction → Lucide-иконка стрелки (для DragOverlay).
const DIRECTION_ICONS = {
  'up': ArrowUp,
  'down': ArrowDown,
  'left': ArrowLeft,
  'right': ArrowRight,
  'up-left': ArrowUpLeft,
  'up-right': ArrowUpRight,
  'down-left': ArrowDownLeft,
  'down-right': ArrowDownRight,
} as const;

export function RollGestureProvider({ children }: RollGestureProviderProps) {
  const [activeDrag, setActiveDrag] = useState<boolean>(false);
  // Live-preview gesture (стрелка направления + preset) во время drag.
  const [livePreview, setLivePreview] = useState<LivePreview | null>(null);
  // Live-скорость и пресет (для power meter)
  const [liveVelocity, setLiveVelocity] = useState<number>(0);
  const [livePreset, setLivePreset] = useState<ThrowPresetId>('power');
  // Находится ли курсор над зоной кейса (для подсветки "верни в кейс").
  const [overCase, setOverCase] = useState<boolean>(false);

  // Ring buffer позиций курсора для вычисления скорости И вектора движения.
  // Хранится в ref — обновляется на каждый onDragMove, но не триггерит ре-рендер.
  const velocitySamplesRef = useRef<VelocitySample[]>(createVelocityTracker());

  // ВАРИАНТ A: больше НЕТ отдельного diceOverlayRef. Кубы рендерятся в
  // постоянном DiceCanvasHost; их кватернионы и угловые скорости читаются
  // через held-dice-bus (getHeldDiceController) при dragEnd.

  // Sensors: PointerSensor для мыши, TouchSensor для мобилки.
  // activationConstraint.distance: 8px — чтобы клик на кейсе не запускал drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 8 } }),
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    if (event.active.id === DRAGGABLE_ID) {
      setActiveDrag(true);
      setLivePreview(null);
      setLiveVelocity(0);
      setLivePreset('power');
      setOverCase(false);
      velocitySamplesRef.current = createVelocityTracker();
      // ВАРИАНТ A: очищаем общий buffer и активируем drag в bus.
      // HeldDiceController (в постоянном канвасе) увидит active=true и
      // начнёт пушить кадры удерживаемых кубов под курсором.
      //
      // ── RETURN-TO-CASE: ПЕРЕД очисткой buffer захватываем позиции старых
      // кубов (если они есть на столе от предыдущего броска). triggerReturnToCase
      // читает последний кадр buffer и запускает анимацию прыжка старых кубов
      // в кейс (ghost-dice indices 4-7). Без этого старые кубы просто
      // исчезнут (мгновенный snap), а с анимацией — "запрыгивают" в кейс.
      // triggerReturnToCase безвреден если buffer пуст (нет старых кубов).
      //
      // ── 2D-режим: те же операции для shared 2D buffer. triggerReturnToCase2D
      // запускает анимацию возврата старых 2D-плиток в кейс.
      const mode = useFateStore.getState().diceMode;
      if (mode === '2d') {
        // ── FIX BUG 2 (2D исчезают до конца анимации): если 2D-физика ещё
        // активна (предыдущий бросок всё ещё катится), НЕ очищаем буфер и НЕ
        // запускаем return-to-case. Иначе старые кубы (ещё tumbling) будут
        // захвачены как ghost и fading-анимированы в кейс → пользователь видит
        // "кубы исчезают раньше чем кончается их анимация". Пусть старый бросок
        // докатится — held-контроллер подавляется пока физика активна (см.
        // dice-2d-canvas.tsx). Новый drag просто не покажет held-кубы, пока
        // старые не остановятся.
        if (!getPhysics2DActive()) {
          triggerReturnToCase2D();
          clearShared2DDiceBuffer();
        }
      } else {
        triggerReturnToCase();
        clearSharedDiceBuffer();
      }
      // ── FIX BUG 1 (3D spawn at center): сбрасываем курсор в (-1,-1) при
      // старте drag. Без этого cursorX/cursorY сохраняют СТАРОЕ значение
      // от ПРЕДЫДУЩЕГО drag (позицию отпускания — часто центр карты).
      // HeldDiceController видит active=true + stale cursor (внутри canvas)
      // и рендерит held-кубы В СТАРОЙ ТОЧКЕ до первого onDragMove → пользователь
      // видит "4 дайса в центре карты" при захвате кубов. Сброс в (-1,-1)
      // → HeldDiceController видит cx<0 → не пушит кадры → кубы НЕ видны,
      // пока курсор реально не войдёт на карту (как и ожидалось).
      setDragActive(true, -1, -1);
    }
  }, []);

  const handleDragMove = useCallback((event: DragMoveEvent) => {
    // Берём координаты центра активного элемента (призрака под курсором).
    const activeRect = event.active.rect.current?.translated;
    if (!activeRect) {
      setLivePreview(null);
      return;
    }
    const cx = activeRect.left + activeRect.width / 2;
    const cy = activeRect.top + activeRect.height / 2;

    // ВАРИАНТ A: пишем позицию курсора в bus → HeldDiceController читает её
    // каждый кадр и raycast'ит на арену → кубы следуют за курсором.
    setDragCursor(cx, cy);

    // Трекаем позицию — добавляем сэмпл в ring buffer.
    velocitySamplesRef.current = pushVelocitySample(
      velocitySamplesRef.current,
      cx,
      cy,
    );

    // Вычисляем ВЕКТОР движения (dx, dy) и скорость из истории сэмплов.
    // Вектор определяет ВСЁ: originSide, originX, preset, direction.
    const vec = computeDragVector(velocitySamplesRef.current);
    const v = computeVelocity(velocitySamplesRef.current);
    setLiveVelocity(v);

    // Ширина карты для масштабирования dx в originX (fallback 600).
    const mapRect = getMapScreenRect();
    const canvasWidth = mapRect?.width ?? 600;

    // ── Gesture из ВЕКТОРА движения ──
    // vecGesture содержит originSide/originX/preset/direction — всё из того,
    // куда игрок двигает мышь в данный момент. Live preview показывает это
    // под курсором, чтобы игрок видел "махаю вверх → кубы вылетят снизу".
    const vecGesture = vec
      ? computeRollGestureFromVector(vec.dx, vec.dy, canvasWidth, v)
      : null;
    const livePresetId = vecGesture?.presetId ?? velocityToPreset(v);
    const liveDirection = vecGesture?.direction ?? 'up';
    const liveOriginSide = vecGesture?.originSide ?? 'near';
    const liveOriginX = vecGesture?.originX ?? 0;
    setLivePreset(livePresetId);

    // Проверяем, находится ли курсор над зоной кейса (для подсветки).
    // event.over обновляется dnd-kit'ом на каждом move.
    const isOverCase = event.over?.id === DROPPABLE_CASE_ID;
    setOverCase(isOverCase);

    // Если курсор над кейсом — НЕ показываем preview броска (кубы возвращаются,
    // не бросаются). Покажем только индикатор "верни в кейс".
    if (isOverCase) {
      setLivePreview(null);
      return;
    }

    // Preview показываем только когда курсор над картой (иначе стрелка
    // висит в пустоте вне зоны броска).
    if (!mapRect) {
      setLivePreview(null);
      return;
    }
    const origin = computeOriginFromDropPosition(cx, cy, mapRect);
    if (!origin) {
      setLivePreview(null);
      return;
    }

    setLivePreview({
      direction: liveDirection,
      originSide: liveOriginSide,
      originX: liveOriginX,
      presetId: livePresetId,
    });
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    // ── TOKEN-PLACEMENT DRAG-ROLL: кубы появляются ровно под курсором ──
    //
    // Главный приоритет — ТОЧНАЯ spawn-позиция: где игрок отпустил кубы,
    // там они и появляются (как размещение токена на карте).
    //
    //   • spawnX/spawnZ — из ПОЗИЦИИ DROP'А (где отпустил).
    //   • directionAngle — из ВЕКТОРА ДВИЖЕНИЯ (куда махнул) — опционально,
    //     кубы слегка отскакивают в сторону жеста. Если вектор короткий —
    //     directionAngle=0, кубы просто падают на месте.
    //   • presetId — из скорости взмаха.
    //   • initialQuats — ТЕКУЩИЕ ориентации 3D-кубиков из DragOverlay.
    //     Кубы вращались всё время drag'а — их ориентации и есть "случайная
    //     стартовая точка" для броска. Передаются в physics-service, который
    //     ПРОПУСКАЕТ фазу перемешивания (SHAKE) → бросок бесшовный.

    const finalVec = computeDragVector(velocitySamplesRef.current);
    const finalVelocity = computeVelocity(velocitySamplesRef.current);
    // Сохраняем последний сэмпл ДО сброса tracker'а — может понадобиться
    // как fallback для drop position.
    const lastSample = velocitySamplesRef.current.length > 0
      ? velocitySamplesRef.current[velocitySamplesRef.current.length - 1]
      : null;

    // ── Захватываем ориентации И угловые скорости удерживаемых кубов ──
    // ВАРИАНТ A: кубы рендерились в постоянном DiceCanvasHost. Через bus
    // читаем их ТЕКУЩИЕ кватернионы (initialQuats) И угловые скорости
    // (initialAngularVelocity). Оба передаются в physics-service →
    // брошенные кубы продолжают вращение удерживаемых (та же ось+скорость)
    // и стартуют с тех же ориентаций. Буквально ТЕ ЖЕ кубы.
    //
    // ── 2D-режим: вместо кватернионов захватываем грани (initialFaces),
    // позиции (initialPositions2D) и скорости (initialVelocities2D) из
    // HeldDice2DController. Передаются в локальный 2D-движок → бесшовный
    // handoff: те же плитки полетели.
    const mode = useFateStore.getState().diceMode;
    const heldCtrl = getHeldDiceController();
    const initialQuats = heldCtrl?.getQuaternions();
    const initialAngularVelocity = heldCtrl?.getAngularVelocities();
    const held2DCtrl = getHeldDice2DController();
    const initialFaces = mode === '2d' ? held2DCtrl?.getFaces() : undefined;
    const initialPositions2D = mode === '2d' ? held2DCtrl?.getPositions() : undefined;
    const initialVelocities2D = mode === '2d' ? held2DCtrl?.getVelocities() : undefined;

    // ВАЖНО: деактивируем drag В БУСЕ сразу после захвата. HeldDiceController
    // перестанет пушить кадры. Если это drag-throw (не кейс) — physics
    // подхватит общий buffer (не очищая, т.к. initialQuats передан →
    // ServerDiceStage не чистит shared buffer). liveMode выключится в
    // HeldDiceController при переходе active→inactive.
    setDragActive(false);

    // Сбрасываем UI-состояние drag'а.
    setActiveDrag(false);
    setLivePreview(null);
    setLiveVelocity(0);
    setLivePreset('power');
    setOverCase(false);
    velocitySamplesRef.current = createVelocityTracker();

    const { over } = event;

    // ── DROP НА КЕЙС: вернуть кубы обратно (отменить бросок) ──
    // Если игрок отпустил кубы над DiceStation — бросок отменяется, никакой
    // физики не запускается. Просто "положил кубы обратно в кейс".
    // Кубы уже исчезли с карты (drag inactive → HeldDiceController не пушит →
    // buffer не растёт; DieMesh покажет последний кадр ~110мс, потом исчезнет).
    // Очищаем buffer чтобы они пропали сразу.
    if (over && over.id === DROPPABLE_CASE_ID) {
      clearSharedDiceBuffer();
      clearShared2DDiceBuffer();
      return;
    }

    if (!over) return;
    if (over.id !== DROPPABLE_ID) return;

    // ── Capture drop position (clientX/Y) ──
    // dnd-kit DragEndEvent содержит event.active.rect.current.translated —
    // последний known прямоугольник dragged-элемента (с учётом transform).
    // Берём его центр — это и есть точка отпускания курсора.
    //
    // Fallback: если rect недоступен (редко), берём последний сэмпл из
    // velocity tracker — там та же позиция курсора.
    const translatedRect = event.active.rect.current.translated;
    let dropX: number | null = null;
    let dropY: number | null = null;
    if (translatedRect) {
      dropX = translatedRect.left + translatedRect.width / 2;
      dropY = translatedRect.top + translatedRect.height / 2;
    }
    if ((dropX === null || dropY === null) && lastSample) {
      dropX = lastSample.x;
      dropY = lastSample.y;
    }
    if (dropX === null || dropY === null) {
      // Совсем нет данных — fallback на старую логику (vector-based).
      const canvasWidth = getMapScreenRect()?.width ?? 600;
      const gesture: RollGesture = finalVec
        ? computeRollGestureFromVector(finalVec.dx, finalVec.dy, canvasWidth, finalVelocity)
        : { originSide: 'near', originX: 0, presetId: 'power', direction: 'up' };
      emitRollGesture({
        ...gesture,
        swingVelocity: finalVelocity,
        ...(initialQuats && initialQuats.length > 0 ? { initialQuats } : {}),
        ...(initialAngularVelocity && initialAngularVelocity.length > 0 ? { initialAngularVelocity } : {}),
        ...(initialFaces && initialFaces.length > 0 ? { initialFaces } : {}),
        ...(initialPositions2D && initialPositions2D.length > 0 ? { initialPositions2D } : {}),
        ...(initialVelocities2D && initialVelocities2D.length > 0 ? { initialVelocities2D } : {}),
      });
      return;
    }

    // ── Get map screen rect + arena dimensions ──
    const mapRect = getMapScreenRect();
    if (!mapRect) {
      // Map не смонтирована — fallback на vector-based.
      const canvasWidth = 600;
      const gesture: RollGesture = finalVec
        ? computeRollGestureFromVector(finalVec.dx, finalVec.dy, canvasWidth, finalVelocity)
        : { originSide: 'near', originX: 0, presetId: 'power', direction: 'up' };
      emitRollGesture({
        ...gesture,
        swingVelocity: finalVelocity,
        ...(initialQuats && initialQuats.length > 0 ? { initialQuats } : {}),
        ...(initialAngularVelocity && initialAngularVelocity.length > 0 ? { initialAngularVelocity } : {}),
        ...(initialFaces && initialFaces.length > 0 ? { initialFaces } : {}),
        ...(initialPositions2D && initialPositions2D.length > 0 ? { initialPositions2D } : {}),
        ...(initialVelocities2D && initialVelocities2D.length > 0 ? { initialVelocities2D } : {}),
      });
      return;
    }

    // arenaHalfW/H = clamp(imgSize / 350, 3.0, 8.0) — формула из MapPanel.
    const mapVp = getMapViewport();
    const imgW = mapVp?.mapImageSize?.w ?? mapRect.width;
    const imgH = mapVp?.mapImageSize?.h ?? mapRect.height;
    const arenaHalfW = Math.max(3.0, Math.min(8.0, imgW / 350));
    const arenaHalfH = Math.max(3.0, Math.min(8.0, imgH / 350));

    // ── Compute gesture from DROP POSITION (token-placement mode) ──
    // spawnX/spawnZ — абсолютная позиция на арене (центр = (0,0)).
    // directionAngle — из drag vector (для импульса, опционально).
    // presetId — из скорости.
    const dx = finalVec?.dx ?? 0;
    const dy = finalVec?.dy ?? 0;
    const gesture = computeRollGestureFromDrop(
      dropX, dropY, mapRect, arenaHalfW, arenaHalfH,
      dx, dy, finalVelocity,
    );

    if (!gesture) {
      // Drop вне карты — fallback на vector-based (старая логика).
      const fallbackGesture: RollGesture = finalVec
        ? computeRollGestureFromVector(finalVec.dx, finalVec.dy, mapRect.width, finalVelocity)
        : { originSide: 'near', originX: 0, presetId: 'power', direction: 'up' };
      emitRollGesture({
        ...fallbackGesture,
        swingVelocity: finalVelocity,
        ...(initialQuats && initialQuats.length > 0 ? { initialQuats } : {}),
        ...(initialAngularVelocity && initialAngularVelocity.length > 0 ? { initialAngularVelocity } : {}),
        ...(initialFaces && initialFaces.length > 0 ? { initialFaces } : {}),
        ...(initialPositions2D && initialPositions2D.length > 0 ? { initialPositions2D } : {}),
        ...(initialVelocities2D && initialVelocities2D.length > 0 ? { initialVelocities2D } : {}),
      });
      return;
    }

    // Добавляем скорость в gesture (для логирования/UI).
    // И initialQuats + initialAngularVelocity — чтобы physics-service продолжил
    // вращение удерживаемых кубов (пропуск фазы перемешивания).
    emitRollGesture({
      ...gesture,
      swingVelocity: finalVelocity,
      ...(initialQuats && initialQuats.length > 0 ? { initialQuats } : {}),
      ...(initialAngularVelocity && initialAngularVelocity.length > 0 ? { initialAngularVelocity } : {}),
      ...(initialFaces && initialFaces.length > 0 ? { initialFaces } : {}),
      ...(initialPositions2D && initialPositions2D.length > 0 ? { initialPositions2D } : {}),
      ...(initialVelocities2D && initialVelocities2D.length > 0 ? { initialVelocities2D } : {}),
    });
  }, []);

  // ── Power meter UI data ──
  const powerNorm = normalizeVelocity(liveVelocity);
  const presetMeta = getPresetMeta(livePreset);

  // Иконка стрелки направления для DragOverlay.
  const DirIcon = livePreview ? DIRECTION_ICONS[livePreview.direction] : ArrowUp;

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {activeDrag ? (
          <div
            className="pointer-events-none flex items-start gap-2 select-none"
            style={{
              transform: 'rotate(-4deg)',
              filter: 'drop-shadow(0 8px 16px rgba(0,0,0,0.4))',
            }}
          >
            {/* ── Power meter (вертикальный бар слева) ── */}
            <div
              className="flex flex-col items-center gap-1 rounded-lg p-1.5"
              style={{
                background: 'rgba(0,0,0,0.75)',
                border: '1px solid rgba(255,255,255,0.15)',
                minWidth: '38px',
              }}
            >
              <span className="text-[8px] font-bold uppercase tracking-wide text-white/70">
                Сила
              </span>
              {/* Вертикальный бар */}
              <div
                className="relative rounded-full overflow-hidden"
                style={{
                  width: '8px',
                  height: '64px',
                  background: 'rgba(255,255,255,0.12)',
                }}
              >
                <div
                  className="absolute bottom-0 left-0 right-0 rounded-full transition-all duration-100"
                  style={{
                    height: `${Math.max(4, powerNorm * 100)}%`,
                    background: `linear-gradient(to top, #3498db 0%, #27ae60 40%, #e67e22 70%, #9b59b6 100%)`,
                  }}
                />
              </div>
              {/* Label текущего пресета */}
              <span
                className="text-[9px] font-bold leading-tight text-center"
                style={{ color: presetMeta.color }}
              >
                {presetMeta.label}
              </span>
            </div>

            {/* ── Бейдж "Бросок!" + индикаторы (кубы рендерятся на карте) ── */}
            <div className="flex flex-col items-center gap-1.5">
              <div
                className="flex items-center gap-1.5 rounded-xl px-3 py-2"
                style={{
                  background: 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-dark))',
                  boxShadow: '0 6px 20px rgba(230, 126, 34, 0.5), inset 0 1px 0 rgba(255,255,255,0.25)',
                  border: '1px solid rgba(255,255,255,0.2)',
                }}
              >
                <Dices className="size-4 text-white" style={{ animation: 'fate-wiggle 0.6s ease-in-out infinite' }} />
                <span className="text-xs font-bold text-white uppercase tracking-wide">Бросок!</span>
              </div>
              {/* ВАРИАНТ A: 3D-кубики больше не в DragOverlay. Они рендерятся
                  в ПОСТОЯННОМ DiceCanvasHost поверх карты (через HeldDiceController).
                  Здесь — только подсказка "тащите на карту" пока курсор не над ней. */}
              {overCase ? (
                /* ── Индикатор "вернуть в кейс" (когда курсор над кейсом) ── */
                <div
                  className="flex items-center gap-1 text-[9px] font-semibold px-2 py-0.5 rounded-full"
                  style={{
                    background: 'rgba(39, 174, 96, 0.85)',
                    color: 'white',
                  }}
                >
                  <ArrowDown className="size-3" />
                  <span>в кейс</span>
                </div>
              ) : livePreview ? (
                <div
                  className="flex flex-col items-center gap-0.5"
                >
                  {/* Side-индикатор: где появятся кубы (near = снизу, far = сверху) */}
                  <div
                    className="flex items-center gap-1 text-[9px] font-semibold px-2 py-0.5 rounded-full"
                    style={{
                      background: 'rgba(0,0,0,0.7)',
                      color: livePreview.originSide === 'near' ? '#3498db' : '#e74c3c',
                    }}
                  >
                    {livePreview.originSide === 'near' ? (
                      <ArrowDown className="size-3" />
                    ) : (
                      <ArrowUp className="size-3" />
                    )}
                    <span>{livePreview.originSide === 'near' ? 'снизу' : 'сверху'}</span>
                    {livePreview.originX !== 0 && (
                      <span className="opacity-70">
                        {' '}· X={livePreview.originX > 0 ? '+' : ''}{livePreview.originX.toFixed(1)}
                      </span>
                    )}
                  </div>
                  {/* Preset-индикатор: сила броска (из вектора движения) */}
                  <div
                    className="flex items-center gap-1 text-[9px] font-medium px-2 py-0.5 rounded-full"
                    style={{
                      background: 'rgba(0,0,0,0.7)',
                      color: presetMeta.color,
                    }}
                  >
                    <DirIcon className="size-3" />
                    <span>{presetMeta.label}</span>
                  </div>
                </div>
              ) : (
                <div
                  className="text-[9px] font-medium px-2 py-0.5 rounded-full"
                  style={{ background: 'rgba(0,0,0,0.7)', color: 'rgba(255,255,255,0.5)' }}
                >
                  тащите на карту
                </div>
              )}
            </div>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

export { DRAGGABLE_ID, DROPPABLE_ID, DROPPABLE_CASE_ID };
