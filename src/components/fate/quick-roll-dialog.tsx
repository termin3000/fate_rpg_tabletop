'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Dice5, Sparkles } from 'lucide-react';

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
import { performRoll } from '@/lib/fate-dice';
import type { RollResult } from '@/lib/types';
import { DiceChips } from '@/components/fate/dice-chips';
import { useNetwork } from '@/hooks/use-network';
import type { LiveRollEvent } from '@/lib/types';
// NOTE: QuickRoll — мгновенный 2D бросок (performRoll). Намеренно НЕ
// использует 3D-физику: "Quick" = быстрый, без зависимости от
// physics-сервиса и его сокета (который рвётся при HMR). 3D-физика
// остаётся для основного RollToolPanel, где драматичный бросок уместен.

type RollMode = 'normal' | 'difficulty' | 'opposed';

interface QuickRollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preselectedCharId?: string | null;
}

// ── Confetti burst overlay for great successes ──────────────
function ConfettiBurst({ trigger }: { trigger: number }) {
  // trigger is a counter — when it changes (and > 0), spawn new pieces
  const pieces = useMemo(() => {
    if (trigger === 0) return [];
    const colors = ['#e67e22', '#27ae60', '#f39c12', '#3498db', '#9b59b6', '#1abc9c', '#e74c3c'];
    return Array.from({ length: 60 }, (_, i) => ({
      id: `${trigger}-${i}`,
      left: Math.random() * 100,
      color: colors[Math.floor(Math.random() * colors.length)],
      delay: Math.random() * 0.4,
      duration: 1.5 + Math.random() * 1.5,
      size: 6 + Math.random() * 8,
      shape: Math.random() > 0.5 ? '50%' : '2px',
    }));
  }, [trigger]);

  if (pieces.length === 0) return null;

  return (
    <div className="fate-confetti-container" key={trigger}>
      {pieces.map((p) => (
        <div
          key={p.id}
          className="fate-confetti-piece"
          style={{
            left: `${p.left}%`,
            backgroundColor: p.color,
            width: p.size,
            height: p.size,
            borderRadius: p.shape,
            animationDuration: `${p.duration}s`,
            animationDelay: `${p.delay}s`,
          }}
        />
      ))}
    </div>
  );
}

export function QuickRollDialog({ open, onOpenChange, preselectedCharId }: QuickRollDialogProps) {
  const { getSceneCharacters, addLogEntry, currentAdventureId, getCharacter, characters, networkMyDisplayName } = useFateStore();
  const { sendRollStage } = useNetwork();
  const sceneCharacters = getSceneCharacters();

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
  const [confettiTrigger, setConfettiTrigger] = useState(0);
  const [crowdTeamEffort, setCrowdTeamEffort] = useState(false);

  const preselectedChar = preselectedCharId ? getCharacter(preselectedCharId) : null;

  // Pre-compute crowd active count & helper bonus (Fate Core "mobs" rule):
  // each additional active member adds +1 (we can't check individual skills
  // because the user hasn't selected one in this quick-roll dialog).
  const crowdActiveCount = useMemo(() => {
    if (!preselectedChar?.isHorde || !preselectedChar.members) return 0;
    return preselectedChar.members.filter((m) => m.isActive).length;
  }, [preselectedChar]);

  const crowdHelperBonus = useMemo(() => Math.max(0, crowdActiveCount - 1), [crowdActiveCount]);

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

  const opponentCharacter = opponentId ? getCharacter(opponentId) : null;

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setLastResult(null);
      setShowResult(false);
      setConfettiTrigger(0);
      setOpponentSkillName('');
      setOpponentResult(null);
      setCrowdTeamEffort(false);
    }
  }, [open]);

  const handleRoll = useCallback(async () => {
    setIsRolling(true);
    setShowResult(false);

    try {
      // ── Crowd team effort bonus ──────────────────────────
      let crowdEffortText: string | null = null;
      let crowdHelperBonusValue = 0;
      if (crowdTeamEffort && preselectedChar?.isHorde && preselectedChar.members && crowdActiveCount >= 2) {
        crowdHelperBonusValue = crowdHelperBonus;
        crowdEffortText = `🤝 Совместные усилия толпы! ${crowdActiveCount} участников (помощь +${crowdHelperBonusValue})`;
      }

      const effectiveBonus = bonus + crowdHelperBonusValue;

      const diff = rollMode === 'difficulty' ? difficulty : null;
      let opponentTotal: number | null = null;

      let oppResult: RollResult | null = null;
      if (rollMode === 'opposed' && opponentId) {
        const opponentChar = getCharacter(opponentId);
        if (opponentChar) {
          const opponentSkillVal = opponentChar.skills.find((s) => s.name === opponentSkillName)?.value ?? 0;
          // Оппонент всегда 2D (его бросок менее важен визуально).
          oppResult = performRoll(opponentSkillVal);
          opponentTotal = oppResult.total;
        }
      }

      const char = preselectedCharId ? getCharacter(preselectedCharId) : null;

      // ── Основной бросок: МГНОВЕННЫЙ 2D Math.random ──
      // QuickRoll = быстрый бросок: без 3D-анимации, без зависимости от
      // physics-сервиса (и его сокета, который рвётся при HMR). Результат
      // считается сразу через performRoll.
      const result = performRoll(effectiveBonus, diff, opponentTotal);
      const mainDice = result.dice;
      const mainTotal = result.total;
      const mainLabel = result.label;
      const mainType = result.type;

      // Краткая (~280мс) прокрутка spinner'а кубиков для тактильной отдачи.
      // Результат уже известен — просто даём UI «прокрутиться».
      await new Promise((r) => setTimeout(r, 280));

      // ── Обновляем UI диалога ──
      const resultObj: RollResult = {
        dice: mainDice,
        total: mainTotal,
        label: mainLabel,
        type: mainType,
      };
      setLastResult(resultObj);
      setOpponentResult(oppResult);
      setRollingDice(mainDice);
      setShowResult(true);

      // Trigger confetti for great successes
      if (mainType === 'great') {
        setConfettiTrigger((t) => t + 1);
      }

      // ── Лог ──
      await addLogEntry({
          adventureId: currentAdventureId ?? undefined,
          characterId: preselectedCharId ?? null,
          characterName: char?.name ?? 'Быстрый бросок',
          skillName: `Бонус +${effectiveBonus}`,
          diceResults: mainDice,
          bonus: effectiveBonus,
          total: mainTotal,
          difficulty: diff,
          opponentTotal,
          result: mainLabel,
          opponentType: rollMode === 'opposed' && opponentId ? 'character' : null,
          opponentCharacterId: rollMode === 'opposed' && opponentId ? opponentId : null,
          opponentName: rollMode === 'opposed' && opponentId ? opponentCharacter?.name ?? null : null,
          opponentSkillName: rollMode === 'opposed' ? opponentSkillName || null : null,
          opponentDiceResults: oppResult?.dice ?? [],
          opponentBonus: oppResult ? (oppResult.total - oppResult.dice.reduce<number>((a, b) => a + b, 0)) : 0,
          opponentSkillValue: rollMode === 'opposed' && opponentId
            ? (getCharacter(opponentId)?.skills.find((s) => s.name === opponentSkillName)?.value ?? 0)
            : null,
          opponentManualBonus: 0,
          extraBonus: 0,
          extraBonusReason: '',
          rerolled: false,
          customText: crowdEffortText,
          isRiftEvent: false,
          skillValue: null,
          manualBonus: effectiveBonus,
          helpers: [],
          aspectInvokeBonus: 0,
          aspectInvokeReason: '',
          aspectRerolled: false,
        });

      // ── Network: broadcast roll-stage to peers ──
      // The log entry is already broadcast automatically by the store's
      // addLogEntry (via _broadcastLogEntryFn). Here we ALSO send a
      // roll-stage event so peers see the theatrical overlay with dice +
      // verdict card. sendRollStage (not broadcastRollStage) because the
      // quick-roll dialog shows its OWN inline 2D result — we don't want
      // the local overlay, just the peer overlay.
      try {
        const diceSum = mainDice.reduce((a, b) => a + b, 0);
        // Stamp the local roller's dice palette + peerId so remote viewers
        // (GM + other players) render this quick-roll's dice in THIS player's
        // colors, not their own. (Per-player dice customization.)
        const _qrState = useFateStore.getState();
        const stageEvent: LiveRollEvent = {
          id: `quick-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: 'simple',
          rolledBy: networkMyDisplayName || char?.name || 'Игрок',
          rolledAt: Date.now(),
          title: char?.name ? `${char.name}` : undefined,
          actionContext: 'check',
          difficulty: diff,
          verdict: mainLabel,
          verdictType: mainType === 'great' || mainType === 'success' ? 'win'
            : mainType === 'fail' ? 'lose' : 'tie',
          participants: [{
            id: `p-${Date.now()}`,
            characterName: char?.name ?? 'Быстрый бросок',
            characterId: preselectedCharId ?? undefined,
            peerId: _qrState.networkMyPeerId ?? null,
            diceColor: _qrState.diceColor,
            symbolColor: _qrState.symbolColor,
            skillName: `Бонус +${effectiveBonus}`,
            skillValue: 0,
            manualBonus: effectiveBonus,
            dice: mainDice,
            diceSum,
            total: mainTotal,
            resultLabel: mainLabel,
            resultType: mainType,
            role: 'roller',
            modifiers: [
              { label: 'кубики', value: diceSum },
              ...(effectiveBonus ? [{ label: 'бонус', value: effectiveBonus }] : []),
            ],
            margin: diff !== null ? mainTotal - diff : null,
          }],
          adventureId: currentAdventureId || undefined,
        };
        sendRollStage(stageEvent);
      } catch (stageErr) {
        console.warn('[quick-roll] failed to send roll stage:', stageErr);
      }
    } finally {
      setIsRolling(false);
    }
  }, [bonus, rollMode, difficulty, opponentId, opponentSkillName, preselectedCharId, currentAdventureId, opponentCharacter, getCharacter, addLogEntry, crowdTeamEffort, preselectedChar, crowdActiveCount, crowdHelperBonus, networkMyDisplayName, sendRollStage]);

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
    <>
      <ConfettiBurst trigger={confettiTrigger} />
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
              Быстрый бросок
            </DialogTitle>
            <DialogDescription>
              Бросьте кубики Fate для проверки навыка
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto fate-scroll flex-1 min-h-0">
            {/* Bonus */}
            <div className="space-y-2">
              <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                Бонус навыка
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
                {crowdTeamEffort && crowdHelperBonus > 0 && (
                  <span className="text-xs ml-2 font-medium" style={{ color: '#c0392b' }}>
                    +{crowdHelperBonus} толпа → итого +{bonus + crowdHelperBonus}
                  </span>
                )}
              </div>

              {/* Crowd team effort checkbox — only meaningful with ≥2 active members */}
              {preselectedChar?.isHorde && preselectedChar.members && crowdActiveCount >= 2 && (
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
                  <div>
                    <Label className="text-xs font-medium cursor-pointer" style={{ color: 'var(--fate-text)' }}>
                      Совместные усилия толпы
                    </Label>
                    <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                      {crowdTeamEffort
                        ? `Бонус: +${crowdHelperBonus} (от ${crowdActiveCount} участников)`
                        : `${crowdActiveCount} участников в строю (помощь: +${crowdHelperBonus})`
                      }
                    </p>
                  </div>
                </div>
              )}
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
                {/* Quick presets */}
                <div className="flex gap-1 flex-wrap">
                  {[
                    { label: 'Легко', value: 1 },
                    { label: 'Средне', value: 2 },
                    { label: 'Сложно', value: 3 },
                    { label: 'Очень сложно', value: 4 },
                    { label: 'Невозможно', value: 5 },
                  ].map((p) => (
                    <button
                      key={p.value}
                      onClick={() => setDifficulty(p.value)}
                      className="px-2 py-0.5 text-[10px] rounded font-medium transition-all duration-150 hover:scale-105"
                      style={
                        difficulty === p.value
                          ? { backgroundColor: 'var(--fate-accent)', color: 'white' }
                          : { backgroundColor: 'rgba(230, 126, 34, 0.1)', color: 'var(--fate-accent)' }
                      }
                    >
                      {p.label} (+{p.value})
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Opponent */}
            {rollMode === 'opposed' && (
              <div className="space-y-2 animate-slide-down">
                <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                  Соперник
                </Label>
                <Select value={opponentId} onValueChange={(v) => { setOpponentId(v); setOpponentSkillName(''); setOpponentResult(null); }}>
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
                        .filter((c) => c.id !== preselectedCharId)
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
              <div
                key={`${lastResult.total}-${lastResult.type}-${showResult}`}
                className={`rounded-xl p-6 text-center space-y-3 fate-dice-reveal ${
                  lastResult.type === 'great' ? 'fate-result-great-glow' : ''
                } ${lastResult.type === 'fail' ? 'fate-fail-shake' : ''}`}
                style={{ backgroundColor: getResultBg(), border: `1px solid ${getResultColor()}20` }}
              >
                {/* Dice chips — large color-coded chips, same visual language
                    as the log entries so the result reads instantly. */}
                <div className="flex justify-center">
                  <DiceChips dice={lastResult.dice} size="lg" />
                </div>

                {/* Total */}
                <div className="flex flex-col items-center gap-2">
                  <div
                    className={`text-5xl font-black tracking-tight fate-animate-pop inline-flex items-center gap-2 ${
                      lastResult.type === 'great' ? 'fate-great-result' : ''
                    }`}
                    style={{ color: getResultColor() }}
                  >
                    {lastResult.type === 'great' && <Sparkles className="size-7 fate-sparkle relative" />}
                    {lastResult.total >= 0 ? `+${lastResult.total}` : lastResult.total}
                  </div>

                  {/* Result Badge */}
                  <Badge
                    className="text-sm px-4 py-1.5 font-semibold rounded-lg shadow-sm"
                    style={{ backgroundColor: getResultColor(), color: 'white', border: 'none' }}
                  >
                    {lastResult.label}
                  </Badge>
                </div>

                {/* Bonus breakdown */}
                {bonus !== 0 && (
                  <div className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                    Базовый: {lastResult.dice.reduce<number>((a, b) => a + b, 0) >= 0 ? '+' : ''}
                    {lastResult.dice.reduce<number>((a, b) => a + b, 0)} + Модификатор: {bonus >= 0 ? '+' : ''}{bonus}
                  </div>
                )}
              </div>
            ) : null}

            {/* Opponent Result (shown when opposed roll) */}
            {!isRolling && rollMode === 'opposed' && opponentResult && opponentCharacter && lastResult && showResult && (
              <div
                className="rounded-xl p-4 text-center space-y-2 fate-dice-reveal"
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

            {/* Default empty state when no roll has been made */}
            {!isRolling && !(lastResult && showResult) && (
              <div
                className="rounded-xl p-6 text-center space-y-2"
                style={{ backgroundColor: 'var(--fate-bg-warm)' }}
              >
                <div className="text-2xl opacity-30">🎲</div>
                <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                  Нажмите «Бросить» для проверки
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
    </>
  );
}

