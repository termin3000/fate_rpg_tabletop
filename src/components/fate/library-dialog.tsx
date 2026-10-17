'use client';

import { useRef, useState } from 'react';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  FolderIcon,
  FolderOpen,
  FolderPlus,
  MapPin,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  UserPlus,
  Users,
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
  DropdownMenu,
  DropdownMenuContent as DropdownContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
import { useFateStore } from '@/lib/store';
import type { Character, Folder } from '@/lib/types';
import { CrowdEditorDialog } from '@/components/fate/crowd-editor-dialog';
import { DEFAULT_SETTINGS } from '@/lib/types';

interface LibraryDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenCharacterSheet: (charId: string) => void;
}

type CharacterTypeFilter = 'all' | 'player' | 'npc';

export function LibraryDialog({ open, onOpenChange, onOpenCharacterSheet }: LibraryDialogProps) {
  const {
    characters,
    folders,
    currentAdventureId,
    scenes,
    currentSceneId,
    createCharacter,
    deleteCharacter,
    updateCharacter,
    createFolder,
    updateFolder,
    deleteFolder,
    addCharacterToScene,
    settings,
  } = useFateStore();

  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<'player' | 'npc'>('player');
  const [newConcept, setNewConcept] = useState('');
  const [newProblem, setNewProblem] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  const [typeFilter, setTypeFilter] = useState<CharacterTypeFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [crowdEditorOpen, setCrowdEditorOpen] = useState(false);

  // Folder UI state
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  const [showNewFolderForm, setShowNewFolderForm] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [movingCharId, setMovingCharId] = useState<string | null>(null);

  const importFileRef = useRef<HTMLInputElement>(null);

  const resetCreateForm = () => {
    setNewName('');
    setNewType('player');
    setNewConcept('');
    setNewProblem('');
    setShowCreateForm(false);
  };

  const handleCreate = async () => {
    if (!newName.trim() || !currentAdventureId) return;
    setIsCreating(true);
    try {
      const baseSkills = settings.baseSkills.length > 0
        ? settings.baseSkills
        : DEFAULT_SETTINGS.baseSkills;

      await createCharacter({
        name: newName.trim(),
        type: newType,
        concept: newConcept.trim(),
        problem: newProblem.trim(),
        adventureId: currentAdventureId,
        skills: baseSkills.map((name) => ({ name, value: 0 })),
      });
      resetCreateForm();
    } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async (id: string) => {
    await deleteCharacter(id);
    setDeleteConfirm(null);
  };

  const handleExportCharacter = (char: Character) => {
    const exportData = {
      format: 'fate-rpg-character-v1',
      version: 1,
      exportedAt: new Date().toISOString(),
      character: {
        name: char.name,
        type: char.type,
        concept: char.concept,
        problem: char.problem,
        aspects: char.aspects,
        skills: char.skills,
        stunts: char.stunts,
        stressTracks: char.stressTracks,
        consequences: char.consequences,
        fatePoints: char.fatePoints,
        refresh: char.refresh,
      },
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${char.name}.fate-char.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast.success(`Персонаж «${char.name}» экспортирован`);
  };

  const handleImportClick = () => {
    importFileRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setIsImporting(true);
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (data.format !== 'fate-rpg-character-v1') {
        toast.error('Неверный формат файла. Ожидается fate-rpg-character-v1.');
        return;
      }

      if (!data.character || !data.character.name) {
        toast.error('Файл не содержит данных персонажа.');
        return;
      }

      if (!currentAdventureId) {
        toast.error('Сначала выберите приключение.');
        return;
      }

      const charData = data.character;
      await createCharacter({
        name: charData.name,
        type: charData.type || 'npc',
        concept: charData.concept || '',
        problem: charData.problem || '',
        aspects: charData.aspects || [],
        skills: charData.skills || [],
        stunts: charData.stunts || [],
        stressTracks: charData.stressTracks || [],
        consequences: charData.consequences || [],
        fatePoints: charData.fatePoints ?? 3,
        refresh: charData.refresh ?? 3,
        adventureId: currentAdventureId,
      });

      toast.success(`Персонаж «${charData.name}» импортирован`);
    } catch (error) {
      console.error('Import character error:', error);
      toast.error('Не удалось импортировать персонажа. Проверьте формат файла.');
    } finally {
      setIsImporting(false);
    }
  };

  const handleViewSheet = (charId: string) => {
    // Note: we intentionally do NOT close the library here.
    // The character sheet opens on top of the library, and when the user
    // closes the sheet they should land back in the library — not on the
    // empty map. Both dialogs coexist via Radix's natural stacking.
    onOpenCharacterSheet(charId);
  };

  const handleAddToScene = async (char: Character) => {
    try {
      await addCharacterToScene(char.id);
      toast.success(`Персонаж «${char.name}» добавлен на сцену`);
    } catch (error) {
      console.error('Add to scene error:', error);
      toast.error('Не удалось добавить персонажа на сцену');
    }
  };

  const currentScene = scenes.find((s) => s.id === currentSceneId);

  // Folder handlers
  const handleCreateFolder = async () => {
    if (!newFolderName.trim() || !currentAdventureId) return;
    await createFolder({ name: newFolderName.trim(), adventureId: currentAdventureId });
    setNewFolderName('');
    setShowNewFolderForm(false);
  };

  const handleRenameFolder = async (folderId: string) => {
    if (!renameValue.trim()) {
      setRenamingFolderId(null);
      return;
    }
    await updateFolder(folderId, { name: renameValue.trim() });
    setRenamingFolderId(null);
    setRenameValue('');
  };

  const handleDeleteFolder = async (folderId: string) => {
    await deleteFolder(folderId);
  };

  const handleMoveCharToFolder = async (charId: string, folderId: string | null) => {
    await updateCharacter(charId, { folderId });
    setMovingCharId(null);
  };

  const toggleFolder = (folderId: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) {
        next.delete(folderId);
      } else {
        next.add(folderId);
      }
      return next;
    });
  };

  const filteredCharacters = characters.filter((c) => {
    // Hide temporary crowd characters from library
    if (c.temporary && c.isHorde) return false;
    if (typeFilter !== 'all' && c.type !== typeFilter) return false;
    if (searchQuery && !c.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  // Group characters by folder
  const charsByFolder: Record<string, Character[]> = {};
  const unfiledChars: Character[] = [];

  for (const char of filteredCharacters) {
    if (char.folderId && folders.some((f) => f.id === char.folderId)) {
      if (!charsByFolder[char.folderId]) charsByFolder[char.folderId] = [];
      charsByFolder[char.folderId].push(char);
    } else {
      unfiledChars.push(char);
    }
  }

  // Visible characters only — exclude temporary crowd characters from stats too
  const visibleChars = characters.filter((c) => !(c.temporary && c.isHorde));
  const playerCount = visibleChars.filter((c) => c.type === 'player').length;
  const npcCount = visibleChars.filter((c) => c.type === 'npc').length;

  // Character row component (reused in folders and unfiled section)
  const renderCharacterRow = (char: Character) => (
    <div
      key={char.id}
      className="fate-card flex items-center gap-2 p-2 group relative"
      style={{
        borderLeft: `3px solid ${char.type === 'player' ? 'var(--fate-accent)' : 'var(--fate-success)'}`,
        opacity: char.hiddenFromPlayers ? 0.65 : 1,
      }}
    >
      {/* Character icon */}
      {char.avatar ? (
        <img
          src={char.avatar}
          alt={char.name}
          className="size-8 rounded-full object-cover shadow-sm shrink-0"
          draggable={false}
        />
      ) : (
        <div
          className="flex items-center justify-center size-8 rounded-full shrink-0 text-white text-[10px] font-bold shadow-sm"
          style={{
            background: char.avatarColor
              ? char.avatarColor
              : char.type === 'player'
                ? 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-dark))'
                : 'linear-gradient(135deg, var(--fate-success), var(--fate-success-dark))',
          }}
        >
          {char.name.charAt(0).toUpperCase()}
        </div>
      )}

      {/* Character info */}
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-xs font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
            {char.name}
          </span>
          {currentScene?.presentCharacters.includes(char.id) && (
            <Badge
              className="text-[7px] h-3.5 px-1 shrink-0 font-bold rounded"
              style={{ backgroundColor: 'rgba(39, 174, 96, 0.15)', color: 'var(--fate-success)', border: 'none' }}
            >
              На сцене
            </Badge>
          )}
          {char.hiddenFromPlayers && (
            <span
              className="text-[7px] font-bold px-1 py-0 rounded shrink-0"
              style={{ backgroundColor: 'rgba(127, 140, 141, 0.15)', color: 'var(--fate-text-muted)' }}
            >
              СКРЫТ
            </span>
          )}
        </div>
        <p className="text-[10px] truncate mt-0.5" style={{ color: 'var(--fate-text-muted)' }}>
          {char.concept || 'Нет концепта'}
        </p>
      </div>

      {/* Compact actions row */}
      <div className="flex items-center gap-0.5 shrink-0">
        {/* Add to scene / already on scene */}
        {currentScene?.presentCharacters.includes(char.id) ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded-md"
            style={{ color: 'var(--fate-success)' }}
            disabled
            title="Персонаж уже на сцене"
          >
            <MapPin className="size-3" />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ color: 'var(--fate-accent)' }}
            onClick={() => handleAddToScene(char)}
            title="Добавить на сцену"
          >
            <MapPin className="size-3" />
          </Button>
        )}

        {/* View sheet */}
        <Button
          variant="ghost"
          size="icon"
          className="size-6 rounded-md opacity-60 group-hover:opacity-100 transition-opacity"
          style={{ color: 'var(--fate-accent)' }}
          onClick={() => handleViewSheet(char.id)}
          title="Лист персонажа"
        >
          <Eye className="size-3" />
        </Button>

        {/* More actions dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
              style={{ color: 'var(--fate-text-muted)' }}
            >
              <MoreHorizontal className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownContent align="end" className="min-w-[160px]">
            <DropdownMenuItem onClick={() => updateCharacter(char.id, { hiddenFromPlayers: !char.hiddenFromPlayers })}>
              {char.hiddenFromPlayers ? <Eye className="size-3 mr-2" /> : <EyeOff className="size-3 mr-2" />}
              {char.hiddenFromPlayers ? 'Показать игрокам' : 'Скрыть от игроков'}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleExportCharacter(char)}>
              <Download className="size-3 mr-2" />
              Экспорт
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setMovingCharId(char.id)}>
              <FolderIcon className="size-3 mr-2" />
              Переместить в папку
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-red-600 focus:text-red-600"
              onClick={() => setDeleteConfirm(char.id)}
            >
              <Trash2 className="size-3 mr-2" />
              Удалить
            </DropdownMenuItem>
          </DropdownContent>
        </DropdownMenu>

        {/* Delete confirmation overlay */}
        {deleteConfirm === char.id && (
          <div
            className="absolute inset-0 flex items-center justify-center gap-2 rounded-lg z-20"
            style={{ backgroundColor: 'rgba(255,255,255,0.92)' }}
          >
            <span className="text-xs font-medium" style={{ color: 'var(--fate-text)' }}>Удалить?</span>
            <Button
              size="sm"
              className="text-[10px] h-6 px-2 rounded-md"
              style={{ backgroundColor: 'var(--fate-danger)', color: 'white' }}
              onClick={() => handleDelete(char.id)}
            >
              Да
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-[10px] h-6 px-2 rounded-md"
              onClick={() => setDeleteConfirm(null)}
            >
              Нет
            </Button>
          </div>
        )}
      </div>
    </div>
  );

  // Move-to-folder overlay (shown when user clicks "Переместить в папку" from dropdown)
  const renderMoveToFolderOverlay = () => {
    if (!movingCharId) return null;
    return (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center"
        style={{ backgroundColor: 'rgba(0,0,0,0.3)' }}
        onClick={() => setMovingCharId(null)}
      >
        <div
          className="p-4 rounded-xl shadow-lg space-y-3 min-w-[240px]"
          style={{ backgroundColor: 'var(--fate-bg-card)', border: '1px solid var(--fate-border)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>Переместить в папку</p>
          <Select
            onValueChange={(val) => handleMoveCharToFolder(movingCharId, val === '__none__' ? null : val)}
          >
            <SelectTrigger className="text-sm rounded-lg" autoFocus>
              <SelectValue placeholder="Выберите папку..." />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">Без папки</SelectItem>
              {folders.map((f) => (
                <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs w-full rounded-lg"
            onClick={() => setMovingCharId(null)}
          >
            Отмена
          </Button>
        </div>
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <BookOpen className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Библиотека
          </DialogTitle>
          <DialogDescription>
            Управление персонажами приключения
          </DialogDescription>
        </DialogHeader>

        {/* Stats Row */}
        <div className="flex gap-2">
          <div
            className="flex items-center gap-2 flex-1 px-3 py-2 rounded-lg"
            style={{ backgroundColor: 'rgba(230, 126, 34, 0.06)', border: '1px solid rgba(230, 126, 34, 0.12)' }}
          >
            <Users className="size-4" style={{ color: 'var(--fate-accent)' }} />
            <div>
              <p className="text-[10px] font-medium" style={{ color: 'var(--fate-text-muted)' }}>Игроки</p>
              <p className="text-lg font-bold leading-tight" style={{ color: 'var(--fate-accent)' }}>{playerCount}</p>
            </div>
          </div>
          <div
            className="flex items-center gap-2 flex-1 px-3 py-2 rounded-lg"
            style={{ backgroundColor: 'rgba(39, 174, 96, 0.06)', border: '1px solid rgba(39, 174, 96, 0.12)' }}
          >
            <Users className="size-4" style={{ color: 'var(--fate-success)' }} />
            <div>
              <p className="text-[10px] font-medium" style={{ color: 'var(--fate-text-muted)' }}>NPC</p>
              <p className="text-lg font-bold leading-tight" style={{ color: 'var(--fate-success)' }}>{npcCount}</p>
            </div>
          </div>
          <div
            className="flex items-center gap-2 flex-1 px-3 py-2 rounded-lg"
            style={{ backgroundColor: 'rgba(44, 62, 80, 0.04)', border: '1px solid rgba(44, 62, 80, 0.08)' }}
          >
            <BookOpen className="size-4" style={{ color: 'var(--fate-text-muted)' }} />
            <div>
              <p className="text-[10px] font-medium" style={{ color: 'var(--fate-text-muted)' }}>Всего</p>
              <p className="text-lg font-bold leading-tight" style={{ color: 'var(--fate-text)' }}>{visibleChars.length}</p>
            </div>
          </div>
        </div>

        {/* Search & Filter */}
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5" style={{ color: 'var(--fate-text-muted)' }} />
            <Input
              placeholder="Поиск по имени..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="text-sm pl-8 rounded-lg"
            />
          </div>
          <Select
            value={typeFilter}
            onValueChange={(v) => setTypeFilter(v as CharacterTypeFilter)}
          >
            <SelectTrigger className="w-28 text-sm rounded-lg">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все</SelectItem>
              <SelectItem value="player">Игроки</SelectItem>
              <SelectItem value="npc">NPC</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Action Buttons */}
        {!showCreateForm && !showNewFolderForm && (
          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 gap-1.5 text-xs rounded-lg border-dashed transition-all duration-200 hover:border-solid hover:shadow-sm"
              style={{ color: 'var(--fate-accent)', borderColor: 'var(--fate-accent)' }}
              onClick={() => setShowCreateForm(true)}
            >
              <UserPlus className="size-4" />
              Создать персонажа
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs rounded-lg transition-all duration-200 hover:shadow-sm"
              style={{ color: '#c0392b', borderColor: '#c0392b' }}
              onClick={() => setCrowdEditorOpen(true)}
            >
              <Users className="size-3.5" />
              Толпы
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs rounded-lg transition-all duration-200 hover:shadow-sm"
              style={{ color: '#8e44ad', borderColor: '#8e44ad' }}
              onClick={() => setShowNewFolderForm(true)}
            >
              <FolderPlus className="size-3.5" />
              Папка
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs rounded-lg transition-all duration-200 hover:scale-105 active:scale-95"
              style={{ color: 'var(--fate-success)', borderColor: 'var(--fate-success)' }}
              onClick={handleImportClick}
              disabled={isImporting}
            >
              <Upload className="size-3.5" />
              {isImporting ? 'Импорт...' : 'Импорт'}
            </Button>
          </div>
        )}

        {/* New Folder Form */}
        {showNewFolderForm && (
          <div
            className="rounded-xl p-3 space-y-2 border-2"
            style={{
              backgroundColor: 'var(--fate-bg-warm)',
              borderColor: '#8e44ad',
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold flex items-center gap-1.5" style={{ color: 'var(--fate-text)' }}>
                <FolderPlus className="size-4" style={{ color: '#8e44ad' }} />
                Новая папка
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="size-6 p-0 hover:scale-110 active:scale-90 transition-transform"
                onClick={() => { setShowNewFolderForm(false); setNewFolderName(''); }}
                aria-label="Закрыть форму"
                title="Закрыть"
              >
                ✕
              </Button>
            </div>
            <div className="flex gap-2">
              <Input
                placeholder="Название папки..."
                value={newFolderName}
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
                className="h-8 text-sm rounded-lg flex-1"
                autoFocus
              />
              <Button
                size="sm"
                className="text-xs gap-1 rounded-lg"
                style={{ backgroundColor: '#8e44ad', color: 'white' }}
                disabled={!newFolderName.trim()}
                onClick={handleCreateFolder}
              >
                <Plus className="size-3" />
                Создать
              </Button>
            </div>
          </div>
        )}

        {/* Create New Character Form */}
        {showCreateForm && (
          <div
            className="rounded-xl p-4 space-y-3 border-2"
            style={{
              backgroundColor: 'var(--fate-bg-warm)',
              borderColor: 'var(--fate-accent)',
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                Новый персонаж
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
                  <Label className="text-xs">Имя</Label>
                  <Input
                    placeholder="Имя персонажа..."
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    className="h-8 text-sm rounded-lg"
                    autoFocus
                  />
                </div>
                <div className="w-28">
                  <Label className="text-xs">Тип</Label>
                  <Select value={newType} onValueChange={(v) => setNewType(v as 'player' | 'npc')}>
                    <SelectTrigger className="h-8 text-sm rounded-lg">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="player">Игрок</SelectItem>
                      <SelectItem value="npc">NPC</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label className="text-xs">Концепт</Label>
                <Input
                  placeholder="Концепт персонажа..."
                  value={newConcept}
                  onChange={(e) => setNewConcept(e.target.value)}
                  className="h-8 text-sm rounded-lg"
                />
              </div>

              <div>
                <Label className="text-xs">Проблема</Label>
                <Input
                  placeholder="Проблема персонажа..."
                  value={newProblem}
                  onChange={(e) => setNewProblem(e.target.value)}
                  className="h-8 text-sm rounded-lg"
                />
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
                className="text-xs gap-1 fate-btn-accent rounded-lg"
                disabled={!newName.trim() || isCreating}
                onClick={handleCreate}
              >
                <Plus className="size-3" />
                {isCreating ? 'Создание...' : 'Создать'}
              </Button>
            </div>
          </div>
        )}

        <Separator />

        {/* Characters List — organized by folders */}
        <ScrollArea className="max-h-72">
          <div className="space-y-1 pr-1">
            {filteredCharacters.length === 0 && folders.length === 0 ? (
              <div className="text-center py-8 animate-fade-in fate-empty-state">
                <div
                  className="fate-empty-icon size-14 mx-auto flex items-center justify-center mb-2"
                  style={{ backgroundColor: 'rgba(127, 140, 141, 0.08)' }}
                >
                  <BookOpen className="size-6" style={{ color: 'var(--fate-text-muted)', opacity: 0.3 }} />
                </div>
                <p className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  {characters.length === 0 ? 'Нет персонажей' : 'Ничего не найдено'}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--fate-text-muted)', opacity: 0.6 }}>
                  {characters.length === 0
                    ? 'Создайте первого персонажа, чтобы начать'
                    : 'Попробуйте изменить фильтр'}
                </p>
              </div>
            ) : (
              <>
                {/* Folder sections */}
                {folders.map((folder) => {
                  const folderChars = charsByFolder[folder.id] ?? [];
                  const isExpanded = expandedFolders.has(folder.id);
                  const isRenaming = renamingFolderId === folder.id;

                  // Don't show empty folders when search is active
                  if (searchQuery && folderChars.length === 0) return null;

                  return (
                    <div key={folder.id} className="mb-1">
                      {/* Folder header */}
                      <div
                        className="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-all duration-150 hover:bg-black/[0.03]"
                        onClick={() => toggleFolder(folder.id)}
                      >
                        {isExpanded ? (
                          <ChevronDown className="size-3.5 shrink-0" style={{ color: '#8e44ad' }} />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0" style={{ color: '#8e44ad' }} />
                        )}
                        {isExpanded ? (
                          <FolderOpen className="size-4 shrink-0" style={{ color: '#8e44ad' }} />
                        ) : (
                          <FolderIcon className="size-4 shrink-0" style={{ color: '#8e44ad' }} />
                        )}

                        {isRenaming ? (
                          <Input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleRenameFolder(folder.id);
                              if (e.key === 'Escape') setRenamingFolderId(null);
                            }}
                            onBlur={() => handleRenameFolder(folder.id)}
                            className="h-6 text-sm rounded-md flex-1"
                            autoFocus
                            onClick={(e) => e.stopPropagation()}
                          />
                        ) : (
                          <span className="text-sm font-semibold flex-1" style={{ color: '#8e44ad' }}>
                            {folder.name}
                          </span>
                        )}

                        <Badge
                          className="text-[10px] h-4 px-1.5 shrink-0 font-medium rounded-md"
                          style={{ backgroundColor: 'rgba(142, 68, 173, 0.1)', color: '#8e44ad', border: 'none' }}
                        >
                          {folderChars.length}
                        </Badge>

                        {/* Folder actions */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-6 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                              style={{ color: 'var(--fate-text-muted)' }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <MoreHorizontal className="size-3" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownContent align="end" className="min-w-[140px]">
                            <DropdownMenuItem
                              onClick={(e) => {
                                e.stopPropagation();
                                setRenamingFolderId(folder.id);
                                setRenameValue(folder.name);
                              }}
                            >
                              <Pencil className="size-3 mr-2" />
                              Переименовать
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-red-600 focus:text-red-600"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteFolder(folder.id);
                              }}
                            >
                              <Trash2 className="size-3 mr-2" />
                              Удалить папку
                            </DropdownMenuItem>
                          </DropdownContent>
                        </DropdownMenu>
                      </div>

                      {/* Folder contents */}
                      {isExpanded && folderChars.length > 0 && (
                        <div className="ml-5 space-y-1 mt-0.5">
                          {folderChars.map((char) => renderCharacterRow(char))}
                        </div>
                      )}
                      {isExpanded && folderChars.length === 0 && (
                        <div className="ml-9 py-2">
                          <p className="text-xs" style={{ color: 'var(--fate-text-muted)', opacity: 0.5 }}>
                            Пустая папка
                          </p>
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Unfiled characters section */}
                {unfiledChars.length > 0 && (
                  <div className="mt-1">
                    {folders.length > 0 && (
                      <div
                        className="flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-all duration-150 hover:bg-black/[0.03]"
                        onClick={() => toggleFolder('__unfiled__')}
                      >
                        {expandedFolders.has('__unfiled__') ? (
                          <ChevronDown className="size-3.5 shrink-0" style={{ color: 'var(--fate-text-muted)' }} />
                        ) : (
                          <ChevronRight className="size-3.5 shrink-0" style={{ color: 'var(--fate-text-muted)' }} />
                        )}
                        <FolderIcon className="size-4 shrink-0" style={{ color: 'var(--fate-text-muted)', opacity: 0.5 }} />
                        <span className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                          Без папки
                        </span>
                        <Badge
                          className="text-[10px] h-4 px-1.5 shrink-0 font-medium rounded-md"
                          style={{ backgroundColor: 'rgba(127, 140, 141, 0.1)', color: 'var(--fate-text-muted)', border: 'none' }}
                        >
                          {unfiledChars.length}
                        </Badge>
                      </div>
                    )}
                    <div className={folders.length > 0 && !expandedFolders.has('__unfiled__') ? 'hidden' : folders.length > 0 ? 'ml-5 space-y-1 mt-0.5' : 'space-y-1.5'}>
                      {unfiledChars.map((char) => renderCharacterRow(char))}
                    </div>
                  </div>
                )}

                {/* Show "no results" when folders exist but all are empty after filtering */}
                {filteredCharacters.length === 0 && folders.length > 0 && (
                  <div className="text-center py-6 animate-fade-in">
                    <p className="text-sm" style={{ color: 'var(--fate-text-muted)' }}>
                      Ничего не найдено
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>

        {/* Hidden file input for character import */}
        <input
          ref={importFileRef}
          type="file"
          accept=".fate-char.json,.json"
          className="hidden"
          onChange={handleImportFile}
        />

        {/* Crowd Editor Dialog */}
        <CrowdEditorDialog
          open={crowdEditorOpen}
          onOpenChange={setCrowdEditorOpen}
        />

        {/* Move-to-folder overlay */}
        {renderMoveToFolderOverlay()}

        <DialogFooter>
          <Button variant="outline" size="sm" className="rounded-lg" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
