// ============================================================
// roll-gesture-bus.ts — модульный event bus для жест-броска кубиков
// ============================================================
//
// Жест-бросок: игрок тащит кубы из кейса (DiceStation) на карту
// (GameCanvas). RollGestureProvider (DndContext) вычисляет gesture
// из drop координат и эмитит его через этот bus. RollToolPanel
// подписан на события и вызывает handleRoll(gesture).
//
// Зачем модульный bus вместо zustand slice?
//   - Минимально инвазивно: не трогаем store.ts (он и так огромный).
//   - Gesture — мимолётное событие, не состояние UI. Event bus
//     семантически точнее, чем store-поле.
//   - Подписчик один (активный RollToolPanel), так что Set из 1 элемента.

import { type RollGesture, type ThrowPresetId } from './roll-gesture';
import { getMapScreenRect, getMapViewport } from './map-viewport-registry';

type GestureListener = (gesture: RollGesture) => void;

const listeners = new Set<GestureListener>();

/**
 * Эмитить gesture-событие. Вызывает RollGestureProvider в onDragEnd
 * после вычисления originSide/originX из drop координат.
 */
export function emitRollGesture(gesture: RollGesture): void {
  // Копируем Set чтобы избежать бесконечных циклов если listener
  // внутри callback'а подпишется/отпишется.
  const snapshot = Array.from(listeners);
  for (const listener of snapshot) {
    try {
      listener(gesture);
    } catch (err) {
      console.error('[roll-gesture-bus] listener error:', err);
    }
  }
}

/**
 * Подписаться на gesture-события. Возвращает функцию отписки.
 * Используется в RollToolPanel: useEffect(() => onRollGesture(handleRoll), []).
 */
export function onRollGesture(listener: GestureListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ============================================================
// emitRandomThrowGesture — синтетический бросок из случайной точки
// ============================================================
//
// Альтернатива drag-броску для тех, кто не хочет перетаскивать кубы.
// Кнопка «Бросить» в DiceStation (когда rollMode активен) вызывает эту
// функцию. Она генерирует RollGesture со случайными параметрами:
//   • spawnX/spawnZ — случайная точка на арене (в пределах карты, с отступом)
//   • directionAngle — случайный угол (0..2π) — кубы летят в случайную сторону
//   • swingVelocity — подобрана под выбранный пресет (gentle/normal/power/lob)
//   • presetId — взвешенный случайный (25% gentle / 30% normal / 30% power / 15% lob)
//
// Gesture эмитится через тот же bus, что и drag-бросок → RollToolPanel
// ловит его и вызывает handleRoll(gesture) → executeDiceRoll с random origin
// → physics-service спавнит кубы в случайной точке с импульсом в случайную
// сторону. Результат — каждый бросок уникален по стартовой позиции и силе.
//
// Если карты нет (mapRect null) — fallback на простой gesture без spawnX/spawnZ
// (physics-service использует edge-based позицию, originSide='near').
//
// ── Взвешенное распределение пресетов (разнообразие бросков) ──
// Раньше было `swingVelocity = 0.4 + Math.random() * 1.6` — это давало 25% normal
// и 75% power, но из-за velocityToHorizontalScale (smoothstep) низкие velocity
// (0.4-1.0) масштабировались в слабый импульс (0.086-0.36 от пресета) → почти
// все броски ощущались "мягкими". Чтобы дать variety, теперь ЯВНО выбираем пресет
// из взвешенного распределения и подбираем velocity под него:
//
//   • 25% — gentle  (soft): swingVelocity 0.15-0.30, мягкая дуга
//   • 30% — normal  (medium): swingVelocity 0.45-0.75, обычный бросок
//   • 30% — power   (strong): swingVelocity 1.2-2.5, плоский мощный полёт
//   • 15% — lob     (high arc): swingVelocity 0.8-1.6, подбрасывание вверх
//
// 'scatter' НЕ используется (он для чисто бокового drag-жеста). 'lob' добавлен
// для variety — высокий подброс, кубы падают почти вертикально.
export function emitRandomThrowGesture(): void {
  const mapRect = getMapScreenRect();
  if (!mapRect) {
    // Нет карты — fallback на default gesture (near edge, power preset).
    emitRollGesture({
      originSide: 'near',
      originX: 0,
      presetId: 'power',
      direction: 'up',
      swingVelocity: 1.0,
    });
    return;
  }

  const mapVp = getMapViewport();
  const imgW = mapVp?.mapImageSize?.w ?? mapRect.width;
  const imgH = mapVp?.mapImageSize?.h ?? mapRect.height;
  // arenaHalfW/H — формула из MapPanel/ServerDiceStage (clamp 3.0..8.0).
  const arenaHalfW = Math.max(3.0, Math.min(8.0, imgW / 350));
  const arenaHalfH = Math.max(3.0, Math.min(8.0, imgH / 350));

  // Случайная позиция спавна в пределах арены (с безопасным отступом от краёв,
  // чтобы кубы не появлялись вплотную к стенке и не застревали).
  // Для lob (высокая дуга) спавним ближе к центру — кубы падают почти вертикально.
  // Для power (плоский) можно пошире разброс — кубы летят далеко.
  const r = Math.random();
  let presetId: ThrowPresetId;
  let swingVelocity: number;
  let SAFE_MARGIN: number;
  if (r < 0.25) {
    // Soft throw — gentle preset
    presetId = 'gentle';
    swingVelocity = 0.15 + Math.random() * 0.15;  // 0.15 - 0.30
    SAFE_MARGIN = 1.2;  // мягкий бросок → кубы остаются у спавна
  } else if (r < 0.55) {
    // Normal throw
    presetId = 'normal';
    swingVelocity = 0.45 + Math.random() * 0.30;  // 0.45 - 0.75
    SAFE_MARGIN = 1.0;
  } else if (r < 0.85) {
    // Power throw — flat, strong
    presetId = 'power';
    swingVelocity = 1.2 + Math.random() * 1.3;    // 1.2 - 2.5
    SAFE_MARGIN = 0.7;  // power → кубы летят далеко, можно спавнить у края
  } else {
    // Lob — high arc, slower
    presetId = 'lob';
    swingVelocity = 0.8 + Math.random() * 0.8;    // 0.8 - 1.6
    SAFE_MARGIN = 1.5;  // lob → кубы падают почти вертикально, узкий разброс
  }

  const spanX = Math.max(0.5, arenaHalfW - SAFE_MARGIN);
  const spanZ = Math.max(0.5, arenaHalfH - SAFE_MARGIN);
  const spawnX = (Math.random() * 2 - 1) * spanX;
  const spawnZ = (Math.random() * 2 - 1) * spanZ;

  // Случайный угол направления полёта (полный 360°).
  const directionAngle = Math.random() * Math.PI * 2;

  emitRollGesture({
    originSide: 'near',
    originX: 0,
    presetId,
    direction: 'up',
    directionAngle,
    swingVelocity,
    spawnX,
    spawnZ,
  });
}
