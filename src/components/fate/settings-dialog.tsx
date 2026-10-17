'use client';

import { useCallback, useRef, useState } from 'react';
import { Minus, Pencil, Plus, RotateCcw, Settings, Upload, Wand2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useFateStore } from '@/lib/store';
import { DEFAULT_SETTINGS } from '@/lib/types';
import type { AdventureSettings, MagicTableEntry } from '@/lib/types';
import { DiceColorPicker } from '@/components/fate/dice-color-picker';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { settings, updateSettings, magicModuleEnabled, magicTable, loadMagicTable } = useFateStore();

  // Initialize local state from store so it's correct on first open
  const [localSkills, setLocalSkills] = useState<string[]>(() => {
    const s = useFateStore.getState().settings;
    return s.baseSkills?.length ? [...s.baseSkills] : [...DEFAULT_SETTINGS.baseSkills];
  });
  const [newSkill, setNewSkill] = useState('');
  const [editingSkillIdx, setEditingSkillIdx] = useState<number | null>(null);
  const [editingSkillValue, setEditingSkillValue] = useState('');

  const [localInitiative, setLocalInitiative] = useState<AdventureSettings['initiative']>(
    settings.initiative,
  );

  const [localMagicEnabled, setLocalMagicEnabled] = useState(magicModuleEnabled);
  const [localMagicTable, setLocalMagicTable] = useState<MagicTableEntry[]>(magicTable);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Re-sync local state from the store when dialog opens (open transitions to true)
  const prevOpenRef = useRef(open);
  if (open && !prevOpenRef.current) {
    const currentSettings = useFateStore.getState().settings;
    const baseSkills = currentSettings.baseSkills?.length
      ? [...currentSettings.baseSkills]
      : [...DEFAULT_SETTINGS.baseSkills];
    setLocalSkills(baseSkills);
    setEditingSkillIdx(null);
    setNewSkill('');

    setLocalInitiative({
      mode: currentSettings.initiative?.mode ?? DEFAULT_SETTINGS.initiative.mode,
      physical: { ...DEFAULT_SETTINGS.initiative.physical, ...currentSettings.initiative?.physical },
      mental: { ...DEFAULT_SETTINGS.initiative.mental, ...currentSettings.initiative?.mental },
    });

    setLocalMagicEnabled(
      currentSettings.modules?.magic ?? useFateStore.getState().magicModuleEnabled,
    );
    setLocalMagicTable([...useFateStore.getState().magicTable]);
  }
  prevOpenRef.current = open;

  const handleOpenChange = useCallback(
    (isOpen: boolean) => {
      if (isOpen) {
        const currentSettings = useFateStore.getState().settings;
        const baseSkills = currentSettings.baseSkills?.length
          ? [...currentSettings.baseSkills]
          : [...DEFAULT_SETTINGS.baseSkills];
        setLocalSkills(baseSkills);
        setEditingSkillIdx(null);
        setNewSkill('');

        setLocalInitiative({
          mode: currentSettings.initiative?.mode ?? DEFAULT_SETTINGS.initiative.mode,
          physical: { ...DEFAULT_SETTINGS.initiative.physical, ...currentSettings.initiative?.physical },
          mental: { ...DEFAULT_SETTINGS.initiative.mental, ...currentSettings.initiative?.mental },
        });

        setLocalMagicEnabled(
          currentSettings.modules?.magic ?? useFateStore.getState().magicModuleEnabled,
        );
        setLocalMagicTable([...useFateStore.getState().magicTable]);
      }
      onOpenChange(isOpen);
    },
    [onOpenChange],
  );

  // ── Skills handlers ────────────────────────────────────────
  const handleAddSkill = () => {
    if (!newSkill.trim() || localSkills.includes(newSkill.trim())) return;
    setLocalSkills((prev) => [...prev, newSkill.trim()]);
    setNewSkill('');
  };

  const handleRemoveSkill = (idx: number) => {
    setLocalSkills((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleStartEditSkill = (idx: number) => {
    setEditingSkillIdx(idx);
    setEditingSkillValue(localSkills[idx]);
  };

  const handleSaveEditSkill = () => {
    if (editingSkillIdx === null) return;
    const trimmed = editingSkillValue.trim();
    if (trimmed && !localSkills.includes(trimmed)) {
      setLocalSkills((prev) =>
        prev.map((s, i) => (i === editingSkillIdx ? trimmed : s)),
      );
    }
    setEditingSkillIdx(null);
    setEditingSkillValue('');
  };

  const handleSaveSkills = async () => {
    await updateSettings({ baseSkills: localSkills });
  };

  const handleResetSkills = () => {
    setLocalSkills([...DEFAULT_SETTINGS.baseSkills]);
  };

  // ── Initiative handlers ────────────────────────────────────
  const handleInitiativeChange = (
    conflictType: 'physical' | 'mental',
    priority: 'primary' | 'secondary' | 'tertiary',
    value: string,
  ) => {
    setLocalInitiative((prev) => ({
      ...prev,
      [conflictType]: {
        ...prev[conflictType],
        [priority]: value,
      },
    }));
  };

  const handleSaveInitiative = async () => {
    await updateSettings({ initiative: localInitiative });
  };

  const handleResetInitiative = () => {
    setLocalInitiative({
      mode: DEFAULT_SETTINGS.initiative.mode,
      physical: { ...DEFAULT_SETTINGS.initiative.physical },
      mental: { ...DEFAULT_SETTINGS.initiative.mental },
    });
  };

  // ── Modules handlers ───────────────────────────────────────
  const handleSaveModules = async () => {
    await updateSettings({
      modules: { magic: localMagicEnabled },
    });
    // Also persist the magic table to the store so other components can use it
    loadMagicTable(localMagicTable);
  };

  /**
   * Parse an entire CSV text (RFC 4180 compliant) into rows of fields.
   * Handles:
   *  - Multiline values (newlines inside double-quoted fields)
   *  - Double-quote escaping ("" → literal ")
   *  - Comma, semicolon, or tab delimiters
   */
  const parseCsvText = (text: string): string[][] => {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentField = '';
    let inQuotes = false;
    let i = 0;

    while (i < text.length) {
      const ch = text[i];

      if (inQuotes) {
        if (ch === '"') {
          // Check for escaped double-quote
          if (i + 1 < text.length && text[i + 1] === '"') {
            currentField += '"';
            i += 2;
          } else {
            // End of quoted field
            inQuotes = false;
            i++;
          }
        } else {
          currentField += ch;
          i++;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
          i++;
        } else if (ch === ',' || ch === ';' || ch === '\t') {
          currentRow.push(currentField.trim());
          currentField = '';
          i++;
        } else if (ch === '\r') {
          // Skip CR (handle \r\n or bare \r)
          currentRow.push(currentField.trim());
          currentField = '';
          rows.push(currentRow);
          currentRow = [];
          i++;
          if (i < text.length && text[i] === '\n') i++;
        } else if (ch === '\n') {
          currentRow.push(currentField.trim());
          currentField = '';
          rows.push(currentRow);
          currentRow = [];
          i++;
        } else {
          currentField += ch;
          i++;
        }
      }
    }

    // Push last field and row
    currentRow.push(currentField.trim());
    if (currentRow.some((f) => f.length > 0)) {
      rows.push(currentRow);
    }

    return rows;
  };

  /** Extract zone stress from an effect string like "Стресс зоны -2\n..." */
  const extractZoneStress = (effect: string): { zoneStress: number; cleanEffect: string } => {
    const match = effect.match(/Стресс зоны\s*([+-]?\d+)/i);
    if (match) {
      const stress = parseInt(match[1], 10);
      // Remove the stress line from the effect, keep the rest
      const cleanEffect = effect
        .replace(/Стресс зоны\s*[+-]?\d+\s*/i, '')
        .trim();
      return { zoneStress: stress, cleanEffect };
    }
    return { zoneStress: undefined as unknown as number, cleanEffect: effect };
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = parseCsvText(text);
      const entries: MagicTableEntry[] = [];
      const header = rows[0]?.join('').toLowerCase() ?? '';
      const startIdx = header.includes('name') || header.includes('название') || header.includes('card') || header.includes('номер') || header.includes('эффект') || header.includes('effect') ? 1 : 0;

      for (let i = startIdx; i < rows.length; i++) {
        const parts = rows[i];
        if (parts.length >= 3) {
          const rawEffect = parts.slice(2).join('\n');
          const { zoneStress, cleanEffect } = extractZoneStress(rawEffect);
          entries.push({
            name: parts[1],
            effect: cleanEffect || rawEffect,
            ...(zoneStress !== undefined && { zoneStress }),
          });
        } else if (parts.length >= 2) {
          const rawEffect = parts[1];
          const { zoneStress, cleanEffect } = extractZoneStress(rawEffect);
          entries.push({
            name: parts[0],
            effect: cleanEffect || rawEffect,
            ...(zoneStress !== undefined && { zoneStress }),
          });
        }
      }

      setLocalMagicTable(entries);
      loadMagicTable(entries);
    };
    reader.readAsText(file);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Combined skills list for initiative dropdowns (includes current baseSkills + default ones)
  const initiativeSkills = localSkills.length > 0
    ? localSkills
    : DEFAULT_SETTINGS.baseSkills;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[88vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
            >
              <Settings className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            Настройки приключения
          </DialogTitle>
          <DialogDescription>
            Настройте навыки, порядок хода и модули
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="skills" className="w-full flex-1 min-h-0 flex flex-col">
          <TabsList className="w-full rounded-lg shrink-0">
            <TabsTrigger value="skills" className="flex-1 text-xs rounded-md transition-all duration-200">
              Базовые навыки
            </TabsTrigger>
            <TabsTrigger value="initiative" className="flex-1 text-xs rounded-md transition-all duration-200">
              Порядок хода
            </TabsTrigger>
            <TabsTrigger value="modules" className="flex-1 text-xs rounded-md transition-all duration-200">
              Модули
            </TabsTrigger>
            <TabsTrigger value="stage" className="flex-1 text-xs rounded-md transition-all duration-200">
              Сцена
            </TabsTrigger>
          </TabsList>

          {/* ── Skills Tab ────────────────────────────────────── */}
          <TabsContent value="skills" className="flex flex-col gap-3 flex-1 min-h-0 overflow-hidden">
            <div className="flex items-center justify-between shrink-0">
              <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                Стандартный список навыков для листов персонажей ({localSkills.length})
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs gap-1 h-6 px-2 rounded-md"
                onClick={handleResetSkills}
                title="Сбросить к стандартным"
                style={{ color: 'var(--fate-accent)' }}
              >
                <RotateCcw className="size-3" />
                Сброс
              </Button>
            </div>

            <div className="flex gap-2 shrink-0">
              <Input
                placeholder="Новый навык..."
                value={newSkill}
                onChange={(e) => setNewSkill(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleAddSkill()}
                className="text-sm rounded-lg"
              />
              <Button
                onClick={handleAddSkill}
                disabled={!newSkill.trim()}
                size="sm"
                variant="outline"
                className="shrink-0 gap-1 rounded-lg"
              >
                <Plus className="size-4" />
              </Button>
            </div>

            <ScrollArea className="flex-1 max-h-[45vh]" type="auto">
              <div className="space-y-1 pr-2">
                {localSkills.length === 0 ? (
                  <div className="text-center py-6 text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                    Нет навыков. Добавьте или сбросьте к стандартным.
                  </div>
                ) : (
                  localSkills.map((skill, idx) => (
                    <div
                      key={`${skill}-${idx}`}
                      className="fate-list-item flex items-center gap-2 p-2"
                    >
                      {editingSkillIdx === idx ? (
                        <div className="flex items-center gap-1 flex-1">
                          <Input
                            value={editingSkillValue}
                            onChange={(e) => setEditingSkillValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveEditSkill();
                              if (e.key === 'Escape') setEditingSkillIdx(null);
                            }}
                            className="h-7 text-sm rounded-lg"
                            autoFocus
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-6 p-0 hover:scale-110 active:scale-90 transition-transform"
                            onClick={handleSaveEditSkill}
                            style={{ color: 'var(--fate-success)' }}
                          >
                            ✓
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="size-6 p-0 hover:scale-110 active:scale-90 transition-transform"
                            onClick={() => setEditingSkillIdx(null)}
                          >
                            <X className="size-3" />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <span className="text-xs font-mono w-5 text-center shrink-0" style={{ color: 'var(--fate-text-muted)' }}>
                            {idx + 1}
                          </span>
                          <span
                            className="flex-1 text-sm font-medium"
                            style={{ color: 'var(--fate-text)' }}
                          >
                            {skill}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 rounded-lg hover:scale-110 active:scale-90 transition-transform"
                            onClick={() => handleStartEditSkill(idx)}
                            style={{ color: 'var(--fate-text-muted)' }}
                          >
                            <Pencil className="size-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-6 rounded-lg hover:scale-110 active:scale-90 transition-transform"
                            onClick={() => handleRemoveSkill(idx)}
                            style={{ color: 'var(--fate-danger)' }}
                          >
                            <Minus className="size-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  ))
                )}
              </div>
            </ScrollArea>

            <div className="flex justify-end shrink-0 pt-2 border-t" style={{ borderColor: 'var(--fate-border)' }}>
              <Button
                size="sm"
                onClick={handleSaveSkills}
                className="fate-btn-accent gap-1.5 rounded-lg"
              >
                Сохранить навыки
              </Button>
            </div>
          </TabsContent>

          {/* ── Initiative Tab ─────────────────────────────────── */}
          <TabsContent value="initiative" className="space-y-4 overflow-y-auto flex-1 min-h-0">
            <div className="flex items-center justify-between">
              <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                Выберите режим и навыки, определяющие порядок хода
              </p>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs gap-1 h-6 px-2 rounded-md"
                onClick={handleResetInitiative}
                title="Сбросить к стандартным"
                style={{ color: 'var(--fate-accent)' }}
              >
                <RotateCcw className="size-3" />
                Сброс
              </Button>
            </div>

            {/* ── Initiative Mode Toggle ── */}
            <div
              className="rounded-lg p-3 space-y-2"
              style={{ backgroundColor: 'var(--fate-bg-card)' }}
            >
              <h4
                className="text-sm font-semibold flex items-center gap-1.5"
                style={{ color: 'var(--fate-text)' }}
              >
                📋 Режим инициативы
              </h4>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setLocalInitiative((prev) => ({ ...prev, mode: 'book' }))}
                  className="text-left rounded-lg p-2.5 transition-all duration-200 border-2 cursor-pointer"
                  style={{
                    borderColor: localInitiative.mode === 'book' ? 'var(--fate-accent)' : 'transparent',
                    backgroundColor: localInitiative.mode === 'book' ? 'rgba(230, 126, 34, 0.08)' : 'var(--fate-bg-hover)',
                  }}
                >
                  <div className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                    📖 По книге
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--fate-text-muted)' }}>
                    Навык определяет порядок. При ничьей — вторичный и третичный навыки
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setLocalInitiative((prev) => ({ ...prev, mode: 'random' }))}
                  className="text-left rounded-lg p-2.5 transition-all duration-200 border-2 cursor-pointer"
                  style={{
                    borderColor: localInitiative.mode === 'random' ? 'var(--fate-accent)' : 'transparent',
                    backgroundColor: localInitiative.mode === 'random' ? 'rgba(230, 126, 34, 0.08)' : 'var(--fate-bg-hover)',
                  }}
                >
                  <div className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                    🎲 Случайная
                  </div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--fate-text-muted)' }}>
                    Бросок 4dF + навык. Каждый раунд можно перебросить
                  </div>
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <h4
                className="text-sm font-semibold flex items-center gap-1.5"
                style={{ color: 'var(--fate-text)' }}
              >
                ⚔️ Физический конфликт
              </h4>
              {(['primary', 'secondary', 'tertiary'] as const).map((priority, idx) => (
                <div key={priority} className="flex items-center gap-2">
                  <Label className="text-xs w-24 shrink-0 font-medium">
                    {idx === 0 ? 'Первичный' : idx === 1 ? 'Вторичный' : 'Третичный'}
                  </Label>
                  <Select
                    value={localInitiative.physical[priority]}
                    onValueChange={(v) => handleInitiativeChange('physical', priority, v)}
                  >
                    <SelectTrigger className="text-sm rounded-lg">
                      <SelectValue placeholder="Выберите навык" />
                    </SelectTrigger>
                    <SelectContent>
                      {initiativeSkills.map((skill) => (
                        <SelectItem key={skill} value={skill}>
                          {skill}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div className="space-y-3">
              <h4
                className="text-sm font-semibold flex items-center gap-1.5"
                style={{ color: 'var(--fate-text)' }}
              >
                🧠 Ментальный конфликт
              </h4>
              {(['primary', 'secondary', 'tertiary'] as const).map((priority, idx) => (
                <div key={priority} className="flex items-center gap-2">
                  <Label className="text-xs w-24 shrink-0 font-medium">
                    {idx === 0 ? 'Первичный' : idx === 1 ? 'Вторичный' : 'Третичный'}
                  </Label>
                  <Select
                    value={localInitiative.mental[priority]}
                    onValueChange={(v) => handleInitiativeChange('mental', priority, v)}
                  >
                    <SelectTrigger className="text-sm rounded-lg">
                      <SelectValue placeholder="Выберите навык" />
                    </SelectTrigger>
                    <SelectContent>
                      {initiativeSkills.map((skill) => (
                        <SelectItem key={skill} value={skill}>
                          {skill}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>

            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleSaveInitiative}
                className="fate-btn-accent gap-1.5 rounded-lg"
              >
                Сохранить порядок хода
              </Button>
            </div>
          </TabsContent>

          {/* ── Modules Tab ────────────────────────────────────── */}
          <TabsContent value="modules" className="space-y-4 overflow-y-auto flex-1 min-h-0">
            <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
              Включите или отключите дополнительные игровые модули
            </p>

            {/* Magic Module */}
            <div
              className="rounded-xl p-4 space-y-3"
              style={{ backgroundColor: 'var(--fate-bg-warm)', border: '1px solid var(--fate-border)' }}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <div
                    className="fate-icon-circle"
                    style={{ backgroundColor: 'rgba(155, 89, 182, 0.12)' }}
                  >
                    <Wand2 className="size-4" style={{ color: '#9b59b6' }} />
                  </div>
                  <div>
                    <h4
                      className="text-sm font-semibold"
                      style={{ color: 'var(--fate-text)' }}
                    >
                      Разрушительная магия
                    </h4>
                    <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                      Добавляет таблицу заклинаний и магические эффекты
                    </p>
                  </div>
                </div>
                <Switch
                  checked={localMagicEnabled}
                  onCheckedChange={setLocalMagicEnabled}
                  aria-label="Включить модуль разрушительной магии"
                />
              </div>

              {localMagicEnabled && (
                <div className="space-y-2 pt-2 border-t" style={{ borderColor: 'var(--fate-border)' }}>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-xs rounded-lg"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="size-3" />
                      Загрузить CSV
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".csv,.txt"
                      onChange={handleCsvUpload}
                      className="hidden"
                    />
                    <span className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                      {localMagicTable.length > 0
                        ? `${localMagicTable.length} записей загружено`
                        : 'Нет данных — загрузите CSV с заклинаниями'}
                    </span>
                  </div>

                  {localMagicTable.length > 0 && (
                    <div className="max-h-48 overflow-y-auto fate-scroll rounded-lg border" style={{ borderColor: 'var(--fate-border)' }}>
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 z-10" style={{ backgroundColor: 'var(--fate-bg-card)' }}>
                          <tr style={{ borderBottom: '1px solid var(--fate-border)' }}>
                            <th className="text-left p-1.5 font-mono w-8" style={{ color: 'var(--fate-text-muted)' }}>#</th>
                            <th className="text-left p-1.5 font-semibold" style={{ color: 'var(--fate-text)' }}>Название</th>
                            <th className="text-left p-1.5 font-semibold" style={{ color: 'var(--fate-text)' }}>Стресс</th>
                          </tr>
                        </thead>
                        <tbody>
                          {localMagicTable.map((entry, idx) => (
                            <tr
                              key={idx}
                              className="transition-colors hover:bg-black/5 dark:hover:bg-white/5"
                              style={{ borderBottom: idx < localMagicTable.length - 1 ? '1px solid var(--fate-border)' : undefined }}
                            >
                              <td className="p-1.5 font-mono" style={{ color: 'var(--fate-text-muted)' }}>{idx + 1}</td>
                              <td className="p-1.5 font-medium truncate max-w-[180px]" style={{ color: 'var(--fate-text)' }}>{entry.name}</td>
                              <td className="p-1.5">
                                {entry.zoneStress !== undefined ? (
                                  <span
                                    className="inline-block px-1.5 py-0 rounded text-[10px] font-bold"
                                    style={{
                                      backgroundColor:
                                        entry.zoneStress <= -2 ? 'rgba(39, 174, 96, 0.12)' :
                                        entry.zoneStress === -1 ? 'rgba(39, 174, 96, 0.08)' :
                                        entry.zoneStress === 0 ? 'rgba(127, 140, 141, 0.08)' :
                                        entry.zoneStress === 1 ? 'rgba(243, 156, 18, 0.1)' :
                                        'rgba(231, 76, 60, 0.1)',
                                      color:
                                        entry.zoneStress <= -2 ? 'var(--fate-success)' :
                                        entry.zoneStress === -1 ? 'var(--fate-success)' :
                                        entry.zoneStress === 0 ? 'var(--fate-text-muted)' :
                                        entry.zoneStress === 1 ? '#f39c12' :
                                        'var(--fate-danger)',
                                    }}
                                  >
                                    {entry.zoneStress > 0 ? '+' : ''}{entry.zoneStress}
                                  </span>
                                ) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  <p className="text-[10px] pt-1" style={{ color: 'var(--fate-text-muted)' }}>
                    Формат CSV: название, эффект — или номер_карты, название, эффект.
                    После загрузки заклинания будут доступны через кнопку 🔮 Магия на панели.
                  </p>
                </div>
              )}
            </div>

            {/* Placeholder for future modules */}
            <div
              className="rounded-xl p-4 flex items-center gap-2.5 opacity-50"
              style={{ backgroundColor: 'var(--fate-bg-warm)', border: '1px solid var(--fate-border)' }}
            >
              <div
                className="fate-icon-circle"
                style={{ backgroundColor: 'rgba(52, 152, 219, 0.12)' }}
              >
                <span className="text-sm">🗺️</span>
              </div>
              <div>
                <h4 className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                  Расширенные зоны
                </h4>
                <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                  Скоро — дополнительные правила для зон на карте
                </p>
              </div>
              <Switch disabled aria-label="Модуль расширенных зон (скоро)" className="ml-auto" />
            </div>

            <div className="flex justify-end">
              <Button
                size="sm"
                onClick={handleSaveModules}
                className="fate-btn-accent gap-1.5 rounded-lg"
              >
                Сохранить модули
              </Button>
            </div>
          </TabsContent>

          {/* ── Stage Tab — theatrical roll overlay settings ───── */}
          <TabsContent value="stage" className="space-y-4 overflow-y-auto flex-1 min-h-0">
            <TheatricalModeSettings />
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" size="sm" className="rounded-lg" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Theatrical Mode Settings ────────────────────────────────
// Lives in the "Сцена" tab of SettingsDialog. Lets the user toggle
// theatrical mode on/off and adjust the overlay auto-dismiss duration.
function TheatricalModeSettings() {
  const enabled = useFateStore((s) => s.theatricalMode);
  const setTheatricalMode = useFateStore((s) => s.setTheatricalMode);
  const durationMs = useFateStore((s) => s.theatricalDurationMs);
  const setTheatricalDurationMs = useFateStore((s) => s.setTheatricalDurationMs);
  const diceMode = useFateStore((s) => s.diceMode);
  const setDiceMode = useFateStore((s) => s.setDiceMode);

  const seconds = durationMs / 1000;

  return (
    <div className="space-y-5">
      {/* Master toggle */}
      <div className="rounded-lg border p-4 space-y-2" style={{ borderColor: 'var(--fate-border)' }}>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold flex items-center gap-2">
              🎭 Театральный режим
            </div>
            <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
              Когда включён, каждый бросок проигрывается полноэкранной анимацией поверх интерфейса.
              Анимацию видят бросавший и все подключённые игроки. Выключите, если анимация
              затягивает игру — броски всё равно попадут в лог.
            </p>
          </div>
          <Button
            size="sm"
            variant={enabled ? 'default' : 'outline'}
            onClick={() => setTheatricalMode(!enabled)}
            className="shrink-0 rounded-lg"
            aria-pressed={enabled}
          >
            {enabled ? 'Включён' : 'Выключен'}
          </Button>
        </div>
      </div>

      {/* Dice mode toggle (3D physics vs 2D random) */}
      <div className="rounded-lg border p-4 space-y-3" style={{ borderColor: 'var(--fate-border)' }}>
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="text-sm font-semibold flex items-center gap-2">
              🎲 Режим кубиков
            </div>
            <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
              <strong>3D (по умолчанию):</strong> броски моделируются серверной физикой
              (Rapier3D) — кубики падают, отскакивают, кувыркаются. Нужно стабильное
              соединение с physics-сервисом.<br/>
              <strong>2D (резерв):</strong> мгновенный бросок через генератор случайных
              чисел. Используйте, если 3D-кубики тормозят или physics-сервис недоступен.
              Игра не прерывается — результаты тех же правил.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setDiceMode('3d')}
            className={`rounded-lg border-2 px-3 py-2.5 text-left transition-all ${
              diceMode === '3d'
                ? 'border-orange-400 bg-orange-50 dark:bg-orange-950/30'
                : 'border-transparent hover:border-orange-200'
            }`}
            style={{
              borderColor: diceMode === '3d' ? 'var(--fate-accent)' : 'var(--fate-border)',
              background: diceMode === '3d' ? 'rgba(230, 126, 34, 0.08)' : 'transparent',
            }}
            aria-pressed={diceMode === '3d'}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-base">🎲</span>
              <span className="text-sm font-semibold">3D физика</span>
              {diceMode === '3d' && (
                <span
                  className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded"
                  style={{ background: 'var(--fate-accent)', color: 'white' }}
                >
                  АКТИВНО
                </span>
              )}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--fate-text-muted)' }}>
              Rapier3D, 30 Hz, реальные отскоки
            </div>
          </button>
          <button
            type="button"
            onClick={() => setDiceMode('2d')}
            className={`rounded-lg border-2 px-3 py-2.5 text-left transition-all ${
              diceMode === '2d'
                ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30'
                : 'border-transparent hover:border-blue-200'
            }`}
            style={{
              borderColor: diceMode === '2d' ? '#3b82f6' : 'var(--fate-border)',
              background: diceMode === '2d' ? 'rgba(59, 130, 246, 0.08)' : 'transparent',
            }}
            aria-pressed={diceMode === '2d'}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-base">🔡</span>
              <span className="text-sm font-semibold">2D резерв</span>
              {diceMode === '2d' && (
                <span
                  className="ml-auto text-[10px] font-bold px-1.5 py-0.5 rounded"
                  style={{ background: '#3b82f6', color: 'white' }}
                >
                  АКТИВНО
                </span>
              )}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--fate-text-muted)' }}>
              Math.random, мгновенно
            </div>
          </button>
        </div>
      </div>

      {/* Dice color customization (10 colors for body + symbol) */}
      <DiceColorPicker />

      {/* Duration slider */}
      <div className={`rounded-lg border p-4 space-y-3 transition-opacity ${enabled ? '' : 'opacity-50 pointer-events-none'}`} style={{ borderColor: 'var(--fate-border)' }}>
        <div className="flex items-center justify-between">
          <div className="text-sm font-medium">Длительность анимации</div>
          <div className="text-sm font-semibold tabular-nums" style={{ color: 'var(--fate-accent)' }}>
            {seconds.toFixed(1)} с
          </div>
        </div>
        <input
          type="range"
          min={1500}
          max={6000}
          step={500}
          value={durationMs}
          onChange={(e) => setTheatricalDurationMs(Number(e.target.value))}
          className="w-full fate-stage-slider"
          aria-label="Длительность анимации броска"
        />
        <div className="flex justify-between text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
          <span>1.5 с (быстро)</span>
          <span>3.5 с (по умолчанию)</span>
          <span>6.0 с (драматично)</span>
        </div>
        <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
          Обычные проверки навыков используют короткую анимацию (~60% от этой длительности).
          Противостояния, совместные и массовые броски — полную.
        </p>
      </div>

      {/* Preview button */}
      <div className="rounded-lg border p-4 space-y-2" style={{ borderColor: 'var(--fate-border)' }}>
        <div className="text-sm font-medium">Предпросмотр</div>
        <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
          Запустить тестовую анимацию, чтобы оценить длительность и визуальный стиль.
        </p>
        <Button
          size="sm"
          variant="outline"
          className="rounded-lg gap-1.5"
          onClick={() => {
            // Build a synthetic preview event and enqueue it.
            const dice = [
              Math.floor(Math.random() * 3) - 1,
              Math.floor(Math.random() * 3) - 1,
              Math.floor(Math.random() * 3) - 1,
              Math.floor(Math.random() * 3) - 1,
            ];
            const diceSum = dice.reduce((a, b) => a + b, 0);
            const skillValue = 3;
            const total = diceSum + skillValue;
            const resultType = total < 0 ? 'fail' : total === 0 ? 'tie' : total >= 3 ? 'great' : 'success';
            const resultLabel = total < 0 ? 'Провал' : total === 0 ? 'Ничья' : total >= 3 ? 'Стиль!!' : 'Успех';
            useFateStore.getState().enqueueLiveRoll({
              id: `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              type: 'simple',
              rolledBy: 'Предпросмотр',
              rolledAt: Date.now(),
              title: 'Тестовая анимация',
              participants: [{
                id: 'preview-1',
                characterName: 'Тестовый персонаж',
                skillName: 'Бой',
                skillValue,
                dice,
                diceSum,
                total,
                resultLabel,
                resultType,
                role: 'roller',
              }],
            });
          }}
        >
          ▶ Запустить тест
        </Button>
      </div>
    </div>
  );
}
