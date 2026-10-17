'use client';

// ============================================================
// DiceCustomizerButton — кнопка-палитра с Popover для настройки цветов кубов
// ============================================================
//
// Переиспользуемый компонент: одна и та же кнопка живёт в шапке DiceStation
// и в главном header (рядом с «Бросок»). По клику открывает Popover с
// DiceColorPicker (embedded — без внешней рамки, поповер даёт свой chrome).
//
// На кнопке — иконка Palette + два мини-свотча текущих цветов (тело + символ).
// Игрок видит свою палитру не открывая пикер. Title показывает имена текущих
// цветов через findColorOption.
//
// `variant`:
//   • 'station' — компактная (для шапки кейса, тёмный фон). padding 3px 7px.
//   • 'toolbar' — стандартная ghost-кнопка как остальные в header (size sm).
//
// Ограничение «нельзя выбрать один цвет для тела и символа» обеспечивает сам
// DiceColorPicker (disabled + store guard).

import { Palette } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useFateStore } from '@/lib/store';
import { findColorOption } from '@/lib/dice-palette';
import { DiceColorPicker } from './dice-color-picker';

type Variant = 'station' | 'toolbar';

export interface DiceCustomizerButtonProps {
  variant?: Variant;
  /** Дополнительный CSS-класс (для toolbar-варианта). */
  className?: string;
  /** Показывать ли текст «Цвета» рядом с иконкой (только toolbar). */
  showLabel?: boolean;
}

export function DiceCustomizerButton({
  variant = 'station',
  className,
  showLabel = true,
}: DiceCustomizerButtonProps) {
  const diceColor = useFateStore((s) => s.diceColor);
  const symbolColor = useFateStore((s) => s.symbolColor);

  const diceName = findColorOption(diceColor)?.name ?? 'кастомный';
  const symbolName = findColorOption(symbolColor)?.name ?? 'кастомный';
  const title = `Цвета кубиков — куб: ${diceName}, символ: ${symbolName}. Нажмите, чтобы изменить.`;

  const popoverContent = (
    <PopoverContent
      align={variant === 'toolbar' ? 'start' : 'end'}
      sideOffset={6}
      collisionPadding={8}
      className="w-[340px] max-w-[calc(100vw-16px)] p-3"
    >
      <DiceColorPicker embedded />
    </PopoverContent>
  );

  if (variant === 'toolbar') {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`fate-toolbar-btn fate-button-shine text-white/70 hover:text-white hover:bg-white/10 active:bg-white/15 active:scale-95 text-xs gap-1.5 rounded-lg ${className ?? ''}`}
            title={title}
            aria-label="Настроить цвета кубиков"
          >
            <Palette className="size-4" />
            {showLabel && <span className="hidden sm:inline">Цвета</span>}
            {/* Два мини-свотча текущих цветов — индикатор палитры */}
            <span className="fate-dice-station__palette-dots" aria-hidden="true">
              <span style={{ background: diceColor }} />
              <span style={{ background: symbolColor }} />
            </span>
          </Button>
        </PopoverTrigger>
        {popoverContent}
      </Popover>
    );
  }

  // station variant — компактная кнопка для шапки кейса
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="fate-dice-station__palette-btn"
          title={title}
          aria-label="Настроить цвета кубиков"
        >
          <Palette size={12} />
          <span className="fate-dice-station__palette-dots" aria-hidden="true">
            <span style={{ background: diceColor }} />
            <span style={{ background: symbolColor }} />
          </span>
        </button>
      </PopoverTrigger>
      {popoverContent}
    </Popover>
  );
}
