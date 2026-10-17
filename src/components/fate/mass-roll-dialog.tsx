'use client';

import React, { Component, useState, useEffect, useCallback, useMemo } from 'react';
import { Dice5, Dices, ShieldAlert, Users, Zap, Check, Clock, Flame, X, RefreshCw, Plus, Gift, GripVertical, Crown } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { FloatingPanel } from '@/components/ui/floating-panel';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useFateStore } from '@/lib/store';
import { performRoll } from '@/lib/fate-dice';
import type { Character, RollResult } from '@/lib/types';
import { DiceChips } from '@/components/fate/dice-chips';
import { useNetwork } from '@/hooks/use-network';

type RollMode = 'normal' | 'difficulty' | 'opposed';

interface MassRollResult {
  characterId: string;
  characterName: string;
  skillValue: number;
  dice: number[];
  diceSum: number;
  bonus: number;
  total: number;
  result: RollResult;
}

interface MassRollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MassRollDialog({ open, onOpenChange }: MassRollDialogProps) {
  const store = useFateStore();
  const getSceneCharacters = store.getSceneCharacters;
  const addLogEntry = store.addLogEntry;
  const currentAdventureId = store.currentAdventureId;
  const getCharacter = store.getCharacter;
  const settings = store.settings;
  const massRollState = store.massRollState;
  const isNetworkActive = store.isNetworkActive;
  const networkRole = store.networkRole;
  const {
    startMassRoll,
    updateMassRollParticipant,
    forceStartMassRoll,
    finalizeMassRoll,
    cancelMassRoll,
  } = store;
  const { broadcastMassRollInvite, broadcastMassRollStart, broadcastMassRollCancel, broadcastMassRollResults } = useNetwork();
  // ── Access control ───────────────────────────────────────────
  // Mass roll is a GM-only tool. Network players never see the entry point
  // in the header dropdown, but defense in depth: gate the dialog body too.
  const canTeamRoll = store.canTeamRoll();
  let sceneCharacters: Character[] = [];
  try {
    sceneCharacters = getSceneCharacters();
  } catch {
    sceneCharacters = [];
  }
  // Memoize to avoid infinite re-renders in useEffect
  const sceneCharIds = useMemo(() => sceneCharacters.map(c => c.id).join(','), [sceneCharacters]);

  const [selectedCharIds, setSelectedCharIds] = useState<Set<string>>(new Set());
  const [skillName, setSkillName] = useState<string>('Бой');
  const [bonus, setBonus] = useState(0);
  const [rollMode, setRollMode] = useState<RollMode>('normal');
  const [difficulty, setDifficulty] = useState(2);
  const [opponentId, setOpponentId] = useState<string>('');
  const [opponentSkillName, setOpponentSkillName] = useState<string>('');
  const [isRolling, setIsRolling] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const [results, setResults] = useState<MassRollResult[]>([]);
  const [rollingDice, setRollingDice] = useState<number[]>([0, 0, 0, 0]);
  const [logged, setLogged] = useState(false);
  const [crowdTeamEffort, setCrowdTeamEffort] = useState(false);

  // Helper: compute Fate Core "mobs" crowd team effort bonus for a character
  const computeCrowdHelperBonus = useCallback(
    (char: Character, name: string): number => {
      if (!char.isHorde || !char.members || !name) return 0;
      const activeMembers = char.members.filter((m) => m.isActive);
      let helperBonus = 0;
      for (let i = 1; i < activeMembers.length; i++) {
        const member = activeMembers[i];
        const baseChar = store.characters.find((c) => c.id === member.baseCharacterId);
        const baseSkillValue = baseChar?.skills.find((s) => s.name === name)?.value ?? 0;
        const charSkillValue = char.skills.find((s) => s.name === name)?.value ?? 0;
        const effectiveSkill = baseChar ? baseSkillValue : charSkillValue;
        if (effectiveSkill >= 1) helperBonus++;
      }
      return helperBonus;
    },
    [store.characters],
  );

  // Available skills from adventure settings
  const availableSkills = useMemo(() => {
    return settings.baseSkills ?? [];
  }, [settings.baseSkills]);

  // Initialize: select all characters when dialog opens
  useEffect(() => {
    if (open) {
      setSelectedCharIds(new Set(sceneCharacters.map((c) => c.id)));
      setResults([]);
      setShowResults(false);
      setLogged(false);
      setBonus(0);
      setRollMode('normal');
      setDifficulty(2);
      setOpponentId('');
      setOpponentSkillName('');
      setCrowdTeamEffort(false);
    }
  }, [open, sceneCharIds]);

  // Animate rolling dice display
  useEffect(() => {
    if (!isRolling) return;
    const interval = setInterval(() => {
      setRollingDice([
        Math.floor(Math.random() * 3) - 1,
        Math.floor(Math.random() * 3) - 1,
        Math.floor(Math.random() * 3) - 1,
        Math.floor(Math.random() * 3) - 1,
      ]);
    }, 80);
    return () => clearInterval(interval);
  }, [isRolling]);

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

  const getSkillValue = useCallback(
    (char: Character, name: string): number => {
      const skill = char.skills.find((s) => s.name === name);
      return skill?.value ?? 0;
    },
    [],
  );

  const handleRoll = useCallback(async () => {
    // Defense in depth: the roll UI is hidden when the user can't perform
    // a mass roll, but guard the handler anyway in case of stale renders.
    if (!canTeamRoll) return;
    if (selectedCharIds.size === 0) return;
    setIsRolling(true);
    setShowResults(false);
    setLogged(false);

    await new Promise((resolve) => setTimeout(resolve, 700));

    try {
      const diff = rollMode === 'difficulty' ? difficulty : null;
      let opponentTotal: number | null = null;

      if (rollMode === 'opposed' && opponentId) {
        const oppChar = getCharacter(opponentId);
        if (oppChar) {
          const oppSkillVal = opponentSkillName
            ? oppChar.skills.find((s) => s.name === opponentSkillName)?.value ?? 0
            : getSkillValue(oppChar, skillName);
          const oppRoll = performRoll(oppSkillVal);
          opponentTotal = oppRoll.total;
        }
      }

      const rollResults: MassRollResult[] = [];

      for (const charId of selectedCharIds) {
        const char = getCharacter(charId);
        if (!char) continue;

        const skillVal = getSkillValue(char, skillName);
        const crowdHelperBonus = crowdTeamEffort ? computeCrowdHelperBonus(char, skillName) : 0;
        const totalBonus = skillVal + bonus + crowdHelperBonus;
        const result = performRoll(totalBonus, diff, opponentTotal);
        const diceSum = result.dice.reduce<number>((a, b) => a + b, 0);

        rollResults.push({
          characterId: char.id,
          characterName: char.name,
          skillValue: skillVal,
          dice: [...result.dice],
          diceSum,
          bonus,
          total: result.total,
          result,
        });
      }

      // Sort by total descending
      rollResults.sort((a, b) => b.total - a.total);

      setResults(rollResults);
      setShowResults(true);
    } finally {
      setIsRolling(false);
    }
  }, [selectedCharIds, skillName, bonus, rollMode, difficulty, opponentId, opponentSkillName, getCharacter, getSkillValue, crowdTeamEffort, computeCrowdHelperBonus, canTeamRoll]);

  const handleLog = useCallback(async () => {
    if (!canTeamRoll) return;
    if (results.length === 0) return;

    const diff = rollMode === 'difficulty' ? difficulty : null;
    let opponentTotal: number | null = null;
    if (rollMode === 'opposed' && opponentId) {
      const oppChar = getCharacter(opponentId);
      if (oppChar) {
        const oppSkillVal = opponentSkillName
          ? oppChar.skills.find((s) => s.name === opponentSkillName)?.value ?? 0
          : getSkillValue(oppChar, skillName);
        const oppRoll = performRoll(oppSkillVal);
        opponentTotal = oppRoll.total;
      }
    }

    // Log each individual result
    for (const r of results) {
      const rChar = getCharacter(r.characterId);
      const rCrowdBonus = crowdTeamEffort && rChar ? computeCrowdHelperBonus(rChar, skillName) : 0;
      const crowdText = rCrowdBonus > 0
        ? ` — 🤝 Толпа: +${rCrowdBonus}`
        : '';
      await addLogEntry({
        adventureId: currentAdventureId ?? undefined,
        characterId: r.characterId,
        characterName: r.characterName,
        skillName,
        diceResults: r.dice,
        bonus: r.skillValue + r.bonus + rCrowdBonus,
        total: r.total,
        difficulty: diff,
        opponentTotal,
        result: r.result.label,
        opponentType: rollMode === 'opposed' && opponentId ? 'character' : null,
        opponentCharacterId: rollMode === 'opposed' && opponentId ? opponentId : null,
        opponentName: rollMode === 'opposed' && opponentId ? getCharacter(opponentId)?.name ?? null : null,
        opponentSkillName: rollMode === 'opposed' ? opponentSkillName || null : null,
        opponentDiceResults: [],
        opponentBonus: 0,
        // ── Opponent rich-tooltip fields ──
        opponentSkillValue: rollMode === 'opposed' && opponentId
          ? (getCharacter(opponentId)?.skills.find((s) => s.name === (opponentSkillName || skillName))?.value ?? 0)
          : null,
        opponentManualBonus: 0,
        extraBonus: r.bonus + rCrowdBonus,
        extraBonusReason: (r.bonus !== 0 || rCrowdBonus !== 0) ? 'Ситуативный бонус' : '',
        rerolled: false,
        customText: `🎲 Массовый бросок${crowdText}`,
        isRiftEvent: false,
        // ── Rich-tooltip fields ──
        skillValue: r.skillValue,
        manualBonus: r.bonus + rCrowdBonus,
        helpers: [],
        aspectInvokeBonus: 0,
        aspectInvokeReason: '',
        aspectRerolled: false,
      });
    }

    // Log summary entry
    const best = results[0]; // sorted desc
    const worst = results[results.length - 1];
    await addLogEntry({
      adventureId: currentAdventureId ?? undefined,
      characterId: null,
      characterName: 'Система',
      skillName,
      diceResults: [],
      bonus: 0,
      total: 0,
      difficulty: null,
      opponentTotal: null,
      result: '',
      opponentType: null,
      opponentName: null,
      opponentSkillName: null,
      opponentDiceResults: [],
      opponentBonus: 0,
      extraBonus: 0,
      extraBonusReason: '',
      rerolled: false,
      customText: `Массовый бросок (${results.length} персонажей, навык: ${skillName}). Лучший: ${best.characterName} (+${best.total}), Худший: ${worst.characterName} (+${worst.total})`,
      isRiftEvent: false,
      // ── Rich-tooltip fields ──
      skillValue: null,
      manualBonus: 0,
      helpers: [],
      aspectInvokeBonus: 0,
      aspectInvokeReason: '',
      aspectRerolled: false,
    });

    setLogged(true);
  }, [results, rollMode, difficulty, opponentId, opponentSkillName, skillName, currentAdventureId, addLogEntry, getCharacter, getSkillValue, crowdTeamEffort, computeCrowdHelperBonus, canTeamRoll]);

  const getResultColor = (type: string) => {
    switch (type) {
      case 'fail': return 'var(--fate-danger)';
      case 'tie': return '#f39c12';
      case 'success': return 'var(--fate-success)';
      case 'great': return '#1e8449';
    }
    return 'var(--fate-text-muted)';
  };

  const getResultBg = (type: string) => {
    switch (type) {
      case 'fail': return 'rgba(231, 76, 60, 0.06)';
      case 'tie': return 'rgba(243, 156, 18, 0.06)';
      case 'success': return 'rgba(39, 174, 96, 0.06)';
      case 'great': return 'rgba(30, 132, 73, 0.08)';
    }
    return 'var(--fate-bg-warm)';
  };

  // ── Result label helpers (match player's RollInvitationPanel design) ──
  // Russian result labels → badge colors. Same palette as the player panel
  // so GM and players see identical result styling.
  const RESULT_LABEL_COLORS: Record<string, string> = {
    'Стиль': '#9b59b6',
    'Успех': '#27ae60',
    'Ничья': '#f39c12',
    'Провал': '#e74c3c',
  };
  const resultBadgeStyle = (label: string): React.CSSProperties => {
    const color = RESULT_LABEL_COLORS[label] ?? '#7f8c8d';
    return { backgroundColor: color, color: 'white', border: 'none' };
  };
  const formatTotal = (total: number): string => total >= 0 ? `+${total}` : String(total);

  const bestResult = results.length > 0 ? results[0] : null;
  const worstResult = results.length > 0 ? results[results.length - 1] : null;

  // ── Unified Mass Roll: start a session with invitations to online players ──
  // This is the new flow that supports per-participant overrides + ready state.
  // Falls back to offline roll when no online PCs are selected.
  const handleStartUnifiedRoll = useCallback(() => {
    if (!canTeamRoll || selectedCharIds.size === 0) return;
    const diff = rollMode === 'difficulty' ? difficulty : null;
    const sessionId = startMassRoll({
      mode: rollMode,
      skillName,
      bonus,
      difficulty: diff,
      characterIds: Array.from(selectedCharIds),
      opponentId: rollMode === 'opposed' ? opponentId : undefined,
      opponentSkillName: rollMode === 'opposed' ? opponentSkillName : undefined,
    });
    // Broadcast invitations to all online participants (PC with peerId !== null).
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
      forceStartMassRoll();
    }
  }, [canTeamRoll, selectedCharIds, rollMode, difficulty, skillName, bonus, opponentId, opponentSkillName, startMassRoll, isNetworkActive, networkRole, broadcastMassRollInvite, forceStartMassRoll]);

  // ── Force-start: GM clicks "Бросить сейчас" before everyone is ready ──
  const handleForceStart = useCallback(() => {
    const session = useFateStore.getState().massRollState;
    if (!session) return;
    // Broadcast start signal to online participants (they auto-roll + send back).
    const onlinePeerIds = session.participants
      .filter((p) => p.peerId !== null && !p.ready)
      .map((p) => p.peerId!);
    if (onlinePeerIds.length > 0) {
      broadcastMassRollStart(session.id, onlinePeerIds);
    }
    // Roll locally for NPC + offline PC + any unready online PC.
    forceStartMassRoll();
    // Broadcast the full updated results (with NPC/offline rolls done by host)
    // so online players immediately see everyone's dice in their dialog.
    const updated = useFateStore.getState().massRollState;
    if (updated) {
      broadcastMassRollResults(updated);
    }
  }, [broadcastMassRollStart, forceStartMassRoll, broadcastMassRollResults]);

  // ── Cancel: GM aborts the session ──
  const handleCancelUnified = useCallback(() => {
    const session = useFateStore.getState().massRollState;
    if (!session) return;
    // Tell all online participants to close their invitation dialogs.
    const onlinePeerIds = session.participants
      .filter((p) => p.peerId !== null)
      .map((p) => p.peerId!);
    if (onlinePeerIds.length > 0) {
      broadcastMassRollCancel(session.id, onlinePeerIds);
    }
    cancelMassRoll();
  }, [broadcastMassRollCancel, cancelMassRoll]);

  // ── Finalize: GM clicks "Записать в лог" after all results are in ──
  const handleFinalizeUnified = useCallback(async () => {
    const session = useFateStore.getState().massRollState;
    if (!session) return;
    // Tell all online participants to close their dialogs (session finalized).
    const onlinePeerIds = session.participants
      .filter((p) => p.peerId !== null)
      .map((p) => p.peerId!);
    if (onlinePeerIds.length > 0) {
      broadcastMassRollCancel(session.id, onlinePeerIds);
    }
    await finalizeMassRoll();
  }, [broadcastMassRollCancel, finalizeMassRoll]);

  // Determine if any online PCs are among the selected characters. If so, we
  // show the "Пригласить игроков" button; otherwise we show the legacy
  // "Бросить для всех" button (offline-only).
  const hasOnlinePCs = useMemo(() => {
    if (!isNetworkActive || networkRole !== 'host') return false;
    const { playerAssignments } = store;
    for (const charId of selectedCharIds) {
      for (const charIds of Object.values(playerAssignments)) {
        if (charIds.includes(charId)) return true;
      }
    }
    return false;
  }, [isNetworkActive, networkRole, selectedCharIds, store.playerAssignments]);

  // Whether the unified session is active (showing waiting/results UI).
  const unifiedActive = massRollState !== null;

  // Quick stats for the unified session.
  const unifiedStats = useMemo(() => {
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

  // ── Compute header badge for the floating panel ──
  const panelBadge = unifiedActive && unifiedStats
    ? massRollState!.status === 'inviting'
      ? <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5" style={{ color: '#f39c12' }}><Clock className="size-2.5" />{unifiedStats.ready}/{unifiedStats.online} готовы</Badge>
      : massRollState!.status === 'rolling'
      ? <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5" style={{ color: 'var(--fate-accent)' }}><Dices className="size-2.5 animate-spin" />{unifiedStats.completed}/{unifiedStats.total}</Badge>
      : <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5" style={{ color: 'var(--fate-success)' }}><Check className="size-2.5" />Готово</Badge>
    : <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5" style={{ color: 'var(--fate-text-muted)' }}>{selectedCharIds.size} выбрано</Badge>;

  return (
    <FloatingPanel
      open={open}
      onClose={() => onOpenChange(false)}
      title="🎲 Массовый бросок"
      subtitle="Бросок кубиков для нескольких персонажей"
      icon={<Dice5 className="size-4" />}
      badge={panelBadge}
      width={580}
      storageKey="mass-roll-gm"
      contentClassName="p-4 space-y-4"
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg gap-1.5"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-3.5" />
            Закрыть
          </Button>

          {/* ── Unified session footer ─────────────────────────── */}
          {unifiedActive && massRollState && unifiedStats && (
            <>
              {massRollState.status !== 'complete' && (
                <Button
                  variant="outline"
                  size="sm"
                  className="rounded-lg gap-1.5"
                  onClick={handleCancelUnified}
                >
                  <X className="size-3.5" />
                  Отменить
                </Button>
              )}

              {massRollState.status === 'inviting' && unifiedStats.online > 0 && !unifiedStats.allReady && (
                <Button
                  size="sm"
                  className="fate-btn-accent fate-button-shine gap-1.5 rounded-lg"
                  onClick={handleForceStart}
                >
                  <Zap className="size-4" />
                  Бросить сейчас
                </Button>
              )}

              {massRollState.status === 'complete' && (
                <Button
                  size="sm"
                  className="fate-btn-accent fate-button-shine gap-1.5 rounded-lg"
                  onClick={handleFinalizeUnified}
                >
                  <Check className="size-4" />
                  Записать в лог
                </Button>
              )}
            </>
          )}

          {/* ── Legacy footer (offline-only flow) ──────────────── */}
          {!unifiedActive && canTeamRoll && showResults && results.length > 0 && !isRolling && (
            <>
              <Button
                variant="outline"
                size="sm"
                className="rounded-lg gap-1.5"
                onClick={handleRoll}
                disabled={isRolling || selectedCharIds.size === 0}
              >
                <Dice5 className="size-3.5" />
                Бросить снова
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="rounded-lg gap-1.5"
                onClick={handleLog}
                disabled={logged}
                style={logged ? { color: 'var(--fate-success)' } : {}}
              >
                {logged ? '✓ Записано' : '📝 Записать в лог'}
              </Button>
            </>
          )}

          {!unifiedActive && canTeamRoll && (!showResults || results.length === 0 || isRolling) && (
            <>
              {hasOnlinePCs && !isRolling && (
                <Button
                  size="sm"
                  disabled={selectedCharIds.size === 0 || (rollMode === 'opposed' && !opponentId)}
                  onClick={handleStartUnifiedRoll}
                  className="fate-btn-accent fate-button-shine gap-1.5 rounded-lg"
                >
                  <Users className="size-4" />
                  Пригласить игроков
                </Button>
              )}
              <Button
                size="sm"
                disabled={isRolling || selectedCharIds.size === 0 || (rollMode === 'opposed' && !opponentId)}
                onClick={handleRoll}
                variant={hasOnlinePCs ? 'outline' : 'default'}
                className={hasOnlinePCs ? 'rounded-lg gap-1.5' : 'fate-btn-accent fate-button-shine gap-1.5 rounded-lg'}
              >
                <Dices className={`size-4 ${isRolling ? 'animate-spin' : ''}`} />
                {isRolling ? 'Бросаю...' : hasOnlinePCs ? 'Бросить локально' : '🎲 Бросить для всех'}
              </Button>
            </>
          )}
        </>
      }
    >
      {/* Drag hint banner — explains that the panel is movable */}
      <div
        className="rounded-lg px-3 py-1.5 flex items-center gap-1.5 text-[10px]"
        style={{ backgroundColor: 'var(--fate-bg-warm)', color: 'var(--fate-text-muted)' }}
      >
        <GripVertical className="size-3 flex-shrink-0" />
        <span>Тяни за заголовок, чтобы отодвинуть окно и увидеть карту. Окно не закрывается при работе с другими панелями.</span>
      </div>

      <div className="space-y-4">
          {/* ── Unified Mass Roll session UI ─────────────────────── */}
          {/* When a massRollSession is active, show the waiting/results UI
              instead of the setup form. This replaces the legacy offline
              flow when online players are involved. */}
          {unifiedActive && massRollState && unifiedStats && (
            <div className="space-y-3 animate-fade-in">
              {/* Session header */}
              <div
                className="rounded-xl p-3 flex items-center justify-between"
                style={{
                  background: 'linear-gradient(135deg, rgba(230, 126, 34, 0.08), rgba(230, 126, 34, 0.03))',
                  border: '1px solid rgba(230, 126, 34, 0.15)',
                }}
              >
                <div className="flex items-center gap-2">
                  <Zap className="size-4" style={{ color: 'var(--fate-accent)' }} />
                  <div>
                    <div className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                      {massRollState.skillName}
                      {massRollState.difficulty !== null && (
                        <span className="ml-2 text-xs font-normal" style={{ color: 'var(--fate-text-muted)' }}>
                          сложность {massRollState.difficulty}
                        </span>
                      )}
                      {massRollState.bonus !== 0 && (
                        <span className="ml-2 text-xs font-normal" style={{ color: 'var(--fate-text-muted)' }}>
                          бонус {massRollState.bonus > 0 ? '+' : ''}{massRollState.bonus}
                        </span>
                      )}
                    </div>
                    <div className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                      {massRollState.mode === 'opposed' ? 'Противостояние' :
                       massRollState.difficulty !== null ? 'Сложность' : 'Проверка'}
                      {massRollState.opponentName && ` · vs ${massRollState.opponentName}`}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  {massRollState.status === 'inviting' && (
                    <span className="flex items-center gap-1.5" style={{ color: 'var(--fate-text-muted)' }}>
                      <Clock className="size-3.5 animate-pulse" />
                      {unifiedStats.ready}/{unifiedStats.online} готовы
                    </span>
                  )}
                  {massRollState.status === 'rolling' && (
                    <span className="flex items-center gap-1.5" style={{ color: 'var(--fate-accent)' }}>
                      <Dices className="size-3.5 animate-spin" />
                      {unifiedStats.completed}/{unifiedStats.total}
                    </span>
                  )}
                  {massRollState.status === 'complete' && (
                    <span className="flex items-center gap-1.5" style={{ color: 'var(--fate-success)' }}>
                      <Check className="size-3.5" />
                      Готово
                    </span>
                  )}
                </div>
              </div>

              {/* ── Participants list ── */}
              {/* When results exist (rolling/complete): show SORTED results list
                  identical to the player's RollInvitationPanel — best on top,
                  with rank icons (👑), dice chips, result badges (Стиль/Успех/
                  Ничья/Провал), and adjustment badges.
                  When inviting (no results yet): show the detailed list with
                  per-participant skill/bonus overrides. */}
              {unifiedStats.completed > 0 ? (
                <>
                  {/* Sorted results — best on top, matching player panel */}
                  <div className="space-y-1.5">
                    {[...massRollState.participants]
                      .filter((p) => p.result)
                      .sort((a, b) => (b.result!.total) - (a.result!.total))
                      .map((p, idx) => {
                        const isBest = idx === 0 && unifiedStats!.completed > 1;
                        const pRerolls = p.result?.rerollCount ?? 0;
                        const pBonuses = p.result?.bonusCount ?? 0;
                        const pFreeInvokes = p.result?.freeInvokeCount ?? 0;
                        return (
                          <div
                            key={p.characterId}
                            className="rounded-lg p-2.5 flex items-center gap-2.5 transition-all"
                            style={{
                              backgroundColor: isBest ? 'rgba(243, 156, 18, 0.10)' : 'var(--fate-bg-warm)',
                              border: `1px solid ${isBest ? 'rgba(243, 156, 18, 0.35)' : 'transparent'}`,
                            }}
                          >
                            {/* Rank / icon */}
                            <div className="flex-shrink-0 w-6 flex items-center justify-center">
                              {isBest ? (
                                <Crown className="size-4" style={{ color: '#f39c12' }} />
                              ) : (
                                <span className="text-[10px] font-bold" style={{ color: 'var(--fate-text-muted)' }}>
                                  {idx + 1}
                                </span>
                              )}
                            </div>

                            {/* Name + dice + adjustment badges */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <span className="text-xs font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                                  {p.characterName}
                                </span>
                                {p.characterType === 'pc' ? (
                                  <Badge variant="outline" className="text-[8px] px-1 py-0">PC</Badge>
                                ) : (
                                  <Badge variant="outline" className="text-[8px] px-1 py-0" style={{ color: 'var(--fate-text-muted)' }}>NPC</Badge>
                                )}
                                {p.peerName && (
                                  <span className="text-[9px]" style={{ color: 'var(--fate-text-muted)' }}>
                                    · {p.peerName}
                                  </span>
                                )}
                                {pRerolls > 0 && (
                                  <Badge variant="outline" className="text-[8px] px-1 py-0 gap-0.5" style={{ color: '#e67e22', borderColor: '#e67e22' }} title={`Переброшено ${pRerolls} раз(а) — потрачено ${pRerolls} жетон(а)`}>
                                    <RefreshCw className="size-2.5" />
                                    {pRerolls > 1 ? `×${pRerolls}` : ''}
                                  </Badge>
                                )}
                                {pBonuses > 0 && (
                                  <Badge variant="outline" className="text-[8px] px-1 py-0 gap-0.5" style={{ color: '#27ae60', borderColor: '#27ae60' }} title={`+${pBonuses * 2} бонус(а) — потрачено ${pBonuses} жетон(а)`}>
                                    <Plus className="size-2.5" />
                                    {pBonuses * 2}{pBonuses > 1 ? ` (×${pBonuses})` : ''}
                                  </Badge>
                                )}
                                {pFreeInvokes > 0 && (
                                  <Badge variant="outline" className="text-[8px] px-1 py-0 gap-0.5" style={{ color: '#9b59b6', borderColor: '#9b59b6' }} title={`${pFreeInvokes} бесплатных призывов (без траты жетонов)`}>
                                    <Gift className="size-2.5" />
                                    {pFreeInvokes * 2}{pFreeInvokes > 1 ? ` (×${pFreeInvokes})` : ''}
                                  </Badge>
                                )}
                              </div>
                              <div className="mt-0.5">
                                <DiceChips dice={p.result?.dice} size="sm" animate={false} />
                              </div>
                            </div>

                            {/* Total + result badge */}
                            <div className="flex-shrink-0 text-right">
                              <div className="text-lg font-black leading-none" style={{ color: 'var(--fate-text)' }}>
                                {formatTotal(p.result?.total ?? 0)}
                              </div>
                              <Badge
                                className="text-[9px] mt-0.5 px-1.5 py-0"
                                style={resultBadgeStyle(p.result?.resultLabel ?? '')}
                              >
                                {p.result?.resultLabel}
                              </Badge>
                            </div>
                          </div>
                        );
                      })}
                  </div>

                  {/* Pending participants (still waiting to roll) */}
                  {massRollState.participants.filter((p) => !p.result).length > 0 && (
                    <div className="space-y-1">
                      <div className="text-[10px] font-medium px-1" style={{ color: 'var(--fate-text-muted)' }}>
                        Ожидают броска:
                      </div>
                      {massRollState.participants
                        .filter((p) => !p.result)
                        .map((p) => (
                          <div
                            key={p.characterId}
                            className="rounded-lg p-2 flex items-center justify-between"
                            style={{ backgroundColor: 'var(--fate-bg-warm)' }}
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <Clock className="size-3.5 animate-pulse flex-shrink-0" style={{ color: '#f39c12' }} />
                              <span className="text-xs font-medium truncate" style={{ color: 'var(--fate-text)' }}>
                                {p.characterName}
                              </span>
                              {p.peerName && (
                                <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                                  · {p.peerName}
                                </span>
                              )}
                            </div>
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0" style={{ color: 'var(--fate-text-muted)' }}>
                              {p.ready ? 'Готов, ждём бросок' : p.peerId === null ? 'GM бросит' : 'Ждём готовности'}
                            </Badge>
                          </div>
                        ))}
                    </div>
                  )}
                </>
              ) : (
                /* ── Inviting phase: detailed list with per-participant overrides ── */
                <div className="space-y-1.5">
                  {massRollState.participants.map((p) => (
                    <div
                      key={p.characterId}
                      className="rounded-lg p-2.5 space-y-2"
                      style={{
                        backgroundColor: 'var(--fate-bg-warm)',
                        border: '1px solid transparent',
                      }}
                    >
                      {/* Top row: name + status */}
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-sm font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                            {p.characterName}
                          </span>
                          {p.characterType === 'pc' ? (
                            <Badge variant="outline" className="text-[9px] px-1 py-0">PC</Badge>
                          ) : (
                            <Badge variant="outline" className="text-[9px] px-1 py-0" style={{ color: 'var(--fate-text-muted)' }}>NPC</Badge>
                          )}
                          {p.peerName && (
                            <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                              · {p.peerName}
                            </span>
                          )}
                        </div>
                        {/* Status badge */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          {p.fatePointMode !== 'none' && (
                            <Badge
                              className="text-[9px] px-1.5 py-0 gap-0.5"
                              style={{ backgroundColor: '#e67e22', color: 'white', border: 'none' }}
                            >
                              <Flame className="size-2.5" />
                              {p.fatePointMode === 'plus2' ? '+2' : '⟳'}
                            </Badge>
                          )}
                          {p.ready ? (
                            <Badge className="text-[9px] px-1.5 py-0 gap-0.5" style={{ backgroundColor: '#27ae60', color: 'white', border: 'none' }}>
                              <Check className="size-2.5" />
                              Готов
                            </Badge>
                          ) : p.peerId === null ? (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0" style={{ color: 'var(--fate-text-muted)' }}>
                              GM бросит
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-[9px] px-1.5 py-0 gap-0.5" style={{ color: '#f39c12' }}>
                              <Clock className="size-2.5 animate-pulse" />
                              Ждём
                            </Badge>
                          )}
                        </div>
                      </div>

                      {/* Per-participant overrides (only in inviting status, no result yet) */}
                      {massRollState!.status === 'inviting' && !p.result && (
                        <div className="grid grid-cols-2 gap-2">
                          {/* Skill override */}
                          <div className="space-y-0.5">
                            <Label className="text-[9px]" style={{ color: 'var(--fate-text-muted)' }}>
                              Навык
                            </Label>
                            <Select
                              value={p.skillName}
                              onValueChange={(v) => updateMassRollParticipant(p.characterId, { skillName: v })}
                            >
                              <SelectTrigger className="h-7 text-[11px] rounded-md">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {availableSkills.map((s) => (
                                  <SelectItem key={s} value={s} className="text-xs">
                                    {s}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                          {/* Manual bonus */}
                          <div className="space-y-0.5">
                            <Label className="text-[9px]" style={{ color: 'var(--fate-text-muted)' }}>
                              Бонус (трюк)
                            </Label>
                            <Input
                              type="number"
                              value={p.manualBonus}
                              onChange={(e) => updateMassRollParticipant(p.characterId, { manualBonus: parseInt(e.target.value) || 0 })}
                              className="h-7 text-[11px] rounded-md"
                              step={1}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Progress hint */}
              {massRollState.status === 'inviting' && unifiedStats.online > 0 && (
                <div
                  className="rounded-lg p-2 flex items-center justify-center gap-2 text-xs"
                  style={{ backgroundColor: 'var(--fate-bg-warm)', color: 'var(--fate-text-muted)' }}
                >
                  <Clock className="size-3.5 animate-pulse" />
                  {unifiedStats.allReady
                    ? 'Все готовы — бросок сейчас начнётся...'
                    : `Ожидаем готовности от ${unifiedStats.online - unifiedStats.ready} игрока(ов)`}
                </div>
              )}
            </div>
          )}

          {/* ── Legacy setup form (only shown when no unified session active) ── */}
          {!unifiedActive && (
            <>
          {/* Blocking message — shown when the current user can't perform a
              mass roll. Network players never see the menu entry that opens
              this dialog, but defense in depth: gate the body too. Close (X)
              corner button and the "Закрыть" footer button still work. */}
          {!canTeamRoll ? (
            <div
              className="rounded-xl p-8 flex flex-col items-center justify-center text-center gap-3 animate-fade-in"
              style={{
                backgroundColor: 'rgba(231, 76, 60, 0.05)',
                border: '1px solid rgba(231, 76, 60, 0.2)',
                minHeight: 240,
              }}
            >
              <div
                className="size-14 rounded-full flex items-center justify-center shrink-0"
                style={{ backgroundColor: 'rgba(231, 76, 60, 0.12)' }}
              >
                <ShieldAlert className="size-7" style={{ color: 'var(--fate-danger)' }} />
              </div>
              <p className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>
                Массовый бросок доступен только мастеру
              </p>
              <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                Закройте окно или попросите мастера выполнить бросок.
              </p>
            </div>
          ) : (
            <>
          {/* Character Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                Персонажи ({selectedCharIds.size}/{sceneCharacters.length})
              </Label>
              <div className="flex gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[10px] h-6 px-2 rounded-md"
                  style={{ color: 'var(--fate-accent)' }}
                  onClick={selectAll}
                >
                  Выбрать все
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[10px] h-6 px-2 rounded-md"
                  style={{ color: 'var(--fate-text-muted)' }}
                  onClick={deselectAll}
                >
                  Снять все
                </Button>
              </div>
            </div>

            {sceneCharacters.length === 0 ? (
              <div
                className="rounded-lg p-4 text-center text-xs"
                style={{ color: 'var(--fate-text-muted)', backgroundColor: 'var(--fate-bg-warm)' }}
              >
                Нет персонажей на сцене
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-1.5 max-h-40 overflow-y-auto fate-scroll rounded-lg p-2" style={{ backgroundColor: 'var(--fate-bg-warm)' }}>
                {sceneCharacters.map((char) => (
                  <label
                    key={char.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-colors hover:bg-white/50 dark:hover:bg-white/5"
                  >
                    <Checkbox
                      checked={selectedCharIds.has(char.id)}
                      onCheckedChange={() => toggleCharacter(char.id)}
                      className="size-4"
                    />
                    <span className="text-xs font-medium truncate" style={{ color: 'var(--fate-text)' }}>
                      {char.name}
                    </span>
                    <span className="text-[10px] ml-auto" style={{ color: 'var(--fate-text-muted)' }}>
                      +{getSkillValue(char, skillName)}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <Separator />

          {/* Skill Selection */}
          <div className="space-y-2">
            <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
              Навык
            </Label>
            <Select value={skillName} onValueChange={setSkillName}>
              <SelectTrigger className="w-full rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {availableSkills.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Situational Bonus */}
          <div className="space-y-2">
            <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
              Ситуативный бонус
            </Label>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="size-9 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                onClick={() => setBonus((b) => b - 1)}
              >
                −
              </Button>
              <Input
                type="number"
                value={bonus}
                onChange={(e) => setBonus(parseInt(e.target.value) || 0)}
                className="text-center w-20 font-semibold text-lg rounded-lg"
              />
              <Button
                variant="outline"
                size="sm"
                className="size-9 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                onClick={() => setBonus((b) => b + 1)}
              >
                +
              </Button>
            </div>

            {/* Crowd team effort checkbox — applies to each selected crowd character */}
            {sceneCharacters.some((c) => c.isHorde && c.members && c.members.filter((m) => m.isActive).length >= 2) && (
              <div
                className="flex items-center gap-3 p-2.5 rounded-lg"
                style={{
                  backgroundColor: crowdTeamEffort ? 'rgba(192, 57, 43, 0.08)' : 'var(--fate-bg-card)',
                  border: `1px solid ${crowdTeamEffort ? 'rgba(192, 57, 43, 0.25)' : 'var(--fate-border)'}`,
                }}
              >
                <Checkbox
                  checked={crowdTeamEffort}
                  onCheckedChange={(checked) => setCrowdTeamEffort(!!checked)}
                  className="size-4 rounded"
                  style={{ borderColor: '#c0392b' }}
                />
                <div>
                  <Label className="text-xs font-medium cursor-pointer" style={{ color: 'var(--fate-text)' }}>
                    Совместные усилия толпы
                  </Label>
                  <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                    {crowdTeamEffort
                      ? `Применяется ко всем выбранным толпам (по правилу Fate Core: +1 за каждого участника с навыком ≥1)`
                      : `Добавляет бонус за совместные усилия к каждой выбранной толпе`
                    }
                  </p>
                </div>
              </div>
            )}
          </div>

          <Separator />

          {/* Roll Mode */}
          <div className="space-y-2">
            <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
              Тип броска
            </Label>
            <Select value={rollMode} onValueChange={(v) => setRollMode(v as RollMode)}>
              <SelectTrigger className="w-full rounded-lg">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="normal">Обычный бросок</SelectItem>
                <SelectItem value="difficulty">Против сложности</SelectItem>
                <SelectItem value="opposed">Против соперника</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Difficulty */}
          {rollMode === 'difficulty' && (
            <div className="space-y-2 animate-slide-down">
              <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                Сложность
              </Label>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="size-9 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                  onClick={() => setDifficulty((d) => Math.max(0, d - 1))}
                >
                  −
                </Button>
                <Input
                  type="number"
                  value={difficulty}
                  onChange={(e) => setDifficulty(parseInt(e.target.value) || 0)}
                  className="text-center w-20 font-semibold text-lg rounded-lg"
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="size-9 p-0 rounded-lg hover:scale-105 active:scale-95 transition-transform"
                  onClick={() => setDifficulty((d) => d + 1)}
                >
                  +
                </Button>
              </div>
            </div>
          )}

          {/* Opponent */}
          {rollMode === 'opposed' && (
            <div className="space-y-2 animate-slide-down">
              <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                Соперник
              </Label>
              <Select value={opponentId} onValueChange={(v) => { setOpponentId(v); setOpponentSkillName(''); }}>
                <SelectTrigger className="w-full rounded-lg">
                  <SelectValue placeholder="Выберите соперника" />
                </SelectTrigger>
                <SelectContent>
                  {sceneCharacters.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      Нет персонажей на сцене
                    </SelectItem>
                  ) : (
                    sceneCharacters
                      .filter((c) => !selectedCharIds.has(c.id))
                      .map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))
                  )}
                </SelectContent>
              </Select>

              {/* Opponent Skill Selection */}
              {opponentId && (() => {
                const oppChar = getCharacter(opponentId);
                if (!oppChar) return null;
                return (
                  <div className="space-y-1.5 pt-1">
                    <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                      Навык соперника
                    </Label>
                    <Select value={opponentSkillName} onValueChange={setOpponentSkillName}>
                      <SelectTrigger className="w-full rounded-lg">
                        <SelectValue placeholder="Выберите навык" />
                      </SelectTrigger>
                      <SelectContent>
                        {oppChar.skills
                          .filter((s) => s.value >= 0)
                          .sort((a, b) => b.value - a.value)
                          .map((s) => (
                            <SelectItem key={s.name} value={s.name}>
                              {s.name} (+{s.value})
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    {!opponentSkillName && (
                      <p className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                        Если не выбран, используется навык «{skillName}»
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          <Separator />

          {/* Rolling Animation */}
          {isRolling && (
            <div
              className="rounded-xl p-6 text-center space-y-3 animate-fade-in overflow-hidden"
              style={{ backgroundColor: 'var(--fate-bg-warm)' }}
            >
              <div className="flex items-center justify-center gap-2">
                <Dices className="size-5 animate-pulse" style={{ color: 'var(--fate-accent)' }} />
                <span className="text-sm font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Бросаю для {selectedCharIds.size} персонажей...
                </span>
              </div>
              <div
                className="inline-flex items-center justify-center"
                style={{
                  animation: 'fate-dice-roll 0.6s ease-out',
                }}
              >
                <DiceChips dice={rollingDice} size="lg" animate={false} />
              </div>
            </div>
          )}

          {/* Results Display — unified format matching player's RollInvitationPanel */}
          {showResults && results.length > 0 && !isRolling && (
            <div className="space-y-1.5 animate-fade-in">
              {/* Sorted results — best on top, matching player panel */}
              {[...results]
                .sort((a, b) => b.total - a.total)
                .map((r, idx) => {
                  const isBest = idx === 0 && results.length > 1;
                  return (
                    <div
                      key={`${r.characterId}-${r.total}-${idx}`}
                      className="rounded-lg p-2.5 flex items-center gap-2.5 transition-all"
                      style={{
                        backgroundColor: isBest ? 'rgba(243, 156, 18, 0.10)' : 'var(--fate-bg-warm)',
                        border: `1px solid ${isBest ? 'rgba(243, 156, 18, 0.35)' : 'transparent'}`,
                      }}
                    >
                      {/* Rank / icon */}
                      <div className="flex-shrink-0 w-6 flex items-center justify-center">
                        {isBest ? (
                          <Crown className="size-4" style={{ color: '#f39c12' }} />
                        ) : (
                          <span className="text-[10px] font-bold" style={{ color: 'var(--fate-text-muted)' }}>
                            {idx + 1}
                          </span>
                        )}
                      </div>

                      {/* Name + dice */}
                      <div className="flex-1 min-w-0">
                        <span className="text-xs font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                          {r.characterName}
                        </span>
                        <div className="mt-0.5">
                          <DiceChips dice={r.dice} size="sm" animate={false} />
                        </div>
                      </div>

                      {/* Total + result label badge */}
                      <div className="flex-shrink-0 text-right">
                        <div className="text-lg font-black leading-none" style={{ color: 'var(--fate-text)' }}>
                          {formatTotal(r.total)}
                        </div>
                        <Badge
                          className="text-[9px] mt-0.5 px-1.5 py-0"
                          style={resultBadgeStyle(r.result.type === 'great' ? 'Стиль' : r.result.type === 'success' ? 'Успех' : r.result.type === 'tie' ? 'Ничья' : 'Провал')}
                        >
                          {r.result.type === 'great' ? 'Стиль' : r.result.type === 'success' ? 'Успех' : r.result.type === 'tie' ? 'Ничья' : 'Провал'}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}

          {/* Empty state */}
          {!isRolling && !showResults && (
            <div
              className="rounded-xl p-6 text-center space-y-2"
              style={{ backgroundColor: 'var(--fate-bg-warm)' }}
            >
              <div className="text-2xl opacity-30">🎲</div>
              <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                Выберите персонажей и нажмите «Бросить для всех»
              </p>
            </div>
          )}
            </>
          )}
            </>
          )}
        </div>
    </FloatingPanel>
  );
}

// Error boundary wrapper
interface EBState { hasError: boolean; error: Error | null }
class MassRollErrorBoundary extends Component<{children: React.ReactNode}, EBState> {
  state: EBState = { hasError: false, error: null };
  static getDerivedStateFromError(error: Error) { return { hasError: true, error }; }
  render() {
    if (this.state.hasError) {
      return (
        <FloatingPanel
          open={true}
          onClose={() => {}}
          title="Ошибка"
          icon={<ShieldAlert className="size-4" />}
          width={420}
          contentClassName="p-4"
        >
          <p className="text-sm" style={{ color: 'var(--fate-text)' }}>
            Произошла ошибка в массовом броске:
          </p>
          <p className="text-xs mt-2 font-mono p-2 rounded" style={{ color: 'var(--fate-danger)', backgroundColor: 'rgba(231, 76, 60, 0.06)' }}>
            {this.state.error?.message}
          </p>
        </FloatingPanel>
      );
    }
    return this.props.children;
  }
}

export function MassRollDialogSafe(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <MassRollErrorBoundary>
      <MassRollDialog {...props} />
    </MassRollErrorBoundary>
  );
}
