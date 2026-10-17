'use client';

// ============================================================
// DiceCase — 3D «кейс с кубиками» внизу блока со сценой
// ============================================================
// Постоянный UI-элемент: визуальный «стол» с кубиками игрока.
// Внутри кейса — 4 НАСТОЯЩИХ 3D кубика (Three.js / R3F), которые
// «лежат» в кейсе между бросками как физические объекты.
//
// Кубы лежат с ПОСЛЕДНИМ РЕЗУЛЬТАТОМ: выбросил игрок +++− — кубы
// в кейсе так и будут лежать (на верхней грани видны те символы).
// Результат сохраняется в store.lastDiceResult и переживает закрытие
// оверлея.
//
// Когда происходит бросок:
//   • кубы в кейсе анимированно исчезают (scale → 0, opacity → 0)
//     — они «вылетают» на карту (физика в Dice3DCanvas)
//   • после броска кейс пульсирует — клик возвращает кубы обратно
//     (return-анимация в Dice3DCanvas), кубы в кейсе снова появляются
//     с новым результатом через DiceCase3D returning-анимацию
//
// Состояния:
//   • idle (нет броска) — кейс с 4 3D кубиками последнего результата
//   • rolling (бросок идёт) — кейс пустой (кубы на карте)
//   • landed (результат показан) — кейс пульсирует, «↩ Вернуть кубы»
//   • exiting (возврат) — кейс тусклый, кубы ещё не вернулись

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft } from 'lucide-react';
import { useFateStore } from '@/lib/store';

// Динамический импорт Three.js-канваса — ssr:false, отдельный chunk.
const DiceCase3D = dynamic(
  () => import('./dice-case-3d').then((m) => m.DiceCase3D),
  { ssr: false, loading: () => null }
);

export function DiceCase() {
  const liveRollStage = useFateStore((s) => s.liveRollStage);
  const liveRollExiting = useFateStore((s) => s.liveRollExiting);
  const requestLiveRollExit = useFateStore((s) => s.requestLiveRollExit);
  const lastDiceResult = useFateStore((s) => s.lastDiceResult);

  // ── Network context: decide whether the CURRENT liveRollStage was
  //    initiated by THIS client. The dice case should only empty out
  //    (rolling animation) for the player who actually threw the dice.
  //    Remote viewers (GM watching a player's roll, or another player)
  //    must keep their own dice sitting in the case — otherwise every
  //    roll on the network blanks everyone's case, which defeats the
  //    "physical dice on your desk" metaphor.
  //    • Offline (no network): every roll is local → case empties.
  //    • Online + roller's peerId === my peerId: local → empties.
  //    • Online + participant.peerId == null AND I'm the host (GM
  //      rolling an NPC/legacy): local → empties.
  //    • Otherwise (someone else's PC roll, received via broadcast):
  //      NOT local → dice stay in the case.
  const isNetworkActive = useFateStore((s) => s.isNetworkActive);
  const networkRole = useFateStore((s) => s.networkRole);
  const networkMyPeerId = useFateStore((s) => s.networkMyPeerId);

  const hasRoll = !!liveRollStage;

  // Was the current stage event initiated locally (by this viewer)?
  const isLocalRoll = (() => {
    if (!hasRoll) return false;
    // Offline / single-player → every roll is local.
    if (!isNetworkActive) return true;
    const rollerPeerId = liveRollStage?.participants?.[0]?.peerId;
    // Roller is me (my PC).
    if (rollerPeerId != null && networkMyPeerId != null && rollerPeerId === networkMyPeerId) {
      return true;
    }
    // GM rolling an NPC / legacy null-peerId roll, and I'm the host.
    if (rollerPeerId == null && networkRole === 'host') {
      return true;
    }
    return false;
  })();

  // canReturn: only the local roller can dismiss the overlay (click the
  // case to "return" dice). Remote viewers see the event but shouldn't
  // control it — they can dismiss via the overlay's own close button.
  const canReturn = hasRoll && !liveRollExiting && isLocalRoll;

  // Локальное состояние: показывает returning-анимацию в кейсе.
  // Включается на 700мс после того, как exiting завершится (кубы
  // «приземляются» обратно в кейс).
  //
  // Паттерн «detect change during render» (как в combat-timer.tsx):
  // сравниваем предыдущее значение liveRollExiting с текущим, и если
  // был переход true → false, ставим returning=true. Это безопасно —
  // setState условный и идемпотентный. Сам timeout срабатывает в useEffect.
  //
  // IMPORTANT: returning should only fire for the LOCAL roller's case.
  // Remote viewers (GM / other players watching a broadcast roll) never
  // had their dice leave the case, so a "landing" animation would be
  // wrong for them. We capture isLocalRoll in a ref while the stage event
  // is active, because by the time exiting completes (liveRollExiting
  // true→false), dismissLiveRoll has already cleared liveRollStage →
  // isLocalRoll would read false at that exact moment.
  const prevExitingRef = useRef(false);
  const wasLocalRollRef = useRef(false);
  const [returning, setReturning] = useState(false);

  // Capture local-roll status while the event is still on stage.
  if (hasRoll) {
    // eslint-disable-next-line react-hooks/refs -- capture for post-dismiss animation
    wasLocalRollRef.current = isLocalRoll;
  }

  // eslint-disable-next-line react-hooks/refs -- previous-value tracking, allowed by React docs
  if (prevExitingRef.current !== liveRollExiting) {
    // eslint-disable-next-line react-hooks/refs -- read previous value
    const wasExiting = prevExitingRef.current;
    // eslint-disable-next-line react-hooks/refs -- update tracked previous value
    prevExitingRef.current = liveRollExiting;
    // Переход true → false: exiting завершился → кубы вернулись в кейс.
    // Only trigger the landing animation if the just-ended roll was local.
    // eslint-disable-next-line react-hooks/refs -- read captured local-roll flag
    if (wasExiting && !liveRollExiting && wasLocalRollRef.current) {
      setReturning(true);
    }
  }

  // Сброс returning через 700мс (async внутри setTimeout — ОК для lint)
  useEffect(() => {
    if (!returning) return;
    const t = setTimeout(() => setReturning(false), 700);
    return () => clearTimeout(t);
  }, [returning]);

  // Кубы в кейсе: показываем последний результат. По умолчанию 4 куба.
  const dice = lastDiceResult.length === 4
    ? lastDiceResult
    : [0, 0, 0, 0];

  // Сумма для подписи (мелкая деталь)
  const diceSum = dice.reduce((a, b) => a + b, 0);
  const sumStr = diceSum > 0 ? `+${diceSum}` : `${diceSum}`;

  // rolling = a LOCAL throw is in progress AND the dice have already left
  // the case (not in returning phase). For remote rolls (someone else's
  // throw received via broadcast), isLocalRoll is false → dice stay put.
  const rolling = hasRoll && isLocalRoll && !liveRollExiting && !returning;

  return (
    <button
      type="button"
      className={`fate-dice-case${canReturn ? ' fate-dice-case--active' : ''}${liveRollExiting && isLocalRoll ? ' fate-dice-case--exiting' : ''}${rolling ? ' fate-dice-case--empty' : ''}`}
      onClick={() => {
        if (canReturn) requestLiveRollExit();
      }}
      disabled={!canReturn}
      aria-label={canReturn ? 'Вернуть кубики в кейс' : 'Кейс с кубиками'}
      title={canReturn ? 'Вернуть кубы (результат в логе)' : `Кейс с кубиками — последний результат: ${sumStr}`}
    >
      {/* 3D кейс с кубиками внутри — НАСТОЯЩИЙ Three.js Canvas */}
      <div className="fate-dice-case__tray">
        <div className="fate-dice-case__tray-inner">
          <DiceCase3D
            dice={dice}
            rolling={rolling}
            returning={returning}
          />
        </div>
        {/* Блик на стекле кейса */}
        <div className="fate-dice-case__glass" />
      </div>

      {/* Подпись */}
      <div className="fate-dice-case__label">
        {liveRollExiting && isLocalRoll ? (
          <span className="fate-dice-case__label-text">Возврат…</span>
        ) : canReturn ? (
          <span className="fate-dice-case__label-text fate-dice-case__label-text--accent">
            <CornerDownLeft size={11} />
            Вернуть кубы
          </span>
        ) : (
          <span className="fate-dice-case__label-text">
            Кубы · {sumStr}
          </span>
        )}
      </div>
    </button>
  );
}
