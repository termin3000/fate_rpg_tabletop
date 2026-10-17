'use client';

import { useState, useEffect, useMemo } from 'react';
import { Wand2, AlertTriangle, Zap } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useFateStore } from '@/lib/store';
import type { MagicTableEntry } from '@/lib/types';

type CastType = 'normal' | 'dangerous';

interface MagicRollResult {
  roll: number;
  entry: MagicTableEntry | null;
  castType: CastType;
  zoneName?: string;
  zoneStressApplied?: number;
  newZoneLevel?: number;
}

interface MagicRollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function getStressColor(stress: number): { bg: string; text: string } {
  if (stress <= -2) return { bg: 'rgba(39, 174, 96, 0.15)', text: 'var(--fate-success)' };
  if (stress === -1) return { bg: 'rgba(39, 174, 96, 0.08)', text: 'var(--fate-success)' };
  if (stress === 0) return { bg: 'rgba(127, 140, 141, 0.08)', text: 'var(--fate-text-muted)' };
  if (stress === 1) return { bg: 'rgba(243, 156, 18, 0.12)', text: '#f39c12' };
  return { bg: 'rgba(231, 76, 60, 0.12)', text: 'var(--fate-danger)' };
}

export function MagicRollDialog({ open, onOpenChange }: MagicRollDialogProps) {
  const {
    magicTable,
    performMagicRoll,
    getZoneForCharacter,
    scenes,
    currentSceneId,
    currentFloorIndex,
    characters,
    currentMode,
    isNetworkActive,
    networkRole,
    myAssignedCharacterId,
  } = useFateStore();

  const [lastResult, setLastResult] = useState<MagicRollResult | null>(null);
  const [isRolling, setIsRolling] = useState(false);
  const [rollingNumber, setRollingNumber] = useState(0);
  const [selectedCasterId, setSelectedCasterId] = useState<string | null>(null);

  // Network access control — network players are locked to their assigned mage.
  const isNetworkPlayer = isNetworkActive && networkRole === 'player';
  const assignedCharId = myAssignedCharacterId();
  const assignedIsMage =
    !!assignedCharId && characters.some((c) => c.id === assignedCharId && c.isMage);

  // Find current scene and floor
  const currentScene = useMemo(
    () => scenes.find((s) => s.id === currentSceneId) ?? null,
    [scenes, currentSceneId],
  );

  const currentFloor = useMemo(
    () => currentScene?.floors[currentFloorIndex] ?? null,
    [currentScene, currentFloorIndex],
  );

  // Find mages with tokens on any floor of the current scene
  const magesOnFloor = useMemo(() => {
    if (!currentScene) return [];
    const tokenCharIds = new Set(currentScene.floors.flatMap((f) => f.tokens.map((t) => t.charId)));
    return characters.filter((c) => c.isMage && tokenCharIds.has(c.id));
  }, [currentScene, characters]);

  // Detect conflict caster
  const conflictCasterId = useMemo(() => {
    if (!currentScene?.conflictData) return null;
    const { participants, currentParticipantIndex } = currentScene.conflictData;
    if (currentParticipantIndex < 0 || currentParticipantIndex >= participants.length) return null;
    return participants[currentParticipantIndex].characterId ?? null;
  }, [currentScene]);

  // Determine if we are in a conflict
  const isInConflict = currentScene?.conflictData != null;

  // Auto-detect effective caster ID
  const effectiveCasterId = useMemo(() => {
    if (isNetworkPlayer) {
      return assignedIsMage ? assignedCharId : null;
    }
    if (isInConflict && conflictCasterId) return conflictCasterId;
    return selectedCasterId;
  }, [isNetworkPlayer, assignedIsMage, assignedCharId, isInConflict, conflictCasterId, selectedCasterId]);

  // Resolve caster character and zone
  const casterCharacter = useMemo(
    () => (effectiveCasterId ? characters.find((c) => c.id === effectiveCasterId) ?? null : null),
    [effectiveCasterId, characters],
  );

  const casterZone = useMemo(
    () => (effectiveCasterId ? getZoneForCharacter(effectiveCasterId) : null),
    [effectiveCasterId, getZoneForCharacter, currentFloor],
  );

  // Animate rolling number display
  useEffect(() => {
    if (!isRolling) return;
    const interval = setInterval(() => {
      setRollingNumber(Math.floor(Math.random() * 100) + 1);
    }, 60);
    return () => clearInterval(interval);
  }, [isRolling]);

  // Reset result when dialog closes
  const handleOpenChangeWrapper = (nextOpen: boolean) => {
    if (!nextOpen) {
      setLastResult(null);
      setIsRolling(false);
    }
    onOpenChange(nextOpen);
  };

  const handleRoll = async (castType: CastType) => {
    setIsRolling(true);
    setLastResult(null);

    await new Promise((resolve) => setTimeout(resolve, 700));

    const result = await performMagicRoll(castType, effectiveCasterId);
    setLastResult(result);
    setRollingNumber(result.roll);
    setIsRolling(false);
  };

  const getRollColor = () => {
    if (!lastResult) return 'var(--fate-accent)';
    if (lastResult.castType === 'dangerous') return '#9b59b6';
    return 'var(--fate-accent)';
  };

  // Count entries by zone stress for the info bar
  const stressCounts = magicTable.reduce<Record<number, number>>((acc, e) => {
    const key = e.zoneStress ?? 0;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  return (
    <Dialog open={open} onOpenChange={handleOpenChangeWrapper}>
      <DialogContent className="sm:max-w-xl max-h-[92vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title fate-dialog-title-bar">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(155, 89, 182, 0.12)' }}
            >
              <Wand2 className="size-4" style={{ color: '#9b59b6' }} />
            </div>
            🔮 Магия
          </DialogTitle>
          <DialogDescription>
            Бросок заклинания по таблице разрушительной магии
          </DialogDescription>
        </DialogHeader>

        {magicTable.length === 0 ? (
          <div
            className="rounded-xl p-6 text-center space-y-3"
            style={{ backgroundColor: 'var(--fate-bg-warm)', border: '1px solid var(--fate-border)' }}
          >
            <AlertTriangle className="size-8 mx-auto opacity-40" style={{ color: '#f39c12' }} />
            <p className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
              Таблица магии не загружена
            </p>
            <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
              Загрузите CSV-файл с таблицей заклинаний в настройках (Модули → Разрушительная магия)
            </p>
          </div>
        ) : (
          <div className="space-y-4 flex-1 min-h-0 overflow-y-auto fate-scroll">
            {/* Caster Info */}
            <div
              className="rounded-xl px-4 py-3 flex items-center gap-2 flex-wrap"
              style={{
                backgroundColor: effectiveCasterId
                  ? 'rgba(155, 89, 182, 0.06)'
                  : 'rgba(231, 76, 60, 0.06)',
                border: `1px solid ${effectiveCasterId ? 'rgba(155, 89, 182, 0.15)' : 'rgba(231, 76, 60, 0.2)'}`,
              }}
            >
              <Wand2 className="size-3.5 shrink-0" style={{ color: effectiveCasterId ? '#9b59b6' : 'var(--fate-danger)' }} />
              {effectiveCasterId && casterCharacter ? (
                <span className="text-sm" style={{ color: 'var(--fate-text)' }}>
                  Кастует{' '}
                  <span className="font-semibold" style={{ color: '#9b59b6' }}>
                    {casterCharacter.name}
                  </span>
                  {casterZone ? (
                    <>
                      {' '}в зоне{' '}
                      <span className="font-semibold" style={{ color: 'var(--fate-accent)' }}>
                        {casterZone.name}
                      </span>
                    </>
                  ) : (
                    <span className="text-xs italic" style={{ color: 'var(--fate-text-muted)' }}>
                      {' '}(вне зоны)
                    </span>
                  )}
                </span>
              ) : (
                <span className="text-sm font-medium" style={{ color: 'var(--fate-danger)' }}>
                  Кастует: Не выбран
                </span>
              )}
            </div>

            {/* Caster Selection (only when NOT in conflict and NOT a network player) */}
            {!isInConflict && !isNetworkPlayer && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium shrink-0" style={{ color: 'var(--fate-text-muted)' }}>
                  Кастующий:
                </span>
                {magesOnFloor.length > 0 ? (
                  <Select
                    value={selectedCasterId ?? ''}
                    onValueChange={(val) => setSelectedCasterId(val || null)}
                  >
                    <SelectTrigger
                      className="w-full text-sm rounded-lg"
                      style={{ borderColor: 'rgba(155, 89, 182, 0.3)', fontSize: '0.8125rem' }}
                    >
                      <SelectValue placeholder="Выберите мага..." />
                    </SelectTrigger>
                    <SelectContent>
                      {magesOnFloor.map((mage) => {
                        const zone = getZoneForCharacter(mage.id);
                        return (
                          <SelectItem key={mage.id} value={mage.id}>
                            <span className="flex items-center gap-1.5">
                              <Wand2 className="size-3" style={{ color: '#9b59b6' }} />
                              {mage.name}
                              {zone && (
                                <span className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                                  ({zone.name})
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        );
                      })}
                    </SelectContent>
                  </Select>
                ) : (
                  <span className="text-xs italic" style={{ color: 'var(--fate-text-muted)' }}>
                    Нет магов на сцене
                  </span>
                )}
              </div>
            )}

            {/* Locked-caster banner for network players */}
            {isNetworkPlayer && (
              <div
                className="rounded-lg px-3 py-2 flex items-center gap-2"
                style={{
                  backgroundColor: assignedIsMage
                    ? 'rgba(155, 89, 182, 0.08)'
                    : 'rgba(231, 76, 60, 0.08)',
                  border: `1px solid ${
                    assignedIsMage ? 'rgba(155, 89, 182, 0.2)' : 'rgba(231, 76, 60, 0.2)'
                  }`,
                }}
              >
                <Wand2
                  className="size-3.5 shrink-0"
                  style={{ color: assignedIsMage ? '#9b59b6' : 'var(--fate-danger)' }}
                />
                <span className="text-xs" style={{ color: 'var(--fate-text)' }}>
                  {assignedIsMage ? (
                    <>
                      Вы кастуете за{' '}
                      <span className="font-semibold" style={{ color: '#9b59b6' }}>
                        {characters.find((c) => c.id === assignedCharId)?.name ?? 'вашего мага'}
                      </span>
                    </>
                  ) : (
                    <>Назначенный персонаж не является магом</>
                  )}
                </span>
              </div>
            )}

            {/* Cast Type Buttons */}
            <div className="grid grid-cols-2 gap-3">
              <Button
                variant="outline"
                className="h-auto py-4 flex flex-col items-center gap-2 rounded-xl transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
                onClick={() => handleRoll('normal')}
                disabled={isRolling}
                style={{ borderColor: 'rgba(155, 89, 182, 0.3)' }}
              >
                <div
                  className="size-10 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: 'rgba(155, 89, 182, 0.1)' }}
                >
                  <Wand2 className="size-5" style={{ color: '#9b59b6' }} />
                </div>
                <span className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                  Обычный каст
                </span>
                <span className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                  Случайная карта
                </span>
              </Button>

              <Button
                variant="outline"
                className="h-auto py-4 flex flex-col items-center gap-2 rounded-xl transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50"
                onClick={() => handleRoll('dangerous')}
                disabled={isRolling}
                style={{ borderColor: 'rgba(231, 76, 60, 0.3)' }}
              >
                <div
                  className="size-10 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: 'rgba(231, 76, 60, 0.1)' }}
                >
                  <AlertTriangle className="size-5" style={{ color: 'var(--fate-danger)' }} />
                </div>
                <span className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                  Опасный каст
                </span>
                <span className="text-xs" style={{ color: 'var(--fate-danger)' }}>
                  Стресс +1 / +2
                </span>
              </Button>
            </div>

            <Separator />

            {/* Result Display */}
            {isRolling ? (
              <div
                className="rounded-xl p-6 text-center space-y-3"
                style={{ backgroundColor: 'var(--fate-bg-warm)' }}
              >
                <div
                  className="text-5xl font-black tracking-tight inline-block"
                  style={{
                    animation: 'fate-dice-roll 0.7s ease-out',
                    color: 'var(--fate-text-muted)',
                  }}
                >
                  {rollingNumber}
                </div>
                <div className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Тяну карту...
                </div>
              </div>
            ) : lastResult ? (
              <div
                className="rounded-xl p-6 text-center space-y-4 fate-dice-reveal"
                style={{
                  backgroundColor: lastResult.castType === 'dangerous'
                    ? 'rgba(231, 76, 60, 0.06)'
                    : 'rgba(155, 89, 182, 0.06)',
                  border: `1px solid ${lastResult.castType === 'dangerous' ? 'rgba(231, 76, 60, 0.2)' : 'rgba(155, 89, 182, 0.2)'}`,
                }}
              >
                {/* Card Number */}
                <div className="space-y-1">
                  <span className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                    {lastResult.castType === 'normal' ? 'Обычный каст' : 'Опасный каст'}
                  </span>
                  <div
                    className="text-4xl font-black tracking-tight"
                    style={{ color: getRollColor() }}
                  >
                    Карта #{lastResult.roll}
                  </div>
                </div>

                {/* Card Name + Zone Stress */}
                {lastResult.entry ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-center gap-2 flex-wrap">
                      <Badge
                        className="text-sm px-4 py-1.5 font-semibold rounded-lg shadow-sm"
                        style={{ backgroundColor: getRollColor(), color: 'white', border: 'none' }}
                      >
                        {lastResult.entry.name}
                      </Badge>
                      {lastResult.entry.zoneStress !== undefined && (
                        <Badge
                          className="text-xs px-2.5 py-1 font-bold rounded-lg"
                          style={{
                            backgroundColor: getStressColor(lastResult.entry.zoneStress).bg,
                            color: getStressColor(lastResult.entry.zoneStress).text,
                            border: 'none',
                          }}
                        >
                          Стресс {lastResult.entry.zoneStress > 0 ? '+' : ''}{lastResult.entry.zoneStress}
                        </Badge>
                      )}
                      {/* Show applied zone stress indicator */}
                      {lastResult.zoneStressApplied !== undefined && lastResult.zoneStressApplied !== 0 && lastResult.zoneName && (
                        <Badge
                          className="text-xs px-2.5 py-1 font-bold rounded-lg"
                          style={{
                            backgroundColor: lastResult.zoneStressApplied > 0
                              ? 'rgba(231, 76, 60, 0.12)'
                              : 'rgba(39, 174, 96, 0.12)',
                            color: lastResult.zoneStressApplied > 0 ? 'var(--fate-danger)' : 'var(--fate-success)',
                            border: 'none',
                          }}
                        >
                          {lastResult.zoneName}: {lastResult.zoneStressApplied > 0 ? '+' : ''}{lastResult.zoneStressApplied}
                        </Badge>
                      )}
                    </div>
                    <div className="max-h-32 overflow-y-auto fate-scroll">
                      <p
                        className="text-sm leading-relaxed text-left whitespace-pre-wrap break-words overflow-wrap-anywhere"
                        style={{ color: 'var(--fate-text)' }}
                      >
                        {lastResult.entry.effect}
                      </p>
                    </div>

                    {/* Dramatic zone level-up message */}
                    {lastResult.newZoneLevel !== undefined && lastResult.newZoneLevel > 0 && (
                      <div
                        className="rounded-lg px-4 py-2.5 flex items-center justify-center gap-2"
                        style={{
                          backgroundColor: 'rgba(231, 76, 60, 0.1)',
                          border: '1px solid rgba(231, 76, 60, 0.3)',
                        }}
                      >
                        <Zap className="size-4 shrink-0" style={{ color: '#e74c3c' }} />
                        <span
                          className="text-sm font-bold"
                          style={{ color: 'var(--fate-danger)' }}
                        >
                          ⚡ Уровень разлома повышен до {lastResult.newZoneLevel}!
                        </span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Badge
                      className="text-sm px-4 py-1.5 font-semibold rounded-lg shadow-sm"
                      style={{ backgroundColor: 'var(--fate-text-muted)', color: 'white', border: 'none' }}
                    >
                      Карта #{lastResult.roll}
                    </Badge>
                    <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                      Запись не найдена в таблице
                    </p>
                  </div>
                )}
              </div>
            ) : (
              <div
                className="rounded-xl p-6 text-center space-y-2"
                style={{ backgroundColor: 'var(--fate-bg-warm)' }}
              >
                <div className="text-2xl opacity-30">🔮</div>
                <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                  Выберите тип каста для броска
                </p>
              </div>
            )}

            {/* Roll Again */}
            {lastResult && !isRolling && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 rounded-lg gap-1.5"
                  onClick={() => handleRoll('normal')}
                >
                  <Wand2 className="size-3.5" />
                  Обычный каст
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1 rounded-lg gap-1.5"
                  onClick={() => handleRoll('dangerous')}
                  style={{ borderColor: 'rgba(231, 76, 60, 0.3)', color: 'var(--fate-danger)' }}
                >
                  <AlertTriangle className="size-3.5" />
                  Опасный каст
                </Button>
              </div>
            )}

            {/* Table info with stress distribution */}
            <div className="text-center space-y-1">
              <span className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                {magicTable.length} карт в колоде
              </span>
              {Object.keys(stressCounts).length > 1 && (
                <div className="flex items-center justify-center gap-1 flex-wrap">
                  {[-2, -1, 0, 1, 2]
                    .filter((s) => stressCounts[s])
                    .map((s) => {
                      const colors = getStressColor(s);
                      return (
                        <span
                          key={s}
                          className="text-[10px] px-1.5 py-0.5 rounded font-medium"
                          style={{ backgroundColor: colors.bg, color: colors.text }}
                        >
                          {s > 0 ? '+' : ''}{s}: {stressCounts[s]}
                        </span>
                      );
                    })}
                </div>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg"
            onClick={() => onOpenChange(false)}
          >
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
