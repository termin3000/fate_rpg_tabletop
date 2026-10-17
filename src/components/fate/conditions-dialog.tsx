'use client';

import { useCallback, useState } from 'react';
import { Plus, Sparkles, Trash2, X } from 'lucide-react';

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
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

import { useFateStore } from '@/lib/store';
import { CONDITION_PRESETS, type Condition } from '@/lib/types';

interface ConditionsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  charId: string | null;
}

// ── Helper: hex to rgba ──────────────────────────────────────
function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export function ConditionsDialog({ open, onOpenChange, charId }: ConditionsDialogProps) {
  const { characters, scenes, currentSceneId, addCondition, removeCondition } = useFateStore();

  // ── Pending add form state ─────────────────────────────────
  const [pendingPreset, setPendingPreset] = useState<string | null>(null);
  const [durationStr, setDurationStr] = useState('3');
  const [unlimited, setUnlimited] = useState(false);

  const char = characters.find((c) => c.id === charId) ?? null;
  const scene = scenes.find((s) => s.id === currentSceneId) ?? null;

  // Search all floors of the current scene for the token (the character's token
  // might be on a floor other than the currently selected one).
  const allFloorToken = scene?.floors
    .flatMap((f) => f.tokens)
    .find((t) => t.charId === charId) ?? null;
  const conditions: Condition[] = allFloorToken?.conditions ?? [];

  const resetForm = useCallback(() => {
    setPendingPreset(null);
    setDurationStr('3');
    setUnlimited(false);
  }, []);

  const handleOpenChange = useCallback((o: boolean) => {
    if (!o) resetForm();
    onOpenChange(o);
  }, [onOpenChange, resetForm]);

  const handlePresetClick = useCallback((key: string) => {
    setPendingPreset(key);
    setUnlimited(false);
    setDurationStr('3');
  }, []);

  const handleAdd = useCallback(async () => {
    if (!charId || !pendingPreset) return;
    const preset = CONDITION_PRESETS[pendingPreset];
    if (!preset) return;
    const duration = unlimited ? -1 : Math.max(1, parseInt(durationStr) || 1);
    await addCondition(charId, { ...preset, duration });
    resetForm();
  }, [charId, pendingPreset, durationStr, unlimited, addCondition, resetForm]);

  const handleRemove = useCallback(async (conditionId: string) => {
    if (!charId) return;
    await removeCondition(charId, conditionId);
  }, [charId, removeCondition]);

  if (!char) return null;

  const isPlayer = char.type === 'player';
  const tokenColor = isPlayer ? '#e67e22' : '#27ae60';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(241, 196, 15, 0.15)' }}
            >
              <Sparkles className="size-4" style={{ color: '#f1c40f' }} />
            </div>
            Состояния персонажа
          </DialogTitle>
          <DialogDescription>
            Управление временными состояниями и эффектами на токене
          </DialogDescription>
        </DialogHeader>

        {/* Character preview */}
        <div
          className="flex items-center gap-2.5 p-2.5 rounded-lg border"
          style={{
            borderColor: 'var(--fate-border)',
            backgroundColor: 'var(--fate-bg-card)',
          }}
        >
          <div
            className="flex items-center justify-center size-10 rounded-full shrink-0 text-white text-sm font-bold shadow-sm"
            style={{
              background: `linear-gradient(135deg, ${tokenColor}, ${tokenColor}dd)`,
              border: '2px solid var(--fate-bg-card)',
            }}
          >
            {char.name.charAt(0).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
              {char.name}
            </div>
            <div className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
              {isPlayer ? 'Игрок' : 'NPC'} · состояний: {conditions.length}
            </div>
          </div>
        </div>

        {/* Active conditions list */}
        <div className="space-y-1.5">
          <div
            className="text-xs font-semibold uppercase tracking-wider fate-section-header pb-1.5"
            style={{ color: 'var(--fate-text-muted)' }}
          >
            Активные состояния
          </div>

          {conditions.length === 0 ? (
            <div className="py-5 text-center rounded-lg border border-dashed" style={{ borderColor: 'var(--fate-border)' }}>
              <p className="text-xs" style={{ color: 'var(--fate-text-muted)', opacity: 0.7 }}>
                Нет активных состояний
              </p>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--fate-text-muted)', opacity: 0.5 }}>
                Выберите состояние ниже, чтобы добавить
              </p>
            </div>
          ) : (
            <ScrollArea className="max-h-44 fate-scroll">
              <div className="space-y-1.5 pr-2">
                {conditions.map((cond) => (
                  <div
                    key={cond.id}
                    className="flex items-center gap-2 p-2 rounded-lg border animate-fade-in"
                    style={{
                      borderColor: hexToRgba(cond.color, 0.3),
                      backgroundColor: hexToRgba(cond.color, 0.05),
                    }}
                  >
                    <div
                      className="size-7 rounded-full flex items-center justify-center text-sm shrink-0 shadow-sm"
                      style={{ backgroundColor: cond.color, border: '2px solid var(--fate-bg-card)' }}
                    >
                      {cond.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                        {cond.name}
                      </div>
                      <div className="text-[10px] truncate" style={{ color: 'var(--fate-text-muted)' }}>
                        {cond.description || '—'}
                      </div>
                    </div>
                    <div
                      className="text-[10px] font-bold px-2 py-0.5 rounded-md shrink-0"
                      style={{
                        backgroundColor:
                          cond.duration === -1
                            ? 'rgba(127,140,141,0.15)'
                            : 'rgba(230,126,34,0.12)',
                        color:
                          cond.duration === -1
                            ? 'var(--fate-text-muted)'
                            : 'var(--fate-accent)',
                      }}
                    >
                      {cond.duration === -1 ? '∞ Бессрочно' : `${cond.duration} раунд.`}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 hover:bg-red-50 dark:hover:bg-red-950/30 shrink-0"
                      onClick={() => handleRemove(cond.id)}
                      title="Удалить состояние"
                      aria-label="Удалить состояние"
                    >
                      <Trash2 className="size-3 text-red-500" />
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </div>

        <Separator />

        {/* Add condition section */}
        <div className="space-y-2">
          <div
            className="text-xs font-semibold uppercase tracking-wider fate-section-header pb-1.5"
            style={{ color: 'var(--fate-text-muted)' }}
          >
            Добавить состояние
          </div>

          <div className="grid grid-cols-3 gap-1.5">
            {Object.entries(CONDITION_PRESETS).map(([key, preset]) => {
              const isPending = pendingPreset === key;
              return (
                <button
                  key={key}
                  type="button"
                  className="flex items-center gap-1.5 p-1.5 rounded-lg border text-left transition-all duration-150 hover:shadow-sm"
                  style={{
                    borderColor: isPending ? preset.color : 'var(--fate-border)',
                    backgroundColor: isPending
                      ? hexToRgba(preset.color, 0.12)
                      : 'var(--fate-bg-card)',
                  }}
                  onClick={() => handlePresetClick(key)}
                  title={preset.description}
                >
                  <div
                    className="size-6 rounded-full flex items-center justify-center text-xs shrink-0"
                    style={{ backgroundColor: preset.color, border: '1.5px solid var(--fate-bg-card)' }}
                  >
                    {preset.icon}
                  </div>
                  <span
                    className="text-[10px] font-medium truncate"
                    style={{ color: 'var(--fate-text)' }}
                  >
                    {preset.name}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Duration form — visible when a preset is selected */}
          {pendingPreset && (
            <div
              className="flex flex-wrap items-end gap-2 p-2.5 rounded-lg border animate-fade-in"
              style={{
                borderColor: 'var(--fate-accent)',
                backgroundColor: 'rgba(230,126,34,0.04)',
              }}
            >
              <div className="flex-1 min-w-[100px]">
                <label
                  className="text-[10px] font-semibold uppercase tracking-wide block mb-1"
                  style={{ color: 'var(--fate-text-muted)' }}
                >
                  Длительность (раундов)
                </label>
                <Input
                  type="number"
                  min={1}
                  value={durationStr}
                  onChange={(e) => setDurationStr(e.target.value)}
                  disabled={unlimited}
                  className="h-8 text-xs"
                />
              </div>
              <button
                type="button"
                onClick={() => setUnlimited(!unlimited)}
                className="h-8 px-3 rounded-md text-xs font-semibold transition-all duration-150 shrink-0"
                style={{
                  backgroundColor: unlimited ? 'var(--fate-accent)' : 'var(--fate-bg-card)',
                  color: unlimited ? 'white' : 'var(--fate-text-muted)',
                  border: unlimited ? 'none' : '1px solid var(--fate-border)',
                }}
                title="Бессрочное состояние"
              >
                ∞ Бессрочно
              </button>
              <Button
                size="sm"
                className="fate-btn-accent fate-button-shine h-8 px-3 text-xs rounded-md gap-1 shrink-0"
                onClick={handleAdd}
              >
                <Plus className="size-3" />
                Добавить
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-8 w-8 p-0 shrink-0"
                onClick={resetForm}
                title="Отмена"
                aria-label="Отменить добавление"
              >
                <X className="size-3.5" />
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => handleOpenChange(false)}
            className="rounded-lg"
          >
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
