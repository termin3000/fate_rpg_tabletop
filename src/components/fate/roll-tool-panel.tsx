'use client';

/**
 * RollToolPanel — полноэкранная (внутри левого сайдбара) панель бросков.
 *
 * UX по запросу пользователя:
 *   «При нажатии на кнопку броска левая панель заменялась на меню броска —
 *    это даёт больше места для анимации кубиков и результата, особенно
 *    для бросков против сложности/противостояния. Нам же не всегда нужно
 *    иметь перед глазами список персонажей в сцене.»
 *
 * Архитектура:
 *   - Кнопка в шапке ScenePanel переключает режим: список → бросок.
 *   - В режиме броска ВСЁ содержимое левого сайдбара заменяется этой панелью.
 *   - Свой header с заголовком + кнопкой «назад к списку».
 *   - ScrollArea для контента, чтобы все поля помещались при любом режиме.
 *   - Сверху — selector персонажа (avatar + name + dropdown если несколько).
 *   - Рядом с именем — info icon: hover → tooltip со списком навыков.
 *   - 3 типа броска: Простой / Сложность / Противостояние.
 *   - Skill selector (берётся из навыков выбранного персонажа).
 *   - Difficulty input (если Сложность) или Opponent selector (если Противостояние).
 *   - Optional situational bonus.
 *   - Большая кнопка «Бросить кубики».
 *   - Результат показывается inline крупно (dice chips xl + total + label + кнопка reroll).
 *   - Если есть активный mass-roll request от GM — он показывается ПРИОРИТЕТНО.
 *
 * Логика броска переиспользует performRoll() из lib/fate-dice и
 * addLogEntry() из store — те же функции, что в CharacterRollDialog.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dices, Dice5, Swords, Shield, Check, X, Clock, Flame,
  RefreshCw, Crown, Plus, Gift, ChevronDown, ChevronUp,
  Info, Eye, UserCircle, Zap, Users, Sparkles,
  Handshake, UserPlus, Crosshair, Target,
  Feather, Scale, ArrowUp, Wind,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { MassRollInline } from '@/components/fate/mass-roll-inline';
import { MassDamageRollInline } from '@/components/fate/mass-damage-roll-inline';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { useFateStore } from '@/lib/store';
import { useNetwork } from '@/hooks/use-network';
import { performRoll } from '@/lib/fate-dice';
import { executeDiceRoll, executeVSRollSimultaneous, useDiceMode, type DiceRollRequest, type DiceRollOutcome } from '@/lib/roll-executor';
import { DEFAULT_SETTINGS } from '@/lib/types';
import type { Character, LiveRollEvent, LiveRollParticipant, RollResult } from '@/lib/types';
import { DiceChips } from '@/components/fate/dice-chips';
import { toast } from 'sonner';
// Shared skill normalization — single source of truth (see /lib/skills.ts).
// Fixes the recurring "only leveled skills shown" bug across all roll tools.
import { normalizeSkills } from '@/lib/skills';
import { formatCoopRollText, formatExtraBonusReason } from '@/lib/roll-format';
import { onRollGesture } from '@/lib/roll-gesture-bus';
import { cancelHeldBridge, clearSharedDiceBuffer } from '@/lib/held-dice-bus';
import {
  getPresetMeta,
  type RollGesture,
  type ThrowPresetId,
} from '@/lib/roll-gesture';

// ── Result label colors (match roll-invitation-panel) ─────────
const RESULT_COLORS: Record<string, string> = {
  'Стиль': '#9b59b6',
  'Успех': '#27ae60',
  'Ничья': '#f39c12',
  'Провал': '#e74c3c',
};

function resultBadgeStyle(label: string): React.CSSProperties {
  const color = RESULT_COLORS[label] ?? '#7f8c8d';
  return { backgroundColor: color, color: 'white', border: 'none' };
}

function formatTotal(total: number): string {
  return total >= 0 ? `+${total}` : String(total);
}

// ── Icon map for throw presets ─────────────────────────────────
// THROW_PRESETS_META хранит имя иконки как строку (чтобы lib/roll-gesture.ts
// не зависел от lucide-react). Здесь маппим строку → компонент.
const PRESET_ICONS: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  feather: Feather,
  scale: Scale,
  zap: Zap,
  'arrow-up': ArrowUp,
  wind: Wind,
};

// Режимы броска в боковом меню:
//  - check       — объединённый «обычный + против сложности» (чекбокс «без сложности»)
//  - opposed     — противостояние (в т.ч. против Безымянного NPC)
//  - cooperative — совместные усилия (один ведёт, остальные помогают +1)
//  - mass        — массовый бросок (GM приглашает нескольких участников)
type RollMode = 'check' | 'opposed' | 'cooperative' | 'mass';

// ── Main component ────────────────────────────────────────────
export function RollToolPanel({ onClose, massTrigger }: { onClose?: () => void; massTrigger?: number }) {
  const store = useFateStore();
  const {
    massRollState,
    networkMyPeerId,
    networkMyDisplayName,
    characters,
    settings,
    currentAdventureId,
    addLogEntry,
    getSceneCharacters,
    getCharacter,
    canRollForCharacter,
    myAssignedCharacterId,
    setMassRollReady,
  } = store;
  const { sendMassRollReady, sendMassRollAdjust, broadcastRollStage } = useNetwork();

  // ── Mass-roll request (priority over self-service) ──
  const myParticipant = useMemo(() => {
    if (!massRollState || !networkMyPeerId) return null;
    return massRollState.participants.find((p) => p.peerId === networkMyPeerId) ?? null;
  }, [massRollState, networkMyPeerId]);

  const hasActiveRequest = !!myParticipant;

  // If there's an active mass-roll request for me → show the request UI
  // (priority). Otherwise → show the self-service roll tool.
  if (hasActiveRequest) {
    return <MassRollRequestView myParticipant={myParticipant!} onClose={onClose} />;
  }
  return <SelfServiceRollTool onClose={onClose} massTrigger={massTrigger} />;
}

// ════════════════════════════════════════════════════════════════
// SELF-SERVICE ROLL TOOL
// ════════════════════════════════════════════════════════════════

function SelfServiceRollTool({ onClose, massTrigger }: { onClose?: () => void; massTrigger?: number }) {
  const store = useFateStore();
  const {
    characters,
    currentAdventureId,
    networkMyDisplayName,
    addLogEntry,
    getCharacter,
    canRollForCharacter,
    myAssignedCharacterId,
    currentSceneId,
    scenes,
    settings,
    addBonusToLogEntry,
    rerollLogEntry,
    updateCharacter,
  } = store;
  const { broadcastRollStage, sendRollStage } = useNetwork();
  const { canUsePhysics, canUse2DPhysics } = useDiceMode();

  // ── Available characters ──
  // For network players: only their assigned characters.
  // For host/offline: all scene characters (PCs + NPCs, including hidden —
  // GM can roll for anyone).
  const sceneCharacters = useMemo(() => {
    const scene = scenes.find((s) => s.id === currentSceneId);
    const roster = settings.playerRoster ?? [];
    const npcIds = scene?.presentCharacters ?? [];
    const visibleIds = new Set<string>([...roster, ...npcIds]);
    return characters.filter((c) => visibleIds.has(c.id));
  }, [characters, scenes, currentSceneId, settings.playerRoster]);

  const myAssignedIds = useMemo(() => {
    const id = myAssignedCharacterId();
    return id ? [id] : [];
  }, [myAssignedCharacterId]);

  const availableChars: Character[] = useMemo(() => {
    // For network players: only assigned chars. For host/offline: all scene chars.
    const candidates = myAssignedIds.length > 0
      ? characters.filter((c) => myAssignedIds.includes(c.id))
      : sceneCharacters;
    // canRollForCharacter returns true for host/offline, and checks assignment
    // for network players. Don't filter by hiddenFromPlayers here — GM should
    // be able to roll for hidden NPCs (player-mode filtering happens elsewhere).
    return candidates.filter((c) => canRollForCharacter(c.id));
  }, [myAssignedIds, characters, sceneCharacters, canRollForCharacter]);

  // ── Selected character ──
  // Default: my assigned char, or first available, or null
  const [selectedCharId, setSelectedCharId] = useState<string | null>(
    myAssignedIds[0] ?? availableChars[0]?.id ?? null
  );

  // Auto-select first available if none selected
  if (!selectedCharId && availableChars.length > 0) {
    setSelectedCharId(availableChars[0].id);
  }

  const selectedChar = useMemo(
    () => (selectedCharId ? getCharacter(selectedCharId) : null),
    // Зависимость от characters — чтобы selectedChar пересчитывался при
    // обновлении персонажа (например, после траты очка судьбы через призыв
    // аспекта). Без этого selectedChar.fatePoints остаётся stale.
    [selectedCharId, getCharacter, characters]
  );

  // ── Roll config ──
  // 'check' объединяет обычный бросок и бросок против сложности:
  // чекбокс noDifficulty (по умолчанию выключен = сложность учитывается).
  const [rollMode, setRollMode] = useState<RollMode>('check');
  const [noDifficulty, setNoDifficulty] = useState(false);
  const [selectedSkillName, setSelectedSkillName] = useState<string>('');
  const [difficulty, setDifficulty] = useState(2);
  const [opponentId, setOpponentId] = useState<string>('');
  const [opponentSkillName, setOpponentSkillName] = useState<string>('');
  const [bonus, setBonus] = useState(0);

  // ── Throw style — Test window REMOVED ──
  // Раньше был throwMode='auto'|'manual' + manualPreset selector (5 кнопок).
  // По просьбе пользователя test-окно «Стиль броска» удалено. presetId теперь
  // ВСЕГДА берётся из gesture:
  //   • drag-бросок  → из скорости взмаха (velocityToPreset в RollGestureProvider).
  //   • кнопка-бросок → из emitRandomThrowGesture (взвешенный random:
  //     25% gentle / 30% normal / 30% power / 15% lob — для variety).
  // ── Opposed mode: «Безымянный NPC» — бросок против абстрактного
  // противника с фиксированным навыком (например, стражник с Внимательностью +2).
  // Когда чекбокс включён, выбор персонажа-противника блокируется.
  const [unnamedNpc, setUnnamedNpc] = useState(false);
  const [unnamedNpcSkill, setUnnamedNpcSkill] = useState<string>('');
  const [unnamedNpcBonus, setUnnamedNpcBonus] = useState(2);
  // ── Cooperative roll: list of helper participant IDs (excluding the main roller) ──
  const [coopParticipantIds, setCoopParticipantIds] = useState<string[]>([]);

  // ── Mass tab sub-mode: 'roll' (GM-only массовый бросок) vs 'damage' (массовый урон, для всех) ──
  const [massSubMode, setMassSubMode] = useState<'roll' | 'damage'>('damage');

  // ── Внешний триггер массового броска (шапка / Cmd+K / горячая клавиша M):
  //    переключает на вкладку «Масс.» при каждом изменении massTrigger.
  //    Паттерн «adjusting state during render» (React docs) — без useEffect. ──
  const [prevMassTrigger, setPrevMassTrigger] = useState(0);
  if (massTrigger && massTrigger > prevMassTrigger) {
    setPrevMassTrigger(massTrigger);
    setRollMode('mass');
  }

  // ── Result ──
  // For opposed rolls, we store both attacker and opponent results so we can
  // render a dual result panel (two dice rows + two totals) that matches the
  // competitive-roll visual language from CharacterRollDialog.
  const [lastResult, setLastResult] = useState<{
    dice: number[];
    total: number;
    label: string;
    type: RollResult['type'];
    skillName: string;
    skillValue: number;
    charName: string;
    // Opponent (opposed mode only):
    opponentDice?: number[];
    opponentTotal?: number;
    opponentName?: string;
    opponentSkillName?: string;
    opponentSkillValue?: number;
    // Cooperative mode: helper results (each helper contributes a passive +1
    // if their skill value > 0 — no dice roll for helpers anymore).
    helpers?: { name: string; skillValue: number; success: boolean }[];
    /** True if the result came from 3D physics (overlay already showed the
     *  dice). When true, the inline panel renders COMPACT (just total + label)
     *  instead of the big dice-chips block — avoids visual duplication. */
    usedPhysics?: boolean;
    /** ID of the log entry created by this roll. Used to apply aspect invoke
     *  (bonus / reroll) directly to the result after the roll completes. */
    logEntryId?: string;
    /** Aspect invoke bonus applied post-roll (via «Призвать аспект»). */
    aspectInvokeBonus?: number;
    /** Which aspect(s) were invoked (comma-separated reasons). */
    aspectInvokeReason?: string;
    /** True if the dice were rerolled via aspect invoke. */
    aspectRerolled?: boolean;
    /** How many FREE invocations were applied (no FP cost). */
    aspectFreeInvokeCount?: number;
    /** Preset физики броска, использованный в этом броске (test feature:
     *  для сравнения стилей). Показывается бейджем в результате. */
    presetUsed?: ThrowPresetId;
  } | null>(null);
  const [isRolling, setIsRolling] = useState(false);
  // Dual rolling animation: separate dice arrays for attacker and opponent.
  const [rollingDice, setRollingDice] = useState<number[]>([0, 0, 0, 0]);
  const [rollingOpponentDice, setRollingOpponentDice] = useState<number[]>([0, 0, 0, 0]);

  // ── Animate rolling dice (attacker + opponent in opposed mode) ──
  React.useEffect(() => {
    if (!isRolling) return;
    const interval = setInterval(() => {
      const rand4 = () => [
        Math.floor(Math.random() * 3) - 1,
        Math.floor(Math.random() * 3) - 1,
        Math.floor(Math.random() * 3) - 1,
        Math.floor(Math.random() * 3) - 1,
      ];
      setRollingDice(rand4());
      if (rollMode === 'opposed' && opponentId) {
        setRollingOpponentDice(rand4());
      }
    }, 80);
    return () => clearInterval(interval);
  }, [isRolling, rollMode, opponentId]);

  // ── Available skills for selected character ──
  // Normalize against the adventure's baseSkills so ALL skills are pickable
  // (even +0). Some legacy NPCs only store leveled skills in the DB.
  const baseSkillNames = useMemo(
    () => settings.baseSkills?.length ? settings.baseSkills : DEFAULT_SETTINGS.baseSkills,
    [settings.baseSkills],
  );
  const availableSkills = useMemo(() => {
    if (!selectedChar) return [];
    return normalizeSkills(selectedChar.skills, baseSkillNames);
  }, [selectedChar, baseSkillNames]);

  // Auto-select first skill when character changes
  React.useEffect(() => {
    if (availableSkills.length > 0 && !availableSkills.find((s) => s.name === selectedSkillName)) {
      setSelectedSkillName(availableSkills[0].name);
    }
  }, [availableSkills, selectedSkillName]);

  // ── Opponent options (all scene characters except selected) ──
  const opponentOptions = useMemo(() => {
    return sceneCharacters.filter((c) => c.id !== selectedCharId);
  }, [sceneCharacters, selectedCharId]);

  const selectedSkillValue = useMemo(() => {
    if (!selectedChar || !selectedSkillName) return 0;
    return availableSkills.find((s) => s.name === selectedSkillName)?.value ?? 0;
  }, [availableSkills, selectedSkillName]);

  // ── Opponent character + skills (opposed mode) ──
  const opponentChar = useMemo(
    () => (opponentId ? getCharacter(opponentId) : null),
    [opponentId, getCharacter]
  );
  const opponentSkills = useMemo(() => {
    if (!opponentChar) return [];
    return normalizeSkills(opponentChar.skills, baseSkillNames);
  }, [opponentChar, baseSkillNames]);
  const opponentSkillValue = useMemo(() => {
    if (!opponentChar || !opponentSkillName) return 0;
    return opponentSkills.find((s) => s.name === opponentSkillName)?.value ?? 0;
  }, [opponentSkills, opponentSkillName]);

  // Auto-select first opponent skill when opponent changes
  React.useEffect(() => {
    if (opponentSkills.length > 0 && !opponentSkills.find((s) => s.name === opponentSkillName)) {
      setOpponentSkillName(opponentSkills[0].name);
    }
  }, [opponentSkills, opponentSkillName]);

  // ── Cooperative roll: available helpers (everyone except main roller) ──
  const coopHelperOptions = useMemo(
    () => sceneCharacters.filter((c) => c.id !== selectedCharId),
    [sceneCharacters, selectedCharId]
  );
  const toggleCoopParticipant = (id: string) => {
    setCoopParticipantIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  };

  // ── Handle roll ──
  // gesture?: RollGesture — передаётся из жест-броска (drag кубов из кейса
  // на карту) или из кнопка-броска (emitRandomThrowGesture в DiceStation).
  // Содержит originSide/originX (направление) + swingVelocity/presetId (сила).
  // Если undefined — защита от старых вызовов (defaults: near, originX=0, power).
  //
  // presetId берётся из gesture.presetId (или fallback 'power'). Раньше был
  // throwMode='auto'|'manual' + manualPreset — удалено вместе с test-окном.
  const handleRoll = async (gesture?: RollGesture) => {
    if (!selectedChar) {
      // ── Clean up held-dice from the drag gesture ──
      // When the player drags dice from the case and releases, the
      // RollGestureProvider emits a gesture → handleRoll is called. If we
      // bail here (no character selected — common for network players whose
      // assignment hasn't arrived yet), the 3D held-dice bridge would keep
      // the dice visible on the table for ~400ms (BRIDGE_MAX_MS). The user
      // perceives this as "dice hung on the table but roll not counted".
      // Cancel the bridge + clear the shared buffer immediately so the dice
      // disappear the instant we decide not to roll.
      cancelHeldBridge();
      clearSharedDiceBuffer();
      toast.error('Выберите персонажа', {
        description: 'Ожидание назначения персонажа мастером…',
        duration: 4000,
      });
      return;
    }
    if (availableSkills.length > 0 && !selectedSkillName) {
      cancelHeldBridge();
      clearSharedDiceBuffer();
      toast.error('Выберите навык');
      return;
    }
    if (rollMode === 'opposed' && !unnamedNpc && !opponentId) {
      cancelHeldBridge();
      clearSharedDiceBuffer();
      toast.error('Выберите противника');
      return;
    }

    setLastResult(null);

    // ── Throw preset selection ──
    // presetId берётся из gesture (вычислен в RollGestureProvider для drag-броска
    // или в emitRandomThrowGesture для кнопка-броска — взвешенный random:
    // 25% gentle / 30% normal / 30% power / 15% lob). Если gesture без presetId
    // (маловероятно, но безопасно) → fallback на 'power'.
    // Раньше был throwMode='auto'|'manual' с ручным выбором пресета — удалено
    // вместе с test-окном «Стиль броска» (см. комментарий ниже в JSX).
    const effectivePresetId: ThrowPresetId = gesture?.presetId ?? 'power';

    // ── 3D vs 2D branching ──
    // В 3D-режиме: НЕ играем 2D blink-анимацию — серверная Rapier3D физика
    //   И ЕСТЬ анимация (кубы кувыркаются на карте в overlay).
    // В 2D-режиме с физикой (canUse2DPhysics): ТОЖЕ НЕ играем blink —
    //   локальная 2D-физика показывает кувыркающиеся плитки на карте.
    //   Blink здесь конкурировал бы с map-физикой и путал игрока
    //   («слева мигают chips, в центре кувыркаются 2D-плитки»).
    // Полный fallback (нет ни 3D, ни 2D физики): играем blink ~500–700мс —
    //   это единственная анимация в этом режиме.
    if (canUsePhysics || canUse2DPhysics) {
      // 3D или 2D-физика — пропускаем blink, сразу к физике.
      // isRolling=false → блок 2D dice-chips анимации остаётся скрытым.
      // Map overlay (3D кубы ИЛИ 2D плитки) обеспечивает весь визуальный фидбек.
    } else {
      // Полный fallback (мгновенный performRoll) — играем локальный blink.
      setIsRolling(true);
      const hasOpponent = rollMode === 'opposed' && (unnamedNpc || !!opponentId);
      const animDelay = hasOpponent ? 700 : 500;
      await new Promise((r) => setTimeout(r, animDelay));
    }

    try {
      // ── Сложность: только в режиме 'check' и если чекбокс «без сложности» снят ──
      const diff = rollMode === 'check' && !noDifficulty ? difficulty : null;

      // ── Противостояние: ОДНОВРЕМЕННЫЙ VS бросок (3D) ──
      // В 3D-режиме оба участника бросают одновременно с разных сторон арены:
      // ролик с near (ближний край), оппонент с far (дальний край). Кубы летят
      // навстречу и приземляются в центре — результат виден по кубам на столе
      // + в логе. Окно с результатом НЕ показывается.
      // В 2D-режиме fallback на последовательный бросок.
      let opponentTotal: number | null = null;
      let oppChar: Character | null = null;
      let oppOutcome: DiceRollOutcome | null = null;
      let result: DiceRollOutcome | null = null;
      let oppSkillName = '';
      let oppSkillVal = 0;
      let oppDisplayName: string | null = null;
      let coopHelpers: { name: string; skillValue: number; success: boolean }[] = [];
      let coopBonus = 0;

      // ── persistResult: запись в лог + обновление UI ──
      // Вызывается либо из onResult callback (3D путь — ДО hold-таймера,
      // пока кубы ещё на столе), либо явно после executeDiceRoll (2D путь).
      // Замыкание читает переменные (coopBonus, oppDisplayName, ...) ПО
      // ЗНАЧЕНИЮ В МОМЕНТ ВЫЗОВА, а не в момент определения — поэтому к
      // этому моменту они уже содержат актуальные значения (установленные
      // в блоке if/else ниже).
      const persistResult = async (r: DiceRollOutcome, opp: DiceRollOutcome | null) => {
        const effectiveBonus = selectedSkillValue + bonus + coopBonus;

        setLastResult({
          dice: r.dice,
          total: r.total,
          label: r.label,
          type: r.type,
          skillName: selectedSkillName || `Бонус +${effectiveBonus}`,
          skillValue: selectedSkillValue,
          charName: selectedChar.name,
          opponentDice: opp?.dice,
          opponentTotal: opp?.total,
          opponentName: oppDisplayName ?? undefined,
          opponentSkillName: oppSkillName || undefined,
          opponentSkillValue: oppSkillVal,
          helpers: coopHelpers.length > 0 ? coopHelpers : undefined,
          usedPhysics: r.usedPhysics,
          presetUsed: effectivePresetId,
        });

        // ── Лог броска ──
        // Единый формат логов для ВСЕХ режимов броска (совпадает с листом
        // персонажа). helpers + customText формируются через общий helper
        // formatCoopRollText / formatExtraBonusReason — чтобы блок бросков и
        // лист персонажа писали в лог абсолютно одинаково.
        const hasOpp = !!(opp && oppDisplayName);
        const opponentBonus = opp ? opp.total - opp.diceSum : 0;
        const extraBonusReason = formatExtraBonusReason(bonus);

        const customText = formatCoopRollText(
          selectedChar.name,
          selectedSkillValue,
          coopHelpers.map((h) => ({ name: h.name, skillValue: h.skillValue, bonus: h.success ? 1 : 0 }))
        );

        const logEntryId = await addLogEntry({
          adventureId: currentAdventureId ?? undefined,
          characterId: selectedChar.id,
          characterName: selectedChar.name,
          skillName: selectedSkillName || `Бонус +${effectiveBonus}`,
          diceResults: r.dice,
          bonus: selectedSkillValue + bonus + coopBonus,
          total: r.total,
          difficulty: diff,
          opponentTotal: opp ? opp.total : opponentTotal,
          result: r.label,
          // ── Противостояние ──
          opponentType: hasOpp ? 'character' : null,
          opponentCharacterId: oppChar?.id ?? null,
          opponentName: hasOpp ? oppDisplayName : null,
          opponentSkillName: hasOpp ? (oppSkillName || null) : null,
          opponentDiceResults: opp?.dice ?? [],
          opponentBonus,
          opponentSkillValue: hasOpp ? oppSkillVal : null,
          opponentManualBonus: 0,
          // ── Бонусы / аспекты ──
          extraBonus: bonus,
          extraBonusReason,
          rerolled: false,
          customText,
          isRiftEvent: false,
          // ── Rich-tooltip поля ──
          skillValue: selectedSkillValue || null,
          manualBonus: bonus,
          helpers: coopHelpers.map((h) => ({
            name: h.name,
            skillName: selectedSkillName || '',
            skillValue: h.skillValue,
            bonus: h.success ? 1 : 0,
          })),
          aspectInvokeBonus: 0,
          aspectInvokeReason: '',
          aspectRerolled: false,
        });

        // Запоминаем ID записи лога, чтобы можно было применить призыв
        // аспекта (+2 / переброс) к результату сразу после броска.
        setLastResult((prev) => prev ? { ...prev, logEntryId } : prev);
      };

      if (rollMode === 'opposed') {
        // Подготовка данных оппонента
        if (unnamedNpc) {
          oppSkillName = unnamedNpcSkill || 'Навык';
          oppSkillVal = unnamedNpcBonus;
          oppDisplayName = 'Безымянный NPC';
        } else if (opponentId) {
          oppChar = getCharacter(opponentId);
          if (oppChar) {
            oppSkillName = opponentSkillName || opponentSkills[0]?.name || selectedSkillName;
            oppSkillVal = oppChar.skills.find((s) => s.name === oppSkillName)?.value ?? 0;
            oppDisplayName = oppChar.name;
          }
        }

        if (oppDisplayName && canUsePhysics) {
          // ── 3D: ОДНОВРЕМЕННЫЙ VS бросок ──
          const rollerRequest: DiceRollRequest = {
            characterName: selectedChar.name,
            characterId: selectedChar.id,
            skillName: selectedSkillName,
            skillValue: selectedSkillValue,
            manualBonus: bonus,
            difficulty: diff,
            role: 'roller',
            adventureId: currentAdventureId ?? undefined,
            rolledBy: networkMyDisplayName || selectedChar.name,
            title: selectedSkillName || undefined,
            actionContext: 'attack',
          };
          const oppRequest: DiceRollRequest = {
            characterName: oppDisplayName,
            characterId: oppChar?.id,
            skillName: oppSkillName,
            skillValue: oppSkillVal,
            difficulty: null,
            role: 'opponent',
            adventureId: currentAdventureId ?? undefined,
            rolledBy: networkMyDisplayName || selectedChar.name,
            title: oppSkillName || 'Защита',
            actionContext: 'defense',
          };
          // ── onResult: лог пишется ПОКА КУБЫ ЕЩЁ НА СТОЛЕ (до hold-таймера) ──
          // executeVSRollSimultaneous вызовет onResult сразу после получения
          // результатов физики для обеих сторон. Кубы обоих игроков ещё лежат
          // на столе — пользователь видит результат на гранях И в логе.
          const vsResults = await executeVSRollSimultaneous(rollerRequest, oppRequest, {
            canUsePhysics,
            presetId: effectivePresetId,
            onResult: async (outcomes) => {
              await persistResult(outcomes.roller, outcomes.opponent);
            },
          });
          result = vsResults.roller;
          oppOutcome = vsResults.opponent;
          opponentTotal = oppOutcome.total;
        } else if (oppDisplayName) {
          // ── 2D fallback: последовательный бросок (opponent first) ──
          const oppRequest: DiceRollRequest = {
            characterName: oppDisplayName,
            characterId: oppChar?.id,
            skillName: oppSkillName,
            skillValue: oppSkillVal,
            difficulty: null,
            role: 'opponent',
            adventureId: currentAdventureId ?? undefined,
            rolledBy: networkMyDisplayName || selectedChar.name,
            title: oppSkillName || 'Защита',
            actionContext: 'defense',
          };
          oppOutcome = await executeDiceRoll(oppRequest, { canUsePhysics, presetId: effectivePresetId });
          opponentTotal = oppOutcome.total;

          // Главный бросок (ролик)
          const mainRequest: DiceRollRequest = {
            characterName: selectedChar.name,
            characterId: selectedChar.id,
            skillName: selectedSkillName,
            skillValue: selectedSkillValue,
            manualBonus: bonus,
            difficulty: diff,
            opponentTotal,
            role: 'roller',
            adventureId: currentAdventureId ?? undefined,
            rolledBy: networkMyDisplayName || selectedChar.name,
            title: selectedSkillName || undefined,
            actionContext: 'attack',
          };
          result = await executeDiceRoll(mainRequest, { canUsePhysics });
          // 2D путь: persistResult вызывается явно после броска (нет hold-таймера)
          await persistResult(result, oppOutcome);
        }
      } else {
        // ── Совместные усилия: каждый помощник с skill >= 1 даёт пассивный +1. ──
        // ВАЖНО: помощники с skill = 0 тоже добавляются в массив (с bonus = 0),
        // чтобы лог показывал всех участников — так же, как в character-roll-dialog
        // (computeTeamEffort). Раньше здесь стоял фильтр `if (hSkillVal > 0)`,
        // который удалял skill=0 помощников из лога — это было расхождение со
        // стилем бросков из листа персонажа.
        if (rollMode === 'cooperative' && coopParticipantIds.length > 0) {
          for (const hid of coopParticipantIds) {
            const hChar = getCharacter(hid);
            if (!hChar) continue;
            const hSkillVal = hChar.skills.find((s) => s.name === selectedSkillName)?.value ?? 0;
            const success = hSkillVal >= 1;
            if (success) coopBonus += 1;
            coopHelpers.push({ name: hChar.name, skillValue: hSkillVal, success });
          }
        }

        // Главный бросок (ролик)
        const mainRequest: DiceRollRequest = {
          characterName: selectedChar.name,
          characterId: selectedChar.id,
          skillName: selectedSkillName,
          skillValue: selectedSkillValue,
          manualBonus: bonus + coopBonus,
          difficulty: diff,
          opponentTotal,
          role: 'roller',
          adventureId: currentAdventureId ?? undefined,
          rolledBy: networkMyDisplayName || selectedChar.name,
          title: selectedSkillName || undefined,
          actionContext: rollMode === 'opposed' ? 'attack' : 'check',
        };
        // ── 3D путь: onResult вызовет persistResult ДО hold-таймера ──
        // (пока кубы на столе). 2D путь: persistResult вызывается явно после.
        // gesture (originSide/originX/directionAngle/spawnX/spawnZ) передаётся
        // только для одиночного броска (check / cooperative). Для opposed —
        // executeVSRollSimultaneous хардкодит near/far (ролик всегда near,
        // оппонент всегда far).
        // Маппинг: gesture.directionAngle (радианы) → origin.direction (для
        // physics-service, который вращает импульс на этот угол).
        // gesture.spawnX/spawnZ → origin.spawnX/spawnZ (token-placement mode:
        // кубы появляются ровно под курсором в точке отпускания).
        result = await executeDiceRoll(mainRequest, {
          canUsePhysics,
          canUse2DPhysics,
          presetId: effectivePresetId,
          onResult: (canUsePhysics || canUse2DPhysics)
            ? async (outcome) => { await persistResult(outcome, null); }
            : undefined,
          ...(gesture ? {
            origin: {
              originSide: gesture.originSide,
              originX: gesture.originX,
              direction: gesture.directionAngle,
              dropX: gesture.dropX,
              dropY: gesture.dropY,
              ...(gesture.spawnX !== undefined ? { spawnX: gesture.spawnX } : {}),
              ...(gesture.spawnZ !== undefined ? { spawnZ: gesture.spawnZ } : {}),
              // swingVelocity (px/ms) — скорость взмаха в момент отпускания.
              // Пробрасывается до physics-service, где масштабирует импульс
              // броска (horizontal + vertical + angular) для реалистичности:
              // медленный отпуск → кубы мягко падают на месте, быстрый flick
              // → кубы летят дальше с дугой. Только для drag-броска.
              ...(gesture.swingVelocity !== undefined ? { swingVelocity: gesture.swingVelocity } : {}),
              // initialQuats — ТЕКУЩИЕ ориентации 4 кубиков из постоянного
              // DiceCanvasHost (in-hand rotation). Кубы вращались всё время
              // drag'а — их ориентации и есть "случайная стартовая точка" для
              // броска. Когда заданы, physics-service ПРОПУСКАЕТ фазу
              // перемешивания (SHAKE_DURATION_MS = 120мс) → бросок становится
              // бесшовным: "тащил → отпустил → кубы сразу полетели".
              ...(gesture.initialQuats !== undefined && gesture.initialQuats.length > 0
                ? { initialQuats: gesture.initialQuats }
                : {}),
              // initialAngularVelocity (Вариант A) — ТЕКУЩИЕ угловые скорости
              // кубиков из HeldDiceController. physics-service при release
              // использует ИХ вместо throwSpin пресета → брошенные кубы
              // ПРОДОЛЖАЮТ вращение удерживаемых (та же ось+скорость).
              ...(gesture.initialAngularVelocity !== undefined && gesture.initialAngularVelocity.length > 0
                ? { initialAngularVelocity: gesture.initialAngularVelocity }
                : {}),
            },
            // ── 2D-режим: origin2D — параметры для локального 2D-движка ──
            // Конвертация из gesture: directionAngle (3D physics-convention:
            // 0=вперёд/-Z=верх экрана, π/2=вправо) → 2D screen-coords convention
            // (0=вправо, π/2=вниз). Формула: screen_dir = directionAngle − π/2.
            //   3D 0 (вперёд/верх)  → 2D -π/2 (вверх) ✓
            //   3D π/2 (вправо)     → 2D 0 (вправо) ✓
            //   3D π (назад/вниз)   → 2D π/2 (вниз) ✓
            //   3D -π/2 (влево)     → 2D -π=π (влево) ✓
            // Раньше directionAngle передавался НАПРЯМУЮ — кубы летели на 90°
            // в сторону от жеста (махнул вправо → кубы вниз). Фикс: вычитаем π/2.
            // swingVelocity (px/ms) → speed (px/с), dropX/dropY → spawnX/spawnY
            // (конвертация screen→map-local в ServerDiceStage2D).
            // initialFaces/initialPositions2D/initialVelocities2D — из drag-контроллера.
            origin2D: {
              direction: (gesture.directionAngle ?? 0) - Math.PI / 2,
              speed: gesture.swingVelocity !== undefined ? gesture.swingVelocity * 1000 : undefined,
              dropX: gesture.dropX,
              dropY: gesture.dropY,
              presetId: gesture.presetId,
              ...(gesture.initialFaces && gesture.initialFaces.length > 0
                ? { initialFaces: gesture.initialFaces }
                : {}),
              ...(gesture.initialPositions2D && gesture.initialPositions2D.length > 0
                ? { initialPositions: gesture.initialPositions2D }
                : {}),
              ...(gesture.initialVelocities2D && gesture.initialVelocities2D.length > 0
                ? { initialVelocities: gesture.initialVelocities2D }
                : {}),
            },
          } : {}),
        });
        if (!canUsePhysics && !canUse2DPhysics) {
          // True fallback (мгновенный performRoll без анимации) — нет hold-таймера,
          // пишем лог сразу. Для 2D/3D onResult уже вызвал persistResult.
          await persistResult(result, null);
        }
      }

      if (!result) {
        // Защита — не должно случаться
        console.error('[roll-tool-panel] no result from roll execution');
        return;
      }

      const effectiveBonus = selectedSkillValue + bonus + coopBonus;

      // ── Theatrical roll overlay broadcast ──
      // Для 2D: строим stage event и сразу broadcast'им (старый путь).
      // Для 3D physics: executeDiceRoll уже создал LiveRollEvent с
      // pendingPhysics и поставил его в очередь overlay. Для простого броска
      // этого достаточно — отдельный summary не нужен.
      // Для opposed/cooperative же мы строим финальный SUMMARY-событие (без
      // pendingPhysics) и broadcast'им его после physics — оно покажет
      // финальные dice/total/verdict обеих сторон.
      try {
        const diceSum = result.diceSum;

        // ── Modifier breakdown for the roller ──
        // Shows exactly where the bonus comes from: skill value, manual bonus,
        // cooperative bonus. Each becomes a chip in the overlay.
        const rollerModifiers: { label: string; value: number }[] = [];
        if (selectedSkillName && selectedSkillValue) {
          rollerModifiers.push({ label: selectedSkillName, value: selectedSkillValue });
        }
        if (bonus !== 0) {
          rollerModifiers.push({ label: bonus > 0 ? 'ситуативный' : 'штраф', value: bonus });
        }
        if (coopBonus > 0) {
          rollerModifiers.push({ label: 'помощники', value: coopBonus });
        }

        // Stamp the local roller's dice palette + peerId onto the summary
        // participant so remote viewers (2D path + VS/coop summary fallback)
        // render this player's dice in their chosen colors, not their own.
        const _summaryRollerState = useFateStore.getState();
        const rollerP: LiveRollParticipant = {
          id: `roller-${selectedChar.id}-${Date.now()}`,
          characterName: selectedChar.name,
          characterId: selectedChar.id,
          peerId: _summaryRollerState.networkMyPeerId ?? null,
          diceColor: _summaryRollerState.diceColor,
          symbolColor: _summaryRollerState.symbolColor,
          skillName: selectedSkillName || undefined,
          skillValue: selectedSkillValue || undefined,
          manualBonus: bonus,
          dice: [...result.dice],
          diceSum,
          total: result.total,
          resultLabel: result.label,
          resultType: result.type,
          role: 'roller',
          modifiers: rollerModifiers.length > 0 ? rollerModifiers : undefined,
        };

        let eventType: LiveRollEvent['type'] = 'simple';
        let opponent: LiveRollParticipant | undefined;
        let participants: LiveRollParticipant[] = [rollerP];
        let verdict: string | undefined;
        let verdictType: LiveRollEvent['verdictType'] | undefined;
        let actionContext: LiveRollEvent['actionContext'] = 'check';
        let opponentKind: 'named' | 'unnamed' | null = null;
        let rollerMargin: number | null = null;

        if (rollMode === 'opposed' && oppOutcome && oppDisplayName) {
          eventType = 'opposed';
          actionContext = 'attack';
          opponentKind = unnamedNpc ? 'unnamed' : 'named';

          // Opponent modifier breakdown
          const oppModifiers: { label: string; value: number }[] = [];
          if (oppSkillName) {
            oppModifiers.push({ label: oppSkillName, value: oppSkillVal });
          }

          opponent = {
            id: `opp-${oppChar?.id ?? 'unnamed'}-${Date.now()}`,
            characterName: oppDisplayName,
            characterId: oppChar?.id,
            skillName: oppSkillName || undefined,
            skillValue: oppSkillVal || undefined,
            dice: [...oppOutcome.dice],
            diceSum: oppOutcome.diceSum,
            total: oppOutcome.total,
            resultLabel: oppOutcome.total > result.total ? 'Победил' : oppOutcome.total < result.total ? 'Проиграл' : 'Ничья',
            resultType: oppOutcome.total > result.total ? 'success' : oppOutcome.total === result.total ? 'tie' : 'fail',
            role: 'opponent',
            modifiers: oppModifiers.length > 0 ? oppModifiers : undefined,
            margin: oppOutcome.total - result.total,
          };
          rollerMargin = result.total - oppOutcome.total;
          if (result.total > oppOutcome.total) {
            const margin = result.total - oppOutcome.total;
            verdict = `— Победа (+${margin})`;
            verdictType = 'win';
          } else if (result.total < oppOutcome.total) {
            const margin = oppOutcome.total - result.total;
            verdict = `— Провал (−${margin})`;
            verdictType = 'lose';
          } else {
            verdict = '— Ничья';
            verdictType = 'tie';
          }
        } else if (rollMode === 'cooperative' && coopHelpers.length > 0) {
          eventType = 'cooperative';
          actionContext = 'cooperative';
          // Helpers as additional participants (passive +1, no dice roll).
          participants = [
            rollerP,
            ...coopHelpers.map((h, i) => {
              const hModifiers: { label: string; value: number }[] = [];
              if (selectedSkillName) {
                hModifiers.push({ label: selectedSkillName, value: h.skillValue });
              }
              return {
                id: `helper-${i}-${Date.now()}`,
                characterName: h.name,
                skillName: selectedSkillName || undefined,
                skillValue: h.skillValue,
                dice: [],
                diceSum: 0,
                total: h.skillValue,
                resultLabel: 'Помог',
                resultType: 'success' as const,
                role: 'helper' as const,
                modifiers: hModifiers.length > 0 ? hModifiers : undefined,
                margin: 1,
              };
            }),
          ];
        } else if (diff !== null) {
          // Simple check vs difficulty — show difficulty as a "verdict".
          actionContext = 'overcome';
          rollerMargin = result.total - diff;
          if (result.total > diff) {
            const margin = result.total - diff;
            verdict = `— Успех (+${margin})`;
            verdictType = 'win';
          } else if (result.total === diff) {
            verdict = `— Ничья (сложность ${diff})`;
            verdictType = 'tie';
          } else {
            const margin = diff - result.total;
            verdict = `— Провал (−${margin})`;
            verdictType = 'lose';
          }
        }

        // Attach the computed margin to the roller participant (first in list)
        if (rollerMargin !== null && participants[0]) {
          participants[0] = { ...participants[0], margin: rollerMargin };
        }

        const stageEvent: LiveRollEvent = {
          id: `roll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          type: eventType,
          rolledBy: networkMyDisplayName || selectedChar.name,
          rolledAt: Date.now(),
          title: rollMode === 'opposed'
            ? `Противостояние: ${selectedSkillName || ''}`
            : rollMode === 'cooperative'
              ? `Совместные усилия: ${selectedSkillName || ''}`
              : selectedSkillName || undefined,
          actionContext,
          opponentKind,
          difficulty: diff,
          verdict,
          verdictType,
          opponent,
          participants,
          adventureId: currentAdventureId || undefined,
        };

        if (!result.usedPhysics) {
          // 2D path — do NOT show the LOCAL theatrical overlay (the inline
          // result panel with dice chips is the sole local display). But we
          // STILL send the stage event to network peers so THEY see the roll
          // animation + result card on their screen. The roller's own
          // inline 2D panel is unaffected.
          sendRollStage(stageEvent);
        } else {
          // 3D path — physics events already enqueued locally by
          // executeDiceRoll (simple check) or executeVSRollSimultaneous (VS).
          // The roller sees the 3D dice tumbling on their map.
          //
          // ── СЕТЕВАЯ ВИДИМОСТЬ АНИМАЦИИ (simple 3D) ──
          // Для simple 3D бросков runRollWithPhysics УЖЕ broadcast'нул pre-roll
          // event (с pendingPhysics, isSummary=false) всем пирам. Remote-клиенты
          // подписались на sessionId через subscribeToSession и видят живую
          // анимацию трансформатов от physics-сервиса (io.emit). Когда физика
          // финализируется — dice:result приходит всем, applyPhysicsResult
          // пересчитывает dice/total/verdict ЛОКАЛЬНО у каждого. Поэтому
          // post-roll summary ЗДЕСЬ не отправляем — он создал бы дубль-overlay.
          //
          // Для cooperative: дополнительно broadcast'им local SUMMARY event,
          // чтобы roller видел помощников в overlay (физика бросала только
          // основной бросок roller'а).
          //
          // Для VS/mass: pre-roll broadcast для multi-session ещё не подключён
          // к runRollWithPhysics → отправляем post-roll summary как fallback.
          if (rollMode === 'cooperative' && coopHelpers.length > 0) {
            broadcastRollStage({
              ...stageEvent,
              id: `summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            });
          } else if (eventType === 'simple') {
            // Simple 3D — pre-roll event уже доставил анимацию + результат
            // remote-клиентам через live physics stream. Ничего не шлём.
          } else {
            // VS / mass — fallback: post-roll summary (без анимации).
            sendRollStage(stageEvent);
          }
        }
      } catch (stageErr) {
        // Overlay is best-effort — never block the roll.
        console.warn('[roll-tool-panel] failed to broadcast roll stage:', stageErr);
      }
    } catch (err) {
      // addLogEntry is offline-first and never throws on server failure,
      // so any exception here is a real client-side bug (e.g. bad character
      // data). Log it for diagnostics but don't scare the user — the dice
      // have already been rolled and displayed via setLastResult above.
      console.error('Roll UI error (non-fatal — dice already shown):', err);
    } finally {
      setIsRolling(false);
    }
  };

  // ── Жест-бросок: подписка на gesture bus ──
  // Когда игрок тащит кубы из кейса (DiceStation) на карту и отпускает —
  // RollGestureProvider вычисляет gesture (originSide/originX) и эмитит
  // его через roll-gesture-bus. Здесь мы ловим событие и вызываем handleRoll.
  //
  // ref на handleRoll нужен чтобы всегда вызывать актуальную версию
  // (с актуальными selectedChar, bonus, rollMode и т.д.). Без ref —
  // useEffect захватил бы handleRoll из первого рендера и навсегда.
  const handleRollRef = useRef(handleRoll);
  useEffect(() => { handleRollRef.current = handleRoll; });

  // isRollingRef — защита от параллельных gesture-бросков. Если игрок
  // быстро тащит кубы дважды — второй gesture игнорируется пока первый
  // бросок не завершится.
  const isRollingRef = useRef(false);
  useEffect(() => { isRollingRef.current = isRolling; }, [isRolling]);

  useEffect(() => {
    const unsubscribe = onRollGesture((gesture: RollGesture) => {
      if (isRollingRef.current) {
        console.info('[roll-tool-panel] gesture ignored — roll in progress');
        return;
      }
      handleRollRef.current(gesture);
    });
    return unsubscribe;
  }, []);

  // ── Mode label (для шапки результата) ──
  const modeLabel =
    rollMode === 'opposed' ? 'Противостояние'
    : rollMode === 'cooperative' ? 'Совместные усилия'
    : rollMode === 'mass' ? 'Массовый бросок'
    : (noDifficulty ? 'Простой бросок' : 'Сложность');

  // ── Recent rolls for the selected character (last 3) ──
  // (удалено из режима «Проверка» по запросу пользователя — история
  // бросков больше не показывается в этом режиме, место отдано призыву
  // аспекта. В других режимах recentRolls тоже не используется — мёртвый
  // код вычищен.)

  // ── Aspect Invoke (призыв аспекта к результату броска) ──
  // В Fate призыв аспекта даёт либо +2 к результату, либо переброс кубиков.
  // Оба варианта стоят 1 очко судьбы (ОС). Применяется к последнему броску
  // через addBonusToLogEntry / rerollLogEntry в store — те же функции, что
  // используются в контекстном меню лога (правый клик по записи).
  //
  // UI: ЕДИНЫЙ 3-кнопочный grid (Переброс / +2 аспект / Бесплатно) для ВСЕХ
  // режимов броска (check / opposed / cooperative / mass) — по запросу
  // пользователя: «Сделай везде как в массовом». Раньше тут была сложная
  // форма с toggle + checkbox + input + Apply/Cancel, которая отличалась
  // от массового режима. Теперь дизайн идентичен.
  const [aspectText, setAspectText] = useState('');          // название аспекта (опциональное)
  const [aspectBusy, setAspectBusy] = useState(false);       // идёт применение
  const [showReason, setShowReason] = useState(false);       // раскрыто ли поле названия аспекта
  // pendingAdjust — визуальная индикация нажатой кнопки (на 600мс подсвечивается).
  const [pendingAdjust, setPendingAdjust] = useState<'reroll' | 'plus2' | 'free-invoke' | null>(null);

  // Можно ли призывать аспект: есть результат, есть ID записи лога,
  // персонаж выбран. Работает для ВСЕХ режимов броска (check / opposed /
  // cooperative / mass) — меню корректировки одинаково для всех бросков
  // в блоке (по запросу пользователя: единое меню для всех типов бросков).
  const canInvokeAspect = !!(
    lastResult?.logEntryId &&
    selectedChar &&
    !isRolling &&
    !aspectBusy
  );
  const aspectFpAvailable = (selectedChar?.fatePoints ?? 0) >= 1;
  // Кнопки «Переброс» и «+2 аспект» требуют 1 ОС. «Бесплатно» — без ОС.
  const canReroll = canInvokeAspect && aspectFpAvailable;
  const canPlus2 = canInvokeAspect && aspectFpAvailable;
  const canFreeInvoke = canInvokeAspect;

  // Единый обработчик для всех 3 кнопок (как в массовом режиме).
  // mode: 'reroll' | 'plus2' | 'free-invoke'
  const handleAspectInvoke = async (mode: 'reroll' | 'plus2' | 'free-invoke') => {
    if (!canInvokeAspect || !lastResult || !selectedChar) return;
    const isFree = mode === 'free-invoke';
    if (!isFree && !aspectFpAvailable) {
      toast.error('Нет очков судьбы для призыва аспекта');
      return;
    }
    // Резолвим актуальный ID записи лога. addLogEntry возвращает локальный ID,
    // но после POST-синхронизации запись заменяется на серверную (с другим ID).
    // К моменту клика «Призвать аспект» локальный ID может быть уже устаревшим.
    // Поэтому: если запись с stored ID не найдена, берём самую свежую запись
    // этого персонажа (бросок только что произошёл — она будет первой).
    let entryId = lastResult.logEntryId!;
    const foundById = useFateStore.getState().logEntries.find((e) => e.id === entryId);
    if (!foundById) {
      const recent = useFateStore.getState().logEntries.find((e) => e.characterId === selectedChar.id);
      if (!recent) {
        toast.error('Запись броска не найдена в логе');
        return;
      }
      entryId = recent.id;
      // Обновляем stored ID, чтобы последующие вызовы работали сразу.
      setLastResult((prev) => prev ? { ...prev, logEntryId: entryId } : prev);
    }

    const baseReason = aspectText.trim()
      || (mode === 'plus2' ? 'Призыв аспекта (+2)'
         : mode === 'free-invoke' ? 'Бесплатный призыв (+2)'
         : 'Призыв аспекта (переброс)');
    const reason = isFree ? `${baseReason} · бесплатно` : baseReason;

    setPendingAdjust(mode);
    setAspectBusy(true);
    try {
      if (mode === 'plus2' || mode === 'free-invoke') {
        // +2 к результату — добавляем бонус к записи лога.
        await addBonusToLogEntry(entryId, 'attacker', 2, reason, { isFree });
      } else {
        // Переброс кубиков — new dice, total пересчитывается в store.
        await rerollLogEntry(entryId, 'attacker', { isFree });
      }
      // Тратим очко судьбы только для платного призыва.
      if (!isFree) {
        await updateCharacter(selectedChar.id, { fatePoints: Math.max(0, selectedChar.fatePoints - 1) });
      }
      const costLabel = isFree ? 'бесплатно' : '−1 ОС';
      const actionLabel = (mode === 'reroll') ? 'переброс' : '+2';
      toast.success(
        `Призыв аспекта: ${actionLabel}`,
        { description: `${reason} · ${costLabel}` }
      );

      // Перечитываем обновлённую запись лога из store и синхронизируем
      // lastResult, чтобы UI сразу показал новый total / label / dice.
      const updated = useFateStore.getState().logEntries.find((e) => e.id === entryId);
      if (updated) {
        setLastResult((prev) => prev ? {
          ...prev,
          dice: updated.diceResults,
          total: updated.total,
          label: updated.result,
          aspectInvokeBonus: updated.aspectInvokeBonus ?? prev.aspectInvokeBonus ?? 0,
          aspectInvokeReason: updated.aspectInvokeReason ?? prev.aspectInvokeReason ?? '',
          aspectRerolled: updated.aspectRerolled ?? prev.aspectRerolled ?? false,
          aspectFreeInvokeCount: updated.aspectFreeInvokeCount ?? prev.aspectFreeInvokeCount ?? 0,
        } : prev);
      }
      setAspectText('');
      setShowReason(false);
    } catch (err) {
      console.error('[aspect-invoke] failed:', err);
      toast.error('Не удалось применить призыв аспекта');
    } finally {
      setAspectBusy(false);
      // Кратковременная подсветка кнопки (как в массовом режиме — 600мс).
      setTimeout(() => setPendingAdjust(null), 600);
    }
  };

  // ── Render ──
  return (
    <div className="flex flex-col h-full fate-bg-texture fate-scene-gradient-top">
      {/* ── Header ── */}
      <div
        className="flex items-center justify-between px-3 py-2.5 fate-section-header border-b"
        style={{ borderColor: 'var(--fate-border)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="fate-icon-circle text-sm"
            style={{ backgroundColor: 'rgba(230, 126, 34, 0.12)' }}
          >
            🎲
          </div>
          <h2 className="font-semibold text-sm" style={{ color: 'var(--fate-text)' }}>
            Бросок кубиков
          </h2>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <ScrollArea className="flex-1 fate-scroll">
        <div className="p-3 space-y-3">
          {/* ── Roll mode tabs (4 режима: Проверка / vs / Совм. / Массовый) — всегда видны ── */}
          <div className="flex items-center gap-0.5 rounded-lg p-0.5" style={{ backgroundColor: 'var(--fate-bg-warm)' }}>
            {([
              { mode: 'check' as const, icon: Dice5, label: 'Проверка' },
              { mode: 'opposed' as const, icon: Swords, label: 'vs' },
              { mode: 'cooperative' as const, icon: Handshake, label: 'Совм.' },
              { mode: 'mass' as const, icon: Dices, label: 'Масс.' },
            ]).map(({ mode, icon: Icon, label }) => (
              <button
                key={mode}
                type="button"
                onClick={() => setRollMode(mode)}
                className={`flex-1 flex items-center justify-center gap-1 rounded-md px-1 py-2 text-[10px] font-medium transition-all ${
                  rollMode === mode
                    ? 'bg-background shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                style={rollMode === mode ? { color: 'var(--fate-text)' } : undefined}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </div>

          {/* ── Mass-режим: sub-toggle между «Массовый бросок» (GM) и «Массовый урон» (все) ── */}
          {rollMode === 'mass' ? (
            <>
              {/* Sub-toggle — виден ВСЕМ пользователям */}
              <div className="flex items-center gap-0.5 rounded-lg p-0.5" style={{ backgroundColor: 'var(--fate-bg-warm)' }}>
                {([
                  { mode: 'damage' as const, icon: Crosshair, label: 'Массовый урон' },
                  { mode: 'roll' as const, icon: Dices, label: 'Массовый бросок' },
                ]).map(({ mode, icon: Icon, label }) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setMassSubMode(mode)}
                    className={`flex-1 flex items-center justify-center gap-1 rounded-md px-1 py-2 text-[10px] font-medium transition-all ${
                      massSubMode === mode
                        ? 'bg-background shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                    style={massSubMode === mode ? { color: 'var(--fate-text)' } : undefined}
                  >
                    <Icon className="size-3.5" />
                    {label}
                  </button>
                ))}
              </div>
              {/* Sub-mode hint */}
              <p className="text-[9px] text-center leading-tight -mt-1" style={{ color: 'var(--fate-text-muted)' }}>
                {massSubMode === 'damage'
                  ? 'Один атакует, распределяет урон, противники защищаются. Доступно всем.'
                  : 'Несколько персонажей бросают один навык. Только для GM.'}
              </p>
              {massSubMode === 'damage' ? (
                <MassDamageRollInline />
              ) : (
                <MassRollInline />
              )}
            </>
          ) : (
          <>
          {/* ── Character selector ── */}
          <CharacterSelector
            chars={availableChars}
            selectedId={selectedCharId}
            onSelect={setSelectedCharId}
            baseSkillNames={baseSkillNames}
          />

          {/* ── Skill selector ── */}
          {availableSkills.length > 0 ? (
            <div className="space-y-1.5">
              <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                Навык
              </Label>
              <Select value={selectedSkillName} onValueChange={setSelectedSkillName}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Выберите навык" />
                </SelectTrigger>
                <SelectContent>
                  {availableSkills.map((s) => (
                    <SelectItem key={s.name} value={s.name} className="text-xs">
                      <span className="flex items-center justify-between w-full gap-2">
                        <span>{s.name}</span>
                        <Badge variant="outline" className="text-[9px] px-1 py-0">+{s.value}</Badge>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div
              className="rounded-md p-2 text-[10px] text-center"
              style={{ backgroundColor: 'var(--fate-bg-warm)', color: 'var(--fate-text-muted)' }}
            >
              {selectedChar ? 'У персонажа нет навыков' : 'Выберите персонажа'}
            </div>
          )}

          {/* ── Чекбокс «бросок без сложности» (объединяет простой бросок и сложность) ── */}
          {rollMode === 'check' && (
            <label
              className="flex items-center gap-2 rounded-md px-2 py-1.5 cursor-pointer transition-colors hover:bg-white/40 dark:hover:bg-white/5"
              style={{ backgroundColor: noDifficulty ? 'transparent' : 'rgba(230, 126, 34, 0.04)' }}
            >
              <Checkbox
                checked={noDifficulty}
                onCheckedChange={(v) => setNoDifficulty(!!v)}
                className="size-4"
              />
              <span className="text-[11px] font-medium" style={{ color: 'var(--fate-text)' }}>
                Бросок без сложности
              </span>
              <span className="text-[9px] ml-auto" style={{ color: 'var(--fate-text-muted)' }}>
                {noDifficulty ? 'просто кубики' : 'со сложностью'}
              </span>
            </label>
          )}

          {/* ── Поле сложности (показывается в режиме check, пока чекбокс снят) ── */}
          {rollMode === 'check' && !noDifficulty && (
            <div className="space-y-1.5">
              <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                Сложность
              </Label>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="size-8 p-0"
                  onClick={() => setDifficulty((d) => Math.max(-4, d - 1))}
                >
                  −
                </Button>
                <Input
                  type="number"
                  value={difficulty}
                  onChange={(e) => setDifficulty(Number(e.target.value) || 0)}
                  className="h-8 text-center text-sm font-semibold"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="size-8 p-0"
                  onClick={() => setDifficulty((d) => Math.min(8, d + 1))}
                >
                  +
                </Button>
              </div>
              {/* Quick difficulty presets */}
              <div className="flex items-center gap-1 flex-wrap">
                {[1, 2, 3, 4, 5].map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setDifficulty(v)}
                    className={`px-2 py-0.5 rounded text-[9px] font-semibold transition-colors ${
                      difficulty === v ? 'text-white' : 'hover:opacity-80'
                    }`}
                    style={{
                      backgroundColor: difficulty === v ? 'var(--fate-accent)' : 'rgba(127, 140, 141, 0.1)',
                      color: difficulty === v ? 'white' : 'var(--fate-text-muted)',
                    }}
                  >
                    {v}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Противостояние ── */}
          {rollMode === 'opposed' && (
            <div className="space-y-2 rounded-lg p-2.5" style={{ backgroundColor: 'rgba(192, 57, 43, 0.05)', border: '1px solid rgba(192, 57, 43, 0.15)' }}>
              {/* Чекбокс «Безымянный NPC» — блокирует выбор персонажа-противника */}
              <label
                className="flex items-center gap-2 cursor-pointer rounded-md px-1.5 py-1 transition-colors hover:bg-white/40 dark:hover:bg-white/5"
                style={{ backgroundColor: unnamedNpc ? 'rgba(192, 57, 43, 0.06)' : 'transparent' }}
              >
                <Checkbox
                  checked={unnamedNpc}
                  onCheckedChange={(v) => setUnnamedNpc(!!v)}
                  className="size-4"
                />
                <UserPlus className="size-3.5" style={{ color: '#c0392b' }} />
                <span className="text-[11px] font-medium" style={{ color: 'var(--fate-text)' }}>
                  Безымянный NPC
                </span>
                <span className="text-[9px] ml-auto" style={{ color: 'var(--fate-text-muted)' }}>
                  {unnamedNpc ? 'абстрактный противник' : 'выберите со сцены'}
                </span>
              </label>

              {/* Безымянный NPC: ввод навыка и бонуса */}
              {unnamedNpc ? (
                <div className="space-y-2 animate-slide-down">
                  <div className="space-y-1">
                    <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                      Навык противника
                    </Label>
                    <Input
                      value={unnamedNpcSkill}
                      onChange={(e) => setUnnamedNpcSkill(e.target.value)}
                      placeholder="напр. Внимательность"
                      className="h-9 text-xs"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                      Бонус противника
                    </Label>
                    <div className="flex items-center gap-1.5">
                      <Button variant="outline" size="sm" className="size-8 p-0" onClick={() => setUnnamedNpcBonus((b) => Math.max(-4, b - 1))}>−</Button>
                      <Input
                        type="number"
                        value={unnamedNpcBonus}
                        onChange={(e) => setUnnamedNpcBonus(Number(e.target.value) || 0)}
                        className="h-8 text-center text-sm font-semibold"
                      />
                      <Button variant="outline" size="sm" className="size-8 p-0" onClick={() => setUnnamedNpcBonus((b) => Math.min(8, b + 1))}>+</Button>
                    </div>
                    <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                      Бросит кубики + <span className="font-semibold">{unnamedNpcBonus >= 0 ? '+' : ''}{unnamedNpcBonus}</span>{unnamedNpcSkill ? ` (${unnamedNpcSkill})` : ''}
                    </p>
                  </div>
                </div>
              ) : (
                <>
                  {/* Выбор персонажа-противника + тултип навыков */}
                  <div className="space-y-1">
                    <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                      Противник
                    </Label>
                    <div className="flex items-center gap-1.5">
                      <Select value={opponentId} onValueChange={setOpponentId}>
                        <SelectTrigger className="h-9 flex-1 text-xs">
                          <SelectValue placeholder="Выберите противника" />
                        </SelectTrigger>
                        <SelectContent>
                          {opponentOptions.map((c) => (
                            <SelectItem key={c.id} value={c.id} className="text-xs">
                              <span className="flex items-center gap-1.5">
                                <CharacterAvatar char={c} size={18} />
                                <span className="truncate">{c.name}</span>
                                {c.type === 'player' ? (
                                  <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1">PC</Badge>
                                ) : (
                                  <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1">NPC</Badge>
                                )}
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {opponentChar && opponentSkills.length > 0 && (
                        <OpponentSkillsTooltip char={opponentChar} baseSkillNames={baseSkillNames} />
                      )}
                    </div>
                  </div>
                  {/* Защитный навык противника */}
                  {opponentChar && opponentSkills.length > 0 && (
                    <div className="space-y-1">
                      <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                        Защитный навык противника
                      </Label>
                      <Select value={opponentSkillName} onValueChange={setOpponentSkillName}>
                        <SelectTrigger className="h-9 text-xs">
                          <SelectValue placeholder="Выберите навык" />
                        </SelectTrigger>
                        <SelectContent>
                          {opponentSkills.map((s) => (
                            <SelectItem key={s.name} value={s.name} className="text-xs">
                              <span className="flex items-center justify-between w-full gap-2">
                                <span>{s.name}</span>
                                <Badge variant="outline" className="text-[9px] px-1 py-0">+{s.value}</Badge>
                              </span>
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {opponentSkillName && (
                        <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                          {opponentChar.name} защищается: <span className="font-semibold">{opponentSkillName} +{opponentSkillValue}</span>
                        </p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── Cooperative mode: select helper participants ── */}
          {rollMode === 'cooperative' && (
            <div className="space-y-2 rounded-lg p-2.5" style={{ backgroundColor: 'rgba(41, 128, 185, 0.05)', border: '1px solid rgba(41, 128, 185, 0.15)' }}>
              <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                Помощники ({coopParticipantIds.length})
              </Label>
              <p className="text-[9px] leading-tight" style={{ color: 'var(--fate-text-muted)' }}>
                Каждый помощник бросает «{selectedSkillName || '—'}» против сложности 0. Успех (+1 или выше) даёт +1 к вашему броску.
              </p>
              <div className="space-y-1 max-h-40 overflow-y-auto fate-scroll">
                {coopHelperOptions.length === 0 ? (
                  <p className="text-[10px] text-center py-2" style={{ color: 'var(--fate-text-muted)' }}>
                    Нет других персонажей на сцене
                  </p>
                ) : (
                  coopHelperOptions.map((c) => {
                    const selected = coopParticipantIds.includes(c.id);
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleCoopParticipant(c.id)}
                        className={`w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-all border ${
                          selected
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:bg-accent'
                        }`}
                        style={selected ? { borderColor: 'var(--fate-accent)', backgroundColor: 'rgba(230, 126, 34, 0.10)' } : undefined}
                      >
                        <CharacterAvatar char={c} size={20} />
                        <span className="flex-1 text-left truncate" style={{ color: 'var(--fate-text)' }}>{c.name}</span>
                        {c.type === 'player' ? (
                          <Badge variant="outline" className="text-[8px] px-1 py-0">PC</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[8px] px-1 py-0">NPC</Badge>
                        )}
                        {selected && <Check className="size-3.5" style={{ color: 'var(--fate-accent)' }} />}
                      </button>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* ── Bonus (compact: label + stepper inline) ── */}
          <div className="flex items-center justify-between gap-2">
            <Label className="text-[10px] font-medium uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--fate-text-muted)' }}>
              Ситуативный бонус
            </Label>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="size-7 p-0"
                onClick={() => setBonus((b) => Math.max(-10, b - 1))}
              >
                −
              </Button>
              <Input
                type="number"
                value={bonus}
                onChange={(e) => setBonus(Number(e.target.value) || 0)}
                className="h-7 w-14 text-center text-sm font-semibold"
              />
              <Button
                variant="outline"
                size="sm"
                className="size-7 p-0"
                onClick={() => setBonus((b) => Math.min(20, b + 1))}
              >
                +
              </Button>
            </div>
          </div>

          {/* ── Throw Style test window + big «Бросить кубики» button REMOVED ──
              Раньше здесь был A/B-тест «стиль броска» (Auto/Manual toggle +
              grid 5 пресетов) И большая оранжевая кнопка «Бросить кубики».
              По просьбе пользователя оба блока удалены — единственная кнопка
              броска теперь живёт в DiceStation (внизу панели):
                • IDLE     — синяя «Бросить» → emitRandomThrowGesture (взвешенный
                            random preset: 25% gentle / 30% normal / 30% power / 15% lob).
                • IN-FLIGHT — оранжевая «Вернуть кубы» (disabled) пока физика летит.
                • SETTLED  — оранжевая «Вернуть кубы» (active) → requestLiveRollExit.

              Жест-бросок (drag) по-прежнему работает через roll-gesture-bus →
              handleRoll(gesture). presetId в Auto берётся из gesture (вычислен
              из скорости взмаха в RollGestureProvider). Клик-бросок через кнопку
              использует preset из gesture (emitRandomThrowGesture). */}

          {/* ── Rolling animation (dual for opposed, single otherwise) ── */}
          {isRolling && (
            <div
              className="rounded-lg py-5 px-3 space-y-3 animate-pulse"
              style={{ backgroundColor: 'var(--fate-bg-warm)' }}
            >
              {/* Attacker dice */}
              <div className="flex flex-col items-center">
                <span className="text-[10px] font-semibold mb-1.5" style={{ color: 'var(--fate-accent)' }}>
                  {selectedChar?.name ?? 'Вы'}
                </span>
                <DiceChips dice={rollingDice} size="xl" animate={false} />
              </div>
              {/* Opponent dice (opposed mode only) */}
              {rollMode === 'opposed' && (unnamedNpc || opponentId) && (
                <>
                  <div className="flex items-center justify-center gap-2 text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                    <span className="h-px flex-1 max-w-12" style={{ backgroundColor: 'var(--fate-border)' }} />
                    VS
                    <span className="h-px flex-1 max-w-12" style={{ backgroundColor: 'var(--fate-border)' }} />
                  </div>
                  <div className="flex flex-col items-center">
                    <span className="text-[10px] font-semibold mb-1.5" style={{ color: '#c0392b' }}>
                      {unnamedNpc ? 'Безымянный NPC' : (opponentChar?.name ?? 'Противник')}
                    </span>
                    <DiceChips dice={rollingOpponentDice} size="xl" animate={false} />
                  </div>
                </>
              )}
              <p className="text-[10px] text-center animate-pulse" style={{ color: 'var(--fate-text-muted)' }}>
                Кубики катятся...
              </p>
            </div>
          )}

          {/* ── Result ──
              3D mode (usedPhysics): COMPACT one-line summary — the 3D overlay
                already showed the dice tumbling on the map, so showing big
                dice-chips again here would be visual noise. Just total + label
                + a hint that details are in the log.
              2D mode (!usedPhysics): full detailed panel with dice-chips,
                opponent row, helpers — this IS the only result display. */}
          {lastResult && !isRolling && lastResult.usedPhysics && (
            <div
              className="rounded-lg px-3 py-2 flex items-center gap-2.5 animate-slide-down"
              style={{
                backgroundColor: 'var(--fate-bg-warm)',
                border: `1px solid ${RESULT_COLORS[lastResult.label] ?? 'var(--fate-border)'}50`,
              }}
            >
              <span className="text-[10px] truncate flex-1 min-w-0" style={{ color: 'var(--fate-text-muted)' }}>
                <span className="font-semibold" style={{ color: 'var(--fate-text)' }}>
                  {lastResult.charName}
                </span>
                {' · '}
                {lastResult.skillName}
                {lastResult.opponentName && (
                  <>
                    {' '}vs <span style={{ color: '#c0392b' }}>{lastResult.opponentName}</span>
                  </>
                )}
              </span>
              {/* Preset badge (test feature) — показывает какой стиль броска был использован */}
              {lastResult.presetUsed && (() => {
                const pm = getPresetMeta(lastResult.presetUsed);
                const PIcon = PRESET_ICONS[pm.icon] ?? Zap;
                return (
                  <span
                    className="text-[9px] font-semibold px-1.5 py-0.5 rounded shrink-0 flex items-center gap-0.5"
                    style={{ backgroundColor: `${pm.color}22`, color: pm.color }}
                    title={`Стиль броска: ${pm.label} — ${pm.hint}`}
                  >
                    <PIcon className="size-2.5" />
                    {pm.label}
                  </span>
                );
              })()}
              <Badge
                className="text-[10px] px-2 py-0.5 font-semibold shrink-0"
                style={resultBadgeStyle(lastResult.label)}
              >
                {lastResult.label}
              </Badge>
              <span
                className="text-xl font-black leading-none tabular-nums shrink-0"
                style={{ color: RESULT_COLORS[lastResult.label] ?? 'var(--fate-text)' }}
              >
                {formatTotal(lastResult.total)}
              </span>
              {lastResult.opponentName && (
                <span
                  className="text-sm font-bold leading-none tabular-nums shrink-0"
                  style={{ color: '#c0392b' }}
                  title={`Противник: ${lastResult.opponentName}`}
                >
                  {formatTotal(lastResult.opponentTotal ?? 0)}
                </span>
              )}
              <Button
                onClick={() => handleRoll()}
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[10px] gap-1 shrink-0"
                title="Бросить ещё раз"
              >
                <RefreshCw className="size-3" />
              </Button>
            </div>
          )}

          {/* ── Result (2D mode — full detailed panel; dual for opposed) ── */}
          {lastResult && !isRolling && !lastResult.usedPhysics && (
            <div
              className="rounded-lg p-4 space-y-3 animate-slide-down"
              style={{
                backgroundColor: 'var(--fate-bg-warm)',
                border: `1px solid ${RESULT_COLORS[lastResult.label] ?? 'var(--fate-border)'}40`,
                boxShadow: `0 4px 20px ${RESULT_COLORS[lastResult.label] ?? 'var(--fate-border)'}15`,
              }}
            >
              <div className="flex items-center justify-between text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                <span className="truncate">{lastResult.charName} · {lastResult.skillName}</span>
                <span>{modeLabel}</span>
              </div>

              {/* Attacker result */}
              <div className="flex justify-center py-1">
                <DiceChips dice={lastResult.dice} size="lg" animate={false} />
              </div>
              <div className="flex items-center justify-between">
                <Badge
                  className="text-xs px-2.5 py-0.5 font-semibold"
                  style={resultBadgeStyle(lastResult.label)}
                >
                  {lastResult.label}
                </Badge>
                <span
                  className="text-4xl font-black leading-none"
                  style={{ color: RESULT_COLORS[lastResult.label] ?? 'var(--fate-text)' }}
                >
                  {formatTotal(lastResult.total)}
                </span>
              </div>

              {/* Opponent result (opposed mode) */}
              {lastResult.opponentDice && lastResult.opponentName && (
                <>
                  <div className="flex items-center justify-center gap-2 text-[10px] py-0.5" style={{ color: 'var(--fate-text-muted)' }}>
                    <span className="h-px flex-1 max-w-16" style={{ backgroundColor: 'var(--fate-border)' }} />
                    ⚔ vs {lastResult.opponentName}
                    {lastResult.opponentSkillName && (
                      <span className="text-[9px]">({lastResult.opponentSkillName} +{lastResult.opponentSkillValue})</span>
                    )}
                    <span className="h-px flex-1 max-w-16" style={{ backgroundColor: 'var(--fate-border)' }} />
                  </div>
                  <div className="flex justify-center py-0.5">
                    <DiceChips dice={lastResult.opponentDice} size="md" animate={false} />
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                      {lastResult.total > (lastResult.opponentTotal ?? 0) ? '🏆 Вы победили' : lastResult.total === lastResult.opponentTotal ? '🤝 Ничья' : '💀 Противник победил'}
                    </span>
                    <span
                      className="text-2xl font-black leading-none"
                      style={{ color: '#c0392b' }}
                    >
                      {formatTotal(lastResult.opponentTotal ?? 0)}
                    </span>
                  </div>
                </>
              )}

              {/* Helpers result (cooperative mode) */}
              {lastResult.helpers && lastResult.helpers.length > 0 && (
                <>
                  <div className="flex items-center justify-center gap-2 text-[10px] py-0.5" style={{ color: 'var(--fate-text-muted)' }}>
                    <span className="h-px flex-1 max-w-12" style={{ backgroundColor: 'var(--fate-border)' }} />
                    <Users className="size-3" />
                    Помощники
                    <span className="h-px flex-1 max-w-12" style={{ backgroundColor: 'var(--fate-border)' }} />
                  </div>
                  <div className="space-y-1">
                    {lastResult.helpers.map((h, i) => (
                      <div key={i} className="flex items-center justify-between rounded-md px-2 py-1 text-[10px]"
                        style={{ backgroundColor: 'rgba(39, 174, 96, 0.10)' }}>
                        <div className="flex items-center gap-1.5 min-w-0">
                          <Badge variant="outline" className="text-[9px] px-1 py-0" style={{ color: 'var(--fate-text-muted)' }}>
                            +{h.skillValue}
                          </Badge>
                          <span className="truncate ml-1" style={{ color: 'var(--fate-text-muted)' }}>{h.name}</span>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <Badge className="text-[8px] px-1 py-0" style={{ backgroundColor: '#27ae60', color: 'white', border: 'none' }}>+1</Badge>
                          <span className="font-bold text-xs" style={{ color: '#27ae60' }}>
                            Помог
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <Button
                onClick={() => handleRoll()}
                variant="outline"
                size="sm"
                className="w-full h-8 text-[11px] gap-1"
              >
                <RefreshCw className="size-3" />
                Бросить ещё раз
              </Button>
            </div>
          )}

          {/* ── Корректировки броска (для ВСЕХ режимов броска) ──
              ЕДИНЫЙ 3-кнопочный grid: Переброс / +2 аспект / Бесплатно.
              По запросу пользователя: «Сделай везде как в массовом».
              Раньше тут была сложная форма с toggle + checkbox + input +
              Apply/Cancel, которая отличалась от массового режима.
              Теперь дизайн идентичен mass-варианту (см. ~line 2435).

              Кнопки:
                • Переброс   — rerollLogEntry (1 ОС)
                • +2 аспект  — addBonusToLogEntry +2 (1 ОС)
                • Бесплатно  — addBonusToLogEntry +2 (free invoke, без ОС)

              Все 3 вызывают handleAspectInvoke(mode), который использует
              те же store-функции, что и контекстное меню лога. */}
          {lastResult && !isRolling && (
            <div
              className="rounded-lg p-2.5 space-y-1.5 animate-slide-down"
              style={{
                backgroundColor: 'rgba(230, 126, 34, 0.06)',
                border: '1px solid rgba(230, 126, 34, 0.25)',
              }}
            >
              {/* Шапка блока: «Корректировки» + кол-во ОС */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5">
                  <Sparkles className="size-3.5" style={{ color: 'var(--fate-accent)' }} />
                  <Label className="text-[10px] font-medium" style={{ color: 'var(--fate-text)' }}>
                    Корректировки
                  </Label>
                </div>
                <span className="flex items-center gap-1 text-[9px]" style={{ color: 'var(--fate-text-muted)' }}>
                  <Zap className="size-3" style={{ color: aspectFpAvailable ? '#f39c12' : 'var(--fate-text-muted)' }} />
                  Ж: {selectedChar?.fatePoints ?? 0}
                </span>
              </div>

              {/* Уже применённые корректировки (показываем, если есть) */}
              {(lastResult.aspectInvokeBonus ?? 0) !== 0 && (
                <div
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px]"
                  style={{ backgroundColor: 'rgba(39, 174, 96, 0.10)', color: 'var(--fate-success)' }}
                >
                  <Plus className="size-3" />
                  <span className="truncate">
                    {(lastResult.aspectInvokeBonus ?? 0) > 0 ? '+' : ''}{lastResult.aspectInvokeBonus}
                    {lastResult.aspectInvokeReason ? ` · ${lastResult.aspectInvokeReason}` : ''}
                  </span>
                </div>
              )}
              {(lastResult.aspectFreeInvokeCount ?? 0) > 0 && (
                <div
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px]"
                  style={{ backgroundColor: 'rgba(155, 89, 182, 0.10)', color: '#9b59b6' }}
                >
                  <Gift className="size-3" />
                  <span>Бесплатный призыв ×{lastResult.aspectFreeInvokeCount}</span>
                </div>
              )}
              {lastResult.aspectRerolled && (
                <div
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[10px]"
                  style={{ backgroundColor: 'rgba(230, 126, 34, 0.10)', color: '#e67e22' }}
                >
                  <RefreshCw className="size-3" />
                  <span>Кубики переброшены</span>
                </div>
              )}

              {/* 3-кнопочный grid (Переброс / +2 аспект / Бесплатно) —
                  идентично mass-варианту (~line 2435). */}
              <div className="grid grid-cols-3 gap-1">
                {/* Переброс — оранжевый, требует 1 ОС */}
                <button
                  type="button"
                  disabled={!canReroll}
                  onClick={() => handleAspectInvoke('reroll')}
                  className="rounded-md p-1.5 text-[9px] font-medium transition-all border flex flex-col items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    backgroundColor: pendingAdjust === 'reroll' ? 'rgba(230, 126, 34, 0.15)' : 'transparent',
                    borderColor: pendingAdjust === 'reroll' ? '#e67e22' : 'var(--fate-border)',
                    color: '#e67e22',
                  }}
                  title="Перебросить кубики за 1 жетон судьбы"
                >
                  <RefreshCw className={`size-3.5 ${pendingAdjust === 'reroll' ? 'animate-spin' : ''}`} />
                  Переброс
                </button>

                {/* +2 аспект — зелёный, требует 1 ОС */}
                <button
                  type="button"
                  disabled={!canPlus2}
                  onClick={() => handleAspectInvoke('plus2')}
                  className="rounded-md p-1.5 text-[9px] font-medium transition-all border flex flex-col items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    backgroundColor: pendingAdjust === 'plus2' ? 'rgba(39, 174, 96, 0.15)' : 'transparent',
                    borderColor: pendingAdjust === 'plus2' ? '#27ae60' : 'var(--fate-border)',
                    color: '#27ae60',
                  }}
                  title="Призвать аспект: +2 к броску за 1 жетон судьбы. Трата жетона судьбы = призыв аспекта — это основная механика Fate."
                >
                  <Plus className={`size-3.5 ${pendingAdjust === 'plus2' ? 'animate-pulse' : ''}`} />
                  +2 аспект
                </button>

                {/* Бесплатно — фиолетовый, без ОС (free invoke) */}
                <button
                  type="button"
                  disabled={!canFreeInvoke}
                  onClick={() => handleAspectInvoke('free-invoke')}
                  className="rounded-md p-1.5 text-[9px] font-medium transition-all border flex flex-col items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    backgroundColor: pendingAdjust === 'free-invoke' ? 'rgba(155, 89, 182, 0.15)' : 'transparent',
                    borderColor: pendingAdjust === 'free-invoke' ? '#9b59b6' : 'var(--fate-border)',
                    color: '#9b59b6',
                  }}
                  title="Бесплатный призыв аспекта: +2 без траты жетона"
                >
                  <Gift className={`size-3.5 ${pendingAdjust === 'free-invoke' ? 'animate-pulse' : ''}`} />
                  Бесплатно
                </button>
              </div>

              {/* Опциональное поле названия аспекта (скрыто по умолчанию) */}
              <button
                type="button"
                onClick={() => setShowReason((s) => !s)}
                className="flex items-center gap-1 text-[9px] transition-colors hover:opacity-70"
                style={{ color: 'var(--fate-text-muted)' }}
              >
                {showReason ? <ChevronUp className="size-2.5" /> : <ChevronDown className="size-2.5" />}
                Указать аспект
              </button>
              {showReason && (
                <Input
                  value={aspectText}
                  onChange={(e) => setAspectText(e.target.value)}
                  placeholder="Какой аспект призывается?"
                  className="text-[11px] h-7"
                  maxLength={60}
                />
              )}
            </div>
          )}
          </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// CHARACTER SELECTOR with skills tooltip
// ════════════════════════════════════════════════════════════════

function CharacterSelector({
  chars,
  selectedId,
  onSelect,
  baseSkillNames,
}: {
  chars: Character[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  baseSkillNames: string[];
}) {
  const selected = chars.find((c) => c.id === selectedId) ?? null;

  if (chars.length === 0) {
    return (
      <div
        className="rounded-lg p-3 text-center text-[11px]"
        style={{ backgroundColor: 'var(--fate-bg-warm)', color: 'var(--fate-text-muted)' }}
      >
        <UserCircle className="size-5 mx-auto mb-1 opacity-40" />
        Нет доступных персонажей
      </div>
    );
  }

  // Sort skills for tooltip: normalize against baseSkills so all are shown
  const skillsForTooltip = selected
    ? normalizeSkills(selected.skills, baseSkillNames)
    : [];

  return (
    <div className="flex items-center gap-1.5">
      {/* Character dropdown */}
      <Select value={selectedId ?? undefined} onValueChange={onSelect}>
        <SelectTrigger className="h-9 flex-1 text-xs">
          <div className="flex items-center gap-1.5 min-w-0">
            {selected && (
              <CharacterAvatar char={selected} size={20} />
            )}
            <SelectValue placeholder="Выберите персонажа" />
          </div>
        </SelectTrigger>
        <SelectContent>
          {chars.map((c) => (
            <SelectItem key={c.id} value={c.id} className="text-xs">
              <div className="flex items-center gap-1.5">
                <CharacterAvatar char={c} size={18} />
                <span className="truncate">{c.name}</span>
                {c.type === 'npc' && (
                  <Badge variant="outline" className="text-[8px] px-1 py-0 ml-1">NPC</Badge>
                )}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Skills tooltip — hover to preview (no native title to avoid overlap) */}
      {selected && skillsForTooltip.length > 0 && (
        <HoverCard openDelay={200} closeDelay={100}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              className="size-9 flex items-center justify-center rounded-md border border-border hover:bg-accent transition-colors flex-shrink-0"
            >
              <Info className="size-4" style={{ color: 'var(--fate-accent)' }} />
            </button>
          </HoverCardTrigger>
          <HoverCardContent
            side="right"
            align="start"
            className="w-64 p-3"
            style={{ backgroundColor: 'var(--fate-bg-card)' }}
          >
            <div className="space-y-2">
              <div className="flex items-center gap-2 pb-1.5 border-b" style={{ borderColor: 'var(--fate-border)' }}>
                <CharacterAvatar char={selected} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                    {selected.name}
                  </div>
                  <div className="text-[9px]" style={{ color: 'var(--fate-text-muted)' }}>
                    {selected.concept || '—'}
                  </div>
                </div>
              </div>

              {/* Aspects (first 3) */}
              {selected.aspects.length > 0 && (
                <div className="space-y-0.5">
                  <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                    Аспекты
                  </div>
                  {selected.aspects.slice(0, 4).map((a, i) => (
                    <div key={i} className="text-[10px] truncate" style={{ color: 'var(--fate-text)' }}>
                      • {a}
                    </div>
                  ))}
                </div>
              )}

              {/* Skills */}
              <div className="space-y-0.5">
                <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                  Навыки
                </div>
                <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
                  {skillsForTooltip.map((s) => (
                    <div key={s.name} className="flex items-center justify-between text-[10px]">
                      <span className="truncate" style={{ color: 'var(--fate-text)' }}>{s.name}</span>
                      <span
                        className="font-bold ml-1 px-1 rounded text-[9px] text-white"
                        style={{ backgroundColor: skillColor(s.value) }}
                      >
                        +{s.value}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Fate points */}
              <div className="flex items-center justify-between pt-1.5 border-t text-[10px]" style={{ borderColor: 'var(--fate-border)' }}>
                <span className="flex items-center gap-1" style={{ color: 'var(--fate-text-muted)' }}>
                  <Flame className="size-3" style={{ color: '#e67e22' }} />
                  Жетоны судьбы
                </span>
                <span className="font-bold" style={{ color: 'var(--fate-text)' }}>
                  {selected.fatePoints} / {selected.refresh}
                </span>
              </div>
            </div>
          </HoverCardContent>
        </HoverCard>
      )}
    </div>
  );
}

// ── Character avatar (emoji or color circle) ──
function CharacterAvatar({ char, size = 24 }: { char: Character; size?: number }) {
  if (char.avatar) {
    return (
      <img
        src={char.avatar}
        alt={char.name}
        className="rounded-full object-cover flex-shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  // Fallback: colored circle with first letter
  const initial = char.name.charAt(0).toUpperCase();
  return (
    <div
      className="rounded-full flex items-center justify-center text-white font-bold flex-shrink-0"
      style={{
        width: size,
        height: size,
        backgroundColor: char.avatarColor || '#e67e22',
        fontSize: size * 0.5,
      }}
    >
      {initial}
    </div>
  );
}

// ── Skill value → color (Fate ladder colors) ──
function skillColor(value: number): string {
  if (value >= 4) return '#1e8449'; // great
  if (value >= 3) return '#27ae60'; // good
  if (value >= 2) return 'var(--fate-accent)'; // fair
  if (value >= 1) return '#e67e22'; // average
  return 'var(--fate-text-muted)';
}

// ════════════════════════════════════════════════════════════════
// OPPONENT SKILLS TOOLTIP (opposed mode — preview defender's skills)
// ════════════════════════════════════════════════════════════════

function OpponentSkillsTooltip({ char, baseSkillNames }: { char: Character; baseSkillNames: string[] }) {
  const skills = useMemo(
    () => normalizeSkills(char.skills, baseSkillNames),
    [char, baseSkillNames]
  );
  if (skills.length === 0) return null;
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="size-9 flex items-center justify-center rounded-md border border-border hover:bg-accent transition-colors flex-shrink-0"
        >
          <Info className="size-4" style={{ color: '#c0392b' }} />
        </button>
      </HoverCardTrigger>
      <HoverCardContent
        side="right"
        align="start"
        className="w-64 p-3"
        style={{ backgroundColor: 'var(--fate-bg-card)' }}
      >
        <div className="space-y-2">
          <div className="flex items-center gap-2 pb-1.5 border-b" style={{ borderColor: 'var(--fate-border)' }}>
            <CharacterAvatar char={char} size={28} />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                {char.name}
              </div>
              <div className="text-[9px]" style={{ color: 'var(--fate-text-muted)' }}>
                {char.concept || '—'}
              </div>
            </div>
          </div>
          <div className="space-y-0.5">
            <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
              Навыки
            </div>
            <div className="grid grid-cols-2 gap-x-2 gap-y-0.5">
              {skills.map((s) => (
                <div key={s.name} className="flex items-center justify-between text-[10px]">
                  <span className="truncate" style={{ color: 'var(--fate-text)' }}>{s.name}</span>
                  <span
                    className="font-bold ml-1 px-1 rounded text-[9px] text-white"
                    style={{ backgroundColor: skillColor(s.value) }}
                  >
                    +{s.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex items-center justify-between pt-1.5 border-t text-[10px]" style={{ borderColor: 'var(--fate-border)' }}>
            <span className="flex items-center gap-1" style={{ color: 'var(--fate-text-muted)' }}>
              <Flame className="size-3" style={{ color: '#e67e22' }} />
              Жетоны судьбы
            </span>
            <span className="font-bold" style={{ color: 'var(--fate-text)' }}>
              {char.fatePoints} / {char.refresh}
            </span>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

// ════════════════════════════════════════════════════════════════
// MASS-ROLL REQUEST VIEW (priority — shown when GM invites player)
// ════════════════════════════════════════════════════════════════

function MassRollRequestView({
  myParticipant,
  onClose,
}: {
  myParticipant: NonNullable<ReturnType<typeof useFateStore.getState>['massRollState']>['participants'][number];
  onClose?: () => void;
}) {
  const store = useFateStore();
  const {
    massRollState,
    characters,
    setMassRollReady,
  } = store;
  const { sendMassRollReady, sendMassRollAdjust } = useNetwork();

  const [fateMode, setFateMode] = useState<'none' | 'plus2'>('none');
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState('');
  const [pendingAdjust, setPendingAdjust] = useState<'reroll' | 'plus2' | 'free-invoke' | null>(null);

  const session = massRollState!;
  const myCharacter = useMemo(
    () => characters.find((c) => c.id === myParticipant.characterId) ?? null,
    [characters, myParticipant.characterId]
  );

  const hasRolled = !!myParticipant.result;
  const myFatePoints = myCharacter?.fatePoints ?? 0;
  const canUseFate = myFatePoints > 0;

  const allResults = session.participants.filter((p) => p.result);
  const sortedResults = [...allResults].sort((a, b) => (b.result!.total) - (a.result!.total));

  const canReroll = hasRolled && canUseFate && !pendingAdjust;
  const canPlus2 = hasRolled && canUseFate && !pendingAdjust;
  const canFreeInvoke = hasRolled && !pendingAdjust;

  const handleToggleReady = () => {
    const newReady = !myParticipant.ready;
    setMassRollReady(session.id, myParticipant.characterId, newReady, {
      mode: fateMode === 'plus2' ? 'plus2' : 'none',
      reason: reason || undefined,
    });
    sendMassRollReady({
      sessionId: session.id,
      characterId: myParticipant.characterId,
      ready: newReady,
      fatePointMode: fateMode === 'plus2' ? 'plus2' : 'none',
      fatePointReason: reason || undefined,
    });
  };

  const handleAdjust = (mode: 'reroll' | 'plus2' | 'free-invoke') => {
    if (!canUseFate && mode !== 'free-invoke') return;
    if (pendingAdjust) return;
    setPendingAdjust(mode);
    sendMassRollAdjust({
      sessionId: session.id,
      characterId: myParticipant.characterId,
      mode,
      reason: reason || undefined,
    });
    setTimeout(() => setPendingAdjust(null), 600);
  };

  const ModeIcon = session.mode === 'opposed' ? Swords : session.difficulty !== null ? Shield : Dices;
  const modeLabel = session.mode === 'opposed'
    ? 'Противостояние'
    : session.difficulty !== null
    ? 'Сложность'
    : 'Проверка';

  const skillOverridden = myParticipant.skillName !== session.skillName;
  const hasManualBonus = myParticipant.manualBonus !== 0;

  const myRerolls = myParticipant.result?.rerollCount ?? 0;
  const myBonuses = myParticipant.result?.bonusCount ?? 0;
  const myFreeInvokes = myParticipant.result?.freeInvokeCount ?? 0;

  return (
    <div className="flex flex-col h-full fate-bg-texture fate-scene-gradient-top">
      {/* ── Header ── */}
      <div
        className="flex items-center justify-between px-3 py-2.5 fate-section-header border-b"
        style={{ borderColor: 'var(--fate-border)' }}
      >
        <div className="flex items-center gap-2">
          <div
            className="fate-icon-circle text-sm"
            style={{
              backgroundColor: hasRolled
                ? 'rgba(39, 174, 96, 0.18)'
                : 'rgba(230, 126, 34, 0.18)',
              ...(hasRolled ? {} : { animation: 'fate-pulse 1.6s ease-in-out infinite' }),
            }}
          >
            {hasRolled ? (
              <Check className="size-4" style={{ color: '#27ae60' }} />
            ) : (
              <Zap className="size-4" style={{ color: 'var(--fate-accent)' }} />
            )}
          </div>
          <h2 className="font-semibold text-sm" style={{ color: 'var(--fate-text)' }}>
            {hasRolled ? 'Результаты броска' : 'Запрос от мастера'}
          </h2>
        </div>
      </div>

      <ScrollArea className="flex-1 fate-scroll">
        <div className="p-3 space-y-3">
          {/* ── Request banner ── */}
          <div
                       className="rounded-lg p-2.5 flex items-center gap-2"
            style={{
              backgroundColor: 'rgba(230, 126, 34, 0.12)',
              border: '1px solid rgba(230, 126, 34, 0.3)',
            }}
          >
            <div
              className="size-8 rounded-full flex items-center justify-center flex-shrink-0 animate-pulse"
              style={{ backgroundColor: 'var(--fate-accent)' }}
            >
              <Zap className="size-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-semibold" style={{ color: 'var(--fate-text)' }}>
                Приглашение к броску
              </div>
              <div className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                Нажмите «Готов!», чтобы сделать бросок
              </div>
            </div>
          </div>

          {/* ── Roll context bar ── */}
          <div
            className="rounded-lg px-2.5 py-2 flex items-center justify-between gap-1.5 text-[11px]"
            style={{ backgroundColor: 'var(--fate-bg-warm)' }}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <ModeIcon className="size-3.5 flex-shrink-0" style={{ color: 'var(--fate-accent)' }} />
              <span className="truncate" style={{ color: 'var(--fate-text-muted)' }}>{modeLabel}</span>
              <Badge variant="outline" className="text-[10px] font-semibold px-1.5 py-0">
                {session.skillName}
              </Badge>
            </div>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {session.difficulty !== null && (
                <span style={{ color: 'var(--fate-text-muted)' }}>
                  Сл: <span className="font-bold" style={{ color: 'var(--fate-text)' }}>{session.difficulty}</span>
                </span>
              )}
              {session.mode === 'opposed' && session.opponentName && (
                <span style={{ color: 'var(--fate-text-muted)' }}>
                  vs <span className="font-bold" style={{ color: 'var(--fate-text)' }}>{session.opponentName}</span>
                  {session.opponentTotal !== undefined && (
                    <span className="ml-0.5" style={{ color: 'var(--fate-accent)' }}>
                      {formatTotal(session.opponentTotal)}
                    </span>
                  )}
                </span>
              )}
            </div>
          </div>

      {/* ── Phase 1: Pre-roll ── */}
      {!hasRolled && (
        <>
          <div className="rounded-lg border border-border p-2.5 space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>Персонаж</span>
              <span className="font-semibold truncate ml-2" style={{ color: 'var(--fate-text)' }}>
                {myParticipant.characterName}
              </span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>Навык</span>
              <span className="font-semibold flex items-center gap-1 text-[11px]" style={{ color: 'var(--fate-text)' }}>
                {myParticipant.skillName} +{myParticipant.skillValue}
                {skillOverridden && (
                  <Badge variant="outline" className="text-[8px] px-1 py-0" style={{ color: 'var(--fate-accent)' }}>
                    GM
                  </Badge>
                )}
              </span>
            </div>
            {hasManualBonus && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>Бонус</span>
                <span className="font-bold text-[11px]" style={{ color: 'var(--fate-success)' }}>
                  {formatTotal(myParticipant.manualBonus)}
                </span>
              </div>
            )}
          </div>

          {canUseFate ? (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-[10px] font-medium flex items-center gap-1" style={{ color: 'var(--fate-text-muted)' }}>
                  <Flame className="size-3" style={{ color: '#e67e22' }} />
                  Жетон судьбы
                </Label>
                <span className="text-[9px]" style={{ color: 'var(--fate-text-muted)' }}>
                  {myFatePoints}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  type="button"
                  onClick={() => setFateMode('none')}
                  className={`rounded-md p-1.5 text-[10px] font-medium transition-all border ${
                    fateMode === 'none'
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-transparent border-border hover:bg-accent'
                  }`}
                >
                  Без жетона
                </button>
                <button
                  type="button"
                  onClick={() => setFateMode('plus2')}
                  className={`rounded-md p-1.5 text-[10px] font-medium transition-all border flex items-center justify-center gap-1 ${
                    fateMode === 'plus2'
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-transparent border-border hover:bg-accent'
                  }`}
                >
                  <Flame className="size-3" />
                  +2 аспект
                </button>
              </div>
            </div>
          ) : null}

          <Button
            onClick={handleToggleReady}
            size="sm"
            className="w-full gap-1.5 h-9 text-xs"
            variant={myParticipant.ready ? 'secondary' : 'default'}
          >
            {myParticipant.ready ? (
              <><X className="size-3.5" />Отменить</>
            ) : (
              <><Check className="size-3.5" />Готов!</>
            )}
          </Button>

          {myParticipant.ready && (
            <div
              className="rounded-md p-1.5 flex items-center justify-center gap-1.5 text-[10px]"
              style={{ backgroundColor: 'var(--fate-bg-warm)', color: 'var(--fate-text-muted)' }}
            >
              <Clock className="size-3 animate-pulse" />
              Ждём остальных...
            </div>
          )}
        </>
      )}

      {/* ── Phase 2: Post-roll (results + adjustments) ── */}
      {hasRolled && (
        <>
          <div className="space-y-1">
            {sortedResults.map((p, idx) => {
              const isMe = p.characterId === myParticipant.characterId;
              const isBest = idx === 0 && sortedResults.length > 1;
              const pRerolls = p.result?.rerollCount ?? 0;
              const pBonuses = p.result?.bonusCount ?? 0;
              const pFreeInvokes = p.result?.freeInvokeCount ?? 0;
              return (
                <div
                  key={p.characterId}
                  className={`rounded-md p-2 flex items-center gap-2 transition-all ${isMe ? 'ring-1 ring-offset-0' : ''}`}
                  style={{
                    backgroundColor: isMe ? 'rgba(230, 126, 34, 0.10)' : 'var(--fate-bg-warm)',
                    // @ts-expect-error CSS custom property
                    '--tw-ring-color': 'var(--fate-accent)',
                  }}
                >
                  <div className="flex-shrink-0 w-4 flex items-center justify-center">
                    {isBest ? (
                      <Crown className="size-3.5" style={{ color: '#f39c12' }} />
                    ) : (
                      <span className="text-[9px] font-bold" style={{ color: 'var(--fate-text-muted)' }}>
                        {idx + 1}
                      </span>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1 flex-wrap">
                      <span
                        className="text-[11px] font-semibold truncate"
                        style={{ color: isMe ? 'var(--fate-accent)' : 'var(--fate-text)' }}
                      >
                        {p.characterName}
                      </span>
                      {isMe && (
                        <Badge variant="outline" className="text-[7px] px-1 py-0" style={{ color: 'var(--fate-accent)' }}>
                          Вы
                        </Badge>
                      )}
                      {pRerolls > 0 && (
                        <Badge variant="outline" className="text-[7px] px-1 py-0 gap-0.5" style={{ color: '#e67e22' }}>
                          <RefreshCw className="size-2" />
                          {pRerolls > 1 ? `×${pRerolls}` : ''}
                        </Badge>
                      )}
                      {pBonuses > 0 && (
                        <Badge variant="outline" className="text-[7px] px-1 py-0 gap-0.5" style={{ color: '#27ae60' }}>
                          <Plus className="size-2" />
                          {pBonuses * 2}{pBonuses > 1 ? `×` : ''}
                        </Badge>
                      )}
                      {pFreeInvokes > 0 && (
                        <Badge variant="outline" className="text-[7px] px-1 py-0 gap-0.5" style={{ color: '#9b59b6' }}>
                          <Gift className="size-2" />
                          {pFreeInvokes * 2}{pFreeInvokes > 1 ? `×` : ''}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-0.5">
                      <DiceChips dice={p.result?.dice} size="sm" animate={false} />
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <div className="text-sm font-black leading-none" style={{ color: 'var(--fate-text)' }}>
                      {formatTotal(p.result?.total ?? 0)}
                    </div>
                    <Badge
                      className="text-[8px] mt-0.5 px-1 py-0"
                      style={resultBadgeStyle(p.result?.resultLabel ?? '')}
                    >
                      {p.result?.resultLabel}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>

          <Separator />

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label className="text-[10px] font-medium" style={{ color: 'var(--fate-text)' }}>
                Корректировки
              </Label>
              <span className="text-[9px]" style={{ color: 'var(--fate-text-muted)' }}>
                Ж: {myFatePoints}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-1">
              <button
                type="button"
                disabled={!canReroll}
                onClick={() => handleAdjust('reroll')}
                className="rounded-md p-1.5 text-[9px] font-medium transition-all border flex flex-col items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: pendingAdjust === 'reroll' ? 'rgba(230, 126, 34, 0.15)' : 'transparent',
                  borderColor: pendingAdjust === 'reroll' ? '#e67e22' : 'var(--fate-border)',
                  color: '#e67e22',
                }}
                title="Перебросить кубики за 1 жетон судьбы"
              >
                <RefreshCw className={`size-3.5 ${pendingAdjust === 'reroll' ? 'animate-spin' : ''}`} />
                Переброс
                {myRerolls > 0 && <span className="text-[7px] opacity-70">×{myRerolls}</span>}
              </button>

              <button
                type="button"
                disabled={!canPlus2}
                onClick={() => handleAdjust('plus2')}
                className="rounded-md p-1.5 text-[9px] font-medium transition-all border flex flex-col items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: pendingAdjust === 'plus2' ? 'rgba(39, 174, 96, 0.15)' : 'transparent',
                  borderColor: pendingAdjust === 'plus2' ? '#27ae60' : 'var(--fate-border)',
                  color: '#27ae60',
                }}
                title="Призвать аспект: +2 к броску за 1 жетон судьбы. Трата жетона судьбы = призыв аспекта — это основная механика Fate."
              >
                <Plus className={`size-3.5 ${pendingAdjust === 'plus2' ? 'animate-pulse' : ''}`} />
                +2 аспект
                {myBonuses > 0 && <span className="text-[7px] opacity-70">×{myBonuses}</span>}
              </button>

              <button
                type="button"
                disabled={!canFreeInvoke}
                onClick={() => handleAdjust('free-invoke')}
                className="rounded-md p-1.5 text-[9px] font-medium transition-all border flex flex-col items-center gap-0.5 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: pendingAdjust === 'free-invoke' ? 'rgba(155, 89, 182, 0.15)' : 'transparent',
                  borderColor: pendingAdjust === 'free-invoke' ? '#9b59b6' : 'var(--fate-border)',
                  color: '#9b59b6',
                }}
                title="Бесплатный призыв аспекта: +2 без траты жетона"
              >
                <Gift className={`size-3.5 ${pendingAdjust === 'free-invoke' ? 'animate-pulse' : ''}`} />
                Бесплатно
                {myFreeInvokes > 0 && <span className="text-[7px] opacity-70">×{myFreeInvokes}</span>}
              </button>
            </div>

            <button
              type="button"
              onClick={() => setShowReason((s) => !s)}
              className="flex items-center gap-1 text-[9px] transition-colors hover:opacity-70"
              style={{ color: 'var(--fate-text-muted)' }}
            >
              {showReason ? <ChevronUp className="size-2.5" /> : <ChevronDown className="size-2.5" />}
              Указать аспект
            </button>
            {showReason && (
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Какой аспект призывается?"
                className="text-[11px] h-7"
              />
            )}
          </div>

          {/* ── Явная кнопка закрытия результатов (после броска) ── */}
          {/* Раньше внизу не было кнопки — только маленькая «Сцена» в шапке,
              которую легко не заметить. Теперь явная крупная кнопка внизу. */}
          {hasRolled && onClose && (
            <div className="pt-2">
              <Button
                onClick={onClose}
                className="w-full h-9 text-xs gap-1.5"
                variant="secondary"
              >
                <X className="size-3.5" />
                Закрыть результаты
              </Button>
              <p className="text-[9px] text-center mt-1.5" style={{ color: 'var(--fate-text-muted)' }}>
                Мастер завершит сессию, когда все закончат корректировки
              </p>
            </div>
          )}
        </>
      )}
        </div>
      </ScrollArea>
    </div>
  );
}
