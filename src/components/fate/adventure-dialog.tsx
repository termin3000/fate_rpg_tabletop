'use client';

import { useRef, useState } from 'react';
import { CheckCircle, Download, FolderOpen, Map, Plus, Trash2, Upload, Users } from 'lucide-react';
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
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFateStore } from '@/lib/store';

interface AdventureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AdventureDialog({ open, onOpenChange }: AdventureDialogProps) {
  const {
    adventures,
    currentAdventureId,
    createAdventure,
    deleteAdventure,
    switchAdventure,
    exportAdventure,
    importAdventure,
  } = useFateStore();

  const [newName, setNewName] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setIsCreating(true);
    try {
      await createAdventure(newName.trim());
      setNewName('');
    } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    await deleteAdventure(id);
    setDeleteConfirm(null);
  };

  const handleSelect = async (id: string) => {
    if (id !== currentAdventureId) {
      await switchAdventure(id);
    }
    onOpenChange(false);
  };

  const handleExport = async () => {
    if (!currentAdventureId) {
      toast.error('Сначала выберите приключение для экспорта');
      return;
    }
    setIsExporting(true);
    try {
      await exportAdventure();
      toast.success('Приключение экспортировано');
    } catch (error) {
      console.error('Export error:', error);
      toast.error('Не удалось экспортировать приключение');
    } finally {
      setIsExporting(false);
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset input so the same file can be re-selected later
    e.target.value = '';
    if (!file) return;

    setIsImporting(true);
    try {
      await importAdventure(file);
      toast.success(`Приключение импортировано из файла «${file.name}»`);
    } catch (error) {
      console.error('Import error:', error);
      toast.error('Не удалось импортировать приключение. Проверьте формат файла.');
    } finally {
      setIsImporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <FolderOpen className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Управление приключениями
          </DialogTitle>
          <DialogDescription>
            Создайте, выберите или удалите приключение
          </DialogDescription>
        </DialogHeader>

        {/* Create New */}
        <div className="flex gap-2">
          <Input
            placeholder="Название нового приключения..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            className="text-sm rounded-lg"
          />
          <Button
            onClick={handleCreate}
            disabled={!newName.trim() || isCreating}
            size="sm"
            className="fate-btn-accent fate-button-shine shrink-0 rounded-lg"
          >
            <Plus className="size-4" />
          </Button>
        </div>

        {/* Export / Import row */}
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 gap-1.5 rounded-lg text-xs"
            onClick={handleExport}
            disabled={isExporting || isImporting || !currentAdventureId}
            title={
              !currentAdventureId
                ? 'Сначала выберите приключение'
                : 'Скачать текущее приключение в JSON-файл'
            }
          >
            <Download className="size-3.5" />
            {isExporting ? 'Экспорт...' : 'Экспорт'}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="flex-1 gap-1.5 rounded-lg text-xs"
            onClick={handleImportClick}
            disabled={isExporting || isImporting}
            title="Загрузить приключение из JSON-файла"
          >
            <Upload className="size-3.5" />
            {isImporting ? 'Импорт...' : 'Импорт'}
          </Button>
          {/* Hidden file input for import */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Adventure List */}
        <ScrollArea className="max-h-72">
          <div className="space-y-1.5 pr-1">
            {adventures.length === 0 ? (
              <div className="text-center py-8 animate-fade-in">
                <div
                  className="size-14 mx-auto rounded-xl flex items-center justify-center mb-2"
                  style={{ backgroundColor: 'rgba(127, 140, 141, 0.08)' }}
                >
                  <FolderOpen className="size-6" style={{ color: 'var(--fate-text-muted)', opacity: 0.3 }} />
                </div>
                <p className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Нет приключений
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--fate-text-muted)', opacity: 0.6 }}>
                  Создайте первое приключение, чтобы начать
                </p>
              </div>
            ) : (
              adventures.map((adventure) => {
                const isActive = adventure.id === currentAdventureId;
                const charCount = adventure.characters?.length ?? 0;
                const sceneCount = adventure.scenes?.length ?? 0;

                return (
                  <div
                    key={adventure.id}
                    className={`fate-list-item flex items-center gap-3 p-3 cursor-pointer ${
                      isActive ? 'border-l-[3px]' : ''
                    }`}
                    style={{
                      backgroundColor: isActive ? 'rgba(230, 126, 34, 0.06)' : 'transparent',
                      borderLeftColor: isActive ? 'var(--fate-accent)' : 'transparent',
                    }}
                    onClick={() => handleSelect(adventure.id)}
                  >
                    {/* Active indicator */}
                    <div
                      className="size-9 rounded-lg flex items-center justify-center shrink-0 transition-all duration-200"
                      style={{
                        background: isActive
                          ? 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-dark))'
                          : 'rgba(0,0,0,0.04)',
                        boxShadow: isActive ? '0 2px 8px var(--fate-accent-glow)' : 'none',
                      }}
                    >
                      {isActive ? (
                        <CheckCircle className="size-4 text-white" />
                      ) : (
                        <FolderOpen className="size-4" style={{ color: 'var(--fate-text-muted)' }} />
                      )}
                    </div>

                    {/* Adventure info */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                          {adventure.name}
                        </span>
                        {isActive && (
                          <Badge
                            className="text-[10px] h-5 px-2 shrink-0 font-semibold rounded-md shadow-sm"
                            style={{ backgroundColor: 'var(--fate-accent)', color: 'white', border: 'none' }}
                          >
                            Активно
                          </Badge>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-[10px] flex items-center gap-1" style={{ color: 'var(--fate-text-muted)' }}>
                          <Users className="size-2.5" />
                          {charCount}
                        </span>
                        <span className="text-[10px] flex items-center gap-1" style={{ color: 'var(--fate-text-muted)' }}>
                          <Map className="size-2.5" />
                          {sceneCount}
                        </span>
                      </div>
                    </div>

                    {/* Delete button */}
                    {deleteConfirm === adventure.id ? (
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-6 px-2 rounded-md"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(adventure.id);
                          }}
                          style={{ color: 'var(--fate-danger)' }}
                        >
                          Удалить
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-xs h-6 px-2 rounded-md"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteConfirm(null);
                          }}
                        >
                          Отмена
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 rounded-lg opacity-30 hover:opacity-100 transition-all duration-200 hover:scale-110 active:scale-90"
                        style={{ color: 'var(--fate-danger)' }}
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfirm(adventure.id);
                        }}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
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
