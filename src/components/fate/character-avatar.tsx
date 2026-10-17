'use client';

import { useMemo } from 'react';

// ── Deterministic color palette for avatar fallbacks ──────────
// Each entry is a { bg, fg } pair. Colors avoid indigo/blue per
// project style guide. Indexed by hashing the character name.
const AVATAR_COLORS: { bg: string; fg: string }[] = [
  { bg: '#e67e22', fg: '#ffffff' }, // amber
  { bg: '#27ae60', fg: '#ffffff' }, // green
  { bg: '#e74c3c', fg: '#ffffff' }, // red
  { bg: '#f39c12', fg: '#ffffff' }, // orange
  { bg: '#8e44ad', fg: '#ffffff' }, // purple
  { bg: '#16a085', fg: '#ffffff' }, // teal
  { bg: '#c0392b', fg: '#ffffff' }, // dark red
  { bg: '#d35400', fg: '#ffffff' }, // dark orange
  { bg: '#138d75', fg: '#ffffff' }, // dark teal
  { bg: '#7d3c98', fg: '#ffffff' }, // dark purple
  { bg: '#0e6655', fg: '#ffffff' }, // very dark teal
  { bg: '#922b21', fg: '#ffffff' }, // very dark red
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

function colorForName(name: string, override?: string): { bg: string; fg: string } {
  if (override) {
    return { bg: override, fg: '#ffffff' };
  }
  return AVATAR_COLORS[hashString(name || '?') % AVATAR_COLORS.length];
}

interface CharacterAvatarProps {
  name: string;
  avatar?: string | null;
  avatarColor?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  /** Clickable wrapper */
  onClick?: () => void;
  /** Show a subtle ring around the avatar */
  ring?: boolean;
  title?: string;
}

const SIZE_MAP: Record<NonNullable<CharacterAvatarProps['size']>, string> = {
  xs: 'size-6 text-[10px]',
  sm: 'size-8 text-xs',
  md: 'size-10 text-sm',
  lg: 'size-14 text-base',
  xl: 'size-20 text-2xl',
};

/**
 * CharacterAvatar — renders a character's uploaded portrait image,
 * or falls back to a colored circle with the character's initial.
 *
 * Used in: scene panel character cards, library dialog grid,
 * character sheet dialog header, dashboard "most active" list,
 * conflict / initiative tracker, NPC generator preview.
 */
export function CharacterAvatar({
  name,
  avatar,
  avatarColor,
  size = 'md',
  className = '',
  onClick,
  ring = false,
  title,
}: CharacterAvatarProps) {
  const colors = useMemo(
    () => colorForName(name, avatarColor),
    [name, avatarColor],
  );

  const initial = (name || '?').charAt(0).toUpperCase();

  const baseClass = `relative shrink-0 flex items-center justify-center font-bold overflow-hidden ${SIZE_MAP[size]} ${ring ? 'ring-2 ring-white/30' : ''} ${onClick ? 'cursor-pointer' : ''} ${className}`;

  const style: React.CSSProperties = avatar
    ? {}
    : { backgroundColor: colors.bg, color: colors.fg };

  const content = avatar ? (
    <img
      src={avatar}
      alt={name}
      className="w-full h-full object-cover"
      draggable={false}
    />
  ) : (
    <span aria-hidden="true">{initial}</span>
  );

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`${baseClass} rounded-full transition-all duration-200 hover:scale-105 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-400`}
        style={style}
        title={title ?? name}
        aria-label={title ?? name}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className={`${baseClass} rounded-full`}
      style={style}
      title={title ?? name}
      role="img"
      aria-label={title ?? `Аватар: ${name}`}
    >
      {content}
    </div>
  );
}
