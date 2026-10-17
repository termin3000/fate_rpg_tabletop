// ============================================================================
// Единый формат лог-записей для бросков с помощниками.
// ============================================================================
//
// Раньше формат customText для совместных бросков различался в 4 местах:
//   1. character-roll-dialog.tsx (team mode)     — эталон: "(+skill→+bonus)"
//   2. character-roll-dialog.tsx (crowd-effort)  — "Совместные усилия толпы! (навык +X) ... = +total"
//   3. skill-roll-dialog.tsx (crowd-effort)      — то же что #2
//   4. roll-tool-panel.tsx (cooperative)         — "(+skill)" без вклада
//
// По запросу пользователя все 4 места унифицированы на эталонный формат #1:
//   "🤝 Совместные усилия! Бросает {name} (+{skill}), помощь: {h1} (+{s1}→+{b1}), {h2} (+{s2}→+{b2})"
//
// Стрелка → показывает: навык помощника → его фактический вклад.
// Это даёт игроку полную картину "кто помогал и какой вклад внёс" прямо в
// основной строке лога (не только в tooltip).
//
// Также унифицирован extraBonusReason: helpers НЕ дублируются в reason
// (они уже в customText). reason = "Ситуативный бонус" только если есть
// ручной бонус, иначе пусто.
// ============================================================================

/**
 * Форматировать customText для совместного броска.
 *
 * @param rollerName  — имя основного бросающего
 * @param rollerSkill — навык бросающего (raw, например +4)
 * @param helpers     — массив помощников { name, skillValue, bonus }
 * @returns строка customText или null, если помощников нет
 */
export function formatCoopRollText(
  rollerName: string,
  rollerSkill: number,
  helpers: { name: string; skillValue: number; bonus: number }[]
): string | null {
  if (!helpers || helpers.length === 0) return null;
  const helpersStr = helpers
    .map((h) => `${h.name} (+${h.skillValue}→+${h.bonus})`)
    .join(', ');
  return `🤝 Совместные усилия! Бросает ${rollerName} (+${rollerSkill}), помощь: ${helpersStr}`;
}

/**
 * Форматировать extraBonusReason.
 *
 * Помощники идут ТОЛЬКО в customText (не дублируются в reason).
 * reason = "Ситуативный бонус" если есть ручной бонус (не 0), иначе ''.
 */
export function formatExtraBonusReason(manualBonus: number): string {
  return manualBonus !== 0 ? 'Ситуативный бонус' : '';
}
