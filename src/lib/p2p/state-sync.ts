// ============================================================
// Fate RPG — State Sync & Visibility Filtering
// ============================================================
// Helpers to:
//  - build a PlayerVisibleState from the host's full state
//  - filter out hidden data (hiddenFromPlayers, fog-of-war, GM-only)
//  - convert LogEntry → SerializableLogEntry
// ============================================================

import type {
  Adventure,
  Character,
  LogEntry,
  Scene,
} from '@/lib/types';
import type {
  PlayerVisibleState,
  SerializableLogEntry,
} from './message-types';

/**
 * Build a player-visible state snapshot from the host's full state.
 * All hidden data is filtered out BEFORE serialization.
 */
export function buildPlayerVisibleState(
  adventure: Adventure,
  scene: Scene,
  characters: Character[],
  logEntries: LogEntry[],
): PlayerVisibleState {
  // Filter out characters marked as hiddenFromPlayers
  const visibleCharacters = characters
    .filter((c) => !c.hiddenFromPlayers)
    .map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      concept: c.concept,
      aspects: c.aspects,
      skills: c.skills,
      stunts: c.stunts,
      stressTracks: c.stressTracks.map((t) => ({
        name: t.name,
        type: t.type,
        icon: t.icon,
        markers: t.markers,
        showInTooltip: t.showInTooltip,
      })),
      consequences: c.consequences.map((cns) => ({
        name: cns.name,
        value: cns.value,
        description: cns.description,
        healed: cns.healed,
      })),
      situationalAspects: c.situationalAspects,
      fatePoints: c.fatePoints,
      refresh: c.refresh,
      avatar: c.avatar,
      avatarColor: c.avatarColor,
      isMage: c.isMage,
    }));

  // Get the floor the player should see (playerFloorIndex).
  // All other floors (GM-only secrets) are hidden.
  const visibleFloor = scene.floors[scene.playerFloorIndex] ?? scene.floors[0] ?? null;
  // Deep-clone and strip fog areas that are still hidden from players
  let visibleFloorFiltered: PlayerVisibleState['visibleFloor'] = null;
  if (visibleFloor) {
    visibleFloorFiltered = {
      ...visibleFloor,
      // Only show tokens whose characters are visible (not hiddenFromPlayers)
      tokens: visibleFloor.tokens.filter((t) => {
        const c = characters.find((ch) => ch.id === t.charId);
        return c ? !c.hiddenFromPlayers : true;
      }),
      // Strip fog areas — players see revealed areas only
      fogAreas: (visibleFloor.fogAreas ?? []).filter((f) => !f.hidden),
      // Keep drawings, zones, pins — these are scene-level public info
      drawings: visibleFloor.drawings,
      zones: visibleFloor.zones,
      pins: visibleFloor.pins,
      // Hide background image if it's marked hidden? For Phase 1, players see the same bg.
      background: visibleFloor.background,
      backgroundImage: visibleFloor.backgroundImage,
      opacity: visibleFloor.opacity,
      id: visibleFloor.id,
      name: visibleFloor.name,
      fogEnabled: visibleFloor.fogEnabled,
    };
  }

  // Latest 50 log entries — players see all rolls (no GM-only filtering needed yet)
  const recentLogs = logEntries
    .slice(-50)
    .map(logEntryToSerializable);

  // Conflict data — strip GM-only fields (eliminatedIds, waitingIds)
  let conflict: PlayerVisibleState['conflict'] = null;
  if (scene.conflictData) {
    const cd = scene.conflictData;
    const currentParticipant = cd.participants[cd.currentParticipantIndex] ?? null;
    conflict = {
      type: cd.type,
      round: cd.round,
      currentParticipantId: currentParticipant?.characterId ?? null,
      participants: cd.participants.map((p) => ({
        characterId: p.characterId,
        initiative: p.initiative,
        hasActed: p.hasActed,
      })),
    };
  }

  return {
    adventureId: adventure.id,
    adventureName: adventure.name,
    sceneId: scene.id,
    sceneName: scene.name,
    playerFloorIndex: scene.playerFloorIndex,
    visibleFloor: visibleFloorFiltered,
    characters: visibleCharacters,
    logEntries: recentLogs,
    conflict,
    playerRoster: adventure.settings.playerRoster ?? [],
    ts: Date.now(),
  };
}

/**
 * Convert a DB LogEntry to the serializable subset for P2P transmission.
 */
export function logEntryToSerializable(entry: LogEntry): SerializableLogEntry {
  return {
    id: entry.id,
    characterId: entry.characterId,
    characterName: entry.characterName,
    skillName: entry.skillName,
    diceResults: entry.diceResults,
    bonus: entry.bonus,
    total: entry.total,
    opponentTotal: entry.opponentTotal,
    difficulty: entry.difficulty,
    result: entry.result,
    opponentType: entry.opponentType,
    opponentCharacterId: entry.opponentCharacterId,
    opponentName: entry.opponentName,
    opponentSkillName: entry.opponentSkillName,
    opponentDiceResults: entry.opponentDiceResults,
    opponentBonus: entry.opponentBonus,
    extraBonus: entry.extraBonus,
    extraBonusReason: entry.extraBonusReason,
    rerolled: entry.rerolled,
    customText: entry.customText,
    isRiftEvent: entry.isRiftEvent,
    createdAt: entry.createdAt,
    skillValue: entry.skillValue,
    manualBonus: entry.manualBonus,
    helpers: entry.helpers,
    aspectInvokeBonus: entry.aspectInvokeBonus,
    aspectInvokeReason: entry.aspectInvokeReason,
    aspectRerolled: entry.aspectRerolled,
    opponentSkillValue: entry.opponentSkillValue,
    opponentManualBonus: entry.opponentManualBonus,
    opponentHelpers: entry.opponentHelpers,
    isMagicRoll: entry.isMagicRoll,
    magicCastType: entry.magicCastType,
    magicCardName: entry.magicCardName,
    magicEffect: entry.magicEffect,
    magicZoneStress: entry.magicZoneStress,
    magicZoneName: entry.magicZoneName,
    magicZoneLevelAfter: entry.magicZoneLevelAfter,
  };
}
