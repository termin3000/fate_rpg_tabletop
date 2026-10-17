'use client';

/**
 * MassDamageRollInline — мастер массового урона для бокового меню бросков.
 *
 * Эволюция инструмента: «от демонстрации экрана мастером» → «все играют вместе».
 * Поэтому доступен ВСЕМ пользователям (canRollForCharacter), а не только GM.
 *
 * Фаза 1 «Атака»:
 *   - Выбор персонажа-атакующего + навыка + ситуативный бонус.
 *   - Бросок 4 Fate кубов. Результат = сумма кубов + навык + бонус.
 *   - Переброс (1 жетон судьбы), +2 призыв аспекта (1 жетон судьбы), +2 бесплатно (free invocation).
 *   - Если результат > 0 → переход к фазе 2.
 *   - Если ≤ 0 → «Атака провалилась», сброс.
 *
 * Фаза 2 «Распределение»:
 *   - Выбор противников со сцены (кроме атакующего).
 *   - Ввод урона по каждому (сумма ≤ результата атаки).
 *   - Помощник «поровну» / «очистить».
 *
 * Фаза 3 «Защита»:
 *   - Для каждого защищающегося: выбор защитного навыка + бросок.
 *   - Сравнение: назначенный урон vs защита.
 *     · защита > урон → «Блок» (защитник отбился)
 *     · защита = урон → «Ничья»
 *     · защита < урон → «Урон (+N)» (защитник получает стресс)
 *   - Кнопка «Защитить всех» — бросает сразу для всех.
 *   - «Записать в лог» — создаёт по одной записи на защитника.
 *
 * Подсчёт стресса — вручную мастером/игроками (как в правил Fate Core).
 */

import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import {
  Dices, Swords, Shield, Check, X, RefreshCw, Plus, Gift,
  Target, Crosshair, Zap, AlertTriangle, ChevronRight, ChevronLeft,
  Flame, RotateCcw, Crown,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFateStore } from '@/lib/store';
import { useNetwork } from '@/hooks/use-network';
import {
  executeDiceRoll,
  executeMassRollSimultaneous,
  useDiceMode,
  type DiceRollRequest,
} from '@/lib/roll-executor';
import { rollFateDice, sumFateDice } from '@/lib/fate-dice';
import type { Character, LiveRollEvent, LiveRollParticipant, RollResultType } from '@/lib/types';
import { DiceChips } from '@/components/fate/dice-chips';
import { DefenseSummary } from '@/components/fate/defense-summary';
import { normalizeSkills } from '@/lib/skills';
import { toast } from 'sonner';

// ── Helpers ──────────────────────────────────────────────────

const RESULT_COLORS: Record<string, string> = {
  'Стиль': '#9b59b6',
  'Успех': '#27ae60',
  'Ничья': '#f39c12',
  'Провал': '#e74c3c',
  'Блок': '#2980b9',
  'Урон': '#c0392b',
};

function resultBadgeStyle(label: string): React.CSSProperties {
  const color = RESULT_COLORS[label] ?? '#7f8c8d';
  return { backgroundColor: color, color: 'white', border: 'none' };
}

function formatTotal(total: number): string {
  return total >= 0 ? `+${total}` : String(total);
}

function CharAvatar({ char, size = 22 }: { char: Character; size?: number }) {
  if (char.avatar) {
    return (
      <img
        src={char.avatar}
        alt={char.name}
        className="rounded-full object-cover flex-shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  const initial = char.name.charAt(0).toUpperCase();
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: char.avatarColor || '#e67e22',
        fontSize: size * 0.5,
      }}
    >
      {initial}
    </div>
  );
}

// ── Types ────────────────────────────────────────────────────

type Phase = 'attack' | 'distribute' | 'defend' | 'done';

interface DefenderState {
  characterId: string;
  characterName: string;
  characterType: 'pc' | 'npc';
  avatarColor: string;
  avatar: string | null;
  assignedDamage: number;
  defenseSkillName: string;
  defenseSkillValue: number;
  // Defense roll result (filled after rolling)
  dice: number[] | null;
  /** Raw dice sum (4dF result, before skill/bonus/aspect). */
  diceSum: number | null;
  /** Final defense total = diceSum + skillValue + aspectBonus. */
  total: number | null;
  resultLabel: string | null;
  resultType: RollResultType | 'block' | null;
  rolled: boolean;
  // ── Per-defender aspect invocation (edit) state ──
  // Players can invoke aspects on THEIR OWN defenders; GM on ALL.
  // Each +2 costs 1 fate point (fatePlus2Count) or is free (freeInvokeCount).
  rerollCount: number;
  fatePlus2Count: number;
  freeInvokeCount: number;
}

// ── Main component ───────────────────────────────────────────

export function MassDamageRollInline() {
  const store = useFateStore();
  const {
    characters,
    scenes,
    currentSceneId,
    settings,
    currentAdventureId,
    networkMyDisplayName,
    isNetworkActive,
    networkRole,
    addLogEntry,
    getCharacter,
    canRollForCharacter,
    myAssignedCharacterIds,
  } = store;
  const { broadcastRollStage } = useNetwork();
  const { canUsePhysics } = useDiceMode();

  // ── Available characters (attacker candidates) ──
  // For network players: only assigned chars. For host/offline: all scene chars.
  const sceneCharacters = useMemo(() => {
    const scene = scenes.find((s) => s.id === currentSceneId);
    const roster = settings.playerRoster ?? [];
    const npcIds = scene?.presentCharacters ?? [];
    const visibleIds = new Set<string>([...roster, ...npcIds]);
    return characters.filter((c) => visibleIds.has(c.id));
  }, [characters, scenes, currentSceneId, settings.playerRoster]);

  const myAssignedIds = useMemo(() => {
    return myAssignedCharacterIds();
  }, [myAssignedCharacterIds]);

  const attackerCandidates = useMemo(() => {
    const candidates = myAssignedIds.length > 0
      ? characters.filter((c) => myAssignedIds.includes(c.id))
      : sceneCharacters;
    return candidates.filter((c) => canRollForCharacter(c.id));
  }, [myAssignedIds, characters, sceneCharacters, canRollForCharacter]);

  // ── Phase ──
  const [phase, setPhase] = useState<Phase>('attack');

  // ── Attack config ──
  const [attackerId, setAttackerId] = useState<string | null>(
    myAssignedIds[0] ?? attackerCandidates[0]?.id ?? null,
  );
  // Auto-select first available if none
  if (!attackerId && attackerCandidates.length > 0) {
    setAttackerId(attackerCandidates[0].id);
  }

  const attacker = useMemo(
    () => (attackerId ? getCharacter(attackerId) : null),
    [attackerId, getCharacter],
  );

  // ── Available skills for attacker ──
  // Normalize against adventure baseSkills so ALL skills are pickable
  // (even +0). Some legacy NPCs only store leveled skills in the DB,
  // which previously made it impossible to pick a non-leveled skill.
  // Uses the shared helper from /lib/skills.ts — single source of truth.
  const availableSkills = useMemo(() => {
    if (!attacker) return [];
    return normalizeSkills(attacker.skills, settings.baseSkills);
  }, [attacker, settings.baseSkills]);

  const [skillName, setSkillName] = useState<string>('');
  // Auto-select first skill
  if (attacker && availableSkills.length > 0 && !availableSkills.find((s) => s.name === skillName)) {
    setSkillName(availableSkills[0].name);
  }

  const [bonus, setBonus] = useState(0);

  // ── Attack result ──
  const [attackDice, setAttackDice] = useState<number[]>([]);
  const [attackDiceSum, setAttackDiceSum] = useState(0);
  const [skillValue, setSkillValue] = useState(0);
  const [rerollCount, setRerollCount] = useState(0);
  const [fatePlus2Count, setFatePlus2Count] = useState(0);
  const [freeInvokeCount, setFreeInvokeCount] = useState(0);
  const [isRolling, setIsRolling] = useState(false);
  const [rollingDice, setRollingDice] = useState<number[]>([0, 0, 0, 0]);

  // Derived attack total
  const fateBonus = fatePlus2Count * 2 + freeInvokeCount * 2;
  const attackTotal = attackDice.length > 0
    ? attackDiceSum + skillValue + bonus + fateBonus
    : 0;
  const hasRolled = attackDice.length > 0;

  // ── Defenders (distribution + defense) ──
  const [defenders, setDefenders] = useState<DefenderState[]>([]);
  // True while async physics defense rolls are in flight — disables the
  // "Защитить всех" / "Защита" buttons so the user can't enqueue a second
  // batch before the first completes.
  const [isDefending, setIsDefending] = useState(false);

  // ── Auto-roll trigger ──
  // When the user clicks "Защита" in the distribute phase, we set phase to
  // 'defend' AND set this ref. A useEffect watching `phase` picks up the ref
  // and immediately calls rollAllDefenses — skipping the intermediate
  // "choose defense type" step (the old per-defender cards + "Защитить всех"
  // button). The roll starts as soon as the phase transition renders.
  const autoRollRef = useRef(false);

  // ── Rolling animation ──
  React.useEffect(() => {
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

  // ── Opponent options (scene chars except attacker) ──
  const opponentOptions = useMemo(
    () => sceneCharacters.filter((c) => c.id !== attackerId),
    [sceneCharacters, attackerId],
  );

  // ── Distribution sum ──
  const distributedSum = useMemo(
    () => defenders.reduce((s, d) => s + d.assignedDamage, 0),
    [defenders],
  );
  const remainingDamage = attackTotal - distributedSum;

  // ── All defenders rolled? ──
  const allDefendersRolled = defenders.length > 0 && defenders.every((d) => d.rolled);

  // ════════════════════════════════════════════════════════════
  // HANDLERS
  // ════════════════════════════════════════════════════════════

  const handleAttackRoll = useCallback(async () => {
    if (!attacker) {
      toast.error('Выберите персонажа');
      return;
    }
    if (!skillName) {
      toast.error('Выберите навык');
      return;
    }

    // isRolling guards the button (disabled) in BOTH paths.
    // The 2D cosmetic dice-cycling animation (setInterval) only runs
    // when canUsePhysics=false — see the useEffect above. When 3D is on,
    // the 3D overlay is the sole visual; running 2D in parallel caused a
    // "double animation" bug (2D cycled underneath 3D for ~4s).
    //
    // 3D path: onResult callback fires the MOMENT physics dice land on
    // the table (BEFORE the 4s hold timer). We set dice + clear isRolling
    // immediately — the user sees the result block render at once, while
    // the 3D overlay continues showing the dice for the 4s hold. Without
    // this, the "Кубики летят на стол..." indicator stayed visible for
    // the full 4s hold even though dice were already on the table.
    setIsRolling(true);
    if (!canUsePhysics) {
      setAttackDice([]);
      await new Promise((r) => setTimeout(r, 250));
    }

    const sv = attacker.skills.find((s) => s.name === skillName)?.value ?? 0;
    // Resolve the attacker's owning peer so the attacking dice use that
    // player's palette (per-player dice colors). NPCs fall back to the local
    // (GM) palette inside executeDiceRoll.
    const _attackerState = useFateStore.getState();
    let _attackerPeerId: string | null = null;
    for (const [pid, charIds] of Object.entries(_attackerState.playerAssignments)) {
      if (charIds.includes(attacker.id)) { _attackerPeerId = pid; break; }
    }
    const _attackerPeerColors = _attackerPeerId ? _attackerState.peerDiceColors[_attackerPeerId] : undefined;
    const outcome = await executeDiceRoll({
      characterName: attacker.name,
      characterId: attacker.id,
      skillName,
      skillValue: sv,
      manualBonus: bonus,
      difficulty: null,
      role: 'attacker',
      adventureId: currentAdventureId ?? undefined,
      rolledBy: networkMyDisplayName || attacker.name,
      title: `Атака: ${skillName}`,
      actionContext: 'attack',
      peerId: _attackerPeerId,
      diceColor: _attackerPeerColors?.diceColor,
      symbolColor: _attackerPeerColors?.symbolColor,
    }, {
      canUsePhysics,
      // 3D path: update UI immediately when physics dice land. The 4s
      // hold timer (inside executeDiceRoll) keeps the 3D overlay visible
      // so the user can read the result on the dice faces AND in the
      // inline result block simultaneously.
      onResult: canUsePhysics ? (o) => {
        setAttackDice(o.dice);
        setAttackDiceSum(o.diceSum);
        setSkillValue(sv);
        setRerollCount(0);
        setFatePlus2Count(0);
        setFreeInvokeCount(0);
        setIsRolling(false);
      } : undefined,
    });

    // 2D path: executeDiceRoll returned instantly (no hold timer).
    // Set state now. (3D path already set state in onResult above.)
    if (!canUsePhysics) {
      setAttackDice(outcome.dice);
      setAttackDiceSum(outcome.diceSum);
      setSkillValue(sv);
      setRerollCount(0);
      setFatePlus2Count(0);
      setFreeInvokeCount(0);
      setIsRolling(false);
    }
  }, [attacker, skillName, bonus, currentAdventureId, networkMyDisplayName, canUsePhysics]);

  const handleReroll = useCallback(() => {
    if (!hasRolled) return;
    const newDice = rollFateDice();
    setAttackDice(newDice);
    setAttackDiceSum(sumFateDice(newDice));
    setRerollCount((c) => c + 1);
    toast.success('Переброс (−1 очко судьбы)');
  }, [hasRolled]);

  const handleFatePlus2 = useCallback(() => {
    if (!hasRolled) return;
    setFatePlus2Count((c) => c + 1);
    toast.success('+2 призыв аспекта (−1 жетон судьбы)');
  }, [hasRolled]);

  const handleFreeInvoke = useCallback(() => {
    if (!hasRolled) return;
    setFreeInvokeCount((c) => c + 1);
    toast.success('+2 (бесплатный призыв аспекта)');
  }, [hasRolled]);

  // ── Distribution handlers ──
  const toggleOpponent = useCallback((char: Character) => {
    setDefenders((prev) => {
      const exists = prev.find((d) => d.characterId === char.id);
      if (exists) {
        return prev.filter((d) => d.characterId !== char.id);
      }
      // Use normalizeSkills so the first skill is the highest-leveled one
      // (falls back to +0 if char has no leveled skills — e.g. legacy NPC).
      const allSkills = normalizeSkills(char.skills, settings.baseSkills);
      const firstSkill = allSkills[0];
      return [
        ...prev,
        {
          characterId: char.id,
          characterName: char.name,
          characterType: (char.type === 'player' ? 'pc' : 'npc') as 'pc' | 'npc',
          avatarColor: char.avatarColor,
          avatar: char.avatar,
          assignedDamage: 0,
          defenseSkillName: firstSkill?.name ?? '',
          defenseSkillValue: firstSkill?.value ?? 0,
          dice: null,
          diceSum: null,
          total: null,
          resultLabel: null,
          resultType: null,
          rolled: false,
          rerollCount: 0,
          fatePlus2Count: 0,
          freeInvokeCount: 0,
        },
      ];
    });
  }, [settings.baseSkills]);

  const setDefenderDamage = useCallback((charId: string, damage: number) => {
    setDefenders((prev) =>
      prev.map((d) =>
        d.characterId === charId
          ? { ...d, assignedDamage: Math.max(0, Math.min(damage, 20)) }
          : d,
      ),
    );
  }, []);

  const setDefenderSkill = useCallback((charId: string, skillName: string) => {
    setDefenders((prev) =>
      prev.map((d) => {
        if (d.characterId !== charId) return d;
        const char = getCharacter(charId);
        const sv = char?.skills.find((s) => s.name === skillName)?.value ?? 0;
        return { ...d, defenseSkillName: skillName, defenseSkillValue: sv };
      }),
    );
  }, [getCharacter]);

  const distributeEvenly = useCallback(() => {
    if (defenders.length === 0 || attackTotal <= 0) return;
    const base = Math.floor(attackTotal / defenders.length);
    let remainder = attackTotal - base * defenders.length;
    setDefenders((prev) =>
      prev.map((d) => {
        const extra = remainder > 0 ? 1 : 0;
        if (remainder > 0) remainder -= 1;
        return { ...d, assignedDamage: base + extra };
      }),
    );
  }, [defenders.length, attackTotal]);

  const clearDistribution = useCallback(() => {
    setDefenders((prev) => prev.map((d) => ({ ...d, assignedDamage: 0 })));
  }, []);

  // ── Defense roll ──
  // Computes the defender's result label/type from the rolled total
  // vs the assigned damage. Used by both single-defender and batch paths.
  //
  // ── Правила: ничья = защита успешна (0 урона) ──
  // Раньше: total === assignedDamage → 'Ничья' (1 стресс по Fate Core).
  // Пользователь решил: при ничьей защитник полностью отбивается — урона нет.
  // Это homebrew rule, проще и логичнее для стола. Теперь:
  //   total >= assignedDamage → Блок (урона нет)
  //   total <  assignedDamage → Урон (+shifts)
  // Тип 'tie' больше не возвращается (но остаётся в union для backwards-compat
  // — другие компоненты могут ссылаться на него).
  const computeDefenseOutcome = (total: number, assignedDamage: number): {
    label: string;
    type: RollResultType | 'block';
  } => {
    if (total >= assignedDamage) {
      return { label: 'Блок', type: 'block' };
    }
    const shifts = assignedDamage - total;
    return {
      label: shifts >= 3 ? `Урон с стилем (+${shifts})` : `Урон (+${shifts})`,
      type: shifts >= 3 ? 'great' : 'success',
    };
  };

  // ── Build a DiceRollRequest for a defender ──
  // Centralized so rollDefense, rollAllDefenses, and reroll share the
  // exact same request shape.
  //
  // ── Per-player dice colors ──
  // Resolve the defender's controlling peer from playerAssignments (inverted:
  // find the peer whose roster includes this character) and stamp that peer's
  // dice palette so the defending dice tumble in the defender's owner's colors.
  // NPCs (no owning peer) fall back to the local (GM) palette via
  // executeMassRollSimultaneous / executeDiceRoll.
  const buildDefenderRequest = useCallback((d: DefenderState): DiceRollRequest => {
    const s = useFateStore.getState();
    let peerId: string | null = null;
    for (const [pid, charIds] of Object.entries(s.playerAssignments)) {
      if (charIds.includes(d.characterId)) { peerId = pid; break; }
    }
    const peerColors = peerId ? s.peerDiceColors[peerId] : undefined;
    return {
      characterName: d.characterName,
      characterId: d.characterId,
      skillName: d.defenseSkillName,
      skillValue: d.defenseSkillValue,
      manualBonus: 0,
      difficulty: null,
      role: 'defender',
      adventureId: currentAdventureId ?? undefined,
      rolledBy: networkMyDisplayName || d.characterName,
      title: `Защита: ${d.characterName}`,
      actionContext: 'defense',
      peerId,
      diceColor: peerColors?.diceColor,
      symbolColor: peerColors?.symbolColor,
    };
  }, [currentAdventureId, networkMyDisplayName]);

  // ── Recompute a defender's outcome from its current dice + aspect bonuses ──
  // Called whenever fatePlus2Count / freeInvokeCount changes — does NOT
  // re-roll the dice, just recalculates the total and result label.
  const recomputeDefenderOutcome = useCallback((d: DefenderState) => {
    if (!d.dice) return d;
    const diceSum = d.dice.reduce<number>((a, b) => a + b, 0);
    const aspectBonus = (d.fatePlus2Count + d.freeInvokeCount) * 2;
    const total = diceSum + d.defenseSkillValue + aspectBonus;
    const { label, type } = computeDefenseOutcome(total, d.assignedDamage);
    return { ...d, diceSum, total, resultLabel: label, resultType: type };
  }, []);

  const rollDefense = useCallback(async (charId: string, opts?: { allowReroll?: boolean }) => {
    const d = defenders.find((x) => x.characterId === charId);
    if (!d || (!opts?.allowReroll && d.rolled) || d.assignedDamage <= 0 || !d.defenseSkillName || isDefending) return;
    setIsDefending(true);
    try {
      // Single defender roll — uses executeDiceRoll (one 3D throw).
      // Both PC and NPC go through the same path here so the user sees
      // the 3D animation for an individual defense roll too.
      //
      // 3D path: onResult fires immediately when physics dice land,
      // BEFORE the 4s hold timer. We update the defender's state and
      // clear isDefending right away so the UI is responsive while the
      // 3D overlay continues showing the dice.
      const outcome = await executeDiceRoll(buildDefenderRequest(d), {
        canUsePhysics,
        onResult: canUsePhysics ? (o) => {
          setDefenders((prev) => prev.map((p) => {
            if (p.characterId !== charId) return p;
            const updated = opts?.allowReroll
              ? { ...p, dice: o.dice, rolled: true, rerollCount: p.rerollCount + 1,
                  fatePlus2Count: 0, freeInvokeCount: 0 }
              : { ...p, dice: o.dice, rolled: true };
            return recomputeDefenderOutcome(updated);
          }));
          setIsDefending(false);
        } : undefined,
      });

      // 2D path: set state after await (instant return, no hold timer).
      if (!canUsePhysics) {
        setDefenders((prev) => prev.map((p) => {
          if (p.characterId !== charId) return p;
          const updated = opts?.allowReroll
            ? { ...p, dice: outcome.dice, rolled: true, rerollCount: p.rerollCount + 1,
                fatePlus2Count: 0, freeInvokeCount: 0 }
            : { ...p, dice: outcome.dice, rolled: true };
          return recomputeDefenderOutcome(updated);
        }));
      }
    } finally {
      // Safety net — clears isDefending if onResult didn't fire (2D path
      // or error). For 3D path, onResult already cleared it; this is a
      // harmless redundant set.
      setIsDefending(false);
    }
  }, [defenders, buildDefenderRequest, canUsePhysics, isDefending, recomputeDefenderOutcome]);

  // ── Per-defender aspect invocation handlers ──
  // These do NOT re-roll — they adjust the fatePlus2Count / freeInvokeCount
  // counters and recompute the total/outcome. Permission is checked by the
  // caller (DefenseSummary only shows the buttons for editable defenders).
  const handleDefenderFatePlus2 = useCallback((charId: string) => {
    setDefenders((prev) => prev.map((p) =>
      p.characterId === charId
        ? recomputeDefenderOutcome({ ...p, fatePlus2Count: p.fatePlus2Count + 1 })
        : p,
    ));
    toast.success('+2 призыв аспекта (−1 жетон судьбы)');
  }, [recomputeDefenderOutcome]);

  const handleDefenderFreeInvoke = useCallback((charId: string) => {
    setDefenders((prev) => prev.map((p) =>
      p.characterId === charId
        ? recomputeDefenderOutcome({ ...p, freeInvokeCount: p.freeInvokeCount + 1 })
        : p,
    ));
    toast.success('+2 (бесплатный призыв аспекта)');
  }, [recomputeDefenderOutcome]);

  // ── Edit (reroll) a single defender from the DefenseSummary card ──
  // Triggered by the [✎] expand button — opens the inline editor which
  // offers reroll / +2 aspect / +2 free invocation.
  const handleEditDefender = useCallback((charId: string) => {
    // Toggle the expanded state in DefenseSummary (handled there via local
    // state). The actual reroll is triggered from the inline editor buttons.
    // This function is kept for backward compat with the [✎] button.
  }, []);

  const handleRerollDefender = useCallback((charId: string) => {
    void rollDefense(charId, { allowReroll: true });
  }, [rollDefense]);

  // ── GM / permission helpers ──
  // isGM: host or offline (matches the pattern used in store.ts guards:
  // !isNetworkActive OR networkRole === 'host').
  const isGM = !isNetworkActive || networkRole === 'host';
  const canEditDefender = useCallback((charId: string) => {
    if (isGM) return true;
    return myAssignedIds.includes(charId);
  }, [isGM, myAssignedIds]);

  // ── Roll ALL pending defenses in one batch ──
  // ALL defenders (PC + NPC) roll SIMULTANEOUSLY in a single 3D overlay
  // via executeMassRollSimultaneous. Each defender gets their own zonal
  // slot (computeZonalLayout) so dice don't overlap on the table.
  //
  // Previously NPCs rolled silently (no animation), but this caused user
  // confusion ("никакие броски не делаются"). Now ALL defenders animate
  // in one overlay — the zonal layout prevents chaos even with 5+ dice
  // sets on the table at once.
  //
  // Result: N defenders resolve in ~4s (one overlay) regardless of
  // PC/NPC composition.
  const rollAllDefenses = useCallback(async () => {
    if (isDefending) return;
    const pending = defenders.filter((d) => !d.rolled && d.assignedDamage > 0 && d.defenseSkillName);
    if (pending.length === 0) return;
    setIsDefending(true);
    try {
      const requests = pending.map(buildDefenderRequest);
      const outcomes = await executeMassRollSimultaneous(requests, {
        canUsePhysics,
        // 3D path: onResult fires when ALL N physics sessions have
        // completed (all dice on the table), BEFORE the 4s hold timer.
        // We update defenders state and clear isDefending immediately —
        // DefenseSummary renders at once while the 3D overlay continues
        // showing all dice in their zonal slots for the 4s hold.
        onResult: canUsePhysics ? (ocs) => {
          setDefenders((prev) => prev.map((p) => {
            const idx = pending.findIndex((d) => d.characterId === p.characterId);
            if (idx === -1) return p;
            const outcome = ocs[idx];
            const updated = {
              ...p,
              dice: outcome.dice,
              rolled: true,
              // Reset aspect counters on fresh roll
              fatePlus2Count: 0,
              freeInvokeCount: 0,
            };
            return recomputeDefenderOutcome(updated);
          }));
          setIsDefending(false);
        } : undefined,
      });

      // 2D path: set state after await (instant return, no hold timer).
      if (!canUsePhysics) {
        setDefenders((prev) => prev.map((p) => {
          const idx = pending.findIndex((d) => d.characterId === p.characterId);
          if (idx === -1) return p;
          const outcome = outcomes[idx];
          const updated = {
            ...p,
            dice: outcome.dice,
            rolled: true,
            fatePlus2Count: 0,
            freeInvokeCount: 0,
          };
          return recomputeDefenderOutcome(updated);
        }));
      }
    } finally {
      // Safety net — clears isDefending if onResult didn't fire.
      setIsDefending(false);
    }
  }, [defenders, buildDefenderRequest, canUsePhysics, isDefending, recomputeDefenderOutcome]);

  // ── Logging ──
  const handleLog = useCallback(async () => {
    if (!attacker || !allDefendersRolled) return;

    // Distribution summary for customText
    const distSummary = defenders
      .map((d) => `${d.characterName} ←${d.assignedDamage}`)
      .join(', ');

    // One log entry per defender (opposed-roll format)
    for (const d of defenders) {
      const oppDice = d.dice ?? [];
      const oppTotal = d.total ?? 0;
      const oppBonus = oppDice.length > 0
        ? oppTotal - oppDice.reduce<number>((a, b) => a + b, 0)
        : 0;
      const outcome =
        d.resultType === 'block' ? 'защитник отбился'
        : d.resultType === 'tie' ? 'ничья — защитник отбился (урона нет)'
        : `защитник получает ${d.assignedDamage - oppTotal} стресса`;

      // Per-defender aspect invocation summary for customText
      const dAspectParts: string[] = [];
      if (d.rerollCount > 0) dAspectParts.push(`переброс ×${d.rerollCount}`);
      if (d.fatePlus2Count > 0) dAspectParts.push(`+${d.fatePlus2Count * 2} аспект`);
      if (d.freeInvokeCount > 0) dAspectParts.push(`+${d.freeInvokeCount * 2} бесплат.`);
      const dAspectStr = dAspectParts.length > 0 ? ` [${dAspectParts.join(', ')}]` : '';

      await addLogEntry({
        adventureId: currentAdventureId ?? undefined,
        characterId: attacker.id,
        characterName: attacker.name,
        skillName: skillName || `Бонус +${skillValue}`,
        diceResults: attackDice,
        // total = assigned damage (so LogPanel computes winner correctly)
        bonus: d.assignedDamage - attackDiceSum,
        total: d.assignedDamage,
        difficulty: null,
        opponentTotal: oppTotal,
        result: d.resultLabel ?? '',
        opponentType: 'character',
        opponentCharacterId: d.characterId,
        opponentName: d.characterName,
        opponentSkillName: d.defenseSkillName || null,
        opponentDiceResults: oppDice,
        opponentBonus: oppBonus,
        opponentSkillValue: d.defenseSkillValue,
        opponentManualBonus: 0,
        extraBonus: bonus,
        extraBonusReason: bonus !== 0 ? 'Ситуативный бонус' : '',
        rerolled: rerollCount > 0,
        customText: `⚔️ Массовая атака +${attackTotal} (${skillName}). Распределение: ${distSummary}. По ${d.characterName}: ${d.assignedDamage} урона → защита ${oppTotal} (${d.defenseSkillName}).${dAspectStr} ${outcome}.`,
        isRiftEvent: false,
        skillValue: skillValue || null,
        manualBonus: bonus,
        helpers: [],
        // Attacker's aspect invocation (from phase 1)
        aspectInvokeBonus: (fatePlus2Count + freeInvokeCount) * 2,
        aspectInvokeReason:
          fatePlus2Count > 0 && freeInvokeCount > 0
            ? 'Призыв аспекта (платно + бесплатно)'
            : fatePlus2Count > 0
              ? 'Призыв аспекта'
              : freeInvokeCount > 0
                ? 'Бесплатный призыв аспекта'
                : '',
        aspectRerolled: false,
      });
    }

    toast.success(`Записано ${defenders.length} броск(ов) в лог`);

    // ── Theatrical overlay: build a 'mass-damage' event ──
    try {
      const attackerP: LiveRollParticipant = {
        id: `attacker-${attacker.id}-${Date.now()}`,
        characterName: attacker.name,
        characterId: attacker.id,
        skillName: skillName || undefined,
        skillValue: skillValue || undefined,
        manualBonus: bonus,
        dice: [...attackDice],
        diceSum: attackDiceSum,
        total: attackTotal,
        resultLabel: attackTotal >= 3 ? 'Стиль' : attackTotal > 0 ? 'Успех' : attackTotal === 0 ? 'Ничья' : 'Провал',
        resultType: attackTotal >= 3 ? 'great' : attackTotal > 0 ? 'success' : attackTotal === 0 ? 'tie' : 'fail',
        role: 'attacker',
        bonusCount: fatePlus2Count,
        freeInvokeCount,
        rerolled: rerollCount > 0,
      };

      const defenderParticipants: LiveRollParticipant[] = defenders.map((d) => {
        const dDice = d.dice ?? [];
        const dDiceSum = dDice.reduce<number>((a, b) => a + b, 0);
        const dTotal = d.total ?? 0;
        const defenseOutcome = d.resultType === 'block' ? 'blocked'
          : d.resultType === 'tie' ? 'tie'
          : 'damage';
        return {
          id: `defender-${d.characterId}-${Date.now()}`,
          characterName: d.characterName,
          characterId: d.characterId,
          skillName: d.defenseSkillName || undefined,
          skillValue: d.defenseSkillValue || undefined,
          dice: [...dDice],
          diceSum: dDiceSum,
          total: dTotal,
          resultLabel: d.resultLabel ?? '',
          resultType: dTotal > d.assignedDamage ? 'success' : dTotal === d.assignedDamage ? 'tie' : 'fail',
          role: 'defender',
          damage: d.assignedDamage,
          defenseOutcome,
        };
      });

      const stageEvent: LiveRollEvent = {
        id: `mass-damage-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        type: 'mass-damage',
        rolledBy: networkMyDisplayName || attacker.name,
        rolledAt: Date.now(),
        title: `Массовая атака: ${skillName || ''}`,
        verdict: `⚔️ ${attacker.name} → ${defenders.length} противник(ов)`,
        verdictType: 'info',
        participants: [attackerP, ...defenderParticipants],
        adventureId: currentAdventureId || undefined,
        // ── Summary-only: НЕ анимируем 3D-кубики ──
        // Кубики уже были брошены и показаны в фазах attack/defend (с реальной
        // физикой через pendingPhysicsSessions). При «Записать в лог» мы только
        // фиксируем финальный результат в лог и показываем компактную полоску
        // итогов (CompactResultStrip). Без этого флага overlay монтировал бы
        // Dice3DCanvas с predetermined finalDice → старая логика face-snapping
        // («кубы выпрыгивают и подстраивают грани под результат»).
        isSummary: true,
      };
      broadcastRollStage(stageEvent);
    } catch (stageErr) {
      console.warn('[mass-damage-roll-inline] failed to broadcast stage event:', stageErr);
    }

    setPhase('done');
  }, [attacker, allDefendersRolled, defenders, currentAdventureId, skillName, attackDice, attackDiceSum, bonus, attackTotal, skillValue, fatePlus2Count, freeInvokeCount, rerollCount, networkMyDisplayName, broadcastRollStage, addLogEntry]);

  // ── Reset ──
  const handleReset = useCallback(() => {
    setPhase('attack');
    setAttackDice([]);
    setAttackDiceSum(0);
    setSkillValue(0);
    setRerollCount(0);
    setFatePlus2Count(0);
    setFreeInvokeCount(0);
    setBonus(0);
    setDefenders([]);
  }, []);

  // ── Phase transitions ──
  const goToDistribute = useCallback(() => {
    if (attackTotal <= 0) {
      toast.error('Атака провалилась — урона нет');
      return;
    }
    setPhase('distribute');
  }, [attackTotal]);

  const goToDefend = useCallback(() => {
    const active = defenders.filter((d) => d.assignedDamage > 0);
    if (active.length === 0) {
      toast.error('Назначьте урон хотя бы одному противнику');
      return;
    }
    // Drop defenders with 0 damage
    setDefenders(active);
    setPhase('defend');
    // ── Trigger auto-roll on next render ──
    // The useEffect below watches `phase` and calls rollAllDefenses when
    // autoRollRef is set. This skips the intermediate "choose defense type"
    // step — the user clicks "Защита" and the dice start rolling immediately.
    // Defenders use their default (highest) defense skill; the user can
    // reroll with a different skill or add aspect bonuses via the edit
    // controls in DefenseSummary after the roll.
    autoRollRef.current = true;
  }, [defenders]);

  // ── Auto-roll when entering defend phase ──
  // Fires once when phase transitions to 'defend' (if autoRollRef is set).
  // Rolls ALL pending defenders simultaneously via rollAllDefenses.
  // For PC defenders assigned to other online players (where canRollForCharacter
  // is false), the roll is handled by the GM/host on their client — in network
  // mode, the mass-damage flow is run by the GM who can roll for everyone.
  useEffect(() => {
    if (phase !== 'defend') return;
    if (!autoRollRef.current) return;
    autoRollRef.current = false;
    // Use a microtask to ensure defenders state has settled after setDefenders
    // in goToDefend. The rollAllDefenses callback reads the latest `defenders`
    // from its closure (recreated every render with fresh defenders).
    const pending = defenders.filter((d) => !d.rolled && d.assignedDamage > 0 && d.defenseSkillName);
    if (pending.length > 0 && !isDefending) {
      // Defer to next tick so the phase transition renders first (loading state)
      const timer = setTimeout(() => rollAllDefenses(), 0);
      return () => clearTimeout(timer);
    }
  }, [phase, defenders, isDefending, rollAllDefenses]);

  // ════════════════════════════════════════════════════════════
  // RENDER
  // ════════════════════════════════════════════════════════════

  // ── No available characters ──
  if (attackerCandidates.length === 0) {
    return (
      <div
        className="rounded-lg p-6 flex flex-col items-center justify-center text-center gap-2 animate-fade-in"
        style={{
          backgroundColor: 'rgba(231, 76, 60, 0.05)',
          border: '1px solid rgba(231, 76, 60, 0.2)',
        }}
      >
        <div
          className="size-12 rounded-full flex items-center justify-center"
          style={{ backgroundColor: 'rgba(231, 76, 60, 0.12)' }}
        >
          <AlertTriangle className="size-6" style={{ color: 'var(--fate-danger)' }} />
        </div>
        <p className="text-xs font-semibold" style={{ color: 'var(--fate-text)' }}>
          Нет доступных персонажей
        </p>
        <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
          Добавьте персонажей на сцену или дождитесь назначения.
        </p>
      </div>
    );
  }

  // ── Phase: Done ──
  if (phase === 'done') {
    return (
      <div className="space-y-3 animate-fade-in">
        <div
          className="rounded-lg p-5 flex flex-col items-center text-center gap-2"
          style={{
            backgroundColor: 'rgba(39, 174, 96, 0.06)',
            border: '1px solid rgba(39, 174, 96, 0.25)',
          }}
        >
          <div
            className="size-12 rounded-full flex items-center justify-center"
            style={{ backgroundColor: 'rgba(39, 174, 96, 0.14)' }}
          >
            <Check className="size-6" style={{ color: '#27ae60' }} />
          </div>
          <p className="text-sm font-bold" style={{ color: 'var(--fate-text)' }}>
            Массовая атака записана
          </p>
          <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
            {attacker?.name} нанес урон {defenders.length} противникам. Стресс снимите вручную.
          </p>
        </div>
        <Button
          onClick={handleReset}
          variant="outline"
          size="sm"
          className="w-full h-9 text-xs gap-1.5"
        >
          <RotateCcw className="size-3.5" />
          Новый бросок
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* ── Phase indicator ── */}
      <div className="flex items-center gap-1 text-[9px]">
        {([
          { p: 'attack' as const, n: 1, label: 'Атака', icon: Swords },
          { p: 'distribute' as const, n: 2, label: 'Урон', icon: Crosshair },
          { p: 'defend' as const, n: 3, label: 'Защита', icon: Shield },
        ]).map(({ p, n, label, icon: Icon }, idx) => {
          const isActive = phase === p;
          const isDone =
            (phase === 'distribute' && p === 'attack') ||
            (phase === 'defend' && (p === 'attack' || p === 'distribute'));
          return (
            <React.Fragment key={p}>
              <div
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-md transition-colors"
                style={{
                  backgroundColor: isActive ? 'rgba(230, 126, 34, 0.15)' : 'transparent',
                  color: isActive ? 'var(--fate-accent)' : isDone ? '#27ae60' : 'var(--fate-text-muted)',
                }}
              >
                <span className={`size-3.5 rounded-full flex items-center justify-center text-[8px] font-bold ${isActive || isDone ? '' : 'opacity-60'}`}
                  style={{
                    backgroundColor: isActive ? 'var(--fate-accent)' : isDone ? '#27ae60' : 'rgba(127,140,141,0.2)',
                    color: isActive || isDone ? 'white' : 'var(--fate-text-muted)',
                  }}
                >
                  {isDone ? <Check className="size-2" /> : n}
                </span>
                <Icon className="size-2.5" />
                <span className="font-medium">{label}</span>
              </div>
              {idx < 2 && (
                <ChevronRight className="size-2.5 opacity-40" style={{ color: 'var(--fate-text-muted)' }} />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* ════════════════════════════════════════════════════════
          PHASE 1: ATTACK
          ════════════════════════════════════════════════════════ */}
      {phase === 'attack' && (
        <div className="space-y-3 animate-fade-in">
          {/* Attacker selector */}
          <div className="space-y-1">
            <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
              Атакующий
            </Label>
            <Select value={attackerId ?? undefined} onValueChange={setAttackerId}>
              <SelectTrigger className="h-9 text-xs">
                <div className="flex items-center gap-1.5 min-w-0">
                  {attacker && <CharAvatar char={attacker} size={18} />}
                  <SelectValue placeholder="Выберите персонажа" />
                </div>
              </SelectTrigger>
              <SelectContent>
                {attackerCandidates.map((c) => (
                  <SelectItem key={c.id} value={c.id} className="text-xs">
                    <span className="flex items-center gap-1.5">
                      <CharAvatar char={c} size={16} />
                      <span className="truncate">{c.name}</span>
                      {c.type === 'player' ? (
                        <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1">PC</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1">NPC</Badge>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Skill selector */}
          {availableSkills.length > 0 ? (
            <div className="space-y-1">
              <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                Навык атаки
              </Label>
              <Select value={skillName} onValueChange={setSkillName}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Выберите навык" />
                </SelectTrigger>
                <SelectContent>
                  {availableSkills.map((s) => (
                    <SelectItem key={s.name} value={s.name} className="text-xs">
                      <span className="flex items-center justify-between w-full gap-2">
                        <span>{s.name}</span>
                        <Badge variant="outline" className="text-[9px] px-1 py-0">+{s.value}</Badge>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div
              className="rounded-md p-2 text-[10px] text-center"
              style={{ backgroundColor: 'var(--fate-bg-warm)', color: 'var(--fate-text-muted)' }}
            >
              У персонажа нет навыков
            </div>
          )}

          {/* Situational bonus */}
          <div className="flex items-center justify-between gap-2">
            <Label className="text-[10px] font-medium uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--fate-text-muted)' }}>
              Ситуативный бонус
            </Label>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" className="size-7 p-0" onClick={() => setBonus((b) => Math.max(-10, b - 1))}>−</Button>
              <Input
                type="number"
                value={bonus}
                onChange={(e) => setBonus(Number(e.target.value) || 0)}
                className="h-7 w-14 text-center text-sm font-semibold"
              />
              <Button variant="outline" size="sm" className="size-7 p-0" onClick={() => setBonus((b) => Math.min(20, b + 1))}>+</Button>
            </div>
          </div>

          {/* Roll button */}
          <Button
            onClick={handleAttackRoll}
            disabled={isRolling || !attacker || !skillName}
            className="w-full h-11 gap-2 text-sm font-semibold fate-btn-accent fate-button-shine"
            size="lg"
            style={{
              background: 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-light))',
              color: 'white',
            }}
          >
            {isRolling ? (
              <>
                <Dices className="size-5 animate-spin" />
                Бросаем...
              </>
            ) : (
              <>
                <Swords className="size-5" />
                {hasRolled ? 'Перебросить атаку' : 'Бросить атаку'}
              </>
            )}
          </Button>

          {/* 2D rolling animation — ONLY shown when 3D physics is OFF.
              When canUsePhysics=true, the 3D overlay is the sole visual
              (dice fly, tumble, land on the table). Showing this 2D
              cosmetic block underneath the 3D overlay caused a confusing
              "double animation" — the 2D dice cycled for ~4s while the
              3D dice were also visible. Now: 2D = fallback only. */}
          {isRolling && !canUsePhysics && (
            <div
              className="rounded-lg py-5 px-3 space-y-3 animate-pulse"
              style={{ backgroundColor: 'var(--fate-bg-warm)' }}
            >
              <div className="flex flex-col items-center">
                <span className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--fate-accent)' }}>
                  {attacker?.name ?? 'Атака'}
                </span>
                <DiceChips dice={rollingDice} size="xl" animate={false} />
              </div>
              <p className="text-[10px] text-center animate-pulse" style={{ color: 'var(--fate-text-muted)' }}>
                Кубики катятся...
              </p>
            </div>
          )}

          {/* 3D rolling indicator — minimal "rolling..." hint shown while
              the 3D overlay plays. Keeps the button area from looking
              frozen without duplicating the dice visual. */}
          {isRolling && canUsePhysics && (
            <div
              className="rounded-lg py-3 px-3 flex items-center justify-center gap-2 animate-pulse"
              style={{ backgroundColor: 'var(--fate-bg-warm)' }}
            >
              <Dices className="size-4 animate-spin" style={{ color: 'var(--fate-accent)' }} />
              <span className="text-[10px] font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                Кубики летят на стол...
              </span>
            </div>
          )}

          {/* Attack result */}
          {hasRolled && !isRolling && (
            <div
              className="rounded-lg p-3 space-y-2.5 animate-slide-down"
              style={{
                backgroundColor: 'var(--fate-bg-warm)',
                border: `1px solid ${attackTotal > 0 ? 'rgba(230, 126, 34, 0.35)' : 'rgba(231, 76, 60, 0.3)'}`,
              }}
            >
              <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                <span className="truncate">{attacker?.name} · {skillName} +{skillValue}{bonus !== 0 && ` ${bonus > 0 ? '+' : ''}${bonus}`}</span>
                <span>Атака</span>
              </div>

              <div className="flex justify-center py-0.5">
                <DiceChips dice={attackDice} size="lg" animate={false} />
              </div>

              <div className="flex items-center justify-between">
                <Badge
                  className="text-xs px-2.5 py-0.5 font-semibold"
                  style={resultBadgeStyle(attackTotal > 0 ? 'Урон' : 'Провал')}
                >
                  {attackTotal > 0 ? `Доступно урона` : 'Атака провалилась'}
                </Badge>
                <span
                  className="text-4xl font-black leading-none"
                  style={{ color: attackTotal > 0 ? 'var(--fate-accent)' : '#e74c3c' }}
                >
                  {formatTotal(attackTotal)}
                </span>
              </div>

              {/* Adjustment counters */}
              {(rerollCount > 0 || fatePlus2Count > 0 || freeInvokeCount > 0) && (
                <div className="flex items-center gap-1 flex-wrap">
                  {rerollCount > 0 && (
                    <Badge variant="outline" className="text-[8px] px-1 py-0 gap-0.5" style={{ color: '#e67e22', borderColor: '#e67e22' }}>
                      <RefreshCw className="size-2" />
                      {rerollCount > 1 ? `×${rerollCount}` : ''}
                    </Badge>
                  )}
                  {fatePlus2Count > 0 && (
                    <Badge variant="outline" className="text-[8px] px-1 py-0 gap-0.5" style={{ color: '#27ae60', borderColor: '#27ae60' }}>
                      <Plus className="size-2" />
                      {fatePlus2Count * 2}
                    </Badge>
                  )}
                  {freeInvokeCount > 0 && (
                    <Badge variant="outline" className="text-[8px] px-1 py-0 gap-0.5" style={{ color: '#9b59b6', borderColor: '#9b59b6' }}>
                      <Gift className="size-2" />
                      {freeInvokeCount * 2}
                    </Badge>
                  )}
                </div>
              )}

              {/* Adjust buttons */}
              <div className="grid grid-cols-3 gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[9px] gap-0.5"
                  onClick={handleReroll}
                  title="Перебросить кубики (1 очко судьбы)"
                >
                  <RefreshCw className="size-3" />
                  Переброс
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[9px] gap-0.5"
                  onClick={handleFatePlus2}
                  title="Призвать аспект: +2 к результату за 1 жетон судьбы. Это основная механика Fate — трата жетона судьбы = призыв аспекта."
                >
                  <Plus className="size-3" />
                  +2 аспект
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-[9px] gap-0.5"
                  onClick={handleFreeInvoke}
                  title="Бесплатный призыв аспекта: +2 без траты жетона. Для аспектов с бесплатными призывами (созданных через «Создание преимущества»)."
                >
                  <Gift className="size-3" />
                  +2 бесплатно
                </Button>
              </div>

              {/* Proceed button */}
              {attackTotal > 0 ? (
                <Button
                  onClick={goToDistribute}
                  className="w-full h-9 text-xs gap-1.5 fate-btn-accent"
                  size="sm"
                >
                  <Crosshair className="size-3.5" />
                  Распределить урон
                  <ChevronRight className="size-3" />
                </Button>
              ) : (
                <Button
                  onClick={handleReset}
                  variant="outline"
                  size="sm"
                  className="w-full h-9 text-xs gap-1.5"
                >
                  <RotateCcw className="size-3.5" />
                  Сбросить
                </Button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          PHASE 2: DISTRIBUTE
          ════════════════════════════════════════════════════════ */}
      {phase === 'distribute' && (
        <div className="space-y-3 animate-fade-in">
          {/* Available damage banner */}
          <div
            className="rounded-lg p-3 flex items-center justify-between"
            style={{
              background: 'linear-gradient(135deg, rgba(230, 126, 34, 0.12), rgba(230, 126, 34, 0.04))',
              border: '1px solid rgba(230, 126, 34, 0.25)',
            }}
          >
            <div>
              <div className="text-[9px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                Доступно урона
              </div>
              <div className="text-2xl font-black leading-none" style={{ color: 'var(--fate-accent)' }}>
                {formatTotal(attackTotal)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[9px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                Распределено
              </div>
              <div
                className="text-2xl font-black leading-none"
                style={{
                  color: remainingDamage === 0 ? '#27ae60' : remainingDamage < 0 ? '#e74c3c' : 'var(--fate-text)',
                }}
              >
                {formatTotal(distributedSum)}
              </div>
              <div className="text-[9px] mt-0.5" style={{ color: 'var(--fate-text-muted)' }}>
                {remainingDamage > 0
                  ? `осталось +${remainingDamage}`
                  : remainingDamage === 0
                    ? 'распределено полностью'
                    : `превышение на ${-remainingDamage}`}
              </div>
            </div>
          </div>

          {/* Quick actions */}
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-7 text-[10px] gap-1"
              onClick={distributeEvenly}
              disabled={defenders.length === 0}
            >
              <Zap className="size-3" />
              Поровну
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-7 text-[10px] gap-1"
              onClick={clearDistribution}
              disabled={defenders.length === 0}
            >
              <X className="size-3" />
              Очистить
            </Button>
          </div>

          {/* Opponent selection */}
          <div className="space-y-1.5">
            <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
              Противники ({defenders.length} выбрано)
            </Label>
            {opponentOptions.length === 0 ? (
              <div
                className="rounded-md p-3 text-center text-[10px]"
                style={{ color: 'var(--fate-text-muted)', backgroundColor: 'var(--fate-bg-warm)' }}
              >
                Нет других персонажей на сцене
              </div>
            ) : (
              <div className="space-y-1 max-h-64 overflow-y-auto fate-scroll rounded-md p-1" style={{ backgroundColor: 'var(--fate-bg-warm)' }}>
                {opponentOptions.map((char) => {
                  const defender = defenders.find((d) => d.characterId === char.id);
                  const selected = !!defender;
                  return (
                    <div
                      key={char.id}
                      className={`rounded-md p-1.5 space-y-1.5 transition-colors ${selected ? '' : 'hover:bg-white/40 dark:hover:bg-white/5'}`}
                      style={{
                        backgroundColor: selected ? 'rgba(230, 126, 34, 0.08)' : 'transparent',
                        border: `1px solid ${selected ? 'rgba(230, 126, 34, 0.25)' : 'transparent'}`,
                      }}
                    >
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleOpponent(char)}
                          className="size-3.5 rounded accent-orange-500"
                        />
                        <CharAvatar char={char} size={20} />
                        <span className="text-[11px] font-medium truncate flex-1" style={{ color: 'var(--fate-text)' }}>
                          {char.name}
                        </span>
                        {char.type === 'player' ? (
                          <Badge variant="outline" className="text-[7px] px-1 py-0">PC</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[7px] px-1 py-0" style={{ color: 'var(--fate-text-muted)' }}>NPC</Badge>
                        )}
                      </label>
                      {selected && (
                        <div className="flex items-center gap-1.5 pl-6 animate-slide-down">
                          <Target className="size-3 flex-shrink-0" style={{ color: 'var(--fate-accent)' }} />
                          <Button
                            variant="outline"
                            size="sm"
                            className="size-6 p-0"
                            onClick={() => setDefenderDamage(char.id, defender!.assignedDamage - 1)}
                          >
                            −
                          </Button>
                          <Input
                            type="number"
                            value={defender!.assignedDamage}
                            onChange={(e) => setDefenderDamage(char.id, parseInt(e.target.value) || 0)}
                            className="h-6 w-12 text-center text-xs font-semibold"
                            min={0}
                            max={attackTotal}
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            className="size-6 p-0"
                            onClick={() => setDefenderDamage(char.id, defender!.assignedDamage + 1)}
                            disabled={remainingDamage <= 0}
                          >
                            +
                          </Button>
                          <span className="text-[9px] ml-auto" style={{ color: 'var(--fate-text-muted)' }}>
                            урон
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Navigation */}
          <div className="flex items-center gap-1.5 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-9 text-[11px] gap-1"
              onClick={() => setPhase('attack')}
            >
              <ChevronLeft className="size-3.5" />
              Назад
            </Button>
            <Button
              size="sm"
              className="flex-1 h-9 text-[11px] gap-1 fate-btn-accent"
              onClick={goToDefend}
              disabled={defenders.filter((d) => d.assignedDamage > 0).length === 0}
            >
              Защита
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
          {remainingDamage < 0 && (
            <p className="text-[9px] text-center" style={{ color: '#e74c3c' }}>
              Превышение доступного урона на {-remainingDamage}
            </p>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════
          PHASE 3: DEFEND
          ════════════════════════════════════════════════════════ */}
      {phase === 'defend' && (
        <div className="space-y-3 animate-fade-in">
          {/* Attack summary */}
          <div
            className="rounded-md p-2 flex items-center justify-between"
            style={{
              backgroundColor: 'rgba(230, 126, 34, 0.08)',
              border: '1px solid rgba(230, 126, 34, 0.2)',
            }}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <Swords className="size-3.5 flex-shrink-0" style={{ color: 'var(--fate-accent)' }} />
              <span className="text-[11px] font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                {attacker?.name}
              </span>
              <span className="text-[9px]" style={{ color: 'var(--fate-text-muted)' }}>
                · {skillName}
              </span>
            </div>
            <span className="text-lg font-black" style={{ color: 'var(--fate-accent)' }}>
              {formatTotal(attackTotal)}
            </span>
          </div>

          {/* ── Defense rolling state ──
              When the user clicks "Защита" in the distribute phase, the
              auto-roll fires immediately (via autoRollRef + useEffect). While
              the dice are rolling (isDefending=true) and not all defenders
              have results yet, we show a compact loading state instead of
              the old per-defender cards + "Защитить всех" button.

              Once all defenders have rolled, the DefenseSummary card below
              shows the results with inline edit controls (reroll, +2 aspect,
              +2 free invoke). The user can change the defense skill via
              reroll from there. */}
          {!allDefendersRolled && (
            <div
              className="rounded-md p-4 flex flex-col items-center justify-center text-center gap-2 animate-fade-in"
              style={{
                backgroundColor: 'var(--fate-bg-warm)',
                border: '1px solid rgba(230, 126, 34, 0.2)',
              }}
            >
              <div className="flex items-center gap-2">
                <Dices className="size-5 animate-spin" style={{ color: 'var(--fate-accent)' }} />
                <span className="text-[11px] font-semibold animate-pulse" style={{ color: 'var(--fate-text)' }}>
                  {isDefending ? 'Бросаем защиту...' : 'Подготовка броска...'}
                </span>
              </div>
              <p className="text-[9px]" style={{ color: 'var(--fate-text-muted)' }}>
                {defenders.length} защитник(ов) · кубы летят на стол
              </p>
              {/* Defender name chips — compact list so the user sees WHO is
                  defending without the full per-defender cards. */}
              <div className="flex flex-wrap gap-1 justify-center mt-1">
                {defenders.map((d) => (
                  <span
                    key={d.characterId}
                    className="text-[9px] px-1.5 py-0.5 rounded-full"
                    style={{
                      backgroundColor: d.rolled ? 'rgba(41, 128, 185, 0.12)' : 'rgba(230, 126, 34, 0.08)',
                      color: d.rolled ? '#2980b9' : 'var(--fate-text-muted)',
                      border: `1px solid ${d.rolled ? 'rgba(41, 128, 185, 0.25)' : 'rgba(230, 126, 34, 0.2)'}`,
                    }}
                  >
                    {d.characterName}
                    {d.rolled && ' ✓'}
                  </span>
                ))}
              </div>
            </div>
          )}


          {/* ── "All rolled" header — compact label replacing the per-defender
              list header. The reroll-all action isn't provided here because
              rollAllDefenses skips already-rolled defenders; per-defender
              reroll buttons live inside DefenseSummary instead. */}
          {allDefendersRolled && defenders.length > 0 && (
            <div className="flex items-center justify-between gap-2">
              <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                Защитники ({defenders.length}) · итоги
              </Label>
              {isDefending && (
                <span className="text-[9px] flex items-center gap-1 animate-pulse" style={{ color: 'var(--fate-accent)' }}>
                  <Dices className="size-3 animate-spin" />
                  Переброс...
                </span>
              )}
            </div>
          )}

          {/* ── Defense Summary card ──
              Renders when ALL defenders have rolled. Shows a compact
              overview of attack + all defender outcomes with inline edit
              controls (reroll / +2 aspect / +2 free invocation).
              Permission-aware: only GM or character owner can edit. */}
          {allDefendersRolled && (
            <DefenseSummary
              attackName={attacker?.name}
              attackSkillName={skillName}
              attackDice={attackDice}
              attackTotal={attackTotal}
              availableDamage={attackTotal}
              defenders={defenders}
              canEditDefender={canEditDefender}
              onEditDefender={handleEditDefender}
              onRerollDefender={handleRerollDefender}
              onFatePlus2={handleDefenderFatePlus2}
              onFreeInvoke={handleDefenderFreeInvoke}
              isDefending={isDefending}
            />
          )}

          {/* Navigation */}
          <div className="flex items-center gap-1.5 pt-1">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-9 text-[11px] gap-1"
              onClick={() => setPhase('distribute')}
            >
              <ChevronLeft className="size-3.5" />
              Назад
            </Button>
            <Button
              size="sm"
              className="flex-1 h-9 text-[11px] gap-1 fate-btn-accent"
              onClick={handleLog}
              disabled={!allDefendersRolled}
            >
              <Check className="size-3.5" />
              Записать в лог
            </Button>
          </div>
          {!allDefendersRolled && (
            <p className="text-[9px] text-center" style={{ color: 'var(--fate-text-muted)' }}>
              Осталось защититься: {defenders.filter((d) => !d.rolled).length}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
