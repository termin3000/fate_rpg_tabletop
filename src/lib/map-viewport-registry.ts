// ============================================================
// map-viewport-registry.ts — реестр viewport-состояния карты
// ============================================================
//
// MapPanel хранит viewport (panX, panY, zoom) и mapImageSize в локальном
// state. Но RollGestureProvider (который живёт в page.tsx, ВЫШЕ MapPanel)
// не имеет доступа к этому state — ему нужно знать прямоугольник карты
// на экране, чтобы вычислить originSide/originX из позиции drop'а.
//
// Решение: module-level singleton, который MapPanel обновляет при каждом
// изменении viewport/mapImageSize, а RollGestureProvider читает при drag end.
//
// Это даёт ТОЧНЫЙ прямоугольник изображения карты на экране (с учётом
// pan/zoom), а не прямоугольник viewport'а (который может быть больше
// или меньше карты при zoom).

export interface MapViewportState {
  /** Экранный прямоугольник viewport'а (data-roll-target элемента). */
  viewportRect: { left: number; top: number; width: number; height: number };
  /** Pan X в world-координатах (px). */
  panX: number;
  /** Pan Y в world-координатах (px). */
  panY: number;
  /** Zoom (1 = 100%). */
  zoom: number;
  /** Natural размер изображения карты (px), или null если карты нет. */
  mapImageSize: { w: number; h: number } | null;
}

let currentState: MapViewportState | null = null;

/**
 * Обновить реестр. Вызывается из MapPanel при каждом изменении viewport
 * или mapImageSize (через useEffect).
 */
export function setMapViewport(state: MapViewportState): void {
  currentState = state;
}

/**
 * Получить текущее viewport-состояние. null если MapPanel ещё не смонтирован.
 */
export function getMapViewport(): MapViewportState | null {
  return currentState;
}

/**
 * Вычислить экранный прямоугольник ИЗОБРАЖЕНИЯ КАРТЫ (не viewport'а!).
 *
 * ВАЖНО: С каноническим world-пространством (CANONICAL_W × CANONICAL_H)
 * изображение размещается в мире через getCanonicalImagePlacement, а
 * затем преобразуется на экран через pan/zoom:
 *   screenPos = worldPos * zoom + pan
 *   screenSize = worldSize * zoom
 *
 * @returns прямоугольник карты на экране {left, top, width, height} или null
 */
export function getMapScreenRect(): { left: number; top: number; width: number; height: number } | null {
  const s = currentState;
  if (!s) return null;

  const vw = s.viewportRect.width;
  const vh = s.viewportRect.height;
  if (vw === 0 || vh === 0) return null;

  // Нет изображения — весь viewport = карта (старое поведение).
  if (!s.mapImageSize || s.mapImageSize.w <= 0 || s.mapImageSize.h <= 0) {
    return { left: s.viewportRect.left, top: s.viewportRect.top, width: vw, height: vh };
  }

  const img = s.mapImageSize;
  const safeZoom = Math.max(0.05, s.zoom);

  // Canonical placement (same math as getCanonicalImagePlacement in
  // game-canvas.tsx — kept in sync here so dice 3D positioning matches).
  const CANONICAL_W = 1920;
  const CANONICAL_H = 1080;
  const fitScale = Math.min(CANONICAL_W / img.w, CANONICAL_H / img.h);
  const mapWorldW = img.w * fitScale;
  const mapWorldH = img.h * fitScale;
  // Center image in canonical canvas.
  const drawX = (CANONICAL_W - mapWorldW) / 2;
  const drawY = (CANONICAL_H - mapWorldH) / 2;

  // Screen position of image top-left (relative to viewport rect origin):
  //   screenX = drawX * zoom + panX
  // Then add viewportRect.left to get absolute screen coords.
  const screenLeft = drawX * safeZoom + s.panX;
  const screenTop = drawY * safeZoom + s.panY;
  const screenW = mapWorldW * safeZoom;
  const screenH = mapWorldH * safeZoom;

  return {
    left: s.viewportRect.left + screenLeft,
    top: s.viewportRect.top + screenTop,
    width: screenW,
    height: screenH,
  };
}
