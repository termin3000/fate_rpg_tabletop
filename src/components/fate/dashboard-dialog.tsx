'use client';

import { useMemo } from 'react';
import {
  BarChart3,
  BookMarked,
  Calendar,
  Clock,
  Dice5,
  Map as MapIcon,
  Package,
  Sparkles,
  Target,
  Timer,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
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
import type { LogEntry } from '@/lib/types';

interface DashboardDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Date formatting helpers ─────────────────────────────────
function formatDate(dateStr: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(dateStr));
  } catch {
    return '—';
  }
}

function formatDateTime(dateStr: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(dateStr));
  } catch {
    return '—';
  }
}

function formatTime(dateStr: string): string {
  try {
    return new Intl.DateTimeFormat('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(dateStr));
  } catch {
    return '';
  }
}

// ── Result categorization ───────────────────────────────────
type ResultCategory = 'fail' | 'tie' | 'success' | 'great' | 'system';

function categorizeEntry(entry: LogEntry): ResultCategory {
  // System messages: result === 'system', OR customText with no characterId
  if (entry.result === 'system') return 'system';
  if (entry.customText && !entry.characterId) return 'system';

  // Otherwise, infer from the Russian label stored in `result`
  const r = entry.result ?? '';
  if (r.includes('Провал') || r === 'fail') return 'fail';
  if (r.includes('Ничья') || r === 'tie') return 'tie';
  if (r.includes('стилем') || r === 'great') return 'great';
  if (r.includes('Успех') || r === 'success') return 'success';

  // Quick rolls without difficulty/opponent produce "Результат: +X" labels.
  // Categorize these by the numeric total to match the same thresholds used
  // in fate-dice.ts getRollResult() for the no-comparison branch.
  const match = r.match(/Результат:\s*([+-]?\d+)/);
  if (match) {
    const total = parseInt(match[1], 10);
    if (total >= 4) return 'great';
    if (total >= 1) return 'success';
    if (total === 0) return 'tie';
    return 'fail';
  }

  // Anything else without a character is treated as system
  if (!entry.characterId) return 'system';
  return 'tie';
}

// ── Distribution bar metadata ───────────────────────────────
const DISTRIBUTION: {
  key: ResultCategory;
  label: string;
  color: string;
}[] = [
  { key: 'fail',    label: 'Провал', color: '#e74c3c' },
  { key: 'tie',     label: 'Ничья',  color: '#95a5a6' },
  { key: 'success', label: 'Успех',  color: '#27ae60' },
  { key: 'great',   label: 'Стиль',  color: '#f39c12' },
  { key: 'system',  label: 'Система', color: '#9b59b6' },
];

// ── Stat card metadata ──────────────────────────────────────
interface StatCardData {
  icon: React.ElementType;
  label: string;
  value: number;
  caption: string;
  tint: string;
}

// ── Component ───────────────────────────────────────────────
export function DashboardDialog({ open, onOpenChange }: DashboardDialogProps) {
  const {
    adventures,
    currentAdventureId,
    characters,
    scenes,
    logEntries,
    items,
    notes,
  } = useFateStore();

  const currentAdventure = useMemo(
    () => adventures.find((a) => a.id === currentAdventureId) ?? null,
    [adventures, currentAdventureId],
  );

  // ── Quick stats ──────────────────────────────────────────
  const stats = useMemo<StatCardData[]>(() => {
    const players = characters.filter((c) => c.type === 'player').length;
    const npcs = characters.filter((c) => c.type === 'npc').length;

    // Count active conditions across all scenes' floors' tokens
    let activeConditions = 0;
    for (const scene of scenes) {
      for (const floor of scene.floors ?? []) {
        for (const token of floor.tokens ?? []) {
          activeConditions += token.conditions?.length ?? 0;
        }
      }
    }

    return [
      {
        icon: Users,
        label: 'Персонажей',
        value: characters.length,
        caption: `${players} игр. / ${npcs} NPC`,
        tint: 'rgba(230, 126, 34, 0.12)',
      },
      {
        icon: MapIcon,
        label: 'Сцен',
        value: scenes.length,
        caption: scenes.length === 1 ? 'одна сцена' : 'всего сцен',
        tint: 'rgba(39, 174, 96, 0.12)',
      },
      {
        icon: Dice5,
        label: 'Бросков',
        value: logEntries.length,
        caption: 'записей в логе',
        tint: 'rgba(155, 89, 182, 0.12)',
      },
      {
        icon: BookMarked,
        label: 'Заметок',
        value: notes.length,
        caption: 'в журнале мастера',
        tint: 'rgba(243, 156, 18, 0.12)',
      },
      {
        icon: Package,
        label: 'Предметов',
        value: items.length,
        caption: 'в инвентаре',
        tint: 'rgba(192, 57, 43, 0.12)',
      },
      {
        icon: Zap,
        label: 'Состояний',
        value: activeConditions,
        caption: 'активных на токенах',
        tint: 'rgba(41, 128, 185, 0.12)',
      },
    ];
  }, [characters, scenes, logEntries, notes, items]);

  // ── Roll distribution ────────────────────────────────────
  const distribution = useMemo(() => {
    const counts: Record<ResultCategory, number> = {
      fail: 0,
      tie: 0,
      success: 0,
      great: 0,
      system: 0,
    };
    for (const entry of logEntries) {
      counts[categorizeEntry(entry)] += 1;
    }
    const total = logEntries.length;
    return { counts, total };
  }, [logEntries]);

  // ── Most active characters ───────────────────────────────
  const topCharacters = useMemo(() => {
    const map = new Map<
      string,
      { characterId: string; name: string; type: 'player' | 'npc'; rolls: number; successes: number }
    >();

    for (const entry of logEntries) {
      if (!entry.characterId) continue;
      const cat = categorizeEntry(entry);
      // Only count actual rolls (not system entries)
      if (cat === 'system') continue;

      const existing = map.get(entry.characterId);
      const isSuccess = cat === 'success' || cat === 'great';
      if (existing) {
        existing.rolls += 1;
        if (isSuccess) existing.successes += 1;
      } else {
        const char = characters.find((c) => c.id === entry.characterId);
        map.set(entry.characterId, {
          characterId: entry.characterId,
          name: entry.characterName || char?.name || 'Без имени',
          type: char?.type ?? 'npc',
          rolls: 1,
          successes: isSuccess ? 1 : 0,
        });
      }
    }

    return Array.from(map.values())
      .sort((a, b) => b.rolls - a.rolls)
      .slice(0, 3);
  }, [logEntries, characters]);

  // ── Recent activity (last 5) ─────────────────────────────
  const recentEntries = useMemo(() => {
    return [...logEntries].reverse().slice(0, 5);
  }, [logEntries]);

  // ── Story Beats — key system events for session recap ──
  const storyBeats = useMemo(() => {
    return logEntries
      .filter((e) => {
        const cat = categorizeEntry(e);
        return cat === 'system';
      })
      .slice(-8)  // last 8 system events
      .reverse();
  }, [logEntries]);

  // ── Conflict stats ────────────────────────────────────────
  const conflictStats = useMemo(() => {
    let conflictsStarted = 0;
    let conflictsEnded = 0;
    for (const e of logEntries) {
      const text = e.customText || '';
      if (text.includes('Начат') && text.includes('конфликт')) conflictsStarted++;
      if (text.includes('Конфликт завершён') || text.includes('конфликт завершён')) conflictsEnded++;
    }
    return { started: conflictsStarted, ended: conflictsEnded };
  }, [logEntries]);

  // ── Roll trend (last 20 rolls) ──────────────────────────
  const rollTrend = useMemo(() => {
    const rolls = logEntries.filter((e) => {
      const cat = categorizeEntry(e);
      return cat !== 'system';
    });
    return [...rolls].reverse().slice(0, 20);
  }, [logEntries]);

  // ── Fate points overview ────────────────────────────────
  const fatePointsData = useMemo(() => {
    return characters
      .filter((c) => c.fatePoints !== c.refresh)
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        fatePoints: c.fatePoints,
        refresh: c.refresh,
      }))
      .sort((a, b) => a.fatePoints - b.fatePoints);
  }, [characters]);

  // ── Session duration ────────────────────────────────────
  const sessionDuration = useMemo(() => {
    if (!currentAdventure) return null;
    const created = new Date(currentAdventure.createdAt).getTime();
    const updated = new Date(currentAdventure.updatedAt).getTime();
    const now = Date.now();
    // Use the more recent: updatedAt or now (if very recent)
    const end = now - updated < 60_000 ? now : updated;
    const diffMs = Math.max(end - created, 0);

    const minutes = Math.floor(diffMs / 60_000);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    let formatted = '';
    if (days > 0) {
      formatted = `${days} ${days === 1 ? 'день' : days < 5 ? 'дня' : 'дней'} ${hours % 24} ${hours % 24 === 1 ? 'час' : hours % 24 < 5 ? 'часа' : 'часов'}`;
    } else if (hours > 0) {
      formatted = `${hours} ${hours === 1 ? 'час' : hours < 5 ? 'часа' : 'часов'} ${minutes % 60} ${minutes % 60 === 1 ? 'минута' : minutes % 60 < 5 ? 'минуты' : 'минут'}`;
    } else {
      formatted = `${minutes} ${minutes === 1 ? 'минута' : minutes < 5 ? 'минуты' : 'минут'}`;
    }

    // Count distinct days with activity
    const activeDays = new Set<string>();
    for (const entry of logEntries) {
      const d = new Date(entry.createdAt);
      activeDays.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    }
    // Also count creation day
    const cd = new Date(currentAdventure.createdAt);
    activeDays.add(`${cd.getFullYear()}-${cd.getMonth()}-${cd.getDate()}`);

    return { formatted, sessionCount: activeDays.size };
  }, [currentAdventure, logEntries]);

  // ── Skill usage breakdown ───────────────────────────────
  const skillUsage = useMemo(() => {
    const skillCounts = new Map<string, number>();
    for (const entry of logEntries) {
      if (entry.skillName) {
        skillCounts.set(entry.skillName, (skillCounts.get(entry.skillName) ?? 0) + 1);
      }
    }
    return Array.from(skillCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [logEntries]);

  // ── Result category color helper ────────────────────────
  function getCategoryColor(cat: ResultCategory): string {
    const d = DISTRIBUTION.find((x) => x.key === cat);
    return d?.color ?? '#95a5a6';
  }

  if (!currentAdventure) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 fate-dialog-title">
              <div
                className="fate-icon-circle"
                style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
              >
                <BarChart3 className="size-4" style={{ color: 'var(--fate-accent)' }} />
              </div>
              Обзор приключения
            </DialogTitle>
            <DialogDescription>Статистика и активность</DialogDescription>
          </DialogHeader>
          <div className="py-10 text-center text-sm text-muted-foreground">
            Загрузка...
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <BarChart3 className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Обзор приключения
          </DialogTitle>
          <DialogDescription>Статистика и активность</DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[70vh] pr-4">
          <div className="space-y-6">
            {/* ── Section 1: Quick Stats Grid ─────────────────── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {stats.map((stat, idx) => {
                const Icon = stat.icon;
                return (
                  <div
                    key={stat.label}
                    className="fate-card-static rounded-xl p-3 flex flex-col gap-1.5 transition-all duration-200 hover:translate-y-[-2px] hover:shadow-md animate-fade-in group relative overflow-hidden"
                    style={{ animationDelay: `${idx * 40}ms` }}
                  >
                    {/* Accent strip on the left */}
                    <div
                      className="absolute left-0 top-0 bottom-0 w-1"
                      style={{ backgroundColor: stat.tint }}
                      aria-hidden="true"
                    />
                    <div className="flex items-center gap-2 pl-1">
                      <div
                        className="size-7 rounded-lg flex items-center justify-center transition-transform duration-200 group-hover:scale-110 shrink-0"
                        style={{ backgroundColor: stat.tint }}
                      >
                        <Icon className="size-4" style={{ color: 'var(--fate-text)' }} />
                      </div>
                      <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                        {stat.label}
                      </span>
                    </div>
                    <div className="font-black text-3xl leading-none tabular-nums pl-1" style={{ color: 'var(--fate-text)' }}>
                      {stat.value}
                    </div>
                    <div className="text-[10px] leading-tight pl-1" style={{ color: 'var(--fate-text-muted)' }}>
                      {stat.caption}
                    </div>
                  </div>
                );
              })}
            </div>

            <Separator />

            {/* ── Section 2: Roll Trend Mini-Chart ────────────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="size-4" style={{ color: 'var(--fate-accent)' }} />
                <h3 className="text-sm font-semibold fate-section-header pb-1.5" style={{ color: 'var(--fate-text)' }}>
                  📈 Тренд бросков
                </h3>
              </div>

              {rollTrend.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-4 fate-card-static rounded-lg">
                  Нет данных
                </div>
              ) : (
                <div className="fate-card-static rounded-lg p-3 space-y-3">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {rollTrend.map((entry, idx) => {
                      const cat = categorizeEntry(entry);
                      const color = getCategoryColor(cat);
                      return (
                        <div
                          key={entry.id}
                          className="size-3.5 rounded-full shrink-0 transition-transform hover:scale-150 cursor-help"
                          style={{ backgroundColor: color, animationDelay: `${idx * 20}ms` }}
                          title={`#${idx + 1} • ${entry.characterName || 'Система'}: ${entry.skillName || entry.result || ''} → ${entry.total >= 0 ? '+' : ''}${entry.total}`}
                        />
                      );
                    })}
                  </div>
                  {/* Legend */}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] pt-2 border-t" style={{ borderColor: 'var(--fate-border)' }}>
                    {[
                      { label: 'Стиль', cat: 'great' },
                      { label: 'Успех', cat: 'success' },
                      { label: 'Ничья', cat: 'tie' },
                      { label: 'Провал', cat: 'fail' },
                      { label: 'Система', cat: 'system' },
                    ].map(({ label, cat }) => (
                      <div key={cat} className="flex items-center gap-1">
                        <div className="size-2 rounded-full" style={{ backgroundColor: getCategoryColor(cat as any) }} />
                        <span style={{ color: 'var(--fate-text-muted)' }}>{label}</span>
                      </div>
                    ))}
                  </div>
                  <div className="text-[10px] flex items-center justify-between" style={{ color: 'var(--fate-text-muted)' }}>
                    <span>Последние {rollTrend.length} бросков</span>
                    <span>Наведите на точку для деталей</span>
                  </div>
                </div>
              )}
            </div>

            <Separator />

            {/* ── Section 3: Roll Distribution ────────────────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <TrendingUp className="size-4" style={{ color: 'var(--fate-accent)' }} />
                <h3 className="text-sm font-semibold fate-section-header pb-1.5" style={{ color: 'var(--fate-text)' }}>
                  Распределение бросков
                </h3>
              </div>

              {distribution.total === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-6 fate-card-static rounded-lg">
                  Нет данных
                </div>
              ) : (
                <div className="space-y-2.5">
                  {DISTRIBUTION.map(({ key, label, color }) => {
                    const count = distribution.counts[key];
                    const pct =
                      distribution.total > 0
                        ? Math.round((count / distribution.total) * 100)
                        : 0;
                    const barWidth = Math.max(pct, count > 0 ? 2 : 0);
                    return (
                      <div key={key} className="flex items-center gap-3">
                        <div className="w-16 text-xs text-muted-foreground text-right shrink-0">
                          {label}
                        </div>
                        <div
                          className="flex-1 h-5 rounded-md overflow-hidden relative"
                          style={{ backgroundColor: 'rgba(0,0,0,0.05)' }}
                        >
                          <div
                            className="h-full rounded-md transition-all duration-500"
                            style={{
                              width: `${barWidth}%`,
                              backgroundColor: color,
                            }}
                          />
                        </div>
                        <div className="w-20 text-xs font-medium shrink-0 flex items-center gap-1.5" style={{ color: 'var(--fate-text)' }}>
                          <span>{count}</span>
                          <span className="text-muted-foreground text-[10px]">({pct}%)</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <Separator />

            {/* ── Section 4: Most Active Characters ───────────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Users className="size-4" style={{ color: 'var(--fate-accent)' }} />
                <h3 className="text-sm font-semibold fate-section-header pb-1.5" style={{ color: 'var(--fate-text)' }}>
                  Самые активные
                </h3>
              </div>

              {topCharacters.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-6 fate-card-static rounded-lg">
                  Нет бросков
                </div>
              ) : (
                <div className="space-y-2">
                  {topCharacters.map((c, idx) => {
                    const isSuccess = c.type === 'player';
                    const successRate =
                      c.rolls > 0 ? Math.round((c.successes / c.rolls) * 100) : 0;
                    const maxRolls = topCharacters[0]?.rolls ?? 1;
                    const rollPct = maxRolls > 0 ? Math.round((c.rolls / maxRolls) * 100) : 0;
                    const medalColor = idx === 0 ? '#f39c12' : idx === 1 ? '#95a5a6' : idx === 2 ? '#cd7f32' : 'var(--fate-text-muted)';
                    return (
                      <div
                        key={c.characterId}
                        className="fate-card-static rounded-lg p-2.5 flex items-center gap-3 transition-all duration-200 hover:translate-x-0.5 hover:shadow-md"
                      >
                        <div className="flex items-center gap-2.5 flex-1 min-w-0">
                          <span
                            className="text-xs font-black w-5 text-center"
                            style={{ color: medalColor }}
                            title={idx === 0 ? '1 место' : idx === 1 ? '2 место' : idx === 2 ? '3 место' : undefined}
                          >
                            {idx + 1}
                          </span>
                          <div
                            className="size-8 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0 ring-2 ring-white/30"
                            style={{
                              backgroundColor: isSuccess ? '#e67e22' : '#27ae60',
                            }}
                          >
                            {(c.name || '?').charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5">
                              <div className="text-sm font-medium truncate" style={{ color: 'var(--fate-text)' }}>
                                {c.name}
                              </div>
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 h-4 shrink-0"
                              >
                                {c.type === 'player' ? 'Игрок' : 'NPC'}
                              </Badge>
                            </div>
                            {/* Roll-count progress bar — visualizes relative activity */}
                            <div className="mt-1 flex items-center gap-1.5">
                              <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--fate-border)' }}>
                                <div
                                  className="h-full rounded-full transition-all duration-500 ease-out"
                                  style={{
                                    width: `${rollPct}%`,
                                    background: isSuccess
                                      ? 'linear-gradient(90deg, var(--fate-accent), var(--fate-accent-dark))'
                                      : 'linear-gradient(90deg, var(--fate-success), var(--fate-success-dark))',
                                  }}
                                />
                              </div>
                              <span className="text-[10px] tabular-nums shrink-0" style={{ color: 'var(--fate-text-muted)' }}>
                                {c.rolls} брос.
                              </span>
                            </div>
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          <Badge
                            variant="secondary"
                            className="text-[10px] gap-1"
                          >
                            <Dice5 className="size-3" />
                            {c.rolls}
                          </Badge>
                          <Badge
                            className="text-[10px]"
                            style={{
                              backgroundColor:
                                successRate >= 60
                                  ? 'rgba(39, 174, 96, 0.15)'
                                  : successRate >= 30
                                    ? 'rgba(243, 156, 18, 0.15)'
                                    : 'rgba(231, 76, 60, 0.15)',
                              color:
                                successRate >= 60
                                  ? '#27ae60'
                                  : successRate >= 30
                                    ? '#f39c12'
                                    : '#e74c3c',
                              border: 'transparent',
                            }}
                            title="Доля успешных бросков"
                          >
                            {successRate}%
                          </Badge>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <Separator />

            {/* ── Section 5: Recent Activity Timeline ─────────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Clock className="size-4" style={{ color: 'var(--fate-accent)' }} />
                <h3 className="text-sm font-semibold fate-section-header pb-1.5" style={{ color: 'var(--fate-text)' }}>
                  Последняя активность
                </h3>
              </div>

              {recentEntries.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-6 fate-card-static rounded-lg">
                  Нет записей
                </div>
              ) : (
                <div className="relative pl-2">
                  {/* vertical line */}
                  <div
                    className="absolute left-[42px] top-1 bottom-1 w-px"
                    style={{ backgroundColor: 'var(--fate-border)' }}
                  />
                  <div className="space-y-2.5">
                    {recentEntries.map((entry) => {
                      const cat = categorizeEntry(entry);
                      const meta = DISTRIBUTION.find((d) => d.key === cat)!;
                      const isSystem = cat === 'system';
                      const name = isSystem
                        ? 'Система'
                        : entry.characterName || 'Без имени';
                      const desc =
                        entry.customText ||
                        entry.skillName ||
                        entry.result ||
                        '';
                      return (
                        <div key={entry.id} className="flex items-start gap-3">
                          <div className="w-9 text-[11px] text-muted-foreground font-mono shrink-0 pt-0.5 text-right">
                            {formatTime(entry.createdAt)}
                          </div>
                          <div
                            className="size-2.5 rounded-full shrink-0 mt-1.5 z-10 ring-2"
                            style={{
                              backgroundColor: meta.color,
                              boxShadow: `0 0 0 2px var(--fate-bg-card)`,
                            }}
                          />
                          <div className="flex-1 min-w-0 fate-card-static rounded-lg px-2.5 py-1.5">
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className="text-xs font-medium truncate"
                                style={{ color: 'var(--fate-text)' }}
                              >
                                {name}
                              </span>
                              <Badge
                                className="text-[9px] px-1.5 h-4"
                                style={{
                                  backgroundColor: `${meta.color}22`,
                                  color: meta.color,
                                  border: 'transparent',
                                }}
                              >
                                {meta.label}
                              </Badge>
                            </div>
                            {desc && (
                              <div className="text-[11px] text-muted-foreground truncate mt-0.5">
                                {desc}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <p className="text-[11px] text-muted-foreground/80 text-center pt-1">
                Полный лог доступен в правой панели
              </p>
            </div>

            <Separator />

            {/* ── Section 5b: Story Beats / Session Recap ─────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <BookMarked className="size-4" style={{ color: 'var(--fate-accent)' }} />
                <h3 className="text-sm font-semibold fate-section-header pb-1.5" style={{ color: 'var(--fate-text)' }}>
                  📖 Сюжетные события
                </h3>
                {conflictStats.started > 0 && (
                  <Badge
                    className="text-[9px] px-1.5 h-4 ml-auto shrink-0"
                    style={{
                      backgroundColor: 'rgba(231, 76, 60, 0.15)',
                      color: '#c0392b',
                      border: 'transparent',
                    }}
                    title="Конфликтов начато / завершено"
                  >
                    ⚔ {conflictStats.started} / {conflictStats.ended}
                  </Badge>
                )}
              </div>

              {storyBeats.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-4 fate-card-static rounded-lg">
                  Нет сюжетных событий
                </div>
              ) : (
                <div className="fate-card-static rounded-lg p-3 space-y-1.5 max-h-44 overflow-y-auto fate-scroll">
                  {storyBeats.map((entry, idx) => {
                    const text = entry.customText || entry.result || '';
                    // Pick an emoji based on content
                    let emoji = '•';
                    let accent = 'var(--fate-text-muted)';
                    if (text.includes('Начат') || text.includes('конфликт')) {
                      emoji = '⚔️';
                      accent = '#c0392b';
                    } else if (text.includes('завершён') || text.includes('Конфликт завершён')) {
                      emoji = '⏹️';
                      accent = '#7f8c8d';
                    } else if (text.includes('сцена') || text.includes('Сцена')) {
                      emoji = '🎬';
                      accent = '#8e44ad';
                    } else if (text.includes('кубик') || text.includes('бросок')) {
                      emoji = '🎲';
                      accent = '#f39c12';
                    } else if (text.includes('персонаж') || text.includes('добавлен')) {
                      emoji = '👤';
                      accent = '#2980b9';
                    }
                    return (
                      <div
                        key={entry.id}
                        className="flex items-start gap-2 text-xs animate-fade-in"
                        style={{ animationDelay: `${idx * 30}ms` }}
                      >
                        <span className="shrink-0 text-sm leading-tight">{emoji}</span>
                        <div className="flex-1 min-w-0">
                          <span
                            className="block leading-snug"
                            style={{ color: 'var(--fate-text)' }}
                          >
                            {text}
                          </span>
                          <span
                            className="text-[10px] font-mono"
                            style={{ color: 'var(--fate-text-muted)' }}
                          >
                            {formatTime(entry.createdAt)} • {formatDate(entry.createdAt)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              <p
                className="text-[10px] italic px-1"
                style={{ color: 'var(--fate-text-muted)' }}
              >
                💡 Краткий пересказ ключевых событий — удобно для начала следующей сессии
              </p>
            </div>

            <Separator />

            {/* ── Section 6: Fate Points Overview ─────────────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Sparkles className="size-4" style={{ color: 'var(--fate-accent)' }} />
                <h3 className="text-sm font-semibold fate-section-header pb-1.5" style={{ color: 'var(--fate-text)' }}>
                  ⭐ Очки судьбы
                </h3>
              </div>

              {fatePointsData.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-4 fate-card-static rounded-lg">
                  У всех персонажей стандартные очки судьбы
                </div>
              ) : (
                <div className="space-y-2">
                  {fatePointsData.map((c) => (
                    <div
                      key={c.id}
                      className="fate-card-static rounded-lg p-2.5 flex items-center gap-3"
                    >
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div
                          className="size-7 rounded-full flex items-center justify-center text-white font-bold text-xs shrink-0"
                          style={{
                            backgroundColor: c.type === 'player' ? '#e67e22' : '#27ae60',
                          }}
                        >
                          {(c.name || '?').charAt(0).toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <span className="text-sm font-medium truncate block" style={{ color: 'var(--fate-text)' }}>
                            {c.name}
                          </span>
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0 h-4 mt-0.5"
                          >
                            {c.type === 'player' ? 'Игрок' : 'NPC'}
                          </Badge>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span
                          className="text-sm font-bold font-mono"
                          style={{
                            color: c.fatePoints <= 1
                              ? '#e74c3c'
                              : c.fatePoints < c.refresh
                                ? '#f39c12'
                                : '#27ae60',
                          }}
                        >
                          FP: {c.fatePoints}/{c.refresh}
                        </span>
                        <div className="flex gap-0.5">
                          {Array.from({ length: Math.max(c.refresh, 1) }).map((_, i) => (
                            <div
                              key={i}
                              className="size-2 rounded-full"
                              style={{
                                backgroundColor: i < c.fatePoints
                                  ? '#f39c12'
                                  : 'rgba(0,0,0,0.12)',
                              }}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Separator />

            {/* ── Section 7: Session Duration Tracker ─────────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Timer className="size-4" style={{ color: 'var(--fate-accent)' }} />
                <h3 className="text-sm font-semibold fate-section-header pb-1.5" style={{ color: 'var(--fate-text)' }}>
                  ⏱ Сессия
                </h3>
              </div>

              {sessionDuration ? (
                <div className="fate-card-static rounded-lg p-3 flex items-center gap-4">
                  <div className="flex-1">
                    <div className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                      {sessionDuration.formatted}
                    </div>
                    <div className="text-[10px] text-muted-foreground/80 mt-0.5">
                      Длительность приключения
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold" style={{ color: 'var(--fate-accent)' }}>
                      {sessionDuration.sessionCount}
                    </div>
                    <div className="text-[10px] text-muted-foreground/80">
                      {sessionDuration.sessionCount === 1 ? 'сессия' : sessionDuration.sessionCount < 5 ? 'сессии' : 'сессий'}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-center text-xs text-muted-foreground py-4 fate-card-static rounded-lg">
                  Нет данных
                </div>
              )}
            </div>

            <Separator />

            {/* ── Section 8: Skill Usage Breakdown ─────────────── */}
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Target className="size-4" style={{ color: 'var(--fate-accent)' }} />
                <h3 className="text-sm font-semibold fate-section-header pb-1.5" style={{ color: 'var(--fate-text)' }}>
                  🎯 Популярные навыки
                </h3>
              </div>

              {skillUsage.length === 0 ? (
                <div className="text-center text-xs text-muted-foreground py-4 fate-card-static rounded-lg">
                  Нет бросков с навыками
                </div>
              ) : (
                <div className="space-y-2.5">
                  {skillUsage.map(({ name, count }) => {
                    const maxCount = skillUsage[0]?.count ?? 1;
                    const pct = Math.round((count / maxCount) * 100);
                    const barWidth = Math.max(pct, count > 0 ? 4 : 0);
                    return (
                      <div key={name} className="flex items-center gap-3">
                        <div className="w-28 text-xs text-muted-foreground text-right shrink-0 truncate" title={name}>
                          {name}
                        </div>
                        <div
                          className="flex-1 h-5 rounded-md overflow-hidden relative"
                          style={{ backgroundColor: 'rgba(0,0,0,0.05)' }}
                        >
                          <div
                            className="h-full rounded-md transition-all duration-500"
                            style={{
                              width: `${barWidth}%`,
                              background: 'linear-gradient(90deg, #f39c12, #e67e22)',
                            }}
                          />
                        </div>
                        <div className="w-8 text-xs font-medium shrink-0 text-right" style={{ color: 'var(--fate-text)' }}>
                          {count}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <Separator />

            {/* ── Section 9: Adventure metadata footer ────────── */}
            <div className="flex flex-wrap items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Calendar className="size-3.5" />
                <span>Создано: <span className="font-medium" style={{ color: 'var(--fate-text)' }}>{formatDate(currentAdventure.createdAt)}</span></span>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock className="size-3.5" />
                <span>Обновлено: <span className="font-medium" style={{ color: 'var(--fate-text)' }}>{formatDateTime(currentAdventure.updatedAt)}</span></span>
              </div>
            </div>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
