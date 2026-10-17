'use client';

// ── Visual Fate dice chips ───────────────────────────────────
// Renders the 4 fate dice as compact color-coded chips so players
// can read the roll at a glance — no hover required.
//   +1 → green chip with «+»
//   -1 → red chip with «−»
//    0 → muted chip with «○»
//
// `size` adapts the chip for different contexts:
//   - 'xs': ultra-compact for dense summary cards (DefenseSummary)
//   - 'sm' (default): inline use in log entries, compact UI
//   - 'md': tooltip / breakdown use
//   - 'lg': large display in roll-dialog result area, very prominent
//   - 'xl': hero rolling animation in the full-height RollToolPanel
//
// Shared between the log panel (compact inline) and the roll dialogs
// (big celebratory display) so the visual language stays consistent.

export type DiceChipSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

const SIZE_MAP: Record<DiceChipSize, { dim: number; fs: number; gap: number }> = {
  xs: { dim: 12, fs: 8, gap: 1 },
  sm: { dim: 16, fs: 10, gap: 2 },
  md: { dim: 22, fs: 13, gap: 3 },
  lg: { dim: 40, fs: 22, gap: 6 },
  xl: { dim: 56, fs: 30, gap: 8 },
};

export function DiceChips({
  dice,
  size = 'sm',
  className,
  animate = true,
}: {
  dice: number[] | null | undefined;
  size?: DiceChipSize;
  className?: string;
  /** Disable the stagger pop-in animation (e.g. when re-rendering in place). */
  animate?: boolean;
}) {
  if (!dice || dice.length === 0) return null;
  const { dim, fs, gap } = SIZE_MAP[size];
  return (
    <span
      className={`fate-dice-chips${className ? ` ${className}` : ''}${animate ? '' : ' fate-dice-chips--no-anim'}`}
      role="img"
      aria-label={`Кубики: ${dice.map((d) => (d > 0 ? 'плюс' : d < 0 ? 'минус' : 'ноль')).join(', ')}`}
      style={{ gap }}
    >
      {dice.map((d, i) => {
        const variant = d > 0 ? 'plus' : d < 0 ? 'minus' : 'blank';
        const symbol = d > 0 ? '+' : d < 0 ? '−' : '○';
        return (
          <span
            key={i}
            className={`fate-dice-chip fate-dice-chip--${variant}`}
            style={{
              width: dim,
              height: dim,
              fontSize: fs,
              lineHeight: `${dim}px`,
              borderRadius: size === 'lg' || size === 'xl' ? Math.round(dim * 0.22) : size === 'xs' ? 3 : 4,
            }}
          >
            {symbol}
          </span>
        );
      })}
    </span>
  );
}
