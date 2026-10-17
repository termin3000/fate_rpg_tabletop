'use client';

import { useState, useEffect, useRef } from 'react';
import { Plus, Dice5, FileText, Sparkles, Library, X } from 'lucide-react';

interface FloatingActionButtonProps {
  onQuickRoll: () => void;
  onNotes: () => void;
  onNpcGenerator: () => void;
  onLibrary: () => void;
}

/**
 * Floating Action Button — provides quick access to common actions
 * on mobile devices and a convenient shortcut on desktop.
 * Expands into a small radial menu when clicked.
 */
export function FloatingActionButton({
  onQuickRoll,
  onNotes,
  onNpcGenerator,
  onLibrary,
}: FloatingActionButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  const items = [
    { label: 'Быстрый бросок', icon: Dice5, action: onQuickRoll, delay: 0 },
    { label: 'Заметки', icon: FileText, action: onNotes, delay: 40 },
    { label: 'Генератор NPC', icon: Sparkles, action: onNpcGenerator, delay: 80 },
    { label: 'Библиотека', icon: Library, action: onLibrary, delay: 120 },
  ];

  const handleClick = (action: () => void) => {
    action();
    setOpen(false);
  };

  return (
    <div ref={ref} className="fate-fab-container" style={{ position: 'fixed', bottom: '1.5rem', right: '1.5rem', zIndex: 40 }}>
      {open && (
        <div className="fate-fab-menu">
          {items.map(({ label, icon: Icon, action, delay }) => (
            <button
              key={label}
              type="button"
              className="fate-fab-menu-item"
              style={{ animationDelay: `${delay}ms` }}
              onClick={() => handleClick(action)}
            >
              <span className="fate-fab-mini-icon">
                <Icon className="size-3.5" />
              </span>
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="fate-fab"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? 'Закрыть меню быстрых действий' : 'Открыть меню быстрых действий'}
        aria-expanded={open}
      >
        {open ? <X className="size-6" /> : <Plus className="size-6" />}
      </button>
    </div>
  );
}
