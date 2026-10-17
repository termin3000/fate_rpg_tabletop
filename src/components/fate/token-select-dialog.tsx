'use client';

import { Check, MapPin, Plus, UserPlus } from 'lucide-react';

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
import { Separator } from '@/components/ui/separator';
import { useFateStore } from '@/lib/store';

interface TokenSelectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** If true, also create a map token when adding character to scene */
  alsoAddToMap?: boolean;
}

export function TokenSelectDialog({ open, onOpenChange, alsoAddToMap = false }: TokenSelectDialogProps) {
  const { characters, scenes, currentSceneId, addCharacterToScene, addTokenToMap } = useFateStore();

  const currentScene = scenes.find((s) => s.id === currentSceneId) ?? null;
  const presentIds: string[] = currentScene?.presentCharacters ?? [];
  const availableCharacters = characters.filter((c) => !presentIds.includes(c.id));

  const handleAdd = async (charId: string) => {
    await addCharacterToScene(charId);
    if (alsoAddToMap) {
      await addTokenToMap(charId);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(39, 174, 96, 0.12)' }}
            >
              <UserPlus className="size-4" style={{ color: 'var(--fate-success)' }} />
            </div>
            {alsoAddToMap ? 'Добавить на карту' : 'Добавить на сцену'}
          </DialogTitle>
          <DialogDescription>
            {alsoAddToMap
              ? 'Персонаж будет добавлен на сцену и на карту'
              : 'Выберите персонажа для добавления на текущую сцену'}
          </DialogDescription>
        </DialogHeader>

        {availableCharacters.length === 0 ? (
          <div className="py-10 text-center animate-fade-in">
            <div
              className="size-14 mx-auto rounded-xl flex items-center justify-center mb-2"
              style={{ backgroundColor: 'rgba(39, 174, 96, 0.08)' }}
            >
              <Check className="size-6" style={{ color: 'var(--fate-success)', opacity: 0.4 }} />
            </div>
            <p className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
              Все персонажи уже на сцене
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--fate-text-muted)', opacity: 0.6 }}>
              Создайте нового персонажа в Библиотеке
            </p>
          </div>
        ) : (
          <ScrollArea className="max-h-[50vh]">
            <div className="space-y-1.5 pr-2">
              {availableCharacters.map((char, index) => (
                <div
                  key={char.id}
                  className="fate-card flex items-center gap-2.5 p-2.5 fate-char-enter group"
                  style={{
                    borderLeft: `3px solid ${char.type === 'player' ? 'var(--fate-accent)' : 'var(--fate-success)'}`,
                    animationDelay: `${index * 50}ms`,
                  }}
                >
                  <div
                    className="flex items-center justify-center size-9 rounded-full shrink-0 text-white text-xs font-bold shadow-sm transition-transform duration-200 group-hover:scale-110"
                    style={{
                      background: char.type === 'player'
                        ? 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-dark))'
                        : 'linear-gradient(135deg, var(--fate-success), var(--fate-success-dark))',
                    }}
                  >
                    {char.name.charAt(0).toUpperCase()}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                        {char.name}
                      </span>
                      <Badge
                        className="text-[10px] h-5 px-2 shrink-0 font-semibold rounded-md"
                        style={{
                          backgroundColor: char.type === 'player' ? 'var(--fate-accent)' : 'var(--fate-success)',
                          color: 'white',
                          border: 'none',
                        }}
                      >
                        {char.type === 'player' ? 'Игрок' : 'NPC'}
                      </Badge>
                    </div>
                    <p className="text-[10px] truncate mt-0.5" style={{ color: 'var(--fate-text-muted)' }}>
                      {char.concept || 'Нет концепта'}
                    </p>
                  </div>

                  <Button
                    size="sm"
                    variant="ghost"
                    className="size-8 shrink-0 rounded-lg hover:scale-110 active:scale-90 transition-all duration-150"
                    style={{ color: 'var(--fate-success)' }}
                    onClick={() => handleAdd(char.id)}
                    title={alsoAddToMap ? 'Добавить на карту' : 'Добавить на сцену'}
                  >
                    {alsoAddToMap ? <MapPin className="size-4" /> : <Plus className="size-4" />}
                  </Button>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}

        <Separator />
        <div className="flex justify-between items-center">
          <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
            На сцене: <span className="font-semibold">{presentIds.length}</span> · Вне сцены: <span className="font-semibold">{availableCharacters.length}</span>
          </p>
          <Button variant="outline" size="sm" className="rounded-lg" onClick={() => onOpenChange(false)}>
            Готово
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
