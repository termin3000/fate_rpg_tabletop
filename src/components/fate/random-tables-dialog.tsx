'use client';

import { useEffect, useMemo, useState } from 'react';
import { Dices, Plus, Pencil, Trash2, Sparkles, X, Check } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { RANDOM_TABLES, rollOnCustomTable, rollOnTable, type RandomTable } from '@/lib/random-tables';
import { useFateStore } from '@/lib/store';
import { genId } from '@/lib/fate-dice';
import type { CustomTable } from '@/lib/types';

interface RandomTablesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface HistoryEntry {
  id: number;
  tableId: string;
  tableIcon: string;
  tableColor: string;
  tableName: string;
  text: string;
  rolledAt: number;
}

// ── Preset color options (matching existing table colors, no blue/indigo) ──
const PRESET_COLORS = [
  '#e74c3c', // red
  '#e67e22', // orange
  '#f39c12', // amber
  '#27ae60', // green
  '#9b59b6', // purple
  '#c0392b', // dark red
];

// ── Common emoji picker options ──
const EMOJI_OPTIONS = [
  '⚔️', '👤', '💰', '📜', '🍺', '🌫️',
  '🎲', '🗺️', '🏠', '🔮', '🎭', '💀',
  '🐉', '🗡️', '🛡️', '🌿', '🔥', '❄️',
  '⚡', '🌙', '☀️', '🌊', '🎵', '📖',
];

// ── Relative time formatter (Russian) ─────────────────────────
function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, Math.floor((now - ts) / 1000));
  if (diff < 3) return 'только что';
  if (diff < 60) return `${diff}с назад`;
  if (diff < 3600) {
    const m = Math.floor(diff / 60);
    return `${m}м назад`;
  }
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    return `${h}ч назад`;
  }
  const d = Math.floor(diff / 86400);
  return `${d}д назад`;
}

// ── Create / Edit Form Component ──────────────────────────────
interface CustomTableFormProps {
  initial?: CustomTable | null;
  onSave: (table: CustomTable) => void;
  onCancel: () => void;
}

function CustomTableForm({ initial, onSave, onCancel }: CustomTableFormProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [icon, setIcon] = useState(initial?.icon ?? '🎲');
  const [color, setColor] = useState(initial?.color ?? PRESET_COLORS[0]);
  const [entriesText, setEntriesText] = useState(initial?.entries.join('\n') ?? '');
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);

  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toast.error('Введите название таблицы');
      return;
    }
    const entries = entriesText
      .split('\n')
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
    if (entries.length < 2) {
      toast.error('Добавьте минимум 2 записи в таблицу');
      return;
    }
    const table: CustomTable = {
      id: initial?.id ?? genId(),
      name: trimmedName,
      icon,
      color,
      entries,
      createdAt: initial?.createdAt ?? new Date().toISOString(),
    };
    onSave(table);
  };

  return (
    <div className="animate-fade-in space-y-4 p-4 rounded-xl" style={{ backgroundColor: 'var(--fate-card)', border: '1px solid var(--fate-border)' }}>
      <h4 className="text-sm font-bold" style={{ color: 'var(--fate-text)' }}>
        {initial ? '✏️ Редактирование таблицы' : '➕ Новая таблица'}
      </h4>

      {/* Name */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
          Название
        </label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Например: Случайные ловушки"
          className="h-9 text-sm"
          style={{ backgroundColor: 'var(--fate-bg)', borderColor: 'var(--fate-border)', color: 'var(--fate-text)' }}
        />
      </div>

      {/* Icon */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
          Иконка
        </label>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowEmojiPicker(!showEmojiPicker)}
            className="size-10 rounded-lg border-2 flex items-center justify-center text-xl transition-colors"
            style={{ borderColor: 'var(--fate-border)', backgroundColor: `${color}1a` }}
          >
            {icon}
          </button>
          {showEmojiPicker && (
            <div className="flex flex-wrap gap-1 p-2 rounded-lg border" style={{ backgroundColor: 'var(--fate-bg)', borderColor: 'var(--fate-border)' }}>
              {EMOJI_OPTIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => { setIcon(e); setShowEmojiPicker(false); }}
                  className="size-8 rounded flex items-center justify-center text-base hover:scale-110 transition-transform"
                  style={{ backgroundColor: icon === e ? `${color}30` : 'transparent' }}
                >
                  {e}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Color */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
          Цвет
        </label>
        <div className="flex gap-2">
          {PRESET_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className="size-8 rounded-full border-2 transition-transform hover:scale-110"
              style={{
                backgroundColor: c,
                borderColor: color === c ? 'var(--fate-text)' : 'transparent',
                boxShadow: color === c ? `0 0 0 2px ${c}60` : 'none',
              }}
            />
          ))}
        </div>
      </div>

      {/* Entries */}
      <div className="space-y-1.5">
        <label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
          Записи (каждая строка — один вариант)
        </label>
        <Textarea
          value={entriesText}
          onChange={(e) => setEntriesText(e.target.value)}
          placeholder={"Первая запись\nВторая запись\nТретья запись"}
          rows={8}
          className="text-sm resize-none"
          style={{ backgroundColor: 'var(--fate-bg)', borderColor: 'var(--fate-border)', color: 'var(--fate-text)' }}
        />
        <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
          {entriesText.split('\n').filter((e) => e.trim()).length} записей (минимум 2)
        </p>
      </div>

      {/* Actions */}
      <div className="flex gap-2 justify-end">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-3 text-xs gap-1.5 rounded-lg"
          style={{ color: 'var(--fate-text-muted)' }}
          onClick={onCancel}
        >
          <X className="size-3.5" />
          Отмена
        </Button>
        <Button
          size="sm"
          className="fate-btn-accent h-8 px-4 text-xs gap-1.5 rounded-lg"
          onClick={handleSave}
        >
          <Check className="size-3.5" />
          Сохранить
        </Button>
      </div>
    </div>
  );
}

// ── Main Dialog ───────────────────────────────────────────────
export function RandomTablesDialog({ open, onOpenChange }: RandomTablesDialogProps) {
  const { customTables, saveCustomTable, deleteCustomTable } = useFateStore();

  // Tab state: 'preset' | 'custom'
  const [tab, setTab] = useState<'preset' | 'custom'>('preset');

  // Preset table selection
  const [selectedPresetId, setSelectedPresetId] = useState<string>(RANDOM_TABLES[0].id);

  // Custom table selection
  const [selectedCustomId, setSelectedCustomId] = useState<string | null>(null);

  // Roll state
  const [currentResult, setCurrentResult] = useState<string | null>(null);
  const [rollKey, setRollKey] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [now, setNow] = useState(Date.now());

  // Custom table editing
  const [editingTable, setEditingTable] = useState<CustomTable | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const selectedPresetTable = useMemo<RandomTable>(
    () => RANDOM_TABLES.find((t) => t.id === selectedPresetId) ?? RANDOM_TABLES[0],
    [selectedPresetId],
  );

  const selectedCustomTable = useMemo<CustomTable | null>(
    () => customTables.find((t) => t.id === selectedCustomId) ?? null,
    [customTables, selectedCustomId],
  );

  // The "active" table info for the roll area
  const activeTable = tab === 'preset'
    ? { id: selectedPresetTable.id, name: selectedPresetTable.name, icon: selectedPresetTable.icon, color: selectedPresetTable.color, description: selectedPresetTable.description, entryCount: selectedPresetTable.entries.length }
    : selectedCustomTable
      ? { id: selectedCustomTable.id, name: selectedCustomTable.name, icon: selectedCustomTable.icon, color: selectedCustomTable.color, description: null, entryCount: selectedCustomTable.entries.length }
      : null;

  // Re-render every second so relative timestamps stay fresh while open.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [open]);

  // Reset transient state when the dialog opens (fresh session each time).
  useEffect(() => {
    if (open) {
      setCurrentResult(null);
      setRollKey(0);
      setHistory([]);
      setNow(Date.now());
      setSelectedPresetId(RANDOM_TABLES[0].id);
      setSelectedCustomId(null);
      setEditingTable(null);
      setIsCreating(false);
      setDeletingId(null);
      setTab('preset');
    }
  }, [open]);

  const handleRoll = () => {
    let text: string;
    let tableId: string;
    let tableIcon: string;
    let tableColor: string;
    let tableName: string;

    if (tab === 'preset') {
      text = rollOnTable(selectedPresetTable);
      tableId = selectedPresetTable.id;
      tableIcon = selectedPresetTable.icon;
      tableColor = selectedPresetTable.color;
      tableName = selectedPresetTable.name;
    } else if (selectedCustomTable) {
      text = rollOnCustomTable(selectedCustomTable.entries);
      tableId = selectedCustomTable.id;
      tableIcon = selectedCustomTable.icon;
      tableColor = selectedCustomTable.color;
      tableName = selectedCustomTable.name;
    } else {
      return;
    }

    setCurrentResult(text);
    setRollKey((k) => k + 1);
    const entry: HistoryEntry = {
      id: Date.now() + Math.random(),
      tableId,
      tableIcon,
      tableColor,
      tableName,
      text,
      rolledAt: Date.now(),
    };
    setHistory((prev) => [entry, ...prev].slice(0, 10));
    setNow(Date.now());
  };

  const handleClearHistory = () => {
    setHistory([]);
  };

  const handleSaveCustom = (table: CustomTable) => {
    const isEdit = customTables.some((t) => t.id === table.id);
    saveCustomTable(table);
    setSelectedCustomId(table.id);
    setEditingTable(null);
    setIsCreating(false);
    toast.success(isEdit ? 'Таблица обновлена' : 'Таблица создана');
  };

  const handleDeleteCustom = (id: string) => {
    deleteCustomTable(id);
    if (selectedCustomId === id) {
      setSelectedCustomId(null);
    }
    setDeletingId(null);
    toast.success('Таблица удалена');
  };

  // ── Render: table list item (shared between preset & custom) ──
  const renderTableCard = (
    id: string,
    name: string,
    icon: string,
    color: string,
    entryCount: number,
    isSelected: boolean,
    onClick: () => void,
    extra?: React.ReactNode,
  ) => (
    <button
      key={id}
      onClick={onClick}
      className="flex-1 md:flex-none text-left rounded-xl p-3 border-2 transition-all duration-200 active:scale-[0.98] hover:shadow-sm w-full"
      style={{
        borderColor: isSelected ? color : 'var(--fate-border)',
        backgroundColor: isSelected ? `${color}14` : 'transparent',
        boxShadow: isSelected ? `0 0 0 1px ${color}40` : 'none',
      }}
    >
      <div className="flex items-center gap-2.5">
        <div
          className="size-9 rounded-lg flex items-center justify-center text-lg shrink-0"
          style={{ backgroundColor: `${color}1a` }}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div
            className="text-sm font-semibold truncate"
            style={{ color: 'var(--fate-text)' }}
          >
            {name}
          </div>
          <div
            className="text-[11px]"
            style={{ color: 'var(--fate-text-muted)' }}
          >
            {entryCount} записей
          </div>
        </div>
        {extra}
      </div>
    </button>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <span className="text-base leading-none">🎲</span>
            </div>
            Случайные таблицы
          </DialogTitle>
          <DialogDescription>
            Бросайте на таблицах для вдохновения во время игры
          </DialogDescription>
        </DialogHeader>

        {/* ── Tab toggle ── */}
        <div className="flex gap-1 p-1 rounded-xl" style={{ backgroundColor: 'var(--fate-card)' }}>
          <button
            onClick={() => setTab('preset')}
            className="flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center gap-1.5"
            style={{
              backgroundColor: tab === 'preset' ? 'var(--fate-bg)' : 'transparent',
              color: tab === 'preset' ? 'var(--fate-text)' : 'var(--fate-text-muted)',
              boxShadow: tab === 'preset' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            📋 Стандартные
          </button>
          <button
            onClick={() => setTab('custom')}
            className="flex-1 py-2 px-3 rounded-lg text-sm font-medium transition-all duration-200 flex items-center justify-center gap-1.5"
            style={{
              backgroundColor: tab === 'custom' ? 'var(--fate-bg)' : 'transparent',
              color: tab === 'custom' ? 'var(--fate-text)' : 'var(--fate-text-muted)',
              boxShadow: tab === 'custom' ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
            }}
          >
            ✏️ Пользовательские
          </button>
        </div>

        {/* ── Two-column layout: table list + roll area ── */}
        <div className="flex flex-col md:flex-row gap-4 flex-1 min-h-0">
          {/* Left column — table list */}
          <div className="md:w-56 shrink-0">
            <ScrollArea className="h-full max-h-[55vh] md:max-h-none fate-scroll">
              <div className="flex md:flex-col gap-2 pr-1">
                {tab === 'preset' ? (
                  // Preset tables
                  RANDOM_TABLES.map((table) =>
                    renderTableCard(
                      table.id,
                      table.name,
                      table.icon,
                      table.color,
                      table.entries.length,
                      table.id === selectedPresetId,
                      () => setSelectedPresetId(table.id),
                    ),
                  )
                ) : (
                  // Custom tables
                  <>
                    {/* Create button */}
                    {!isCreating && !editingTable && (
                      <button
                        onClick={() => { setIsCreating(true); setEditingTable(null); }}
                        className="fate-btn-accent w-full rounded-xl p-3 text-sm font-semibold gap-2 flex items-center justify-center transition-all duration-200 active:scale-[0.98]"
                      >
                        <Plus className="size-4" />
                        Создать таблицу
                      </button>
                    )}
                    {customTables.map((table) => {
                      const isSelected = table.id === selectedCustomId && !isCreating && !editingTable;
                      return renderTableCard(
                        table.id,
                        table.name,
                        table.icon,
                        table.color,
                        table.entries.length,
                        isSelected,
                        () => { setSelectedCustomId(table.id); setIsCreating(false); setEditingTable(null); },
                        <div className="flex gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <button
                            onClick={(e) => { e.stopPropagation(); setEditingTable(table); setIsCreating(false); }}
                            className="size-7 rounded-md flex items-center justify-center transition-colors hover:scale-105"
                            style={{ color: 'var(--fate-text-muted)' }}
                            title="Редактировать"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                          {deletingId === table.id ? (
                            <div className="flex gap-0.5">
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteCustom(table.id); }}
                                className="size-7 rounded-md flex items-center justify-center text-xs transition-colors"
                                style={{ color: '#e74c3c' }}
                                title="Подтвердить удаление"
                              >
                                <Check className="size-3.5" />
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); setDeletingId(null); }}
                                className="size-7 rounded-md flex items-center justify-center text-xs transition-colors"
                                style={{ color: 'var(--fate-text-muted)' }}
                                title="Отмена"
                              >
                                <X className="size-3.5" />
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); setDeletingId(table.id); }}
                              className="size-7 rounded-md flex items-center justify-center transition-colors hover:scale-105"
                              style={{ color: 'var(--fate-text-muted)' }}
                              title="Удалить"
                            >
                              <Trash2 className="size-3.5" />
                            </button>
                          )}
                        </div>,
                      );
                    })}
                    {customTables.length === 0 && !isCreating && (
                      <div
                        className="text-center py-8 text-xs rounded-xl p-4"
                        style={{ color: 'var(--fate-text-muted)', backgroundColor: 'var(--fate-card)', border: '1px dashed var(--fate-border)' }}
                      >
                        Нет пользовательских таблиц.<br />Нажмите «Создать таблицу», чтобы добавить.
                      </div>
                    )}
                  </>
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Right column — roll area or edit form */}
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            {/* Show edit/create form if active */}
            {tab === 'custom' && (isCreating || editingTable) ? (
              <CustomTableForm
                initial={editingTable}
                onSave={handleSaveCustom}
                onCancel={() => { setIsCreating(false); setEditingTable(null); }}
              />
            ) : activeTable ? (
              <>
                {/* Selected table header */}
                <div
                  className="rounded-xl p-4 border-l-4"
                  style={{
                    borderColor: activeTable.color,
                    backgroundColor: `${activeTable.color}0d`,
                  }}
                >
                  <div className="flex items-center gap-2.5 mb-1">
                    <span className="text-2xl leading-none">{activeTable.icon}</span>
                    <h3
                      className="text-base font-bold"
                      style={{ color: activeTable.color }}
                    >
                      {activeTable.name}
                    </h3>
                  </div>
                  {activeTable.description && (
                    <p
                      className="text-xs leading-relaxed"
                      style={{ color: 'var(--fate-text-muted)' }}
                    >
                      {activeTable.description}
                    </p>
                  )}
                  <p
                    className="text-[11px] mt-1"
                    style={{ color: 'var(--fate-text-muted)' }}
                  >
                    {activeTable.entryCount} записей
                  </p>
                </div>

                {/* Roll button */}
                <Button
                  onClick={handleRoll}
                  className="fate-btn-accent h-12 rounded-xl text-base font-bold gap-2 w-full"
                >
                  <Dices className="size-5" />
                  🎲 Бросить
                </Button>

                {/* Result display */}
                <div
                  className="rounded-xl p-5 min-h-[88px] flex items-center justify-center text-center"
                  style={{
                    backgroundColor: 'var(--fate-card)',
                    border: '2px solid var(--fate-border)',
                    borderLeft: `4px solid ${activeTable.color}`,
                  }}
                >
                  {currentResult ? (
                    <p
                      key={rollKey}
                      className="animate-fade-in text-base font-semibold leading-relaxed"
                      style={{ color: 'var(--fate-text)' }}
                    >
                      {currentResult}
                    </p>
                  ) : (
                    <div
                      className="flex flex-col items-center gap-2 opacity-60"
                      style={{ color: 'var(--fate-text-muted)' }}
                    >
                      <Sparkles className="size-6" />
                      <span className="text-sm">Нажмите «Бросить», чтобы получить результат</span>
                    </div>
                  )}
                </div>

                {/* History section */}
                <div className="flex-1 min-h-0 flex flex-col">
                  <div className="flex items-center justify-between mb-2">
                    <h4
                      className="text-xs font-semibold uppercase tracking-wide"
                      style={{ color: 'var(--fate-text-muted)' }}
                    >
                      История бросков
                    </h4>
                    {history.length > 0 && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs gap-1.5 rounded-lg"
                        style={{ color: 'var(--fate-text-muted)' }}
                        onClick={handleClearHistory}
                        title="Очистить историю"
                      >
                        <Trash2 className="size-3" />
                        Очистить историю
                      </Button>
                    )}
                  </div>
                  <Separator className="mb-2" />

                  <ScrollArea className="flex-1 max-h-64 fate-scroll">
                    {history.length === 0 ? (
                      <div
                        className="text-center py-8 text-xs"
                        style={{ color: 'var(--fate-text-muted)', opacity: 0.7 }}
                      >
                        История пуста
                      </div>
                    ) : (
                      <ul className="space-y-1.5 pr-1">
                        {history.map((h) => (
                          <li
                            key={h.id}
                            className="flex items-start gap-2.5 rounded-lg p-2 transition-colors duration-150"
                            style={{ backgroundColor: 'var(--fate-card)' }}
                          >
                            <span className="text-base leading-none mt-0.5 shrink-0">
                              {h.tableIcon}
                            </span>
                            <div className="min-w-0 flex-1">
                              <p
                                className="text-xs leading-snug"
                                style={{ color: 'var(--fate-text)' }}
                              >
                                {h.text}
                              </p>
                              <p
                                className="text-[10px] mt-0.5"
                                style={{ color: h.tableColor, opacity: 0.85 }}
                              >
                                {h.tableName} · {formatRelative(h.rolledAt, now)}
                              </p>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </ScrollArea>
                </div>
              </>
            ) : (
              /* No custom table selected */
              <div
                className="flex-1 flex items-center justify-center rounded-xl p-8"
                style={{ backgroundColor: 'var(--fate-card)', border: '1px dashed var(--fate-border)' }}
              >
                <div className="text-center" style={{ color: 'var(--fate-text-muted)' }}>
                  <span className="text-3xl mb-3 block">📋</span>
                  <p className="text-sm">Выберите таблицу из списка слева</p>
                  <p className="text-xs mt-1 opacity-70">или создайте новую</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
