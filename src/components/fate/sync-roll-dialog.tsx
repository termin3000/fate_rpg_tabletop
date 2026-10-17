'use client';

/**
 * SyncRollDialog — synchronous dice-roll session UI for P2P multiplayer.
 *
 * Two perspectives:
 *  - GM (host): picks skill + participants (assigned players), starts the
 *    session, watches live results stream in, then finalizes (logs a summary).
 *  - Player: receives the request, sees a 3-2-1 countdown, then auto-rolls
 *    with their assigned character + skill value. Result is sent back to host.
 *
 * State lives in `syncRollState` (store.ts). Networking is handled by
 * use-network.ts (broadcastSyncRoll on host side, sendSyncRollResult on
 * player side). This component just renders the store state and triggers
 * the right actions at the right moments.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Dices, Users, Zap, Trophy, X, Clock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { Separator } from '@/components/ui/separator';
import { useFateStore, type SyncRollResult } from '@/lib/store';
import { useNetwork } from '@/hooks/use-network';
import { rollFateDice, sumFateDice, getRollResult, formatDiceSymbol } from '@/lib/fate-dice';
import { toast } from 'sonner';

interface SyncRollDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Player color palette — used for participant dots and result rows. */
const PLAYER_COLORS = ['#e67e22', '#3498db', '#9b59b6', '#1abc9c', '#f39c12', '#e74c3c', '#2ecc71', '#34495e'];

export function SyncRollDialog({ open, onOpenChange }: SyncRollDialogProps) {
  const store = useFateStore();
  const {
    syncRollState,
    isNetworkActive,
    networkRole,
    networkMyPeerId,
    networkMyDisplayName,
    networkPeers,
    playerAssignments,
    characters,
    settings,
    startSyncRoll,
    cancelSyncRoll,
    submitSyncRollResult,
    finalizeSyncRoll,
  } = store;
  const { broadcastSyncRoll, sendSyncRollResult } = useNetwork();

  // ── GM setup form state ──────────────────────────────────────
  const [skillName, setSkillName] = useState('Бой');
  const [skillValue, setSkillValue] = useState(2);
  const [bonus, setBonus] = useState(0);
  const [difficulty, setDifficulty] = useState<number | ''>('');
  const [countdownSec, setCountdownSec] = useState(3);
  const [selectedPeerIds, setSelectedPeerIds] = useState<Set<string>>(new Set());

  // ── Available skills from adventure settings ────────────────
  const availableSkills = useMemo(() => {
    return settings.baseSkills?.length
      ? [...settings.baseSkills].sort((a, b) => a.localeCompare(b, 'ru'))
      : [];
  }, [settings.baseSkills]);

  // ── Auto-suggest skill value from the first selected participant ──
  // When the GM picks a skill, try to read its value from the first
  // selected player's assigned character. This is just a convenience —
  // the actual roll uses each player's own character skill value.
  useEffect(() => {
    if (!selectedPeerIds.size) return;
    const firstPeerId = Array.from(selectedPeerIds)[0];
    const charIds = playerAssignments[firstPeerId] ?? [];
    const char = characters.find((c) => c.id === charIds[0]);
    if (char) {
      const found = char.skills?.find((s) => s.name === skillName);
      if (found) setSkillValue(found.value);
    }
  }, [skillName, selectedPeerIds, playerAssignments, characters]);

  // ── Live countdown tick (re-render every 250ms while countdown active) ──
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!syncRollState || syncRollState.status !== 'countdown') return;
    const id = window.setInterval(() => setTick((t) => t + 1), 250);
    return () => window.clearInterval(id);
  }, [syncRollState?.status, syncRollState?.id]);

  // ── Auto-roll trigger for players ────────────────────────────
  // When the countdown reaches zero, the player auto-rolls once and sends
  // the result back to the host. We use a ref to ensure it only fires once
  // per session (React StrictMode double-mount protection).
  const rolledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!syncRollState) return;
    if (networkRole !== 'player') return;
    if (syncRollState.status !== 'countdown') return;
    if (rolledRef.current === syncRollState.id) return;

    const remaining = syncRollState.deadlineTs - Date.now() - 5000; // countdown portion
    if (remaining > 0) return; // not yet

    // Time to roll!
    rolledRef.current = syncRollState.id;
    const myCharId = store.myAssignedCharacterId();
    const myChar = myCharId ? characters.find((c) => c.id === myCharId) : null;
    const charName = myChar?.name ?? networkMyDisplayName;
    // Use the skillValue from the session, but if the player's character has
    // a different rating for this skill, prefer theirs.
    let usedSkillValue = syncRollState.skillValue;
    if (myChar) {
      const found = myChar.skills?.find((s) => s.name === syncRollState.skillName);
      if (found) usedSkillValue = found.value;
    }
    const dice = rollFateDice();
    const diceSum = sumFateDice(dice);
    const total = diceSum + usedSkillValue + syncRollState.bonus;
    const { label } = getRollResult(total, syncRollState.difficulty);
    const result: SyncRollResult = {
      peerId: networkMyPeerId!,
      peerName: networkMyDisplayName,
      characterId: myCharId,
      characterName: charName,
      skillName: syncRollState.skillName,
      skillValue: usedSkillValue,
      dice,
      bonus: usedSkillValue + syncRollState.bonus,
      total,
      resultLabel: label,
      ts: Date.now(),
    };
    submitSyncRollResult(result);
    sendSyncRollResult({
      id: syncRollState.id,
      peerId: result.peerId,
      peerName: result.peerName,
      characterId: result.characterId,
      characterName: result.characterName,
      skillName: result.skillName,
      skillValue: result.skillValue,
      dice: result.dice,
      bonus: result.bonus,
      total: result.total,
      resultLabel: result.resultLabel,
      ts: result.ts,
    });
    toast.success(`Бросок выполнен: +${total} (${label})`);
  }, [syncRollState, networkRole, characters, networkMyPeerId, networkMyDisplayName, submitSyncRollResult, sendSyncRollResult, store]);

  // ── Host: auto-finalize when all results are in OR deadline expires ──
  const finalizedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!syncRollState) return;
    if (networkRole !== 'host') return;
    if (finalizedRef.current === syncRollState.id) return;

    // Auto-expire: if deadline passed and not all submitted, mark expired
    if (syncRollState.status === 'complete') {
      // Wait 1.5s so the user sees the final results, then they can manually finalize
      return;
    }
    if (Date.now() > syncRollState.deadlineTs && syncRollState.status !== 'expired') {
      // Mark as expired but don't auto-finalize — let GM decide
      useFateStore.setState((s) => ({
        syncRollState: s.syncRollState ? { ...s.syncRollState, status: 'expired' as const } : null,
      }));
      toast.warning('Время ожидания истекло. Можно завершить с неполными результатами.');
    }
  }, [syncRollState, networkRole]);

  // Reset rolled/finalized refs when session is null
  useEffect(() => {
    if (!syncRollState) {
      rolledRef.current = null;
      finalizedRef.current = null;
    }
  }, [syncRollState?.id]);

  // ── Cleanup on dialog close ─────────────────────────────────
  const handleClose = () => {
    if (syncRollState && networkRole === 'host') {
      // GM closing mid-session = cancel
      cancelSyncRoll();
    }
    onOpenChange(false);
  };

  // ── GM: start a new session ─────────────────────────────────
  const handleStart = () => {
    if (selectedPeerIds.size === 0) {
      toast.error('Выберите хотя бы одного игрока');
      return;
    }
    const participantPeerIds = Array.from(selectedPeerIds);
    startSyncRoll({
      skillName,
      skillValue,
      bonus,
      difficulty: difficulty === '' ? null : difficulty,
      participantPeerIds,
      countdownSec,
    });
    // Broadcast immediately after store update
    const session = useFateStore.getState().syncRollState;
    if (session) {
      broadcastSyncRoll({
        id: session.id,
        skillName: session.skillName,
        skillValue: session.skillValue,
        bonus: session.bonus,
        difficulty: session.difficulty,
        countdownSec: session.countdownSec,
        deadlineTs: session.deadlineTs,
        targetPeerIds: participantPeerIds,
      });
      toast.success(`Групповой бросок запущен для ${participantPeerIds.length} игрок(ов)`);
    }
  };

  const handleFinalize = async () => {
    await finalizeSyncRoll();
    toast.success('Результаты записаны в лог');
    onOpenChange(false);
  };

  const handleCancel = () => {
    cancelSyncRoll();
    onOpenChange(false);
  };

  // ── Build list of peers that have at least one assigned PC ──
  const assignablePeers = useMemo(() => {
    return Object.values(networkPeers)
      .filter((p) => p.role === 'player')
      .map((p, idx) => ({
        peerId: p.peerId,
        displayName: p.displayName,
        color: PLAYER_COLORS[idx % PLAYER_COLORS.length],
        assignedCharacterIds: playerAssignments[p.peerId] ?? [],
        assignedCharacterNames: (playerAssignments[p.peerId] ?? [])
          .map((cid) => characters.find((c) => c.id === cid)?.name)
          .filter(Boolean) as string[],
      }))
      .filter((p) => p.assignedCharacterIds.length > 0);
  }, [networkPeers, playerAssignments, characters]);

  // ── Render: nothing to show if dialog is closed ──
  if (!open) return null;

  // ── Render: active session (countdown / rolling / complete / expired) ──
  if (syncRollState) {
    const remainingMs = Math.max(0, syncRollState.deadlineTs - 5000 - Date.now());
    const countdownNum = Math.ceil(remainingMs / 1000);
    const isCountdown = syncRollState.status === 'countdown' && countdownNum > 0;
    const results = Object.values(syncRollState.results).sort((a, b) => b.total - a.total);
    const expectedCount = networkRole === 'host' ? syncRollState.participantPeerIds.length : 1;

    return (
      <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
        <DialogContent className="sm:max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
              <div
                className="fate-icon-circle"
                style={{ backgroundColor: 'rgba(155, 89, 182, 0.12)' }}
              >
                <Zap className="size-4" style={{ color: '#9b59b6' }} />
              </div>
              ⚡ Групповой бросок
              {networkRole === 'host' && (
                <Badge variant="outline" className="ml-1 text-[10px]">GM</Badge>
              )}
            </DialogTitle>
            <DialogDescription>
              Навык: <span className="font-semibold">{syncRollState.skillName}</span>
              {syncRollState.difficulty !== null && (
                <> · Сложность: <span className="font-semibold">{syncRollState.difficulty}</span></>
              )}
              {syncRollState.bonus !== 0 && (
                <> · Бонус: <span className="font-semibold">+{syncRollState.bonus}</span></>
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 overflow-y-auto fate-scroll flex-1 pr-1">
            {/* Countdown overlay */}
            {isCountdown && (
              <div
                className="rounded-2xl p-8 flex flex-col items-center justify-center gap-3 animate-fade-in"
                style={{
                  background: 'linear-gradient(135deg, rgba(155, 89, 182, 0.08), rgba(230, 126, 34, 0.08))',
                  border: '1px solid rgba(155, 89, 182, 0.2)',
                  minHeight: 200,
                }}
              >
                <div className="flex items-center gap-2 text-xs uppercase tracking-wider" style={{ color: 'var(--fate-text-muted)' }}>
                  <Clock className="size-3.5" />
                  Приготовьтесь бросать!
                </div>
                <div
                  className="text-7xl font-bold tabular-nums"
                  style={{ color: '#9b59b6', textShadow: '0 2px 12px rgba(155, 89, 182, 0.3)' }}
                >
                  {countdownNum}
                </div>
                <p className="text-xs text-center max-w-xs" style={{ color: 'var(--fate-text-muted)' }}>
                  {networkRole === 'player'
                    ? 'Кубики бросятся автоматически для вашего персонажа'
                    : 'Игроки бросят автоматически по истечении отсчёта'}
                </p>
              </div>
            )}

            {/* Rolling / complete state */}
            {!isCountdown && (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--fate-text)' }}>
                    <Users className="size-4" />
                    <span className="font-medium">Результаты</span>
                    <Badge variant="secondary" className="text-[10px]">
                      {results.length} / {expectedCount}
                    </Badge>
                  </div>
                  {syncRollState.status === 'expired' && (
                    <Badge variant="destructive" className="text-[10px]">Время истекло</Badge>
                  )}
                  {syncRollState.status === 'complete' && (
                    <Badge className="text-[10px]" style={{ backgroundColor: '#27ae60' }}>Готово</Badge>
                  )}
                  {syncRollState.status === 'rolling' && (
                    <Badge variant="outline" className="text-[10px] animate-pulse">Ожидаем...</Badge>
                  )}
                </div>

                {results.length === 0 ? (
                  <div
                    className="rounded-xl p-8 flex flex-col items-center justify-center text-center gap-2"
                    style={{ backgroundColor: 'var(--fate-bg-warm)' }}
                  >
                    <Dices className="size-8 animate-pulse" style={{ color: 'var(--fate-text-muted)' }} />
                    <p className="text-sm" style={{ color: 'var(--fate-text-muted)' }}>
                      Ожидаем результатов от игроков...
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {results.map((r, idx) => {
                      const isBest = idx === 0 && results.length > 1;
                      const isWorst = idx === results.length - 1 && results.length > 1;
                      const peerEntry = assignablePeers.find((p) => p.peerId === r.peerId);
                      const color = peerEntry?.color ?? '#95a5a6';
                      return (
                        <div
                          key={r.peerId}
                          className="rounded-xl p-3 flex items-center gap-3"
                          style={{
                            backgroundColor: isBest ? 'rgba(39, 174, 96, 0.06)' : isWorst ? 'rgba(231, 76, 60, 0.05)' : 'var(--fate-bg-warm)',
                            border: `1px solid ${isBest ? 'rgba(39, 174, 96, 0.25)' : isWorst ? 'rgba(231, 76, 60, 0.2)' : 'transparent'}`,
                          }}
                        >
                          <div
                            className="size-9 rounded-full flex items-center justify-center shrink-0 text-xs font-bold text-white"
                            style={{ backgroundColor: color }}
                            title={r.peerName}
                          >
                            {r.characterName.charAt(0).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="text-sm font-semibold truncate" style={{ color: 'var(--fate-text)' }}>
                                {r.characterName}
                              </span>
                              {isBest && <Trophy className="size-3.5" style={{ color: '#f39c12' }} />}
                            </div>
                            <div className="flex items-center gap-1 text-[11px] mt-0.5" style={{ color: 'var(--fate-text-muted)' }}>
                              {r.dice.map((d, i) => (
                                <span
                                  key={i}
                                  className="inline-flex items-center justify-center w-4 h-4 rounded text-[9px] font-bold"
                                  style={{
                                    backgroundColor: d === 1 ? 'rgba(39, 174, 96, 0.15)' : d === -1 ? 'rgba(231, 76, 60, 0.15)' : 'rgba(149, 165, 166, 0.15)',
                                    color: d === 1 ? '#27ae60' : d === -1 ? '#e74c3c' : '#7f8c8d',
                                  }}
                                >
                                  {formatDiceSymbol(d)}
                                </span>
                              ))}
                              <span className="ml-1">
                                ({r.dice.length > 0 ? (r.dice.reduce((s, x) => s + x, 0) >= 0 ? '+' : '') : ''}{r.dice.reduce((s, x) => s + x, 0)})
                                {r.bonus > 0 && ` +${r.bonus}`}
                              </span>
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <div className="text-xl font-bold tabular-nums" style={{ color: 'var(--fate-text)' }}>
                              {r.total >= 0 ? '+' : ''}{r.total}
                            </div>
                            <div className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                              {r.resultLabel}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>

          <DialogFooter className="gap-2">
            {networkRole === 'host' ? (
              <>
                <Button variant="ghost" onClick={handleCancel} className="text-xs">
                  <X className="size-3.5 mr-1" /> Отмена
                </Button>
                <Button
                  onClick={handleFinalize}
                  disabled={results.length === 0}
                  className="text-xs"
                  style={{ backgroundColor: '#9b59b6' }}
                >
                  <Trophy className="size-3.5 mr-1" /> Записать в лог
                </Button>
              </>
            ) : (
              <Button variant="ghost" onClick={handleClose} className="text-xs">
                Закрыть
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Render: GM setup mode (no active session) ───────────────
  // Only host sees this. Players never open the dialog without an active
  // session (the dialog auto-opens via page.tsx effect when syncRollState appears).
  if (networkRole !== 'host') {
    return (
      <Dialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2.5">
              <Zap className="size-4" style={{ color: '#9b59b6' }} />
              Групповой бросок
            </DialogTitle>
            <DialogDescription>
              Только мастер может инициировать групповой бросок.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(155, 89, 182, 0.12)' }}
            >
              <Zap className="size-4" style={{ color: '#9b59b6' }} />
            </div>
            ⚡ Групповой бросок
            <Badge variant="outline" className="ml-1 text-[10px]">GM</Badge>
          </DialogTitle>
          <DialogDescription>
            Запустите одновременный бросок для выбранных игроков. Все увидят обратный отсчёт 3-2-1 и бросят одновременно.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto fate-scroll flex-1 pr-1">
          {/* Network inactive warning */}
          {!isNetworkActive && (
            <div
              className="rounded-xl p-4 flex items-center gap-3"
              style={{ backgroundColor: 'rgba(231, 76, 60, 0.06)', border: '1px solid rgba(231, 76, 60, 0.2)' }}
            >
              <X className="size-5" style={{ color: 'var(--fate-danger)' }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>Сеть не активна</p>
                <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                  Откройте диалог «Сеть» и создайте комнату, чтобы игроки могли подключиться.
                </p>
              </div>
            </div>
          )}

          {/* No assigned peers warning */}
          {isNetworkActive && assignablePeers.length === 0 && (
            <div
              className="rounded-xl p-4 flex items-center gap-3"
              style={{ backgroundColor: 'rgba(243, 156, 18, 0.06)', border: '1px solid rgba(243, 156, 18, 0.2)' }}
            >
              <Users className="size-5" style={{ color: '#f39c12' }} />
              <div>
                <p className="text-sm font-semibold" style={{ color: 'var(--fate-text)' }}>Нет игроков с назначенными персонажами</p>
                <p className="text-xs" style={{ color: 'var(--fate-text-muted)' }}>
                  Назначьте PC игрокам в диалоге «Сеть», затем вернитесь сюда.
                </p>
              </div>
            </div>
          )}

          {/* Skill + params form */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Навык</Label>
              {availableSkills.length > 0 ? (
                <Select value={skillName} onValueChange={setSkillName}>
                  <SelectTrigger className="text-sm h-9 w-full rounded-lg">
                    <SelectValue placeholder="Выберите навык" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableSkills.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={skillName}
                  onChange={(e) => setSkillName(e.target.value)}
                  placeholder="Бой, Атлетика, Знание..."
                  className="text-sm h-9"
                />
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">
                Значение навыка {selectedPeerIds.size > 0 && <span className="text-[10px] opacity-60">(по умолч.)</span>}
              </Label>
              <Input
                type="number"
                value={skillValue}
                onChange={(e) => setSkillValue(Number(e.target.value) || 0)}
                className="text-sm h-9"
                min={-1}
                max={10}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Бонус</Label>
              <Input
                type="number"
                value={bonus}
                onChange={(e) => setBonus(Number(e.target.value) || 0)}
                className="text-sm h-9"
                min={-10}
                max={20}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Сложность (опц.)</Label>
              <Input
                type="number"
                value={difficulty}
                onChange={(e) => setDifficulty(e.target.value === '' ? '' : Number(e.target.value))}
                placeholder="—"
                className="text-sm h-9"
                min={0}
                max={10}
              />
            </div>
          </div>

          {/* Countdown selector */}
          <div className="space-y-1.5">
            <Label className="text-xs">Обратный отсчёт: {countdownSec} сек</Label>
            <div className="flex gap-1.5">
              {[3, 5, 10].map((n) => (
                <Button
                  key={n}
                  variant={countdownSec === n ? 'default' : 'outline'}
                  size="sm"
                  className="text-xs h-7 flex-1"
                  onClick={() => setCountdownSec(n)}
                  style={countdownSec === n ? { backgroundColor: '#9b59b6' } : {}}
                >
                  {n} сек
                </Button>
              ))}
            </div>
          </div>

          <Separator />

          {/* Participant selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium flex items-center gap-1.5">
                <Users className="size-3.5" />
                Игроки ({selectedPeerIds.size}/{assignablePeers.length})
              </Label>
              {assignablePeers.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[10px] h-6 px-2"
                  style={{ color: '#9b59b6' }}
                  onClick={() => {
                    if (selectedPeerIds.size === assignablePeers.length) {
                      setSelectedPeerIds(new Set());
                    } else {
                      setSelectedPeerIds(new Set(assignablePeers.map((p) => p.peerId)));
                    }
                  }}
                >
                  {selectedPeerIds.size === assignablePeers.length ? 'Снять все' : 'Выбрать все'}
                </Button>
              )}
            </div>

            {assignablePeers.length === 0 ? (
              <p className="text-xs italic py-4 text-center" style={{ color: 'var(--fate-text-muted)' }}>
                Нет подключённых игроков с назначенными персонажами
              </p>
            ) : (
              <div className="space-y-1.5 max-h-64 overflow-y-auto fate-scroll pr-1">
                {assignablePeers.map((p) => {
                  const selected = selectedPeerIds.has(p.peerId);
                  return (
                    <button
                      key={p.peerId}
                      type="button"
                      onClick={() => {
                        setSelectedPeerIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.peerId)) next.delete(p.peerId);
                          else next.add(p.peerId);
                          return next;
                        });
                      }}
                      className="w-full rounded-xl p-2.5 flex items-center gap-3 text-left transition-colors"
                      style={{
                        backgroundColor: selected ? 'rgba(155, 89, 182, 0.08)' : 'var(--fate-bg-warm)',
                        border: `1px solid ${selected ? 'rgba(155, 89, 182, 0.3)' : 'transparent'}`,
                      }}
                    >
                      <div
                        className="size-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold text-white"
                        style={{ backgroundColor: p.color }}
                      >
                        {p.displayName.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: 'var(--fate-text)' }}>
                          {p.displayName}
                        </div>
                        <div className="text-[11px] truncate" style={{ color: 'var(--fate-text-muted)' }}>
                          {p.assignedCharacterNames.join(', ') || '—'}
                        </div>
                      </div>
                      <div
                        className="size-5 rounded-md border-2 flex items-center justify-center shrink-0"
                        style={{
                          borderColor: selected ? '#9b59b6' : 'var(--fate-border)',
                          backgroundColor: selected ? '#9b59b6' : 'transparent',
                        }}
                      >
                        {selected && (
                          <svg viewBox="0 0 24 24" className="size-3 text-white" fill="none" stroke="currentColor" strokeWidth="3">
                            <path d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)} className="text-xs">
            Отмена
          </Button>
          <Button
            onClick={handleStart}
            disabled={!isNetworkActive || selectedPeerIds.size === 0}
            className="text-xs"
            style={{ backgroundColor: '#9b59b6' }}
          >
            <Zap className="size-3.5 mr-1" />
            Запустить ({selectedPeerIds.size})
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
