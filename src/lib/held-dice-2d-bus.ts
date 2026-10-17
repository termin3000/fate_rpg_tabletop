// ============================================================
// held-dice-2d-bus.ts — модульный мост для 2D-канваса кубиков
// ============================================================
//
// Полный аналог held-dice-bus.ts (для 3D), но для 2D-режима.
// Singleton-модуль хранит:
//   • Shared 2D buffer — массив Snapshot2DFrame. Die2DCanvas читает
//     его каждый кадр. HeldDice2DController пушит сюда процедурные
//     кадры удерживаемых кубов во время drag; ServerDiceStage2D пушит
//     сюда physics-кадры после release. Один buffer — одна непрерывная
//     анимация (как в 3D Plan A).
//   • Controller registry — HeldDice2DController регистрирует API
//     (getFaces/getPositions/getVelocities), чтобы RollGestureProvider
//     при dragEnd мог захватить ТЕКУЩИЕ грани И позиции И скорости
//     удерживаемых 2D-кубиков и передать их в 2D-физику. Так бросок
//     становится бесшовным: те же плитки полетели.
//   • Return-to-case state — для анимации возврата старых кубов в кейс.
//
// Drag state (active/cursorX/cursorY/rollMode) ПЕРЕИСПОЛЬЗУЕТСЯ из
// held-dice-bus.ts — он уже хранит эти поля и RollGestureProvider уже
// пишет в них. 2D-контроллер подписывается на subscribeDragState.
//
// Зачем отдельный bus от 3D?
//   - 3D buffer хранит DieTransform (3D-кватернионы), 2D — Die2DTransform.
//   - Контроллеры разные (3D getQuaternions vs 2D getFaces).
//   - Изоляция: переключение diceMode не мутирует чужой buffer.

import type { Snapshot2DFrame, Die2DTransform, FudgeFace } from './dice-2d-physics';

// ── Shared 2D snapshot buffer ────────────────────────────────────────────
// ВАЖНО: используем globalThis для гарантии singleton в браузере.
// Next.js webpack может создавать РАЗНЫЕ module instances (client/server chunks),
// что приводит к разным _shared2DBuffer объектам. globalThis гарантирует
// один объект на всё приложение.
type Shared2DBuffer = { current: Snapshot2DFrame[]; __id?: string };
const _shared2DBufferId = `buf2d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function getOrCreateBuffer(): Shared2DBuffer {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as unknown as { __dice2DBufferSingleton?: Shared2DBuffer };
    if (!g.__dice2DBufferSingleton) {
      g.__dice2DBufferSingleton = { current: [], __id: _shared2DBufferId };
    }
    return g.__dice2DBufferSingleton;
  }
  // SSR fallback (не должно использоваться в browser).
  return { current: [], __id: _shared2DBufferId };
}

const _shared2DBuffer: Shared2DBuffer = getOrCreateBuffer();

// ── Started flag тоже через globalThis (консистентность с buffer) ──
// Раньше был module-level { current: false }. При webpack module-duplication
// Dice2DCanvas и ServerDiceStage2D получали РАЗНЫЕ startedRef объекты.
// ServerDiceStage2D ставил started=true в одном, Die2DCanvas читал false
// из другого → рендер мог не запуститься / рассинхрон. globalThis фиксит.
function getOrCreate2DStarted(): { current: boolean } {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as unknown as { __dice2DStartedSingleton?: { current: boolean } };
    if (!g.__dice2DStartedSingleton) {
      g.__dice2DStartedSingleton = { current: false };
    }
    return g.__dice2DStartedSingleton;
  }
  return { current: false };
}

export function getShared2DDiceBuffer(): { current: Snapshot2DFrame[] } {
  // Всегда возвращаем globalThis singleton (актуальный, не stale).
  return getOrCreateBuffer();
}

export function getShared2DBufferId(): string {
  return getOrCreateBuffer().__id ?? 'no-id';
}

export function getShared2DStartedRef(): { current: boolean } {
  return getOrCreate2DStarted();
}

export function clearShared2DDiceBuffer(): void {
  // Очищаем globalThis singleton (актуальный buffer).
  getShared2DDiceBuffer().current = [];
  getShared2DStartedRef().current = false;
  // Возврат в кейс НЕ очищаем (как в 3D) — returnState сама очистится.
}

export function pushSnapshot2D(
  bufferRef: { current: Snapshot2DFrame[] },
  frame: Snapshot2DFrame,
): void {
  bufferRef.current.push(frame);
  // Ограничиваем длину buffer (как в 3D pushSnapshot) — чтобы не рос бесконечно.
  if (bufferRef.current.length > 240) {
    bufferRef.current.splice(0, bufferRef.current.length - 240);
  }
}

// ── Live mode (нулевая задержка рендера для held-dice) ───────────────────
// Die2DCanvas по умолчанию рендерит кадры с задержкой RENDER_DELAY_MS=80мс
// (сглаживание). Для ЛОКАЛЬНО генерируемых held-dice кадров задержка
// неприемлема. Когда 2D-контроллер пушит кадры, он ставит live2DMode=true.
//
// ── globalThis singleton ──
// ВАЖНО: live2DMode и physics2DActive РАНЬШЕ были module-level let.
// Next.js webpack может создавать РАЗНЫЕ module instances (client/server
// chunks), из-за чего ServerDiceStage2D (setPhysics2DActive(true)) писал в
// ОДИН экземпляр, а roll-gesture-provider / Dice2DCanvas (getPhysics2DActive)
// читали из ДРУГОГО (всегда false). Это ломало guard в handleDragStart:
// `if (!getPhysics2DActive()) { clearShared2DDiceBuffer(); }` — buffer
// очищался ДАЖЕ когда предыдущий бросок ещё катился → старые кубы исчезали
// mid-tumble (баг "преждевременное исчезновение 2D кубов").
// ФИКС: храним флаги в globalThis (как _shared2DBuffer / _shared2DStarted).
function getLive2DModeRef(): { current: boolean } {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as unknown as { __dice2DLiveModeSingleton?: { current: boolean } };
    if (!g.__dice2DLiveModeSingleton) g.__dice2DLiveModeSingleton = { current: false };
    return g.__dice2DLiveModeSingleton;
  }
  return { current: false };
}
function getPhysics2DActiveRef(): { current: boolean } {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as unknown as { __dice2DPhysicsActiveSingleton?: { current: boolean } };
    if (!g.__dice2DPhysicsActiveSingleton) g.__dice2DPhysicsActiveSingleton = { current: false };
    return g.__dice2DPhysicsActiveSingleton;
  }
  return { current: false };
}
export function setLive2DMode(v: boolean): void { getLive2DModeRef().current = v; }
export function getLive2DMode(): boolean { return getLive2DModeRef().current; }

// ── Physics active flag (сигнал "physics начал стримить кадры") ───────────
export function setPhysics2DActive(v: boolean): void { getPhysics2DActiveRef().current = v; }
export function getPhysics2DActive(): boolean { return getPhysics2DActiveRef().current; }

// ── RETURN-TO-CASE animation state (2D) ──────────────────────────────────
// Когда начинается новый бросок (drag ИЛИ button-throw), а на столе ещё
// лежат кубики от предыдущего броска — запускаем короткую анимацию:
// старые плитки «запрыгивают» в кейс (arc-траектория к casePosition + fade).
//
// triggerReturnToCase2D() захватывает позиции из последнего кадра shared 2D
// buffer ДО его очистки. Die2DCanvas в RAF-цикле читает это состояние и
// анимирует ghost-плитки (indices 4-7) с интерполяцией к casePosition.
export interface ReturnToCase2DState {
  /** Стартовые позиции 4 плиток (из последнего кадра). */
  positions: Array<{ x: number; y: number }>;
  /** Стартовые грани 4 плиток (для отображения во время анимации). */
  faces: FudgeFace[];
  /** Время старта анимации (Date.now()). */
  startTime: number;
  /** Длительность анимации в мс. */
  duration: number;
  /** Целевая позиция кейса на карте (px). */
  caseX: number;
  caseY: number;
}

// ── RETURN-TO-CASE state тоже через globalThis (консистентность) ──
// Тот же module-duplication риск: если state в module-level let,
// triggerReturnToCase2D (вызывается из ServerDiceStage2D) пишет в один
// экземпляр, а Die2DCanvas (читает getReturn2DState) — из другого.
// globalThis гарантирует один объект на приложение.
function getReturn2DStateRef(): { current: ReturnToCase2DState | null } {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as unknown as { __dice2DReturnStateSingleton?: { current: ReturnToCase2DState | null } };
    if (!g.__dice2DReturnStateSingleton) g.__dice2DReturnStateSingleton = { current: null };
    return g.__dice2DReturnStateSingleton;
  }
  return { current: null };
}

/**
 * Запустить анимацию возврата старых 2D-кубиков в кейс.
 * Читает последний кадр shared 2D buffer и захватывает позиции+грани
 * для indices 0-3. Если buffer пуст — ничего не делает.
 *
 * caseX/caseY — позиция кейса на карте (px, относительно карты).
 * Если не переданы — берётся центр левого нижнего угла (fallback).
 *
 * ── STALE FRAME PROTECTION ──
 * Если последний кадр в buffer старше 500мс — не запускаем анимацию.
 *
 * Раньше было 2с — слишком длинный порог. При rapid-throw (событие2
 * стартует во время exit-окна события1, ~470мс после requestLiveRollExit)
 * буфер содержит кадры события1 возрастом ~470мс. С порогом 2с эти кадры
 * считались "свежими" → запускалась ghost-анимация → "призрачные кубы
 * в центре карты" (призраки летят из позиций события1 в кейс).
 *
 * С порогом 500мс кадры старше 500мс не анимируются. 470мс exit-окно
 * + задержка dismiss (~10-50мс) → кадры события1 стареют до ~520мс,
 * что больше 500мс → ghost-анимация не запускается. Cubes события1
 * просто исчезают при clearShared2DDiceBuffer (мгновенный snap, без
 * анимации — приемлемо для rapid-throw сценария).
 *
 * Для нормального сценария (старые кубы на столе, новый бросок) кадры
 * всегда свежие (<100мс, physics RAF пушит 60fps) → анимация работает.
 */
export function triggerReturnToCase2D(caseX?: number, caseY?: number): void {
  const buf = getShared2DDiceBuffer().current;
  if (buf.length === 0) return;
  const lastFrame = buf[buf.length - 1];
  // Stale frame protection: если последний кадр старше 500мс — не анимируем.
  // lastFrame.t — performance.now() (из RAF), текущее время — тоже performance.now().
  const now = performance.now();
  if (now - lastFrame.t > 500) {
    return;
  }
  const positions: Array<{ x: number; y: number }> = [];
  const faces: FudgeFace[] = [];
  for (let i = 0; i < 4; i++) {
    const tr = lastFrame.dice.find((d) => d.i === i);
    if (tr) {
      positions.push({ x: tr.x, y: tr.y });
      faces.push(tr.face);
    } else {
      positions.push({ x: 0, y: 0 });
      faces.push(0);
    }
  }
  getReturn2DStateRef().current = {
    positions,
    faces,
    startTime: Date.now(),
    duration: 380,
    caseX: caseX ?? 60,
    caseY: caseY ?? 0,  // caller должен передать реальную позицию
  };
}

export function getReturn2DState(): ReturnToCase2DState | null {
  return getReturn2DStateRef().current;
}

export function clearReturn2DState(): void {
  getReturn2DStateRef().current = null;
}

// ── HeldDice2DController registry ────────────────────────────────────────
// HeldDice2DController (внутри Dice2DCanvas) регистрирует API, чтобы
// RollGestureProvider при dragEnd мог прочитать ТЕКУЩИЕ грани, позиции и
// скорости удерживаемых 2D-кубиков.
export interface HeldDice2DControllerApi {
  /** Текущие грани 4 кубиков (для бесшовного handoff в физику). */
  getFaces: () => FudgeFace[];
  /** Текущие позиции 4 кубиков на карте (px). */
  getPositions: () => Array<{ x: number; y: number }>;
  /** Текущие скорости 4 кубиков (px/с) — из velocity tracker. */
  getVelocities: () => Array<{ vx: number; vy: number }>;
}

// ── HeldDice2DController registry тоже через globalThis ──
// Тот же module-duplication риск: registerHeldDice2DController (вызывается из
// Dice2DCanvas) пишет в один экземпляр, getHeldDice2DController (вызывается из
// roll-gesture-provider) читает из другого → returns null → initialFaces
// undefined → isDragContinuation=false → buffer очищается при новом броске.
function getController2DRef(): { current: HeldDice2DControllerApi | null } {
  if (typeof globalThis !== 'undefined') {
    const g = globalThis as unknown as { __dice2DControllerSingleton?: { current: HeldDice2DControllerApi | null } };
    if (!g.__dice2DControllerSingleton) g.__dice2DControllerSingleton = { current: null };
    return g.__dice2DControllerSingleton;
  }
  return { current: null };
}

export function registerHeldDice2DController(api: HeldDice2DControllerApi | null): void {
  getController2DRef().current = api;
}

export function getHeldDice2DController(): HeldDice2DControllerApi | null {
  return getController2DRef().current;
}
