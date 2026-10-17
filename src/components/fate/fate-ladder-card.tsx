'use client';

import { useState } from 'react';
import { BarChart3, ChevronDown, ChevronUp } from 'lucide-react';

/**
 * Fate Ladder Reference Card
 *
 * A small, collapsible card showing the Fate RPG result ladder (+8 Legendary
 * down to -4 Nightmarish) with color-coded badges. Designed to sit at the
 * bottom of the scene panel so the GM can quickly look up roll meanings.
 *
 * Uses existing Fate CSS variables and helper classes (fate-card-static,
 * fate-scroll, animate-slide-down / animate-fade-in) for visual consistency.
 */

// ── Ladder data ────────────────────────────────────────────────────────
type LadderTier = 'legendary' | 'great' | 'average' | 'poor' | 'terrible';

interface LadderEntry {
  value: string;
  label: string;
  description: string;
  tier: LadderTier;
}

const LADDER: LadderEntry[] = [
  { value: '+8', label: 'Легендарный',     description: 'Совершенство, превосхождение обычного', tier: 'legendary' },
  { value: '+7', label: 'Эпический',        description: 'Героический масштаб',                  tier: 'legendary' },
  { value: '+6', label: 'Фантастический',   description: 'Выдающееся достижение',               tier: 'legendary' },
  { value: '+5', label: 'Сверхъестественный', description: 'Редкое мастерство',                 tier: 'legendary' },
  { value: '+4', label: 'Великий',          description: 'Экспертный уровень',                  tier: 'great' },
  { value: '+3', label: 'Хороший',          description: 'Профессиональный уровень',            tier: 'great' },
  { value: '+2', label: 'Умеренный',        description: 'Компетентный уровень',                tier: 'great' },
  { value: '+1', label: 'Средний',          description: 'Обычный уровень',                     tier: 'great' },
  { value: '+0', label: 'Посредственный',   description: 'Базовый уровень',                     tier: 'average' },
  { value: '-1', label: 'Слабый',           description: 'Ниже среднего',                       tier: 'poor' },
  { value: '-2', label: 'Ужасный',          description: 'Новичок',                             tier: 'poor' },
  { value: '-3', label: 'Катастрофический', description: 'Полная неудача',                      tier: 'terrible' },
  { value: '-4', label: 'Кошмарный',        description: 'Катастрофа',                          tier: 'terrible' },
];

// Each tier maps to a solid badge background (white text inside).
const TIER_BADGE_COLOR: Record<LadderTier, string> = {
  legendary: 'var(--fate-success-dark)',
  great:     'var(--fate-accent)',
  average:   'var(--fate-text-muted)',
  poor:      'var(--fate-danger)',
  terrible:  'var(--fate-danger-dark)',
};

export function FateLadderCard() {
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      className="fate-card-static rounded-lg p-3 w-full transition-all duration-200"
      style={{ backgroundColor: 'var(--fate-bg-card)' }}
    >
      {/* Header — click to toggle */}
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        aria-controls="fate-ladder-body"
        className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-black/5 dark:hover:bg-white/5"
        style={{ color: 'var(--fate-text)' }}
      >
        <span className="flex items-center gap-2 text-xs font-semibold">
          <BarChart3 className="size-3.5" style={{ color: 'var(--fate-accent)' }} />
          Лестница Fate
        </span>
        {expanded ? (
          <ChevronUp className="size-3.5" style={{ color: 'var(--fate-text-muted)' }} />
        ) : (
          <ChevronDown className="size-3.5" style={{ color: 'var(--fate-text-muted)' }} />
        )}
      </button>

      {/* Body — scrollable ladder list */}
      {expanded && (
        <div
          id="fate-ladder-body"
          className="mt-2 max-h-[280px] overflow-y-auto fate-scroll animate-slide-down"
        >
          <ul className="space-y-1">
            {LADDER.map((entry) => (
              <li
                key={entry.value}
                className="flex items-center gap-2 rounded-md px-1.5 py-1 transition-colors duration-150 hover:bg-black/5 dark:hover:bg-white/5"
              >
                {/* Colored value badge */}
                <span
                  className="inline-flex h-5 w-6 shrink-0 items-center justify-center rounded text-[11px] font-bold text-white shadow-sm"
                  style={{ backgroundColor: TIER_BADGE_COLOR[entry.tier] }}
                  aria-label={`Значение ${entry.value}`}
                >
                  {entry.value}
                </span>

                {/* Label + description */}
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span
                    className="truncate text-xs font-medium"
                    style={{ color: 'var(--fate-text)' }}
                  >
                    {entry.label}
                  </span>
                  <span
                    className="truncate text-[10px]"
                    style={{ color: 'var(--fate-text-muted)' }}
                  >
                    {entry.description}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
