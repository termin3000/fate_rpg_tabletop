'use client';

/**
 * MassRollInline — компактная версия GM-массового-броска для встраивания
 * в боковое меню бросков (RollToolPanel, вкладка «Массовый»).
 *
 * Заменяет отдельную модалку MassRollDialog при работе из панели бросков.
 * Переиспользует те же store-actions (startMassRoll / forceStartMassRoll /
 * cancelMassRoll / finalizeMassRoll) и network-broadcast хуки.
 *
 * Два состояния:
 *  1. Нет активной сессии → форма конфигурации (персонажи / навык / тип /
 *     сложность / противник / бонус) + кнопка старт.
 *  2. Сессия активна → список участников со статусом готовности / результатами,
 *     кнопки «Бросить сейчас» / «Записать в лог» / «Отмена».
 */

import React, { useState, useMemo, useCallback } from 'react';
import {
  Dices, Users, Zap, Check, Clock, X, RefreshCw, Plus, Gift,
  Crown, ShieldAlert, Flame, Handshake, UserPlus,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFateStore } from '@/lib/store';
import {
  executeDiceRollSilent,
  executeMassRollSimultaneous,
  useDiceMode,
} from '@/lib/roll-executor';
import type { DiceRollOutcome, DiceRollRequest } from '@/lib/roll-executor';
import type { Character } from '@/lib/types';
import { DiceChips } from '@/components/fate/dice-chips';
import { useNetwork } from '@/hooks/use-network';
import { toast } from 'sonner';

type RollMode = 'normal' | 'difficulty' | 'opposed';

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

// ── Character avatar (emoji or color circle) ──
function CharAvatar({ char, size = 22 }: { char: Character; size?: number }) {
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

export function MassRollInline() {
  const store = useFateStore();
  const {
    getSceneCharacters,
    currentAdventureId,
    getCharacter,
    settings,
    massRollState,
    isNetworkActive,
    networkRole,
    networkMyDisplayName,
    characters,
    playerAssignments,
    startMassRoll,
    updateMassRollParticipant,
    finalizeMassRoll,
    cancelMassRoll,
    canTeamRoll,
  } = store;
  const {
    broadcastMassRollInvite,
    broadcastMassRollStart,
    broadcastMassRollCancel,
    broadcastMassRollResults,
    broadcastRollStage,
  } = useNetwork();
  const { canUsePhysics } = useDiceMode();

  const canRoll = canTeamRoll();
  let sceneCharacters: Character[] = [];
  try {
    sceneCharacters = getSceneCharacters();
  } catch {
    sceneCharacters = [];
  }

  const availableSkills = useMemo(
    () => settings.baseSkills ?? [],
    [settings.baseSkills],
  );

  const [selectedCharIds, setSelectedCharIds] = useState<Set<string>>(
    () => new Set(sceneCharacters.map((c) => c.id)),
  );
  const [skillName, setSkillName] = useState<string>(
    availableSkills[0] ?? 'Бой',
  );
  const [bonus, setBonus] = useState(0);
  // ── Режим массового броска ──
  // 'check' объединяет «проверку» и «сложность» через чекбокс noDifficulty
  // (как в основном roll-tool-panel). 'opposed' — против персонажа или
  // безымянного NPC.
  const [rollMode, setRollMode] = useState<RollMode>('normal');
  const [noDifficulty, setNoDifficulty] = useState(false);
  const [difficulty, setDifficulty] = useState(2);
  const [opponentId, setOpponentId] = useState<string>('');
  // ── Безымянный NPC (opposed mode) — абстрактный противник с фиксированным
  // бонусом (напр. стражник с Внимательностью +2). Блокирует выбор персонажа.
  const [unnamedNpc, setUnnamedNpc] = useState(false);
  const [unnamedNpcSkill, setUnnamedNpcSkill] = useState<string>('');
  const [unnamedNpcBonus, setUnnamedNpcBonus] = useState(2);

  // ── Helpers ──
  const getSkillValue = useCallback(
    (char: Character, name: string): number => {
      return char.skills.find((s) => s.name === name)?.value ?? 0;
    },
    [],
  );

  const toggleCharacter = (id: string) => {
    setSelectedCharIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelectedCharIds(new Set(sceneCharacters.map((c) => c.id)));
  const deselectAll = () => setSelectedCharIds(new Set());

  const opponentOptions = useMemo(
    () => sceneCharacters,
    [sceneCharacters],
  );

  // ── Are there online PCs among the selected? ──
  const hasOnlinePCs = useMemo(() => {
    if (!isNetworkActive || networkRole !== 'host') return false;
    for (const charId of selectedCharIds) {
      for (const charIds of Object.values(playerAssignments)) {
        if (charIds.includes(charId)) return true;
      }
    }
    return false;
  }, [isNetworkActive, networkRole, selectedCharIds, playerAssignments]);

  // ── Roll dice locally for every participant without a result ──
  // Replaces the synchronous `forceStartMassRoll()` store action.
  //
  // SPLIT EXECUTION (Task ID 5):
  //   - PCs   → executeMassRollSimultaneous: ONE 3D overlay with N physics
  //            sessions thrown at the SAME time from different lateral
  //            slots on the arena (see computeZonalLayout /
  //            runMassRollWithPhysics). Falls back to silent 2D rolls when
  //            canUsePhysics is false.
  //   - NPCs  → executeDiceRollSilent: NO overlay, just Math.random. Runs in
  //            parallel with the PCs' 3D animation via Promise.all.
  //
  // Both arrays preserve the original pending order. Outcomes are merged
  // back into the same order so the existing summary panel and store
  // submission (submitMassRollResult) work unchanged.
  //
  // The total passed to the overlay includes per-participant manualBonus +
  // session.bonus + fate-point +2 bonus, so the modifier chips shown in the
  // physics overlay match what the log will record.
  const executeMassRollForParticipants = useCallback(async () => {
    const session = useFateStore.getState().massRollState;
    if (!session) return;
    const pending = session.participants.filter((p) => !p.result);
    if (pending.length === 0) return;

    // ── Split pending participants into PCs (3D simultaneous) and NPCs (silent) ──
    const pcPending = pending.filter((p) => p.characterType === 'pc');
    const npcPending = pending.filter((p) => p.characterType !== 'pc');

    // Build a DiceRollRequest from a pending participant. Bundle every
    // non-dice modifier into manualBonus so executeMassRollSimultaneous
    // returns the correct `total` AND shows them as chips in the overlay.
    //
    // ── Per-player dice colors ──
    // Stamp each participant's peerId + resolved color palette so the tumbling
    // dice use THAT player's colors (not the GM's). Colors resolve from (1) the
    // participant's own snapshot, (2) the host's peerDiceColors map keyed by
    // the participant's peerId, or (3) left undefined → executeMassRollSimultaneous
    // falls back to the local (GM) palette. This is what makes a mass roll with
    // 3 PCs show 3 different dice colors on everyone's screen.
    const peerDiceColors = useFateStore.getState().peerDiceColors;
    const buildRequest = (p: typeof pending[number]): DiceRollRequest => {
      const peerColors = p.peerId ? peerDiceColors[p.peerId] : undefined;
      return {
        characterName: p.characterName,
        characterId: p.characterId,
        skillName: p.skillName,
        skillValue: p.skillValue,
        manualBonus: p.manualBonus + session.bonus + (p.fatePointMode === 'plus2' ? 2 : 0),
        difficulty: session.difficulty,
        role: 'roller',
        adventureId: currentAdventureId ?? undefined,
        rolledBy: networkMyDisplayName || p.characterName,
        title: `${p.characterName}: ${p.skillName}`,
        actionContext: 'mass',
        peerId: p.peerId,
        diceColor: p.diceColor ?? peerColors?.diceColor,
        symbolColor: p.symbolColor ?? peerColors?.symbolColor,
      };
    };

    // ── Run PCs' 3D mass-roll overlay and NPCs' silent rolls in parallel ──
    // NPC rolls are synchronous (performRoll = Math.random) but wrapped in
    // Promise.all so they execute in parallel with the PCs' physics
    // animation. The NPC promise resolves instantly relative to the
    // physics wait.
    //
    // We assign each promise to a typed local first so the array literal
    // passed to Promise.all is contextually typed as a tuple
    // [Promise<DiceRollOutcome[]>, Promise<DiceRollOutcome[]>] — that way
    // the destructured `pcOutcomes` / `npcOutcomes` come back as
    // `DiceRollOutcome[]` (not `DiceRollOutcome[] | undefined`).
    const pcPromise: Promise<DiceRollOutcome[]> = pcPending.length > 0
      ? executeMassRollSimultaneous(pcPending.map(buildRequest), { canUsePhysics })
      : Promise.resolve([] as DiceRollOutcome[]);
    const npcPromise: Promise<DiceRollOutcome[]> = Promise.all(
      npcPending.map((p) => Promise.resolve(executeDiceRollSilent(buildRequest(p)))),
    );
    const [pcOutcomes, npcOutcomes] = await Promise.all([pcPromise, npcPromise]);

    // ── Merge outcomes back into pending order ──
    // pcOutcomes / npcOutcomes are sub-sequences of `pending` (filtered by
    // characterType). Walk through `pending` and pull from the right bucket
    // so the i-th outcome matches the i-th pending participant.
    const outcomes: DiceRollOutcome[] = new Array(pending.length);
    let pcIdx = 0;
    let npcIdx = 0;
    for (let i = 0; i < pending.length; i++) {
      if (pending[i].characterType === 'pc') {
        outcomes[i] = pcOutcomes[pcIdx++];
      } else {
        outcomes[i] = npcOutcomes[npcIdx++];
      }
    }

    // Submit each outcome to the store using the same label logic that
    // forceStartMassRoll used (so UI / log formatting stays identical).
    const submit = useFateStore.getState().submitMassRollResult;
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      const outcome = outcomes[i];
      let resultLabel = 'Успех';
      if (session.difficulty !== null) {
        if (outcome.total > session.difficulty) resultLabel = outcome.total - session.difficulty >= 3 ? 'Стиль' : 'Успех';
        else if (outcome.total === session.difficulty) resultLabel = 'Ничья';
        else resultLabel = 'Провал';
      } else {
        if (outcome.total >= 4) resultLabel = 'Стиль';
        else if (outcome.total >= 1) resultLabel = 'Успех';
        else if (outcome.total === 0) resultLabel = 'Ничья';
        else resultLabel = 'Провал';
      }
      submit(session.id, p.characterId, {
        dice: outcome.dice,
        diceSum: outcome.diceSum,
        total: outcome.total,
        resultLabel,
        usedReroll: p.fatePointMode === 'reroll',
      });
    }
  }, [canUsePhysics, currentAdventureId, networkMyDisplayName]);

  // ── Start unified session ──
  const handleStartUnified = useCallback(async () => {
    if (!canRoll || selectedCharIds.size === 0) return;
    if (rollMode === 'opposed' && !unnamedNpc && !opponentId) {
      toast.error('Выберите противника');
      return;
    }
    // В режиме 'check' сложность учитывается, только если чекбокс снят.
    // (Раньше был отдельный режим 'difficulty' — теперь объединено.)
    const diff = rollMode === 'normal' && !noDifficulty ? difficulty : null;
    const sessionId = startMassRoll({
      mode: rollMode === 'normal' ? (noDifficulty ? 'normal' : 'difficulty') : rollMode,
      skillName,
      bonus,
      difficulty: diff,
      characterIds: Array.from(selectedCharIds),
      opponentId: rollMode === 'opposed' && !unnamedNpc ? opponentId : undefined,
      unnamedNpc: rollMode === 'opposed' && unnamedNpc
        ? { skillName: unnamedNpcSkill || 'Навык', skillValue: unnamedNpcBonus }
        : undefined,
    });
    const session = useFateStore.getState().massRollState;
    if (!session) return;
    const onlineParticipants = session.participants
      .filter((p) => p.peerId !== null)
      .map((p) => ({
        characterId: p.characterId,
        characterName: p.characterName,
        peerId: p.peerId!,
        skillName: p.skillName,
        skillValue: p.skillValue,
        manualBonus: p.manualBonus,
      }));
    if (onlineParticipants.length > 0 && isNetworkActive && networkRole === 'host') {
      broadcastMassRollInvite({
        sessionId,
        mode: session.mode,
        skillName: session.skillName,
        bonus: session.bonus,
        difficulty: session.difficulty,
        opponentName: session.opponentName,
        opponentTotal: session.opponentTotal,
        participants: onlineParticipants,
      });
    } else {
      // No online players — roll everything locally right away.
      await executeMassRollForParticipants();
    }
  }, [canRoll, selectedCharIds, rollMode, noDifficulty, difficulty, skillName, bonus, opponentId, unnamedNpc, unnamedNpcSkill, unnamedNpcBonus, startMassRoll, isNetworkActive, networkRole, broadcastMassRollInvite, executeMassRollForParticipants]);

  // ── Force-start: roll now ──
  const handleForceStart = useCallback(async () => {
    const session = useFateStore.getState().massRollState;
    if (!session) return;
    const onlinePeerIds = session.participants
      .filter((p) => p.peerId !== null && !p.ready)
      .map((p) => p.peerId!);
    if (onlinePeerIds.length > 0) {
      broadcastMassRollStart(session.id, onlinePeerIds);
    }
    await executeMassRollForParticipants();
    const updated = useFateStore.getState().massRollState;
    if (updated) broadcastMassRollResults(updated);
  }, [broadcastMassRollStart, broadcastMassRollResults, executeMassRollForParticipants]);

  // ── Cancel ──
  const handleCancel = useCallback(() => {
    const session = useFateStore.getState().massRollState;
    if (!session) return;
    const onlinePeerIds = session.participants
      .filter((p) => p.peerId !== null)
      .map((p) => p.peerId!);
    if (onlinePeerIds.length > 0) broadcastMassRollCancel(session.id, onlinePeerIds);
    cancelMassRoll();
  }, [broadcastMassRollCancel, cancelMassRoll]);

  // ── Finalize ──
  const handleFinalize = useCallback(async () => {
    const session = useFateStore.getState().massRollState;
    if (!session) return;
    const onlinePeerIds = session.participants
      .filter((p) => p.peerId !== null)
      .map((p) => p.peerId!);
    if (onlinePeerIds.length > 0) broadcastMassRollCancel(session.id, onlinePeerIds);

    // ── Theatrical overlay: build a 'mass' event from session results ──
    // ВАЖНО: isSummary=true — кубики УЖЕ были брошены и показаны в физик-оверлеях
    // (через executeMassRollSimultaneous в executeMassRollForParticipants).
    // При «Записать в лог» мы только показываем компактную полоску итогов
    // (CompactResultStrip) без 3D-анимации. Без этого флага overlay монтировал
    // бы Dice3DCanvas с predetermined finalDice → «кубы выпрыгивают снова».
    //
    // resultType: store хранит resultLabel как РУССКУЮ строку ('Успех'/'Ничья'/
    // 'Стиль'/'Провал'), а LiveRollParticipant.resultType ожидает АНГЛИЙСКИЙ
    // enum ('fail'|'tie'|'success'|'great'). Мапим явно — иначе
    // RESULT_COLORS[<russian>] вернёт undefined и colors.fg крашнет overlay.
    const LABEL_TO_TYPE: Record<string, 'fail' | 'tie' | 'success' | 'great'> = {
      'Провал': 'fail',
      'Ничья': 'tie',
      'Успех': 'success',
      'Стиль': 'great',
    };
    try {
      const resultsWithRolls = session.participants.filter((p) => p.result);
      if (resultsWithRolls.length > 0) {
        const sorted = [...resultsWithRolls].sort((a, b) => (b.result!.total) - (a.result!.total));
        const winnerTotal = sorted[0].result!.total;
        const participants = sorted.map((p) => ({
          id: `mass-${p.characterId}-${session.id}`,
          characterName: p.characterName,
          characterId: p.characterId,
          skillName: p.skillName,
          skillValue: p.skillValue,
          manualBonus: p.manualBonus,
          dice: [...p.result!.dice],
          diceSum: p.result!.diceSum,
          total: p.result!.total,
          // resultLabel из store уже русский («Успех»/«Ничья»/«Стиль»/«Провал»)
          // — отдаём как есть, для CompactResultStrip.
          resultLabel: p.result!.resultLabel,
          // Мапим русский label → английский enum для RESULT_COLORS.
          resultType: LABEL_TO_TYPE[p.result!.resultLabel] ?? 'fail',
          role: 'roller' as const,
          isWinner: p.result!.total === winnerTotal && sorted.length > 1,
          bonusCount: p.result!.bonusCount,
          freeInvokeCount: p.result!.freeInvokeCount,
          rerolled: !!p.result!.usedReroll,
        }));
        broadcastRollStage({
          id: `mass-${session.id}-${Date.now()}`,
          type: 'mass',
          rolledBy: networkMyDisplayName || 'Мастер',
          rolledAt: Date.now(),
          title: `Массовый бросок: ${session.skillName}`,
          difficulty: session.difficulty,
          verdict: sorted.length > 1
            ? `— ${sorted[0].characterName} победил (+${winnerTotal})`
            : undefined,
          verdictType: 'info',
          participants,
          adventureId: currentAdventureId || undefined,
          // ── Summary-only: НЕ анимируем 3D-кубики ──
          // Кубики уже были брошены и показаны в фазе rolling (через
          // executeMassRollSimultaneous). Здесь только компактная полоска
          // итогов (CompactResultStrip).
          isSummary: true,
        });
      }
    } catch (stageErr) {
      console.warn('[mass-roll-inline] failed to broadcast stage event:', stageErr);
    }

    await finalizeMassRoll();
    toast.success('Массовый бросок записан в лог');
  }, [broadcastMassRollCancel, finalizeMassRoll, broadcastRollStage, networkMyDisplayName, currentAdventureId]);

  // ── Session stats ──
  const stats = useMemo(() => {
    if (!massRollState) return null;
    const online = massRollState.participants.filter((p) => p.peerId !== null);
    const ready = online.filter((p) => p.ready);
    const completed = massRollState.participants.filter((p) => p.result);
    return {
      total: massRollState.participants.length,
      online: online.length,
      ready: ready.length,
      completed: completed.length,
      allReady: online.length > 0 && ready.length === online.length,
      allComplete: completed.length === massRollState.participants.length,
    };
  }, [massRollState]);

  // ── Access denied ──
  if (!canRoll) {
    return (
      <div
        className="rounded-lg p-6 flex flex-col items-center justify-center text-center gap-2 animate-fade-in"
        style={{
          backgroundColor: 'rgba(231, 76, 60, 0.05)',
          border: '1px solid rgba(231, 76, 60, 0.2)',
        }}
      >
        <div
          className="size-12 rounded-full flex items-center justify-center"
          style={{ backgroundColor: 'rgba(231, 76, 60, 0.12)' }}
        >
          <ShieldAlert className="size-6" style={{ color: 'var(--fate-danger)' }} />
        </div>
        <p className="text-xs font-semibold" style={{ color: 'var(--fate-text)' }}>
          Массовый бросок доступен только мастеру
        </p>
        <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
          Попросите мастера выполнить бросок.
        </p>
      </div>
    );
  }

  // ── Active session UI ──
  if (massRollState && stats) {
    const sorted = [...massRollState.participants]
      .filter((p) => p.result)
      .sort((a, b) => (b.result!.total) - (a.result!.total));
    const pending = massRollState.participants.filter((p) => !p.result);

    return (
      <div className="space-y-3">
        {/* Session header */}
        <div
          className="rounded-lg p-2.5 flex items-center justify-between gap-2"
          style={{
            background: 'linear-gradient(135deg, rgba(230, 126, 34, 0.10), rgba(230, 126, 34, 0.03))',
            border: '1px solid rgba(230, 126, 34, 0.2)',
          }}
        >
          <div className="flex items-center gap-2 min-w-0">
            <Zap className="size-4 flex-shrink-0" style={{ color: 'var(--fate-accent)' }} />
            <div className="min-w-0">
              <div className="text-xs font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                {massRollState.skillName}
                {massRollState.difficulty !== null && (
                  <span className="ml-1.5 text-[10px] font-normal" style={{ color: 'var(--fate-text-muted)' }}>
                    Сл {massRollState.difficulty}
                  </span>
                )}
                {massRollState.bonus !== 0 && (
                  <span className="ml-1.5 text-[10px] font-normal" style={{ color: 'var(--fate-text-muted)' }}>
                    {massRollState.bonus > 0 ? '+' : ''}{massRollState.bonus}
                  </span>
                )}
              </div>
              <div className="text-[9px]" style={{ color: 'var(--fate-text-muted)' }}>
                {massRollState.mode === 'opposed' ? 'Противостояние'
                  : massRollState.difficulty !== null ? 'Сложность' : 'Проверка'}
                {massRollState.opponentName && ` · vs ${massRollState.opponentName}`}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] flex-shrink-0">
            {massRollState.status === 'inviting' && (
              <span className="flex items-center gap-1" style={{ color: 'var(--fate-text-muted)' }}>
                <Clock className="size-3 animate-pulse" />
                {stats.ready}/{stats.online}
              </span>
            )}
            {massRollState.status === 'rolling' && (
              <span className="flex items-center gap-1" style={{ color: 'var(--fate-accent)' }}>
                <Dices className="size-3 animate-spin" />
                {stats.completed}/{stats.total}
              </span>
            )}
            {massRollState.status === 'complete' && (
              <span className="flex items-center gap-1" style={{ color: 'var(--fate-success)' }}>
                <Check className="size-3" />
                Готово
              </span>
            )}
          </div>
        </div>

        {/* Sorted results */}
        {sorted.length > 0 && (
          <div className="space-y-1">
            {sorted.map((p, idx) => {
              const isBest = idx === 0 && sorted.length > 1;
              const pRerolls = p.result?.rerollCount ?? 0;
              const pBonuses = p.result?.bonusCount ?? 0;
              const pFreeInvokes = p.result?.freeInvokeCount ?? 0;
              return (
                <div
                  key={p.characterId}
                  className="rounded-md p-2 flex items-center gap-2"
                  style={{
                    backgroundColor: isBest ? 'rgba(243, 156, 18, 0.10)' : 'var(--fate-bg-warm)',
                    border: `1px solid ${isBest ? 'rgba(243, 156, 18, 0.35)' : 'transparent'}`,
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
                      <span className="text-[11px] font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                        {p.characterName}
                      </span>
                      {p.characterType === 'pc' ? (
                        <Badge variant="outline" className="text-[7px] px-1 py-0">PC</Badge>
                      ) : (
                        <Badge variant="outline" className="text-[7px] px-1 py-0" style={{ color: 'var(--fate-text-muted)' }}>NPC</Badge>
                      )}
                      {pRerolls > 0 && (
                        <Badge variant="outline" className="text-[7px] px-1 py-0 gap-0.5" style={{ color: '#e67e22', borderColor: '#e67e22' }}>
                          <RefreshCw className="size-2" />
                          {pRerolls > 1 ? `×${pRerolls}` : ''}
                        </Badge>
                      )}
                      {pBonuses > 0 && (
                        <Badge variant="outline" className="text-[7px] px-1 py-0 gap-0.5" style={{ color: '#27ae60', borderColor: '#27ae60' }}>
                          <Plus className="size-2" />
                          {pBonuses * 2}
                        </Badge>
                      )}
                      {pFreeInvokes > 0 && (
                        <Badge variant="outline" className="text-[7px] px-1 py-0 gap-0.5" style={{ color: '#9b59b6', borderColor: '#9b59b6' }}>
                          <Gift className="size-2" />
                          {pFreeInvokes * 2}
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
                    <Badge className="text-[8px] mt-0.5 px-1 py-0" style={resultBadgeStyle(p.result?.resultLabel ?? '')}>
                      {p.result?.resultLabel}
                    </Badge>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pending participants */}
        {pending.length > 0 && (
          <div className="space-y-1">
            <div className="text-[9px] font-medium px-1" style={{ color: 'var(--fate-text-muted)' }}>
              Ожидают броска:
            </div>
            {pending.map((p) => (
              <div
                key={p.characterId}
                className="rounded-md p-1.5 flex items-center justify-between"
                style={{ backgroundColor: 'var(--fate-bg-warm)' }}
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <Clock className="size-3 animate-pulse flex-shrink-0" style={{ color: '#f39c12' }} />
                  <span className="text-[11px] font-medium truncate" style={{ color: 'var(--fate-text)' }}>
                    {p.characterName}
                  </span>
                </div>
                <Badge variant="outline" className="text-[8px] px-1 py-0" style={{ color: 'var(--fate-text-muted)' }}>
                  {p.ready ? 'Готов' : p.peerId === null ? 'GM бросит' : 'Ждём'}
                </Badge>
              </div>
            ))}
          </div>
        )}

        {/* Inviting phase: per-participant overrides */}
        {massRollState.status === 'inviting' && stats.completed === 0 && (
          <div className="space-y-1.5">
            <div className="text-[9px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
              Персонажи и навыки
            </div>
            {massRollState.participants.map((p) => (
              <div
                key={p.characterId}
                className="rounded-md p-1.5 space-y-1.5"
                style={{ backgroundColor: 'var(--fate-bg-warm)' }}
              >
                <div className="flex items-center justify-between gap-1.5">
                  <span className="text-[11px] font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                    {p.characterName}
                  </span>
                  {p.ready ? (
                    <Badge className="text-[8px] px-1 py-0 gap-0.5" style={{ backgroundColor: '#27ae60', color: 'white', border: 'none' }}>
                      <Check className="size-2" />Готов
                    </Badge>
                  ) : p.peerId === null ? (
                    <Badge variant="outline" className="text-[8px] px-1 py-0" style={{ color: 'var(--fate-text-muted)' }}>GM</Badge>
                  ) : (
                    <Badge variant="outline" className="text-[8px] px-1 py-0 gap-0.5" style={{ color: '#f39c12' }}>
                      <Clock className="size-2 animate-pulse" />Ждём
                    </Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <Select
                    value={p.skillName}
                    onValueChange={(v) => updateMassRollParticipant(p.characterId, { skillName: v })}
                  >
                    <SelectTrigger className="h-7 text-[10px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {availableSkills.map((s) => (
                        <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    value={p.manualBonus}
                    onChange={(e) => updateMassRollParticipant(p.characterId, { manualBonus: parseInt(e.target.value) || 0 })}
                    className="h-7 text-[10px]"
                    step={1}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-1.5 pt-1">
          {massRollState.status !== 'complete' && (
            <Button
              variant="outline"
              size="sm"
              className="flex-1 h-8 text-[11px] gap-1"
              onClick={handleCancel}
            >
              <X className="size-3" />
              Отмена
            </Button>
          )}
          {massRollState.status === 'inviting' && stats.online > 0 && !stats.allReady && (
            <Button
              size="sm"
              className="flex-1 h-8 text-[11px] gap-1 fate-btn-accent"
              onClick={handleForceStart}
            >
              <Zap className="size-3.5" />
              Бросить сейчас
            </Button>
          )}
          {massRollState.status === 'complete' && (
            <Button
              size="sm"
              className="flex-1 h-8 text-[11px] gap-1 fate-btn-accent"
              onClick={handleFinalize}
            >
              <Check className="size-3.5" />
              Записать в лог
            </Button>
          )}
        </div>

        {/* Progress hint */}
        {massRollState.status === 'inviting' && stats.online > 0 && (
          <div
            className="rounded-md p-1.5 flex items-center justify-center gap-1.5 text-[10px]"
            style={{ backgroundColor: 'var(--fate-bg-warm)', color: 'var(--fate-text-muted)' }}
          >
            <Clock className="size-3 animate-pulse" />
            {stats.allReady
              ? 'Все готовы — бросок вот-вот начнётся...'
              : `Ожидаем ${stats.online - stats.ready} игрока(ов)`}
          </div>
        )}
      </div>
    );
  }

  // ── Config form (no active session) ──
  return (
    <div className="space-y-3">
      {/* Character selection */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
            Персонажи ({selectedCharIds.size}/{sceneCharacters.length})
          </Label>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={selectAll}
              className="text-[9px] px-1.5 py-0.5 rounded transition-colors hover:opacity-70"
              style={{ color: 'var(--fate-accent)' }}
            >
              Все
            </button>
            <button
              type="button"
              onClick={deselectAll}
              className="text-[9px] px-1.5 py-0.5 rounded transition-colors hover:opacity-70"
              style={{ color: 'var(--fate-text-muted)' }}
            >
              Снять
            </button>
          </div>
        </div>
        {sceneCharacters.length === 0 ? (
          <div
            className="rounded-md p-3 text-center text-[10px]"
            style={{ color: 'var(--fate-text-muted)', backgroundColor: 'var(--fate-bg-warm)' }}
          >
            Нет персонажей на сцене
          </div>
        ) : (
          <div
            className="space-y-0.5 max-h-44 overflow-y-auto fate-scroll rounded-md p-1.5"
            style={{ backgroundColor: 'var(--fate-bg-warm)' }}
          >
            {sceneCharacters.map((char) => {
              const selected = selectedCharIds.has(char.id);
              return (
                <label
                  key={char.id}
                  className="flex items-center gap-2 px-1.5 py-1 rounded cursor-pointer transition-colors hover:bg-white/40 dark:hover:bg-white/5"
                >
                  <Checkbox
                    checked={selected}
                    onCheckedChange={() => toggleCharacter(char.id)}
                    className="size-3.5"
                  />
                  <CharAvatar char={char} size={18} />
                  <span className="text-[11px] font-medium truncate flex-1" style={{ color: 'var(--fate-text)' }}>
                    {char.name}
                  </span>
                  <span className="text-[9px] flex-shrink-0" style={{ color: 'var(--fate-text-muted)' }}>
                    +{getSkillValue(char, skillName)}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Skill */}
      <div className="space-y-1">
        <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
          Навык
        </Label>
        <Select value={skillName} onValueChange={setSkillName}>
          <SelectTrigger className="h-9 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableSkills.map((s) => (
              <SelectItem key={s} value={s} className="text-xs">{s}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Roll mode — 2 варианта: Проверка (со сложностью / без) и vs (противостояние) */}
      <div className="space-y-1">
        <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
          Тип броска
        </Label>
        <div className="flex items-center gap-0.5 rounded-lg p-0.5" style={{ backgroundColor: 'var(--fate-bg-warm)' }}>
          {([
            { mode: 'normal' as const, label: 'Проверка' },
            { mode: 'opposed' as const, label: 'vs' },
          ]).map(({ mode, label }) => (
            <button
              key={mode}
              type="button"
              onClick={() => setRollMode(mode)}
              className={`flex-1 rounded-md px-1 py-1.5 text-[10px] font-medium transition-all ${
                rollMode === mode
                  ? 'bg-background shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              style={rollMode === mode ? { color: 'var(--fate-text)' } : undefined}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Чекбокс «бросок без сложности» (объединяет проверку и сложность) ── */}
      {rollMode === 'normal' && (
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

      {/* Difficulty — показывается в режиме 'normal', пока чекбокс снят */}
      {rollMode === 'normal' && !noDifficulty && (
        <div className="space-y-1 animate-slide-down">
          <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
            Сложность
          </Label>
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="size-8 p-0" onClick={() => setDifficulty((d) => Math.max(0, d - 1))}>−</Button>
            <Input
              type="number"
              value={difficulty}
              onChange={(e) => setDifficulty(parseInt(e.target.value) || 0)}
              className="h-8 text-center text-sm font-semibold"
            />
            <Button variant="outline" size="sm" className="size-8 p-0" onClick={() => setDifficulty((d) => d + 1)}>+</Button>
          </div>
          {/* Quick presets */}
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

      {/* ── Противостояние (vs): безымянный NPC или выбор персонажа ── */}
      {rollMode === 'opposed' && (
        <div className="space-y-2 rounded-lg p-2.5 animate-slide-down" style={{ backgroundColor: 'rgba(192, 57, 43, 0.05)', border: '1px solid rgba(192, 57, 43, 0.15)' }}>
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
            <div className="space-y-1">
              <Label className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--fate-text-muted)' }}>
                Противник
              </Label>
              <Select value={opponentId} onValueChange={setOpponentId}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Выберите противника" />
                </SelectTrigger>
                <SelectContent>
                  {opponentOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id} className="text-xs">
                      <span className="flex items-center gap-1.5">
                        <CharAvatar char={c} size={16} />
                        <span className="truncate">{c.name}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {/* Bonus */}
      <div className="flex items-center justify-between gap-2">
        <Label className="text-[10px] font-medium uppercase tracking-wide whitespace-nowrap" style={{ color: 'var(--fate-text-muted)' }}>
          Бонус
        </Label>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="size-7 p-0" onClick={() => setBonus((b) => Math.max(-10, b - 1))}>−</Button>
          <Input
            type="number"
            value={bonus}
            onChange={(e) => setBonus(parseInt(e.target.value) || 0)}
            className="h-7 w-14 text-center text-sm font-semibold"
          />
          <Button variant="outline" size="sm" className="size-7 p-0" onClick={() => setBonus((b) => Math.min(20, b + 1))}>+</Button>
        </div>
      </div>

      {/* Start button */}
      <Button
        onClick={handleStartUnified}
        disabled={selectedCharIds.size === 0 || (rollMode === 'opposed' && !unnamedNpc && !opponentId)}
        className="w-full h-11 gap-2 text-sm font-semibold fate-btn-accent fate-button-shine"
        size="lg"
      >
        {hasOnlinePCs ? (
          <>
            <Users className="size-4" />
            Пригласить игроков
          </>
        ) : (
          <>
            <Dices className="size-4" />
            Бросить для всех
          </>
        )}
      </Button>
      <p className="text-[9px] text-center leading-tight" style={{ color: 'var(--fate-text-muted)' }}>
        {hasOnlinePCs
          ? 'Игроки получат приглашение и отметят готовность'
          : 'Все броски выполнятся локально'}
      </p>
    </div>
  );
}
