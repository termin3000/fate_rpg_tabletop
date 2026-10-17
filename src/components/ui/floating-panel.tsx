'use client';

/**
 * FloatingPanel — a draggable, non-modal floating window.
 *
 * Unlike shadcn Dialog (which is modal and blocks underlying interaction),
 * FloatingPanel floats above the page without an overlay. Users can:
 *   - Drag it by the header to reposition
 *   - Minimize it to a compact pill (click the minimize button)
 *   - Close it (click the X button) — parent decides what "close" means
 *   - Interact with the rest of the page normally (it doesn't block clicks)
 *
 * Used for: RollInvitationPanel (player dice-roll dialog) and the GM mass-roll
 * dialog — both need to stay visible while the user looks at character sheets
 * or the map.
 *
 * Design notes:
 *   - Background is TRANSLUCENT by default (variant='translucent') — frosted
 *     glass with heavy backdrop-blur (20px) + high-opacity tint (0.90) +
 *     subtle text-shadow. Looks great over the map while keeping text legible.
 *   - Use variant='solid' only when maximum contrast is needed (e.g., over
 *     very busy/light map backgrounds where even frosted glass isn't enough).
 *   - Strong drop shadow separates the panel from the underlying map.
 *   - Border uses a slightly darker shade for crisp edges.
 *   - Position is constrained to the viewport (can't be dragged off-screen).
 *   - Initial position: bottom-right of the viewport, with a small margin.
 *   - Width is fixed but content can scroll vertically.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, Minus, Square, GripVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface FloatingPanelProps {
  open: boolean;
  onClose: () => void;
  /** Title shown in the header (drag handle area). */
  title: React.ReactNode;
  /** Optional icon shown before the title. */
  icon?: React.ReactNode;
  /** Optional badge/status shown after the title (e.g. "3/5 готовы"). */
  badge?: React.ReactNode;
  /** Optional subtitle shown under the title (small muted text). */
  subtitle?: React.ReactNode;
  /** Panel width in pixels. Default 420. */
  width?: number;
  /** Panel content. */
  children: React.ReactNode;
  /** Footer (buttons). Optional. */
  footer?: React.ReactNode;
  /** Initial position. If omitted, defaults to bottom-right. */
  initialPosition?: { x: number; y: number };
  /** Storage key — if provided, position is persisted to localStorage. */
  storageKey?: string;
  /** Extra class on the content area (for max-height control). */
  contentClassName?: string;
  /**
   * Visual variant:
   *   - 'translucent' (default): frosted-glass effect (backdrop-blur 20px +
   *     0.90 opacity tint + subtle text-shadow). Cool glass look with readable
   *     text over any map background.
   *   - 'solid': fully opaque background — use only when maximum contrast is
   *     needed (e.g., over very busy/light map backgrounds).
   */
  variant?: 'solid' | 'translucent';
  /**
   * Header accent color. Defaults to the warm parchment background
   * (var(--fate-bg-warm)). Pass a CSS color to customize.
   */
  headerAccent?: string;
}

export function FloatingPanel({
  open,
  onClose,
  title,
  icon,
  badge,
  subtitle,
  width = 420,
  children,
  footer,
  initialPosition,
  storageKey,
  contentClassName = '',
  variant = 'translucent',
  headerAccent,
}: FloatingPanelProps) {
  // ── Position state ──
  const [pos, setPos] = useState(() => {
    if (storageKey) {
      try {
        const saved = localStorage.getItem(`fp-${storageKey}`);
        if (saved) {
          const parsed = JSON.parse(saved);
          if (typeof parsed.x === 'number' && typeof parsed.y === 'number') {
            return parsed;
          }
        }
      } catch { /* ignore */ }
    }
    if (initialPosition) return initialPosition;
    // Default: bottom-right with margin
    return {
      x: Math.max(16, window.innerWidth - width - 24),
      y: Math.max(16, window.innerHeight - 480),
    };
  });

  const [minimized, setMinimized] = useState(false);
  const dragRef = useRef<{ offsetX: number; offsetY: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // ── Persist position ──
  useEffect(() => {
    if (!storageKey) return;
    try {
      localStorage.setItem(`fp-${storageKey}`, JSON.stringify(pos));
    } catch { /* ignore */ }
  }, [pos, storageKey]);

  // ── Clamp position to viewport on resize ──
  useEffect(() => {
    const onResize = () => {
      setPos((p) => ({
        x: Math.min(p.x, Math.max(0, window.innerWidth - 200)),
        y: Math.min(p.y, Math.max(0, window.innerHeight - 80)),
      }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // ── Drag handlers (pointer events — works on mouse + touch) ──
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Only start dragging from the header (left-click or touch)
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    // Don't start drag if clicking on a button inside the header
    const target = e.target as HTMLElement;
    if (target.closest('button')) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragRef.current = {
      offsetX: e.clientX - rect.left,
      offsetY: e.clientY - rect.top,
    };
    // Capture pointer so we get move/up events even outside the header
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    e.preventDefault();
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const newX = e.clientX - dragRef.current.offsetX;
    const newY = e.clientY - dragRef.current.offsetY;
    // Clamp to viewport — keep at least 120px visible horizontally and the
    // full header visible vertically.
    const clampedX = Math.max(8, Math.min(newX, window.innerWidth - 120));
    const clampedY = Math.max(8, Math.min(newY, window.innerHeight - 48));
    setPos({ x: clampedX, y: clampedY });
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
  }, []);

  // ── Escape key closes (like a real window) ──
  // Uses capture phase so we run BEFORE Radix's own keydown listeners —
  // otherwise Radix closes its menu first, and we'd see no open overlay
  // and wrongly close the panel too.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Don't auto-close on Escape if there's an open select/popover/menu
        // anywhere on the page — those handle their own Escape.
        const openOverlays = document.querySelectorAll(
          '[data-state="open"][role="dialog"], ' +
          '[data-state="open"][role="listbox"], ' +
          '[data-state="open"][role="menu"], ' +
          '[data-state="open"][role="tooltip"], ' +
          '[data-state="open"][role="popover"], ' +
          '[data-state="open"][role="combobox"]'
        );
        if (openOverlays.length > 0) return;
        // Also: only close on Escape if focus is currently INSIDE the panel.
        // This prevents closing the panel when the user presses Escape while
        // focused on some other element (e.g., a map input).
        const panelEl = panelRef.current;
        if (panelEl && !panelEl.contains(document.activeElement)) return;
        onClose();
      }
    };
    // capture: true → run before Radix's bubble-phase listeners
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  // ── Compute visual styles based on variant ──
  // Translucent (default): frosted glass with strong blur + high-opacity tint.
  //   The key to readability over busy map backgrounds is:
  //     1. Heavy backdrop blur (20px) — smooths out background detail
  //     2. High opacity tint (0.90) — mostly covers the background
  //     3. Subtle text-shadow — lifts text off the background
  //   This gives the cool frosted-glass aesthetic while keeping text crisp.
  const isTranslucent = variant === 'translucent';
  const panelStyle: React.CSSProperties = {
    left: pos.x,
    top: pos.y,
    width: minimized ? 280 : width,
    maxHeight: minimized ? 'auto' : 'calc(100vh - 32px)',
    // Subtle entrance animation
    animation: 'fp-enter 0.18s ease-out',
    // Strong shadow separates the panel from the underlying map.
    // Three-layer shadow: tight dark + soft ambient + hairline ring.
    boxShadow: '0 12px 40px -8px rgba(0,0,0,0.32), 0 4px 12px -4px rgba(0,0,0,0.18), 0 0 0 1px rgba(0,0,0,0.06)',
    // Text-shadow lifts text off the frosted background for readability.
    // Very subtle — only visible over busy backgrounds.
    textShadow: isTranslucent ? '0 1px 2px hsl(var(--background) / 0.6)' : undefined,
  };
  if (isTranslucent) {
    // Frosted-glass look — heavy blur + high-opacity tint.
    // 20px blur + 0.90 opacity = cool glass effect with readable text.
    panelStyle.backdropFilter = 'blur(20px) saturate(1.15)';
    panelStyle.WebkitBackdropFilter = 'blur(20px) saturate(1.15)';
    panelStyle.backgroundColor = 'hsl(var(--background) / 0.90)';
  } else {
    // Solid background — fully opaque, maximum contrast.
    panelStyle.backgroundColor = 'hsl(var(--background))';
  }

  const headerBg = headerAccent ?? 'var(--fate-bg-warm)';

  return (
    <div
      ref={panelRef}
      className="fixed z-[100] flex flex-col rounded-xl border border-border overflow-hidden"
      style={panelStyle}
    >
      {/* ── Header (drag handle) ── */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="flex items-center gap-2 px-3 py-2.5 border-b border-border cursor-grab active:cursor-grabbing select-none relative"
        style={{ backgroundColor: headerBg }}
      >
        {/* Drag grip indicator — 6 dots in 2 columns, gives visual cue that
            the header is a drag handle. Subtle, doesn't compete with text. */}
        <div
          className="flex flex-col gap-[2px] mr-0.5 flex-shrink-0 opacity-40"
          aria-hidden="true"
        >
          <div className="flex gap-[2px]">
            <span className="size-[3px] rounded-full" style={{ backgroundColor: 'var(--fate-text-muted)' }} />
            <span className="size-[3px] rounded-full" style={{ backgroundColor: 'var(--fate-text-muted)' }} />
          </div>
          <div className="flex gap-[2px]">
            <span className="size-[3px] rounded-full" style={{ backgroundColor: 'var(--fate-text-muted)' }} />
            <span className="size-[3px] rounded-full" style={{ backgroundColor: 'var(--fate-text-muted)' }} />
          </div>
          <div className="flex gap-[2px]">
            <span className="size-[3px] rounded-full" style={{ backgroundColor: 'var(--fate-text-muted)' }} />
            <span className="size-[3px] rounded-full" style={{ backgroundColor: 'var(--fate-text-muted)' }} />
          </div>
        </div>
        {icon && (
          <span className="flex-shrink-0" style={{ color: 'var(--fate-accent)' }}>
            {icon}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
              {title}
            </span>
            {badge && <span className="flex-shrink-0">{badge}</span>}
          </div>
          {subtitle && (
            <div className="text-[10px] mt-0.5 truncate" style={{ color: 'var(--fate-text-muted)' }}>
              {subtitle}
            </div>
          )}
        </div>
        {/* Window controls */}
        <div className="flex items-center gap-0.5 flex-shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0 rounded-md hover:bg-accent"
            onClick={(e) => { e.stopPropagation(); setMinimized((m) => !m); }}
            title={minimized ? 'Развернуть' : 'Свернуть'}
          >
            {minimized ? <Square className="size-3.5" /> : <Minus className="size-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="size-7 p-0 rounded-md hover:bg-accent hover:text-destructive"
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            title="Закрыть"
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* ── Drag hint (only when minimized) ── */}
      {minimized && (
        <div className="px-3 py-1.5 flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
          <GripVertical className="size-3" />
          Тяни за заголовок, чтобы переместить · разверни для деталей
        </div>
      )}

      {/* ── Content ── */}
      {!minimized && (
        <div className={`flex-1 overflow-y-auto fate-scrollbar ${contentClassName}`}>
          {children}
        </div>
      )}

      {/* ── Footer ── */}
      {!minimized && footer && (
        <div
          className="px-3 py-2.5 border-t border-border flex items-center gap-2 flex-wrap"
          style={{ backgroundColor: headerBg }}
        >
          {footer}
        </div>
      )}

      <style jsx>{`
        @keyframes fp-enter {
          from { opacity: 0; transform: scale(0.96) translateY(8px); }
          to   { opacity: 1; transform: scale(1) translateY(0); }
        }
      `}</style>
    </div>
  );
}
