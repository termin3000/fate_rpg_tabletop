'use client';

import { useState } from 'react';
import { CheckCircle, Eye, Layers, Map, Plus, Swords, Trash2, Users } from 'lucide-react';

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
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFateStore } from '@/lib/store';
import { ScenePreview } from '@/components/fate/scene-preview';

interface ScenesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ScenesDialog({ open, onOpenChange }: ScenesDialogProps) {
  const {
    scenes,
    currentSceneId,
    createScene,
    deleteScene,
    switchScene,
  } = useFateStore();

  const [newName, setNewName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setIsCreating(true);
    try {
      await createScene(newName.trim());
      setNewName('');
    } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    await deleteScene(id);
    setDeleteConfirm(null);
  };

  const handleSetActive = (id: string) => {
    if (id !== currentSceneId) {
      switchScene(id);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md md:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <Map className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Управление сценами
          </DialogTitle>
          <DialogDescription>
            Создайте, переключайте или удалите сцены приключения
          </DialogDescription>
        </DialogHeader>

        {/* Create New Scene */}
        <div className="flex gap-2">
          <Input
            placeholder="Название новой сцены..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="text-sm rounded-lg"
          />
          <Button
            onClick={handleCreate}
            disabled={!newName.trim() || isCreating}
            size="sm"
            className="fate-btn-accent fate-button-shine shrink-0 gap-1.5 rounded-lg"
          >
            <Plus className="size-4" />
            Новая сцена
          </Button>
        </div>

        {/* Scenes List */}
        <ScrollArea className="max-h-72">
          <div className="space-y-1.5 pr-1">
            {scenes.length === 0 ? (
              <div className="text-center py-8 animate-fade-in">
                <div
                  className="size-14 mx-auto rounded-xl flex items-center justify-center mb-2"
                  style={{ backgroundColor: 'rgba(127, 140, 141, 0.08)' }}
                >
                  <Map className="size-6" style={{ color: 'var(--fate-text-muted)', opacity: 0.3 }} />
                </div>
                <p className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Нет сцен
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--fate-text-muted)', opacity: 0.6 }}>
                  Создайте первую сцену, чтобы начать игру
                </p>
              </div>
            ) : (
              scenes.map((scene) => {
                const isActive = scene.id === currentSceneId;
                const charCount = scene.presentCharacters?.length ?? 0;
                const totalFloors = scene.floors?.length ?? 0;
                const totalTokens = scene.floors?.reduce(
                  (sum, f) => sum + (f.tokens?.length ?? 0),
                  0,
                ) ?? 0;

                return (
                  <div
                    key={scene.id}
                    className={`fate-list-item flex items-start gap-3 p-3 transition-all duration-200 hover:translate-x-0.5 ${
                      isActive ? 'border-l-[3px]' : ''
                    }`}
                    style={{
                      backgroundColor: isActive ? 'rgba(230, 126, 34, 0.06)' : 'transparent',
                      borderLeftColor: isActive ? 'var(--fate-accent)' : 'transparent',
                    }}
                  >
                    {/* Scene preview thumbnail */}
                    <div
                      className="shrink-0 rounded-lg overflow-hidden transition-transform duration-200 hover:scale-105 cursor-pointer relative"
                      style={{
                        boxShadow: isActive
                          ? '0 2px 8px var(--fate-accent-glow)'
                          : '0 1px 3px rgba(0,0,0,0.08)',
                      }}
                      onClick={() => !isActive && handleSetActive(scene.id)}
                      title={isActive ? 'Активная сцена' : `Перейти к сцене «${scene.name}»`}
                    >
                      <ScenePreview
                        scene={scene}
                        width={84}
                        height={62}
                        isActive={isActive}
                      />
                      {/* Conflict indicator overlay */}
                      {scene.conflictData && (
                        <div
                          className="absolute top-1 right-1 size-4 rounded-full flex items-center justify-center text-[9px]"
                          style={{ backgroundColor: 'rgba(231, 76, 60, 0.95)' }}
                          title={`Активен конфликт — раунд ${scene.conflictData.round}`}
                        >
                          <Swords className="size-2.5 text-white" />
                        </div>
                      )}
                    </div>

                    {/* Scene info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                          {scene.name}
                        </span>
                        {isActive && (
                          <Badge
                            className="text-[10px] h-5 px-2 shrink-0 font-semibold rounded-md shadow-sm"
                            style={{ backgroundColor: 'var(--fate-accent)', color: 'white', border: 'none' }}
                          >
                            Активная
                          </Badge>
                        )}
                        {scene.conflictData && (
                          <Badge
                            className="text-[9px] h-5 px-1.5 shrink-0 font-semibold rounded-md shadow-sm animate-pulse"
                            style={{ backgroundColor: 'rgba(231, 76, 60, 0.15)', color: 'var(--fate-danger)', border: '1px solid rgba(231, 76, 60, 0.3)' }}
                            title={`Раунд ${scene.conflictData.round}`}
                          >
                            <Swords className="size-2.5 mr-0.5" />
                            Р{scene.conflictData.round}
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1 text-[10px] flex-wrap" style={{ color: 'var(--fate-text-muted)' }}>
                        <span
                          className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md"
                          style={{ backgroundColor: 'rgba(127, 140, 141, 0.08)' }}
                          title={`${charCount} персонажей на сцене`}
                        >
                          <Users className="size-2.5" />
                          {charCount}
                        </span>
                        {totalFloors > 0 && (
                          <span
                            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md"
                            style={{ backgroundColor: 'rgba(52, 152, 219, 0.08)' }}
                            title={`${totalFloors} этаж(ей)`}
                          >
                            <Layers className="size-2.5" />
                            {totalFloors}
                          </span>
                        )}
                        {totalTokens > 0 && (
                          <span
                            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md"
                            style={{ backgroundColor: 'rgba(39, 174, 96, 0.08)' }}
                            title={`${totalTokens} токенов на карте`}
                          >
                            <Map className="size-2.5" />
                            {totalTokens}
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-1 shrink-0 self-center">
                      {!isActive && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-7 px-2 gap-1 rounded-lg hover:scale-105 active:scale-95 transition-all"
                          style={{ color: 'var(--fate-accent)' }}
                          onClick={() => handleSetActive(scene.id)}
                        >
                          <Eye className="size-3" />
                          Перейти
                        </Button>
                      )}

                      {deleteConfirm === scene.id ? (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs h-6 px-2 rounded-md"
                            onClick={() => handleDelete(scene.id)}
                            style={{ color: 'var(--fate-danger)' }}
                          >
                            Удалить
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs h-6 px-2 rounded-md"
                            onClick={() => setDeleteConfirm(null)}
                          >
                            Отмена
                          </Button>
                        </div>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 rounded-lg opacity-30 hover:opacity-100 transition-all duration-200 hover:scale-110 active:scale-90"
                          style={{ color: 'var(--fate-danger)' }}
                          onClick={() => setDeleteConfirm(scene.id)}
                          aria-label="Удалить сцену"
                          title="Удалить"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>

        <DialogFooter>
          <Button variant="outline" size="sm" className="rounded-lg" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
