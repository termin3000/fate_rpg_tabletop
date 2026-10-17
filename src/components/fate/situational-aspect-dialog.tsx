'use client';

import { useCallback, useState } from 'react';
import { Plus, Sparkles, Trash2 } from 'lucide-react';

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

interface SituationalAspectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  charId: string | null;
  /** If set, adds aspect to zone instead of token */
  zoneId?: string | null;
}

export function SituationalAspectDialog({ open, onOpenChange, charId, zoneId }: SituationalAspectDialogProps) {
  const characters = useFateStore((s) => s.characters);
  const scenes = useFateStore((s) => s.scenes);
  const currentSceneId = useFateStore((s) => s.currentSceneId);
  const currentFloorIndex = useFateStore((s) => s.currentFloorIndex);
  const updateScene = useFateStore((s) => s.updateScene);

  const [newAspect, setNewAspect] = useState('');

  const char = charId ? characters.find((c) => c.id === charId) ?? null : null;
  const scene = scenes.find((s) => s.id === currentSceneId) ?? null;
  const floor = scene?.floors[currentFloorIndex] ?? null;

  // Get situational aspects from token or zone
  const token = charId && floor
    ? floor.tokens.find((t) => t.charId === charId) ?? null
    : null;
  const zone = zoneId && floor
    ? floor.zones.find((z) => z.id === zoneId) ?? null
    : null;

  const existingAspects: string[] = token
    ? (token.situationalAspects ?? [])
    : zone
      ? zone.aspects
      : [];

  const targetName = char?.name ?? zone?.name ?? 'Объект';
  const isPlayer = char?.type === 'player';
  const tokenColor = isPlayer ? '#e67e22' : '#27ae60';

  const resetForm = useCallback(() => {
    setNewAspect('');
  }, []);

  const handleOpenChange = useCallback((o: boolean) => {
    if (!o) resetForm();
    onOpenChange(o);
  }, [onOpenChange, resetForm]);

  const handleAddAspect = useCallback(async () => {
    const trimmed = newAspect.trim();
    if (!trimmed) return;

    // Re-read scene/floor at call time to avoid stale closure
    const currentScene = useFateStore.getState().scenes.find((s) => s.id === useFateStore.getState().currentSceneId);
    const currentFloor = currentScene?.floors[useFateStore.getState().currentFloorIndex];
    if (!currentScene || !currentFloor) return;

    const updatedFloors = [...currentScene.floors];

    const currentToken = charId ? currentFloor.tokens.find((t) => t.charId === charId) : null;
    const currentZone = zoneId ? currentFloor.zones.find((z) => z.id === zoneId) : null;

    if (currentToken) {
      const updatedTokens = currentFloor.tokens.map((t) =>
        t.charId === charId
          ? { ...t, situationalAspects: [...(t.situationalAspects ?? []), trimmed] }
          : t,
      );
      updatedFloors[useFateStore.getState().currentFloorIndex] = { ...currentFloor, tokens: updatedTokens };
    } else if (currentZone) {
      const updatedZones = currentFloor.zones.map((z) =>
        z.id === zoneId
          ? { ...z, aspects: [...z.aspects, trimmed] }
          : z,
      );
      updatedFloors[useFateStore.getState().currentFloorIndex] = { ...currentFloor, zones: updatedZones };
    }

    await updateScene(currentScene.id, { floors: updatedFloors });
    setNewAspect('');
  }, [newAspect, charId, zoneId, updateScene]);

  const handleRemoveAspect = useCallback(async (index: number) => {
    const currentScene = useFateStore.getState().scenes.find((s) => s.id === useFateStore.getState().currentSceneId);
    const currentFloor = currentScene?.floors[useFateStore.getState().currentFloorIndex];
    if (!currentScene || !currentFloor) return;

    const updatedFloors = [...currentScene.floors];

    const currentToken = charId ? currentFloor.tokens.find((t) => t.charId === charId) : null;
    const currentZone = zoneId ? currentFloor.zones.find((z) => z.id === zoneId) : null;

    if (currentToken) {
      const updatedTokens = currentFloor.tokens.map((t) =>
        t.charId === charId
          ? { ...t, situationalAspects: (t.situationalAspects ?? []).filter((_, i) => i !== index) }
          : t,
      );
      updatedFloors[useFateStore.getState().currentFloorIndex] = { ...currentFloor, tokens: updatedTokens };
    } else if (currentZone) {
      const updatedZones = currentFloor.zones.map((z) =>
        z.id === zoneId
          ? { ...z, aspects: z.aspects.filter((_, i) => i !== index) }
          : z,
      );
      updatedFloors[useFateStore.getState().currentFloorIndex] = { ...currentFloor, zones: updatedZones };
    }

    await updateScene(currentScene.id, { floors: updatedFloors });
  }, [charId, zoneId, updateScene]);

  // Determine which target we're working with
  if (!char && !zone) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <Sparkles className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Ситуационные аспекты
          </DialogTitle>
          <DialogDescription>
            Управление ситуационными аспектами на токене или зоне
          </DialogDescription>
        </DialogHeader>

        {/* Target preview */}
        <div
          className="flex items-center gap-2.5 p-2.5 rounded-lg border"
          style={{
            borderColor: 'var(--fate-border)',
            backgroundColor: 'var(--fate-bg-card)',
          }}
        >
          {char ? (
            <div
              className="flex items-center justify-center size-10 rounded-full shrink-0 text-white text-sm font-bold shadow-sm"
              style={{
                background: `linear-gradient(135deg, ${tokenColor}, ${tokenColor}dd)`,
                border: '2px solid var(--fate-bg-card)',
              }}
            >
              {char.name.charAt(0).toUpperCase()}
            </div>
          ) : (
            <div
              className="flex items-center justify-center size-10 rounded-lg shrink-0 text-white text-sm font-bold shadow-sm"
              style={{
                backgroundColor: zone?.color ?? '#3498db',
                border: '2px solid var(--fate-bg-card)',
              }}
            >
              ◆
            </div>
          )}
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
              {targetName}
            </div>
            <div className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
              {char ? (isPlayer ? 'Игрок' : 'NPC') : 'Зона'} · аспектов: {existingAspects.length}
            </div>
          </div>
        </div>

        {/* Active aspects list */}
        <div className="space-y-1.5">
          <div
            className="text-xs font-semibold uppercase tracking-wider fate-section-header pb-1.5"
            style={{ color: 'var(--fate-text-muted)' }}
          >
            Активные аспекты
          </div>

          {existingAspects.length === 0 ? (
            <div className="py-5 text-center rounded-lg border border-dashed" style={{ borderColor: 'var(--fate-border)' }}>
              <p className="text-xs" style={{ color: 'var(--fate-text-muted)', opacity: 0.7 }}>
                Нет ситуационных аспектов
              </p>
              <p className="text-[10px] mt-0.5" style={{ color: 'var(--fate-text-muted)', opacity: 0.5 }}>
                Введите аспект ниже, чтобы добавить
              </p>
            </div>
          ) : (
            <ScrollArea className="max-h-44 fate-scroll">
              <div className="space-y-1.5 pr-2">
                {existingAspects.map((aspect, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-2 p-2 rounded-lg border animate-fade-in"
                    style={{
                      borderColor: 'rgba(230, 126, 34, 0.2)',
                      backgroundColor: 'rgba(230, 126, 34, 0.05)',
                    }}
                  >
                    <span className="text-sm" style={{ color: 'var(--fate-accent)' }}>◆</span>
                    <span className="text-sm italic flex-1 min-w-0 truncate" style={{ color: 'var(--fate-text)' }}>
                      {aspect}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6 hover:bg-red-50 dark:hover:bg-red-950/30 shrink-0"
                      onClick={() => handleRemoveAspect(idx)}
                      title="Удалить аспект"
                      aria-label="Удалить аспект"
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

        {/* Add aspect form */}
        <div className="space-y-2">
          <div
            className="text-xs font-semibold uppercase tracking-wider fate-section-header pb-1.5"
            style={{ color: 'var(--fate-text-muted)' }}
          >
            Добавить аспект
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={newAspect}
              onChange={(e) => setNewAspect(e.target.value)}
              placeholder="Ситуационный аспект…"
              className="text-sm"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddAspect();
                }
              }}
            />
            <Button
              size="sm"
              className="fate-btn-accent fate-button-shine h-8 px-3 text-xs rounded-md gap-1 shrink-0"
              onClick={handleAddAspect}
              disabled={!newAspect.trim()}
            >
              <Plus className="size-3" />
              Добавить
            </Button>
          </div>
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
