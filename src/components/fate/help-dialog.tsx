'use client';

import { HelpCircle } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface HelpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Keyboard Shortcuts Data ────────────────────────────────
interface ShortcutEntry {
  key: string;
  description: string;
}

const SHORTCUTS: ShortcutEntry[] = [
  { key: '⌘K', description: 'Командная палитра — глобальный поиск' },
  { key: 'Q', description: 'Быстрый бросок' },
  { key: 'N', description: 'Журнал мастера' },
  { key: 'R', description: 'Случайные таблицы' },
  { key: 'G', description: 'Генератор NPC' },
  { key: 'L', description: 'Библиотека персонажей' },
  { key: 'I', description: 'Инвентарь' },
  { key: 'S', description: 'Управление сценами' },
  { key: 'A', description: 'Управление приключениями' },
  { key: 'D', description: 'Обзор приключения' },
  { key: 'M', description: 'Массовый бросок' },
  { key: ',', description: 'Настройки' },
  { key: 'T', description: 'Переключить тему' },
  { key: 'H', description: 'Открыть справку' },
  { key: 'Esc', description: 'Закрыть диалог' },
];

// ── Fate Ladder Data ───────────────────────────────────────
type LadderTier = 'legendary' | 'great' | 'average' | 'poor' | 'terrible';

interface LadderEntry {
  value: string;
  label: string;
  english: string;
  description: string;
  tier: LadderTier;
}

const LADDER: LadderEntry[] = [
  {
    value: '+8',
    label: 'Легендарный',
    english: 'Legendary',
    description: 'Совершенство, превосхождение обычного',
    tier: 'legendary',
  },
  {
    value: '+7',
    label: 'Эпический',
    english: 'Epic',
    description: 'Героический масштаб',
    tier: 'legendary',
  },
  {
    value: '+6',
    label: 'Фантастический',
    english: 'Fantastic',
    description: 'Выдающееся достижение',
    tier: 'legendary',
  },
  {
    value: '+5',
    label: 'Сверхъестественный',
    english: 'Superb',
    description: 'Редкое мастерство',
    tier: 'great',
  },
  {
    value: '+4',
    label: 'Великий',
    english: 'Great',
    description: 'Экспертный уровень',
    tier: 'great',
  },
  {
    value: '+3',
    label: 'Хороший',
    english: 'Good',
    description: 'Профессиональный уровень',
    tier: 'great',
  },
  {
    value: '+2',
    label: 'Умеренный',
    english: 'Fair',
    description: 'Компетентный уровень',
    tier: 'average',
  },
  {
    value: '+1',
    label: 'Средний',
    english: 'Average',
    description: 'Обычный уровень',
    tier: 'average',
  },
  {
    value: '+0',
    label: 'Посредственный',
    english: 'Mediocre',
    description: 'Базовый уровень',
    tier: 'average',
  },
  {
    value: '-1',
    label: 'Слабый',
    english: 'Poor',
    description: 'Ниже среднего',
    tier: 'poor',
  },
  {
    value: '-2',
    label: 'Ужасный',
    english: 'Terrible',
    description: 'Новичок',
    tier: 'poor',
  },
  {
    value: '-3',
    label: 'Катастрофический',
    english: 'Catastrophic',
    description: 'Полная неудача',
    tier: 'terrible',
  },
  {
    value: '-4',
    label: 'Кошмарный',
    english: 'Nightmarish',
    description: 'Катастрофа',
    tier: 'terrible',
  },
];

const LADDER_TIER_STYLES: Record<LadderTier, { bg: string; text: string; border: string }> = {
  legendary: {
    bg: 'rgba(39, 174, 96, 0.14)',
    text: '#1e8449',
    border: 'rgba(39, 174, 96, 0.45)',
  },
  great: {
    bg: 'rgba(243, 156, 18, 0.14)',
    text: '#b9770e',
    border: 'rgba(243, 156, 18, 0.45)',
  },
  average: {
    bg: 'rgba(127, 140, 141, 0.14)',
    text: '#566573',
    border: 'rgba(127, 140, 141, 0.4)',
  },
  poor: {
    bg: 'rgba(231, 76, 60, 0.14)',
    text: '#c0392b',
    border: 'rgba(231, 76, 60, 0.4)',
  },
  terrible: {
    bg: 'rgba(120, 40, 40, 0.22)',
    text: '#922b21',
    border: 'rgba(120, 40, 40, 0.55)',
  },
};

// ── Kbd element styled as a physical key ───────────────────
function KbdKey({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      className="inline-flex items-center justify-center min-w-[1.9rem] px-2 py-0.5 rounded-md font-mono text-xs font-semibold shadow-sm border transition-colors"
      style={{
        background: 'var(--fate-bg-card)',
        borderColor: 'var(--fate-border)',
        color: 'var(--fate-text)',
        boxShadow: '0 1px 0 var(--fate-border), inset 0 -1px 0 rgba(0,0,0,0.06)',
      }}
    >
      {children}
    </kbd>
  );
}

export function HelpDialog({ open, onOpenChange }: HelpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <HelpCircle className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Справка и горячие клавиши
          </DialogTitle>
          <DialogDescription>
            Список горячих клавиш, инструменты карты и лестница навыков Fate RPG
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="shortcuts" className="w-full">
          <TabsList className="w-full rounded-lg">
            <TabsTrigger
              value="shortcuts"
              className="flex-1 text-xs rounded-md transition-all duration-200"
            >
              ⌨️ Горячие клавиши
            </TabsTrigger>
            <TabsTrigger
              value="ladder"
              className="flex-1 text-xs rounded-md transition-all duration-200"
            >
              📊 Лестница Fate
            </TabsTrigger>
            <TabsTrigger
              value="tools"
              className="flex-1 text-xs rounded-md transition-all duration-200"
            >
              🛠️ Инструменты карты
            </TabsTrigger>
          </TabsList>

          {/* ── Shortcuts Tab ──────────────────────────────────── */}
          <TabsContent value="shortcuts" className="space-y-3">
            <div
              className="fate-card-static rounded-xl overflow-hidden"
              style={{ backgroundColor: 'var(--fate-bg-card)' }}
            >
              <div
                className="fate-section-header px-4 py-2.5"
                style={{
                  borderColor: 'var(--fate-border)',
                }}
              >
                <h4
                  className="text-sm font-semibold flex items-center gap-1.5"
                  style={{ color: 'var(--fate-text)' }}
                >
                  ⌨️ Быстрый доступ
                </h4>
              </div>

              <div
                className="max-h-[70vh] overflow-y-auto fate-scroll"
                role="table"
                aria-label="Горячие клавиши"
              >
                <div
                  className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 px-4 py-3"
                  style={{ color: 'var(--fate-text)' }}
                >
                  {SHORTCUTS.map((s, idx) => (
                    <div
                      key={s.key}
                      className="contents"
                    >
                      <div
                        className={`flex items-center justify-end py-1.5 ${idx % 2 === 0 ? 'fate-row-even' : 'fate-row-odd'}`}
                        style={{ borderRadius: '0.375rem' }}
                      >
                        <KbdKey>{s.key}</KbdKey>
                      </div>
                      <div
                        className={`flex items-center px-3 py-1.5 text-sm ${idx % 2 === 0 ? 'fate-row-even' : 'fate-row-odd'}`}
                        style={{ borderRadius: '0.375rem', color: 'var(--fate-text)' }}
                      >
                        {s.description}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <p
              className="text-xs leading-relaxed px-1"
              style={{ color: 'var(--fate-text-muted)' }}
            >
              💡 Подсказка: горячие клавиши не срабатывают, когда фокус находится в поле ввода
              или открыт любой диалог.
            </p>
          </TabsContent>

          {/* ── Map Tools Tab ──────────────────────────────────── */}
          <TabsContent value="tools" className="space-y-3">
            <div
              className="fate-card-static rounded-xl overflow-hidden"
              style={{ backgroundColor: 'var(--fate-bg-card)' }}
            >
              <div
                className="fate-section-header px-4 py-2.5"
                style={{ borderColor: 'var(--fate-border)' }}
              >
                <h4
                  className="text-sm font-semibold flex items-center gap-1.5"
                  style={{ color: 'var(--fate-text)' }}
                >
                  🛠️ Инструменты карты
                </h4>
              </div>
              <div className="px-4 py-3 space-y-3 text-sm" style={{ color: 'var(--fate-text)' }}>
                {/* Tool: Zone (polygon) */}
                <div
                  className="rounded-lg p-3"
                  style={{ backgroundColor: 'rgba(230, 126, 34, 0.06)', border: '1px solid rgba(230, 126, 34, 0.2)' }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-base">◆</span>
                    <span className="font-semibold" style={{ color: 'var(--fate-accent)' }}>Зона (полигон)</span>
                  </div>
                  <p className="text-xs leading-relaxed mb-2" style={{ color: 'var(--fate-text-muted)' }}>
                    Создавайте зоны любой формы — треугольники, ромбы, многоугольники.
                    Зона сохраняется на текущем этаже сцены.
                  </p>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <KbdKey>Клик</KbdKey>
                    <span style={{ color: 'var(--fate-text-muted)' }}>Добавить вершину полигона</span>
                    <KbdKey>Двойной клик</KbdKey>
                    <span style={{ color: 'var(--fate-text-muted)' }}>Завершить полигон (≥3 вершины)</span>
                    <KbdKey>⏎ Enter</KbdKey>
                    <span style={{ color: 'var(--fate-text-muted)' }}>Завершить полигон (≥3 вершины)</span>
                    <KbdKey>⌫ Backspace</KbdKey>
                    <span style={{ color: 'var(--fate-text-muted)' }}>Отменить последнюю вершину</span>
                    <KbdKey>Esc</KbdKey>
                    <span style={{ color: 'var(--fate-text-muted)' }}>Отменить создание полигона</span>
                  </div>
                  <p className="text-[11px] mt-2 italic" style={{ color: 'var(--fate-text-muted)' }}>
                    💡 Подсказка: первая вершина подсвечивается кольцом — кликните по ней, чтобы быстро замкнуть полигон.
                  </p>
                </div>

                {/* Tool: Pen */}
                <div
                  className="rounded-lg p-3"
                  style={{ backgroundColor: 'rgba(52, 152, 219, 0.06)', border: '1px solid rgba(52, 152, 219, 0.2)' }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-base">✏️</span>
                    <span className="font-semibold" style={{ color: '#3498db' }}>Карандаш</span>
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--fate-text-muted)' }}>
                    Свободное рисование на карте. Зажмите левую кнопку мыши и ведите —
                    линия сохранится автоматически. Толщина настраивается в тулбаре.
                  </p>
                </div>

                {/* Tool: Eraser */}
                <div
                  className="rounded-lg p-3"
                  style={{ backgroundColor: 'rgba(231, 76, 60, 0.06)', border: '1px solid rgba(231, 76, 60, 0.2)' }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-base">🧽</span>
                    <span className="font-semibold" style={{ color: 'var(--fate-danger)' }}>Ластик</span>
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--fate-text-muted)' }}>
                    Удаляет нарисованные линии. Ведите мышью с зажатой кнопкой — радиус
                    настраивается в тулбаре.
                  </p>
                </div>

                {/* Tool: Pin */}
                <div
                  className="rounded-lg p-3"
                  style={{ backgroundColor: 'rgba(155, 89, 182, 0.06)', border: '1px solid rgba(155, 89, 182, 0.2)' }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-base">📍</span>
                    <span className="font-semibold" style={{ color: '#9b59b6' }}>Метка</span>
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--fate-text-muted)' }}>
                    Правый клик по пустому месту карты → «Создать метку». Откроется окно с выбором
                    названия, иконки и цвета. Правый клик по существующей метке позволяет её
                    отредактировать или удалить.
                  </p>
                </div>

                {/* Tool: Fog */}
                <div
                  className="rounded-lg p-3"
                  style={{ backgroundColor: 'rgba(127, 140, 141, 0.08)', border: '1px solid rgba(127, 140, 141, 0.25)' }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-base">🌫️</span>
                    <span className="font-semibold" style={{ color: '#7f8c8d' }}>Туман войны</span>
                  </div>
                  <p className="text-xs leading-relaxed mb-2" style={{ color: 'var(--fate-text-muted)' }}>
                    Скрывает области карты от игроков. Включите туман переключателем «Туман войны»,
                    затем рисуйте прямоугольники тумана. ПКМ по туману — переключить скрыто/видимо.
                  </p>
                  <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <KbdKey>ЛКМ drag</KbdKey>
                    <span style={{ color: 'var(--fate-text-muted)' }}>Создать область тумана</span>
                    <KbdKey>ПКМ</KbdKey>
                    <span style={{ color: 'var(--fate-text-muted)' }}>Переключить скрыто/видимо</span>
                  </div>
                </div>

                {/* Token drag-and-drop */}
                <div
                  className="rounded-lg p-3"
                  style={{ backgroundColor: 'rgba(39, 174, 96, 0.06)', border: '1px solid rgba(39, 174, 96, 0.2)' }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-base">🎴</span>
                    <span className="font-semibold" style={{ color: 'var(--fate-success)' }}>Перетаскивание токенов</span>
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--fate-text-muted)' }}>
                    Перетащите карточку персонажа из левой панели прямо на карту — токен
                    разместится в точке бросания. Игроки добавляются в постоянный roster
                    (видны во всех сценах), NPC привязываются к текущей сцене.
                  </p>
                </div>

                {/* Context roll (Shift+drag) */}
                <div
                  className="rounded-lg p-3"
                  style={{ backgroundColor: 'rgba(243, 156, 18, 0.06)', border: '1px solid rgba(243, 156, 18, 0.2)' }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-base">⚔️</span>
                    <span className="font-semibold" style={{ color: '#f39c12' }}>Контекстный бросок</span>
                  </div>
                  <p className="text-xs leading-relaxed" style={{ color: 'var(--fate-text-muted)' }}>
                    Зажмите Shift и перетащите от одного токена к другому — откроется диалог
                    контекстного броска (атака против защиты).
                  </p>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* ── Fate Ladder Tab ────────────────────────────────── */}
          <TabsContent value="ladder" className="space-y-3">
            <div
              className="fate-card-static rounded-xl overflow-hidden"
              style={{ backgroundColor: 'var(--fate-bg-card)' }}
            >
              <div
                className="fate-section-header px-4 py-2.5"
                style={{ borderColor: 'var(--fate-border)' }}
              >
                <h4
                  className="text-sm font-semibold flex items-center gap-1.5"
                  style={{ color: 'var(--fate-text)' }}
                >
                  📊 Лестница навыков Fate
                </h4>
              </div>

              {/* Header row */}
              <div
                className="grid grid-cols-[4rem_1fr_1.5fr] gap-2 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide border-b"
                style={{
                  color: 'var(--fate-text-muted)',
                  borderColor: 'var(--fate-border)',
                }}
              >
                <div>Значение</div>
                <div>Метка</div>
                <div className="hidden sm:block">Описание</div>
              </div>

              <div
                className="max-h-[70vh] overflow-y-auto fate-scroll"
                role="table"
                aria-label="Лестница Fate"
              >
                {LADDER.map((entry, idx) => {
                  const tierStyle = LADDER_TIER_STYLES[entry.tier];
                  return (
                    <div
                      key={entry.value}
                      className={`grid grid-cols-[4rem_1fr_1.5fr] gap-2 items-center px-4 py-2 ${idx % 2 === 0 ? 'fate-row-even' : 'fate-row-odd'}`}
                      style={{ borderColor: 'var(--fate-border)' }}
                    >
                      <div className="flex items-center">
                        <span
                          className="inline-flex items-center justify-center min-w-[2.5rem] px-2 py-1 rounded-md text-xs font-bold border"
                          style={{
                            backgroundColor: tierStyle.bg,
                            color: tierStyle.text,
                            borderColor: tierStyle.border,
                          }}
                        >
                          {entry.value}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span
                          className="text-sm font-semibold"
                          style={{ color: 'var(--fate-text)' }}
                        >
                          {entry.label}
                        </span>
                        <span
                          className="text-[11px] italic"
                          style={{ color: 'var(--fate-text-muted)' }}
                        >
                          {entry.english}
                        </span>
                      </div>
                      <div
                        className="text-sm leading-snug hidden sm:block"
                        style={{ color: 'var(--fate-text-muted)' }}
                      >
                        {entry.description}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Color legend */}
            <div
              className="flex flex-wrap items-center gap-2 px-1 text-xs"
              style={{ color: 'var(--fate-text-muted)' }}
            >
              <span className="font-medium">Легенда:</span>
              {(
                [
                  { tier: 'legendary', label: 'Легендарный (+5…+8)' },
                  { tier: 'great', label: 'Великий (+3…+4)' },
                  { tier: 'average', label: 'Средний (+1…+0)' },
                  { tier: 'poor', label: 'Слабый (-1…-2)' },
                  { tier: 'terrible', label: 'Кошмарный (-3…-4)' },
                ] as const
              ).map((item) => (
                <span
                  key={item.tier}
                  className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border"
                  style={{
                    backgroundColor: LADDER_TIER_STYLES[item.tier].bg,
                    color: LADDER_TIER_STYLES[item.tier].text,
                    borderColor: LADDER_TIER_STYLES[item.tier].border,
                  }}
                >
                  <span
                    className="size-2 rounded-full"
                    style={{ backgroundColor: LADDER_TIER_STYLES[item.tier].text }}
                  />
                  {item.label}
                </span>
              ))}
            </div>
          </TabsContent>
        </Tabs>

        {/* Footer note */}
        <div
          className="flex items-center justify-between gap-2 pt-2 border-t"
          style={{ borderColor: 'var(--fate-border)' }}
        >
          <p
            className="text-[11px] leading-relaxed"
            style={{ color: 'var(--fate-text-muted)' }}
          >
            🎲 Fate RPG — настольная ролевая система с использованием Fudge-кубов
            (⟨+⟩/⟨0⟩/⟨−⟩). Лестница навыков определяет уровень мастерства персонажа.
          </p>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-all duration-200 hover:scale-[1.02] active:scale-95"
            style={{
              backgroundColor: 'var(--fate-accent)',
              color: 'white',
            }}
          >
            Закрыть
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
