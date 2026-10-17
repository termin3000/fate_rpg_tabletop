'use client';

/**
 * DefenseSummary — компактная сводка защит для массовой атаки.
 *
 * Показывается в фазе 3 «defend» после того, как все защитники бросили
 * кубики (ALL defenders animate via executeMassRollSimultaneous — one
 * 3D overlay with N zonal slots).
 *
 * Дизайн:
 *   • Compact header — атакующий + навык + итог в одну строку
 *   • Compact defender rows — аватар + имя + кубы + итог + лейбл + [✎]
 *   • Inline editor (expandable) — переброс / +2 аспект / +2 бесплатно
 *
 * Права на редактирование:
 *   - GM (host или offline) → может редактировать ВСЕ строки (PC и NPC).
 *   - Player → может редактировать ТОЛЬКО строки, где defender.characterId
 *     входит в его назначенные персонажи. Для остальных строк кнопки
 *     скрыты (read-only badge «только просмотр»).
 *
 * Решение о правах принимает родитель через колбэк `canEditDefender(charId)`.
 */

import React, { useState } from 'react';
import {
  Swords, Shield, Pencil, Skull, Handshake, Trophy,
  RefreshCw, Plus, Gift, ChevronDown, ChevronUp,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DiceChips } from '@/components/fate/dice-chips';
import type { RollResultType } from '@/lib/types';

// ── Helpers ──────────────────────────────────────────────────

function formatTotal(total: number): string {
  return total >= 0 ? `+${total}` : String(total);
}

/** Внешний вид badge по типу исхода защиты.
 *  tie = block (homebrew rule: ничья = защитник отбился, 0 урона). */
function outcomeBadgeStyle(resultType: RollResultType | 'block' | null): React.CSSProperties {
  if (resultType === 'block' || resultType === 'tie') {
    return { backgroundColor: '#2980b9', color: 'white', border: 'none' };
  }
  return { backgroundColor: '#c0392b', color: 'white', border: 'none' };
}

/** Компактный аватар. */
function MiniAvatar({
  name,
  avatar,
  avatarColor,
  size = 18,
}: {
  name: string;
  avatar?: string | null;
  avatarColor?: string;
  size?: number;
}) {
  if (avatar) {
    return (
      <img
        src={avatar}
        alt={name}
        className="rounded-full object-cover flex-shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  const initial = name.charAt(0).toUpperCase();
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: avatarColor || '#e67e22',
        fontSize: size * 0.5,
      }}
    >
      {initial}
    </div>
  );
}

// ── Types ────────────────────────────────────────────────────

export interface DefenseSummaryDefender {
  characterId: string;
  characterName: string;
  characterType: 'pc' | 'npc';
  avatarColor: string;
  avatar: string | null;
  assignedDamage: number;
  defenseSkillName: string;
  defenseSkillValue: number;
  dice: number[] | null;
  diceSum: number | null;
  total: number | null;
  resultLabel: string | null;
  resultType: RollResultType | 'block' | null;
  rolled: boolean;
  // Per-defender aspect invocation state
  rerollCount: number;
  fatePlus2Count: number;
  freeInvokeCount: number;
}

export interface DefenseSummaryProps {
  attackName?: string;
  attackSkillName?: string;
  attackDice: number[];
  attackTotal: number;
  availableDamage?: number;
  defenders: DefenseSummaryDefender[];
  canEditDefender: (characterId: string) => boolean;
  /** Reserved for future use — expand toggle is internal. */
  onEditDefender?: (characterId: string) => void;
  /** Reroll this defender's dice (1 fate point). */
  onRerollDefender: (characterId: string) => void;
  /** +2 aspect invocation (1 fate point). Does NOT re-roll. */
  onFatePlus2: (characterId: string) => void;
  /** +2 free invocation (no fate point). Does NOT re-roll. */
  onFreeInvoke: (characterId: string) => void;
  /** True while async defense rolls are in flight — disables edit buttons. */
  isDefending?: boolean;
}

// ── Main component ───────────────────────────────────────────

export function DefenseSummary({
  attackName,
  attackSkillName,
  attackDice,
  attackTotal,
  availableDamage,
  defenders,
  canEditDefender,
  onRerollDefender,
  onFatePlus2,
  onFreeInvoke,
  isDefending = false,
}: DefenseSummaryProps) {
  const dmg = availableDamage ?? attackTotal;
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div
      className="rounded-lg overflow-hidden animate-fade-in"
      style={{
        backgroundColor: 'var(--fate-bg-warm)',
        border: '1px solid rgba(230, 126, 34, 0.25)',
      }}
    >
      {/* ── Compact attack header (single row) ── */}
      <div
        className="flex items-center justify-between gap-2 px-2.5 py-1.5"
        style={{
          backgroundColor: 'rgba(230, 126, 34, 0.08)',
          borderBottom: '1px solid rgba(230, 126, 34, 0.2)',
        }}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <Swords className="size-3 flex-shrink-0" style={{ color: 'var(--fate-accent)' }} />
          <span className="text-[10px] font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
            {attackName ?? '—'}
          </span>
          {attackSkillName && (
            <span className="text-[9px] truncate" style={{ color: 'var(--fate-text-muted)' }}>
              · {attackSkillName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <DiceChips dice={attackDice} size="xs" animate={false} />
          <span className="text-sm font-black leading-none" style={{ color: 'var(--fate-accent)' }}>
            {formatTotal(attackTotal)}
          </span>
          <Badge
            variant="outline"
            className="text-[7px] px-1 py-0"
            style={{ color: 'var(--fate-accent)', borderColor: 'var(--fate-accent)' }}
          >
            урон {formatTotal(dmg)}
          </Badge>
        </div>
      </div>

      {/* ── Compact defenders list ──
          Capped height with custom slim scrollbar so the card never
          overflows the panel even with many defenders. Each row is
          ~24px, so max-h-64 (~256px) fits ~10 defenders before scroll. */}
      <div className="px-1.5 py-1.5">
        <div className="flex items-center gap-1 px-1 pb-1">
          <Shield className="size-2.5" style={{ color: 'var(--fate-text-muted)' }} />
          <span className="text-[8px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
            Защита ({defenders.length})
          </span>
        </div>
        <ul className="space-y-0.5 max-h-64 overflow-y-auto fate-scroll pr-0.5">
          {defenders.map((d) => {
            const editable = canEditDefender(d.characterId);
            const isExpanded = expandedId === d.characterId;
            const hasAdjustments = d.rerollCount > 0 || d.fatePlus2Count > 0 || d.freeInvokeCount > 0;
            return (
              <li key={d.characterId}>
                {/* ── Compact row ── */}
                <div
                  className="flex items-center gap-1.5 px-1.5 py-1 rounded-md transition-colors"
                  style={{
                    backgroundColor: 'transparent',
                    border: `1px solid ${
                      d.resultType === 'block'
                        ? 'rgba(41, 128, 185, 0.25)'
                        : d.resultType === 'tie'
                          ? 'rgba(243, 156, 18, 0.25)'
                          : 'rgba(192, 57, 43, 0.25)'
                    }`,
                  }}
                >
                  <MiniAvatar
                    name={d.characterName}
                    avatar={d.avatar}
                    avatarColor={d.avatarColor}
                    size={18}
                  />
                  <div className="flex flex-col min-w-0 flex-1 gap-0">
                    <div className="flex items-center gap-1 min-w-0">
                      <span className="text-[10px] font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                        {d.characterName}
                      </span>
                      {d.characterType === 'pc' ? (
                        <Badge variant="outline" className="text-[6px] px-0.5 py-0 flex-shrink-0 h-3 leading-none" style={{ color: 'var(--fate-accent)', borderColor: 'var(--fate-accent)' }}>
                          PC
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[6px] px-0.5 py-0 flex-shrink-0 h-3 leading-none" style={{ color: 'var(--fate-text-muted)', borderColor: 'var(--fate-text-muted)' }}>
                          NPC
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <DiceChips dice={d.dice} size="xs" animate={false} />
                      {d.defenseSkillName && (
                        <span className="text-[7px] truncate" style={{ color: 'var(--fate-text-muted)' }}>
                          {d.defenseSkillName} +{d.defenseSkillValue}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-0 flex-shrink-0">
                    <span
                      className="text-xs font-black leading-none"
                      style={{
                        color:
                          d.resultType === 'block' || d.resultType === 'tie'
                            ? '#2980b9'
                            : '#c0392b',
                      }}
                    >
                      {d.total !== null ? formatTotal(d.total) : '—'}
                    </span>
                    <Badge
                      className="text-[7px] px-1 py-0 gap-0.5 h-3 leading-none"
                      style={outcomeBadgeStyle(d.resultType)}
                    >
                      {d.resultType === 'block' || d.resultType === 'tie' ? <Trophy className="size-2" /> : <Skull className="size-2" />}
                      {d.resultLabel ?? '—'}
                    </Badge>
                  </div>
                  {/* Expand toggle button — only for editable defenders */}
                  {editable ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="size-5 p-0 flex-shrink-0"
                      onClick={() => setExpandedId(isExpanded ? null : d.characterId)}
                      aria-label={isExpanded ? 'Свернуть' : 'Редактировать'}
                      title={isExpanded ? 'Свернуть' : 'Редактировать защиту'}
                    >
                      {isExpanded ? <ChevronUp className="size-3" /> : <Pencil className="size-2.5" />}
                    </Button>
                  ) : (
                    <div className="size-5 flex-shrink-0 flex items-center justify-center" title="Только просмотр">
                      <span className="text-[7px]" style={{ color: 'var(--fate-text-muted)' }}>—</span>
                    </div>
                  )}
                </div>

                {/* ── Adjustment badges row (if any) ── */}
                {hasAdjustments && (
                  <div className="flex items-center gap-1 flex-wrap px-2 pb-0.5">
                    {d.rerollCount > 0 && (
                      <Badge variant="outline" className="text-[7px] px-1 py-0 gap-0.5 h-3 leading-none" style={{ color: '#e67e22', borderColor: '#e67e22' }}>
                        <RefreshCw className="size-2" />
                        {d.rerollCount > 1 ? `×${d.rerollCount}` : ''}
                      </Badge>
                    )}
                    {d.fatePlus2Count > 0 && (
                      <Badge variant="outline" className="text-[7px] px-1 py-0 gap-0.5 h-3 leading-none" style={{ color: '#27ae60', borderColor: '#27ae60' }}>
                        <Plus className="size-2" />
                        {d.fatePlus2Count * 2}
                      </Badge>
                    )}
                    {d.freeInvokeCount > 0 && (
                      <Badge variant="outline" className="text-[7px] px-1 py-0 gap-0.5 h-3 leading-none" style={{ color: '#9b59b6', borderColor: '#9b59b6' }}>
                        <Gift className="size-2" />
                        {d.freeInvokeCount * 2}
                      </Badge>
                    )}
                  </div>
                )}

                {/* ── Inline editor (expandable) ── */}
                {editable && isExpanded && (
                  <div className="px-2 pb-1.5 pt-0.5 animate-slide-down">
                    <div className="grid grid-cols-3 gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[8px] gap-0.5"
                        disabled={isDefending}
                        onClick={() => onRerollDefender(d.characterId)}
                        title="Перебросить кубики (1 очко судьбы)"
                      >
                        <RefreshCw className="size-2.5" />
                        Переброс
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[8px] gap-0.5"
                        disabled={isDefending}
                        onClick={() => onFatePlus2(d.characterId)}
                        title="Призвать аспект: +2 к защите за 1 жетон судьбы"
                      >
                        <Plus className="size-2.5" />
                        +2 аспект
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 text-[8px] gap-0.5"
                        disabled={isDefending}
                        onClick={() => onFreeInvoke(d.characterId)}
                        title="Бесплатный призыв аспекта: +2 без жетона"
                      >
                        <Gift className="size-2.5" />
                        +2 бесплат.
                      </Button>
                    </div>
                    {d.resultType === 'block' && (
                      <p className="text-[8px] text-center mt-1" style={{ color: '#2980b9' }}>
                        🛡️ Отбился — урона нет
                      </p>
                    )}
                    {d.resultType === 'tie' && (
                      <p className="text-[8px] text-center mt-1" style={{ color: '#2980b9' }}>
                        🛡️ Отбился — урона нет
                      </p>
                    )}
                    {(d.resultType === 'success' || d.resultType === 'great') && (
                      <p className="text-[8px] text-center mt-1" style={{ color: '#c0392b' }}>
                        ⚔️ {d.assignedDamage - (d.total ?? 0)} стресса
                      </p>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export default DefenseSummary;
