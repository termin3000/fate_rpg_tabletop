// ============================================================
// Fate RPG — P2P Message Types
// ============================================================
// All messages exchanged between GM (host) and players over
// WebRTC DataChannel. JSON-serialized.
// ============================================================

/** Network role — host is GM, player is connected peer. */
export type NetworkRole = 'host' | 'player';

/** Connection state of the P2P manager. */
export type NetworkStatus =
  | 'offline'        // network mode off
  | 'connecting'     // signaling in progress
  | 'online'         // connected to signaling, peers may or may not be connected
  | 'error';         // signaling failed / disconnected

/** Metadata about a connected peer, derived from signaling roster. */
export interface PeerMeta {
  peerId: string;
  name: string;
  isHost: boolean;
  characterId: string | null;
  /** Round-trip latency in ms, populated by client-side ping. */
  pingMs?: number;
  /** Connection state of the WebRTC peer connection. */
  connectionState?: RTCPeerConnectionState;
}

// ── DataChannel message envelope ────────────────────────────
// Every message sent over the DataChannel has a `type` discriminator.
export type P2PMessage =
  | StateSnapshotMessage
  | StateDeltaMessage
  | RollEventMessage
  | SheetUpdateMessage
  | SheetAuditMessage
  | PresenceMessage
  | RequestSnapshotMessage
  | PeerInfoMessage;

/** Full state snapshot — sent by host to a player on initial connect. */
export interface StateSnapshotMessage {
  type: 'state-snapshot';
  /** Monotonic state version (host-side counter). */
  version: number;
  /** Adventure id (so player can verify they're in the right game). */
  adventureId: string;
  /** Scene id this snapshot is for. */
  sceneId: string;
  /** Player-filtered state (no hidden data). */
  state: PlayerVisibleState;
  /** Server time when snapshot was generated. */
  ts: number;
}

/** Delta — incremental update to the state. */
export interface StateDeltaMessage {
  type: 'state-delta';
  version: number;
  sceneId: string;
  /** Path-based patch: array of {op, path, value} operations. */
  patch: StatePatchOp[];
  ts: number;
}

/** Single patch operation (RFC 6902 subset — only what we need). */
export interface StatePatchOp {
  op: 'replace' | 'add' | 'remove';
  /** JSON pointer path, e.g. "/characters/3/stressTracks/0/markers/1". */
  path: string;
  value?: unknown;
}

/** Roll event — broadcast by whoever rolled (player or host-side NPC). */
export interface RollEventMessage {
  type: 'roll-event';
  /** Same shape as LogEntry minus the DB id — host will persist it. */
  roll: SerializableLogEntry;
  /** PeerId of the roller (so host knows who sent it). */
  fromPeerId: string;
  ts: number;
}

/** Sheet update — sent by player when they edit their character sheet. */
export interface SheetUpdateMessage {
  type: 'sheet-update';
  characterId: string;
  /** Patch of changes (same format as StatePatchOp). */
  patch: StatePatchOp[];
  fromPeerId: string;
  ts: number;
}

/** Sheet audit — broadcast by host to GM's own log when a player edits a sheet. */
export interface SheetAuditMessage {
  type: 'sheet-audit';
  characterId: string;
  characterName: string;
  /** Human-readable description of what changed. */
  description: string;
  ts: number;
}

/** Presence ping — periodic heartbeat from player to host.
 *  Also carries the player's dice color preferences so the host (and other
 *  players via snapshot) can render that player's rolls in their chosen
 *  palette. Colors are optional for backward compat with older clients. */
export interface PresenceMessage {
  type: 'presence';
  fromPeerId: string;
  ts: number;
  /** Player's chosen dice body color (hex). Host stores in peerDiceColors map. */
  diceColor?: string;
  /** Player's chosen symbol color (hex). */
  symbolColor?: string;
}

/** Player → host: request a fresh full snapshot. */
export interface RequestSnapshotMessage {
  type: 'request-snapshot';
  fromPeerId: string;
  ts: number;
}

/** Host → player: peer info (current assignments, roster update). */
export interface PeerInfoMessage {
  type: 'peer-info';
  /** Your peerId (echoed back so player knows it). */
  yourPeerId: string;
  /** Your assigned characterId (or null if unassigned). */
  assignedCharacterId: string | null;
  /** Current scene id. */
  sceneId: string;
  ts: number;
}

// ── Player-visible state ────────────────────────────────────
// Subset of full state visible to a player. Host filters via
// filterStateForPlayer() before sending.
export interface PlayerVisibleState {
  adventureId: string;
  adventureName: string;
  sceneId: string;
  sceneName: string;
  /** Floor index the player is currently viewing (playerFloorIndex). */
  playerFloorIndex: number;
  /** Only the floor the player can see — others are hidden. */
  visibleFloor: Floor | null;
  /** All visible characters (hiddenFromPlayers filtered out). */
  characters: Array<{
    id: string;
    name: string;
    type: 'player' | 'npc';
    concept: string;
    aspects: string[];
    skills: Array<{ name: string; value: number }>;
    stunts: Array<{ name: string; description: string }>;
    stressTracks: Array<{ name: string; type: string; icon: string; markers: boolean[]; showInTooltip: boolean }>;
    consequences: Array<{ name: string; value: number; description: string; healed: boolean }>;
    situationalAspects: string[];
    fatePoints: number;
    refresh: number;
    avatar: string | null;
    avatarColor: string;
    isMage: boolean;
  }>;
  /** Latest N log entries (filtered — only rolls visible to player). */
  logEntries: Array<{
    id: string;
    characterName: string;
    skillName: string;
    total: number;
    result: string;
    createdAt: string;
    opponentName: string | null;
    opponentTotal: number | null;
  }>;
  /** Conflict data if active (without GM-only waiting/eliminated hints). */
  conflict: {
    type: 'physical' | 'mental';
    round: number;
    currentParticipantId: string | null;
    participants: Array<{ characterId: string; initiative: number; hasActed: boolean }>;
  } | null;
  /** Roster of PCs in this adventure (so player knows who exists). */
  playerRoster: string[];
  ts: number;
}

// Re-export for convenience
import type { Floor } from '@/lib/types';

// ── Serializable subset of LogEntry (no DB id, no adventureId) ──
export interface SerializableLogEntry {
  id: string;
  characterId: string | null;
  characterName: string;
  skillName: string;
  diceResults: number[];
  bonus: number;
  total: number;
  opponentTotal: number | null;
  difficulty: number | null;
  result: string;
  opponentType: string | null;
  opponentCharacterId: string | null;
  opponentName: string | null;
  opponentSkillName: string | null;
  opponentDiceResults: number[];
  opponentBonus: number;
  extraBonus: number;
  extraBonusReason: string;
  rerolled: boolean;
  customText: string | null;
  isRiftEvent: boolean;
  createdAt: string;
  skillValue?: number | null;
  manualBonus?: number;
  helpers?: Array<{ name: string; bonus: number; baseCharacterName?: string; skillName?: string; skillValue?: number }>;
  aspectInvokeBonus?: number;
  aspectInvokeReason?: string;
  aspectRerolled?: boolean;
  opponentSkillValue?: number | null;
  opponentManualBonus?: number;
  opponentHelpers?: Array<{ name: string; bonus: number; baseCharacterName?: string; skillName?: string; skillValue?: number }>;
  isMagicRoll?: boolean;
  magicCastType?: 'normal' | 'dangerous' | null;
  magicCardName?: string | null;
  magicEffect?: string | null;
  magicZoneStress?: number | null;
  magicZoneName?: string | null;
  magicZoneLevelAfter?: number | null;
}
