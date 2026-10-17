'use client';

import { useState, useMemo } from 'react';
import { ChevronDown, ChevronUp, Minus, Plus, Trash2, Users, X } from 'lucide-react';
import { toast } from 'sonner';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { useFateStore } from '@/lib/store';
import type { Character, HordeMember, StressTrack, AspectSource } from '@/lib/types';

interface CrowdEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Composition entry: an NPC type + count
interface CompositionEntry {
  characterId: string;
  character: Character;
  count: number;
}

export function CrowdEditorDialog({ open, onOpenChange }: CrowdEditorDialogProps) {
  const { characters, currentAdventureId, createCharacter, addCharacterToScene } = useFateStore();

  // Eligible NPCs (crowdEligible && npc)
  const eligibleNPCs = useMemo(
    () => characters.filter((c) => c.crowdEligible && c.type === 'npc' && !c.isHorde && !c.temporary),
    [characters],
  );

  // Selected composition
  const [composition, setComposition] = useState<CompositionEntry[]>([]);
  const [crowdName, setCrowdName] = useState('');
  const [creating, setCreating] = useState(false);

  // Add an NPC type to the composition
  const addNPC = (npc: Character) => {
    setComposition((prev) => {
      const existing = prev.find((e) => e.characterId === npc.id);
      if (existing) {
        // Already added — increment count
        return prev.map((e) =>
          e.characterId === npc.id ? { ...e, count: e.count + 1 } : e,
        );
      }
      return [...prev, { characterId: npc.id, character: npc, count: 1 }];
    });
  };

  // Remove an NPC type from composition
  const removeNPC = (characterId: string) => {
    setComposition((prev) => prev.filter((e) => e.characterId !== characterId));
  };

  // Change count for a specific NPC type
  const setCount = (characterId: string, count: number) => {
    if (count < 1) return;
    setComposition((prev) =>
      prev.map((e) =>
        e.characterId === characterId ? { ...e, count } : e,
      ),
    );
  };

  // Total members in the crowd
  const totalMembers = useMemo(
    () => composition.reduce((sum, e) => sum + e.count, 0),
    [composition],
  );

  // Build crowd skills: max skill value among all member types
  const buildCrowdSkills = (entries: CompositionEntry[]) => {
    const skillMap: Record<string, number> = {};
    for (const entry of entries) {
      for (const skill of entry.character.skills) {
        if (skill.value >= 0) {
          skillMap[skill.name] = Math.max(skillMap[skill.name] ?? 0, skill.value);
        }
      }
    }
    // Convert to sorted skill array
    return Object.entries(skillMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  };

  // Build crowd aspects: unique aspects + concepts + problems from all member types (deduplicated)
  // Also returns aspectSources for tracking which source contributes each aspect
  const buildCrowdAspects = (entries: CompositionEntry[]): { aspects: string[]; aspectSources: AspectSource[] } => {
    const sourceMap: Record<string, string[]> = {}; // aspectText → sourceCharIds
    for (const entry of entries) {
      const charId = entry.character.id;
      // Collect all aspect-like texts from this source
      const allTexts: string[] = [];
      // Add concept if present
      const concept = entry.character.concept?.trim();
      if (concept) allTexts.push(concept);
      // Add problem if present
      const problem = entry.character.problem?.trim();
      if (problem) allTexts.push(problem);
      // Add regular aspects
      for (const aspect of entry.character.aspects) {
        const trimmed = aspect?.trim();
        if (trimmed) allTexts.push(trimmed);
      }
      // Register each unique text with this source
      for (const text of allTexts) {
        if (!sourceMap[text]) sourceMap[text] = [];
        if (!sourceMap[text].includes(charId)) sourceMap[text].push(charId);
      }
    }
    const aspects = Object.keys(sourceMap);
    const aspectSources: AspectSource[] = Object.entries(sourceMap).map(([text, sourceIds]) => ({
      text,
      sourceIds,
    }));
    return { aspects, aspectSources };
  };

  // Build crowd stress tracks: unified tracks based on member types
  // For crowd-level tooltip display: aggregate all stress across members
  const buildCrowdStressTracks = (entries: CompositionEntry[]): StressTrack[] => {
    // Collect unique stress track names and their maximum box counts
    const trackMap: Record<string, { type: 'progressive' | 'linear'; icon: string; maxMarkers: number }> = {};
    for (const entry of entries) {
      for (const track of entry.character.stressTracks) {
        const existing = trackMap[track.name];
        if (!existing || track.markers.length > existing.maxMarkers) {
          trackMap[track.name] = {
            type: track.type,
            icon: track.icon,
            maxMarkers: track.markers.length,
          };
        }
      }
    }
    return Object.entries(trackMap).map(([name, info]) => ({
      name,
      type: info.type,
      icon: info.icon,
      markers: Array(info.maxMarkers).fill(false),
      showInTooltip: true,
    }));
  };

  // Build crowd members (HordeMember[])
  const buildCrowdMembers = (entries: CompositionEntry[]): HordeMember[] => {
    const members: HordeMember[] = [];
    let globalIndex = 0;
    for (const entry of entries) {
      for (let i = 0; i < entry.count; i++) {
        globalIndex++;
        // Each member inherits stress tracks from their source NPC
        const memberStress: boolean[] = [];
        for (const track of entry.character.stressTracks) {
          for (let m = 0; m < track.markers.length; m++) {
            memberStress.push(false);
          }
        }
        members.push({
          id: `hm-${Date.now()}-${globalIndex}`,
          name: `${entry.character.name} ${globalIndex}`,
          stress: memberStress,
          isActive: true,
          stressType: 'progressive',
          baseCharacterId: entry.character.id,
          baseCharacterName: entry.character.name,
          stressTracks: entry.character.stressTracks.map((t) => ({
            ...t,
            markers: t.markers.map(() => false),
          })),
        });
      }
    }
    return members;
  };

  // Create the crowd
  const handleCreate = async () => {
    if (!currentAdventureId) {
      toast.error('Нет активного приключения');
      return;
    }
    if (composition.length === 0) {
      toast.error('Добавьте хотя бы одного NPC в толпу');
      return;
    }
    if (!crowdName.trim()) {
      toast.error('Укажите название толпы');
      return;
    }

    setCreating(true);
    try {
      const skills = buildCrowdSkills(composition);
      const { aspects, aspectSources } = buildCrowdAspects(composition);
      const stressTracks = buildCrowdStressTracks(composition);
      const members = buildCrowdMembers(composition);
      const crowdComposition: Record<string, number> = {};
      for (const entry of composition) {
        crowdComposition[entry.characterId] = entry.count;
      }

      // Pick a representative avatar color from first entry
      const avatarColor = composition[0]?.character.avatarColor || '#e67e22';

      // Create the crowd character
      const crowdChar = await createCharacter({
        name: crowdName.trim(),
        type: 'npc',
        concept: `Толпа (${totalMembers} участников)`,
        problem: '',
        aspects,
        skills,
        stunts: [],
        stressTracks,
        consequences: [], // Crowds typically don't have consequences
        situationalAspects: [],
        fatePoints: 0,
        refresh: 0,
        isHorde: true,
        members,
        crowdComposition,
        aspectSources,
        temporary: true,
        avatarColor,
        adventureId: currentAdventureId,
      });

      // Add to current scene only (not to map — GM places token manually)
      if (crowdChar?.id) {
        await addCharacterToScene(crowdChar.id);
      }

      toast.success(`Толпа «${crowdName.trim()}» создана (${totalMembers} участников)`);
      // Reset form
      setComposition([]);
      setCrowdName('');
      onOpenChange(false);
    } catch (error) {
      console.error('Failed to create crowd:', error);
      toast.error('Ошибка при создании толпы');
    } finally {
      setCreating(false);
    }
  };

  // NPC types not yet added
  const availableNPCs = useMemo(
    () => eligibleNPCs.filter((npc) => !composition.some((e) => e.characterId === npc.id)),
    [eligibleNPCs, composition],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl p-0 gap-0 overflow-hidden">
        {/* Header */}
        <DialogHeader className="p-4 pb-3" style={{ borderBottom: '2px solid rgba(230, 126, 34, 0.15)' }}>
          <DialogTitle
            className="flex items-center gap-2 text-base"
            style={{ color: 'var(--fate-text)' }}
          >
            <div
              className="flex items-center justify-center rounded-full size-8"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <Users className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Редактор толп
          </DialogTitle>
          <DialogDescription className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
            Создайте толпу из NPC, отмеченных как доступные для толп
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[65vh]">
          <div className="p-4 space-y-4">
            {/* NPC selection */}
            <div className="space-y-2">
              <h3
                className="text-xs font-semibold flex items-center gap-2 pb-1"
                style={{ color: 'var(--fate-text)', borderBottom: '1px solid var(--fate-border)' }}
              >
                <Users className="size-3.5" style={{ color: 'var(--fate-accent)' }} />
                Доступные NPC
                {eligibleNPCs.length === 0 && (
                  <span className="text-[10px] font-normal" style={{ color: 'var(--fate-text-muted)' }}>
                    — отметьте NPC чекбоксом «Использовать в толпах» в их листе
                  </span>
                )}
              </h3>

              {eligibleNPCs.length === 0 ? (
                <p className="text-xs py-3 text-center" style={{ color: 'var(--fate-text-muted)' }}>
                  Нет NPC, доступных для толп. Откройте лист NPC и отметьте «Использовать в толпах».
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-1.5">
                  {eligibleNPCs.map((npc) => {
                    const isAdded = composition.some((e) => e.characterId === npc.id);
                    const topSkill = npc.skills.length > 0
                      ? npc.skills.reduce((best, s) => (s.value > best.value ? s : best), npc.skills[0])
                      : null;
                    return (
                      <div
                        key={npc.id}
                        className="flex items-center gap-3 p-2.5 rounded-lg transition-all duration-150"
                        style={{
                          backgroundColor: isAdded ? 'rgba(39, 174, 96, 0.08)' : 'var(--fate-bg-card)',
                          border: `1px solid ${isAdded ? 'rgba(39, 174, 96, 0.25)' : 'var(--fate-border)'}`,
                        }}
                      >
                        {/* Avatar circle */}
                        <div
                          className="flex items-center justify-center rounded-full size-8 shrink-0 text-white text-xs font-bold"
                          style={{ backgroundColor: npc.avatarColor || '#27ae60' }}
                        >
                          {npc.name.charAt(0).toUpperCase()}
                        </div>

                        {/* NPC info */}
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                            {npc.name}
                          </p>
                          <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                            {topSkill ? `${topSkill.name}: +${topSkill.value}` : 'Нет навыков'}
                            {' · '}
                            {npc.stressTracks.reduce((s, t) => s + t.markers.length, 0)} стр.
                            {npc.aspects.filter(Boolean).length > 0 && ` · ${npc.aspects.filter(Boolean).length} асп.`}
                          </p>
                        </div>

                        {/* Add/Added button */}
                        {isAdded ? (
                          <Badge
                            className="text-[10px] shrink-0"
                            style={{ backgroundColor: 'rgba(39, 174, 96, 0.15)', color: '#27ae60' }}
                          >
                            Добавлен
                          </Badge>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs h-7 px-2.5 gap-1 shrink-0"
                            style={{ color: 'var(--fate-accent)' }}
                            onClick={() => addNPC(npc)}
                          >
                            <Plus className="size-3" />
                            Добавить
                          </Button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Current composition */}
            {composition.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <h3
                    className="text-xs font-semibold flex items-center gap-2 pb-1"
                    style={{ color: 'var(--fate-text)', borderBottom: '1px solid var(--fate-border)' }}
                  >
                    Состав толпы
                    <Badge
                      className="text-[10px] ml-1"
                      style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)', color: 'var(--fate-accent)' }}
                    >
                      {totalMembers}
                    </Badge>
                  </h3>

                  <div className="space-y-2">
                    {composition.map((entry) => {
                      const npc = entry.character;
                      return (
                        <div
                          key={entry.characterId}
                          className="p-3 rounded-lg"
                          style={{
                            backgroundColor: 'var(--fate-bg-card)',
                            border: '1px solid var(--fate-border)',
                          }}
                        >
                          <div className="flex items-center gap-2 mb-2">
                            <div
                              className="flex items-center justify-center rounded-full size-6 shrink-0 text-white text-[10px] font-bold"
                              style={{ backgroundColor: npc.avatarColor || '#27ae60' }}
                            >
                              {npc.name.charAt(0).toUpperCase()}
                            </div>
                            <span className="text-xs font-semibold flex-1" style={{ color: 'var(--fate-text)' }}>
                              {npc.name}
                            </span>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-5 shrink-0 p-0 hover:scale-110 active:scale-90 transition-transform"
                              style={{ color: 'var(--fate-danger)' }}
                              onClick={() => removeNPC(entry.characterId)}
                              title="Убрать из толпы"
                            >
                              <X className="size-3" />
                            </Button>
                          </div>

                          {/* Count controls */}
                          <div className="flex items-center gap-2">
                            <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                              Количество:
                            </span>
                            <div className="flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-6 p-0"
                                onClick={() => setCount(entry.characterId, entry.count - 1)}
                                disabled={entry.count <= 1}
                              >
                                <Minus className="size-3" />
                              </Button>
                              <Input
                                type="number"
                                min={1}
                                value={entry.count}
                                onChange={(e) => {
                                  const val = Math.max(1, parseInt(e.target.value) || 1);
                                  setCount(entry.characterId, val);
                                }}
                                className="text-xs h-6 w-14 text-center rounded-md"
                              />
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-6 p-0"
                                onClick={() => setCount(entry.characterId, entry.count + 1)}
                              >
                                <Plus className="size-3" />
                              </Button>
                            </div>

                            {/* Quick info */}
                            <span className="text-[10px] ml-auto" style={{ color: 'var(--fate-text-muted)' }}>
                              {npc.stressTracks.reduce((s, t) => s + t.markers.length, 0) * entry.count} стр. ·{' '}
                              {npc.aspects.filter(Boolean).length > 0 ? `${npc.aspects.filter(Boolean).length} асп.` : '—'}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Preview: skills summary */}
                  {(() => {
                    const crowdSkills = buildCrowdSkills(composition);
                    const topSkills = crowdSkills.slice(0, 6);
                    if (topSkills.length === 0) return null;
                    return (
                      <div
                        className="p-2.5 rounded-lg"
                        style={{
                          backgroundColor: 'rgba(230, 126, 34, 0.04)',
                          border: '1px solid rgba(230, 126, 34, 0.1)',
                        }}
                      >
                        <p className="text-[10px] font-medium mb-1.5" style={{ color: 'var(--fate-text-muted)' }}>
                          Навыки толпы (макс. из участников):
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {topSkills.map((skill) => (
                            <Badge
                              key={skill.name}
                              className="text-[10px]"
                              style={{
                                backgroundColor: skill.value >= 3 ? 'rgba(230, 126, 34, 0.12)' : 'rgba(39, 174, 96, 0.1)',
                                color: skill.value >= 3 ? 'var(--fate-accent)' : 'var(--fate-success)',
                              }}
                            >
                              {skill.name} +{skill.value}
                            </Badge>
                          ))}
                          {crowdSkills.length > 6 && (
                            <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                              +{crowdSkills.length - 6} ещё
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Preview: aspects */}
                  {(() => {
                    const { aspects: crowdAspects, aspectSources: sources } = buildCrowdAspects(composition);
                    if (crowdAspects.length === 0) return null;
                    return (
                      <div
                        className="p-2.5 rounded-lg"
                        style={{
                          backgroundColor: 'rgba(230, 126, 34, 0.04)',
                          border: '1px solid rgba(230, 126, 34, 0.1)',
                        }}
                      >
                        <p className="text-[10px] font-medium mb-1.5" style={{ color: 'var(--fate-text-muted)' }}>
                          Аспекты толпы (концепты, проблемы, аспекты — уникальные):
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {sources.map((src, i) => (
                            <Badge
                              key={i}
                              className="text-[10px]"
                              style={{ backgroundColor: 'rgba(155, 89, 182, 0.1)', color: '#8e44ad' }}
                            >
                              ◆ {src.text}
                              {src.sourceIds.length > 1 && (
                                <span style={{ opacity: 0.6 }}> ×{src.sourceIds.length}</span>
                              )}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              </>
            )}

            {/* Crowd name */}
            {composition.length > 0 && (
              <>
                <Separator />
                <div className="space-y-2">
                  <Label className="text-xs font-medium" style={{ color: 'var(--fate-text)' }}>
                    Название толпы
                  </Label>
                  <Input
                    value={crowdName}
                    onChange={(e) => setCrowdName(e.target.value)}
                    placeholder="Например: Орда гоблинов"
                    className="text-sm rounded-lg"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreate();
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </ScrollArea>

        {/* Footer */}
        {composition.length > 0 && (
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
              style={{ backgroundColor: 'var(--fate-accent)', color: 'white' }}
              onClick={handleCreate}
              disabled={creating || !crowdName.trim()}
            >
              <Users className="size-3.5" />
              {creating ? 'Создание…' : `Создать толпу (${totalMembers})`}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
