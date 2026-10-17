'use client';

// ============================================================
// DiceCanvasHost2D — постоянный 2D-канвас для held-dice и single-бросков
// ============================================================
//
// Полный аналог DiceCanvasHost (для 3D), но для 2D-режима. Монтируется
// в MapPanel когда diceMode === '2d'. Существует всё время, пока есть карта.
//
// Рендерит Dice2DCanvas с heldMode=true → встроенный HeldDice2DController
// активен:
//   • Во время drag: пушит процедурные кадры удерживаемых 2D-плиток
//     под курсором в общий shared 2D buffer. Die2DCanvas рендерит их.
//   • После release (single drag-throw): ServerDiceStage2D кормит ТЕ ЖЕ
//     плитки через общий shared buffer (2D-физика). Die2DCanvas НЕ
//     перемонтируется → бесшовный handoff «те же плитки полетели».
//   • Button single-throw: тоже через shared buffer (контроллер idle —
//     drag не активен — 2D-физика сама льёт кадры).
//   • Multi-session (VS/mass): ServerDiceStage2D рендерит СВОЙ отдельный
//     канвас (numDice=N*4), shared 2D buffer очищается → host невидим.
//
// numDice=8: indices 0-3 = «живые» плитки (held-dice во время drag ИЛИ
// physics при броске). indices 4-7 = «ghost-плитки» для анимации возврата
// старых кубов в кейс (triggerReturnToCase2D). Ghost активны только ~380мс.
//
// ── STATIC import (не dynamic) ──
// Dice2DCanvas использует static import (как ServerDiceStage в 3D), чтобы
// гарантировать что module singleton (held-dice-2d-bus.ts) — ОДИН на всё
// приложение. Dynamic import создаёт отдельный chunk с собственным module
// scope → getShared2DDiceBuffer() возвращал бы РАЗНЫЕ объекты в
// Dice2DCanvas (dynamic) и ServerDiceStage2D (static) → buffer не
// синхронизировался бы. 'use client' в dice-2d-canvas.tsx + то что
// DiceCanvasHost2D монтируется только в browser (через условный рендер в
// MapPanel) — обеспечивает SSR-safety без dynamic import.

import { useMemo } from 'react';
import { getShared2DDiceBuffer, getShared2DStartedRef } from '@/lib/held-dice-2d-bus';
import { Dice2DCanvas } from './dice-2d-canvas';

interface DiceCanvasHost2DProps {
  viewport: { panX: number; panY: number; zoom: number };
  arenaHalfW?: number;
  arenaHalfH?: number;
  mapImageSize?: { w: number; h: number } | null;
}

export function DiceCanvasHost2D({ viewport, arenaHalfW, arenaHalfH, mapImageSize }: DiceCanvasHost2DProps) {
  // Shared 2D buffer + startedRef — ОДИН на всё приложение (module singleton).
  // ServerDiceStage2D (single-throw) пишет в него physics-кадры;
  // HeldDice2DController пишет в него held-кадры. Die2DCanvas здесь читает.
  const bufferRef = useMemo(() => getShared2DDiceBuffer(), []);
  const startedRef = useMemo(() => getShared2DStartedRef(), []);

  return (
    <Dice2DCanvas
      numDice={8}
      bufferRef={bufferRef}
      startedRef={startedRef}
      viewport={viewport}
      arenaHalfW={arenaHalfW}
      arenaHalfH={arenaHalfH}
      mapImageSize={mapImageSize}
      heldMode
    />
  );
}
