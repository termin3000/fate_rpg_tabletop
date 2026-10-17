'use client';

import { useState } from 'react';
import {
  ArrowLeftRight,
  Eye,
  EyeOff,
  Package,
  Pencil,
  Plus,
  Trash2,
  X,
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useFateStore } from '@/lib/store';
import type { Item } from '@/lib/types';

interface InventoryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InventoryDialog({ open, onOpenChange }: InventoryDialogProps) {
  const {
    items,
    currentAdventureId,
    currentSceneId,
    currentMode,
    createItem,
    updateItem,
    deleteItem,
  } = useFateStore();

  const isGM = currentMode === 'master';

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newItemType, setNewItemType] = useState<'item' | 'note'>('item');
  const [newItemName, setNewItemName] = useState('');
  const [newItemDesc, setNewItemDesc] = useState('');
  const [newItemText, setNewItemText] = useState('');
  const [newItemOnScene, setNewItemOnScene] = useState(false);
  const [isCreating, setIsCreating] = useState(false);

  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editText, setEditText] = useState('');

  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const resetCreateForm = () => {
    setNewItemType('item');
    setNewItemName('');
    setNewItemDesc('');
    setNewItemText('');
    setNewItemOnScene(false);
    setShowCreateForm(false);
  };

  // ── Filtered items ──
  // GM sees everything; players only see items on the current scene
  const visibleItems = isGM
    ? items.filter((i) => i.adventureId === currentAdventureId)
    : items.filter((i) => i.adventureId === currentAdventureId && i.sceneId === currentSceneId);

  const onSceneItems = visibleItems.filter((i) => i.sceneId === currentSceneId);
  const gmOnlyItems = visibleItems.filter((i) => !i.sceneId);

  const handleCreate = async () => {
    if (!newItemName.trim() || !currentAdventureId) return;
    setIsCreating(true);
    try {
      await createItem({
        name: newItemName.trim(),
        type: newItemType,
        description: newItemDesc.trim(),
        text: newItemType === 'note' ? newItemText.trim() || null : null,
        adventureId: currentAdventureId,
        sceneId: newItemOnScene ? currentSceneId : null,
      });
      resetCreateForm();
      toast.success('Элемент создан');
    } finally {
      setIsCreating(false);
    }
  };

  const handleStartEdit = (item: Item) => {
    setEditingItemId(item.id);
    setEditName(item.name);
    setEditDesc(item.description);
    setEditText(item.text ?? '');
  };

  const handleSaveEdit = async () => {
    if (!editingItemId) return;
    await updateItem(editingItemId, {
      name: editName.trim(),
      description: editDesc.trim(),
      text: editText.trim() || null,
    });
    setEditingItemId(null);
  };

  const handleDelete = async (id: string) => {
    await deleteItem(id);
    setDeleteConfirm(null);
  };

  const handleToggleScene = async (item: Item) => {
    const newSceneId = item.sceneId ? null : currentSceneId;
    await updateItem(item.id, { sceneId: newSceneId });
    toast.success(newSceneId ? 'Предмет перемещён на сцену' : 'Предмет скрыт от игроков');
  };

  // ── Render single item card ──
  const renderItem = (item: Item) => (
    <div
      key={item.id}
      className="fate-card p-2.5"
      style={{
        borderLeft: `3px solid ${item.type === 'item' ? 'var(--fate-accent)' : '#9b59b6'}`,
      }}
    >
      {editingItemId === item.id ? (
        <div className="space-y-2">
          <Input
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            className="h-7 text-sm rounded-lg"
            autoFocus
          />
          <Input
            value={editDesc}
            onChange={(e) => setEditDesc(e.target.value)}
            placeholder="Описание"
            className="h-7 text-sm rounded-lg"
          />
          {item.type === 'note' && (
            <Textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              placeholder="Текст заметки"
              className="text-sm min-h-16 rounded-lg"
            />
          )}
          <div className="flex justify-end gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-xs h-6 px-2 rounded-lg"
              onClick={() => setEditingItemId(null)}
              aria-label="Отменить редактирование"
              title="Отмена"
            >
              <X className="size-3" />
            </Button>
            <Button
              size="sm"
              className="text-xs h-6 px-2 fate-btn-accent fate-button-shine rounded-lg"
              onClick={handleSaveEdit}
            >
              ✓ Сохранить
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                {item.name}
              </span>
              <Badge
                className="text-[10px] h-5 px-2 shrink-0 font-semibold rounded-md"
                style={{
                  backgroundColor: item.type === 'item' ? 'var(--fate-accent)' : '#9b59b6',
                  color: 'white',
                  border: 'none',
                }}
              >
                {item.type === 'item' ? 'Предмет' : 'Заметка'}
              </Badge>
              {/* Visibility badge — GM only */}
              {isGM && (
                <Badge
                  className="text-[10px] h-5 px-2 shrink-0 font-semibold rounded-md"
                  style={{
                    backgroundColor: item.sceneId
                      ? 'rgba(39, 174, 96, 0.12)'
                      : 'rgba(127, 140, 141, 0.12)',
                    color: item.sceneId ? 'var(--fate-success)' : 'var(--fate-text-muted)',
                    borderColor: 'transparent',
                  }}
                >
                  {item.sceneId ? (
                    <span className="flex items-center gap-0.5"><Eye className="size-2.5" /> На сцене</span>
                  ) : (
                    <span className="flex items-center gap-0.5"><EyeOff className="size-2.5" /> Скрыто</span>
                  )}
                </Badge>
              )}
            </div>
            {item.description && (
              <p className="text-[10px] truncate mt-0.5" style={{ color: 'var(--fate-text-muted)' }}>
                {item.description}
              </p>
            )}
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            {/* Toggle scene visibility — GM only */}
            {isGM && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7 rounded-lg hover:scale-110 active:scale-90 transition-transform"
                      onClick={() => handleToggleScene(item)}
                      style={{
                        color: item.sceneId ? 'var(--fate-success)' : 'var(--fate-text-muted)',
                      }}
                      aria-label={item.sceneId ? 'Скрыть от игроков' : 'Показать на сцене'}
                    >
                      <ArrowLeftRight className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="text-xs">
                    {item.sceneId ? 'Скрыть от игроков' : 'Переместить на сцену'}
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            {/* Edit — GM only */}
            {isGM && (
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-lg hover:scale-110 active:scale-90 transition-transform"
                onClick={() => handleStartEdit(item)}
                style={{ color: 'var(--fate-text-muted)' }}
                aria-label="Редактировать"
                title="Редактировать"
              >
                <Pencil className="size-3" />
              </Button>
            )}

            {/* Delete — GM only */}
            {isGM && (
              deleteConfirm === item.id ? (
                <div className="flex items-center gap-0.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-6 px-1.5 rounded-md"
                    onClick={() => handleDelete(item.id)}
                    style={{ color: 'var(--fate-danger)' }}
                  >
                    Да
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-6 px-1.5 rounded-md"
                    onClick={() => setDeleteConfirm(null)}
                  >
                    Нет
                  </Button>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-lg opacity-40 hover:opacity-100 transition-all duration-200 hover:scale-110 active:scale-90"
                  onClick={() => setDeleteConfirm(item.id)}
                  style={{ color: 'var(--fate-danger)' }}
                  aria-label="Удалить"
                  title="Удалить"
                >
                  <Trash2 className="size-3" />
                </Button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <Package className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Инвентарь
            {!isGM && (
              <Badge
                className="text-[10px] h-5 px-2 font-semibold rounded-md ml-1"
                style={{
                  backgroundColor: 'rgba(39, 174, 96, 0.12)',
                  color: 'var(--fate-success)',
                  borderColor: 'transparent',
                }}
              >
                Режим игрока
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {isGM
              ? 'Управляйте предметами — перемещайте между сценой и скрытым хранилищем'
              : 'Предметы и заметки, доступные на текущей сцене'}
          </DialogDescription>
        </DialogHeader>

        {/* Create New Item — GM only */}
        {isGM && !showCreateForm && (
          <Button
            variant="outline"
            size="sm"
            className="w-full gap-1.5 text-xs rounded-lg border-dashed transition-all duration-200 hover:border-solid hover:shadow-sm"
            style={{ color: 'var(--fate-accent)', borderColor: 'var(--fate-accent)' }}
            onClick={() => setShowCreateForm(true)}
          >
            <Plus className="size-4" />
            Создать предмет / заметку
          </Button>
        )}

        {isGM && showCreateForm && (
          <div
            className="rounded-xl p-4 space-y-3 border-2"
            style={{
              backgroundColor: 'var(--fate-bg-warm)',
              borderColor: 'var(--fate-accent)',
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                Новый элемент
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="size-6 p-0 hover:scale-110 active:scale-90 transition-transform"
                onClick={resetCreateForm}
                aria-label="Закрыть форму"
                title="Закрыть"
              >
                ✕
              </Button>
            </div>

            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="flex-1">
                  <Label className="text-xs">Название</Label>
                  <Input
                    placeholder="Название..."
                    value={newItemName}
                    onChange={(e) => setNewItemName(e.target.value)}
                    className="h-8 text-sm rounded-lg"
                    autoFocus
                  />
                </div>
                <div className="w-28">
                  <Label className="text-xs">Тип</Label>
                  <Select value={newItemType} onValueChange={(v) => setNewItemType(v as 'item' | 'note')}>
                    <SelectTrigger className="h-8 text-sm rounded-lg">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="item">Предмет</SelectItem>
                      <SelectItem value="note">Заметка</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label className="text-xs">Описание</Label>
                <Input
                  placeholder="Краткое описание..."
                  value={newItemDesc}
                  onChange={(e) => setNewItemDesc(e.target.value)}
                  className="h-8 text-sm rounded-lg"
                />
              </div>

              {newItemType === 'note' && (
                <div>
                  <Label className="text-xs">Текст заметки</Label>
                  <Textarea
                    placeholder="Подробный текст заметки..."
                    value={newItemText}
                    onChange={(e) => setNewItemText(e.target.value)}
                    className="text-sm min-h-20 rounded-lg"
                  />
                </div>
              )}

              {/* On scene toggle */}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant={newItemOnScene ? 'default' : 'outline'}
                  size="sm"
                  className="text-xs gap-1.5 rounded-lg"
                  style={newItemOnScene ? { backgroundColor: 'var(--fate-success)' } : {}}
                  onClick={() => setNewItemOnScene(true)}
                >
                  <Eye className="size-3" />
                  На сцене
                </Button>
                <Button
                  type="button"
                  variant={!newItemOnScene ? 'default' : 'outline'}
                  size="sm"
                  className="text-xs gap-1.5 rounded-lg"
                  style={!newItemOnScene ? { backgroundColor: 'var(--fate-text-muted)' } : {}}
                  onClick={() => setNewItemOnScene(false)}
                >
                  <EyeOff className="size-3" />
                  Скрыто (только МГ)
                </Button>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                className="text-xs rounded-lg"
                onClick={resetCreateForm}
              >
                Отмена
              </Button>
              <Button
                size="sm"
                className="text-xs gap-1 fate-btn-accent fate-button-shine rounded-lg"
                disabled={!newItemName.trim() || isCreating}
                onClick={handleCreate}
              >
                <Plus className="size-3" />
                {isCreating ? 'Создание...' : 'Создать'}
              </Button>
            </div>
          </div>
        )}

        <Separator />

        {/* Items List */}
        <ScrollArea className="flex-1 max-h-96">
          <div className="space-y-1.5 pr-1">
            {visibleItems.length === 0 ? (
              <div className="text-center py-8 animate-fade-in fate-empty-state">
                <div
                  className="fate-empty-icon size-14 mx-auto flex items-center justify-center mb-2"
                  style={{ backgroundColor: 'rgba(127, 140, 141, 0.08)' }}
                >
                  <Package className="size-6" style={{ color: 'var(--fate-text-muted)', opacity: 0.3 }} />
                </div>
                <p className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Нет элементов
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--fate-text-muted)', opacity: 0.6 }}>
                  {isGM ? 'Инвентарь пуст' : 'На этой сцене нет доступных предметов'}
                </p>
              </div>
            ) : isGM ? (
              /* GM: grouped view — "On Scene" section, then "GM Only" section */
              <div className="space-y-3">
                {/* On Scene */}
                {onSceneItems.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <Eye className="size-3" style={{ color: 'var(--fate-success)' }} />
                      <span
                        className="text-[11px] font-semibold uppercase tracking-wide"
                        style={{ color: 'var(--fate-success)' }}
                      >
                        На сцене ({onSceneItems.length})
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {onSceneItems.map(renderItem)}
                    </div>
                  </div>
                )}

                {/* GM Only */}
                {gmOnlyItems.length > 0 && (
                  <div>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <EyeOff className="size-3" style={{ color: 'var(--fate-text-muted)' }} />
                      <span
                        className="text-[11px] font-semibold uppercase tracking-wide"
                        style={{ color: 'var(--fate-text-muted)' }}
                      >
                        Скрыто — только МГ ({gmOnlyItems.length})
                      </span>
                    </div>
                    <div className="space-y-1.5">
                      {gmOnlyItems.map(renderItem)}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Player: flat list of scene items */
              <div className="space-y-1.5">
                {visibleItems.map(renderItem)}
              </div>
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
