'use client';

// ============================================================
// DiceCanvasHost — постоянный 3D-канвас для held-dice и single-бросков
// ============================================================
//
// ВАРИАНТ A (единый канвас): этот компонент монтируется в MapPanel и
// существует ВСЁ время, пока есть карта. Он рендерит Dice3DPhysicsCanvas
// с heldMode=true → HeldDiceController активен.
//
//   • Во время drag: HeldDiceController пушит процедурные кадры удерживаемых
//     кубов в общий shared buffer. DieMesh рендерит их.
//   • После release (single drag-throw): ServerDiceStage кормит ТЕ ЖЕ
//     кубы через общий shared buffer (physics snapshots). DieMesh НЕ
//     перемонтируется → бесшовный handoff "те же кубы полетели".
//   • Button single-throw: тоже через shared buffer (HeldDiceController
//     idle — drag не активен — физика сама льёт кадры).
//   • Multi-session (VS/mass): ServerDiceStage рендерит СВОЙ отдельный
//     канвас (numDice=N*4), shared buffer очищается → host невидим.
//
// numDice=8 (ВЫШЛО с 4 → 8): indices 0-3 = "живые" кубы (held-dice во
// время drag ИЛИ physics при броске). indices 4-7 = "ghost-кубы" для
// анимации возврата старых кубов в кейс (triggerReturnToCase). Ghost-кубы
// активны только ~380мс при старте нового броска, пока на столе ещё
// лежат кубы от предыдущего. В остальное время ghost-кубы невидимы
// (DieMesh видит, что index'а нет в кадре → visible=false).

import dynamic from 'next/dynamic';
import { useMemo } from 'react';
import { getSharedDiceBuffer, getSharedStartedRef } from '@/lib/held-dice-bus';
import { useFateStore } from '@/lib/store';

// Динамический импорт Three.js-канваса — ssr:false, отдельный chunk.
const Dice3DPhysicsCanvas = dynamic(
  () => import('./dice-3d-physics-canvas').then((m) => m.Dice3DPhysicsCanvas),
  { ssr: false },
);

interface DiceCanvasHostProps {
  viewport: { panX: number; panY: number; zoom: number };
  arenaHalfW?: number;
  arenaHalfH?: number;
  mapImageSize?: { w: number; h: number } | null;
}

export function DiceCanvasHost({ viewport, arenaHalfW, arenaHalfH, mapImageSize }: DiceCanvasHostProps) {
  // Shared buffer + startedRef — ОДИН на всё приложение (module singleton).
  // ServerDiceStage (single-throw) пишет в него physics-кадры;
  // HeldDiceController пишет в него held-кадры. DieMesh здесь читает.
  const bufferRef = useMemo(() => getSharedDiceBuffer(), []);
  const startedRef = useMemo(() => getSharedStartedRef(), []);

  // ── Per-player dice colors for single-session rolls ──
  // This persistent canvas renders BOTH held-dice (during drag, before a roll
  // exists) AND single-session physics rolls (after release / button throw).
  // For held-dice there is no liveRollStage → participantColors is undefined →
  // DieMesh falls back to the LOCAL viewer's store colors (correct: you drag
  // your own dice). For an active single roll, we read the first participant's
  // stamped colors so the tumbling dice appear in the ROLLER's palette — both
  // for the local roller (whose colors == local store anyway) AND for remote
  // viewers (who would otherwise see their own colors, defeating per-player
  // customization).
  //
  // IMPORTANT: we select the primitive color strings individually (stable refs)
  // and build the array via useMemo. Returning a fresh array literal from a
  // Zustand selector breaks useSyncExternalStore (getSnapshot must be cached)
  // and triggers an infinite render loop ("Maximum update depth exceeded").
  const participantDiceColor = useFateStore(
    (s) => s.liveRollStage?.participants?.[0]?.diceColor,
  );
  const participantSymbolColor = useFateStore(
    (s) => s.liveRollStage?.participants?.[0]?.symbolColor,
  );
  const liveStageParticipantColors = useMemo(() => {
    if (participantDiceColor && participantSymbolColor) {
      return [{ diceColor: participantDiceColor, symbolColor: participantSymbolColor }];
    }
    return undefined;
  }, [participantDiceColor, participantSymbolColor]);

  return (
    <Dice3DPhysicsCanvas
      numDice={8}
      bufferRef={bufferRef}
      startedRef={startedRef}
      viewport={viewport}
      arenaHalfW={arenaHalfW}
      arenaHalfH={arenaHalfH}
      mapImageSize={mapImageSize}
      heldMode
      participantColors={liveStageParticipantColors}
    />
  );
}
