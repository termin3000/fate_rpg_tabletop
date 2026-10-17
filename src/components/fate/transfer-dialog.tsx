'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Box,
  Folder,
  Loader2,
  Map,
  Settings as SettingsIcon,
  Users,
  FileText,
  Puzzle,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFateStore } from '@/lib/store';
import type { Adventure } from '@/lib/types';

interface TransferDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface TransferOptions {
  characters: boolean;
  scenes: boolean;
  items: boolean;
  folders: boolean;
  notes: boolean;
  settings: boolean;
  modules: boolean;
}

const OPTION_META: {
  key: keyof TransferOptions;
  label: string;
  icon: typeof Users;
  description: string;
}[] = [
  { key: 'characters', label: 'Персонажи', icon: Users, description: 'NPC, ПК, толпы' },
  { key: 'scenes', label: 'Сцены', icon: Map, description: 'Карты, токены, зоны' },
  { key: 'items', label: 'Инвентарь', icon: Box, description: 'Предметы' },
  { key: 'folders', label: 'Папки', icon: Folder, description: 'Структура библиотеки' },
  { key: 'notes', label: 'Заметки', icon: FileText, description: 'Журнал мастера' },
  { key: 'settings', label: 'Настройки', icon: SettingsIcon, description: 'Навыки, инициатива' },
  { key: 'modules', label: 'Модули', icon: Puzzle, description: 'Магия и др. модули' },
];

// Helpers to read runtime-only count fields that the API returns but the
// Adventure type doesn't declare (added via _count in the API route).
function charCount(a: Adventure): number {
  return (a as unknown as { characterCount?: number }).characterCount ?? a.characters?.length ?? 0;
}
function sceneCount(a: Adventure): number {
  return (a as unknown as { sceneCount?: number }).sceneCount ?? a.scenes?.length ?? 0;
}

export function TransferDialog({ open, onOpenChange }: TransferDialogProps) {
  const { adventures, currentAdventureId, transferAdventure } = useFateStore();

  // Source candidates: every adventure EXCEPT the active one, sorted alphabetically.
  // The active adventure is always the destination (target).
  const sourceOptions = useMemo(() => {
    return adventures
      .filter((a) => a.id !== currentAdventureId)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }));
  }, [adventures, currentAdventureId]);

  const activeAdventure = adventures.find((a) => a.id === currentAdventureId);

  const [sourceId, setSourceId] = useState<string>('');
  const [options, setOptions] = useState<TransferOptions>({
    characters: true,
    scenes: true,
    items: true,
    folders: true,
    notes: false,
    settings: false,
    modules: false,
  });
  const [isTransferring, setIsTransferring] = useState(false);

  // Reset state when the dialog opens — pick the first alphabetical source
  // by default. Using useEffect (instead of onOpenChange) because Radix's
  // controlled Dialog doesn't reliably fire onOpenChange when the `open`
  // prop flips from false → true programmatically.
  useEffect(() => {
    if (!open) return;
    const sorted = adventures
      .filter((a) => a.id !== currentAdventureId)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }));
    setSourceId(sorted[0]?.id ?? '');
    setOptions({
      characters: true,
      scenes: true,
      items: true,
      folders: true,
      notes: false,
      settings: false,
      modules: false,
    });
  }, [open]);

  const handleOpenChange = (next: boolean) => {
    onOpenChange(next);
  };

  const toggleOption = (key: keyof TransferOptions) => {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const sourceAdv = adventures.find((a) => a.id === sourceId);
  const anySelected = Object.values(options).some(Boolean);
  const hasActive = Boolean(currentAdventureId);
  const hasSourceOptions = sourceOptions.length > 0;
  const canTransfer =
    hasActive &&
    hasSourceOptions &&
    Boolean(sourceId) &&
    anySelected &&
    sourceId !== currentAdventureId &&
    !isTransferring;

  const handleTransfer = async () => {
    if (!canTransfer || !currentAdventureId) return;
    setIsTransferring(true);
    try {
      const counts = await transferAdventure(sourceId, currentAdventureId, options);
      const parts: string[] = [];
      if (counts.characters) parts.push(`${counts.characters} персонажей`);
      if (counts.scenes) parts.push(`${counts.scenes} сцен`);
      if (counts.items) parts.push(`${counts.items} предметов`);
      if (counts.folders) parts.push(`${counts.folders} папок`);
      if (counts.notes) parts.push(`${counts.notes} заметок`);
      if (counts.settings) parts.push('настроек');
      if (counts.modules) parts.push('модулей');
      toast.success(
        parts.length > 0
          ? `Перенесено: ${parts.join(', ')}`
          : 'Перенос завершён (ничего не выбрано)',
      );
      handleOpenChange(false);
    } catch (error) {
      console.error('Transfer error:', error);
      toast.error('Не удалось перенести данные');
    } finally {
      setIsTransferring(false);
    }
  };

  // Edge case: no active adventure — nothing to copy INTO
  if (!hasActive) {
    return (
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
              <div
                className="fate-icon-circle"
                style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
              >
                <ArrowRight className="size-4" style={{ color: 'var(--fate-accent)' }} />
              </div>
              Перенос между приключениями
            </DialogTitle>
            <DialogDescription>
              Сначала выберите активное приключение — в него будут скопированы элементы
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2.5 p-3 rounded-lg border border-amber-500/30 bg-amber-500/8 text-amber-700 dark:text-amber-400">
            <AlertCircle className="size-4 mt-0.5 shrink-0" />
            <div className="text-xs">
              <p className="font-semibold mb-0.5">Нет активного приключения</p>
              <p className="text-muted-foreground">
                Выберите приключение в выпадающем списке сверху или создайте новое через «Создать новое...».
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={() => handleOpenChange(false)}
            >
              Закрыть
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <ArrowRight className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Перенос в «{activeAdventure?.name}»
          </DialogTitle>
          <DialogDescription>
            Копировать выбранные элементы из другого приключения в активное
          </DialogDescription>
        </DialogHeader>

        {/* Source → Target flow */}
        <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
          {/* Source — alphabetical, excludes active */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground">Из приключения</label>
            {hasSourceOptions ? (
              <Select value={sourceId} onValueChange={setSourceId}>
                <SelectTrigger className="h-9 text-xs rounded-lg">
                  <SelectValue placeholder="Источник" />
                </SelectTrigger>
                <SelectContent>
                  {sourceOptions.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="h-9 px-3 flex items-center rounded-lg border border-dashed border-border text-[11px] text-muted-foreground">
                Нет других приключений
              </div>
            )}
            {sourceAdv && (
              <div className="flex gap-2 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-0.5">
                  <Users className="size-2.5" />
                  {charCount(sourceAdv)}
                </span>
                <span className="flex items-center gap-0.5">
                  <Map className="size-2.5" />
                  {sceneCount(sourceAdv)}
                </span>
              </div>
            )}
          </div>

          <div className="pb-6">
            <ArrowRight className="size-4 text-muted-foreground" />
          </div>

          {/* Target — always the active adventure, locked */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
              В приключение
              <Badge
                className="text-[9px] h-4 px-1.5 font-bold rounded"
                style={{ backgroundColor: 'var(--fate-accent)', color: 'white', border: 'none' }}
              >
                Активно
              </Badge>
            </label>
            <div className="h-9 px-3 flex items-center gap-2 rounded-lg border border-[var(--fate-accent)]/40 bg-[var(--fate-accent)]/8 text-xs font-semibold">
              <CheckCircle2 className="size-3.5 text-[var(--fate-accent)]" />
              <span className="truncate">{activeAdventure?.name ?? '—'}</span>
            </div>
            {activeAdventure && (
              <div className="flex gap-2 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-0.5">
                  <Users className="size-2.5" />
                  {charCount(activeAdventure)}
                </span>
                <span className="flex items-center gap-0.5">
                  <Map className="size-2.5" />
                  {sceneCount(activeAdventure)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Transfer options */}
        <div className="space-y-1.5">
          <label className="text-xs font-semibold text-muted-foreground">Что перенести</label>
          <div className="grid grid-cols-2 gap-2">
            {OPTION_META.map(({ key, label, icon: Icon, description }) => {
              const active = options[key];
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => toggleOption(key)}
                  className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-left transition-all duration-150 ${
                    active
                      ? 'border-[var(--fate-accent)] bg-[var(--fate-accent)]/8'
                      : 'border-border hover:border-muted-foreground/30 bg-transparent'
                  }`}
                >
                  <Icon
                    className={`size-4 mt-0.5 shrink-0 ${active ? 'text-[var(--fate-accent)]' : 'text-muted-foreground'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold">{label}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{description}</div>
                  </div>
                  {active && (
                    <Badge
                      className="text-[9px] h-4 px-1.5 shrink-0 font-bold rounded"
                      style={{ backgroundColor: 'var(--fate-accent)', color: 'white', border: 'none' }}
                    >
                      ✓
                    </Badge>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Info note */}
        <div className="text-[11px] text-muted-foreground bg-muted/40 rounded-lg p-2.5 border border-border/50">
          ℹ Элементы <strong>копируются</strong>, а не перемещаются. Все ID генерируются заново,
          связи между сущностями (папки, сцены, токены) переопределяются.
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg"
            onClick={() => handleOpenChange(false)}
            disabled={isTransferring}
          >
            Отмена
          </Button>
          <Button
            size="sm"
            className="fate-btn-accent fate-button-shine rounded-lg gap-1.5"
            onClick={handleTransfer}
            disabled={!canTransfer}
          >
            {isTransferring ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Перенос...
              </>
            ) : (
              <>
                <ArrowRight className="size-3.5" />
                Перенести
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
