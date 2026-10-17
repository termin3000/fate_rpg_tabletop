// ============================================================
// Fate RPG Virtual Tabletop — Fate Dice Utility
// ============================================================

import type { Character, FateDie, GroupedCrowdHelper, RollHelper, RollResult, RollResultType } from '@/lib/types';

/**
 * Roll 4 Fate dice.
 * Each die: -1 (minus), 0 (blank), +1 (plus).
 */
export function rollFateDice(): FateDie[] {
  const results: FateDie[] = [];
  for (let i = 0; i < 4; i++) {
    const r = Math.floor(Math.random() * 3);
    if (r === 0) results.push(1);
    else if (r === 1) results.push(-1);
    else results.push(0);
  }
  return results;
}

/**
 * Sum the values of an array of Fate dice.
 */
export function sumFateDice(dice: FateDie[]): number {
  return dice.reduce<number>((sum, d) => sum + d, 0);
}

/**
 * Determine the result of a roll compared to a difficulty or an opponent's total.
 * Uses Russian-language labels as per the Fate RPG Russian localization convention.
 */
export function getRollResult(
  total: number,
  difficulty?: number | null,
  opponentTotal?: number | null,
): { label: string; type: RollResultType } {
  // Versus an opponent
  if (opponentTotal !== undefined && opponentTotal !== null) {
    if (total > opponentTotal) {
      const shifts = total - opponentTotal;
      if (shifts >= 3)
        return { label: `Успех с стилем (+${shifts})`, type: 'great' };
      return { label: `Успех (+${shifts})`, type: 'success' };
    }
    if (total === opponentTotal)
      return { label: 'Ничья', type: 'tie' };
    return { label: `Провал (${total - opponentTotal})`, type: 'fail' };
  }

  // Versus a fixed difficulty
  if (difficulty !== undefined && difficulty !== null) {
    if (total > difficulty) {
      const shifts = total - difficulty;
      if (shifts >= 3)
        return { label: `Успех с стилем (+${shifts})`, type: 'great' };
      return { label: `Успех (+${shifts})`, type: 'success' };
    }
    if (total === difficulty) return { label: 'Ничья', type: 'tie' };
    return { label: `Провал (${total - difficulty})`, type: 'fail' };
  }

  // No comparison — just describe the total
  if (total >= 4) return { label: `Результат: +${total}`, type: 'great' };
  if (total >= 1) return { label: `Результат: +${total}`, type: 'success' };
  if (total === 0) return { label: 'Результат: 0', type: 'tie' };
  return { label: `Результат: ${total}`, type: 'fail' };
}

/**
 * Convenience: roll dice, add a skill rating, and return a full RollResult.
 */
export function performRoll(
  skillRank: number = 0,
  difficulty?: number | null,
  opponentTotal?: number | null,
): RollResult {
  const dice = rollFateDice();
  const raw = sumFateDice(dice);
  const total = raw + skillRank;
  const { label, type } = getRollResult(total, difficulty, opponentTotal);
  return { dice, total, label, type };
}

/**
 * Format a single die value as a human-readable symbol.
 */
export function formatDiceSymbol(value: number): string {
  if (value === 1) return '＋';
  if (value === -1) return '－';
  return '◯';
}

/**
 * Generate a unique ID (client-side, for optimistic updates).
 */
export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
}

// ============================================================
// Crowd / Horde Team-Effort Helpers
// ============================================================
// Fate Core "mobs" rule: when a crowd acts together on a roll, the member
// with the highest relevant skill is the "roller" (their skill is already
// reflected by the crowd's own skill rating). Every OTHER active member
// whose base character has that skill at +1 or higher adds +1 to the roll.
// Members whose base character doesn't have the skill (value 0) contribute
// +0 but are still listed so the GM can see who participated and why they
// didn't help.

export interface CrowdEffortResult {
  /** The name of the member chosen as the roller (for display). */
  rollerName: string;
  /** All other active members with their per-member contribution. */
  helpers: RollHelper[];
  /** Sum of all helper bonuses (excludes the roller). */
  totalHelperBonus: number;
  /** Total number of active members in the crowd. */
  activeCount: number;
}

/**
 * Calculate the crowd team-effort breakdown for a roll.
 *
 * @param crowdChar    The crowd (horde) character.
 * @param skillName    The skill being rolled.
 * @param crowdSkillValue  The crowd's own rating in that skill.
 * @param characters   All characters in the adventure (for base-char lookup).
 */
export function calculateCrowdHelpers(
  crowdChar: Character | null | undefined,
  skillName: string,
  crowdSkillValue: number,
  characters: Character[],
): CrowdEffortResult {
  if (!crowdChar?.isHorde || !crowdChar.members || !skillName) {
    return { rollerName: crowdChar?.name ?? '', helpers: [], totalHelperBonus: 0, activeCount: 0 };
  }

  const activeMembers = crowdChar.members.filter((m) => m.isActive);
  if (activeMembers.length === 0) {
    return { rollerName: crowdChar.name, helpers: [], totalHelperBonus: 0, activeCount: 0 };
  }

  // Pick the roller: the active member whose base character has the highest
  // value in this skill. This matches the user's expectation that "the
  // character with the highest target skill in the crowd is chosen".
  // Falls back to the first active member if no base character has the skill.
  let rollerIndex = 0;
  let rollerSkill = -Infinity;
  for (let i = 0; i < activeMembers.length; i++) {
    const member = activeMembers[i];
    const baseChar = characters.find((c) => c.id === member.baseCharacterId);
    const baseSkillValue = baseChar?.skills.find((s) => s.name === skillName)?.value;
    const effective = baseSkillValue ?? crowdSkillValue;
    if (effective > rollerSkill) {
      rollerSkill = effective;
      rollerIndex = i;
    }
  }
  const roller = activeMembers[rollerIndex];

  const helpers: RollHelper[] = [];
  let totalHelperBonus = 0;

  for (let i = 0; i < activeMembers.length; i++) {
    if (i === rollerIndex) continue;
    const member = activeMembers[i];
    const baseChar = characters.find((c) => c.id === member.baseCharacterId);
    const baseSkillValue = baseChar?.skills.find((s) => s.name === skillName)?.value;
    // If the base character can't be found, fall back to the crowd's skill.
    // If the base character exists but doesn't have the skill (undefined),
    // treat it as 0 (they genuinely don't have the skill).
    const effectiveSkill = baseSkillValue ?? (baseChar ? 0 : crowdSkillValue);
    const bonus = effectiveSkill >= 1 ? 1 : 0;

    helpers.push({
      name: member.name,
      baseCharacterName: member.baseCharacterName || member.name,
      skillName,
      skillValue: effectiveSkill,
      bonus,
    });
    totalHelperBonus += bonus;
  }

  return {
    rollerName: roller.name,
    helpers,
    totalHelperBonus,
    activeCount: activeMembers.length,
  };
}

/**
 * Group a flat list of crowd helpers by their base character ("type").
 *
 * This collapses a verbose per-member list (e.g. "Гоблин 1", "Гоблин 2", …,
 * "Волк 5", "Волк 6", …) into compact per-type rows (e.g. "Гоблин ×2 +2",
 * "Волк ×3 0") so the tooltip stays readable even for large mobs.
 *
 * Helpers without `baseCharacterName` (older log entries) fall back to
 * grouping by `name`, which effectively keeps each as its own row — but in
 * practice old entries also lack grouping metadata, so this is acceptable.
 *
 * The order of groups is: by descending totalBonus (so contributing types
 * appear first), then alphabetically for stable output.
 */
export function groupCrowdHelpers(helpers: RollHelper[] | null | undefined): GroupedCrowdHelper[] {
  if (!helpers || helpers.length === 0) return [];

  const map = new Map<string, GroupedCrowdHelper>();
  for (const h of helpers) {
    const key = h.baseCharacterName || h.name;
    const existing = map.get(key);
    if (existing) {
      existing.count += 1;
      existing.totalBonus += h.bonus;
      // Keep the skill info from the first member of this type (they share it).
    } else {
      map.set(key, {
        typeLabel: key,
        count: 1,
        skillName: h.skillName,
        skillValue: h.skillValue,
        totalBonus: h.bonus,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    // Contributing types (totalBonus > 0) first, then non-contributing.
    if (b.totalBonus !== a.totalBonus) return b.totalBonus - a.totalBonus;
    return a.typeLabel.localeCompare(b.typeLabel, 'ru');
  });
}
