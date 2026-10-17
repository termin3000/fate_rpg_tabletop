'use client';

// ============================================================
// Dice2DCanvas — 2D-рендерер Fudge-кубиков поверх карты
// ============================================================
//
// Полный аналог Dice3DPhysicsCanvas, но для 2D-режима. Рендерит
// абсолютно-позиционированные div-плитки поверх карты (CSS-трансформы),
// читает shared 2D buffer каждый кадр через requestAnimationFrame.
//
// Режимы работы (как в 3D Plan A):
//   • HELD MODE (heldMode=true): встроенный HeldDice2DController активен.
//     Во время drag (dragActive из held-dice-bus) — пушит процедурные
//     кадры удерживаемых кубов под курсором (4 плитки, кувыркаются).
//     После release — ServerDiceStage2D кормит тот же buffer physics-кадрами.
//     Бесшовный handoff: те же плитки полетели.
//   • PHYSICS ONLY (heldMode=false): только рендерит buffer. Используется
//     в multi-session (VS) — ServerDiceStage2D рендерит свой canvas.
//
// Layout: позиционируется относительно .fate-map-canvas-wrapper (parent).
// Ширина/высота = размеры карты. pointer-events: none → карта остаётся
// интерактивной во время броска.
//
// ВАЖНО: координаты в buffer — px относительно карты (0,0 = верх-лево).
// Рендерер позиционирует плитки через left/top = (x - DIE_SIZE/2, y - DIE_SIZE/2).
//
// ── СТИЛИЗАЦИЯ ──
// 2D-плитки используют ТОТ ЖЕ стиль что и 3D-кубики:
//   • Синий диагональный градиент (BLUE_TOP=#2196f3 → BLUE_MID=#1976d2 → BLUE_BOTTOM=#0d47a1)
//   • Тёмная виньетка по краям (глубина)
//   • Чистые белые символы (#ffffff) с тёмно-синей тенью
//   • Скруглённые рёбра (border-radius 10px)
// Это гарантирует единый визуальный язык между 2D и 3D режимами. В будущем
// редактор кубов будет менять общую палитру — оба режима подхватят её.

import { useEffect, useMemo, useRef } from 'react';
import {
  type Die2DState,
  type FudgeFace,
  type Physics2DBounds,
  type Snapshot2DFrame,
  DIE_SIZE_2D,
  spawnDice2D,
  toTransforms,
  allSettled,
  getFaces,
} from '@/lib/dice-2d-physics';
import {
  getShared2DDiceBuffer,
  getShared2DStartedRef,
  getLive2DMode,
  getPhysics2DActive,
  setLive2DMode,
  getReturn2DState,
  clearReturn2DState,
  registerHeldDice2DController,
  pushSnapshot2D,
  triggerReturnToCase2D,
} from '@/lib/held-dice-2d-bus';
import {
  getDragState,
  subscribeDragState,
  type HeldDragState,
} from '@/lib/held-dice-bus';
import { getMapScreenRect } from '@/lib/map-viewport-registry';
import { DiceFaceSvg, ALL_FUDGE_FACES } from './dice-face-svg';

// ── СТИЛЬ: палитра 2D-плиток ─────────────────────────────────────────
// Раньше была жёстко зашитая сине-белая палитра. Теперь кубики кастомизируются:
// цвет тела и символа берутся из store (diceColor, symbolColor). Градиент
// выводится через derivePalette(hex) — top lighten+8%, mid base, bottom darken-12%.
// Это гарантирует единый визуальный язык между 2D и 3D режимами и позволяет
// менять палитру «в одном месте» — в settings-dialog.
import { useFateStore } from '@/lib/store';
import { derivePalette, suggestSymbolShadow } from '@/lib/dice-palette';

// Карта граней для переключения SVG-слоёв. Каждая плитка содержит 3
// абсолютно-позиционированных <DiceFaceSvg> слоя (по одному на грань).
// renderTiles toggle'ит display: 'block' для нужной грани и 'none' для
// остальных. Это быстрее чем манипулировать innerHTML каждый кадр.
const FACE_LAYER_KEY = (face: FudgeFace): string => `face-${face}`;

// ── Props ────────────────────────────────────────────────────────────────
interface Dice2DCanvasProps {
  /** Количество слотов кубиков (4 для single, 8 для VS). */
  numDice: number;
  /** Buffer с кадрами (shared singleton для single, local для multi). */
  bufferRef: { current: Snapshot2DFrame[] };
  /** Ref-флаг "физика стартанула" (для рендера). */
  startedRef: { current: boolean };
  /** Включить held-mode (контроллер удерживаемых кубов активен). */
  heldMode?: boolean;
  /** Размер карты (для отскоков). */
  mapImageSize?: { w: number; h: number } | null;
  /** Не используются в 2D, но принимаются для совместимости с host-обёрткой. */
  viewport?: { panX: number; panY: number; zoom: number };
  arenaHalfW?: number;
  arenaHalfH?: number;
  /** Per-participant dice colors (mass rolls). 2D path currently uses entry[0]
   *  (the roller's colors) for all tiles — full per-tile coloring is a future
   *  enhancement. If absent, falls back to store (viewer's own colors). */
  participantColors?: Array<{ diceColor: string; symbolColor: string }>;
}

// ── Внешняя функция рендера (react-hooks/immutability: не внутри компонента) ──
// Читает последний кадр из buffer, позиционирует плитки через DOM-стили.
//
// ВАЖНО: ghost-плитки (indices 4-7) рендерятся НАПРЯМУЮ из returnState, БЕЗ
// прохода через buffer. Раньше Dice2DCanvas пушыл ghost-кадры (только 4-7) в
// buffer с t=client-now, а ServerDiceStage2D пушыл live-кадры (только 0-3) с
// t=physics-now (performance.now() из RAF). Эти t могли различаться >16ms
// (особенно при jitter RAF) → в buffer появлялись ОТДЕЛЬНЫЕ кадры (один с 0-3,
// другой с 4-7). renderTiles читал последний кадр: если он содержал только 4-7
// → live-кубы (0-3) ИСЧЕЗАЛИ. Если только 0-3 → ПРИЗРАКИ ИСЧЕЗАЛИ. Это и было
// причиной багов "призрачные кубы" и "исчезновение кубов при частых бросках".
//
// ТЕПЕРЬ: renderTiles читает buffer ТОЛЬКО для live-плиток (0-3). Ghost-плитки
// (4-7) рендерятся напрямую из returnState (arc-интерполяция к casePosition +
// fade). Buffer не содержит ghost-кадров. Никакой race condition.
function renderTiles(
  bufferRef: { current: Snapshot2DFrame[] },
  tileRefs: React.RefObject<Array<HTMLDivElement | null>>,
  numDice: number,
  now: number,
) {
  const buf = bufferRef.current;

  // ── RENDER LIVE TILES (0-3) from buffer ──
  const used = new Set<number>();
  if (buf.length === 0) {
    // Скрываем все live-плитки (ghost-плитки обработаны ниже).
    for (let i = 0; i < 4; i++) {
      const el = tileRefs.current[i];
      if (el) el.style.opacity = '0';
    }
  } else {
    // В live mode рендерим последний кадр сразу (нулевая задержка).
    // Иначе — с задержкой 80мс (сглаживание).
    const live = getLive2DMode() || getPhysics2DActive();
    const renderTime = live ? now : now - 80;

    // Находим кадр для renderTime (ближайший слева).
    let frame = buf[buf.length - 1];
    for (let i = buf.length - 1; i >= 0; i--) {
      if (buf[i].t <= renderTime) {
        frame = buf[i];
        break;
      }
    }

    // Применяем трансформы к LIVE-плиткам (0-3).
    for (const tr of frame.dice) {
      if (tr.i >= 4) continue;  // ghost-плитки (4-7) обработаны ниже
      if (tr.i >= numDice) continue;
      const el = tileRefs.current[tr.i];
      if (!el) continue;
      used.add(tr.i);
      el.style.left = `${tr.x - DIE_SIZE_2D / 2}px`;
      el.style.top = `${tr.y - DIE_SIZE_2D / 2}px`;
      el.style.transform = `rotate(${tr.rotation}rad)`;
      el.style.opacity = `${tr.alpha}`;

      // ── Переключение SVG-слоёв грани ──
      const layers = el.querySelectorAll('[data-face-layer]');
      layers.forEach((layer) => {
        const layerFace = layer.getAttribute('data-face-layer');
        if (layerFace === String(tr.face)) {
          (layer as HTMLElement).style.display = 'block';
        } else {
          (layer as HTMLElement).style.display = 'none';
        }
      });

      // ── Подсветка состояния ──
      el.style.boxShadow = tr.tumbling
        ? '0 4px 14px rgba(0,0,0,0.35), 0 0 0 2px rgba(230, 126, 34, 0.55), 0 0 18px rgba(230, 126, 34, 0.3)'
        : tr.settled
          ? '0 5px 12px rgba(0,0,0,0.45), 0 0 0 1px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.18)'
          : '0 5px 14px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.15)';
    }
    // Скрываем неиспользуемые live-плитки.
    for (let i = 0; i < 4; i++) {
      if (!used.has(i)) {
        const el = tileRefs.current[i];
        if (el) el.style.opacity = '0';
      }
    }
  }

  // ── RENDER GHOST TILES (4-7) DIRECTLY from returnState ──
  // Ghost-плитки НЕ читают buffer. Они рендерятся из returnState (arc-интерполяция
  // к casePosition + fade). Это устраняет race condition между live-кадрами (0-3)
  // и ghost-кадрами (4-7) в buffer.
  const rs = getReturn2DState();
  if (rs && numDice >= 8) {
    const elapsed = Date.now() - rs.startTime;
    const progress = Math.min(1, elapsed / rs.duration);
    if (progress < 1) {
      // Ease-out (как было).
      const eased = 1 - Math.pow(1 - progress, 3);
      for (let k = 0; k < 4; k++) {
        const el = tileRefs.current[4 + k];
        if (!el) continue;
        used.add(4 + k);
        const start = rs.positions[k];
        const face = rs.faces[k];
        // Arc-траектория: вверх-в-сторону + fade.
        const arcH = -60 * Math.sin(Math.PI * eased);  // пик в середине
        const x = start.x + (rs.caseX - start.x) * eased;
        const y = start.y + (rs.caseY - start.y) * eased + arcH;
        const alpha = 1 - eased;
        el.style.left = `${x - DIE_SIZE_2D / 2}px`;
        el.style.top = `${y - DIE_SIZE_2D / 2}px`;
        el.style.transform = `rotate(${eased * Math.PI * 2}rad)`;
        el.style.opacity = `${alpha}`;

        // Переключение SVG-слоёв грани.
        const layers = el.querySelectorAll('[data-face-layer]');
        layers.forEach((layer) => {
          const layerFace = layer.getAttribute('data-face-layer');
          if (layerFace === String(face)) {
            (layer as HTMLElement).style.display = 'block';
          } else {
            (layer as HTMLElement).style.display = 'none';
          }
        });

        // Ghost-плитки — мягкая тень (без подсветки состояния).
        el.style.boxShadow = '0 4px 12px rgba(0,0,0,0.35), 0 0 0 1px rgba(0,0,0,0.15)';
      }
    }
  }
  // Скрываем неиспользуемые ghost-плитки.
  for (let i = 4; i < numDice; i++) {
    if (!used.has(i)) {
      const el = tileRefs.current[i];
      if (el) el.style.opacity = '0';
    }
  }
}

export function Dice2DCanvas({
  numDice,
  bufferRef,
  startedRef,
  heldMode = false,
  mapImageSize,
  participantColors,
}: Dice2DCanvasProps) {
  // DOM-рефы плиток (по индексу).
  const tileRefs = useRef<Array<HTMLDivElement | null>>([]);

  // ── Кастомизация: цвет тела куба и символа ──
  // Priority: participantColors[0] (the roller's colors, for mass rolls) → store.
  // 2D path uses a single color set for all tiles (per-tile coloring is future work).
  const storeDiceColor = useFateStore((s) => s.diceColor);
  const storeSymbolColor = useFateStore((s) => s.symbolColor);
  const diceColor = participantColors?.[0]?.diceColor ?? storeDiceColor;
  const symbolColor = participantColors?.[0]?.symbolColor ?? storeSymbolColor;
  // Градиент тела куба (top/mid/bottom) — вычисляется из diceColor.
  const diceFaceBg = useMemo(() => {
    const p = derivePalette(diceColor);
    return `linear-gradient(135deg, ${p.top} 0%, ${p.mid} 50%, ${p.bottom} 100%)`;
  }, [diceColor]);
  // Цвет тени символа — подбирается под яркость куба (на тёмных кубах
  // тень должна быть более контрастной).
  const symbolShadow = useMemo(
    () => suggestSymbolShadow(diceColor),
    [diceColor],
  );

  // ── HELD-DICE CONTROLLER STATE ──
  // 4 кубика под курсором во время drag. Хранится в ref (не React state —
  // обновается каждый кадр в RAF, ре-рендер не нужен).
  const heldDiceRef = useRef<Die2DState[]>([]);
  // Текущее drag-состояние (читаем из 3D bus — он уже хранит cursorX/Y/active).
  const dragStateRef = useRef<HeldDragState>(getDragState());
  // Трекер скорости курсора (для initialVelocities при dragEnd).
  const cursorSamplesRef = useRef<Array<{ x: number; y: number; t: number }>>([]);
  // Текущие held-грани (для getFaces API).
  const heldFacesRef = useRef<FudgeFace[]>([0, 0, 0, 0]);

  // ── ВАЖНО: обновляем shared globalThis refs НА КАЖДОМ РЕНДЕРЕ ──────────
  // Dice2DCanvas часто перемонтируется (через условный рендер в MapPanel при
  // ре-рендерах, переключении diceMode, и т.д.). При перемонтировании useRef
  // создаёт НОВЫЙ массив tileRefs.current. Если оставить обновление только в
  // useEffect([]), RAF будет читать СТАРЫЙ массив (полный null после unmount)
  // и плитки останутся opacity:0. Отдельный useEffect без deps-массива
  // выполняется на каждом рендере (и после перемонтирования), гарантируя,
  // что globalThis всегда указывает на актуальный массив. Массив заполняется
  // DOM-элементами в commit-фазе (через ref-коллбэки), а RAF читает его на
  // следующем кадре.
  useEffect(() => {
    const g = globalThis as unknown as {
      __dice2DRafRunning?: boolean;
      __dice2DTileRefs?: Array<HTMLDivElement | null>;
      __dice2DNumDice?: number;
      __dice2DHeldMode?: boolean;
    };
    g.__dice2DTileRefs = tileRefs.current;
    g.__dice2DNumDice = numDice;
    g.__dice2DHeldMode = heldMode;
  });

  // ── RAF-цикл: рендер + (для heldMode) контроллер ─────────────────────
  // ВАЖНО: Dice2DCanvas может перемонтироваться при ре-рендерах MapPanel.
  // Используем globalThis для хранения RAF и tileRefs — при unmount НЕ отменяем,
  // RAF продолжает работать. При новом mount — обновляем tileRefs в globalThis
  // (см. useEffect выше — выполняется на каждом рендере).
  useEffect(() => {
    const g = globalThis as unknown as {
      __dice2DRafRunning?: boolean;
      __dice2DTileRefs?: Array<HTMLDivElement | null>;
      __dice2DNumDice?: number;
      __dice2DHeldMode?: boolean;
    };
    if (g.__dice2DRafRunning) {
      // RAF уже запущен — не запускаем дубликат. tick читает tileRefs из globalThis.
      return;
    }
    g.__dice2DRafRunning = true;
    let rafId = 0;
    let lastT = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastT) / 1000);  // clamp 50мс
      lastT = now;
      // Читаем актуальные tileRefs из globalThis (переживают перемонтирование).
      const liveTileRefs = g.__dice2DTileRefs ?? [];
      const liveNumDice = g.__dice2DNumDice ?? numDice;
      const liveHeldMode = g.__dice2DHeldMode ?? heldMode;

      const bounds: Physics2DBounds = {
        // ВАЖНО: bounds — VIEWPORT-размеры (видимая область карты), не naturalImageSize.
        // Кубы рендерятся через `left/top = tr.x/tr.y - DIE_SIZE/2` относительно
        // canvas-обёртки (которая = viewport). Если использовать naturalImageSize
        // (1400×800), кубы улетят за пределы видимой области (canvas 700×426).
        w: getMapScreenRect()?.width ?? mapImageSize?.w ?? 800,
        h: getMapScreenRect()?.height ?? mapImageSize?.h ?? 600,
      };

      // ── HELD MODE: контроллер удерживаемых кубов ──
      if (liveHeldMode) {
        const ds = dragStateRef.current;
        // ── FIX BUG 2: если 2D-физика ещё активна (предыдущий бросок катится),
        // НЕ пушим held-кадры. Иначе held-кубы (indices 0-3) перезапишут
        // physics-кадры (тоже 0-3) в buffer → старые кубы "исчезнут" mid-tumble.
        // Пусть старый бросок докатится; held-кубы появятся когда игрок снова
        // потащит ПОСЛЕ settle. (handleDragStart тоже не чистит буфер при
        // активной физике.)
        if (ds.active && ds.cursorX >= 0 && ds.cursorY >= 0 && !getPhysics2DActive()) {
          // Конвертация clientX/Y → map-local px.
          const mapRect = getMapScreenRect();
          if (mapRect) {
            const localX = ds.cursorX - mapRect.left;
            const localY = ds.cursorY - mapRect.top;

            // Трекаем скорость курсора.
            const sample = { x: localX, y: localY, t: now };
            cursorSamplesRef.current.push(sample);
            // Храним только последние ~300мс.
            const cutoff = now - 300;
            while (cursorSamplesRef.current.length > 2 &&
                   cursorSamplesRef.current[0].t < cutoff) {
              cursorSamplesRef.current.shift();
            }

            // Спавним held-кубики если их ещё нет.
            if (heldDiceRef.current.length === 0) {
              heldDiceRef.current = spawnDice2D({
                spawnX: localX,
                spawnY: localY,
                direction: 0,
                speed: 0,
                presetId: 'normal',
                count: 4,
              });
              // Кубы под курсором НЕ летят — обнулим скорости.
              for (const d of heldDiceRef.current) {
                d.vx = 0;
                d.vy = 0;
                d.spin = 0;
                d.tumbling = true;  // кувыркаются всё время drag
              }
              setLive2DMode(true);
            }

            // Обновляем позиции held-кубов: следуют за курсором (с лёгким смещением
            // вокруг центра — «стакан в руке»).
            const offsets = [
              { dx: -18, dy: -18 },
              { dx: 18, dy: -18 },
              { dx: -18, dy: 18 },
              { dx: 18, dy: 18 },
            ];
            for (let k = 0; k < heldDiceRef.current.length; k++) {
              const d = heldDiceRef.current[k];
              d.x = localX + offsets[k].dx;
              d.y = localY + offsets[k].dy;
              // Кувыркание: меняем face каждые ~80мс (всё время drag).
              d.tumbleAccum += dt;
              if (d.tumbleAccum >= 0.08) {
                d.tumbleAccum = 0;
                const faces: FudgeFace[] = [1, 0, -1];
                d.face = faces[Math.floor(Math.random() * 3)];
              }
              // Лёгкое вращение (визуальный «трясёт в руке»).
              d.rotation += dt * 1.5 * (k % 2 === 0 ? 1 : -1);
              heldFacesRef.current[k] = d.face;
            }

            // Пушим кадр в shared 2D buffer (live singleton).
            pushSnapshot2D(getShared2DDiceBuffer(), {
              t: now,
              dice: toTransforms(heldDiceRef.current),
            });
            startedRef.current = true;
            (getShared2DStartedRef() as { current: boolean }).current = true;
          }
        } else if (!ds.active && heldDiceRef.current.length > 0) {
          // Drag закончился. НЕ очищаем held-кубы сразу — ServerDiceStage2D
          // подхватит их через getHeldDice2DController().getFaces()/getPositions().
          // Но если это был drop на кейс — cubes должны исчезнуть.
          // RollGestureProvider уже вызвал clearShared2DDiceBuffer() при drop-на-кейс.
          // Здесь просто сбрасываем held-state (контроллер перестаёт пушить).
          heldDiceRef.current = [];
          cursorSamplesRef.current = [];
          setLive2DMode(false);
        }
      }

      // ── RETURN-TO-CASE: cleanup only (ghost-плитки рендерятся в renderTiles) ──
      // ВАЖНО: ghost-плитки (indices 4-7) больше НЕ пушим в buffer. Раньше
      // Dice2DCanvas пушыл ghost-кадры (только 4-7) с t=client-now, а
      // ServerDiceStage2D пушыл live-кадры (только 0-3) с t=physics-now.
      // Эти t могли различаться >16ms (RAF jitter) → в buffer появлялись
      // ОТДЕЛЬНЫЕ кадры (один с 0-3, другой с 4-7). renderTiles читал последний
      // кадр: если он содержал только 4-7 → live-кубы ИСЧЕЗАЛИ. Если только 0-3
      // → ПРИЗРАКИ ИСЧЕЗАЛИ. Это и было причиной багов "призрачные кубы" и
      // "исчезновение кубов при частых бросках".
      //
      // ТЕПЕРЬ: renderTiles читает buffer ТОЛЬКО для live-плиток (0-3). Ghost-
      // плитки (4-7) рендерятся напрямую из returnState (см. renderTiles).
      // Здесь только проверяем: если анимация завершена (progress >= 1) —
      // очищаем returnState. renderTiles на следующем тике увидит rs=null и
      // скроет ghost-плитки.
      const returnState = getReturn2DState();
      if (returnState) {
        const elapsed = Date.now() - returnState.startTime;
        const progress = Math.min(1, elapsed / returnState.duration);
        if (progress >= 1) {
          // Анимация завершена — очищаем state. Ghost-плитки больше не рендерятся.
          clearReturn2DState();
        }
      }

      // ── РЕНДЕР: читаем последний кадр из buffer ──
      const liveBuffer = getShared2DDiceBuffer();
      renderTiles(liveBuffer, { current: liveTileRefs } as React.RefObject<Array<HTMLDivElement | null>>, liveNumDice, now);

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    // НЕ отменяем RAF при cleanup — пусть продолжает работать.
    // При перемонтировании tileRefs обновляются через globalThis.
  }, []);

  // ── Подписка на drag state (для held-mode) ──────────────────────────
  useEffect(() => {
    if (!heldMode) return;
    const unsub = subscribeDragState((state) => {
      dragStateRef.current = state;
    });
    return unsub;
  }, [heldMode]);

  // ── Регистрация контроллера (для RollGestureProvider) ───────────────
  useEffect(() => {
    if (!heldMode) return;
    registerHeldDice2DController({
      getFaces: () => [...heldFacesRef.current],
      getPositions: () => heldDiceRef.current.map((d) => ({ x: d.x, y: d.y })),
      getVelocities: () => {
        // Вычисляем скорость из последних сэмплов курсора.
        // Используем только последние ~120мс (не весь 300мс buffer) —
        // это даёт INSTANTANEOUS release velocity, а не среднюю за весь drag.
        // Если игрок замедлился перед отпусканием, last-120ms velocity будет
        // низкой — но spawnDice2D всё равно даст минимальный импульс от base
        // velocity (preset × direction). Если игрок сделал быстрый flick в
        // конце — last-120ms velocity будет высокой → кубы полетят быстрее.
        const samples = cursorSamplesRef.current;
        if (samples.length < 2) {
          return [0, 1, 2, 3].map(() => ({ vx: 0, vy: 0 }));
        }
        const last = samples[samples.length - 1];
        // Берём сэмплы из последних 120мс (fallback на первый сэмпл если
        // весь drag был короче 120мс).
        const windowStart = last.t - 120;
        let first = samples[0];
        for (let i = samples.length - 1; i >= 0; i--) {
          if (samples[i].t <= windowStart) {
            first = samples[i];
            break;
          }
        }
        const dt = (last.t - first.t) / 1000;
        if (dt <= 0) return [0, 1, 2, 3].map(() => ({ vx: 0, vy: 0 }));
        const vx = (last.x - first.x) / dt;
        const vy = (last.y - first.y) / dt;
        // Все 4 куба получают одну скорость (стакан летит целиком).
        // spawnDice2D добавит radial kick для разброса.
        return [0, 1, 2, 3].map(() => ({ vx, vy }));
      },
    });
    return () => {
      // Снимаем контроллер при unmount canvas'а (diceMode переключился).
      registerHeldDice2DController(null);
    };
  }, [heldMode]);

  return (
    <div
      className="fate-dice-2d-canvas"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 30,
      }}
    >
      {Array.from({ length: numDice }, (_, i) => (
        <div
          key={i}
          ref={(el) => { tileRefs.current[i] = el; }}
          className="fate-dice-2d-tile"
          data-die-index={i}
          style={{
            position: 'absolute',
            width: `${DIE_SIZE_2D}px`,
            height: `${DIE_SIZE_2D}px`,
            borderRadius: '10px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            // Фон — градиент из текущего diceColor. Не зависит от грани —
            // все кубы одного цвета, символ различает.
            background: diceFaceBg,
            // opacity/left/top/transform/boxShadow НЕ задаём здесь —
            // ими управляет renderTiles через DOM. React ре-рендер перезаписал бы
            // inline style, сбрасывая значения которые renderTiles установил.
            overflow: 'hidden',
            willChange: 'transform, left, top, opacity',
            // Скруглённая внутренняя рамка для "объёма" (как у 3D rounded box).
            border: '1px solid rgba(0, 10, 40, 0.35)',
            // Внутренний блик сверху (имитация освещения 3D-сцены).
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18)',
          }}
        >
          {/* Виньетка по краям (как у 3D текстур). Абсолютно позиционирована,
              не мешает центрированию SVG-символа. */}
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: '10px',
              pointerEvents: 'none',
              background:
                'radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,0.28) 100%)',
            }}
          />
          {/* 3 SVG-слоя символов — переключаются через display в renderTiles.
              Каждый слой абсолютно позиционирован и заполняет плитку (100%).
              SVG внутри DiceFaceSvg идеально центрирован в своём viewBox. */}
          {ALL_FUDGE_FACES.map((face) => (
            <div
              key={FACE_LAYER_KEY(face)}
              data-face-layer={String(face)}
              style={{
                position: 'absolute',
                inset: 0,
                display: 'none',  // renderTiles покажет нужный слой
                alignItems: 'center',
                justifyContent: 'center',
                padding: '14%',  // SVG занимает ~72% плитки (с запасом под виньетку)
                boxSizing: 'border-box',
                pointerEvents: 'none',
              }}
            >
              <DiceFaceSvg
                face={face}
                size="100%"
                symbolColor={symbolColor}
                shadowColor={symbolShadow}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Хелпер для ServerDiceStage2D: запуск локальной 2D-физики ─────────────
// Возвращает функцию step(), которую caller вызывает в RAF, и cancel().
export interface Dice2DPhysicsHandle {
  /** Текущее состояние кубиков (для inspection). */
  getDice: () => Die2DState[];
  /** Отмена физики (остановка RAF). */
  cancel: () => void;
}

// Пуш кадра в buffer (реэкспорт для удобства).
export { pushSnapshot2D, triggerReturnToCase2D, allSettled, getFaces };
