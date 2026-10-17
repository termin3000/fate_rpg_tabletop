'use client';

import {
  ArrowRight,
  BarChart3,
  BookMarked,
  BookOpen,
  Dice5,
  Dices,
  Download,
  FolderPlus,
  Globe,
  HelpCircle,
  Map,
  Moon,
  MoreHorizontal,
  Package,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Shuffle,
  Sun,
  Sword,
  Upload,
  Users,
  Wand2,
  Zap,
} from 'lucide-react';

import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { BackupDialog } from '@/components/fate/backup-dialog';
import { CreateAdventureDialog } from '@/components/fate/create-adventure-dialog';
import { HelpDialog } from '@/components/fate/help-dialog';
import { NetworkDialog } from '@/components/fate/network-dialog';
import { ExitApplicationMenuItem } from '@/components/fate/exit-application';
import { TransferDialog } from '@/components/fate/transfer-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFateStore } from '@/lib/store';
import { toast } from 'sonner';

interface HeaderProps {
  onOpenAdventureDialog: () => void;
  onOpenQuickRollDialog: () => void;
  onOpenMassRollDialog: () => void;
  onOpenSyncRollDialog: () => void;
  onOpenCharacterSheet: (charId: string) => void;
  onOpenScenesDialog: () => void;
  onOpenInventoryDialog: () => void;
  onOpenSettingsDialog: () => void;
  onOpenLibraryDialog: () => void;
  onOpenMagicDialog: () => void;
  onOpenNotesDialog: () => void;
  onOpenRandomTablesDialog: () => void;
  onOpenNpcGenerator: () => void;
  onOpenDashboardDialog: () => void;
  onOpenBackupDialog: () => void;
  onOpenHelpDialog: () => void;
  onOpenCommandPalette: () => void;
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
}
export function FateHeader({
  onOpenAdventureDialog,
  onOpenQuickRollDialog,
  onOpenMassRollDialog,
  onOpenSyncRollDialog,
  onOpenScenesDialog,
  onOpenInventoryDialog,
  onOpenSettingsDialog,
  onOpenLibraryDialog,
  onOpenMagicDialog,
  onOpenNotesDialog,
  onOpenRandomTablesDialog,
  onOpenNpcGenerator,
  onOpenDashboardDialog,
  onOpenBackupDialog,
  onOpenHelpDialog,
  onOpenCommandPalette,
  theme,
  onToggleTheme,
}: HeaderProps) {
  const {
    adventures,
    currentAdventureId,
    currentMode,
    switchAdventure,
    setMode,
    magicModuleEnabled,
    notes,
    exportAdventure,
    importAdventure,
    characters,
    isNetworkActive,
    networkRole,
    networkSignalingStatus,
    peerLatencies,
    networkPeers,
    myAssignedCharacterId,
    canEditAdventure,
    canSeeLibrary,
    canTeamRoll,
  } = useFateStore();

  const [helpDialogOpen, setHelpDialogOpen] = useState(false);
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);
  const [createAdventureOpen, setCreateAdventureOpen] = useState(false);
  const [networkDialogOpen, setNetworkDialogOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Auto-open the Network dialog when the page is loaded via a ?join=CODE
  // share link (e.g. the host shared a URL or a player scanned the QR). The
  // NetworkDialog itself reads the code from the URL and pre-fills the join
  // form. We only do this once on mount to avoid re-opening on every render.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const join = params.get('join');
    if (join && /^[A-Z0-9]{6}$/i.test(join)) {
      setNetworkDialogOpen(true);
    }
  }, []);

  const pinnedCount = notes.filter((n) => n.pinned).length;

  const isPlayer = currentMode === 'player';
  const isNetworkPlayer = isNetworkActive && networkRole === 'player';
  const assignedCharId = myAssignedCharacterId();
  const assignedIsMage =
    !!assignedCharId && characters.some((c) => c.id === assignedCharId && c.isMage);
  const canOpenMagic = magicModuleEnabled && (!isPlayer || assignedIsMage);

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
    <header
      className="fate-header-anim flex flex-wrap items-center gap-2 px-4 py-2 shadow-lg relative overflow-hidden"
      style={{
        background: 'var(--fate-header-gradient)',
        borderBottom: '3px solid var(--fate-accent)',
      }}
    >
      {/* Subtle texture overlay */}
      <div
        className="absolute inset-0 opacity-5 pointer-events-none"
        style={{
          backgroundImage: `radial-gradient(circle at 25% 50%, rgba(255,255,255,0.15), transparent 50%),
            radial-gradient(circle at 75% 30%, rgba(255,255,255,0.1), transparent 50%)`,
        }}
      />

      {/* Accent line glow at bottom */}
      <div
        className="absolute bottom-0 left-0 right-0 h-[3px] fate-accent-line"
        style={{ backgroundColor: 'var(--fate-accent)' }}
      />

      {/* Logo */}
      <div className="flex items-center gap-2.5 mr-3 relative z-10">
        <div
          className="size-9 rounded-xl flex items-center justify-center shadow-md transition-transform duration-200 hover:scale-110 hover:rotate-12"
          style={{ background: 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-dark))' }}
        >
          <span className="text-lg leading-none">🎲</span>
        </div>
        <h1 className="text-lg font-bold tracking-tight whitespace-nowrap drop-shadow-sm fate-text-gradient">
          Fate RPG Tool
        </h1>
      </div>

      {/* Adventure Selector + quick actions — host / local only */}
      {canEditAdventure() && (
        <div className="flex items-center gap-1 relative z-10">
          <Select
            value={currentAdventureId ?? ''}
            onValueChange={(id) => switchAdventure(id)}
          >
            <SelectTrigger
              size="sm"
              className={`w-52 border-white/15 bg-white/8 text-white text-xs hover:bg-white/15 hover:border-white/25 transition-all duration-300 rounded-lg fate-toolbar-btn [&_svg]:text-white/60 ${currentAdventureId ? 'fate-subtle-glow' : ''}`}
            >
              <span className="fate-adventure-select-icon">🎲</span>
              <SelectValue placeholder="Выберите приключение" />
            </SelectTrigger>
            <SelectContent>
              {adventures.length === 0 ? (
                <SelectItem value="__none" disabled>
                  Нет приключений
                </SelectItem>
              ) : (
                adventures.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>

          {/* Quick actions dropdown: create / transfer / export / import */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="flex items-center justify-center size-8 rounded-lg border border-white/15 bg-white/8 hover:bg-white/15 hover:border-white/25 transition-all duration-200 text-white/70 hover:text-white"
                aria-label="Действия с приключением"
                title="Создать / перенести / экспорт / импорт"
              >
                <ArrowRight className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuItem
                onClick={() => setCreateAdventureOpen(true)}
                className="gap-2 cursor-pointer"
              >
                <FolderPlus className="size-3.5 text-[var(--fate-accent)]" />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">Создать новое...</span>
                  <span className="text-[10px] text-muted-foreground">Новое приключение и сделать активным</span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setTransferDialogOpen(true)}
                disabled={!currentAdventureId || adventures.length < 2}
                className="gap-2 cursor-pointer"
              >
                <ArrowRight className="size-3.5 text-[var(--fate-accent)]" />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">Перенести...</span>
                  <span className="text-[10px] text-muted-foreground">Копировать из другого в активное</span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={handleExport}
                disabled={isExporting || isImporting || !currentAdventureId}
                className="gap-2 cursor-pointer"
              >
                <Download className="size-3.5 text-emerald-600" />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">{isExporting ? 'Экспорт...' : 'Экспорт'}</span>
                  <span className="text-[10px] text-muted-foreground">Скачать приключение в JSON</span>
                </div>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={handleImportClick}
                disabled={isExporting || isImporting}
                className="gap-2 cursor-pointer"
              >
                <Upload className="size-3.5 text-blue-600" />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">{isImporting ? 'Импорт...' : 'Импорт'}</span>
                  <span className="text-[10px] text-muted-foreground">Загрузить приключение из JSON</span>
                </div>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Hidden file input for import */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Command Palette trigger — search button */}
      {!isPlayer && (
        <button
          type="button"
          onClick={onOpenCommandPalette}
          className="hidden sm:flex items-center gap-2 px-3 h-8 rounded-lg border border-white/15 bg-white/8 hover:bg-white/15 hover:border-white/25 transition-all duration-200 text-white/70 hover:text-white text-xs mr-1 group"
          aria-label="Открыть командную палитру (Ctrl+K)"
          title="Командная палитра (Ctrl+K)"
        >
          <Search className="size-3.5 group-hover:scale-110 transition-transform" />
          <span className="hidden md:inline">Поиск...</span>
          <kbd className="hidden md:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] rounded border border-white/20 bg-white/5 font-mono">
            ⌘K
          </kbd>
        </button>
      )}

      {/* Toolbar — Primary actions always visible, secondary in «Ещё» dropdown */}
      <div className="flex items-center gap-0.5 relative z-10">
        {/* ── Primary buttons ─────────────────────── */}

        {/* Журнал — host / local only, frequent */}
        {canEditAdventure() && (
          <Button
            variant="ghost"
            size="sm"
            className="fate-toolbar-btn fate-button-shine text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 active:scale-95 text-xs gap-1.5 rounded-lg"
            onClick={onOpenNotesDialog}
            title="Журнал мастера (N)"
          >
            <BookMarked className="size-4" />
            <span className="hidden lg:inline">Журнал</span>
            {pinnedCount > 0 && (
              <span
                className="absolute -top-0.5 -right-0.5 size-3.5 rounded-full text-[9px] font-bold flex items-center justify-center"
                style={{ backgroundColor: '#f39c12', color: 'white' }}
              >
                {pinnedCount}
              </span>
            )}
          </Button>
        )}

        {/* Бросок — always visible, very frequent */}
        <Button
          variant="ghost"
          size="sm"
          className="fate-toolbar-btn fate-button-shine text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 active:scale-95 text-xs gap-1.5 rounded-lg"
          onClick={onOpenQuickRollDialog}
          title="Быстрый бросок (Q)"
        >
          <Dice5 className="size-4" />
          <span className="hidden sm:inline">Бросок</span>
        </Button>

        {/* Магия — visible when module is on AND (host/local OR assigned mage) */}
        {canOpenMagic && (
          <Button
            variant="ghost"
            size="sm"
            className="fate-toolbar-btn fate-button-shine text-white/70 hover:text-white hover:bg-purple-500/20 active:bg-purple-500/30 active:scale-95 text-xs gap-1.5 rounded-lg"
            onClick={onOpenMagicDialog}
            title="Магия (заклинания)"
          >
            <Wand2 className="size-4" />
            <span className="hidden sm:inline">🔮 Магия</span>
          </Button>
        )}

        {/* ── Secondary tools in «Ещё» dropdown ──── */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="fate-toolbar-btn fate-button-shine text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 active:scale-95 text-xs gap-1.5 rounded-lg"
            >
              <MoreHorizontal className="size-4" />
              <span className="hidden sm:inline">Ещё</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {/* Библиотека */}
            {canSeeLibrary() && (
              <DropdownMenuItem onClick={onOpenLibraryDialog} className="gap-2 cursor-pointer">
                <BookOpen className="size-3.5 text-[var(--fate-accent)]" />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">Библиотека</span>
                  <span className="text-[10px] text-muted-foreground">Персонажи и шаблоны (L)</span>
                </div>
              </DropdownMenuItem>
            )}
            {/* Сцены */}
            {canEditAdventure() && (
              <DropdownMenuItem onClick={onOpenScenesDialog} className="gap-2 cursor-pointer">
                <Map className="size-3.5 text-[var(--fate-accent)]" />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">Сцены</span>
                  <span className="text-[10px] text-muted-foreground">Управление сценами (S)</span>
                </div>
              </DropdownMenuItem>
            )}
            {/* Инвентарь */}
            <DropdownMenuItem onClick={onOpenInventoryDialog} className="gap-2 cursor-pointer">
              <Package className="size-3.5 text-[var(--fate-accent)]" />
              <div className="flex flex-col">
                <span className="text-xs font-semibold">Инвентарь</span>
                <span className="text-[10px] text-muted-foreground">Предметы на сцене (I)</span>
              </div>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* Массовый бросок */}
            {currentAdventureId && canTeamRoll() && (
              <DropdownMenuItem onClick={onOpenMassRollDialog} className="gap-2 cursor-pointer">
                <Dices className="size-3.5 text-emerald-600" />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">Массовый бросок</span>
                  <span className="text-[10px] text-muted-foreground">Несколько персонажей сразу (M)</span>
                </div>
              </DropdownMenuItem>
            )}
            {/* Групповой бросок (P2P) — доступен только когда сеть активна */}
            {isNetworkActive && networkRole === 'host' && (
              <DropdownMenuItem onClick={onOpenSyncRollDialog} className="gap-2 cursor-pointer">
                <Zap className="size-3.5" style={{ color: '#9b59b6' }} />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">Групповой бросок</span>
                  <span className="text-[10px] text-muted-foreground">Одновременно для всех игроков</span>
                </div>
              </DropdownMenuItem>
            )}
            {/* Обзор */}
            {canEditAdventure() && (
              <DropdownMenuItem onClick={onOpenDashboardDialog} className="gap-2 cursor-pointer">
                <BarChart3 className="size-3.5 text-emerald-600" />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">Обзор</span>
                  <span className="text-[10px] text-muted-foreground">Сводка по приключению (D)</span>
                </div>
              </DropdownMenuItem>
            )}
            {/* Таблицы */}
            <DropdownMenuItem onClick={onOpenRandomTablesDialog} className="gap-2 cursor-pointer">
              <Shuffle className="size-3.5 text-emerald-600" />
              <div className="flex flex-col">
                <span className="text-xs font-semibold">Случайные таблицы</span>
                <span className="text-[10px] text-muted-foreground">Кастомные таблицы (R)</span>
              </div>
            </DropdownMenuItem>
            {/* NPC Generator */}
            {canSeeLibrary() && currentAdventureId && (
              <DropdownMenuItem onClick={onOpenNpcGenerator} className="gap-2 cursor-pointer">
                <Zap className="size-3.5 text-emerald-600" />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">Генератор NPC</span>
                  <span className="text-[10px] text-muted-foreground">Быстрое создание NPC (G)</span>
                </div>
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator />

            {/* Настройки */}
            {canEditAdventure() && (
              <DropdownMenuItem onClick={onOpenSettingsDialog} className="gap-2 cursor-pointer">
                <Settings className="size-3.5 text-muted-foreground" />
                <div className="flex flex-col">
                  <span className="text-xs font-semibold">Настройки</span>
                  <span className="text-[10px] text-muted-foreground">Навыки, модули, инициатива (,)</span>
                </div>
              </DropdownMenuItem>
            )}

            {/* Защита данных — резервные копии */}
            <DropdownMenuItem onClick={onOpenBackupDialog} className="gap-2 cursor-pointer">
              <ShieldCheck className="size-3.5 text-emerald-600" />
              <div className="flex flex-col">
                <span className="text-xs font-semibold">Защита данных</span>
                <span className="text-[10px] text-muted-foreground">Резервные копии и снапшоты</span>
              </div>
            </DropdownMenuItem>
            <ExitApplicationMenuItem />
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Divider between tools and utility */}
        <div className="w-px h-5 mx-1 bg-white/15" />

        {/* Help Button — always visible */}
        <Button
          variant="ghost"
          size="icon"
          className="fate-toolbar-btn fate-button-shine size-8 text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 active:scale-95 rounded-lg"
          onClick={() => setHelpDialogOpen(true)}
          title="Справка (H)"
          aria-label="Справка"
        >
          <HelpCircle className="size-4" />
        </Button>

        {/* Theme Toggle — always visible */}
        <Button
          variant="ghost"
          size="icon"
          className="fate-toolbar-btn fate-button-shine size-8 text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 active:scale-95 rounded-lg"
          onClick={onToggleTheme}
          title={theme === 'light' ? 'Тёмная тема (T)' : 'Светлая тема (T)'}
          aria-label={theme === 'light' ? 'Включить тёмную тему' : 'Включить светлую тему'}
        >
          {theme === 'light' ? <Moon className="size-4" /> : <Sun className="size-4" />}
        </Button>
      </div>

      {/* Network button — visible to everyone, opens NetworkDialog.
          The colored dot reflects the live signaling connection status:
            🟢 online + in-room   → emerald (pulsing)
            🟡 online, no room    → amber
            🔵 connecting         → sky (pulsing)
            🔴 offline/error      → red
            ⚪ not started        → muted (hidden) */}
      {(() => {
        const playerCount = Object.keys(networkPeers).length;
        const inRoom = isNetworkActive;
        let dotColor = 'rgba(255,255,255,0.25)';
        let pulse = false;
        let titleText = 'Сеть — не подключено';
        if (inRoom) {
          dotColor = '#10b981'; // emerald-500
          pulse = true;
          titleText = `Сеть активна · ${playerCount} игрок(ов) в комнате`;
        } else if (networkSignalingStatus === 'online') {
          dotColor = '#f59e0b'; // amber-500
          titleText = 'Сервер сигнализации онлайн · комната не создана';
        } else if (networkSignalingStatus === 'connecting') {
          dotColor = '#0ea5e9'; // sky-500
          pulse = true;
          titleText = 'Подключение к серверу сигнализации…';
        } else if (networkSignalingStatus === 'error') {
          dotColor = '#ef4444'; // red-500
          titleText = 'Ошибка подключения к серверу сигнализации';
        } else {
          // offline — keep dot hidden if not in any network state
          dotColor = '';
        }
        const avgPing = playerCount > 0
          ? Math.round(Object.values(peerLatencies).reduce((a, b) => a + b, 0) / playerCount)
          : null;
        if (avgPing !== null) {
          titleText += ` · средний пинг ${avgPing} мс`;
        }
        return (
          <Button
            variant="ghost"
            size="sm"
            className={`fate-toolbar-btn fate-button-shine ml-2 relative z-10 text-xs gap-1.5 rounded-lg h-8 ${
              isNetworkActive
                ? 'text-white hover:text-white hover:bg-emerald-500/20 active:bg-emerald-500/30 border border-emerald-400/40'
                : 'text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15'
            }`}
            onClick={() => setNetworkDialogOpen(true)}
            title={titleText}
            aria-label={titleText}
          >
            <div className="relative">
              <Globe className="size-4" />
              {dotColor && (
                <span
                  className={`absolute -top-0.5 -right-0.5 size-2 rounded-full ring-1 ring-black/40 ${pulse ? 'animate-pulse' : ''}`}
                  style={{ backgroundColor: dotColor }}
                  aria-hidden="true"
                />
              )}
            </div>
            <span className="hidden sm:inline">Сеть</span>
          </Button>
        );
      })()}

      {/* Mode Toggle — Balanced Pill Switch */}
      {isNetworkPlayer ? (
        // Network players are locked to player mode — show a static badge.
        <div
          className="ml-2 relative z-10 flex items-center gap-1.5 rounded-full px-3 h-7 text-xs font-medium select-none"
          style={{
            backgroundColor: 'rgba(39, 174, 96, 0.18)',
            color: '#a7e8c0',
            border: '1px solid rgba(39, 174, 96, 0.35)',
          }}
          title="Недоступно в сетевом режиме"
        >
          <Shield className="size-3" />
          <span>Игрок</span>
        </div>
      ) : (
        <div
          className="ml-2 relative z-10 flex items-center rounded-full p-0.5"
          style={{ backgroundColor: 'rgba(0,0,0,0.25)' }}
        >
          <button
            type="button"
            onClick={() => setMode('master')}
            className={`
              flex items-center justify-center gap-1.5 rounded-full text-xs font-medium
              h-7 transition-all duration-300 cursor-pointer select-none
              ${currentMode === 'master'
                ? 'bg-[var(--fate-accent)] text-white shadow-md scale-105'
                : 'text-white/60 hover:text-white/90'
              }
            `}
            style={{ minWidth: '80px', padding: '0 12px' }}
            aria-pressed={currentMode === 'master'}
            aria-label="Режим мастера"
          >
            <Sword className="size-3" />
            <span>Мастер</span>
          </button>
          <button
            type="button"
            onClick={() => setMode('player')}
            className={`
              flex items-center justify-center gap-1.5 rounded-full text-xs font-medium
              h-7 transition-all duration-300 cursor-pointer select-none
              ${currentMode === 'player'
                ? 'bg-[var(--fate-accent)] text-white shadow-md scale-105'
                : 'text-white/60 hover:text-white/90'
              }
            `}
            style={{ minWidth: '80px', padding: '0 12px' }}
            aria-pressed={currentMode === 'player'}
            aria-label="Режим игрока"
          >
            <Shield className="size-3" />
            <span>Игрок</span>
          </button>
        </div>
      )}

      <HelpDialog open={helpDialogOpen} onOpenChange={setHelpDialogOpen} />
      <TransferDialog open={transferDialogOpen} onOpenChange={setTransferDialogOpen} />
      <CreateAdventureDialog open={createAdventureOpen} onOpenChange={setCreateAdventureOpen} />
      <NetworkDialog open={networkDialogOpen} onOpenChange={setNetworkDialogOpen} />
    </header>
  );
}

// ── Theatrical Mode Toggle ──────────────────────────────────
// REMOVED: кнопка «Театр» убрана — театральный режим теперь всегда включён.
// Кубики всегда вылетают из кейса на карту при каждом броске. См. store.ts
// (enqueueLiveRoll больше не проверяет theatricalMode).
