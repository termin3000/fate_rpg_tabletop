'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Lock, Pause, Play, RotateCcw, Timer as TimerIcon, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useFateStore } from '@/lib/store';
import { useToast } from '@/hooks/use-toast';

// ── Constants ──────────────────────────────────────────────
const STORAGE_EXPANDED_KEY = 'fate-combat-timer-expanded';
const STORAGE_STATE_KEY = 'fate-combat-timer-state';
const WARNING_THRESHOLD_SECONDS = 120; // 2 minutes
const LONG_THRESHOLD_SECONDS = 300; // 5 minutes — red glow visual cue for long combats

interface PersistedState {
  running: boolean;
  elapsed: number;
  /** Wall-clock ms timestamp captured on the last persist while running — used to recover elapsed time across reloads. */
  lastTimestamp: number | null;
}

interface PendingToast {
  title: string;
  description: string;
}

const DEFAULT_STATE: PersistedState = {
  running: false,
  elapsed: 0,
  lastTimestamp: null,
};

// ── localStorage helpers (SSR-safe) ────────────────────────
function loadExpanded(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    const raw = window.localStorage.getItem(STORAGE_EXPANDED_KEY);
    return raw === null ? true : raw === '1';
  } catch {
    return true;
  }
}

function loadState(): PersistedState {
  if (typeof window === 'undefined') return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_STATE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<PersistedState>;
    const running = Boolean(parsed.running);
    let elapsed = Math.max(0, Math.floor(Number(parsed.elapsed) || 0));
    const lastTimestamp =
      typeof parsed.lastTimestamp === 'number' ? parsed.lastTimestamp : null;
    // If the timer was running when the page was closed, advance elapsed by the time we were away.
    if (running && lastTimestamp !== null) {
      const delta = Math.max(0, Math.floor((Date.now() - lastTimestamp) / 1000));
      elapsed += delta;
    }
    return { running, elapsed, lastTimestamp: null };
  } catch {
    return DEFAULT_STATE;
  }
}

// ── Time format helper ─────────────────────────────────────
/**
 * Format a duration in seconds as `MM:SS`, or `H:MM:SS` if the duration exceeds one hour.
 */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
  return `${pad(minutes)}:${pad(secs)}`;
}

// ── Component ──────────────────────────────────────────────
export function CombatTimer() {
  const { toast } = useToast();

  // Subscribe only to the current scene's conflictData — stable reference unless it actually changes.
  const conflictData = useFateStore((s) => {
    const scene = s.scenes.find((sc) => sc.id === s.currentSceneId) ?? null;
    return scene?.conflictData ?? null;
  });

  // ── Access control: network players can view but not control the timer ──
  const isNetworkActive = useFateStore((s) => s.isNetworkActive);
  const networkRole = useFateStore((s) => s.networkRole);
  const isNetworkPlayer = isNetworkActive && networkRole === 'player';

  const [expanded, setExpanded] = useState<boolean>(loadExpanded);
  const [state, setState] = useState<PersistedState>(loadState);
  const { running, elapsed } = state;

  // Refs that survive re-renders for tracking previous values and scheduling toasts.
  const roundRef = useRef<number | null>(conflictData?.round ?? null);
  const conflictActiveRef = useRef<boolean>(conflictData !== null);
  const conflictSceneIdRef = useRef<string | null>(null);
  const pendingToastRef = useRef<PendingToast | null>(null);

  // ── Adjust timer state when conflictData changes ──────────
  // Using the React-recommended "store information from previous renders" pattern:
  // detect the change during render and update state synchronously (allowed by React
  // when the update is conditional and idempotent). This avoids the
  // `react-hooks/set-state-in-effect` lint warning and prevents cascading renders.
  const currentRound = conflictData?.round ?? null;
  const currentConflictActive = conflictData !== null;

  // Auto-reset on new combat round
  if (roundRef.current !== currentRound) {
    const prevRound = roundRef.current;
    roundRef.current = currentRound;
    if (
      prevRound !== null &&
      currentRound !== null &&
      currentRound > prevRound &&
      state.running
    ) {
      setState((prev) => ({ ...prev, elapsed: 0 }));
      pendingToastRef.current = {
        title: 'Новый раунд',
        description: 'Таймер сброшен',
      };
    }
  }

  // Auto-pause on conflict end
  if (conflictActiveRef.current !== currentConflictActive) {
    const wasActive = conflictActiveRef.current;
    if (currentConflictActive) {
      conflictSceneIdRef.current =
        useFateStore.getState().currentSceneId ?? null;
    }
    conflictActiveRef.current = currentConflictActive;

    if (!currentConflictActive && wasActive) {
      const currentSceneId =
        useFateStore.getState().currentSceneId ?? null;
      const sameScene = conflictSceneIdRef.current === currentSceneId;
      if (sameScene && state.running) {
        const total = state.elapsed;
        setState((prev) => ({ ...prev, running: false }));
        pendingToastRef.current = {
          title: 'Бой окончен',
          description: `Общее время боя: ${formatTime(total)}`,
        };
      }
      conflictSceneIdRef.current = null;
    }
  }

  // ── Fire any pending toast after the render commits ───────
  useEffect(() => {
    if (pendingToastRef.current) {
      const t = pendingToastRef.current;
      pendingToastRef.current = null;
      toast(t);
    }
  });

  // ── Persist expanded/collapsed state ──────────────────────
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_EXPANDED_KEY, expanded ? '1' : '0');
    } catch {
      /* ignore storage errors (private mode, etc.) */
    }
  }, [expanded]);

  // ── Persist running/elapsed state (every tick while running) ──
  useEffect(() => {
    try {
      const payload: PersistedState = {
        running,
        elapsed,
        lastTimestamp: running ? Date.now() : null,
      };
      window.localStorage.setItem(STORAGE_STATE_KEY, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }, [running, elapsed]);

  // ── Ticking interval (1Hz) ────────────────────────────────
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setState((prev) =>
        prev.running ? { ...prev, elapsed: prev.elapsed + 1 } : prev,
      );
    }, 1000);
    return () => window.clearInterval(id);
  }, [running]);

  // ── Handlers ──────────────────────────────────────────────
  const handleToggle = useCallback(() => {
    if (isNetworkPlayer) return;
    setState((prev) => ({ ...prev, running: !prev.running }));
  }, [isNetworkPlayer]);

  const handleReset = useCallback(() => {
    if (isNetworkPlayer) return;
    setState((prev) => ({ ...prev, elapsed: 0 }));
  }, [isNetworkPlayer]);

  const handleCollapse = useCallback(() => setExpanded(false), []);
  const handleExpand = useCallback(() => setExpanded(true), []);

  // ── Derived visual state ──────────────────────────────────
  const isWarning = elapsed >= WARNING_THRESHOLD_SECONDS;
  const isLong = elapsed >= LONG_THRESHOLD_SECONDS;

  let textColor: string;
  if (isLong) {
    textColor = '#e74c3c';
  } else if (isWarning) {
    textColor = '#e74c3c';
  } else if (running) {
    textColor = 'var(--fate-accent)';
  } else if (elapsed > 0) {
    textColor = '#f39c12';
  } else {
    textColor = 'var(--fate-text-muted)';
  }

  const dotColor = running
    ? '#27ae60'
    : elapsed > 0
      ? '#f39c12'
      : 'var(--fate-text-muted)';

  // ── Collapsed: small ⏱ icon button ────────────────────────
  if (!expanded) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-3 right-3 z-30 size-7 rounded-lg backdrop-blur-sm border shadow-lg hover:bg-black/5 dark:hover:bg-white/5 animate-fade-in"
        style={{ borderColor: 'var(--fate-border)', color: textColor, backgroundColor: 'var(--fate-bg-card)' }}
        onClick={handleExpand}
        title="Показать таймер боя"
        aria-label="Показать таймер боя"
      >
        <TimerIcon className="size-4" />
      </Button>
    );
  }

  // ── Expanded: full timer widget ───────────────────────────
  const containerStyle: React.CSSProperties = {
    borderColor: isLong ? '#e74c3c' : isWarning ? '#e74c3c' : 'var(--fate-border)',
  };
  // Long combats (>5min) get the red glow animation (takes priority over warning pulse)
  // Warning (>=2min) while running keeps the existing warning animation
  if (isLong) {
    containerStyle.animation = 'fate-timer-long-glow 1.5s ease-in-out infinite';
  } else if (isWarning && running) {
    containerStyle.animation = 'fate-timer-warning 1.2s ease-in-out infinite';
  }

  // Container className includes pulse-glow when running (and not already in long/warning state)
  const containerClassName = [
    'absolute top-3 right-3 z-30 px-3 py-2 rounded-lg border shadow-lg backdrop-blur-sm flex items-center gap-2 text-xs animate-fade-in',
    running && !isLong && !isWarning ? 'fate-timer-running' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
        className={containerClassName}
        style={{...containerStyle, backgroundColor: 'var(--fate-bg-card)' }}
        role="timer"
        aria-live="off"
        aria-label={`Таймер боя: ${formatTime(elapsed)}`}
      >
        {/* Timer icon (header) */}
        <TimerIcon
          className="size-3.5 shrink-0"
          style={{ color: textColor }}
          aria-hidden="true"
        />

        {/* Visible label «Бой» — gives sighted users immediate context
            that this timer measures the current combat. Hidden from screen
            readers because the aria-label above already says «Таймер боя». */}
        <span
          className="text-[10px] uppercase tracking-wide shrink-0 select-none font-medium"
          style={{ color: textColor, opacity: 0.7 }}
          aria-hidden="true"
        >
          Бой
        </span>

        {/* Status dot */}
        <span
          className="size-2 rounded-full shrink-0"
          style={{
            backgroundColor: dotColor,
            animation: running
              ? 'fate-timer-pulse 1.5s ease-in-out infinite'
              : undefined,
          }}
          aria-hidden="true"
        />

        {/* Time display — more dramatic when running */}
        <kbd
          className={`font-mono tabular-nums font-semibold transition-all duration-200 ${
            running ? 'text-sm tracking-wide' : 'text-xs'
          }`}
          style={{ color: textColor }}
        >
          {formatTime(elapsed)}
        </kbd>

        {/* Running/paused state indicator */}
        <span
          className="text-[10px] shrink-0 transition-opacity duration-200"
          style={{ color: textColor, opacity: 0.7 }}
          aria-hidden="true"
          title={running ? 'Идёт отсчёт' : 'На паузе'}
        >
          {running ? '▶' : '⏸'}
        </span>

        {/* Controls */}
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleToggle}
            disabled={isNetworkPlayer}
            title={isNetworkPlayer ? 'Управление таймером недоступно для игрока' : running ? 'Пауза' : 'Старт'}
            aria-label={isNetworkPlayer ? 'Управление таймером недоступно для игрока' : running ? 'Пауза' : 'Старт'}
          >
            {running ? (
              <Pause className="size-3.5" />
            ) : (
              <Play className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed"
            onClick={handleReset}
            disabled={isNetworkPlayer}
            title={isNetworkPlayer ? 'Управление таймером недоступно для игрока' : 'Сбросить'}
            aria-label={isNetworkPlayer ? 'Управление таймером недоступно для игрока' : 'Сбросить таймер'}
          >
            {isNetworkPlayer ? (
              <Lock className="size-3.5" />
            ) : (
              <RotateCcw className="size-3.5" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded hover:bg-black/5 dark:hover:bg-white/10"
            onClick={handleCollapse}
            title="Свернуть"
            aria-label="Свернуть таймер"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>
  );
}
