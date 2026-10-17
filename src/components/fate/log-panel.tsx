'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, BarChart3, Download, FileJson, FileSpreadsheet, Filter, Plus, RefreshCw, Scroll, Trash2, TrendingUp, Wand2, Zap, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTheme } from 'next-themes';

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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFateStore } from '@/lib/store';
import { formatDiceSymbol, groupCrowdHelpers } from '@/lib/fate-dice';
import type { GroupedCrowdHelper, GroupRollParticipant, LogEntry, RollHelper, RollResultType } from '@/lib/types';
import { DiceChips } from '@/components/fate/dice-chips';

function getResultColor(type: RollResultType | string): string {
  switch (type) {
    case 'fail':
      return 'var(--fate-danger)';
    case 'tie':
      return '#e67e22';
    case 'success':
      return 'var(--fate-success)';
    case 'great':
      return '#1e8449';
    default:
      return 'var(--fate-text-muted)';
  }
}

function getResultBgColor(type: RollResultType | string, isDark: boolean): string {
  if (isDark) {
    switch (type) {
      case 'fail':
        return 'rgba(231, 76, 60, 0.18)';
      case 'tie':
        return 'rgba(230, 126, 34, 0.15)';
      case 'success':
        return 'rgba(46, 204, 113, 0.15)';
      case 'great':
        return 'rgba(30, 132, 73, 0.2)';
      default:
        return 'transparent';
    }
  }
  switch (type) {
    case 'fail':
      return 'rgba(231, 76, 60, 0.12)';
    case 'tie':
      return 'rgba(243, 156, 18, 0.12)';
    case 'success':
      return 'rgba(39, 174, 96, 0.12)';
    case 'great':
      return 'rgba(30, 132, 73, 0.15)';
    default:
      return 'transparent';
  }
}

function getResultBorderColor(type: RollResultType | string): string {
  switch (type) {
    case 'fail':
      return 'rgba(231, 76, 60, 0.35)';
    case 'tie':
      return 'rgba(243, 156, 18, 0.3)';
    case 'success':
      return 'rgba(39, 174, 96, 0.35)';
    case 'great':
      return 'rgba(30, 132, 73, 0.4)';
    default:
      return 'var(--fate-border)';
  }
}

function inferResultType(entry: LogEntry): RollResultType {
  // ── Opposed rolls: determine outcome by comparing totals ──
  // The `result` string for opposed rolls is localized like
  // "Атака: Успех (+N)" / "Защита: Успех (+N)" / "Ничья" — but from the
  // attacker's perspective, "Защита: Успех" means the attack FAILED.
  // Per user request, the log highlight should reflect the attacker's
  // outcome: green when the attacker wins, red when they lose.
  if (entry.opponentTotal != null) {
    if (entry.total > entry.opponentTotal) {
      const shifts = entry.total - entry.opponentTotal;
      return shifts >= 3 ? 'great' : 'success';
    }
    if (entry.total === entry.opponentTotal) return 'tie';
    return 'fail';
  }
  // ── Difficulty rolls: compare total vs difficulty ──
  if (entry.difficulty != null) {
    if (entry.total > entry.difficulty) {
      const shifts = entry.total - entry.difficulty;
      return shifts >= 3 ? 'great' : 'success';
    }
    if (entry.total === entry.difficulty) return 'tie';
    return 'fail';
  }

  const r = entry.result || '';
  // Standard result labels (non-opposed, non-difficulty)
  if (r.includes('Провал')) return 'fail';
  if (r.includes('Ничья')) return 'tie';
  if (r.includes('стилем')) return 'great';
  if (r.includes('Успех')) return 'success';
  // Fallback: "Результат: +N" / "Результат: -N" / "Результат: 0"
  // These are used for rolls without a difficulty/opponent
  if (r.startsWith('Результат')) {
    if (entry.total >= 4) return 'great';
    if (entry.total >= 1) return 'success';
    if (entry.total === 0) return 'tie';
    return 'fail';
  }
  // Magic/conflict system messages — not rolls, stay neutral
  return 'tie';
}

function formatTimestamp(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// Full timestamp for tooltip hover — "DD.MM.YYYY HH:MM:SS"
function formatFullTimestamp(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}:${ss}`;
  } catch {
    return '';
  }
}

// ── Rich HTML tooltip for log entries ─────────────────────────
// Shows a structured breakdown: Character · Roll · Skill · Bonus · Helpers · Aspect invoke · Final
// For opposed rolls, renders two columns (attacker vs defender) side by side.
function LogEntryTooltip({ entry, isDark }: { entry: LogEntry; isDark: boolean }) {
  // Only show for actual rolls (with dice results OR group-roll entries)
  if (!entry.diceResults?.length && !(entry.groupRollResults?.length)) return null;

  // Dice breakdown
  const diceStr = entry.diceResults.map((d) => formatDiceSymbol(d)).join(' ');
  const diceSum = entry.diceResults.reduce((s, d) => s + d, 0);

  // Skill value (raw, e.g. +4 for Athletics +4)
  const skillValue = entry.skillValue ?? null;
  // Manual bonus (added in roll dialog before rolling). Per user request the
  // bonus block shows ONLY this value — no fallback to the legacy extraBonus
  // field. If the user didn't add a manual bonus, the block is hidden.
  const manualBonus = entry.manualBonus ?? 0;
  // Helpers (joint effort) — always shown when present, even if a helper
  // contributed +0 (so players see who participated).
  const helpers: RollHelper[] = entry.helpers ?? [];
  // Aspect invoke bonus (added via right-click on log)
  const aspectInvokeBonus = entry.aspectInvokeBonus ?? 0;
  const aspectInvokeReason = entry.aspectInvokeReason ?? '';
  const aspectRerolled = entry.aspectRerolled ?? false;

  // Backward-compat fallback for the ASPECT INVOKE section only (old entries
  // stored aspect invokes in extraBonus). The bonus block above does NOT use
  // this fallback — it only reflects the true manualBonus.
  const effectiveAspectBonus = aspectInvokeBonus !== 0
    ? aspectInvokeBonus
    : (manualBonus === 0 && entry.extraBonus > 0 && entry.extraBonusReason && entry.extraBonusReason !== 'Ситуативный бонус' ? entry.extraBonus : 0);
  const effectiveAspectReason = aspectInvokeReason || (effectiveAspectBonus !== 0 ? entry.extraBonusReason : '');

  // Opponent breakdown (if opposed roll)
  const hasOpponent = !!entry.opponentDiceResults?.length && entry.opponentName;
  const oppDiceStr = hasOpponent
    ? entry.opponentDiceResults.map((d) => formatDiceSymbol(d)).join(' ')
    : '';
  const oppDiceSum = hasOpponent
    ? entry.opponentDiceResults.reduce((s, d) => s + d, 0)
    : 0;

  const showBonusSection = manualBonus !== 0;
  const showHelpersSection = helpers.length > 0;
  const showAspectSection = effectiveAspectBonus !== 0 || aspectRerolled;

  // Defender (opponent) crowd helpers — only relevant for opposed rolls where
  // the defender is a crowd with team-effort enabled.
  const opponentHelpers: RollHelper[] = entry.opponentHelpers ?? [];
  const showOpponentHelpersSection = opponentHelpers.length > 0;

  // Pre-compute grouped helper buckets so the tooltip shows one compact row
  // per creature TYPE (e.g. "Гоблин ×2  +2", "Волк ×3  0") instead of one
  // row per individual member. This keeps big crowds readable.
  const helperGroups: GroupedCrowdHelper[] = groupCrowdHelpers(helpers);
  const opponentHelperGroups: GroupedCrowdHelper[] = groupCrowdHelpers(opponentHelpers);

  /**
   * Render a compact, grouped list of crowd helpers.
   * Each row: "<Type> ×<count>  <Skill> <+val>  ...  <+total>"
   * Non-contributing types (total 0) are shown in a muted color so it's
   * immediately clear who helped and who didn't.
   */
  const renderGroupedHelpers = (groups: GroupedCrowdHelper[]) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {groups.map((g, idx) => {
        const contributes = g.totalBonus > 0;
        return (
          <div
            key={idx}
            style={{
              ...valueStyle,
              display: 'flex',
              justifyContent: 'space-between',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, flex: 1 }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 700 }}>
                {g.typeLabel}
              </span>
              <span style={{ fontSize: 10, fontWeight: 600, color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)', flexShrink: 0 }}>
                ×{g.count}
              </span>
              {g.skillName && (
                <span style={{ fontSize: 10, color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)', flexShrink: 0 }}>
                  {g.skillName}{g.skillValue !== undefined ? ` ${g.skillValue >= 0 ? '+' : ''}${g.skillValue}` : ''}
                </span>
              )}
            </span>
            <span
              style={{
                color: contributes ? '#27ae60' : (isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'),
                fontWeight: 800,
                flexShrink: 0,
                fontSize: 13,
              }}
            >
              {contributes ? `+${g.totalBonus}` : '0'}
            </span>
          </div>
        );
      })}
    </div>
  );

  const separator = (
    <div
      style={{
        height: 1,
        background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
        margin: '6px 0',
      }}
    />
  );

  const sectionTitleStyle: React.CSSProperties = {
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)',
    marginBottom: 2,
  };
  const valueStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: isDark ? '#e8eaed' : '#2c2c2c',
  };

  const totalColor = (t: number) =>
    t >= 4 ? '#1e8449' : t >= 1 ? '#27ae60' : t === 0 ? '#e67e22' : '#e74c3c';

  // ── Opposed roll: two-column layout ──
  if (hasOpponent) {
    const attackerTotal = entry.total;
    const defenderTotal = entry.opponentTotal ?? 0;
    const winner =
      attackerTotal > defenderTotal ? entry.characterName
        : attackerTotal < defenderTotal ? entry.opponentName
        : null;
    return (
      <div
        className="fate-log-tooltip"
        style={{
          minWidth: 360,
          maxWidth: 460,
          padding: '10px 12px',
          borderRadius: 8,
          background: isDark ? '#1a1d23' : '#ffffff',
          border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
          boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
          fontSize: 12,
          color: isDark ? '#e8eaed' : '#2c2c2c',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        <div style={{ fontSize: 11, fontWeight: 800, color: '#e67e22', marginBottom: 8, letterSpacing: '0.04em' }}>
          ⚔ Соревновательный бросок
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          {/* Attacker column */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4, color: isDark ? '#fff' : '#000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {entry.characterName || 'Бросающий'}
            </div>
            <div style={sectionTitleStyle}>Бросок</div>
            <div style={{ ...valueStyle, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
              <DiceChips dice={entry.diceResults} size="md" />
              <span style={{ color: isDark ? '#aaa' : '#666' }}>= {diceSum >= 0 ? `+${diceSum}` : diceSum}</span>
            </div>
            {entry.skillName && (
              <div style={{ ...valueStyle, marginTop: 4 }}>
                <span style={sectionTitleStyle}>Навык</span>
                <div>
                  {entry.skillName}
                  {skillValue !== null && (
                    <span style={{ marginLeft: 4, color: '#e67e22', fontWeight: 700 }}>+{skillValue}</span>
                  )}
                </div>
              </div>
            )}
            {showBonusSection && (
              <div style={{ marginTop: 4 }}>
                <span style={sectionTitleStyle}>Бонус</span>
                <div style={{ ...valueStyle, fontWeight: 800, color: manualBonus > 0 ? '#27ae60' : '#e74c3c' }}>
                  {manualBonus > 0 ? '+' : ''}{manualBonus}
                </div>
              </div>
            )}
            {/* Crowd helpers — inline in the attacker's calculation block
                so it's clear the total includes their contribution. */}
            {showHelpersSection && (
              <div style={{ marginTop: 4 }}>
                <div style={{ ...sectionTitleStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span>🤝 Толпа</span>
                  <span style={{ color: '#c0392b', fontWeight: 800, fontSize: 11 }}>
                    +{helpers.reduce((s, h) => s + h.bonus, 0)}
                  </span>
                </div>
                {renderGroupedHelpers(helperGroups)}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <span style={sectionTitleStyle}>Итог</span>
              <div style={{ fontSize: 20, fontWeight: 900, color: totalColor(attackerTotal), fontFamily: 'monospace' }}>
                {attackerTotal}
              </div>
            </div>
          </div>

          {/* Divider */}
          <div style={{ width: 1, background: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }} />

          {/* Defender column */}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 4, color: isDark ? '#fff' : '#000', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {entry.opponentName}
            </div>
            <div style={sectionTitleStyle}>Бросок</div>
            <div style={{ ...valueStyle, fontSize: 13, fontFamily: 'monospace', letterSpacing: 1 }}>
              <span style={{ fontSize: 15 }}>{oppDiceStr}</span>
              <span style={{ marginLeft: 4, color: isDark ? '#aaa' : '#666' }}>= {oppDiceSum >= 0 ? `+${oppDiceSum}` : oppDiceSum}</span>
            </div>
            {entry.opponentSkillName && (
              <div style={{ ...valueStyle, marginTop: 4 }}>
                <span style={sectionTitleStyle}>Навык</span>
                <div>
                  {entry.opponentSkillName}
                  {entry.opponentSkillValue != null && (
                    <span style={{ marginLeft: 4, color: '#e67e22', fontWeight: 700 }}>
                      +{entry.opponentSkillValue}
                    </span>
                  )}
                </div>
              </div>
            )}
            {(entry.opponentManualBonus ?? 0) !== 0 && (
              <div style={{ marginTop: 4 }}>
                <span style={sectionTitleStyle}>Бонус</span>
                <div style={{ ...valueStyle, fontWeight: 800, color: '#27ae60' }}>
                  +{entry.opponentManualBonus}
                </div>
              </div>
            )}
            {/* Defender crowd helpers — inline in the defender's calculation block */}
            {showOpponentHelpersSection && (
              <div style={{ marginTop: 4 }}>
                <div style={{ ...sectionTitleStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <span>🤝 Толпа</span>
                  <span style={{ color: '#c0392b', fontWeight: 800, fontSize: 11 }}>
                    +{opponentHelpers.reduce((s, h) => s + h.bonus, 0)}
                  </span>
                </div>
                {renderGroupedHelpers(opponentHelperGroups)}
              </div>
            )}
            <div style={{ marginTop: 6 }}>
              <span style={sectionTitleStyle}>Итог</span>
              <div style={{ fontSize: 20, fontWeight: 900, color: totalColor(defenderTotal), fontFamily: 'monospace' }}>
                {defenderTotal}
              </div>
            </div>
          </div>
        </div>

        {/* Aspect invoke (full width) — shown only when present. */}
        {showAspectSection && separator}
        {showAspectSection && (
          <div>
            <div style={sectionTitleStyle}>Призыв аспекта</div>
            {effectiveAspectBonus !== 0 && (
              <div style={{ ...valueStyle, color: '#e67e22', fontWeight: 700 }}>
                Бонус {effectiveAspectBonus > 0 ? '+' : ''}{effectiveAspectBonus}
                {effectiveAspectReason && (
                  <span style={{ marginLeft: 6, color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)', fontWeight: 500, fontStyle: 'italic' }}>
                    · {effectiveAspectReason}
                  </span>
                )}
              </div>
            )}
            {aspectRerolled && (
              <div style={{ ...valueStyle, color: '#9b59b6', fontWeight: 700 }}>↻ Переброс</div>
            )}
          </div>
        )}

        {/* Winner footer */}
        {separator}
        <div style={{ ...valueStyle, textAlign: 'center', fontWeight: 800, fontSize: 13 }}>
          {winner ? (
            <span style={{ color: '#27ae60' }}>🏆 Победил: {winner}</span>
          ) : (
            <span style={{ color: '#e67e22' }}>🤝 Ничья</span>
          )}
        </div>
      </div>
    );
  }

  // ── Group roll (P2P synchronized dice roll) layout ──
  // Rendered when entry.groupRollResults is populated. Shows one row per
  // participant with their dice + skill + bonus + total, sorted by total
  // desc (already sorted at write time, but we re-sort defensively).
  if (entry.groupRollResults && entry.groupRollResults.length > 0) {
    const participants: GroupRollParticipant[] = [...entry.groupRollResults]
      .sort((a, b) => b.total - a.total);
    const best = participants[0];
    return (
      <div
        className="fate-log-tooltip"
        style={{
          minWidth: 280,
          maxWidth: 380,
          padding: '10px 12px',
          borderRadius: 8,
          background: isDark ? '#1a1d23' : '#ffffff',
          border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
          boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
          fontSize: 12,
          color: isDark ? '#e8eaed' : '#2c2c2c',
          fontFamily: 'system-ui, sans-serif',
        }}
      >
        {/* Header: ⚡ Групповой бросок · skill name + (difficulty/bonus) */}
        <div style={{ fontSize: 11, fontWeight: 800, color: '#9b59b6', marginBottom: 8, letterSpacing: '0.04em' }}>
          ⚡ Групповой бросок
          <span style={{ marginLeft: 6, color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.55)', fontWeight: 600 }}>
            {entry.skillName}
            {entry.difficulty != null && ` · сложность ${entry.difficulty}`}
            {entry.bonus !== 0 && ` · бонус ${entry.bonus > 0 ? '+' : ''}${entry.bonus}`}
          </span>
        </div>

        {/* One row per participant */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {participants.map((p, idx) => {
            const pDiceSum = p.dice.reduce((s, d) => s + d, 0);
            const isBest = idx === 0 && participants.length > 1;
            return (
              <div
                key={idx}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '3px 4px',
                  borderRadius: 4,
                  backgroundColor: isBest
                    ? 'rgba(155, 89, 182, 0.06)'
                    : 'transparent',
                }}
              >
                {/* Character name */}
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: isDark ? '#fff' : '#000',
                    minWidth: 64,
                    maxWidth: 110,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {p.characterName}
                </span>
                {/* Dice chips */}
                <DiceChips dice={p.dice} size="sm" />
                {/* Skill value + bonus (compact) */}
                <span style={{ fontSize: 10, color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)', fontFamily: 'monospace' }}>
                  ({pDiceSum >= 0 ? '+' : ''}{pDiceSum}
                  {p.skillValue !== 0 && ` +${p.skillValue}`}
                  {p.bonus !== p.skillValue && p.bonus - p.skillValue !== 0 && ` +${p.bonus - p.skillValue}`}
                  )
                </span>
                {/* Total */}
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 15,
                    fontWeight: 900,
                    fontFamily: 'monospace',
                    color: totalColor(p.total),
                  }}
                >
                  {p.total >= 0 ? '+' : ''}{p.total}
                </span>
              </div>
            );
          })}
        </div>

        {/* Footer — best participant's outcome */}
        {separator}
        <div style={{ ...valueStyle, textAlign: 'center', fontWeight: 800, fontSize: 13 }}>
          {entry.result ? (
            <span style={{ color: totalColor(best.total) }}>
              Лучший: {best.characterName} ({best.total >= 0 ? '+' : ''}{best.total}) · {entry.result}
            </span>
          ) : (
            <span style={{ color: totalColor(best.total) }}>
              Лучший: {best.characterName} ({best.total >= 0 ? '+' : ''}{best.total})
            </span>
          )}
        </div>
      </div>
    );
  }

  // ── Standard (non-opposed) layout ──
  return (
    <div
      className="fate-log-tooltip"
      style={{
        minWidth: 220,
        maxWidth: 320,
        padding: '10px 12px',
        borderRadius: 8,
        background: isDark ? '#1a1d23' : '#ffffff',
        border: `1px solid ${isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'}`,
        boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
        fontSize: 12,
        color: isDark ? '#e8eaed' : '#2c2c2c',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      {/* Character name (title) */}
      <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 6, color: isDark ? '#fff' : '#000' }}>
        {entry.characterName || 'Бросок'}
      </div>

      {/* Roll section — the calculation block.
          Бросок / Навык / Бонус / 🤝 Толпа flow as a single calculation,
          without separators between them, so it's clear they all sum into
          the Итог below. A separator only appears before "Призыв аспекта"
          (which is a separate, post-roll modification) and before the Итог. */}
      <div style={sectionTitleStyle}>Бросок</div>
      <div style={{ ...valueStyle, fontSize: 14, display: 'flex', alignItems: 'center', gap: 8 }}>
        <DiceChips dice={entry.diceResults} size="md" />
        <span style={{ color: isDark ? '#aaa' : '#666' }}>= {diceSum >= 0 ? `+${diceSum}` : diceSum}</span>
      </div>

      {/* Skill section — name + level (part of the calculation block) */}
      {entry.skillName && (
        <div style={{ marginTop: 4 }}>
          <span style={sectionTitleStyle}>Навык</span>
          <div style={valueStyle}>
            {entry.skillName}
            {skillValue !== null && (
              <span style={{ marginLeft: 6, color: '#e67e22', fontWeight: 700 }}>
                +{skillValue}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Bonus section — manual bonus (part of the calculation block) */}
      {showBonusSection && (
        <div style={{ marginTop: 4 }}>
          <span style={sectionTitleStyle}>Бонус</span>
          <div style={{ ...valueStyle, fontSize: 14, fontWeight: 800, color: manualBonus > 0 ? '#27ae60' : '#e74c3c' }}>
            {manualBonus > 0 ? '+' : ''}{manualBonus}
          </div>
        </div>
      )}

      {/* Crowd helpers — part of the calculation block (no separator before
          it), so the tooltip reads as: Бросок + Навык + Бонус + Толпа = Итог.
          Helpers are grouped by creature type for compactness. */}
      {showHelpersSection && (
        <div style={{ marginTop: 4 }}>
          <div style={{ ...sectionTitleStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span>🤝 Толпа</span>
            <span style={{ color: '#c0392b', fontWeight: 800, fontSize: 11 }}>
              +{helpers.reduce((s, h) => s + h.bonus, 0)}
            </span>
          </div>
          {renderGroupedHelpers(helperGroups)}
        </div>
      )}

      {/* Calculation formula — small breakdown showing how the total was
          computed, e.g. "= 2 + 2 + 2". Makes the math fully transparent. */}
      {(() => {
        const parts: { label: string; value: number }[] = [];
        parts.push({ label: 'Бросок', value: diceSum });
        if (skillValue !== null) parts.push({ label: 'Навык', value: skillValue });
        if (showBonusSection) parts.push({ label: 'Бонус', value: manualBonus });
        if (showHelpersSection) {
          parts.push({ label: 'Толпа', value: helpers.reduce((s, h) => s + h.bonus, 0) });
        }
        // Only show the formula if there's more than one component
        if (parts.length <= 1) return null;
        return (
          <div style={{ marginTop: 6, fontSize: 10, color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)', fontFamily: 'monospace', letterSpacing: 0.3 }}>
            {parts.map((p, i) => (
              <span key={i}>
                {i > 0 ? ' + ' : ''}
                {p.value >= 0 ? '+' : ''}{p.value}
              </span>
            ))}
            <span style={{ marginLeft: 4, color: totalColor(entry.total), fontWeight: 700 }}>
              = {entry.total}
            </span>
          </div>
        );
      })()}

      {/* Aspect invoke section — separate from the main calculation */}
      {showAspectSection && (
        <>
          {separator}
          <div style={sectionTitleStyle}>Призыв аспекта</div>
          {effectiveAspectBonus !== 0 && (
            <div style={{ ...valueStyle, color: '#e67e22', fontWeight: 700 }}>
              Бонус от призыва {effectiveAspectBonus > 0 ? '+' : ''}{effectiveAspectBonus}
              {effectiveAspectReason && (
                <span style={{ marginLeft: 6, color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)', fontWeight: 500, fontStyle: 'italic' }}>
                  · {effectiveAspectReason}
                </span>
              )}
            </div>
          )}
          {aspectRerolled && (
            <div style={{ ...valueStyle, color: '#9b59b6', fontWeight: 700 }}>
              ↻ Переброс
            </div>
          )}
        </>
      )}

      {/* Final value — a single number, no duplicate below */}
      {separator}
      <div style={sectionTitleStyle}>Итоговое значение</div>
      <div style={{
        fontSize: 22,
        fontWeight: 900,
        color: totalColor(entry.total),
        fontFamily: 'monospace',
      }}>
        {entry.total}
      </div>
    </div>
  );
}

// Relative time-ago label ("только что", "5 мин назад", "2 ч назад") —
// only returns a non-empty string for entries from today.
function formatTimeAgo(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const isSameDay =
      date.getFullYear() === now.getFullYear() &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();
    if (!isSameDay) return '';

    const diffSec = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
    if (diffSec < 10) return 'только что';
    if (diffSec < 60) return `${diffSec} сек назад`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) {
      const word = diffMin === 1
        ? 'минуту'
        : diffMin >= 2 && diffMin <= 4
          ? 'минуты'
          : 'минут';
      return `${diffMin} ${word} назад`;
    }
    const diffHr = Math.floor(diffMin / 60);
    const word = diffHr === 1
      ? 'час'
      : diffHr >= 2 && diffHr <= 4
        ? 'часа'
        : 'часов';
    return `${diffHr} ${word} назад`;
  } catch {
    return '';
  }
}

// Check if entry is a "roll" entry (has dice results and not a system message)
function isRollEntry(entry: LogEntry): boolean {
  // Magic card draws are rendered as their own card block — exclude them
  // from the generic "roll" treatment so they don't pollute roll statistics
  // or get a misleading result color.
  if (entry.isMagicRoll) return false;
  // Group roll (P2P) entries are roll entries — they have aggregate result
  // info and a structured participant list in `groupRollResults`.
  if (entry.groupRollResults && entry.groupRollResults.length > 0) return true;
  return Boolean(
    (entry.diceResults &&
    entry.diceResults.length > 0 &&
    entry.diceResults.some((d) => d !== 0)) || // exclude pure 0s if it's a system message
    (entry.diceResults.length > 0 && entry.result && entry.result.match(/Успех|Провал|Ничья|стилем|Результат/))
  );
}

// ── CSV helper: escape a value for semicolon-delimited CSV ──
function escapeCsvValue(value: string | null | undefined): string {
  if (value == null) return '';
  const str = String(value);
  // If the value contains a semicolon, quote, or newline — wrap in quotes and escape inner quotes
  if (str.includes(';') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// ── Format date for export filename ──
function formatExportDate(): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  return `${dd}${mm}${yyyy}-${hh}${mi}`;
}

// ── Format date for CSV rows (DD.MM.YYYY HH:MM) ──
function formatCsvDate(dateStr: string): string {
  try {
    const date = new Date(dateStr);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    return `${dd}.${mm}.${yyyy} ${hh}:${mi}`;
  } catch {
    return '';
  }
}

// ── Download helper ──
function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function LogPanel() {
  const { logEntries, clearLog, adventures, currentAdventureId, rerollLogEntry, addBonusToLogEntry, canRerollLog, canEditAdventure } = useFateStore();
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  // ── Access control ──
  // Reroll/bonus actions are host/local only. Network players still see the
  // full log (read-only) but cannot modify past entries.
  const canReroll = canRerollLog();
  // Clearing the log is a destructive adventure-level action — only host/local.
  const canClear = canEditAdventure();
  const [statsOpen, setStatsOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | RollResultType | 'system'>('all');
  const [search, setSearch] = useState('');

  // ── Rich tooltip state (HTML hover popover for log entries) ──
  const [hoveredTooltip, setHoveredTooltip] = useState<{
    entry: LogEntry;
    x: number;
    y: number;
  } | null>(null);
  const tooltipHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showTooltipFor = useCallback((entry: LogEntry, clientX: number, clientY: number) => {
    if (tooltipHideTimer.current) {
      clearTimeout(tooltipHideTimer.current);
      tooltipHideTimer.current = null;
    }
    // Opposed-roll tooltips are wider (two columns) — reserve more horizontal
    // space so they don't overflow the right edge of the viewport.
    const isOpposed = !!entry.opponentDiceResults?.length && !!entry.opponentName;
    const tooltipWidth = isOpposed ? 480 : 340;
    const x = Math.min(clientX + 14, window.innerWidth - tooltipWidth);
    const y = Math.min(clientY + 14, window.innerHeight - 400);
    setHoveredTooltip({ entry, x, y });
  }, []);
  const hideTooltipSoon = useCallback((delay = 120) => {
    if (tooltipHideTimer.current) clearTimeout(tooltipHideTimer.current);
    tooltipHideTimer.current = setTimeout(() => setHoveredTooltip(null), delay);
  }, []);
  const cancelHideTooltip = useCallback(() => {
    if (tooltipHideTimer.current) {
      clearTimeout(tooltipHideTimer.current);
      tooltipHideTimer.current = null;
    }
  }, []);

  // ── Context menu state (right-click on log entries) ──
  const [contextMenu, setContextMenu] = useState<{
    entryId: string;
    x: number;
    y: number;
    characterId: string;
    characterName: string;
    opponentName: string | null;
    opponentType: string | null;
    opponentCharacterId: string | null;
  } | null>(null);

  // ── Bonus dialog state ──
  const [bonusDialog, setBonusDialog] = useState<{
    entryId: string;
    target: 'attacker' | 'defender';
    targetName: string;
  } | null>(null);
  const [bonusAmount, setBonusAmount] = useState(2);
  const [bonusReason, setBonusReason] = useState('Призыв аспекта');

  // Scroll state
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLElement | null>(null);
  const isAtTop = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // Find the ScrollArea viewport and attach scroll listener
  useEffect(() => {
    const root = scrollAreaRef.current;
    if (!root) return;

    const findViewport = (): HTMLElement | null =>
      root.querySelector(
        '[data-slot="scroll-area-viewport"], [data-radix-scroll-area-viewport]'
      ) as HTMLElement | null;

    let viewport = findViewport();
    if (viewport) {
      viewportRef.current = viewport;
    }

    const handleScroll = () => {
      const vp = viewportRef.current;
      if (!vp) return;
      const atTop = vp.scrollTop <= 40;
      isAtTop.current = atTop;
      setShowScrollButton(!atTop);
    };

    if (viewport) {
      viewport.addEventListener('scroll', handleScroll, { passive: true });
      return () => viewport.removeEventListener('scroll', handleScroll);
    }

    let attached = false;
    const observer = new MutationObserver(() => {
      const vp = findViewport();
      if (vp && !attached) {
        attached = true;
        viewportRef.current = vp;
        vp.addEventListener('scroll', handleScroll, { passive: true });
        observer.disconnect();
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      if (attached && viewportRef.current) {
        viewportRef.current.removeEventListener('scroll', handleScroll);
      }
    };
  }, []);

  // Auto-scroll to top when new entries arrive (since newest are at top)
  useEffect(() => {
    if (!isAtTop.current) return;
    const vp = viewportRef.current;
    if (!vp) {
      const root = scrollAreaRef.current;
      if (root) {
        const found = root.querySelector(
          '[data-slot="scroll-area-viewport"], [data-radix-scroll-area-viewport]'
        ) as HTMLElement | null;
        if (found) viewportRef.current = found;
      }
    }
    const viewport = viewportRef.current;
    if (!viewport) return;
    requestAnimationFrame(() => {
      viewport.scrollTop = 0;
    });
  }, [logEntries, filter, search]);

  // Scroll to top handler for the floating button
  const scrollToTop = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    vp.scrollTo({ top: 0, behavior: 'smooth' });
    isAtTop.current = true;
    setShowScrollButton(false);
  }, []);

  // Get current adventure name for export filenames
  const adventureName = adventures.find((a) => a.id === currentAdventureId)?.name ?? 'adventure';

  // ── Export to JSON ──
  const exportJson = useCallback(() => {
    try {
      const data = {
        format: 'fate-rpg-log-v1',
        version: 1,
        exportedAt: new Date().toISOString(),
        adventureName,
        totalEntries: logEntries.length,
        entries: logEntries,
      };
      const content = JSON.stringify(data, null, 2);
      const filename = `fate-log-${adventureName}-${formatExportDate()}.json`;
      downloadFile(content, filename, 'application/json;charset=utf-8');
      toast.success('Лог экспортирован в JSON', { description: `${logEntries.length} записей` });
    } catch {
      toast.error('Ошибка экспорта', { description: 'Не удалось экспортировать лог в JSON' });
    }
  }, [logEntries, adventureName]);

  // ── Export to CSV ──
  const exportCsv = useCallback(() => {
    try {
      const BOM = '\uFEFF'; // UTF-8 BOM for Excel compatibility
      const headers = ['Дата', 'Персонаж', 'Навык', 'Кубики', 'Бонус', 'Итого', 'Результат', 'Сложность', 'Оппонент', 'Описание', 'Карта магии', 'Эффект магии', 'Зона магии', 'Групповой бросок'];
      const rows = logEntries.map((entry) => {
        const diceStr = entry.diceResults?.length
          ? `[${entry.diceResults.map((d) => (d >= 0 ? `+${d}` : String(d))).join(',')}]`
          : '';
        const totalStr = entry.total != null ? String(entry.total) : '';
        const bonusStr = entry.bonus != null ? String(entry.bonus) : '';
        const groupStr = entry.groupRollResults?.length
          ? entry.groupRollResults.map((p) => `${p.characterName} ${p.total >= 0 ? '+' : ''}${p.total}`).join(' | ')
          : '';
        return [
          formatCsvDate(entry.createdAt),
          entry.characterName || '',
          entry.skillName || '',
          diceStr,
          bonusStr,
          totalStr,
          entry.result || '',
          entry.difficulty != null ? String(entry.difficulty) : '',
          entry.opponentName || '',
          entry.customText || '',
          entry.magicCardName || '',
          entry.magicEffect || '',
          entry.magicZoneName || '',
          groupStr,
        ].map(escapeCsvValue).join(';');
      });
      const content = BOM + [headers.join(';'), ...rows].join('\n');
      const filename = `fate-log-${adventureName}-${formatExportDate()}.csv`;
      downloadFile(content, filename, 'text/csv;charset=utf-8');
      toast.success('Лог экспортирован в CSV', { description: `${logEntries.length} записей` });
    } catch {
      toast.error('Ошибка экспорта', { description: 'Не удалось экспортировать лог в CSV' });
    }
  }, [logEntries, adventureName]);

  // logEntries is stored in DESC order (newest first, matching the API).
  // Display as-is so new rolls appear at the top both live and after refresh.
  const sortedEntries = logEntries;

  // Apply filter + search
  const filteredEntries = useMemo(() => {
    let list = sortedEntries;
    if (filter === 'system') {
      list = list.filter((e) => !isRollEntry(e));
    } else if (filter !== 'all') {
      list = list.filter((e) => isRollEntry(e) && inferResultType(e) === filter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(
        (e) =>
          (e.characterName ?? '').toLowerCase().includes(q) ||
          (e.skillName ?? '').toLowerCase().includes(q) ||
          (e.result ?? '').toLowerCase().includes(q) ||
          (e.customText ?? '').toLowerCase().includes(q) ||
          (e.magicCardName ?? '').toLowerCase().includes(q) ||
          (e.magicEffect ?? '').toLowerCase().includes(q) ||
          (e.magicZoneName ?? '').toLowerCase().includes(q),
      );
    }
    return list;
  }, [sortedEntries, filter, search]);

  // Compute counts per filter for badge display
  const filterCounts = useMemo(() => {
    const counts = { all: logEntries.length, fail: 0, tie: 0, success: 0, great: 0, system: 0 };
    for (const e of logEntries) {
      if (isRollEntry(e)) {
        counts[inferResultType(e)]++;
      } else {
        counts.system++;
      }
    }
    return counts;
  }, [logEntries]);

  // Compute roll statistics
  const stats = useMemo(() => {
    const rolls = logEntries.filter(isRollEntry);
    if (rolls.length === 0) {
      return { total: 0, successRate: 0, best: null, worst: null, byType: { fail: 0, tie: 0, success: 0, great: 0 }, avgTotal: 0 };
    }
    const byType = { fail: 0, tie: 0, success: 0, great: 0 };
    let best: LogEntry | null = null;
    let worst: LogEntry | null = null;
    let sumTotal = 0;
    for (const r of rolls) {
      const t = inferResultType(r);
      byType[t]++;
      if (best === null || r.total > best.total) best = r;
      if (worst === null || r.total < worst.total) worst = r;
      sumTotal += r.total;
    }
    const successRate = ((byType.success + byType.great) / rolls.length) * 100;
    return {
      total: rolls.length,
      successRate,
      best,
      worst,
      byType,
      avgTotal: sumTotal / rolls.length,
    };
  }, [logEntries]);

  return (
    <div className="flex flex-col h-full fate-bg-texture relative overflow-hidden">
      {/* Section Header */}
      <div
        className="fate-log-header flex items-center justify-between px-3 py-2.5"
        style={{ borderColor: 'var(--fate-border)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="fate-icon-circle text-sm"
            style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
          >
            📜
          </div>
          <h2 className="font-semibold text-sm" style={{ color: 'var(--fate-text)' }}>
            Лог бросков
          </h2>
          {logEntries.length > 0 && (
            <>
              <span className="sr-only">
                {logEntries.length}{' '}
                {logEntries.length === 1
                  ? 'запись'
                  : logEntries.length >= 2 && logEntries.length <= 4
                    ? 'записи'
                    : 'записей'}
              </span>
              <Badge
                aria-hidden="true"
                variant="secondary"
                className="text-xs h-5 px-2"
                style={{ color: 'var(--fate-text-muted)' }}
              >
                {logEntries.length}
              </Badge>
            </>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {logEntries.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7 rounded-lg hover:scale-110 active:scale-90 transition-all duration-150"
                  style={{ color: 'var(--fate-text-muted)' }}
                  title="Экспорт лога"
                  aria-label="Экспорт лога"
                >
                  <Download className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={exportJson} className="cursor-pointer">
                  <FileJson className="size-4" />
                  📄 JSON
                </DropdownMenuItem>
                <DropdownMenuItem onClick={exportCsv} className="cursor-pointer">
                  <FileSpreadsheet className="size-4" />
                  📊 CSV
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {stats.total > 0 && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg hover:scale-110 active:scale-90 transition-all duration-150"
              style={{ color: 'var(--fate-accent)' }}
              onClick={() => setStatsOpen(true)}
              title="Статистика бросков"
              aria-label="Статистика бросков"
            >
              <BarChart3 className="size-3.5" />
            </Button>
          )}
          {logEntries.length > 0 && canClear && (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 rounded-lg hover:scale-110 active:scale-90 transition-all duration-150"
              style={{ color: 'var(--fate-danger)' }}
              onClick={clearLog}
              title="Очистить лог — только для мастера"
              aria-label="Очистить лог"
            >
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Filter & Search Row */}
      {logEntries.length > 0 && (
        <div
          className="px-2 py-2 border-b space-y-2"
          style={{ borderColor: 'var(--fate-border)', backgroundColor: 'rgba(127, 140, 141, 0.04)' }}
        >
          {/* Search */}
          <div className="relative">
            <Input
              placeholder="Поиск по логу..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-7 text-xs pl-7 pr-7 rounded-lg"
            />
            <Filter
              className="absolute left-2 top-1/2 -translate-y-1/2 size-3"
              style={{ color: 'var(--fate-text-muted)' }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 size-4 rounded-full flex items-center justify-center hover:bg-black/5 transition-colors"
                title="Очистить"
                aria-label="Очистить поиск"
              >
                <X className="size-3" style={{ color: 'var(--fate-text-muted)' }} />
              </button>
            )}
          </div>

          {/* Filter Pills — each with a colored status dot for instant recognition */}
          <div className="flex items-center gap-1 flex-wrap">
            {(
              [
                { key: 'all', label: 'Все', count: filterCounts.all, color: 'var(--fate-text)', dot: false },
                { key: 'fail', label: 'Провал', count: filterCounts.fail, color: 'var(--fate-danger)', dot: true },
                { key: 'tie', label: 'Ничья', count: filterCounts.tie, color: '#f39c12', dot: true },
                { key: 'success', label: 'Успех', count: filterCounts.success, color: 'var(--fate-success)', dot: true },
                { key: 'great', label: 'Стиль', count: filterCounts.great, color: '#1e8449', dot: true },
                { key: 'system', label: 'Системные', count: filterCounts.system, color: 'var(--fate-text-muted)', dot: false },
              ] as const
            ).map((pill) => {
              const isActive = filter === pill.key;
              const hasItems = pill.count > 0;
              if (!hasItems && !isActive) return null;
              return (
                <button
                  key={pill.key}
                  onClick={() => setFilter(pill.key)}
                  data-active={isActive}
                  className={`fate-toggle-pill fate-filter-pill ${isActive ? 'fate-toggle-pill-active fate-filter-pill-active' : ''}`}
                  style={
                    isActive
                      ? { backgroundColor: pill.color, color: 'white', borderColor: pill.color }
                      : { color: pill.color }
                  }
                >
                  {/* Colored status dot — visual cue even before reading the label */}
                  {pill.dot && (
                    <span
                      className="fate-filter-pill-dot"
                      style={{
                        backgroundColor: isActive ? 'rgba(255,255,255,0.85)' : pill.color,
                        boxShadow: isActive ? '0 0 4px rgba(255,255,255,0.5)' : `0 0 4px ${pill.color}66`,
                      }}
                      aria-hidden="true"
                    />
                  )}
                  {pill.label}
                  <span
                    className="fate-filter-pill-count"
                    style={
                      isActive
                        ? { backgroundColor: 'rgba(255,255,255,0.25)', color: 'white' }
                        : { backgroundColor: `${pill.color}18`, color: pill.color }
                    }
                  >
                    {pill.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Log Entries */}
      <div className="flex-1 min-h-0 relative">
        <ScrollArea ref={scrollAreaRef} className="h-full fate-scroll">
          <div className="p-2 space-y-1 fate-log-stagger">
          {filteredEntries.length === 0 ? (
            <div className="text-center py-12 px-4 animate-fade-in fate-empty-state">
              <div
                className="fate-empty-icon size-16 mx-auto flex items-center justify-center mb-3"
                style={{ backgroundColor: 'rgba(127, 140, 141, 0.08)' }}
              >
                <Scroll className="size-8" style={{ color: 'var(--fate-text-muted)', opacity: 0.35 }} />
              </div>
              <p className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                {logEntries.length === 0 ? 'Нет записей в логе' : 'Ничего не найдено'}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--fate-text-muted)', opacity: 0.6 }}>
                {logEntries.length === 0
                  ? 'Бросьте кубики, чтобы увидеть результаты'
                  : 'Попробуйте изменить фильтр или поисковый запрос'}
              </p>
            </div>
          ) : (
            filteredEntries.map((entry, index) => {
              // ── Magic card draw — render as an effect card ──
              if (entry.isMagicRoll) {
                const isDangerous = entry.magicCastType === 'dangerous';
                const accent = isDangerous ? '#e74c3c' : '#9b59b6';
                const castLabel = isDangerous ? 'Опасный каст' : 'Обычный каст';
                const casterName = entry.characterName?.replace(/^🔮\s*/, '') || '';
                const cardNum = entry.diceResults?.[0];
                const zoneStress = entry.magicZoneStress;
                const stressColor = (() => {
                  if (zoneStress == null) return { bg: 'rgba(127,140,141,0.12)', text: 'var(--fate-text-muted)' };
                  if (zoneStress <= -1) return { bg: 'rgba(39,174,96,0.14)', text: 'var(--fate-success)' };
                  if (zoneStress === 0) return { bg: 'rgba(127,140,141,0.1)', text: 'var(--fate-text-muted)' };
                  if (zoneStress === 1) return { bg: 'rgba(243,156,18,0.16)', text: '#f39c12' };
                  return { bg: 'rgba(231,76,60,0.16)', text: 'var(--fate-danger)' };
                })();
                const zoneLevel = entry.magicZoneLevelAfter;
                const levelLabel =
                  zoneLevel === 1 ? 'Трещины' :
                  zoneLevel === 2 ? 'Разрыв' :
                  zoneLevel === 3 ? 'Катастрофа' : 'Чисто';

                return (
                  <div
                    key={entry.id}
                    className={`fate-magic-card fate-animate-slide-right ${isDangerous ? 'fate-magic-card--dangerous' : ''}`}
                  >
                    {/* Top strip: cast type + caster + card number, timestamp on the right */}
                    <div className="fate-magic-card__strip">
                      <Wand2 className="size-3 shrink-0" style={{ color: accent }} />
                      <span
                        className="text-[11px] font-bold tracking-wide"
                        style={{ color: accent }}
                      >
                        {castLabel.toUpperCase()}
                      </span>
                      {casterName && (
                        <span
                          className="text-[11px] font-medium truncate"
                          style={{ color: 'var(--fate-text)' }}
                          title={casterName}
                        >
                          · {casterName}
                        </span>
                      )}
                      {cardNum != null && (
                        <span
                          className="text-[10px] font-semibold px-1.5 py-0.5 rounded"
                          style={{ backgroundColor: 'rgba(127,140,141,0.14)', color: 'var(--fate-text-muted)' }}
                          title="Номер карты в колоде"
                        >
                          #{cardNum}
                        </span>
                      )}
                      <span
                        className="text-[10px] ml-auto shrink-0"
                        style={{ color: 'var(--fate-text-muted)', opacity: 0.7 }}
                        title={formatFullTimestamp(entry.createdAt)}
                      >
                        {formatTimestamp(entry.createdAt)}
                      </span>
                    </div>

                    {/* Card body: name + effect + badges */}
                    <div className="fate-magic-card__body">
                      {entry.magicCardName ? (
                        <span className="fate-magic-card__name">
                          <Wand2 className="size-3" />
                          {entry.magicCardName}
                        </span>
                      ) : (
                        <span
                          className="fate-magic-card__name"
                          style={{ background: 'var(--fate-text-muted)' }}
                        >
                          Карта #{cardNum ?? '?'}
                        </span>
                      )}

                      {entry.magicEffect && (
                        <p className="fate-magic-card__effect fate-scroll">
                          {entry.magicEffect}
                        </p>
                      )}

                      {/* Badges row: zone stress, zone name, rift level after cast */}
                      <div className="fate-magic-card__badges">
                        {zoneStress != null && (
                          <span
                            className="fate-magic-card__badge"
                            style={{ backgroundColor: stressColor.bg, color: stressColor.text }}
                            title="Стресс зоны с карты"
                          >
                            ⚡ Стресс {zoneStress > 0 ? '+' : ''}{zoneStress}
                          </span>
                        )}
                        {entry.magicZoneName && (
                          <span
                            className="fate-magic-card__badge"
                            style={{
                              backgroundColor: 'rgba(52,152,219,0.12)',
                              color: '#3498db',
                            }}
                            title="Зона, в которую применён стресс"
                          >
                            📍 {entry.magicZoneName}
                          </span>
                        )}
                        {zoneLevel != null && zoneLevel > 0 && (
                          <span
                            className="fate-magic-card__badge"
                            style={{
                              backgroundColor: 'rgba(231,76,60,0.12)',
                              color: 'var(--fate-danger)',
                            }}
                            title="Уровень разлома зоны после каста"
                          >
                            ⚠ {levelLabel} ({zoneLevel})
                          </span>
                        )}
                      </div>

                      {/* Dramatic level-up banner */}
                      {zoneLevel != null && zoneLevel > 0 && (
                        <div className="fate-magic-card__levelup">
                          <Zap className="size-3.5 shrink-0" />
                          <span>Уровень разлома повышен до {zoneLevel} — {levelLabel}!</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              // ── Rift event — dramatic "torn reality" styling ──
              if (entry.isRiftEvent) {
                // Determine rift level from skillName ("Трещины" / "Разрыв" / "Катастрофа")
                // for an appropriate icon + heading.
                const riftIcon =
                  entry.skillName === 'Трещины' ? '⚡' :
                  entry.skillName === 'Разрыв' ? '💀' :
                  entry.skillName === 'Катастрофа' ? '☠️' : '💀';
                const riftTitle =
                  entry.skillName === 'Трещины' ? 'ТРЕЩИНЫ В РЕАЛЬНОСТИ' :
                  entry.skillName === 'Разрыв' ? 'РАЗРЫВ РЕАЛЬНОСТИ' :
                  entry.skillName === 'Катастрофа' ? 'КАТАСТРОФА РЕАЛЬНОСТИ' :
                  'РАЗРЫВ РЕАЛЬНОСТИ';

                return (
                  <div key={entry.id} className="fate-rift-glow-wrapper fate-animate-slide-right">
                    <div className="fate-rift-entry">
                      <div className="flex items-center gap-2 mb-1.5 fate-rift-title">
                        <span className="text-lg leading-none">{riftIcon}</span>
                        <span>{riftTitle}</span>
                      </div>
                      <p className="fate-rift-body">
                        {entry.result || entry.customText || ''}
                      </p>
                      <div className="fate-rift-footer">
                        {formatTimestamp(entry.createdAt)}
                      </div>
                    </div>
                  </div>
                );
              }

              const resultType = inferResultType(entry);
              const resultColor = getResultColor(resultType);
              const resultBg = getResultBgColor(resultType, isDark);
              const resultBorder = getResultBorderColor(resultType);
              const isNewest = index === 0;
              const isRoll = isRollEntry(entry);
              const isEven = index % 2 === 0;
              const isGroupRoll = !!(entry.groupRollResults && entry.groupRollResults.length > 0);

              // Result icon
              const resultIcon = resultType === 'fail' ? '✖' : resultType === 'great' ? '⭐' : resultType === 'success' ? '✓' : '—';
              // Short result label
              const shortResult = resultType === 'fail' ? 'ПРОВАЛ'
                : resultType === 'great' ? `СТИЛЬ (${entry.total - (entry.opponentTotal ?? entry.difficulty ?? 0)})`
                : resultType === 'success' ? `УСПЕХ (${entry.total - (entry.opponentTotal ?? entry.difficulty ?? 0)})`
                : 'НИЧЬЯ';

              // Build line 2: total vs difficulty/opponent + result
              const buildResultLine = (): string => {
                const totalStr = String(entry.total);
                if (entry.opponentTotal != null) {
                  const oppStr = String(entry.opponentTotal);
                  return `${totalStr} против ${oppStr}`;
                }
                if (entry.difficulty != null) {
                  return `${totalStr} против сложности ${entry.difficulty}`;
                }
                return `→ ${totalStr}`;
              };

              return (
                <div
                  key={entry.id}
                  className={`fate-timeline-entry fate-list-item fate-log-entry rounded-lg px-3 py-1.5 border ${
                    !isRoll ? (isEven ? 'fate-row-even' : 'fate-row-odd') : ''
                  } ${isNewest ? 'fate-animate-slide-right' : ''} ${isRoll && entry.characterId && canReroll ? 'cursor-context-menu' : ''}`}
                  style={{
                    borderColor: isRoll ? resultBorder : 'var(--fate-border)',
                    borderLeft: isRoll ? `4px solid ${resultColor}` : `3px solid var(--fate-border)`,
                    backgroundColor: isRoll ? resultBg : undefined,
                  }}
                  onMouseEnter={(e) => {
                    if (isRoll && (entry.diceResults?.length || isGroupRoll)) {
                      showTooltipFor(entry, e.clientX, e.clientY);
                    }
                  }}
                  onMouseMove={(e) => {
                    if (isRoll && (entry.diceResults?.length || isGroupRoll)) {
                      showTooltipFor(entry, e.clientX, e.clientY);
                    }
                  }}
                  onMouseLeave={() => {
                    if (isRoll) hideTooltipSoon();
                  }}
                  {...(isRoll && entry.characterId && canReroll ? {
                    onContextMenu: (e: React.MouseEvent) => {
                      e.preventDefault();
                      const menuWidth = 200;
                      const menuHeight = 180;
                      const x = Math.min(e.clientX, window.innerWidth - menuWidth);
                      const y = Math.min(e.clientY, window.innerHeight - menuHeight);
                      setContextMenu({
                        entryId: entry.id,
                        x,
                        y,
                        characterId: entry.characterId!,
                        characterName: entry.characterName || 'Бросок',
                        opponentName: entry.opponentName || null,
                        opponentType: entry.opponentType || null,
                        opponentCharacterId: entry.opponentCharacterId || null,
                      });
                    },
                  } : {})}
                >
                  {/* ── Group roll entry — structured multi-line block ── */}
                  {isGroupRoll ? (
                    <>
                      {/* Header line: ⚡ Групповой бросок · Бой · сложность 2 · бонус +1 */}
                      <div className="flex items-center gap-1 min-w-0">
                        <span
                          className="text-[13px] font-bold truncate"
                          style={{ color: resultColor }}
                        >
                          ⚡ Групповой бросок
                          <span style={{ color: 'var(--fate-text-muted)', fontWeight: 500 }}>
                            {' · '}{entry.skillName}
                            {entry.difficulty != null && ` · сложность ${entry.difficulty}`}
                            {entry.bonus !== 0 && ` · бонус ${entry.bonus > 0 ? '+' : ''}${entry.bonus}`}
                          </span>
                        </span>
                        {isNewest && (
                          <span className="fate-new-indicator shrink-0" aria-label="Новейшая запись">
                            new
                          </span>
                        )}
                        <span
                          className="text-[10px] ml-auto shrink-0"
                          style={{ color: 'var(--fate-text-muted)', opacity: 0.6 }}
                          title={formatFullTimestamp(entry.createdAt)}
                        >
                          {formatTimestamp(entry.createdAt)}
                        </span>
                      </div>
                      {/* Aggregate result line */}
                      <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                        <span className="text-[13px] font-bold" style={{ color: resultColor }}>
                          Лучший: {entry.total >= 0 ? '+' : ''}{entry.total}
                        </span>
                        <span className="text-[12px] font-semibold" style={{ color: resultColor }}>
                          {resultIcon} {shortResult}
                        </span>
                      </div>
                      {/* Participant breakdown — one row per character */}
                      <div className="mt-1 space-y-0.5">
                        {entry.groupRollResults!.map((p, idx) => {
                          const pTotal = p.total;
                          const pColor = pTotal >= 4 ? '#1e8449'
                            : pTotal >= 1 ? '#27ae60'
                            : pTotal === 0 ? '#e67e22'
                            : '#e74c3c';
                          return (
                            <div
                              key={idx}
                              className="flex items-center gap-2 text-[11px] py-0.5 px-1 rounded"
                              style={{ backgroundColor: idx === 0 && entry.groupRollResults!.length > 1 ? 'rgba(155, 89, 182, 0.05)' : 'transparent' }}
                            >
                              <DiceChips dice={p.dice} size="sm" />
                              <span className="font-semibold truncate" style={{ color: 'var(--fate-text)', minWidth: 50, maxWidth: 120 }}>
                                {p.characterName}
                              </span>
                              <span style={{ color: 'var(--fate-text-muted)', fontFamily: 'monospace' }}>
                                +{p.skillValue}{p.bonus - p.skillValue !== 0 && ` +${p.bonus - p.skillValue}`}
                              </span>
                              <span
                                className="ml-auto font-bold tabular-nums"
                                style={{ color: pColor }}
                              >
                                {pTotal >= 0 ? '+' : ''}{pTotal}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                  <>
                  {/* Line 1: Character (Skill) vs Opponent (Skill) */}
                  <div className="flex items-center gap-1 min-w-0">
                    <span
                      className="text-[13px] font-semibold truncate"
                      style={{ color: isRoll ? resultColor : 'var(--fate-text)' }}
                    >
                      {entry.characterName || 'Неизвестный'}
                      {entry.skillName && (
                        <span style={{ color: 'var(--fate-text-muted)', fontWeight: 400 }}> ({entry.skillName})</span>
                      )}
                      {entry.opponentName && (
                        <span style={{ color: 'var(--fate-text-muted)', fontWeight: 400 }}> против {entry.opponentName}{entry.opponentSkillName ? ` (${entry.opponentSkillName})` : ''}</span>
                      )}
                    </span>
                    {isNewest && (
                      <span className="fate-new-indicator shrink-0" aria-label="Новейшая запись">
                        new
                      </span>
                    )}
                    {/* Pending-sync indicator — shown when the entry hasn't
                        been confirmed by the server yet (offline-first mode). */}
                    {typeof entry.id === 'string' && entry.id.startsWith('local_') && (
                      <span
                        className="shrink-0 inline-flex items-center justify-center rounded-full"
                        style={{
                          width: 14,
                          height: 14,
                          backgroundColor: 'rgba(243, 156, 18, 0.18)',
                          color: '#f39c12',
                          marginRight: 4,
                        }}
                        title="Запись сохранена локально. Будет синхронизирована с сервером, когда он снова станет доступен."
                        aria-label="Ожидает синхронизации"
                      >
                        <RefreshCw className="size-2.5 animate-spin" style={{ animationDuration: '2s' }} />
                      </span>
                    )}
                    <span
                      className="text-[10px] ml-auto shrink-0"
                      style={{ color: 'var(--fate-text-muted)', opacity: 0.6 }}
                      title={formatFullTimestamp(entry.createdAt)}
                    >
                      {formatTimestamp(entry.createdAt)}
                    </span>
                  </div>

                  {/* Line 2: Dice chips + Total vs Difficulty/Opponent + Result icon + label.
                      Dice chips are shown inline so the roll is readable at a glance
                      without hovering. Opposed rolls also show the opponent's dice. */}
                  {isRoll && (
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      {entry.diceResults?.length ? (
                        <DiceChips dice={entry.diceResults} size="sm" />
                      ) : null}
                      <span
                        className="text-[13px] font-bold"
                        style={{ color: resultColor }}
                      >
                        {buildResultLine()}
                      </span>
                      <span className="text-[12px] font-semibold" style={{ color: resultColor }}>
                        {resultIcon} {shortResult}
                      </span>
                      {entry.opponentDiceResults?.length ? (
                        <span className="flex items-center gap-1 ml-1" title={`Кубики противника: ${entry.opponentDiceResults.join(', ')}`}>
                          <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>vs</span>
                          <DiceChips dice={entry.opponentDiceResults} size="sm" />
                        </span>
                      ) : null}
                      {entry.extraBonus > 0 && (
                        <span
                          className="text-[10px] font-semibold px-1 py-0 rounded"
                          style={{ backgroundColor: 'rgba(39, 174, 96, 0.15)', color: 'var(--fate-success)' }}
                          title={entry.extraBonusReason || `Бонус +${entry.extraBonus}`}
                        >
                          +{entry.extraBonus}
                        </span>
                      )}
                      {entry.rerolled && (
                        <span
                          className="text-[10px] font-semibold px-1 py-0 rounded"
                          style={{ backgroundColor: 'rgba(52, 152, 219, 0.15)', color: '#3498db' }}
                        >
                          🎲
                        </span>
                      )}
                    </div>
                  )}

                  {/* Custom text (for magic/conflict log entries) */}
                  {entry.customText && !entry.diceResults?.length && !isGroupRoll && (
                    <p className="text-xs leading-relaxed mt-0.5" style={{ color: 'var(--fate-text-muted)' }}>
                      {entry.customText}
                    </p>
                  )}
                  </>
                  )}
                </div>
              );
            })
          )}
          </div>
        </ScrollArea>

        {/* Scroll-to-top floating button */}
        {showScrollButton && (
          <button
            onClick={scrollToTop}
            className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium shadow-lg transition-all duration-200 hover:scale-105 active:scale-95 cursor-pointer"
            style={{
              backgroundColor: 'var(--fate-accent)',
              color: 'white',
              boxShadow: '0 2px 8px rgba(230, 126, 34, 0.35)',
            }}
            aria-label="Прокрутить к новым записям"
          >
            <ArrowDown className="size-3.5 rotate-180" />
            Новые записи
          </button>
        )}
      </div>

      {/* Statistics Dialog */}
      <Dialog open={statsOpen} onOpenChange={setStatsOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              <div
                className="fate-icon-circle"
                style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
              >
                <BarChart3 className="size-4" style={{ color: 'var(--fate-accent)' }} />
              </div>
              Статистика бросков
            </DialogTitle>
            <DialogDescription>
              Анализ результатов бросков в этом приключении
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Total rolls + Success rate */}
            <div className="grid grid-cols-2 gap-2">
              <div
                className="rounded-lg p-3 border"
                style={{ backgroundColor: 'rgba(230, 126, 34, 0.05)', borderColor: 'rgba(230, 126, 34, 0.2)' }}
              >
                <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--fate-text-muted)' }}>
                  Всего бросков
                </div>
                <div className="text-2xl font-black mt-1 fate-number-pop" style={{ color: 'var(--fate-accent)' }}>
                  {stats.total}
                </div>
              </div>
              <div
                className="rounded-lg p-3 border"
                style={{ backgroundColor: 'rgba(39, 174, 96, 0.05)', borderColor: 'rgba(39, 174, 96, 0.2)' }}
              >
                <div className="text-[10px] font-medium uppercase tracking-wider flex items-center gap-1" style={{ color: 'var(--fate-text-muted)' }}>
                  <TrendingUp className="size-3" />
                  Успешность
                </div>
                <div className="text-2xl font-black mt-1 fate-number-pop" style={{ color: 'var(--fate-success)' }}>
                  {stats.successRate.toFixed(0)}%
                </div>
              </div>
            </div>

            {/* Breakdown bar */}
            <div>
              <div className="text-xs font-medium mb-1.5" style={{ color: 'var(--fate-text-muted)' }}>
                Распределение результатов
              </div>
              {stats.total > 0 ? (
                <>
                  <div className="flex h-3 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--fate-bg-warm)' }}>
                    <div style={{ width: `${(stats.byType.fail / stats.total) * 100}%`, backgroundColor: 'var(--fate-danger)' }} title={`Провал: ${stats.byType.fail}`} />
                    <div style={{ width: `${(stats.byType.tie / stats.total) * 100}%`, backgroundColor: '#f39c12' }} title={`Ничья: ${stats.byType.tie}`} />
                    <div style={{ width: `${(stats.byType.success / stats.total) * 100}%`, backgroundColor: 'var(--fate-success)' }} title={`Успех: ${stats.byType.success}`} />
                    <div style={{ width: `${(stats.byType.great / stats.total) * 100}%`, backgroundColor: '#1e8449' }} title={`Успех со стилем: ${stats.byType.great}`} />
                  </div>
                  <div className="flex flex-wrap gap-2 mt-2">
                    <Badge className="text-[10px] h-5 px-2" style={{ backgroundColor: 'rgba(231, 76, 60, 0.12)', color: 'var(--fate-danger)', border: 'none' }}>
                      Провал: {stats.byType.fail}
                    </Badge>
                    <Badge className="text-[10px] h-5 px-2" style={{ backgroundColor: 'rgba(243, 156, 18, 0.12)', color: '#f39c12', border: 'none' }}>
                      Ничья: {stats.byType.tie}
                    </Badge>
                    <Badge className="text-[10px] h-5 px-2" style={{ backgroundColor: 'rgba(39, 174, 96, 0.12)', color: 'var(--fate-success)', border: 'none' }}>
                      Успех: {stats.byType.success}
                    </Badge>
                    <Badge className="text-[10px] h-5 px-2" style={{ backgroundColor: 'rgba(30, 132, 73, 0.12)', color: '#1e8449', border: 'none' }}>
                      Стиль: {stats.byType.great}
                    </Badge>
                  </div>
                </>
              ) : (
                <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>Нет данных</p>
              )}
            </div>

            {/* Best & Worst */}
            {stats.best && stats.worst && (
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg p-2.5 border" style={{ borderColor: 'var(--fate-border)' }}>
                  <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--fate-text-muted)' }}>
                    ⭐ Лучший
                  </div>
                  <div className="text-lg font-bold mt-0.5" style={{ color: 'var(--fate-success)' }}>
                    +{stats.best.total}
                  </div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--fate-text-muted)' }}>
                    {stats.best.characterName}
                  </div>
                </div>
                <div className="rounded-lg p-2.5 border" style={{ borderColor: 'var(--fate-border)' }}>
                  <div className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--fate-text-muted)' }}>
                    💥 Худший
                  </div>
                  <div className="text-lg font-bold mt-0.5" style={{ color: 'var(--fate-danger)' }}>
                    {stats.worst.total}
                  </div>
                  <div className="text-[10px] truncate" style={{ color: 'var(--fate-text-muted)' }}>
                    {stats.worst.characterName}
                  </div>
                </div>
              </div>
            )}

            {/* Average */}
            {stats.total > 0 && (
              <div className="text-center text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                Средний результат: <span className="font-bold" style={{ color: 'var(--fate-text)' }}>
                  {stats.avgTotal >= 0 ? '+' : ''}{stats.avgTotal.toFixed(1)}
                </span>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Context Menu (right-click on roll entries) ──────────
          Reroll & bonus actions are host/local only. The context menu is
          gated on `canReroll` both at the open site (onContextMenu) and
          here at the render site, so if the peer's permissions change while
          the menu is open it just disappears. */}
      {contextMenu && canReroll && (
        <>
          <div className="fixed inset-0 z-[100]" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-[101] rounded-lg shadow-xl border py-1 min-w-[220px] overflow-hidden animate-in fade-in-0 zoom-in-95 duration-100"
            style={{
              backgroundColor: 'var(--fate-bg-card)',
              left: contextMenu.x,
              top: contextMenu.y,
              borderColor: 'var(--fate-border)',
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
            }}
          >
            {/* Header */}
            <div
              className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5"
              style={{ color: 'var(--fate-accent)', backgroundColor: 'rgba(230, 126, 34, 0.06)' }}
            >
              <span>✨</span>
              Призыв аспекта
              <span className="ml-auto text-[9px] font-normal normal-case" style={{ color: 'var(--fate-text-muted)' }}>
                1 ОС
              </span>
            </div>

            {/* Reroll attacker */}
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center gap-2.5 transition-colors"
              style={{ color: 'var(--fate-text)' }}
              onClick={async () => {
                await rerollLogEntry(contextMenu.entryId, 'attacker');
                toast.success(`Переброс: ${contextMenu.characterName}`, { description: 'Призыв аспекта (1 ОС)' });
                setContextMenu(null);
              }}
            >
              <RefreshCw className="size-3.5 text-blue-500" />
              <span>Перебросить {contextMenu.characterName}</span>
            </button>

            {/* Reroll defender (only if opponent is a character) */}
            {contextMenu.opponentName && contextMenu.opponentType === 'character' && (
              <button
                className="w-full text-left px-3 py-2 text-sm hover:bg-orange-50 dark:hover:bg-orange-950/30 flex items-center gap-2.5 transition-colors"
                style={{ color: 'var(--fate-text)' }}
                onClick={async () => {
                  await rerollLogEntry(contextMenu.entryId, 'defender');
                  toast.success(`Переброс: ${contextMenu.opponentName}`, { description: 'Призыв аспекта (1 ОС)' });
                  setContextMenu(null);
                }}
              >
                <RefreshCw className="size-3.5 text-blue-500" />
                <span>Перебросить {contextMenu.opponentName}</span>
              </button>
            )}

            {/* Divider */}
            <div className="my-1 border-t" style={{ borderColor: 'var(--fate-border)' }} />

            {/* Bonus attacker */}
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-green-50 dark:hover:bg-green-950/30 flex items-center gap-2.5 transition-colors"
              style={{ color: 'var(--fate-text)' }}
              onClick={() => {
                setBonusDialog({
                  entryId: contextMenu.entryId,
                  target: 'attacker',
                  targetName: contextMenu.characterName,
                });
                setBonusAmount(2);
                setBonusReason('Призыв аспекта');
                setContextMenu(null);
              }}
            >
              <Plus className="size-3.5 text-green-600" />
              <span>Бонус {contextMenu.characterName}</span>
            </button>

            {/* Bonus defender (only if opponent is a character) */}
            {contextMenu.opponentName && contextMenu.opponentType === 'character' && (
              <button
                className="w-full text-left px-3 py-2 text-sm hover:bg-green-50 dark:hover:bg-green-950/30 flex items-center gap-2.5 transition-colors"
                style={{ color: 'var(--fate-text)' }}
                onClick={() => {
                  setBonusDialog({
                    entryId: contextMenu.entryId,
                    target: 'defender',
                    targetName: contextMenu.opponentName!,
                  });
                  setBonusAmount(2);
                  setBonusReason('Призыв аспекта');
                  setContextMenu(null);
                }}
              >
                <Plus className="size-3.5 text-green-600" />
                <span>Бонус {contextMenu.opponentName}</span>
              </button>
            )}
          </div>
        </>
      )}

      {/* ── Bonus Dialog ──────────────────────────────────────── */}
      <Dialog open={bonusDialog !== null} onOpenChange={(open) => { if (!open) setBonusDialog(null); }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="size-5 text-green-600" />
              Бонус для {bonusDialog?.targetName}
            </DialogTitle>
            <DialogDescription>
              Призыв аспекта — добавьте бонус к результату броска (стоимость: 1 очко судьбы)
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Bonus amount */}
            <div className="space-y-2">
              <label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                Размер бонуса
              </label>
              <div className="flex items-center gap-3">
                <Button
                  variant="outline"
                  size="icon"
                  className="size-9 rounded-lg"
                  onClick={() => setBonusAmount((b) => Math.max(1, b - 1))}
                >
                  −
                </Button>
                <div
                  className="text-2xl font-black w-16 text-center tabular-nums"
                  style={{ color: 'var(--fate-success)' }}
                >
                  +{bonusAmount}
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="size-9 rounded-lg"
                  onClick={() => setBonusAmount((b) => Math.min(10, b + 1))}
                >
                  +
                </Button>
              </div>
            </div>

            {/* Reason */}
            <div className="space-y-2">
              <label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                Причина
              </label>
              <Input
                value={bonusReason}
                onChange={(e) => setBonusReason(e.target.value)}
                placeholder="Призыв аспекта"
                className="rounded-lg"
              />
            </div>
          </div>
          <DialogFooter className="gap-2 mt-2">
            <Button variant="ghost" onClick={() => setBonusDialog(null)} className="rounded-lg">
              Отмена
            </Button>
            <Button
              className="rounded-lg fate-btn-accent"
              onClick={async () => {
                if (!bonusDialog) return;
                await addBonusToLogEntry(bonusDialog.entryId, bonusDialog.target, bonusAmount, bonusReason);
                toast.success(`+${bonusAmount} для ${bonusDialog.targetName}`, { description: bonusReason });
                setBonusDialog(null);
              }}
            >
              <Plus className="size-4 mr-1" />
              Добавить +{bonusAmount}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Rich HTML tooltip for log entries (hover popover) ── */}
      {hoveredTooltip && (
        <div
          style={{
            position: 'fixed',
            left: hoveredTooltip.x,
            top: hoveredTooltip.y,
            zIndex: 9999,
            pointerEvents: 'none',
            animation: 'fate-tooltip-fade-in 0.12s ease-out',
          }}
          onMouseEnter={cancelHideTooltip}
          onMouseLeave={() => hideTooltipSoon(60)}
        >
          <LogEntryTooltip entry={hoveredTooltip.entry} isDark={isDark} />
        </div>
      )}

      {/* Roll Stage Overlay переехал на карту (map-panel.tsx) — кубики
          теперь рендерятся над картой, а не в лог-панели. */}
    </div>
  );
}
