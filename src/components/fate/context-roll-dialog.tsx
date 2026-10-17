'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Swords, Dice5 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useFateStore } from '@/lib/store';
import { calculateCrowdHelpers, groupCrowdHelpers, performRoll } from '@/lib/fate-dice';
import type { RollResult, RollHelper } from '@/lib/types';
import { DiceChips } from '@/components/fate/dice-chips';

interface ContextRollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selected attacker character id (from right-click context) */
  attackerId: string | null;
  /** Pre-selected defender character id (optional, can be selected in dialog) */
  defenderId?: string | null;
}

export function ContextRollDialog({
  open,
  onOpenChange,
  attackerId,
  defenderId,
}: ContextRollDialogProps) {
  const { getCharacter, getSceneCharacters, addLogEntry, currentAdventureId, characters } = useFateStore();
  const sceneCharacters = getSceneCharacters();

  // ── Selection state ──────────────────────────────────────────
  const [attackerCharId, setAttackerCharId] = useState<string>(attackerId ?? '');
  const [defenderCharId, setDefenderCharId] = useState<string>(defenderId ?? '');
  const [attackerSkillName, setAttackerSkillName] = useState<string>('');
  const [defenderSkillName, setDefenderSkillName] = useState<string>('');
  const [attackerBonus, setAttackerBonus] = useState(0);
  const [defenderBonus, setDefenderBonus] = useState(0);
  const [attackerCrowdEffortEnabled, setAttackerCrowdEffort] = useState(false);
  const [defenderCrowdEffortEnabled, setDefenderCrowdEffort] = useState(false);

  // ── Result state ─────────────────────────────────────────────
  const [attackerResult, setAttackerResult] = useState<RollResult | null>(null);
  const [defenderResult, setDefenderResult] = useState<RollResult | null>(null);
  const [isRolling, setIsRolling] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [rollingDice, setRollingDice] = useState<number[]>([0, 0, 0, 0]);

  // ── Derived characters ───────────────────────────────────────
  const attackerChar = attackerCharId ? getCharacter(attackerCharId) : null;
  const defenderChar = defenderCharId ? getCharacter(defenderCharId) : null;

  // ── Animate rolling dice display ─────────────────────────────
  useEffect(() => {
    if (!isRolling) return;
    const interval = setInterval(() => {
      setRollingDice([
        Math.floor(Math.random() * 3) - 1,
        Math.floor(Math.random() * 3) - 1,
        Math.floor(Math.random() * 3) - 1,
        Math.floor(Math.random() * 3) - 1,
      ]);
    }, 80);
    return () => clearInterval(interval);
  }, [isRolling]);

  // ── Reset state when dialog opens ────────────────────────────
  useEffect(() => {
    if (open) {
      setAttackerCharId(attackerId ?? '');
      setDefenderCharId(defenderId ?? '');
      setAttackerSkillName('');
      setDefenderSkillName('');
      setAttackerBonus(0);
      setDefenderBonus(0);
      setAttackerCrowdEffort(false);
      setDefenderCrowdEffort(false);
      setAttackerResult(null);
      setDefenderResult(null);
      setShowResult(false);
    }
  }, [open, attackerId, defenderId]);

  // ── Auto-select highest combat skill when character changes ──
  useEffect(() => {
    if (attackerChar && !attackerSkillName) {
      const combatSkill = attackerChar.skills.find((s) => s.name === 'Бой');
      if (combatSkill && combatSkill.value > 0) {
        setAttackerSkillName('Бой');
      } else {
        const topSkill = attackerChar.skills
          .filter((s) => s.value >= 0)
          .sort((a, b) => b.value - a.value)[0];
        if (topSkill) setAttackerSkillName(topSkill.name);
      }
    }
  }, [attackerChar, attackerSkillName]);

  useEffect(() => {
    if (defenderChar && !defenderSkillName) {
      const defenseSkill = defenderChar.skills.find((s) => s.name === 'Бой');
      if (defenseSkill && defenseSkill.value > 0) {
        setDefenderSkillName('Бой');
      } else {
        const topSkill = defenderChar.skills
          .filter((s) => s.value >= 0)
          .sort((a, b) => b.value - a.value)[0];
        if (topSkill) setDefenderSkillName(topSkill.name);
      }
    }
  }, [defenderChar, defenderSkillName]);

  // ── Skill values ─────────────────────────────────────────────
  const attackerSkillValue = attackerChar?.skills.find((s) => s.name === attackerSkillName)?.value ?? 0;
  const defenderSkillValue = defenderChar?.skills.find((s) => s.name === defenderSkillName)?.value ?? 0;

  // ── Crowd team effort helpers (Fate Core "mobs" rule) ───────
  // Each additional active member whose base character has the selected
  // skill at +1 or higher adds +1 to the roll.
  const attackerCrowdEffort = useMemo(() => {
    return calculateCrowdHelpers(attackerChar, attackerSkillName ?? '', attackerSkillValue, characters);
  }, [attackerChar, attackerSkillName, attackerSkillValue, characters]);

  const attackerCrowdHelperBonus = attackerCrowdEffort.totalHelperBonus;
  const attackerCrowdHelpers: RollHelper[] = attackerCrowdEffort.helpers;

  const attackerCrowdActiveCount = useMemo(() => {
    if (!attackerChar?.isHorde || !attackerChar.members) return 0;
    return attackerChar.members.filter((m) => m.isActive).length;
  }, [attackerChar]);

  const defenderCrowdEffort = useMemo(() => {
    return calculateCrowdHelpers(defenderChar, defenderSkillName ?? '', defenderSkillValue, characters);
  }, [defenderChar, defenderSkillName, defenderSkillValue, characters]);

  const defenderCrowdHelperBonus = defenderCrowdEffort.totalHelperBonus;
  const defenderCrowdHelpers: RollHelper[] = defenderCrowdEffort.helpers;

  const defenderCrowdActiveCount = useMemo(() => {
    if (!defenderChar?.isHorde || !defenderChar.members) return 0;
    return defenderChar.members.filter((m) => m.isActive).length;
  }, [defenderChar]);

  // ── Perform the opposed roll ─────────────────────────────────
  const handleRoll = useCallback(async () => {
    if (!attackerCharId || !defenderCharId) return;
    setIsRolling(true);
    setShowResult(false);

    // Simulate dice rolling animation
    await new Promise((resolve) => setTimeout(resolve, 600));

    try {
      // ── Crowd team effort bonuses ────────────────────────────
      const aCrowdBonus = attackerCrowdEffortEnabled ? attackerCrowdHelperBonus : 0;
      const dCrowdBonus = defenderCrowdEffortEnabled ? defenderCrowdHelperBonus : 0;
      const aSkill = attackerSkillValue + attackerBonus + aCrowdBonus;
      const dSkill = defenderSkillValue + defenderBonus + dCrowdBonus;

      // Roll defender first (so attacker's result can reference opponent total)
      const dResult = performRoll(dSkill);
      const aResult = performRoll(aSkill, null, dResult.total);

      setAttackerResult(aResult);
      setDefenderResult(dResult);
      setRollingDice(aResult.dice);
      setShowResult(true);

      // Determine overall result label
      let overallLabel: string;
      if (aResult.total > dResult.total) {
        const shifts = aResult.total - dResult.total;
        overallLabel = shifts >= 3
          ? `Атака: Успех с стилем (+${shifts})`
          : `Атака: Успех (+${shifts})`;
      } else if (aResult.total === dResult.total) {
        overallLabel = 'Ничья';
      } else {
        const shifts = dResult.total - aResult.total;
        overallLabel = `Защита: Успех (+${shifts})`;
      }

      // Build custom text mentioning crowd effort if active
      const crowdParts: string[] = [];
      if (attackerCrowdEffortEnabled && attackerCrowdActiveCount >= 2) {
        const helperNames = attackerCrowdHelpers
          .map((h) => `${h.name} (${h.bonus > 0 ? `+${h.bonus}` : '0'})`)
          .join(', ');
        crowdParts.push(`🤝 Атакующая толпа: ${attackerCrowdEffort.rollerName} (навык +${attackerSkillValue})${attackerCrowdHelpers.length > 0 ? ` + помощь: ${helperNames} = +${aCrowdBonus}` : ''}`);
      }
      if (defenderCrowdEffortEnabled && defenderCrowdActiveCount >= 2) {
        const helperNames = defenderCrowdHelpers
          .map((h) => `${h.name} (${h.bonus > 0 ? `+${h.bonus}` : '0'})`)
          .join(', ');
        crowdParts.push(`🤝 Защищающаяся толпа: ${defenderCrowdEffort.rollerName} (навык +${defenderSkillValue})${defenderCrowdHelpers.length > 0 ? ` + помощь: ${helperNames} = +${dCrowdBonus}` : ''}`);
      }
      const customText = crowdParts.length > 0
        ? `⚔️ Контекстный бросок: ${attackerChar?.name ?? 'Атакующий'} vs ${defenderChar?.name ?? 'Защитник'} — ${crowdParts.join('; ')}`
        : `⚔️ Контекстный бросок: ${attackerChar?.name ?? 'Атакующий'} vs ${defenderChar?.name ?? 'Защитник'}`;

      // The attacker helpers list — only populated when crowd effort is enabled
      const attackerHelpers: RollHelper[] = attackerCrowdEffortEnabled ? attackerCrowdHelpers : [];
      // The defender helpers list — only populated when defender crowd effort
      // is enabled. Stored separately so the tooltip can show the defender's
      // crowd breakdown in the opponent column (transparency: where the
      // defender's total comes from).
      const defenderHelpers: RollHelper[] = defenderCrowdEffortEnabled ? defenderCrowdHelpers : [];

      // Log the roll
      await addLogEntry({
        adventureId: currentAdventureId ?? undefined,
        characterId: attackerCharId,
        characterName: attackerChar?.name ?? 'Неизвестный',
        skillName: attackerSkillName || 'Навык',
        diceResults: aResult.dice,
        bonus: aSkill,
        total: aResult.total,
        difficulty: null,
        opponentTotal: dResult.total,
        result: overallLabel,
        opponentType: 'character',
        opponentCharacterId: defenderCharId || null,
        opponentName: defenderChar?.name ?? null,
        opponentSkillName: defenderSkillName || null,
        opponentDiceResults: dResult.dice,
        opponentBonus: dSkill,
        // ── Opponent rich-tooltip fields ──
        // Store the defender's raw skill value separately so the tooltip can
        // show "Athletics +3" rather than dumping the value into the bonus
        // field. The defender's crowd helper bonus is conveyed via the
        // helpers list + customText, NOT merged into opponentManualBonus.
        opponentSkillValue: defenderSkillValue,
        opponentManualBonus: defenderBonus,
        extraBonus: attackerBonus + aCrowdBonus,
        extraBonusReason: (attackerBonus !== 0 || aCrowdBonus !== 0) ? 'Ситуативный бонус' : '',
        rerolled: false,
        customText,
        isRiftEvent: false,
        // ── Rich-tooltip fields ──
        // IMPORTANT: manualBonus is ONLY the user-set situational bonus.
        // The crowd helper bonus is conveyed via the `helpers` list (so the
        // tooltip can show grouped "Гоблин ×2: +2, Волк ×3: 0").
        skillValue: attackerSkillValue,
        manualBonus: attackerBonus,
        helpers: attackerHelpers,
        aspectInvokeBonus: 0,
        aspectInvokeReason: '',
        aspectRerolled: false,
        // Defender crowd helpers — shown in the opponent column of the tooltip
        // so the source of the defender's total is fully transparent.
        opponentHelpers: defenderHelpers,
      });
    } finally {
      setIsRolling(false);
    }
  }, [
    attackerCharId, defenderCharId, attackerSkillValue, defenderSkillValue,
    attackerBonus, defenderBonus, attackerSkillName, defenderSkillName,
    attackerChar, defenderChar, currentAdventureId, addLogEntry,
    attackerCrowdEffortEnabled, defenderCrowdEffortEnabled,
    attackerCrowdEffort, defenderCrowdEffort,
    attackerCrowdHelperBonus, defenderCrowdHelperBonus,
    attackerCrowdHelpers, defenderCrowdHelpers,
    attackerCrowdActiveCount, defenderCrowdActiveCount,
  ]);

  // ── Result color helpers ─────────────────────────────────────
  const getResultColor = (type: 'attacker' | 'defender') => {
    if (!attackerResult || !defenderResult) return '';
    if (attackerResult.total > defenderResult.total) {
      return type === 'attacker' ? 'var(--fate-success)' : 'var(--fate-danger)';
    }
    if (attackerResult.total < defenderResult.total) {
      return type === 'defender' ? 'var(--fate-success)' : 'var(--fate-danger)';
    }
    return '#f39c12'; // tie
  };

  const getResultBg = (type: 'attacker' | 'defender') => {
    if (!attackerResult || !defenderResult) return '';
    if (attackerResult.total > defenderResult.total) {
      return type === 'attacker' ? 'rgba(39, 174, 96, 0.06)' : 'rgba(231, 76, 60, 0.06)';
    }
    if (attackerResult.total < defenderResult.total) {
      return type === 'defender' ? 'rgba(39, 174, 96, 0.06)' : 'rgba(231, 76, 60, 0.06)';
    }
    return 'rgba(243, 156, 18, 0.06)'; // tie
  };

  const getOutcomeLabel = () => {
    if (!attackerResult || !defenderResult) return '';
    if (attackerResult.total > defenderResult.total) {
      const shifts = attackerResult.total - defenderResult.total;
      return shifts >= 3
        ? `Успех с стилем (+${shifts})`
        : `Успех (+${shifts})`;
    }
    if (attackerResult.total === defenderResult.total) {
      return 'Ничья';
    }
    const shifts = defenderResult.total - attackerResult.total;
    return `Защита успешна (+${shifts})`;
  };

  const getOutcomeColor = () => {
    if (!attackerResult || !defenderResult) return '';
    if (attackerResult.total > defenderResult.total) return 'var(--fate-success)';
    if (attackerResult.total < defenderResult.total) return 'var(--fate-danger)';
    return '#f39c12';
  };

  const getOutcomeBg = () => {
    if (!attackerResult || !defenderResult) return '';
    if (attackerResult.total > defenderResult.total) return 'rgba(39, 174, 96, 0.06)';
    if (attackerResult.total < defenderResult.total) return 'rgba(231, 76, 60, 0.06)';
    return 'rgba(243, 156, 18, 0.06)';
  };

  // ── Available characters (exclude self from defender list and vice versa) ──
  const availableAttackers = sceneCharacters;
  const availableDefenders = sceneCharacters.filter((c) => c.id !== attackerCharId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[92vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title fate-dialog-title-bar">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <Swords className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Соревновательный бросок
          </DialogTitle>
          <DialogDescription>
            Атакующий и защитник бросают кости одновременно
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto fate-scroll flex-1 min-h-0">
          {/* ── Attacker Section ────────────────────────────────── */}
          <div
            className="rounded-xl p-4 space-y-3"
            style={{
              background: 'linear-gradient(135deg, rgba(230, 126, 34, 0.08), rgba(230, 126, 34, 0.03))',
              border: '1px solid rgba(230, 126, 34, 0.15)',
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <Swords className="size-3.5" style={{ color: 'var(--fate-accent)' }} />
              <span className="text-xs font-semibold uppercase tracking-wider fate-section-header pb-1" style={{ color: 'var(--fate-accent)' }}>
                Атакующий
              </span>
            </div>

            {/* Attacker select */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Персонаж
              </Label>
              <Select value={attackerCharId} onValueChange={(v) => { setAttackerCharId(v); setAttackerSkillName(''); }}>
                <SelectTrigger className="w-full rounded-lg">
                  <SelectValue placeholder="Выберите атакующего" />
                </SelectTrigger>
                <SelectContent>
                  {availableAttackers.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      Нет персонажей на сцене
                    </SelectItem>
                  ) : (
                    availableAttackers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Attacker skill */}
            {attackerChar && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Навык атакующего
                </Label>
                <Select value={attackerSkillName} onValueChange={setAttackerSkillName}>
                  <SelectTrigger className="w-full rounded-lg">
                    <SelectValue placeholder="Выберите навык" />
                  </SelectTrigger>
                  <SelectContent>
                    {attackerChar.skills
                      .filter((s) => s.value >= 0)
                      .sort((a, b) => b.value - a.value)
                      .map((s) => (
                        <SelectItem key={s.name} value={s.name}>
                          {s.name} (+{s.value})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Attacker bonus */}
            {attackerChar && (
              <div className="flex items-center gap-2">
                <Label className="text-xs shrink-0" style={{ color: 'var(--fate-text-muted)' }}>
                  Бонус
                </Label>
                <Button
                  variant="outline"
                  size="sm"
                  className="size-7 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                  onClick={() => setAttackerBonus((b) => b - 1)}
                >
                  −
                </Button>
                <Input
                  type="number"
                  value={attackerBonus}
                  onChange={(e) => setAttackerBonus(parseInt(e.target.value) || 0)}
                  className="text-center w-16 font-semibold text-sm rounded-lg h-7"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="size-7 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                  onClick={() => setAttackerBonus((b) => b + 1)}
                >
                  +
                </Button>
                <span className="text-xs ml-1" style={{ color: 'var(--fate-text-muted)' }}>
                  Итого: +{attackerSkillValue + attackerBonus + (attackerCrowdEffortEnabled ? attackerCrowdHelperBonus : 0)}
                </span>
              </div>
            )}

            {/* Attacker crowd team effort checkbox */}
            {attackerChar?.isHorde && attackerChar.members && attackerCrowdActiveCount >= 2 && (
              <div
                className="flex items-center gap-2 p-2 rounded-lg"
                style={{
                  backgroundColor: attackerCrowdEffortEnabled ? 'rgba(192, 57, 43, 0.08)' : 'var(--fate-bg-card)',
                  border: `1px solid ${attackerCrowdEffortEnabled ? 'rgba(192, 57, 43, 0.25)' : 'var(--fate-border)'}`,
                }}
              >
                <Checkbox
                  checked={attackerCrowdEffortEnabled}
                  onCheckedChange={(checked) => setAttackerCrowdEffort(!!checked)}
                  className="size-3.5 rounded"
                  style={{ borderColor: '#c0392b' }}
                />
                <div className="min-w-0 flex-1">
                  <span className="text-[11px] font-medium" style={{ color: 'var(--fate-text)' }}>
                    🤝 Толпа: +{attackerCrowdHelperBonus} ({attackerCrowdActiveCount} уч.)
                  </span>
                  {attackerCrowdEffortEnabled && attackerCrowdHelpers.length > 0 && (
                    <div className="text-[9px] mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0">
                      {attackerCrowdHelpers.map((h, idx) => (
                        <span
                          key={idx}
                          style={{
                            color: h.bonus > 0 ? '#27ae60' : 'var(--fate-text-muted)',
                            fontWeight: h.bonus > 0 ? 600 : 400,
                          }}
                        >
                          {h.name}: {h.bonus > 0 ? `+${h.bonus}` : '0'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* ── VS Divider ─────────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span
              className="text-xs font-bold px-2 py-0.5 rounded-full"
              style={{
                color: 'var(--fate-accent)',
                backgroundColor: 'rgba(230, 126, 34, 0.1)',
              }}
            >
              VS
            </span>
            <Separator className="flex-1" />
          </div>

          {/* ── Defender Section ────────────────────────────────── */}
          <div
            className="rounded-xl p-4 space-y-3"
            style={{
              background: 'linear-gradient(135deg, rgba(231, 76, 60, 0.06), rgba(231, 76, 60, 0.02))',
              border: '1px solid rgba(231, 76, 60, 0.12)',
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <Swords className="size-3.5 rotate-180" style={{ color: '#e74c3c' }} />
              <span className="text-xs font-semibold uppercase tracking-wider fate-section-header pb-1" style={{ color: '#e74c3c' }}>
                Защитник
              </span>
            </div>

            {/* Defender select */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Персонаж
              </Label>
              <Select value={defenderCharId} onValueChange={(v) => { setDefenderCharId(v); setDefenderSkillName(''); }}>
                <SelectTrigger className="w-full rounded-lg">
                  <SelectValue placeholder="Выберите защитника" />
                </SelectTrigger>
                <SelectContent>
                  {availableDefenders.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      Нет персонажей на сцене
                    </SelectItem>
                  ) : (
                    availableDefenders.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* Defender skill */}
            {defenderChar && (
              <div className="space-y-1.5">
                <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Навык защитника
                </Label>
                <Select value={defenderSkillName} onValueChange={setDefenderSkillName}>
                  <SelectTrigger className="w-full rounded-lg">
                    <SelectValue placeholder="Выберите навык" />
                  </SelectTrigger>
                  <SelectContent>
                    {defenderChar.skills
                      .filter((s) => s.value >= 0)
                      .sort((a, b) => b.value - a.value)
                      .map((s) => (
                        <SelectItem key={s.name} value={s.name}>
                          {s.name} (+{s.value})
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {/* Defender bonus */}
            {defenderChar && (
              <div className="flex items-center gap-2">
                <Label className="text-xs shrink-0" style={{ color: 'var(--fate-text-muted)' }}>
                  Бонус
                </Label>
                <Button
                  variant="outline"
                  size="sm"
                  className="size-7 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                  onClick={() => setDefenderBonus((b) => b - 1)}
                >
                  −
                </Button>
                <Input
                  type="number"
                  value={defenderBonus}
                  onChange={(e) => setDefenderBonus(parseInt(e.target.value) || 0)}
                  className="text-center w-16 font-semibold text-sm rounded-lg h-7"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="size-7 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                  onClick={() => setDefenderBonus((b) => b + 1)}
                >
                  +
                </Button>
                <span className="text-xs ml-1" style={{ color: 'var(--fate-text-muted)' }}>
                  Итого: +{defenderSkillValue + defenderBonus + (defenderCrowdEffortEnabled ? defenderCrowdHelperBonus : 0)}
                </span>
              </div>
            )}

            {/* Defender crowd team effort checkbox */}
            {defenderChar?.isHorde && defenderChar.members && defenderCrowdActiveCount >= 2 && (
              <div
                className="flex items-center gap-2 p-2 rounded-lg"
                style={{
                  backgroundColor: defenderCrowdEffortEnabled ? 'rgba(192, 57, 43, 0.08)' : 'var(--fate-bg-card)',
                  border: `1px solid ${defenderCrowdEffortEnabled ? 'rgba(192, 57, 43, 0.25)' : 'var(--fate-border)'}`,
                }}
              >
                <Checkbox
                  checked={defenderCrowdEffortEnabled}
                  onCheckedChange={(checked) => setDefenderCrowdEffort(!!checked)}
                  className="size-3.5 rounded"
                  style={{ borderColor: '#c0392b' }}
                />
                <div className="min-w-0 flex-1">
                  <span className="text-[11px] font-medium" style={{ color: 'var(--fate-text)' }}>
                    🤝 Толпа: +{defenderCrowdHelperBonus} ({defenderCrowdActiveCount} уч.)
                  </span>
                  {defenderCrowdEffortEnabled && defenderCrowdHelpers.length > 0 && (
                    <div className="text-[9px] mt-0.5 flex flex-wrap gap-x-1.5 gap-y-0">
                      {defenderCrowdHelpers.map((h, idx) => (
                        <span
                          key={idx}
                          style={{
                            color: h.bonus > 0 ? '#27ae60' : 'var(--fate-text-muted)',
                            fontWeight: h.bonus > 0 ? 600 : 400,
                          }}
                        >
                          {h.name}: {h.bonus > 0 ? `+${h.bonus}` : '0'}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* ── Result Display ──────────────────────────────────── */}
          {isRolling ? (
            <div
              className="rounded-xl p-6 text-center space-y-3"
              style={{ backgroundColor: 'var(--fate-bg-warm)' }}
            >
              <div
                className="inline-flex items-center justify-center"
                style={{
                  animation: 'fate-dice-roll 0.6s ease-out',
                }}
              >
                <DiceChips dice={rollingDice} size="lg" animate={false} />
              </div>
              <div className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Бросаю кубики...
              </div>
            </div>
          ) : attackerResult && defenderResult && showResult ? (
            <div className="space-y-3">
              {/* Overall outcome badge */}
              <div
                className="rounded-xl p-4 text-center space-y-2 fate-dice-reveal"
                style={{ backgroundColor: getOutcomeBg(), border: `1px solid ${getOutcomeColor()}20` }}
              >
                <Badge
                  className="text-sm px-4 py-1.5 font-semibold rounded-lg shadow-sm"
                  style={{ backgroundColor: getOutcomeColor(), color: 'white', border: 'none' }}
                >
                  {getOutcomeLabel()}
                </Badge>
              </div>

              {/* Side-by-side results */}
              <div className="grid grid-cols-2 gap-3">
                {/* Attacker result */}
                <div
                  className="rounded-xl p-3 text-center space-y-2"
                  style={{
                    backgroundColor: getResultBg('attacker'),
                    border: `1px solid ${getResultColor('attacker')}20`,
                  }}
                >
                  <div className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                    {attackerChar?.name ?? 'Атакующий'}
                    {attackerSkillName && ` — ${attackerSkillName}`}
                  </div>
                  <div className="flex justify-center">
                    <DiceChips dice={attackerResult.dice} size="lg" />
                  </div>
                  <div
                    className="text-3xl font-black tracking-tight"
                    style={{ color: getResultColor('attacker') }}
                  >
                    {attackerResult.total >= 0 ? `+${attackerResult.total}` : attackerResult.total}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                    Кубики: {(attackerResult.dice.reduce<number>((a, b) => a + b, 0) >= 0 ? '+' : '')}
                    {attackerResult.dice.reduce<number>((a, b) => a + b, 0)}
                    {' + '}Навык: +{attackerSkillValue}
                    {attackerCrowdEffortEnabled && attackerCrowdHelperBonus > 0 && (
                      <span style={{ color: '#c0392b', fontWeight: 700 }}>
                        {' + '}Помощь: +{attackerCrowdHelperBonus}
                      </span>
                    )}
                    {attackerBonus !== 0 && (
                      <> {' + '}Бонус: {attackerBonus >= 0 ? '+' : ''}{attackerBonus}</>
                    )}
                  </div>
                  {/* Attacker crowd helpers breakdown — grouped by type */}
                  {attackerCrowdEffortEnabled && attackerCrowdHelpers.length > 0 && (
                    <div
                      className="text-[9px] rounded-md p-1.5 text-left"
                      style={{
                        backgroundColor: 'rgba(192, 57, 43, 0.06)',
                        border: '1px solid rgba(192, 57, 43, 0.12)',
                        color: 'var(--fate-text-muted)',
                      }}
                    >
                      <div className="font-semibold mb-0.5 flex items-center justify-between" style={{ color: '#c0392b' }}>
                        <span>🤝 Помощь толпы</span>
                        <span>+{attackerCrowdHelperBonus}</span>
                      </div>
                      <div className="space-y-0">
                        {groupCrowdHelpers(attackerCrowdHelpers).map((g, idx) => (
                          <div key={idx} className="flex justify-between gap-1.5 items-baseline">
                            <span className="truncate">
                              <span className="font-semibold" style={{ color: 'var(--fate-text)' }}>{g.typeLabel}</span>
                              <span style={{ color: 'var(--fate-text-muted)' }}> ×{g.count}</span>
                              {g.skillName && (
                                <span style={{ color: 'var(--fate-text-muted)' }}>
                                  {' '}{g.skillName}{g.skillValue !== undefined ? ` ${g.skillValue >= 0 ? '+' : ''}${g.skillValue}` : ''}
                                </span>
                              )}
                            </span>
                            <span style={{
                              color: g.totalBonus > 0 ? '#27ae60' : 'var(--fate-text-muted)',
                              fontWeight: 700,
                            }}>
                              {g.totalBonus > 0 ? `+${g.totalBonus}` : '0'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Defender result */}
                <div
                  className="rounded-xl p-3 text-center space-y-2"
                  style={{
                    backgroundColor: getResultBg('defender'),
                    border: `1px solid ${getResultColor('defender')}20`,
                  }}
                >
                  <div className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                    {defenderChar?.name ?? 'Защитник'}
                    {defenderSkillName && ` — ${defenderSkillName}`}
                  </div>
                  <div className="flex justify-center">
                    <DiceChips dice={defenderResult.dice} size="lg" />
                  </div>
                  <div
                    className="text-3xl font-black tracking-tight"
                    style={{ color: getResultColor('defender') }}
                  >
                    {defenderResult.total >= 0 ? `+${defenderResult.total}` : defenderResult.total}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                    Кубики: {(defenderResult.dice.reduce<number>((a, b) => a + b, 0) >= 0 ? '+' : '')}
                    {defenderResult.dice.reduce<number>((a, b) => a + b, 0)}
                    {' + '}Навык: +{defenderSkillValue}
                    {defenderCrowdEffortEnabled && defenderCrowdHelperBonus > 0 && (
                      <span style={{ color: '#c0392b', fontWeight: 700 }}>
                        {' + '}Помощь: +{defenderCrowdHelperBonus}
                      </span>
                    )}
                    {defenderBonus !== 0 && (
                      <> {' + '}Бонус: {defenderBonus >= 0 ? '+' : ''}{defenderBonus}</>
                    )}
                  </div>
                  {/* Defender crowd helpers breakdown — grouped by type */}
                  {defenderCrowdEffortEnabled && defenderCrowdHelpers.length > 0 && (
                    <div
                      className="text-[9px] rounded-md p-1.5 text-left"
                      style={{
                        backgroundColor: 'rgba(192, 57, 43, 0.06)',
                        border: '1px solid rgba(192, 57, 43, 0.12)',
                        color: 'var(--fate-text-muted)',
                      }}
                    >
                      <div className="font-semibold mb-0.5 flex items-center justify-between" style={{ color: '#c0392b' }}>
                        <span>🤝 Помощь толпы</span>
                        <span>+{defenderCrowdHelperBonus}</span>
                      </div>
                      <div className="space-y-0">
                        {groupCrowdHelpers(defenderCrowdHelpers).map((g, idx) => (
                          <div key={idx} className="flex justify-between gap-1.5 items-baseline">
                            <span className="truncate">
                              <span className="font-semibold" style={{ color: 'var(--fate-text)' }}>{g.typeLabel}</span>
                              <span style={{ color: 'var(--fate-text-muted)' }}> ×{g.count}</span>
                              {g.skillName && (
                                <span style={{ color: 'var(--fate-text-muted)' }}>
                                  {' '}{g.skillName}{g.skillValue !== undefined ? ` ${g.skillValue >= 0 ? '+' : ''}${g.skillValue}` : ''}
                                </span>
                              )}
                            </span>
                            <span style={{
                              color: g.totalBonus > 0 ? '#27ae60' : 'var(--fate-text-muted)',
                              fontWeight: 700,
                            }}>
                              {g.totalBonus > 0 ? `+${g.totalBonus}` : '0'}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div
              className="rounded-xl p-6 text-center space-y-2"
              style={{ backgroundColor: 'var(--fate-bg-warm)' }}
            >
              <div className="text-2xl opacity-30">⚔️</div>
              <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                Выберите атакующего и защитника, затем бросьте кости
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg"
            onClick={() => onOpenChange(false)}
          >
            Закрыть
          </Button>
          {attackerResult && defenderResult && showResult && (
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg gap-1.5"
              onClick={handleRoll}
              disabled={isRolling}
            >
              <Dice5 className="size-3.5" />
              Ещё раз
            </Button>
          )}
          <Button
            size="sm"
            disabled={isRolling || !attackerCharId || !defenderCharId || !attackerSkillName || !defenderSkillName}
            onClick={handleRoll}
            className="fate-btn-accent fate-button-shine gap-1.5 rounded-lg"
          >
            <Dice5 className={`size-4 ${isRolling ? 'animate-spin' : ''}`} />
            {isRolling ? 'Бросаю...' : 'Бросить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
