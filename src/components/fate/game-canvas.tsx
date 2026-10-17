'use client';

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';

import type { Character, Drawing, FogArea, Pin, Token, Zone } from '@/lib/types';
import { genId } from '@/lib/fate-dice';
import { charDragState, setCharDrag } from '@/lib/drag-state';
import { useFateStore } from '@/lib/store';
import { useNetwork } from '@/hooks/use-network';

// ── Types ───────────────────────────────────────────────────

interface GameCanvasProps {
  tool: 'select' | 'pen' | 'eraser' | 'zone' | 'fog';
  penColor: string;
  penSize: number;
  tokenRadius: number;
  conflictActiveCharId?: string | null;
  backgroundImage?: string | null;
  masterMode?: boolean;
  /** When true, canvas ignores all pointer events (e.g. while context menu is open) */
  contextMenuOpen?: boolean;
  onTokenMove?: (charId: string, x: number, y: number) => void;
  onZoneCreate?: (x: number, y: number, width: number, height: number) => void;
  onDrawingAdd?: (drawing: Drawing) => void;
  onFogAreaCreate?: (x: number, y: number, width: number, height: number) => void;
  onFogAreaToggle?: (areaId: string) => void;
  onTokenContextMenu?: (charId: string, x: number, y: number) => void;
  onEmptySpaceContextMenu?: (worldX: number, worldY: number, clientX: number, clientY: number) => void;
  /** Right-click on an existing pin: open edit/delete menu */
  onPinContextMenu?: (pinId: string, clientX: number, clientY: number) => void;
  onTokenClick?: (charId: string) => void;
  onTokenSelect?: (charId: string | null) => void;
  onZoneDoubleClick?: (zoneId: string) => void;
  onZoomChange?: (zoom: number) => void;
  /** Called whenever the viewport (pan + zoom) changes — drag, zoom buttons,
   *  wheel zoom, reset. Used by RollStageOverlay to keep 3D dice anchored
   *  to world coordinates of the map. */
  onViewportChange?: (viewport: { panX: number; panY: number; zoom: number }) => void;
  /** Called when Shift+drag from one token to another completes */
  onContextRoll?: (attackerCharId: string, defenderCharId: string) => void;
  /** Called when a character card is dragged from the side panel and dropped on the map */
  onCharacterDrop?: (charId: string, worldX: number, worldY: number) => void;
}

export interface GameCanvasHandle {
  zoomIn: () => void;
  zoomOut: () => void;
  resetView: () => void;
}

// ── Constants ───────────────────────────────────────────────

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.15;
const GRID_SPACING = 40;
const DOT_RADIUS = 2.0;

const PLAYER_COLOR = '#e67e22';
const NPC_COLOR = '#27ae60';

// ── Canonical world space ────────────────────────────────────
// CRITICAL: All token/zone/drawing coordinates are stored in THIS virtual
// canvas space, NOT in the actual screen-pixel space of whoever placed
// them. This makes positions resolution-independent: a token at world
// (960, 540) is at the CENTER of the canonical canvas on EVERY client,
// regardless of their monitor size.
//
// The background image is fit-scaled into this canonical space (not into
// the actual viewport), so the same world coordinate always maps to the
// same spot on the image. Each client then pans/zooms to view a window
// into the canonical space — but the underlying coordinates are shared.
//
// Without this, a GM on 1920×1080 and a player on 1366×768 would see
// tokens in completely different places relative to the map, because the
// old code fit-scaled the image to the ACTUAL canvas (different per
// client) and stored coords in that client-specific pixel space.
const CANONICAL_W = 1920;
const CANONICAL_H = 1080;

/**
 * Compute the background image's placement in CANONICAL world space.
 * Same result on every client → world coordinates are portable.
 *
 * Returns null if there's no background image (caller falls back to
 * treating the whole canonical canvas as the "map").
 */
function getCanonicalImagePlacement(imgW: number, imgH: number) {
  const scale = Math.min(CANONICAL_W / imgW, CANONICAL_H / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  // Center the image inside the canonical canvas.
  const drawX = (CANONICAL_W - drawW) / 2;
  const drawY = (CANONICAL_H - drawH) / 2;
  return { drawX, drawY, drawW, drawH, scale };
}

/**
 * Compute the initial zoom + pan that fit the canonical canvas (and the
 * background image inside it) into the ACTUAL viewport.
 *
 * The zoom is chosen so the IMAGE (not the canonical canvas) fits the
 * viewport with a small margin. The pan centers the image.
 *
 * Math (pan is applied before scale in the render):
 *   screenPos = worldPos * zoom + pan
 *   For the image (drawn at drawX,drawY with size drawW,drawH) to be
 *   centered in the viewport:
 *     drawX*zoom + pan.x + drawW*zoom/2 = viewportW/2
 *   Since drawX = (CANONICAL_W - drawW)/2:
 *     pan.x = viewportW/2 - CANONICAL_W*zoom/2
 *           = (viewportW - CANONICAL_W*zoom) / 2
 */
function computeAutoFit(
  viewportW: number,
  viewportH: number,
  imgPlacement: { drawX: number; drawY: number; drawW: number; drawH: number } | null,
): { zoom: number; pan: { x: number; y: number } } {
  // If we have an image, fit the IMAGE to the viewport (with 4% margin).
  if (imgPlacement && imgPlacement.drawW > 0 && imgPlacement.drawH > 0) {
    const MARGIN = 0.96; // leave 2% margin on each side
    const zoomX = (viewportW * MARGIN) / imgPlacement.drawW;
    const zoomY = (viewportH * MARGIN) / imgPlacement.drawH;
    const zoom = Math.min(zoomX, zoomY, MAX_ZOOM);
    // pan.x = (viewportW - CANONICAL_W*zoom) / 2  (derived above)
    const pan = {
      x: (viewportW - CANONICAL_W * zoom) / 2,
      y: (viewportH - CANONICAL_H * zoom) / 2,
    };
    return { zoom, pan };
  }
  // No image: fit the canonical canvas itself to the viewport.
  const MARGIN = 0.96;
  const zoom = Math.min(
    (viewportW * MARGIN) / CANONICAL_W,
    (viewportH * MARGIN) / CANONICAL_H,
    MAX_ZOOM,
  );
  const pan = {
    x: (viewportW - CANONICAL_W * zoom) / 2,
    y: (viewportH - CANONICAL_H * zoom) / 2,
  };
  return { zoom, pan };
}

// ── Component ───────────────────────────────────────────────

export const GameCanvas = forwardRef<GameCanvasHandle, GameCanvasProps>(
  function GameCanvas(
    {
      tool,
      penColor,
      penSize,
      tokenRadius,
      conflictActiveCharId,
      backgroundImage,
      masterMode,
      contextMenuOpen,
      onTokenMove,
      onZoneCreate,
      onDrawingAdd,
      onFogAreaCreate,
      onFogAreaToggle,
      onTokenContextMenu,
      onEmptySpaceContextMenu,
      onPinContextMenu,
      onTokenClick,
      onTokenSelect,
      onZoneDoubleClick,
      onZoomChange,
      onViewportChange,
      onContextRoll,
      onCharacterDrop,
    },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const rafRef = useRef<number>(0);

    // ── Background image element (HTMLImageElement loaded async) ──
    const bgImageRef = useRef<HTMLImageElement | null>(null);
    const [bgImageLoaded, setBgImageLoaded] = useState(false);

    // ── Avatar images for tokens (preloaded) ──
    const avatarImages = useRef<Map<string, HTMLImageElement>>(new Map());

    useEffect(() => {
      if (!backgroundImage) {
        bgImageRef.current = null;
        // Use microtask to avoid synchronous setState in effect body
        queueMicrotask(() => setBgImageLoaded(false));
        return;
      }
      const img = new Image();
      img.onload = () => {
        bgImageRef.current = img;
        requestAnimationFrame(() => setBgImageLoaded(true));
      };
      img.onerror = () => {
        bgImageRef.current = null;
        requestAnimationFrame(() => setBgImageLoaded(false));
      };
      img.src = backgroundImage;
      return () => {
        img.onload = null;
        img.onerror = null;
      };
    }, [backgroundImage]);

    // ── Store ────────────────────────────────────────────────
    // Subscribe to network state so the component re-renders when
    // isNetworkActive / networkRole / playerAssignments change — this keeps
    // the canControlToken() result and the visual cue for non-controllable
    // tokens in sync as the host reassigns characters mid-session.
    const {
      scenes, currentSceneId, currentFloorIndex, characters, updateScene, currentMode, magicModuleEnabled,
      isNetworkActive, networkRole, networkMyPeerId, playerAssignments,
      canControlToken,
    } = useFateStore();
    // Cursor-move broadcasting (live cursor feature). Throttled to ~30fps
    // inside the hook; we just feed it world coords on every mousemove.
    const { sendCursorMove, sendCursorLeave, broadcastTokenMove } = useNetwork();
    const currentScene = scenes.find((s) => s.id === currentSceneId) ?? null;
    const floors = currentScene?.floors ?? [];
    const currentFloor = floors[currentFloorIndex] ?? null;

    // ── View state ───────────────────────────────────────────
    const [zoom, setZoom] = useState(1);
    const [pan, setPan] = useState({ x: 0, y: 0 });
    const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });

    // ── Interaction state ────────────────────────────────────
    const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
    const [hoveredTokenId, setHoveredTokenId] = useState<string | null>(null);
    const [hoveredZoneId, setHoveredZoneId] = useState<string | null>(null);
    // ── Tooltip structured types ──────────────────────────────
    type TooltipLine =
      | { type: 'text'; text: string; danger?: boolean }
      | { type: 'section'; text: string; danger?: boolean }
      | { type: 'stress'; name: string; markers: boolean[]; trackType?: 'progressive' | 'linear' };

    const [tooltip, setTooltip] = useState<{ x: number; y: number; lines: TooltipLine[] } | null>(null);

    // ── Tooltip suppression (after click, suppress until mouse leaves token) ──
    const tooltipSuppressed = useRef(false);

    // ── Drag state (pan) ────────────────────────────────────
    const isPanning = useRef(false);
    const panStart = useRef({ x: 0, y: 0 });
    const panStartOffset = useRef({ x: 0, y: 0 });

    // ── Token drag state ────────────────────────────────────
    const isDraggingToken = useRef(false);
    const dragTokenId = useRef<string | null>(null);
    const dragOffset = useRef({ x: 0, y: 0 });

    // ── Shift+drag context roll state ──────────────────────
    const isShiftDragging = useRef(false);
    const shiftDragSourceId = useRef<string | null>(null);
    const [shiftDragTarget, setShiftDragTarget] = useState<{ sourceId: string; sourceX: number; sourceY: number; targetX: number; targetY: number } | null>(null);

    // ── Drawing state ───────────────────────────────────────
    const isDrawing = useRef(false);
    const currentDrawing = useRef<Drawing | null>(null);
    const [drawingTick, setDrawingTick] = useState(0); // forces re-render during drawing

    // ── Eraser cursor position ──────────────────────────────
    const eraserCursor = useRef<{ wx: number; wy: number } | null>(null);
    const [eraserTick, setEraserTick] = useState(0); // forces re-render for eraser cursor

    // ── Zone creation state ─────────────────────────────────
    // Polygon-mode: click to add vertices, double-click or Enter to finish
    const isCreatingZone = useRef(false);
    const zoneStart = useRef({ x: 0, y: 0 });
    const [zonePreview, setZonePreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
    // Polygon vertices in progress (world coords) — when non-empty, the zone tool is in polygon mode
    const [polygonVertices, setPolygonVertices] = useState<{ x: number; y: number }[]>([]);
    // Current cursor position in world coords (for the polygon preview line)
    const [polygonCursor, setPolygonCursor] = useState<{ x: number; y: number } | null>(null);

    // ── Fog creation state ────────────────────────────────────
    const isCreatingFog = useRef(false);
    const fogStart = useRef({ x: 0, y: 0 });
    const [fogPreview, setFogPreview] = useState<{ x: number; y: number; w: number; h: number } | null>(null);

    // ── Character drag-and-drop preview state ───────────────
    // isDraggingOver: a character card from the side panel is currently being
    //   dragged over the map. Drives the green drop-zone highlight + animation loop.
    // dragPreviewRef: live world-coords position of the cursor during the drag,
    //   plus the dragged character payload (read from the module-level drag state).
    //   Updated imperatively in onDragOver to avoid per-frame React setState.
    const [isDraggingOver, setIsDraggingOver] = useState(false);
    const dragPreviewRef = useRef<{ charId: string; wx: number; wy: number } | null>(null);

    // ── Double-click detection ──────────────────────────────
    const lastClickTime = useRef(0);
    const lastClickTarget = useRef<string | null>(null);

    // ── Eliminated IDs from conflict data ───────────────────
    const eliminatedIds = currentScene?.conflictData?.eliminatedIds ?? [];

    // ── Zoom level ref for imperative handle ────────────────
    const zoomRef = useRef(zoom);
    const panRef = useRef(pan);

    useEffect(() => { zoomRef.current = zoom; }, [zoom]);
    useEffect(() => { panRef.current = pan; }, [pan]);

    // Notify parent whenever viewport changes — used by RollStageOverlay to
    // keep 3D dice anchored to map world coordinates (pan/zoom follow).
    useEffect(() => {
      onViewportChange?.({ panX: pan.x, panY: pan.y, zoom });
    }, [pan, zoom, onViewportChange]);

    // ── Expose zoom controls ────────────────────────────────
    useImperativeHandle(ref, () => ({
      zoomIn: () => {
        const newZoom = Math.min(MAX_ZOOM, +(zoomRef.current + ZOOM_STEP).toFixed(2));
        setZoom(newZoom);
        onZoomChange?.(newZoom);
      },
      zoomOut: () => {
        const newZoom = Math.max(MIN_ZOOM, +(zoomRef.current - ZOOM_STEP).toFixed(2));
        setZoom(newZoom);
        onZoomChange?.(newZoom);
      },
      resetView: () => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
        onZoomChange?.(1);
      },
    }), [onZoomChange]);

    // ── Coordinate transforms ───────────────────────────────
    const screenToWorld = useCallback(
      (sx: number, sy: number) => ({
        x: (sx - panRef.current.x) / zoomRef.current,
        y: (sy - panRef.current.y) / zoomRef.current,
      }),
      [],
    );

    const worldToScreen = useCallback(
      (wx: number, wy: number) => ({
        x: wx * zoomRef.current + panRef.current.x,
        y: wy * zoomRef.current + panRef.current.y,
      }),
      [],
    );

    // ── Fog area hit testing ──────────────────────────────────
    const getFogAreaAtPos = useCallback(
      (worldX: number, worldY: number): FogArea | null => {
        if (!currentFloor) return null;
        const areas = currentFloor.fogAreas ?? [];
        for (let i = areas.length - 1; i >= 0; i--) {
          const fa = areas[i];
          if (fa.type === 'rect' && fa.points.length >= 2) {
            const [tl, br] = [fa.points[0], fa.points[1]];
            if (worldX >= tl.x && worldX <= br.x && worldY >= tl.y && worldY <= br.y) return fa;
          } else if (fa.type === 'freehand' && fa.points.length >= 3) {
            let inside = false;
            const pts = fa.points;
            for (let j = 0, k = pts.length - 1; j < pts.length; k = j++) {
              if (((pts[j].y > worldY) !== (pts[k].y > worldY)) &&
                (worldX < (pts[k].x - pts[j].x) * (worldY - pts[j].y) / (pts[k].y - pts[j].y) + pts[j].x)) {
                inside = !inside;
              }
            }
            if (inside) return fa;
          }
        }
        return null;
      },
      [currentFloor],
    );

    // ── Get character data ──────────────────────────────────
    const getCharacter = useCallback(
      (charId: string): Character | null => characters.find((c) => c.id === charId) ?? null,
      [characters],
    );

    // ── Preload avatar images for tokens ────────────────────
    useEffect(() => {
      if (!currentFloor) return;
      for (const token of currentFloor.tokens) {
        const char = getCharacter(token.charId);
        if (char?.avatar && !avatarImages.current.has(char.id)) {
          const img = new Image();
          img.onload = () => {
            avatarImages.current.set(char.id, img);
          };
          img.src = char.avatar;
        }
      }
    }, [currentFloor, getCharacter]);

    // ── Hit testing ─────────────────────────────────────────
    const getTokenAtPos = useCallback(
      (worldX: number, worldY: number): Token | null => {
        if (!currentFloor) return null;
        const isMasterMode = masterMode ?? currentMode === 'master';
        for (let i = currentFloor.tokens.length - 1; i >= 0; i--) {
          const t = currentFloor.tokens[i];
          // In player mode, skip hidden characters
          if (!isMasterMode) {
            const char = getCharacter(t.charId);
            if (char?.hiddenFromPlayers) continue;
          }
          const dx = worldX - t.x;
          const dy = worldY - t.y;
          if (dx * dx + dy * dy <= tokenRadius * tokenRadius) return t;
        }
        return null;
      },
      [currentFloor, tokenRadius, masterMode, currentMode, getCharacter],
    );

    const getZoneAtPos = useCallback(
      (worldX: number, worldY: number): Zone | null => {
        if (!currentFloor) return null;
        for (let i = currentFloor.zones.length - 1; i >= 0; i--) {
          const z = currentFloor.zones[i];
          // If the zone has polygon vertices, use point-in-polygon test
          if (z.vertices && z.vertices.length >= 3) {
            if (pointInPolygon(worldX, worldY, z.vertices)) return z;
          } else {
            // Fallback: rectangle hit-test using bounding box
            if (worldX >= z.x && worldX <= z.x + z.width && worldY >= z.y && worldY <= z.y + z.height) {
              return z;
            }
          }
        }
        return null;
      },
      [currentFloor],
    );

    const getPinAtPos = useCallback(
      (worldX: number, worldY: number): Pin | null => {
        if (!currentFloor) return null;
        const threshold = 16;
        for (let i = currentFloor.pins.length - 1; i >= 0; i--) {
          const p = currentFloor.pins[i];
          const dx = worldX - p.x;
          const dy = worldY - p.y;
          if (dx * dx + dy * dy <= threshold * threshold) return p;
        }
        return null;
      },
      [currentFloor],
    );

    // ── Render ──────────────────────────────────────────────
    const render = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const dpr = window.devicePixelRatio || 1;
      const { w, h } = canvasSize;
      if (w === 0 || h === 0) return;

      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.scale(dpr, dpr);

      // ── Detect dark mode (read from <html class="dark">) ────
      const isDark =
        typeof document !== 'undefined' &&
        document.documentElement.classList.contains('dark');
      const bgColor = isDark ? '#1a1d23' : '#faf8f6';
      const dotColor = isDark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.13)';

      // Clear
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, w, h);

      ctx.save();
      ctx.translate(pan.x, pan.y);
      ctx.scale(zoom, zoom);

      // ── Background image ────────────────────────────────────
      // Drawn in CANONICAL world space — same placement on every client
      // regardless of their actual viewport size. This is what makes token
      // coordinates resolution-independent: the image is always at the same
      // world coords, so a token at (x, y) is at the same spot on the image
      // for the GM on 1920×1080 and the player on 1366×768.
      const bgImg = bgImageRef.current;
      if (bgImg && bgImageLoaded && bgImg.naturalWidth > 0 && bgImg.naturalHeight > 0 && w > 0 && h > 0) {
        const imgW = bgImg.naturalWidth;
        const imgH = bgImg.naturalHeight;
        const placement = getCanonicalImagePlacement(imgW, imgH);
        ctx.drawImage(bgImg, placement.drawX, placement.drawY, placement.drawW, placement.drawH);
      }

      // ── Dot grid ──────────────────────────────────────────
      const startX = Math.floor(-pan.x / zoom / GRID_SPACING) * GRID_SPACING - GRID_SPACING;
      const startY = Math.floor(-pan.y / zoom / GRID_SPACING) * GRID_SPACING - GRID_SPACING;
      const endX = startX + w / zoom + GRID_SPACING * 2;
      const endY = startY + h / zoom + GRID_SPACING * 2;

      ctx.fillStyle = dotColor;
      for (let x = startX; x < endX; x += GRID_SPACING) {
        for (let y = startY; y < endY; y += GRID_SPACING) {
          ctx.beginPath();
          ctx.arc(x, y, DOT_RADIUS, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // ── Zones ─────────────────────────────────────────────
      if (currentFloor) {
        for (const zone of currentFloor.zones) {
          const alpha = hoveredZoneId === zone.id ? 0.25 : 0.15;
          const zoneColor = zone.color || '#3498db';
          ctx.fillStyle = hexToRgba(zoneColor, alpha);

          // Draw fill — polygon or rectangle
          if (zone.vertices && zone.vertices.length >= 3) {
            // Polygon zone
            ctx.beginPath();
            ctx.moveTo(zone.vertices[0].x, zone.vertices[0].y);
            for (let i = 1; i < zone.vertices.length; i++) {
              ctx.lineTo(zone.vertices[i].x, zone.vertices[i].y);
            }
            ctx.closePath();
            ctx.fill();
            // Stroke
            ctx.strokeStyle = hexToRgba(zoneColor, hoveredZoneId === zone.id ? 0.9 : 0.6);
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.stroke();
            // Vertex markers (visible on hover)
            if (hoveredZoneId === zone.id) {
              ctx.fillStyle = hexToRgba(zoneColor, 0.9);
              for (const v of zone.vertices) {
                ctx.beginPath();
                ctx.arc(v.x, v.y, 4, 0, Math.PI * 2);
                ctx.fill();
              }
            }
          } else {
            // Rectangular zone (legacy / bounding-box fallback)
            ctx.fillRect(zone.x, zone.y, zone.width, zone.height);
            ctx.strokeStyle = hexToRgba(zoneColor, hoveredZoneId === zone.id ? 0.9 : 0.6);
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.strokeRect(zone.x, zone.y, zone.width, zone.height);
          }

          // ── Magic-module: permanent stress/level badge on the zone ──
          // A small corner badge so the GM can see every zone's rift state
          // at a glance — without hovering each one. Only renders when the
          // magic module is enabled AND the zone has any stress or level > 0.
          if (magicModuleEnabled) {
            const lvl = zone.level ?? 0;
            const stressArr =
              zone.stress && zone.stress.length === 5
                ? zone.stress
                : new Array(5).fill(false);
            const filled = stressArr.filter(Boolean).length;
            const hasStress = filled > 0 || lvl > 0;
            if (hasStress) {
              // Compute bounding box (polygon → from vertices; rect → x/y/w/h)
              let bbX = zone.x, bbY = zone.y, bbW = zone.width, bbH = zone.height;
              if (zone.vertices && zone.vertices.length >= 3) {
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const v of zone.vertices) {
                  if (v.x < minX) minX = v.x;
                  if (v.y < minY) minY = v.y;
                  if (v.x > maxX) maxX = v.x;
                  if (v.y > maxY) maxY = v.y;
                }
                bbX = minX; bbY = minY; bbW = maxX - minX; bbH = maxY - minY;
              }

              // Level color palette: 0=gray, 1=amber, 2=orange, 3=deep red
              const levelColors: Array<{ bg: string; border: string; text: string }> = [
                { bg: 'rgba(120, 120, 120, 0.85)', border: 'rgba(80, 80, 80, 0.9)', text: '#ffffff' },
                { bg: 'rgba(241, 196, 15, 0.92)', border: 'rgba(180, 140, 10, 0.95)', text: '#3d2e00' },
                { bg: 'rgba(230, 126, 34, 0.92)', border: 'rgba(170, 90, 20, 0.95)', text: '#ffffff' },
                { bg: 'rgba(192, 30, 30, 0.94)', border: 'rgba(130, 15, 15, 0.97)', text: '#ffffff' },
              ];
              const lc = levelColors[Math.min(3, Math.max(0, lvl))];

              // Badge position: top-right corner of the zone bounding box,
              // slightly inside (offset 4px) so it sits on the fill.
              const badgeW = 46;
              const badgeH = 18;
              const bx = bbX + bbW - badgeW - 4;
              const by = bbY + 4;

              // Background pill
              ctx.save();
              ctx.setLineDash([]);
              ctx.fillStyle = lc.bg;
              ctx.strokeStyle = lc.border;
              ctx.lineWidth = 1;
              roundRect(ctx, bx, by, badgeW, badgeH, 9);
              ctx.fill();
              ctx.stroke();

              // ⚡ icon (small lightning bolt) on the left
              ctx.fillStyle = lc.text;
              ctx.font = 'bold 11px system-ui, -apple-system, sans-serif';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'middle';
              ctx.fillText('⚡', bx + 5, by + badgeH / 2 + 0.5);

              // Level + stress text: "L{lvl} {filled}/5"
              ctx.font = 'bold 9px system-ui, -apple-system, sans-serif';
              ctx.fillStyle = lc.text;
              ctx.fillText(`L${lvl} ${filled}/5`, bx + 18, by + badgeH / 2 + 0.5);

              ctx.restore();
            }
          }

          // NOTE: Per user request, nothing else is rendered INSIDE the zone —
          // all other info (name, aspects, description) lives in the hover
          // tooltip (see the zoneLines block in handleMouseMove). The badge
          // above is the only persistent overlay, and only when the magic
          // module is enabled.
        }
      }

      // ── Zone preview (rect-drag mode) ──────────────────────
      if (zonePreview && polygonVertices.length === 0) {
        ctx.fillStyle = hexToRgba(penColor, 0.15);
        ctx.fillRect(zonePreview.x, zonePreview.y, zonePreview.w, zonePreview.h);
        ctx.strokeStyle = hexToRgba(penColor, 0.6);
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(zonePreview.x, zonePreview.y, zonePreview.w, zonePreview.h);
        ctx.setLineDash([]);
      }

      // ── Polygon zone preview (vertex-by-vertex mode) ────────
      // Per user request: while the polygon is not yet finished, render ONLY
      // dashed lines — between committed vertices and from the last vertex to
      // the cursor. No fill, no closing edge, no solid stroke. The finished
      // polygon is rendered only after the user completes it (double-click /
      // Enter).
      if (tool === 'zone' && polygonVertices.length > 0) {
        const polyColor = penColor;

        // Dashed line connecting committed vertices
        if (polygonVertices.length >= 2) {
          ctx.beginPath();
          ctx.moveTo(polygonVertices[0].x, polygonVertices[0].y);
          for (let i = 1; i < polygonVertices.length; i++) {
            ctx.lineTo(polygonVertices[i].x, polygonVertices[i].y);
          }
          ctx.strokeStyle = hexToRgba(polyColor, 0.75);
          ctx.lineWidth = 2;
          ctx.setLineDash([7, 5]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Dashed line from last committed vertex to cursor
        if (polygonCursor && polygonVertices.length >= 1) {
          const last = polygonVertices[polygonVertices.length - 1];
          ctx.beginPath();
          ctx.moveTo(last.x, last.y);
          ctx.lineTo(polygonCursor.x, polygonCursor.y);
          ctx.strokeStyle = hexToRgba(polyColor, 0.6);
          ctx.lineWidth = 1.5;
          ctx.setLineDash([5, 4]);
          ctx.stroke();
          ctx.setLineDash([]);
        }

        // Vertex markers
        ctx.fillStyle = hexToRgba(polyColor, 0.95);
        polygonVertices.forEach((v, idx) => {
          ctx.beginPath();
          ctx.arc(v.x, v.y, 5, 0, Math.PI * 2);
          ctx.fill();
          // First vertex is highlighted (click it to close)
          if (idx === 0 && polygonVertices.length >= 3) {
            ctx.strokeStyle = hexToRgba(polyColor, 1);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(v.x, v.y, 9, 0, Math.PI * 2);
            ctx.stroke();
          }
        });

        // (Helper text removed per user request — the toolbar hint was
        // removed too to keep the UI clean. Users can press Enter to
        // finish, Esc to cancel, or click the first vertex to close.)
      }

      // ── Drawings ──────────────────────────────────────────
      if (currentFloor) {
        for (const drawing of currentFloor.drawings) {
          drawSmoothPath(ctx, drawing.points, drawing.color, drawing.size);
        }
      }

      // ── Current freehand drawing (real-time preview) ──────
      const liveDrawing = currentDrawing.current;
      if (liveDrawing && liveDrawing.points.length >= 2) {
        drawSmoothPath(ctx, liveDrawing.points, liveDrawing.color, liveDrawing.size);
      }

      // ── Eraser cursor preview ──────────────────────────────
      if (tool === 'eraser' && eraserCursor.current) {
        const ec = eraserCursor.current;
        ctx.beginPath();
        ctx.arc(ec.wx, ec.wy, penSize * 2, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(231, 76, 60, 0.6)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // ── Pins ──────────────────────────────────────────────
      if (currentFloor) {
        ctx.save();
        // Reset alpha + fillStyle so the first pin's emoji isn't drawn with
        // a leftover low-alpha fillStyle (e.g. from the dot grid) — emojis
        // respect fillStyle alpha on most browsers, which made the first pin
        // appear semi-transparent while subsequent ones were opaque.
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#2c3e50';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Max width for the pin name label on the canvas. Names wider than
        // this are truncated with an ellipsis so a long name can't blow out
        // the map layout or overlap neighbouring tokens/pins.
        const PIN_LABEL_MAX_W = 130;
        for (const pin of currentFloor.pins) {
          ctx.font = '20px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(pin.icon || '📍', pin.x, pin.y);

          if (pin.name) {
            ctx.font = 'bold 10px sans-serif';
            const pinColor = pin.color || '#2c3e50';

            // Truncate the name to PIN_LABEL_MAX_W with an ellipsis.
            // measureText gives us the exact rendered width for the current
            // font, so the cap is pixel-accurate regardless of font fallback.
            let label = pin.name;
            if (ctx.measureText(label).width > PIN_LABEL_MAX_W) {
              const ellipsis = '…';
              // Binary search the longest prefix that fits together with the
              // ellipsis — cheaper than slicing char-by-char for most fonts.
              let lo = 0;
              let hi = label.length;
              while (lo < hi) {
                const mid = Math.ceil((lo + hi) / 2);
                if (ctx.measureText(label.slice(0, mid) + ellipsis).width <= PIN_LABEL_MAX_W) {
                  lo = mid;
                } else {
                  hi = mid - 1;
                }
              }
              label = label.slice(0, lo) + ellipsis;
              // Guard against the degenerate case where even one char + ellipsis
              // is too wide (shouldn't happen at 130px/10px font, but be safe).
              if (ctx.measureText(label).width > PIN_LABEL_MAX_W && label.length > 1) {
                label = ellipsis;
              }
            }

            const textWidth = ctx.measureText(label).width;
            const textY = pin.y + 14;
            const padX = 4;
            const padY = 2;

            // Subtle background pill for contrast against any map background.
            ctx.fillStyle = isDark ? 'rgba(20,20,20,0.72)' : 'rgba(255,255,255,0.82)';
            roundRect(
              ctx,
              pin.x - textWidth / 2 - padX,
              textY - padY,
              textWidth + padX * 2,
              10 + padY * 2,
              4,
            );
            ctx.fill();

            // Name text on top of the pill.
            ctx.fillStyle = pinColor;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(label, pin.x, textY);
            // Reset to a solid color so the next pin's emoji isn't affected
            // by this pin's (potentially custom) color alpha.
            ctx.fillStyle = '#2c3e50';
            ctx.globalAlpha = 1;
          }
        }
        ctx.restore();
      }

      // ── Fog of War ─────────────────────────────────────────
      const isMaster = masterMode ?? currentMode === 'master';
      if (currentFloor && currentFloor.fogEnabled && (currentFloor.fogAreas ?? []).length > 0) {
        const fogAreas = currentFloor.fogAreas ?? [];

        for (const fa of fogAreas) {
          if (!fa.hidden) continue;

          if (fa.type === 'rect' && fa.points.length >= 2) {
            const [tl, br] = [fa.points[0], fa.points[1]];
            if (isMaster) {
              ctx.fillStyle = 'rgba(30, 30, 40, 0.55)';
              ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
              ctx.strokeStyle = 'rgba(230, 126, 34, 0.7)';
              ctx.lineWidth = 2;
              ctx.setLineDash([6, 4]);
              ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
              ctx.setLineDash([]);
            } else {
              ctx.fillStyle = 'rgba(30, 30, 40, 0.85)';
              ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
            }
          } else if (fa.type === 'freehand' && fa.points.length >= 3) {
            ctx.beginPath();
            ctx.moveTo(fa.points[0].x, fa.points[0].y);
            for (let i = 1; i < fa.points.length; i++) {
              ctx.lineTo(fa.points[i].x, fa.points[i].y);
            }
            ctx.closePath();
            if (isMaster) {
              ctx.fillStyle = 'rgba(30, 30, 40, 0.55)';
              ctx.fill();
              ctx.strokeStyle = 'rgba(230, 126, 34, 0.7)';
              ctx.lineWidth = 2;
              ctx.setLineDash([6, 4]);
              ctx.stroke();
              ctx.setLineDash([]);
            } else {
              ctx.fillStyle = 'rgba(30, 30, 40, 0.85)';
              ctx.fill();
            }
          }
        }

        if (isMaster) {
          for (const fa of fogAreas) {
            if (fa.hidden) continue;

            if (fa.type === 'rect' && fa.points.length >= 2) {
              const [tl, br] = [fa.points[0], fa.points[1]];
              ctx.strokeStyle = 'rgba(39, 174, 96, 0.5)';
              ctx.lineWidth = 1.5;
              ctx.setLineDash([4, 3]);
              ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
              ctx.setLineDash([]);
              ctx.font = '12px sans-serif';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.fillText('👁', tl.x + 3, tl.y + 2);
            } else if (fa.type === 'freehand' && fa.points.length >= 3) {
              ctx.beginPath();
              ctx.moveTo(fa.points[0].x, fa.points[0].y);
              for (let i = 1; i < fa.points.length; i++) {
                ctx.lineTo(fa.points[i].x, fa.points[i].y);
              }
              ctx.closePath();
              ctx.strokeStyle = 'rgba(39, 174, 96, 0.5)';
              ctx.lineWidth = 1.5;
              ctx.setLineDash([4, 3]);
              ctx.stroke();
              ctx.setLineDash([]);
              ctx.font = '12px sans-serif';
              ctx.textAlign = 'left';
              ctx.textBaseline = 'top';
              ctx.fillText('👁', fa.points[0].x + 3, fa.points[0].y + 2);
            }
          }
        }
      }

      // ── Fog preview (while drawing) ────────────────────────
      if (fogPreview) {
        ctx.fillStyle = 'rgba(30, 30, 40, 0.35)';
        ctx.fillRect(fogPreview.x, fogPreview.y, fogPreview.w, fogPreview.h);
        ctx.strokeStyle = 'rgba(230, 126, 34, 0.7)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(fogPreview.x, fogPreview.y, fogPreview.w, fogPreview.h);
        ctx.setLineDash([]);
      }

      // ── Tokens ────────────────────────────────────────────
      if (currentFloor) {
        for (const token of currentFloor.tokens) {
          const char = getCharacter(token.charId);
          if (!char) continue;

          // In player mode, skip tokens for characters hidden from players
          if (!isMaster && char.hiddenFromPlayers) continue;

          const isEliminated = eliminatedIds.includes(token.charId);
          const isSelected = selectedTokenId === token.charId;
          const isHovered = hoveredTokenId === token.charId;
          // ── Access control: tokens the current peer can't control (e.g.
          // other players' characters and NPCs for a network player) are
          // rendered with subtle opacity so it's visually clear which tokens
          // they can drag. Host/local sees every token at full opacity.
          const canControl = canControlToken(token.charId);
          const r = tokenRadius;

          ctx.save();

          if (isEliminated) {
            ctx.filter = 'grayscale(1) opacity(0.5)';
          } else if (!canControl) {
            // Subtle dim — keeps the token readable but signals "not yours
            // to move". 0.7 is enough to feel different without hiding it.
            ctx.globalAlpha = 0.7;
          }

          // Conflict active participant: pulsing orange ring
          const isConflictActive = conflictActiveCharId === token.charId;
          if (isConflictActive) {
            const pulsePhase = (Date.now() % 1200) / 1200;
            const pulseRadius = r + 6 + Math.sin(pulsePhase * Math.PI * 2) * 4;
            ctx.beginPath();
            ctx.arc(token.x, token.y, pulseRadius, 0, Math.PI * 2);
            ctx.strokeStyle = '#e67e22';
            ctx.lineWidth = 3;
            ctx.globalAlpha = 0.5 + Math.sin(pulsePhase * Math.PI * 2) * 0.4;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }

          // Selected: pulsing ring
          if (isSelected) {
            const pulsePhase = (Date.now() % 1500) / 1500;
            const pulseRadius = r + 4 + Math.sin(pulsePhase * Math.PI * 2) * 3;
            ctx.beginPath();
            ctx.arc(token.x, token.y, pulseRadius, 0, Math.PI * 2);
            ctx.strokeStyle = char.type === 'player' ? PLAYER_COLOR : NPC_COLOR;
            ctx.lineWidth = 2.5;
            ctx.globalAlpha = 0.6 + Math.sin(pulsePhase * Math.PI * 2) * 0.3;
            ctx.stroke();
            ctx.globalAlpha = 1;
          }

          // Hovered: shadow
          if (isHovered && !isEliminated) {
            ctx.shadowColor = 'rgba(0,0,0,0.3)';
            ctx.shadowBlur = 8;
            ctx.shadowOffsetY = 2;
          }

          // ── Health ring (subtle, not distracting) ──────────────
          const tracks = char.stressTracks ?? [];
          const totalStressSlots = tracks.reduce((sum, t) => sum + t.markers.length, 0);
          const markedStress = tracks.reduce(
            (sum, t) => sum + t.markers.filter(Boolean).length,
            0,
          );
          const unhealedConsequences = (char.consequences ?? []).filter((c) => !c.healed).length;
          const hasCriticalConsequence = unhealedConsequences > 0;
          const healthRatio = totalStressSlots > 0 ? markedStress / totalStressSlots : 0;
          const isCritical = totalStressSlots > 0 ? healthRatio >= 1 || hasCriticalConsequence : hasCriticalConsequence;
          const isWounded = !isCritical && healthRatio >= 0.5;
          const isLightWound = !isCritical && !isWounded && markedStress > 0;

          // Only show health ring when there's actual damage
          if (isLightWound) {
            ctx.beginPath();
            ctx.arc(token.x, token.y, r + 2, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(243, 156, 18, 0.35)';
            ctx.lineWidth = 2;
            ctx.stroke();
          } else if (isWounded) {
            ctx.beginPath();
            ctx.arc(token.x, token.y, r + 2, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(231, 76, 60, 0.5)';
            ctx.lineWidth = 2;
            ctx.stroke();
          } else if (isCritical) {
            const pulse = 0.4 + (Math.sin(Date.now() / 400) + 1) * 0.15;
            ctx.beginPath();
            ctx.arc(token.x, token.y, r + 2, 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(231, 76, 60, ${pulse})`;
            ctx.lineWidth = 3;
            ctx.stroke();
          }

          // Token circle
          const tokenColor = char.type === 'player' ? PLAYER_COLOR : NPC_COLOR;
          ctx.beginPath();
          ctx.arc(token.x, token.y, r, 0, Math.PI * 2);
          ctx.fillStyle = tokenColor;
          ctx.fill();

          ctx.shadowColor = 'transparent';
          ctx.shadowBlur = 0;

          // Border (subtle)
          ctx.strokeStyle = isDark ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.5)';
          ctx.lineWidth = 1.5;
          ctx.stroke();

          // ── Invisible indicator in master mode ──────────────────
          if (isMaster && char.hiddenFromPlayers) {
            ctx.save();
            // Dashed border
            ctx.beginPath();
            ctx.arc(token.x, token.y, r + 1, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(127, 140, 141, 0.7)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 3]);
            ctx.stroke();
            ctx.setLineDash([]);
            // Small eye-off icon in top-right
            const eyeX = token.x + r * 0.65;
            const eyeY = token.y - r * 0.65;
            ctx.beginPath();
            ctx.arc(eyeX, eyeY, 6, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(127, 140, 141, 0.85)';
            ctx.fill();
            ctx.font = 'bold 7px sans-serif';
            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('👁', eyeX, eyeY);
            ctx.restore();
          }

          // ── Crowd member count badge ────────────────────────────
          if (char.isHorde && char.members && char.members.length > 0) {
            const activeCount = char.members.filter((m) => m.isActive).length;
            const badgeR = 9;
            const badgeX = token.x + r * 0.7;
            const badgeY = token.y - r * 0.7;
            // Badge background
            ctx.beginPath();
            ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
            ctx.fillStyle = '#c0392b';
            ctx.fill();
            ctx.strokeStyle = 'white';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            // Number text
            ctx.font = 'bold 9px sans-serif';
            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(activeCount), badgeX, badgeY + 0.5);
          }

          // ── Avatar or initial ──────────────────────────────────
          // Clip to circle for avatar
          ctx.save();
          ctx.beginPath();
          ctx.arc(token.x, token.y, r - 2, 0, Math.PI * 2);
          ctx.clip();

          if (char.avatar) {
            // Draw avatar image (from preloaded images)
            const img = avatarImages.current.get(char.id);
            if (img) {
              const size = (r - 2) * 2;
              ctx.drawImage(img, token.x - r + 2, token.y - r + 2, size, size);
            } else {
              // Fallback to initial if image not loaded
              const initial = char.name.charAt(0).toUpperCase();
              ctx.font = `bold ${Math.max(12, r * 0.9)}px sans-serif`;
              ctx.fillStyle = 'white';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(initial, token.x, token.y);
            }
          } else {
            const initial = char.name.charAt(0).toUpperCase();
            ctx.font = `bold ${Math.max(12, r * 0.9)}px sans-serif`;
            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(initial, token.x, token.y);
          }
          ctx.restore();

          // Name below with background for contrast — adaptive font size
          // Longer names get slightly smaller font to fit more characters
          const nameLen = char.name.length;
          const nameFontSize = nameLen > 16 ? 8 : nameLen > 12 ? 9 : 10;
          ctx.font = `bold ${nameFontSize}px sans-serif`;
          // Allow up to 18 chars before truncating
          const maxChars = 18;
          const nameText = nameLen > maxChars ? char.name.slice(0, maxChars - 1) + '…' : char.name;
          const textMetrics = ctx.measureText(nameText);
          const textWidth = textMetrics.width;
          const textHeight = nameFontSize + 2;
          const nameY = token.y + r + 4;
          const bgPadX = 3;
          const bgPadY = 1;

          // Background pill
          ctx.fillStyle = isEliminated
            ? (isDark ? 'rgba(40,40,40,0.75)' : 'rgba(200,200,200,0.75)')
            : (isDark ? 'rgba(30,30,30,0.8)' : 'rgba(255,255,255,0.8)');
          ctx.beginPath();
          const bgX = token.x - textWidth / 2 - bgPadX;
          const bgY = nameY - bgPadY;
          const bgW = textWidth + bgPadX * 2;
          const bgH = textHeight + bgPadY * 2;
          const bgR = 3;
          // Rounded rect
          ctx.moveTo(bgX + bgR, bgY);
          ctx.lineTo(bgX + bgW - bgR, bgY);
          ctx.quadraticCurveTo(bgX + bgW, bgY, bgX + bgW, bgY + bgR);
          ctx.lineTo(bgX + bgW, bgY + bgH - bgR);
          ctx.quadraticCurveTo(bgX + bgW, bgY + bgH, bgX + bgW - bgR, bgY + bgH);
          ctx.lineTo(bgX + bgR, bgY + bgH);
          ctx.quadraticCurveTo(bgX, bgY + bgH, bgX, bgY + bgH - bgR);
          ctx.lineTo(bgX, bgY + bgR);
          ctx.quadraticCurveTo(bgX, bgY, bgX + bgR, bgY);
          ctx.closePath();
          ctx.fill();

          // Name text
          ctx.fillStyle = isEliminated ? (isDark ? '#666' : '#999') : (isDark ? '#e8eaed' : '#2c2c2c');
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillText(nameText, token.x, nameY);

          // NOTE: Stress boxes under tokens are intentionally removed.
          // Stress is now indicated only by the subtle health ring around the token,
          // the compact stress counter badge (top-left), and the critical corner triangle.
          // Full stress details are available in the character sheet and the hover tooltip.

          // Situational aspects indicator — small diamond + count below name
          const sitAspects = (token.situationalAspects ?? []).filter((a) => a && a.trim());
          if (sitAspects.length > 0) {
            const sitY = token.y + r + 18;
            ctx.font = 'bold 9px sans-serif';
            ctx.fillStyle = '#e67e22';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            const sitText = sitAspects.length === 1
              ? `◆ ${sitAspects[0].length > 12 ? sitAspects[0].slice(0, 11) + '…' : sitAspects[0]}`
              : `◆×${sitAspects.length}`;
            ctx.fillText(sitText, token.x, sitY);
          }

          // Condition badges
          const conditions = token.conditions ?? [];
          if (conditions.length > 0) {
            const badgeR = Math.max(7, Math.min(10, r * 0.36));
            const badgeGap = 2;
            const maxBadges = 4;
            const visible = conditions.slice(0, maxBadges);
            const overflow = conditions.length - maxBadges;
            const totalBadges = visible.length + (overflow > 0 ? 1 : 0);
            const totalWidth = totalBadges * (badgeR * 2) + (totalBadges - 1) * badgeGap;
            const startX = token.x - totalWidth / 2 + badgeR;
            // Position badges below name (and situational aspects if present)
            let badgesY = token.y + r + 20;
            if (sitAspects.length > 0) {
              badgesY += 12; // make room for situational aspect text
            }

            const pulsePhase = (Date.now() % 2000) / 2000;
            const pulse = 0.85 + Math.sin(pulsePhase * Math.PI * 2) * 0.15;

            visible.forEach((cond, idx) => {
              const cx = startX + idx * (badgeR * 2 + badgeGap);
              ctx.beginPath();
              ctx.arc(cx, badgesY, badgeR + 1, 0, Math.PI * 2);
              ctx.fillStyle = hexToRgba(cond.color, 0.25 * pulse);
              ctx.fill();

              ctx.beginPath();
              ctx.arc(cx, badgesY, badgeR, 0, Math.PI * 2);
              ctx.fillStyle = cond.color;
              ctx.globalAlpha = pulse;
              ctx.fill();
              ctx.globalAlpha = 1;

              ctx.strokeStyle = isDark ? 'rgba(0,0,0,0.6)' : 'white';
              ctx.lineWidth = 1.5;
              ctx.stroke();

              ctx.font = `${badgeR + 1}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(cond.icon, cx, badgesY + 0.5);
            });

            if (overflow > 0) {
              const cx = startX + visible.length * (badgeR * 2 + badgeGap);
              ctx.beginPath();
              ctx.arc(cx, badgesY, badgeR, 0, Math.PI * 2);
              ctx.fillStyle = 'rgba(44, 62, 80, 0.85)';
              ctx.fill();
              ctx.strokeStyle = isDark ? 'rgba(0,0,0,0.6)' : 'white';
              ctx.lineWidth = 1.5;
              ctx.stroke();
              ctx.font = `bold ${badgeR}px sans-serif`;
              ctx.fillStyle = 'white';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(`+${overflow}`, cx, badgesY + 0.5);
            }
          }

          // ── Stress count badge (top-left of token) ───────────
          if (markedStress > 0) {
            const badgeR = 9;
            const bx = token.x - r + 2;
            const by = token.y - r + 2;
            ctx.save();
            ctx.beginPath();
            ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
            ctx.fillStyle = isDark ? '#1a1d23' : '#000000';
            ctx.fill();
            ctx.strokeStyle = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.font = 'bold 11px sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(markedStress), bx, by + 0.5);
            ctx.restore();
          }

          // ── Critical corner triangle (top-right of token) ────
          if (isCritical) {
            const triSize = Math.max(8, r * 0.45);
            const cx0 = token.x + r - 2;
            const cy0 = token.y - r + 2;
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(cx0, cy0);
            ctx.lineTo(cx0 + triSize, cy0);
            ctx.lineTo(cx0 + triSize, cy0 + triSize);
            ctx.closePath();
            ctx.fillStyle = '#e74c3c';
            ctx.fill();
            ctx.strokeStyle = isDark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.85)';
            ctx.lineWidth = 1;
            ctx.stroke();
            ctx.restore();
          }

          // ── Eliminated visual effects ────────────────────────
          if (isEliminated) {
            // Reset the grayscale filter for the strike-through and label
            ctx.filter = 'none';

            // Diagonal strikethrough line across token circle
            ctx.beginPath();
            const diagOffset = r * 0.7;
            ctx.moveTo(token.x - diagOffset, token.y - diagOffset);
            ctx.lineTo(token.x + diagOffset, token.y + diagOffset);
            ctx.strokeStyle = '#c0392b';
            ctx.lineWidth = 3;
            ctx.globalAlpha = 0.85;
            ctx.stroke();
            ctx.globalAlpha = 1;

            // "ВЫБЫЛ" label below the token
            ctx.font = 'bold 9px sans-serif';
            ctx.fillStyle = '#c0392b';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            // Position below the name (and situational aspects if present)
            let vyLabelY = token.y + r + 4 + 12; // below name
            const sitAspects = (token.situationalAspects ?? []).filter((a) => a && a.trim());
            if (sitAspects.length > 0) vyLabelY += 12; // below situational aspects
            ctx.fillText('ВЫБЫЛ', token.x, vyLabelY);
          }

          ctx.restore();
        }
      }

      // ── Shift+drag line (context roll indicator) — drawn in world space ─
      if (shiftDragTarget) {
        const sourceToken = currentFloor?.tokens.find((t) => t.charId === shiftDragTarget.sourceId);
        if (sourceToken) {
          ctx.beginPath();
          ctx.moveTo(sourceToken.x, sourceToken.y);
          ctx.lineTo(shiftDragTarget.targetX, shiftDragTarget.targetY);
          ctx.strokeStyle = 'rgba(230, 126, 34, 0.7)';
          ctx.lineWidth = 3 / zoom; // compensate for zoom so line appears consistent
          ctx.setLineDash([8 / zoom, 4 / zoom]);
          ctx.stroke();
          ctx.setLineDash([]);

          // Arrowhead
          const angle = Math.atan2(shiftDragTarget.targetY - sourceToken.y, shiftDragTarget.targetX - sourceToken.x);
          const arrowLen = 14 / zoom;
          ctx.beginPath();
          ctx.moveTo(shiftDragTarget.targetX, shiftDragTarget.targetY);
          ctx.lineTo(
            shiftDragTarget.targetX - arrowLen * Math.cos(angle - Math.PI / 6),
            shiftDragTarget.targetY - arrowLen * Math.sin(angle - Math.PI / 6),
          );
          ctx.moveTo(shiftDragTarget.targetX, shiftDragTarget.targetY);
          ctx.lineTo(
            shiftDragTarget.targetX - arrowLen * Math.cos(angle + Math.PI / 6),
            shiftDragTarget.targetY - arrowLen * Math.sin(angle + Math.PI / 6),
          );
          ctx.strokeStyle = 'rgba(230, 126, 34, 0.9)';
          ctx.lineWidth = 3 / zoom;
          ctx.stroke();

          // "⚔" label at midpoint
          const midX = (sourceToken.x + shiftDragTarget.targetX) / 2;
          const midY = (sourceToken.y + shiftDragTarget.targetY) / 2;
          ctx.font = `bold ${14 / zoom}px sans-serif`;
          ctx.fillStyle = '#e67e22';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('⚔', midX, midY - 12 / zoom);
        }
      }

      // ── Drag-and-drop preview token (world space) ─────────
      // Renders a translucent token at the cursor while a character card is
      // being dragged from the side panel onto the map, so the user sees
      // exactly where the token will land.
      const dragPreview = dragPreviewRef.current;
      const dragPayload = charDragState.current;
      if (dragPreview && dragPayload && dragPayload.charId === dragPreview.charId) {
        const dx = dragPreview.wx;
        const dy = dragPreview.wy;
        const r = tokenRadius;
        const isPlayer = dragPayload.type === 'player';
        const baseColor = isPlayer ? '#e67e22' : '#27ae60';
        // Pulse animation based on time
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
        // Outer glow ring
        ctx.beginPath();
        ctx.arc(dx, dy, r + 6 + pulse * 3, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(baseColor, 0.12 + pulse * 0.08);
        ctx.fill();
        // Translucent token body
        ctx.beginPath();
        ctx.arc(dx, dy, r, 0, Math.PI * 2);
        ctx.fillStyle = hexToRgba(baseColor, 0.55);
        ctx.fill();
        ctx.strokeStyle = hexToRgba(baseColor, 0.95);
        ctx.lineWidth = 2 / zoom;
        ctx.setLineDash([4 / zoom, 3 / zoom]);
        ctx.stroke();
        ctx.setLineDash([]);
        // Initial letter
        const initial = (dragPayload.charName || '?').charAt(0).toUpperCase();
        ctx.font = `bold ${Math.max(12, r * 0.9)}px sans-serif`;
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initial, dx, dy);
        // Small name label below
        ctx.font = `bold ${11 / zoom}px sans-serif`;
        ctx.fillStyle = hexToRgba(baseColor, 0.95);
        ctx.fillText(dragPayload.charName, dx, dy + r + 10 / zoom);
      }

      ctx.restore();

      // ── Drop-zone green highlight (screen space) ──────────
      // When a character is being dragged over the map, tint the entire
      // canvas green and draw a dashed border to signal a valid drop target.
      if (isDraggingOver) {
        const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 280);
        ctx.fillStyle = `rgba(39, 174, 96, ${0.06 + pulse * 0.04})`;
        ctx.fillRect(0, 0, w, h);
        // Dashed green border
        ctx.strokeStyle = `rgba(39, 174, 96, ${0.7 + pulse * 0.2})`;
        ctx.lineWidth = 3;
        ctx.setLineDash([10, 6]);
        ctx.strokeRect(4, 4, w - 8, h - 8);
        ctx.setLineDash([]);
        // Corner badges
        ctx.font = 'bold 11px sans-serif';
        ctx.fillStyle = 'rgba(39, 174, 96, 0.95)';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('▼ Отпустите, чтобы разместить токен', 12, 12);
      }

      // ── Tooltip (screen space) ────────────────────────────
      if (tooltip) {
        const lines = tooltip.lines;
        const lineHeight = 18;
        const padding = 8;
        const stressBoxSize = 10;
        const stressBoxGap = 3;
        // Cap the tooltip width so long aspect names (e.g. rift aspects from
        // level-3 rifts) don't stretch it across the whole screen. Long text
        // lines are word-wrapped across multiple rows instead.
        const MAX_TOOLTIP_WIDTH = 340;

        ctx.font = '12px sans-serif';

        // Word-wrap helper: splits a string into visual lines that fit within
        // `maxInnerW` (in px). Uses greedy word wrapping. Long single words
        // are hard-broken by character to avoid overflow.
        const wrapText = (text: string, maxInnerW: number): string[] => {
          const words = text.split(/\s+/);
          const out: string[] = [];
          let cur = '';
          for (const w of words) {
            const tryLine = cur ? `${cur} ${w}` : w;
            if (ctx.measureText(tryLine).width <= maxInnerW) {
              cur = tryLine;
            } else {
              if (cur) out.push(cur);
              // Word itself longer than maxInnerW — hard-break by chars
              if (ctx.measureText(w).width > maxInnerW) {
                let chunk = '';
                for (const ch of w) {
                  if (ctx.measureText(chunk + ch).width <= maxInnerW) {
                    chunk += ch;
                  } else {
                    if (chunk) out.push(chunk);
                    chunk = ch;
                  }
                }
                cur = chunk;
              } else {
                cur = w;
              }
            }
          }
          if (cur) out.push(cur);
          return out.length ? out : [''];
        };

        // First pass: compute wrapped lines and final width/height
        const innerW = MAX_TOOLTIP_WIDTH - padding * 2;
        type RenderRow =
          | { kind: 'section'; text: string; danger?: boolean }
          | { kind: 'stress'; name: string; markers: boolean[]; trackType?: 'progressive' | 'linear' }
          | { kind: 'text'; text: string; bold?: boolean; bright?: boolean; danger?: boolean };
        const rows: RenderRow[] = [];
        let maxRowWidth = 0;

        for (const line of lines) {
          if (line.type === 'stress') {
            const labelW = ctx.measureText(`  ${line.name}: `).width;
            const boxesW = line.markers.length * (stressBoxSize + stressBoxGap);
            const countW = ctx.measureText(` (${line.markers.filter(Boolean).length}/${line.markers.length})`).width;
            maxRowWidth = Math.max(maxRowWidth, labelW + boxesW + countW);
            rows.push({ kind: 'stress', name: line.name, markers: line.markers, trackType: line.trackType });
          } else if (line.type === 'section') {
            const wrapped = wrapText(line.text, innerW);
            for (const w of wrapped) {
              maxRowWidth = Math.max(maxRowWidth, ctx.measureText(w).width);
              rows.push({ kind: 'section', text: w, danger: line.danger });
            }
          } else {
            const isBold = rows.length === 0; // first row (name) is bold
            ctx.font = isBold ? 'bold 12px sans-serif' : '12px sans-serif';
            const wrapped = wrapText(line.text, innerW);
            for (const w of wrapped) {
              maxRowWidth = Math.max(maxRowWidth, ctx.measureText(w).width);
              rows.push({ kind: 'text', text: w, bold: isBold, bright: isBold, danger: line.danger });
            }
            ctx.font = '12px sans-serif';
          }
        }

        // Final tooltip width: capped at MAX_TOOLTIP_WIDTH, but grows up to
        // maxRowWidth + padding if no wrapping was needed (so short tooltips
        // stay compact).
        let tooltipW = Math.min(MAX_TOOLTIP_WIDTH, maxRowWidth + padding * 2);
        // Never shrink below a sensible minimum so single-word lines have room
        tooltipW = Math.max(tooltipW, 120);
        const tooltipH = rows.length * lineHeight + padding * 2;
        let tx = tooltip.x + 14;
        let ty = tooltip.y - tooltipH / 2;

        if (tx + tooltipW > w) tx = tooltip.x - tooltipW - 14;
        if (tx < 0) tx = 8;
        if (ty < 0) { ty = 0; }
        if (ty + tooltipH > h) { ty = h - tooltipH; }

        ctx.fillStyle = 'rgba(30, 40, 55, 0.95)';
        roundRect(ctx, tx, ty, tooltipW, tooltipH, 6);
        ctx.fill();
        // Subtle border
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        roundRect(ctx, tx, ty, tooltipW, tooltipH, 6);
        ctx.stroke();

        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        let rowIdx = 0;
        for (const row of rows) {
          const ly = ty + padding + rowIdx * lineHeight;

          if (row.kind === 'section') {
            // Section header — e.g. "— Стресс —"
            ctx.font = 'bold 11px sans-serif';
            ctx.fillStyle = row.danger ? 'rgba(231, 76, 60, 0.95)' : 'rgba(255, 165, 0, 0.9)';
            ctx.fillText(row.text, tx + padding, ly + 2);
          } else if (row.kind === 'stress') {
            // Stress track: name + colored boxes with numbers + count
            const marked = row.markers.filter(Boolean).length;
            const total = row.markers.length;

            ctx.font = '12px sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            const labelText = `  ${row.name}: `;
            ctx.fillText(labelText, tx + padding, ly + 2);

            const labelWidth = ctx.measureText(labelText).width;
            const boxStartX = tx + padding + labelWidth;

            // Draw stress boxes with numbers
            const isLinear = row.trackType === 'linear';
            for (let i = 0; i < row.markers.length; i++) {
              const bx = boxStartX + i * (stressBoxSize + stressBoxGap);
              const by = ly + 3;
              const label = String(isLinear ? 1 : i + 1);
              if (row.markers[i]) {
                // Marked stress — filled red box
                ctx.fillStyle = '#e74c3c';
                roundRect(ctx, bx, by, stressBoxSize, stressBoxSize, 2);
                ctx.fill();
                // Number inside (white)
                ctx.font = 'bold 7px sans-serif';
                ctx.fillStyle = 'white';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, bx + stressBoxSize / 2, by + stressBoxSize / 2 + 0.5);
              } else {
                // Unmarked — empty box with border
                ctx.fillStyle = 'rgba(255,255,255,0.08)';
                roundRect(ctx, bx, by, stressBoxSize, stressBoxSize, 2);
                ctx.fill();
                ctx.strokeStyle = 'rgba(255,255,255,0.25)';
                ctx.lineWidth = 0.8;
                roundRect(ctx, bx, by, stressBoxSize, stressBoxSize, 2);
                ctx.stroke();
                // Number inside (muted)
                ctx.font = '7px sans-serif';
                ctx.fillStyle = 'rgba(255,255,255,0.35)';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(label, bx + stressBoxSize / 2, by + stressBoxSize / 2 + 0.5);
              }
            }

            // Count label after boxes
            const boxesEndX = boxStartX + row.markers.length * (stressBoxSize + stressBoxGap);
            ctx.font = '11px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillStyle = marked > 0 ? '#e74c3c' : 'rgba(255,255,255,0.5)';
            ctx.fillText(`(${marked}/${total})`, boxesEndX, ly + 3);
          } else {
            // Regular text line
            ctx.font = row.bold ? 'bold 12px sans-serif' : '12px sans-serif';
            if (row.danger) {
              ctx.fillStyle = '#e74c3c';
            } else if (row.bright) {
              ctx.fillStyle = 'white';
            } else {
              ctx.fillStyle = 'rgba(255,255,255,0.85)';
            }
            ctx.fillText(row.text, tx + padding, ly + 2);
          }
          rowIdx++;
        }
      }
    }, [
      canvasSize, zoom, pan, currentFloor, tokenRadius,
      selectedTokenId, hoveredTokenId, hoveredZoneId,
      eliminatedIds, conflictActiveCharId, tooltip, zonePreview, fogPreview, getCharacter, penColor,
      bgImageLoaded, backgroundImage, masterMode, currentMode, drawingTick, eraserTick, tool, penSize, shiftDragTarget, avatarImages,
      polygonVertices, polygonCursor, isDraggingOver, magicModuleEnabled,
      canControlToken,
    ]);

    // Keep dragPreviewRef in sync with charDragState so the animation loop
    // re-renders the preview token smoothly. We tie it to drawingTick so each
    // animation frame picks up the latest cursor position stored imperatively.
    useEffect(() => {
      // no-op; dependency on drawingTick ensures ref is read on re-render
    }, [drawingTick, isDraggingOver]);

    // ── Animation loop for pulsing effects + drawing preview ──
    const hasConditions = currentFloor?.tokens.some((t) => (t.conditions ?? []).length > 0) ?? false;
    const hasWoundedTokens = (currentFloor?.tokens ?? []).some((t) => {
      const c = getCharacter(t.charId);
      if (!c) return false;
      const marked = (c.stressTracks ?? []).reduce(
        (sum, tr) => sum + tr.markers.filter(Boolean).length,
        0,
      );
      if (marked > 0) return true;
      return (c.consequences ?? []).some((cs) => !cs.healed);
    });
    // Run animation loop when: tokens need pulsing OR we are actively drawing
    // OR a character is being dragged over the map (for live preview token)
    const needsAnimationLoop = !!(selectedTokenId || conflictActiveCharId || hasConditions || hasWoundedTokens || isDraggingOver);
    useEffect(() => {
      if (needsAnimationLoop || isDrawing.current) {
        const tick = () => {
          render();
          rafRef.current = requestAnimationFrame(tick);
        };
        rafRef.current = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(rafRef.current);
      }
    }, [needsAnimationLoop, render]);

    // ── Resize observer ─────────────────────────────────────
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const { width, height } = entry.contentRect;
          setCanvasSize({ w: Math.floor(width), h: Math.floor(height) });
        }
      });

      observer.observe(container);
      return () => observer.disconnect();
    }, []);

    // ── Auto-fit: center the canonical world in the viewport ──
    // Fires on three occasions:
    //   1. Scene change (currentSceneId changes) — reset the view for the
    //      new map so the player isn't looking at empty space.
    //   2. Background image load (bgImageLoaded flips to true) — now that
    //      we know the image dimensions, we can fit it properly.
    //   3. First canvas size measurement (canvasSize goes from 0→real) —
    //      the initial mount, before which we can't compute a fit.
    //
    // We use a ref-guarded "hasFitForScene" so that we only auto-fit ONCE
    // per scene — the user's manual pan/zoom after that is respected.
    // Switching back to a previously-visited scene re-fits (intentional:
    // it's jarring to switch scenes and see the wrong view).
    const lastFitSceneId = useRef<string | null>(null);
    useEffect(() => {
      // Need a real canvas size and (if there's a background) a loaded
      // image before we can compute a meaningful fit.
      if (canvasSize.w === 0 || canvasSize.h === 0) return;
      if (backgroundImage && !bgImageLoaded) return;
      // Only fit once per scene change.
      if (lastFitSceneId.current === currentSceneId) return;
      lastFitSceneId.current = currentSceneId;

      const bgImg = bgImageRef.current;
      let imgPlacement: { drawX: number; drawY: number; drawW: number; drawH: number } | null = null;
      if (bgImg && bgImageLoaded && bgImg.naturalWidth > 0 && bgImg.naturalHeight > 0) {
        imgPlacement = getCanonicalImagePlacement(bgImg.naturalWidth, bgImg.naturalHeight);
      }
      const { zoom: fitZoom, pan: fitPan } = computeAutoFit(
        canvasSize.w,
        canvasSize.h,
        imgPlacement,
      );
      // Defer the setState calls via a microtask so they're not invoked
      // synchronously inside the effect body (which the
      // `react-hooks/set-state-in-effect` lint rule flags). This is an
      // external-state sync (canvas size + image load → viewport), which
      // is exactly what effects are for — the deferral is just to satisfy
      // the linter without changing behavior.
      queueMicrotask(() => {
        setZoom(fitZoom);
        setPan(fitPan);
        onZoomChange?.(fitZoom);
      });
      // onViewportChange will fire from the pan/zoom state effect.
    }, [canvasSize, bgImageLoaded, backgroundImage, currentSceneId, onZoomChange]);

    // ── Re-render when data changes ─────────────────────────
    useEffect(() => {
      render();
    }, [render]);

    // ── Notify parent of selection changes ──────────────────
    useEffect(() => {
      onTokenSelect?.(selectedTokenId);
    }, [selectedTokenId, onTokenSelect]);

    // ── Re-render when theme (dark mode) changes ────────────
    useEffect(() => {
      const root = document.documentElement;
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.attributeName === 'class') {
            render();
            break;
          }
        }
      });
      observer.observe(root, { attributes: true, attributeFilter: ['class'] });
      return () => observer.disconnect();
    }, [render]);

    // ── Persist token position ──────────────────────────────
    // LATENCY FIX: granular broadcast FIRST (100 байт, мгновенно), затем
    // updateScene для DB-персистенса. Раньше updateScene слал ВЕСЬ массив
    // floors (~10KB+) каждому peer — JSON.stringify блокировал main thread,
    // а при >16KB DataChannel.send молча dropал сообщение.
    const persistTokenPosition = useCallback(
      async (charId: string, x: number, y: number) => {
        if (!currentScene || !currentFloor) return;
        // Granular broadcast — peers видят move за ~0ms (DataChannel latency).
        // Нет coalescing, нет JSON.stringify большого payload.
        try {
          broadcastTokenMove(currentScene.id, currentFloorIndex, charId, x, y);
        } catch (e) {
          console.warn('[game-canvas] broadcastTokenMove failed:', e);
        }
        // DB-персистенс: обновляем local state + persist в SQLite.
        // updateScene тоже broadcastит (через broadcastSceneUpdate), но
        // peers уже получили granular action — дубликат не страшен (merge
        // того же token position = no-op визуально). Coalescing 16ms
        // сглаживает rapid drags.
        const updatedTokens = currentFloor.tokens.map((t) =>
          t.charId === charId ? { ...t, x, y } : t,
        );
        const updatedFloors = [...floors];
        updatedFloors[currentFloorIndex] = { ...currentFloor, tokens: updatedTokens };
        await updateScene(currentScene.id, { floors: updatedFloors });
        onTokenMove?.(charId, x, y);
      },
      [currentScene, currentFloor, floors, currentFloorIndex, updateScene, onTokenMove, broadcastTokenMove],
    );

    // ── Persist drawing ─────────────────────────────────────
    const persistDrawing = useCallback(
      async (drawing: Drawing) => {
        if (!currentScene || !currentFloor) return;
        const updatedDrawings = [...currentFloor.drawings, drawing];
        const updatedFloors = [...floors];
        updatedFloors[currentFloorIndex] = { ...currentFloor, drawings: updatedDrawings };
        await updateScene(currentScene.id, { floors: updatedFloors });
        onDrawingAdd?.(drawing);
      },
      [currentScene, currentFloor, floors, currentFloorIndex, updateScene, onDrawingAdd],
    );

    // ── Erase at position (segment-level eraser) ────────────
    const eraseAtPos = useCallback(
      async (worldX: number, worldY: number) => {
        if (!currentScene || !currentFloor) return;

        const eraserRadius = penSize * 2;
        const updatedDrawings: Drawing[] = [];

        for (const drawing of currentFloor.drawings) {
          // Check which points are within eraser radius
          const pointStatuses = drawing.points.map((p) => {
            const dx = worldX - p.x;
            const dy = worldY - p.y;
            return dx * dx + dy * dy <= eraserRadius * eraserRadius;
          });

          // If no points are hit, keep the drawing as-is
          if (!pointStatuses.some(Boolean)) {
            updatedDrawings.push(drawing);
            continue;
          }

          // Split the drawing into segments around erased points
          const segments: { x: number; y: number }[][] = [];
          let currentSegment: { x: number; y: number }[] = [];

          for (let i = 0; i < drawing.points.length; i++) {
            if (pointStatuses[i]) {
              // This point is erased — end current segment
              if (currentSegment.length >= 2) {
                segments.push(currentSegment);
              }
              currentSegment = [];
            } else {
              currentSegment.push(drawing.points[i]);
            }
          }
          // Don't forget the last segment
          if (currentSegment.length >= 2) {
            segments.push(currentSegment);
          }

          // Add each segment as a separate drawing (same color/size)
          for (const seg of segments) {
            updatedDrawings.push({
              points: seg,
              color: drawing.color,
              size: drawing.size,
            });
          }
        }

        const updatedFloors = [...floors];
        updatedFloors[currentFloorIndex] = { ...currentFloor, drawings: updatedDrawings };
        await updateScene(currentScene.id, { floors: updatedFloors });
      },
      [currentScene, currentFloor, floors, currentFloorIndex, updateScene, penSize],
    );

    // ── Create zone ─────────────────────────────────────────
    const createZone = useCallback(
      async (x: number, y: number, width: number, height: number) => {
        if (!currentScene || !currentFloor) return;
        const newZone: Zone = {
          id: genId(),
          name: 'Новая зона',
          x, y, width, height,
          color: penColor,
          level: 0,
          stress: [],
          aspects: [],
        };
        const updatedZones = [...currentFloor.zones, newZone];
        const updatedFloors = [...floors];
        updatedFloors[currentFloorIndex] = { ...currentFloor, zones: updatedZones };
        await updateScene(currentScene.id, { floors: updatedFloors });
        onZoneCreate?.(x, y, width, height);
      },
      [currentScene, currentFloor, floors, currentFloorIndex, updateScene, penColor, onZoneCreate],
    );

    // ── Create polygon zone (vertices-based) ──────────────────
    const createPolygonZone = useCallback(
      async (vertices: { x: number; y: number }[]) => {
        if (!currentScene || !currentFloor) return;
        if (vertices.length < 3) return;
        const bbox = polygonBoundingBox(vertices);
        const newZone: Zone = {
          id: genId(),
          name: 'Новая зона',
          x: bbox.x,
          y: bbox.y,
          width: bbox.width,
          height: bbox.height,
          vertices,
          color: penColor,
          level: 0,
          stress: [],
          aspects: [],
        };
        const updatedZones = [...currentFloor.zones, newZone];
        const updatedFloors = [...floors];
        updatedFloors[currentFloorIndex] = { ...currentFloor, zones: updatedZones };
        await updateScene(currentScene.id, { floors: updatedFloors });
        onZoneCreate?.(bbox.x, bbox.y, bbox.width, bbox.height);
      },
      [currentScene, currentFloor, floors, currentFloorIndex, updateScene, penColor, onZoneCreate],
    );

    // ── Finish polygon zone (called on double-click or Enter) ──
    const finishPolygonZone = useCallback(async () => {
      if (polygonVertices.length >= 3) {
        // Double-click adds a duplicate vertex at the end — remove it if the last two
        // vertices are within a small threshold of each other
        let verts = polygonVertices;
        if (verts.length >= 2) {
          const last = verts[verts.length - 1];
          const prev = verts[verts.length - 2];
          const dx = last.x - prev.x;
          const dy = last.y - prev.y;
          if (dx * dx + dy * dy < 25) { // within 5px
            verts = verts.slice(0, -1);
          }
        }
        if (verts.length >= 3) {
          await createPolygonZone(verts);
        }
      }
      setPolygonVertices([]);
      setPolygonCursor(null);
    }, [polygonVertices, createPolygonZone]);

    // ── Cancel polygon zone (called on Escape or tool change) ──
    const cancelPolygonZone = useCallback(() => {
      setPolygonVertices([]);
      setPolygonCursor(null);
    }, []);

    // ── Mouse helpers ───────────────────────────────────────
    const getMousePos = useCallback(
      (e: React.MouseEvent) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return { sx: 0, sy: 0, wx: 0, wy: 0 };
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const world = screenToWorld(sx, sy);
        return { sx, sy, wx: world.x, wy: world.y };
      },
      [screenToWorld],
    );

    // ── Mouse event handlers ────────────────────────────────
    const handleMouseDown = useCallback(
      (e: React.MouseEvent) => {
        // Ignore all canvas mouse events while context menu is open
        if (contextMenuOpen) return;

        const { sx, sy, wx, wy } = getMousePos(e);

        // Middle mouse → pan
        if (e.button === 1) {
          e.preventDefault();
          isPanning.current = true;
          panStart.current = { x: sx, y: sy };
          panStartOffset.current = { ...panRef.current };
          return;
        }

        // Right-click is handled by onContextMenu handler
        if (e.button === 2) {
          return;
        }

        if (e.button === 0) {
          // Close tooltip on any left click and suppress re-appearance
          setTooltip(null);
          tooltipSuppressed.current = true;

          switch (tool) {
            case 'select': {
              const token = getTokenAtPos(wx, wy);
              if (token) {
                const now = Date.now();
                if (now - lastClickTime.current < 400 && lastClickTarget.current === token.charId) {
                  onTokenClick?.(token.charId);
                  lastClickTime.current = 0;
                  lastClickTarget.current = null;
                  return;
                }
                lastClickTime.current = now;
                lastClickTarget.current = token.charId;

                // Shift+click on token = start shift+drag for context roll
                if (e.shiftKey) {
                  isShiftDragging.current = true;
                  shiftDragSourceId.current = token.charId;
                  setShiftDragTarget({ sourceId: token.charId, sourceX: token.x, sourceY: token.y, targetX: wx, targetY: wy });
                  setSelectedTokenId(token.charId);
                  return;
                }

                setSelectedTokenId(token.charId);
                // ── Access control: only allow drag if the current peer can
                // control this token (host/local → always; network player →
                // only their assigned character). Selection is still allowed
                // for everyone (click to view, double-click for character
                // sheet) — we just refuse to start a drag.
                if (canControlToken(token.charId)) {
                  isDraggingToken.current = true;
                  dragTokenId.current = token.charId;
                  dragOffset.current = { x: wx - token.x, y: wy - token.y };
                }
              } else {
                const zone = getZoneAtPos(wx, wy);
                if (zone) {
                  const now = Date.now();
                  if (now - lastClickTime.current < 400 && lastClickTarget.current === `zone-${zone.id}`) {
                    onZoneDoubleClick?.(zone.id);
                    lastClickTime.current = 0;
                    lastClickTarget.current = null;
                    return;
                  }
                  lastClickTime.current = now;
                  lastClickTarget.current = `zone-${zone.id}`;
                  // Select zone (highlight it)
                  setHoveredZoneId(zone.id);
                } else {
                  const pin = getPinAtPos(wx, wy);
                  if (pin) {
                    const now = Date.now();
                    if (now - lastClickTime.current < 400 && lastClickTarget.current === `pin-${pin.id}`) {
                      lastClickTime.current = 0;
                      lastClickTarget.current = null;
                      return;
                    }
                    lastClickTime.current = now;
                    lastClickTarget.current = `pin-${pin.id}`;
                  }
                  // Left click on empty space: just deselect, do NOT pan
                  setSelectedTokenId(null);
                  setHoveredZoneId(null);
                }
              }
              break;
            }
            case 'pen': {
              isDrawing.current = true;
              currentDrawing.current = {
                points: [{ x: wx, y: wy }],
                color: penColor,
                size: penSize,
              };
              setDrawingTick((t) => t + 1); // trigger re-render for animation loop
              break;
            }
            case 'eraser': {
              eraseAtPos(wx, wy);
              break;
            }
            case 'zone': {
              // ── Polygon-mode: each click adds a vertex. ──
              // Click near the first vertex (when ≥3 vertices exist) closes
              // the polygon and finishes it. Drag from one point to another
              // adds the start point on mousedown and the end point on mouseup.
              const CLOSE_THRESHOLD = 12; // px in world coords
              if (polygonVertices.length >= 3) {
                const first = polygonVertices[0];
                const dx = wx - first.x;
                const dy = wy - first.y;
                if (Math.sqrt(dx * dx + dy * dy) <= CLOSE_THRESHOLD) {
                  // Clicked on the first vertex — close & finish
                  void finishPolygonZone();
                  return;
                }
              }
              setPolygonVertices((prev) => [...prev, { x: wx, y: wy }]);
              // Track drag start so mouseUp can add a second vertex if the
              // user dragged (instead of just clicking).
              isCreatingZone.current = true;
              zoneStart.current = { x: wx, y: wy };
              break;
            }
            case 'fog': {
              isCreatingFog.current = true;
              fogStart.current = { x: wx, y: wy };
              setFogPreview({ x: wx, y: wy, w: 0, h: 0 });
              break;
            }
          }
        }
      },
      [
        getMousePos, tool, penColor, penSize, contextMenuOpen,
        getTokenAtPos, getZoneAtPos, getPinAtPos, getFogAreaAtPos,
        eraseAtPos, onTokenContextMenu, onFogAreaToggle, onTokenClick, onZoneDoubleClick,
        polygonVertices, finishPolygonZone,
        canControlToken,
      ],
    );

    // ── Double-click handler: finishes polygon zone if in progress ──
    const handleDoubleClick = useCallback(
      (e: React.MouseEvent) => {
        if (tool === 'zone' && polygonVertices.length >= 3) {
          e.preventDefault();
          void finishPolygonZone();
          isCreatingZone.current = false;
          setZonePreview(null);
        }
      },
      [tool, polygonVertices, finishPolygonZone],
    );

    // ── Cancel polygon when tool changes away from 'zone' ──
    useEffect(() => {
      if (tool !== 'zone' && polygonVertices.length > 0) {
        // Defer the state update to avoid synchronous setState in effect
        const t = setTimeout(() => cancelPolygonZone(), 0);
        return () => clearTimeout(t);
      }
    }, [tool, polygonVertices.length, cancelPolygonZone]);

    // ── Keyboard handler: Enter finishes polygon, Escape cancels ──
    useEffect(() => {
      if (tool !== 'zone') return;
      const handler = (e: KeyboardEvent) => {
        if (e.key === 'Enter' && polygonVertices.length >= 3) {
          e.preventDefault();
          void finishPolygonZone();
        } else if (e.key === 'Escape' && polygonVertices.length > 0) {
          e.preventDefault();
          cancelPolygonZone();
        } else if (e.key === 'Backspace' && polygonVertices.length > 0) {
          // Undo last vertex
          e.preventDefault();
          setPolygonVertices((prev) => prev.slice(0, -1));
        }
      };
      window.addEventListener('keydown', handler);
      return () => window.removeEventListener('keydown', handler);
    }, [tool, polygonVertices, finishPolygonZone, cancelPolygonZone]);

    const handleMouseMove = useCallback(
      (e: React.MouseEvent) => {
        // Ignore all canvas mouse events while context menu is open
        if (contextMenuOpen) return;

        const { sx, sy, wx, wy } = getMousePos(e);

        // Broadcast my cursor position to remote peers (live cursor feature).
        // Throttled to ~30fps inside the hook; no-op when network is inactive.
        // Use getState() to avoid stale closure + dependency churn.
        if (useFateStore.getState().isNetworkActive) {
          sendCursorMove(wx, wy);
        }

        if (isPanning.current) {
          const dx = sx - panStart.current.x;
          const dy = sy - panStart.current.y;
          setPan({ x: panStartOffset.current.x + dx, y: panStartOffset.current.y + dy });
          return;
        }

        // Shift+drag: update line target
        if (isShiftDragging.current && shiftDragSourceId.current) {
          setShiftDragTarget((prev) => prev ? { ...prev, targetX: wx, targetY: wy } : null);

          // Change cursor if hovering over a token (potential target)
          const targetToken = getTokenAtPos(wx, wy);
          const canvas = canvasRef.current;
          if (canvas) {
            canvas.style.cursor = (targetToken && targetToken.charId !== shiftDragSourceId.current) ? 'crosshair' : 'not-allowed';
          }
          return;
        }

        if (isDraggingToken.current && dragTokenId.current) {
          const newX = wx - dragOffset.current.x;
          const newY = wy - dragOffset.current.y;
          if (currentFloor) {
            const updatedTokens = currentFloor.tokens.map((t) =>
              t.charId === dragTokenId.current ? { ...t, x: newX, y: newY } : t,
            );
            useFateStore.setState((state) => ({
              scenes: state.scenes.map((sc) =>
                sc.id === currentSceneId
                  ? {
                      ...sc,
                      floors: sc.floors.map((f, idx) =>
                        idx === currentFloorIndex ? { ...f, tokens: updatedTokens } : f,
                      ),
                    }
                  : sc,
              ),
            }));
          }
          return;
        }

        if (isDrawing.current && currentDrawing.current) {
          currentDrawing.current.points.push({ x: wx, y: wy });
          setDrawingTick((t) => t + 1); // trigger React re-render + animation loop
          return;
        }

        // Eraser: track cursor for preview + drag-erase
        if (tool === 'eraser') {
          eraserCursor.current = { wx, wy };
          setEraserTick((t) => t + 1);
          if (e.buttons === 1) {
            eraseAtPos(wx, wy);
          }
          return;
        }

        if (isCreatingZone.current) {
          // In polygon mode, always update the cursor preview so the dashed
          // line from the last vertex to the cursor is visible — regardless
          // of whether the user is dragging or just hovering.
          if (polygonVertices.length > 0) {
            setPolygonCursor({ x: wx, y: wy });
            return;
          }
          // No vertices yet — shouldn't normally happen in zone tool, but
          // keep the legacy rect-drag path as a fallback (no-op here).
          return;
        }

        // ── Polygon cursor tracking (no mouse button held) ──
        // When the zone tool is active and vertices exist, always update
        // the cursor preview so the dashed line follows the mouse even
        // between clicks. This fixes the "no dashed line when just
        // clicking points" issue.
        if (tool === 'zone' && polygonVertices.length > 0) {
          setPolygonCursor({ x: wx, y: wy });
          return;
        }

        if (isCreatingFog.current) {
          const x = Math.min(fogStart.current.x, wx);
          const y = Math.min(fogStart.current.y, wy);
          const w = Math.abs(wx - fogStart.current.x);
          const h = Math.abs(wy - fogStart.current.y);
          setFogPreview({ x, y, w, h });
          return;
        }

        // Hover detection
        if (tool === 'select') {
          const token = getTokenAtPos(wx, wy);
          const zone = getZoneAtPos(wx, wy);

          if (token) {
            setHoveredTokenId(token.charId);
            setHoveredZoneId(null);
            const char = getCharacter(token.charId);
            if (char) {
              // If tooltip was suppressed by a click, don't re-show until mouse leaves
              if (!tooltipSuppressed.current) {
                const topSkill = char.skills.length > 0
                  ? char.skills.reduce((best, s) => (s.value > best.value ? s : best), char.skills[0])
                  : null;
                const typeLabel = char.type === 'player' ? 'Игрок' : 'NPC';
                const lines: Array<{ type: 'text'; text: string } | { type: 'section'; text: string } | { type: 'stress'; name: string; markers: boolean[]; trackType?: 'progressive' | 'linear' }> = [];

                lines.push({ type: 'text', text: `${char.name}` });

                // ── Crowd-specific tooltip ─────────────────────────
                if (char.isHorde && char.members && char.members.length > 0) {
                  const activeMembers = char.members.filter((m) => m.isActive);
                  const eliminatedMembers = char.members.filter((m) => !m.isActive);
                  lines.push({ type: 'text', text: `Толпа · ${topSkill ? `${topSkill.name}: +${topSkill.value}` : 'Нет навыков'}` });
                  lines.push({ type: 'text', text: `В строю: ${activeMembers.length} · Выбыли: ${eliminatedMembers.length}` });

                  // Unified stress counter: total marked / total capacity across all active members
                  let totalStressCapacity = 0;
                  let totalStressMarked = 0;
                  for (const member of activeMembers) {
                    if (member.stressTracks && member.stressTracks.length > 0) {
                      for (const track of member.stressTracks) {
                        totalStressCapacity += track.markers.length;
                        totalStressMarked += track.markers.filter(Boolean).length;
                      }
                    }
                  }
                  if (totalStressCapacity > 0) {
                    lines.push({ type: 'section', text: '— Стресс —' });
                    lines.push({ type: 'text', text: `  Стресс: ${totalStressMarked} / ${totalStressCapacity}` });
                  }

                  // Consequences — only show unhealed with description
                  const unhealedConsequences = (char.consequences ?? []).filter((c) => !c.healed && c.description);
                  if (unhealedConsequences.length > 0) {
                    lines.push({ type: 'section', text: '— Последствия —' });
                    for (const con of unhealedConsequences) {
                      lines.push({ type: 'text', text: `  ${con.name}: ${con.description}` });
                    }
                  }

                  // Aspects
                  const aspects = (char.aspects ?? []).filter((a) => a && a.trim());
                  if (aspects.length > 0) {
                    lines.push({ type: 'section', text: '— Аспекты —' });
                    for (const asp of aspects) {
                      lines.push({ type: 'text', text: `  ◆ ${asp}` });
                    }
                  }

                  // Situational aspects on token
                  const sitAspects = (token.situationalAspects ?? []).filter((a) => a && a.trim());
                  const charSitAspects = (char.situationalAspects ?? []).filter((a) => a && a.trim());
                  const allSitAspects = [...sitAspects, ...charSitAspects];
                  if (allSitAspects.length > 0) {
                    lines.push({ type: 'section', text: '— Ситуационные аспекты —' });
                    for (const asp of allSitAspects) {
                      lines.push({ type: 'text', text: `  ◆ ${asp}` });
                    }
                  }

                  // Active conditions on token
                  const conds = token.conditions ?? [];
                  if (conds.length > 0) {
                    lines.push({ type: 'section', text: '— Состояния —' });
                    for (const c of conds) {
                      const durLabel = c.duration === -1 ? '∞' : `${c.duration} раунд.`;
                      lines.push({ type: 'text', text: `  ${c.icon} ${c.name} (${durLabel})` });
                    }
                  }
                } else {
                  // ── Regular character tooltip ─────────────────────
                  lines.push({ type: 'text', text: `${typeLabel}${topSkill ? ` · ${topSkill.name}: +${topSkill.value}` : ''}` });

                  // Stress status — show all tracks with visual boxes
                  const tracks = char.stressTracks ?? [];
                  if (tracks.length > 0) {
                    lines.push({ type: 'section', text: '— Стресс —' });
                    for (const track of tracks) {
                      lines.push({ type: 'stress', name: track.name, markers: track.markers, trackType: track.type });
                    }
                  }

                  // Consequences — only show unhealed with description
                  const unhealedConsequences = (char.consequences ?? []).filter((c) => !c.healed && c.description);
                  if (unhealedConsequences.length > 0) {
                    lines.push({ type: 'section', text: '— Последствия —' });
                    for (const con of unhealedConsequences) {
                      lines.push({ type: 'text', text: `  ${con.name}: ${con.description}` });
                    }
                  }

                  // Aspects (high concept + first few aspects) — only if non-empty
                  const aspects = (char.aspects ?? []).filter((a) => a && a.trim());
                  const visibleAspects = aspects.slice(0, 4);
                  if (visibleAspects.length > 0) {
                    lines.push({ type: 'section', text: '— Аспекты —' });
                    for (const asp of visibleAspects) {
                      lines.push({ type: 'text', text: `  ◆ ${asp}` });
                    }
                    if (aspects.length > 4) {
                      lines.push({ type: 'text', text: `  …и ещё ${aspects.length - 4}` });
                    }
                  }

                  // Situational aspects on token — only if non-empty
                  const sitAspects = (token.situationalAspects ?? []).filter((a) => a && a.trim());
                  if (sitAspects.length > 0) {
                    lines.push({ type: 'section', text: '— Ситуационные аспекты —' });
                    for (const asp of sitAspects) {
                      lines.push({ type: 'text', text: `  ◆ ${asp}` });
                    }
                  }

                  // Active conditions on token — only if non-empty
                  const conds = token.conditions ?? [];
                  if (conds.length > 0) {
                    lines.push({ type: 'section', text: '— Состояния —' });
                    for (const c of conds) {
                      const durLabel = c.duration === -1 ? '∞' : `${c.duration} раунд.`;
                      lines.push({ type: 'text', text: `  ${c.icon} ${c.name} (${durLabel})` });
                    }
                  }
                }
                setTooltip({ x: sx, y: sy, lines });
              }
            }
          } else if (zone) {
            // Mouse left any token — clear tooltip suppression
            tooltipSuppressed.current = false;
            setHoveredTokenId(null);
            setHoveredZoneId(zone.id);
            // Rich zone tooltip — all zone info lives here (nothing is drawn
            // inside the zone itself). Sections: name, level (if >0), stress
            // track, aspects, rift aspects, description, zone type.
            const zoneLines: Array<{ type: 'text'; text: string } | { type: 'section'; text: string } | { type: 'stress'; name: string; markers: boolean[] }> = [];
            zoneLines.push({ type: 'text', text: zone.name });

            // Zone type label
            const zoneTypeLabels: Record<string, string> = {
              normal: 'Обычная',
              danger: '⚠ Опасная',
              bonus: '✦ Бонусная',
              special: '★ Особая',
            };
            const zt = zone.zoneType ?? 'normal';
            if (zt !== 'normal') {
              zoneLines.push({ type: 'text', text: `  ${zoneTypeLabels[zt] ?? 'Обычная'}` });
            }

            // Level (destruction/rift progression) — only when magic module is on.
            // Always shown (even at 0) when module is on, so the GM can see the
            // current state at a glance: «Чисто», «Трещины», «Разрыв», «Катастрофа».
            if (magicModuleEnabled) {
              const levelLabels = ['Чисто', 'Трещины', 'Разрыв', 'Катастрофа'];
              zoneLines.push({ type: 'text', text: `  Уровень: ${levelLabels[zone.level] ?? zone.level}` });
            }

            // Stress track — only when magic module is on. Stress belongs to
            // the CURRENT level; shows the linear 5-slot tracker plus an
            // explicit «N/5» summary so the GM knows how close the next
            // level-up is.
            if (magicModuleEnabled && zone.stress && zone.stress.length > 0) {
              const filled = zone.stress.filter(Boolean).length;
              zoneLines.push({ type: 'section', text: `— Стресс зоны (${filled}/5) —` });
              zoneLines.push({ type: 'stress', name: 'Напряжение', markers: zone.stress });
            }

            // Aspects
            if (zone.aspects.length > 0) {
              zoneLines.push({ type: 'section', text: '— Аспекты —' });
              for (const a of zone.aspects) {
                zoneLines.push({ type: 'text', text: `  ◆ ${a}` });
              }
            }

            // Rift aspects (auto-added, shown distinctly in red) — only when magic module is on
            if (magicModuleEnabled && zone.riftAspects && zone.riftAspects.length > 0) {
              zoneLines.push({ type: 'section', text: '— Аспекты разрыва —', danger: true });
              for (const a of zone.riftAspects) {
                zoneLines.push({ type: 'text', text: `  ◆ ${a}`, danger: true });
              }
            }

            // GM description / notes
            if (zone.description && zone.description.trim()) {
              zoneLines.push({ type: 'section', text: '— Описание —' });
              zoneLines.push({ type: 'text', text: `  ${zone.description.trim()}` });
            }

            setTooltip({ x: sx, y: sy, lines: zoneLines });
          } else {
            // Mouse left any token/zone — clear tooltip suppression
            tooltipSuppressed.current = false;
            setHoveredTokenId(null);
            setHoveredZoneId(null);
            setTooltip(null);
          }

          const canvas = canvasRef.current;
          if (canvas) {
            // Non-controllable token: cursor "not-allowed" so the player
            // knows they can't drag it (click still selects — selection is
            // a read-only view action).
            if (token && !canControlToken(token.charId)) {
              canvas.style.cursor = 'not-allowed';
            } else {
              canvas.style.cursor = token ? 'pointer' : zone ? 'pointer' : 'grab';
            }
          }
        } else {
          tooltipSuppressed.current = false;
          setHoveredTokenId(null);
          setHoveredZoneId(null);
          setTooltip(null);
          const canvas = canvasRef.current;
          if (canvas) canvas.style.cursor = 'crosshair';
        }
      },
      [
        getMousePos, tool, currentFloor, currentSceneId, currentFloorIndex, contextMenuOpen,
        getTokenAtPos, getZoneAtPos, getCharacter, eraseAtPos,
        polygonVertices, magicModuleEnabled,
        canControlToken, sendCursorMove,
      ],
    );

    const handleMouseUp = useCallback(
      (_e: React.MouseEvent) => {
        // Shift+drag: check if released over a different token
        if (isShiftDragging.current && shiftDragSourceId.current) {
          const target = shiftDragTarget;
          if (target) {
            const targetToken = getTokenAtPos(target.targetX, target.targetY);
            if (targetToken && targetToken.charId !== shiftDragSourceId.current) {
              onContextRoll?.(shiftDragSourceId.current, targetToken.charId);
            }
          }
          isShiftDragging.current = false;
          shiftDragSourceId.current = null;
          setShiftDragTarget(null);
          return;
        }

        if (isPanning.current) {
          isPanning.current = false;
          return;
        }

        if (isDraggingToken.current && dragTokenId.current) {
          const charId = dragTokenId.current;
          const token = currentFloor?.tokens.find((t) => t.charId === charId);
          if (token) persistTokenPosition(charId, token.x, token.y);
          isDraggingToken.current = false;
          dragTokenId.current = null;
          return;
        }

        if (isDrawing.current && currentDrawing.current) {
          if (currentDrawing.current.points.length >= 2) {
            persistDrawing(currentDrawing.current);
          }
          currentDrawing.current = null;
          isDrawing.current = false;
          setDrawingTick((t) => t + 1); // stop animation loop
          return;
        }

        if (isCreatingZone.current) {
          // In polygon mode, mouseUp checks if the user dragged from the
          // last vertex. If so, add a new vertex at the release point —
          // this lets the user either click points or drag to draw edges.
          if (polygonVertices.length > 0) {
            const pos = getMousePos(_e);
            if (pos) {
              const last = polygonVertices[polygonVertices.length - 1];
              const dx = pos.wx - last.x;
              const dy = pos.wy - last.y;
              const dist = Math.sqrt(dx * dx + dy * dy);
              // Only add a new vertex if the user actually dragged (not just
              // a click — the vertex was already added on mouseDown).
              if (dist > 8) {
                // Check if released near the first vertex (close polygon)
                if (polygonVertices.length >= 3) {
                  const first = polygonVertices[0];
                  const fdx = pos.wx - first.x;
                  const fdy = pos.wy - first.y;
                  if (Math.sqrt(fdx * fdx + fdy * fdy) <= 12) {
                    isCreatingZone.current = false;
                    void finishPolygonZone();
                    return;
                  }
                }
                setPolygonVertices((prev) => [...prev, { x: pos.wx, y: pos.wy }]);
              }
            }
          }
          isCreatingZone.current = false;
          setZonePreview(null);
          return;
        }

        if (isCreatingFog.current) {
          if (fogPreview && fogPreview.w > 5 && fogPreview.h > 5) {
            onFogAreaCreate?.(fogPreview.x, fogPreview.y, fogPreview.w, fogPreview.h);
          }
          isCreatingFog.current = false;
          setFogPreview(null);
          return;
        }
      },
      [currentFloor, persistTokenPosition, persistDrawing, createZone, zonePreview, fogPreview, onFogAreaCreate, getTokenAtPos, onContextRoll, shiftDragTarget, polygonVertices, getMousePos, finishPolygonZone],
    );

    const handleWheel = useCallback(
      (e: React.WheelEvent) => {
        e.preventDefault();
        const { sx, sy } = getMousePos(e);

        const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
        const currentZoom = zoomRef.current;
        const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, +(currentZoom + delta).toFixed(2)));

        const worldX = (sx - panRef.current.x) / currentZoom;
        const worldY = (sy - panRef.current.y) / currentZoom;
        const newPanX = sx - worldX * newZoom;
        const newPanY = sy - worldY * newZoom;

        setZoom(newZoom);
        setPan({ x: newPanX, y: newPanY });
        onZoomChange?.(newZoom);
      },
      [getMousePos, onZoomChange],
    );

    const handleMouseLeave = useCallback(() => {
      tooltipSuppressed.current = false;
      isPanning.current = false;
      isDraggingToken.current = false;
      isDrawing.current = false;
      isCreatingZone.current = false;
      isCreatingFog.current = false;
      isShiftDragging.current = false;
      shiftDragSourceId.current = null;
      currentDrawing.current = null;
      dragTokenId.current = null;
      eraserCursor.current = null;
      setHoveredTokenId(null);
      setHoveredZoneId(null);
      setTooltip(null);
      setZonePreview(null);
      setFogPreview(null);
      setShiftDragTarget(null);
      setDrawingTick((t) => t + 1);
      setEraserTick((t) => t + 1);
      // Notify peers that my cursor left the map area
      if (useFateStore.getState().isNetworkActive) {
        sendCursorLeave();
      }
    }, [sendCursorLeave]);

    const handleContextMenu = useCallback((e: React.MouseEvent) => {
      e.preventDefault();
      if (contextMenuOpen) return;
      const { sx, sy, wx, wy } = getMousePos(e);
      // Right-click on fog area toggles hidden/revealed
      if (tool === 'fog') {
        const fogArea = getFogAreaAtPos(wx, wy);
        if (fogArea) {
          onFogAreaToggle?.(fogArea.id);
          return;
        }
      }
      const token = getTokenAtPos(wx, wy);
      if (token) {
        onTokenContextMenu?.(token.charId, e.clientX, e.clientY);
        return;
      }
      // Right-click on an existing pin: open edit/delete menu
      const pin = getPinAtPos(wx, wy);
      if (pin) {
        onPinContextMenu?.(pin.id, e.clientX, e.clientY);
        return;
      }
      // Right-click on empty space
      onEmptySpaceContextMenu?.(wx, wy, e.clientX, e.clientY);
    }, [contextMenuOpen, getMousePos, tool, getFogAreaAtPos, getTokenAtPos, getPinAtPos, onFogAreaToggle, onTokenContextMenu, onPinContextMenu, onEmptySpaceContextMenu]);

    // ── Touch events for mobile ─────────────────────────────
    const touchState = useRef({
      lastDist: 0,
      isTouchPanning: false,
      isTouchDrawing: false,
    });

    const getTouchDistance = (touches: React.TouchList) => {
      const dx = touches[0].clientX - touches[1].clientX;
      const dy = touches[0].clientY - touches[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };

    const handleTouchStart = useCallback(
      (e: React.TouchEvent) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;

        if (e.touches.length === 2) {
          touchState.current.lastDist = getTouchDistance(e.touches);
          touchState.current.isTouchPanning = false;
          touchState.current.isTouchDrawing = false;
          return;
        }

        if (e.touches.length === 1) {
          const sx = e.touches[0].clientX - rect.left;
          const sy = e.touches[0].clientY - rect.top;
          const world = screenToWorld(sx, sy);

          if (tool === 'pen') {
            touchState.current.isTouchDrawing = true;
            isDrawing.current = true;
            currentDrawing.current = {
              points: [{ x: world.x, y: world.y }],
              color: penColor,
              size: penSize,
            };
            setDrawingTick((t) => t + 1);
          } else if (tool === 'fog') {
            touchState.current.isTouchPanning = false;
            isCreatingFog.current = true;
            fogStart.current = { x: world.x, y: world.y };
            setFogPreview({ x: world.x, y: world.y, w: 0, h: 0 });
          } else if (tool === 'eraser') {
            eraseAtPos(world.x, world.y);
          } else {
            touchState.current.isTouchPanning = true;
            panStart.current = { x: sx, y: sy };
            panStartOffset.current = { ...panRef.current };
          }
        }
      },
      [tool, penColor, penSize, screenToWorld, eraseAtPos],
    );

    const handleTouchMove = useCallback(
      (e: React.TouchEvent) => {
        e.preventDefault();
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;

        if (e.touches.length === 2) {
          const dist = getTouchDistance(e.touches);
          const scale = dist / touchState.current.lastDist;
          const currentZoom = zoomRef.current;
          const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, +(currentZoom * scale).toFixed(2)));

          const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
          const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
          const worldX = (cx - panRef.current.x) / currentZoom;
          const worldY = (cy - panRef.current.y) / currentZoom;
          const newPanX = cx - worldX * newZoom;
          const newPanY = cy - worldY * newZoom;

          setZoom(newZoom);
          setPan({ x: newPanX, y: newPanY });
          touchState.current.lastDist = dist;
          onZoomChange?.(newZoom);
          return;
        }

        if (e.touches.length === 1) {
          const sx = e.touches[0].clientX - rect.left;
          const sy = e.touches[0].clientY - rect.top;

          if (touchState.current.isTouchPanning) {
            const dx = sx - panStart.current.x;
            const dy = sy - panStart.current.y;
            setPan({
              x: panStartOffset.current.x + dx,
              y: panStartOffset.current.y + dy,
            });
          }

          if (touchState.current.isTouchDrawing && currentDrawing.current) {
            const world = screenToWorld(sx, sy);
            currentDrawing.current.points.push({ x: world.x, y: world.y });
            setDrawingTick((t) => t + 1);
          }

          if (tool === 'eraser') {
            const world = screenToWorld(sx, sy);
            eraseAtPos(world.x, world.y);
          }
        }
      },
      [screenToWorld, onZoomChange, tool, eraseAtPos],
    );

    const handleTouchEnd = useCallback(() => {
      touchState.current.isTouchPanning = false;
      touchState.current.isTouchDrawing = false;

      if (isDrawing.current && currentDrawing.current) {
        if (currentDrawing.current.points.length >= 2) {
          persistDrawing(currentDrawing.current);
        }
        currentDrawing.current = null;
        isDrawing.current = false;
        setDrawingTick((t) => t + 1);
      }
    }, [persistDrawing]);

    // ── Convert screen→world for drag handlers ─────────────
    const screenToWorldFromEvent = useCallback((e: React.DragEvent) => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      return {
        sx,
        sy,
        worldX: (sx - panRef.current.x) / zoomRef.current,
        worldY: (sy - panRef.current.y) / zoomRef.current,
      };
    }, []);

    // ── Document-level drag listeners ───────────────────────────
    // On dragend (drop or cancel): clear drag state so the preview token
    // and green overlay never get stuck.
    // On dragover (document-wide): keep the preview token position in sync
    // with the cursor, even if the canvas itself doesn't fire dragover
    // events (e.g. when the browser's drag ghost sits on top of the canvas
    // and intercepts them). This makes the live preview reliable.
    useEffect(() => {
      const onDragEndDoc = () => {
        dragPreviewRef.current = null;
        setCharDrag(null);
        setIsDraggingOver(false);
      };
      const onDragOverDoc = (e: DragEvent) => {
        if (!charDragState.current) return;
        // Only react to character-card drags
        if (!e.dataTransfer?.types.includes('text/fate-char-id') &&
            !e.dataTransfer?.types.includes('text/plain')) return;
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        // Only update if cursor is within the canvas bounds
        if (sx < 0 || sy < 0 || sx > rect.width || sy > rect.height) {
          // Cursor left the map — clear preview but keep drag state
          if (dragPreviewRef.current) {
            dragPreviewRef.current = null;
            setDrawingTick((t) => t + 1);
          }
          if (isDraggingOver) setIsDraggingOver(false);
          return;
        }
        const worldX = (sx - panRef.current.x) / zoomRef.current;
        const worldY = (sy - panRef.current.y) / zoomRef.current;
        dragPreviewRef.current = {
          charId: charDragState.current.charId,
          wx: worldX,
          wy: worldY,
        };
        if (!isDraggingOver) setIsDraggingOver(true);
        setDrawingTick((t) => t + 1);
      };
      document.addEventListener('dragend', onDragEndDoc);
      document.addEventListener('dragover', onDragOverDoc);
      return () => {
        document.removeEventListener('dragend', onDragEndDoc);
        document.removeEventListener('dragover', onDragOverDoc);
      };
    }, [isDraggingOver]);

    // ── Render JSX ──────────────────────────────────────────
    return (
      <div
        ref={containerRef}
        className="absolute inset-0 overflow-hidden"
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes('text/fate-char-id') || e.dataTransfer.types.includes('text/plain')) {
            e.preventDefault();
            setIsDraggingOver(true);
          }
        }}
        onDragOver={(e) => {
          // Allow drop of character cards from the side panel
          if (e.dataTransfer.types.includes('text/fate-char-id') || e.dataTransfer.types.includes('text/plain')) {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            // Update preview token position imperatively (no setState per frame)
            const pos = screenToWorldFromEvent(e);
            if (pos && charDragState.current) {
              dragPreviewRef.current = { charId: charDragState.current.charId, wx: pos.worldX, wy: pos.worldY };
              // Nudge drawingTick so the animation loop re-renders the preview
              setDrawingTick((t) => t + 1);
            }
            if (!isDraggingOver) setIsDraggingOver(true);
          }
        }}
        onDragLeave={(e) => {
          // Only clear when the cursor truly leaves the container (not when
          // moving between the container and its canvas child).
          const related = e.relatedTarget as Node | null;
          if (!containerRef.current?.contains(related)) {
            dragPreviewRef.current = null;
            setIsDraggingOver(false);
          }
        }}
        onDrop={(e) => {
          e.preventDefault();
          const charId = e.dataTransfer.getData('text/fate-char-id') || e.dataTransfer.getData('text/plain');
          // Clear drag UI immediately
          dragPreviewRef.current = null;
          setCharDrag(null);
          setIsDraggingOver(false);
          if (!charId || !onCharacterDrop) return;
          // Convert screen coords to world coords
          const rect = canvasRef.current?.getBoundingClientRect();
          if (!rect) return;
          const sx = e.clientX - rect.left;
          const sy = e.clientY - rect.top;
          const worldX = (sx - panRef.current.x) / zoomRef.current;
          const worldY = (sy - panRef.current.y) / zoomRef.current;
          onCharacterDrop(charId, worldX, worldY);
        }}
      >
        <canvas
          ref={canvasRef}
          className="absolute inset-0 touch-none"
          style={{
            width: '100%',
            height: '100%',
            pointerEvents: contextMenuOpen ? 'none' : 'auto',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseLeave}
          onDoubleClick={handleDoubleClick}
          onWheel={handleWheel}
          onContextMenu={handleContextMenu}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        />
        {/* Live cursor overlay — renders remote peers' cursors as HTML
            elements positioned via worldToScreen(pan, zoom). Pointer-events
            disabled so it never intercepts canvas interactions. */}
        <PeerCursorsLayer pan={pan} zoom={zoom} />
      </div>
    );
  },
);

// ── Live cursor overlay ────────────────────────────────────
// Memoized so it only re-renders when its props (pan, zoom) or its store
// slice (peerCursors, myPeerId) change — not on every canvas state update.
const PeerCursorsLayer = memo(function PeerCursorsLayer({
  pan,
  zoom,
}: {
  pan: { x: number; y: number };
  zoom: number;
}) {
  const peerCursors = useFateStore((s) => s.peerCursors);
  const myPeerId = useFateStore((s) => s.networkMyPeerId);
  const isNetworkActive = useFateStore((s) => s.isNetworkActive);

  if (!isNetworkActive || Object.keys(peerCursors).length === 0) return null;

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 30 }}
      aria-hidden="true"
    >
      {Object.entries(peerCursors).map(([peerId, c]) => {
        if (peerId === myPeerId) return null; // don't render own cursor
        const sx = c.x * zoom + pan.x;
        const sy = c.y * zoom + pan.y;
        // Skip if off-screen
        if (sx < -50 || sy < -50 || sx > 5000 || sy > 5000) return null;
        return (
          <div
            key={peerId}
            className="absolute flex items-center gap-1 transition-opacity duration-300"
            style={{
              left: `${sx}px`,
              top: `${sy}px`,
              transform: 'translate(-2px, -2px)',
              opacity: c.active ? 1 : 0.45,
            }}
          >
            {/* Cursor pointer — SVG arrow */}
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke={c.color}
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.4))' }}
            >
              <path d="M3 3 L3 17 L7 13 L10 20 L13 19 L10 12 L16 12 Z" fill={c.color} />
            </svg>
            {/* Name label */}
            <div
              className="px-1.5 py-0.5 rounded text-[10px] font-semibold text-white whitespace-nowrap shadow-sm"
              style={{ backgroundColor: c.color }}
            >
              {c.name}
              {!c.active && <span className="ml-1 opacity-70">●</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
});

// ── Utility: hex to rgba ────────────────────────────────────
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ── Utility: point-in-polygon test (ray casting algorithm) ──
function pointInPolygon(x: number, y: number, vertices: { x: number; y: number }[]): boolean {
  if (vertices.length < 3) return false;
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    const intersect = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// ── Utility: compute bounding box of a polygon ──────────────
function polygonBoundingBox(vertices: { x: number; y: number }[]): { x: number; y: number; width: number; height: number } {
  if (vertices.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of vertices) {
    if (v.x < minX) minX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.x > maxX) maxX = v.x;
    if (v.y > maxY) maxY = v.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// ── Utility: round rectangle ────────────────────────────────
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

// ── Utility: draw smooth path ───────────────────────────────
function drawSmoothPath(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],
  color: string,
  size: number,
) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    if (i < points.length - 1) {
      const midX = (points[i].x + points[i + 1].x) / 2;
      const midY = (points[i].y + points[i + 1].y) / 2;
      ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
    } else {
      ctx.lineTo(points[i].x, points[i].y);
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = size;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([]);
  ctx.stroke();
}
