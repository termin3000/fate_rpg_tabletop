'use client';

import { useEffect, useState } from 'react';
import { FolderOpen, Lightbulb, RefreshCw, Sparkles } from 'lucide-react';

// Hook: is the viewport ≥1024px (Tailwind 'lg' breakpoint)?
// Used to conditionally render desktop OR mobile layout — NEVER both.
// Rendering both caused two <MapPanel> instances → two <RollStageOverlay>
// → two <ServerDiceStage> → duplicate dice:roll events per click,
// which caused dice to collide and fall through the table.
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState<boolean>(true);
  useEffect(() => {
    const mql = window.matchMedia('(min-width: 1024px)');
    const onChange = () => setIsDesktop(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isDesktop;
}

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';

import { AdventureDialog } from '@/components/fate/adventure-dialog';
import { BackupDialog } from '@/components/fate/backup-dialog';
import { CharacterSheetDialog } from '@/components/fate/character-sheet-dialog';
import { CommandPalette } from '@/components/fate/command-palette';
import { DashboardDialog } from '@/components/fate/dashboard-dialog';
import { FateHeader } from '@/components/fate/header';
import { FloatingActionButton } from '@/components/fate/floating-action-button';
import { HelpDialog } from '@/components/fate/help-dialog';
import { InventoryDialog } from '@/components/fate/inventory-dialog';
import { LibraryDialog } from '@/components/fate/library-dialog';
import { LogPanel } from '@/components/fate/log-panel';
import { MagicRollDialog } from '@/components/fate/magic-roll-dialog';
import { MapPanel } from '@/components/fate/map-panel';
import { NotesDialog } from '@/components/fate/notes-dialog';
import { NetworkDialog } from '@/components/fate/network-dialog';
import { NpcGeneratorDialog } from '@/components/fate/npc-generator-dialog';
import { QuickRollDialog } from '@/components/fate/quick-roll-dialog';
import { CharacterRollDialog } from '@/components/fate/character-roll-dialog';
import { SyncRollDialog } from '@/components/fate/sync-roll-dialog';
import { RandomTablesDialog } from '@/components/fate/random-tables-dialog';
import { RollGestureProvider } from '@/components/fate/roll-gesture-provider';
import { ScenePanel } from '@/components/fate/scene-panel';
import { ScenesDialog } from '@/components/fate/scenes-dialog';
import { SettingsDialog } from '@/components/fate/settings-dialog';

import { useFateStore } from '@/lib/store';
import { useNetwork } from '@/hooks/use-network';

// ── GM tips shown on the welcome screen (Polish Area 1) ────
const GM_TIPS: string[] = [
  'Используйте аспекты для усложнения или упрощения сюжета',
  'Очки судьбы — основная валюта Fate. Тратьте их смело!',
  'При провале предлагайте игроку успех с последствиями',
  'Аспекты работают в обе стороны: вызов и улучшение',
  'Не бойтесь пускать игроков в соавторов сюжета',
];

// Floating dice emojis for the welcome background — fixed positions
const FLOATING_DICE: { emoji: string; top: string; left: string }[] = [
  { emoji: '🎲', top: '12%', left: '8%' },
  { emoji: '🎯', top: '22%', left: '85%' },
  { emoji: '⚔️', top: '70%', left: '12%' },
  { emoji: '✨', top: '78%', left: '82%' },
  { emoji: '🎲', top: '45%', left: '92%' },
  { emoji: '🔮', top: '8%', left: '50%' },
];

export default function Home() {
  const { restoreSession } = useNetwork();
  // Mount ONLY desktop OR mobile layout, never both (fixes double-roll bug).
  const isDesktop = useIsDesktop();

  const {
    currentAdventureId,
    adventures,
    isLoading,
    loadAdventures,
    loadCustomTables,
    createAdventure,
    switchAdventure,
    canSeeLibrary,
    canEditAdventure,
    canTeamRoll,
    syncRollState,
  } = useFateStore();

  // Dialog states
  const [adventureDialogOpen, setAdventureDialogOpen] = useState(false);
  const [joinFromLink, setJoinFromLink] = useState(false);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('join');
    if (code && /^[A-Z0-9]{6}$/i.test(code)) {
      setJoinFromLink(true);
      setJoinDialogOpen(true);
    }
  }, []);
  const [quickRollDialogOpen, setQuickRollDialogOpen] = useState(false);
  const [characterRollDialogOpen, setCharacterRollDialogOpen] = useState(false);
  const [characterSheetOpen, setCharacterSheetOpen] = useState(false);
  const [scenesDialogOpen, setScenesDialogOpen] = useState(false);
  const [inventoryDialogOpen, setInventoryDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [libraryDialogOpen, setLibraryDialogOpen] = useState(false);
  const [magicDialogOpen, setMagicDialogOpen] = useState(false);
  const [notesDialogOpen, setNotesDialogOpen] = useState(false);
  const [randomTablesDialogOpen, setRandomTablesDialogOpen] = useState(false);
  const [dashboardDialogOpen, setDashboardDialogOpen] = useState(false);
  const [npcGeneratorOpen, setNpcGeneratorOpen] = useState(false);
  // Массовый бросок теперь живёт внутри боковой панели бросков (вкладка «Масс.»).
  // massRollTrigger инкрементируется при каждом запросе — ScenePanel реагирует
  // входом в режим броска и переключением на нужную вкладку.
  const [massRollTrigger, setMassRollTrigger] = useState(0);
  const [syncRollDialogOpen, setSyncRollDialogOpen] = useState(false);
  const [helpDialogOpen, setHelpDialogOpen] = useState(false);
  const [backupDialogOpen, setBackupDialogOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [selectedCharId, setSelectedCharId] = useState<string | null>(null);

  // Theme state — light by default
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  // Welcome screen state
  const [newAdventureName, setNewAdventureName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Tip of the day — start with index 0 (deterministic for SSR), rotate to random on mount
  const [tipIndex, setTipIndex] = useState(0);
  useEffect(() => {
    // Pick a random tip only on the client after hydration to avoid SSR mismatch
    setTipIndex(Math.floor(Math.random() * GM_TIPS.length));
  }, []);
  const handleShuffleTip = () => {
    setTipIndex((prev) => {
      if (GM_TIPS.length <= 1) return prev;
      let next = prev;
      while (next === prev) next = Math.floor(Math.random() * GM_TIPS.length);
      return next;
    });
  };

  // Auto-open the SyncRollDialog whenever a sync-roll session appears in the
  // store (host started it locally OR player received it via the network).
  // This ensures players see the countdown even if they didn't click anything.
  useEffect(() => {
    if (syncRollState && !syncRollDialogOpen) {
      setSyncRollDialogOpen(true);
    }
  }, [syncRollState, syncRollDialogOpen]);

  // NOTE: Roll invitations are now shown inline in the ScenePanel's
  // RollRequestsPanel (bottom of the left sidebar), not as a floating panel.

  useEffect(() => {
    loadAdventures().then(async () => {
      // After adventures are loaded, restore the last-selected adventure from
      // localStorage so a page refresh doesn't drop the user back to the
      // welcome screen. The adventure id is saved by switchAdventure().
      try {
        const savedId = localStorage.getItem('fate-current-adventure');
        if (savedId) {
          const adventures = useFateStore.getState().adventures;
          if (adventures.some((a) => a.id === savedId)) {
            await switchAdventure(savedId);
          } else {
            // Stale id — clear it so we don't keep trying
            localStorage.removeItem('fate-current-adventure');
          }
        }
      } catch {
        // localStorage may be unavailable (private mode, etc.) — ignore
      }
      restoreSession();
    });
    loadCustomTables();
  }, [loadAdventures, loadCustomTables, switchAdventure, restoreSession]);

  // Apply theme to document root
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
      root.style.colorScheme = 'dark';
    } else {
      root.classList.remove('dark');
      root.style.colorScheme = 'light';
    }
  }, [theme]);

  // ── Cmd+K / Ctrl+K opens Command Palette (works anywhere) ──
  useEffect(() => {
    if (!currentAdventureId) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyK') {
        e.preventDefault();
        setCommandPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentAdventureId]);

  // ── Global keyboard shortcuts ──────────────────────────────
  // Only triggers when no dialog is open and no input/textarea is focused.
  useEffect(() => {
    if (!currentAdventureId) return;

    const handler = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea/contenteditable
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable) {
          return;
        }
      }
      // Skip if any modifier other than shift is pressed
      if (e.altKey || e.metaKey || e.ctrlKey) return;
      // Skip if any dialog is currently open
      if (document.querySelector('[data-slot="dialog-content"][data-state="open"]')) return;

      switch (e.code) {
        case 'KeyQ':
          e.preventDefault();
          setSelectedCharId(null);
          setQuickRollDialogOpen(true);
          break;
        case 'KeyN':
          if (!canEditAdventure()) return;
          e.preventDefault();
          setNotesDialogOpen(true);
          break;
        case 'KeyR':
          e.preventDefault();
          setRandomTablesDialogOpen(true);
          break;
        case 'KeyG':
          if (!canSeeLibrary()) return;
          e.preventDefault();
          setNpcGeneratorOpen(true);
          break;
        case 'KeyL':
          if (!canSeeLibrary()) return;
          e.preventDefault();
          setLibraryDialogOpen(true);
          break;
        case 'KeyI':
          e.preventDefault();
          setInventoryDialogOpen(true);
          break;
        case 'KeyS':
          if (!canEditAdventure()) return;
          e.preventDefault();
          setScenesDialogOpen(true);
          break;
        case 'Comma':
          if (!canEditAdventure()) return;
          e.preventDefault();
          setSettingsDialogOpen(true);
          break;
        case 'KeyA':
          if (!canEditAdventure()) return;
          e.preventDefault();
          setAdventureDialogOpen(true);
          break;
        case 'KeyD':
          if (!canEditAdventure()) return;
          e.preventDefault();
          setDashboardDialogOpen(true);
          break;
        case 'KeyM':
          if (!canTeamRoll()) return;
          e.preventDefault();
          setMassRollTrigger((t) => t + 1);
          break;
        case 'KeyH':
          e.preventDefault();
          setHelpDialogOpen(true);
          break;
        case 'KeyT':
          e.preventDefault();
          setTheme((t) => (t === 'light' ? 'dark' : 'light'));
          break;
        case 'Escape':
          // Close any open dialog (handled by shadcn, but also reset state)
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentAdventureId, canSeeLibrary, canEditAdventure, canTeamRoll]);

  const handleToggleTheme = () => {
    setTheme((t) => (t === 'light' ? 'dark' : 'light'));
  };

  const handleOpenCharacterSheet = (charId: string) => {
    setSelectedCharId(charId);
    setCharacterSheetOpen(true);
  };

  const handleQuickRoll = (charId: string) => {
    setSelectedCharId(charId);
    setCharacterRollDialogOpen(true);
  };

  const handleCreateFirstAdventure = async () => {
    if (!newAdventureName.trim()) return;
    setIsCreating(true);
    try {
      await createAdventure(newAdventureName.trim());
      const newAdventures = useFateStore.getState().adventures;
      const newAdv = newAdventures[newAdventures.length - 1];
      if (newAdv) {
        await switchAdventure(newAdv.id);
      }
      setNewAdventureName('');
    } finally {
      setIsCreating(false);
    }
  };

  // Share links must allow joining before selecting an adventure locally.
  if (joinFromLink && !currentAdventureId) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 fate-welcome-bg">
        <h1 className="text-2xl font-bold">Подключение к игре Fate</h1>
        <p className="text-sm">Введите имя и подключитесь к комнате мастера.</p>
        <Button onClick={() => setJoinDialogOpen(true)}>Подключиться как игрок</Button>
        <NetworkDialog open={joinDialogOpen} onOpenChange={setJoinDialogOpen} />
      </div>
    );
  }

  // ── Welcome Screen (no adventure selected) ─────────────────
  if (!currentAdventureId && adventures.length === 0 && !isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 fate-welcome-bg relative overflow-hidden">
        {/* Floating dice background */}
        {FLOATING_DICE.map((d, i) => (
          <span
            key={i}
            className="fate-float-dice"
            style={{ top: d.top, left: d.left }}
            aria-hidden="true"
          >
            {d.emoji}
          </span>
        ))}
        <div className="max-w-md w-full text-center space-y-8 relative z-10">
          {/* Logo */}
          <div className="space-y-3 animate-fade-in">
            <div
              className="fate-dice-logo size-20 mx-auto rounded-2xl flex items-center justify-center shadow-lg"
              style={{ background: 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-dark))' }}
            >
              <span className="text-4xl">🎲</span>
            </div>
            <h1
              className="text-3xl font-black tracking-tight fate-welcome-title-decorator"
              style={{ color: 'var(--fate-text)' }}
            >
              Fate RPG Tool
            </h1>
            <p style={{ color: 'var(--fate-text-muted)' }} className="text-sm leading-relaxed">
              Виртуальный стол для настольной ролевой игры Fate
            </p>
          </div>

          {/* Create Adventure Card */}
          <div
            className="fate-welcome-card fate-shimmer-line rounded-xl p-6 text-left space-y-4"
            style={{
              border: '2px solid var(--fate-border)',
              background: 'var(--fate-bg-card)',
            }}
          >
            <div className="flex items-center gap-2.5">
              <div
                className="fate-icon-circle"
                style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
              >
                <Sparkles className="size-4" style={{ color: 'var(--fate-accent)' }} />
              </div>
              <h2 className="font-semibold" style={{ color: 'var(--fate-text)' }}>
                Начните новое приключение
              </h2>
            </div>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--fate-text-muted)' }}>
              Создайте своё первое приключение, чтобы начать игру. Вы сможете
              добавлять персонажей, сцены и вести лог бросков.
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="Название приключения..."
                value={newAdventureName}
                onChange={(e) => setNewAdventureName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateFirstAdventure()}
                className="text-sm rounded-lg"
              />
              <Button
                onClick={handleCreateFirstAdventure}
                disabled={!newAdventureName.trim() || isCreating}
                className="fate-btn-accent rounded-lg"
              >
                {isCreating ? 'Создание...' : 'Создать'}
              </Button>
            </div>
          </div>

          {/* Or open adventure manager */}
          <div className="text-center">
            <Button
              variant="outline"
              size="sm"
              className="text-xs gap-1.5 rounded-full px-4 border-dashed transition-all duration-300 hover:border-solid hover:shadow-sm hover:scale-105"
              style={{ color: 'var(--fate-accent)', borderColor: 'var(--fate-accent)' }}
              onClick={() => setAdventureDialogOpen(true)}
            >
              <FolderOpen className="size-3.5" />
              Управление приключениями
            </Button>
          </div>

          {/* Tip of the day */}
          <div className="fate-tip-card max-w-md mx-auto text-left animate-fade-in">
            <div className="flex items-start gap-2.5">
              <Lightbulb
                className="size-4 shrink-0 mt-0.5"
                style={{ color: 'var(--fate-accent)' }}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span
                    className="text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--fate-accent)' }}
                  >
                    Совет дня
                  </span>
                  <button
                    type="button"
                    onClick={handleShuffleTip}
                    className="size-5 rounded-full flex items-center justify-center transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/10 active:scale-90"
                    style={{ color: 'var(--fate-text-muted)' }}
                    title="Другой совет"
                    aria-label="Показать другой совет"
                  >
                    <RefreshCw className="size-3" />
                  </button>
                </div>
                <p
                  key={tipIndex}
                  className="text-xs leading-relaxed animate-fade-in"
                  style={{ color: 'var(--fate-text)' }}
                >
                  {GM_TIPS[tipIndex]}
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Dialogs */}
        <AdventureDialog open={adventureDialogOpen} onOpenChange={setAdventureDialogOpen} />
      </div>
    );
  }

  // ── Adventure exists but none selected ─────────────────────
  if (!currentAdventureId && adventures.length > 0 && !isLoading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6 fate-welcome-bg relative overflow-hidden">
        {/* Floating dice background */}
        {FLOATING_DICE.map((d, i) => (
          <span
            key={i}
            className="fate-float-dice"
            style={{ top: d.top, left: d.left }}
            aria-hidden="true"
          >
            {d.emoji}
          </span>
        ))}
        <div className="max-w-md w-full text-center space-y-6 animate-fade-in relative z-10">
          <div
            className="fate-dice-logo size-20 mx-auto rounded-2xl flex items-center justify-center shadow-lg"
            style={{ background: 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-dark))' }}
          >
            <span className="text-4xl">🎲</span>
          </div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--fate-text)' }}>
            Выберите приключение
          </h1>
          <p className="text-sm" style={{ color: 'var(--fate-text-muted)' }}>
            У вас есть {adventures.length}{' '}
            {adventures.length === 1 ? 'приключение' : 'приключения'}. Выберите
            одно, чтобы продолжить.
          </p>
          <div className="flex flex-col gap-2">
            {adventures.map((adv) => (
              <Button
                key={adv.id}
                variant="outline"
                className="w-full justify-start gap-2.5 rounded-lg transition-all duration-200 hover:shadow-sm hover:translate-x-1"
                onClick={() => switchAdventure(adv.id)}
              >
                <FolderOpen className="size-4" style={{ color: 'var(--fate-accent)' }} />
                {adv.name}
              </Button>
            ))}
            <Button
              variant="outline"
              size="sm"
              className="text-xs gap-1.5 mt-2 rounded-full px-4 border-dashed transition-all duration-300 hover:border-solid hover:shadow-sm hover:scale-105"
              style={{ color: 'var(--fate-accent)', borderColor: 'var(--fate-accent)' }}
              onClick={() => setAdventureDialogOpen(true)}
            >
              <FolderOpen className="size-3.5" />
              Управление приключениями
            </Button>
          </div>

          {/* Tip of the day */}
          <div className="fate-tip-card max-w-md mx-auto text-left">
            <div className="flex items-start gap-2.5">
              <Lightbulb
                className="size-4 shrink-0 mt-0.5"
                style={{ color: 'var(--fate-accent)' }}
                aria-hidden="true"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2 mb-0.5">
                  <span
                    className="text-[10px] font-bold uppercase tracking-wider"
                    style={{ color: 'var(--fate-accent)' }}
                  >
                    Совет дня
                  </span>
                  <button
                    type="button"
                    onClick={handleShuffleTip}
                    className="size-5 rounded-full flex items-center justify-center transition-all duration-200 hover:bg-black/5 dark:hover:bg-white/10 active:scale-90"
                    style={{ color: 'var(--fate-text-muted)' }}
                    title="Другой совет"
                    aria-label="Показать другой совет"
                  >
                    <RefreshCw className="size-3" />
                  </button>
                </div>
                <p
                  key={tipIndex}
                  className="text-xs leading-relaxed animate-fade-in"
                  style={{ color: 'var(--fate-text)' }}
                >
                  {GM_TIPS[tipIndex]}
                </p>
              </div>
            </div>
          </div>
        </div>

        <AdventureDialog open={adventureDialogOpen} onOpenChange={setAdventureDialogOpen} />
      </div>
    );
  }

  // ── Loading State ───────────────────────────────────────────
  if (isLoading && !currentAdventureId) {
    return (
      <div
        className="min-h-screen flex items-center justify-center fate-bg-texture"
      >
        <div className="text-center space-y-4">
          <div
            className="size-16 mx-auto rounded-2xl flex items-center justify-center shadow-md"
            style={{ background: 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-dark))', animation: 'fate-float 3s ease-in-out infinite' }}
          >
            <span className="text-3xl">🎲</span>
          </div>
          <p className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
            Загрузка...
          </p>
        </div>
      </div>
    );
  }

  // ── Main Layout ─────────────────────────────────────────────
  return (
    <div
      className="h-screen flex flex-col overflow-hidden fate-bg-texture"
    >
      {/* Header */}
      <FateHeader
        onOpenAdventureDialog={() => setAdventureDialogOpen(true)}
        onOpenQuickRollDialog={() => {
          setSelectedCharId(null);
          setQuickRollDialogOpen(true);
        }}
        onOpenMassRollDialog={() => setMassRollTrigger((t) => t + 1)}
        onOpenSyncRollDialog={() => setSyncRollDialogOpen(true)}
        onOpenCharacterSheet={handleOpenCharacterSheet}
        onOpenScenesDialog={() => setScenesDialogOpen(true)}
        onOpenInventoryDialog={() => setInventoryDialogOpen(true)}
        onOpenSettingsDialog={() => setSettingsDialogOpen(true)}
        onOpenLibraryDialog={() => setLibraryDialogOpen(true)}
        onOpenMagicDialog={() => setMagicDialogOpen(true)}
        onOpenNotesDialog={() => setNotesDialogOpen(true)}
        onOpenRandomTablesDialog={() => setRandomTablesDialogOpen(true)}
        onOpenNpcGenerator={() => setNpcGeneratorOpen(true)}
        onOpenDashboardDialog={() => setDashboardDialogOpen(true)}
        onOpenBackupDialog={() => setBackupDialogOpen(true)}
        onOpenHelpDialog={() => setHelpDialogOpen(true)}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        theme={theme}
        onToggleTheme={handleToggleTheme}
      />

      {/* Main Content — 3-Panel Layout
          IMPORTANT: only ONE of desktop/mobile is ever mounted at a time.
          Previously both were mounted (CSS hidden via hidden/lg:hidden),
          causing duplicate <MapPanel> → duplicate <RollStageOverlay> →
          double dice:roll events → dice colliding and falling through
          the table. Now we use a JS media query to mount only one.

          RollGestureProvider оборачивает ВСЁ чтобы DnD работал между
          левым сайдбаром (DiceStation — draggable) и центральным canvas
          (GameCanvas — droppable). Они в разных ResizablePanel, поэтому
          DndContext должен быть выше обоих. */}
      <RollGestureProvider>
      <div className="flex-1 overflow-hidden">
        {isDesktop ? (
          <div className="h-full">
            <ResizablePanelGroup direction="horizontal" className="h-full">
              {/* Left Panel — Scene */}
              <ResizablePanel defaultSize={20} minSize={15} maxSize={35}>
                <ScenePanel
                  onOpenCharacterSheet={handleOpenCharacterSheet}
                  onQuickRoll={handleQuickRoll}
                  onOpenLibraryDialog={() => setLibraryDialogOpen(true)}
                  onOpenInventoryDialog={() => setInventoryDialogOpen(true)}
                  massRollTrigger={massRollTrigger}
                />
              </ResizablePanel>

              <ResizableHandle withHandle />

              {/* Center Panel — Map */}
              <ResizablePanel defaultSize={55} minSize={30}>
                <MapPanel />
              </ResizablePanel>

              <ResizableHandle withHandle />

              {/* Right Panel — Log */}
              <ResizablePanel defaultSize={25} minSize={15} maxSize={40}>
                <LogPanel />
              </ResizablePanel>
            </ResizablePanelGroup>
          </div>
        ) : (
          <div className="overflow-y-auto fate-scroll h-full">
            {/* Map first (primary content) */}
            <div className="h-[50vh] min-h-[300px]">
              <MapPanel />
            </div>

            {/* Scene panel */}
            <div className="h-[40vh] min-h-[250px] border-t" style={{ borderColor: 'var(--fate-border)' }}>
              <ScenePanel
                onOpenCharacterSheet={handleOpenCharacterSheet}
                onQuickRoll={handleQuickRoll}
                onOpenLibraryDialog={() => setLibraryDialogOpen(true)}
                onOpenInventoryDialog={() => setInventoryDialogOpen(true)}
                massRollTrigger={massRollTrigger}
              />
            </div>

            {/* Log panel */}
            <div className="h-[40vh] min-h-[250px] border-t" style={{ borderColor: 'var(--fate-border)' }}>
              <LogPanel />
            </div>
          </div>
        )}
      </div>
      </RollGestureProvider>

      {/* Dialogs */}
      <AdventureDialog open={adventureDialogOpen} onOpenChange={setAdventureDialogOpen} />
      <QuickRollDialog
        open={quickRollDialogOpen}
        onOpenChange={setQuickRollDialogOpen}
        preselectedCharId={null}
      />
      <CharacterRollDialog
        open={characterRollDialogOpen}
        onOpenChange={setCharacterRollDialogOpen}
        characterId={selectedCharId}
      />
      <CharacterSheetDialog
        open={characterSheetOpen}
        onOpenChange={setCharacterSheetOpen}
        characterId={selectedCharId}
      />
      <ScenesDialog
        open={scenesDialogOpen}
        onOpenChange={setScenesDialogOpen}
      />
      <InventoryDialog
        open={inventoryDialogOpen}
        onOpenChange={setInventoryDialogOpen}
      />
      <SettingsDialog
        open={settingsDialogOpen}
        onOpenChange={setSettingsDialogOpen}
      />
      <BackupDialog
        open={backupDialogOpen}
        onOpenChange={setBackupDialogOpen}
      />
      <LibraryDialog
        open={libraryDialogOpen}
        onOpenChange={setLibraryDialogOpen}
        onOpenCharacterSheet={handleOpenCharacterSheet}
      />
      <MagicRollDialog
        open={magicDialogOpen}
        onOpenChange={setMagicDialogOpen}
      />
      <NotesDialog
        open={notesDialogOpen}
        onOpenChange={setNotesDialogOpen}
      />
      <RandomTablesDialog
        open={randomTablesDialogOpen}
        onOpenChange={setRandomTablesDialogOpen}
      />
      <NpcGeneratorDialog
        open={npcGeneratorOpen}
        onOpenChange={setNpcGeneratorOpen}
      />
      <DashboardDialog
        open={dashboardDialogOpen}
        onOpenChange={setDashboardDialogOpen}
      />
      <SyncRollDialog
        open={syncRollDialogOpen}
        onOpenChange={setSyncRollDialogOpen}
      />
      <HelpDialog
        open={helpDialogOpen}
        onOpenChange={setHelpDialogOpen}
      />

      {/* Command Palette — Cmd+K / Ctrl+K */}
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        onQuickRoll={() => {
          setSelectedCharId(null);
          setQuickRollDialogOpen(true);
        }}
        onCharacterRoll={() => setCharacterRollDialogOpen(true)}
        onMassRoll={() => setMassRollTrigger((t) => t + 1)}
        onLibrary={() => setLibraryDialogOpen(true)}
        onScenes={() => setScenesDialogOpen(true)}
        onInventory={() => setInventoryDialogOpen(true)}
        onNotes={() => setNotesDialogOpen(true)}
        onSettings={() => setSettingsDialogOpen(true)}
        onNpcGenerator={() => setNpcGeneratorOpen(true)}
        onRandomTables={() => setRandomTablesDialogOpen(true)}
        onDashboard={() => setDashboardDialogOpen(true)}
        onMagic={() => setMagicDialogOpen(true)}
        onOpenCharacterSheet={handleOpenCharacterSheet}
        onSwitchScene={() => {}}
      />

      {/* Floating Action Button — quick access on mobile/desktop */}
      <FloatingActionButton
        onQuickRoll={() => {
          setSelectedCharId(null);
          setQuickRollDialogOpen(true);
        }}
        onNotes={() => setNotesDialogOpen(true)}
        onNpcGenerator={() => setNpcGeneratorOpen(true)}
        onLibrary={() => setLibraryDialogOpen(true)}
      />

    </div>
  );
}
