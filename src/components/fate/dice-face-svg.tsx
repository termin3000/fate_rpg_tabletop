'use client';

// ============================================================
// DiceFaceSvg — SVG-символы граней Fudge-кубиков
// ============================================================
//
// Рисует символы (+, −) как inline SVG. В отличие от текстовых
// символов (Unicode +/−), SVG-фигуры ИДЕАЛЬНО центрированы внутри
// своего viewBox — никакой зависимости от font-metrics, baseline
// или асимметрии glyph'ов. Это убирает проблему «иконки граней
// не ровно по центру», которая была с текстовыми символами.
//
// Стиль совпадает с 3D-кубиками:
//   • Цвет символа — настраивается (по умолчанию чистый белый #ffffff)
//   • Тень символа — настраивается (по умолчанию тёмно-синяя rgba(0,10,40,0.55))
//   • Форма «плюс» и «минус» — скруглённые прямоугольники (как в 3D)
//   • Грань «пусто» (face=0) — НЕ рисует ничего, просто прозрачный SVG.
//     Это полностью совпадает с 3D-кубиками, где blank-грань — чистый
//     синий градиент без символа (см. makeFaceTexture в dice-case-3d.tsx).
//
// Используется в:
//   • DiceStation static tray (4 статичных плитки с последним результатом)
//   • Dice2DCanvas live tiles (3 слоя SVG на плитку, переключаются по face)

import type { FudgeFace } from '@/lib/dice-2d-physics';

export interface DiceFaceSvgProps {
  /** Грань: 1=+, 0=пусто, -1=− */
  face: FudgeFace;
  /** Размер SVG в px (квадрат). По умолчанию 100% (заполняет родителя). */
  size?: number | string;
  /** className для корневого <svg>. */
  className?: string;
  /** Не рисовать тень (для маленьких иконок). */
  noShadow?: boolean;
  /** Цвет символа (fill). По умолчанию '#ffffff' (белый). */
  symbolColor?: string;
  /** Цвет тени символа. По умолчанию 'rgba(0, 10, 40, 0.55)'. */
  shadowColor?: string;
}

// ── Размеры фигур внутри viewBox 100×100 ──────────────────────────────
// Подобраны так, чтобы символ визуально занимал ~62% плитки (как в 3D).
const SYMBOL_SIZE = 62;       // длина плеча плюса / минуса
const SYMBOL_THICKNESS = 18;  // толщина плеча
const SYMBOL_RADIUS = 9;      // скругление концов

// Тень: рисуем фигуру ещё раз со смещением (+3, +4) и тёмным цветом.
const SHADOW_OFFSET_X = 3;
const SHADOW_OFFSET_Y = 4;

// ── Суб-компоненты для каждой формы ───────────────────────────────────
// Скруглённый прямоугольник как <rect> с rx/ry. Проще чем <path>.

function PlusShape({ offsetX = 0, offsetY = 0, fill }: { offsetX?: number; offsetY?: number; fill: string }) {
  const cx = 50 + offsetX;
  const cy = 50 + offsetY;
  const half = SYMBOL_SIZE / 2;
  const halfT = SYMBOL_THICKNESS / 2;
  return (
    <>
      {/* Горизонтальное плечо */}
      <rect
        x={cx - half}
        y={cy - halfT}
        width={SYMBOL_SIZE}
        height={SYMBOL_THICKNESS}
        rx={SYMBOL_RADIUS}
        ry={SYMBOL_RADIUS}
        fill={fill}
      />
      {/* Вертикальное плечо */}
      <rect
        x={cx - halfT}
        y={cy - half}
        width={SYMBOL_THICKNESS}
        height={SYMBOL_SIZE}
        rx={SYMBOL_RADIUS}
        ry={SYMBOL_RADIUS}
        fill={fill}
      />
    </>
  );
}

function MinusShape({ offsetX = 0, offsetY = 0, fill }: { offsetX?: number; offsetY?: number; fill: string }) {
  const cx = 50 + offsetX;
  const cy = 50 + offsetY;
  const half = SYMBOL_SIZE / 2;
  const halfT = SYMBOL_THICKNESS / 2;
  return (
    <rect
      x={cx - half}
      y={cy - halfT}
      width={SYMBOL_SIZE}
      height={SYMBOL_THICKNESS}
      rx={SYMBOL_RADIUS}
      ry={SYMBOL_RADIUS}
      fill={fill}
    />
  );
}

// ── Корневой компонент ────────────────────────────────────────────────
// face=0 (пусто) рендерит пустой SVG — только синий фон плитки виден.
// Это совпадает с 3D-кубиками, где blank-грань не имеет символа.
export function DiceFaceSvg({
  face,
  size = '100%',
  className,
  noShadow = false,
  symbolColor = '#ffffff',
  shadowColor = 'rgba(0, 10, 40, 0.55)',
}: DiceFaceSvgProps) {
  const shadowFill = shadowColor;
  const mainFill = symbolColor;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      style={{ display: 'block', pointerEvents: 'none' }}
      aria-hidden="true"
    >
      {/* Тень (смещённая) — только для + и −. Пустая грань не имеет тени. */}
      {!noShadow && face === 1 && (
        <PlusShape offsetX={SHADOW_OFFSET_X} offsetY={SHADOW_OFFSET_Y} fill={shadowFill} />
      )}
      {!noShadow && face === -1 && (
        <MinusShape offsetX={SHADOW_OFFSET_X} offsetY={SHADOW_OFFSET_Y} fill={shadowFill} />
      )}
      {/* Основная фигура — только для + и −. Пустая грань (face=0) — пустой SVG. */}
      {face === 1 && <PlusShape fill={mainFill} />}
      {face === -1 && <MinusShape fill={mainFill} />}
    </svg>
  );
}

// ── Карта граней (для удобства перебора) ──────────────────────────────
export const ALL_FUDGE_FACES: FudgeFace[] = [1, 0, -1];
