'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Dice5 } from 'lucide-react';

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
import { formatCoopRollText, formatExtraBonusReason } from '@/lib/roll-format';
import { DiceChips } from '@/components/fate/dice-chips';

type RollMode = 'normal' | 'difficulty' | 'opposed';

interface SkillRollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  characterId: string | null;
  skillName: string | null;
  skillValue: number;
}

export function SkillRollDialog({
  open,
  onOpenChange,
  characterId,
  skillName,
  skillValue,
}: SkillRollDialogProps) {
  const { getCharacter, getSceneCharacters, addLogEntry, currentAdventureId, characters } = useFateStore();
  const sceneCharacters = getSceneCharacters();
  const character = characterId ? getCharacter(characterId) : null;

  const [bonus, setBonus] = useState(0);
  const [rollMode, setRollMode] = useState<RollMode>('normal');
  const [difficulty, setDifficulty] = useState(2);
  const [opponentId, setOpponentId] = useState<string>('');
  const [opponentSkillName, setOpponentSkillName] = useState<string>('');
  const [lastResult, setLastResult] = useState<RollResult | null>(null);
  const [opponentResult, setOpponentResult] = useState<RollResult | null>(null);
  const [isRolling, setIsRolling] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [rollingDice, setRollingDice] = useState<number[]>([0, 0, 0, 0]);

  const [crowdTeamEffort, setCrowdTeamEffort] = useState(false);

  // Pre-compute crowd team-effort helper bonus (Fate Core "mobs" rule).
  const crowdEffort = useMemo(() => {
    return calculateCrowdHelpers(character, skillName ?? '', skillValue, characters);
  }, [character, skillName, skillValue, characters]);

  const crowdHelperBonus = crowdEffort.totalHelperBonus;
  const crowdHelpers: RollHelper[] = crowdEffort.helpers;

  const crowdActiveCount = useMemo(() => {
    if (!character?.isHorde || !character.members) return 0;
    return character.members.filter((m) => m.isActive).length;
  }, [character]);

  // Animate rolling dice display
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

  // Reset state when dialog opens with a new skill
  useEffect(() => {
    if (open) {
      setLastResult(null);
      setShowResult(false);
      setBonus(0);
      setRollMode('normal');
      setDifficulty(2);
      setOpponentId('');
      setOpponentSkillName('');
      setOpponentResult(null);
      setCrowdTeamEffort(false);
    }
  }, [open, skillName, skillValue]);

  const opponentCharacter = opponentId ? getCharacter(opponentId) : null;

  const handleRoll = useCallback(async () => {
    setIsRolling(true);
    setShowResult(false);

    // Simulate dice rolling animation
    await new Promise((resolve) => setTimeout(resolve, 600));

    try {
      // ── Crowd team effort bonus ──────────────────────────
      let crowdEffortText: string | null = null;
      let crowdHelpersList: RollHelper[] = [];
      let crowdHelperBonusValue = 0;
      if (crowdTeamEffort && character?.isHorde && character.members && skillName) {
        const effort = calculateCrowdHelpers(character, skillName, skillValue, characters);
        crowdHelpersList = effort.helpers;
        crowdHelperBonusValue = effort.totalHelperBonus;
        // Единый формат customText для crowd-effort (совпадает с team mode,
        // блоком бросков и character-roll-dialog). helpers с разбивкой (+skill→+bonus).
        crowdEffortText = formatCoopRollText(
          effort.rollerName,
          skillValue,
          effort.helpers.map((h) => ({ name: h.name, skillValue: h.skillValue ?? 0, bonus: h.bonus }))
        );
      }

      const totalBonus = skillValue + bonus + crowdHelperBonusValue;
      const diff = rollMode === 'difficulty' ? difficulty : null;
      let oppResult: RollResult | null = null;
      let opponentTotal: number | null = null;

      if (rollMode === 'opposed' && opponentId) {
        const oppChar = getCharacter(opponentId);
        if (oppChar) {
          // Find the opponent's skill value for the selected skill (or 0)
          const oppSkillVal = oppChar.skills.find((s) => s.name === opponentSkillName)?.value ?? 0;
          oppResult = performRoll(oppSkillVal);
          opponentTotal = oppResult.total;
        }
      }

      const result = performRoll(totalBonus, diff, opponentTotal);
      setLastResult(result);
      setOpponentResult(oppResult);
      setRollingDice(result.dice);
      setShowResult(true);

      await addLogEntry({
        adventureId: currentAdventureId ?? undefined,
        characterId: characterId ?? null,
        characterName: character?.name ?? 'Неизвестный',
        skillName: skillName ?? 'Навык',
        diceResults: result.dice,
        bonus: totalBonus,
        total: result.total,
        difficulty: diff,
        opponentTotal,
        result: result.label,
        opponentType: rollMode === 'opposed' && opponentId ? 'character' : null,
        opponentCharacterId: rollMode === 'opposed' && opponentId ? opponentId : null,
        opponentName: rollMode === 'opposed' && opponentId ? opponentCharacter?.name ?? null : null,
        opponentSkillName: rollMode === 'opposed' ? opponentSkillName || null : null,
        opponentDiceResults: oppResult?.dice ?? [],
        opponentBonus: oppResult ? skillValue + bonus : 0,
        // ── Opponent rich-tooltip fields ──
        opponentSkillValue: rollMode === 'opposed' && opponentId
          ? (getCharacter(opponentId)?.skills.find((s) => s.name === opponentSkillName)?.value ?? 0)
          : null,
        opponentManualBonus: 0,
        extraBonus: bonus,
        extraBonusReason: formatExtraBonusReason(bonus),
        rerolled: false,
        customText: crowdEffortText,
        isRiftEvent: false,
        // ── Rich-tooltip fields ──
        skillValue,
        manualBonus: bonus,
        helpers: crowdHelpersList,
        aspectInvokeBonus: 0,
        aspectInvokeReason: '',
        aspectRerolled: false,
      });
    } finally {
      setIsRolling(false);
    }
  }, [bonus, rollMode, difficulty, opponentId, opponentSkillName, skillName, skillValue, characterId, character, opponentCharacter, currentAdventureId, getCharacter, addLogEntry, crowdTeamEffort, crowdHelperBonus, crowdActiveCount, characters]);

  const getResultColor = () => {
    if (!lastResult) return '';
    switch (lastResult.type) {
      case 'fail': return 'var(--fate-danger)';
      case 'tie': return '#f39c12';
      case 'success': return 'var(--fate-success)';
      case 'great': return '#1e8449';
    }
  };

  const getResultBg = () => {
    if (!lastResult) return '';
    switch (lastResult.type) {
      case 'fail': return 'rgba(231, 76, 60, 0.06)';
      case 'tie': return 'rgba(243, 156, 18, 0.06)';
      case 'success': return 'rgba(39, 174, 96, 0.06)';
      case 'great': return 'rgba(30, 132, 73, 0.08)';
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[92vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title fate-dialog-title-bar">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <Dice5 className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Проверка навыка
          </DialogTitle>
          <DialogDescription>
            Бросок навыка для проверки
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto fate-scroll flex-1 min-h-0">
          {/* Character & Skill Info */}
          <div
            className="rounded-xl p-4 space-y-2"
            style={{
              background: 'linear-gradient(135deg, rgba(230, 126, 34, 0.08), rgba(230, 126, 34, 0.03))',
              border: '1px solid rgba(230, 126, 34, 0.15)',
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Персонаж
              </span>
              <span className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                {character?.name ?? '—'}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Навык
              </span>
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                  {skillName ?? '—'}
                </span>
                <Badge
                  className="text-xs font-bold px-2 py-0.5 rounded-md shadow-sm"
                  style={{
                    backgroundColor: skillValue >= 4 ? 'var(--fate-accent)' : skillValue >= 2 ? 'var(--fate-success)' : 'var(--fate-bg-warm)',
                    color: skillValue >= 2 ? 'white' : 'var(--fate-text)',
                  }}
                >
                  +{skillValue}
                </Badge>
              </div>
            </div>
          </div>

          {/* Crowd team effort checkbox — only meaningful with ≥2 active members */}
          {character?.isHorde && character.members && crowdActiveCount >= 2 && (
            <div
              className="flex items-center gap-3 p-2.5 rounded-lg"
              style={{
                backgroundColor: crowdTeamEffort ? 'rgba(192, 57, 43, 0.08)' : 'var(--fate-bg-card)',
                border: `1px solid ${crowdTeamEffort ? 'rgba(192, 57, 43, 0.25)' : 'var(--fate-border)'}`,
              }}
            >
              <Checkbox
                checked={crowdTeamEffort}
                onCheckedChange={(checked) => setCrowdTeamEffort(!!checked)}
                className="size-4 rounded"
                style={{ borderColor: '#c0392b' }}
              />
              <div className="min-w-0 flex-1">
                <Label className="text-xs font-medium cursor-pointer" style={{ color: 'var(--fate-text)' }}>
                  Совместные усилия толпы
                </Label>
                <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                  {crowdTeamEffort
                    ? `Бросает ${crowdEffort.rollerName} (навык +${skillValue}) + помощь +${crowdHelperBonus} = +${skillValue + crowdHelperBonus}`
                    : `${crowdActiveCount} участников в строю (навык ≥1: +${crowdHelperBonus})`
                  }
                </p>
                {crowdTeamEffort && crowdHelpers.length > 0 && (
                  <div className="text-[10px] mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                    {groupCrowdHelpers(crowdHelpers).map((g, idx) => (
                      <span
                        key={idx}
                        style={{
                          color: g.totalBonus > 0 ? '#27ae60' : 'var(--fate-text-muted)',
                          fontWeight: g.totalBonus > 0 ? 600 : 400,
                        }}
                      >
                        {g.typeLabel} ×{g.count}: {g.totalBonus > 0 ? `+${g.totalBonus}` : '0'}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Bonus Modifier */}
          <div className="space-y-2">
            <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
              Ситуативный бонус
            </Label>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="size-9 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                onClick={() => setBonus((b) => b - 1)}
              >
                −
              </Button>
              <Input
                type="number"
                value={bonus}
                onChange={(e) => setBonus(parseInt(e.target.value) || 0)}
                className="text-center w-20 font-semibold text-lg rounded-lg"
              />
              <Button
                variant="outline"
                size="sm"
                className="size-9 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                onClick={() => setBonus((b) => b + 1)}
              >
                +
              </Button>
              <span className="text-xs ml-2" style={{ color: 'var(--fate-text-muted)' }}>
                Итого: +{skillValue + bonus + (crowdTeamEffort ? crowdHelperBonus : 0)}
              </span>
            </div>
          </div>

          <Separator />

          {/* Roll Mode */}
          <div className="space-y-2">
            <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
              Тип броска
            </Label>
            <Select value={rollMode} onValueChange={(v) => setRollMode(v as RollMode)}>
              <SelectTrigger className="w-full rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Обычный бросок</SelectItem>
                <SelectItem value="difficulty">Против сложности</SelectItem>
                <SelectItem value="opposed">Против соперника</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Difficulty */}
          {rollMode === 'difficulty' && (
            <div className="space-y-2 animate-slide-down">
              <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                Сложность
              </Label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="size-9 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                  onClick={() => setDifficulty((d) => Math.max(0, d - 1))}
                >
                  −
                </Button>
                <Input
                  type="number"
                  value={difficulty}
                  onChange={(e) => setDifficulty(parseInt(e.target.value) || 0)}
                  className="text-center w-20 font-semibold text-lg rounded-lg"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="size-9 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                  onClick={() => setDifficulty((d) => d + 1)}
                >
                  +
                </Button>
              </div>
            </div>
          )}

          {/* Opponent */}
          {rollMode === 'opposed' && (
            <div className="space-y-2 animate-slide-down">
              <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                Соперник
              </Label>
              <Select value={opponentId} onValueChange={(v) => { setOpponentId(v); setOpponentSkillName(''); }}>
                <SelectTrigger className="w-full rounded-lg">
                  <SelectValue placeholder="Выберите соперника" />
                </SelectTrigger>
                <SelectContent>
                  {sceneCharacters.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      Нет персонажей на сцене
                    </SelectItem>
                  ) : (
                    sceneCharacters
                      .filter((c) => c.id !== characterId)
                      .map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))
                  )}
                </SelectContent>
              </Select>

              {/* Opponent Skill Selection */}
              {opponentCharacter && (
                <div className="space-y-1.5 pt-1">
                  <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                    Навык соперника
                  </Label>
                  <Select value={opponentSkillName} onValueChange={setOpponentSkillName}>
                    <SelectTrigger className="w-full rounded-lg">
                      <SelectValue placeholder="Выберите навык" />
                    </SelectTrigger>
                    <SelectContent>
                      {opponentCharacter.skills
                        .filter((s) => s.value > 0)
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
            </div>
          )}

          <Separator />

          {/* Result Display */}
          {isRolling ? (
            <div
              className="rounded-xl p-6 text-center space-y-3 overflow-hidden"
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
          ) : lastResult && showResult ? (
            <div className="space-y-3">
              {/* Main Result */}
              <div
                className="rounded-xl p-6 text-center space-y-3 fate-dice-reveal"
                style={{ backgroundColor: getResultBg(), border: `1px solid ${getResultColor()}20` }}
              >
                {/* Dice chips — large color-coded chips, same visual language
                    as the log entries so the result reads instantly. */}
                <div className="flex justify-center">
                  <DiceChips dice={lastResult.dice} size="lg" />
                </div>

                {/* Total */}
                <div
                  className="text-5xl font-black tracking-tight"
                  style={{ color: getResultColor() }}
                >
                  {lastResult.total >= 0 ? `+${lastResult.total}` : lastResult.total}
                </div>

                {/* Result Badge */}
                <Badge
                  className="text-sm px-4 py-1.5 font-semibold rounded-lg shadow-sm"
                  style={{ backgroundColor: getResultColor(), color: 'white', border: 'none' }}
                >
                  {lastResult.label}
                </Badge>

                {/* Bonus breakdown */}
                <div className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                  Кубики: {lastResult.dice.reduce<number>((a, b) => a + b, 0) >= 0 ? '+' : ''}
                  {lastResult.dice.reduce<number>((a, b) => a + b, 0)}
                  {' + '}Навык: +{skillValue}
                  {crowdTeamEffort && crowdHelperBonus > 0 && (
                    <span style={{ color: '#c0392b', fontWeight: 700 }}>
                      {' + '}Помощь толпы: +{crowdHelperBonus}
                    </span>
                  )}
                  {bonus !== 0 && (
                    <> {' + '}Бонус: {bonus >= 0 ? '+' : ''}{bonus}</>
                  )}
                </div>

                {/* Crowd helpers breakdown — grouped by creature type so a
                    large mob stays readable (one row per type, not per member). */}
                {crowdTeamEffort && crowdHelpers.length > 0 && (
                  <div
                    className="text-[10px] rounded-md p-2 w-full max-w-md mx-auto text-left"
                    style={{
                      backgroundColor: 'rgba(192, 57, 43, 0.06)',
                      border: '1px solid rgba(192, 57, 43, 0.15)',
                      color: 'var(--fate-text-muted)',
                    }}
                  >
                    <div className="font-semibold mb-1 flex items-center justify-between" style={{ color: '#c0392b' }}>
                      <span>🤝 Помощь толпы</span>
                      <span>+{crowdHelperBonus}</span>
                    </div>
                    <div className="flex flex-col gap-0.5">
                      {groupCrowdHelpers(crowdHelpers).map((g, idx) => (
                        <div key={idx} className="flex justify-between gap-2 items-baseline">
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

              {/* Opponent Result */}
              {rollMode === 'opposed' && opponentResult && opponentCharacter && (
                <div
                  className="rounded-xl p-4 text-center space-y-2"
                  style={{ backgroundColor: 'rgba(0,0,0,0.03)', border: '1px solid var(--fate-border)' }}
                >
                  <div className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                    {opponentCharacter.name}
                    {opponentSkillName && ` — ${opponentSkillName}`}
                  </div>
                  <div className="flex justify-center">
                    <DiceChips dice={opponentResult.dice} size="md" />
                  </div>
                  <div className="text-xl font-bold" style={{ color: 'var(--fate-text)' }}>
                    {opponentResult.total >= 0 ? `+${opponentResult.total}` : opponentResult.total}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div
              className="rounded-xl p-6 text-center space-y-2"
              style={{ backgroundColor: 'var(--fate-bg-warm)' }}
            >
              <div className="text-2xl opacity-30">🎲</div>
              <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                Нажмите «Бросить» для проверки {skillName}
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
          {lastResult && showResult && (
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
            disabled={isRolling || (rollMode === 'opposed' && !opponentId)}
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
