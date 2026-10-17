'use client';

// ============================================================
// Dice3DPhysicsCanvas — рендер кубиков на основе серверной физики
// ============================================================
//
// В отличие от старого Dice3DCanvas (который сам симулировал физику
// и подменял текстуры), этот компонент ТОЛЬКО рендерит трансформы,
// которые присылает physics-service. Кубик — настоящий Fate d6:
//
//   • 6 граней с ФИКСИРОВАННЫМИ символами:
//       face 0 (+X) и face 1 (-X) → "+" (2 грани)
//       face 2 (+Y) и face 3 (-Y) → "−" (2 грани)
//       face 4 (+Z) и face 5 (-Z) → пусто  (2 грани)
//     Противоположные пары одинаковые → P(+) = P(−) = P(0) = 1/3.
//     Символы назначаются ОДИН РАЗ при создании и НИКОГДА не меняются.
//
//   • Никакой локальной физики. Никакого relabel. Что физика положила
//     вверх — то и видит игрок. Это и есть честный бросок.
//
//   • Snapshot interpolation: входящие трансформы (30 Гц) буферизуются
//     и интерполируются до 60+ fps для плавного рендера. Без этого
//     при сетевом лаге кубики дёргаются.
//
// ПРИВЯЗКА К КАРТЕ: CSS transform на wrapper с pan/zoom — кубы ведут
// себя КАК ТОКЕНЫ (позиция привязана к world-координатам, размер
// масштабируется с zoom). Физический мир (на сервере) — отдельная
// система координат; камера R3F смотрит на арену сверху-сбоку.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows } from '@react-three/drei';
import * as THREE from 'three';
import type { DieTransform } from '@/hooks/use-dice-physics';
import { useFateStore } from '@/lib/store';
import { derivePalette, suggestSymbolShadow } from '@/lib/dice-palette';
import {
  getDragState,
  getLiveMode,
  setLiveMode,
  getPhysicsActive,
  setPhysicsActive,
  consumeBridgeCancel,
  registerHeldDiceController,
  getReturnState,
  clearReturnState,
  type HeldDiceControllerApi,
} from '@/lib/held-dice-bus';

// ── Параметры рендера ────────────────────────────────────────
// Уменьшенные кубики: DIE_SIZE 0.28 — компактнее, хорошо видны на фоне
// карты, не доминируют. Сервер DIE_HALF=0.22 (side=0.44) — визуальный
// рендер чуть меньше физического коллайдера, что нормально (кубы выглядят
// аккуратнее, физика остаётся стабильной).
const DIE_SIZE = 0.28;       // сторона кубика (визуальный рендер)
const DIE_RADIUS = 0.032;    // скругление рёбер
const FACE_SIZE = 256;       // разрешение текстуры грани

// ── Размер арены (динамический, прямоугольный) ──
// Дефолт — 4.0 (квадрат, как на сервере). Реальные значения передаются через
// props arenaHalfW (X) и arenaHalfH (Z) и должны совпадать с тем, что клиент
// отправил в dice:roll. Камера и позиционирование канваса адаптируются под
// эти размеры. Прямоугольная арена → соотношение сторон арены =
// соотношению сторон изображения карты.
//
// ВАЖНО: визуальных бортиков НЕТ — они выглядели как «мешанина».
// Физические стены (невидимые, непреодолимые) живут на сервере
// (physics-service: WALL_HEIGHT=1.1, WALL_THICKNESS=1.0, на ±AHW/±AHH).
// Кубики отскакивают от невидимых стен и остаются внутри контура карты.
const DEFAULT_ARENA_HALF = 4.0;

// ── Палитра (насыщенный ярко-синий пластик) — fallback по умолчанию ──
// Реальные цвета приходят из store (diceColor, symbolColor) и передаются
// в makeFaceTexture как параметры.
const DEFAULT_BLUE_TOP = '#2196f3';
const DEFAULT_BLUE_MID = '#1976d2';
const DEFAULT_BLUE_BOTTOM = '#0d47a1';
const DEFAULT_SYMBOL_COLOR = '#ffffff';
const DEFAULT_SYMBOL_SHADOW = 'rgba(0, 10, 40, 0.55)';

// ── Палитра обводки рёбер для одновременных бросков ──
// Каждый «слот участника» (0=ролик, 1=оппонент, 2+=третий и т.д.) получает
// свой контрастный цвет. Цвета выбраны так, чтобы быть ЧЁТКО различимыми
// на фоне синих кубиков и карты:
//   slot 0 — тёплый жёлто-зелёный (#9eff5e) — «свой», ассоциируется с +/успехом
//   slot 1 — горячий розово-красный (#ff4d6d) — «враг», тревожный
//   slot 2 — оранжевый (#ff8c42) — нейтральный третий
//   slot 3 — бирюзовый (#00d4d4) — холодный нейтральный
// При броске 4×4 (VS) ролик видит СВОИ кубики с зелёной обводкой, оппонент —
// с розовой. Легко отличить даже когда кубики перемешались на столе.
const DICE_OUTLINE_COLORS: string[] = [
  '#9eff5e',  // slot 0 — ролик (зелёный)
  '#ff4d6d',  // slot 1 — оппонент (розово-красный)
  '#ff8c42',  // slot 2 — третий участник (оранжевый)
  '#00d4d4',  // slot 3 — четвёртый (бирюзовый)
];

// Вычислить цвет обводки для кубика с индексом `dieIndex` при `numSessions`
// активных участниках. Возвращает null если участник один (одиночный бросок
// — обводка не нужна). Индекс кубика маппится на слот участника через
// DICE_PER_SESSION (4 кубика на участника).
export function getOutlineColorForDie(dieIndex: number, numSessions: number): string | null {
  if (numSessions <= 1) return null;
  const slot = Math.floor(dieIndex / 4);
  return DICE_OUTLINE_COLORS[slot % DICE_OUTLINE_COLORS.length] ?? null;
}

// Позиция "руки" — где кубики появляются до/во время перемешивания (невидимые
// до первого снапшота, scale 0). Соответствует серверной HAND_Y / HAND_Z_FACTOR:
// ближний край (+Z = низ экрана = сторона игрока), высота руки над столом.
// При arenaHalf=4.0 → [0, 0.95, 2.48].
export const DEFAULT_CASE_POSITION: [number, number, number] = [0, 0.95, 2.48];

// Вычислить позицию "руки" под размер арены. Z пропорционален arenaHalfH
// (ближний край), Y = высота руки (константа).
function casePosForArena(arenaHalfH: number): [number, number, number] {
  const k = arenaHalfH / DEFAULT_ARENA_HALF;
  return [0, 0.95, 2.48 * k];
}

// ── Вычислить 3D-цель "возврата в кейс" по РЕАЛЬНОЙ позиции DiceStation ──
// DiceStation (кейс с кубами) живёт в левом сайдбаре (ScenePanel) — ВНЕ
// 3D-канваса. Раньше return-to-case анимация использовала casePosForArena
// (нижний центр арены = позиция "руки"), и кубы "прыгали" в нижнюю часть
// карты вместо кейса. Эта функция находит DOM-элемент .fate-dice-station__tray,
// берёт его центр в screen-координатах, переводит в NDC относительно
// 3D-канваса (NDC будет вне [-1,1] т.к. кейс ВНЕ канваса — это нормально),
// и рейкастит луч от камеры через эту точку на плоскость y=HELD_DIE_Y.
// Результат — 3D-точка ВНЕ арены (слева от неё), куда кубы и должны лететь.
//
// Fallback: если элемент не найден (панель закрыта / рендер ещё не готов) —
// цель = левый край арены с запасом (кубы улетят за левый борт).
function computeCaseTarget(
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  arenaHalfW: number,
  arenaHalfH: number,
): [number, number, number] {
  const canvasRect = canvas.getBoundingClientRect();
  // Fallback: левый край арены (кейс в левом сайдбаре).
  const fallback: [number, number, number] = [
    -arenaHalfW - 1.5, HELD_DIE_Y, arenaHalfH * 0.4,
  ];
  if (canvasRect.width === 0 || canvasRect.height === 0) return fallback;
  const tray = document.querySelector('.fate-dice-station__tray') as HTMLElement | null;
  if (!tray) return fallback;
  const trayRect = tray.getBoundingClientRect();
  if (trayRect.width === 0 || trayRect.height === 0) return fallback;
  // Центр кейса в client-координатах.
  const cx = trayRect.left + trayRect.width / 2;
  const cy = trayRect.top + trayRect.height / 2;
  // NDC относительно 3D-канваса. Кейс ВНЕ канваса → NDC вне [-1,1] — это ОК,
  // raycaster работает с любыми NDC (луч просто уходит за пределыViewport).
  const ndcX = ((cx - canvasRect.left) / canvasRect.width) * 2 - 1;
  const ndcY = -(((cy - canvasRect.top) / canvasRect.height) * 2 - 1);
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  // Плоскость на высоте покоя кубика (y=HELD_DIE_Y). normal=(0,1,0),
  // constant=-HELD_DIE_Y (т.к. y + constant = 0 → y = HELD_DIE_Y).
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -HELD_DIE_Y);
  const hit = new THREE.Vector3();
  if (!rc.ray.intersectPlane(plane, hit)) return fallback;
  return [hit.x, HELD_DIE_Y, hit.z];
}

// FOV камеры — 42° (было 55°). Уже → арена заполняет бóльшую часть кадра
// (бортики видны крупно, а не как мелкая фигня в центре). Вместе с
// top-down позиционированием камеры это даёт чистый прямоугольный вид.
const CAMERA_FOV = 42;

export interface DiceViewport {
  panX: number;
  panY: number;
  zoom: number;
}

// ── Canvas-рисование текстур (переиспользуется из старого компонента) ──

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

function drawPlus(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, thickness: number) {
  const r = thickness / 2;
  roundedRectPath(ctx, cx - size / 2, cy - thickness / 2, size, thickness, r);
  ctx.fill();
  roundedRectPath(ctx, cx - thickness / 2, cy - size / 2, thickness, size, r);
  ctx.fill();
}

function drawMinus(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number, thickness: number) {
  const r = thickness / 2;
  roundedRectPath(ctx, cx - size / 2, cy - thickness / 2, size, thickness, r);
  ctx.fill();
}

function makeFaceTexture(
  symbol: '+' | '-' | null,
  diceColor: string,
  symbolColor: string,
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = FACE_SIZE;
  canvas.height = FACE_SIZE;
  const ctx = canvas.getContext('2d')!;

  // Палитра градиента тела куба — вычисляется из diceColor.
  const pal = derivePalette(diceColor);

  // Диагональный градиент
  const grad = ctx.createLinearGradient(0, 0, FACE_SIZE, FACE_SIZE);
  grad.addColorStop(0, pal.top);
  grad.addColorStop(0.5, pal.mid);
  grad.addColorStop(1, pal.bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);

  // Виньетка
  const vignette = ctx.createRadialGradient(
    FACE_SIZE / 2, FACE_SIZE / 2, FACE_SIZE * 0.35,
    FACE_SIZE / 2, FACE_SIZE / 2, FACE_SIZE * 0.72
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);

  // Символ
  if (symbol) {
    const cx = FACE_SIZE / 2;
    const cy = FACE_SIZE / 2;
    const symbolSize = FACE_SIZE * 0.62;
    const thickness = FACE_SIZE * 0.18;

    const shadowColor = suggestSymbolShadow(diceColor);

    ctx.save();
    ctx.fillStyle = shadowColor;
    if (symbol === '+') drawPlus(ctx, cx + 4, cy + 5, symbolSize, thickness);
    else if (symbol === '-') drawMinus(ctx, cx + 4, cy + 5, symbolSize, thickness);
    ctx.restore();

    ctx.fillStyle = symbolColor;
    if (symbol === '+') drawPlus(ctx, cx, cy, symbolSize, thickness);
    else if (symbol === '-') drawMinus(ctx, cx, cy, symbolSize, thickness);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

// Кэш текстур (лимит 24 — 8 комбинаций цветов × 3 символов)
const textureCache = new Map<string, THREE.CanvasTexture>();
const TEXTURE_CACHE_MAX = 24;
function getFaceTexture(
  symbol: '+' | '-' | null,
  diceColor: string = DEFAULT_BLUE_MID,
  symbolColor: string = DEFAULT_SYMBOL_COLOR,
): THREE.CanvasTexture {
  const key = `${symbol ?? 'blank'}|${diceColor.toLowerCase()}|${symbolColor.toLowerCase()}`;
  let tex = textureCache.get(key);
  if (!tex) {
    tex = makeFaceTexture(symbol, diceColor, symbolColor);
    textureCache.set(key, tex);
    if (textureCache.size > TEXTURE_CACHE_MAX) {
      const firstKey = textureCache.keys().next().value;
      if (firstKey) {
        const old = textureCache.get(firstKey);
        old?.dispose();
        textureCache.delete(firstKey);
      }
    }
  }
  return tex;
}

// ── ФИКСИРОВАННОЕ распределение символов по 6 граням ──
// Порядок BoxGeometry: 0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z
// Противоположные пары (0/1, 2/3, 4/5) имеют ОДИНАКОВЫЕ символы.
// Это даёт правильное распределение Fate: 2×+, 2×−, 2×пусто → 1/3 каждый.
const FATE_FACE_SYMBOLS: Array<'+' | '-' | null> = [
  '+', '+',     // 0=+X, 1=-X
  '-', '-',     // 2=+Y, 3=-Y
  null, null,   // 4=+Z, 5=-Z
];

// ── RoundedBoxGeometry (упрощённая версия) ──
function makeRoundedBoxGeometry(size: number, radius: number, segments: number): THREE.BufferGeometry {
  // Скругляем BoxGeometry, отодвигая вершины возле углов к сферической поверхности.
  // Сохраняет 6 групп материала (по одной на грань) — важно для назначения символов.
  const geo = new THREE.BoxGeometry(size, size, size, segments, segments, segments);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const v = new THREE.Vector3();
  const inner = size / 2 - radius;
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const cx = Math.sign(v.x) * Math.min(Math.abs(v.x), inner);
    const cy = Math.sign(v.y) * Math.min(Math.abs(v.y), inner);
    const cz = Math.sign(v.z) * Math.min(Math.abs(v.z), inner);
    const dx = v.x - cx;
    const dy = v.y - cy;
    const dz = v.z - cz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > radius) {
      const s = radius / dist;
      pos.setXYZ(i, cx + dx * s, cy + dy * s, cz + dz * s);
    }
  }
  geo.computeVertexNormals();
  return geo;
}

// ── Snapshot interpolation ──────────────────────────────────
// Буфер последних N снапшотов. useFrame интерполирует между двумя
// ближайшими к "render time" (текущее время - RENDER_DELAY_MS).
//
// ВАЖНО: RENDER_DELAY_MS=110 (было 80) — больший буфер сглаживания.
// Серверный event loop может иметь микро-лаги (GC, socket flush), из-за
// которых 30Hz поток снапшотов получает "дыры" до 60-90мс. При 80мс delay
// буфер истощался → кубики "прилипали" к последней позиции и дёргались.
// 110мс delay даёт ~3.3 снапшота запаса — достаточно чтобы пережить
// кратковременные лаги без видимых артефактов. 110мс = ~6.6 кадров при
// 60fps — всё ещё ощущается "живым", не лагающим.
const RENDER_DELAY_MS = 110;  // рендерим 110мс в прошлом — скрывает джиттер сервера
// v3l: 20 → 40. Сервер теперь стримит 60Hz (было 30Hz). 20 кадров при 60Hz =
// только 333мс истории — слишком мало для RENDER_DELAY_MS=110 + интерполяции.
// 40 кадров = 666мс — тот же запас что был при 30Hz/20.
const MAX_BUFFER_SIZE = 40;   // ~666мс истории при 60Hz — запас на лаги

interface SnapshotFrame {
  t: number;  // server time (ms)
  transforms: Map<number, DieTransform>;  // die index → transform
}

// ── DieMesh — один кубик с интерполяцией ──

interface DieMeshProps {
  index: number;
  bufferRef: React.MutableRefObject<SnapshotFrame[]>;
  casePosition: [number, number, number];
  startedRef: React.MutableRefObject<boolean>;
  // Цвет обводки рёбер. Если не передан — обводка не рисуется (одиночный бросок).
  // Используется для VS/одновременных бросков: кубики ролика — один цвет,
  // кубики оппонента — другой. Цвета назначаются по «слоту участника»
  // (roll-stage-overlay → ServerDiceStage → Dice3DPhysicsCanvas → DieMesh).
  outlineColor?: string | null;
  // ── Визуальный масштаб кубика ──
  // По умолчанию 1.0 (кубик DIE_SIZE=0.28 физ. единиц). Для маленькой арены
  // (drag-and-drop бросок) передаём бóльшее значение (1.8), чтобы кубики
  // выглядели КРУПНО на маленьком canvas (192×132px). Без этого кубы занимают
  // лишь ~10px на экране — слишком мелко. Масштаб применяется через
  // mesh.scale (геометрия остаётся прежней, меняется только визуальный размер).
  dieScale?: number;
  // ── Арена (для ghost-dice рендеринга) ──
  // Используется DieMesh для index >= 4 (ghost-dice) для вычисления 3D-цели
  // "возврата в кейс" через raycast screen→world (computeCaseTarget).
  arenaHalfW?: number;
  arenaHalfH?: number;
  // ── Количество участников в одновременном броске ──
  // 1 (или отсутствует) = одиночный бросок. В этом случае indices 4-7 — это
  // GHOST-кубы для анимации возврата старых кубов в кейс (рендерятся из
  // returnState, не из buffer).
  // >1 = VS/массовый бросок. В этом случае ALL indices (0-7) — LIVE-кубы
  // (session 0 → 0-3, session 1 → 4-7). Все рендерятся из buffer. Ghost
  // анимация для multi-session НЕ запускается (см. server-dice-stage.tsx).
  numSessions?: number;
  /** Per-participant dice body color (mass rolls). Falls back to store. */
  diceColor?: string;
  /** Per-participant symbol color (mass rolls). Falls back to store. */
  symbolColor?: string;
}

// ── GHOST-DICE ANIMATION STATE (module-level cache) ────────────────────────
// ВАЖНО: ghost-dice (indices 4-7) рендерятся НАПРЯМУЮ из returnState, БЕЗ
// прохода через buffer. Раньше HeldDiceController пушал ghost-кадры (только 4-7)
// в buffer с t=client-now, а физика пушала live-кадры (только 0-3) с t=server-t.
// Из-за сетевой задержки t различались на ~30-50ms > порог merge 16ms →
// в buffer появлялись ОТДЕЛЬНЫЕ кадры: один с 0-3, другой с 4-7. DieMesh
// для 0-3 видел кадр только с 4-7 → mesh.visible=false → КУБЫ ИСЧЕЗАЛИ.
// DieMesh для 4-7 видел кадр только с 0-3 → mesh.visible=false → ПРИЗРАКИ
// ИСЧЕЗАЛИ. Это и было причиной багов "призрачные кубы" и "исчезновение кубов".
//
// ТЕПЕРЬ: returnState хранит позиции+кватернионы старых кубов. DieMesh для
// index >= 4 читает returnState каждый кадр и рендерит ghost-кубы НАПРЯМУЮ
// (position arc + spin from startQuat). Buffer не трогается — физика льёт
// туда только live-кадры (0-3). Никакой race condition.
//
// Этот кэш инициализируется ОДИН раз при старте анимации (первый DieMesh с
// index >= 4, увидевший returnState) и очищается при завершении (progress >= 1).
// Хранит:
//   caseTarget — 3D-цель "возврата в кейс" (raycast от DOM .fate-dice-station__tray).
//   spins — 4 оси+скорости для ghost-кубов (fixed at init, как было в HeldDiceController).
//   quats — 4 стартовых кватерниона (captured из returnState.quats).
//   startTime — timestamp старта (для проверки что кэш соответствует текущему returnState).
interface GhostAnimState {
  caseTarget: [number, number, number];
  spins: Array<{ axis: THREE.Vector3; speed: number }>;
  quats: Array<THREE.Quaternion>;
  startTime: number;
}

let _ghostAnimState: GhostAnimState | null = null;

function clearGhostAnimState(): void {
  _ghostAnimState = null;
}

/**
 * Получить (или инициализировать) ghost animation state для текущего returnState.
 * Идиомптентно: если кэш уже соответствует текущему returnState (по startTime),
 * возвращаем существующий. Иначе инициализируем заново.
 *
 * ВАЖНО: вычисление caseTarget (raycast) делается ОДИН раз на анимацию —
 * это дорогая операция (querySelector + raycast). Кешируем результат.
 */
function getOrCreateGhostAnimState(
  returnState: NonNullable<ReturnType<typeof getReturnState>>,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  arenaHalfW: number,
  arenaHalfH: number,
): GhostAnimState {
  if (_ghostAnimState && _ghostAnimState.startTime === returnState.startTime) {
    return _ghostAnimState;
  }
  // Вычисляем 3D-цель "возврата в кейс" (DiceStation в левом сайдбаре).
  const caseTarget = computeCaseTarget(camera, canvas, arenaHalfW, arenaHalfH);
  // 4 оси+скорости для ghost-кубов (fixed на всю анимацию).
  const spins = Array.from({ length: LIVE_DICE_COUNT }, () => {
    let ax = (Math.random() - 0.5) * 2;
    let ay = (Math.random() - 0.5) * 2;
    let az = (Math.random() - 0.5) * 2;
    const alen = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    ax /= alen; ay /= alen; az /= alen;
    return {
      axis: new THREE.Vector3(ax, ay, az),
      speed: 12 + Math.random() * 8,  // 12-20 рад/с — быстрее held (как было)
    };
  });
  // Стартовые кватернионы из returnState.
  const quats = returnState.quats.map((q) => new THREE.Quaternion(q[0], q[1], q[2], q[3]));
  _ghostAnimState = { caseTarget, spins, quats, startTime: returnState.startTime };
  return _ghostAnimState;
}

function DieMesh({ index, bufferRef, casePosition, startedRef, outlineColor, dieScale = 1, arenaHalfW = DEFAULT_ARENA_HALF, arenaHalfH = DEFAULT_ARENA_HALF, numSessions = 1, diceColor: diceColorProp, symbolColor: symbolColorProp }: DieMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null!);
  // Camera + gl for ghost-dice rendering (needed for computeCaseTarget raycast).
  // useThree() — cheap hook, doesn't cause re-render (returns stable refs).
  const { camera, gl } = useThree();

  // ── Кастомизация: цвет тела куба и символа ──
  // Priority: explicit prop (per-participant, mass rolls) → store (viewer's own).
  const storeDiceColor = useFateStore((s) => s.diceColor);
  const storeSymbolColor = useFateStore((s) => s.symbolColor);
  const diceColor = diceColorProp ?? storeDiceColor;
  const symbolColor = symbolColorProp ?? storeSymbolColor;

  // Материалы — 6 граней с фиксированными символами. Создаются ОДИН РАЗ
  // на комбинацию цветов. При смене цвета — пересоздаются (useMemo dep).
  // Никакого relabel, никакого needsUpdate после создания.
  const materials = useMemo<THREE.MeshStandardMaterial[]>(() => {
    return FATE_FACE_SYMBOLS.map((sym) => new THREE.MeshStandardMaterial({
      map: getFaceTexture(sym, diceColor, symbolColor),
      color: '#ffffff',
      roughness: 0.96,
      metalness: 0.0,
    }));
  }, [diceColor, symbolColor]);

  const geometry = useMemo(
    () => makeRoundedBoxGeometry(DIE_SIZE, DIE_RADIUS, 4),
    []
  );

  // ── EdgesGeometry: проволочная обводка рёбер куба ──
  // Создаётся из «острой» BoxGeometry (без скругления) с thresholdAngle=1°
  // → выделяются ТОЛЬКО 12 рёбер куба (грани под 90°). Скруглённая
  // geometry тут не подходит — дала бы «клубок» из микро-рёбер.
  // EdgesGeometry — это LineSegments, рендерится поверх меша без записи
  // в depth buffer → всегда видна поверх граней (x-ray). Толщина линии
  // через LineBasicMaterial.linewidth (WebGL игнорирует >1, но цвет и
  // opacity работают). Эффект: яркая цветная каёмка по рёбрам кубика.
  const edgesGeometry = useMemo(() => {
    const boxGeo = new THREE.BoxGeometry(DIE_SIZE, DIE_SIZE, DIE_SIZE);
    const edges = new THREE.EdgesGeometry(boxGeo, 1);
    boxGeo.dispose();
    return edges;
  }, []);

  const outlineMaterial = useMemo(() => {
    if (!outlineColor) return null;
    return new THREE.LineBasicMaterial({
      color: outlineColor,
      transparent: true,
      opacity: 0.95,
      depthTest: true,
      depthWrite: false,
    });
  }, [outlineColor]);

  useEffect(() => () => {
    materials.forEach((m) => m.dispose());
    geometry.dispose();
    edgesGeometry.dispose();
    outlineMaterial?.dispose();
  }, [materials, geometry, edgesGeometry, outlineMaterial]);

  // Временные векторы (переиспользуем, чтобы не создавать мусор в useFrame)
  const tmpPos = useMemo(() => new THREE.Vector3(), []);
  const tmpQuat = useMemo(() => new THREE.Quaternion(), []);
  const tmpQuatA = useMemo(() => new THREE.Quaternion(), []);
  const tmpQuatB = useMemo(() => new THREE.Quaternion(), []);
  // Временные кватернионы для ghost-dice рендеринга (index >= 4).
  const tmpQuatForGhost = useMemo(() => new THREE.Quaternion(), []);
  const tmpQuatAForGhost = useMemo(() => new THREE.Quaternion(), []);

  // ── НЕВИДИМ до первого снапшота, затем ПОЯВЛЯЕТСЯ СРАЗУ КРУТЯЩИМСЯ ──
  // Раньше кубик стоял ВИДИМЫМ в casePosition (y=0.95, над столом у нижнего
  // края экрана) и ждал первый снапшот (~50мс socket latency). Когда снапшот
  // приходил — кость "прыгала" вниз на y=0.25 (спавн-позиция на полу).
  // Этот вертикальный скачок (0.95 → 0.25, ~0.7 единиц) воспринимался
  // пользователем как "выезжают откуда-то из-за края экрана, висят".
  //
  // Затем была добавлена pop-in анимация (scale 0→1 за 120мс) — но она
  // МАСКИРОВАЛА вращение: кубик "вырастал" вместо того, чтобы "вкручиваться"
  // в кадр. Пользователь просил: "кубы появлялись уже крутящимися".
  //
  // ТЕПЕРЬ: кубик НЕВИДИМ (scale=0) пока буфер пуст (~50мс socket latency,
  // незаметно). Когда первый снапшот приходит — кость СРАЗУ появляется на
  // своей спавн-позиции в ПОЛНОМ масштабе (scale=1, без pop-in), уже
  // повёрнутой (acc=STEP на сервере + spin 32-54 рад/с = ~1-1.8 рад за
  // первый шаг). Со следующего кадра (33мс) интерполяция между снапшотами
  // показывает ЯВНОЕ вращение — кубик "вкручивается" в кадр уже крутящимся.
  // Никакого "выезжают", никакого "висят", никакого "потом крутятся".

  // Initial state — НЕВИДИМЫЙ (visible=false). Position не важен (невидим).
  //
  // ── ПОЧЕМУ visible=false, а НЕ scale=0 ──
  // Раньше тут был scale=0 ("невидимый до первого снапшота"). Но scale=0
  // ВСЁ РАВНО рендерит меш (просто нулевого размера). При race condition
  // (React mount → R3F первый useFrame ДО useEffect React) меш на 1 кадр
  // мог быть виден с default scale=1 в casePosition (ближний край арены).
  // На быстрой машине это незаметно (~16мс), но на медленной или при
  // WebGL Context Lost восстановление могло показать "призрак" куба.
  //
  // visible=false ПОЛНОСТЬЮ исключает меш из рендера (three.js skip'ает
  // object в render loop). Никакого "призрака", никакого race condition.
  // visible=true ставится в useFrame ТОЛЬКО когда есть валидный снапшот.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.position.set(casePosition[0], casePosition[1], casePosition[2]);
    mesh.scale.setScalar(1);    // полный масштаб (видимостью управляет visible)
    mesh.visible = false;       // НЕВИДИМ до первого снапшота
  }, [casePosition]);

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    // state/delta не используются после удаления pop-in, но сохранены в
    // сигнатуре useFrame (R3F передаёт их всегда). Lint допускает unused
    // params в callback-сигнатурах (no-unused-vars с args: 'after-used').

    // ── GHOST-DICE (indices 4-7): render DIRECTLY from returnState ──────
    // ВАЖНО: ghost-dice НЕ читают buffer. Раньше они пушились туда отдельными
    // кадрами (только 4-7) с t=client-now, а физика пушала live-кадры (только
    // 0-3) с t=server-t. Из-за сетевой задержки t различались >16ms → в buffer
    // были ОТДЕЛЬНЫЕ кадры (один с 0-3, другой с 4-7) → DieMesh для 0-3 видел
    // кадр с 4-7 → КУБЫ ИСЧЕЗАЛИ. DieMesh для 4-7 видел кадр с 0-3 → ПРИЗРАКИ
    // ИСЧЕЗАЛИ. Это и было причиной багов "призрачные кубы" и "исчезновение кубов".
    //
    // ТЕПЕРЬ: ghost-dice читают returnState напрямую, рендерят позицию (arc
    // интерполяция к caseTarget) и вращение (startQuat * axisAngle(axis, speed*elapsed)).
    // Buffer не трогается — физика льёт туда ТОЛЬКО live-кадры (0-3). Никакой
    // race condition, никаких отдельных кадров с половиной кубов.
    //
    // ТОЛЬКО для single-session (numSessions <= 1). Для multi-session (VS/mass)
    // indices 4-7 — это LIVE-кубы session 1, они рендерятся из buffer как обычно.
    // Ghost анимация для multi-session НЕ запускается (см. server-dice-stage.tsx).
    if (index >= 4 && numSessions <= 1) {
      const rs = getReturnState();
      if (!rs) {
        mesh.visible = false;
        return;
      }
      const elapsed = Date.now() - rs.startTime;
      const progress = Math.min(1, elapsed / rs.duration);
      if (progress >= 1) {
        // Анимация завершена. Ghost-dice больше не рендерятся.
        mesh.visible = false;
        // Очистка returnState + ghost cache — только один раз (index 4).
        // Другие ghost-dice (5,6,7) увидят rs=null на следующем кадре.
        if (index === 4) {
          clearReturnState();
          clearGhostAnimState();
        }
        return;
      }
      // Инициализация/получение ghost animation state (caseTarget + spins + quats).
      const ghostState = getOrCreateGhostAnimState(
        rs, camera, gl.domElement as HTMLCanvasElement, arenaHalfW, arenaHalfH,
      );
      const i = index - 4;  // 0..3 → позиция в массивах ghost
      // Easing: ease-in-out (как было в HeldDiceController).
      const eased = progress < 0.5
        ? 2 * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      // Position: lerp start → caseTarget (2×2 grid) + arc (parabola).
      const col = i % 2;
      const row = Math.floor(i / 2);
      const targetX = ghostState.caseTarget[0] + (col - 0.5) * CASE_GRID_STEP;
      const targetZ = ghostState.caseTarget[2] + (row - 0.5) * CASE_GRID_STEP;
      const targetY = ghostState.caseTarget[1];
      const start = rs.positions[i];
      const x = THREE.MathUtils.lerp(start[0], targetX, eased);
      const z = THREE.MathUtils.lerp(start[2], targetZ, eased);
      const y = THREE.MathUtils.lerp(start[1], targetY, eased)
        + Math.sin(progress * Math.PI) * RETURN_ARC_HEIGHT;
      // Rotation: startQuat * axisAngle(axis, speed * elapsed).
      // Эквивалентно accumulated premultiply (q0 * Δq * Δq * ... = q0 * Δq_total),
      // но чисто (без состояния) — можно вычислять в любом порядке.
      const ghostQ = ghostState.quats[i];
      const spin = ghostState.spins[i];
      const spinAngle = spin.speed * (elapsed / 1000);
      const deltaQ = tmpQuatForGhost.setFromAxisAngle(spin.axis, spinAngle);
      tmpQuatAForGhost.copy(ghostQ).multiply(deltaQ);
      tmpQuatAForGhost.normalize();
      // Scale: shrink after 0.6 (как было — "втягивание" в кейс).
      let scale = 1;
      if (progress > 0.6) {
        const t = (progress - 0.6) / 0.4;
        scale = 1 - t * t * 0.85;  // 1.0 → 0.15
      }
      mesh.position.set(x, y, z);
      mesh.quaternion.copy(tmpQuatAForGhost);
      mesh.scale.setScalar(scale * dieScale);
      mesh.visible = true;
      return;
    }

    // ── LIVE-DICE (indices 0-3): render from buffer (как раньше) ──────
    const buffer = bufferRef.current;
    if (buffer.length === 0) {
      // Нет трансформов — кубик НЕВИДИМ. Ждём первый снапшот.
      mesh.visible = false;
      return;
    }

    // ── СРАЗУ ПОЛНЫЙ МАСШТАБ — без pop-in анимации ──
    // Кубик появляется в полном масштабе (scale=1) с первого кадра.
    // Вращение видно сразу: первый снапшот уже содержит поворот от acc=STEP
    // на сервере, второй (через 33мс) — дополнительный поворот на ~1-1.8 рад.
    // Интерполяция между ними даёт ЯВНОЕ вращение с первого кадра.
    mesh.visible = true;
    // ── GHOST-DICE SHRINK: кубы уменьшаются при "входе" в кейс ──
    // Ghost-dice (indices 4-7) — старые кубы, анимируемые возвратом в кейс.
    // В последней трети анимации (progress 0.6→1.0) они сжимаются с 1 до 0.15,
    // создавая иллюзию "запрыгивания" в кейс (куб становится меньше и
    // "исчезает" в кейсе, который находится ВНЕ 3D-канваса). Для live-dice
    // (indices 0-3) shrink = 1 всегда — их масштаб не меняется.
    let targetScale = 1;
    if (index >= 4) {
      const rs = getReturnState();
      if (rs) {
        const elapsed = Date.now() - rs.startTime;
        const progress = Math.min(1, elapsed / rs.duration);
        if (progress > 0.6) {
          // ease-in: медленно в начале сжатия, быстро в конце (куб "втягивается").
          const t = (progress - 0.6) / 0.4;
          targetScale = 1 - t * t * 0.85;  // 1.0 → 0.15
        }
      }
    }

    // ── ADAPTIVE RENDER DELAY ──
    // Полный RENDER_DELAY_MS (110мс) нужен для сглаживания сетевого джиттера:
    // буфер должен содержать кадры «по обе стороны» от renderTime для
    // интерполяции. Но в САМОМ НАЧАЛЕ броска (buffer.length <= 2) буфер
    // слишком тонкий — 110мс задержки означает, что renderTime ОПЕРЕЖАЕТ
    // все доступные кадры → кубики snap-ятся к первому кадру и визуально
    // «стоят» ~110мс, пока не накопится достаточно истории. Это и есть
    // «мёртвое время» в начале броска.
    //
    // Решение: пока буфер молодой (≤2 кадров), используем МАЛУЮ задержку
    // (30мс) — кубики начинают двигаться почти сразу, как приходит первый
    // снапшот. Как только буфер заполняется (>2 кадров) — возвращаемся к
    // 110мс для стабильной интерполяции. 30мс < typical 33мс snapshot
    // interval → в начале всегда будет snap, но это лучше «зависания».
    //
    // ── LIVE MODE (held-dice, Вариант A) ──
    // Когда игрок ДЕРЖИТ кубы мышкой (drag активен), HeldDiceController
    // пушит кадры локально (60fps, t=now). 110мс задержка = 110мс лаг
    // курсора → неприемлемо. getLiveMode()=true → renderDelay=0 →
    // рендерим ПОСЛЕДНИЙ кадр сразу, кубы следуют за курсором без лага.
    // Когда drag заканчивается и physics-service стримит — liveMode=false
    // → возвращаемся к адаптивной/110мс интерполяции (плавная физика).
    const liveMode = getLiveMode();
    const renderDelay = liveMode ? 0 : (buffer.length <= 2 ? 30 : RENDER_DELAY_MS);
    const renderTime = Date.now() - renderDelay;

    // Найти два соседних кадра: frameA.t <= renderTime < frameB.t
    // Идём от старых к новым. Если ВСЕ кадры в будущем (renderTime раньше
    // всех) — frameA=null, frameB=самый ранний (ближайший к renderTime).
    // Раньше тут был баг: при всех-будущих кадрах frameB = НОВЕЙШИЙ кадр
    // (buffer[length-1]) вместо самого раннего → кубик "прыгал вперёд".
    let frameA: SnapshotFrame | null = null;
    let frameB: SnapshotFrame | null = null;
    for (let i = 0; i < buffer.length; i++) {
      if (buffer[i].t <= renderTime) {
        frameA = buffer[i];
        frameB = buffer[i + 1] ?? null;
      } else {
        // Первый кадр с t > renderTime — это frameB
        if (!frameB) frameB = buffer[i];
        break;
      }
    }

    // Если есть только frameB (renderTime < самого раннего кадра) — snap к нему
    if (!frameA && frameB) {
      const tr = frameB.transforms.get(index);
      if (tr) {
        tmpPos.set(tr.p[0], tr.p[1], tr.p[2]);
        tmpQuat.set(tr.q[0], tr.q[1], tr.q[2], tr.q[3]);
        mesh.position.copy(tmpPos);
        mesh.quaternion.copy(tmpQuat);
        mesh.scale.setScalar(targetScale);
        mesh.visible = true;
      } else {
        // Этого index'а нет в кадре → кубик НЕ ВИДИМ.
        // ВАЖНО для ghost-dice (indices 4-7): когда анимация возврата завершена
        // и эти index'ы больше не пушатся в buffer, DieMesh должен СКРЫТЬ их.
        // Без этого фикса кубики "зависали" на последней позиции (case position)
        // и не исчезали.
        mesh.visible = false;
      }
      return;
    }

    if (!frameA) return;

    const trA = frameA.transforms.get(index);
    if (!trA) {
      // Index'а нет в кадре → кубик НЕ ВИДИМ (ghost-dice после анимации).
      mesh.visible = false;
      return;
    }

    // Если нет frameB (последний кадр в буфере) — snap к A
    if (!frameB) {
      const tr = frameA.transforms.get(index);
      if (tr) {
        tmpPos.set(tr.p[0], tr.p[1], tr.p[2]);
        tmpQuat.set(tr.q[0], tr.q[1], tr.q[2], tr.q[3]);
        mesh.position.copy(tmpPos);
        mesh.quaternion.copy(tmpQuat);
        mesh.scale.setScalar(targetScale);
        mesh.visible = true;
      } else {
        mesh.visible = false;
      }
      return;
    }

    const trB = frameB.transforms.get(index);
    if (!trB) {
      // B не имеет этого die → кубик исчезает (переходная frameset граница)
      mesh.visible = false;
      return;
    }

    // Линейная интерполяция позиции
    const span = Math.max(1, frameB.t - frameA.t);
    const t = THREE.MathUtils.clamp((renderTime - frameA.t) / span, 0, 1);
    tmpPos.set(
      THREE.MathUtils.lerp(trA.p[0], trB.p[0], t),
      THREE.MathUtils.lerp(trA.p[1], trB.p[1], t),
      THREE.MathUtils.lerp(trA.p[2], trB.p[2], t),
    );
    // Сферическая интерполяция кватерниона
    tmpQuatA.set(trA.q[0], trA.q[1], trA.q[2], trA.q[3]);
    tmpQuatB.set(trB.q[0], trB.q[1], trB.q[2], trB.q[3]);
    tmpQuat.copy(tmpQuatA).slerp(tmpQuatB, t);

    mesh.position.copy(tmpPos);
    mesh.quaternion.copy(tmpQuat);
    mesh.scale.setScalar(targetScale);
    mesh.visible = true;
  });

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      castShadow
      receiveShadow
    >
      {materials.map((mat, i) => (
        <primitive key={i} object={mat} attach={`material-${i}`} />
      ))}
      {/* Цветная обводка рёбер — только если передан outlineColor
          (VS/одновременный бросок). Одиночный бросок — без обводки,
          кубики остаются «чисто синими». */}
      {outlineMaterial && (
        <lineSegments geometry={edgesGeometry} material={outlineMaterial} />
      )}
    </mesh>
  );
}

// ── CameraRig: камера смотрит на центр арены сверху-сбоку ──
//
// ПОЧЕМУ TOP-DOWN (почти вертикально):
//   Камера высоко и почти вертикально (y=3.0*AH, z=0.55*AH) — арена
//   выглядит как чистый ПРЯМОУГОЛЬНИК, без перспективных искажений.
//   Кубики отбрасывают мягкую контактную тень прямо под собой.
//
// ПОЧЕМУ FOV 42°:
//   Уже → арена заполняет бóльшую часть кадра. При top-down позиционировании
//   арена заполняет ~85% высоты кадра.
//
// ПОЗИЦИЯ: [0, 3.0*maxHalf, 0.55*maxHalf] — пропорционально бóльшей стороне.
// lookAt(0,0,0). Наклон ~10° от вертикали — достаточно для лёгкого 3D-объёма
// (кубики видны сбоку), но без искажения прямоугольника арены.
//
// БОРТИКОВ НЕТ: визуально арена открыта. Невидимые физические стены
// живут на сервере (physics-service) — кубики отскакивают от них,
// оставаясь внутри контура карты.
function CameraRig({
  target = [0, 0, 0] as [number, number, number],
  arenaHalfW = DEFAULT_ARENA_HALF,
  arenaHalfH = DEFAULT_ARENA_HALF,
}) {
  const { camera } = useThree();
  const targetVec = useMemo(() => new THREE.Vector3(target[0], target[1], target[2]), [target]);
  // Используем бóльшую сторону для высоты камеры — обе стороны арены
  // помещаются в кадр. Камера почти вертикально (z << y) → минимальная
  // перспективная трапеция.
  const maxHalf = Math.max(arenaHalfW, arenaHalfH);
  const camPos = useMemo<[number, number, number]>(
    () => [0, 3.0 * maxHalf, 0.55 * maxHalf],
    [maxHalf],
  );
  useFrame(() => {
    camera.position.set(camPos[0], camPos[1], camPos[2]);
    camera.lookAt(targetVec);
  });
  return null;
}

// ── CanvasMapSync: позиционирует 3D-канвас поверх видимой области карты ──
//
// КЛЮЧЕВАЯ ИДЕЯ: 3D-канвас (с ареной и кубиками) должен точно совпадать с
// видимым прямоугольником карты на экране. Тогда арена (с тем же соотношением
// сторон, что и изображение) заполняет канвас, а бортики стоят ТОЧНО по
// краям картинки карты — как настоящая рамка стола.
//
// МАТЕМАТИКА (с каноническим world-пространством CANONICAL_W × CANONICAL_H):
//   GameCanvas рендерит фоновое изображение в CANONICAL world-пространстве:
//     fitScale = min(CANONICAL_W/imgW, CANONICAL_H/imgH)
//     mapWorldW = imgW * fitScale, mapWorldH = imgH * fitScale
//     drawX = (CANONICAL_W - mapWorldW)/2, drawY = (CANONICAL_H - mapWorldH)/2
//   На экране (pan/zoom применяются к world-координатам):
//     screenLeft = drawX * zoom + panX
//     screenTop  = drawY * zoom + panY
//     screenW = mapWorldW * zoom,  screenH = mapWorldH * zoom
//
// ПРИМЕНЕНИЕ: мы устанавливаем CSS-размер и позицию canvas-wrapper'а равными
// screen-прямоугольнику карты. R3F измеряет wrapper (через ResizeObserver) и
// ставит drawing buffer = wrapper size → camera aspect = map aspect = arena
// aspect. Арена заполняет канвас, бортики по краям.
//
// ЕСЛИ НЕТ ИЗОБРАЖЕНИЯ (mapImageSize=null): fallback — канвас заполняет весь
// viewport (старое поведение). Арена центрирована, бортики видны, но не
// привязаны к краям карты (т.к. карты нет).
const CANONICAL_W_3D = 1920;
const CANONICAL_H_3D = 1080;
function CanvasMapSync({
  zoom,
  panX,
  panY,
  mapImageSize,
  wrapperRef,
}: {
  zoom: number;
  panX: number;
  panY: number;
  mapImageSize?: { w: number; h: number } | null;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
}) {
  const gl = useThree((s) => s.gl);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    canvasElRef.current = gl.domElement as HTMLCanvasElement;
  }, [gl]);

  // Последние значения viewport — для использования в useFrame (замыкание
  // useFrame может устареть, а ref — всегда свежий).
  const vpRef = useRef({ panX, panY, zoom, mapImageSize });
  useEffect(() => {
    vpRef.current = { panX, panY, zoom, mapImageSize };
  });

  useFrame(() => {
    const wrapper = wrapperRef.current;
    const canvas = canvasElRef.current;
    if (!wrapper || !canvas) return;

    const parent = wrapper.parentElement;
    if (!parent) return;
    const vw = parent.clientWidth ?? 0;
    const vh = parent.clientHeight ?? 0;
    if (vw === 0 || vh === 0) return;

    const {
      panX: px,
      panY: py,
      zoom: z,
      mapImageSize: img,
    } = vpRef.current;
    const safeZoom = Math.max(0.05, z);

    if (!img || img.w <= 0 || img.h <= 0) {
      // Fallback: нет изображения — канвас заполняет viewport (старое поведение).
      // Центр арены = центр viewport в world-координатах.
      const worldCx = vw / 2;
      const worldCy = vh / 2;
      const screenCx = worldCx * safeZoom + px;
      const screenCy = worldCy * safeZoom + py;
      // Канвас = весь viewport, но сдвинут так, чтобы его центр попал в
      // screen-позицию центра viewport. При zoom=1,pan=0 → без сдвига.
      // Размер канваса масштабируется zoom'ом (кубики увеличиваются с zoom).
      const cw = vw;
      const ch = vh;
      const tx = screenCx - cw / 2;
      const ty = screenCy - ch / 2;
      wrapper.style.left = '0px';
      wrapper.style.top = '0px';
      wrapper.style.width = vw + 'px';
      wrapper.style.height = vh + 'px';
      const desired = `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${safeZoom})`;
      if (canvas.style.transform !== desired) {
        canvas.style.transform = desired;
        canvas.style.transformOrigin = 'center center';
      }
      // Wrapper позиционирован (fallback: весь viewport) → делаем видимым.
      // До этого момента opacity:0 (см. wrapperStyle в Dice3DPhysicsCanvas).
      if (wrapper.style.opacity !== '1') wrapper.style.opacity = '1';
      return;
    }

    // Есть изображение — позиционируем канвас точно по screen-прямоугольнику
    // карты в CANONICAL world-пространстве.
    const fitScale = Math.min(CANONICAL_W_3D / img.w, CANONICAL_H_3D / img.h);
    const mapWorldW = img.w * fitScale;
    const mapWorldH = img.h * fitScale;
    // Image is centered in the canonical canvas.
    const drawX = (CANONICAL_W_3D - mapWorldW) / 2;
    const drawY = (CANONICAL_H_3D - mapWorldH) / 2;
    // Screen position: screenPos = worldPos * zoom + pan.
    const left = drawX * safeZoom + px;
    const top = drawY * safeZoom + py;
    const screenW = mapWorldW * safeZoom;
    const screenH = mapWorldH * safeZoom;

    // Устанавливаем размер wrapper'а = screen-прямоугольник карты.
    // R3F измеряет wrapper → drawing buffer = screenW × screenH →
    // camera aspect = screenW/screenH = mapWorldW/mapWorldH = img.w/img.h
    // = arenaHalfW/arenaHalfH (арена). Арена заполняет канвас, бортики по краям.
    wrapper.style.left = left.toFixed(2) + 'px';
    wrapper.style.top = top.toFixed(2) + 'px';
    wrapper.style.width = screenW.toFixed(2) + 'px';
    wrapper.style.height = screenH.toFixed(2) + 'px';
    // Canvas внутри wrapper'а = 100% × 100% (без дополнительного transform).
    // R3F сам ставит размер canvas = wrapper size. Никакого scale —
    // 1 физ.единица = 1 screen-pixel / zoom... нет, R3F рендерит арену в
    // drawing buffer размером wrapper'a. Камера фреймит арену на весь buffer.
    if (canvas.style.transform !== 'none') {
      canvas.style.transform = 'none';
      canvas.style.transformOrigin = 'center center';
    }
    // Wrapper позиционирован по screen-прямоугольнику карты → делаем видимым.
    // До этого момента opacity:0 — кубы НЕ видны в неправильной позиции.
    // Это фикс бага "кубы вылезают из-за правой части карты": раньше wrapper
    // был виден сразу (на весь viewport), пока useFrame не перемещал его
    // на карту. Теперь opacity:1 ставится ТОЛЬКО после позиционирования.
    if (wrapper.style.opacity !== '1') wrapper.style.opacity = '1';
  });
  return null;
}

// ── HeldDiceController: рендер удерживаемых кубов во время drag ────────
//
// ВАРИАНТ A (единый канвас): кубы, которые игрок "держит" мышкой во время
// drag'а, рендерятся в ТОМ ЖЕ Dice3DPhysicsCanvas, что и бросаемые.
// Этот контроллер (внутри <Canvas>) каждый кадр:
//   1. Читает позицию курсора из held-dice-bus (RollGestureProvider пишет).
//   2. Raycast'ит курсор на плоскость арены (y=0) → целевая (x,z).
//   3. Расставляет 4 куба сеткой 2×2 (шаг = physics spawn step 0.48) с
//      центром в целевой точке — позиции совпадают с тем, куда physics
//      поставит кубы при release → БЕСШОВНЫЙ handoff (кубы не "прыгают").
//   4. Накапливает кватернион вращения каждого куба (премножим, world space)
//      вокруг фиксированной случайной оси со скоростью 8-14 рад/с.
//   5. Пушит кадр {t: now, dice} в общий bufferRef через pushSnapshot.
//      DieMesh рендерит его как обычно — ТЕ ЖЕ меши, что потом будут
//      бросаться. Никакого "телепорта между двумя канвасами".
//   6. Ставит liveMode=true → DieMesh рендерит без 110мс задержки (кубы
//      следуют за курсором мгновенно).
//
// При dragEnd RollGestureProvider читает getQuaternions()/getAngularVelocities()
// через bus и передаёт их в physics-service (initialQuats + initialAngularVelocity)
// → брошенные кубы продолжают вращение удерживаемых (та же ось + скорость).
// Физика ставит кубы в ту же spawn-точку (spawnX/spawnZ из drop-позиции) →
// позиция тоже совпадает. Итог: бросаются ИМЕННО ТЕ кубы, что были захвачены.

interface HeldDiceControllerProps {
  bufferRef: React.MutableRefObject<SnapshotFrame[]>;
  arenaHalfW: number;
  arenaHalfH: number;
  numDice: number;
}

// Шаг сетки 2×2 — совпадает с physics-service (DIE_HALF*2 + gap = 0.48).
// Так сетка удерживаемых кубов = сетка спавна physics → нулевой "прыжок".
const HELD_GRID_STEP = 0.48;
// Высота удержания — совпадает с physics spawn Y (DIE_HALF + 0.03 ≈ 0.25).
const HELD_DIE_Y = 0.25;
// ── "Живые" кубики (indices 0-3): held-dice во время drag + bridge + physics.
// Ghost-кубики (indices 4-7) нужны только для анимации возврата в кейс и
// живут ~380мс. numDice в DiceCanvasHost = 8 (4 live + 4 ghost), но циклы
// held/bridge работают только с LIVE_DICE_COUNT=4 (indices 0-3).
const LIVE_DICE_COUNT = 4;
// ── BRIDGE MODE: максимальная длительность моста drag→physics ──
// При dragEnd HeldDiceController продолжает экстраполировать вращение и
// пушить кадры, пока physics-service не пришлёт свой первый кадр
// (getPhysicsActive()=true). Обычно physics стартует за ~30-80мс (socket
// latency + spawn). 400мс — это safety timeout: если physics не пришёл
// (ошибка/лаг сети), bridge завершится и кубы замрут на последней позиции.
// 400мс > worst-case latency Caddy gateway + physics spawn (типично <100мс).
const BRIDGE_MAX_MS = 400;
// ── RETURN-TO-CASE: параметры анимации прыжка старых кубов в кейс ──
// ARC_HEIGHT = 0.9 — высота прыжка (кубы взлетают на ~0.9 единицы над столом).
// CASE_GRID_STEP = 0.14 — кубы складываются в маленькую 2×2 сетку у кейса
//   (меньше HELD_GRID_STEP=0.48, чтобы визуально "стянуться" в кейс).
const RETURN_ARC_HEIGHT = 0.9;
const CASE_GRID_STEP = 0.14;

function HeldDiceController({ bufferRef, arenaHalfW, arenaHalfH }: HeldDiceControllerProps) {
  const { camera, gl } = useThree();

  // Raycaster + плоскость пола (переиспользуем каждый кадр — без мусора).
  // ВАЖНО: useRef (не useMemo) для объектов, чьи СВОЙСТВА мутируются напрямую
  // (ndc.x = ...). react-hooks/immutability запрещает мутировать useMemo-результат.
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const ndc = useRef(new THREE.Vector2());
  const groundPlane = useMemo(() => new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), []);
  const hitPoint = useMemo(() => new THREE.Vector3(), []);
  const deltaQ = useMemo(() => new THREE.Quaternion(), []);

  // Per-die spin: ось (нормированная) + скорость + текущий кватернион.
  // ФИКСИРОВАНЫ на всё время жизни контроллера → вращение непрерывно.
  // При dragEnd эти же ось+скорость → physics-service (initialAngularVelocity).
  // ТОЛЬКО для LIVE_DICE_COUNT=4 (indices 0-3). Ghost-dice (indices 4-7)
  // используют отдельный ghostSpins (см. ниже).
  const dieSpins = useMemo(() => {
    return Array.from({ length: LIVE_DICE_COUNT }, () => {
      let ax = (Math.random() - 0.5) * 2;
      let ay = (Math.random() - 0.5) * 2;
      let az = (Math.random() - 0.5) * 2;
      const alen = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
      ax /= alen; ay /= alen; az /= alen;
      const axis = new THREE.Vector3(ax, ay, az);
      const speed = 8 + Math.random() * 6;  // 8-14 рад/с
      const q0 = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(Math.random(), Math.random(), Math.random()).normalize(),
        Math.random() * Math.PI * 2,
      );
      return { axis, speed, quat: q0.clone() };
    });
  }, []);

  // ── Ghost-dice spins ── УБРАНО: ghost-dice теперь рендерятся DieMesh напрямую
  // из returnState (см. блок ghost-dice в DieMesh.useFrame). Раньше здесь были
  // ghostSpins (4 оси+скорости) и ghostQuatsRef (накапливаемые кватернионы),
  // но они больше не нужны — DieMesh вычисляет вращение чисто из returnState
  // + elapsed time (q0 * axisAngle(axis, speed*elapsed)). Buffer не трогается.

  // Регистрируем API в bus → RollGestureProvider читает при dragEnd.
  useEffect(() => {
    const api: HeldDiceControllerApi = {
      getQuaternions: () => dieSpins.map((s) => [
        s.quat.x, s.quat.y, s.quat.z, s.quat.w,
      ] as [number, number, number, number]),
      getAngularVelocities: () => dieSpins.map((s) => [
        s.axis.x * s.speed, s.axis.y * s.speed, s.axis.z * s.speed,
      ] as [number, number, number]),
    };
    registerHeldDiceController(api);
    return () => { registerHeldDiceController(null); };
  }, [dieSpins]);

  // Отслеживаем переход active→inactive чтобы запустить BRIDGE MODE.
  // ── BRIDGE MODE (устранение задержки drag→physics) ──────────────────
  // Проблема без bridge: при dragEnd сразу setLiveMode(false) → DieMesh
  // переключается на 110мс задержку → но в buffer только held-кадры с
  // t < T_release → renderTime указывает "в прошлое" → snap к последнему
  // held кадру → кубы ЗАМИРАЮТ на ~110мс, пока physics не заполнит buffer.
  //
  // Решение: при dragEnd HeldDiceController НЕ выключает liveMode сразу.
  // Он продолжает экстраполировать вращение (та же ось+скорость, что и при
  // drag) и пушить кадры с ПОСЛЕДНЕЙ удерживаемой позицией (кубы крутятся
  // на месте). Как только physics-service присылает первый кадр
  // (ServerDiceStage → setPhysicsActive(true)) — bridge завершается,
  // liveMode выключается, буфер плавно заполняется physics-кадрами.
  //
  // Если physics по какой-то причине не пришёл (ошибка/лаг) — bridge
  // длится максимум BRIDGE_MAX_MS=400мс, потом принудительно завершается.
  const prevActiveRef = useRef(false);
  const bridgeUntilRef = useRef(0);
  const bridgeActiveRef = useRef(false);
  // Последняя удерживаемая позиция каждого куба (для экстраполяции вращения
  // в bridge mode — кубы остаются на месте, продолжая крутиться).
  const lastHeldPosRef = useRef<Array<[number, number, number]>>([]);

  useFrame((_, delta) => {
    const ds = getDragState();
    const now = Date.now();

    // ── BRIDGE CANCEL: явный сигнал остановить мост ──
    // clearSharedDiceBuffer() (drag→case или новый drag) вызывает cancelHeldBridge().
    // Потребляем флаг здесь, в начале useFrame, ПЕРЕД любой логикой bridge.
    // Если выставлен — bridge немедленно завершается (кубы исчезают/переходят
    // под курсор нового drag).
    //
    // ВАЖНО: также сбрасываем prevActiveRef.current = false. Без этого сброса
    // блок bridge-init ниже (if (prevActiveRef.current)) снова запустит bridge
    // в ТОМ ЖЕ кадре — кубы продолжат крутиться на месте ~400мс после drag→case
    // (пользователь видит «анимацию слабого броска» без лога). Со сбросом —
    // bridge не запускается, буфер остаётся пустым, кубы сразу исчезают.
    if (consumeBridgeCancel()) {
      bridgeActiveRef.current = false;
      setLiveMode(false);
      prevActiveRef.current = false;  // НЕ запускать bridge в этом же кадре
      // Не return — продолжаем обработку текущего состояния (может быть active
      // для нового drag или inactive для cancel).
    }

    // ── RETURN-TO-CASE: анимация теперь обрабатывается DieMesh напрямую ──
    // ВАЖНО: Раньше HeldDiceController пушил ghost-кадры (только 4-7) в buffer
    // с t=client-now. Физика пушала live-кадры (только 0-3) с t=server-t.
    // Из-за сетевой задержки t различались >16ms (порог merge в pushSnapshot)
    // → в buffer появлялись ОТДЕЛЬНЫЕ кадры: один с 0-3, другой с 4-7.
    // DieMesh для 0-3 видел кадр только с 4-7 → mesh.visible=false → КУБЫ
    // ИСЧЕЗАЛИ. DieMesh для 4-7 видел кадр только с 0-3 → mesh.visible=false
    // → ПРИЗРАКИ ИСЧЕЗАЛИ. Это и было причиной багов "призрачные кубы" и
    // "исчезновение кубов при частых бросках".
    //
    // ТЕПЕРЬ: ghost-dice (indices 4-7) рендерятся DieMesh НАПРЯМУЮ из
    // returnState (см. блок ghost-dice в DieMesh.useFrame). HeldDiceController
    // больше НЕ пушил ghost-кадры в buffer. Buffer содержит ТОЛЬКО live-кадры
    // (0-3) от физики/held-dice. Никакой race condition.
    //
    // Здесь только проверяем: если returnState активна — ставим liveMode=true,
    // чтобы DieMesh для 0-3 рендерил без 110мс задержки (физика может ещё не
    // пришла, но кубы от ПРЕДЫДУЩЕГО броска ещё видны через buffer).
    // Также: если returnState завершена (progress >= 1) — DieMesh для index 4
    // сам вызовет clearReturnState(). Здесь не дублируем.
    const returnState = getReturnState();
    if (returnState) {
      // liveMode=true → DieMesh рендерит без 110мс задержки.
      // Важно для ghost-dice (index 4-7): их рендеринг идёт от returnState,
      // не от buffer, но liveMode всё равно нужен для live-dice (0-3) чтобы
      // они не "замерли" на 110мс при переходе physics→returnState.
      setLiveMode(true);
    }

    if (!ds.active) {
      if (prevActiveRef.current) {
        // Drag ТОЛЬКО ЧТО закончился → запускаем bridge на 400мс.
        // НЕ выключаем liveMode! Кубы продолжают крутиться через экстраполяцию.
        bridgeUntilRef.current = now + BRIDGE_MAX_MS;
        bridgeActiveRef.current = true;
        prevActiveRef.current = false;
      }

      if (bridgeActiveRef.current) {
        // ── Проверяем: physics уже начал стримить? ──
        if (getPhysicsActive()) {
          // Physics подхватил → завершаем bridge. liveMode=false → DieMesh
          // плавно переходит на 110мс интерполяцию (physics-кадры уже в буфере).
          bridgeActiveRef.current = false;
          setLiveMode(false);
          setPhysicsActive(false);  // сброс для следующего броска
          return;
        }
        // ── Bridge истёк по таймауту? ──
        if (now >= bridgeUntilRef.current) {
          // Physics так и не пришёл (ошибка?) → завершаем bridge.
          // Кубы останутся на последней позиции и через ~110мс исчезнут
          // (buffer перестанет расти, DieMesh snap-ит к последнему кадру).
          bridgeActiveRef.current = false;
          setLiveMode(false);
          return;
        }
        // ── BRIDGE: продолжаем экстраполировать вращение + пушим кадры ──
        // Кубы остаются в lastHeldPosRef (где игрок отпустил), но продолжают
        // вращаться с той же угловой скоростью. Так визуально НЕТ заморозки.
        // ТОЛЬКО indices 0-3 (LIVE_DICE_COUNT). Ghost-dice (4-7) пушатся
        // отдельно блоком return-to-case выше (если активен).
        const dt = Math.min(delta, 0.1);
        for (const s of dieSpins) {
          deltaQ.setFromAxisAngle(s.axis, s.speed * dt);
          s.quat.premultiply(deltaQ);
          s.quat.normalize();
        }
        const dice: DieTransform[] = [];
        for (let i = 0; i < LIVE_DICE_COUNT; i++) {
          const p = lastHeldPosRef.current[i] ?? [0, HELD_DIE_Y, 0];
          const s = dieSpins[i];
          dice.push({
            i,
            p: [p[0], p[1], p[2]],
            q: [s.quat.x, s.quat.y, s.quat.z, s.quat.w],
          });
        }
        pushSnapshot(bufferRef, { t: now, dice });
        setLiveMode(true);
        return;
      }

      // Не в bridge, не в drag — ничего не делаем (физика рулит).
      // return-to-case (если активен) уже пушит ghost-dice выше.
      return;
    }

    // ── ACTIVE DRAG — обычная логика ──
    prevActiveRef.current = true;
    // Сбрасываем bridge-флаги на всякий случай (новый drag после предыдущего).
    bridgeActiveRef.current = false;
    setPhysicsActive(false);

    // ── Raycast курсор → плоскость арены ──
    const canvas = gl.domElement as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const cx = ds.cursorX, cy = ds.cursorY;
    if (cx < 0 || cy < 0) {
      // Нет данных о курсоре — не пушим held-dice, но сохраняем liveMode
      // (если return-to-case активен, он уже выставил liveMode=true выше;
      // иначе liveMode остаётся прежним). Не return с liveMode=false,
      // иначе DieMesh начнёт лагать на 110мс.
      return;
    }
    // ── ФИКС "stuck in left corner": не пушим held-dice если курсор ВНЕ
    // canvas. Раньше raycast + clamp к краю арены приводили к тому, что
    // при drag из кейса (курсор в левом сайдбаре, ВНЕ canvas) кубы
    // прилипали к левому краю арены и "застревали" там. Теперь: курсор
    // вне canvas → held-dice не пушатся → кубы невидимы, пока курсор не
    // войдёт в canvas. Это даёт чистое "кубы появляются под курсором при
    // входе на карту" вместо "кубы прилипают к левому краю".
    if (cx < rect.left || cx > rect.right || cy < rect.top || cy > rect.bottom) {
      // Curse outside canvas — не пушим held-dice. liveMode=true чтобы
      // DieMesh рендерил последний held-кадр без лага (если он есть).
      // Если return-to-case активен, он уже выставил liveMode=true.
      // Если нет — ставим true, чтобы избежать 110мс лага при возврате
      // курсора на canvas.
      if (!getReturnState()) setLiveMode(true);
      return;
    }
    ndc.current.x = ((cx - rect.left) / rect.width) * 2 - 1;
    ndc.current.y = -(((cy - rect.top) / rect.height) * 2 - 1);
    raycaster.setFromCamera(ndc.current, camera);
    if (!raycaster.ray.intersectPlane(groundPlane, hitPoint)) return;

    // Clamp в арену (с запасом под пол-сетки).
    const marginX = HELD_GRID_STEP * 0.6;
    const marginZ = HELD_GRID_STEP * 0.6;
    const cxPhys = THREE.MathUtils.clamp(hitPoint.x, -arenaHalfW + marginX, arenaHalfW - marginX);
    const czPhys = THREE.MathUtils.clamp(hitPoint.z, -arenaHalfH + marginZ, arenaHalfH - marginZ);

    // ── Вращение: накапливаем кватернион (premultiply = world space) ──
    const dt = Math.min(delta, 0.1);
    for (const s of dieSpins) {
      deltaQ.setFromAxisAngle(s.axis, s.speed * dt);
      s.quat.premultiply(deltaQ);
      s.quat.normalize();
    }

    // ── Пушим кадр в общий buffer + сохраняем последнюю позицию ──
    // ТОЛЬКО indices 0-3 (LIVE_DICE_COUNT). Ghost-dice (4-7) пушатся
    // отдельно блоком return-to-case выше (если активен).
    const dice: DieTransform[] = [];
    for (let i = 0; i < LIVE_DICE_COUNT; i++) {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = cxPhys + (col - 0.5) * HELD_GRID_STEP;
      const z = czPhys + (row - 0.5) * HELD_GRID_STEP;
      const s = dieSpins[i];
      // Сохраняем последнюю удерживаемую позицию для bridge mode.
      lastHeldPosRef.current[i] = [x, HELD_DIE_Y, z];
      dice.push({
        i,
        p: [x, HELD_DIE_Y, z],
        q: [s.quat.x, s.quat.y, s.quat.z, s.quat.w],
      });
    }
    pushSnapshot(bufferRef, { t: now, dice });
    setLiveMode(true);
  });

  return null;
}

// ── Сцена: камера + свет + кубики ─────────────────────────────

interface Dice3DSceneProps {
  numDice: number;
  bufferRef: React.MutableRefObject<SnapshotFrame[]>;
  startedRef: React.MutableRefObject<boolean>;
  casePosition?: [number, number, number];
  zoom: number;
  panX: number;
  panY: number;
  arenaHalfW?: number;
  arenaHalfH?: number;
  mapImageSize?: { w: number; h: number } | null;
  wrapperRef: React.RefObject<HTMLDivElement | null>;
  // Количество участников в одновременном броске. 1 (или отсутствует) =
  // одиночный бросок, обводка не рисуется. >1 = VS/массовый бросок,
  // кубики каждого участника получают свой цвет обводки.
  numSessions?: number;
  // ── Drop-позиция (drag-and-drop бросок) ──
  // Если передана — CanvasMapSync позиционирует МАЛЕНЬКУЮ арену прямо
  // на этой screen-точке. Кубы появляются чуть ниже drop-точки (near край
  // маленькой арены) и падают рядом.
  dropX?: number;
  dropY?: number;
  // ── Визуальный масштаб кубика ──
  // 1.0 (default) для большой арены. >1 для маленькой арены (drop mode),
  // чтобы кубики были видны на маленьком canvas.
  dieScale?: number;
  // ── Held-dice режим (Вариант A) ──
  // Если true — в сцену добавляется HeldDiceController, который во время
  // drag пушит процедурные кадры удерживаемых кубов в общий bufferRef.
  // Те же DieMesh рендерят их → бесшовный handoff на физику при release.
  heldMode?: boolean;
  /** Per-participant dice colors (mass rolls). Entry 0 = session 0 (dice
   *  indices 0-3), entry 1 = session 1 (indices 4-7), etc. If absent or
   *  entry missing, DieMesh falls back to store (viewer's own colors). */
  participantColors?: Array<{ diceColor: string; symbolColor: string }>;
}

function Dice3DScene({
  numDice,
  bufferRef,
  startedRef,
  casePosition,
  zoom,
  panX,
  panY,
  arenaHalfW = DEFAULT_ARENA_HALF,
  arenaHalfH = DEFAULT_ARENA_HALF,
  mapImageSize,
  wrapperRef,
  numSessions = 1,
  dropX,
  dropY,
  dieScale = 1,
  heldMode = false,
  participantColors,
}: Dice3DSceneProps) {
  // Позиция кейса адаптируется к H-стороне арены (если не передана явно).
  const effectiveCasePos = useMemo(
    () => casePosition ?? casePosForArena(arenaHalfH),
    [casePosition, arenaHalfH],
  );

  // Масштаб освещения и теней под бóльшую сторону арены.
  const maxHalf = Math.max(arenaHalfW, arenaHalfH);
  const shadowScale = Math.max(8, maxHalf * 2.2);

  return (
    <>
      {/* Камера: top-down, адаптируется под бóльшую сторону арены. */}
      <CameraRig target={[0, 0, 0]} arenaHalfW={arenaHalfW} arenaHalfH={arenaHalfH} />

      {/* Позиционирует 3D-канвас точно по screen-прямоугольнику карты. */}
      <CanvasMapSync
        zoom={zoom}
        panX={panX}
        panY={panY}
        mapImageSize={mapImageSize}
        wrapperRef={wrapperRef}
      />

      {/* Матовое освещение — позиции масштабируются под размер арены. */}
      <ambientLight intensity={1.15} />
      <directionalLight
        position={[-maxHalf * 1.2, maxHalf * 2.0, maxHalf * 0.8]}
        intensity={0.95}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={0.1}
        shadow-camera-far={maxHalf * 6}
        shadow-camera-left={-shadowScale}
        shadow-camera-right={shadowScale}
        shadow-camera-top={shadowScale}
        shadow-camera-bottom={-shadowScale}
        shadow-bias={-0.0005}
      />
      <directionalLight position={[maxHalf * 1.2, maxHalf * 0.8, -maxHalf * 0.4]} intensity={0.35} color="#ffffff" />
      <directionalLight position={[0, maxHalf * 0.5, -maxHalf * 1.5]} intensity={0.40} color="#ffffff" />

      {/* Визуальных бортиков НЕТ — физические стены живут на сервере
          (physics-service) и блокируют кубиков невидимо. Здесь только
          рендер самих кубиков и контактной тени под ними. */}

      {/* HeldDiceController (Вариант A): во время drag пушит процедурные
          кадры удерживаемых кубов в общий buffer. DieMesh ниже рендерит
          их как обычно — те же меши, что потом будут бросаться. */}
      {heldMode && (
        <HeldDiceController
          bufferRef={bufferRef}
          arenaHalfW={arenaHalfW}
          arenaHalfH={arenaHalfH}
          numDice={numDice}
        />
      )}

      {Array.from({ length: numDice }).map((_, i) => {
        // Resolve per-participant colors by session index (4 dice per session).
        const sessIdx = Math.floor(i / 4);
        const pc = participantColors?.[sessIdx];
        return (
          <DieMesh
            key={i}
            index={i}
            bufferRef={bufferRef}
            casePosition={effectiveCasePos}
            startedRef={startedRef}
            outlineColor={getOutlineColorForDie(i, numSessions)}
            dieScale={dieScale}
            arenaHalfW={arenaHalfW}
            arenaHalfH={arenaHalfH}
            numSessions={numSessions}
            diceColor={pc?.diceColor}
            symbolColor={pc?.symbolColor}
          />
        );
      })}

      <ContactShadows
        position={[0, -0.001, 0]}
        opacity={0.32}
        scale={Math.max(10, maxHalf * 2.5)}
        blur={2.8}
        far={3.0}
        color="#1a1a2a"
      />
    </>
  );
}

// ── Внешний компонент: Canvas + WebGL check + viewport binding ──

interface Dice3DPhysicsCanvasProps {
  numDice: number;
  bufferRef: React.MutableRefObject<SnapshotFrame[]>;
  startedRef: React.MutableRefObject<boolean>;
  viewport?: DiceViewport;
  casePosition?: [number, number, number];
  // Половины сторон прямоугольной арены (в физ. единицах). Определяют размер
  // бортиков и позицию камеры. Должны совпадать с arenaHalfW/H, переданными
  // в dice:roll. Соотношение сторон = imgW/imgH → бортики по контуру карты.
  arenaHalfW?: number;
  arenaHalfH?: number;
  // Размер фонового изображения (naturalWidth × naturalHeight) — для
  // позиционирования 3D-канваса точно по screen-прямоугольнику карты.
  mapImageSize?: { w: number; h: number } | null;
  // Количество участников в одновременном броске (1 = одиночный, >1 = VS).
  // Определяет, будут ли кубики иметь цветную обводку рёбер для различения.
  numSessions?: number;
  // ── Drop-позиция (drag-and-drop бросок) ──
  // Если передана — маленькая арена позиционируется прямо на этой screen-точке.
  // Кубы появляются чуть ниже drop-точки и падают рядом. Без этого кубы
  // спавнятся с края большой арены (вся карта) — выглядят "со стороны".
  dropX?: number;
  dropY?: number;
  // ── Визуальный масштаб кубика ──
  // 1.0 (default). >1 для маленькой арены (drop mode) — кубики крупнее,
  // чтобы быть видимыми на маленьком canvas (192×132px).
  dieScale?: number;
  // ── Held-dice режим (Вариант A) ──
  // Если true — в сцену добавляется HeldDiceController, который во время
  // drag пушит процедурные кадры удерживаемых кубов в общий bufferRef.
  // Persistent-канвас (DiceCanvasHost) ставит heldMode=true. ServerDiceStage
  // (физика) — false (физика сама льёт кадры).
  heldMode?: boolean;
  /** Per-participant dice colors (mass rolls). See Dice3DSceneProps. */
  participantColors?: Array<{ diceColor: string; symbolColor: string }>;
}

export function Dice3DPhysicsCanvas(props: Dice3DPhysicsCanvasProps) {
  const {
    viewport,
    numDice,
    bufferRef,
    startedRef,
    casePosition,
    arenaHalfW,
    arenaHalfH,
    mapImageSize,
    numSessions,
    dropX,
    dropY,
    dieScale,
    heldMode,
    participantColors,
  } = props;
  const vp = viewport ?? { panX: 0, panY: 0, zoom: 1 };
  const arenaW = arenaHalfW ?? DEFAULT_ARENA_HALF;
  const arenaH = arenaHalfH ?? DEFAULT_ARENA_HALF;
  // Ref на wrapper div — CanvasMapSync (внутри <Canvas>) устанавливает его
  // CSS-позицию и размер = screen-прямоугольнику карты каждый кадр.
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const webglOk = useMemo(() => {
    if (typeof window === 'undefined') return false;
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      return !!gl;
    } catch {
      return false;
    }
  }, []);

  if (!webglOk) return null;

  // ── Wrapper: позиционируется CanvasMapSync'ом ──────────────
  // Wrapper имеет position:absolute, но его left/top/width/height
  // устанавливаются CanvasMapSync'ом каждый кадр = screen-прямоугольник
  // карты. R3F измеряет wrapper → drawing buffer = map rect size →
  // camera aspect = map aspect = arena aspect → арена заполняет канвас,
  // бортики по краям карты.
  //
  // При отсутствии изображения (fallback) — wrapper = весь viewport,
  // canvas получает translate+scale (старое поведение).
  //
  // ── opacity НЕ здесь — в CSS-классе .dice-3d-canvas-wrapper ──
  // Класс ставит opacity:0 (невидим). CanvasMapSync ставит inline
  // opacity:1 ПОСЛЕ позиционирования. React не трогает opacity (его нет
  // в этом style-объекте) → не сбрасывает при ре-рендере. См. globals.css.
  const wrapperStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    willChange: 'transform, width, height',
  };

  // Canvas: 100% × 100% wrapper'а. Без дополнительного CSS-transform
  // (при наличии изображения) — R3F рендерит арену в drawing buffer =
  // wrapper size, камера фреймит арену на весь buffer.
  const canvasStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    willChange: 'transform',
  };

  const maxHalf = Math.max(arenaW, arenaH);

  return (
    <div className="dice-3d-canvas-wrapper" style={wrapperStyle} ref={wrapperRef}>
      <Canvas
        shadows
        camera={{ position: [0, 3.0 * maxHalf, 0.55 * maxHalf], fov: CAMERA_FOV }}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
        style={canvasStyle}
        dpr={[1, 2]}
      >
        <Dice3DScene
          numDice={numDice}
          bufferRef={bufferRef}
          startedRef={startedRef}
          casePosition={casePosition}
          zoom={vp.zoom}
          panX={vp.panX}
          panY={vp.panY}
          arenaHalfW={arenaW}
          arenaHalfH={arenaH}
          mapImageSize={mapImageSize}
          wrapperRef={wrapperRef}
          numSessions={numSessions}
          dropX={dropX}
          dropY={dropY}
          dieScale={dieScale}
          heldMode={heldMode}
          participantColors={participantColors}
        />
      </Canvas>
    </div>
  );
}

// ── Helper: создание буфера снапшотов (используется в overlay) ──

export function createSnapshotBuffer() {
  return { current: [] as SnapshotFrame[] };
}

export function pushSnapshot(
  bufferRef: React.MutableRefObject<SnapshotFrame[]>,
  snapshot: { t: number; dice: DieTransform[] },
) {
  const buf = bufferRef.current;
  const t = snapshot.t;

  // ── MERGE для multi-session (VS): ──
  // При VS броске две сессии стримят трансформы независимо. Сервер emits
  // оба снапшота в одном tickSim (синхронно, t = Date.now() одинаковый).
  // Без merge они попадают в buffer как РАЗНЫЕ кадры:
  //   frame[0]: t=1000, {0:A0, 1:A1, 2:A2, 3:A3}  // session 0
  //   frame[1]: t=1000, {4:B0, 5:B1, 6:B2, 7:B3}  // session 1
  //
  // DieMesh для die 0 ищет frameA (t ≤ renderTime). Находит frame[1]
  // (t=1000 ≤ renderTime), но frame[1] НЕ содержит die 0 → trA=undefined
  // → die 0 НЕ рендерится. Следующий кадр — может содержать. Результат:
  // кубики МИГАЮТ (то видны, то нет) — выглядит как ужасный лаг.
  //
  // Фикс: если последний кадр в буфере имеет тот же t (±16мс = в пределах
  // одного tick), MERGE новые dice в него вместо создания нового кадра.
  // Все 8 кубиков (4+4) оказываются в одном кадре → frame search находит
  // трансформ для каждого die каждый кадр → стабильный рендер без миганий.
  const last = buf[buf.length - 1];
  if (last && Math.abs(last.t - t) <= 16) {
    for (const d of snapshot.dice) last.transforms.set(d.i, d);
    return;
  }

  const transforms = new Map<number, DieTransform>();
  for (const d of snapshot.dice) transforms.set(d.i, d);
  buf.push({ t, transforms });
  // Trim — оставляем последние N кадров
  if (buf.length > MAX_BUFFER_SIZE) buf.shift();
}

export type { SnapshotFrame };
