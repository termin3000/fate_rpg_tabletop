'use client';

// ============================================================
// PhysicsQuickRoll — компактная кнопка для честного броска кубиков
// ============================================================
//
// Использует сервер-авторитативную физику (Rapier3D на physics-service,
// порт 3006). Кубики кувыркаются по-настоящему на столе, результат
// читается с верхней грани — НИКАКОЙ подмены текстур.
//
// Flow:
//   1. Клик → создаём event skeleton с pendingPhysics
//   2. runRollWithPhysics возвращает Promise
//   3. Overlay показывается, кубики кувыркаются (server transforms)
//   4. После settle (~1.5-2.5с) → Promise resolve'ится с реальным dice
//   5. Создаём log entry с реальным результатом
//
// Это альтернатива обычным диалогам бросков (quick-roll, skill-roll),
// которые используют локальную физику + relabel граней. Здесь —
// честная 3D-физика, никакой подмены.

import { useState, useCallback } from 'react';
import { Dices, Loader2, Zap } from 'lucide-react';
import { useFateStore } from '@/lib/store';
import { useDicePhysics } from '@/hooks/use-dice-physics';
import { genId } from '@/lib/fate-dice';
import type { LiveRollEvent, LiveRollParticipant } from '@/lib/types';

interface PhysicsQuickRollProps {
  /** Стиль кнопки: 'header' — компактная для header'а; 'panel' — полноразмерная */
  variant?: 'header' | 'panel';
  /** Опциональный модификатор бонуса (отображается в overlay) */
  bonus?: number;
}

export function PhysicsQuickRoll({ variant = 'panel', bonus = 0 }: PhysicsQuickRollProps) {
  const [rolling, setRolling] = useState(false);
  const physics = useDicePhysics();
  const runRollWithPhysics = useFateStore((s) => s.runRollWithPhysics);
  const addLogEntry = useFateStore((s) => s.addLogEntry);
  const currentAdventureId = useFateStore((s) => s.currentAdventureId);
  const networkMyDisplayName = useFateStore((s) => s.networkMyDisplayName);

  const handleRoll = useCallback(async () => {
    if (rolling) return;
    setRolling(true);

    try {
      // Создаём participant skeleton — dice placeholder, реальный
      // результат придёт от физики и применится через applyPhysicsResult.
      const participantId = `phys-roller-${Date.now()}`;
      const eventId = `roll-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      const modifiers: { label: string; value: number }[] = [];
      if (bonus !== 0) {
        modifiers.push({ label: bonus > 0 ? 'ситуативный' : 'штраф', value: bonus });
      }

      const participant: LiveRollParticipant = {
        id: participantId,
        characterName: networkMyDisplayName || 'Быстрый бросок',
        skillName: 'Физический бросок',
        skillValue: 0,
        manualBonus: bonus,
        dice: [0, 0, 0, 0],  // placeholder — будет заменён физикой
        diceSum: 0,
        total: bonus,         // placeholder
        resultLabel: '...',   // placeholder — будет пересчитан в applyPhysicsResult
        resultType: 'tie',
        role: 'roller',
        modifiers: modifiers.length > 0 ? modifiers : undefined,
      };

      const eventSkeleton: Omit<LiveRollEvent, 'pendingPhysics'> = {
        id: eventId,
        type: 'simple',
        rolledBy: networkMyDisplayName || 'Игрок',
        rolledAt: Date.now(),
        title: 'Честный бросок кубиков',
        actionContext: 'check',
        difficulty: null,
        verdict: undefined,    // будет вычислен в applyPhysicsResult
        verdictType: undefined,
        participants: [participant],
        adventureId: currentAdventureId ?? undefined,
      };

      // Запускаем бросок — overlay покажется сразу, кубики
      // кувыркаются через серверные трансформы.
      const result = await runRollWithPhysics(eventSkeleton);

      // Физика финализирована — создаём лог с реальным результатом.
      const diceStr = result.dice.map((d) => (d > 0 ? '+' : d < 0 ? '−' : '○')).join(' ');
      const label =
        result.total >= 4 ? `Стиль!! (+${result.total})` :
        result.total >= 1 ? `Успех (+${result.total})` :
        result.total === 0 ? 'Ничья (0)' :
        `Провал (${result.total})`;

      await addLogEntry({
        adventureId: currentAdventureId ?? undefined,
        characterId: null,
        characterName: networkMyDisplayName || 'Быстрый бросок',
        skillName: `Физика: ${diceStr}`,
        diceResults: result.dice,
        bonus,
        total: result.total,
        difficulty: null,
        opponentTotal: null,
        result: label,
        opponentType: null,
        opponentCharacterId: null,
        opponentName: null,
        opponentSkillName: null,
        opponentDiceResults: [],
        opponentBonus: 0,
        opponentSkillValue: null,
        opponentManualBonus: 0,
        extraBonus: 0,
        extraBonusReason: '',
        rerolled: false,
        customText: '🎲 Честная 3D-физика (Rapier3D)',
        isRiftEvent: false,
        skillValue: null,
        manualBonus: bonus,
        helpers: [],
        aspectInvokeBonus: 0,
        aspectInvokeReason: '',
        aspectRerolled: false,
      });
    } catch (err) {
      console.error('[PhysicsQuickRoll] failed:', err);
    } finally {
      setRolling(false);
    }
  }, [rolling, bonus, runRollWithPhysics, addLogEntry, currentAdventureId, networkMyDisplayName]);

  const connected = physics.connected;

  if (variant === 'header') {
    return (
      <button
        onClick={handleRoll}
        disabled={rolling || !connected}
        className="fate-physics-roll-btn fate-physics-roll-btn--header"
        title={connected ? 'Бросить кубики с честной 3D-физикой' : 'Physics service недоступен'}
        aria-label="Бросить кубики с честной физикой"
      >
        {rolling ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
        <span className="hidden sm:inline">Физика</span>
      </button>
    );
  }

  return (
    <button
      onClick={handleRoll}
      disabled={rolling || !connected}
      className="fate-physics-roll-btn fate-physics-roll-btn--panel"
      title={connected ? 'Бросить кубики с честной 3D-физикой' : 'Physics service недоступен'}
    >
      {rolling ? (
        <Loader2 size={16} className="animate-spin" />
      ) : (
        <Dices size={16} />
      )}
      <span>Бросить кубики</span>
      <span className="fate-physics-roll-btn__badge">3D</span>
    </button>
  );
}
