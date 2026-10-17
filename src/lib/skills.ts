// ============================================================
// skills.ts — shared skill utilities
// ============================================================
//
// Single source of truth for skill list normalization.
//
// PROBLEM this solves:
//   Some characters (especially NPCs created by the quick generator
//   before the full-skill-list fix) only store their LEVELED skills
//   in the DB (value > 0). When the user needs to pick ANY skill
//   (e.g. to defend with a +0 skill in a VS / mass-damage roll),
//   the dropdown would only show the leveled ones — making it
//   impossible to select a non-leveled skill.
//
// SOLUTION:
//   `normalizeSkills(charSkills, baseSkills)` merges the character's
//   stored skills with the adventure's `baseSkills` list (value 0
//   for missing ones). This guarantees the FULL skill list is always
//   pickable, regardless of how the character was created.
//
//   This helper MUST be used by EVERY component that renders a skill
//   selector for a character — RollToolPanel, MassDamageRollInline,
//   MassRollInline, CharacterSheetDialog, etc. Do NOT redefine it
//   locally; import from here so the fix is universal.

import type { Skill } from '@/lib/types';

/**
 * Merge a character's stored skills with the adventure's base skill
 * names. Skills the character has leveled keep their value; skills
 * they haven't leveled appear with value 0.
 *
 * The result is sorted by value descending (leveled skills first,
 * then alphabetical-ish via stable sort).
 *
 * @param charSkills   - the character's `skills` array from the DB
 * @param baseSkills   - the adventure's `baseSkills` (names only)
 * @returns            - full skill list, sorted by value desc
 */
export function normalizeSkills(
  charSkills: Skill[],
  baseSkills: string[] | undefined | null,
): Skill[] {
  const map = new Map<string, number>();
  // Start with adventure base skills at 0
  if (baseSkills) {
    for (const name of baseSkills) {
      map.set(name, 0);
    }
  }
  // Overlay the character's actual skills (leveled or custom)
  for (const s of charSkills) {
    map.set(s.name, s.value);
  }
  return Array.from(map.entries())
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Look up a skill's value by name, defaulting to 0 if not found.
 * Convenience wrapper around `character.skills.find(...)`.
 */
export function getSkillValue(
  charSkills: Skill[],
  skillName: string | undefined | null,
): number {
  if (!skillName) return 0;
  return charSkills.find((s) => s.name === skillName)?.value ?? 0;
}
