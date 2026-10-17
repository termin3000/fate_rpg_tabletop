'use client';

import { useEffect, useState } from 'react';
import { Dices, History, Sparkles, UserPlus, Zap } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';

import {
  generateNPC,
  NPC_ARCHETYPES,
  NAME_PRESETS,
  type GeneratedNPC,
  type NPCGender,
  type NamePreset,
} from '@/lib/npc-generator';
import { useFateStore } from '@/lib/store';

interface NpcGeneratorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const RANDOM_KEY = '__random';

export function NpcGeneratorDialog({ open, onOpenChange }: NpcGeneratorDialogProps) {
  const { currentAdventureId, createCharacter } = useFateStore();

  const [archetype, setArchetype] = useState<string>(RANDOM_KEY);
  const [gender, setGender] = useState<string>(RANDOM_KEY);
  const [namePreset, setNamePreset] = useState<string>('russian');
  const [npc, setNpc] = useState<GeneratedNPC | null>(null);
  const [history, setHistory] = useState<GeneratedNPC[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [rollKey, setRollKey] = useState(0);

  // Reset transient state every time the dialog opens.
  useEffect(() => {
    if (open) {
      setNpc(null);
      setHistory([]);
      setArchetype(RANDOM_KEY);
      setGender(RANDOM_KEY);
      setNamePreset('russian');
      setRollKey(0);
    }
  }, [open]);

  const resolveOptions = () => ({
    archetype: archetype === RANDOM_KEY ? undefined : archetype,
    gender: gender === RANDOM_KEY ? undefined : (gender as NPCGender),
    namePreset: namePreset as NamePreset,
  });

  const handleGenerate = () => {
    const next = generateNPC(resolveOptions());
    setNpc(next);
    setHistory((prev) => [next, ...prev].slice(0, 5));
    setRollKey((k) => k + 1);
  };

  const handleSelectFromHistory = (entry: GeneratedNPC) => {
    setNpc(entry);
    setRollKey((k) => k + 1);
  };

  const handleSave = async () => {
    if (!npc) return;
    if (!currentAdventureId) {
      toast.error('Сначала выберите приключение');
      return;
    }
    setIsSaving(true);
    try {
      await createCharacter({
        name: npc.name,
        type: 'npc',
        concept: npc.concept,
        problem: '',
        adventureId: currentAdventureId,
        aspects: npc.aspects,
        skills: npc.skills,
        fatePoints: npc.fatePoints,
        refresh: npc.refresh,
      });
      toast.success(`NPC «${npc.name}» добавлен в приключение`);
    } catch (error) {
      console.error('NPC save error:', error);
      toast.error('Не удалось создать NPC');
    } finally {
      setIsSaving(false);
    }
  };

  const selectedPresetLabel = NAME_PRESETS.find((p) => p.id === namePreset)?.label ?? 'Русские';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <Zap className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            ⚡ Быстрый генератор NPC
          </DialogTitle>
          <DialogDescription>
            Создавайте случайных NPC с именами, аспектами и навыками на ходу во время игры
          </DialogDescription>
        </DialogHeader>

        {/* ── Controls ── */}
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_1fr_auto] gap-2">
          {/* Name Preset */}
          <Select value={namePreset} onValueChange={setNamePreset}>
            <SelectTrigger className="text-xs rounded-lg">
              <SelectValue placeholder="Раса/культура" />
            </SelectTrigger>
            <SelectContent>
              {NAME_PRESETS.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.icon} {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={archetype} onValueChange={setArchetype}>
            <SelectTrigger className="text-xs rounded-lg">
              <SelectValue placeholder="Архетип" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={RANDOM_KEY}>🎲 Случайный архетип</SelectItem>
              {NPC_ARCHETYPES.map((a) => (
                <SelectItem key={a.name} value={a.name}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={gender} onValueChange={setGender}>
            <SelectTrigger className="text-xs rounded-lg">
              <SelectValue placeholder="Пол" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={RANDOM_KEY}>🎲 Случайный пол</SelectItem>
              <SelectItem value="male">♂ Мужской</SelectItem>
              <SelectItem value="female">♀ Женский</SelectItem>
            </SelectContent>
          </Select>

          <Button
            onClick={handleGenerate}
            className="fate-btn-accent fate-button-shine rounded-lg gap-2 sm:whitespace-nowrap"
          >
            <Dices className="size-4" />
            🎲 Сгенерировать
          </Button>
        </div>

        {/* ── NPC Display ── */}
        <ScrollArea className="flex-1 min-h-0 max-h-[52vh] fate-scroll">
          <div
            key={rollKey}
            className="animate-fade-in rounded-xl p-5"
            style={{
              backgroundColor: 'var(--fate-bg-card)',
              border: '2px solid var(--fate-border)',
              borderLeft: '4px solid var(--fate-accent)',
            }}
          >
            {npc ? (
              <div className="space-y-4">
                {/* Name + meta */}
                <div>
                  <h3
                    className="text-xl font-bold leading-tight"
                    style={{ color: 'var(--fate-text)' }}
                  >
                    {npc.name}
                  </h3>
                  <p
                    className="text-sm italic mt-1 leading-snug"
                    style={{ color: 'var(--fate-text-muted)' }}
                  >
                    {npc.concept}
                  </p>
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <Badge
                      variant="secondary"
                      className="text-[11px]"
                      style={{
                        backgroundColor: 'rgba(230, 126, 34, 0.12)',
                        color: 'var(--fate-accent)',
                        borderColor: 'transparent',
                      }}
                    >
                      {npc.archetype}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="text-[11px]"
                      style={{ color: 'var(--fate-text-muted)' }}
                    >
                      {npc.gender === 'male' ? '♂ Мужской' : '♀ Женский'}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="text-[11px]"
                      style={{ color: 'var(--fate-text-muted)' }}
                    >
                      {selectedPresetLabel}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="text-[11px]"
                      style={{ color: 'var(--fate-text-muted)' }}
                    >
                      ⚡ Очки судьбы: {npc.fatePoints}
                    </Badge>
                    <Badge
                      variant="outline"
                      className="text-[11px]"
                      style={{ color: 'var(--fate-text-muted)' }}
                    >
                      ↻ Восстановление: {npc.refresh}
                    </Badge>
                  </div>
                </div>

                <Separator />

                {/* Aspects */}
                <div>
                  <h4
                    className="text-xs font-semibold uppercase tracking-wide mb-2 fate-section-header pb-1.5"
                    style={{ color: 'var(--fate-text-muted)' }}
                  >
                    Аспекты
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {npc.aspects.map((aspect, i) => (
                      <Badge
                        key={`${aspect}-${i}`}
                        className="text-xs"
                        style={{
                          backgroundColor: 'rgba(230, 126, 34, 0.12)',
                          color: 'var(--fate-accent)',
                          borderColor: 'transparent',
                        }}
                      >
                        {aspect}
                      </Badge>
                    ))}
                  </div>
                </div>

                <Separator />

                {/* Skills */}
                <div>
                  <h4
                    className="text-xs font-semibold uppercase tracking-wide mb-2 fate-section-header pb-1.5"
                    style={{ color: 'var(--fate-text-muted)' }}
                  >
                    Навыки
                  </h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
                    {npc.skills.map((skill) => (
                      <div
                        key={skill.name}
                        className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs"
                        style={{
                          backgroundColor: 'var(--fate-bg-warm)',
                          border: '1px solid var(--fate-border)',
                        }}
                      >
                        <span
                          className="truncate"
                          style={{ color: 'var(--fate-text)' }}
                          title={skill.name}
                        >
                          {skill.name}
                        </span>
                        <span
                          className="font-bold ml-1.5"
                          style={{ color: 'var(--fate-accent)' }}
                        >
                          +{skill.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex gap-2 pt-1">
                  <Button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="fate-btn-accent fate-button-shine rounded-lg gap-2 flex-1"
                  >
                    <UserPlus className="size-4" />
                    {isSaving ? 'Сохранение…' : '💾 Создать персонажа'}
                  </Button>
                  <Button
                    onClick={handleGenerate}
                    variant="outline"
                    className="rounded-lg gap-2"
                  >
                    <Dices className="size-4" />
                    🎲 Ещё
                  </Button>
                </div>
              </div>
            ) : (
              <div
                className="flex flex-col items-center justify-center text-center gap-2 py-10"
                style={{ color: 'var(--fate-text-muted)' }}
              >
                <Sparkles className="size-8 opacity-60" />
                <p className="text-sm">
                  Нажмите «🎲 Сгенерировать», чтобы создать случайного NPC
                </p>
                <p className="text-xs opacity-70">
                  Выберите расу/культуру, архетип и пол — или оставьте случайными
                </p>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* ── History ── */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <History
              className="size-3.5"
              style={{ color: 'var(--fate-text-muted)' }}
            />
            <h4
              className="text-xs font-semibold uppercase tracking-wide fate-section-header pb-1.5"
              style={{ color: 'var(--fate-text-muted)' }}
            >
              История (последние 5)
            </h4>
          </div>
          <Separator className="mb-2" />
          {history.length === 0 ? (
            <p
              className="text-xs text-center py-3 opacity-70"
              style={{ color: 'var(--fate-text-muted)' }}
            >
              История пуста
            </p>
          ) : (
            <div className="flex gap-2 overflow-x-auto fate-scroll pb-1">
              {history.map((entry, i) => {
                const isActive = npc === entry;
                return (
                  <button
                    key={`${entry.name}-${i}`}
                    onClick={() => handleSelectFromHistory(entry)}
                    className="shrink-0 text-left rounded-lg px-3 py-2 transition-all duration-150 active:scale-[0.98] hover:shadow-sm"
                    style={{
                      backgroundColor: isActive
                        ? 'rgba(230, 126, 34, 0.12)'
                        : 'var(--fate-bg-card)',
                      border: `1px solid ${
                        isActive ? 'var(--fate-accent)' : 'var(--fate-border)'
                      }`,
                    }}
                    title={`Показать ${entry.name}`}
                  >
                    <div
                      className="text-xs font-semibold whitespace-nowrap"
                      style={{ color: 'var(--fate-text)' }}
                    >
                      {entry.name}
                    </div>
                    <div
                      className="text-[10px] whitespace-nowrap"
                      style={{ color: 'var(--fate-text-muted)' }}
                    >
                      {entry.archetype} · {entry.gender === 'male' ? '♂' : '♀'}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
