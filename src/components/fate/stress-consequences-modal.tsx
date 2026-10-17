'use client';

import { useState, useEffect } from 'react';
import { Heart, Plus, Shield, Trash2, Users, UserX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFateStore } from '@/lib/store';
import type { AspectSource, Consequence, HordeMember, StressTrack } from '@/lib/types';

interface StressConsequencesModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  characterId: string | null;
}

export function StressConsequencesModal({ open, onOpenChange, characterId }: StressConsequencesModalProps) {
  const { getCharacter, updateCharacter } = useFateStore();
  const character = characterId ? getCharacter(characterId) : null;

  // Local state for editing
  const [localTracks, setLocalTracks] = useState<StressTrack[]>([]);
  const [localConsequences, setLocalConsequences] = useState<Consequence[]>([]);
  const [localMembers, setLocalMembers] = useState<HordeMember[]>([]);
  const [localMembersCount, setLocalMembersCount] = useState<number>(0);
  const [localSituationalAspects, setLocalSituationalAspects] = useState<string[]>([]);
  const [localAspectSources, setLocalAspectSources] = useState<AspectSource[]>([]);
  const [saving, setSaving] = useState(false);

  // Sync from character when opened
  useEffect(() => {
    if (open && character) {
      setLocalTracks(
        character.stressTracks
          ? character.stressTracks.map((t) => ({ ...t, markers: [...t.markers] }))
          : [],
      );
      setLocalConsequences(
        character.consequences ? character.consequences.map((c) => ({ ...c })) : [],
      );
      setLocalMembers(
        character.members ? character.members.map((m) => ({ ...m, stress: [...m.stress], stressTracks: m.stressTracks?.map((t) => ({ ...t, markers: [...t.markers] })) ?? [] })) : [],
      );
      setLocalMembersCount(character.members?.length ?? 0);
      setLocalSituationalAspects(character.situationalAspects ? [...character.situationalAspects] : []);
      setLocalAspectSources(character.aspectSources ? character.aspectSources.map((s) => ({ ...s, sourceIds: [...s.sourceIds] })) : []);
    }
  }, [open, character]);

  // Toggle stress marker (for non-horde characters)
  const toggleMarker = (trackIdx: number, markerIdx: number) => {
    setLocalTracks((prev) =>
      prev.map((t, i) => {
        if (i !== trackIdx) return t;
        const newMarkers = [...t.markers];
        newMarkers[markerIdx] = !newMarkers[markerIdx];
        return { ...t, markers: newMarkers };
      }),
    );
  };

  // Toggle stress marker for a specific member's stress track
  const toggleMemberTrackMarker = (memberIdx: number, trackIdx: number, markerIdx: number) => {
    setLocalMembers((prev) =>
      prev.map((m, i) => {
        if (i !== memberIdx) return m;
        const tracks = m.stressTracks?.map((t, ti) => {
          if (ti !== trackIdx) return t;
          const newMarkers = [...t.markers];
          newMarkers[markerIdx] = !newMarkers[markerIdx];
          return { ...t, markers: newMarkers };
        }) ?? [];
        // Also update the flat stress array for backward compatibility
        const flatStress: boolean[] = [];
        for (const track of tracks) {
          flatStress.push(...track.markers);
        }
        return { ...m, stress: flatStress, stressTracks: tracks };
      }),
    );
  };

  // Toggle member active state ("Выбыл" / "В строй")
  // Also recalculates crowd aspects based on which sources are still active
  const toggleMemberActive = (memberIdx: number) => {
    setLocalMembers((prev) => {
      const updated = prev.map((m, i) =>
        i === memberIdx ? { ...m, isActive: !m.isActive } : m,
      );
      // Recalculate aspects based on active members' sources
      recalculateAspectsFromMembers(updated);
      return updated;
    });
  };

  // Recalculate crowd aspects from aspectSources, keeping only those
  // contributed by at least one active member
  const recalculateAspectsFromMembers = (members: HordeMember[]) => {
    // Get set of baseCharacterIds from active members
    const activeSourceIds = new Set(
      members.filter((m) => m.isActive).map((m) => m.baseCharacterId),
    );
    // Filter aspectSources: keep only those where at least one source is active
    const filteredSources = localAspectSources
      .map((src) => ({
        ...src,
        sourceIds: src.sourceIds.filter((id) => activeSourceIds.has(id)),
      }))
      .filter((src) => src.sourceIds.length > 0);
    setLocalAspectSources(filteredSources);
  };

  // Add new members to the crowd
  const addMembers = () => {
    // We don't have access to the source characters here, so add generic members
    const currentCount = localMembers.length;
    const newMembers: HordeMember[] = [];
    for (let i = 0; i < 1; i++) {
      newMembers.push({
        id: `hm-${Date.now()}-${currentCount + i}`,
        name: `Участник ${currentCount + i + 1}`,
        stress: localTracks.reduce((s, t) => s + t.markers.length, 0) > 0
          ? Array(localTracks.reduce((s, t) => s + t.markers.length, 0)).fill(false)
          : [],
        isActive: true,
        stressType: 'progressive',
        baseCharacterId: '',
        baseCharacterName: 'Участник',
        stressTracks: localTracks.map((t) => ({ ...t, markers: t.markers.map(() => false) })),
      });
    }
    setLocalMembers((prev) => [...prev, ...newMembers]);
  };

  // Remove a member from the crowd
  const removeMember = (memberIdx: number) => {
    setLocalMembers((prev) => prev.filter((_, i) => i !== memberIdx));
  };

  // Update consequence description
  const updateConsequenceDesc = (idx: number, desc: string) => {
    setLocalConsequences((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, description: desc } : c)),
    );
  };

  // Toggle consequence healing
  const toggleConsequenceHealed = (idx: number) => {
    setLocalConsequences((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, healed: !c.healed } : c)),
    );
  };

  // Add consequence
  const addConsequence = () => {
    const existingValues = localConsequences.map((c) => c.value);
    const defaultValues = [2, 4, 6, 8];
    let newValue = 2;
    for (const v of defaultValues) {
      if (!existingValues.includes(v)) {
        newValue = v;
        break;
      }
    }
    const names: Record<number, string> = {
      2: 'Лёгкое (2)',
      4: 'Среднее (4)',
      6: 'Тяжёлое (6)',
      8: 'Экстремальное (8)',
    };
    setLocalConsequences((prev) => [
      ...prev,
      {
        name: names[newValue] ?? `Последствие (${newValue})`,
        value: newValue,
        description: '',
        healed: false,
      },
    ]);
  };

  // Remove consequence
  const removeConsequence = (idx: number) => {
    setLocalConsequences((prev) => prev.filter((_, i) => i !== idx));
  };

  // Clear all stress
  const clearAllStress = () => {
    setLocalTracks((prev) =>
      prev.map((t) => ({ ...t, markers: t.markers.map(() => false) })),
    );
  };

  // Situational aspect management
  const addSituationalAspect = () => {
    setLocalSituationalAspects((prev) => [...prev, '']);
  };

  const updateSituationalAspect = (idx: number, value: string) => {
    setLocalSituationalAspects((prev) =>
      prev.map((a, i) => (i === idx ? value : a)),
    );
  };

  const removeSituationalAspect = (idx: number) => {
    setLocalSituationalAspects((prev) => prev.filter((_, i) => i !== idx));
  };

  // Save
  const handleSave = async () => {
    if (!character) return;
    setSaving(true);
    try {
      const updateData: Record<string, unknown> = {
        stressTracks: localTracks,
        consequences: localConsequences,
        members: localMembers,
        situationalAspects: localSituationalAspects,
      };

      // Update crowd-level stress tracks to reflect aggregate
      if (character.isHorde) {
        // Keep crowd-level stress tracks in sync
        updateData.stressTracks = localTracks;
        // Recalculate aspects from aspectSources (only those with active sources remain)
        const activeSourceIds = new Set(
          localMembers.filter((m) => m.isActive).map((m) => m.baseCharacterId),
        );
        const filteredSources = localAspectSources
          .map((src) => ({
            ...src,
            sourceIds: src.sourceIds.filter((id) => activeSourceIds.has(id)),
          }))
          .filter((src) => src.sourceIds.length > 0);
        updateData.aspects = filteredSources.map((src) => src.text);
        updateData.aspectSources = filteredSources;
      }

      await updateCharacter(character.id, updateData);
      onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  if (!character) return null;

  const accentColor = character.avatarColor || '#e67e22';
  const isHorde = character.isHorde;
  const activeMembers = localMembers.filter((m) => m.isActive).length;
  const eliminatedMembers = localMembers.filter((m) => !m.isActive).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${isHorde ? 'sm:max-w-lg' : 'sm:max-w-md'} p-0 gap-0 overflow-hidden`}>
        {/* Header with character accent color */}
        <DialogHeader
          className="p-4 pb-3"
          style={{ borderBottom: `2px solid ${accentColor}33` }}
        >
          <DialogTitle
            className="flex items-center gap-2 text-base"
            style={{ color: 'var(--fate-text)' }}
          >
            <div
              className="flex items-center justify-center rounded-full size-8"
              style={{ backgroundColor: `${accentColor}22` }}
            >
              {isHorde ? (
                <Users className="size-4" style={{ color: accentColor }} />
              ) : (
                <Heart className="size-4" style={{ color: accentColor }} />
              )}
            </div>
            {character.name}
            {isHorde && (
              <span className="text-xs font-normal ml-1" style={{ color: 'var(--fate-text-muted)' }}>
                ({activeMembers} в строю{eliminatedMembers > 0 ? `, ${eliminatedMembers} выбыли` : ''})
              </span>
            )}
          </DialogTitle>
          <DialogDescription className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
            {isHorde ? 'Управление состоянием толпы' : 'Быстрое редактирование стресса и последствий персонажа'}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div className="p-4 space-y-5">
            {/* ═══ HORDE MEMBERS SECTION ═══ */}
            {isHorde && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3
                    className="text-xs font-semibold flex items-center gap-2 pb-1"
                    style={{ color: 'var(--fate-text)', borderBottom: '1px solid var(--fate-border)' }}
                  >
                    <Users className="size-3.5" style={{ color: 'var(--fate-accent)' }} />
                    Участники толпы ({activeMembers} активных)
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-[10px] h-6 px-2 gap-1"
                    style={{ color: 'var(--fate-accent)' }}
                    onClick={addMembers}
                  >
                    <Plus className="size-3" />
                    Добавить
                  </Button>
                </div>

                <div className="space-y-1.5">
                  {localMembers.map((member, mi) => (
                    <div
                      key={member.id}
                      className="p-2.5 rounded-lg transition-all duration-150"
                      style={{
                        backgroundColor: member.isActive ? 'var(--fate-bg-card)' : 'rgba(127, 140, 141, 0.08)',
                        border: `1px solid ${member.isActive ? 'var(--fate-border)' : 'rgba(127, 140, 141, 0.2)'}`,
                        opacity: member.isActive ? 1 : 0.6,
                      }}
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        {/* Member name */}
                        <span
                          className="text-xs font-semibold flex-1"
                          style={{
                            color: member.isActive ? 'var(--fate-text)' : 'var(--fate-text-muted)',
                            textDecoration: member.isActive ? 'none' : 'line-through',
                          }}
                        >
                          {member.name}
                        </span>

                        {/* Source NPC label */}
                        {member.baseCharacterName && member.baseCharacterName !== 'Участник' && (
                          <span
                            className="text-[9px] px-1.5 py-0.5 rounded-md"
                            style={{ backgroundColor: 'rgba(39, 174, 96, 0.1)', color: '#27ae60' }}
                          >
                            {member.baseCharacterName}
                          </span>
                        )}

                        {/* Выбыл / В строю toggle */}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-[10px] h-6 px-2 gap-1 shrink-0"
                          style={{
                            color: member.isActive ? 'var(--fate-danger)' : 'var(--fate-success)',
                          }}
                          onClick={() => toggleMemberActive(mi)}
                          title={member.isActive ? 'Отметить как выбывшего' : 'Вернуть в строй'}
                        >
                          {member.isActive ? (
                            <>
                              <UserX className="size-3" />
                              Выбыл
                            </>
                          ) : (
                            <>
                              <Users className="size-3" />
                              В строй
                            </>
                          )}
                        </Button>

                        {/* Remove member */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-5 shrink-0 p-0 hover:scale-110 active:scale-90 transition-transform"
                          style={{ color: 'var(--fate-danger)' }}
                          onClick={() => removeMember(mi)}
                          title="Удалить участника"
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>

                      {/* Member stress tracks */}
                      {member.stressTracks && member.stressTracks.length > 0 ? (
                        <div className="space-y-1">
                          {member.stressTracks.map((track, ti) => (
                            <div key={ti} className="flex items-center gap-1.5">
                              <span className="text-[10px] w-5 shrink-0" style={{ color: 'var(--fate-text-muted)' }}>
                                {track.icon}
                              </span>
                              <div className="flex items-center gap-1">
                                {track.markers.map((checked, mi2) => (
                                  <button
                                    key={mi2}
                                    type="button"
                                    className="relative flex items-center justify-center transition-all duration-150 hover:scale-110 active:scale-95"
                                    onClick={() => toggleMemberTrackMarker(mi, ti, mi2)}
                                    title={`${track.name} ${track.type === 'progressive' ? mi2 + 1 : 1}${checked ? ' (отмечено)' : ''}`}
                                  >
                                    <span
                                      className="flex items-center justify-center rounded transition-all duration-150"
                                      style={{
                                        width: 24,
                                        height: 24,
                                        backgroundColor: checked ? 'var(--fate-danger)' : 'transparent',
                                        border: `1.5px solid ${checked ? 'var(--fate-danger)' : 'var(--fate-border)'}`,
                                        color: checked ? 'white' : 'var(--fate-text-muted)',
                                      }}
                                    >
                                      <span className="text-[9px] font-bold">
                                        {track.type === 'progressive' ? mi2 + 1 : 1}
                                      </span>
                                    </span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        /* Fallback: flat stress array */
                        member.stress.length > 0 && (
                          <div className="flex items-center gap-1">
                            {member.stress.map((checked, si) => (
                              <button
                                key={si}
                                type="button"
                                className="relative flex items-center justify-center transition-all duration-150 hover:scale-110 active:scale-95"
                                onClick={() => {
                                  setLocalMembers((prev) =>
                                    prev.map((m, i) => {
                                      if (i !== mi) return m;
                                      const newStress = [...m.stress];
                                      newStress[si] = !newStress[si];
                                      return { ...m, stress: newStress };
                                    }),
                                  );
                                }}
                              >
                                <span
                                  className="flex items-center justify-center rounded transition-all duration-150"
                                  style={{
                                    width: 24,
                                    height: 24,
                                    backgroundColor: checked ? 'var(--fate-danger)' : 'transparent',
                                    border: `1.5px solid ${checked ? 'var(--fate-danger)' : 'var(--fate-border)'}`,
                                    color: checked ? 'white' : 'var(--fate-text-muted)',
                                  }}
                                >
                                  <span className="text-[9px] font-bold">{si + 1}</span>
                                </span>
                              </button>
                            ))}
                          </div>
                        )
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ═══ NON-HORDE STRESS TRACKS ═══ */}
            {!isHorde && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h3
                    className="text-xs font-semibold flex items-center gap-2 pb-1"
                    style={{ color: 'var(--fate-text)', borderBottom: '1px solid var(--fate-border)' }}
                  >
                    <Shield className="size-3.5" style={{ color: 'var(--fate-danger)' }} />
                    Стресс
                  </h3>
                  {localTracks.some((t) => t.markers.some(Boolean)) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-[10px] h-6 px-2 gap-1"
                      style={{ color: 'var(--fate-text-muted)' }}
                      onClick={clearAllStress}
                    >
                      Сбросить всё
                    </Button>
                  )}
                </div>

                {localTracks.length === 0 ? (
                  <p className="text-xs py-2" style={{ color: 'var(--fate-text-muted)' }}>
                    Нет треков стресса
                  </p>
                ) : (
                  <div className="space-y-2">
                    {localTracks.map((track, ti) => (
                      <div
                        key={ti}
                        className="p-2.5 rounded-lg"
                        style={{
                          backgroundColor: 'var(--fate-bg-card)',
                          border: '1px solid var(--fate-border)',
                        }}
                      >
                        <div className="flex items-center gap-1.5 mb-2">
                          <span className="text-xs font-semibold" style={{ color: 'var(--fate-text)' }}>
                            {track.icon} {track.name}
                          </span>
                          <span className="text-[9px] ml-auto" style={{ color: 'var(--fate-text-muted)' }}>
                            {track.type === 'progressive' ? '1,2,3…' : '1,1,1…'}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {track.markers.map((checked, mi) => (
                            <button
                              key={mi}
                              type="button"
                              className="relative flex items-center justify-center transition-all duration-150 hover:scale-110 active:scale-95"
                              onClick={() => toggleMarker(ti, mi)}
                              title={`${track.name} ${track.type === 'progressive' ? mi + 1 : 1}${checked ? ' (отмечено)' : ''}`}
                              aria-label={`${track.name} ${track.type === 'progressive' ? mi + 1 : 1}${checked ? ' (отмечено)' : ''}`}
                              aria-pressed={checked}
                            >
                              <span
                                className="flex items-center justify-center rounded-md transition-all duration-150"
                                style={{
                                  width: 32,
                                  height: 32,
                                  backgroundColor: checked
                                    ? 'var(--fate-danger)'
                                    : 'transparent',
                                  border: `2px solid ${checked ? 'var(--fate-danger)' : 'var(--fate-border)'}`,
                                  color: checked ? 'white' : 'var(--fate-text-muted)',
                                }}
                              >
                                <span className="text-[11px] font-bold">
                                  {track.type === 'progressive' ? mi + 1 : 1}
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ═══ CONSEQUES (hidden for horde by default) ═══ */}
            {!isHorde && (
              <div className="space-y-2">
                <h3
                  className="text-xs font-semibold flex items-center gap-2 pb-1"
                  style={{ color: 'var(--fate-text)', borderBottom: '1px solid var(--fate-border)' }}
                >
                  <Heart className="size-3.5" style={{ color: '#e67e22' }} />
                  Последствия
                </h3>

                {localConsequences.length === 0 ? (
                  <p className="text-xs py-1" style={{ color: 'var(--fate-text-muted)' }}>
                    Нет последствий
                  </p>
                ) : (
                  <div className="space-y-2">
                    {localConsequences.map((consequence, ci) => {
                      const isTaken = !!consequence.description;
                      return (
                        <div
                          key={ci}
                          className="p-2.5 rounded-lg"
                          style={{
                            backgroundColor: isTaken
                              ? 'rgba(231, 76, 60, 0.06)'
                              : 'var(--fate-bg-card)',
                            border: `1px solid ${isTaken ? 'rgba(231, 76, 60, 0.2)' : 'var(--fate-border)'}`,
                          }}
                        >
                          <div className="flex items-center gap-2 mb-1.5">
                            <span
                              className="text-[10px] font-bold px-1.5 py-0.5 rounded-md shrink-0"
                              style={{
                                backgroundColor: isTaken
                                  ? 'var(--fate-danger)'
                                  : 'var(--fate-bg-warm)',
                                color: isTaken ? 'white' : 'var(--fate-text-muted)',
                              }}
                            >
                              −{consequence.value}
                            </span>
                            <span
                              className="text-xs font-semibold shrink-0"
                              style={{
                                color: isTaken
                                  ? 'var(--fate-danger)'
                                  : 'var(--fate-text-muted)',
                              }}
                            >
                              {consequence.name}
                            </span>
                            <div className="flex items-center gap-1 ml-auto shrink-0">
                              <Checkbox
                                checked={consequence.healed}
                                onCheckedChange={() => toggleConsequenceHealed(ci)}
                                className="size-3.5"
                              />
                              <span
                                className="text-[9px]"
                                style={{
                                  color: consequence.healed
                                    ? 'var(--fate-success)'
                                    : 'var(--fate-text-muted)',
                                }}
                              >
                                🩹
                              </span>
                            </div>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-5 shrink-0 p-0 hover:scale-110 active:scale-90 transition-transform"
                              style={{ color: 'var(--fate-danger)' }}
                              onClick={() => removeConsequence(ci)}
                              title="Удалить последствие"
                            >
                              <Trash2 className="size-3" />
                            </Button>
                          </div>
                          <Input
                            value={consequence.description ?? ''}
                            onChange={(e) => updateConsequenceDesc(ci, e.target.value)}
                            className="text-xs h-7 rounded-lg"
                            placeholder="Описание последствия..."
                            style={{
                              borderColor: isTaken
                                ? 'rgba(231, 76, 60, 0.25)'
                                : 'var(--fate-border)',
                            }}
                          />
                          {consequence.healed && isTaken && (
                            <p
                              className="text-[10px] mt-1"
                              style={{ color: 'var(--fate-success)', opacity: 0.8 }}
                            >
                              ✦ Восстановление начато
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1.5 rounded-lg w-full border-dashed"
                  style={{ color: 'var(--fate-accent)', borderColor: 'var(--fate-accent)' }}
                  onClick={addConsequence}
                >
                  <Plus className="size-3" />
                  Добавить последствие
                </Button>
              </div>
            )}

            {/* ═══ CROWD ASPECTS FROM SOURCES ═══ */}
            {isHorde && localAspectSources.length > 0 && (
              <div className="space-y-2">
                <h3
                  className="text-xs font-semibold flex items-center gap-2 pb-1"
                  style={{ color: 'var(--fate-text)', borderBottom: '1px solid var(--fate-border)' }}
                >
                  <Shield className="size-3.5" style={{ color: 'var(--fate-accent)' }} />
                  Аспекты от участников
                  <span className="text-[10px] font-normal" style={{ color: 'var(--fate-text-muted)' }}>
                    (исчезают при выбытии всех источников)
                  </span>
                </h3>
                <div className="flex flex-wrap gap-1.5">
                  {localAspectSources.map((src, i) => (
                    <div
                      key={i}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs"
                      style={{
                        backgroundColor: 'rgba(230, 126, 34, 0.08)',
                        border: '1px solid rgba(230, 126, 34, 0.15)',
                        color: 'var(--fate-text)',
                      }}
                    >
                      <span style={{ color: 'var(--fate-accent)' }}>◆</span>
                      <span className="font-medium">{src.text}</span>
                      {src.sourceIds.length > 1 && (
                        <span
                          className="text-[9px] font-bold px-1 rounded"
                          style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)', color: 'var(--fate-accent)' }}
                        >
                          ×{src.sourceIds.length}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ═══ SITUATIONAL ASPECTS (for both regular and horde) ═══ */}
            {isHorde && (
              <div className="space-y-2">
                <h3
                  className="text-xs font-semibold flex items-center gap-2 pb-1"
                  style={{ color: 'var(--fate-text)', borderBottom: '1px solid var(--fate-border)' }}
                >
                  <Shield className="size-3.5" style={{ color: '#8e44ad' }} />
                  Ситуационные аспекты
                </h3>

                {localSituationalAspects.length === 0 ? (
                  <p className="text-xs py-1" style={{ color: 'var(--fate-text-muted)' }}>
                    Нет ситуационных аспектов
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {localSituationalAspects.map((aspect, ai) => (
                      <div key={ai} className="flex items-center gap-1.5">
                        <span className="text-xs" style={{ color: '#8e44ad' }}>◆</span>
                        <Input
                          value={aspect}
                          onChange={(e) => updateSituationalAspect(ai, e.target.value)}
                          className="text-xs h-7 rounded-lg flex-1"
                          placeholder="Ситуационный аспект..."
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-5 shrink-0 p-0 hover:scale-110 active:scale-90 transition-transform"
                          style={{ color: 'var(--fate-danger)' }}
                          onClick={() => removeSituationalAspect(ai)}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}

                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs gap-1.5 rounded-lg w-full border-dashed"
                  style={{ color: '#8e44ad', borderColor: '#8e44ad' }}
                  onClick={addSituationalAspect}
                >
                  <Plus className="size-3" />
                  Добавить аспект
                </Button>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Footer with Save button */}
        <DialogFooter
          className="p-3 border-t"
          style={{ borderColor: 'var(--fate-border)' }}
        >
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            style={{ color: 'var(--fate-text-muted)' }}
            onClick={() => onOpenChange(false)}
          >
            Отмена
          </Button>
          <Button
            size="sm"
            className="text-xs gap-1.5"
            style={{
              backgroundColor: accentColor,
              color: 'white',
            }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? 'Сохранение…' : 'Сохранить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
