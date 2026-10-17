'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  Search,
  Users,
  Map,
  Dice5,
  BookOpen,
  Sparkles,
  FileText,
  Settings,
  Library,
  ShoppingCart,
  Dices,
  Zap,
  type LucideIcon,
} from 'lucide-react';

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command';
import { useFateStore } from '@/lib/store';

interface CommandAction {
  id: string;
  label: string;
  icon: LucideIcon;
  shortcut?: string;
  action: () => void;
  keywords?: string;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Callbacks to open various dialogs / trigger actions
  onQuickRoll: () => void;
  onCharacterRoll: () => void;
  onMassRoll: () => void;
  onLibrary: () => void;
  onScenes: () => void;
  onInventory: () => void;
  onNotes: () => void;
  onSettings: () => void;
  onNpcGenerator: () => void;
  onRandomTables: () => void;
  onDashboard: () => void;
  onMagic: () => void;
  onOpenCharacterSheet: (charId: string) => void;
  onSwitchScene: (sceneId: string) => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onQuickRoll,
  onCharacterRoll,
  onMassRoll,
  onLibrary,
  onScenes,
  onInventory,
  onNotes,
  onSettings,
  onNpcGenerator,
  onRandomTables,
  onDashboard,
  onMagic,
  onOpenCharacterSheet,
  onSwitchScene,
}: CommandPaletteProps) {
  const { characters, scenes, currentAdventureId, setCurrentScene } = useFateStore();

  // Build the list of quick actions
  const actions: CommandAction[] = useMemo(() => {
    if (!currentAdventureId) return [];
    return [
      { id: 'quick-roll', label: 'Быстрый бросок кубиков', icon: Dice5, shortcut: 'Q', action: onQuickRoll, keywords: 'dice roll бросок кубики fudge' },
      { id: 'char-roll', label: 'Бросок навыка персонажа', icon: Dices, action: onCharacterRoll, keywords: 'character skill skill roll бросок навык' },
      { id: 'mass-roll', label: 'Массовый бросок', icon: Dices, shortcut: 'M', action: onMassRoll, keywords: 'mass roll массовый бросок' },
      { id: 'magic', label: 'Магический бросок', icon: Zap, action: onMagic, keywords: 'magic магия spell заклинание' },
      { id: 'npc-gen', label: 'Генератор NPC', icon: Sparkles, shortcut: 'G', action: onNpcGenerator, keywords: 'npc generator генератор создать' },
      { id: 'library', label: 'Библиотека персонажей', icon: Library, shortcut: 'L', action: onLibrary, keywords: 'characters library персонажи библиотека' },
      { id: 'scenes', label: 'Управление сценами', icon: Map, shortcut: 'S', action: onScenes, keywords: 'scenes map карта сцены' },
      { id: 'inventory', label: 'Инвентарь', icon: ShoppingCart, shortcut: 'I', action: onInventory, keywords: 'items inventory предметы' },
      { id: 'notes', label: 'Заметки мастера', icon: FileText, shortcut: 'N', action: onNotes, keywords: 'notes заметки journal журнал' },
      { id: 'tables', label: 'Случайные таблицы', icon: BookOpen, shortcut: 'R', action: onRandomTables, keywords: 'random tables таблицы random' },
      { id: 'dashboard', label: 'Обзор приключения', icon: Search, shortcut: 'D', action: onDashboard, keywords: 'dashboard stats обзор статистика' },
      { id: 'settings', label: 'Настройки', icon: Settings, shortcut: ',', action: onSettings, keywords: 'settings настройки config' },
    ];
  }, [currentAdventureId, onQuickRoll, onCharacterRoll, onMassRoll, onMagic, onNpcGenerator, onLibrary, onScenes, onInventory, onNotes, onRandomTables, onDashboard, onSettings]);

  const handleRun = (action: CommandAction) => {
    action.action();
    onOpenChange(false);
  };

  const handleOpenCharacter = (charId: string) => {
    onOpenCharacterSheet(charId);
    onOpenChange(false);
  };

  const handleSwitchScene = async (sceneId: string) => {
    await setCurrentScene(sceneId);
    onSwitchScene(sceneId);
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="Найдите действие, персонажа или сцену..." />
      <CommandList>
        <CommandEmpty>Ничего не найдено.</CommandEmpty>

        {actions.length > 0 && (
          <CommandGroup heading="Быстрые действия" className="fate-command-enter">
            {actions.map((a) => (
              <CommandItem
                key={a.id}
                value={`${a.label} ${a.keywords ?? ''}`}
                onSelect={() => handleRun(a)}
                className="fate-command-item"
              >
                <a.icon className="size-4 mr-2" style={{ color: 'var(--fate-accent)' }} />
                <span>{a.label}</span>
                {a.shortcut && (
                  <CommandShortcut>
                    <kbd className="px-1.5 py-0.5 text-[10px] rounded border" style={{ borderColor: 'var(--fate-border)', color: 'var(--fate-text-muted)' }}>
                      {a.shortcut}
                    </kbd>
                  </CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {characters.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Персонажи" className="fate-command-enter">
              {characters.slice(0, 12).map((c) => (
                <CommandItem
                  key={c.id}
                  value={`${c.name} ${c.type} ${c.concept} ${c.aspects?.join(' ') ?? ''}`}
                  onSelect={() => handleOpenCharacter(c.id)}
                  className="fate-command-item"
                >
                  <div className="size-6 rounded-full flex items-center justify-center text-xs font-bold mr-2 shrink-0"
                       style={{ backgroundColor: c.avatarColor || 'var(--fate-accent)', color: 'white' }}>
                    {c.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm">{c.name}</span>
                    {c.concept && (
                      <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                        {c.concept.slice(0, 50)}
                      </span>
                    )}
                  </div>
                  <CommandShortcut>
                    <span className="text-[10px] px-1.5 py-0.5 rounded" style={{
                      backgroundColor: c.type === 'player' ? 'rgba(39, 174, 96, 0.15)' : 'rgba(127, 140, 141, 0.15)',
                      color: c.type === 'player' ? 'var(--fate-success)' : 'var(--fate-text-muted)',
                    }}>
                      {c.type === 'player' ? 'Игрок' : 'NPC'}
                    </span>
                  </CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}

        {scenes.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Сцены" className="fate-command-enter">
              {scenes.map((s) => (
                <CommandItem
                  key={s.id}
                  value={`сцена ${s.name} этаж ${s.floors.length}`}
                  onSelect={() => handleSwitchScene(s.id)}
                  className="fate-command-item"
                >
                  <Map className="size-4 mr-2" style={{ color: 'var(--fate-accent)' }} />
                  <span className="text-sm">{s.name}</span>
                  <CommandShortcut>
                    <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                      {s.floors.length} эт.
                    </span>
                  </CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}
