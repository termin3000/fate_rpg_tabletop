'use client';

import { useRef, useState } from 'react';
import { Dice5, Eye, EyeOff, Flame, Heart, ImageIcon, Minus, Plus, Shield, ShieldAlert, Sparkles, Star, Sword, Trash2, User, Wand2, Zap } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useFateStore } from '@/lib/store';
import type { Character, Consequence, Skill, Stunt, StressTrack } from '@/lib/types';
import { SkillRollDialog } from '@/components/fate/skill-roll-dialog';
import { CharacterAvatar } from '@/components/fate/character-avatar';

// Common emoji presets offered in the stress-track icon picker.
// Curated to cover the most common Fate stress types (physical, mental,
// armor, resource, crowd, etc.) so the GM can quickly set a meaningful icon.
const STRESS_ICON_PRESETS: string[] = [
  '❤️', '🧠', '💜', '✨', '🛡️', '⚔️', '🔥', '💧',
  '🌿', '☠️', '🩸', '💢', '⚡', '🩹', '💀', '👻',
  '👥', '🤖', '🐾', '🐉', '👁️', '🌑', '☀️', '⭐',
];

// Maximum length for a stress track name. Keeps the layout stable on the
// canvas and in the character sheet header.
const STRESS_NAME_MAX = 24;

interface CharacterSheetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  characterId: string | null;
  onSkillClick?: (characterId: string, skillName: string, skillValue: number) => void;
}

// Color palette for the avatar fallback background picker
const AVATAR_COLOR_PALETTE: string[] = [
  '#e67e22', // amber
  '#27ae60', // green
  '#e74c3c', // red
  '#f39c12', // orange
  '#8e44ad', // purple
  '#16a085', // teal
  '#c0392b', // dark red
  '#d35400', // dark orange
  '#0e6655', // very dark teal
  '#922b21', // very dark red
  '#7d3c98', // dark purple
  '#1a5276', // dark slate
];

// Section icon component with background circle
function SectionIcon({ icon: Icon, color }: { icon: React.ElementType; color: string }) {
  return (
    <div
      className="fate-icon-circle"
      style={{ backgroundColor: `${color}15` }}
    >
      <Icon className="size-4" style={{ color }} />
    </div>
  );
}

export function CharacterSheetDialog({ open, onOpenChange, characterId, onSkillClick }: CharacterSheetDialogProps) {
  const { getCharacter, updateCharacter, magicModuleEnabled, canEditCharacter, myAssignedCharacterIds } = useFateStore();
  const character = characterId ? getCharacter(characterId) : null;

  // ── Access control ───────────────────────────────────────────
  // Local users and the network host can edit every character. A network
  // player can only edit (and roll for) the characters assigned to them —
  // everyone else's sheet opens in read-only mode.
  const canEdit = characterId ? canEditCharacter(characterId) : true;
  const isMine = characterId ? myAssignedCharacterIds().includes(characterId) : false;

  const [isEditing, setIsEditing] = useState(false);
  const [editData, setEditData] = useState<Partial<Character>>({});

  // Skill roll dialog state
  const [skillRollOpen, setSkillRollOpen] = useState(false);
  const [skillRollData, setSkillRollData] = useState<{ name: string; value: number }>({ name: '', value: 0 });

  // Avatar upload
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const handleStartEdit = () => {
    if (!character) return;
    // Defense in depth: the "Редактировать" button is hidden when the user
    // can't edit this character, but if a stale render calls this handler
    // we no-op rather than enter edit mode for someone else's sheet.
    if (!canEdit) return;
    setEditData({
      name: character.name,
      concept: character.concept,
      problem: character.problem,
      aspects: [...character.aspects],
      skills: character.skills.map((s) => ({ ...s })),
      stunts: character.stunts.map((s) => ({ ...s })),
      stressTracks: character.stressTracks.map((t) => ({ ...t, markers: [...t.markers] })),
      consequences: character.consequences.map((c) => ({ ...c })),
      fatePoints: character.fatePoints,
      refresh: character.refresh,
      avatar: character.avatar,
      avatarColor: character.avatarColor,
      hiddenFromPlayers: character.hiddenFromPlayers,
    });
    setIsEditing(true);
  };

  const handleSave = async () => {
    if (!characterId || !editData) return;
    await updateCharacter(characterId, editData);
    setIsEditing(false);
    setEditData({});
  };

  const handleCancel = () => {
    setIsEditing(false);
    setEditData({});
  };

  // Avatar upload handler — converts image to a base64 data URL and stores it
  // directly in the character record. Resizes to a max of 256x256 to keep the
  // payload reasonable for SQLite storage.
  const handleAvatarUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) return;
    if (file.size > 5 * 1024 * 1024) {
      // 5 MB limit; skip silently if exceeded
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      const src = ev.target?.result;
      if (typeof src !== 'string') return;

      // Downscale large images via canvas to keep SQLite payload small.
      const img = new Image();
      img.onload = () => {
        const MAX = 256;
        let { width, height } = img;
        if (width > MAX || height > MAX) {
          const scale = Math.min(MAX / width, MAX / height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          // Fallback: store the raw data URL
          setEditData((d) => ({ ...d, avatar: src }));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        setEditData((d) => ({ ...d, avatar: dataUrl }));
      };
      img.onerror = () => {
        setEditData((d) => ({ ...d, avatar: src }));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const handleAvatarRemove = () => {
    setEditData((d) => ({ ...d, avatar: null }));
  };

  // Color picker for the avatar fallback background
  const handleAvatarColorPick = (color: string) => {
    setEditData((d) => ({ ...d, avatarColor: color, avatar: null }));
  };

  if (!character) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Персонаж не найден</DialogTitle>
            <DialogDescription>Выберите персонажа для просмотра листа</DialogDescription>
          </DialogHeader>
          <p className="text-sm" style={{ color: 'var(--fate-text-muted)' }}>
            Выберите персонажа для просмотра листа
          </p>
        </DialogContent>
      </Dialog>
    );
  }

  const displayData = isEditing ? { ...character, ...editData } : character;

  // Group skills by level for the pyramid display
  const skillsByLevel = (displayData.skills ?? []).reduce<Record<number, Skill[]>>(
    (acc, skill) => {
      if (!acc[skill.value]) acc[skill.value] = [];
      acc[skill.value].push(skill);
      return acc;
    },
    {},
  );

  const sortedLevels = Object.keys(skillsByLevel)
    .map(Number)
    .sort((a, b) => b - a);

  // Skill level color helper
  const getSkillLevelColor = (level: number) => {
    if (level >= 4) return 'var(--fate-accent)';
    if (level >= 2) return 'var(--fate-success)';
    return 'var(--fate-text-muted)';
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <SectionIcon icon={User} color="var(--fate-accent)" />
            {isEditing ? (
              <Input
                value={editData.name ?? ''}
                onChange={(e) => setEditData((d) => ({ ...d, name: e.target.value }))}
                className="h-7 text-lg font-semibold w-48 rounded-lg"
              />
            ) : (
              displayData.name
            )}
            {/* "ВЫ" badge — visible when this character is assigned to the
                current network player. Helps a player recognise their own PC
                when the host opens someone else's sheet on their screen. */}
            {isMine && !isEditing && (
              <span
                className="text-[9px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide shrink-0"
                style={{ color: 'white', backgroundColor: 'var(--fate-accent)' }}
                title="Ваш персонаж"
              >
                Вы
              </span>
            )}
            <span className="sr-only">
              ({displayData.type === 'player' ? 'Игрок' : 'NPC'})
            </span>
            <Badge
              aria-hidden="true"
              variant="outline"
              className="text-xs font-medium rounded-md"
              style={{
                borderColor: displayData.type === 'player' ? 'var(--fate-accent)' : 'var(--fate-success)',
                color: displayData.type === 'player' ? 'var(--fate-accent)' : 'var(--fate-success)',
                backgroundColor: displayData.type === 'player' ? 'rgba(230, 126, 34, 0.06)' : 'rgba(39, 174, 96, 0.06)',
              }}
            >
              {displayData.type === 'player' ? 'Игрок' : 'NPC'}
            </Badge>
            {/* Hidden from players toggle — positioned with extra margin to avoid close button */}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 ml-auto mr-10 shrink-0 rounded-lg transition-all duration-200 hover:scale-110 active:scale-95"
              style={{ color: displayData.hiddenFromPlayers ? 'var(--fate-text-muted)' : 'var(--fate-accent)', opacity: canEdit ? 1 : 0.4 }}
              onClick={() => {
                // Read-only when the user can't edit this character.
                if (!canEdit) return;
                const newValue = !displayData.hiddenFromPlayers;
                if (isEditing) {
                  setEditData((d) => ({ ...d, hiddenFromPlayers: newValue }));
                } else {
                  updateCharacter(characterId!, { hiddenFromPlayers: newValue });
                }
              }}
              disabled={!canEdit}
              title={canEdit ? (displayData.hiddenFromPlayers ? 'Показать игрокам' : 'Скрыть от игроков') : 'Недоступно для этого персонажа'}
              aria-label={displayData.hiddenFromPlayers ? 'Показать игрокам' : 'Скрыть от игроков'}
            >
              {displayData.hiddenFromPlayers ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </Button>
          </DialogTitle>
          <DialogDescription>Просмотр и редактирование характеристик персонажа</DialogDescription>
        </DialogHeader>

        {/* Read-only banner — shown when the current user can't edit this
            character (e.g. a network player viewing someone else's PC).
            The sheet below stays visible but every interactive control is
            either disabled or no-ops. */}
        {!canEdit && (
          <div
            className="rounded-lg p-3 flex items-start gap-3 animate-fade-in"
            style={{
              backgroundColor: 'rgba(230, 126, 34, 0.08)',
              border: '1px solid rgba(230, 126, 34, 0.25)',
            }}
          >
            <div
              className="size-8 rounded-full flex items-center justify-center shrink-0"
              style={{ backgroundColor: 'rgba(230, 126, 34, 0.15)' }}
            >
              <ShieldAlert className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold" style={{ color: 'var(--fate-accent)' }}>
                Просмотр без бросков
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--fate-text-muted)' }}>
                Вы можете просматривать лист персонажа, но не редактировать его.
              </p>
            </div>
          </div>
        )}

        <ScrollArea className="max-h-[65vh] pr-2">
          <div className="space-y-5">
            {/* Avatar / Portrait Section */}
            <div
              className="rounded-xl p-4 flex items-center gap-4"
              style={{
                background: 'linear-gradient(135deg, rgba(39, 174, 96, 0.06), rgba(230, 126, 34, 0.04))',
                border: '1px solid var(--fate-border)',
              }}
            >
              <CharacterAvatar
                name={displayData.name}
                avatar={displayData.avatar}
                avatarColor={displayData.avatarColor}
                size="xl"
                ring
              />
              <div className="flex-1 min-w-0">
                <Label className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                  Портрет персонажа
                </Label>
                <p className="text-sm mt-0.5" style={{ color: 'var(--fate-text)' }}>
                  {displayData.avatar
                    ? 'Загруженное изображение'
                    : displayData.avatarColor
                      ? 'Цветной фон с инициалом'
                      : 'Портрет не задан — будет показан инициал'}
                </p>
                {isEditing && (
                  <div className="flex flex-wrap items-center gap-2 mt-3">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-xs rounded-lg"
                      onClick={() => avatarInputRef.current?.click()}
                    >
                      <ImageIcon className="size-3" />
                      {displayData.avatar ? 'Заменить' : 'Загрузить'}
                    </Button>
                    {displayData.avatar && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 gap-1.5 text-xs rounded-lg"
                        onClick={handleAvatarRemove}
                        style={{ color: 'var(--fate-danger)' }}
                      >
                        <Trash2 className="size-3" />
                        Удалить
                      </Button>
                    )}
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      className="hidden"
                      onChange={handleAvatarUpload}
                    />
                  </div>
                )}
                {isEditing && !displayData.avatar && (
                  <div className="flex flex-wrap items-center gap-1.5 mt-2.5">
                    <span className="text-[10px] uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                      Или выберите цвет:
                    </span>
                    {AVATAR_COLOR_PALETTE.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className="size-5 rounded-full transition-all duration-150 hover:scale-125 focus:outline-none focus:ring-2 focus:ring-offset-1 focus:ring-orange-400"
                        style={{
                          backgroundColor: c,
                          outline: displayData.avatarColor === c ? '2px solid var(--fate-text)' : 'none',
                          outlineOffset: 1,
                        }}
                        onClick={() => handleAvatarColorPick(c)}
                        aria-label={`Цвет фона: ${c}`}
                        title={`Цвет ${c}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Fate Points & Refresh — Prominent Display */}
            <div
              className="rounded-xl p-4 flex items-center gap-6"
              style={{
                background: 'linear-gradient(135deg, rgba(230, 126, 34, 0.08), rgba(230, 126, 34, 0.03))',
                border: '1px solid rgba(230, 126, 34, 0.15)',
              }}
            >
              {/* Fate Points */}
              <div className="flex items-center gap-3">
                <div
                  className="size-12 rounded-full flex items-center justify-center shadow-sm"
                  style={{
                    background: 'linear-gradient(135deg, var(--fate-accent), var(--fate-accent-dark))',
                  }}
                >
                  <Sparkles className="size-5 text-white" />
                </div>
                <div>
                  <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                    Очки судьбы
                  </Label>
                  {isEditing ? (
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="size-7 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                        onClick={() => setEditData((d) => ({ ...d, fatePoints: Math.max(0, (d.fatePoints ?? 0) - 1) }))}
                      >
                        −
                      </Button>
                      <span className="text-2xl font-black w-8 text-center" style={{ color: 'var(--fate-accent)' }}>
                        {editData.fatePoints ?? 0}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="size-7 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                        onClick={() => setEditData((d) => ({ ...d, fatePoints: (d.fatePoints ?? 0) + 1 }))}
                      >
                        +
                      </Button>
                    </div>
                  ) : (
                    <p className="text-3xl font-black" style={{ color: 'var(--fate-accent)' }}>
                      {displayData.fatePoints}
                    </p>
                  )}
                </div>
              </div>

              {/* Refresh */}
              <div className="flex items-center gap-3">
                <div
                  className="size-10 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: 'rgba(44, 62, 80, 0.08)' }}
                >
                  <Zap className="size-4" style={{ color: 'var(--fate-text-muted)' }} />
                </div>
                <div>
                  <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                    Обновление
                  </Label>
                  {isEditing ? (
                    <Input
                      type="number"
                      value={editData.refresh ?? 0}
                      onChange={(e) => setEditData((d) => ({ ...d, refresh: parseInt(e.target.value) || 0 }))}
                      className="w-16 h-7 text-sm rounded-lg mt-0.5"
                    />
                  ) : (
                    <p className="text-xl font-bold" style={{ color: 'var(--fate-text)' }}>
                      {displayData.refresh}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Concept & Problem */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Концепт
                </Label>
                {isEditing ? (
                  <Input
                    value={editData.concept ?? ''}
                    onChange={(e) => setEditData((d) => ({ ...d, concept: e.target.value }))}
                    className="text-sm rounded-lg"
                  />
                ) : (
                  <p className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                    {displayData.concept || '—'}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Проблема
                </Label>
                {isEditing ? (
                  <Input
                    value={editData.problem ?? ''}
                    onChange={(e) => setEditData((d) => ({ ...d, problem: e.target.value }))}
                    className="text-sm rounded-lg"
                  />
                ) : (
                  <p className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                    {displayData.problem || '—'}
                  </p>
                )}
              </div>
            </div>

            {/* Crowd eligibility — NPC only, not for crowds themselves */}
            {displayData.type === 'npc' && !displayData.isHorde && (
              <div
                className="flex items-center gap-3 p-3 rounded-lg"
                style={{
                  backgroundColor: 'rgba(230, 126, 34, 0.05)',
                  border: '1px solid rgba(230, 126, 34, 0.15)',
                }}
              >
                <Checkbox
                  checked={displayData.crowdEligible ?? false}
                  disabled={!canEdit}
                  onCheckedChange={(checked) => {
                    if (!canEdit) return;
                    const val = !!checked;
                    if (isEditing) {
                      setEditData((d) => ({ ...d, crowdEligible: val }));
                    } else {
                      updateCharacter(characterId!, { crowdEligible: val });
                    }
                  }}
                  className="size-4 rounded"
                  style={{ borderColor: 'var(--fate-accent)' }}
                />
                <div>
                  <Label
                    className="text-xs font-medium cursor-pointer"
                    style={{ color: 'var(--fate-text)' }}
                    onClick={() => {
                      if (!canEdit) return;
                      const val = !(displayData.crowdEligible ?? false);
                      if (isEditing) {
                        setEditData((d) => ({ ...d, crowdEligible: val }));
                      } else {
                        updateCharacter(characterId!, { crowdEligible: val });
                      }
                    }}
                  >
                    Использовать в толпах
                  </Label>
                  <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                    Отметьте, чтобы NPC был доступен в редакторе толп
                  </p>
                </div>
              </div>
            )}

            {/* Mage checkbox — only visible when magic module is enabled */}
            {magicModuleEnabled && (
              <div
                className="flex items-center gap-3 p-3 rounded-lg"
                style={{
                  backgroundColor: 'rgba(155, 89, 182, 0.05)',
                  border: '1px solid rgba(155, 89, 182, 0.15)',
                }}
              >
                <Checkbox
                  checked={displayData.isMage ?? false}
                  disabled={!canEdit}
                  onCheckedChange={(checked) => {
                    if (!canEdit) return;
                    const val = !!checked;
                    if (isEditing) {
                      setEditData((d) => ({ ...d, isMage: val }));
                    } else {
                      updateCharacter(characterId!, { isMage: val });
                    }
                  }}
                  className="size-4 rounded"
                  style={{ borderColor: '#9b59b6' }}
                />
                <div>
                  <Label
                    className="text-xs font-medium cursor-pointer flex items-center gap-1.5"
                    style={{ color: 'var(--fate-text)' }}
                    onClick={() => {
                      if (!canEdit) return;
                      const val = !(displayData.isMage ?? false);
                      if (isEditing) {
                        setEditData((d) => ({ ...d, isMage: val }));
                      } else {
                        updateCharacter(characterId!, { isMage: val });
                      }
                    }}
                  >
                    <Wand2 className="size-3" style={{ color: '#9b59b6' }} />
                    Является магом
                  </Label>
                  <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                    Отметьте, если персонаж владеет разрушительной магией
                  </p>
                </div>
              </div>
            )}

            {/* Quick Stats Summary — at-a-glance overview */}
            {!isEditing && (
              <div
                className="grid grid-cols-4 gap-2 p-2.5 rounded-xl"
                style={{
                  background: 'linear-gradient(135deg, rgba(230,126,34,0.05), rgba(39,174,96,0.04))',
                  border: '1px solid var(--fate-border)',
                }}
              >
                {(() => {
                  const allSkills = displayData.skills ?? [];
                  const topSkill = allSkills.length > 0
                    ? allSkills.reduce((a, b) => a.value > b.value ? a : b)
                    : null;
                  const totalAspects = (displayData.aspects ?? []).filter(a => a && a.trim()).length;
                  const totalStunts = (displayData.stunts ?? []).length;
                  const totalStressMarked = (displayData.stressTracks ?? []).reduce(
                    (sum, t) => sum + (t.markers?.filter(Boolean).length ?? 0), 0
                  );
                  const totalStressBoxes = (displayData.stressTracks ?? []).reduce(
                    (sum, t) => sum + (t.markers?.length ?? 0), 0
                  );
                  const items = [
                    {
                      label: 'Навыков',
                      value: allSkills.length,
                      hint: topSkill ? `Лучш.: ${topSkill.name} +${topSkill.value}` : '—',
                      color: 'var(--fate-accent)',
                      bg: 'rgba(230, 126, 34, 0.1)',
                    },
                    {
                      label: 'Аспектов',
                      value: totalAspects,
                      hint: totalAspects >= 5 ? 'Полный набор' : 'Можно добавить',
                      color: '#9b59b6',
                      bg: 'rgba(155, 89, 182, 0.1)',
                    },
                    {
                      label: 'Трюков',
                      value: totalStunts,
                      hint: totalStunts >= 3 ? 'Хорошо развит' : 'Базовый набор',
                      color: '#2980b9',
                      bg: 'rgba(41, 128, 185, 0.1)',
                    },
                    {
                      label: 'Стресс',
                      value: `${totalStressMarked}/${totalStressBoxes}`,
                      hint: totalStressMarked === 0 ? 'Здоров' : 'Есть повреждения',
                      color: totalStressMarked > 0 ? '#e74c3c' : '#27ae60',
                      bg: totalStressMarked > 0 ? 'rgba(231, 76, 60, 0.1)' : 'rgba(39, 174, 96, 0.1)',
                    },
                  ];
                  return items.map((it, idx) => (
                    <div
                      key={it.label}
                      className="rounded-lg p-2 flex flex-col items-center text-center transition-transform duration-200 hover:scale-105 animate-fade-in"
                      style={{
                        backgroundColor: it.bg,
                        animationDelay: `${idx * 50}ms`,
                      }}
                      title={it.hint}
                    >
                      <span
                        className="text-lg font-black leading-none tabular-nums"
                        style={{ color: it.color }}
                      >
                        {it.value}
                      </span>
                      <span
                        className="text-[9px] font-semibold uppercase tracking-wide mt-1"
                        style={{ color: 'var(--fate-text-muted)' }}
                      >
                        {it.label}
                      </span>
                      <span
                        className="text-[9px] mt-0.5 leading-tight truncate w-full"
                        style={{ color: 'var(--fate-text-muted)', opacity: 0.7 }}
                      >
                        {it.hint}
                      </span>
                    </div>
                  ));
                })()}
              </div>
            )}

            <Separator />

            {/* Aspects */}
            <div className="space-y-2.5">
              <h3 className="text-sm font-semibold flex items-center gap-2 fate-section-header pb-2" style={{ color: 'var(--fate-text)' }}>
                <SectionIcon icon={Star} color="var(--fate-accent)" />
                Аспекты
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {(displayData.aspects ?? []).map((aspect, i) =>
                  isEditing ? (
                    <div key={i} className="flex items-center gap-1">
                      <Input
                        value={aspect}
                        onChange={(e) => {
                          const newAspects = [...(editData.aspects ?? [])];
                          newAspects[i] = e.target.value;
                          setEditData((d) => ({ ...d, aspects: newAspects }));
                        }}
                        className="text-xs h-7 w-40 rounded-lg"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-5 shrink-0 hover:scale-110 active:scale-90 transition-transform"
                        style={{ color: 'var(--fate-danger)' }}
                        onClick={() => {
                          const newAspects = (editData.aspects ?? []).filter((_, idx) => idx !== i);
                          setEditData((d) => ({ ...d, aspects: newAspects }));
                        }}
                      >
                        ×
                      </Button>
                    </div>
                  ) : (
                    <Badge
                      key={i}
                      variant="secondary"
                      className="text-xs rounded-lg px-2.5 py-0.5"
                      style={{ backgroundColor: 'var(--fate-bg-warm)', color: 'var(--fate-text)' }}
                    >
                      {aspect}
                    </Badge>
                  ),
                )}
                {isEditing && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7 gap-1 rounded-lg"
                    style={{ color: 'var(--fate-accent)' }}
                    onClick={() => {
                      setEditData((d) => ({ ...d, aspects: [...(d.aspects ?? []), ''] }));
                    }}
                  >
                    + Аспект
                  </Button>
                )}
                {!isEditing && (displayData.aspects ?? []).length === 0 && (
                  <p className="text-xs italic fate-empty-placeholder" style={{ color: 'var(--fate-text-muted)' }}>
                    Нет аспектов — нажмите «Редактировать» чтобы добавить
                  </p>
                )}
              </div>
            </div>

            <Separator />

            {/* Skills */}
            <div className="space-y-3">
              <h3 className="text-sm font-semibold flex items-center gap-2 fate-section-header pb-2" style={{ color: 'var(--fate-text)' }}>
                <SectionIcon icon={Shield} color="var(--fate-success)" />
                Навыки
              </h3>
              {isEditing ? (
                /* Edit mode: Clean grid layout for skill levels */
                <div className="space-y-2">
                  {(editData.skills ?? []).map((skill, i) => (
                    <div
                      key={skill.name + i}
                      className="flex items-center gap-2 p-2 rounded-lg"
                      style={{ backgroundColor: 'var(--fate-bg-card)' }}
                    >
                      <span className="text-xs w-28 truncate font-medium" style={{ color: 'var(--fate-text)' }}>
                        {skill.name}
                      </span>
                      <div className="flex items-center gap-0.5 flex-1">
                        {[-1, 0, 1, 2, 3, 4, 5].map((val) => (
                          <button
                            key={val}
                            type="button"
                            className={`size-7 rounded-md text-xs font-bold transition-all duration-150 ${
                              skill.value === val
                                ? 'text-white shadow-sm scale-105'
                                : 'hover:bg-black/5 active:scale-95'
                            }`}
                            style={skill.value === val ? {
                              backgroundColor: getSkillLevelColor(val),
                            } : { color: 'var(--fate-text-muted)' }}
                            onClick={() => {
                              const newSkills = [...(editData.skills ?? [])];
                              newSkills[i] = { ...newSkills[i], value: val };
                              setEditData((d) => ({ ...d, skills: newSkills }));
                            }}
                          >
                            {val >= 0 ? `+${val}` : val}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                /* View mode: Tiered grid layout with clear separation */
                <div className="space-y-2">
                  {sortedLevels.map((level) => {
                    const tierColor = getSkillLevelColor(level);
                    const tierBg = level >= 4
                      ? 'rgba(230, 126, 34, 0.06)'
                      : level >= 2
                        ? 'rgba(39, 174, 96, 0.06)'
                        : 'rgba(127, 140, 141, 0.04)';
                    const tierBorder = level >= 4
                      ? 'rgba(230, 126, 34, 0.2)'
                      : level >= 2
                        ? 'rgba(39, 174, 96, 0.2)'
                        : 'rgba(127, 140, 141, 0.12)';
                    const tierLabel = level >= 5 ? 'Легендарный' : level >= 4 ? 'Великий' : level >= 3 ? 'Хороший' : level >= 2 ? 'Средний' : level >= 1 ? 'Средний' : level >= 0 ? 'Посредственный' : 'Слабый';

                    return (
                      <div
                        key={level}
                        className="rounded-lg border overflow-hidden"
                        style={{ borderColor: tierBorder, backgroundColor: tierBg }}
                      >
                        {/* Tier header */}
                        <div
                          className="flex items-center gap-2 px-3 py-1.5"
                          style={{ borderBottom: `1px solid ${tierBorder}` }}
                        >
                          <span
                            className="text-xs font-bold min-w-[32px] text-center py-0.5 px-1.5 rounded-md shadow-sm"
                            style={{
                              backgroundColor: level >= 4 ? 'var(--fate-accent)' : level >= 2 ? 'var(--fate-success)' : 'var(--fate-bg-warm)',
                              color: level >= 2 ? 'white' : 'var(--fate-text)',
                            }}
                          >
                            +{level}
                          </span>
                          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: tierColor, opacity: 0.7 }}>
                            {tierLabel}
                          </span>
                          <span className="text-[10px] ml-auto" style={{ color: 'var(--fate-text-muted)', opacity: 0.5 }}>
                            {skillsByLevel[level].length} {skillsByLevel[level].length === 1 ? 'навык' : 'навыка'}
                          </span>
                        </div>
                        {/* Skills grid */}
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-2 gap-y-0.5 p-2">
                          {skillsByLevel[level].map((skill) => (
                            <button
                              key={skill.name}
                              type="button"
                              disabled={!canEdit}
                              className="group inline-flex items-center gap-1 cursor-pointer transition-all duration-150 hover:scale-105 active:scale-95 px-1.5 py-0.5 rounded-md hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:hover:scale-100 disabled:opacity-50"
                              onClick={() => {
                                if (!canEdit) return;
                                if (onSkillClick) {
                                  onSkillClick(characterId ?? '', skill.name, skill.value);
                                } else {
                                  setSkillRollData({ name: skill.name, value: skill.value });
                                  setSkillRollOpen(true);
                                }
                              }}
                              title={canEdit ? `Бросить ${skill.name} (+${skill.value})` : 'Недоступно для этого персонажа'}
                            >
                              <Badge
                                variant="outline"
                                className="text-xs rounded-md px-2 py-0.5 font-medium"
                                style={{
                                  borderColor: `${tierColor}30`,
                                  color: tierColor,
                                  backgroundColor: `${tierColor}08`,
                                }}
                              >
                                {skill.name}
                              </Badge>
                              <Dice5
                                className="size-3 opacity-0 group-hover:opacity-70 transition-opacity duration-150"
                                style={{ color: tierColor }}
                              />
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                  {sortedLevels.length === 0 && (
                    <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                      Нет навыков
                    </p>
                  )}
                </div>
              )}
            </div>

            <Separator />

            {/* Stunts */}
            <div className="space-y-2.5">
              <h3 className="text-sm font-semibold flex items-center gap-2 fate-section-header pb-2" style={{ color: 'var(--fate-text)' }}>
                <SectionIcon icon={Flame} color="#9b59b6" />
                Трюки
              </h3>
              {(displayData.stunts ?? []).length === 0 && !isEditing ? (
                <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                  Нет трюков
                </p>
              ) : (
                <div className="space-y-1.5">
                  {(displayData.stunts as Stunt[]).map((stunt, i) => (
                    <div
                      key={i}
                      className="fate-card-static rounded-lg p-2.5 text-xs"
                      style={{ backgroundColor: 'var(--fate-bg-warm)' }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex-1">
                          {isEditing ? (
                            <div className="space-y-1.5">
                              <Input
                                value={stunt.name}
                                onChange={(e) => {
                                  const newStunts = [...(editData.stunts ?? [])];
                                  newStunts[i] = { ...newStunts[i], name: e.target.value };
                                  setEditData((d) => ({ ...d, stunts: newStunts }));
                                }}
                                className="text-xs h-6 rounded-lg"
                                placeholder="Название трюка"
                              />
                              <Textarea
                                value={stunt.description}
                                onChange={(e) => {
                                  const newStunts = [...(editData.stunts ?? [])];
                                  newStunts[i] = { ...newStunts[i], description: e.target.value };
                                  setEditData((d) => ({ ...d, stunts: newStunts }));
                                }}
                                className="text-xs rounded-lg"
                                rows={2}
                                placeholder="Описание"
                              />
                            </div>
                          ) : (
                            <>
                              <span className="font-semibold" style={{ color: 'var(--fate-text)' }}>
                                {stunt.name}
                              </span>
                              {stunt.description && (
                                <p className="mt-0.5" style={{ color: 'var(--fate-text-muted)' }}>
                                  {stunt.description}
                                </p>
                              )}
                            </>
                          )}
                        </div>
                        {isEditing && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-5 shrink-0 hover:scale-110 active:scale-90 transition-transform"
                            style={{ color: 'var(--fate-danger)' }}
                            onClick={() => {
                              const newStunts = (editData.stunts ?? []).filter((_, idx) => idx !== i);
                              setEditData((d) => ({ ...d, stunts: newStunts }));
                            }}
                          >
                            ×
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                  {isEditing && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs gap-1 rounded-lg"
                      style={{ color: 'var(--fate-accent)' }}
                      onClick={() => {
                        setEditData((d) => ({ ...d, stunts: [...(d.stunts ?? []), { name: '', description: '' }] }));
                      }}
                    >
                      + Трюк
                    </Button>
                  )}
                </div>
              )}
            </div>

            <Separator />

            {/* Stress & Consequences */}
            <div className="space-y-4">
              {/* Stress Tracks */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold flex items-center gap-2 fate-section-header pb-2" style={{ color: 'var(--fate-text)' }}>
                  <SectionIcon icon={Heart} color="var(--fate-danger)" />
                  Стресс
                </h3>
                {(displayData.stressTracks ?? []).length === 0 && !isEditing ? (
                  <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                    Нет треков стресса
                  </p>
                ) : (
                  <div className="space-y-2">
                    {(displayData.stressTracks ?? []).map((track, ti) => (
                      <div
                        key={ti}
                        className="p-2.5 rounded-lg"
                        style={{ backgroundColor: 'var(--fate-bg-card)', border: '1px solid var(--fate-border)' }}
                      >
                        <div className="flex items-center justify-between mb-2 gap-2">
                          {isEditing ? (
                            <div className="flex items-center gap-1.5 min-w-0 flex-1">
                              {/* Icon picker — small popover button showing current icon */}
                              <Popover>
                                <PopoverTrigger asChild>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 w-9 p-0 shrink-0 rounded-md text-base"
                                    title="Выбрать иконку"
                                    aria-label="Выбрать иконку"
                                  >
                                    {track.icon || '■'}
                                  </Button>
                                </PopoverTrigger>
                                <PopoverContent className="w-56 p-2" align="start">
                                  <div className="grid grid-cols-8 gap-1">
                                    {STRESS_ICON_PRESETS.map((icon) => (
                                      <button
                                        key={icon}
                                        type="button"
                                        className="h-7 w-7 flex items-center justify-center rounded-md text-base transition-all hover:scale-110 hover:bg-accent"
                                        onClick={() => {
                                          const tracks = (editData.stressTracks ?? []).map((t, tidx) =>
                                            tidx === ti ? { ...t, icon } : t,
                                          );
                                          setEditData((d) => ({ ...d, stressTracks: tracks }));
                                        }}
                                        title={icon}
                                        aria-label={`Иконка ${icon}`}
                                      >
                                        {icon}
                                      </button>
                                    ))}
                                  </div>
                                  <div className="mt-2 flex items-center gap-1.5">
                                    <Input
                                      value={track.icon || ''}
                                      onChange={(e) => {
                                        const next = e.target.value.slice(0, 2);
                                        const tracks = (editData.stressTracks ?? []).map((t, tidx) =>
                                          tidx === ti ? { ...t, icon: next } : t,
                                        );
                                        setEditData((d) => ({ ...d, stressTracks: tracks }));
                                      }}
                                      placeholder="■"
                                      className="h-7 w-12 text-sm text-center rounded-md"
                                      maxLength={2}
                                    />
                                    <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                                      Своё (эмодзи/символ)
                                    </span>
                                  </div>
                                </PopoverContent>
                              </Popover>
                              {/* Name input */}
                              <Input
                                value={track.name}
                                onChange={(e) => {
                                  const next = e.target.value.slice(0, STRESS_NAME_MAX);
                                  const tracks = (editData.stressTracks ?? []).map((t, tidx) =>
                                    tidx === ti ? { ...t, name: next } : t,
                                  );
                                  setEditData((d) => ({ ...d, stressTracks: tracks }));
                                }}
                                placeholder="Название трека"
                                className="text-xs h-7 min-w-0 flex-1 rounded-md"
                                maxLength={STRESS_NAME_MAX}
                              />
                              {/* Type badge — non-editable, set at creation */}
                              <span
                                className="text-[9px] font-medium px-1.5 py-0.5 rounded shrink-0"
                                style={{
                                  color: 'var(--fate-text-muted)',
                                  backgroundColor: track.type === 'linear' ? 'rgba(230, 126, 34, 0.12)' : 'rgba(0,0,0,0.04)',
                                  border: `1px solid ${track.type === 'linear' ? 'rgba(230, 126, 34, 0.3)' : 'var(--fate-border)'}`,
                                }}
                                title={track.type === 'linear' ? 'Линейный: каждый маркер = 1 урон' : 'Прогрессивный: 1, 2, 3 урона'}
                              >
                                {track.type === 'linear' ? '1,1,1' : '1,2,3'}
                              </span>
                            </div>
                          ) : (
                            <span className="text-xs font-semibold flex items-center gap-1.5 min-w-0" style={{ color: 'var(--fate-text)' }}>
                              <span className="truncate">{track.icon} {track.name}</span>
                              <span
                                className="text-[9px] font-medium px-1.5 py-0.5 rounded shrink-0"
                                style={{
                                  color: 'var(--fate-text-muted)',
                                  backgroundColor: track.type === 'linear' ? 'rgba(230, 126, 34, 0.12)' : 'rgba(0,0,0,0.04)',
                                  border: `1px solid ${track.type === 'linear' ? 'rgba(230, 126, 34, 0.3)' : 'var(--fate-border)'}`,
                                }}
                                title={track.type === 'linear' ? 'Линейный: каждый маркер = 1 урон' : 'Прогрессивный: 1, 2, 3 урона'}
                              >
                                {track.type === 'linear' ? '1,1,1' : '1,2,3'}
                              </span>
                            </span>
                          )}
                          {isEditing && (
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-5 p-0 hover:scale-110 active:scale-90 transition-transform"
                                style={{ color: 'var(--fate-text-muted)' }}
                                onClick={() => {
                                  const tracks = [...(editData.stressTracks ?? [])];
                                  const t = { ...tracks[ti], markers: [...tracks[ti].markers] };
                                  if (t.markers.length > 1) {
                                    t.markers.pop();
                                    tracks[ti] = t;
                                    setEditData((d) => ({ ...d, stressTracks: tracks }));
                                  }
                                }}
                                disabled={(editData.stressTracks?.[ti]?.markers?.length ?? 0) <= 1}
                                title="Убрать поле стресса"
                              >
                                <Minus className="size-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-5 p-0 hover:scale-110 active:scale-90 transition-transform"
                                style={{ color: 'var(--fate-accent)' }}
                                onClick={() => {
                                  const tracks = [...(editData.stressTracks ?? [])];
                                  const t = { ...tracks[ti], markers: [...tracks[ti].markers] };
                                  t.markers.push(false);
                                  tracks[ti] = t;
                                  setEditData((d) => ({ ...d, stressTracks: tracks }));
                                }}
                                title="Добавить поле стресса"
                              >
                                <Plus className="size-3" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-5 p-0 hover:scale-110 active:scale-90 transition-transform"
                                style={{ color: 'var(--fate-danger)' }}
                                onClick={() => {
                                  const tracks = (editData.stressTracks ?? []).filter((_, idx) => idx !== ti);
                                  setEditData((d) => ({ ...d, stressTracks: tracks }));
                                }}
                                title="Удалить трек"
                              >
                                <Trash2 className="size-3" />
                              </Button>
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {track.markers.map((checked, mi) => (
                            <button
                              key={mi}
                              type="button"
                              disabled={!canEdit}
                              className="relative flex items-center justify-center transition-all duration-200 hover:scale-110 active:scale-95 disabled:cursor-not-allowed disabled:hover:scale-100"
                              onClick={() => {
                                // Read-only when the user can't edit this character.
                                if (!canEdit) return;
                                if (isEditing) {
                                  const tracks = (editData.stressTracks ?? []).map((t, tidx) => {
                                    if (tidx !== ti) return t;
                                    const newMarkers = [...t.markers];
                                    newMarkers[mi] = !newMarkers[mi];
                                    return { ...t, markers: newMarkers };
                                  });
                                  setEditData((d) => ({ ...d, stressTracks: tracks }));
                                } else {
                                  const tracks = character.stressTracks.map((t, tidx) => {
                                    if (tidx !== ti) return t;
                                    const newMarkers = [...t.markers];
                                    newMarkers[mi] = !newMarkers[mi];
                                    return { ...t, markers: newMarkers };
                                  });
                                  updateCharacter(characterId!, { stressTracks: tracks });
                                }
                              }}
                              title={canEdit ? `${track.name} ${track.type === 'progressive' ? mi + 1 : 1}${checked ? ' (отмечено)' : ''}` : 'Недоступно для этого персонажа'}
                              aria-label={`${track.name} ${track.type === 'progressive' ? mi + 1 : 1}${checked ? ' (отмечено)' : ''}`}
                              aria-pressed={checked}
                            >
                              <span
                                className="flex items-center justify-center rounded-md transition-all duration-200"
                                style={{
                                  width: 28,
                                  height: 28,
                                  backgroundColor: checked ? 'var(--fate-danger)' : 'transparent',
                                  border: `2px solid ${checked ? 'var(--fate-danger)' : 'var(--fate-border)'}`,
                                  color: checked ? 'white' : 'var(--fate-text-muted)',
                                }}
                              >
                                <span className="text-[10px] font-bold">
                                  {track.type === 'progressive' ? mi + 1 : 1}
                                </span>
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                    {isEditing && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-xs gap-1.5 rounded-lg w-full border-dashed"
                            style={{ color: 'var(--fate-accent)', borderColor: 'var(--fate-accent)' }}
                          >
                            <Plus className="size-3" />
                            Добавить трек стресса
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-72">
                          <DropdownMenuItem
                            onClick={() => {
                              const newTrack: StressTrack = {
                                name: 'Новый трек',
                                type: 'progressive',
                                icon: '■',
                                markers: [false, false, false],
                                showInTooltip: true,
                              };
                              setEditData((d) => ({
                                ...d,
                                stressTracks: [...(d.stressTracks ?? []), newTrack],
                              }));
                            }}
                          >
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold">Прогрессивный</span>
                                <span
                                  className="text-[9px] font-medium px-1.5 py-0.5 rounded"
                                  style={{ color: 'var(--fate-text-muted)', backgroundColor: 'rgba(0,0,0,0.04)', border: '1px solid var(--fate-border)' }}
                                >
                                  1,2,3
                                </span>
                              </div>
                              <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                                Классический Fate: маркеры 1, 2, 3 урона
                              </span>
                            </div>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              const newTrack: StressTrack = {
                                name: 'Новый трек',
                                type: 'linear',
                                icon: '■',
                                markers: [false, false, false],
                                showInTooltip: true,
                              };
                              setEditData((d) => ({
                                ...d,
                                stressTracks: [...(d.stressTracks ?? []), newTrack],
                              }));
                            }}
                          >
                            <div className="flex flex-col gap-0.5">
                              <div className="flex items-center gap-2">
                                <span className="text-xs font-semibold">Линейный</span>
                                <span
                                  className="text-[9px] font-medium px-1.5 py-0.5 rounded"
                                  style={{ color: 'rgba(230, 126, 34, 1)', backgroundColor: 'rgba(230, 126, 34, 0.12)', border: '1px solid rgba(230, 126, 34, 0.3)' }}
                                >
                                  1,1,1
                                </span>
                              </div>
                              <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                                Каждый маркер = 1 урон. Для слабых врагов и боссов с прочной бронёй
                              </span>
                            </div>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                )}
              </div>

              {/* Consequences */}
              <div className="space-y-3">
                <h3 className="text-sm font-semibold flex items-center gap-2 fate-section-header pb-2" style={{ color: 'var(--fate-text)' }}>
                  <SectionIcon icon={Sword} color="#e67e22" />
                  Последствия
                </h3>
                {(displayData.consequences ?? []).length === 0 && !isEditing ? (
                  <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                    Нет последствий
                  </p>
                ) : (
                  <div className="space-y-2">
                    {(displayData.consequences ?? []).map((consequence, ci) => {
                      const isTaken = !!consequence.description;
                      return (
                        <div
                          key={ci}
                          className="p-2.5 rounded-lg"
                          style={{
                            backgroundColor: isTaken ? 'rgba(231, 76, 60, 0.06)' : 'var(--fate-bg-card)',
                            border: `1px solid ${isTaken ? 'rgba(231, 76, 60, 0.2)' : 'var(--fate-border)'}`,
                          }}
                        >
                          <div className="flex items-center gap-2">
                            {/* Value badge */}
                            <span
                              className="text-[10px] font-bold px-1.5 py-0.5 rounded-md shrink-0"
                              style={{
                                backgroundColor: isTaken ? 'var(--fate-danger)' : 'var(--fate-bg-warm)',
                                color: isTaken ? 'white' : 'var(--fate-text-muted)',
                              }}
                            >
                              −{consequence.value}
                            </span>
                            {/* Consequence name (type label) */}
                            {isEditing ? (
                              <Input
                                value={consequence.name}
                                onChange={(e) => {
                                  const conqs = [...(editData.consequences ?? [])];
                                  conqs[ci] = { ...conqs[ci], name: e.target.value };
                                  setEditData((d) => ({ ...d, consequences: conqs }));
                                }}
                                className="text-xs h-6 w-24 rounded-lg"
                                placeholder="Тип"
                              />
                            ) : (
                              <span
                                className="text-xs font-semibold shrink-0"
                                style={{ color: isTaken ? 'var(--fate-danger)' : 'var(--fate-text-muted)' }}
                              >
                                {consequence.name}
                              </span>
                            )}
                            {/* Description input/display */}
                            {isEditing ? (
                              <Input
                                value={consequence.description ?? ''}
                                onChange={(e) => {
                                  const conqs = [...(editData.consequences ?? [])];
                                  conqs[ci] = { ...conqs[ci], description: e.target.value };
                                  setEditData((d) => ({ ...d, consequences: conqs }));
                                }}
                                className="text-xs h-6 flex-1 rounded-lg"
                                placeholder="Описание последствия..."
                              />
                            ) : (
                              <span
                                className="text-xs flex-1"
                                style={{
                                  color: isTaken ? 'var(--fate-text)' : 'var(--fate-text-muted)',
                                  fontStyle: isTaken ? 'normal' : 'italic',
                                }}
                              >
                                {consequence.description || '—'}
                              </span>
                            )}
                            {/* Healing checkbox */}
                            <div className="flex items-center gap-1 shrink-0">
                              <Checkbox
                                checked={consequence.healed}
                                disabled={(!isTaken && !isEditing) || !canEdit}
                                onCheckedChange={(checked) => {
                                  if (!canEdit) return;
                                  if (isEditing) {
                                    const conqs = [...(editData.consequences ?? [])];
                                    conqs[ci] = { ...conqs[ci], healed: !!checked };
                                    setEditData((d) => ({ ...d, consequences: conqs }));
                                  } else if (isTaken) {
                                    const conqs = character.consequences.map((c, idx) =>
                                      idx === ci ? { ...c, healed: !!checked } : c,
                                    );
                                    updateCharacter(characterId!, { consequences: conqs });
                                  }
                                }}
                                className="size-3.5"
                              />
                              <span
                                className="text-[9px]"
                                style={{
                                  color: consequence.healed ? 'var(--fate-success)' : 'var(--fate-text-muted)',
                                }}
                              >
                                🩹
                              </span>
                            </div>
                            {/* Delete button (edit mode only) */}
                            {isEditing && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="size-5 shrink-0 p-0 hover:scale-110 active:scale-90 transition-transform"
                                style={{ color: 'var(--fate-danger)' }}
                                onClick={() => {
                                  const conqs = (editData.consequences ?? []).filter((_, idx) => idx !== ci);
                                  setEditData((d) => ({ ...d, consequences: conqs }));
                                }}
                                title="Удалить последствие"
                              >
                                <Trash2 className="size-3" />
                              </Button>
                            )}
                          </div>
                          {consequence.healed && isTaken && (
                            <p
                              className="text-[10px] mt-1 ml-8"
                              style={{ color: 'var(--fate-success)', opacity: 0.8 }}
                            >
                              ✦ Восстановление начато
                            </p>
                          )}
                        </div>
                      );
                    })}
                    {isEditing && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-xs gap-1.5 rounded-lg w-full border-dashed"
                        style={{ color: 'var(--fate-accent)', borderColor: 'var(--fate-accent)' }}
                        onClick={() => {
                          const existingValues = (editData.consequences ?? []).map((c) => c.value);
                          // Default values: 2 (Mild), 4 (Moderate), 6 (Severe), 8 (Extreme)
                          const defaultValues = [2, 4, 6, 8];
                          let newValue = 2;
                          for (const v of defaultValues) {
                            if (!existingValues.includes(v)) {
                              newValue = v;
                              break;
                            }
                          }
                          const defaultNames: Record<number, string> = {
                            2: 'Лёгкое',
                            4: 'Среднее',
                            6: 'Тяжёлое',
                            8: 'Экстремальное',
                          };
                          const newConq: Consequence = {
                            name: defaultNames[newValue] || `Последствие (${newValue})`,
                            value: newValue,
                            description: '',
                            healed: false,
                          };
                          setEditData((d) => ({
                            ...d,
                            consequences: [...(d.consequences ?? []), newConq],
                          }));
                        }}
                      >
                        <Plus className="size-3" />
                        Добавить последствие
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </ScrollArea>

        {/* Skill Roll Dialog */}
        <SkillRollDialog
          open={skillRollOpen}
          onOpenChange={setSkillRollOpen}
          characterId={characterId}
          skillName={skillRollData.name || null}
          skillValue={skillRollData.value}
        />

        <DialogFooter>
          {isEditing ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="rounded-lg"
                onClick={handleCancel}
              >
                Отмена
              </Button>
              <Button
                size="sm"
                onClick={handleSave}
                className="fate-btn-accent fate-button-shine rounded-lg"
              >
                Сохранить
              </Button>
            </>
          ) : canEdit ? (
            <Button
              size="sm"
              variant="outline"
              onClick={handleStartEdit}
              className="rounded-lg transition-all duration-200 hover:shadow-sm"
            >
              Редактировать
            </Button>
          ) : (
            // Read-only viewers can't enter edit mode. Show a disabled
            // hint button so the footer doesn't look broken/empty.
            <Button
              size="sm"
              variant="outline"
              disabled
              className="rounded-lg"
              title="Недоступно для этого персонажа"
            >
              Только просмотр
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
