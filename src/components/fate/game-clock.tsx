'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, Lock, Minus, Plus, RotateCcw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useFateStore } from '@/lib/store';

// ── Constants ──────────────────────────────────────────────
const STORAGE_KEY = 'fate-game-clock-state';
const STORAGE_EXPANDED_KEY = 'fate-game-clock-expanded';

interface GameClockState {
  /** Current in-game time as total seconds from midnight */
  currentSeconds: number;
}

const DEFAULT_STATE: GameClockState = {
  currentSeconds: 8 * 3600, // 08:00 by default
};

// ── localStorage helpers (SSR-safe) ────────────────────────
function loadState(): GameClockState {
  if (typeof window === 'undefined') return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_STATE;
  }
}

function loadExpanded(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_EXPANDED_KEY) === '1';
  } catch {
    return false;
  }
}

// ── Time format helper ─────────────────────────────────────
function formatGameTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600) % 24;
  const m = Math.floor((totalSeconds % 3600) / 60);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}`;
}

// ── Component ──────────────────────────────────────────────
export function GameClock() {
  const [expanded, setExpanded] = useState<boolean>(loadExpanded);
  const [state, setState] = useState<GameClockState>(loadState);
  const { currentSeconds } = state;

  // ── Access control: host/local can manage, network players read-only ──
  const canManage = useFateStore((s) => s.canManageClocks());

  // ── Edit mode state ──────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [editHours, setEditHours] = useState(Math.floor(currentSeconds / 3600) % 24);
  const [editMinutes, setEditMinutes] = useState(Math.floor((currentSeconds % 3600) / 60));
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Persist state ────────────────────────────────────────
  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch { /* ignore */ }
  }, [state]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_EXPANDED_KEY, expanded ? '1' : '0');
    } catch { /* ignore */ }
  }, [expanded]);

  // ── Handlers (all gated by canManage — defense in depth) ──
  const handleAdvance5Min = useCallback(() => {
    if (!canManage) return;
    setState((prev) => ({ ...prev, currentSeconds: (prev.currentSeconds + 300) % 86400 }));
  }, [canManage]);

  const handleRetreat5Min = useCallback(() => {
    if (!canManage) return;
    setState((prev) => ({ ...prev, currentSeconds: (prev.currentSeconds - 300 + 86400) % 86400 }));
  }, [canManage]);

  const handleAdvance1Hour = useCallback(() => {
    if (!canManage) return;
    setState((prev) => ({ ...prev, currentSeconds: (prev.currentSeconds + 3600) % 86400 }));
  }, [canManage]);

  const handleRetreat1Hour = useCallback(() => {
    if (!canManage) return;
    setState((prev) => ({ ...prev, currentSeconds: (prev.currentSeconds - 3600 + 86400) % 86400 }));
  }, [canManage]);

  const handleStartEdit = useCallback(() => {
    if (!canManage) return;
    setEditHours(Math.floor(currentSeconds / 3600) % 24);
    setEditMinutes(Math.floor((currentSeconds % 3600) / 60));
    setEditing(true);
    // Focus input after state update
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [canManage, currentSeconds]);

  const handleConfirmEdit = useCallback(() => {
    const h = Math.max(0, Math.min(23, parseInt(String(editHours)) || 0));
    const m = Math.max(0, Math.min(59, parseInt(String(editMinutes)) || 0));
    setState((prev) => ({ ...prev, currentSeconds: h * 3600 + m * 60 }));
    setEditing(false);
  }, [editHours, editMinutes]);

  const handleResetClock = useCallback(() => {
    if (!canManage) return;
    setState({ currentSeconds: 8 * 3600 });
  }, [canManage]);

  // ── Collapsed: small clock icon button ───────────────────
  if (!expanded) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="absolute bottom-3 right-3 z-30 size-7 rounded-lg backdrop-blur-sm border shadow-lg hover:bg-black/5 dark:hover:bg-white/5 animate-fade-in"
        style={{ borderColor: 'var(--fate-border)', color: 'var(--fate-text)', backgroundColor: 'var(--fate-bg-card)' }}
        onClick={() => setExpanded(true)}
        title="Показать часы игры"
        aria-label="Показать часы игры"
      >
        <Clock className="size-4" />
      </Button>
    );
  }

  // ── Expanded: full game clock widget ─────────────────────
  return (
    <div
      className="absolute bottom-3 right-3 z-30 w-52 rounded-lg border shadow-lg backdrop-blur-sm animate-fade-in overflow-hidden"
      style={{ borderColor: 'var(--fate-border)', backgroundColor: 'var(--fate-bg-card)' }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{
          background: 'linear-gradient(135deg, rgba(230,126,34,0.12), rgba(230,126,34,0.04))',
          borderBottom: '1px solid var(--fate-border)',
        }}
      >
        <div className="flex items-center gap-1.5">
          <Clock className="size-3.5" style={{ color: 'var(--fate-accent)' }} />
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--fate-text)' }}>
            Часы игры
          </span>
          {!canManage && (
            <span
              className="flex items-center gap-0.5 text-[9px] font-semibold px-1 py-0.5 rounded"
              style={{
                color: 'var(--fate-text-muted)',
                backgroundColor: 'rgba(127, 140, 141, 0.12)',
              }}
              title="Только просмотр — управление доступно только мастеру"
            >
              <Lock className="size-2.5" />
              Только просмотр
            </span>
          )}
        </div>
        <button
          className="size-5 rounded flex items-center justify-center transition-colors hover:bg-black/5 dark:hover:bg-white/10"
          onClick={() => setExpanded(false)}
          title="Свернуть"
          aria-label="Свернуть часы"
        >
          <X className="size-3" style={{ color: 'var(--fate-text-muted)' }} />
        </button>
      </div>

      {/* Game time display */}
      <div className="px-3 pt-2.5 pb-2">
        {/* Time display / editor */}
        {editing ? (
          <div
            className="flex items-center gap-1.5 p-2 rounded-lg border animate-fade-in"
            style={{
              borderColor: 'var(--fate-accent)',
              backgroundColor: 'rgba(230, 126, 34, 0.04)',
            }}
          >
            <Input
              ref={inputRef}
              type="number"
              min={0}
              max={23}
              value={editHours}
              onChange={(e) => setEditHours(parseInt(e.target.value) || 0)}
              className="h-7 w-12 text-xs text-center"
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmEdit(); }}
            />
            <span className="text-xs font-bold" style={{ color: 'var(--fate-text-muted)' }}>:</span>
            <Input
              type="number"
              min={0}
              max={59}
              value={editMinutes}
              onChange={(e) => setEditMinutes(parseInt(e.target.value) || 0)}
              className="h-7 w-12 text-xs text-center"
              onKeyDown={(e) => { if (e.key === 'Enter') handleConfirmEdit(); }}
            />
            <Button
              size="sm"
              className="h-7 px-2 text-[10px] fate-btn-accent rounded shrink-0"
              onClick={handleConfirmEdit}
            >
              Ок
            </Button>
          </div>
        ) : (
          <div
            className={`font-mono text-2xl font-bold tabular-nums tracking-tight transition-opacity ${
              canManage ? 'cursor-pointer hover:opacity-80' : 'cursor-default'
            }`}
            style={{ color: 'var(--fate-text)' }}
            onClick={handleStartEdit}
            title={canManage ? 'Нажмите, чтобы установить время' : 'Только просмотр — управление доступно только мастеру'}
          >
            {formatGameTime(currentSeconds)}
          </div>
        )}

        {/* Manual time controls — hidden for read-only viewers (host/local only) */}
        {canManage && (
        <div className="flex items-center gap-0.5 mt-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded hover:bg-black/5 dark:hover:bg-white/10"
            onClick={handleRetreat1Hour}
            title="−1 час"
            aria-label="Минус 1 час"
          >
            <span className="text-[9px] font-bold" style={{ color: 'var(--fate-text-muted)' }}>−1ч</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded hover:bg-black/5 dark:hover:bg-white/10"
            onClick={handleRetreat5Min}
            title="−5 мин"
            aria-label="Минус 5 минут"
          >
            <span className="text-[9px] font-bold" style={{ color: 'var(--fate-text-muted)' }}>−5м</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded hover:bg-black/5 dark:hover:bg-white/10"
            onClick={handleAdvance5Min}
            title="+5 мин"
            aria-label="Плюс 5 минут"
          >
            <span className="text-[9px] font-bold" style={{ color: 'var(--fate-text-muted)' }}>+5м</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded hover:bg-black/5 dark:hover:bg-white/10"
            onClick={handleAdvance1Hour}
            title="+1 час"
            aria-label="Плюс 1 час"
          >
            <span className="text-[9px] font-bold" style={{ color: 'var(--fate-text-muted)' }}>+1ч</span>
          </Button>
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            className="size-6 rounded hover:bg-black/5 dark:hover:bg-white/10"
            onClick={handleResetClock}
            title="Сбросить на 08:00"
            aria-label="Сбросить часы"
          >
            <RotateCcw className="size-3" style={{ color: 'var(--fate-text-muted)' }} />
          </Button>
        </div>
        )}
      </div>
    </div>
  );
}
