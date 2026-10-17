'use client';

import { useState, useMemo } from 'react';
import {
  BookMarked,
  BookOpen,
  Flag,
  Map,
  Pin,
  PinOff,
  Plus,
  Search,
  ScrollText,
  Sparkles,
  Trash2,
  User,
  Wand2,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
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
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useFateStore } from '@/lib/store';
import type { Note, NoteCategory, NoteColor } from '@/lib/types';

interface NotesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Category metadata ───────────────────────────────────────
const CATEGORIES: { value: NoteCategory; label: string; icon: React.ElementType; color: string; tint: string }[] = [
  { value: 'session',  label: 'Сессия',        icon: ScrollText, color: '#e67e22', tint: 'rgba(230, 126, 34, 0.12)' },
  { value: 'lore',     label: 'Лор',           icon: BookOpen,   color: '#8e44ad', tint: 'rgba(142, 68, 173, 0.12)' },
  { value: 'npc',      label: 'NPC',           icon: User,       color: '#27ae60', tint: 'rgba(39, 174, 96, 0.12)' },
  { value: 'quest',    label: 'Задания',       icon: Flag,       color: '#c0392b', tint: 'rgba(192, 57, 43, 0.12)' },
  { value: 'handout',  label: 'Раздаточное',   icon: Map,        color: '#2980b9', tint: 'rgba(41, 128, 185, 0.12)' },
];

const COLORS: { value: NoteColor; bg: string; border: string }[] = [
  { value: 'default', bg: 'rgba(127, 140, 141, 0.06)', border: 'rgba(127, 140, 141, 0.3)' },
  { value: 'orange',  bg: 'rgba(230, 126, 34, 0.08)', border: 'rgba(230, 126, 34, 0.4)' },
  { value: 'green',   bg: 'rgba(39, 174, 96, 0.08)',  border: 'rgba(39, 174, 96, 0.4)' },
  { value: 'blue',    bg: 'rgba(52, 152, 219, 0.08)', border: 'rgba(52, 152, 219, 0.4)' },
  { value: 'purple',  bg: 'rgba(155, 89, 182, 0.08)', border: 'rgba(155, 89, 182, 0.4)' },
  { value: 'red',     bg: 'rgba(231, 76, 60, 0.08)',  border: 'rgba(231, 76, 60, 0.4)' },
];

function getCategoryMeta(cat: NoteCategory) {
  return CATEGORIES.find((c) => c.value === cat) ?? CATEGORIES[0];
}

function getColorMeta(color: NoteColor) {
  return COLORS.find((c) => c.value === color) ?? COLORS[0];
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// ── Minimal markdown renderer ─────────────────────────────────
// Supports: **bold**, *italic*, `code`, line breaks, - /* unordered
// lists, 1. ordered lists. Output is styled by `.fate-note-content`.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInlineMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
}

function renderNoteContent(text: string): string {
  const escaped = escapeHtml(text);
  const lines = escaped.split('\n');
  const html: string[] = [];
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) { html.push('</ul>'); inUl = false; }
    if (inOl) { html.push('</ol>'); inOl = false; }
  };

  for (const line of lines) {
    const ulMatch = line.match(/^\s*[-*]\s+(.*)$/);
    const olMatch = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ulMatch) {
      if (inOl) { html.push('</ol>'); inOl = false; }
      if (!inUl) { html.push('<ul>'); inUl = true; }
      html.push(`<li>${renderInlineMarkdown(ulMatch[1])}</li>`);
    } else if (olMatch) {
      if (inUl) { html.push('</ul>'); inUl = false; }
      if (!inOl) { html.push('<ol>'); inOl = true; }
      html.push(`<li>${renderInlineMarkdown(olMatch[1])}</li>`);
    } else {
      closeLists();
      if (line.trim() === '') {
        html.push('<br>');
      } else {
        html.push(`<p>${renderInlineMarkdown(line)}</p>`);
      }
    }
  }
  closeLists();
  return html.join('');
}

export function NotesDialog({ open, onOpenChange }: NotesDialogProps) {
  const {
    notes,
    currentAdventureId,
    createNote,
    updateNote,
    deleteNote,
  } = useFateStore();

  const [search, setSearch] = useState('');
  const [filterCat, setFilterCat] = useState<NoteCategory | 'all'>('all');
  const [editingNote, setEditingNote] = useState<Note | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState<NoteCategory>('session');
  const [editColor, setEditColor] = useState<NoteColor>('default');

  // Create form state
  const [newTitle, setNewTitle] = useState('');
  const [newContent, setNewContent] = useState('');
  const [newCategory, setNewCategory] = useState<NoteCategory>('session');
  const [newColor, setNewColor] = useState<NoteColor>('default');

  const filtered = useMemo(() => {
    return notes.filter((n) => {
      if (filterCat !== 'all' && n.category !== filterCat) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!n.title.toLowerCase().includes(q) && !n.content.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [notes, filterCat, search]);

  const handleStartCreate = () => {
    setNewTitle('');
    setNewContent('');
    setNewCategory(filterCat === 'all' ? 'session' : filterCat);
    setNewColor('default');
    setIsCreating(true);
  };

  const handleCreate = async () => {
    if (!newTitle.trim() || !currentAdventureId) return;
    await createNote({
      title: newTitle.trim(),
      content: newContent.trim(),
      category: newCategory,
      color: newColor,
      adventureId: currentAdventureId,
    });
    setIsCreating(false);
    setNewTitle('');
    setNewContent('');
  };

  const handleStartEdit = (note: Note) => {
    setEditingNote(note);
    setEditTitle(note.title);
    setEditContent(note.content);
    setEditCategory(note.category);
    setEditColor(note.color);
  };

  const handleSaveEdit = async () => {
    if (!editingNote) return;
    await updateNote(editingNote.id, {
      title: editTitle.trim(),
      content: editContent.trim(),
      category: editCategory,
      color: editColor,
    });
    setEditingNote(null);
  };

  const handleTogglePin = async (note: Note) => {
    await updateNote(note.id, { pinned: !note.pinned });
  };

  const handleDelete = async () => {
    if (!deleteConfirm) return;
    await deleteNote(deleteConfirm);
    setDeleteConfirm(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(142, 68, 173, 0.12)' }}
            >
              <BookMarked className="size-4" style={{ color: '#8e44ad' }} />
            </div>
            Журнал мастера
            {notes.length > 0 && (
              <>
                <span className="sr-only">
                  {notes.length}{' '}
                  {notes.length === 1
                    ? 'запись'
                    : notes.length >= 2 && notes.length <= 4
                      ? 'записи'
                      : 'записей'}
                </span>
                <Badge
                  aria-hidden="true"
                  className="text-xs h-5 px-2 font-semibold"
                  style={{ backgroundColor: 'rgba(142, 68, 173, 0.12)', color: '#8e44ad', border: 'none' }}
                >
                  {notes.length}
                </Badge>
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            Заметки, лор, задания и раздаточные материалы для приключения
          </DialogDescription>
        </DialogHeader>

        {/* Search & Category Filter Row */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[180px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5" style={{ color: 'var(--fate-text-muted)' }} />
            <Input
              placeholder="Поиск по заметкам..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-8 text-xs rounded-lg"
            />
          </div>
          {/* Category Filter Pills */}
          <div className="flex items-center gap-1 flex-wrap">
            <Button
              variant={filterCat === 'all' ? 'default' : 'outline'}
              size="sm"
              className="h-8 px-2.5 text-xs rounded-lg gap-1"
              style={filterCat === 'all' ? { backgroundColor: '#2c3e50', color: 'white' } : undefined}
              onClick={() => setFilterCat('all')}
            >
              Все
              <span className="text-[10px] opacity-70">{notes.length}</span>
            </Button>
            {CATEGORIES.map((c) => {
              const count = notes.filter((n) => n.category === c.value).length;
              const active = filterCat === c.value;
              return (
                <Button
                  key={c.value}
                  variant={active ? 'default' : 'outline'}
                  size="sm"
                  className="h-8 px-2.5 text-xs rounded-lg gap-1"
                  style={active ? { backgroundColor: c.color, color: 'white', border: 'none' } : { color: c.color, borderColor: `${c.color}40` }}
                  onClick={() => setFilterCat(c.value)}
                >
                  <c.icon className="size-3" />
                  {c.label}
                  {count > 0 && <span className="text-[10px] opacity-70">{count}</span>}
                </Button>
              );
            })}
          </div>
        </div>

        {/* Create New Note Card */}
        {isCreating ? (
          <div
            className="rounded-xl p-4 border-2 space-y-3 animate-slide-down"
            style={{ borderColor: '#8e44ad', backgroundColor: 'rgba(142, 68, 173, 0.03)' }}
          >
            <div className="flex items-center justify-between">
              <Label className="text-sm font-semibold flex items-center gap-1.5" style={{ color: '#8e44ad' }}>
                <Sparkles className="size-3.5" />
                Новая заметка
              </Label>
              <Button
                variant="ghost"
                size="icon"
                className="size-7 rounded-lg"
                onClick={() => setIsCreating(false)}
                aria-label="Закрыть форму"
                title="Закрыть"
              >
                <X className="size-3.5" />
              </Button>
            </div>
            <Input
              placeholder="Заголовок заметки..."
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              className="text-sm rounded-lg"
              autoFocus
            />
            <Textarea
              placeholder="Содержание заметки..."
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              className="text-sm rounded-lg min-h-[100px] resize-y"
            />
            <div className="flex items-center gap-3 flex-wrap">
              {/* Category */}
              <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>Категория:</span>
                {CATEGORIES.map((c) => (
                  <button
                    key={c.value}
                    onClick={() => setNewCategory(c.value)}
                    className="px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1 transition-all duration-150"
                    style={
                      newCategory === c.value
                        ? { backgroundColor: c.color, color: 'white' }
                        : { backgroundColor: c.tint, color: c.color }
                    }
                  >
                    <c.icon className="size-3" />
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>Цвет:</span>
              {COLORS.map((c) => (
                <button
                  key={c.value}
                  onClick={() => setNewColor(c.value)}
                  className="size-6 rounded-full border-2 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: c.bg,
                    borderColor: newColor === c.value ? c.border : 'transparent',
                    boxShadow: newColor === c.value ? `0 0 0 2px ${c.border}` : 'none',
                  }}
                />
              ))}
            </div>
            <div className="flex gap-2 justify-end pt-1">
              <Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => setIsCreating(false)}>
                Отмена
              </Button>
              <Button
                size="sm"
                className="rounded-lg text-xs gap-1.5 fate-btn-accent fate-button-shine"
                style={{ backgroundColor: '#8e44ad', color: 'white' }}
                disabled={!newTitle.trim()}
                onClick={handleCreate}
              >
                <Plus className="size-3.5" />
                Создать
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            className="w-full h-9 rounded-xl border-dashed text-xs gap-1.5 transition-all duration-200 hover:border-solid"
            style={{ color: '#8e44ad', borderColor: 'rgba(142, 68, 173, 0.4)' }}
            onClick={handleStartCreate}
          >
            <Plus className="size-3.5" />
            Создать новую заметку
          </Button>
        )}

        <Separator />

        {/* Notes List */}
        <ScrollArea className="flex-1 fate-scroll min-h-[300px]">
          <div className="space-y-2 pr-2">
            {filtered.length === 0 ? (
              <div className="text-center py-12 px-4 animate-fade-in">
                <div
                  className="size-16 mx-auto rounded-2xl flex items-center justify-center mb-3"
                  style={{ backgroundColor: 'rgba(142, 68, 173, 0.08)' }}
                >
                  <BookMarked className="size-8" style={{ color: '#8e44ad', opacity: 0.4 }} />
                </div>
                <p className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  {search || filterCat !== 'all' ? 'Ничего не найдено' : 'Нет заметок'}
                </p>
                <p className="text-xs mt-1" style={{ color: 'var(--fate-text-muted)', opacity: 0.6 }}>
                  {search || filterCat !== 'all' ? 'Измените фильтры поиска' : 'Создайте первую заметку, чтобы начать'}
                </p>
              </div>
            ) : (
              filtered.map((note) => {
                const meta = getCategoryMeta(note.category);
                const colorMeta = getColorMeta(note.color);

                // Editing this note
                if (editingNote?.id === note.id) {
                  return (
                    <div
                      key={note.id}
                      className="rounded-xl p-4 border-2 space-y-3 animate-scale-in"
                      style={{ borderColor: '#8e44ad', backgroundColor: 'rgba(142, 68, 173, 0.03)' }}
                    >
                      <div className="flex items-center justify-between">
                        <Label className="text-sm font-semibold" style={{ color: '#8e44ad' }}>
                          Редактирование
                        </Label>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 rounded-lg"
                          onClick={() => setEditingNote(null)}
                          aria-label="Закрыть форму"
                          title="Закрыть"
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>
                      <Input
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        className="text-sm rounded-lg"
                      />
                      <Textarea
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        className="text-sm rounded-lg min-h-[100px] resize-y"
                      />
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {CATEGORIES.map((c) => (
                          <button
                            key={c.value}
                            onClick={() => setEditCategory(c.value)}
                            className="px-2 py-1 rounded-md text-xs font-medium flex items-center gap-1 transition-all duration-150"
                            style={
                              editCategory === c.value
                                ? { backgroundColor: c.color, color: 'white' }
                                : { backgroundColor: c.tint, color: c.color }
                            }
                          >
                            <c.icon className="size-3" />
                            {c.label}
                          </button>
                        ))}
                      </div>
                      <div className="flex items-center gap-1.5">
                        {COLORS.map((c) => (
                          <button
                            key={c.value}
                            onClick={() => setEditColor(c.value)}
                            className="size-6 rounded-full border-2 transition-transform hover:scale-110"
                            style={{
                              backgroundColor: c.bg,
                              borderColor: editColor === c.value ? c.border : 'transparent',
                              boxShadow: editColor === c.value ? `0 0 0 2px ${c.border}` : 'none',
                            }}
                          />
                        ))}
                      </div>
                      <div className="flex gap-2 justify-end pt-1">
                        <Button variant="outline" size="sm" className="rounded-lg text-xs" onClick={() => setEditingNote(null)}>
                          Отмена
                        </Button>
                        <Button
                          size="sm"
                          className="rounded-lg text-xs gap-1.5 fate-btn-accent fate-button-shine"
                          style={{ backgroundColor: '#8e44ad', color: 'white' }}
                          disabled={!editTitle.trim()}
                          onClick={handleSaveEdit}
                        >
                          Сохранить
                        </Button>
                      </div>
                    </div>
                  );
                }

                // Display note
                return (
                  <div
                    key={note.id}
                    className="fate-list-item rounded-xl p-3 border transition-all duration-200 group relative"
                    style={{
                      backgroundColor: colorMeta.bg,
                      borderColor: colorMeta.border,
                      borderLeft: `3px solid ${meta.color}`,
                    }}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        <button
                          onClick={() => handleTogglePin(note)}
                          className="mt-0.5 shrink-0 transition-transform hover:scale-110"
                          title={note.pinned ? 'Открепить' : 'Закрепить'}
                          aria-label={note.pinned ? 'Открепить заметку' : 'Закрепить заметку'}
                          style={{ color: note.pinned ? meta.color : 'var(--fate-text-muted)', opacity: note.pinned ? 1 : 0.4 }}
                        >
                          {note.pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
                        </button>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h4 className="text-sm font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                              {note.title}
                            </h4>
                            <Badge
                              className="text-[10px] h-4 px-1.5 shrink-0 font-medium"
                              style={{
                                backgroundColor: meta.tint,
                                color: meta.color,
                                border: 'none',
                              }}
                            >
                              <meta.icon className="size-2.5 mr-0.5" />
                              {meta.label}
                            </Badge>
                            {note.pinned && (
                              <Badge className="text-[10px] h-4 px-1.5 shrink-0" style={{ backgroundColor: 'rgba(243, 156, 18, 0.12)', color: '#f39c12', border: 'none' }}>
                                📌
                              </Badge>
                            )}
                          </div>
                          {note.content && (
                            <div
                              className="fate-note-content text-xs mt-1"
                              dangerouslySetInnerHTML={{
                                __html: renderNoteContent(
                                  note.content.length > 240 ? note.content.slice(0, 240) + '…' : note.content,
                                ),
                              }}
                            />
                          )}
                          <p className="text-[10px] mt-1.5 opacity-60" style={{ color: 'var(--fate-text-muted)' }}>
                            {formatDate(note.updatedAt)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 shrink-0">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs rounded-lg"
                          style={{ color: 'var(--fate-text-muted)' }}
                          onClick={() => handleStartEdit(note)}
                          title="Редактировать"
                          aria-label="Редактировать заметку"
                        >
                          <Wand2 className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 rounded-lg"
                          style={{ color: 'var(--fate-danger)' }}
                          onClick={() => setDeleteConfirm(note.id)}
                          title="Удалить"
                          aria-label="Удалить заметку"
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </ScrollArea>

        {/* Delete Confirmation */}
        <Dialog open={!!deleteConfirm} onOpenChange={(o) => !o && setDeleteConfirm(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base fate-dialog-title">
                <div
                  className="fate-icon-circle"
                  style={{ backgroundColor: 'rgba(231, 76, 60, 0.12)' }}
                >
                  <Trash2 className="size-4" style={{ color: 'var(--fate-danger)' }} />
                </div>
                Удалить заметку?
              </DialogTitle>
              <DialogDescription>
                Это действие нельзя отменить. Заметка будет удалена навсегда.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" className="rounded-lg" onClick={() => setDeleteConfirm(null)}>
                Отмена
              </Button>
              <Button
                size="sm"
                className="rounded-lg"
                style={{ backgroundColor: 'var(--fate-danger)', color: 'white' }}
                onClick={handleDelete}
              >
                <Trash2 className="size-3.5 mr-1.5" />
                Удалить
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <DialogFooter>
          <Button variant="outline" size="sm" className="rounded-lg" onClick={() => onOpenChange(false)}>
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
