'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CloudFog,
  Eraser,
  Eye,
  Heart,
  ImageIcon,
  MapPin,
  MousePointer2,
  Pencil,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Square,
  Swords,
  Trash2,
  UserPlus,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group';

import {
  GameCanvas,
  type GameCanvasHandle,
} from '@/components/fate/game-canvas';
import { CombatTimer } from '@/components/fate/combat-timer';
import { GameClock } from '@/components/fate/game-clock';
import { RollStageOverlay } from '@/components/fate/roll-stage-overlay';
import { DiceCanvasHost } from '@/components/fate/dice-canvas-host';
import { DiceCanvasHost2D } from '@/components/fate/dice-canvas-host-2d';
import { ConditionsDialog } from '@/components/fate/conditions-dialog';
import { SituationalAspectDialog } from '@/components/fate/situational-aspect-dialog';
import { ContextRollDialog } from '@/components/fate/context-roll-dialog';
import {
  ConflictTypeDialog,
  InitiativeTracker,
} from '@/components/fate/initiative-tracker';
import { TokenSelectDialog } from '@/components/fate/token-select-dialog';
import { StressConsequencesModal } from '@/components/fate/stress-consequences-modal';
import { FloorsManagerDialog } from '@/components/fate/floors-manager-dialog';
import { useFateStore } from '@/lib/store';
import { genId } from '@/lib/fate-dice';
import { useToast } from '@/hooks/use-toast';
import { useDroppable } from '@dnd-kit/core';
import { DROPPABLE_ID } from '@/components/fate/roll-gesture-provider';
import { setMapViewport } from '@/lib/map-viewport-registry';

// ── Color palette ───────────────────────────────────────────
const COLOR_PALETTE = [
  '#e67e22', '#e74c3c', '#27ae60', '#3498db',
  '#9b59b6', '#1abc9c', '#f39c12', '#2c3e50',
];

// ── Pin icon options (grouped loosely by theme) ─────────────
const PIN_ICONS = [
  // General / navigation
  '📍', '📌', '🚩', '🎯',
  // Places
  '🏰', '🏠', '🚪', '🌉',
  // Danger / combat
  '⚔️', '🗡️', '🛡️', '💀',
  // Treasure
  '💰', '💎', '🏆', '🔑',
  // Quest / story
  '📜', '⭐', '🌟', '💡',
  // Magic / special
  '🔮', '⚗️', '🧪', '✨',
  // Nature / hazards
  '🔥', '❄️', '⚡', '🕳️',
  // Creatures
  '🐉', '👹', '👑', '🦴',
];

// ── Pin color options ───────────────────────────────────────
const PIN_COLORS = [
  '#2c3e50', '#9b59b6', '#e67e22', '#e74c3c',
  '#27ae60', '#3498db', '#f39c12', '#1abc9c',
];

// ── Hard cap for pin name length ────────────────────────────
// Prevents the dialog / canvas from being blown out by a wall of text.
// 40 chars fits descriptive names like "Логово красного дракона" while
// keeping the canvas label short enough to truncate cleanly.
export const PIN_NAME_MAX = 40;

export function MapPanel() {
  const { scenes, currentSceneId, currentFloorIndex, setFloorIndex, addFloor, startConflict, endConflict, characters, updateFloorBackground, updateScene, currentMode, addFogArea, toggleFogArea, toggleFloorFog, clearFloorFog, addTokenToMap, addTokenToMapAt, removeTokenFromMap, eliminateParticipant, returnParticipant, addCharacterToScene, magicModuleEnabled, canDrawFog, canManageFloors } = useFateStore();
  const diceMode = useFateStore((s) => s.diceMode);
  const currentScene = scenes.find((s) => s.id === currentSceneId) ?? null;
  const floors = currentScene?.floors ?? [];
  const conflictData = currentScene?.conflictData ?? null;
  const { toast } = useToast();

  // ── Current floor (for background image access) ───────────
  const currentFloor = floors[currentFloorIndex] ?? null;
  const currentBackgroundImage = currentFloor?.backgroundImage ?? null;

  // ── Размер фонового изображения карты ──────────────────────
  // Загружаем naturalWidth/Height чтобы вычислить arenaHalf для физического
  // сервиса. Бортики и стены ставятся по контуру карты → кубики не вылетают.
  // Масштаб: 500px → 1.0 физ.ед. (2000px → 4.0, как дефолт сервиса).
  const [mapImageSize, setMapImageSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!currentBackgroundImage) {
      setMapImageSize(null);
      return;
    }
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setMapImageSize({ w: img.naturalWidth, h: img.naturalHeight });
      }
    };
    img.onerror = () => setMapImageSize(null);
    img.src = currentBackgroundImage;
  }, [currentBackgroundImage]);
  // arenaHalfW = imgW / 350, arenaHalfH = imgH / 350, clamped в [3.0, 8.0].
  // ПРЯМОУГОЛЬНАЯ арена: соотношение сторон арены = соотношению сторон
  // изображения → визуальные бортики точно повторяют контур карты.
  // Делитель 350 даёт просторную арену; MIN 3.0 — даже маленькие карты
  // получают достаточно места для броска.
  const arenaHalfW = useMemo(() => {
    if (!mapImageSize) return undefined;
    const raw = mapImageSize.w / 350;
    return Math.max(3.0, Math.min(8.0, raw));
  }, [mapImageSize]);
  const arenaHalfH = useMemo(() => {
    if (!mapImageSize) return undefined;
    const raw = mapImageSize.h / 350;
    return Math.max(3.0, Math.min(8.0, raw));
  }, [mapImageSize]);

  // ── Toolbar state ──────────────────────────────────────────
  const [tool, setTool] = useState<'select' | 'pen' | 'eraser' | 'zone' | 'fog'>('select');
  const [penColor, setPenColor] = useState('#e67e22');
  const [penSize, setPenSize] = useState(3);
  const [tokenRadius, setTokenRadius] = useState(25);
  const [zoomLevel, setZoomLevel] = useState(100);
  // Viewport (pan + zoom) — passed to RollStageOverlay so 3D dice follow
  // the map pan/zoom and stay anchored to world coordinates.
  const [viewport, setViewport] = useState({ panX: 0, panY: 0, zoom: 1 });
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [isUploadingBg, setIsUploadingBg] = useState(false);
  const [floorsManagerOpen, setFloorsManagerOpen] = useState(false);

  // ── Token selection + conditions dialog state ──────────────
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ charId: string; x: number; y: number } | null>(null);
  const [conditionsOpen, setConditionsOpen] = useState(false);
  const [conditionsCharId, setConditionsCharId] = useState<string | null>(null);

  // ── Situational aspect dialog state ─────────────────────────
  const [situationalAspectOpen, setSituationalAspectOpen] = useState(false);
  const [situationalAspectCharId, setSituationalAspectCharId] = useState<string | null>(null);

  // ── Context roll dialog state ──────────────────────────────
  const [contextRollOpen, setContextRollOpen] = useState(false);
  const [contextRollAttackerId, setContextRollAttackerId] = useState<string | null>(null);
  const [contextRollDefenderId, setContextRollDefenderId] = useState<string | null>(null);

  // ── Stress & Consequences modal state ──────────────────────
  const [stressModalOpen, setStressModalOpen] = useState(false);
  const [stressModalCharId, setStressModalCharId] = useState<string | null>(null);

  // ── Token select dialog state ──────────────────────────────
  const [tokenSelectOpen, setTokenSelectOpen] = useState(false);

  // ── Empty space context menu state (master mode only) ──────
  const [emptySpaceMenu, setEmptySpaceMenu] = useState<{ x: number; y: number; worldX: number; worldY: number } | null>(null);

  // ── Zone edit dialog state ─────────────────────────────────
  const [zoneEditOpen, setZoneEditOpen] = useState(false);
  const [zoneEditId, setZoneEditId] = useState<string | null>(null);
  const [zoneEditName, setZoneEditName] = useState('');
  const [zoneEditAspects, setZoneEditAspects] = useState<string[]>([]);
  const [zoneEditColor, setZoneEditColor] = useState('#3498db');
  const [zoneEditLevel, setZoneEditLevel] = useState(0);
  const [zoneEditStress, setZoneEditStress] = useState<boolean[]>(new Array(5).fill(false));
  const [zoneEditAspectInput, setZoneEditAspectInput] = useState('');

  // ── Pin dialog state (create via right-click on empty space, edit via right-click on pin) ──
  const [pinEditOpen, setPinEditOpen] = useState(false);
  const [pinEditId, setPinEditId] = useState<string | null>(null);
  const [pinEditName, setPinEditName] = useState('');
  const [pinEditIcon, setPinEditIcon] = useState('📍');
  const [pinEditColor, setPinEditColor] = useState('#2c3e50');
  // World coords captured from the empty-space right-click when creating a new pin
  const [pinNewPos, setPinNewPos] = useState<{ x: number; y: number } | null>(null);

  // ── Pin right-click context menu (edit/delete) ─────────────
  const [pinContextMenu, setPinContextMenu] = useState<{ pinId: string; x: number; y: number } | null>(null);

  // ── Canvas ref for imperative zoom controls ────────────────
  const canvasRef = useRef<GameCanvasHandle>(null);

  // ── Droppable target for dice gesture-roll ────────────────
  // Игрок тащит кубы из DiceStation (левый сайдбар) на карту —
  // этот div становится drop-зоной. data-roll-target используется
  // RollGestureProvider для вычисления rect canvas при drop.
  // isOver подсвечивает canvas когда над ним тащат кубы.
  const rollTargetRef = useRef<HTMLDivElement | null>(null);
  const { setNodeRef: setRollTargetRef, isOver: isRollTargetOver } = useDroppable({
    id: DROPPABLE_ID,
  });
  // Композитный ref: и dnd-kit setNodeRef, и наш rollTargetRef — чтобы
  // читать getBoundingClientRect() для map-viewport-registry.
  const setRollTargetNode = useCallback((node: HTMLDivElement | null) => {
    setRollTargetRef(node);
    rollTargetRef.current = node;
  }, [setRollTargetRef]);

  // ── Map viewport registry ─────────────────────────────────
  // Обновляем module-level registry при каждом изменении viewport или
  // mapImageSize. RollGestureProvider читает из него при drag end,
  // чтобы получить ТОЧНЫЙ прямоугольник изображения карты на экране
  // (с учётом pan/zoom), а не прямоугольник viewport'а.
  useEffect(() => {
    const node = rollTargetRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setMapViewport({
      viewportRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      panX: viewport.panX,
      panY: viewport.panY,
      zoom: viewport.zoom,
      mapImageSize,
    });
  }, [viewport, mapImageSize]);

  // Также обновляем при resize/scroll — используем ResizeObserver
  // и scroll listener на window (viewport rect меняется при скролле страницы
  // или изменении размера панели).
  useEffect(() => {
    const node = rollTargetRef.current;
    if (!node) return;
    const update = () => {
      const rect = node.getBoundingClientRect();
      setMapViewport({
        viewportRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        panX: viewport.panX,
        panY: viewport.panY,
        zoom: viewport.zoom,
        mapImageSize,
      });
    };
    const ro = new ResizeObserver(update);
    ro.observe(node);
    window.addEventListener('scroll', update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener('scroll', update, true);
    };
  }, [viewport, mapImageSize]);

  // ── Hidden file input ref for background image upload ──────
  const bgFileInputRef = useRef<HTMLInputElement>(null);

  // ── Handle tool change (single toggle group for all tools) ─
  const handleToolChange = useCallback((value: string) => {
    if (value) setTool(value as typeof tool);
  }, []);

  // ── Access control: if the current peer loses fog access while the fog
  // tool is active (e.g. they just connected as a network player), force the
  // tool back to 'select' so they aren't stuck on a tool whose toolbar
  // button is now hidden. Host/local always keeps access, so this is a no-op
  // for them.
  useEffect(() => {
    if (tool === 'fog' && !canDrawFog()) {
      setTool('select');
    }
  }, [tool, canDrawFog]);

  // ── Zoom handlers ──────────────────────────────────────────
  const handleZoomIn = useCallback(() => {
    canvasRef.current?.zoomIn();
  }, []);

  const handleZoomOut = useCallback(() => {
    canvasRef.current?.zoomOut();
  }, []);

  const handleResetView = useCallback(() => {
    canvasRef.current?.resetView();
  }, []);

  const handleZoomChange = useCallback((z: number) => {
    setZoomLevel(Math.round(z * 100));
  }, []);

  const handleViewportChange = useCallback((vp: { panX: number; panY: number; zoom: number }) => {
    setViewport(vp);
  }, []);

  // ── Background image upload ────────────────────────────────
  const MAX_BG_SIZE = 20 * 1024 * 1024; // 20 MB
  const ACCEPTED_BG_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'];

  const handleBgUploadClick = useCallback(() => {
    bgFileInputRef.current?.click();
  }, []);

  const handleBgFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file || !currentScene) return;

      if (!ACCEPTED_BG_TYPES.includes(file.type)) {
        toast({
          title: 'Неподдерживаемый формат',
          description: 'Допустимы только PNG, JPG, WebP и GIF',
          variant: 'destructive',
        });
        return;
      }

      if (file.size > MAX_BG_SIZE) {
        toast({
          title: 'Файл слишком большой',
          description: 'Изображение слишком большое (максимум 20МБ)',
          variant: 'destructive',
        });
        return;
      }

      setIsUploadingBg(true);
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            const result = reader.result;
            if (typeof result === 'string') resolve(result);
            else reject(new Error('Не удалось прочитать файл'));
          };
          reader.onerror = () => reject(reader.error ?? new Error('Ошибка чтения файла'));
          reader.readAsDataURL(file);
        });

        await updateFloorBackground(currentScene.id, currentFloorIndex, dataUrl);
        toast({ title: 'Фоновое изображение загружено' });
      } catch (err) {
        toast({
          title: 'Ошибка загрузки',
          description: err instanceof Error ? err.message : 'Не удалось загрузить изображение',
          variant: 'destructive',
        });
      } finally {
        setIsUploadingBg(false);
      }
    },
    [currentScene, currentFloorIndex, updateFloorBackground, toast],
  );

  const handleBgRemove = useCallback(async () => {
    if (!currentScene) return;
    try {
      await updateFloorBackground(currentScene.id, currentFloorIndex, null);
      toast({ title: 'Фоновое изображение удалено' });
    } catch (err) {
      toast({
        title: 'Ошибка',
        description: err instanceof Error ? err.message : 'Не удалось удалить изображение',
        variant: 'destructive',
      });
    }
  }, [currentScene, currentFloorIndex, updateFloorBackground, toast]);

  // ── Close color picker on outside click ────────────────────
  const handleCanvasClick = useCallback(() => {
    if (colorPickerOpen) setColorPickerOpen(false);
  }, [colorPickerOpen]);

  // ── Empty space right-click handler (master mode only) ─────
  const handleEmptySpaceContextMenu = useCallback((worldX: number, worldY: number, clientX: number, clientY: number) => {
    if (currentMode !== 'master') return;
    setEmptySpaceMenu({ x: clientX, y: clientY, worldX, worldY });
  }, [currentMode]);

  // ── Right-click on an existing pin: open edit/delete menu ──
  const handlePinContextMenu = useCallback((pinId: string, clientX: number, clientY: number) => {
    if (currentMode !== 'master') return;
    setPinContextMenu({ pinId, x: clientX, y: clientY });
  }, [currentMode]);

  // ── Open the pin dialog for creating a new pin at (x, y) ──
  const openPinCreate = useCallback((worldX: number, worldY: number) => {
    setPinEditId(null);
    setPinEditName('');
    setPinEditIcon('📍');
    setPinEditColor('#2c3e50');
    setPinNewPos({ x: worldX, y: worldY });
    setPinEditOpen(true);
    setEmptySpaceMenu(null);
  }, []);

  // ── Open the pin dialog for editing an existing pin ──
  const openPinEdit = useCallback((pinId: string) => {
    if (!currentScene) return;
    const floor = currentScene.floors[currentFloorIndex];
    if (!floor) return;
    const pin = floor.pins.find((p) => p.id === pinId);
    if (!pin) return;
    setPinEditId(pinId);
    setPinEditName(pin.name);
    setPinEditIcon(pin.icon || '📍');
    setPinEditColor(pin.color || '#2c3e50');
    setPinNewPos(null);
    setPinEditOpen(true);
    setPinContextMenu(null);
  }, [currentScene, currentFloorIndex]);

  // ── Save pin (create or update) ────────────────────────────
  const savePinEdits = useCallback(async () => {
    if (!currentScene) return;
    const floor = currentScene.floors[currentFloorIndex];
    if (!floor) return;

    const trimmedName = pinEditName.trim().slice(0, PIN_NAME_MAX);
    const icon = pinEditIcon || '📍';
    const color = pinEditColor || '#2c3e50';

    if (pinEditId) {
      // Update existing pin
      const updatedPins = floor.pins.map((p) =>
        p.id === pinEditId ? { ...p, name: trimmedName, icon, color } : p,
      );
      const updatedFloors = [...currentScene.floors];
      updatedFloors[currentFloorIndex] = { ...floor, pins: updatedPins };
      await updateScene(currentScene.id, { floors: updatedFloors });
    } else if (pinNewPos) {
      // Create new pin at captured world coords
      const newPin = {
        id: genId(),
        name: trimmedName,
        x: pinNewPos.x,
        y: pinNewPos.y,
        icon,
        color,
      };
      const updatedFloors = [...currentScene.floors];
      updatedFloors[currentFloorIndex] = { ...floor, pins: [...floor.pins, newPin] };
      await updateScene(currentScene.id, { floors: updatedFloors });
    }

    setPinEditOpen(false);
    setPinEditId(null);
    setPinNewPos(null);
  }, [currentScene, currentFloorIndex, pinEditId, pinEditName, pinEditIcon, pinEditColor, pinNewPos, updateScene]);

  // ── Delete pin ─────────────────────────────────────────────
  const deletePin = useCallback(async () => {
    if (!currentScene || !pinEditId) return;
    const floor = currentScene.floors[currentFloorIndex];
    if (!floor) return;
    const updatedPins = floor.pins.filter((p) => p.id !== pinEditId);
    const updatedFloors = [...currentScene.floors];
    updatedFloors[currentFloorIndex] = { ...floor, pins: updatedPins };
    await updateScene(currentScene.id, { floors: updatedFloors });
    setPinEditOpen(false);
    setPinEditId(null);
    setPinNewPos(null);
    setPinContextMenu(null);
  }, [currentScene, currentFloorIndex, pinEditId, updateScene]);

  // ── Quick delete from pin context menu (no dialog) ─────────
  const quickDeletePin = useCallback(async (pinId: string) => {
    if (!currentScene) return;
    const floor = currentScene.floors[currentFloorIndex];
    if (!floor) return;
    const updatedPins = floor.pins.filter((p) => p.id !== pinId);
    const updatedFloors = [...currentScene.floors];
    updatedFloors[currentFloorIndex] = { ...floor, pins: updatedPins };
    await updateScene(currentScene.id, { floors: updatedFloors });
    setPinContextMenu(null);
  }, [currentScene, currentFloorIndex, updateScene]);

  // ── Current conflict participant char id for token pulsing ─
  const conflictActiveCharId = conflictData
    ? (conflictData.participants[conflictData.currentParticipantIndex]?.characterId ?? null)
    : null;

  // ── Open conditions dialog for a character ─────────────────
  const openConditionsFor = (charId: string | null) => {
    if (!charId) {
      toast({
        title: 'Токен не выбран',
        description: 'Выберите токен на карте, чтобы управлять состояниями',
      });
      return;
    }
    setConditionsCharId(charId);
    setConditionsOpen(true);
    setContextMenu(null);
  };

  // ── Open context roll dialog for a character ────────────────
  const openContextRollFor = (charId: string) => {
    setContextRollAttackerId(charId);
    setContextRollOpen(true);
    setContextMenu(null);
  };

  // ── Token right-click context menu ─────────────────────────
  const handleTokenContextMenu = useCallback((charId: string, x: number, y: number) => {
    setContextMenu({ charId, x, y });
  }, []);

  // Close context menu on any outside mousedown (document-level)
  useEffect(() => {
    if (!contextMenu) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      // Don't close if clicking inside the context menu itself
      const target = e.target as HTMLElement;
      if (target.closest('[data-context-menu]')) return;
      setContextMenu(null);
    };
    // Prevent browser's native context menu while custom menu is open
    const preventNativeContextMenu = (e: MouseEvent) => e.preventDefault();
    // Use a small delay so the right-click that opened the menu doesn't immediately close it
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleDocMouseDown, true);
    }, 0);
    document.addEventListener('contextmenu', preventNativeContextMenu);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleDocMouseDown, true);
      document.removeEventListener('contextmenu', preventNativeContextMenu);
    };
  }, [contextMenu]);

  // Close empty space context menu on any outside mousedown (document-level)
  useEffect(() => {
    if (!emptySpaceMenu) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-context-menu]')) return;
      setEmptySpaceMenu(null);
    };
    const preventNativeContextMenu = (e: MouseEvent) => e.preventDefault();
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleDocMouseDown, true);
    }, 0);
    document.addEventListener('contextmenu', preventNativeContextMenu);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleDocMouseDown, true);
      document.removeEventListener('contextmenu', preventNativeContextMenu);
    };
  }, [emptySpaceMenu]);

  // Close pin context menu on any outside mousedown (document-level)
  useEffect(() => {
    if (!pinContextMenu) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('[data-context-menu]')) return;
      setPinContextMenu(null);
    };
    const preventNativeContextMenu = (e: MouseEvent) => e.preventDefault();
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleDocMouseDown, true);
    }, 0);
    document.addEventListener('contextmenu', preventNativeContextMenu);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleDocMouseDown, true);
      document.removeEventListener('contextmenu', preventNativeContextMenu);
    };
  }, [pinContextMenu]);

  const handleTokenSelect = (charId: string | null) => {
    setSelectedCharId(charId);
  };

  // ── Resolve character name for context menu ────────────────
  const getCharName = (charId: string) => {
    return characters.find((c) => c.id === charId)?.name ?? 'Персонаж';
  };

  // ── Zone double-click: open edit dialog ────────────────────
  const handleZoneDoubleClick = useCallback((zoneId: string) => {
    if (!currentScene) return;
    const floor = currentScene.floors[currentFloorIndex];
    if (!floor) return;
    const zone = floor.zones.find((z) => z.id === zoneId);
    if (!zone) return;

    setZoneEditId(zoneId);
    setZoneEditName(zone.name);
    setZoneEditAspects([...zone.aspects]);
    setZoneEditColor(zone.color || '#3498db');
    setZoneEditLevel(zone.level || 0);
    // Load the zone's 5-slot stress track for manual editing.
    // Normalise to exactly 5 slots (in case an older zone has a different length).
    const loadedStress =
      zone.stress && zone.stress.length === 5
        ? [...zone.stress]
        : new Array(5).fill(false);
    setZoneEditStress(loadedStress);
    setZoneEditAspectInput('');
    setZoneEditOpen(true);
  }, [currentScene, currentFloorIndex]);

  // ── Save zone edits ───────────────────────────────────────
  const saveZoneEdits = useCallback(async () => {
    if (!currentScene || !zoneEditId) return;
    const floor = currentScene.floors[currentFloorIndex];
    if (!floor) return;

    const updatedZones = floor.zones.map((z) =>
      z.id === zoneEditId
        ? { ...z, name: zoneEditName, aspects: zoneEditAspects.filter((a) => a.trim()), color: zoneEditColor, level: zoneEditLevel, stress: zoneEditStress }
        : z,
    );
    const updatedFloors = [...currentScene.floors];
    updatedFloors[currentFloorIndex] = { ...floor, zones: updatedZones };
    await updateScene(currentScene.id, { floors: updatedFloors });
    setZoneEditOpen(false);
    setZoneEditId(null);
  }, [currentScene, currentFloorIndex, zoneEditId, zoneEditName, zoneEditAspects, zoneEditColor, zoneEditLevel, zoneEditStress, updateScene]);

  // ── Delete zone ────────────────────────────────────────────
  const deleteZone = useCallback(async () => {
    if (!currentScene || !zoneEditId) return;
    const floor = currentScene.floors[currentFloorIndex];
    if (!floor) return;

    const updatedZones = floor.zones.filter((z) => z.id !== zoneEditId);
    const updatedFloors = [...currentScene.floors];
    updatedFloors[currentFloorIndex] = { ...floor, zones: updatedZones };
    await updateScene(currentScene.id, { floors: updatedFloors });
    setZoneEditOpen(false);
    setZoneEditId(null);
  }, [currentScene, currentFloorIndex, zoneEditId, updateScene]);

  // ── Add aspect in zone edit ────────────────────────────────
  const addZoneAspect = useCallback(() => {
    const trimmed = zoneEditAspectInput.trim();
    if (!trimmed) return;
    setZoneEditAspects((prev) => [...prev, trimmed]);
    setZoneEditAspectInput('');
  }, [zoneEditAspectInput]);

  // ── Remove aspect from zone edit ───────────────────────────
  const removeZoneAspect = useCallback((idx: number) => {
    setZoneEditAspects((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  return (
    <div className="flex flex-col h-full" style={{ backgroundColor: 'var(--fate-bg-warm)' }}>
      {/* Map Toolbar */}
      <div className="fate-map-toolbar flex items-center gap-1 px-2 py-1.5 border-b" style={{ borderColor: 'var(--fate-bg-warm)' }}>
        {/* Single tool toggle group */}
        <ToggleGroup
          type="single"
          value={tool}
          onValueChange={handleToolChange}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem value="select" className="fate-tool-btn size-7 p-0" title="Выделение">
            <MousePointer2 className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="pen" className="fate-tool-btn size-7 p-0" title="Карандаш">
            <Pencil className="size-3.5" />
          </ToggleGroupItem>
          <ToggleGroupItem value="eraser" className="fate-tool-btn size-7 p-0" title="Ластик">
            <Eraser className="size-3.5" />
          </ToggleGroupItem>

          <div className="w-px h-5 bg-border mx-0.5" />

          <ToggleGroupItem value="zone" className="fate-tool-btn size-7 p-0" title="Зона">
            <Square className="size-3.5" />
          </ToggleGroupItem>
          {canDrawFog() && (
            <ToggleGroupItem value="fog" className="fate-tool-btn size-7 p-0" title="Туман войны — только для мастера">
              <CloudFog className="size-3.5" />
            </ToggleGroupItem>
          )}
        </ToggleGroup>

        <Separator orientation="vertical" className="h-5 mx-1" />

        {/* Add Token Button */}
        {currentScene && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs gap-1 rounded-lg transition-all duration-200 hover:shadow-sm"
            style={{
              color: 'var(--fate-accent)',
              backgroundColor: 'rgba(230, 126, 34, 0.08)',
            }}
            onClick={() => setTokenSelectOpen(true)}
            title="Добавить персонажа на карту"
          >
            <UserPlus className="size-3.5" />
            <span className="hidden sm:inline">Токен</span>
          </Button>
        )}

        {/* Color Picker */}
        <div className="relative">
          <div
            className="size-6 rounded border cursor-pointer shadow-sm transition-shadow hover:shadow-md"
            style={{ backgroundColor: penColor, borderColor: 'rgba(0,0,0,0.15)' }}
            title="Цвет"
            onClick={() => setColorPickerOpen(!colorPickerOpen)}
          />
          {colorPickerOpen && (
            <div
              className="absolute top-8 left-0 z-50 rounded-lg shadow-lg border p-2 flex flex-wrap gap-1.5"
              style={{ width: 148, borderColor: 'var(--fate-border)', backgroundColor: 'var(--fate-bg-card)' }}
            >
              {COLOR_PALETTE.map((c) => (
                <button
                  key={c}
                  className="size-6 rounded-full border-2 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: c,
                    borderColor: c === penColor ? '#2c3e50' : 'transparent',
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setPenColor(c);
                    setColorPickerOpen(false);
                  }}
                />
              ))}
              <input
                type="color"
                value={penColor}
                onChange={(e) => setPenColor(e.target.value)}
                className="w-full h-6 cursor-pointer rounded border-0 mt-1"
                title="Пользовательский цвет"
              />
            </div>
          )}
        </div>

        {/* Pen Size Slider (visible when pen/eraser tool active) */}
        {(tool === 'pen' || tool === 'eraser') && (
          <div className="flex items-center gap-2 ml-1">
            <span className="text-[10px] whitespace-nowrap" style={{ color: 'var(--fate-text-muted)' }}>
              {tool === 'pen' ? 'Толщина' : 'Радиус'}
            </span>
            <Slider
              value={[penSize]}
              onValueChange={(v) => setPenSize(v[0])}
              min={1}
              max={20}
              step={1}
              className="w-16"
            />
            <span className="text-[10px] w-4" style={{ color: 'var(--fate-text-muted)' }}>
              {penSize}
            </span>
          </div>
        )}

        {/* Fog of War controls — host/local only. Hidden (not disabled) for
            network players because the entire fog workflow (drawing, erasing,
            toggling) is meaningless without write access. The tooltip on the
            toolbar fog tool button (above) carries the "только для мастера" hint. */}
        {canDrawFog() && currentScene && (
          <>
            <Separator orientation="vertical" className="h-5 mx-0.5" />
            <div className="flex items-center gap-1.5">
              <Switch
                checked={currentFloor?.fogEnabled ?? false}
                onCheckedChange={(checked) => toggleFloorFog(currentScene.id, currentFloorIndex, checked)}
                className="scale-75"
                aria-label="Туман войны"
              />
              <span className="text-[10px] whitespace-nowrap" style={{ color: currentFloor?.fogEnabled ? 'var(--fate-accent)' : 'var(--fate-text-muted)' }} title="Туман войны — только для мастера">
                Туман войны
              </span>
            </div>
            {currentFloor?.fogEnabled && (currentFloor.fogAreas ?? []).length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs gap-1 rounded-lg"
                style={{ color: '#e74c3c' }}
                onClick={() => clearFloorFog(currentScene.id, currentFloorIndex)}
                title="Убрать весь туман с текущего этажа"
              >
                <Trash2 className="size-3" />
                <span className="hidden sm:inline">Убрать туман</span>
              </Button>
            )}
          </>
        )}

        <div className="flex-1" />

        {/* Situational Aspect Button */}
        {currentScene && (
          <>
            <Separator orientation="vertical" className="h-5 mx-0.5" />
            <Button
              variant="ghost"
              size="sm"
              className={`h-7 px-2 text-xs gap-1 rounded-lg transition-all duration-300 hover:shadow-sm ${selectedCharId ? 'fate-conditions-pulse' : ''}`}
              style={{
                color: selectedCharId ? 'var(--fate-accent)' : 'var(--fate-text-muted)',
                backgroundColor: selectedCharId ? 'rgba(230, 126, 34, 0.08)' : 'transparent',
              }}
              onClick={() => {
                if (!selectedCharId) {
                  toast({
                    title: 'Токен не выбран',
                    description: 'Выберите токен на карте, чтобы добавить ситуационный аспект',
                  });
                  return;
                }
                setSituationalAspectCharId(selectedCharId);
                setSituationalAspectOpen(true);
              }}
              title={selectedCharId ? 'Ситуационный аспект выбранного токена' : 'Выберите токен на карте'}
            >
              <Sparkles className="size-3.5" />
              <span className="hidden sm:inline">Аспект</span>
            </Button>
          </>
        )}

        {/* Conflict Button */}
        {currentScene && (
          <>
            <Separator orientation="vertical" className="h-5 mx-0.5" />
            <Button
              variant={conflictData ? 'default' : 'ghost'}
              size="sm"
              className={`h-7 px-2 text-xs gap-1 rounded-lg transition-all duration-300 fate-button-shine ${conflictData ? 'fate-border-glow' : ''}`}
              style={conflictData ? {
                background: 'linear-gradient(135deg, #e67e22, #d35400)',
                color: 'white',
              } : undefined}
              onClick={() => {
                if (!conflictData) {
                  setConflictDialogOpen(true);
                }
              }}
              disabled={!!conflictData}
              title={conflictData ? 'Конфликт идёт' : 'Начать конфликт'}
            >
              <Swords className="size-3.5" />
              <span className="hidden sm:inline">
                {conflictData ? '⚔️ Бой' : 'Конфликт'}
              </span>
            </Button>
          </>
        )}

        {/* Background Image Controls */}
        {currentScene && (
          <>
            <Separator orientation="vertical" className="h-5 mx-0.5" />
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs gap-1 rounded-lg transition-all duration-200 hover:shadow-sm"
              style={{
                color: currentBackgroundImage ? 'var(--fate-accent)' : 'var(--fate-text-muted)',
                backgroundColor: currentBackgroundImage ? 'rgba(230, 126, 34, 0.08)' : 'transparent',
              }}
              onClick={handleBgUploadClick}
              disabled={isUploadingBg}
              title={currentBackgroundImage ? 'Заменить фоновое изображение' : 'Загрузить фоновое изображение'}
            >
              <ImageIcon className="size-3.5" />
              <span className="hidden sm:inline">{isUploadingBg ? 'Загрузка…' : 'Фон'}</span>
            </Button>
            {currentBackgroundImage && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-xs gap-1 rounded-lg transition-all duration-200 hover:shadow-sm"
                style={{ color: '#e74c3c' }}
                onClick={handleBgRemove}
                disabled={isUploadingBg}
                title="Удалить фон"
              >
                <Trash2 className="size-3.5" />
                <span className="hidden sm:inline">Удалить фон</span>
              </Button>
            )}
            {/* Hidden file input for background image upload */}
            <input
              ref={bgFileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="hidden"
              onChange={handleBgFileChange}
            />
          </>
        )}

        {/* Zoom Controls — labeled for clarity (label is sr-only for screen readers,
            visible icon + value for sighted users). */}
        <div className="flex items-center gap-0.5" aria-label="Масштаб карты">
          <span
            className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mr-1 hidden sm:inline select-none"
            aria-hidden="true"
          >
            Масштаб
          </span>
          <span className="sr-only">Масштаб карты:</span>
          <Button variant="ghost" size="icon" className="size-7" title="Уменьшить" aria-label="Уменьшить масштаб" onClick={handleZoomOut}>
            <ZoomOut className="size-3.5" />
          </Button>
          <span
            className="fate-zoom-indicator"
            title="Сбросить масштаб"
            aria-label={`Текущий масштаб ${zoomLevel}%, клик для сброса`}
            onClick={handleResetView}
          >
            🔍 {zoomLevel}%
          </span>
          <Button variant="ghost" size="icon" className="size-7" title="Увеличить" aria-label="Увеличить масштаб" onClick={handleZoomIn}>
            <ZoomIn className="size-3.5" />
          </Button>
          <Separator orientation="vertical" className="h-5 mx-0.5" />
          <Button variant="ghost" size="icon" className="size-7" title="Сбросить вид" aria-label="Сбросить вид" onClick={handleResetView}>
            <RotateCcw className="size-3" />
          </Button>
        </div>
      </div>

      {/* Map Canvas Area
          data-roll-target="true" — маркер для RollGestureProvider:
          querySelector('[data-roll-target="true"]') → getBoundingClientRect()
          для вычисления originSide/originX из drop координат.
          isRollTargetOver → подсветка когда над canvas тащат кубы. */}
      <div
        ref={setRollTargetNode}
        data-roll-target="true"
        className={`fate-map-canvas-wrapper flex-1 relative${isRollTargetOver ? ' fate-map-canvas-wrapper--roll-target' : ''}`}
        onClick={handleCanvasClick}
      >
        {currentScene ? (
          <>

            <GameCanvas
              ref={canvasRef}
              tool={tool}
              penColor={penColor}
              penSize={penSize}
              tokenRadius={tokenRadius}
              conflictActiveCharId={conflictActiveCharId}
              backgroundImage={currentBackgroundImage}
              masterMode={currentMode === 'master'}
              contextMenuOpen={!!contextMenu}
              onTokenContextMenu={handleTokenContextMenu}
              onTokenClick={(_charId) => {
                // Could open character sheet
              }}
              onTokenSelect={handleTokenSelect}
              onFogAreaCreate={(x, y, width, height) => {
                if (!currentScene) return;
                addFogArea(currentScene.id, currentFloorIndex, {
                  id: genId(),
                  type: 'rect',
                  points: [{ x, y }, { x: x + width, y: y + height }],
                  hidden: true,
                });
              }}
              onFogAreaToggle={(areaId) => {
                if (!currentScene) return;
                toggleFogArea(currentScene.id, currentFloorIndex, areaId);
              }}
              onZoneDoubleClick={handleZoneDoubleClick}
              onEmptySpaceContextMenu={handleEmptySpaceContextMenu}
              onPinContextMenu={handlePinContextMenu}
              onZoomChange={handleZoomChange}
              onViewportChange={handleViewportChange}
              onContextRoll={(attackerId, defenderId) => {
                setContextRollAttackerId(attackerId);
                setContextRollDefenderId(defenderId);
                setContextRollOpen(true);
              }}
              onCharacterDrop={async (charId, worldX, worldY) => {
                await addTokenToMapAt(charId, worldX, worldY);
                const droppedChar = useFateStore.getState().characters.find((c) => c.id === charId);
                toast({
                  title: `${droppedChar?.name ?? 'Персонаж'} размещён на карте`,
                  description: droppedChar?.type === 'player' ? 'Игрок добавлен в roster' : undefined,
                });
              }}
            />
            {/* Initiative Tracker Overlay */}
            {conflictData && (
              <InitiativeTracker
                onEndConflict={endConflict}
              />
            )}
            {/* Combat Round Timer Overlay */}
            <CombatTimer />
            {/* Game Clock Overlay */}
            <GameClock />
            {/* Roll Stage Overlay — кубики вылетают из кейса на карту,
                кувыркаются, показывают результат. pointer-events: none на
                канвасе → карта остаётся интерактивной во время броска.
                Кейс с кубиками теперь живёт в ScenePanel (левый блок).
                viewport (pan/zoom) передаётся чтобы кубы были привязаны
                к мировым координатам карты.
                arenaHalf (из размера карты) — бортики и стены по контуру. */}
            <RollStageOverlay
              viewport={viewport}
              arenaHalfW={arenaHalfW}
              arenaHalfH={arenaHalfH}
              mapImageSize={mapImageSize}
            />
            {/* DiceCanvasHost (3D) ИЛИ DiceCanvasHost2D (2D) — ПОСТОЯННЫЙ канвас
                для held-dice и single-бросков. Монтируется всегда (когда есть
                карта). Режим определяется diceMode в настройках:
                  • 3D: Three.js + Rapier3D (physics-service port 3006).
                  • 2D: CSS-плитки + локальный 2D-движок (dice-2d-physics).
                Оба режима поддерживают drag-бросок, button-бросок, возврат в кейс.
                Multi-session (VS/mass) рендерит свой канвас в ServerDiceStage(2D). */}
            {diceMode === '2d' ? (
              <DiceCanvasHost2D
                viewport={viewport}
                arenaHalfW={arenaHalfW}
                arenaHalfH={arenaHalfH}
                mapImageSize={mapImageSize}
              />
            ) : (
              <DiceCanvasHost
                viewport={viewport}
                arenaHalfW={arenaHalfW}
                arenaHalfH={arenaHalfH}
                mapImageSize={mapImageSize}
              />
            )}
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center fate-empty-map-state">
            <div className="text-center space-y-4 max-w-sm px-6">
              {/* Animated map icon */}
              <div className="relative mx-auto" style={{ width: 96, height: 96 }}>
                <div
                  className="absolute inset-0 rounded-2xl flex items-center justify-center"
                  style={{
                    background: 'radial-gradient(circle, rgba(230, 126, 34, 0.12) 0%, transparent 70%)',
                  }}
                />
                <div
                  className="absolute inset-2 rounded-2xl flex items-center justify-center fate-map-empty-icon"
                  style={{
                    backgroundColor: 'var(--fate-bg-card)',
                    border: '2px dashed rgba(230, 126, 34, 0.25)',
                  }}
                >
                  <MapPin className="size-10" style={{ color: 'var(--fate-accent)', opacity: 0.55 }} />
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-base font-semibold" style={{ color: 'var(--fate-text)' }}>
                  Карта сцены
                </p>
                <p className="text-xs leading-relaxed" style={{ color: 'var(--fate-text-muted)' }}>
                  Выберите сцену, чтобы начать рисовать карту, размещать токены
                  и создавать зоны. Используйте клавишу <kbd className="px-1 py-0.5 text-[10px] rounded font-mono" style={{ backgroundColor: 'var(--fate-bg)', border: '1px solid var(--fate-border)' }}>S</kbd> для быстрого открытия менеджера сцен.
                </p>
              </div>
              {/* Quick action hint */}
              <div
                className="flex items-center gap-2 px-3 py-2 rounded-lg mx-auto"
                style={{
                  backgroundColor: 'rgba(230, 126, 34, 0.06)',
                  border: '1px solid rgba(230, 126, 34, 0.15)',
                }}
              >
                <span className="text-[11px]" style={{ color: 'var(--fate-accent)' }}>💡</span>
                <span className="text-[11px]" style={{ color: 'var(--fate-text-muted)' }}>
                  Совет: перетащите персонажа из левой панели прямо на карту
                </span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Floor Tabs */}
      <div className="fate-map-toolbar flex items-center gap-1 px-2 py-1.5 border-t" style={{ borderColor: 'var(--fate-bg-warm)' }}>
        {/* Token Radius Slider — with preview circle + min/max markers + percentage badge */}
        <div className="flex items-center gap-1.5 mr-2">
          <span className="text-[10px] shrink-0" style={{ color: 'var(--fate-text-muted)' }}>
            Токен
          </span>
          {/* Scaling preview circle — diameter proportional to slider value */}
          <div
            className="fate-token-preview shrink-0"
            aria-hidden="true"
            style={{
              width: `${Math.max(6, tokenRadius / 3)}px`,
              height: `${Math.max(6, tokenRadius / 3)}px`,
              transition: 'width 0.15s ease, height 0.15s ease',
            }}
          />
          {/* Min marker (small circle) */}
          <div
            className="fate-token-size-marker shrink-0"
            aria-hidden="true"
            style={{ width: '5px', height: '5px' }}
            title="Минимальный размер токена"
          />
          <Slider
            value={[tokenRadius]}
            onValueChange={(v) => setTokenRadius(v[0])}
            min={15}
            max={50}
            step={5}
            className="w-16"
            aria-label="Размер токена на карте"
          />
          {/* Max marker (larger circle) */}
          <div
            className="fate-token-size-marker shrink-0"
            aria-hidden="true"
            style={{ width: '10px', height: '10px' }}
            title="Максимальный размер токена"
          />
          {/* Percentage badge */}
          <span
            className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0 tabular-nums"
            style={{
              color: 'var(--fate-accent)',
              backgroundColor: 'rgba(230, 126, 34, 0.1)',
              minWidth: '28px',
              textAlign: 'center',
            }}
            aria-label={`Размер токена ${Math.round(((tokenRadius - 15) / (50 - 15)) * 100)}%`}
          >
            {Math.round(((tokenRadius - 15) / (50 - 15)) * 100)}%
          </span>
        </div>

        <Separator orientation="vertical" className="h-5 mx-1" />

        {/* Floor tabs */}
        <div className="flex items-center gap-1 max-w-[280px] overflow-x-auto fate-thin-scrollbar">
          {floors.length === 0 ? (
            <button
              className={`fate-floor-tab ${currentFloorIndex === 0 ? 'fate-floor-tab-active' : ''}`}
              onClick={() => setFloorIndex(0)}
            >
              Этаж 1
            </button>
          ) : (
            floors.map((floor, idx) => (
              <button
                key={floor.id}
                className={`fate-floor-tab shrink-0 ${currentFloorIndex === idx ? 'fate-floor-tab-active' : ''}`}
                onClick={() => setFloorIndex(idx)}
                title={floor.name || `Этаж ${idx + 1}`}
              >
                <span className="inline-flex items-center justify-center size-3.5 rounded text-[9px] font-bold mr-0.5" style={{
                  backgroundColor: currentFloorIndex === idx ? 'rgba(255,255,255,0.25)' : 'rgba(127,140,141,0.18)',
                }}>
                  {idx + 1}
                </span>
                {floor.name || `Этаж ${idx + 1}`}
              </button>
            ))
          )}
          {/* Add floor — host/local only. Network players can still view
              existing floors (the tabs above remain clickable) but cannot
              create new ones. */}
          {canManageFloors() && (
            <button
              className="shrink-0 fate-floor-tab fate-floor-tab-add"
              onClick={async () => {
                if (currentSceneId) {
                  await addFloor(currentSceneId);
                  toast({ description: 'Добавлен новый этаж' });
                }
              }}
              title="Добавить этаж — только для мастера"
            >
              <Plus className="size-3.5" />
            </button>
          )}
        </div>

        {/* Manage floors (gear) — host/local only. Tooltip explains why it's
            missing for network players. */}
        {canManageFloors() ? (
          <button
            className="shrink-0 size-7 rounded-md flex items-center justify-center transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            onClick={() => setFloorsManagerOpen(true)}
            title="Управление этажами"
            style={{ color: 'var(--fate-text-muted)' }}
          >
            <Settings2 className="size-3.5" />
          </button>
        ) : (
          <button
            className="shrink-0 size-7 rounded-md flex items-center justify-center cursor-not-allowed"
            title="Управление этажами — только для мастера"
            style={{ color: 'var(--fate-text-muted)', opacity: 0.4 }}
            aria-disabled="true"
            tabIndex={-1}
          >
            <Settings2 className="size-3.5" />
          </button>
        )}
      </div>

      {/* Floors Manager Dialog */}
      <FloorsManagerDialog
        open={floorsManagerOpen}
        onOpenChange={setFloorsManagerOpen}
        sceneId={currentSceneId}
      />

      {/* Conflict Type Dialog */}
      <ConflictTypeDialog
        open={conflictDialogOpen}
        onOpenChange={setConflictDialogOpen}
        onStartConflict={startConflict}
      />

      {/* Token Context Menu (right-click on token) */}
      {contextMenu && (() => {
        const isConflictActive = !!conflictData;
        const isEliminated = conflictData?.eliminatedIds?.includes(contextMenu.charId) ?? false;
        return (
          <div
            data-context-menu
            className="fixed z-[101] rounded-lg shadow-xl border py-1 min-w-[180px] overflow-hidden animate-fade-in"
            style={{
              backgroundColor: 'var(--fate-bg-card)',
              left: Math.min(contextMenu.x, window.innerWidth - 210),
              top: Math.min(contextMenu.y, window.innerHeight - 200),
              borderColor: 'var(--fate-border)',
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {/* Character name header */}
            <div
              className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                color: 'var(--fate-text-muted)',
                borderBottom: '1px solid var(--fate-border)',
                backgroundColor: 'var(--fate-bg-card)',
              }}
            >
              {getCharName(contextMenu.charId)}
            </div>

            {/* 1. Стресс и последствия */}
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center gap-2 transition-colors"
              style={{ color: 'var(--fate-text)' }}
              onClick={(e) => {
                e.stopPropagation();
                setStressModalCharId(contextMenu.charId);
                setStressModalOpen(true);
                setContextMenu(null);
              }}
            >
              <Heart className="size-3.5" style={{ color: '#e74c3c' }} />
              <span>Стресс и последствия</span>
            </button>

            {/* 2. Ситуационный аспект */}
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center gap-2 transition-colors"
              style={{ color: 'var(--fate-text)' }}
              onClick={(e) => {
                e.stopPropagation();
                setSituationalAspectCharId(contextMenu.charId);
                setSituationalAspectOpen(true);
                setContextMenu(null);
              }}
            >
              <Sparkles className="size-3.5" style={{ color: 'var(--fate-accent)' }} />
              <span>Ситуационный аспект</span>
            </button>

            {/* 3. Убрать с карты */}
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center gap-2 transition-colors"
              style={{ color: 'var(--fate-text)' }}
              onClick={(e) => {
                e.stopPropagation();
                removeTokenFromMap(contextMenu.charId);
                setContextMenu(null);
              }}
            >
              <MapPin className="size-3.5" style={{ color: 'var(--fate-text-muted)' }} />
              <span>Убрать с карты</span>
            </button>

            {/* 4. Выбыл — only when conflict active and NOT eliminated */}
            {isConflictActive && !isEliminated && (
              <button
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors"
                style={{
                  color: '#c0392b',
                  backgroundColor: 'transparent',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(231,76,60,0.08)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  eliminateParticipant(contextMenu.charId);
                  setContextMenu(null);
                }}
              >
                <Trash2 className="size-3.5" style={{ color: '#c0392b' }} />
                <span className="font-medium">Выбыл</span>
              </button>
            )}

            {/* 6. Вернуть в бой — only when conflict active and IS eliminated */}
            {isConflictActive && isEliminated && (
              <button
                className="w-full text-left px-3 py-2 text-sm flex items-center gap-2 transition-colors"
                style={{
                  color: '#27ae60',
                  backgroundColor: 'transparent',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.backgroundColor = 'rgba(39,174,96,0.08)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  returnParticipant(contextMenu.charId);
                  setContextMenu(null);
                }}
              >
                <RotateCcw className="size-3.5" style={{ color: '#27ae60' }} />
                <span className="font-medium">Вернуть в бой</span>
              </button>
            )}
          </div>
        );
      })()}

      {/* Empty Space Context Menu (right-click on empty map, master mode only) */}
      {emptySpaceMenu && currentScene && (() => {
        const currentFloorData = currentScene.floors[currentFloorIndex];
        const existingTokenCharIds = new Set((currentFloorData?.tokens ?? []).map((t) => t.charId));
        // Characters on the scene that don't already have a token on this floor
        const availableChars = characters.filter(
          (c) => currentScene.presentCharacters.includes(c.id) && !existingTokenCharIds.has(c.id),
        );

        const handlePlaceToken = async (charId: string) => {
          // Ensure character is on the scene (should be, but guard)
          if (!currentScene.presentCharacters.includes(charId)) {
            await addCharacterToScene(charId);
          }
          // Create token at the clicked world position
          const updatedScene = useFateStore.getState().scenes.find((s) => s.id === currentSceneId);
          if (!updatedScene) return;
          const updatedFloors = [...updatedScene.floors];
          const floorIdx = currentFloorIndex;
          if (updatedFloors[floorIdx]) {
            const floor = { ...updatedFloors[floorIdx] };
            const alreadyHasToken = floor.tokens.some((t) => t.charId === charId);
            if (!alreadyHasToken) {
              floor.tokens = [...floor.tokens, { charId, x: emptySpaceMenu.worldX, y: emptySpaceMenu.worldY }];
              updatedFloors[floorIdx] = floor;
              await updateScene(updatedScene.id, { floors: updatedFloors });
            }
          }
          setEmptySpaceMenu(null);
        };

        return (
          <div
            data-context-menu
            className="fixed z-[101] rounded-lg shadow-xl border py-1 min-w-[220px] max-h-80 overflow-y-auto animate-fade-in fate-scroll"
            style={{
              backgroundColor: 'var(--fate-bg-card)',
              left: Math.min(emptySpaceMenu.x, window.innerWidth - 240),
              top: Math.min(emptySpaceMenu.y, window.innerHeight - 240),
              borderColor: 'var(--fate-border)',
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {/* Create pin action (always available) */}
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-purple-50 dark:hover:bg-purple-950/30 flex items-center gap-2 transition-colors"
              style={{ color: 'var(--fate-text)' }}
              onClick={(e) => {
                e.stopPropagation();
                openPinCreate(emptySpaceMenu.worldX, emptySpaceMenu.worldY);
              }}
              title="Создать метку в этой точке"
            >
              <span
                className="inline-flex items-center justify-center size-5 rounded-full text-[11px] shrink-0"
                style={{
                  backgroundColor: 'rgba(155, 89, 182, 0.14)',
                  color: '#9b59b6',
                }}
              >
                📍
              </span>
              <span className="font-medium">Создать метку</span>
            </button>

            {/* Divider */}
            <div className="h-px my-0.5" style={{ backgroundColor: 'var(--fate-border)' }} />

            {/* Header for token list */}
            <div
              className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider"
              style={{
                color: 'var(--fate-text-muted)',
                borderBottom: '1px solid var(--fate-border)',
                backgroundColor: 'var(--fate-bg-card)',
              }}
            >
              Добавить токен
            </div>

            {currentScene.presentCharacters.length === 0 ? (
              /* No characters on scene */
              <div className="px-3 py-3 text-xs text-center" style={{ color: 'var(--fate-text-muted)' }}>
                Нет персонажей на сцене
              </div>
            ) : availableChars.length === 0 ? (
              /* All characters already have tokens on this floor */
              <div className="px-3 py-3 text-xs text-center" style={{ color: 'var(--fate-text-muted)' }}>
                Все персонажи уже на карте
              </div>
            ) : (
              /* List of available characters */
              availableChars.map((char) => (
                <button
                  key={char.id}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center gap-2 transition-colors"
                  style={{ color: 'var(--fate-text)' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePlaceToken(char.id);
                  }}
                >
                  <span
                    className="inline-flex items-center justify-center size-5 rounded-full text-[9px] font-bold shrink-0"
                    style={{
                      backgroundColor: char.type === 'player' ? 'rgba(39,174,96,0.12)' : 'rgba(155,89,182,0.12)',
                      color: char.type === 'player' ? '#27ae60' : '#9b59b6',
                    }}
                  >
                    {char.type === 'player' ? 'И' : 'N'}
                  </span>
                  <span className="truncate">{char.name}</span>
                  <span
                    className="ml-auto text-[10px] px-1.5 py-0.5 rounded shrink-0"
                    style={{
                      backgroundColor: char.type === 'player' ? 'rgba(39,174,96,0.08)' : 'rgba(155,89,182,0.08)',
                      color: char.type === 'player' ? '#27ae60' : '#9b59b6',
                    }}
                  >
                    {char.type === 'player' ? 'Игрок' : 'NPC'}
                  </span>
                </button>
              ))
            )}
          </div>
        );
      })()}

      {/* Pin Context Menu (right-click on an existing pin, master mode only) */}
      {pinContextMenu && currentScene && (() => {
        const floor = currentScene.floors[currentFloorIndex];
        const pin = floor?.pins.find((p) => p.id === pinContextMenu.pinId);
        if (!pin) return null;
        return (
          <div
            data-context-menu
            className="fixed z-[101] rounded-lg shadow-xl border py-1 min-w-[180px] animate-fade-in"
            style={{
              backgroundColor: 'var(--fate-bg-card)',
              left: Math.min(pinContextMenu.x, window.innerWidth - 200),
              top: Math.min(pinContextMenu.y, window.innerHeight - 120),
              borderColor: 'var(--fate-border)',
            }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {/* Header showing the pin name */}
            <div
              className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider flex items-center gap-1.5"
              style={{
                color: 'var(--fate-text-muted)',
                borderBottom: '1px solid var(--fate-border)',
                backgroundColor: 'var(--fate-bg-card)',
              }}
            >
              <span className="text-sm">{pin.icon || '📍'}</span>
              <span className="truncate">{pin.name || 'Без названия'}</span>
            </div>

            {/* Edit */}
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center gap-2 transition-colors"
              style={{ color: 'var(--fate-text)' }}
              onClick={(e) => {
                e.stopPropagation();
                openPinEdit(pin.id);
              }}
            >
              <Pencil className="size-3.5" style={{ color: 'var(--fate-accent)' }} />
              <span>Редактировать</span>
            </button>

            {/* Delete */}
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center gap-2 transition-colors"
              style={{ color: '#e74c3c' }}
              onClick={(e) => {
                e.stopPropagation();
                void quickDeletePin(pin.id);
              }}
            >
              <Trash2 className="size-3.5" />
              <span>Удалить</span>
            </button>
          </div>
        );
      })()}

      {/* Zone Edit Dialog */}
      <Dialog open={zoneEditOpen} onOpenChange={setZoneEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="fate-dialog-title flex items-center gap-2.5">
              <div
                className="fate-icon-circle"
                style={{ backgroundColor: hexToRgba(zoneEditColor, 0.12) }}
              >
                <Square className="size-4" style={{ color: zoneEditColor }} />
              </div>
              Редактирование зоны
            </DialogTitle>
            <DialogDescription>
              Измените свойства зоны на карте
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Name */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Название зоны
              </label>
              <Input
                value={zoneEditName}
                onChange={(e) => setZoneEditName(e.target.value)}
                placeholder="Название зоны"
                className="text-sm"
              />
            </div>

            {/* Color */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Цвет
              </label>
              <div className="flex items-center gap-2">
                {COLOR_PALETTE.map((c) => (
                  <button
                    key={c}
                    className="size-6 rounded-full border-2 transition-transform hover:scale-110"
                    style={{
                      backgroundColor: c,
                      borderColor: c === zoneEditColor ? '#2c3e50' : 'transparent',
                    }}
                    onClick={() => setZoneEditColor(c)}
                  />
                ))}
                <input
                  type="color"
                  value={zoneEditColor}
                  onChange={(e) => setZoneEditColor(e.target.value)}
                  className="size-6 cursor-pointer rounded border-0"
                />
              </div>
            </div>

            {/* Level & manual stress — only visible when the magic module is enabled.
                4 discrete levels: 0 (Чисто), 1 (Трещины), 2 (Разрыв), 3 (Катастрофа).
                The 5-slot linear stress track can be tweaked by hand here, just in case
                the GM needs to correct an automated magic-cast result. */}
            {magicModuleEnabled && (
              <div className="space-y-3 rounded-lg border p-3" style={{ borderColor: 'var(--fate-border)', backgroundColor: 'rgba(231, 76, 60, 0.04)' }}>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium flex items-center justify-between" style={{ color: 'var(--fate-text-muted)' }}>
                    <span>Уровень разрыва</span>
                    <span className="font-semibold" style={{ color: 'var(--fate-danger)' }}>
                      {['Чисто', 'Трещины', 'Разрыв', 'Катастрофа'][zoneEditLevel] ?? zoneEditLevel}
                    </span>
                  </label>
                  <Slider
                    value={[zoneEditLevel]}
                    onValueChange={(v) => setZoneEditLevel(Math.min(3, Math.max(0, v[0])))}
                    min={0}
                    max={3}
                    step={1}
                  />
                  <div className="flex justify-between text-[9px] px-0.5" style={{ color: 'var(--fate-text-muted)', opacity: 0.7 }}>
                    <span>Чисто</span>
                    <span>Трещины</span>
                    <span>Разрыв</span>
                    <span>Катастрофа</span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="text-xs font-medium flex items-center justify-between" style={{ color: 'var(--fate-text-muted)' }}>
                    <span>Стресс зоны (вручную)</span>
                    <span
                      className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                      style={{
                        backgroundColor: 'rgba(231, 76, 60, 0.15)',
                        color: 'var(--fate-danger)',
                      }}
                    >
                      {zoneEditStress.filter(Boolean).length}/5
                    </span>
                  </label>
                  <div className="flex items-center gap-1.5">
                    {zoneEditStress.map((marked, bi) => (
                      <button
                        key={bi}
                        type="button"
                        onClick={() =>
                          setZoneEditStress((prev) => {
                            const next = [...prev];
                            next[bi] = !next[bi];
                            return next;
                          })
                        }
                        className="transition-all duration-150 hover:scale-110"
                        title={`Слот стресса ${bi + 1}${marked ? ' (отмечено)' : ''}`}
                        aria-label={`Слот стресса ${bi + 1}${marked ? ' (отмечено)' : ''}`}
                        aria-pressed={marked}
                      >
                        <span
                          className="fate-stress-box block rounded-sm transition-colors duration-150 flex items-center justify-center"
                          style={{
                            width: 22,
                            height: 22,
                            backgroundColor: marked ? 'var(--fate-danger)' : 'transparent',
                            border: `1.5px solid ${marked ? 'var(--fate-danger)' : 'var(--fate-text-muted)'}`,
                            opacity: marked ? 1 : 0.45,
                            fontSize: 10,
                            fontWeight: marked ? 800 : 600,
                            color: marked ? 'white' : 'var(--fate-text-muted)',
                            lineHeight: '22px',
                          }}
                        >
                          {bi + 1}
                        </span>
                      </button>
                    ))}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 ml-1 text-[10px] shrink-0"
                      onClick={() => setZoneEditStress(new Array(5).fill(false))}
                      title="Сбросить стресс зоны в 0"
                      disabled={zoneEditStress.every((s) => !s)}
                    >
                      <RotateCcw className="size-3 mr-1" />
                      Сброс
                    </Button>
                  </div>
                  <p className="text-[10px] italic" style={{ color: 'var(--fate-text-muted)', opacity: 0.7 }}>
                    Ручная коррекция на случай, если нужно поправить стресс зоны.
                  </p>
                </div>
              </div>
            )}

            {/* Aspects */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Аспекты
              </label>
              <div className="space-y-1.5">
                {zoneEditAspects.map((aspect, idx) => (
                  <div key={idx} className="flex items-center gap-1.5">
                    <span className="text-xs" style={{ color: zoneEditColor }}>◆</span>
                    <span className="text-sm flex-1 italic" style={{ color: 'var(--fate-text)' }}>
                      {aspect}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 shrink-0"
                      style={{ color: '#e74c3c' }}
                      onClick={() => removeZoneAspect(idx)}
                      title="Удалить аспект"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  value={zoneEditAspectInput}
                  onChange={(e) => setZoneEditAspectInput(e.target.value)}
                  placeholder="Новый аспект"
                  className="text-sm"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addZoneAspect();
                    }
                  }}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 rounded-lg"
                  onClick={addZoneAspect}
                  disabled={!zoneEditAspectInput.trim()}
                >
                  <Plus className="size-3.5" />
                </Button>
              </div>
            </div>
          </div>

          <DialogFooter className="flex gap-2 sm:gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs gap-1 rounded-lg"
              style={{ color: '#e74c3c' }}
              onClick={deleteZone}
            >
              <Trash2 className="size-3.5" />
              Удалить
            </Button>
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              className="text-xs rounded-lg"
              onClick={() => setZoneEditOpen(false)}
            >
              Отмена
            </Button>
            <Button
              size="sm"
              className="text-xs fate-btn-accent rounded-lg"
              onClick={saveZoneEdits}
            >
              Сохранить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pin Edit Dialog (create via right-click on empty space, edit via right-click on pin) */}
      <Dialog open={pinEditOpen} onOpenChange={setPinEditOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="fate-dialog-title flex items-center gap-2.5">
              <div
                className="fate-icon-circle"
                style={{ backgroundColor: 'rgba(155, 89, 182, 0.14)' }}
              >
                <MapPin className="size-4" style={{ color: '#9b59b6' }} />
              </div>
              {pinEditId ? 'Редактирование метки' : 'Новая метка'}
            </DialogTitle>
            <DialogDescription>
              {pinEditId
                ? 'Измените название, иконку и цвет метки'
                : 'Задайте название, иконку и цвет для новой метки на карте'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Live preview */}
            <div
              className="rounded-lg p-3 flex items-center gap-3"
              style={{
                backgroundColor: 'rgba(155, 89, 182, 0.06)',
                border: '1px solid rgba(155, 89, 182, 0.18)',
              }}
            >
              <div
                className="flex items-center justify-center rounded-full fate-pin-preview-badge"
                style={{
                  width: 44,
                  height: 44,
                  fontSize: 22,
                  backgroundColor: hexToRgba(pinEditColor, 0.12),
                  border: `2px solid ${pinEditColor}`,
                  color: pinEditColor,
                }}
              >
                {pinEditIcon || '📍'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs uppercase tracking-wider" style={{ color: 'var(--fate-text-muted)' }}>
                  Предпросмотр
                </div>
                <div
                  className="text-sm font-semibold truncate"
                  style={{ color: pinEditColor || 'var(--fate-text)' }}
                >
                  {pinEditName.trim() || 'Без названия'}
                </div>
              </div>
            </div>

            {/* Name */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Название метки
                </label>
                <span
                  className="text-[10px] tabular-nums"
                  style={{
                    color: pinEditName.length > PIN_NAME_MAX * 0.8
                      ? '#e67e22'
                      : 'var(--fate-text-muted)',
                  }}
                >
                  {pinEditName.length} / {PIN_NAME_MAX}
                </span>
              </div>
              <Input
                value={pinEditName}
                onChange={(e) => setPinEditName(e.target.value.slice(0, PIN_NAME_MAX))}
                placeholder="Например: Логово дракона"
                className="text-sm"
                maxLength={PIN_NAME_MAX}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void savePinEdits();
                  }
                }}
              />
              {pinEditName.trim().length > 24 && (
                <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                  Длинные названия обрезаются на карте многоточием
                </p>
              )}
            </div>

            {/* Icon picker */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Иконка
              </label>
              <div className="grid grid-cols-8 gap-1 fate-pin-icon-grid">
                {PIN_ICONS.map((icon) => (
                  <button
                    key={icon}
                    type="button"
                    className="fate-pin-icon-btn"
                    style={{
                      backgroundColor: icon === pinEditIcon
                        ? 'rgba(155, 89, 182, 0.18)'
                        : 'var(--fate-bg)',
                      borderColor: icon === pinEditIcon ? '#9b59b6' : 'var(--fate-border)',
                      color: icon === pinEditIcon ? '#9b59b6' : 'var(--fate-text)',
                    }}
                    onClick={() => setPinEditIcon(icon)}
                    title={icon}
                  >
                    <span className="text-base leading-none">{icon}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Color */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Цвет подписи
              </label>
              <div className="flex items-center gap-2 flex-wrap">
                {PIN_COLORS.map((c) => (
                  <button
                    key={c}
                    className="size-6 rounded-full border-2 transition-transform hover:scale-110"
                    style={{
                      backgroundColor: c,
                      borderColor: c === pinEditColor ? '#2c3e50' : 'transparent',
                    }}
                    onClick={() => setPinEditColor(c)}
                  />
                ))}
                <input
                  type="color"
                  value={pinEditColor}
                  onChange={(e) => setPinEditColor(e.target.value)}
                  className="size-6 cursor-pointer rounded border-0"
                />
              </div>
            </div>
          </div>

          <DialogFooter className="flex gap-2 sm:gap-2">
            {pinEditId && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs gap-1 rounded-lg"
                style={{ color: '#e74c3c' }}
                onClick={deletePin}
              >
                <Trash2 className="size-3.5" />
                Удалить
              </Button>
            )}
            <div className="flex-1" />
            <Button
              variant="outline"
              size="sm"
              className="text-xs rounded-lg"
              onClick={() => setPinEditOpen(false)}
            >
              Отмена
            </Button>
            <Button
              size="sm"
              className="text-xs fate-btn-accent rounded-lg"
              onClick={() => void savePinEdits()}
            >
              {pinEditId ? 'Сохранить' : 'Создать'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Conditions Dialog (kept for internal use, removed from UI) */}
      <ConditionsDialog
        open={conditionsOpen}
        onOpenChange={setConditionsOpen}
        charId={conditionsCharId}
      />

      {/* Situational Aspect Dialog */}
      <SituationalAspectDialog
        open={situationalAspectOpen}
        onOpenChange={setSituationalAspectOpen}
        charId={situationalAspectCharId}
      />

      {/* Context Roll Dialog */}
      <ContextRollDialog
        open={contextRollOpen}
        onOpenChange={setContextRollOpen}
        attackerId={contextRollAttackerId}
        defenderId={contextRollDefenderId}
      />

      {/* Token Select Dialog */}
      <TokenSelectDialog open={tokenSelectOpen} onOpenChange={setTokenSelectOpen} alsoAddToMap />

      {/* Stress & Consequences Quick Edit Modal */}
      <StressConsequencesModal
        open={stressModalOpen}
        onOpenChange={setStressModalOpen}
        characterId={stressModalCharId}
      />
    </div>
  );
}

// ── Utility: hex to rgba ────────────────────────────────────
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}
