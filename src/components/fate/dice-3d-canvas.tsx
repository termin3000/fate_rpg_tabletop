'use client';

// ============================================================
// Dice3DCanvas — настоящий 3D рендер кубиков через Three.js / R3F
// ============================================================
// КУБЫ НА СТОЛЕ: кубики вылетают из "кейса" (теперь в ScenePanel),
// физически скачут по карте (гравитация + подскоки с затуханием),
// замирают и показывают результат. Результат уходит в лог. Кубики
// остаются на карте там, где упали, пока игрок не кликнет кейс —
// тогда они анимированно возвращаются в кейс.
//
//   • Насыщенный ярко-синий пластик (#1976d2), МАТОВЫЙ (без бликов)
//   • Чистые белые символы +/− (БЕЗ нолика — пустая грань = 0)
//   • НАСТОЯЩИЙ кубик: 6 РАЗНЫХ граней (2×+, 2×−, 2×пусто), результат на top
//   • Скруглённые рёбра (custom rounded box, radius=0.06)
//   • Матовое освещение: высокий ambient + мягкий directional
//   • Контактная тень под каждым кубиком
//
// ПРИВЯЗКА К КАРТЕ:
//   • viewport ({panX, panY, zoom}) передаётся из MapPanel → RollStageOverlay
//   • CSS transform на wrapper: translate(panX, panY) scale(zoom)
//   • Кубы двигаются и масштабируются вместе с картой
//   • Если игрок pan after броска — кубы сдвигаются вместе с картой
//   • Если zoom — кубы масштабируются вместе с картой
//
// ФИЗИКА БРОСКА (поведение в useFrame):
//   enter  → кубик в кейсе, невидим (scale 0.5)
//   drop   → LAUNCH + PHYSICS: вылет из кейса с начальной скоростью,
//            гравитация, 1-3 подскока с затуханием (restitution=0.42),
//            угловое вращение пропорционально линейной скорости.
//            После замирания — NO SNAP: кубик остаётся в естественной
//            ориентации физики, текстуры граней ПЕРЕНАЗНАЧАЮТСЯ так,
//            чтобы верхняя (видимая) грань показывала результат.
//            Каждый куб имеет свой случайный flightTime, angVel,
//            MAX_BOUNCES — кувыркаются НЕ одновременно, естественная физика.
//   reveal/verdict/hold → кубики лежат на месте падения (статичные)
//   exit   → RETURN: возврат в кейс по дуге, shrink + fade
//
// SSR-safe: динамический импорт с ssr:false в roll-stage-overlay.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { ContactShadows } from '@react-three/drei';
import * as THREE from 'three';
import { useFateStore } from '@/lib/store';
import { derivePalette, suggestSymbolShadow } from '@/lib/dice-palette';

// ── Кастомная rounded-box геометрия (СОХРАНЯЕТ 6 групп от BoxGeometry) ──
function makeRoundedBoxGeometry(
  size: number, radius: number, segments: number
): THREE.BoxGeometry {
  const geom = new THREE.BoxGeometry(size, size, size, segments, segments, segments);
  const pos = geom.attributes.position as THREE.BufferAttribute;
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
      const scale = radius / dist;
      pos.setXYZ(i, cx + dx * scale, cy + dy * scale, cz + dz * scale);
    }
  }
  geom.computeVertexNormals();
  return geom;
}

// ── Типы ─────────────────────────────────────────────────────
export type DicePhase =
  | 'enter'
  | 'drop'
  | 'tumble'
  | 'settle'
  | 'reveal'
  | 'verdict'
  | 'hold'
  | 'exit';

export interface DieScatter3D {
  x: number;
  tiltX: number;
  tiltY: number;
  z: number;
  dropDelay: number;
}

export interface DiceViewport {
  panX: number;
  panY: number;
  zoom: number;
}

// ── Цветовая палитра ─────────────────────────────────────────
const FACE_SIZE = 256;

// Палитра по умолчанию (синие кубы с белыми символами) — используется
// как fallback, если store ещё не hydrated. Реальные цвета приходят из
// store (diceColor, symbolColor) и передаются в makeFaceTexture как
// параметры. Это позволяет менять палитру без перезагрузки текстур.
const DEFAULT_BLUE_TOP = '#2196f3';
const DEFAULT_BLUE_MID = '#1976d2';
const DEFAULT_BLUE_BOTTOM = '#0d47a1';

const DEFAULT_SYMBOL_COLOR = '#ffffff';
const DEFAULT_SYMBOL_SHADOW = 'rgba(0, 10, 40, 0.55)';

// Позиция кейса в 3D-координатах сцены (левый нижний угол экрана).
// Камера [0, 5.5, 4.8] fov 35 → низ-лево ≈ (-3.2, ~0, 2.4).
// Теперь кейс в ScenePanel, но launch-точка остаётся здесь для визуальной
// совместимости — кубы "вылетают" из левого нижнего угла карты.
export const DEFAULT_CASE_POSITION: [number, number, number] = [-3.2, 0.18, 2.4];

// ── Утилиты для canvas-рисования ─────────────────────────────

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

// ── Генерация canvas-текстуры для грани ───────────────────────
// Принимает цвет тела куба и цвет символа — это позволяет менять палитру
// без перезагрузки страницы. Все цвета вычисляются через derivePalette()
// (top lighten+8%, mid base, bottom darken-12%) и suggestSymbolShadow()
// (адаптивная тень под яркость куба).
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
  const topColor = pal.top;
  const midColor = pal.mid;
  const bottomColor = pal.bottom;

  // Мягкий диагональный градиент (top-left → bottom-right)
  const grad = ctx.createLinearGradient(0, 0, FACE_SIZE, FACE_SIZE);
  grad.addColorStop(0, topColor);
  grad.addColorStop(0.5, midColor);
  grad.addColorStop(1, bottomColor);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);

  // Тёмная виньетка по краям (глубина)
  const vignette = ctx.createRadialGradient(
    FACE_SIZE / 2, FACE_SIZE / 2, FACE_SIZE * 0.35,
    FACE_SIZE / 2, FACE_SIZE / 2, FACE_SIZE * 0.72
  );
  vignette.addColorStop(0, 'rgba(0,0,0,0)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);

  // Символ (если есть)
  if (symbol) {
    const cx = FACE_SIZE / 2;
    const cy = FACE_SIZE / 2;
    const symbolSize = FACE_SIZE * 0.62;
    const thickness = FACE_SIZE * 0.18;

    // Цвет тени подбирается под яркость куба (на тёмных кубах
    // классическая тёмно-синяя тень невидима).
    const shadowColor = suggestSymbolShadow(diceColor);

    // Тень символа
    ctx.save();
    ctx.fillStyle = shadowColor;
    if (symbol === '+') {
      drawPlus(ctx, cx + 4, cy + 5, symbolSize, thickness);
    } else if (symbol === '-') {
      drawMinus(ctx, cx + 4, cy + 5, symbolSize, thickness);
    }
    ctx.restore();

    // Сам символ (выбранный цвет)
    ctx.fillStyle = symbolColor;
    if (symbol === '+') {
      drawPlus(ctx, cx, cy, symbolSize, thickness);
    } else if (symbol === '-') {
      drawMinus(ctx, cx, cy, symbolSize, thickness);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 8;
  texture.needsUpdate = true;
  return texture;
}

// ── Кэш текстур ──
// Ключ = `${symbol}|${diceColor}|${symbolColor}`. При смене цвета
// создаются новые текстуры (минимум 3 на комбинацию: +, -, blank).
// Старые текстуры удаляются из кеша через pruneFaceTextureCache() —
// это предотвращает утечку GPU-памяти при частой смене цветов.
const textureCache = new Map<string, THREE.CanvasTexture>();
const TEXTURE_CACHE_MAX = 24; // 8 комбинаций × 3 символов — достаточно

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
    // Prune: удаляем старые неиспользуемые текстуры если кеш переполнен.
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

/** Инвалидировать кеш текстур (вызвать при смене цветов).
 *  Dispose'ит все текстуры и чистит кеш — материалы создадут новые. */
export function invalidateDice3DTextureCache() {
  for (const tex of textureCache.values()) {
    tex.dispose();
  }
  textureCache.clear();
}

// ── Распределение символов по 6 граням (настоящий Fate-кубик: 2×+, 2×−, 2×пусто) ──
// Порядок граней BoxGeometry: 0=+X(right), 1=-X(left), 2=+Y(top), 3=-Y(bottom), 4=+Z(front), 5=-Z(back)
// Результат → top (+Y, индекс 2). Bottom дублирует top. Остальные 4 грани — оставшиеся символы.
function getFaceSymbols(result: number): Array<'+' | '-' | null> {
  if (result > 0) return ['-', null, '+', '+', '-', null];
  if (result < 0) return ['+', null, '-', '-', '+', null];
  return ['+', '-', null, null, '+', '-'];
}

// ── Физические константы ─────────────────────────────────────
const GRAVITY = 22.0;          // м/с² (сильная — кубики маленькие, динамика быстрая)
const RESTITUTION = 0.42;      // насколько упругий подскок (0 = нет, 1 = идеальный)
const FRICTION = 0.42;         // затухание горизонтальной скорости при ударе
const ANGULAR_DAMP = 0.38;     // затухание вращения при ударе (сильнее — куб меньше кувыркается после приземления)
const SETTLE_VEL = 0.9;        // порог: ниже этой скорости кубик "замирает"
const POST_SETTLE_ANG_DECAY = 9.0;  // экспоненциальное затухание вращения после settle (1/с)

// ── Нормали 6 граней куба (в локальных координатах BoxGeometry) ──
// Порядок групп BoxGeometry: 0=+X(right), 1=-X(left), 2=+Y(top), 3=-Y(bottom),
// 4=+Z(front), 5=-Z(back).
const FACE_NORMALS: THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Определяет, какая грань куба (по индексу материала 0..5) сейчас "смотрит вверх"
// — то есть имеет нормаль, наиболее сонаправленную с мировым +Y.
function getUpFaceIndex(rotation: THREE.Euler): number {
  const q = new THREE.Quaternion().setFromEuler(rotation);
  let bestIdx = 2;
  let bestDot = -Infinity;
  for (let i = 0; i < 6; i++) {
    const worldNormal = FACE_NORMALS[i].clone().applyQuaternion(q);
    const dot = worldNormal.dot(WORLD_UP);
    if (dot > bestDot) {
      bestDot = dot;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// Распределяет символы Fate (2×+, 2×−, 2×пусто) по 6 граням так, чтобы
// грань с индексом topFaceIdx показывала результат. Остальные грани
// получают оставшиеся символы в случайном порядке — кубик выглядит как
// настоящий Fate d6, на верхней грани виден результат броска.
function buildFaceSymbolsForTopFace(
  topFaceIdx: number,
  result: number
): Array<'+' | '-' | null> {
  const resultSym: '+' | '-' | null = result > 0 ? '+' : result < 0 ? '-' : null;
  // Остальные 5 символов: судьбоносное распределение минус один результат.
  //   result = + → 1×+, 2×−, 2×пусто
  //   result = − → 2×+, 1×−, 2×пусто
  //   result = 0 → 2×+, 2×−, 1×пусто
  const others: Array<'+' | '-' | null> = [];
  if (result > 0)      others.push('+', '-', '-', null, null);
  else if (result < 0) others.push('-', '+', '+', null, null);
  else                 others.push('+', '+', '-', '-', null);
  // Перемешиваем остальные символы
  for (let i = others.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [others[i], others[j]] = [others[j], others[i]];
  }
  const out: Array<'+' | '-' | null> = new Array(6);
  out[topFaceIdx] = resultSym;
  let oi = 0;
  for (let i = 0; i < 6; i++) {
    if (i === topFaceIdx) continue;
    out[i] = others[oi++];
  }
  return out;
}

// ── Кубик ────────────────────────────────────────────────────

interface DieMeshProps {
  finalValue: number;
  phase: DicePhase;
  scatter: DieScatter3D;
  index: number;
  totalDice: number;
  startTime: number;
  casePosition: [number, number, number];
  /** Per-participant dice body color. If absent, falls back to store (viewer's own). */
  diceColor?: string;
  /** Per-participant symbol color. If absent, falls back to store. */
  symbolColor?: string;
}

// Ещё меньше — кубики компактные, не перекрывают пины на карте.
const DIE_SIZE = 0.32;
const DIE_RADIUS = 0.055;
const DIE_SPACING = 0.46;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function DieMesh({ finalValue, phase, scatter, index, totalDice, startTime, casePosition, diceColor: diceColorProp, symbolColor: symbolColorProp }: DieMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null!);

  // Случайные параметры для естественности (считаются один раз).
  // ВАЖНО: каждый куб имеет свой flightTime, angVel, MAX_BOUNCES —
  // кувыркаются НЕ одновременно, физика выглядит живой.
  // Умеренные угловые скорости: кубики кувыркаются естественно, но
  // не слишком сильно — после приземления они докатываются до
  // почти плоского положения (не стоят на ребре).
  const jitter = useMemo(() => {
    const baseX = (index - (totalDice - 1) / 2) * DIE_SPACING;
    // Случайное количество подскоков: 1-2 (разные кубы делают разное число подскоков)
    const maxBounces = 1 + Math.floor(Math.random() * 2); // 1 или 2
    return {
      // Целевая позиция на карте (куда летит куб). Разброс по обоим осям.
      targetX: baseX + (Math.random() - 0.5) * 0.6,
      targetZ: (Math.random() - 0.5) * 0.9 + 0.5,
      // Умеренные угловые скорости — куб кувыркается 1-2 раза в полёте.
      // Знак случайный (куб может кувыркаться в любую сторону).
      angVelX: (Math.random() - 0.5) * 12 + (Math.random() > 0.5 ? 5 : -5),
      angVelY: (Math.random() - 0.5) * 8,
      angVelZ: (Math.random() - 0.5) * 10 + (Math.random() > 0.5 ? 4 : -4),
      // Время полёта до первого касания — БОЛЬШОЙ разброс (0.45 - 0.72с),
      // чтобы кубы приземлялись в разное время (не одновременно).
      flightTime: 0.45 + Math.random() * 0.27,
      // Сколько подскоков делает этот куб
      maxBounces,
    };
  }, [index, totalDice]);

  const targetX = jitter.targetX;
  const targetZ = jitter.targetZ;

  // ── Кастомизация: цвет тела куба и символа ──
  // Priority: explicit prop (per-participant, for mass rolls) → store (viewer's own).
  // При смене цвета useMemo пересоздаёт материалы с новыми текстурами.
  const storeDiceColor = useFateStore((s) => s.diceColor);
  const storeSymbolColor = useFateStore((s) => s.symbolColor);
  const diceColor = diceColorProp ?? storeDiceColor;
  const symbolColor = symbolColorProp ?? storeSymbolColor;

  // 6 МАТЕРИАЛОВ — по одному на грань. Изначально назначаем по default-раскладке
  // (результат на top). После приземления физикой мы ПЕРЕНАЗНАЧАЕМ текстуры так,
  // чтобы верхняя грань (какой бы она ни оказалась) показывала результат.
  // Это даёт «честное физическое приземление» без странного кувырка-щелчка.
  const materials = useMemo<THREE.MeshStandardMaterial[]>(() => {
    const symbols = getFaceSymbols(finalValue);
    return symbols.map((sym) => new THREE.MeshStandardMaterial({
      map: getFaceTexture(sym, diceColor, symbolColor),
      color: '#ffffff',
      roughness: 0.96,
      metalness: 0.0,
    }));
  }, [finalValue, diceColor, symbolColor]);

  // Переназначает текстуры граней так, чтобы грань, оказавшаяся сверху после
  // физики, показывала результат. Остальные грани получают судьбоносное
  // распределение (2×+, 2×−, 2×пусто). Это происходит ОДИН раз после settle —
  // кубик не делает никакого дополнительного вращения, просто меняются текстуры.
  const relabelTopFace = useCallback((upFaceIdx: number) => {
    const symbols = buildFaceSymbolsForTopFace(upFaceIdx, finalValue);
    materials.forEach((mat, i) => {
      mat.map = getFaceTexture(symbols[i], diceColor, symbolColor);
      mat.needsUpdate = true;
    });
  }, [materials, finalValue, diceColor, symbolColor]);

  useEffect(() => {
    return () => { materials.forEach((m) => m.dispose()); };
  }, [materials]);

  const geometry = useMemo(
    () => makeRoundedBoxGeometry(DIE_SIZE, DIE_RADIUS, 6),
    []
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  // ── Физическое состояние ──
  // Сохраняется между кадрами. Инициализируется при первом входе в 'drop'.
  const physics = useRef({
    initialized: false,      // физика запущена
    launchTime: 0,           // абсолютное время старта броска (не сбрасывается при смене phase)
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    angVel: new THREE.Vector3(),
    bounces: 0,
    settled: false,          // физика завершена, куб замирал
    settleStartTime: 0,      // когда началось затухание вращения
    relabelled: false,       // текстуры переназначены (верхняя грань = результат)
    exitStartTime: 0,
    exitStartPos: new THREE.Vector3(),
    exitStartRot: new THREE.Euler(),
  });

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const p = physics.current;
    const now = performance.now();

    // ── Время старта броска (одно на весь бросок, НЕ сбрасывается при
    // смене phase). При первом входе в 'drop' фиксируем now; при 'enter'
    // сбрасываем.
    if (phase === 'enter') {
      p.launchTime = 0;
    } else if (!p.launchTime) {
      p.launchTime = now;
    }
    const elapsed = p.launchTime ? (now - p.launchTime) / 1000 : 0;

    const [caseX, caseY, caseZ] = casePosition;
    const halfSize = DIE_SIZE / 2;

    // ── ENTER: кубик в кейсе, невидим ──
    if (phase === 'enter') {
      mesh.visible = false;
      mesh.position.set(caseX, caseY, caseZ);
      mesh.scale.setScalar(0.5);
      // Сброс физического состояния для следующего броска
      p.initialized = false;
      p.launchTime = 0;
      p.settled = false;
      p.relabelled = false;
      p.bounces = 0;
      p.exitStartTime = 0;
      // Восстанавливаем «дефолтную» раскладку текстур — результат на top (+Y).
      // Это безопасно: при следующем броске после settle мы всё равно переназначим.
      const defaultSyms = getFaceSymbols(finalValue);
      materials.forEach((mat, i) => {
        mat.map = getFaceTexture(defaultSyms[i], diceColor, symbolColor);
        mat.needsUpdate = true;
      });
      return;
    }

    // ── EXIT: возврат в кейс по дуге, shrink + fade ──
    if (phase === 'exit') {
      if (!p.exitStartTime) {
        p.exitStartTime = now;
        p.exitStartPos.copy(mesh.position);
        p.exitStartRot.copy(mesh.rotation);
      }
      const returnDuration = 0.45;
      const t = clamp01((now - p.exitStartTime) / 1000 / returnDuration);
      const ease = t * t;

      const px = lerp(p.exitStartPos.x, caseX, ease);
      const pz = lerp(p.exitStartPos.z, caseZ, ease);
      const arc = Math.sin(t * Math.PI) * 1.2;
      mesh.position.set(px, Math.max(halfSize, arc) + halfSize * 0.5, pz);

      mesh.rotation.x = p.exitStartRot.x + delta * jitter.angVelX * 0.3 * (1 - t);
      mesh.rotation.y = p.exitStartRot.y + delta * jitter.angVelY * 0.3 * (1 - t);
      mesh.rotation.z = p.exitStartRot.z + delta * jitter.angVelZ * 0.3 * (1 - t);

      mesh.scale.setScalar(1 - 0.6 * ease);

      const mats = mesh.material as THREE.MeshStandardMaterial[];
      mats.forEach((m) => { m.transparent = true; m.opacity = 1 - ease; });
      return;
    }

    // ── DROP / TUMBLE / SETTLE: физика броска ──
    // Эти три фазы объединены в одну непрерывную физическую симуляцию.
    mesh.visible = true;

    // Stagger — каждый куб стартует со своей задержкой (60-300мс),
    // чтобы они не вылетали одновременно.
    const staggerOffset = scatter.dropDelay / 1000;

    // Ещё не время этому кубику — ждёт в кейсе
    if (elapsed < staggerOffset) {
      mesh.visible = false;
      mesh.position.set(caseX, caseY, caseZ);
      mesh.scale.setScalar(0.5);
      return;
    }
    mesh.visible = true;

    const localT = elapsed - staggerOffset;

    // Инициализация физики (первый кадр для этого куба)
    if (!p.initialized) {
      p.initialized = true;
      const h0 = caseY + halfSize; // высота старта (центр куба)
      // Время полёта до первого касания. Из него вычисляем launchVy так,
      // чтобы куб приземлился ровно через flightTime (баллистика):
      //   h0 + vy*t - 0.5*g*t² = 0  →  vy = (0.5*g*t² - h0) / t
      const ft = jitter.flightTime;
      const launchVy = (0.5 * GRAVITY * ft * ft + h0) / ft;
      p.pos.set(caseX, h0, caseZ);
      // Горизонтальная скорость: к цели, равномерно за flightTime
      p.vel.set(
        (targetX - caseX) / ft,
        launchVy,
        (targetZ - caseZ) / ft
      );
      p.angVel.set(jitter.angVelX, jitter.angVelY, jitter.angVelZ);
      p.bounces = 0;
      p.settled = false;
      p.relabelled = false;
    }

    // ── Симуляция физики (если ещё не settle) ──
    const dt = Math.min(delta, 1 / 30);

    if (!p.settled) {
      // Гравитация
      p.vel.y -= GRAVITY * dt;

      // Интеграция позиции
      p.pos.x += p.vel.x * dt;
      p.pos.y += p.vel.y * dt;
      p.pos.z += p.vel.z * dt;

      // Касание земли
      if (p.pos.y <= halfSize) {
        p.pos.y = halfSize;
        // Подскок (если есть энергия и ещё не превышен лимит)
        if (Math.abs(p.vel.y) > SETTLE_VEL && p.bounces < jitter.maxBounces) {
          p.vel.y = -p.vel.y * RESTITUTION;
          // Горизонтальная скорость затухает при каждом касании —
          // куб остаётся примерно там, где упал, но слегка "катится".
          const horizontalDamp = p.bounces === 0 ? 0.18 : 0.05;
          p.vel.x *= horizontalDamp;
          p.vel.z *= horizontalDamp;
          // Вращение затухает, но не полностью — куб ещё кувыркается
          p.angVel.multiplyScalar(ANGULAR_DAMP);
          p.bounces++;
        } else {
          // Замирание: линейную скорость в 0, но УГЛОВУЮ оставляем —
          // куб ещё «катится» по поверхности и естественно замирает.
          p.vel.set(0, 0, 0);
          p.settled = true;
          p.settleStartTime = now;
        }
      }
    } else {
      // После settle — плавное затухание вращения (без резкого обрыва).
      // Куб продолжает вращаться, но всё медленнее — выглядит как
      // естественное «докатывание» до финального положения.
      // Быстрое затухание (9.0/с) — кубик замирает за ~0.3с.
      const decay = Math.exp(-dt * POST_SETTLE_ANG_DECAY);
      p.angVel.multiplyScalar(decay);
      // Полный останов при очень малой скорости
      if (p.angVel.lengthSq() < 0.02) {
        p.angVel.set(0, 0, 0);
      }
    }

    // Применяем позицию
    mesh.position.copy(p.pos);

    // Кувыркание (пропорционально угловой скорости) — всегда, даже после settle
    mesh.rotation.x += p.angVel.x * dt;
    mesh.rotation.y += p.angVel.y * dt;
    mesh.rotation.z += p.angVel.z * dt;

    // Scale: растёт от 0.6 до 1.0 в первые 0.2с (кубик "вылетает")
    const launchScale = clamp01(localT / 0.2);
    mesh.scale.setScalar(0.6 + 0.4 * launchScale);

    // Сброс opacity (на случай если был return)
    const mats = mesh.material as THREE.MeshStandardMaterial[];
    mats.forEach((m) => {
      if (m.opacity < 1) { m.transparent = false; m.opacity = 1; }
    });

    // ── ПЕРЕНАЗНАЧЕНИЕ ТЕКСТУР (один раз сразу после settle). Куб не
    //    делает кувырка-щелчка — он просто лежит там, где его оставила
    //    физика, а мы тихо меняем текстуры так, чтобы верхняя (видимая)
    //    грань показывала результат. Релабел происходит сразу при settle
    //    ПОКА куб ещё докатывается — движение маскирует смену текстуры. ──
    if (p.settled && !p.relabelled) {
      const upFaceIdx = getUpFaceIndex(mesh.rotation);
      relabelTopFace(upFaceIdx);
      p.relabelled = true;
    }

    // Сброс exit-флага (для следующего броска)
    p.exitStartTime = 0;
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
    </mesh>
  );
}

// ── Сцена: камера + свет + кубики ────────────────────────────
interface Dice3DSceneProps {
  finalDice: number[];
  tumbleDice: number[];
  phase: DicePhase;
  scatter: DieScatter3D[];
  startTime: number;
  casePosition?: [number, number, number];
  /** Per-participant dice colors (mass rolls). If absent, each DieMesh reads store. */
  diceColor?: string;
  symbolColor?: string;
}

function Dice3DScene({ finalDice, phase, scatter, startTime, casePosition = DEFAULT_CASE_POSITION, diceColor, symbolColor }: Dice3DSceneProps) {
  return (
    <>
      {/* Матовое освещение */}
      <ambientLight intensity={0.88} />
      <directionalLight
        position={[-5, 8, 4]}
        intensity={0.55}
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-near={0.1}
        shadow-camera-far={20}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={5}
        shadow-camera-bottom={-5}
        shadow-bias={-0.0005}
      />
      <directionalLight position={[5, 3, -2]} intensity={0.18} color="#ffffff" />
      <directionalLight position={[0, 2, -6]} intensity={0.20} color="#ffffff" />

      {finalDice.map((d, i) => (
        <DieMesh
          key={i}
          finalValue={d}
          phase={phase}
          scatter={scatter[i] ?? { x: 0, tiltX: 0, tiltY: 0, z: 2, dropDelay: i * 80 }}
          index={i}
          totalDice={finalDice.length}
          startTime={startTime}
          casePosition={casePosition}
          diceColor={diceColor}
          symbolColor={symbolColor}
        />
      ))}

      <ContactShadows
        position={[0, -0.001, 0]}
        opacity={0.50}
        scale={14}
        blur={2.2}
        far={3.0}
        color="#0a0a1a"
      />
    </>
  );
}

// ── Внешний компонент: Canvas + проверка WebGL ───────────────
interface Dice3DCanvasProps extends Dice3DSceneProps {
  viewport?: DiceViewport;
}

export function Dice3DCanvas(props: Dice3DCanvasProps) {
  const { viewport, ...sceneProps } = props;
  const vp = viewport ?? { panX: 0, panY: 0, zoom: 1 };

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

  if (!webglOk) {
    return null;
  }

  // CSS transform на wrapper — кубы двигаются и масштабируются вместе с картой.
  // transform-origin: 0 0 (top-left) — совпадает с worldToScreen карты:
  //   screen = world * zoom + pan
  // Малый translate(0.5px) подавляет sub-pixel jitter при zoom=1.
  const wrapperStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    transform: `translate(${vp.panX}px, ${vp.panY}px) scale(${vp.zoom})`,
    transformOrigin: '0 0',
    willChange: 'transform',
  };

  return (
    <div
      className="dice-3d-canvas-wrapper"
      style={wrapperStyle}
    >
      <Canvas
        shadows
        camera={{ position: [0, 5.5, 4.8], fov: 35 }}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
        style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
        dpr={[1, 2]}
      >
        <Dice3DScene {...sceneProps} />
      </Canvas>
    </div>
  );
}
