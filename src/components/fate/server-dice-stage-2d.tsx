'use client';

// ============================================================
// ServerDiceStage2D — обёртка для запуска ЛОКАЛЬНОЙ 2D-физики броска
// ============================================================
//
// Полный аналог ServerDiceStage (для 3D), но для 2D-режима. Используется
// в RollStageOverlay когда event.pending2DPhysics != null.
//
// Поведение:
//   1. Mount: читает pending2DPhysics (spawn/direction/speed/preset/initialFaces).
//   2. Спавнит 4 кубика через spawnDice2D.
//   3. Запускает RAF-цикл: stepDie2D для каждого кубика, pushSnapshot2D в
//      shared 2D buffer. Die2DCanvas (в DiceCanvasHost2D) рендерит их.
//   4. При allSettled → applyPhysicsResult(event.id, participantId, getFaces).
//   5. Unmount / event change: cancel RAF.
//
// SINGLE-SESSION only (пока). Multi-session (VS/mass) для 2D будет добавлен
// позже — пока VS/mass в 2D-режиме падает на мгновенный performRoll (как было).
//
// ВАЖНО: этот компонент НЕ рендерит свой canvas (как 3D single-session).
// Single-session 2D-броски рендерятся в ПОСТОЯННОМ канвасе (DiceCanvasHost2D
// в MapPanel). Здесь только запускается физика и кормится shared buffer.
// Возвращает null.

import { useEffect, useRef } from 'react';
import { useFateStore } from '@/lib/store';
import type { LiveRollEvent } from '@/lib/types';
import {
  type Die2DState,
  type Physics2DBounds,
  type RngFn,
  spawnDice2D,
  stepDie2D,
  resolveDiceCollisions,
  toTransforms,
  allSettled,
  getFaces,
  physToPx,
  DIE_SIZE_2D,
  createRng,
} from '@/lib/dice-2d-physics';
import {
  getShared2DDiceBuffer,
  getShared2DStartedRef,
  setPhysics2DActive,
  setLive2DMode,
  clearShared2DDiceBuffer,
  pushSnapshot2D,
  triggerReturnToCase2D,
} from '@/lib/held-dice-2d-bus';
import { getMapScreenRect, getMapViewport } from '@/lib/map-viewport-registry';

// Module-level guard: tracks which sessionId values have already been thrown.
// ВАЖНО: sessionId удаляется из Set в cleanup useEffect'а. Это совместимо с
// React Strict Mode (двойной вызов эффектов в dev): первая инвокация добавляет
// sessionId и спавнит кубы, cleanup удаляет sessionId и отменяет RAF, вторая
// инвокация снова добавляет sessionId и спавнит кубы. Без удаления Strict Mode
// блокировал бы вторую инвокацию → кубы бы не спавнились → "кубы исчезают".
const thrown2DSessionIds = new Set<string>();

interface ServerDiceStage2DProps {
  event: LiveRollEvent;
  viewport: { panX: number; panY: number; zoom: number };
  arenaHalfW?: number;
  arenaHalfH?: number;
  mapImageSize?: { w: number; h: number } | null;
}

export function ServerDiceStage2D({ event, arenaHalfW, arenaHalfH, mapImageSize }: ServerDiceStage2DProps) {
  const applyResult = useFateStore((s) => s.applyPhysicsResult);
  const rafRef = useRef<number>(0);
  const diceRef = useRef<Die2DState[]>([]);
  const resultAppliedRef = useRef(false);
  // Флаг "post-settle separation выполнена" — чтобы не запускать разделение
  // каждый кадр после settle (однократно, при первом allSettled).
  const postSettleSeparatedRef = useRef(false);

  // ── Запуск 2D-физики — ОДИН раз на event (keyed by event.id) ─────────
  useEffect(() => {
    const pending = event.pending2DPhysics;
    if (!pending) {
      return;
    }

    if (thrown2DSessionIds.has(pending.sessionId)) {
      return;
    }
    thrown2DSessionIds.add(pending.sessionId);

    resultAppliedRef.current = false;
    postSettleSeparatedRef.current = false;

    // ── Подготовка параметров спавна ──
    // ВАЖНО: bounds для 2D-физики — это VIEWPORT-размеры (видимая область карты
    // на экране), а НЕ naturalWidth/Height изображения. Dice2DCanvas позиционирует
    // плитки через `left/top = tr.x/tr.y - DIE_SIZE/2` в пикселях относительно
    // canvas-обёртки, которая занимает viewport. Если использовать mapImageSize
    // (naturalWidth/Height, например 1400×800 для большой карты), кубы улетят
    // за пределы видимой области (canvas всего 700×426). Поэтому приоритет —
    // mapRect (экранный rect изображения), затем mapVp.mapImageSize, и только
    // потом prop mapImageSize как последний fallback.
    const mapRect = getMapScreenRect();
    const mapVp = getMapViewport();
    const mapW = mapRect?.width ?? mapVp?.mapImageSize?.w ?? mapImageSize?.w ?? 800;
    const mapH = mapRect?.height ?? mapVp?.mapImageSize?.h ?? mapImageSize?.h ?? 600;
    const aHalfW = arenaHalfW ?? Math.max(3.0, Math.min(8.0, mapW / 350));
    const aHalfH = arenaHalfH ?? Math.max(3.0, Math.min(8.0, mapH / 350));

    // Конвертация: spawnX/spawnY уже в px (drag-бросок передаёт их напрямую).
    // Если undefined (button-throw через emitRandomThrowGesture) — конвертируем
    // из spawnX/spawnZ (физ.ед.) через physToPx, либо центр карты.
    let spawnX: number;
    let spawnY: number;
    if (pending.spawnX !== undefined && pending.spawnY !== undefined) {
      // 2D-формат: уже в px.
      spawnX = pending.spawnX;
      spawnY = pending.spawnY;
    } else if (pending.dropX !== undefined && pending.dropY !== undefined && mapRect) {
      // Drag-бросок: screen-coords → map-local px.
      spawnX = pending.dropX - mapRect.left;
      spawnY = pending.dropY - mapRect.top;
    } else {
      // Fallback: центр карты.
      spawnX = mapW / 2;
      spawnY = mapH / 2;
    }

    // Direction: priority pending.direction (screen-coords, из directionAngle).
    // Если undefined — случайный угол (button-throw без directionAngle).
    // ВАЖНО для remote-реплея: если direction не задан в event, используем seed
    // для генерации того же случайного угла на всех клиентах.
    const isRemote = pending.isRemote === true;
    const rng: RngFn = pending.seed !== undefined ? createRng(pending.seed) : Math.random;
    const direction = pending.direction ?? rng() * Math.PI * 2;

    // Speed: priority pending.speed (уже в px/с). Если undefined —
    // конвертируем из swingVelocity (px/ms × 1000 = px/с). Default 400.
    const speed = pending.speed ?? 400;

    // ── Drag-continuation? (initialFaces переданы → бросок продолжает held-dice) ──
    // Если да — НЕ очищаем shared buffer: удерживаемые кубы уже там,
    // физика продолжит кормить тот же buffer → бесшовный handoff.
    // Если нет (button-throw) — очищаем (свежий бросок).
    //
    // ── RETURN-TO-CASE: ТОЛЬКО для button-throw ──
    // Для drag-continuation НЕ вызываем triggerReturnToCase2D — буфер содержит
    // held-dice кадры (позиции кубов под курсором). Если их захватить как
    // "старые" и анимировать в кейс → 8 кубов на карте (4 брошенных + 4 призрака).
    // Это баг "призрачные кубы". Зеркалируем 3D поведение (server-dice-stage.tsx
    // строки 188-194: "для drag-continuation старых кубов на столе нет").
    //
    // Для button-throw вызываем triggerReturnToCase2D ПЕРЕД очисткой буфера.
    // Если на столе лежат старые кубы от предыдущего броска — они анимируются
    // в кейс (ghost-плитки 4-7). Безвреден если буфер пуст.
    //
    // ── STALE FRAME PROTECTION ──
    // triggerReturnToCase2D имеет встроенную защиту от stale-кадров (порог 500мс).
    // При частых бросках (rapid-throw: событие2 стартует во время exit-окна
    // события1) буфер может содержать кадры события1 возрастом ~470мс. Без
    // защиты эти кадры попали бы в ghost-анимацию → "призрачные кубы в центре".
    // С порогом 500мс кадры старше 500мс не анимируются.
    const isDragContinuation = !!(pending.initialFaces && pending.initialFaces.length > 0);
    if (!isDragContinuation) {
      triggerReturnToCase2D(60, mapH - 60);
      clearShared2DDiceBuffer();
      setLive2DMode(false);
    }
    setPhysics2DActive(false);

    // ── Спавн кубиков ──
    diceRef.current = spawnDice2D({
      spawnX,
      spawnY,
      direction,
      speed,
      presetId: pending.presetId,
      count: 4,
      initialFaces: pending.initialFaces,
      initialPositions: pending.initialPositions,
      initialVelocities: pending.initialVelocities,
      rng,
    });

    // ── SPAWN FRAME: immediately push initial dice state to buffer ──
    // ПРОБЛЕМА: после clearShared2DDiceBuffer() buffer пуст. Первый RAF tick
    // запушит кадр через ~16ms. В этот gap Die2DCanvas видит пустой buffer →
    // live плитки (0-3) невидимы (opacity:0). Если одновременно активна
    // ghost-анимация (return-to-case от предыдущего броска), то видны ТОЛЬКО
    // ghost-плитки (4-7) → пользователь видит "призрачные кубы".
    //
    // ФИКС: сразу после spawnDice2D пушим начальный кадр в buffer. Die2DCanvas
    // видит кадр → плитки видны с первого кадра. RAF tick добавит следующие
    // кадры (с обновлёнными позициями после stepDie2D).
    {
      const buffer = getShared2DDiceBuffer();
      pushSnapshot2D(buffer, {
        t: performance.now(),
        dice: toTransforms(diceRef.current),
      });
      getShared2DStartedRef().current = true;
    }

    // Сигнализируем что физика стартанула (для Die2DCanvas — переключение
    // в режим без live-задержки, плавная интерполяция).
    setPhysics2DActive(true);

    const bounds: Physics2DBounds = { w: mapW, h: mapH };

    // ── Stopped flag ──
    // Ставим true в cleanup. tick проверяет флаг и немедленно возвращается,
    // не пуша кадры в buffer. Это гарантирует, что после cleanup (RAF cancel)
    // НИ ОДИН кадр не будет запушен — даже если cancelAnimationFrame не успел
    // отработать до следующего тика (race condition в React Strict Mode).
    let stopped = false;

    // ── RAF-цикл: шаг физики + push в shared buffer ──
    let lastT = performance.now();
    const tick = (now: number) => {
      if (stopped) return;  // cleanup уже отработал — не пушим кадры
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;

      // Шаг физики для каждого кубика.
      for (let k = 0; k < diceRef.current.length; k++) {
        diceRef.current[k] = stepDie2D(diceRef.current[k], dt, bounds, rng);
      }

      // ── Коллизии между кубиками ──
      // Разрешаем перекрытия и применяем упругие столкновения, чтобы
      // кубики не сваливались в одну кучу (особенно при броске из одной
      // точки). 4 итерации внутри resolveDiceCollisions достаточно для
      // 4-8 кубиков.
      resolveDiceCollisions(diceRef.current, rng);

      // ── POST-SETTLE SEPARATION ──
      // Когда все кубики засеттлились, запускаем финальную серию
      // "разделений" — гарантированно раздвигаем перекрытые кубики.
      // Это предотвращает ситуацию, когда кубики засеттлились пока
      // перекрывались (например, после удара о стену и схождения к центру).
      // settled кубы не двигаются от collision velocity (они "приклеены"),
      // но здесь мы ПОЗИЦИОННО раздвигаем их (меняем x,y напрямую).
      if (allSettled(diceRef.current) && !postSettleSeparatedRef.current) {
        postSettleSeparatedRef.current = true;
        // Несколько проходов для гарантии (chain overlaps разрешаются).
        for (let pass = 0; pass < 8; pass++) {
          let anyOverlap = false;
          for (let i = 0; i < diceRef.current.length; i++) {
            for (let j = i + 1; j < diceRef.current.length; j++) {
              const a = diceRef.current[i];
              const b = diceRef.current[j];
              const dx = b.x - a.x;
              const dy = b.y - a.y;
              const dist = Math.hypot(dx, dy);
              const minDist = DIE_SIZE_2D;
              if (dist < minDist && dist > 0.001) {
                anyOverlap = true;
                const nx = dx / dist;
                const ny = dy / dist;
                const overlap = minDist - dist;
                const half = overlap / 2;
                // Двигаем оба куба (оба settled — это ОК, мы меняем позиции напрямую).
                diceRef.current[i] = { ...a, x: a.x - nx * half, y: a.y - ny * half };
                diceRef.current[j] = { ...b, x: b.x + nx * half, y: b.y + ny * half };
              } else if (dist <= 0.001) {
                // Кубы точно в одной точке — раздвигаем по случайной оси.
                anyOverlap = true;
                const angle = rng() * Math.PI * 2;
                const nx = Math.cos(angle);
                const ny = Math.sin(angle);
                const half = DIE_SIZE_2D / 2;
                diceRef.current[i] = { ...a, x: a.x - nx * half, y: a.y - ny * half };
                diceRef.current[j] = { ...b, x: b.x + nx * half, y: b.y + ny * half };
              }
            }
          }
          // Ограничиваем кубы внутри bounds (после разделения могли выйти).
          for (let k = 0; k < diceRef.current.length; k++) {
            const d = diceRef.current[k];
            const margin = DIE_SIZE_2D / 2 + 2;
            diceRef.current[k] = {
              ...d,
              x: Math.max(margin, Math.min(bounds.w - margin, d.x)),
              y: Math.max(margin, Math.min(bounds.h - margin, d.y)),
            };
          }
          if (!anyOverlap) break;
        }
      }

      // Пуш кадра в shared 2D buffer.
      const buffer = getShared2DDiceBuffer();
      pushSnapshot2D(buffer, {
        t: now,
        dice: toTransforms(diceRef.current),
      });
      getShared2DStartedRef().current = true;

      // ── Settle detection: все кубики зафиксированы? ──
      // REMOTE-клиент НЕ вызывает applyResult — результат броска уже определён
      // originator'ом (GM/игроком который бросал) и придёт через log-entry
      // broadcast. Remote-клиент только РЕНДЕРИТ анимацию (через seeded PRNG),
      // его локальный результат не нужен. Вызов applyResult на remote был бы
      // no-op (нет resolver для этого eventId), но мы пропускаем его для clarity.
      if (!isRemote && !resultAppliedRef.current && allSettled(diceRef.current)) {
        resultAppliedRef.current = true;
        const faces = getFaces(diceRef.current);
        // Конвертация FudgeFace[] → number[] (1/0/-1).
        const diceNum = faces.map((f) => f as number);
        applyResult(event.id, pending.participantId, diceNum);
        // Физика завершена — снимаем флаг (кубы остаются на столе,
        // рендерятся через buffer).
        setPhysics2DActive(false);
        // НЕ отменяем RAF — кубы остаются на столе (buffer растёт).
        // Но новые шаги не меняют состояние (settled=true → step возвращает d).
        // Это ОК, но buffer растёт бесконечно. Ограничим: после settle
        // пушим только если кадр изменился. Пока оставим — pushSnapshot2D
        // ограничивает длину 240.
      } else if (isRemote && !resultAppliedRef.current && allSettled(diceRef.current)) {
        // Remote: кубы засеттлились, но НЕ вызываем applyResult (результат
        // придёт через log-entry от originator). Снимаем флаг активности.
        resultAppliedRef.current = true;
        setPhysics2DActive(false);
      }

      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);

    return () => {
      stopped = true;  // останавливаем tick до следующего вызова
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      // Удаляем sessionId из guard'а — совместимо с React Strict Mode
      // (двойной вызок эффектов в dev). Без этого вторая инвокация эффекта
      // видит sessionId в Set и блокирует спавн → кубы исчезают.
      thrown2DSessionIds.delete(pending.sessionId);
    };
  }, [event.id]);

  // ── Clean up guard entry when pending2DPhysics cleared ──
  useEffect(() => {
    if (!event.pending2DPhysics && thrown2DSessionIds.size > 0) {
      thrown2DSessionIds.clear();
      resultAppliedRef.current = false;
    }
  }, [event.pending2DPhysics]);

  // SINGLE-SESSION: не рендерит свой canvas — DiceCanvasHost2D рендерит.
  return null;
}
