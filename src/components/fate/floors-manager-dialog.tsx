'use client';

import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Eye,
  EyeOff,
  Layers,
  Map as MapIcon,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';

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
import { Slider } from '@/components/ui/slider';
import { useFateStore } from '@/lib/store';
import type { Floor } from '@/lib/types';

interface FloorsManagerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sceneId: string | null;
}

export function FloorsManagerDialog({ open, onOpenChange, sceneId }: FloorsManagerDialogProps) {
  const {
    scenes,
    currentFloorIndex,
    setFloorIndex,
    addFloor,
    removeFloor,
    renameFloor,
    duplicateFloor,
    reorderFloor,
    setFloorOpacity,
  } = useFateStore();

  const scene = scenes.find((s) => s.id === sceneId) ?? null;
  const floors: Floor[] = scene?.floors ?? [];

  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<number | null>(null);
  const [newFloorName, setNewFloorName] = useState('');

  // Reset transient state when the dialog closes (handled via onOpenChange
  // wrapper to avoid calling setState synchronously inside an effect).
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setEditingIdx(null);
      setDeleteConfirm(null);
      setNewFloorName('');
    }
    onOpenChange(next);
  };

  const handleStartEdit = (idx: number, current: string) => {
    setEditingIdx(idx);
    setEditValue(current);
  };

  const handleCommitEdit = async () => {
    if (editingIdx === null || !sceneId) return;
    const trimmed = editValue.trim();
    if (trimmed) {
      await renameFloor(sceneId, editingIdx, trimmed);
    }
    setEditingIdx(null);
  };

  const handleAddFloor = async () => {
    if (!sceneId) return;
    const name = newFloorName.trim() || undefined;
    await addFloor(sceneId, name);
    setNewFloorName('');
  };

  const handleDelete = async (idx: number) => {
    if (!sceneId) return;
    await removeFloor(sceneId, idx);
    setDeleteConfirm(null);
  };

  const handleDuplicate = async (idx: number) => {
    if (!sceneId) return;
    await duplicateFloor(sceneId, idx);
  };

  const handleMove = async (from: number, dir: -1 | 1) => {
    if (!sceneId) return;
    const to = from + dir;
    if (to < 0 || to >= floors.length) return;
    await reorderFloor(sceneId, from, to);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md md:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(127, 140, 141, 0.12)' }}
            >
              <Layers className="size-4" style={{ color: 'var(--fate-text-muted)' }} />
            </div>
            Управление этажами
          </DialogTitle>
          <DialogDescription>
            Добавляйте, переименовывайте, дублируйте и удаляйте этажи карты.
            Каждый этаж хранит свои токены, зоны, рисунки и туман войны.
          </DialogDescription>
        </DialogHeader>

        {/* Add new floor */}
        <div className="flex gap-2">
          <Input
            placeholder="Название этажа (необязательно)…"
            value={newFloorName}
            onChange={(e) => setNewFloorName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddFloor()}
            className="text-sm rounded-lg"
          />
          <Button
            onClick={handleAddFloor}
            size="sm"
            className="fate-btn-accent fate-button-shine shrink-0 gap-1.5 rounded-lg"
          >
            <Plus className="size-4" />
            Добавить
          </Button>
        </div>

        {/* Floors list */}
        <ScrollArea className="max-h-80">
          <div className="space-y-1.5 pr-1">
            {floors.length === 0 ? (
              <div className="text-center py-8 animate-fade-in">
                <div
                  className="size-14 mx-auto rounded-xl flex items-center justify-center mb-2"
                  style={{ backgroundColor: 'rgba(127, 140, 141, 0.08)' }}
                >
                  <MapIcon className="size-6" style={{ color: 'var(--fate-text-muted)', opacity: 0.3 }} />
                </div>
                <p className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Нет этажей
                </p>
              </div>
            ) : (
              floors.map((floor, idx) => {
                const isActive = idx === currentFloorIndex;
                const tokenCount = floor.tokens?.length ?? 0;
                const zoneCount = floor.zones?.length ?? 0;
                const drawingCount = floor.drawings?.length ?? 0;
                const hasBg = !!(floor.backgroundImage || floor.background);
                const isEditing = editingIdx === idx;
                const isConfirming = deleteConfirm === idx;

                return (
                  <div
                    key={floor.id}
                    className={`fate-list-item flex flex-col gap-2 p-3 transition-all duration-200 ${
                      isActive ? 'border-l-[3px]' : ''
                    }`}
                    style={{
                      backgroundColor: isActive ? 'rgba(230, 126, 34, 0.06)' : 'transparent',
                      borderLeftColor: isActive ? 'var(--fate-accent)' : 'transparent',
                    }}
                  >
                    {/* Top row: index, name, actions */}
                    <div className="flex items-center gap-2">
                      {/* Floor index badge */}
                      <button
                        onClick={() => setFloorIndex(idx)}
                        className="shrink-0 size-7 rounded-md flex items-center justify-center text-[11px] font-bold transition-colors"
                        style={{
                          backgroundColor: isActive
                            ? 'var(--fate-accent)'
                            : 'rgba(127, 140, 141, 0.12)',
                          color: isActive ? '#fff' : 'var(--fate-text-muted)',
                        }}
                        title={isActive ? 'Текущий этаж' : `Перейти на этаж ${idx + 1}`}
                      >
                        {idx + 1}
                      </button>

                      {/* Name / edit input */}
                      {isEditing ? (
                        <Input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onBlur={handleCommitEdit}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCommitEdit();
                            if (e.key === 'Escape') setEditingIdx(null);
                          }}
                          className="h-7 text-sm rounded-md flex-1"
                        />
                      ) : (
                        <button
                          onClick={() => setFloorIndex(idx)}
                          className="flex-1 text-left text-sm font-medium truncate min-w-0"
                          style={{ color: isActive ? 'var(--fate-text)' : 'var(--fate-text-muted)' }}
                          title={floor.name || `Этаж ${idx + 1}`}
                        >
                          {floor.name || `Этаж ${idx + 1}`}
                        </button>
                      )}

                      {/* Quick actions */}
                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          onClick={() => handleStartEdit(idx, floor.name || `Этаж ${idx + 1}`)}
                          className="size-7 rounded-md flex items-center justify-center transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                          style={{ color: 'var(--fate-text-muted)' }}
                          title="Переименовать"
                        >
                          <Pencil className="size-3.5" />
                        </button>
                        <button
                          onClick={() => handleDuplicate(idx)}
                          className="size-7 rounded-md flex items-center justify-center transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                          style={{ color: 'var(--fate-text-muted)' }}
                          title="Дублировать"
                        >
                          <Copy className="size-3.5" />
                        </button>
                        <button
                          onClick={() => handleMove(idx, -1)}
                          disabled={idx === 0}
                          className="size-7 rounded-md flex items-center justify-center transition-colors hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
                          style={{ color: 'var(--fate-text-muted)' }}
                          title="Поднять вверх"
                        >
                          <ArrowUp className="size-3.5" />
                        </button>
                        <button
                          onClick={() => handleMove(idx, 1)}
                          disabled={idx === floors.length - 1}
                          className="size-7 rounded-md flex items-center justify-center transition-colors hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent"
                          style={{ color: 'var(--fate-text-muted)' }}
                          title="Опустить вниз"
                        >
                          <ArrowDown className="size-3.5" />
                        </button>
                        {isConfirming ? (
                          <>
                            <button
                              onClick={() => handleDelete(idx)}
                              disabled={floors.length <= 1}
                              className="size-7 rounded-md flex items-center justify-center transition-colors disabled:opacity-30"
                              style={{ backgroundColor: 'rgba(231, 76, 60, 0.15)', color: '#e74c3c' }}
                              title="Подтвердить удаление"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                            <button
                              onClick={() => setDeleteConfirm(null)}
                              className="px-1.5 h-7 text-[10px] rounded-md"
                              style={{ color: 'var(--fate-text-muted)' }}
                            >
                              отмена
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setDeleteConfirm(idx)}
                            disabled={floors.length <= 1}
                            className="size-7 rounded-md flex items-center justify-center transition-colors hover:bg-red-500/10 disabled:opacity-30 disabled:hover:bg-transparent"
                            style={{ color: '#e74c3c' }}
                            title={floors.length <= 1 ? 'Нельзя удалить последний этаж' : 'Удалить этаж'}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Bottom row: stats + opacity */}
                    <div className="flex items-center gap-3 pl-9">
                      {/* Stats badges */}
                      <div className="flex items-center gap-1.5 text-[10px] flex-wrap" style={{ color: 'var(--fate-text-muted)' }}>
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(127, 140, 141, 0.1)' }}>
                          <span style={{ color: 'var(--fate-accent)' }}>{tokenCount}</span> ток.
                        </span>
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(127, 140, 141, 0.1)' }}>
                          <span style={{ color: 'var(--fate-accent)' }}>{zoneCount}</span> зон
                        </span>
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(127, 140, 141, 0.1)' }}>
                          <span style={{ color: 'var(--fate-accent)' }}>{drawingCount}</span> рис.
                        </span>
                        {hasBg ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(39, 174, 96, 0.12)', color: '#27ae60' }}>
                            <Eye className="size-2.5" /> фон
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(127, 140, 141, 0.1)' }}>
                            <EyeOff className="size-2.5" /> без фона
                          </span>
                        )}
                        {floor.fogEnabled && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(52, 152, 219, 0.12)', color: '#3498db' }}>
                            туман
                          </span>
                        )}
                      </div>

                      {/* Opacity slider */}
                      <div className="flex items-center gap-1.5 ml-auto min-w-[110px]">
                        <span className="text-[10px] shrink-0" style={{ color: 'var(--fate-text-muted)' }}>
                          Прозр.
                        </span>
                        <Slider
                          value={[floor.opacity ?? 100]}
                          min={10}
                          max={100}
                          step={5}
                          onValueChange={(vals) => {
                            if (sceneId) setFloorOpacity(sceneId, idx, vals[0]);
                          }}
                          className="flex-1"
                        />
                        <span className="text-[10px] font-mono w-7 text-right" style={{ color: 'var(--fate-text-muted)' }}>
                          {floor.opacity ?? 100}%
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)} className="rounded-lg">
            Готово
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
