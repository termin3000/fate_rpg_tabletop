'use client';

// ============================================================
// DiceCase3D — настоящие 3D кубики в кейсе (Three.js / R3F)
// ============================================================
// Маленький Canvas внутри DiceCase: 4 настоящих 3D Fate-кубика
// «лежат» в кейсе как физические объекты. На верхней грани каждого
// виден символ последнего результата (+, − или пусто).
//
//   • Тот же стиль кубов, что и на карте: матовый синий пластик,
//     скруглённые рёбра, чистые белые символы
//   • Кубики лежат на «подносе» (тёмная поверхность с лёгким фетром)
//   • Камера под небольшим наклоном — видны верхняя и одна боковая
//     грань каждого кубика (3D-ощущение)
//   • Субъективное освещение: тёплый ambient + мягкий directional
//   • Контактная тень под каждым кубиком
//   • При hover — лёгкое покачивание (как будто кубики задели)
//   • При броске (rolling=true) — кубики исчезают (scale → 0)
//   • При возврате (returning=true) — кубики «приземляются» обратно
//
// Это НЕ переиспользует Dice3DCanvas — у них разные задачи:
// Dice3DCanvas показывает активный бросок на карте (с физикой),
// DiceCase3D показывает «статичную витрину» последнего результата
// в кейсе.

import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
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

// ── Цветовая палитра (как у кубов на карте) ─────────────────
const FACE_SIZE = 256;

// Палитра по умолчанию (синие кубы с белыми символами) — fallback.
// Реальные цвета приходят из store (diceColor, symbolColor) и передаются
// в makeFaceTexture как параметры.
const DEFAULT_BLUE_TOP = '#2196f3';
const DEFAULT_BLUE_MID = '#1976d2';
const DEFAULT_BLUE_BOTTOM = '#0d47a1';

const DEFAULT_SYMBOL_COLOR = '#ffffff';
const DEFAULT_SYMBOL_SHADOW = 'rgba(0, 10, 40, 0.55)';

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
// Принимает цвет тела куба и цвет символа — позволяет менять палитру
// без перезагрузки страницы. Градиент тела выводится через derivePalette().
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

    // Цвет тени подбирается под яркость куба.
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
// Ключ = `${symbol}|${diceColor}|${symbolColor}`. Лимит 24 (8 комбинаций × 3 символов).
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
// Результат → top (+Y, индекс 2). Bottom дублирует top. Остальные 4 грани — оставшиеся символы.
function getFaceSymbols(result: number): Array<'+' | '-' | null> {
  if (result > 0) return ['-', null, '+', '+', '-', null];
  if (result < 0) return ['+', null, '-', '-', '+', null];
  return ['+', '-', null, null, '+', '-'];
}

// ── Размеры кубика в зоне ────────────────────────────────────
// Кубы подобраны так, чтобы 4 штуки в ряд помещались в окно зоны
// «вровень» с 2D-плитками — без переполнения, ровно по краям.
//
// Математика: камера [0, 3.3, 1.08] fov 30° смотрит на origin.
// На ground plane (y=0) видимый half-width ≈ 3.3 × tan(15°) × aspect ≈ 1.9.
// 4 куба со spacing 1.0 занимают 3.0 единиц (well within 3.8 full-width).
// Каждый куб (size 0.85) визуально ~22% ширины зоны — совпадает с 2D-плиткой.
//
// Jitter МИНИМАЛЕН: кубы лежат ровно в ряд, на одном baseline, с лёгким
// разбросом углов (как настоящие кубы, но не "пьяная куча").
const CASE_DIE_SIZE = 0.85;
const CASE_DIE_RADIUS = 0.10;
const CASE_DIE_SPACING = 1.00;

// ── Кубик в кейсе ────────────────────────────────────────────
interface CaseDieMeshProps {
  finalValue: number;
  index: number;
  totalDice: number;
  rolling: boolean;       // true = бросок идёт, кубы исчезают
  returning: boolean;     // true = возврат, кубы «приземляются»
}

function CaseDieMesh({ finalValue, index, totalDice, rolling, returning }: CaseDieMeshProps) {
  const meshRef = useRef<THREE.Mesh>(null!);

  // ── Кастомизация: цвет тела куба и символа из store ──
  const diceColor = useFateStore((s) => s.diceColor);
  const symbolColor = useFateStore((s) => s.symbolColor);

  // Лёгкая случайная ориентация, чтобы кубы лежали не идеально ровно
  // (как настоящие кубы, брошенные на стол). Но верхняя грань всегда = результат.
  // Jitter МИНИМАЛЕН — кубы лежат ровно в ряд на одном baseline, с лёгким
  // разбросом углов (как настоящие кубы, но не "пьяная куча").
  const jitter = useMemo(() => {
    return {
      tiltX: (Math.random() - 0.5) * 0.06,  // ±~2° (было ±5°)
      tiltY: (Math.random() - 0.5) * 0.18,  // ±~5° (вокруг вертикальной оси)
      tiltZ: (Math.random() - 0.5) * 0.06,  // ±~2° (было ±5°)
      // Минимальное смещение по X/Z — кубы лежат почти в идеальном ряду
      offsetX: (Math.random() - 0.5) * 0.04,
      offsetZ: (Math.random() - 0.5) * 0.04,
      // Фаза для idle-покачивания
      idlePhase: Math.random() * Math.PI * 2,
      // Лёгкий наклон при появлении (returning-анимация)
      landDelay: index * 0.08,
    };
  }, [index]);

  // 6 МАТЕРИАЛОВ — по одному на грань. Верхняя грань показывает результат.
  const materials = useMemo<THREE.MeshStandardMaterial[]>(() => {
    const symbols = getFaceSymbols(finalValue);
    return symbols.map((sym) => new THREE.MeshStandardMaterial({
      map: getFaceTexture(sym, diceColor, symbolColor),
      color: '#ffffff',
      roughness: 0.96,
      metalness: 0.0,
    }));
  }, [finalValue, diceColor, symbolColor]);

  useEffect(() => {
    return () => { materials.forEach((m) => m.dispose()); };
  }, [materials]);

  const geometry = useMemo(
    () => makeRoundedBoxGeometry(CASE_DIE_SIZE, CASE_DIE_RADIUS, 6),
    []
  );
  useEffect(() => () => geometry.dispose(), [geometry]);

  // Состояние для returning-анимации
  const animState = useRef({
    returnStartTime: 0,
    returnActive: false,
    settledOpacity: 1,
  });

  useFrame((state, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const now = performance.now();
    const elapsed = now / 1000;

    // Базовая позиция: 4 куба в ряд
    const baseX = (index - (totalDice - 1) / 2) * CASE_DIE_SPACING + jitter.offsetX;
    const baseZ = jitter.offsetZ;
    const halfSize = CASE_DIE_SIZE / 2;

    // ── ROLLING: кубы исчезают (бросок идёт) ──
    if (rolling) {
      const scale = THREE.MathUtils.lerp(mesh.scale.x, 0.0, Math.min(1, delta * 8));
      mesh.scale.setScalar(scale);
      const mats = mesh.material as THREE.MeshStandardMaterial[];
      mats.forEach((m) => { m.transparent = true; m.opacity = scale; });
      mesh.visible = scale > 0.01;
      return;
    }

    mesh.visible = true;

    // ── RETURNING: кубы «приземляются» обратно в кейс ──
    if (returning) {
      if (!animState.current.returnActive) {
        animState.current.returnActive = true;
        animState.current.returnStartTime = now + jitter.landDelay * 1000;
      }
      const t = animState.current.returnStartTime
        ? clamp01((now - animState.current.returnStartTime) / 1000 / 0.45)
        : 0;
      // Изиинг: подпрыгивание вверх, потом приземление
      const arc = Math.sin(t * Math.PI) * 0.6;
      const scale = THREE.MathUtils.lerp(0.2, 1, easeOutBack(t));
      mesh.scale.setScalar(scale);
      mesh.position.set(baseX, halfSize + arc, baseZ);
      mesh.rotation.set(jitter.tiltX, jitter.tiltY, jitter.tiltZ);

      const mats = mesh.material as THREE.MeshStandardMaterial[];
      mats.forEach((m) => { m.transparent = true; m.opacity = clamp01(t * 2); });

      if (t >= 1) {
        animState.current.returnActive = false;
        animState.current.settledOpacity = 1;
      }
      return;
    }

    // ── IDLE: кубы лежат в кейсе, лёгкое покачивание ──
    animState.current.returnActive = false;
    mesh.scale.setScalar(1);

    // Очень лёгкое покачивание (как будто кубы только что упали и слегка качаются)
    const idleSway = Math.sin(elapsed * 0.7 + jitter.idlePhase) * 0.012;
    const idleLift = Math.sin(elapsed * 1.1 + jitter.idlePhase) * 0.008;

    mesh.position.set(baseX, halfSize + idleLift, baseZ);
    mesh.rotation.set(
      jitter.tiltX + idleSway * 0.5,
      jitter.tiltY,
      jitter.tiltZ + idleSway * 0.3
    );

    // Восстанавливаем opacity
    const mats = mesh.material as THREE.MeshStandardMaterial[];
    mats.forEach((m) => {
      if (m.opacity < 1) { m.transparent = false; m.opacity = 1; }
    });
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

// ── Математические утилиты ──
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
function easeOutBack(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// ── Сцена кейса: поднос + кубики + свет ──────────────────────
interface DiceCase3DSceneProps {
  dice: number[];
  rolling: boolean;
  returning: boolean;
}

// CameraRig — направляет камеру на центр подноса. Без этого R3F-камера
// смотрит вдоль -Z горизонтально, и кубы оказываются ниже кадра.
function CaseCameraRig({ target = [0, 0, 0] as [number, number, number] }) {
  const { camera } = useThree();
  const targetVec = useMemo(() => new THREE.Vector3(target[0], target[1], target[2]), [target]);
  useFrame(() => {
    camera.lookAt(targetVec);
  });
  return null;
}

function DiceCase3DScene({ dice, rolling, returning }: DiceCase3DSceneProps) {
  // Без подноса: рамка зоны (CSS) сама по себе ограничивает «стол».
  // Кубы лежат в ряд, как настоящий набор дайсов. Контактные тени
  // под каждым кубом дают ощущение поверхности.
  const trayWidth = dice.length * CASE_DIE_SPACING + 0.8;

  return (
    <>
      <CaseCameraRig target={[0, 0, 0]} />

      {/* Матовое тёплое освещение */}
      <ambientLight intensity={0.85} color="#fff4e0" />
      <directionalLight
        position={[2, 4, 3]}
        intensity={0.55}
        color="#ffeacc"
        castShadow
        shadow-mapSize-width={512}
        shadow-mapSize-height={512}
        shadow-camera-near={0.1}
        shadow-camera-far={10}
        shadow-camera-left={-3}
        shadow-camera-right={3}
        shadow-camera-top={2}
        shadow-camera-bottom={-2}
        shadow-bias={-0.0005}
      />
      {/* Заполняющий свет с противоположной стороны */}
      <directionalLight position={[-3, 2, -1]} intensity={0.22} color="#b8d4f0" />

      {/* Кубики — без подноса, лежат «на» рамке зоны */}
      {dice.map((v, i) => (
        <CaseDieMesh
          key={i}
          finalValue={v}
          index={i}
          totalDice={dice.length}
          rolling={rolling}
          returning={returning}
        />
      ))}

      {/* Контактные тени под кубиками — дают ощущение поверхности */}
      <ContactShadows
        position={[0, 0.001, 0]}
        opacity={0.50}
        scale={trayWidth}
        blur={2.6}
        far={1.5}
        color="#000000"
      />
    </>
  );
}

// ── Внешний компонент: Canvas + проверка WebGL ───────────────
interface DiceCase3DProps {
  dice: number[];
  rolling?: boolean;
  returning?: boolean;
}

export function DiceCase3D({ dice, rolling = false, returning = false }: DiceCase3DProps) {
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

  // Камера: крутой ракурс сверху (почти top-down) с небольшим наклоном,
  // чтобы видеть верхние грани кубов + чуть-чуть боковые — сохраняется
  // ощущение 3D-объёма, но взгляд «сверху на стол».
  // Кубы (size 0.85, spacing 1.0) → 4 куба занимают 3.0 ед. Камера [0, 3.3, 1.08]
  // fov 30° → видимый half-width на ground ≈ 1.9 → full-width 3.8 → 4 куба
  // помещаются с запасом, не переполняя зону.
  // position [0, 3.3, 1.08] → наклон ~72° от горизонтали (~18° от вертикали).
  return (
    <Canvas
      shadows
      camera={{ position: [0, 3.3, 1.08], fov: 30 }}
      gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
      dpr={[1, 2]}
    >
      <DiceCase3DScene dice={dice} rolling={rolling} returning={returning} />
    </Canvas>
  );
}
