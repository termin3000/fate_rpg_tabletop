'use client';

/**
 * RollInvitationPanel — a draggable, non-modal floating panel shown to a
 * player when the GM invites them to participate in a mass-roll session.
 *
 * Replaces the old RollInvitationDialog (which was a modal Dialog that blocked
 * access to the rest of the tool). Now the player can:
 *   - Drag the panel aside to see the map / character sheet
 *   - Minimize it to a compact pill
 *   - Keep it open while browsing other parts of the tool
 *
 * Two-phase UX:
 *
 *  Phase 1 (pre-roll / readiness):
 *   - Player sees: skill name, difficulty, opponent (if opposed), their
 *     resolved skill value, and any GM overrides (different skill / manual bonus).
 *   - Player optionally toggles "+2" fate point usage.
 *   - Player clicks "Готов" → sends mass-roll-ready to host.
 *
 *  Phase 2 (post-roll / results):
 *   - Player sees ALL participants' results (sorted by total desc).
 *   - Player can perform THREE post-roll adjustments (each is a separate action):
 *       1. "Переброс"        — spend 1 fate point, re-roll dice. Multiple allowed.
 *       2. "+2 к броску"     — spend 1 fate point, add +2 to total. Multiple allowed.
 *       3. "Бесплатный призыв" — no fate point cost, add +2 (from a free invocation
 *          on an aspect created with Create an Advantage). Multiple allowed.
 *   - Each adjustment is immediately broadcast to all players + GM.
 *   - The player's own row shows a compact history of adjustments (badges).
 *   - Reason field is gone — the panel is non-modal so the player can look at
 *     their character sheet directly to decide which aspect to invoke.
 */

import React, { useMemo, useState, useEffect } from 'react';
import { Dices, Zap, Shield, Swords, Check, X, Clock, Flame, RefreshCw, Crown, Plus, Gift, ChevronDown, ChevronUp } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FloatingPanel } from '@/components/ui/floating-panel';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { useFateStore } from '@/lib/store';
import { useNetwork } from '@/hooks/use-network';
import { DiceChips } from '@/components/fate/dice-chips';

interface RollInvitationPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Result label colors ─────────────────────────────────────
const RESULT_COLORS: Record<string, string> = {
  'Стиль': '#9b59b6',
  'Успех': '#27ae60',
  'Ничья': '#f39c12',
  'Провал': '#e74c3c',
};

function resultBadgeStyle(label: string): React.CSSProperties {
  const color = RESULT_COLORS[label] ?? '#7f8c8d';
  return { backgroundColor: color, color: 'white', border: 'none' };
}

function formatTotal(total: number): string {
  return total >= 0 ? `+${total}` : String(total);
}

export function RollInvitationPanel({ open, onOpenChange }: RollInvitationPanelProps) {
  const store = useFateStore();
  const {
    massRollState,
    networkMyPeerId,
    characters,
    setMassRollReady,
  } = store;
  const { sendMassRollReady, sendMassRollAdjust } = useNetwork();

  // ── Local UI state (fate point choice — pre-roll) ─────────
  const [fateMode, setFateMode] = useState<'none' | 'plus2'>('none');
  // ── Local UI state (optional reason — collapsed by default) ──
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState('');
  // ── Track in-flight requests to show "processing" state ──
  const [pendingAdjust, setPendingAdjust] = useState<'reroll' | 'plus2' | 'free-invoke' | null>(null);

  // Find my participant entry.
  const myParticipant = useMemo(() => {
    if (!massRollState || !networkMyPeerId) return null;
    return massRollState.participants.find((p) => p.peerId === networkMyPeerId) ?? null;
  }, [massRollState, networkMyPeerId]);

  // Resolve my character's fate points.
  const myCharacter = useMemo(() => {
    if (!myParticipant) return null;
    return characters.find((c) => c.id === myParticipant.characterId) ?? null;
  }, [myParticipant, characters]);

  // Reset local state when panel closes.
  useEffect(() => {
    if (!open) {
      const t = setTimeout(() => {
        setFateMode('none');
        setShowReason(false);
        setReason('');
        setPendingAdjust(null);
      }, 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // If session is gone (host cancelled/finalized), close the panel.
  useEffect(() => {
    if (!massRollState && open) {
      onOpenChange(false);
    }
  }, [massRollState, open, onOpenChange]);

  if (!massRollState || !myParticipant) {
    return null;
  }

  const session = massRollState;
  const skillOverridden = myParticipant.skillName !== session.skillName;
  const hasManualBonus = myParticipant.manualBonus !== 0;
  const myFatePoints = myCharacter?.fatePoints ?? 0;
  const canUseFate = myFatePoints > 0;

  // ── Phase detection ───────────────────────────────────────
  const hasRolled = !!myParticipant.result;
  const allResults = session.participants.filter((p) => p.result);
  const sortedResults = [...allResults].sort((a, b) => (b.result!.total) - (a.result!.total));

  // ── Adjustment availability ──
  // Reroll + plus2: need fate points. Free-invoke: always allowed.
  // Multiple adjustments allowed — no per-session limit.
  // The "pendingAdjust" flag prevents double-clicks while a request is in flight.
  const canReroll = hasRolled && canUseFate && !pendingAdjust;
  const canPlus2 = hasRolled && canUseFate && !pendingAdjust;
  const canFreeInvoke = hasRolled && !pendingAdjust;

  // ── Ready toggle (pre-roll) ───────────────────────────────
  const handleToggleReady = () => {
    if (!myParticipant) return;
    const newReady = !myParticipant.ready;
    setMassRollReady(session.id, myParticipant.characterId, newReady, {
      mode: fateMode === 'plus2' ? 'plus2' : 'none',
      reason: reason || undefined,
    });
    sendMassRollReady({
      sessionId: session.id,
      characterId: myParticipant.characterId,
      ready: newReady,
      fatePointMode: fateMode === 'plus2' ? 'plus2' : 'none',
      fatePointReason: reason || undefined,
    });
  };

  // ── Post-roll adjustment (reroll / plus2 / free-invoke) ───
  const handleAdjust = (mode: 'reroll' | 'plus2' | 'free-invoke') => {
    if (!myParticipant || !canUseFate && mode !== 'free-invoke') return;
    if (pendingAdjust) return;
    setPendingAdjust(mode);
    sendMassRollAdjust({
      sessionId: session.id,
      characterId: myParticipant.characterId,
      mode,
      reason: reason || undefined,
    });
    // Clear pending state after a short delay — the host's broadcast will
    // arrive and update the results, at which point the player can act again.
    setTimeout(() => setPendingAdjust(null), 600);
  };

  // ── Mode icon + label ─────────────────────────────────────
  const ModeIcon = session.mode === 'opposed' ? Swords : session.difficulty !== null ? Shield : Dices;
  const modeLabel = session.mode === 'opposed'
    ? 'Противостояние'
    : session.difficulty !== null
    ? 'Сложность'
    : 'Проверка';

  // ── My adjustment history badges ──
  const myRerolls = myParticipant.result?.rerollCount ?? 0;
  const myBonuses = myParticipant.result?.bonusCount ?? 0;
  const myFreeInvokes = myParticipant.result?.freeInvokeCount ?? 0;

  // ── Panel badge (status summary) ──
  const panelBadge = hasRolled
    ? (session.status === 'complete'
        ? <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5" style={{ color: '#27ae60' }}><Check className="size-2.5" />Готово</Badge>
        : <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5" style={{ color: 'var(--fate-accent)' }}><Dices className="size-2.5" />Результаты</Badge>)
    : (myParticipant.ready
        ? <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5" style={{ color: '#27ae60' }}><Check className="size-2.5" />Готов</Badge>
        : <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5" style={{ color: '#f39c12' }}><Clock className="size-2.5" />Ждём</Badge>);

  return (
    <FloatingPanel
      open={open}
      onClose={() => onOpenChange(false)}
      title={hasRolled ? 'Результаты броска' : 'Бросок от мастера'}
      icon={<ModeIcon className="size-4" />}
      badge={panelBadge}
      width={440}
      storageKey="roll-invitation"
      contentClassName="p-4 space-y-3"
      footer={
        !hasRolled ? (
          <Button
            onClick={handleToggleReady}
            className="flex-1 gap-2"
            variant={myParticipant.ready ? 'secondary' : 'default'}
          >
            {myParticipant.ready ? (
              <><X className="size-4" />Отменить готовность</>
            ) : (
              <><Check className="size-4" />Готов!</>
            )}
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="flex-1"
          >
            Закрыть
          </Button>
        )
      }
    >
      {/* ── Roll context bar ─────────────── */}
      <div
        className="rounded-lg px-3 py-2.5 flex items-center justify-between gap-2 text-xs"
        style={{ backgroundColor: 'var(--fate-bg-warm)' }}
      >
        <div className="flex items-center gap-2">
          <span style={{ color: 'var(--fate-text-muted)' }}>{modeLabel}</span>
          <Badge variant="outline" className="text-[10px] font-semibold">
            {session.skillName}
          </Badge>
        </div>
        <div className="flex items-center gap-3">
          {session.difficulty !== null && (
            <span style={{ color: 'var(--fate-text-muted)' }}>
              Сложность: <span className="font-bold" style={{ color: 'var(--fate-text)' }}>{session.difficulty}</span>
            </span>
          )}
          {session.mode === 'opposed' && session.opponentName && (
            <span style={{ color: 'var(--fate-text-muted)' }}>
              vs <span className="font-bold" style={{ color: 'var(--fate-text)' }}>{session.opponentName}</span>
              {session.opponentTotal !== undefined && (
                <span className="ml-0.5" style={{ color: 'var(--fate-accent)' }}>
                  {formatTotal(session.opponentTotal)}
                </span>
              )}
            </span>
          )}
          {session.bonus !== 0 && (
            <span style={{ color: 'var(--fate-text-muted)' }}>
              Бонус: <span className="font-bold" style={{ color: 'var(--fate-text)' }}>{formatTotal(session.bonus)}</span>
            </span>
          )}
        </div>
      </div>

      {/* ── Phase 1: Pre-roll ── */}
      {!hasRolled && (
        <>
          {/* My character info */}
          <div className="rounded-lg border border-border p-3 space-y-1.5">
            <div className="flex items-center justify-between text-sm">
              <span className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>Ваш персонаж</span>
              <span className="font-semibold" style={{ color: 'var(--fate-text)' }}>
                {myParticipant.characterName}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>Навык</span>
              <span className="font-semibold flex items-center gap-1.5 text-xs" style={{ color: 'var(--fate-text)' }}>
                {myParticipant.skillName} +{myParticipant.skillValue}
                {skillOverridden && (
                  <Badge variant="outline" className="text-[9px] px-1 py-0" style={{ color: 'var(--fate-accent)' }}>
                    GM заменил
                  </Badge>
                )}
              </span>
            </div>
            {hasManualBonus && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>Бонус (трюк)</span>
                <span className="font-bold text-xs" style={{ color: 'var(--fate-success)' }}>
                  {formatTotal(myParticipant.manualBonus)}
                </span>
              </div>
            )}
          </div>

          <Separator />

          {/* Fate point choice — only "+2" pre-roll (reroll is post-roll) */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium flex items-center gap-1.5" style={{ color: 'var(--fate-text-muted)' }}>
                <Flame className="size-3.5" style={{ color: '#e67e22' }} />
                Жетон судьбы
              </Label>
              <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                У вас: {myFatePoints}
              </span>
            </div>

            {!canUseFate ? (
              <p className="text-[10px] italic" style={{ color: 'var(--fate-text-muted)' }}>
                Нет жетонов судьбы
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setFateMode('none')}
                    className={`rounded-lg p-2.5 text-xs font-medium transition-all border ${
                      fateMode === 'none'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-transparent border-border hover:bg-accent'
                    }`}
                  >
                    Без жетона
                  </button>
                  <button
                    type="button"
                    onClick={() => setFateMode('plus2')}
                    className={`rounded-lg p-2.5 text-xs font-medium transition-all border flex items-center justify-center gap-1.5 ${
                      fateMode === 'plus2'
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-transparent border-border hover:bg-accent'
                    }`}
                  >
                    <Flame className="size-3.5" />
                    +2 аспект
                  </button>
                </div>

                {/* Optional reason — collapsed by default */}
                <button
                  type="button"
                  onClick={() => setShowReason((s) => !s)}
                  className="flex items-center gap-1 text-[10px] transition-colors hover:opacity-70"
                  style={{ color: 'var(--fate-text-muted)' }}
                >
                  {showReason ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
                  Указать аспект (опционально)
                </button>
                {showReason && (
                  <Input
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Какой аспект задействуете?"
                    className="text-xs h-8"
                  />
                )}
              </>
            )}
          </div>

          {/* Ready status hint */}
          {myParticipant.ready && (
            <div
              className="rounded-lg p-2 flex items-center justify-center gap-2 text-xs"
              style={{ backgroundColor: 'var(--fate-bg-warm)', color: 'var(--fate-text-muted)' }}
            >
              <Clock className="size-3.5 animate-pulse" />
              Ждём остальных игроков...
            </div>
          )}
        </>
      )}

      {/* ── Phase 2: Post-roll (results + adjustments) ────── */}
      {hasRolled && (
        <>
          {/* Results list — all participants, sorted by total desc */}
          <div className="space-y-1.5">
            {sortedResults.map((p, idx) => {
              const isMe = p.characterId === myParticipant.characterId;
              const isBest = idx === 0 && sortedResults.length > 1;
              const pRerolls = p.result?.rerollCount ?? 0;
              const pBonuses = p.result?.bonusCount ?? 0;
              const pFreeInvokes = p.result?.freeInvokeCount ?? 0;
              return (
                <div
                  key={p.characterId}
                  className={`rounded-lg p-2.5 flex items-center gap-2.5 transition-all ${isMe ? 'ring-1 ring-offset-0' : ''}`}
                  style={{
                    backgroundColor: isMe ? 'rgba(230, 126, 34, 0.08)' : 'var(--fate-bg-warm)',
                    // @ts-expect-error CSS custom property
                    '--tw-ring-color': 'var(--fate-accent)',
                  }}
                >
                  {/* Rank / icon */}
                  <div className="flex-shrink-0 w-6 flex items-center justify-center">
                    {isBest ? (
                      <Crown className="size-4" style={{ color: '#f39c12' }} />
                    ) : (
                      <span className="text-[10px] font-bold" style={{ color: 'var(--fate-text-muted)' }}>
                        {idx + 1}
                      </span>
                    )}
                  </div>

                  {/* Name + dice + adjustment badges */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span
                        className="text-xs font-semibold truncate"
                        style={{ color: isMe ? 'var(--fate-accent)' : 'var(--fate-text)' }}
                      >
                        {p.characterName}
                      </span>
                      {isMe && (
                        <Badge variant="outline" className="text-[8px] px-1 py-0" style={{ color: 'var(--fate-accent)' }}>
                          Вы
                        </Badge>
                      )}
                      {/* Adjustment badges — show for everyone, so all players see each other's adjustments */}
                      {pRerolls > 0 && (
                        <Badge variant="outline" className="text-[8px] px-1 py-0 gap-0.5" style={{ color: '#e67e22' }}>
                          <RefreshCw className="size-2.5" />
                          {pRerolls > 1 ? `×${pRerolls}` : ''}
                        </Badge>
                      )}
                      {pBonuses > 0 && (
                        <Badge variant="outline" className="text-[8px] px-1 py-0 gap-0.5" style={{ color: '#27ae60' }}>
                          <Plus className="size-2.5" />
                          {pBonuses * 2}{pBonuses > 1 ? ` (×${pBonuses})` : ''}
                        </Badge>
                      )}
                      {pFreeInvokes > 0 && (
                        <Badge variant="outline" className="text-[8px] px-1 py-0 gap-0.5" style={{ color: '#9b59b6' }}>
                          <Gift className="size-2.5" />
                          {pFreeInvokes * 2}{pFreeInvokes > 1 ? ` (×${pFreeInvokes})` : ''}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5">
                      <DiceChips dice={p.result?.dice} size="sm" animate={false} />
                    </div>
                  </div>

                  {/* Total + result badge */}
                  <div className="flex-shrink-0 text-right">
                    <div className="text-lg font-black leading-none" style={{ color: 'var(--fate-text)' }}>
                      {formatTotal(p.result?.total ?? 0)}
                    </div>
                    <Badge
                      className="text-[9px] mt-0.5 px-1.5 py-0"
                      style={resultBadgeStyle(p.result?.resultLabel ?? '')}
                    >
                      {p.result?.resultLabel}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Adjustment actions (only for my character) ── */}
          <Separator />
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-xs font-medium" style={{ color: 'var(--fate-text)' }}>
                Корректировки
              </Label>
              <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                Жетонов: {myFatePoints}
              </span>
            </div>

            {/* Three action buttons in a row */}
            <div className="grid grid-cols-3 gap-1.5">
              {/* Reroll */}
              <button
                type="button"
                disabled={!canReroll}
                onClick={() => handleAdjust('reroll')}
                className="rounded-lg p-2 text-[10px] font-medium transition-all border flex flex-col items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: pendingAdjust === 'reroll' ? 'rgba(230, 126, 34, 0.15)' : 'transparent',
                  borderColor: pendingAdjust === 'reroll' ? '#e67e22' : 'var(--fate-border)',
                  color: '#e67e22',
                }}
                title="Перебросить кубики за 1 жетон судьбы. Можно использовать несколько раз."
              >
                <RefreshCw className={`size-4 ${pendingAdjust === 'reroll' ? 'animate-spin' : ''}`} />
                Переброс
                {myRerolls > 0 && <span className="text-[8px] opacity-70">×{myRerolls}</span>}
              </button>

              {/* +2 bonus */}
              <button
                type="button"
                disabled={!canPlus2}
                onClick={() => handleAdjust('plus2')}
                className="rounded-lg p-2 text-[10px] font-medium transition-all border flex flex-col items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: pendingAdjust === 'plus2' ? 'rgba(39, 174, 96, 0.15)' : 'transparent',
                  borderColor: pendingAdjust === 'plus2' ? '#27ae60' : 'var(--fate-border)',
                  color: '#27ae60',
                }}
                title="Призвать аспект: +2 к броску за 1 жетон судьбы. Трата жетона судьбы = призыв аспекта. Можно использовать несколько раз."
              >
                <Plus className={`size-4 ${pendingAdjust === 'plus2' ? 'animate-pulse' : ''}`} />
                +2 аспект
                {myBonuses > 0 && <span className="text-[8px] opacity-70">×{myBonuses}</span>}
              </button>

              {/* Free invoke */}
              <button
                type="button"
                disabled={!canFreeInvoke}
                onClick={() => handleAdjust('free-invoke')}
                className="rounded-lg p-2 text-[10px] font-medium transition-all border flex flex-col items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: pendingAdjust === 'free-invoke' ? 'rgba(155, 89, 182, 0.15)' : 'transparent',
                  borderColor: pendingAdjust === 'free-invoke' ? '#9b59b6' : 'var(--fate-border)',
                  color: '#9b59b6',
                }}
                title="Бесплатный призыв аспекта: +2 без траты жетона. Для аспектов с бесплатными призывами (созданных через Создание преимущества)."
              >
                <Gift className={`size-4 ${pendingAdjust === 'free-invoke' ? 'animate-pulse' : ''}`} />
                Бесплатно
                {myFreeInvokes > 0 && <span className="text-[8px] opacity-70">×{myFreeInvokes}</span>}
              </button>
            </div>

            {/* Helper text */}
            <p className="text-[9px] leading-relaxed" style={{ color: 'var(--fate-text-muted)' }}>
              <RefreshCw className="inline size-2.5 mr-1" />Переброс и <Plus className="inline size-2.5 mx-0.5" />+2 стоят по 1 жетону.
              <Gift className="inline size-2.5 mx-1" />Бесплатный призыв не тратит жетон — для аспектов с бесплатными призывами.
              Все корректировки можно применять несколько раз.
            </p>

            {/* Optional reason — collapsed */}
            <button
              type="button"
              onClick={() => setShowReason((s) => !s)}
              className="flex items-center gap-1 text-[10px] transition-colors hover:opacity-70"
              style={{ color: 'var(--fate-text-muted)' }}
            >
              {showReason ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              Указать аспект (опционально)
            </button>
            {showReason && (
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Какой аспект призывается?"
                className="text-xs h-8"
              />
            )}
          </div>
        </>
      )}
    </FloatingPanel>
  );
}
