'use client';

// ============================================================
// DiceColorPicker — палитра выбора цветов куба и символа
// ============================================================
//
// Живёт во вкладке «Сцена» SettingsDialog. Даёт игроку выбрать:
//   • Цвет тела куба (10 пресетов)
//   • Цвет символов (10 пресетов)
//
// ОГРАНИЧЕНИЕ: нельзя выбрать один цвет для куба И символа.
// Если цвет занят другой палитрой — он disabled (затемнён, с замком).
// Игрок видит, что выбор ограничен, без необходимости читать текст.
//
// Превью: 4 мини-плитки с текущей палитрой (цвет тела + символы +/−/пусто)
// в том же стиле, что и DiceStation 2D-плитки. Это даёт мгновенный фидбек.
//
// Сброс: одна кнопка «Сбросить к стандарту» возвращает синий куб + белый символ.
//
// Архитектура:
//   • Состояние хранится в store (diceColor, symbolColor) — переживает
//     перезагрузку страницы (persisted in localStorage).
//   • setDiceColor / setSymbolColor имеют встроенный guard: если значение
//     === другому цвету — оно игнорируется. UI тоже disabled, но store
//     обеспечивает безопасность на случай программной установки.

import { useMemo } from 'react';
import { Lock, RotateCcw, Palette } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useFateStore } from '@/lib/store';
import {
  DICE_COLORS,
  DEFAULT_DICE_COLOR,
  DEFAULT_SYMBOL_COLOR,
  derivePalette,
  suggestSymbolShadow,
  findColorOption,
  type DiceColorOption,
} from '@/lib/dice-palette';
import { DiceFaceSvg } from './dice-face-svg';
import type { FudgeFace } from '@/lib/dice-2d-physics';

// ── Превью: 4 мини-плитки как в DiceStation ──
// Показывает кубы с гранями +/−/пусто/+ в текущей палитре.
const PREVIEW_FACES: FudgeFace[] = [1, -1, 0, 1];

function PreviewTiles({ diceColor, symbolColor }: { diceColor: string; symbolColor: string }) {
  const diceFaceBg = useMemo(() => {
    const p = derivePalette(diceColor);
    return `linear-gradient(135deg, ${p.top} 0%, ${p.mid} 50%, ${p.bottom} 100%)`;
  }, [diceColor]);
  const shadowColor = useMemo(
    () => suggestSymbolShadow(diceColor),
    [diceColor],
  );

  return (
    <div className="grid grid-cols-4 gap-2">
      {PREVIEW_FACES.map((face, i) => (
        <div
          key={i}
          className="relative aspect-square rounded-lg overflow-hidden border"
          style={{
            background: diceFaceBg,
            borderColor: 'rgba(0, 10, 40, 0.35)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.18)',
          }}
        >
          <div
            aria-hidden="true"
            className="absolute inset-0 rounded-lg pointer-events-none"
            style={{
              background:
                'radial-gradient(ellipse at center, rgba(0,0,0,0) 35%, rgba(0,0,0,0.28) 100%)',
            }}
          />
          <div className="absolute inset-0 flex items-center justify-center p-[14%] box-border">
            <DiceFaceSvg
              face={face}
              size="100%"
              symbolColor={symbolColor}
              shadowColor={shadowColor}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Один свотч цвета ──
interface ColorSwatchProps {
  option: DiceColorOption;
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  label: string;
}

function ColorSwatch({ option, selected, disabled, onSelect, label }: ColorSwatchProps) {
  // Градиент свотча — чтобы был визуально «живой» (как кубик), а не плоский.
  const pal = useMemo(() => derivePalette(option.hex), [option.hex]);
  const background = useMemo(
    () => `linear-gradient(135deg, ${pal.top} 0%, ${pal.mid} 50%, ${pal.bottom} 100%)`,
    [pal],
  );

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-label={`${label}: ${option.name}${disabled ? ' (занято)' : ''}`}
      aria-pressed={selected}
      title={disabled ? `${option.name} — занят другой палитрой` : option.name}
      className={`
        relative aspect-square rounded-lg transition-all
        ${disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'cursor-pointer hover:scale-105 hover:shadow-md active:scale-95'
        }
        ${selected
          ? 'ring-2 ring-offset-2 ring-offset-background'
          : 'ring-1 ring-inset'
        }
      `}
      style={{
        background,
        // ring color = orange-400 (как и акценты в проекте)
        ...(selected
          ? { boxShadow: '0 0 0 2px var(--fate-accent), 0 4px 10px rgba(0,0,0,0.2)' }
          : { boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)' }),
      }}
    >
      {/* Иконка блокировки для занятого цвета */}
      {disabled && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          aria-hidden="true"
        >
          <Lock
            size={14}
            className="text-white/80 drop-shadow"
            strokeWidth={2.5}
          />
        </div>
      )}
      {/* Имя цвета при selected — маленькая плашка внизу */}
      {selected && !disabled && (
        <div
          className="absolute bottom-0 left-0 right-0 text-[9px] font-semibold text-center py-0.5"
          style={{
            background: 'rgba(0, 0, 0, 0.5)',
            color: 'white',
            backdropFilter: 'blur(2px)',
          }}
        >
          {option.name}
        </div>
      )}
    </button>
  );
}

// ── Главная панель ──
//
// `embedded` — рендер без внешней рамки и отступов. Используется когда
// пикер вставляется внутрь контейнера с собственной обрамлением (например,
// Popover из шапки DiceStation). В режиме `embedded` описание правила
// скрывается (контекст и так понятен из триггера).
export interface DiceColorPickerProps {
  embedded?: boolean;
}

export function DiceColorPicker({ embedded = false }: DiceColorPickerProps = {}) {
  const diceColor = useFateStore((s) => s.diceColor);
  const symbolColor = useFateStore((s) => s.symbolColor);
  const setDiceColor = useFateStore((s) => s.setDiceColor);
  const setSymbolColor = useFateStore((s) => s.setSymbolColor);

  const selectedDiceName = findColorOption(diceColor)?.name ?? 'Кастомный';
  const selectedSymbolName = findColorOption(symbolColor)?.name ?? 'Кастомный';

  const handleReset = () => {
    setDiceColor(DEFAULT_DICE_COLOR);
    setSymbolColor(DEFAULT_SYMBOL_COLOR);
  };

  const wrapperClass = embedded
    ? 'space-y-4'
    : 'rounded-lg border p-4 space-y-4';

  return (
    <div
      className={wrapperClass}
      style={embedded ? undefined : { borderColor: 'var(--fate-border)' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 flex-1">
          <div className="text-sm font-semibold flex items-center gap-2">
            <Palette size={14} style={{ color: 'var(--fate-accent)' }} />
            Цвета кубиков
          </div>
          {!embedded && (
            <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
              Выберите цвет тела куба и цвет символов (+, −). Один цвет нельзя
              использовать одновременно для тела и символа — занятые цвета
              помечены замком. Настройка сохраняется в браузере.
            </p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 rounded-lg gap-1.5"
          onClick={handleReset}
          title="Вернуть стандартные цвета (синий куб + белый символ)"
        >
          <RotateCcw size={12} />
          Сброс
        </Button>
      </div>

      {/* Превью текущей палитры */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--fate-text-muted)' }}>
          <span>Предпросмотр</span>
          <span className="tabular-nums">
            Куб: <strong style={{ color: 'var(--fate-text)' }}>{selectedDiceName}</strong>
            {' • '}
            Символ: <strong style={{ color: 'var(--fate-text)' }}>{selectedSymbolName}</strong>
          </span>
        </div>
        <PreviewTiles diceColor={diceColor} symbolColor={symbolColor} />
      </div>

      {/* Палитра тела куба */}
      <div className="space-y-2">
        <div className="text-xs font-medium flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{ background: diceColor, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3)' }}
          />
          Цвет тела куба
        </div>
        <div className="grid grid-cols-5 gap-2">
          {DICE_COLORS.map((opt) => {
            const isOccupied = opt.hex.toLowerCase() === symbolColor.toLowerCase();
            const isSelected = opt.hex.toLowerCase() === diceColor.toLowerCase();
            return (
              <ColorSwatch
                key={opt.id}
                option={opt}
                selected={isSelected}
                disabled={isOccupied}
                onSelect={() => setDiceColor(opt.hex)}
                label="Тело куба"
              />
            );
          })}
        </div>
      </div>

      {/* Палитра символа */}
      <div className="space-y-2">
        <div className="text-xs font-medium flex items-center gap-1.5">
          <span
            className="inline-block w-2.5 h-2.5 rounded-sm"
            style={{ background: symbolColor, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3)' }}
          />
          Цвет символов
        </div>
        <div className="grid grid-cols-5 gap-2">
          {DICE_COLORS.map((opt) => {
            const isOccupied = opt.hex.toLowerCase() === diceColor.toLowerCase();
            const isSelected = opt.hex.toLowerCase() === symbolColor.toLowerCase();
            return (
              <ColorSwatch
                key={opt.id}
                option={opt}
                selected={isSelected}
                disabled={isOccupied}
                onSelect={() => setSymbolColor(opt.hex)}
                label="Символ"
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
