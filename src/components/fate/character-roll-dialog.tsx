'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Dice5, ShieldAlert, Sparkles, Users } from 'lucide-react';

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
import { calculateCrowdHelpers, formatDiceSymbol, groupCrowdHelpers, performRoll } from '@/lib/fate-dice';
import type { RollResult, Skill, Character, RollHelper } from '@/lib/types';
import { formatCoopRollText, formatExtraBonusReason } from '@/lib/roll-format';
import { DiceChips } from '@/components/fate/dice-chips';

type RollMode = 'normal' | 'difficulty' | 'opposed' | 'team';

interface CharacterRollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  characterId: string | null;
}

// ── Confetti burst overlay for great successes ──────────────
function ConfettiBurst({ trigger }: { trigger: number }) {
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

// ── Skill Pyramid component ────────────────────────────────
function SkillPyramid({
  skills,
  selectedSkill,
  onSelectSkill,
}: {
  skills: Skill[];
  selectedSkill: string | null;
  onSelectSkill: (name: string, value: number) => void;
}) {
  // Group skills by value (level), descending
  const levels = useMemo(() => {
    const map = new Map<number, Skill[]>();
    for (const s of skills) {
      const existing = map.get(s.value) ?? [];
      existing.push(s);
      map.set(s.value, existing);
    }
    // Sort levels descending
    const sorted = Array.from(map.entries())
      .sort(([a], [b]) => b - a);
    return sorted;
  }, [skills]);

  const maxLevel = levels.length > 0 ? levels[0][0] : 0;

  return (
    <div
      className="rounded-xl p-3 space-y-2"
      style={{
        backgroundColor: 'var(--fate-bg-warm)',
        border: '1px solid var(--fate-border)',
      }}
    >
      <div className="text-xs font-semibold text-center uppercase tracking-wider" style={{ color: 'var(--fate-text-muted)' }}>
        Пирамида навыков
      </div>
      {levels.map(([level, levelSkills]) => (
        <div key={level} className="space-y-1">
          <div className="text-[10px] font-medium pl-1" style={{ color: 'var(--fate-text-muted)' }}>
            Уровень {level}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {levelSkills.map((skill) => {
              const isSelected = selectedSkill === skill.name;
              return (
                <button
                  key={skill.name}
                  onClick={() => onSelectSkill(skill.name, skill.value)}
                  className={`
                    flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm font-medium
                    transition-all duration-150 hover:scale-105 active:scale-95
                    ${isSelected
                      ? 'shadow-md ring-2 ring-offset-1'
                      : 'hover:shadow-sm'
                    }
                  `}
                  style={{
                    backgroundColor: isSelected
                      ? 'var(--fate-accent)'
                      : 'var(--fate-bg-card)',
                    color: isSelected ? 'white' : 'var(--fate-text)',
                    outline: isSelected ? '2px solid var(--fate-accent)' : '2px solid transparent',
                    border: `1px solid ${isSelected ? 'var(--fate-accent)' : 'var(--fate-border)'}`,
                  }}
                >
                  <span>{skill.name}</span>
                  <span
                    className="inline-flex items-center justify-center size-5 rounded-full text-[10px] font-bold shrink-0"
                    style={{
                      backgroundColor: isSelected ? 'rgba(255,255,255,0.25)' : getLevelColor(skill.value),
                      color: isSelected ? 'white' : 'white',
                    }}
                  >
                    +{skill.value}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function getLevelColor(value: number): string {
  if (value >= 4) return 'var(--fate-accent)';
  if (value >= 3) return '#e67e22';
  if (value >= 2) return 'var(--fate-success)';
  if (value >= 1) return '#3498db';
  return 'var(--fate-text-muted)';
}

// ── Team Effort helpers ─────────────────────────────────────
// NOTE: computeTeamEffort is defined LOCALLY here (not imported).
// It must NOT be imported from @/lib/fate-dice (which doesn't export it).
function computeTeamEffort(
  characters: Character[],
  skillName: string,
): { roller: Character; rollerSkill: number; helpers: { char: Character; skill: number; bonus: number }[]; totalBonus: number } {
  // Find the character with the highest skill value
  let roller: Character | null = null;
  let rollerSkill = -Infinity;
  const tiedChars: Character[] = [];

  for (const char of characters) {
    const skill = char.skills.find((s) => s.name === skillName);
    const value = skill?.value ?? 0;
    if (value > rollerSkill) {
      rollerSkill = value;
      roller = char;
      tiedChars.length = 0;
      tiedChars.push(char);
    } else if (value === rollerSkill) {
      tiedChars.push(char);
    }
  }

  // If tie, pick random
  if (tiedChars.length > 1) {
    roller = tiedChars[Math.floor(Math.random() * tiedChars.length)];
  }

  if (!roller) {
    return { roller: characters[0], rollerSkill: 0, helpers: [], totalBonus: 0 };
  }

  // Helpers: every OTHER selected character is listed as a helper — even if
  // their skill is 0 (they contribute +0 but are still shown so players see
  // who participated). A helper with skill >= +1 adds +1 to the total.
  const helpers: { char: Character; skill: number; bonus: number }[] = [];
  let helperBonus = 0;
  for (const char of characters) {
    if (char.id === roller.id) continue;
    const skill = char.skills.find((s) => s.name === skillName);
    const value = skill?.value ?? 0;
    const bonus = value >= 1 ? 1 : 0;
    helpers.push({ char, skill: value, bonus });
    helperBonus += bonus;
  }

  return {
    roller,
    rollerSkill,
    helpers,
    totalBonus: rollerSkill + helperBonus,
  };
}

// ── Main Dialog ─────────────────────────────────────────────
export function CharacterRollDialog({ open, onOpenChange, characterId }: CharacterRollDialogProps) {
  const { getCharacter, getSceneCharacters, addLogEntry, currentAdventureId, characters, canRollForCharacter } = useFateStore();
  const sceneCharacters = getSceneCharacters();
  const character = characterId ? getCharacter(characterId) : null;

  // ── Defense in depth ────────────────────────────────────────
  // The scene panel already hides the dice button for characters the user
  // can't roll for, but the dialog can still be opened from other entry
  // points (skill click, keyboard shortcut, command palette, etc.). We
  // re-check the guard here and show a blocking message instead of the
  // roll UI when the user lacks permission.
  const canRoll = characterId ? canRollForCharacter(characterId) : true;

  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const [selectedSkillValue, setSelectedSkillValue] = useState(0);
  const [bonus, setBonus] = useState(0);
  const [rollMode, setRollMode] = useState<RollMode>('normal');
  const [difficulty, setDifficulty] = useState(2);
  const [opponentId, setOpponentId] = useState<string>('');
  const [opponentSkillName, setOpponentSkillName] = useState<string>('');
  const [teamCharIds, setTeamCharIds] = useState<string[]>(characterId ? [characterId] : []);
  const [teamSkillName, setTeamSkillName] = useState<string>('');
  const [lastResult, setLastResult] = useState<RollResult | null>(null);
  const [opponentResult, setOpponentResult] = useState<RollResult | null>(null);
  const [teamResult, setTeamResult] = useState<{
    roller: string;
    rollerSkill: number;
    helpers: { name: string; skill: number; bonus: number }[];
    helperBonus: number;
  } | null>(null);
  const [isRolling, setIsRolling] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [rollingDice, setRollingDice] = useState<number[]>([0, 0, 0, 0]);
  const [confettiTrigger, setConfettiTrigger] = useState(0);
  const [crowdTeamEffort, setCrowdTeamEffort] = useState(false);

  const opponentCharacter = opponentId ? getCharacter(opponentId) : null;

  // Pre-compute the crowd team-effort helper bonus so the UI can display it
  // before rolling. Implements Fate Core "mobs" rule: each additional active
  // member whose base character has the relevant skill at +1 or higher adds +1.
  const crowdEffort = useMemo(() => {
    return calculateCrowdHelpers(character, selectedSkillName ?? '', selectedSkillValue, characters);
  }, [character, selectedSkillName, selectedSkillValue, characters]);

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

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setLastResult(null);
      setShowResult(false);
      setConfettiTrigger(0);
      setSelectedSkillName(null);
      setSelectedSkillValue(0);
      setBonus(0);
      setRollMode('normal');
      setDifficulty(2);
      setOpponentId('');
      setOpponentSkillName('');
      setOpponentResult(null);
      setTeamCharIds(characterId ? [characterId] : []);
      setTeamSkillName('');
      setTeamResult(null);
      setCrowdTeamEffort(false);
    }
  }, [open, characterId]);

  const handleSelectSkill = useCallback((name: string, value: number) => {
    setSelectedSkillName(name);
    setSelectedSkillValue(value);
    setBonus(0);
    setRollMode('normal');
    setShowResult(false);
    setLastResult(null);
  }, []);

  const handleRoll = useCallback(async () => {
    // Defense in depth: the roll UI is hidden when the user lacks roll
    // permission, but guard the handler anyway in case a stale render
    // triggers it.
    if (!canRoll) return;
    if (!selectedSkillName && rollMode !== 'team') return;

    setIsRolling(true);
    setShowResult(false);

    await new Promise((resolve) => setTimeout(resolve, 600));

    try {
      if (rollMode === 'team') {
        // Team effort roll
        const teamChars = teamCharIds
          .map((id) => getCharacter(id))
          .filter(Boolean) as Character[];

        if (teamChars.length === 0 || !teamSkillName) return;

        const effort = computeTeamEffort(teamChars, teamSkillName);
        const result = performRoll(effort.totalBonus + bonus);

        setLastResult(result);
        setRollingDice(result.dice);
        setShowResult(true);
        setTeamResult({
          roller: effort.roller.name,
          rollerSkill: effort.rollerSkill,
          helpers: effort.helpers.map((h) => ({ name: h.char.name, skill: h.skill, bonus: h.bonus })),
          helperBonus: effort.helpers.reduce((s, h) => s + h.bonus, 0),
        });

        if (result.type === 'great') setConfettiTrigger((t) => t + 1);

        const diff = difficulty || null;

        await addLogEntry({
          adventureId: currentAdventureId ?? undefined,
          characterId: effort.roller.id,
          characterName: effort.roller.name,
          // Per user request: the skill name should be just the skill (e.g.
          // "Обман"), not "Совместные усилия: Обман". The joint-effort nature
          // is conveyed via customText + the helpers list in the tooltip.
          skillName: teamSkillName,
          diceResults: result.dice,
          bonus: effort.totalBonus,
          total: result.total,
          difficulty: diff,
          opponentTotal: null,
          result: result.label,
          opponentType: null,
          opponentName: null,
          opponentSkillName: null,
          opponentDiceResults: [],
          opponentBonus: 0,
          extraBonus: bonus,
          extraBonusReason: formatExtraBonusReason(bonus),
          rerolled: false,
          customText: formatCoopRollText(
            effort.roller.name,
            effort.rollerSkill,
            effort.helpers.map((h) => ({ name: h.char.name, skillValue: h.skill, bonus: h.bonus }))
          ),
          isRiftEvent: false,
          // ── Rich-tooltip fields ──
          skillValue: effort.rollerSkill,
          manualBonus: bonus,
          helpers: effort.helpers.map((h) => ({
            name: h.char.name,
            skillName: teamSkillName,
            skillValue: h.skill,
            bonus: h.bonus,
          })),
          aspectInvokeBonus: 0,
          aspectInvokeReason: '',
          aspectRerolled: false,
        });
      } else {
        // Normal / difficulty / opposed roll
        let totalBonus = selectedSkillValue + bonus;

        // ── Crowd team effort bonus ──────────────────────────
        // Fate Core "mobs" rule: when NPCs attack together, each additional
        // member who has the relevant skill at +1 or higher adds +1 to the roll.
        let crowdEffortText: string | null = null;
        let crowdHelpersList: RollHelper[] = [];
        const char = characterId ? getCharacter(characterId) : null;
        if (crowdTeamEffort && char?.isHorde && char.members && selectedSkillName) {
          const effort = calculateCrowdHelpers(char, selectedSkillName, selectedSkillValue, characters);
          crowdHelpersList = effort.helpers;
          totalBonus = selectedSkillValue + effort.totalHelperBonus + bonus;
          // Единый формат customText для crowd-effort (совпадает с team mode
          // и блоком бросков). helpers показываются с разбивкой (+skill→+bonus).
          crowdEffortText = formatCoopRollText(
            effort.rollerName,
            selectedSkillValue,
            effort.helpers.map((h) => ({ name: h.name, skillValue: h.skillValue ?? 0, bonus: h.bonus }))
          );
        }

        const diff = rollMode === 'difficulty' ? difficulty : null;
        let oppResult: RollResult | null = null;
        let opponentTotal: number | null = null;

        if (rollMode === 'opposed' && opponentId) {
          const oppChar = getCharacter(opponentId);
          if (oppChar) {
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
        setTeamResult(null);

        if (result.type === 'great') setConfettiTrigger((t) => t + 1);

        await addLogEntry({
          adventureId: currentAdventureId ?? undefined,
          characterId: characterId ?? null,
          characterName: char?.name ?? 'Неизвестный',
          skillName: selectedSkillName ?? 'Навык',
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
          opponentBonus: oppResult ? (oppResult.total - oppResult.dice.reduce<number>((a, b) => a + b, 0)) : 0,
          // ── Opponent rich-tooltip fields ──
          // Store the opponent's raw skill value so the tooltip can show
          // "Contacts +3" instead of dumping the skill value into the bonus field.
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
          skillValue: selectedSkillValue,
          manualBonus: bonus,
          helpers: crowdHelpersList,
          aspectInvokeBonus: 0,
          aspectInvokeReason: '',
          aspectRerolled: false,
        });
      }
    } finally {
      setIsRolling(false);
    }
  }, [selectedSkillName, selectedSkillValue, bonus, rollMode, difficulty, opponentId, opponentSkillName, characterId, currentAdventureId, opponentCharacter, getCharacter, addLogEntry, teamCharIds, teamSkillName, crowdTeamEffort, characters, canRoll]);

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

  // Get all available skills for team roll
  const teamAvailableSkills = useMemo(() => {
    const skillMap = new Map<string, number>();
    for (const id of teamCharIds) {
      const char = getCharacter(id);
      if (!char) continue;
      for (const s of char.skills) {
        if (s.value >= 0 && (!skillMap.has(s.name) || skillMap.get(s.name)! < s.value)) {
          skillMap.set(s.name, s.value);
        }
      }
    }
    return Array.from(skillMap.entries())
      .sort(([, a], [, b]) => b - a)
      .map(([name, value]) => ({ name, value }));
  }, [teamCharIds, getCharacter]);

  // Whether the form is filled out enough to actually roll. The access
  // control check (`canRoll` from the store) is separate — when the user
  // lacks roll permission we don't render the form at all.
  const canSubmitRoll = rollMode === 'team'
    ? teamCharIds.length >= 2 && !!teamSkillName
    : !!selectedSkillName;

  return (
    <>
      <ConfettiBurst trigger={confettiTrigger} />
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl max-h-[92vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 fate-dialog-title fate-dialog-title-bar">
              <div
                className="fate-icon-circle"
                style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
              >
                <Dice5 className="size-4" style={{ color: 'var(--fate-accent)' }} />
              </div>
              {character?.name ?? 'Бросок'}
            </DialogTitle>
            <DialogDescription>
              Выберите навык из пирамиды и бросьте кубики
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 flex-1 min-h-0 overflow-y-auto fate-scroll pr-1">
            {/* Blocking message — shown when the user can't roll for this
                character (defense in depth: the scene panel hides the dice
                button, but the dialog can be opened from other entry points).
                Close (X) button in the corner keeps working. */}
            {!canRoll ? (
              <div
                className="rounded-xl p-8 flex flex-col items-center justify-center text-center gap-3 animate-fade-in"
                style={{
                  backgroundColor: 'rgba(231, 76, 60, 0.05)',
                  border: '1px solid rgba(231, 76, 60, 0.2)',
                  minHeight: 240,
                }}
              >
                <div
                  className="size-14 rounded-full flex items-center justify-center shrink-0"
                  style={{ backgroundColor: 'rgba(231, 76, 60, 0.12)' }}
                >
                  <ShieldAlert className="size-7" style={{ color: 'var(--fate-danger)' }} />
                </div>
                <p className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                  У вас нет прав для броска за этого персонажа
                </p>
                <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                  Закройте окно и выберите доступного персонажа.
                </p>
              </div>
            ) : (
              <>
            {/* Character info */}
            {character && (
              <div
                className="rounded-xl p-3 flex items-center gap-3"
                style={{
                  background: 'linear-gradient(135deg, rgba(230, 126, 34, 0.08), rgba(230, 126, 34, 0.03))',
                  border: '1px solid rgba(230, 126, 34, 0.15)',
                }}
              >
                {character.avatar ? (
                  <img
                    src={character.avatar}
                    alt={character.name}
                    className="size-10 rounded-full object-cover shadow-sm"
                    draggable={false}
                  />
                ) : (
                  <div
                    className="flex items-center justify-center size-10 rounded-full text-white text-sm font-bold shadow-sm"
                    style={{
                      background: character.type === 'player'
                        ? 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-dark))'
                        : 'linear-gradient(135deg, var(--fate-success), var(--fate-success-dark))',
                    }}
                  >
                    {character.name.charAt(0).toUpperCase()}
                  </div>
                )}
                <div>
                  <div className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                    {character.name}
                  </div>
                  <div className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                    {character.concept || 'Нет концепта'}
                  </div>
                </div>
                <div className="ml-auto">
                  <Badge
                    className="text-xs font-bold px-2 shadow-sm"
                    style={{ backgroundColor: 'rgba(230, 126, 34, 0.1)', color: 'var(--fate-accent)', border: '1px solid rgba(230, 126, 34, 0.2)' }}
                  >
                    ⭐{character.fatePoints}
                  </Badge>
                </div>
              </div>
            )}

            {/* Roll Mode Selection */}
            <div className="space-y-2">
              <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                Тип броска
              </Label>
              <Select value={rollMode} onValueChange={(v) => { setRollMode(v as RollMode); setShowResult(false); setLastResult(null); }}>
                <SelectTrigger className="w-full rounded-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="normal">Обычный бросок</SelectItem>
                  <SelectItem value="difficulty">Против сложности</SelectItem>
                  <SelectItem value="opposed">Против соперника</SelectItem>
                  <SelectItem value="team">🤝 Совместные усилия</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Team Effort Setup */}
            {rollMode === 'team' && (
              <div className="space-y-3 animate-slide-down">
                {/* Team member selection */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                    Участники группы (мин. 2)
                  </Label>
                  <div className="space-y-1 max-h-32 overflow-y-auto fate-scroll">
                    {sceneCharacters.map((c) => {
                      const isInTeam = teamCharIds.includes(c.id);
                      return (
                        <button
                          key={c.id}
                          className={`w-full flex items-center gap-2 p-1.5 rounded-lg text-left transition-all duration-150 ${
                            isInTeam ? 'ring-1 ring-orange-400/50' : ''
                          }`}
                          style={{
                            backgroundColor: isInTeam ? 'rgba(230, 126, 34, 0.1)' : 'transparent',
                          }}
                          onClick={() => {
                            setTeamCharIds((prev) =>
                              isInTeam
                                ? prev.filter((id) => id !== c.id)
                                : [...prev, c.id],
                            );
                          }}
                        >
                          <div
                            className="size-5 rounded-full flex items-center justify-center text-[8px] font-bold text-white shrink-0"
                            style={{
                              backgroundColor: c.type === 'player'
                                ? 'rgba(230, 126, 34, 0.6)'
                                : 'rgba(39, 174, 96, 0.6)',
                            }}
                          >
                            {c.name.charAt(0).toUpperCase()}
                          </div>
                          <span className="text-xs font-medium" style={{ color: 'var(--fate-text)' }}>
                            {c.name}
                          </span>
                          {isInTeam && (
                            <span className="text-[10px] ml-auto" style={{ color: 'var(--fate-accent)' }}>
                              ✓
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Team skill selection */}
                {teamCharIds.length >= 2 && (
                  <div className="space-y-2">
                    <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                      Навык для совместной проверки
                    </Label>
                    <Select value={teamSkillName} onValueChange={setTeamSkillName}>
                      <SelectTrigger className="w-full rounded-lg">
                        <SelectValue placeholder="Выберите навык" />
                      </SelectTrigger>
                      <SelectContent>
                        {teamAvailableSkills.map((s) => (
                          <SelectItem key={s.name} value={s.name}>
                            {s.name} (макс. +{s.value})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>

                    {/* Team effort preview */}
                    {teamSkillName && (() => {
                      const teamChars = teamCharIds.map((id) => getCharacter(id)).filter(Boolean) as Character[];
                      const effort = computeTeamEffort(teamChars, teamSkillName);
                      return (
                        <div
                          className="rounded-lg p-2.5 text-xs space-y-1"
                          style={{ backgroundColor: 'rgba(39, 174, 96, 0.08)', border: '1px solid rgba(39, 174, 96, 0.15)' }}
                        >
                          <div className="font-semibold" style={{ color: 'var(--fate-success)' }}>
                            🤝 Расчёт совместных усилий
                          </div>
                          <div style={{ color: 'var(--fate-text)' }}>
                            Бросает: <strong>{effort.roller.name}</strong> (+{effort.rollerSkill})
                          </div>
                          {effort.helpers.length > 0 && (
                            <div style={{ color: 'var(--fate-text-muted)' }}>
                              Помощь: {effort.helpers.map((h) => `${h.char.name} (+${h.skill}→+${h.bonus})`).join(', ')}
                            </div>
                          )}
                          <div className="font-bold pt-0.5" style={{ color: 'var(--fate-accent)' }}>
                            Итого бонус: +{effort.totalBonus}
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>
            )}

            {/* Skill Pyramid (non-team mode) */}
            {rollMode !== 'team' && character && (
              <SkillPyramid
                skills={character.skills}
                selectedSkill={selectedSkillName}
                onSelectSkill={handleSelectSkill}
              />
            )}

            {/* Selected skill info + bonus */}
            {rollMode !== 'team' && selectedSkillName && (
              <div className="space-y-3">
                <div
                  className="rounded-lg p-3 flex items-center justify-between"
                  style={{ backgroundColor: 'rgba(230, 126, 34, 0.06)', border: '1px solid rgba(230, 126, 34, 0.1)' }}
                >
                  <div>
                    <span className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                      {selectedSkillName}
                    </span>
                  </div>
                  <Badge
                    className="text-sm font-bold px-3 py-1 shadow-sm"
                    style={{
                      backgroundColor: selectedSkillValue >= 4 ? 'var(--fate-accent)' : selectedSkillValue >= 2 ? 'var(--fate-success)' : 'var(--fate-bg-warm)',
                      color: selectedSkillValue >= 2 ? 'white' : 'var(--fate-text)',
                    }}
                  >
                    +{selectedSkillValue}
                  </Badge>
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
                          ? `Бросает ${crowdEffort.rollerName} (навык +${selectedSkillValue}) + помощь +${crowdHelperBonus} = +${selectedSkillValue + crowdHelperBonus}`
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

                {/* Situational bonus */}
                <div className="space-y-2">
                  <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                    Ситуативный бонус
                  </Label>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="size-8 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                      onClick={() => setBonus((b) => b - 1)}
                    >
                      −
                    </Button>
                    <Input
                      type="number"
                      value={bonus}
                      onChange={(e) => setBonus(parseInt(e.target.value) || 0)}
                      className="text-center w-16 font-semibold text-sm rounded-lg h-8"
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="size-8 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                      onClick={() => setBonus((b) => b + 1)}
                    >
                      +
                    </Button>
                    <span className="text-xs ml-1" style={{ color: 'var(--fate-text-muted)' }}>
                      Итого: +{selectedSkillValue + bonus}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* Team difficulty */}
            {rollMode === 'team' && teamSkillName && (
              <div className="space-y-2">
                <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Сложность
                </Label>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="size-8 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                    onClick={() => setDifficulty((d) => Math.max(0, d - 1))}
                  >
                    −
                  </Button>
                  <Input
                    type="number"
                    value={difficulty}
                    onChange={(e) => setDifficulty(parseInt(e.target.value) || 0)}
                    className="text-center w-16 font-semibold text-sm rounded-lg h-8"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="size-8 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                    onClick={() => setDifficulty((d) => d + 1)}
                  >
                    +
                  </Button>
                  <span className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                    {difficulty === 0 ? 'Без сложности' : `Против +${difficulty}`}
                  </span>
                </div>
                <div className="flex gap-1 flex-wrap">
                  {[
                    { label: 'Нет', value: 0 },
                    { label: 'Легко', value: 1 },
                    { label: 'Средне', value: 2 },
                    { label: 'Сложно', value: 3 },
                    { label: 'Очень', value: 4 },
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
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Team bonus */}
            {rollMode === 'team' && teamSkillName && (
              <div className="space-y-2">
                <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Доп. бонус
                </Label>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="size-8 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                    onClick={() => setBonus((b) => b - 1)}
                  >
                    −
                  </Button>
                  <Input
                    type="number"
                    value={bonus}
                    onChange={(e) => setBonus(parseInt(e.target.value) || 0)}
                    className="text-center w-16 font-semibold text-sm rounded-lg h-8"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="size-8 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                    onClick={() => setBonus((b) => b + 1)}
                  >
                    +
                  </Button>
                </div>
              </div>
            )}

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
                        .filter((c) => c.id !== characterId)
                        .map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
                          </SelectItem>
                        ))
                    )}
                  </SelectContent>
                </Select>

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
              <div className="space-y-3">
                {/* Main Result */}
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
                  {/* Compact text fallback (for screen readers & copy) */}
                  <div
                    className="sr-only"
                    aria-label={`Кубики: ${lastResult.dice.map((d) => (d > 0 ? 'плюс' : d < 0 ? 'минус' : 'ноль')).join(', ')}`}
                  >
                    {lastResult.dice.map((d) => formatDiceSymbol(d)).join(' ')}
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
                    <Badge
                      className="text-sm px-4 py-1.5 font-semibold rounded-lg shadow-sm"
                      style={{ backgroundColor: getResultColor(), color: 'white', border: 'none' }}
                    >
                      {lastResult.label}
                    </Badge>
                  </div>

                  {/* Bonus breakdown */}
                  {rollMode === 'team' && teamResult ? (
                    <div className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                      Кубики: {lastResult.dice.reduce<number>((a, b) => a + b, 0) >= 0 ? '+' : ''}
                      {lastResult.dice.reduce<number>((a, b) => a + b, 0)}
                      {' + '}{teamResult.roller}: +{teamResult.rollerSkill}
                      {teamResult.helperBonus > 0 && ` + Помощь: +${teamResult.helperBonus}`}
                      {bonus !== 0 && ` + Бонус: ${bonus >= 0 ? '+' : ''}${bonus}`}
                    </div>
                  ) : (
                    <div className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                      Кубики: {lastResult.dice.reduce<number>((a, b) => a + b, 0) >= 0 ? '+' : ''}
                      {lastResult.dice.reduce<number>((a, b) => a + b, 0)}
                      {' + '}Навык: +{selectedSkillValue}
                      {crowdTeamEffort && crowdHelperBonus > 0 && (
                        <span style={{ color: '#c0392b', fontWeight: 700 }}>
                          {' + '}Помощь толпы: +{crowdHelperBonus}
                        </span>
                      )}
                      {bonus !== 0 && ` + Бонус: ${bonus >= 0 ? '+' : ''}${bonus}`}
                    </div>
                  )}

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
              </div>
            ) : (
              <div
                className="rounded-xl p-6 text-center space-y-2"
                style={{ backgroundColor: 'var(--fate-bg-warm)' }}
              >
                <div className="text-2xl opacity-30">🎲</div>
                <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                  {rollMode === 'team'
                    ? 'Выберите участников и навык для совместной проверки'
                    : 'Выберите навык из пирамиды для броска'}
                </p>
              </div>
            )}
              </>
            )}
          </div>

          <DialogFooter className="gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="rounded-lg"
              onClick={() => onOpenChange(false)}
            >
              Закрыть
            </Button>
            {/* Roll buttons are hidden entirely when the user lacks roll
                permission — the blocking message above explains why. The
                close (X) corner button and the "Закрыть" footer button
                still work so the user can dismiss the dialog. */}
            {canRoll && lastResult && showResult && (
              <Button
                variant="outline"
                size="sm"
                className="rounded-lg gap-1.5"
                onClick={handleRoll}
                disabled={isRolling || !canSubmitRoll}
              >
                <Dice5 className="size-3.5" />
                Ещё раз
              </Button>
            )}
            {canRoll && (
              <Button
                size="sm"
                disabled={isRolling || !canSubmitRoll || (rollMode === 'opposed' && !opponentId)}
                onClick={handleRoll}
                className="fate-btn-accent fate-button-shine gap-1.5 rounded-lg"
              >
                <Dice5 className={`size-4 ${isRolling ? 'animate-spin' : ''}`} />
                {isRolling ? 'Бросаю...' : 'Бросить'}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
