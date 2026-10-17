'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, CircleDot, Dices, Skull, RotateCcw, Square, EyeOff, UserPlus, Clock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';

import { useFateStore } from '@/lib/store';
import type { Condition } from '@/lib/types';

// ── Conflict Type Dialog ───────────────────────────────────
interface ConflictTypeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStartConflict: (type: 'physical' | 'mental') => void;
}

export function ConflictTypeDialog({ open, onOpenChange, onStartConflict }: ConflictTypeDialogProps) {
  const [starting, setStarting] = useState(false);
  const settings = useFateStore((s) => s.settings);

  const handleStart = useCallback(async (type: 'physical' | 'mental') => {
    setStarting(true);
    try {
      await onStartConflict(type);
      onOpenChange(false);
    } finally {
      setStarting(false);
    }
  }, [onStartConflict, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" showCloseButton={!starting}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <span className="text-sm">⚔️</span>
            </div>
            Начать конфликт
          </DialogTitle>
          <DialogDescription>
            Выберите тип конфликта для определения инициативы
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-3 py-2">
          <Button
            variant="outline"
            className="h-auto py-3 px-4 justify-start gap-3 rounded-lg transition-all duration-200 hover:shadow-md hover:translate-x-1"
            disabled={starting}
            onClick={() => handleStart('physical')}
          >
            <div
              className="size-10 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'rgba(231, 76, 60, 0.12)' }}
            >
              <span className="text-xl">💥</span>
            </div>
            <div className="text-left">
              <div className="font-semibold text-sm">Физический конфликт</div>
              <div className="text-xs opacity-60 mt-0.5">Инициатива: {settings.initiative.physical.primary}</div>
            </div>
          </Button>

          <Button
            variant="outline"
            className="h-auto py-3 px-4 justify-start gap-3 rounded-lg transition-all duration-200 hover:shadow-md hover:translate-x-1"
            disabled={starting}
            onClick={() => handleStart('mental')}
          >
            <div
              className="size-10 rounded-lg flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'rgba(155, 89, 182, 0.12)' }}
            >
              <span className="text-xl">🧠</span>
            </div>
            <div className="text-left">
              <div className="font-semibold text-sm">Ментальный конфликт</div>
              <div className="text-xs opacity-60 mt-0.5">Инициатива: {settings.initiative.mental.primary}</div>
            </div>
          </Button>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={starting}
            className="rounded-lg"
          >
            Отмена
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Initiative Tracker (floating overlay) ──────────────────
interface InitiativeTrackerProps {
  onEndConflict: () => void;
}

export function InitiativeTracker({ onEndConflict }: InitiativeTrackerProps) {
  const { toast } = useToast();
  const { scenes, currentSceneId, characters, currentMode, settings, nextTurn, eliminateParticipant, returnParticipant, tickConditions, rollInitiativeForAll, addParticipantToConflict, isNetworkActive, networkRole, canEndTurnFor, canEditAdventure, myAssignedCharacterId } = useFateStore();
  const scene = scenes.find((s) => s.id === currentSceneId) ?? null;
  const conflictData = scene?.conflictData ?? null;
  const isPlayerMode = currentMode === 'player';

  // ── Access control: host/local retain full control; network players are restricted ──
  const isNetworkPlayer = isNetworkActive && networkRole === 'player';
  const canEditAdv = canEditAdventure();
  const myAssigned = myAssignedCharacterId();

  const [contextMenu, setContextMenu] = useState<{
    charId: string;
    x: number;
    y: number;
  } | null>(null);

  const [confirmEndOpen, setConfirmEndOpen] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [rollingInitiative, setRollingInitiative] = useState(false);
  const [addParticipantOpen, setAddParticipantOpen] = useState(false);

  // ── One-click initiative roll for all participants ──────────
  const handleRollInitiative = useCallback(async () => {
    if (rollingInitiative) return;
    setRollingInitiative(true);
    try {
      await rollInitiativeForAll();
    } finally {
      // Small delay so the spinning-dice animation has time to register
      setTimeout(() => setRollingInitiative(false), 600);
    }
  }, [rollingInitiative, rollInitiativeForAll]);

  // ── Track previous round number to detect new round ───────
  const prevRoundRef = useRef<number>(conflictData?.round ?? 0);

  useEffect(() => {
    prevRoundRef.current = conflictData?.round ?? 0;
  }, [conflictData?.round]);

  const handleContextMenu = useCallback((e: React.MouseEvent, charId: string) => {
    // Eliminate/return is a host-only operation — skip opening the menu entirely for non-hosts.
    if (!canEditAdv) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ charId, x: e.clientX, y: e.clientY });
  }, [canEditAdv]);

  const handleBackdropClick = useCallback(() => {
    setContextMenu(null);
  }, []);

  // ── Look up a character's active conditions (across all floors) ──
  const getCharConditions = useCallback((charId: string): Condition[] => {
    if (!scene) return [];
    const token = scene.floors.flatMap((f) => f.tokens).find((t) => t.charId === charId);
    return token?.conditions ?? [];
  }, [scene]);

  // ── Check if character is hidden from players ──
  const isCharHidden = useCallback((charId: string): boolean => {
    const char = characters.find((c) => c.id === charId);
    return char?.hiddenFromPlayers ?? false;
  }, [characters]);

  // ── Handle next turn — calls tickConditions when a new round starts ──
  const handleNextTurn = useCallback(async () => {
    if (advancing) return;
    // Read the current participant's character id from the latest store state
    // (declared later in the render, so we look it up freshly here).
    const liveScene = useFateStore.getState().scenes.find((s) => s.id === currentSceneId);
    const liveConflict = liveScene?.conflictData ?? null;
    const liveCharId = liveConflict
      ? liveConflict.participants[liveConflict.currentParticipantIndex]?.characterId ?? null
      : null;
    // Access control: only the assigned player (or host/local) can end this character's turn.
    if (!liveCharId || !canEndTurnFor(liveCharId)) {
      toast({
        variant: 'destructive',
        title: 'Действие недоступно',
        description: 'Вы можете завершать только свой ход',
      });
      return;
    }
    const prevRound = prevRoundRef.current;
    setAdvancing(true);
    try {
      await nextTurn();
      // Detect if a new round started by reading the latest store state
      const updated = useFateStore.getState().scenes.find((s) => s.id === currentSceneId);
      const newRound = updated?.conflictData?.round ?? prevRound;
      if (newRound > prevRound) {
        await tickConditions();
      }
    } finally {
      setAdvancing(false);
    }
  }, [advancing, canEndTurnFor, currentSceneId, nextTurn, tickConditions, toast]);

  // ── Characters available to add to conflict (on scene + on map, but not in conflict) ──
  const availableToAdd = useCallback(() => {
    if (!scene || !conflictData) return [];
    const tokenCharIds = new Set(scene.floors.flatMap((f) => f.tokens.map((t) => t.charId)));
    const inConflict = new Set([
      ...conflictData.participants.map((p) => p.characterId),
      ...conflictData.eliminatedIds,
      ...(conflictData.waitingIds ?? []),
    ]);
    return characters.filter((c) =>
      scene.presentCharacters.includes(c.id) && tokenCharIds.has(c.id) && !inConflict.has(c.id),
    );
  }, [scene, conflictData, characters]);

  if (!conflictData) return null;

  const { type, round, participants, currentParticipantIndex, eliminatedIds } = conflictData;
  const waitingIds = conflictData.waitingIds ?? [];

  // Split participants into visible and hidden (for player mode)
  const activeParticipants = participants.filter((p) => !eliminatedIds.includes(p.characterId));
  const eliminatedParticipants = participants.filter((p) => eliminatedIds.includes(p.characterId));

  const currentCharId = participants[currentParticipantIndex]?.characterId ?? null;

  const getCharName = (charId: string) => {
    const char = characters.find((c) => c.id === charId);
    return char?.name ?? 'Неизвестный';
  };

  const getCharType = (charId: string) => {
    const char = characters.find((c) => c.id === charId);
    return char?.type ?? 'npc';
  };

  return (
    <>
      {/* Context menu backdrop */}
      {contextMenu && (
        <div className="fixed inset-0 z-[100]" onClick={handleBackdropClick} />
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-[101] rounded-lg shadow-xl border py-1 min-w-[160px] overflow-hidden"
          style={{
            backgroundColor: 'var(--fate-bg-card)',
            left: contextMenu.x,
            top: contextMenu.y,
            borderColor: 'var(--fate-border)',
          }}
        >
          {eliminatedIds.includes(contextMenu.charId) ? (
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-green-50 dark:hover:bg-green-950/30 flex items-center gap-2 transition-colors"
              onClick={() => {
                returnParticipant(contextMenu.charId);
                setContextMenu(null);
              }}
            >
              <RotateCcw className="size-3.5 text-green-600" />
              <span>Вернуть</span>
            </button>
          ) : (
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center gap-2 transition-colors"
              onClick={() => {
                eliminateParticipant(contextMenu.charId);
                setContextMenu(null);
              }}
            >
              <Skull className="size-3.5 text-red-500" />
              <span>Выбыл</span>
            </button>
          )}
        </div>
      )}

      {/* Tracker Panel */}
      <div
        className="absolute top-2 left-2 z-30 w-60 max-h-[calc(100%-1rem)] flex flex-col rounded-xl overflow-hidden transition-all duration-300"
        style={{
          backgroundColor: 'rgba(44, 62, 80, 0.92)',
          backdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.1)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        {/* Header — conflict type + round counter with icon badge */}
        <div
          className="px-3 py-2.5 flex items-center justify-between shrink-0 fate-conflict-header"
          style={{
            background: 'linear-gradient(135deg, rgba(230,126,34,0.3), rgba(230,126,34,0.1))',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            {/* Conflict-type icon badge */}
            <div
              className="size-7 rounded-lg flex items-center justify-center shrink-0 fate-conflict-icon-badge"
              style={{
                background: type === 'physical'
                  ? 'linear-gradient(135deg, rgba(231,76,60,0.35), rgba(192,57,43,0.25))'
                  : 'linear-gradient(135deg, rgba(155,89,182,0.35), rgba(142,68,173,0.25))',
                border: `1px solid ${type === 'physical' ? 'rgba(231,76,60,0.4)' : 'rgba(155,89,182,0.4)'}`,
              }}
              aria-hidden="true"
            >
              <span className="text-xs">{type === 'physical' ? '💥' : '🧠'}</span>
            </div>
            <div className="min-w-0">
              <div className="text-white text-xs font-bold tracking-wide truncate">
                {type === 'physical' ? 'Физический' : 'Ментальный'}
              </div>
              <div className="text-white/60 text-[10px] flex items-center gap-1">
                <span className="fate-round-dot" aria-hidden="true" />
                Раунд <span className="font-bold text-white/80 tabular-nums">{round}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {/* Add participant button (host/local only) */}
            {canEditAdv && availableToAdd().length > 0 && (
              <button
                className="text-white/70 hover:text-green-300 transition-colors p-1 rounded hover:bg-white/10"
                title="Добавить участника"
                aria-label="Добавить участника"
                onClick={() => setAddParticipantOpen(true)}
              >
                <UserPlus className="size-3.5" />
              </button>
            )}
            {/* Roll initiative button (host/local only) */}
            {canEditAdv && (
              <button
                className="text-white/70 hover:text-orange-300 transition-colors p-1 rounded hover:bg-white/10 disabled:opacity-50 disabled:cursor-not-allowed"
                title={settings.initiative.mode === 'book' ? 'Пересчитать инициативу' : 'Бросить инициативу для всех'}
                aria-label={settings.initiative.mode === 'book' ? 'Пересчитать инициативу' : 'Бросить инициативу для всех'}
                onClick={handleRollInitiative}
                disabled={rollingInitiative}
              >
                <Dices className={`size-3.5 ${rollingInitiative ? 'animate-spin' : ''}`} />
              </button>
            )}
            {/* End conflict button (host/local only) */}
            {canEditAdv && (
              <button
                className="text-white/50 hover:text-red-400 transition-colors p-1 rounded hover:bg-white/10"
                title="Завершить конфликт"
                onClick={() => setConfirmEndOpen(true)}
              >
                <Square className="size-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Participants list */}
        <div className="flex-1 overflow-y-auto fate-scroll py-1">
          {activeParticipants.map((participant, idx) => {
            const isCurrent = participant.characterId === currentCharId;
            const charName = getCharName(participant.characterId);
            const charType = getCharType(participant.characterId);
            const charConditions = getCharConditions(participant.characterId);
            const isHidden = isCharHidden(participant.characterId);
            const isNew = participant.addedThisRound;

            // In player mode: skip invisible characters
            if (isPlayerMode && isHidden) {
              return null;
            }

            return (
              <div
                key={participant.characterId}
                className={`px-3 py-1.5 flex items-center gap-2 transition-all duration-200 ${
                  canEditAdv ? 'cursor-pointer' : 'cursor-default'
                } ${
                  isCurrent
                    ? 'bg-orange-500/25'
                    : participant.hasActed
                      ? 'opacity-40'
                      : 'hover:bg-white/5'
                }`}
                onContextMenu={(e) => handleContextMenu(e, participant.characterId)}
                title={canEditAdv ? 'ПКМ для опций' : undefined}
              >
                {/* Current indicator */}
                <div className="shrink-0 w-4 flex justify-center">
                  {isCurrent ? (
                    <CircleDot className="size-3.5 text-orange-400" style={{ animation: 'fate-pulse-glow 1.5s ease-in-out infinite' }} />
                  ) : participant.hasActed ? (
                    <div className="size-1.5 rounded-full bg-white/30" />
                  ) : (
                    <div className="size-2 rounded-full bg-white/50" />
                  )}
                </div>

                {/* Avatar circle */}
                <div
                  className="size-6 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold text-white relative"
                  style={{
                    backgroundColor: isCurrent
                      ? '#e67e22'
                      : charType === 'player'
                        ? 'rgba(230, 126, 34, 0.6)'
                        : 'rgba(39, 174, 96, 0.6)',
                  }}
                >
                  {charName.charAt(0).toUpperCase()}
                  {/* Invisible indicator (GM only) */}
                  {isHidden && !isPlayerMode && (
                    <div
                      className="absolute -top-0.5 -right-0.5 flex items-center justify-center size-3 rounded-full shadow-sm"
                      style={{ backgroundColor: 'rgba(127, 140, 141, 0.9)' }}
                      title="Невидим для игроков"
                    >
                      <EyeOff className="size-2 text-white" />
                    </div>
                  )}
                  {/* New participant indicator */}
                  {isNew && (
                    <div
                      className="absolute -top-0.5 -left-0.5 flex items-center justify-center size-3 rounded-full shadow-sm"
                      style={{ backgroundColor: 'rgba(39, 174, 96, 0.9)' }}
                      title="Новый участник"
                    >
                      <span className="text-[7px] text-white font-bold">N</span>
                    </div>
                  )}
                </div>

                {/* Name + condition badges */}
                <div className="flex-1 min-w-0 flex items-center gap-1">
                  <span
                    className={`text-[11px] font-medium truncate ${
                      isCurrent ? 'text-orange-300' : 'text-white'
                    } ${isHidden && !isPlayerMode ? 'italic opacity-80' : ''}`}
                  >
                    {charName}
                  </span>
                  {charConditions.slice(0, 3).map((c) => (
                    <span
                      key={c.id}
                      className="size-3.5 rounded-full flex items-center justify-center text-[9px] shrink-0 leading-none"
                      style={{
                        backgroundColor: c.color,
                        border: '1px solid rgba(255,255,255,0.8)',
                      }}
                      title={`${c.name}${c.duration === -1 ? ' (∞)' : ` (${c.duration} раунд.)`}${c.description ? ` — ${c.description}` : ''}`}
                    >
                      {c.icon}
                    </span>
                  ))}
                  {charConditions.length > 3 && (
                    <span className="text-[9px] text-white/60 shrink-0 font-bold">
                      +{charConditions.length - 3}
                    </span>
                  )}
                </div>

                {/* Initiative value */}
                <div
                  className={`text-[11px] font-bold tabular-nums ${
                    isCurrent ? 'text-orange-300' : 'text-white/50'
                  }`}
                >
                  {participant.initiative >= 0 ? '+' : ''}{participant.initiative}
                </div>
              </div>
            );
          })}

          {/* Waiting participants (GM only) */}
          {!isPlayerMode && waitingIds.length > 0 && (
            <>
              <div
                className="px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-white/30 flex items-center gap-1"
                style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
              >
                <Clock className="size-2.5" />
                Ожидающие ({waitingIds.length})
              </div>
              {waitingIds.map((charId) => {
                const charName = getCharName(charId);
                return (
                  <div
                    key={charId}
                    className="px-3 py-1 flex items-center gap-2 opacity-60"
                  >
                    <div className="shrink-0 w-4 flex justify-center">
                      <Clock className="size-2.5 text-yellow-400/60" />
                    </div>
                    <div
                      className="size-5 rounded-full flex items-center justify-center shrink-0 text-[8px] font-bold text-white/40"
                      style={{ backgroundColor: 'rgba(243, 156, 18, 0.3)' }}
                    >
                      {charName.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-[10px] text-yellow-300/60 italic truncate flex-1">
                      {charName}
                    </span>
                  </div>
                );
              })}
            </>
          )}

          {/* Eliminated participants */}
          {eliminatedParticipants.length > 0 && (
            <>
              <div
                className="px-3 py-1 text-[9px] font-bold uppercase tracking-wider text-white/30"
                style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}
              >
                Выбывшие
              </div>
              {eliminatedParticipants.map((participant) => {
                const charName = getCharName(participant.characterId);
                const isHidden = isCharHidden(participant.characterId);

                // Hide eliminated invisible chars from players
                if (isPlayerMode && isHidden) return null;

                return (
                  <div
                    key={participant.characterId}
                    className={`px-3 py-1 flex items-center gap-2 transition-colors ${
                      canEditAdv ? 'cursor-pointer hover:bg-white/5' : 'cursor-default'
                    }`}
                    onContextMenu={(e) => handleContextMenu(e, participant.characterId)}
                    title={canEditAdv ? 'ПКМ: вернуть' : undefined}
                  >
                    <div className="shrink-0 w-4 flex justify-center">
                      <Skull className="size-3 text-red-400/50" />
                    </div>
                    <div
                      className="size-6 rounded-full flex items-center justify-center shrink-0 text-[10px] font-bold text-white/40"
                      style={{
                        backgroundColor: 'rgba(100,100,100,0.3)',
                      }}
                    >
                      {charName.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] text-white/30 line-through truncate">
                        {charName}
                      </div>
                    </div>
                    <div className="text-[11px] text-white/20 tabular-nums">
                      {participant.initiative >= 0 ? '+' : ''}{participant.initiative}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* Footer — Next Turn button */}
        <div
          className="px-2 py-2 shrink-0"
          style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}
        >
          <button
            className="w-full py-1.5 rounded-lg text-xs font-bold text-white flex items-center justify-center gap-1.5 transition-all duration-200 hover:shadow-lg active:scale-95 disabled:opacity-60 disabled:cursor-not-allowed"
            style={{
              background: 'linear-gradient(135deg, #e67e22, #d35400)',
            }}
            onClick={handleNextTurn}
            disabled={advancing || !canEndTurnFor(currentCharId)}
            title={
              !canEndTurnFor(currentCharId)
                ? isNetworkPlayer
                  ? myAssigned
                    ? 'Дождитесь своего хода'
                    : 'Только мастер может пропускать ходы'
                  : 'Недоступно'
                : 'Следующий ход'
            }
          >
            <ChevronRight className="size-3.5" />
            Следующий ход
          </button>
        </div>
      </div>

      {/* Add Participant Dialog */}
      <Dialog open={addParticipantOpen} onOpenChange={setAddParticipantOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <UserPlus className="size-5" style={{ color: 'var(--fate-success)' }} />
              Добавить участника
            </DialogTitle>
            <DialogDescription>
              Выберите персонажа для вступления в конфликт
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-64 overflow-y-auto fate-scroll">
            {availableToAdd().map((char) => (
              <div
                key={char.id}
                className="flex items-center gap-3 p-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
              >
                <div
                  className="size-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold text-white"
                  style={{
                    backgroundColor: char.type === 'player'
                      ? 'rgba(230, 126, 34, 0.6)'
                      : 'rgba(39, 174, 96, 0.6)',
                  }}
                >
                  {char.name.charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate" style={{ color: 'var(--fate-text)' }}>
                    {char.name}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                    {char.type === 'player' ? 'Игрок' : 'NPC'}
                    {char.hiddenFromPlayers && ' • Невидим'}
                  </div>
                </div>
                <div className="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-[10px] h-7 px-2 rounded-md"
                    onClick={async () => {
                      await addParticipantToConflict(char.id, false);
                      setAddParticipantOpen(false);
                    }}
                    title="Вступит в следующем раунде"
                  >
                    <Clock className="size-3 mr-1" />
                    Далее
                  </Button>
                  <Button
                    size="sm"
                    className="text-[10px] h-7 px-2 rounded-md fate-btn-accent"
                    onClick={async () => {
                      await addParticipantToConflict(char.id, true);
                      setAddParticipantOpen(false);
                    }}
                    title="Вступит немедленно"
                  >
                    <ChevronRight className="size-3 mr-1" />
                    Сейчас
                  </Button>
                </div>
              </div>
            ))}
            {availableToAdd().length === 0 && (
              <div className="text-center py-4 text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                Нет доступных персонажей для добавления
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAddParticipantOpen(false)} className="rounded-lg">
              Отмена
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm End Conflict Dialog */}
      <Dialog open={confirmEndOpen} onOpenChange={setConfirmEndOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>⏹️ Завершить конфликт?</DialogTitle>
            <DialogDescription>
              Стресс и ситуативные аспекты будут сброшены. Последствия сохранятся. Это действие нельзя отменить.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="ghost"
              onClick={() => setConfirmEndOpen(false)}
              className="rounded-lg"
            >
              Отмена
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                onEndConflict();
                setConfirmEndOpen(false);
              }}
              className="rounded-lg"
            >
              Завершить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
