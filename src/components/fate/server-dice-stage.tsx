'use client';

// ============================================================
// ServerDiceStage — обёртка над Dice3DPhysicsCanvas + useDicePhysics
// ============================================================
//
// Используется в RollStageOverlay когда event.pendingPhysics != null
// (single-session) ИЛИ event.pendingPhysicsSessions != null (multi-session,
// для одновременного VS броска).
//
// Поведение:
//   1. Mount: для каждой pending-сессии вызывает physics.throwDice с
//      originSide из сессии. onTransform пушит снапшот в bufferRef
//      СМЕЩАЯ индексы кубиков по сессии (session[i] → dice i*4..i*4+3).
//   2. onResult: вызывает applyPhysicsResult(event.id, session.participantId, dice)
//      для соответствующего участника.
//   3. Unmount / event change: cancel() всех активных сессий.
//
// MULTI-SESSION (VS): обе сессии бросаются ОДНОВРЕМЕННО. Кубики ролика
// летят с near (ближний край), кубики оппонента с far (дальний край).
// В одном Dice3DPhysicsCanvas рендерятся 8 кубиков (4 ролик + 4 оппонент),
// каждый со своим индексом (0-3 ролик, 4-7 оппонент). Это позволяет видеть
// ОБА броска на столе одновременно — результат VS виден по кубам.
//
// ВАЖНО: guard от двойного броска. Module-level Set уже-брошенных
// pendingSessionId гарантирует, что один и тот же бросок не запустится дважды.

import { useEffect, useMemo, useRef } from 'react';
import { useDicePhysics } from '@/hooks/use-dice-physics';
import {
  Dice3DPhysicsCanvas,
  pushSnapshot,
} from '@/components/fate/dice-3d-physics-canvas';
import type { SnapshotFrame } from '@/components/fate/dice-3d-physics-canvas';
import { useFateStore } from '@/lib/store';
import type { LiveRollEvent } from '@/lib/types';
import {
  getSharedDiceBuffer,
  getSharedStartedRef,
  setLiveMode,
  setPhysicsActive,
  triggerReturnToCase,
} from '@/lib/held-dice-bus';

// Module-level guard: tracks which pendingSessionId values have already
// been thrown. Survives React cleanup/remount cycles within the same
// roll. Cleared after the result is applied (so a future roll with a
// new sessionId can proceed).
const thrownSessionIds = new Set<string>();

// Каждая сессия в multi-session броске имеет 4 кубика. Смещение индексов:
// session[0] → 0..3, session[1] → 4..7, session[2] → 8..11, и т.д.
const DICE_PER_SESSION = 4;

interface ServerDiceStageProps {
  event: LiveRollEvent;
  viewport: { panX: number; panY: number; zoom: number };
  // Половины сторон прямоугольной арены (в физ. единицах) — вычисляются из
  // naturalWidth/naturalHeight фонового изображения карты. Передаются в
  // physics-service (стены на ±arenaHalfW/H) и в Dice3DPhysicsCanvas
  // (визуальные бортики + позиционирование канваса по контуру карты).
  arenaHalfW?: number;
  arenaHalfH?: number;
  // Размер фонового изображения (naturalWidth × naturalHeight) — для
  // позиционирования 3D-канваса поверх видимой области карты.
  mapImageSize?: { w: number; h: number } | null;
}

export function ServerDiceStage({ event, viewport, arenaHalfW, arenaHalfH, mapImageSize }: ServerDiceStageProps) {
  const physics = useDicePhysics();
  const applyResult = useFateStore((s) => s.applyPhysicsResult);

  // Определяем режим: multi-session (VS) или single-session.
  const multiSessions = event.pendingPhysicsSessions && event.pendingPhysicsSessions.length > 0
    ? event.pendingPhysicsSessions
    : null;
  const singleSession = event.pendingPhysics;
  const isMulti = !!multiSessions;

  // ── ВАРИАНТ A: общий канвас для single-session ──────────────────
  // Single-session броски (drag И button) рендерятся в ПОСТОЯННОМ канвасе
  // (DiceCanvasHost в MapPanel). ServerDiceStage здесь только кормит общий
  // shared buffer physics-кадрами. Свой канвас НЕ рендерит.
  //
  // Multi-session (VS/mass) — рендерит СВОЙ отдельный канвас (numDice=N*4)
  // со своим локальным buffer (как раньше). При монтировании очищает shared
  // buffer → постоянный host становится невидимым (не мешает).
  //
  // bufferRef: single → shared singleton; multi → local useRef.
  // startedRef: ВСЕГДА локальный (react-hooks/immutability запрещает мутировать
  // conditional-refs в effect). Для single дополнительно пишем в shared startedRef
  // (хост читает его). Для multi — только локальный (multi-канвас читает его).
  const localBufferRef = useRef<SnapshotFrame[]>([]);
  const startedRef = useRef(false);
  const bufferRef = isMulti
    ? localBufferRef
    : (getSharedDiceBuffer() as unknown as React.MutableRefObject<SnapshotFrame[]>);

  const handlesRef = useRef<Array<{ cancel: () => void } | null>>([]);
  const resultsAppliedRef = useRef<Set<string>>(new Set());

  // ── Drag-continuation? (initialQuats передан → бросок продолжает held-dice) ──
  // Если да — НЕ очищаем shared buffer при старте: удерживаемые кубы уже там,
  // физика продолжит кормить тот же buffer → бесшовный handoff.
  // Если нет (button-throw) — очищаем (свежий бросок).

  // ── Арена = вся карта (как раньше, рабочее состояние) ──
  // Раньше тут была логика "drop-position": маленькая арена (1.6×1.1),
  // центрированная на drop-точке + dieScale=1.8 + visual padding. Это
  // приводило к обрезанию кубов границами маленького canvas и прочим
  // визуальным артефактам. По запросу пользователя ("вчера всё работало
  // нормально") откатываемся к большой арене = вся карта.
  //
  // Кубы спавнятся с near края (низ карты, originSide='near'), летят к
  // центру, падают на карту. Canvas покрывает всю карту (screen-прямоугольник).
  // Никаких обрезаний — кубы всегда внутри видимой области.
  const effectiveArenaHalfW = arenaHalfW;
  const effectiveArenaHalfH = arenaHalfH;

  // ВАЖНО: numDiceTotal вычисляется ОДИН РАЗ на event (useMemo by event.id).
  // Раньше было `numSessions * DICE_PER_SESSION` на каждый рендер. Когда физика
  // финализировалась, applyResult убирал pendingPhysics → numSessions=0 →
  // numDiceTotal=0 → Dice3DPhysicsCanvas получал numDice=0 → ВСЕ DieMesh
  // размонтировались → кубики мгновенно пропадали со стола ДО того, как
  // 5-секундный auto-dismiss таймер успевал сработать.
  //
  // Теперь: useMemo фиксирует numDiceTotal при первом рендере (когда
  // pendingPhysics ещё не null) и не меняет его до закрытия оверлея.
  // Кубики остаются на столе после settle, видны пользователю.
  const { numDiceTotal, numSessionsFixed } = useMemo(() => {
    const sessions = multiSessions ? multiSessions.length : (singleSession ? 1 : 0);
    return {
      numDiceTotal: Math.max(sessions, 1) * DICE_PER_SESSION,
      numSessionsFixed: Math.max(sessions, 1),
    };
    // numDiceTotal intentionally computed once per event (not per render).
    // When physics finalizes, pendingPhysics becomes null but we must NOT
    // recalculate — dice must stay mounted on the table after settle.
  }, [event.id]);

  // Запуск броска — ОДИН раз на event (keyed by event.id).
  // ВАЖНО: зависимость только event.id, НЕ pendingPhysicsSessions.
  // Причина: когда результат сессии приходит, applyPhysicsResult убирает её
  // из pendingPhysicsSessions. Если эффект зависит от этого массива — он
  // перезапустится, вызовет cancel() на активных throws и НЕ сможет их
  // перезапустить (thrownSessionIds guard). Результат: safety timeout.
  // Фикс: эффект читает sessions ОДИН раз при монтировании (на event.id),
  // бросает все сессии, и не реагирует на изменения pendingPhysicsSessions.
  useEffect(() => {
    // ── ОЧИСТКА БУФЕРА ── (Вариант A: умная очистка + BRIDGE MODE)
    //
    // MULTI-SESSION (VS/mass): очищаем И shared (скрыть постоянный host —
    // он не должен мешать multi-канвасу), И local (свежий multi-бросок).
    //
    // SINGLE drag-throw (initialQuats передан): НЕ очищаем shared buffer —
    // удерживаемые кубы уже там, физика продолжит кормить тот же buffer →
    // бесшовный handoff. И НЕ выключаем liveMode — пусть BRIDGE MODE в
    // HeldDiceController продолжит экстраполировать вращение кубов, пока
    // physics не пришлёт первый кадр (устраняет задержку ~110мс).
    // Первый physics-кадр вызовет setPhysicsActive(true) → bridge завершится
    // сам, liveMode выключится в HeldDiceController.
    //
    // SINGLE button-throw (без initialQuats): очищаем shared (свежий бросок,
    // как раньше — иначе кубы "вылезают из-за правой части карты").
    const isDragContinuation = !isMulti
      && !!(singleSession?.initialQuats && singleSession.initialQuats.length > 0);
    if (isMulti) {
      // Скрыть постоянный host + свежий local buffer.
      // ── RETURN-TO-CASE: для multi-session НЕ запускаем анимацию возврата.
      // Multi-session рендерит СВОЙ отдельный canvas (поверх постоянного host).
      // Если запустить ghost-анимацию в persistent host, она будет видна ПОД
      // multi-session canvas (оба с alpha:true) — визуально messy. Проще
      // мгновенно скрыть старые кубы. Single-session (drag и button) — там
      // ghost-анимация работает чисто (один canvas, нет перекрытия).
      const shared = getSharedDiceBuffer();
      shared.current = [];
      getSharedStartedRef().current = false;
      setLiveMode(false);
      setPhysicsActive(false);
      localBufferRef.current = [];
      startedRef.current = false;

      // ── SPAWN FRAME for multi-session ──
      // Аналогично single-session: пушим начальные позиции для ВСЕХ сессий
      // (0-3, 4-7, ...) в localBufferRef чтобы cube были видны с первого
      // кадра, до прихода physics-кадров (~50-100ms).
      {
        const aHalfH = effectiveArenaHalfH ?? 4.0;
        const step = 0.24;
        const spawnY = 0.25;
        const allSpawnDice: Array<{ i: number; p: [number, number, number]; q: [number, number, number, number] }> = [];
        for (let sIdx = 0; sIdx < (multiSessions?.length ?? 0); sIdx++) {
          const sess = multiSessions![sIdx];
          const baseIndex = sIdx * DICE_PER_SESSION;
          const originSide = sess.originSide ?? 'near';
          const originX = sess.originX ?? 0;
          const spawnX0 = originX;
          const spawnZ0 = originSide === 'far' ? -aHalfH + 0.5 : aHalfH - 0.5;
          for (let k = 0; k < 4; k++) {
            const col = k % 2;
            const row = Math.floor(k / 2);
            allSpawnDice.push({
              i: baseIndex + k,
              p: [spawnX0 + (col - 0.5) * step * 2, spawnY, spawnZ0 + (row - 0.5) * step * 2],
              q: [0, 0, 0, 1],
            });
          }
        }
        if (allSpawnDice.length > 0) {
          pushSnapshot(localBufferRef, { t: Date.now(), dice: allSpawnDice });
          startedRef.current = true;
        }
      }
    } else if (isDragContinuation) {
      // ── BRIDGE MODE ──
      // НЕ трогаем shared buffer — там held-dice кадры.
      // НЕ выключаем liveMode — пусть HeldDiceController продолжит экстраполяцию
      // вращения в bridge mode, пока physics не пришёл (нулевая задержка).
      // Сбрасываем physicsActive (мог остаться от предыдущего броска).
      // ── RETURN-TO-CASE: для drag-continuation старых кубов на столе нет
      // (они только что были held-dice под курсором и сейчас летят в physics).
      // triggerReturnToCase безвреден если buffer не имеет "старых" кадров,
      // но здесь buffer имеет held-dice кадры — они будут захвачены как
      // "старые" и анимированы в кейс. Это НЕ то, что мы хотим (кубы должны
      // перейти в physics, а не в кейс). Поэтому НЕ вызываем triggerReturnToCase
      // для drag-continuation.
      setPhysicsActive(false);
    } else {
      // Single button-throw — свежий shared buffer.
      // ── RETURN-TO-CASE: захватываем позиции старых кубов (если они есть
      // на столе от предыдущего броска) ПЕРЕД очисткой buffer. Ghost-dice
      // (indices 4-7) будут анимироваться в кейс параллельно с новым
      // physics-броском (indices 0-3). Безвреден если buffer пуст.
      triggerReturnToCase();
      const shared = getSharedDiceBuffer();
      shared.current = [];
      getSharedStartedRef().current = false;
      setLiveMode(false);
      setPhysicsActive(false);

      // ── SPAWN FRAME: immediately push initial dice positions to buffer ──
      // ПРОБЛЕМА: после clearSharedDiceBuffer() buffer пуст. Physics-service
      // начинает стримить кадры через ~50-100ms (socket round-trip + spawn).
      // В этот gap DieMesh для indices 0-3 видит пустой buffer →
      // mesh.visible=false → LIVE CUBES INVISIBLE. Если одновременно активна
      // ghost-анимация (return-to-case от предыдущего броска), то видны
      // ТОЛЬКО ghost-кубы (4-7) → пользователь видит "призрачные кубы".
      //
      // ФИКС: сразу после очистки buffer пушим синтетический "spawn frame"
      // с начальными позициями кубиков в точке спавна. DieMesh видит кадр →
      // mesh.visible=true → live кубы видны с первого кадра. Когда physics
      // начнёт стримить (через 50-100ms), его кадры заменят spawn frame
      // (pushSnapshot merge'ит по t, но t разные → новый кадр добавится).
      // Spawn positions:
      //   - spawnX/spawnZ (drag "token placement") если заданы
      //   - иначе edge-based: near (default) = +arenaHalfH - 0.5, far = -arenaHalfH + 0.5
      //   - originX сдвигает по X
      // 2x2 grid с шагом HELD_GRID_STEP=0.48 (совпадает с physics spawn).
      {
        const aHalfH = effectiveArenaHalfH ?? 4.0;
        const originSide = singleSession?.originSide ?? 'near';
        const originX = singleSession?.originX ?? 0;
        const spawnX0 = singleSession?.spawnX ?? originX;
        const spawnZ0 = singleSession?.spawnZ ?? (originSide === 'far' ? -aHalfH + 0.5 : aHalfH - 0.5);
        const spawnY = 0.25; // HELD_DIE_Y
        const step = 0.24; // half of HELD_GRID_STEP (0.48)
        const initialQuats = singleSession?.initialQuats;
        const spawnDice = [
          { i: 0, p: [spawnX0 - step, spawnY, spawnZ0 - step] as [number, number, number], q: (initialQuats?.[0] ?? [0, 0, 0, 1]) as [number, number, number, number] },
          { i: 1, p: [spawnX0 + step, spawnY, spawnZ0 - step] as [number, number, number], q: (initialQuats?.[1] ?? [0, 0, 0, 1]) as [number, number, number, number] },
          { i: 2, p: [spawnX0 - step, spawnY, spawnZ0 + step] as [number, number, number], q: (initialQuats?.[2] ?? [0, 0, 0, 1]) as [number, number, number, number] },
          { i: 3, p: [spawnX0 + step, spawnY, spawnZ0 + step] as [number, number, number], q: (initialQuats?.[3] ?? [0, 0, 0, 1]) as [number, number, number, number] },
        ];
        pushSnapshot(bufferRef, { t: Date.now(), dice: spawnDice });
        getSharedStartedRef().current = true;
      }
    }
    // bufferRef для single === shared объект (см. выше), для multi === local.
    // pushSnapshot ниже пишет в правильный buffer автоматически.

    // Snapshot of sessions at mount time — stable, won't change even if
    // event.pendingPhysicsSessions is mutated later.
    const sessionsAtMount = multiSessions;
    const singleAtMount = singleSession;

    if (sessionsAtMount && sessionsAtMount.length > 0) {
      // ── MULTI-SESSION (VS): бросаем все сессии параллельно ──
      handlesRef.current = sessionsAtMount.map((sess, sessionIdx) => {
        if (thrownSessionIds.has(sess.sessionId)) return null;
        thrownSessionIds.add(sess.sessionId);

        const baseIndex = sessionIdx * DICE_PER_SESSION;
        const participantId = sess.participantId;

        const safetyTimeout = setTimeout(() => {
          if (!resultsAppliedRef.current.has(participantId)) {
            console.warn(`[ServerDiceStage] safety timeout — applying fallback dice for ${participantId}`);
            applyResult(event.id, participantId, [0, 0, 0, 0]);
            resultsAppliedRef.current.add(participantId);
          }
        }, 8000);

        const handle = sess.isRemote
          ? physics.subscribeToSession(sess.sessionId, {
              onTransform: (snap) => {
                startedRef.current = true;
                const remappedDice = snap.dice.map((d) => ({
                  ...d,
                  i: d.i + baseIndex,
                }));
                pushSnapshot(bufferRef, { t: snap.t, dice: remappedDice });
              },
              onResult: (res) => {
                if (resultsAppliedRef.current.has(participantId)) return;
                resultsAppliedRef.current.add(participantId);
                clearTimeout(safetyTimeout);
                applyResult(event.id, participantId, res.dice);
              },
              onError: (err) => {
                console.error(`[ServerDiceStage] subscribe error for ${participantId}:`, err.message);
                if (!resultsAppliedRef.current.has(participantId)) {
                  clearTimeout(safetyTimeout);
                  applyResult(event.id, participantId, [0, 0, 0, 0]);
                  resultsAppliedRef.current.add(participantId);
                }
              },
            })
          : physics.throwDice(4, {
              onTransform: (snap) => {
                startedRef.current = true;
                // СМЕЩАЕМ индексы кубиков: session[i] → dice i*4..i*4+3.
                const remappedDice = snap.dice.map((d) => ({
                  ...d,
                  i: d.i + baseIndex,
                }));
                pushSnapshot(bufferRef, { t: snap.t, dice: remappedDice });
              },
              onResult: (res) => {
                if (resultsAppliedRef.current.has(participantId)) return;
                resultsAppliedRef.current.add(participantId);
                clearTimeout(safetyTimeout);
                applyResult(event.id, participantId, res.dice);
              },
              onError: (err) => {
                console.error(`[ServerDiceStage] physics error for ${participantId}:`, err.message);
                if (!resultsAppliedRef.current.has(participantId)) {
                  clearTimeout(safetyTimeout);
                  applyResult(event.id, participantId, [0, 0, 0, 0]);
                  resultsAppliedRef.current.add(participantId);
                }
              },
            }, {
              // sessionId передаём явно — для сетевой синхронизации (phys-${eventId}).
              // Все клиенты (initiator + remote) используют ОДИН sessionId →
              // physics-сервис стримит трансформаты всем через io.emit.
              sessionId: sess.sessionId,
              // multi-session: используем БОЛЬШУЮ арену (вся карта) — кубы летят
              // с разных сторон (near/far) навстречу друг другу.
              ...(arenaHalfW != null ? { arenaHalfW } : {}),
              ...(arenaHalfH != null ? { arenaHalfH } : {}),
              presetId: sess.presetId,
              originSide: sess.originSide,
              ...(sess.originX !== undefined ? { originX: sess.originX } : {}),
            });
        return handle;
      });

      return () => {
        for (const h of handlesRef.current) {
          try { h?.cancel(); } catch {}
        }
        handlesRef.current = [];
      };
    }

    if (!singleAtMount) return;
    // ── SINGLE-SESSION (как раньше) ──
    const { sessionId: pendingSessionId, participantId } = singleAtMount;

    if (thrownSessionIds.has(pendingSessionId)) {
      return;
    }
    thrownSessionIds.add(pendingSessionId);

    resultsAppliedRef.current = new Set();
    startedRef.current = false;

    const safetyTimeout = setTimeout(() => {
      if (!resultsAppliedRef.current.has(participantId)) {
        console.warn('[ServerDiceStage] safety timeout — applying fallback dice');
        applyResult(event.id, participantId, [0, 0, 0, 0]);
        resultsAppliedRef.current.add(participantId);
      }
    }, 8000);

    const isRemoteRoll = !!singleAtMount.isRemote;

    const handle = isRemoteRoll
      ? physics.subscribeToSession(pendingSessionId, {
          onTransform: (snap) => {
            startedRef.current = true;
            getSharedStartedRef().current = true;
            setPhysicsActive(true);
            pushSnapshot(bufferRef, { t: snap.t, dice: snap.dice });
          },
          onResult: (res) => {
            if (resultsAppliedRef.current.has(participantId)) return;
            resultsAppliedRef.current.add(participantId);
            clearTimeout(safetyTimeout);
            applyResult(event.id, participantId, res.dice);
          },
          onError: (err) => {
            console.error('[ServerDiceStage] subscribe error:', err.message);
            if (!resultsAppliedRef.current.has(participantId)) {
              clearTimeout(safetyTimeout);
              applyResult(event.id, participantId, [0, 0, 0, 0]);
              resultsAppliedRef.current.add(participantId);
            }
          },
        })
      : physics.throwDice(4, {
      onTransform: (snap) => {
        startedRef.current = true;
        // Для single-session хост-канвас (DiceCanvasHost) читает SHARED
        // startedRef → синхронизируем его тоже.
        getSharedStartedRef().current = true;
        // ── BRIDGE MODE: сигнализируем HeldDiceController, что physics
        // начал стримить кадры → bridge завершается, liveMode выключается,
        // DieMesh плавно переходит на 110мс интерполяцию. Без этого сигнала
        // bridge продлится 400мс (safety timeout), и мы получим задержку.
        // Только для drag-continuation (есть initialQuats → bridge активен).
        // Для button-throw liveMode уже false (нет bridge) → setPhysicsActive
        // безвредно (HeldDiceController не активен вне drag).
        setPhysicsActive(true);
        pushSnapshot(bufferRef, { t: snap.t, dice: snap.dice });
      },
      onResult: (res) => {
        if (resultsAppliedRef.current.has(participantId)) return;
        resultsAppliedRef.current.add(participantId);
        clearTimeout(safetyTimeout);
        applyResult(event.id, participantId, res.dice);
      },
      onError: (err) => {
        console.error('[ServerDiceStage] physics error:', err.message);
        if (!resultsAppliedRef.current.has(participantId)) {
          clearTimeout(safetyTimeout);
          applyResult(event.id, participantId, [0, 0, 0, 0]);
          resultsAppliedRef.current.add(participantId);
        }
      },
    }, {
      // sessionId передаём явно (phys-${eventId}) — для сетевой синхронизации.
      // Remote-клиенты подпишутся на тот же sessionId через subscribeToSession.
      sessionId: pendingSessionId,
      // single-session: большая арена = вся карта. Кубы спавнятся с near/far
      // края (зависит от originSide из gesture-броска) + латеральный originX.
      // Для кнопка-броска: originSide/originX/direction не передаются → defaults.
      // Для drag-броска (TOKEN-PLACEMENT MODE): spawnX/spawnZ заданы →
      // physics-service ставит стакан В ЭТОЙ ТОЧКЕ арены — кубы появляются
      // ровно под курсором в точке отпускания (как размещение токена).
      // direction (угол) → physics-service вращает импульс на этот угол,
      // кубы слегка отскакивают в сторону жеста (импульс масштабирован 0.30).
      // swingVelocity (px/ms) → physics-service масштабирует импульс от
      // скорости взмаха: медленный отпуск → мягкое падение, быстрый flick
      // → реальный бросок с дугой.
      // initialQuats → ТЕКУЩИЕ ориентации кубиков из 3D-оверлея (in-hand
      //   rotation). Когда заданы, physics-service ПРОПУСКАЕТ фазу
      //   перемешивания (SHAKE_DURATION_MS = 120мс) → бросок бесшовный:
      //   "тащил → отпустил → кубы сразу полетели". Случайность результата
      //   обеспечивается тем, что ориентации случайны (кубы вращались во
      //   время drag).
      ...(effectiveArenaHalfW != null ? { arenaHalfW: effectiveArenaHalfW } : {}),
      ...(effectiveArenaHalfH != null ? { arenaHalfH: effectiveArenaHalfH } : {}),
      presetId: singleAtMount.presetId,
      // Передаём originSide/originX/direction/spawnX/spawnZ/swingVelocity/initialQuats из gesture (если есть).
      ...(singleAtMount.originSide ? { originSide: singleAtMount.originSide } : {}),
      ...(singleAtMount.originX !== undefined ? { originX: singleAtMount.originX } : {}),
      ...(singleAtMount.direction !== undefined ? { direction: singleAtMount.direction } : {}),
      ...(singleAtMount.spawnX !== undefined ? { spawnX: singleAtMount.spawnX } : {}),
      ...(singleAtMount.spawnZ !== undefined ? { spawnZ: singleAtMount.spawnZ } : {}),
      ...(singleAtMount.swingVelocity !== undefined ? { swingVelocity: singleAtMount.swingVelocity } : {}),
      ...(singleAtMount.initialQuats !== undefined && singleAtMount.initialQuats.length > 0
        ? { initialQuats: singleAtMount.initialQuats }
        : {}),
      // initialAngularVelocity (Вариант A) — передаём угловые скорости
      // удерживаемых кубов → physics-service продолжит их вращение.
      ...(singleAtMount.initialAngularVelocity !== undefined && singleAtMount.initialAngularVelocity.length > 0
        ? { initialAngularVelocity: singleAtMount.initialAngularVelocity }
        : {}),
    });
    handlesRef.current = [handle];

    return () => {
      clearTimeout(safetyTimeout);
      try { handle.cancel(); } catch {}
      handlesRef.current = [];
    };
  }, [event.id]);

  // Clean up the module-level guard entry when the result has been applied
  // and the event transitions out of pending. This allows future rolls
  // with new sessionIds to proceed.
  useEffect(() => {
    const hasPending = !!event.pendingPhysics
      || (event.pendingPhysicsSessions && event.pendingPhysicsSessions.length > 0);
    if (!hasPending && thrownSessionIds.size > 0) {
      thrownSessionIds.clear();
      resultsAppliedRef.current = new Set();
    }
  }, [event.pendingPhysics, event.pendingPhysicsSessions]);

  // ── ВАРИАНТ A: single-session НЕ рендерит свой канвас ────────────────
  // Single-session броски рендерятся в ПОСТОЯННОМ канвасе (DiceCanvasHost в
  // MapPanel). ServerDiceStage здесь только кормит общий shared buffer
  // physics-кадрами (onTransform → pushSnapshot в shared buffer). Возврат null
  // → этот компонент "невидим" в React-дереве, но useEffect отработал и
  // физика запущена.
  //
  // MULTI-session (VS/mass) — рендерит СВОЙ отдельный канвас (numDice=N*4) с
  // локальным buffer (как раньше). Постоянный host в это время невидим
  // (shared buffer очищен).
  if (!isMulti) {
    return null;
  }

  // Per-participant dice colors: collect from event participants (stamped by
  // enqueueLiveRoll). Each session = 4 dice, so participantColors[i] applies
  // to dice indices [i*4 .. i*4+3]. Filter out entries without colors —
  // Dice3DPhysicsCanvas falls back to store for missing entries.
  const participantColors = event.participants
    .map((p) => (p.diceColor && p.symbolColor ? { diceColor: p.diceColor, symbolColor: p.symbolColor } : null))
    .filter((c): c is { diceColor: string; symbolColor: string } => c !== null);

  return (
    <Dice3DPhysicsCanvas
      numDice={numDiceTotal}
      bufferRef={bufferRef}
      startedRef={startedRef}
      viewport={viewport}
      // Большая арена = вся карта. Canvas покрывает screen-прямоугольник
      // карты, кубы падают на карту без обрезаний.
      arenaHalfW={effectiveArenaHalfW}
      arenaHalfH={effectiveArenaHalfH}
      mapImageSize={mapImageSize}
      numSessions={numSessionsFixed}
      participantColors={participantColors.length > 0 ? participantColors : undefined}
    />
  );
}
