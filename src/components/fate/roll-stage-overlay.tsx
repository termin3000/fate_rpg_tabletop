'use client';

// ============================================================
// Roll Stage Overlay — «театральный режим» бросков (над картой)
// ============================================================
// Оверлей рендерится НАД КАРТОЙ (внутри .fate-map-canvas-wrapper).
// Кубики вылетают из кейса (левый нижний угол), кувыркаются, приземляются
// на карту и показывают результат. Результат уходит в лог. Кубики
// остаются на карте, пока игрок не кликнет кейс (DiceCase) — тогда
// играется return-анимация и оверлей закрывается.
//
// pointer-events: none на канвасе и подложке → карта остаётся
// интерактивной во время броска. pointer-events: auto только на
// плавающей карточке с информацией (правый верхний угол).
//
// ── Информативность (компактная плавающая карточка) ──
//   • Контекст действия (⚔ атака / 🛡️ защита / ✓ проверка / ↑ преодоление / 🤝 совместное)
//   • Кто бросает + имя персонажа + навык (+значение)
//   • Разбивка модификаторов (чипы)
//   • Кубики (3D, на карте)
//   • Сумма кубиков + итоговое число + лестница Fate
//   • Сложность + превышение/дефицит
//   • Verdict
//
// Закрытие:
// - Клик по кейсу (DiceCase) → return-анимация → dismiss (graceful)
// - Esc → return-анимация → dismiss (graceful)
// - Клик по ✕ в карточке → немедленный dismiss (skip)
// - Авто-dismiss убран: кубики остаются на столе до ручного закрытия

import { useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  X, Swords, Shield, CheckCircle, TrendingUp, Users, Dices,
} from 'lucide-react';
import { useFateStore } from '@/lib/store';

// Динамический импорт Three.js-канваса — ssr:false, отдельный chunk.
// Если WebGL недоступен — fallback на SVG Die3D (внутри PhysicalDiceRow).
const Dice3DCanvas = dynamic(
  () => import('./dice-3d-canvas').then((m) => m.Dice3DCanvas),
  { ssr: false, loading: () => null }
);
// ── ServerDiceStage: СТАТИЧЕСКИЙ импорт (раньше был dynamic) ──────────────
// Раньше ServerDiceStage грузился через next/dynamic — отдельный chunk
// скачивался при ПЕРВОМ броске после reload страницы. Это давало 500-700ms
// задержку между dragEnd и socket.emit('dice:roll') → physics-service
// получал roll-запрос через 700ms → bridge mode не помогал (timeout 400ms).
//
// Статический импорт встраивает ServerDiceStage в основной бандл → он доступен
// сразу при монтировании RollStageOverlay, без chunk-download задержки.
// SSR: false обеспечивается 'use client' в server-dice-stage.tsx + тем,
// что RollStageOverlay сам монтируется только в browser (через dynamic в
// page.tsx). Webpack не пытается рендерить ServerDiceStage на сервере.
import { ServerDiceStage } from './server-dice-stage';
import { ServerDiceStage2D } from './server-dice-stage-2d';
import type { DicePhase, DieScatter3D } from './dice-3d-canvas';
import type { LiveRollEvent, LiveRollParticipant } from '@/lib/types';
import { clearSharedDiceBuffer, clearReturnState } from '@/lib/held-dice-bus';
import { clearShared2DDiceBuffer, clearReturn2DState } from '@/lib/held-dice-2d-bus';

// ── Фазы анимации ────────────────────────────────────────────
type Phase = 'enter' | 'drop' | 'tumble' | 'settle' | 'reveal' | 'verdict' | 'hold' | 'exit';

const RESULT_COLORS: Record<LiveRollParticipant['resultType'], { fg: string; bg: string; border: string }> = {
  fail:    { fg: '#e74c3c', bg: 'rgba(231, 76, 60, 0.12)',  border: 'rgba(231, 76, 60, 0.4)' },
  tie:     { fg: '#7f8c8d', bg: 'rgba(127, 140, 141, 0.12)', border: 'rgba(127, 140, 141, 0.4)' },
  success: { fg: '#27ae60', bg: 'rgba(39, 174, 96, 0.12)',  border: 'rgba(39, 174, 96, 0.4)' },
  great:   { fg: '#f39c12', bg: 'rgba(243, 156, 18, 0.15)', border: 'rgba(243, 156, 18, 0.45)' },
};

const VERDICT_COLORS: Record<NonNullable<LiveRollEvent['verdictType']>, string> = {
  win:  '#27ae60',
  lose: '#e74c3c',
  tie:  '#7f8c8d',
  info: '#3498db',
};

// ── Контекст действия: иконка + подпись ──
const ACTION_CONTEXT_META: Record<NonNullable<LiveRollEvent['actionContext']>, { icon: typeof Swords; label: string; color: string }> = {
  attack:      { icon: Swords,        label: 'Атака',           color: '#e74c3c' },
  defense:     { icon: Shield,        label: 'Защита',          color: '#3498db' },
  check:       { icon: CheckCircle,   label: 'Проверка',        color: '#7f8c8d' },
  overcome:    { icon: TrendingUp,    label: 'Преодоление',     color: '#f39c12' },
  cooperative: { icon: Users,         label: 'Совместные',      color: '#27ae60' },
  mass:        { icon: Dices,         label: 'Массовый бросок', color: '#9b59b6' },
};

// ── Длительности фаз (мс) ────────────────────────────────────
//   short/long — для physics-event'ов (кубики реально кувыркаются на карте).
//   summary    — для post-physics summary-событий (opposed/coop verdict):
//                кубики УЖЕ были брошены в предыдущих event'ах, здесь
//                только показываем финальный результат. Фазы ускорены:
//                enter → verdict почти мгновенно, полоска появляется сразу.
const PHASE_DURATIONS = {
  short:   { enter: 150, drop: 700, dropStagger: 240, tumble: 500,  settle: 300, reveal: 200, verdict: 400, exit: 250 },
  long:    { enter: 150, drop: 700, dropStagger: 240, tumble: 800,  settle: 350, reveal: 250, verdict: 500, exit: 300 },
  summary: { enter: 100, drop:   0, dropStagger:   0, tumble:   0, settle: 150, reveal: 100, verdict: 200, exit: 250 },
};

// ── Scatter seed: случайные позиции/наклоны для каждого кубика ──
// Вычисляется ОДИН раз на событие (useMemo по event.id), чтобы кубики
// не «прыгали» между ререндерами. Каждый кубик получает:
//   x:     случайное смещение по горизонтали (±24px) — «раскатились по столу»
//   tiltX: случайный наклон по оси X (±14°) — «упали криво» (3D)
//   tiltY: случайный наклон по оси Y (±14°) — «завалены вбок» (3D)
//   z:     случайный z-index (1..4) — некоторые кубики перекрывают другие
interface DieScatter { x: number; tiltX: number; tiltY: number; z: number; rotY: number; }

function makeScatter(dieCount: number): DieScatter[] {
  return Array.from({ length: dieCount }, () => ({
    x: Math.round((Math.random() - 0.5) * 48),      // ±24px
    tiltX: Math.round((Math.random() - 0.5) * 28),  // ±14°
    tiltY: Math.round((Math.random() - 0.5) * 28),  // ±14°
    z: Math.floor(Math.random() * 4) + 1,
    rotY: Math.round(Math.random() * 720 + 360),    // 360..1080° during drop
  }));
}

// ── 3D кубики через inline SVG (правильная изометрическая проекция) ──
// После неудач с CSS preserve-3d используем inline SVG с тремя видимыми
// полигонами (top + front-left + front-right). 3D-эффект «зашит» в
// координаты полигонов — не зависит от preserve-3d / overflow / stacking.
//
// ПРОПOPЦИИ (исправлены): правильная изометрия, все видимые рёбра равны.
//   side s = 34px
//   half-width  = s × cos(30°) = 30
//   half-depth  = s × sin(30°) = 17
//   height      = s = 34
//   куб: ширина 60, высота 68, ratio 0.882 ≈ 1/1.155 (isometric gold ratio)
//
// ИНТРИГА: во время drop+tumble кубики НЕЙТРАЛЬНО-СЕРЫЕ без символа —
// игрок не видит результат до момента settle. Только на settle кубик
// «раскрашивается» в свой цвет (+/−/○) и показывает символ.

type DieVariant = 'plus' | 'minus' | 'blank';

const DIE_COLORS: Record<DieVariant, {
  top: string; topLight: string; left: string; right: string; edge: string; symbol: string;
  symbolShadow: boolean;
}> = {
  // Серый "neutral" убран: кубики всегда показывают цвет результата.
  // Во время tumble 3D-кубики кувыркаются (результат скрыт движением).
  plus:  {
    top: '#5fd980', topLight: '#a8f0bf',
    left: '#2a7a3f', right: '#175026',
    edge: '#0a2814', symbol: '#ffffff', symbolShadow: true,
  },
  minus: {
    top: '#ff6b5a', topLight: '#ffb3a6',
    left: '#a82a1c', right: '#651a10',
    edge: '#330a05', symbol: '#ffffff', symbolShadow: true,
  },
  blank: {
    top: '#fbf3d8', topLight: '#ffffff',
    left: '#9a8550', right: '#6b5a34',
    edge: '#33280f', symbol: '#3a4858', symbolShadow: false,
  },
};

function Die3D({ symbol, variant }: { symbol: string; variant: DieVariant }) {
  const c = DIE_COLORS[variant];
  const showSymbol = symbol !== '';
  // Правильная изометрия: side=34, half-width=30, half-depth=17, height=34
  // Точки:
  //   top-back   = (32, 4)
  //   top-right  = (62, 21)
  //   top-front  = (32, 38)
  //   top-left   = (2, 21)
  //   bot-right  = (62, 55)
  //   bot-front  = (32, 72)
  //   bot-left   = (2, 55)
  return (
    <svg
      className="fate-stage-die-svg"
      viewBox="0 0 64 76"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      {/* Front-left face (darkest visible) */}
      <polygon
        points="2,21 32,38 32,72 2,55"
        fill={c.left}
        stroke={c.edge}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* Front-right face (medium-dark) */}
      <polygon
        points="32,38 62,21 62,55 32,72"
        fill={c.right}
        stroke={c.edge}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* Top face (brightest) */}
      <polygon
        points="32,4 62,21 32,38 2,21"
        fill={c.top}
        stroke={c.edge}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* Gloss highlight on top face (smaller rhombus, centered) */}
      <polygon
        points="32,10 50,21 32,32 14,21"
        fill={c.topLight}
        opacity="0.4"
        stroke="none"
      />
      {/* Inner edge highlight (subtle white line along top-face upper edges) */}
      <line
        x1="32" y1="6" x2="60" y2="21"
        stroke="rgba(255,255,255,0.5)"
        strokeWidth="1"
        strokeLinecap="round"
      />
      <line
        x1="32" y1="6" x2="4" y2="21"
        stroke="rgba(255,255,255,0.5)"
        strokeWidth="1"
        strokeLinecap="round"
      />
      {/* Symbol on top face — centroid is (32, 21); text baseline offset to ~26 */}
      {showSymbol && (
        <text
          x="32"
          y="27"
          textAnchor="middle"
          fontSize="20"
          fontWeight="900"
          fontFamily="system-ui, -apple-system, sans-serif"
          fill={c.symbol}
          style={c.symbolShadow ? { filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.6))' } : undefined}
        >
          {symbol}
        </text>
      )}
    </svg>
  );
}

// ── Dice Row: НАСТОЯЩИЙ 3D через Three.js (с SVG-fallback) ────
// Рендерит Dice3DCanvas (Three.js / R3F) с реальной 3D-геометрией:
// BoxGeometry с 6 canvas-текстурами, кувыркание в 3D, контактные тени,
// environment-освещение для пластикового блеска.
//
// Если WebGL недоступен (старый браузер / серверный рендер) — автоматически
// fallback на SVG Die3D (изометрическая проекция).
//
// ИНТРИГА: во время drop+tumble кубики НЕЙТРАЛЬНО-СЕРЫЕ без символа.
// Только на settle+ показываем финальный цвет и символ результата.

function PhysicalDiceRow({
  finalDice,
  tumbleDice,
  phase,
  scatter,
  diceColor,
  symbolColor,
}: {
  finalDice: number[];
  tumbleDice: number[];
  phase: Phase;
  scatter: DieScatter[];
  /** Per-participant dice colors (mass rolls). If absent, Dice3DCanvas reads store. */
  diceColor?: string;
  symbolColor?: string;
}) {
  // Серый "neutral" убран: кубики всегда показывают результат.
  // Во время tumble 3D-кубики кувыркаются — результат скрыт движением.
  const current = finalDice;

  // Время начала текущей фазы — для useFrame-анимаций в Three.js
  const phaseStartTime = useMemo(() => performance.now(), [phase]);

  // Преобразуем DieScatter → DieScatter3D (Three.js-совместимый)
  const scatter3d: DieScatter3D[] = useMemo(
    () => scatter.map((s) => ({
      x: s.x,
      tiltX: s.tiltX,
      tiltY: s.tiltY,
      z: s.z,
      dropDelay: (parseInt(String(s.rotY)) || 0) % 240, // reuse rotY field as delay seed
    })),
    [scatter]
  );

  // Проверка: показывать ли Three.js-канвас (фаза нуждается в 3D)
  // На enter — кубики скрыты, не тратим GPU.
  const show3D = phase !== 'enter';

  // WebGL availability — проверяем ОДИН раз. Если недоступен, показываем
  // SVG fallback (через CSS-класс .fate-stage-dice-row--no-webgl).
  const [webglOk] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      return !!gl;
    } catch {
      return false;
    }
  });

  // SVG fallback (если WebGL недоступен — Dice3DCanvas вернёт null, и этот
  // блок покажется). Используем существующий Die3D SVG-компонент.
  const dieAnimClass =
    phase === 'enter' ? '' :
    phase === 'drop'  ? 'fate-stage-die--dropping' :
    phase === 'tumble' ? 'fate-stage-die--rolling' :
    phase === 'settle' ? 'fate-stage-die--settling' :
    '';

  const rowClassName = `fate-stage-dice-row fate-stage-dice-row--3d${!webglOk ? ' fate-stage-dice-row--no-webgl' : ''}`;

  return (
    <div className={rowClassName}>
      {show3D && webglOk && (
        <div className="fate-stage-dice-3d-canvas">
          <Dice3DCanvas
            finalDice={finalDice}
            tumbleDice={tumbleDice}
            phase={phase as DicePhase}
            scatter={scatter3d}
            startTime={phaseStartTime}
            diceColor={diceColor}
            symbolColor={symbolColor}
          />
        </div>
      )}

      {/* SVG fallback — рендерится только если WebGL недоступен.
          CSS скрывает его по умолчанию; показывается через
          .fate-stage-dice-row--no-webgl класс. */}
      {!webglOk && (
        <div className="fate-stage-dice-svg-fallback" aria-hidden={webglOk}>
          {current.map((d, i) => {
            const variant: DieVariant = d > 0 ? 'plus' : d < 0 ? 'minus' : 'blank';
            const symbol = d > 0 ? '+' : d < 0 ? '−' : '○';
            const delay = i * 80;
            const s = scatter[i] ?? { x: 0, tiltX: 0, tiltY: 0, z: 1, rotY: 720 };
            const keyPhase =
              phase === 'reveal' || phase === 'verdict' || phase === 'hold' || phase === 'exit'
                ? 'settle'
                : phase;
            return (
              <span
                key={`${keyPhase}-${i}`}
                className={`fate-stage-die-wrap ${dieAnimClass}`}
                style={{
                  animationDelay: `${delay}ms`,
                  ['--scatter-x' as string]: `${s.x}px`,
                  ['--tilt-x' as string]: `${s.tiltX}deg`,
                  ['--tilt-y' as string]: `${s.tiltY}deg`,
                  ['--rot-y' as string]: `${s.rotY}deg`,
                  zIndex: s.z,
                } as React.CSSProperties}
              >
                <Die3D symbol={symbol} variant={variant} />
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Чип модификатора (Бой +3 / ситуативный +2 / помощники +1) ──
function ModifierChip({ label, value }: { label: string; value: number }) {
  const sign = value >= 0 ? '+' : '−';
  const absVal = Math.abs(value);
  const isPositive = value > 0;
  const isNegative = value < 0;
  return (
    <span
      className={`fate-stage-modifier${isPositive ? ' fate-stage-modifier--pos' : ''}${isNegative ? ' fate-stage-modifier--neg' : ''}`}
      title={`${label}: ${sign}${absVal}`}
    >
      <span className="fate-stage-modifier__label">{label}</span>
      <span className="fate-stage-modifier__value">{sign}{absVal}</span>
    </span>
  );
}

// ── Под-компонент: один участник ─────────────────────────────
function ParticipantCard({
  participant,
  phase,
  tumbleDice,
  scatter,
  isWinner,
  delayMs = 0,
  hideDice = false,
}: {
  participant: LiveRollParticipant;
  phase: Phase;
  tumbleDice: number[];
  scatter: DieScatter[];
  isWinner: boolean;
  delayMs?: number;
  hideDice?: boolean;
}) {
  // Defensive: RESULT_COLORS indexed by English enum ('fail'|'tie'|'success'|
  // 'great'). If a caller accidentally passes a Russian label or undefined
  // (historically mass-roll-inline did this), fall back to 'fail' so the
  // overlay renders instead of crashing on `colors.fg`.
  const colors = RESULT_COLORS[participant.resultType] ?? RESULT_COLORS.fail;
  const showTotal = phase === 'settle' || phase === 'reveal' || phase === 'verdict' || phase === 'hold' || phase === 'exit';
  const showResultDetails = phase === 'reveal' || phase === 'verdict' || phase === 'hold' || phase === 'exit';
  const isLanded = phase === 'settle' || phase === 'reveal' || phase === 'verdict' || phase === 'hold' || phase === 'exit';
  // Modifiers + skill describe WHAT is being rolled — show them from the
  // start (enter phase) so the user sees context immediately, not just
  // after the dice land. Only the RESULT (total, margin, verdict) is gated.
  const showContext = phase !== 'enter';

  // Format dice sum: e.g. +2, 0, −1
  const diceSumStr = participant.diceSum > 0 ? `+${participant.diceSum}` : `${participant.diceSum}`;

  // Margin label
  const margin = participant.margin;
  let marginLabel: string | null = null;
  if (margin !== null && margin !== undefined && showResultDetails) {
    if (margin > 0) marginLabel = `превышение +${margin}`;
    else if (margin < 0) marginLabel = `дефицит ${margin}`;
    else marginLabel = 'вровень';
  }

  return (
    <div
      className="fate-stage-participant"
      style={{
        animationDelay: `${delayMs}ms`,
        borderColor: isWinner ? '#f1c40f' : colors.border,
        boxShadow: isWinner ? '0 0 24px rgba(241, 196, 15, 0.4)' : 'none',
      }}
    >
      {/* Role badge (top-right) */}
      <div className="fate-stage-participant__role-badge">
        {participant.role === 'roller' && '⚔️'}
        {participant.role === 'opponent' && '🛡️'}
        {participant.role === 'helper' && '🤝'}
        {participant.role === 'attacker' && '⚔️'}
        {participant.role === 'defender' && '🛡️'}
      </div>

      {/* Name + skill line */}
      <div className="fate-stage-participant__header">
        <span className="fate-stage-participant__name">
          {isWinner && <span className="fate-stage-crown">👑</span>}
          {participant.characterName}
        </span>
        {participant.skillName && (
          <span className="fate-stage-participant__skill">
            {participant.skillName}
            {typeof participant.skillValue === 'number' && participant.skillValue !== 0 && (
              <span className="fate-stage-participant__skill-val">
                {' '}{participant.skillValue >= 0 ? '+' : ''}{participant.skillValue}
              </span>
            )}
          </span>
        )}
      </div>

      {/* Modifier chips — breakdown of bonuses. Shown from the start
          (drop phase) because they describe the roll, not the result. */}
      {showContext && participant.modifiers && participant.modifiers.length > 0 && (
        <div className="fate-stage-participant__modifiers">
          {participant.modifiers.map((m, i) => (
            <ModifierChip key={i} label={m.label} value={m.value} />
          ))}
        </div>
      )}

      {/* Dice with physics — скрываются когда hideDice=true
          (для simple/coop кубики рендерятся на уровне карты) */}
      {!hideDice && (
        <div className={`fate-stage-participant__dice${isLanded ? ' fate-stage-participant__dice--landed' : ''}`}>
          <PhysicalDiceRow
            finalDice={participant.dice}
            tumbleDice={tumbleDice}
            phase={phase}
            scatter={scatter}
            diceColor={participant.diceColor}
            symbolColor={participant.symbolColor}
          />
        </div>
      )}

      {/* Dice sum (shown once landed) */}
      {showResultDetails && (
        <div className="fate-stage-participant__dice-sum">
          кубики: <strong>{diceSumStr}</strong>
        </div>
      )}

      {/* Total + ladder label */}
      {showTotal && (
        <div
          className="fate-stage-participant__total"
          style={{ color: colors.fg, animationDelay: `${delayMs + 100}ms` }}
        >
          <span className="fate-stage-participant__total-num">
            {participant.total >= 0 ? '+' : ''}{participant.total}
          </span>
          <span
            className="fate-stage-participant__label"
            style={{ background: colors.bg, color: colors.fg }}
          >
            {participant.resultLabel}
          </span>
        </div>
      )}

      {/* Margin (exceed/deficit) */}
      {marginLabel && (
        <div className={`fate-stage-participant__margin${(margin ?? 0) > 0 ? ' fate-stage-participant__margin--pos' : ''}${(margin ?? 0) < 0 ? ' fate-stage-participant__margin--neg' : ''}`}>
          {marginLabel}
        </div>
      )}

      {/* Damage (mass-damage defenders) */}
      {participant.damage !== undefined && phase !== 'drop' && phase !== 'tumble' && (
        <div className="fate-stage-participant__damage">
          {participant.defenseOutcome === 'blocked' && '🛡️ Блок'}
          {participant.defenseOutcome === 'tie' && '🤝 Ничья'}
          {participant.defenseOutcome === 'damage' && `⚔️ −${participant.damage} стресс`}
        </div>
      )}

      {/* Bonus tags */}
      {(participant.bonusCount || 0) > 0 && phase !== 'drop' && phase !== 'tumble' && (
        <div className="fate-stage-participant__bonus-tag" title="Призыв аспекта">
          ✨ +{participant.bonusCount! * 2}
        </div>
      )}
      {(participant.freeInvokeCount || 0) > 0 && phase !== 'drop' && phase !== 'tumble' && (
        <div className="fate-stage-participant__bonus-tag fate-stage-participant__bonus-tag--free" title="Бесплатный призыв">
          ⭐ +{participant.freeInvokeCount! * 2}
        </div>
      )}
      {participant.rerolled && phase !== 'drop' && phase !== 'tumble' && (
        <div className="fate-stage-participant__bonus-tag fate-stage-participant__bonus-tag--reroll" title="Переброс">
          🔄
        </div>
      )}
    </div>
  );
}

// ── CompactResultStrip — компактная полоска кубов с результатом ──
// ЕДИНСТВЕННОЕ место, где показывается результат броска поверх карты.
// Заменяет старую большую плавающую карточку (fate-stage-floating) с
// 3D-повтором броска. Теперь только полоска: кубы + итог + verdict.
//
// Поддерживает ВСЕ типы бросков:
//   • simple / check — одна строка (кубы + итог + label)
//   • opposed (VS)   — две строки (ролик vs противник) + verdict
//   • cooperative    — ролик + помощники (passive +1, без кубов)
//   • mass           — N строк (каждый участник)
//
// Показывается после settle (кубы приземлились). Висит 2.5с, потом
// auto-dismiss через requestLiveRollExit (return-анимация → dismiss).
function CompactResultStrip({
  event,
  phase,
}: {
  event: LiveRollEvent;
  phase: Phase;
}) {
  // ── SKIP for simple and opposed types ──
  // Пользователь: "Для обычного броска проверки не нужно выводить окно с
  // результатом, эта инфа сразу отображается в логе". И для VS: "в броске VS
  // делать одновременный бросок противников... было бы видно по кубам на
  // столе и результату в логах".
  // Для simple (check) и opposed (VS) — НЕ показываем полоску. Результат
  // виден по кубам на столе (3D физика) + в логе бросков.
  // Для cooperative и mass/mass-damage — ПОКАЗЫВАЕМ (там много участников,
  // по кубам сложно понять итог).
  if (event.type === 'simple' || event.type === 'opposed') {
    return null;
  }

  // Показываем только после settle (кубы приземлились, результат известен)
  // И только когда результат реально готов: для physics-event'ов это
  // означает pendingPhysics === null (физика финализирована, applyResult
  // вызван). Для summary-event'ов (opposed/coop/mass) pendingPhysics
  // всегда null — они создаются уже с готовыми dice.
  const resultReady = !event.pendingPhysics
    && !event.pending2DPhysics
    && (!event.pendingPhysicsSessions || event.pendingPhysicsSessions.length === 0);
  const visible = resultReady && (phase === 'settle' || phase === 'reveal' || phase === 'verdict' || phase === 'hold' || phase === 'exit');
  if (!visible) return null;

  // Собираем «строки» для отображения. Для простого броска — одна строка.
  // Для opposed — две (ролик + противник). Для coop/mass — сколько есть.
  type Row = {
    name: string;
    skillName?: string;
    skillValue?: number;
    dice: number[];
    diceSum: number;
    total: number;
    resultLabel: string;
    resultType: LiveRollParticipant['resultType'];
    role: LiveRollParticipant['role'];
    isWinner: boolean;
  };

  const rows: Row[] = [];
  const isOpposed = event.type === 'opposed';

  if (isOpposed) {
    // VS — ровно две строки: ролик и противник
    const r = event.participants[0];
    if (r) {
      rows.push({
        name: r.characterName,
        skillName: r.skillName,
        skillValue: r.skillValue,
        dice: r.dice,
        diceSum: r.diceSum,
        total: r.total,
        resultLabel: r.resultLabel,
        resultType: r.resultType,
        role: r.role,
        isWinner: (event.verdictType === 'win') === (r.role === 'roller'),
      });
    }
    if (event.opponent) {
      const o = event.opponent;
      rows.push({
        name: o.characterName,
        skillName: o.skillName,
        skillValue: o.skillValue,
        dice: o.dice,
        diceSum: o.diceSum,
        total: o.total,
        resultLabel: o.resultLabel,
        resultType: o.resultType,
        role: o.role,
        isWinner: (event.verdictType === 'win') === (o.role === 'opponent'),
      });
    }
  } else {
    // simple / cooperative / mass — все участники по порядку
    for (const p of event.participants) {
      rows.push({
        name: p.characterName,
        skillName: p.skillName,
        skillValue: p.skillValue,
        dice: p.dice,
        diceSum: p.diceSum,
        total: p.total,
        resultLabel: p.resultLabel,
        resultType: p.resultType,
        role: p.role,
        isWinner: !!p.isWinner,
      });
    }
  }

  // verdict color
  const verdictColor = event.verdictType
    ? VERDICT_COLORS[event.verdictType]
    : '#f8fafc';

  return (
    <div
      className="fate-stage-compact-strip"
      role="status"
      aria-live="polite"
      aria-label={`Результат броска: ${event.verdict ?? rows.map((r) => `${r.name} ${r.total}`).join(', ')}`}
      style={{
        position: 'absolute',
        bottom: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 50,
        pointerEvents: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        alignItems: 'center',
        maxWidth: 'calc(100% - 80px)',
      }}
    >
      {/* Rows */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '5px',
          alignItems: 'stretch',
          padding: '8px 12px',
          background: 'rgba(15, 23, 42, 0.94)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          border: '1px solid rgba(255,255,255,0.10)',
          borderRadius: '10px',
          boxShadow: '0 8px 28px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.04) inset',
          color: '#f8fafc',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          animation: 'fateCompactStripIn 280ms cubic-bezier(0.16, 1, 0.3, 1)',
        }}
      >
        {rows.map((r, idx) => {
          // Defensive fallback — see ParticipantCard for the same guard.
          const colors = RESULT_COLORS[r.resultType] ?? RESULT_COLORS.fail;
          const showVs = isOpposed && idx === 1;
          return (
            <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {showVs && (
                <div style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  gap: 6, fontSize: '9px', fontWeight: 800, letterSpacing: '0.12em',
                  color: 'rgba(255,255,255,0.55)', padding: '2px 0',
                }}>
                  <span style={{ height: 1, flex: 1, maxWidth: 36, background: 'rgba(255,255,255,0.18)' }} />
                  VS
                  <span style={{ height: 1, flex: 1, maxWidth: 36, background: 'rgba(255,255,255,0.18)' }} />
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                {/* Name + skill */}
                <div style={{
                  display: 'flex', flexDirection: 'column', minWidth: 0, flexShrink: 1,
                  maxWidth: 120, gap: 0,
                }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700, color: r.isWinner ? '#f1c40f' : '#f8fafc',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    display: 'flex', alignItems: 'center', gap: 3,
                  }}>
                    {r.isWinner && <span style={{ fontSize: 10 }}>👑</span>}
                    {r.role === 'opponent' && !r.isWinner && <span style={{ opacity: 0.6 }}>🛡</span>}
                    {r.role === 'helper' && <span style={{ opacity: 0.8 }}>🤝</span>}
                    {r.name}
                  </span>
                  {r.skillName && (
                    <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {r.skillName}{typeof r.skillValue === 'number' && r.skillValue !== 0 ? ` ${r.skillValue >= 0 ? '+' : ''}${r.skillValue}` : ''}
                    </span>
                  )}
                </div>

                {/* Dice chips (only if dice were rolled — helpers have empty dice) */}
                {r.dice.length > 0 && (
                  <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                    {r.dice.map((d, i) => {
                      const symbol = d > 0 ? '+' : d < 0 ? '−' : '○';
                      const bg = d > 0 ? '#16a34a' : d < 0 ? '#dc2626' : '#475569';
                      return (
                        <div
                          key={i}
                          style={{
                            width: '20px',
                            height: '20px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            background: bg,
                            borderRadius: '4px',
                            fontSize: '13px',
                            fontWeight: 800,
                            color: '#fff',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.10) inset',
                            lineHeight: 1,
                            fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                          }}
                        >
                          {symbol}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Helper passive bonus badge */}
                {r.dice.length === 0 && r.role === 'helper' && (
                  <span style={{
                    fontSize: '9px', fontWeight: 700, padding: '2px 6px',
                    background: 'rgba(39,174,96,0.18)', color: '#27ae60',
                    borderRadius: '4px', border: '1px solid rgba(39,174,96,0.35)',
                  }}>
                    +1 помощь
                  </span>
                )}

                {/* Total */}
                <span style={{
                  fontSize: '18px', fontWeight: 900, color: colors.fg, lineHeight: 1,
                  fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
                  minWidth: 32, textAlign: 'right', flexShrink: 0,
                }}>
                  {r.total >= 0 ? `+${r.total}` : r.total}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Verdict — отдельный бейдж под полоской */}
      {event.verdict && (
        <div
          style={{
            padding: '5px 14px',
            background: 'rgba(15, 23, 42, 0.94)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: `1px solid ${verdictColor}55`,
            borderRadius: '8px',
            color: verdictColor,
            fontSize: '12px',
            fontWeight: 800,
            letterSpacing: '0.02em',
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
            animation: 'fateCompactStripIn 280ms 80ms cubic-bezier(0.16, 1, 0.3, 1) backwards',
            fontFamily: 'ui-sans-serif, system-ui, sans-serif',
          }}
        >
          {event.verdict}
        </div>
      )}

      <style jsx>{`
        @keyframes fateCompactStripIn {
          from {
            opacity: 0;
            transform: translateY(14px) scale(0.96);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
      `}</style>
    </div>
  );
}

// ── Палитра обводки рёбер для меток участников ────────────────
// РЕПЛИКА `DICE_OUTLINE_COLORS` из `dice-3d-physics-canvas.tsx` (строка ~75).
// Дублирована здесь, а не импортирована, чтобы НЕ тянуть Three.js-бандл в
// основной чанк оверлея: ServerDiceStage/Dice3DCanvas грузятся динамически
// через next/dynamic (ssr:false), а любой статический импорт значения из
// dice-3d-physics-canvas.tsx утянул бы весь R3F/THREE в main chunk.
// ЕСЛИ палитра меняется в dice-3d-physics-canvas.tsx — ОБЯЗАТЕЛЬНО обновить
// и здесь (и наоборот). Цвета: slot 0 = ролик (зелёный), 1 = оппонент
// (розовый), 2 = третий участник (оранжевый), 3 = четвёртый (бирюзовый).
const SLOT_LABEL_COLORS: string[] = [
  '#9eff5e',  // slot 0 — ролик (зелёный)
  '#ff4d6d',  // slot 1 — оппонент (розово-красный)
  '#ff8c42',  // slot 2 — третий участник (оранжевый)
  '#00d4d4',  // slot 3 — четвёртый (бирюзовый)
];

function slotColor(slot: number): string {
  return SLOT_LABEL_COLORS[slot % SLOT_LABEL_COLORS.length] ?? '#f8fafc';
}

// ── Position calculation for a session label ──────────────────
// Maps a physics session's (originSide, originX) → screen percentage
// relative to the `.fate-stage-overlay` (which covers the whole map area).
//
//   • near = spawn со стороны игрока (нижний край арены) → top: 75%
//   • far  = spawn с противоположной стороны (верхний край)  → top: 20%
//   • originX → горизонтальная позиция: 0 = центр, ±1.2 → ~32/68 %,
//     ±1.6 → ~26/74 %. Зажат в [15 %, 85 %] чтобы метки не вылезали за край.
//
// СПЕЦ-СЛУЧАЙ — VS mode (opposed, 2 sessions, оба originX undefined →
// обе сессии в физике стартуют при x=0). Метка ролика — снизу по центру,
// метка оппонента — сверху по центру. Вертикальное разделение достаточно,
// горизонтальное смещение не нужно.
function getSlotScreenPosition(
  sessionIdx: number,
  totalSessions: number,
  originX?: number,
  originSide?: 'near' | 'far',
): { leftPct: number; topPct: number } {
  const side: 'near' | 'far' = originSide ?? 'near';
  const topPct = side === 'far' ? 20 : 75;

  // VS mode: 2 sessions, оба originX undefined → both at x=0 in physics.
  // Центрируем по горизонтали; вертикальное разделение (near vs far)
  // достаточно, чтобы метки не накладывались друг на друга.
  if (totalSessions === 2 && originX === undefined) {
    return { leftPct: 50, topPct };
  }

  // Mass mode (N≥3): используем originX для горизонтального смещения.
  // arenaHalfW по умолчанию = 4. Типичные значения originX: ±1.2, ±1.6.
  // Маппинг [-2, +2] → [20 %, 80 %] с зажимом в [15 %, 85 %].
  const x = originX ?? 0;
  const raw = 50 + (x / 2) * 30;
  const leftPct = Math.max(15, Math.min(85, raw));
  return { leftPct, topPct };
}

// ── MassSessionLabels — HTML-метки с именами участников поверх 3D-сцены ──
// Показывается ТОЛЬКО для multi-session бросков (pendingPhysicsSessions.length
// >= 2): VS (opposed, 2 сессии) и Mass (3+ сессий). Для single-session
// бросков (pendingPhysics only) метка не нужна — участник и так очевиден.
//
// Метки — чистый HTML-overlay (pointer-events: none): НЕ трогают 3D-канвас,
// НЕ перехватывают клики мышью (карта остаётся интерактивной), НЕ влияют на
// фазовую машину и тайминги auto-dismiss. Просто визуальные «тэги» с цветной
// точкой, привязанной к слоту участника (совпадает с цветом обводки рёбер
// кубиков того же слота → пользователь сразу видит «эти кубики — этого персонажа»).
//
// ПОЗИЦИОНИРОВАНИЕ: одна метка на сессию, координаты считаются через
// getSlotScreenPosition (near→низ, far→верх, originX→горизонталь). Метка
// центрирована по своей точке через translate(-50%, -50%).
function MassSessionLabels({
  event,
  phase,
}: {
  event: LiveRollEvent;
  phase: Phase;
}) {
  const sessions = event.pendingPhysicsSessions;
  if (!sessions || sessions.length < 2) return null;

  // Показываем только в фазах, когда кубики ВИДНЫ на столе: drop (кубики
  // падают) → hold (кубики лежат). На enter (кубиков ещё нет) и exit
  // (кубики улетают в кейс) — скрываем, чтобы не было «висящих» меток без
  // кубиков. 'verdict' включён — в этой фазе кубики всё ещё на столе, а
  // CompactResultStrip уже показывает результат.
  if (phase === 'enter' || phase === 'exit') return null;

  const total = sessions.length;

  return (
    <div
      className="fate-stage-session-labels"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        zIndex: 40, // ниже CompactResultStrip (z=50) — стрип результата важнее
      }}
    >
      {sessions.map((sess, idx) => {
        const participant = event.participants[idx];
        if (!participant) return null;
        const color = slotColor(idx);
        const { leftPct, topPct } = getSlotScreenPosition(
          idx,
          total,
          sess.originX,
          sess.originSide,
        );
        return (
          <div
            key={sess.participantId}
            style={{
              position: 'absolute',
              left: `${leftPct}%`,
              top: `${topPct}%`,
              // Статический transform совпадает с финальным кадром анимации
              // (translate(-50%, -50%) scale(1)) — после окончания анимации
              // позиция остаётся стабильной, без скачка.
              transform: 'translate(-50%, -50%)',
              display: 'flex',
              flexDirection: 'column',
              gap: 0,
              maxWidth: '120px',
              padding: '4px 8px',
              background: 'rgba(15, 23, 42, 0.85)',
              backdropFilter: 'blur(6px)',
              WebkitBackdropFilter: 'blur(6px)',
              // `${color}99` → 60 % alpha (0x99 ≈ 60 %)
              border: `1px solid ${color}99`,
              borderRadius: '6px',
              boxShadow: `0 4px 12px rgba(0,0,0,0.45), 0 0 8px ${color}33`,
              color: '#ffffff',
              fontFamily: 'ui-sans-serif, system-ui, sans-serif',
              pointerEvents: 'none',
              animation: 'fateLabelFadeIn 200ms ease-out',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  flexShrink: 0,
                  borderRadius: '50%',
                  background: color,
                  boxShadow: `0 0 6px ${color}AA`,
                }}
              />
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  lineHeight: 1.2,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  minWidth: 0,
                }}
              >
                {participant.characterName}
              </span>
            </div>
            {participant.skillName && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 400,
                  lineHeight: 1.2,
                  color: 'rgba(255,255,255,0.65)',
                  // Выравниваем под именем: 8 px (точка) + 6 px (gap) = 14 px
                  marginLeft: 14,
                  marginTop: 1,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {participant.skillName}
                {typeof participant.skillValue === 'number' && participant.skillValue !== 0
                  ? ` ${participant.skillValue >= 0 ? '+' : ''}${participant.skillValue}`
                  : ''}
              </span>
            )}
          </div>
        );
      })}
      <style jsx>{`
        @keyframes fateLabelFadeIn {
          from {
            opacity: 0;
            transform: translate(-50%, -50%) scale(0.92);
          }
          to {
            opacity: 1;
            transform: translate(-50%, -50%) scale(1);
          }
        }
      `}</style>
    </div>
  );
}

// ── Inner component — assumes event is non-null ──────────────
function RollStageOverlayInner({
  event,
  durationMs,
  onDismiss,
  onRequestExit,
  exiting,
  viewport,
  arenaHalfW,
  arenaHalfH,
  mapImageSize,
}: {
  event: LiveRollEvent;
  durationMs: number;
  onDismiss: () => void;
  onRequestExit: () => void;
  exiting: boolean;
  viewport: { panX: number; panY: number; zoom: number };
  arenaHalfW?: number;
  arenaHalfH?: number;
  mapImageSize?: { w: number; h: number } | null;
}) {
  const [phase, setPhase] = useState<Phase>('enter');
  const [tumbleDice, setTumbleDice] = useState<number[]>([0, 0, 0, 0]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const startRef = useRef<number>(0);
  // Если event хотя бы раз имел pendingPhysics ИЛИ pendingPhysicsSessions —
  // оставляем ServerDiceStage смонтированным даже после applyResult (кубики
  // остаются замершими на столе, overlay показывает verdict).
  const [serverPhysicsActive, setServerPhysicsActive] = useState(
    !!event.pendingPhysics || !!event.pending2DPhysics || !!(event.pendingPhysicsSessions && event.pendingPhysicsSessions.length > 0)
  );
  useEffect(() => {
    if (event.pendingPhysics) setServerPhysicsActive(true);
    if (event.pending2DPhysics) setServerPhysicsActive(true);
    if (event.pendingPhysicsSessions && event.pendingPhysicsSessions.length > 0) setServerPhysicsActive(true);
  }, [event.pendingPhysics, event.pending2DPhysics, event.pendingPhysicsSessions]);

  // Scatter seed — computed ONCE per event (stable across re-renders).
  // 4 dice for the roller + each opponent/helper gets their own scatter.
  const rollerScatter = useMemo(() => makeScatter(4), [event.id]);
  const opponentScatter = useMemo(
    () => (event.opponent ? makeScatter(4) : []),
    [event.id, event.opponent]
  );
  const helperScatters = useMemo(() => {
    return event.participants
      .filter((p) => p.role === 'helper')
      .map(() => makeScatter(4));
  }, [event.id, event.participants]);

  // Sorted copy for mass: highest first (computed once per event).
  const sortedParticipants = useMemo(() => {
    if (event.type !== 'mass' && event.type !== 'mass-damage') return event.participants;
    return [...event.participants].sort((a, b) => b.total - a.total);
  }, [event]);

  const clearTimers = () => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  };

  // Phase machine — анимация броска (enter → drop → tumble → settle → reveal → verdict → hold).
  // Для physics-event'ов (pendingPhysics или pendingPhysicsSessions) — normal/long durations
  //   (кубики реально кувыркаются, нужно время на drop+tumble).
  // Для summary-event'ов (!pendingPhysics && !pendingPhysicsSessions) — summary durations
  //   (кубики УЖЕ были брошены, сразу показываем результатную полоску).
  // Auto-dismiss: после verdict/hold запускается таймер 2.5с (см. ниже).
  useEffect(() => {
    startRef.current = performance.now();
    const hasPhysics = !!event.pendingPhysics
      || !!event.pending2DPhysics
      || !!(event.pendingPhysicsSessions && event.pendingPhysicsSessions.length > 0);
    const isSummary = !hasPhysics && event.type !== 'simple';
    const d = isSummary
      ? PHASE_DURATIONS.summary
      : (event.type !== 'simple' ? PHASE_DURATIONS.long : PHASE_DURATIONS.short);
    const participantCount = Math.max(1, event.participants.length);
    const massStagger = (event.type === 'mass' || event.type === 'mass-damage')
      ? Math.max(0, participantCount - 1) * 600
      : 0;

    const tEnter      = d.enter;
    const tDropEnd    = tEnter + d.drop + d.dropStagger;
    const tTumbleEnd  = tDropEnd + d.tumble + massStagger;
    const tSettleEnd  = tTumbleEnd + d.settle;
    const tRevealEnd  = tSettleEnd + d.reveal;
    const tVerdictEnd = tRevealEnd + (event.verdict ? d.verdict : 0);

    timersRef.current.push(setTimeout(() => setPhase('drop'),     tEnter));
    timersRef.current.push(setTimeout(() => setPhase('tumble'),   tDropEnd));
    timersRef.current.push(setTimeout(() => setPhase('settle'),   tTumbleEnd));
    timersRef.current.push(setTimeout(() => setPhase('reveal'),   tSettleEnd));
    if (event.verdict) {
      timersRef.current.push(setTimeout(() => setPhase('verdict'), tRevealEnd));
    }
    timersRef.current.push(setTimeout(() => setPhase('hold'),     tVerdictEnd));

    return () => { clearTimers(); };
    // ВАЖНО: зависимость event.id (НЕ event). Когда applyResult модифицирует
    // event (pendingPhysics → null), объект event меняется, но event.id — НЕТ.
    // Если зависиться от event, эффект перезапустится → clearTimers() + новая
    // серия setTimeout → фаза скидывается до 'drop', auto-dismiss таймер
    // сбрасывается → кубики то появляются, то пропадают, оверлей живёт дольше
    // нужного. С event.id фаза-машина запускается ОДИН РАЗ на бросок.
  }, [event.id, durationMs, serverPhysicsActive]);

  // Graceful exit watcher: когда store получает requestLiveRollExit
  // (клик по кейсу / Esc), exiting=true → играем return-фазу ('exit'),
  // через 450мс (длительность return-анимации) вызываем onDismiss.
  useEffect(() => {
    if (!exiting) return;
    setPhase('exit');
    const id = setTimeout(() => onDismiss(), 470);
    return () => clearTimeout(id);
  }, [exiting, onDismiss]);

  // Safety auto-dismiss: если игрок ушёл и не закрыл бросок,
  // кубики убираются через 12с (результат уже в логе).
  // Это safety-net — основной auto-dismiss ниже срабатывает раньше.
  useEffect(() => {
    const id = setTimeout(() => onDismiss(), 12000);
    return () => clearTimeout(id);
  }, [onDismiss, event.id]);

  // ── Auto-dismiss после показа результата ──
  // Когда результат готов (pendingPhysics === null И pendingPhysicsSessions
  // пуст/неактивен) И фаза дошла до 'verdict' или 'hold' — запускаем таймер.
  // По истечении вызываем requestLiveRollExit (return-анимация → dismiss).
  //
  // Кубики ПОЛЕЖАТ на столе подольше — пользователь успеет увидеть результат
  // на самих кубах (а не только в полоске/логе). Раньше было 1.8с/2.5с —
  // слишком быстро, кубы пропадали "мгновенно". Теперь:
  //   • simple (Проверка) — 5.0с: кубы полежат, результат видно на гранях
  //   • opposed (VS) — 4.5с: хватает чтобы сравнить два броска
  //   • cooperative/mass — 4.5с: полоска с результатом читается
  useEffect(() => {
    const hasPending = !!event.pendingPhysics
      || !!event.pending2DPhysics
      || !!(event.pendingPhysicsSessions && event.pendingPhysicsSessions.length > 0);
    if (hasPending) return;            // физика ещё не финализирована
    if (phase !== 'verdict' && phase !== 'hold') return;  // результат ещё не показан
    const dismissMs = (event.type === 'simple') ? 5000
                    : (event.type === 'opposed') ? 4500
                    : 4500;
    const id = setTimeout(() => {
      onRequestExit();
    }, dismissMs);
    return () => clearTimeout(id);
  }, [event.pendingPhysics, event.pending2DPhysics, event.pendingPhysicsSessions, event.type, phase, onRequestExit]);

  // Esc → graceful exit (return-анимация). Space/Enter → тоже graceful.
  // (Раньше был immediate onDismiss — теперь красиво возвращаем кубы в кейс.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        onRequestExit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onRequestExit]);

  // Tumbling dice
  useEffect(() => {
    if (phase !== 'drop' && phase !== 'tumble') return;
    const id = setInterval(() => {
      setTumbleDice(Array.from({ length: 4 }, () => Math.floor(Math.random() * 3) - 1));
    }, 80);
    return () => clearInterval(id);
  }, [phase]);

  const isMassLike = event.type === 'mass' || event.type === 'mass-damage';
  const isOpposed = event.type === 'opposed';
  const isSimpleLike = event.type === 'simple' || event.type === 'cooperative';
  const queueLength = useFateStore((s) => s.liveRollQueue.length);

  // Action context meta
  const ctx = event.actionContext ? ACTION_CONTEXT_META[event.actionContext] : null;
  const CtxIcon = ctx?.icon;

  // Для simple/coop/opposed/mass: кубики рендерятся на уровне карты
  // (ServerDiceStage поверх всей области карты). Раньше mass исключался
  // (считалось, что он использует summary events), но теперь mass-броски
  // тоже запускают реальную физику через pendingPhysicsSessions —
  // ServerDiceStage должен монтироваться, иначе видны только метки зон
  // без кубиков. serverPhysicsActive гарантирует, что мы рендерим Stage
  // только когда есть активная physics-сессия (не для summary events).
  //
  // event.isSummary — события-итоги (например «Записать в лог» в массовой
  // атаке). Кубики УЖЕ были брошены и показаны в предыдущих physics-event'ах;
  // повторно анимировать их не нужно. Показываем только CompactResultStrip.
  const diceOnMap = !event.isSummary
    && (isSimpleLike || isOpposed || isMassLike)
    && !!event.participants[0];

  // Время начала текущей фазы — для useFrame-анимаций в Three.js
  const phaseStartTime = useMemo(() => performance.now(), [phase]);

  // Преобразуем rollerScatter (DieScatter[]) → DieScatter3D[] для канваса
  const rollerScatter3d: DieScatter3D[] = useMemo(
    () => rollerScatter.map((s) => ({
      x: s.x,
      tiltX: s.tiltX,
      tiltY: s.tiltY,
      z: s.z,
      dropDelay: (parseInt(String(s.rotY)) || 0) % 240,
    })),
    [rollerScatter]
  );

  return (
    <div
      className={`fate-stage-overlay fate-stage-overlay--map fate-stage-overlay--${phase}`}
      role="dialog"
      aria-modal="false"
      aria-label={`Бросок: ${event.title || event.participants[0]?.characterName || ''}`}
    >
      {/* ── Кубики на карте (3D-канвас, pointer-events: none) ──
          Канвас покрывает всю область карты; кубики вылетают из кейса
          (левый нижний угол), кувыркаются и приземляются на карту.

          ВЕТВЛЕНИЕ:
            • event.pendingPhysics — сервер-авторитативная физика (Rapier3D):
              кубики кувыркаются по реальным законам физики, результат
              читается с верхней грани. Никакой подмены текстур.
            • Иначе (summary event) — кубики НЕ показываются на карте.
              Они уже были брошены в предыдущих physics-event'ах. Здесь
              только CompactResultStrip с финальным сравнением. */}
      {diceOnMap && serverPhysicsActive && (
        event.pending2DPhysics ? (
          <ServerDiceStage2D
            event={event}
            viewport={viewport}
            arenaHalfW={arenaHalfW}
            arenaHalfH={arenaHalfH}
            mapImageSize={mapImageSize}
          />
        ) : (
          <ServerDiceStage
            event={event}
            viewport={viewport}
            arenaHalfW={arenaHalfW}
            arenaHalfH={arenaHalfH}
            mapImageSize={mapImageSize}
          />
        )
      )}
      {/* ── СТАРАЯ клиентская Dice3DCanvas анимация УБРАНА ──
          Раньше здесь рендерился `<Dice3DCanvas>` для summary-событий
          (когда serverPhysicsActive === false). Это вызывало «вылет больших
          кубиков из кейса» после совместных/противостоящих бросков —
          кубики УЖЕ были брошены через physics-service (порт 3006, LOCKED),
          а старая анимация проигрывала ПОВТОРНО, создавая визуальный шум.

          По запросу пользователя: убрать старую анимацию. Теперь для
          summary-событий показывается ТОЛЬКО CompactResultStrip (ниже),
          который отображает финальный результат без повторного броска.

          serverPhysicsActive === false означает:
            • verdict-фаза opposed/cooperative броска (результат уже посчитан)
            • mass summary (все участники бросили)
            • 2D-режим (canUsePhysics === false, кубики бросаются через Math.random)
          Во всех этих случаях повторная анимация не нужна. */}

      {/* ── HTML-метки с именами участников (поверх 3D-сцены) ──
          Показываются ТОЛЬКО для multi-session бросков (VS = 2, mass = 3+):
          одна метка на сессию с цветной точкой, привязанной к слоту.
          Чистый HTML-overlay (pointer-events: none) — не трогает 3D-канвас,
          не перехватывает клики. Позиция считается из originSide/originX
          сессии (near→низ, far→верх, originX→горизонталь). */}
      <MassSessionLabels event={event} phase={phase} />

      {/* ── Compact Result Strip — единственное место результата ──
          Показывается после settle (кубы приземлились). Для ВСЕХ типов
          бросков: simple / opposed / cooperative / mass.
          Заменяет старую большую плавающую карточку с 3D-повтором. */}
      <CompactResultStrip event={event} phase={phase} />

      {/* ── Tiny close button (top-right) — единственный видимый UI ──
          Во время броска НЕТ большой карточки — только 3D кубы на карте
          и компактная полоска снизу. Маленькая кнопка ✕ позволяет
          немедленно закрыть overlay (skip). Esc / Space / Enter — тоже. */}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Закрыть сцену броска"
        title="Esc — пропустить"
        style={{
          position: 'absolute',
          top: '10px',
          right: '10px',
          zIndex: 60,
          width: '28px',
          height: '28px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(15, 23, 42, 0.85)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '8px',
          color: 'rgba(255,255,255,0.85)',
          cursor: 'pointer',
          transition: 'all 0.15s ease',
          padding: 0,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(231, 76, 60, 0.85)';
          e.currentTarget.style.borderColor = 'rgba(231, 76, 60, 0.6)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(15, 23, 42, 0.85)';
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
        }}
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ── Главный компонент ────────────────────────────────────────
export function RollStageOverlay({
  viewport,
  arenaHalfW,
  arenaHalfH,
  mapImageSize,
}: {
  viewport: { panX: number; panY: number; zoom: number };
  // Половины сторон прямоугольной арены (в физ. единицах) — вычисляются из
  // naturalWidth/naturalHeight фонового изображения карты в MapPanel.
  // Передаются в ServerDiceStage → physics-service (стены на ±arenaHalfW/H)
  // и Dice3DPhysicsCanvas (визуальные бортики + позиционирование канваса).
  arenaHalfW?: number;
  arenaHalfH?: number;
  // Размер фонового изображения (naturalWidth × naturalHeight) — нужен для
  // позиционирования 3D-канваса поверх видимой области карты (бортики
  // выравниваются по краям изображения).
  mapImageSize?: { w: number; h: number } | null;
}) {
  const event = useFateStore((s) => s.liveRollStage);
  const dismiss = useFateStore((s) => s.dismissLiveRoll);
  const requestExit = useFateStore((s) => s.requestLiveRollExit);
  const exiting = useFateStore((s) => s.liveRollExiting);
  const durationMs = useFateStore((s) => s.theatricalDurationMs);

  // ── Очистка shared buffer когда оверлей закрыт ──────────────────────
  // Когда liveRollStage становится null (auto-dismiss / ручной dismiss /
  // Esc), оверлей размонтируется. Кубы на карте (из shared buffer) должны
  // исчезнуть — иначе они остаются висеть на карте после закрытия оверлея,
  // и игрок может «схватить кубы из пустого кейса» (drag из DiceStation),
  // что вызывает дублирование 8 кубов (4 ghost + 4 held).
  //
  // Очистка buffer → DiceCanvasHost рендерит пустой buffer → кубы исчезают.
  // clearSharedDiceBuffer также вызывает cancelHeldBridge() — если bridge
  // mode был активен (маловероятно в этот момент), он завершается.
  //
  // Также очищаем returnState (3D) и return2DState (2D) — defensive cleanup.
  // Если ghost-анимация возврата в кейс была активна в момент закрытия оверлея
  // (маловероятно, но возможно при rapid dismiss), её state остался бы в bus.
  // При следующем броске triggerReturnToCase перезаписал бы его, но между
  // бросками DieMesh мог бы рендерить stale ghost-кубы. Явная очистка здесь
  // гарантирует чистое состояние.
  //
  // НЕ очищаем при переходе между событиями в очереди (event → another event):
  // в этом случае event не null, эффект не срабатывает. Новый ServerDiceStage
  // сам вызовет triggerReturnToCase + clearSharedDiceBuffer для нового броска.
  useEffect(() => {
    if (!event) {
      clearSharedDiceBuffer();
      clearShared2DDiceBuffer();
      clearReturnState();
      clearReturn2DState();
    }
  }, [event]);

  if (!event) return null;

  return (
    <RollStageOverlayInner
      key={event.id}
      event={event}
      durationMs={durationMs}
      onDismiss={dismiss}
      onRequestExit={requestExit}
      exiting={exiting}
      viewport={viewport}
      arenaHalfW={arenaHalfW}
      arenaHalfH={arenaHalfH}
      mapImageSize={mapImageSize}
    />
  );
}
