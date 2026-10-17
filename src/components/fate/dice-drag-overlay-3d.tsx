'use client';

// ============================================================
// DiceDragOverlay3D — 4 вращающихся 3D-кубика в DragOverlay
// ============================================================
//
// Пока игрок "держит" кубы мышкой (drag-режим), под курсором летят
// 4 НАСТОЯЩИХ 3D-кубика, которые непрерывно вращаются. Это решает
// сразу две задачи:
//
//   1. ВИЗУАЛ: под курсором не статичные "чипы", а живые 3D-кубы —
//      ощущение, что реально "держишь кубы в руке".
//
//   2. РАНДОМ: кубы вращаются всё время drag'а. При отпускании их
//      ТЕКУЩИЕ ориентации (кватернионы) захватываются и передаются
//      в physics-service как initialQuats. Поскольку игрок тащил их
//      произвольное время, ориентации получаются случайными →
//      результат броска становится случайным БЕЗ отдельной фазы
//      перемешивания (SHAKE). Бросок становится БЕСШОВНЫМ:
//      "тащил → отпустил → кубы сразу полетели".
//
// Стиль кубов идентичен DiceCase3D (матовый синий пластик, скруглённые
// рёбра, белые символы +/−/пусто). Но здесь кубы НЕ показывают
// конкретный результат — они просто вращаются как "перемешиваются
// в руке". На гранях видны +/−/пусто в стандартном распределении
// Fate-кубика (2×+, 2×−, 2×пусто), но какая именно грань сверху —
// зависит от текущей ориентации (случайно).
//
// Камера слегка наклонена (как в кейсе) — тот же ракурс, что и у
// лежащих кубов, для визуальной консистентности.

import { useEffect, useMemo, useRef, useImperativeHandle, forwardRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useFateStore } from '@/lib/store';
import { derivePalette, suggestSymbolShadow } from '@/lib/dice-palette';

// ── Кастомная rounded-box геометрия (как в dice-case-3d.tsx) ──
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

// ── Цветовая палитра (как у кубов на карте и в кейсе) ─────────
const FACE_SIZE = 256;

// Палитра по умолчанию — fallback. Реальные цвета приходят из store.
const DEFAULT_BLUE_TOP = '#2196f3';
const DEFAULT_BLUE_MID = '#1976d2';
const DEFAULT_BLUE_BOTTOM = '#0d47a1';

const DEFAULT_SYMBOL_COLOR = '#ffffff';
const DEFAULT_SYMBOL_SHADOW = 'rgba(0, 10, 40, 0.55)';

// ── Утилиты для canvas-рисования (дублируем из dice-case-3d, чтобы
//    не плодить cross-component зависимости) ──
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
// Принимает цвет тела куба и цвет символа — позволяет менять палитру
// без перезагрузки страницы.
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

  // Мягкий диагональный градиент (top-left → bottom-right)
  const grad = ctx.createLinearGradient(0, 0, FACE_SIZE, FACE_SIZE);
  grad.addColorStop(0, pal.top);
  grad.addColorStop(0.5, pal.mid);
  grad.addColorStop(1, pal.bottom);
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

    const shadowColor = suggestSymbolShadow(diceColor);

    ctx.save();
    ctx.fillStyle = shadowColor;
    if (symbol === '+') {
      drawPlus(ctx, cx + 4, cy + 5, symbolSize, thickness);
    } else if (symbol === '-') {
      drawMinus(ctx, cx + 4, cy + 5, symbolSize, thickness);
    }
    ctx.restore();

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

// ── Распределение символов по 6 граням (настоящий Fate-кубик: 2×+, 2×−, 2×пусто) ──
// Порядок граней BoxGeometry: 0=+X(right), 1=-X(left), 2=+Y(top), 3=-Y(bottom), 4=+Z(front), 5=-Z(back)
// Здесь символы раскиданы так, чтобы кубик ВЫГЛЯДЕЛ как Fate-кубик при любом
// повороте — на видимых гранях всегда есть смесь +/−/пусто.
function getFaceSymbols(): Array<'+' | '-' | null> {
  return ['+', '-', null, null, '+', '-'];
}

// ── Размеры кубика в оверлее ──────────────────────────────────
const DRAG_DIE_SIZE = 0.62;
const DRAG_DIE_RADIUS = 0.09;
const DRAG_DIE_SPACING = 0.85;

// ── Вращающийся кубик в оверлее ───────────────────────────────
interface DragDieMeshProps {
  index: number;
  totalDice: number;
  // ref-массив, куда каждый кадр пишется текущий кватернион этого кубика.
  // По наружнему ref'у (DiceDragOverlay3DRef.getQuaternions) читается при
  // drag end — это и есть "случайная стартовая ориентация" для physics-service.
  quatOutRef: React.MutableRefObject<Array<[number, number, number, number]>>;
}

function DragDieMesh({ index, totalDice, quatOutRef }: DragDieMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null!);

  // ── Кастомизация: цвет тела куба и символа из store ──
  const diceColor = useFateStore((s) => s.diceColor);
  const symbolColor = useFateStore((s) => s.symbolColor);

  // Хаотичная ось вращения (нормированная) + скорость для КАЖДОГО кубика.
  // Разные оси → кубы вращаются по-разному → ориентации в момент отпускания
  // получаются независимыми и случайными.
  //
  // Скорость: 8-14 рад/с ≈ 1.3-2.2 оборота/сек. Достаточно быстро, чтобы
  // за типичный drag (0.5-2с) кубы сделали несколько оборотов и их ориентации
  // стали существенно различными между собой и от броска к броску.
  const spin = useMemo(() => {
    let ax = (Math.random() - 0.5) * 2;
    let ay = (Math.random() - 0.5) * 2;
    let az = (Math.random() - 0.5) * 2;
    const alen = Math.sqrt(ax * ax + ay * ay + az * az) || 1;
    ax /= alen; ay /= alen; az /= alen;
    const axis = new THREE.Vector3(ax, ay, az).normalize();
    // Случайная стартовая ориентация — чтобы кубы сразу выглядели "брошенными
    // в руку", а не идеально выровненными.
    const q0 = new THREE.Quaternion();
    q0.setFromAxisAngle(
      new THREE.Vector3(Math.random(), Math.random(), Math.random()).normalize(),
      Math.random() * Math.PI * 2,
    );
    return {
      axis,
      speed: 8 + Math.random() * 6,  // 8-14 рад/с
      q0,
      // Лёгкий "дрожащий" офсет по позиции — кубы "трясутся в руке"
      bobPhase: Math.random() * Math.PI * 2,
      bobAmp: 0.015 + Math.random() * 0.02,
    };
  }, []);

  // 6 МАТЕРИАЛОВ — по одному на грань.
  const materials = useMemo<THREE.MeshStandardMaterial[]>(() => {
    const symbols = getFaceSymbols();
    return symbols.map((sym) => new THREE.MeshStandardMaterial({
      map: getFaceTexture(sym, diceColor, symbolColor),
      color: '#ffffff',
      roughness: 0.96,
      metalness: 0.0,
    }));
  }, [diceColor, symbolColor]);

  useEffect(() => {
    return () => { materials.forEach((m) => m.dispose()); };
  }, [materials]);

  const geometry = useMemo(
    () => makeRoundedBoxGeometry(DRAG_DIE_SIZE, DRAG_DIE_RADIUS, 6),
    []
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Текущий кватернион кубика (обновляется каждый кадр в useFrame)
  const currentQuat = useRef(new THREE.Quaternion());

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    // Базовая позиция: 4 куба в ряд, с лёгким "дрожанием" (трясём в руке)
    const baseX = (index - (totalDice - 1) / 2) * DRAG_DIE_SPACING;
    const t = state.clock.elapsedTime;
    const bobY = Math.sin(t * 6 + spin.bobPhase) * spin.bobAmp;
    const bobX = Math.cos(t * 5.3 + spin.bobPhase) * spin.bobAmp * 0.5;
    mesh.position.set(baseX + bobX, DRAG_DIE_SIZE / 2 + bobY, 0);

    // Вращение: накапливаем кватернион вокруг фиксированной оси.
    // delta ограничен 0.1 (защита от больших скачков при лагах).
    const dt = Math.min(delta, 0.1);
    const angle = spin.speed * dt;
    const deltaQ = new THREE.Quaternion().setFromAxisAngle(spin.axis, angle);
    // Премножаем: вращение в world space (как в applySpin в physics-service)
    currentQuat.current.premultiply(deltaQ);
    // Нормируем (на случай численного дрейфа)
    currentQuat.current.normalize();
    mesh.quaternion.copy(currentQuat.current);

    // Пишем текущий кватернион в наружний ref — его прочитают при drag end.
    quatOutRef.current[index] = [
      currentQuat.current.x,
      currentQuat.current.y,
      currentQuat.current.z,
      currentQuat.current.w,
    ];
  });

  // При монтировании инициализируем кватернион стартовой ориентацией.
  useEffect(() => {
    currentQuat.current.copy(spin.q0);
    if (meshRef.current) meshRef.current.quaternion.copy(spin.q0);
    // Записываем сразу, чтобы даже при мгновенном drag end был валидный кват.
    quatOutRef.current[index] = [
      spin.q0.x,
      spin.q0.y,
      spin.q0.z,
      spin.q0.w,
    ];
  }, [spin.q0, index, quatOutRef]);

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      castShadow
    >
      {materials.map((mat, i) => (
        <primitive key={i} object={mat} attach={`material-${i}`} />
      ))}
    </mesh>
  );
}

// ── Сцена оверлея: кубики + свет ──────────────────────────────
interface DiceDragOverlay3DSceneProps {
  quatOutRef: React.MutableRefObject<Array<[number, number, number, number]>>;
  numDice: number;
}

function DiceDragOverlay3DScene({ quatOutRef, numDice }: DiceDragOverlay3DSceneProps) {
  return (
    <>
      <DragCameraRig target={[0, 0, 0]} />

      {/* Матовое тёплое освещение — как в кейсе */}
      <ambientLight intensity={0.85} color="#fff4e0" />
      <directionalLight
        position={[2, 4, 3]}
        intensity={0.55}
        color="#ffeacc"
      />
      <directionalLight position={[-3, 2, -1]} intensity={0.22} color="#b8d4f0" />

      {Array.from({ length: numDice }).map((_, i) => (
        <DragDieMesh
          key={i}
          index={i}
          totalDice={numDice}
          quatOutRef={quatOutRef}
        />
      ))}
    </>
  );
}

// CameraRig — направляет камеру на центр. Без этого R3F-камера
// смотрит вдоль -Z горизонтально, и кубы оказываются ниже кадра.
function DragCameraRig({ target = [0, 0, 0] as [number, number, number] }) {
  const { camera } = useThree();
  const targetVec = useMemo(() => new THREE.Vector3(target[0], target[1], target[2]), [target]);
  useFrame(() => {
    camera.lookAt(targetVec);
  });
  return null;
}

// ── Imperative ref: позволяет наружнему коду читать текущие кватернионы ──
export interface DiceDragOverlay3DRef {
  /** Возвращает текущие ориентации всех кубиков в виде массива [x,y,z,w].
   *  Используется в onDragEnd RollGestureProvider'а — эти кватернионы
   *  передаются в physics-service как initialQuats. */
  getQuaternions: () => Array<[number, number, number, number]>;
}

interface DiceDragOverlay3DProps {
  numDice?: number;
}

// ── Внешний компонент: Canvas + проверка WebGL ───────────────
export const DiceDragOverlay3D = forwardRef<DiceDragOverlay3DRef, DiceDragOverlay3DProps>(
  function DiceDragOverlay3D({ numDice = 4 }, ref) {
    // Ref-массив для хранения текущих кватернионов каждого кубика.
    // Инициализируется нулевыми кватернионами (валидная "no-rotation"
    // ориентация = [0, 0, 0, 1]). DragDieMesh каждый кадр перезаписывает
    // свой элемент актуальным кватернионом.
    const quatOutRef = useRef<Array<[number, number, number, number]>>(
      Array.from({ length: numDice }, () => [0, 0, 0, 1])
    );

    useImperativeHandle(ref, () => ({
      getQuaternions: () => quatOutRef.current.map((q) => [...q] as [number, number, number, number]),
    }), []);

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

    // Камера: крутой ракурс сверху (как в кейсе), чтобы видеть верхние грани.
    return (
      <Canvas
        camera={{ position: [0, 2.6, 0.95], fov: 32 }}
        gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
        style={{ width: '120px', height: '70px', pointerEvents: 'none' }}
        dpr={[1, 2]}
      >
        <DiceDragOverlay3DScene quatOutRef={quatOutRef} numDice={numDice} />
      </Canvas>
    );
  }
);
