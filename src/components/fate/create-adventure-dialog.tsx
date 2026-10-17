'use client';

import { useEffect, useRef, useState } from 'react';
import { FolderPlus, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

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
import { useFateStore } from '@/lib/store';

interface CreateAdventureDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Compact dialog for creating a new adventure.
 * After creation, automatically switches to the new adventure so the user
 * can immediately start working in it (or use «Перенести...» to copy data).
 */
export function CreateAdventureDialog({ open, onOpenChange }: CreateAdventureDialogProps) {
  const { createAdventure, switchAdventure } = useFateStore();
  const [name, setName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input and clear state whenever the dialog opens
  useEffect(() => {
    if (open) {
      setName('');
      // Defer focus so the input is mounted before we focus it
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setIsCreating(true);
    try {
      await createAdventure(trimmed);
      // Find the freshly created adventure by name — createAdventure adds it
      // to the store, so we can look it up immediately after.
      const created = useFateStore
        .getState()
        .adventures.find((a) => a.name === trimmed);
      if (created) {
        await switchAdventure(created.id);
      }
      toast.success(`Приключение «${trimmed}» создано`);
      onOpenChange(false);
    } catch (error) {
      console.error('Create adventure error:', error);
      toast.error('Не удалось создать приключение');
    } finally {
      setIsCreating(false);
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
              <FolderPlus className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Новое приключение
          </DialogTitle>
          <DialogDescription>
            Введите название. После создания приключение станет активным.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Input
            ref={inputRef}
            placeholder="Например: Тени Упадка..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !isCreating) {
                e.preventDefault();
                handleCreate();
              }
            }}
            className="text-sm rounded-lg"
            maxLength={80}
          />
          <p className="text-[10px] text-muted-foreground">
            Можно сразу перенести элементы из другого приключения через «Перенести...».
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg"
            onClick={() => onOpenChange(false)}
            disabled={isCreating}
          >
            Отмена
          </Button>
          <Button
            size="sm"
            className="fate-btn-accent fate-button-shine rounded-lg gap-1.5"
            onClick={handleCreate}
            disabled={!name.trim() || isCreating}
          >
            {isCreating ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Создание...
              </>
            ) : (
              <>
                <FolderPlus className="size-3.5" />
                Создать
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
