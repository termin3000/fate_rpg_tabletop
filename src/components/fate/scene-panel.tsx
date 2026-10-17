'use client';

import {
  Dice5,
  EyeOff,
  FileText,
  MapPin,
  Minus,
  Shield,
  Users,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { RollToolPanel } from '@/components/fate/roll-tool-panel';
import { DiceStation } from '@/components/fate/dice-station';
import { useFateStore } from '@/lib/store';
import { setCharDrag } from '@/lib/drag-state';
import type { Character } from '@/lib/types';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

// ── Compact stress track renderer with hover ghost + inner shadow ──
function SceneStressMini({
  character,
  canEdit = true,
}: {
  character: Character;
  canEdit?: boolean;
}) {
  const { updateCharacter } = useFateStore();
  const tracks = character.stressTracks ?? [];
  if (tracks.length === 0) return null;

  const toggleBox = (trackIdx: number, boxIdx: number) => {
    // Read-only when the current user can't edit this character (e.g. a
    // network player viewing someone else's sheet).
    if (!canEdit) return;
    const updatedTracks = tracks.map((t, ti) => {
      if (ti !== trackIdx) return t;
      const newMarkers = [...t.markers];
      newMarkers[boxIdx] = !newMarkers[boxIdx];
      return { ...t, markers: newMarkers };
    });
    updateCharacter(character.id, { stressTracks: updatedTracks });
  };

  const clearTrack = (trackIdx: number) => {
    if (!canEdit) return;
    const updatedTracks = tracks.map((t, ti) => {
      if (ti !== trackIdx) return t;
      return { ...t, markers: t.markers.map(() => false) };
    });
    updateCharacter(character.id, { stressTracks: updatedTracks });
  };

  const totalMarked = tracks.reduce(
    (sum, t) => sum + (t.markers?.filter(Boolean).length ?? 0),
    0,
  );
  const totalBoxes = tracks.reduce((sum, t) => sum + (t.markers?.length ?? 0), 0);

  return (
    <div className="flex items-center gap-1.5 mt-0.5">
      {tracks.map((track, ti) => (
        <div
          key={ti}
          className="flex items-center gap-0.5"
          title={`${track.name} — Shift+клик по полю стресса, чтобы очистить весь трек`}
        >
          <span className="text-[10px]" style={{ opacity: 0.7 }}>
            {track.icon || '■'}
          </span>
          <div className="flex items-center gap-0.5">
            {track.markers.map((marked, bi) => (
              <button
                key={bi}
                onClick={(e) => {
                  e.stopPropagation();
                  if (e.shiftKey) {
                    clearTrack(ti);
                  } else {
                    toggleBox(ti, bi);
                  }
                }}
                className="transition-all duration-200 hover:scale-125"
                title={`${track.name} ${track.type === 'progressive' ? bi + 1 : 1}${marked ? ' (отмечено)' : ''}`}
                aria-label={`${track.name} ${track.type === 'progressive' ? bi + 1 : 1}${marked ? ' (отмечено)' : ''}`}
                aria-pressed={marked}
              >
                <span
                  className={`fate-stress-box block rounded-sm ${marked ? 'fate-stress-checked' : ''} flex items-center justify-center`}
                  style={{
                    width: 14,
                    height: 14,
                    backgroundColor: marked ? 'var(--fate-danger)' : 'transparent',
                    border: `1.5px solid ${marked ? 'var(--fate-danger)' : 'var(--fate-text-muted)'}`,
                    opacity: marked ? 1 : 0.45,
                    fontSize: 8,
                    fontWeight: marked ? 800 : 600,
                    color: marked ? 'white' : 'var(--fate-text-muted)',
                    lineHeight: '14px',
                  }}
                >
                  {track.type === 'progressive' ? bi + 1 : 1}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
      {totalMarked > 0 && (
        <span
          className="text-[9px] font-bold ml-1 px-1 rounded"
          style={{
            backgroundColor: 'rgba(231, 76, 60, 0.15)',
            color: 'var(--fate-danger)',
          }}
        >
          {totalMarked}/{totalBoxes}
        </span>
      )}
    </div>
  );
}

// ── Section header for Players / NPC groups ──
function SectionHeader({
  icon,
  label,
  count,
  accentColor,
  bgColor,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  accentColor: string;
  bgColor: string;
}) {
  return (
    <div
      className="flex items-center gap-2 px-2 py-1.5 rounded-md mb-1.5"
      style={{ backgroundColor: bgColor }}
    >
      <span className="text-sm">{icon}</span>
      <span
        className="text-xs font-semibold tracking-wide uppercase"
        style={{ color: accentColor }}
      >
        {label}
      </span>
      <Badge
        variant="secondary"
        className="text-[10px] h-4 px-1.5 font-bold shadow-sm ml-auto"
        style={{ backgroundColor: accentColor, color: 'white' }}
      >
        {count}
      </Badge>
    </div>
  );
}

// ── Character card within a section ──
function CharacterCard({
  char,
  index,
  isOnMap,
  isPlayerMode,
  onQuickRoll,
  onOpenCharacterSheet,
  onRemoveFromScene,
  onAddTokenToMap,
  onRemoveTokenFromMap,
  onAdjustFatePoints,
}: {
  char: Character;
  index: number;
  isOnMap: boolean;
  isPlayerMode: boolean;
  onQuickRoll: (id: string) => void;
  onOpenCharacterSheet: (id: string) => void;
  onRemoveFromScene: (id: string) => void;
  onAddTokenToMap: (id: string) => void;
  onRemoveTokenFromMap: (id: string) => void;
  onAdjustFatePoints: (id: string, delta: number) => void;
}) {
  // ── Access control (network-aware) ───────────────────────────
  // Guards come from the Zustand store. For the local user / network host
  // every guard returns true. A network player only gets canRoll/canEdit
  // for the character assigned to them; canManageScene is always false for
  // network players (host-only operations: add/remove tokens, kick from scene).
  const {
    canRollForCharacter,
    canEditCharacter,
    canEditAdventure,
    myAssignedCharacterIds,
  } = useFateStore();
  const canRoll = canRollForCharacter(char.id);
  const canEdit = canEditCharacter(char.id);
  const isMine = myAssignedCharacterIds().includes(char.id);
  const canManageScene = canEditAdventure();

  const showInvisibleBadge = char.hiddenFromPlayers && !isPlayerMode;

  // ── HTML5 drag-and-drop: allow dragging this character onto the map ──
  const handleDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/fate-char-id', char.id);
    e.dataTransfer.setData('text/plain', char.id); // fallback for some browsers
    e.dataTransfer.effectAllowed = 'copy';
    // Stash payload for live preview rendering on the canvas (dataTransfer
    // values are unreadable during dragover).
    setCharDrag({
      charId: char.id,
      charName: char.name,
      avatar: char.avatar,
      avatarColor: char.avatarColor,
      type: char.type,
    });
  };

  const handleDragEnd = () => {
    setCharDrag(null);
  };

  return (
    <div
      className="fate-card fate-card-hover fate-token-card fate-char-stagger flex items-center gap-2.5 p-2.5 group cursor-default"
      style={{
        borderLeft: `3px solid ${char.type === 'player' ? 'var(--fate-accent)' : 'var(--fate-success)'}`,
        animationDelay: `${index * 50}ms`,
      }}
      draggable
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      title="Перетащите на карту, чтобы разместить токен"
    >
      {/* Character Icon — uses uploaded portrait or colored fallback */}
      <div className="fate-avatar-hover relative shrink-0 transition-transform duration-200 group-hover:scale-110">
        {char.avatar ? (
          <img
            src={char.avatar}
            alt={char.name}
            className="size-9 rounded-full object-cover shadow-sm"
            draggable={false}
          />
        ) : (
          <div
            className="flex items-center justify-center size-9 rounded-full text-white text-xs font-bold shadow-sm"
            style={{
              background: char.avatarColor
                ? char.avatarColor
                : char.type === 'player'
                  ? 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-dark))'
                  : 'linear-gradient(135deg, var(--fate-success), var(--fate-success-dark))',
            }}
          >
            {char.name.charAt(0).toUpperCase()}
          </div>
        )}
        {/* GM-only invisible indicator */}
        {showInvisibleBadge && (
          <div
            className="absolute -top-0.5 -right-0.5 flex items-center justify-center size-4 rounded-full shadow-sm"
            style={{ backgroundColor: 'rgba(127, 140, 141, 0.9)' }}
            title="Скрыт от игроков"
          >
            <EyeOff className="size-2.5 text-white" />
          </div>
        )}
        {char.skills && char.skills.length > 0 && (
          <div className="fate-avatar-hover-info">
            <div style={{ color: 'var(--fate-accent)', fontWeight: 700 }}>
              {char.skills.reduce((best, s) => s.value > best.value ? s : best, char.skills[0]).name}: +{char.skills.reduce((best, s) => s.value > best.value ? s : best, char.skills[0]).value}
            </div>
          </div>
        )}
      </div>

      {/* Character Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium truncate" style={{ color: 'var(--fate-text)' }}>
            {char.name}
          </span>
          {/* "ВЫ" badge — shown when this character is assigned to the
              current network player, so they can spot their own PC at a
              glance in a multi-player session. */}
          {isMine && (
            <span
              className="text-[9px] font-bold px-1 py-0 rounded shrink-0 uppercase tracking-wide"
              style={{
                color: 'white',
                backgroundColor: 'var(--fate-accent)',
              }}
              title="Ваш персонаж"
            >
              Вы
            </span>
          )}
          {/* Map indicator badge */}
          {isOnMap ? (
            <span
              className="text-[8px] px-1 py-0 rounded font-semibold shrink-0"
              style={{ color: 'var(--fate-success)', backgroundColor: 'rgba(39,174,96,0.1)' }}
              title="На карте"
            >
              🗺
            </span>
          ) : (
            <span
              className="text-[8px] px-1 py-0 rounded font-semibold shrink-0"
              style={{ color: 'var(--fate-text-muted)', backgroundColor: 'rgba(127,140,141,0.08)' }}
              title="Не на карте"
            >
              ○
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <p className="text-[10px] truncate" style={{ color: 'var(--fate-text-muted)' }}>
            {char.concept || 'Нет концепта'}
          </p>
        </div>
        {/* Compact stress tracks — clickable to mark/unmark */}
        {char.stressTracks && char.stressTracks.length > 0 && (
          <SceneStressMini character={char} canEdit={canEdit} />
        )}
      </div>

      {/* Fate Points Mini Display — compact clickable badge.
          When the current user can't edit this character (e.g. a network
          player viewing someone else's PC), the +/- buttons are hidden and
          only the read-only FP value remains. */}
      <div
        className="flex items-center gap-0 px-1 py-0.5 rounded shrink-0 text-[10px] font-bold fate-fp-badge group/fp"
        style={{
          backgroundColor: 'rgba(230, 126, 34, 0.1)',
          color: 'var(--fate-accent)',
        }}
        title={canEdit ? 'Очки судьбы (клик для изменения)' : 'Очки судьбы (только просмотр)'}
      >
        {canEdit && (
          <button
            className="opacity-0 group-hover/fp:opacity-100 hover:scale-125 transition-all duration-150 px-0 text-[9px]"
            onClick={(e) => { e.stopPropagation(); onAdjustFatePoints(char.id, -1); }}
            title="Уменьшить"
          >
            −
          </button>
        )}
        <span
          key={char.fatePoints}
          className="fate-fp-pulse px-0.5 inline-block"
        >
          ⭐{char.fatePoints}
        </span>
        {canEdit && (
          <button
            className="opacity-0 group-hover/fp:opacity-100 hover:scale-125 transition-all duration-150 px-0 text-[9px]"
            onClick={(e) => { e.stopPropagation(); onAdjustFatePoints(char.id, +1); }}
            title="Увеличить"
          >
            +
          </button>
        )}
      </div>

      {/* Type Badge — far right */}
      <Badge
        variant="outline"
        className="text-[10px] h-4 px-1.5 shrink-0 font-medium"
        style={{
          borderColor: char.type === 'player' ? 'var(--fate-accent)' : 'var(--fate-success)',
          color: char.type === 'player' ? 'var(--fate-accent)' : 'var(--fate-success)',
          backgroundColor: char.type === 'player' ? 'rgba(230, 126, 34, 0.06)' : 'rgba(39, 174, 96, 0.06)',
        }}
      >
        {char.type === 'player' ? 'Игрок' : 'NPC'}
      </Badge>

      {/* Action Buttons */}
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-all duration-200">
        {/* Add to map — host-only scene management */}
        {canManageScene && !isOnMap && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 hover:scale-110 active:scale-95 transition-transform duration-150"
            style={{ color: 'var(--fate-success)' }}
            onClick={() => onAddTokenToMap(char.id)}
            title="Добавить на карту"
          >
            <MapPin className="size-3.5" />
          </Button>
        )}
        {/* Remove from map — host-only scene management */}
        {canManageScene && isOnMap && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 hover:scale-110 active:scale-95 transition-transform duration-150"
            style={{ color: 'var(--fate-text-muted)' }}
            onClick={() => onRemoveTokenFromMap(char.id)}
            title="Убрать с карты"
          >
            <MapPin className="size-3.5" style={{ opacity: 0.5 }} />
          </Button>
        )}
        {/* Dice roll — disabled when the user can't roll for this character
            (e.g. a network player not assigned to this PC). A disabled
            shadcn Button still shows the title tooltip on hover. */}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 hover:scale-110 active:scale-95 transition-transform duration-150"
          style={{ color: canRoll ? 'var(--fate-accent)' : 'var(--fate-text-muted)', opacity: canRoll ? 1 : 0.4 }}
          onClick={() => onQuickRoll(char.id)}
          disabled={!canRoll}
          title={canRoll ? 'Бросок' : 'Недоступно для этого персонажа'}
        >
          <Dice5 className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 hover:scale-110 active:scale-95 transition-transform duration-150"
          style={{ color: 'var(--fate-text-muted)' }}
          onClick={() => onOpenCharacterSheet(char.id)}
          title="Лист персонажа"
        >
          <FileText className="size-3.5" />
        </Button>
        {/* Remove from scene — host-only scene management */}
        {canManageScene && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 hover:scale-110 active:scale-95 transition-transform duration-150"
            style={{ color: 'var(--fate-danger)' }}
            onClick={() => onRemoveFromScene(char.id)}
            title="Убрать со сцены"
          >
            <Minus className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

interface ScenePanelProps {
  onOpenCharacterSheet: (charId: string) => void;
  onQuickRoll: (charId: string) => void;
  onOpenLibraryDialog: () => void;
  onOpenInventoryDialog: () => void;
  /** Внешний триггер массового броска: инкрементируется шапкой/Cmd+K/
   *  горячей клавишей M. ScenePanel реагирует входом в режим броска +
   *  переключением на вкладку «Масс.». */
  massRollTrigger?: number;
}

export function ScenePanel({ onOpenCharacterSheet, onQuickRoll, massRollTrigger }: ScenePanelProps) {
  const { characters, scenes, currentSceneId, currentMode, isLoading, settings, removeCharacterFromScene, updateCharacter, addTokenToMap, removeTokenFromMap, massRollState, networkMyPeerId } = useFateStore();

  // ── Roll mode: when true, the entire left panel is replaced by RollToolPanel.
  // This gives the roll tool full vertical space — better for animations,
  // opposed/difficulty rolls, and result display.
  const [rollMode, setRollMode] = useState(false);

  // ── Реакция на внешний триггер массового броска ──
  // Используем паттерн «adjusting state during render» (React docs) вместо
  // useEffect+setState — так избегаем каскадных ре-рендеров.
  const [prevMassTrigger, setPrevMassTrigger] = useState(0);
  if (massRollTrigger && massRollTrigger > prevMassTrigger) {
    setPrevMassTrigger(massRollTrigger);
    setRollMode(true);
  }

  // ── Приглашение к массовому броску для текущего игрока ──
  // Раньше панель броска открывалась автоматически — это слишком агрессивно:
  // если игрок листал сцену, его выбрасывало в панель. Теперь вместо
  // авто-открытия кнопка «Бросок» в шапке пульсирует и показывает бейдж «!».
  // Если игрок уже в панели броска — приглашение видно там (MassRollRequestView).
  //
  // ВАЖНО: пульсация показывается ТОЛЬКО пока игрок ещё не сделал бросок.
  // После броска (myParticipant.result заполнен) или при завершении/отмене
  // сессии — кнопка перестаёт мигать, чтобы не вводить в заблуждение.
  const hasMyMassRollRequest = useMemo(() => {
    if (!massRollState || !networkMyPeerId) return false;
    if (massRollState.status === 'complete' || massRollState.status === 'cancelled') return false;
    const me = massRollState.participants.find((p) => p.peerId === networkMyPeerId);
    if (!me) return false;
    // Уже сделал бросок — приглашение более неактуально, не мигаем.
    if (me.result) return false;
    return true;
  }, [massRollState, networkMyPeerId]);

  // ── Есть ли у меня завершённый бросок в активной сессии? ──
  // Используется для мягкой индикации (без пульсации): «у вас есть результаты
  // броска — нажмите, чтобы посмотреть / сделать корректировки».
  const hasMyMassRollResult = useMemo(() => {
    if (!massRollState || !networkMyPeerId) return false;
    if (massRollState.status === 'cancelled') return false;
    const me = massRollState.participants.find((p) => p.peerId === networkMyPeerId);
    if (!me) return false;
    return !!me.result;
  }, [massRollState, networkMyPeerId]);

  // ── Toast при появлении приглашения ──
  // Чтобы игрок точно заметил, даже если не смотрит на кнопку: показываем
  // toast со звукоподобным призывом. Срабатывает только на переходе false→true
  // и только когда панель броска закрыта (иначе тост дублирует то, что видно).
  const prevHadRequestRef = useRef(false);
  useEffect(() => {
    if (hasMyMassRollRequest && !prevHadRequestRef.current && !rollMode) {
      toast.info('🎲 Вас приглашают к броску!', {
        description: 'Нажмите кнопку «Бросок» в шапке сцены',
        duration: 6000,
      });
    }
    prevHadRequestRef.current = hasMyMassRollRequest;
  }, [hasMyMassRollRequest, rollMode]);

  const handleAdjustFatePoints = (charId: string, delta: number) => {
    const char = characters.find((c) => c.id === charId);
    if (!char) return;
    const newValue = Math.max(0, char.fatePoints + delta);
    updateCharacter(charId, { fatePoints: newValue });
  };

  const currentScene = scenes.find((s) => s.id === currentSceneId) ?? null;
  const isPlayerMode = currentMode === 'player';

  // PCs come from the persistent player roster (visible across all scenes)
  // NPCs come from the current scene's presentCharacters
  const rosterIds: string[] = settings.playerRoster ?? [];
  const sceneNpcIds: string[] = currentScene?.presentCharacters ?? [];
  const visibleIds = new Set<string>([...rosterIds, ...sceneNpcIds]);
  const sceneCharacters = characters.filter((c) => {
    if (!visibleIds.has(c.id)) return false;
    // In player mode, hide characters marked as hidden from players
    if (isPlayerMode && c.hiddenFromPlayers) return false;
    return true;
  });

  // Split into players and NPCs
  const playerChars = sceneCharacters.filter((c) => c.type === 'player');
  const npcChars = sceneCharacters.filter((c) => c.type === 'npc');

  // Check if a character has a token on any floor
  const hasTokenOnAnyFloor = (charId: string): boolean => {
    if (!currentScene) return false;
    return currentScene.floors.some((f) => f.tokens.some((t) => t.charId === charId));
  };

  return (
    <div className="flex flex-col h-full overflow-hidden fate-bg-texture fate-scene-gradient-top">
      {/* ── If roll mode is active, replace the character list with RollToolPanel,
          but keep DiceStation visible at the bottom (so player can roll / see
          dice result). ── */}
      {rollMode ? (
        <>
          <div className="flex-1 min-h-0 overflow-hidden">
            <RollToolPanel onClose={() => setRollMode(false)} massTrigger={massRollTrigger} />
          </div>
          <DiceStation
            onOpenRollMenu={() => setRollMode(true)}
            onBack={() => setRollMode(false)}
            hasMyMassRollRequest={hasMyMassRollRequest}
            hasMyMassRollResult={hasMyMassRollResult}
            rollModeActive
          />
        </>
      ) : (
      <>
      {/* Section Header */}
      <div
        className="flex items-center justify-between px-3 py-2.5 fate-section-header"
        style={{ borderColor: 'var(--fate-border)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="fate-icon-circle text-sm"
            style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
          >
            🎭
          </div>
          <h2 className="font-semibold text-sm" style={{ color: 'var(--fate-text)' }}>
            Персонажи на сцене
          </h2>
          <Badge
            variant="secondary"
            className="text-xs h-5 px-2 shadow-sm"
            style={{ backgroundColor: 'var(--fate-accent)', color: 'white' }}
          >
            {sceneCharacters.length}
          </Badge>
        </div>
        <div className="flex items-center gap-1.5">
          {/* Кнопка «Бросок» убрана — открытие меню броска теперь делается
              через синюю кнопку «Бросить кубики» в блоке DiceStation внизу.
              Mass-roll приглашения и индикация результатов тоже переехали
              на кнопку DiceStation (см. props hasMyMassRollRequest/Result). */}
          {currentScene && (
            <span
              className="text-xs font-semibold px-2 py-0.5 rounded-md shadow-sm"
              style={{
                color: 'white',
                background: 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-light))',
                backgroundSize: '200% auto',
                animation: 'fate-gradient-shift 8s ease-in-out infinite',
              }}
            >
              {currentScene.name}
            </span>
          )}
        </div>
      </div>

      {/* Character List */}
      <ScrollArea className="flex-1 min-h-0 fate-scroll">
        <div className="p-2 space-y-1">
          {isLoading ? (
            // Loading skeleton
            [0, 1, 2].map((i) => (
              <div
                key={i}
                className="fate-skeleton-card flex items-center gap-2.5 animate-fade-in"
                style={{ animationDelay: `${i * 90}ms` }}
                aria-hidden="true"
              >
                <Skeleton className="size-9 rounded-full shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-2 w-32" />
                  <div className="flex items-center gap-1 pt-1">
                    <Skeleton className="size-2 rounded-full" />
                    <Skeleton className="size-2 rounded-full" />
                    <Skeleton className="size-2 rounded-full" />
                  </div>
                </div>
                <Skeleton className="size-7 rounded-md shrink-0" />
              </div>
            ))
          ) : sceneCharacters.length === 0 ? (
            <div className="text-center py-12 px-4 animate-fade-in fate-empty-state">
              <div
                className="fate-empty-icon size-16 mx-auto flex items-center justify-center mb-3"
                style={{ backgroundColor: 'rgba(127, 140, 141, 0.08)' }}
              >
                <Users className="size-8" style={{ color: 'var(--fate-text-muted)', opacity: 0.35 }} />
              </div>
              <p className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Нет персонажей на сцене
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--fate-text-muted)', opacity: 0.6 }}>
                Добавьте персонажей из библиотеки, чтобы начать
              </p>
            </div>
          ) : (
            <>
              {/* Players Section */}
              {playerChars.length > 0 && (
                <div>
                  <SectionHeader
                    icon={<Users className="size-3.5" />}
                    label="Игроки"
                    count={playerChars.length}
                    accentColor="var(--fate-accent)"
                    bgColor="rgba(230, 126, 34, 0.06)"
                  />
                  <div className="space-y-1.5 pl-1">
                    {playerChars.map((char, index) => (
                      <CharacterCard
                        key={char.id}
                        char={char}
                        index={index}
                        isOnMap={hasTokenOnAnyFloor(char.id)}
                        isPlayerMode={isPlayerMode}
                        onQuickRoll={onQuickRoll}
                        onOpenCharacterSheet={onOpenCharacterSheet}
                        onRemoveFromScene={removeCharacterFromScene}
                        onAddTokenToMap={addTokenToMap}
                        onRemoveTokenFromMap={removeTokenFromMap}
                        onAdjustFatePoints={handleAdjustFatePoints}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Separator between sections */}
              {playerChars.length > 0 && npcChars.length > 0 && (
                <div
                  className="my-2 border-t"
                  style={{ borderColor: 'var(--fate-border)', opacity: 0.5 }}
                />
              )}

              {/* NPC Section */}
              {npcChars.length > 0 && (
                <div>
                  <SectionHeader
                    icon={<Shield className="size-3.5" />}
                    label="NPC"
                    count={npcChars.length}
                    accentColor="var(--fate-success)"
                    bgColor="rgba(39, 174, 96, 0.06)"
                  />
                  <div className="space-y-1.5 pl-1">
                    {npcChars.map((char, index) => (
                      <CharacterCard
                        key={char.id}
                        char={char}
                        index={index}
                        isOnMap={hasTokenOnAnyFloor(char.id)}
                        isPlayerMode={isPlayerMode}
                        onQuickRoll={onQuickRoll}
                        onOpenCharacterSheet={onOpenCharacterSheet}
                        onRemoveFromScene={removeCharacterFromScene}
                        onAddTokenToMap={addTokenToMap}
                        onRemoveTokenFromMap={removeTokenFromMap}
                        onAdjustFatePoints={handleAdjustFatePoints}
                      />
                    ))}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>

      {/* DiceStation — единый блок «набор кубиков на столе».
          4 настоящих 3D-кубика (вид сверху) как физические объекты
          + блок UI для бросков (модификатор, кнопка, результат).
          Кубики лежат здесь → значит и настройка броска здесь.
          Кнопка «Бросить кубики» теперь открывает RollToolPanel
          (вместо прямого physics-броска). Mass-roll приглашения
          и индикация результатов тоже на этой кнопке.

          Жест-бросок: когда RollToolPanel открыт (rollMode=true),
          кубы в кейсе становятся draggable — игрок "берёт" их и
          тащит на центральную карту. dragEnabled={rollMode}. */}
      <DiceStation
        onOpenRollMenu={() => setRollMode(true)}
        onBack={() => setRollMode(false)}
        hasMyMassRollRequest={hasMyMassRollRequest}
        hasMyMassRollResult={hasMyMassRollResult}
        rollModeActive={rollMode}
      />
      </>
      )}
    </div>
  );
}
