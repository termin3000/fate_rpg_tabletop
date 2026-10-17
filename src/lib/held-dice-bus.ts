// ============================================================
// held-dice-bus.ts — модульный мост для унифицированного канваса кубов
// ============================================================
//
// ВАРИАНТ A (единый канвас): кубы, которые игрок "держит" мышкой во время
// drag'а, и кубы, которые бросаются физикой, рендерятся в ОДНОМ
// Dice3DPhysicsCanvas. Этот bus — связующее звено:
//
//   • Drag state + позиция курсора — RollGestureProvider пишет при drag,
//     HeldDiceController читает каждый кадр (cursor → arena raycast →
//     позиция удерживаемых кубов).
//   • Shared buffer — общий bufferRef для held-dice и physics snapshots.
//     DieMesh читает из него непрерывно: во время drag там процедурные
//     кадры (курсор + вращение), после release туда же льются physics-кадры.
//     Никакого "прыжка" между двумя канвасами — тот же buffer, те же DieMesh.
//   • Controller registry — HeldDiceController регистрирует API
//     (getQuaternions / getAngularVelocities), чтобы RollGestureProvider
//     мог при dragEnd захватить ТЕКУЩИЕ ориентации И угловые скорости
//     удерживаемых кубов и передать их в physics-service. Так бросок
//     продолжает вращение буквально тех же кубов.
//
// Зачем module singleton (а не React context)?
//   - bufferRef/startedRef переживают перемонтирование RollStageOverlay
//     (который keyed by event.id и ремонтируется на каждый бросок).
//   - RollGestureProvider живёт ВЫШЕ MapPanel и не имеет доступа к canvas
//     через props — bus решает это без prop-drilling.
//   - На карте ВСЕГДА один канвас (один физический мир) → singleton безопасен.
//
// ── ВАЖНО: ВСЕ state переменные — globalThis singletons ──────────────
// Раньше только _sharedBuffer и _sharedStarted были globalThis. Остальные
// (_physicsActive, _liveMode, _returnState, _bridgeCancelled, _dragState,
// _controller, _listeners) были module-level let/const. Next.js webpack
// дублирует module instances (client/server chunks, dynamic vs static
// imports) → ServerDiceStage (setPhysicsActive(true)) писал в ОДИН экземпляр,
// а HeldDiceController (getPhysicsActive()) читал из ДРУГОГО (всегда false).
// Из-за этого BRIDGE MODE никогда не обнаруживал активность физики →
// после нескольких бросков физика "не применялась" (кубы рендерились из
// устаревших held-кадров вместо physics-кадров).
//
// ФИКС: ВСЕ state переменные переведены на globalThis singletons, как уже
// было сделано в held-dice-2d-bus.ts. Зеркальная архитектура 2D/3D.

import type { DieTransform } from '@/hooks/use-dice-physics';

// ── Shared snapshot buffer (переживает перемонтирования) ──────────────
// DieMesh читает buffer.current (массив SnapshotFrame). Во время drag
// HeldDiceController пушит сюда процедурные кадры; после release сюда же
// ServerDiceStage пушит physics-кадры (через pushSnapshot). Один buffer —
// одна непрерывная анимация.
//
// ВАЖНО: не очищаем при старте physics, если это drag-continuation
// (initialQuats задан) — иначе удерживаемые кубы "исчезнут" и появятся
// заново. Очищаем только при drag START (свежие held-dice) или при
// button-throw (нет initialQuats).

export interface SnapshotFrame {
  t: number;
  transforms: Map<number, DieTransform>;
}

// ════════════════════════════════════════════════════════════════════════
// globalThis singletons — ВСЕ state переменные тут
// ════════════════════════════════════════════════════════════════════════
// Все mutable state в этом файле живёт в globalThis, чтобы гарантировать
// singleton даже при webpack module-duplication (client/server chunks,
// dynamic imports). См. комментарий в шапке файла.

type Shared3DBuffer = { current: SnapshotFrame[]; __id?: string };
type Shared3DStarted = { current: boolean };
type Shared3DReturnState = { current: ReturnToCaseState | null };
type Shared3DDragState = { current: HeldDragState };
type Shared3DListeners = { current: Set<DragListener> };
type Shared3DController = { current: HeldDiceControllerApi | null };
type Shared3DBool = { current: boolean };

const _sharedBufferId = `buf3d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function getG<T>(key: string, factory: () => T): T {
  if (typeof globalThis === 'undefined') return factory();
  const g = globalThis as unknown as Record<string, T>;
  if (!g[key]) g[key] = factory();
  return g[key];
}

// ── Buffer + started ──────────────────────────────────────────────────
function getOrCreate3DBuffer(): Shared3DBuffer {
  return getG<Shared3DBuffer>('__dice3DBufferSingleton', () => ({ current: [], __id: _sharedBufferId }));
}
function getOrCreate3DStarted(): Shared3DStarted {
  return getG<Shared3DStarted>('__dice3DStartedSingleton', () => ({ current: false }));
}

export function getSharedDiceBuffer(): { current: SnapshotFrame[] } {
  return getOrCreate3DBuffer();
}
export function getSharedStartedRef(): { current: boolean } {
  return getOrCreate3DStarted();
}

// ── Bridge cancel flag ────────────────────────────────────────────────
function getBridgeCancelledRef(): Shared3DBool {
  return getG<Shared3DBool>('__dice3DBridgeCancelledSingleton', () => ({ current: false }));
}

export function cancelHeldBridge(): void {
  getBridgeCancelledRef().current = true;
}
export function consumeBridgeCancel(): boolean {
  const ref = getBridgeCancelledRef();
  if (ref.current) {
    ref.current = false;
    return true;
  }
  return false;
}

/** Полная очистка буфера (новый бросок / новый drag). */
export function clearSharedDiceBuffer(): void {
  // Очищаем globalThis singleton (актуальный buffer) — НЕ module-level ref,
  // иначе при webpack module-duplication очистим не тот объект.
  getSharedDiceBuffer().current = [];
  getSharedStartedRef().current = false;
  // ── BRIDGE MODE: отмена активного моста ──
  // clearSharedDiceBuffer вызывается при drag→case (возврат кубов в кейс)
  // и при handleDragStart (новый drag). В обоих случаях активный bridge
  // должен быть немедленно завершён: при cancel — кубы исчезают, при новом
  // drag — bridge не нужен (кубы снова под курсором).
  cancelHeldBridge();
  // ── RETURN-TO-CASE: НЕ очищаем returnState здесь! ──
  // clearSharedDiceBuffer вызывается в handleDragStart ПЕРЕД setDragActive,
  // и triggerReturnToCase() вызывается ПЕРЕД clearSharedDiceBuffer. Если
  // здесь очистить returnState — анимация возврата никогда не запустится.
  // returnState сама очистится через 380мс (когда анимация завершится в
  // HeldDiceController) или при явном вызове clearReturnState (drag-cancel).
}

// ── RETURN-TO-CASE animation state ────────────────────────────────────
// Когда начинается новый бросок (drag ИЛИ button-throw), а на столе ещё
// лежат кубики от предыдущего броска — мы запускаем короткую анимацию:
// старые кубики "запрыгивают" в кейс (arc-траектория к casePosition + fade).
//
// triggerReturnToCase() захватывает позиции из последнего кадра shared buffer
// ДО его очистки. HeldDiceController в useFrame читает это состояние и
// пушит "возвратные" кадры для indices 4-7 (ghost-dice) с arc-интерполяцией.
// indices 0-3 в это время используются для новых кубов (held-dice или
// новая физика). После завершения анимации (~350мс) state очищается,
// indices 4-7 перестают пушиться → DieMesh для них уходит в visible=false.
//
// ВАЖНО: triggerReturnToCase ДОЛЖНА вызываться ПЕРЕД clearSharedDiceBuffer,
// иначе последний кадр (с позициями старых кубов) будет потерян.
export interface ReturnToCaseState {
  /** Стартовые позиции 4 кубиков (indices 0-3 из последнего кадра). */
  positions: Array<[number, number, number]>;
  /** Стартовые ориентации (кватернионы) 4 кубиков. */
  quats: Array<[number, number, number, number]>;
  /** Время старта анимации (Date.now()). */
  startTime: number;
  /** Длительность анимации в мс. */
  duration: number;
}

function getReturnStateRef(): Shared3DReturnState {
  return getG<Shared3DReturnState>('__dice3DReturnStateSingleton', () => ({ current: null }));
}

/**
 * Запустить анимацию возврата старых кубов в кейс.
 * Читает последний кадр shared buffer и захватывает позиции+ориентации
 * для indices 0-3. Если buffer пуст — ничего не делает (нет старых кубов).
 */
export function triggerReturnToCase(): void {
  const buf = getSharedDiceBuffer().current;
  if (buf.length === 0) return;
  const lastFrame = buf[buf.length - 1];
  const positions: Array<[number, number, number]> = [];
  const quats: Array<[number, number, number, number]> = [];
  for (let i = 0; i < 4; i++) {
    const tr = lastFrame.transforms.get(i);
    if (tr) {
      positions.push([tr.p[0], tr.p[1], tr.p[2]]);
      quats.push([tr.q[0], tr.q[1], tr.q[2], tr.q[3]]);
    } else {
      // Нет трансформа для этого индекса — используем дефолт (центр стола).
      positions.push([0, 0.25, 0]);
      quats.push([0, 0, 0, 1]);
    }
  }
  getReturnStateRef().current = {
    positions,
    quats,
    startTime: Date.now(),
    duration: 380,  // ~380мс — быстрая, "забавная" анимация прыжка
  };
}

export function getReturnState(): ReturnToCaseState | null {
  return getReturnStateRef().current;
}

export function clearReturnState(): void {
  getReturnStateRef().current = null;
}

// ── Drag state + cursor position ──────────────────────────────────────

export interface HeldDragState {
  /** Drag активен (игрок держит кубы мышкой). */
  active: boolean;
  /** Курсор clientX (px). —1 если нет данных. */
  cursorX: number;
  /** Курсор clientY (px). —1 если нет данных. */
  cursorY: number;
  /** rollMode активен (панель броска открыта) — канвас должен быть готов. */
  rollMode: boolean;
}

function getDragStateRef(): Shared3DDragState {
  return getG<Shared3DDragState>('__dice3DDragStateSingleton', () => ({
    current: { active: false, cursorX: -1, cursorY: -1, rollMode: false },
  }));
}

type DragListener = (state: HeldDragState) => void;
function getListenersRef(): Shared3DListeners {
  return getG<Shared3DListeners>('__dice3DListenersSingleton', () => ({ current: new Set<DragListener>() }));
}

export function setRollModeActive(active: boolean): void {
  const ref = getDragStateRef();
  ref.current = { ...ref.current, rollMode: active };
  _notify();
}

export function setDragActive(active: boolean, cursorX?: number, cursorY?: number): void {
  const ref = getDragStateRef();
  ref.current = {
    ...ref.current,
    active,
    cursorX: cursorX ?? ref.current.cursorX,
    cursorY: cursorY ?? ref.current.cursorY,
  };
  _notify();
}

export function setDragCursor(cursorX: number, cursorY: number): void {
  const ref = getDragStateRef();
  ref.current = { ...ref.current, cursorX, cursorY };
  // cursor update — не нотифицируем React (контроллер читает каждый кадр в
  // useFrame, ре-рендер не нужен). Это избегает 60fps ре-рендеров provider'а.
}

export function getDragState(): HeldDragState {
  return getDragStateRef().current;
}

export function subscribeDragState(listener: DragListener): () => void {
  const listeners = getListenersRef().current;
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function _notify(): void {
  const listeners = getListenersRef().current;
  const snap = Array.from(listeners);
  const ds = getDragStateRef().current;
  for (const l of snap) {
    try { l(ds); } catch (e) { console.error('[held-dice-bus] listener error:', e); }
  }
}

// ── HeldDiceController registry ───────────────────────────────────────
// HeldDiceController (внутри <Canvas>) регистрирует API, чтобы
// RollGestureProvider при dragEnd мог прочитать ТЕКУЩИЕ ориентации и
// угловые скорости удерживаемых кубов.

export interface HeldDiceControllerApi {
  /** Текущие ориентации кубов [x,y,z,w] (по одному на кубик). */
  getQuaternions: () => Array<[number, number, number, number]>;
  /** Текущие угловые скорости кубов [wx,wy,wz] (рад/с, по одному на кубик).
   *  Передаётся в physics-service как initialAngularVelocity — брошенные
   *  кубы продолжают вращение удерживаемых. */
  getAngularVelocities: () => Array<[number, number, number]>;
}

function getControllerRef(): Shared3DController {
  return getG<Shared3DController>('__dice3DControllerSingleton', () => ({ current: null }));
}

export function registerHeldDiceController(api: HeldDiceControllerApi | null): void {
  getControllerRef().current = api;
}

export function getHeldDiceController(): HeldDiceControllerApi | null {
  return getControllerRef().current;
}

// ── Live mode (нулевая задержка рендера для held-dice) ─────────────────
// DieMesh по умолчанию рендерит кадры с RENDER_DELAY_MS=110мс задержкой
// (сглаживание сетевого джиттера physics-service). Но для ЛОКАЛЬНО
// генерируемых held-dice кадров эта задержка = 110мс лаг курсора →
// неприемлемо. Когда HeldDiceController пушит кадры, он ставит liveMode=true
// → DieMesh использует renderDelay=0 → рендерит ПОСЛЕДНИЙ кадр сразу.
// Когда drag заканчивается и physics-service начинает стримить — liveMode=false
// → DieMesh возвращается к 110мс интерполяции (плавная физика).
function getLiveModeRef(): Shared3DBool {
  return getG<Shared3DBool>('__dice3DLiveModeSingleton', () => ({ current: false }));
}

export function setLiveMode(v: boolean): void { getLiveModeRef().current = v; }
export function getLiveMode(): boolean { return getLiveModeRef().current; }

// ── Physics active flag (сигнал "physics начал стримить кадры") ─────────
// BRIDGE MODE: при dragEnd HeldDiceController НЕ выключает liveMode сразу.
// Вместо этого он продолжает экстраполировать вращение удерживаемых кубов
// и пушить кадры в общий buffer (кубы крутятся на месте), пока physics-
// service не пришлёт свой первый кадр. ServerDiceStage при первом
// onTransform ставит physicsActive=true → HeldDiceController видит это,
// выключает liveMode и прекращает bridge. Так кубы НИКОГДА не "замерзают"
// между drag-end и приходом physics — нулевая задержка броска.
//
// Без bridge: dragEnd → setLiveMode(false) → DieMesh переключается на 110мс
// задержку → но buffer содержит только held-кадры (t < T_release) → renderTime
// указывает на "прошлое" → snap к последнему held кадру → кубы ЗАМИРАЮТ на
// ~110мс, пока physics-кадры не заполнят buffer. Это и было источником
// наблюдаемой задержки ~140-160ms.
//
// ВАЖНО: globalThis singleton! ServerDiceStage (setPhysicsActive(true)) и
// HeldDiceController (getPhysicsActive()) ДОЛЖНЫ видеть одно и то же
// значение. Module-level let приводил к module-duplication багу: писали в
// один экземпляр, читали из другого (всегда false) → bridge никогда не
// завершался корректно.
function getPhysicsActiveRef(): Shared3DBool {
  return getG<Shared3DBool>('__dice3DPhysicsActiveSingleton', () => ({ current: false }));
}

export function setPhysicsActive(v: boolean): void { getPhysicsActiveRef().current = v; }
export function getPhysicsActive(): boolean { return getPhysicsActiveRef().current; }

// ── Re-export THREE types used by controller (for type-only imports) ──
export type { Quaternion, Vector3 } from 'three';
