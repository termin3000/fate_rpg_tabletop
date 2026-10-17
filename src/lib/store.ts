// ============================================================
// Fate RPG Virtual Tabletop — Zustand Store
// ============================================================

import { create } from 'zustand';

import type {
  Adventure,
  AdventureSettings,
  Character,
  Condition,
  ConflictData,
  ConflictParticipant,
  CustomTable,
  Floor,
  FogArea,
  Folder,
  InitiativeMode,
  Item,
  LiveRollEvent,
  LogEntry,
  MagicTableEntry,
  Note,
  RollResultType,
  Scene,
  Zone,
} from '@/lib/types';
import { DEFAULT_SETTINGS } from '@/lib/types';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from '@/lib/api';
import { genId, getRollResult, rollFateDice, sumFateDice } from '@/lib/fate-dice';
import {
  genLocalId,
  initSyncLoop,
  isLocalId,
  loadPendingEntries,
  persistPendingEntries,
  postLocalEntry,
  patchEntry as offlinePatchEntry,
  setSyncStatus,
  type LocalLogEntry,
} from '@/lib/offline-sync';

// ── Initiative Helpers ──────────────────────────────────────

/** Get a character's skill value by name, defaulting to 0 */
function getSkillValue(char: Character, skillName: string): number {
  return char.skills.find((s) => s.name === skillName)?.value ?? 0;
}

/** Check if a point is inside a polygon (ray casting algorithm) */
function pointInPolygon(x: number, y: number, vertices: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = vertices.length - 1; i < vertices.length; j = i++) {
    const xi = vertices[i].x, yi = vertices[i].y;
    const xj = vertices[j].x, yj = vertices[j].y;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * Calculate a single numeric initiative value for a character.
 * - 'book' mode: primary skill value only (no dice). Tiebreakers handled by sort.
 * - 'random' mode: 4dF + primary skill value (classic Fate).
 */
function calcInitiativeValue(
  char: Character,
  conflictType: 'physical' | 'mental',
  settings: AdventureSettings,
): number {
  const skillSet = conflictType === 'physical'
    ? settings.initiative.physical
    : settings.initiative.mental;

  const primaryValue = getSkillValue(char, skillSet.primary);

  if (settings.initiative.mode === 'random') {
    const dice = rollFateDice();
    const diceTotal = sumFateDice(dice);
    return diceTotal + primaryValue;
  }

  // Book mode: initiative = primary skill value
  return primaryValue;
}

/**
 * Sort comparator for conflict participants.
 * In 'book' mode: compare primary → secondary → tertiary → name (tiebreakers).
 * In 'random' mode: simple descending numeric sort.
 */
function createInitiativeComparator(
  characters: Character[],
  conflictType: 'physical' | 'mental',
  settings: AdventureSettings,
) {
  const skillSet = conflictType === 'physical'
    ? settings.initiative.physical
    : settings.initiative.mental;

  return (a: ConflictParticipant, b: ConflictParticipant) => {
    if (settings.initiative.mode === 'random') {
      return b.initiative - a.initiative;
    }

    // Book mode: multi-key comparison with tiebreakers
    const charA = characters.find((c) => c.id === a.characterId);
    const charB = characters.find((c) => c.id === b.characterId);

    // Primary skill
    const primaryA = charA ? getSkillValue(charA, skillSet.primary) : 0;
    const primaryB = charB ? getSkillValue(charB, skillSet.primary) : 0;
    if (primaryB !== primaryA) return primaryB - primaryA;

    // Secondary skill (tiebreaker)
    const secondaryA = charA ? getSkillValue(charA, skillSet.secondary) : 0;
    const secondaryB = charB ? getSkillValue(charB, skillSet.secondary) : 0;
    if (secondaryB !== secondaryA) return secondaryB - secondaryA;

    // Tertiary skill (tiebreaker)
    const tertiaryA = charA ? getSkillValue(charA, skillSet.tertiary) : 0;
    const tertiaryB = charB ? getSkillValue(charB, skillSet.tertiary) : 0;
    if (tertiaryB !== tertiaryA) return tertiaryB - tertiaryA;

    // Final tiebreaker: alphabetical by name
    const nameA = charA?.name ?? '';
    const nameB = charB?.name ?? '';
    return nameA.localeCompare(nameB, 'ru');
  };
}

// ── P2P Network Types ───────────────────────────────────────

/** Live cursor of a remote peer on the map. Coordinates are world-space
 *  (independent of viewport pan/zoom), so each client renders the cursor at
 *  the right spot regardless of their own view. */
export interface PeerCursor {
  /** World X (same coordinate space as token.x). */
  x: number;
  /** World Y (same coordinate space as token.y). */
  y: number;
  /** Display name shown in the cursor label. */
  name: string;
  /** CSS color for the cursor dot + label background. */
  color: string;
  /** Epoch ms of the last cursor-move event from this peer. */
  ts: number;
  /** False when the peer has been idle (no movement) for >3s — UI renders
   *  idle cursors at reduced opacity. */
  active: boolean;
}

/** Synchronous dice-roll session state. Lives in the store so both host and
 *  players can render the countdown + results panel from the same source. */
export interface SyncRollSession {
  /** Unique session id (used for dedup on the player side). */
  id: string;
  /** Skill name being rolled (e.g. "Бой", "Атлетика"). */
  skillName: string;
  /** Skill value the GM pre-selected (players may override locally). */
  skillValue: number;
  /** Flat bonus to apply to every participant's roll. */
  bonus: number;
  /** Optional fixed difficulty — if set, each result is evaluated vs it. */
  difficulty: number | null;
  /** Peer ids expected to roll. On the host this is the full list; on the
   *  player side it's just [myPeerId] (they only care about themselves). */
  participantPeerIds: string[];
  /** Epoch ms when the session was created (countdown start). */
  startedAt: number;
  /** Epoch ms when the grace period ends — after this, host auto-finalizes. */
  deadlineTs: number;
  /** Countdown duration in seconds (3 by default). */
  countdownSec: number;
  /** Submitted results keyed by peerId. */
  results: Record<string, SyncRollResult>;
  /** Session lifecycle phase. */
  status: 'countdown' | 'rolling' | 'complete' | 'expired';
}

/** One participant's result in a sync-roll session. */
export interface SyncRollResult {
  peerId: string;
  /** Display name of the rolling peer. */
  peerName: string;
  /** Character id the peer rolled for (their assigned PC). */
  characterId: string | null;
  /** Character name (for the results table). */
  characterName: string;
  /** Skill name actually used (may differ from session.skillName if the
   *  player picked a different one for their PC). */
  skillName: string;
  /** Skill value used. */
  skillValue: number;
  /** 4 Fudge dice results (-1, 0, +1 each). */
  dice: number[];
  /** Bonus applied (skill value + flat bonus + manual bonus). */
  bonus: number;
  /** Final total = sum(dice) + bonus. */
  total: number;
  /** Result label ("fail" | "tie" | "success" | "great" — Fate ladder). */
  resultLabel: string;
  /** Epoch ms when the result was submitted. */
  ts: number;
}

// ── Unified Mass Roll (replaces sync-roll) ─────────────────
// A single participant in a mass roll. May be a PC (with peerId of the
// controlling player) or an NPC / offline PC (peerId = null, GM rolls locally).
export interface MassRollParticipant {
  /** Character id rolling. */
  characterId: string;
  /** Character name (cached for display). */
  characterName: string;
  /** Type of character — used for icon/label. */
  characterType: 'pc' | 'npc';
  /** Peer id of the controlling player, or null when GM rolls locally
   *  (NPC or offline PC). */
  peerId: string | null;
  /** Display name of controlling peer (for online indicator). */
  peerName?: string;
  /** Per-player dice colors (stamped from host's peerDiceColors map when
   *  broadcasting results). Used by rendering paths that read massRollState. */
  diceColor?: string;
  symbolColor?: string;

  // ── Skill (resolved) ──────────────────────────────────────
  /** Skill name actually used for this participant. Defaults to the session
   *  skill, but GM may override per-participant (e.g. a stunt that lets a
   *  character roll "Бой" instead of "Атлетика"). */
  skillName: string;
  /** Skill value resolved from the character's sheet for the chosen skill. */
  skillValue: number;
  /** Per-participant manual bonus (from stunts). Defaults to 0. */
  manualBonus: number;

  // ── Ready state (online players only) ────────────────────
  /** True when the player has marked themselves ready in RollInvitationDialog.
   *  For NPC/offline PC, ready=true from the start (no invitation sent). */
  ready: boolean;
  /** Epoch ms when ready was marked (for "ready since Xs ago" display). */
  readyAt: number | null;

  // ── Fate point (player-decided, optional) ────────────────
  /** Whether the player chose to spend a fate point. 'none' = no, 'plus2' =
   *  +2 bonus, 'reroll' = reroll dice once. */
  fatePointMode: 'none' | 'plus2' | 'reroll';
  /** Optional free-text reason (for the log). */
  fatePointReason?: string;

  // ── Result (filled after roll completes) ─────────────────
  result?: MassRollResultData;
}

/** Roll result data for a single mass-roll participant. */
export interface MassRollResultData {
  /** 4 Fudge dice results (-1, 0, +1 each). */
  dice: number[];
  /** Sum of dice (always between -4 and +4). */
  diceSum: number;
  /** Final total = diceSum + skillValue + manualBonus + sessionBonus + fateBonuses + freeInvokeBonuses. */
  total: number;
  /** Result label ("fail" | "tie" | "success" | "great"). */
  resultLabel: string;
  /** True if at least one fate point was used for a reroll (for log annotation / backward compat). */
  usedReroll?: boolean;
  /** Number of fate-point rerolls performed (0 = initial roll). Each reroll
   *  replaces the dice. Multiple rerolls allowed — one fate point per reroll. */
  rerollCount?: number;
  /** Number of fate-point +2 bonuses applied after the roll. Each costs 1 fate
   *  point. Stacks with freeInvokeCount. */
  bonusCount?: number;
  /** Number of free invocations used (no fate point cost). Each adds +2.
   *  Free invocations come from aspects created with Create an Advantage. */
  freeInvokeCount?: number;
  /** History of all adjustments made to this result (for GM visibility + log).
   *  Each entry records what was done and when. */
  history?: Array<{
    type: 'initial' | 'reroll' | 'plus2' | 'free-invoke';
    ts: number;
  }>;
}

/** Unified mass-roll session — replaces SyncRollSession. Combines:
 *  - Multi-character selection (any chars on scene)
 *  - Per-participant skill/bonus overrides
 *  - Online-player ready state (no countdown timer)
 *  - GM force-start when someone is AFK
 *  - Opposed mode (attacker vs multiple defenders)
 *  - Crowd effort (for hordes) */
export interface MassRollSession {
  /** Unique session id. */
  id: string;
  /** Roll mode: 'normal' (no target), 'difficulty' (vs fixed number),
   *  'opposed' (vs an opponent's roll). */
  mode: 'normal' | 'difficulty' | 'opposed';
  /** Default skill name for the session. Per-participant overrides possible. */
  skillName: string;
  /** Default flat bonus applied to every participant. */
  bonus: number;
  /** Fixed difficulty (mode='difficulty'). */
  difficulty: number | null;
  // ── Opposed mode ──────────────────────────────────────────
  /** Opponent character id (mode='opposed'). May be a PC or NPC. */
  opponentId?: string;
  /** Opponent character name (cached). */
  opponentName?: string;
  /** Opponent skill name (may differ from session skill). */
  opponentSkillName?: string;
  /** Opponent total roll (if GM pre-rolled or it's an NPC). */
  opponentTotal?: number;
  /** Opponent dice results (for log display). */
  opponentDice?: number[];

  // ── Participants ──────────────────────────────────────────
  participants: MassRollParticipant[];

  // ── Status ────────────────────────────────────────────────
  /** 'inviting' = waiting for online players to mark ready;
   *  'rolling' = dice are being rolled (or rolled locally for NPCs);
   *  'complete' = all results in, awaiting GM finalize;
   *  'cancelled' = GM aborted. */
  status: 'inviting' | 'rolling' | 'complete' | 'cancelled';
  /** Epoch ms when session was created. */
  startedAt: number;
  /** Epoch ms when all results arrived (for "completed Xs ago" display). */
  completedAt: number | null;
}

// ── Store Interface ─────────────────────────────────────────
interface FateStore {
  // Current state
  currentAdventureId: string | null;
  currentSceneId: string | null;
  currentMode: 'master' | 'player';
  currentFloorIndex: number;

  // Data
  adventures: Adventure[];
  characters: Character[];
  scenes: Scene[];
  logEntries: LogEntry[];
  items: Item[];
  folders: Folder[];
  notes: Note[];

  // Settings
  settings: AdventureSettings;
  magicModuleEnabled: boolean;
  magicTable: MagicTableEntry[];

  // Custom Random Tables (localStorage)
  customTables: CustomTable[];

  // ── Network (P2P) State ─────────────────────────────────────
  /** True when connected to a host (player) or when hosting (host). */
  isNetworkActive: boolean;
  /** 'host' = GM hosting; 'player' = connected to a host; null = local/offline. */
  networkRole: 'host' | 'player' | null;
  /** This peer's stable id (persisted in localStorage). */
  networkMyPeerId: string | null;
  /** Display name shown to other peers. */
  networkMyDisplayName: string;
  /** Room id (shared by host + players in the same session). */
  networkRoomId: string | null;
  /** Connected peers keyed by peerId → displayName. */
  networkPeers: Record<string, { peerId: string; displayName: string; role: 'host' | 'player' }>;
  /** Character assignments: peerId → list of characterIds the peer controls. */
  playerAssignments: Record<string, string[]>;
  /** Whether the host is currently online (player perspective). */
  networkHostOnline: boolean;
  /** Signaling connection status: 'offline' = not connected, 'connecting' = in
   *  progress, 'online' = signaling socket connected (room may or may not be
   *  active), 'error' = connection failed. */
  networkSignalingStatus: 'offline' | 'connecting' | 'online' | 'error';
  /** Per-peer round-trip latency in milliseconds (keyed by peerId). Updated
   *  by the ping/pong loop in use-network.ts. */
  peerLatencies: Record<string, number>;
  /** Per-peer last-seen timestamp (ms epoch). Used to mark peers as offline
   *  if no pong received within the timeout window. */
  peerLastSeen: Record<string, number>;
  /** Live cursors of remote peers on the map. Keyed by peerId. Updated in
   *  near-real-time (throttled to ~30fps) by the cursor-move handler in
   *  use-network.ts. The `active` flag is false when the peer has stopped
   *  moving for >3s — UI renders those with reduced opacity (idle state). */
  peerCursors: Record<string, PeerCursor>;
  /** Current synchronous dice-roll session, or null when idle. When the GM
   *  triggers a sync roll, a session is created with a deadline; assigned
   *  players receive a countdown and then auto-roll. Results accumulate
   *  here until the GM closes the dialog or the deadline expires. */
  syncRollState: SyncRollSession | null;
  /** Unified mass-roll session (replaces syncRollState going forward).
   *  Supports: any chars on scene as participants, per-participant skill
   *  overrides + manual bonus, online-player ready state (no countdown),
   *  GM force-start, opposed mode, crowd effort. Null when idle. */
  massRollState: MassRollSession | null;

  // ── Live Roll Stage Overlay (theatrical mode) ───────────────
  /** Currently displayed roll event on the full-screen overlay, or null when
   *  the overlay is closed. Driven by `enqueueLiveRoll` — when null and the
   *  queue is non-empty, the next event auto-plays. */
  liveRollStage: LiveRollEvent | null;
  /** Queue of pending roll events waiting to be displayed (FIFO). New events
   *  added via `enqueueLiveRoll`; consumed by `dismissLiveRoll`. */
  liveRollQueue: LiveRollEvent[];
  /** Set of already-seen event ids (last ~50). Used to dedupe incoming
   *  network events so the same roll doesn't play twice if it arrives via
   *  both local enqueue + remote broadcast. */
  liveRollSeenIds: string[];
  /** When true, the RollStageOverlay should play the "return to case"
   *  animation (dice fly back into the dice case) and then call
   *  dismissLiveRoll. Set by requestLiveRollExit (DiceCase click / Esc).
   *  Reset to false by dismissLiveRoll. */
  liveRollExiting: boolean;
  /** Last rolled dice (Fudge dice: array of -1/0/1, length = 4 by default).
   *  Captured at the moment a roll is enqueued — used by DiceCase to show
   *  the cube faces "lying" with the last result. Survives overlay close. */
  lastDiceResult: number[];
  /** Color of dice body (hex). Persisted in localStorage('fate-dice-color').
   *  Default: '#1976d2' (синий). Cannot equal symbolColor — setDiceColor
   *  ignores values that match symbolColor (UI also blocks the choice). */
  diceColor: string;
  /** Color of dice symbols (hex). Persisted in localStorage('fate-symbol-color').
   *  Default: '#f8fafc' (белый). Cannot equal diceColor — setSymbolColor
   *  ignores values that match diceColor. */
  symbolColor: string;
  /** ── Per-peer dice colors (for multiplayer) ──
   *  Map peerId → { diceColor, symbolColor }. Populated from presence
   *  messages (players announce their colors to host) + the host's own
   *  entry. Used by `enqueueLiveRoll` to stamp each participant's dice
   *  with THAT player's chosen palette, so in mass rolls everyone's dice
   *  are visually distinct. The local viewer's own peerId maps to their
   *  own colors (kept in sync with diceColor/symbolColor). */
  peerDiceColors: Record<string, { diceColor: string; symbolColor: string }>;
  /** Theatrical mode master toggle. When false, no overlay is shown (rolls
   *  still go to the log). Persisted in localStorage. */
  theatricalMode: boolean;
  /** Overlay duration in milliseconds (auto-dismiss). Default 3500. Persisted
   *  in localStorage. Range: 1500–6000. */
  theatricalDurationMs: number;
  /** Dice rendering mode: '3d' = server-side Rapier3D physics (default),
   *  '2d' = pure Math.random fallback for weak devices / offline physics.
   *  Persisted in localStorage('fate-dice-mode'). */
  diceMode: '3d' | '2d';

  // UI State
  isLoading: boolean;

  // Actions — Adventures
  loadAdventures: () => Promise<void>;
  createAdventure: (name: string) => Promise<void>;
  deleteAdventure: (id: string) => Promise<void>;
  switchAdventure: (id: string) => Promise<void>;
  exportAdventure: () => Promise<void>;
  importAdventure: (file: File) => Promise<void>;
  transferAdventure: (
    sourceAdventureId: string,
    targetAdventureId: string,
    transfer: {
      characters?: boolean;
      scenes?: boolean;
      items?: boolean;
      folders?: boolean;
      notes?: boolean;
      settings?: boolean;
      modules?: boolean;
    },
  ) => Promise<{ characters: number; scenes: number; items: number; folders: number; notes: number; settings: boolean; modules: boolean }>;

  // Actions — Characters
  loadCharacters: (adventureId: string) => Promise<void>;
  createCharacter: (data: Partial<Character>) => Promise<Character>;
  updateCharacter: (id: string, data: Partial<Character>) => Promise<void>;
  deleteCharacter: (id: string) => Promise<void>;

  // Actions — Scenes
  loadScenes: (adventureId: string) => Promise<void>;
  createScene: (name: string) => Promise<void>;
  deleteScene: (id: string) => Promise<void>;
  switchScene: (id: string) => Promise<void>;
  updateScene: (id: string, data: Partial<Scene>) => Promise<void>;
  addCharacterToScene: (characterId: string) => Promise<void>;
  removeCharacterFromScene: (characterId: string) => Promise<void>;
  addTokenToMap: (characterId: string) => Promise<void>;
  addTokenToMapAt: (characterId: string, x: number, y: number) => Promise<void>;
  removeTokenFromMap: (characterId: string) => Promise<void>;

  // Actions — Log
  loadLogEntries: (adventureId: string) => Promise<void>;
  addLogEntry: (entry: Partial<LogEntry>) => Promise<string>;
  /** Add a log entry that originated from a REMOTE peer (over the network).
   *  Adds to local state + localStorage but does NOT POST to the server
   *  (the originating peer already POSTed) and does NOT re-broadcast
   *  (prevents infinite loop). Dedupes by id if the entry already exists. */
  addRemoteLogEntry: (entry: LocalLogEntry) => void;
  updateLogEntry: (id: string, updates: Partial<LogEntry>) => Promise<void>;
  rerollLogEntry: (entryId: string, target: 'attacker' | 'defender', opts?: { isFree?: boolean }) => Promise<void>;
  addBonusToLogEntry: (entryId: string, target: 'attacker' | 'defender', bonus: number, reason: string, opts?: { isFree?: boolean }) => Promise<void>;
  clearLog: () => Promise<void>;

  // Actions — Items
  loadItems: (adventureId: string) => Promise<void>;
  createItem: (data: Partial<Item>) => Promise<void>;
  updateItem: (id: string, data: Partial<Item>) => Promise<void>;
  deleteItem: (id: string) => Promise<void>;

  // Actions — Folders
  loadFolders: (adventureId: string) => Promise<void>;
  createFolder: (data: Partial<Folder>) => Promise<void>;
  updateFolder: (id: string, data: Partial<Folder>) => Promise<void>;
  deleteFolder: (id: string) => Promise<void>;

  // Actions — Notes
  loadNotes: (adventureId: string) => Promise<void>;
  createNote: (data: Partial<Note>) => Promise<void>;
  updateNote: (id: string, data: Partial<Note>) => Promise<void>;
  deleteNote: (id: string) => Promise<void>;

  // Actions — Settings
  updateSettings: (settings: Partial<AdventureSettings>) => Promise<void>;

  // Actions — Magic
  loadMagicTable: (entries: MagicTableEntry[]) => void;
  getZoneForCharacter: (charId: string) => Zone | null;
  applyMagicZoneStress: (zoneId: string, stressDelta: number, casterName?: string) => Promise<{ newLevel: number; oldLevel: number; zoneName: string }>;
  performMassWillRoll: (zoneId: string) => Promise<void>;
  performMagicRoll: (castType: 'normal' | 'dangerous', casterId?: string | null) => Promise<{
    roll: number;
    entry: MagicTableEntry | null;
    castType: 'normal' | 'dangerous';
    zoneName?: string;
    zoneStressApplied?: number;
    newZoneLevel?: number;
  }>;

  // Actions — Conflict
  startConflict: (type: 'physical' | 'mental') => Promise<void>;
  nextTurn: () => Promise<void>;
  eliminateParticipant: (characterId: string) => Promise<void>;
  returnParticipant: (characterId: string) => Promise<void>;
  removeParticipantFromConflict: (characterId: string) => Promise<void>;
  endConflict: () => Promise<void>;
  rollInitiativeForAll: () => Promise<void>;
  addParticipantToConflict: (characterId: string, immediate?: boolean) => Promise<void>;

  // Actions — Conditions (status effects on tokens)
  addCondition: (charId: string, condition: Omit<Condition, 'id'>) => Promise<void>;
  removeCondition: (charId: string, conditionId: string) => Promise<void>;
  updateCondition: (charId: string, conditionId: string, data: Partial<Condition>) => Promise<void>;
  tickConditions: () => Promise<void>;

  // Actions — Floor background image
  updateFloorBackground: (sceneId: string, floorIndex: number, backgroundImage: string | null) => Promise<void>;

  // Actions — Fog of War
  addFogArea: (sceneId: string, floorIndex: number, area: FogArea) => Promise<void>;
  removeFogArea: (sceneId: string, floorIndex: number, areaId: string) => Promise<void>;
  toggleFogArea: (sceneId: string, floorIndex: number, areaId: string) => Promise<void>;
  toggleFloorFog: (sceneId: string, floorIndex: number, enabled: boolean) => Promise<void>;
  clearFloorFog: (sceneId: string, floorIndex: number) => Promise<void>;

  // Actions — UI
  setMode: (mode: 'master' | 'player') => void;
  setFloorIndex: (index: number) => void;

  // ── Actions — Network (P2P) ─────────────────────────────────
  /** Initialize network state when starting/joining a session. */
  setNetworkActive: (active: boolean) => void;
  setNetworkRole: (role: 'host' | 'player' | null) => void;
  setNetworkMyPeerId: (peerId: string | null) => void;
  setNetworkMyDisplayName: (name: string) => void;
  setNetworkRoomId: (roomId: string | null) => void;
  setNetworkPeers: (peers: Record<string, { peerId: string; displayName: string; role: 'host' | 'player' }>) => void;
  setNetworkHostOnline: (online: boolean) => void;
  /** Update the signaling connection status (called by use-network.ts lifecycle). */
  setNetworkSignalingStatus: (status: 'offline' | 'connecting' | 'online' | 'error') => void;
  /** Update a single peer's RTT latency (called by the ping/pong loop). */
  setPeerLatency: (peerId: string, latencyMs: number) => void;
  /** Bulk-replace peer latencies (e.g. on state sync from host). */
  setPeerLatencies: (latencies: Record<string, number>) => void;
  /** Update a single peer's last-seen timestamp. */
  touchPeer: (peerId: string) => void;
  /** Remove a peer's latency and last-seen entries (on disconnect). */
  forgetPeer: (peerId: string) => void;
  /** Update (or replace) a remote peer's cursor on the map. Called by the
   *  cursor-move handler at ~30fps. Pass `active: false` to mark idle. */
  setPeerCursor: (peerId: string, cursor: PeerCursor) => void;
  /** Remove a single peer's cursor (when they disconnect or leave the map). */
  clearPeerCursor: (peerId: string) => void;
  /** Remove all peer cursors (e.g. on session leave). */
  clearAllPeerCursors: () => void;
  /** GM: start a new synchronous dice-roll session. Broadcasts the request
   *  to all assigned players via use-network.ts. */
  startSyncRoll: (params: { skillName: string; skillValue: number; bonus: number; difficulty: number | null; participantPeerIds: string[]; countdownSec?: number }) => void;
  /** GM or player: cancel the current sync-roll session (clears state). */
  cancelSyncRoll: () => void;
  /** Player: submit my roll result back to the host. Stored locally and
   *  also broadcast via use-network.ts. */
  submitSyncRollResult: (result: SyncRollResult) => void;
  /** GM: finalize the session (sort results, persist a log entry). */
  finalizeSyncRoll: () => Promise<void>;
  // ── Unified Mass Roll Actions ─────────────────────────────
  /** GM: start a new mass-roll session. Builds participants from selected
   *  character ids, resolves their peerId from playerAssignments, and
   *  resolves their skill value from their character sheet for the chosen
   *  skill. Returns the session id so the caller can broadcast invitations. */
  startMassRoll: (params: {
    mode: 'normal' | 'difficulty' | 'opposed';
    skillName: string;
    bonus: number;
    difficulty: number | null;
    characterIds: string[];
    opponentId?: string;
    opponentSkillName?: string;
    /** Unnamed NPC (opposed mode): abstract opponent with a fixed skill bonus.
     *  When provided, opponentId is ignored and a local roll is performed
     *  with this skill value. Name in the log will be "Безымянный NPC". */
    unnamedNpc?: {
      skillName: string;
      skillValue: number;
    };
  }) => string;
  /** GM: update a single participant's overrides (skill name or manual bonus).
   *  Re-resolves skillValue from the character sheet when skillName changes. */
  updateMassRollParticipant: (characterId: string, updates: {
    skillName?: string;
    manualBonus?: number;
  }) => void;
  /** Player: mark myself ready (or unready) for a mass-roll session, with
   *  optional fate point usage. Stored locally and broadcast to host. */
  setMassRollReady: (sessionId: string, characterId: string, ready: boolean, fatePoint?: {
    mode: 'none' | 'plus2' | 'reroll';
    reason?: string;
  }) => void;
  /** GM or player (via broadcast): apply a ready-state update received from
   *  the network. Updates the participant's ready flag + fate point info. */
  applyMassRollReady: (sessionId: string, characterId: string, ready: boolean, fatePoint?: {
    mode: 'none' | 'plus2' | 'reroll';
    reason?: string;
  }) => void;
  /** GM: force the roll to start now (even if not all online players are
   *  ready). Used when someone is AFK. Auto-rolls for unready participants
   *  without fate point usage. */
  forceStartMassRoll: () => void;
  /** Internal: roll dice for a single participant (NPC or unready PC) and
   *  store the result locally. Called by forceStartMassRoll and when all
   *  online participants are ready. */
  rollMassRollParticipantLocally: (characterId: string) => void;
  /** Player or GM: store a participant's result (received from network or
   *  rolled locally). Marks the participant as complete. When all participants
   *  have results, sets session status to 'complete'. */
  submitMassRollResult: (sessionId: string, characterId: string, result: MassRollResultData) => void;
  /** GM: finalize the session — sort participants by total, persist a
   *  structured log entry (similar to finalizeSyncRoll but with per-participant
   *  skill overrides + manual bonus in the log). Clears massRollState. */
  finalizeMassRoll: () => Promise<void>;
  /** Cancel the current mass-roll session (clears state without logging). */
  cancelMassRoll: () => void;

  // ── Live Roll Stage Overlay actions ────────────────────────
  /** Enqueue a new roll event for theatrical display. If the overlay is
   *  currently idle (liveRollStage === null), the event starts playing
   *  immediately; otherwise it's queued and auto-plays when the current
   *  event is dismissed. Idempotent — if the event id was already seen,
   *  it's silently dropped (prevents local+broadcast double-play). */
  enqueueLiveRoll: (event: LiveRollEvent) => void;
  /** Dismiss the currently displayed event and pop the next one from the
   *  queue (if any). Called by the overlay's auto-dismiss timer or by the
   *  user clicking the skip button. */
  dismissLiveRoll: () => void;
  /** Request a graceful exit: sets liveRollExiting=true so the overlay
   *  plays the "return to case" animation, then calls dismissLiveRoll
   *  after ~450ms. Used by DiceCase click and Esc key. */
  requestLiveRollExit: () => void;
  /** Clear the entire overlay queue + dismiss current. Used when switching
   *  adventures or leaving a network session. */
  clearLiveRollQueue: () => void;
  /** Применить результат серверной физики к текущему event'у: обновляет
   *  participant.dice/total/resultLabel, пересчитывает verdict, снимает
   *  флаг pendingPhysics. Вызывается из RollStageOverlay по callback
   *  onResult от physics-service. */
  applyPhysicsResult: (
    eventId: string,
    participantId: string,
    dice: number[],
  ) => void;
  /** Запустить бросок через сервер-авторитативную физику. Создаёт event
   *  skeleton с pendingPhysics, ставит в очередь overlay, возвращает
   *  Promise который резолвится когда физика финализируется (или reject'ится
   *  при cancel/timeout). Caller (диалог броска) создаёт лог-запись с
   *  реальным результатом в .then(). */
  runRollWithPhysics: (
    eventSkeleton: Omit<LiveRollEvent, 'pendingPhysics'>,
    presetId?: string,
    /** Жест-бросок: направление и латеральный офсет, вычисленные из drop
     *  координат на canvas. Если не передан — defaults (originSide='near',
     *  originX=0), как было раньше (кнопка-бросок).
     *  direction (угол в радианах) — только для drag-броска: physics-service
     *  вращает импульс на этот угол, кубы летят в сторону жеста.
     *  spawnX/spawnZ (абсолютные физ. координаты) — token-placement mode:
     *  кубы появляются ровно под курсором в точке отпускания.
     *  swingVelocity (px/ms) — скорость взмаха: масштабирует импульс броска
     *  для реалистичности (медленно → мягкое падение, быстро → сильный бросок).
     *  initialQuats — текущие ориентации кубиков из 3D-оверлея (in-hand
     *    rotation): physics-service пропускает фазу перемешивания → бросок
     *    становится бесшовным ("тащил → отпустил → сразу полетели").
     *  initialAngularVelocity (Вариант A) — текущие угловые скорости кубиков
     *    из HeldDiceController: physics-service продолжает вращение
     *    удерживаемых кубов (та же ось+скорость) → "те же кубы полетели". */
    origin?: { originSide?: 'near' | 'far'; originX?: number; direction?: number; dropX?: number; dropY?: number; spawnX?: number; spawnZ?: number; swingVelocity?: number; initialQuats?: Array<[number, number, number, number]>; initialAngularVelocity?: Array<[number, number, number]> },
  ) => Promise<{ dice: number[]; total: number; eventId: string; participantId: string }>;
  /** Запустить бросок через ЛОКАЛЬНУЮ 2D-физику (diceMode='2d'). Полный
   *  аналог runRollWithPhysics, но вместо server-authoritative Rapier3D
   *  используется лёгкий 2D-движок (dice-2d-physics) в браузере. Создаёт
   *  event skeleton с pending2DPhysics, ставит в очередь overlay, возвращает
   *  Promise который резолвится когда 2D-физика финализируется (кубики
   *  останавливаются). Тот же pendingPhysicsResolvers Map (по eventId) —
   *  applyPhysicsResult не различает 2D/3D.
   *
   *  origin2D — параметры 2D-броска (в пикселях относительно карты, НЕ в
   *  физ. единицах как origin для 3D):
   *    spawnX/spawnY — стартовая позиция на карте в px.
   *    direction — угол в screen-coords (0=вправо, π/2=вниз).
   *    speed — базовая скорость в px/с (масштабируется пресетом).
   *    initialFaces — грани удерживаемых 2D-плиток (drag-handoff).
   *    initialPositions/initialVelocities — для бесшовного handoff.
   *    dropX/dropY — screen-координаты (для логирования).
   *    presetId — пресет броска (gentle/normal/power/lob/scatter). */
  runRollWith2DPhysics: (
    eventSkeleton: Omit<LiveRollEvent, 'pending2DPhysics'>,
    presetId?: string,
    origin2D?: {
      spawnX?: number;
      spawnY?: number;
      direction?: number;
      speed?: number;
      initialFaces?: Array<1 | 0 | -1>;
      initialPositions?: Array<{ x: number; y: number }>;
      initialVelocities?: Array<{ vx: number; vy: number }>;
      dropX?: number;
      dropY?: number;
    },
  ) => Promise<{ dice: number[]; total: number; eventId: string; participantId: string }>;
  /** Запустить ОДНОВРЕМЕННЫЙ VS бросок: две физические сессии (ролик + оппонент)
   *  стартуют параллельно с разных сторон арены (near + far). Кубики летят
   *  навстречу друг другу и приземляются в центре. Возвращает Promise который
   *  резолвится когда ОБЕ сессии финализированы, с массивом результатов
   *  (по одному на участника, в порядке participants). */
  runVSRollWithPhysics: (
    eventSkeleton: Omit<LiveRollEvent, 'pendingPhysics' | 'pendingPhysicsSessions'>,
    sessions: Array<{ participantId: string; presetId?: string; originSide: 'near' | 'far' }>,
  ) => Promise<Array<{ dice: number[]; total: number; eventId: string; participantId: string }>>;
  /** Запустить ZONAL MASS бросок: N физических сессий (одна на участника)
   *  стартуют параллельно с разных латеральных X-офсетов (originX) так,
   *  чтобы кубики разных участников не пересекались на столе. Каждая
   *  сессия имеет свой originSide ('near'/'far') и опциональный originX
   *  (латеральный офсет точки спавна стакана). Возвращает Promise, который
   *  резолвится когда ВСЕ сессии финализированы, с массивом результатов
   *  в порядке participants.
   *
   *  В отличие от runVSRollWithPhysics (который жёстко рассчитан на 2
   *  участников — ролик + оппонент), этот метод поддерживает ПРОИЗВОЛЬНОЕ
   *  число участников N ≥ 1. Promise-bridge переиспользует тот же
   *  pendingVSResolvers Map (переименованный концептуально в
   *  "multi-session resolvers", но переменная оставлена для совместимости). */
  runMassRollWithPhysics: (
    eventSkeleton: Omit<LiveRollEvent, 'pendingPhysics' | 'pendingPhysicsSessions'>,
    sessions: Array<{ participantId: string; presetId?: string; originSide: 'near' | 'far'; originX?: number }>,
  ) => Promise<Array<{ dice: number[]; total: number; eventId: string; participantId: string }>>;
  /** Toggle theatrical mode on/off. Persisted in localStorage. */
  setTheatricalMode: (enabled: boolean) => void;
  /** Set overlay auto-dismiss duration in ms. Persisted in localStorage. */
  setTheatricalDurationMs: (ms: number) => void;
  /** Switch dice rendering between '3d' (server Rapier3D physics) and '2d'
   *  (pure Math.random fallback). Persisted in localStorage('fate-dice-mode'). */
  setDiceMode: (mode: '3d' | '2d') => void;
  /** Set dice body color (hex). Ignored if value === current symbolColor
   *  — UI prevents this, but the guard is also in store for safety.
   *  Persisted in localStorage('fate-dice-color'). */
  setDiceColor: (hex: string) => void;
  /** Set dice symbol color (hex). Ignored if value === current diceColor.
   *  Persisted in localStorage('fate-symbol-color'). */
  setSymbolColor: (hex: string) => void;
  /** Update a remote peer's dice colors (from presence message). Merged
   *  into `peerDiceColors` map. Pass null to remove a disconnected peer. */
  setPeerDiceColor: (peerId: string, colors: { diceColor: string; symbolColor: string } | null) => void;
  /** GM: toggle a character on/off a peer's controlled roster. */
  togglePeerCharacter: (peerId: string, characterId: string) => Promise<void>;
  /** GM: replace a peer's full controlled character list. */
  setPeerCharacters: (peerId: string, characterIds: string[]) => Promise<void>;
  /** GM (legacy compat): set a peer's roster to exactly [characterId] or []. */
  assignCharacterToPeer: (peerId: string, characterId: string | null) => Promise<void>;
  /** Replace all player assignments (e.g. on state sync from host). */
  setPlayerAssignments: (assignments: Record<string, string[]>) => void;
  /** Register/unregister network broadcaster callbacks. Called by the
   *  useNetwork hook on mount/unmount. Passing null for a fn unregisters it.
   *  The store uses these to push log entries to peers without a circular
   *  import. See the module-level _broadcastLogEntryFn docs. */
  setNetworkBroadcasters: (fns: {
    broadcastLogEntry?: ((entry: LocalLogEntry) => void) | null;
    broadcastRollStage?: ((event: LiveRollEvent) => void) | null;
    /** Broadcast this client's dice color palette to peers so each player's
     *  dice render in THEIR chosen colors everywhere (per-player customization).
     *  Called from setDiceColor/setSymbolColor and on initial peer connect. */
    broadcastDiceColors?: ((colors: { diceColor: string; symbolColor: string }) => void) | null;
    /** Broadcast a scene update (token move, drawing, zone, fog edit, etc.)
     *  to all peers. Called from updateScene. */
    broadcastSceneUpdate?: ((sceneId: string, data: Partial<Scene>) => void) | null;
    /** Broadcast a character sheet update to all peers. Called from
     *  updateCharacter. */
    broadcastCharacterUpdate?: ((characterId: string, data: Partial<Character>) => void) | null;
    /** Broadcast a GRANULAR token move (latency fix). Sends only {sceneId,
     *  floorIndex, charId, x, y} instead of the full floors array. Called
     *  from game-canvas persistTokenPosition. */
    broadcastTokenMove?: ((sceneId: string, floorIndex: number, charId: string, x: number, y: number) => void) | null;
  }) => void;
  /** Reset all network state (disconnect). */
  resetNetworkState: () => void;

  // ── Access Control Guards ───────────────────────────────────
  /** Returns ALL character ids assigned to this peer (multi-assign support). */
  myAssignedCharacterIds: () => string[];
  /** Returns the primary (first) character id assigned to this peer, or null. */
  myAssignedCharacterId: () => string | null;
  /** Can the current peer roll dice for this character? */
  canRollForCharacter: (characterId: string) => boolean;
  /** Can the current peer edit this character's sheet? */
  canEditCharacter: (characterId: string) => boolean;
  /** Can the current peer move this token on the map? */
  canControlToken: (characterId: string) => boolean;
  /** Can the current peer create/edit adventures? */
  canEditAdventure: () => boolean;
  /** Can the current peer see the library/NPC generator? */
  canSeeLibrary: () => boolean;
  /** Can the current peer trigger team/mass rolls? */
  canTeamRoll: () => boolean;
  /** Can the current peer reroll or add bonuses to log entries? */
  canRerollLog: () => boolean;
  /** Can the current peer manage game clocks? */
  canManageClocks: () => boolean;
  /** Can the current peer end the turn for this character in conflict? */
  canEndTurnFor: (characterId: string) => boolean;
  /** Can the current peer become host (only when network is NOT active)? */
  canBecomeHost: () => boolean;
  /** Can the current peer draw/edit fog of war? */
  canDrawFog: () => boolean;
  /** Can the current peer manage floors? */
  canManageFloors: () => boolean;

  // Actions — Floor management
  addFloor: (sceneId: string, name?: string) => Promise<void>;
  removeFloor: (sceneId: string, floorIndex: number) => Promise<void>;
  renameFloor: (sceneId: string, floorIndex: number, name: string) => Promise<void>;
  duplicateFloor: (sceneId: string, floorIndex: number) => Promise<void>;
  reorderFloor: (sceneId: string, fromIndex: number, toIndex: number) => Promise<void>;
  setFloorOpacity: (sceneId: string, floorIndex: number, opacity: number) => Promise<void>;

  // Actions — Custom Random Tables
  loadCustomTables: () => void;
  saveCustomTable: (table: CustomTable) => void;
  deleteCustomTable: (id: string) => void;

  // Helpers
  getCurrentAdventure: () => Adventure | null;
  getCurrentScene: () => Scene | null;
  getCharacter: (id: string) => Character | null;
  getActiveCharacters: () => Character[];
  getSceneCharacters: () => Character[];
}

// ── Store Implementation ────────────────────────────────────

// Promise-bridge для runRollWithPhysics. Хранит resolver'ы по eventId,
// чтобы applyPhysicsResult мог резолвнуть promise когда физика финализируется.
// Living outside the store state — это side-effect-канал, не UI-state.
const pendingPhysicsResolvers = new Map<
  string,
  (result: { dice: number[]; total: number; eventId: string; participantId: string }) => void
>();

// Promise-bridge для runVSRollWithPhysics И runMassRollWithPhysics (одновременный
// multi-session бросок — VS на 2 участников или zonal mass на N участников).
// Один eventId → один resolver, который ждёт результаты ВСЕХ участников.
// Когда последний участник финализирован — резолвится с массивом результатов
// в порядке participants. Имя переменной сохранено для совместимости со
// старым кодом, но концептуально это "multi-session resolvers".
const pendingVSResolvers = new Map<
  string,
  {
    expected: Set<string>;  // participantIds, которые ещё ждут
    results: Map<string, { dice: number[]; total: number; participantId: string }>;
    resolve: (all: Array<{ dice: number[]; total: number; eventId: string; participantId: string }>) => void;
  }
>();

// ── Network broadcaster refs ─────────────────────────────────
// Module-level refs set by the useNetwork hook on mount. The store calls
// these to push log entries and roll-stage events to connected peers without
// creating a circular import (store → useNetwork → store).
//
//   _broadcastLogEntryFn: called from addLogEntry after the entry is added
//     locally. Sends the entry to peers so they can add it via
//     addRemoteLogEntry (which does NOT POST to the server, avoiding
//     duplicates). null when network is inactive.
//
//   _broadcastRollStageFn: called from broadcastRollStage (useNetwork) —
//     declared here for completeness but actually invoked from the hook
//     itself (not the store) since the hook owns enqueueLiveRoll routing.
//
//   _broadcastSceneUpdateFn: called from updateScene after the scene is
//     updated locally + persisted to the API. Sends the partial scene data
//     to peers so they can apply it via applyAction (which calls updateScene
//     in "silent" mode — no re-broadcast — to avoid an infinite loop).
//     This is what makes token moves, drawings, zones, and fog edits sync
//     in real-time. null when network is inactive.
//
//   _broadcastCharacterUpdateFn: same idea, for character sheet edits.
//
//   _suppressSceneBroadcast: when true, updateScene skips calling
//     _broadcastSceneUpdateFn. Set by applyAction (in use-network) when
//     applying a REMOTE action, so we don't echo it back to the sender.
//   _suppressCharacterBroadcast: same for character updates.
//
// Both are no-ops when null (offline mode, or useNetwork not yet mounted).
let _broadcastLogEntryFn: ((entry: LocalLogEntry) => void) | null = null;
let _broadcastRollStageFn: ((event: LiveRollEvent) => void) | null = null;
// _broadcastDiceColorsFn: called from setDiceColor/setSymbolColor (and on
// peer connect) to push this client's dice palette to all peers. Peers store
// it in peerDiceColors[myPeerId] so they can render this player's rolls (and
// mass-roll participants) in their chosen colors. null when offline.
let _broadcastDiceColorsFn: ((colors: { diceColor: string; symbolColor: string }) => void) | null = null;
let _broadcastSceneUpdateFn: ((sceneId: string, data: Partial<Scene>) => void) | null = null;
let _broadcastCharacterUpdateFn: ((characterId: string, data: Partial<Character>) => void) | null = null;
let _broadcastTokenMoveFn: ((sceneId: string, floorIndex: number, charId: string, x: number, y: number) => void) | null = null;
// Suppression flags — set true while applying a REMOTE action so the local
// updateScene/updateCharacter doesn't re-broadcast (would cause an infinite
// echo: host → player → host → player → ...).
let _suppressSceneBroadcast = false;
let _suppressCharacterBroadcast = false;

/**
 * Toggle scene-update broadcast suppression. Called by use-network's
 * applyAction() while applying a REMOTE scene:update, so the local
 * updateScene doesn't echo the change back to the sender.
 */
export function setSuppressSceneBroadcast(v: boolean) {
  _suppressSceneBroadcast = v;
}
/**
 * Toggle character-update broadcast suppression. Same idea as above.
 */
export function setSuppressCharacterBroadcast(v: boolean) {
  _suppressCharacterBroadcast = v;
}

// ── isLocalRollEvent ─────────────────────────────────────────
// Determines whether a LiveRollEvent was initiated by THIS client (the local
// viewer). Used to gate store mutations that should only affect the roller's
// own local state — most importantly `lastDiceResult` (the dice faces shown
// "lying" in the viewer's own dice case). Without this gate, a remote player's
// broadcast roll would overwrite every other viewer's lastDiceResult, making
// everyone's dice case show the remote roller's result — which breaks the
// "these are MY dice on MY desk" metaphor.
//
//   • Offline (no network): every roll is local.
//   • Online + roller.peerId === networkMyPeerId: my PC's roll.
//   • Online + roller.peerId == null AND I'm host: GM rolling an NPC / legacy.
//   • Otherwise (someone else's PC, received via broadcast): NOT local.
function isLocalRollEvent(
  event: LiveRollEvent | null | undefined,
  s: { isNetworkActive: boolean; networkRole: 'host' | 'player' | null; networkMyPeerId: string | null },
): boolean {
  if (!event) return false;
  if (!s.isNetworkActive) return true;
  const rollerPeerId = event.participants?.[0]?.peerId;
  if (rollerPeerId != null && s.networkMyPeerId != null && rollerPeerId === s.networkMyPeerId) {
    return true;
  }
  if (rollerPeerId == null && s.networkRole === 'host') {
    return true;
  }
  return false;
}

export const useFateStore = create<FateStore>((set, get) => ({
  // ── Initial state ──────────────────────────────────────────
  currentAdventureId: null,
  currentSceneId: null,
  currentMode: 'master',
  currentFloorIndex: 0,

  adventures: [],
  characters: [],
  scenes: [],
  logEntries: [],
  items: [],
  folders: [],
  notes: [],

  settings: { ...DEFAULT_SETTINGS },
  magicModuleEnabled: false,
  magicTable: (() => {
    if (typeof window === 'undefined') return [];
    try {
      const stored = localStorage.getItem('fate-magic-table');
      return stored ? JSON.parse(stored) : [];
    } catch { return []; }
  })(),

  customTables: [],

  // ── Network (P2P) initial state ───────────────────────────
  isNetworkActive: false,
  networkRole: null,
  // PeerId MUST be unique per browser tab — if we use localStorage, all tabs
  // in the same browser will share the same peerId, which collides on the
  // signaling server (peerSockets map overwrites itself) and breaks host/
  // player discovery. Use sessionStorage instead so each tab gets its own.
  networkMyPeerId: (() => {
    if (typeof window === 'undefined') return null;
    try {
      // sessionStorage is per-tab — perfect for peerId
      let id = sessionStorage.getItem('fate-peer-id');
      if (!id) {
        id = `peer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        sessionStorage.setItem('fate-peer-id', id);
      }
      return id;
    } catch { return null; }
  })(),
  networkMyDisplayName: (() => {
    if (typeof window === 'undefined') return 'Игрок';
    try {
      return localStorage.getItem('fate-display-name') || 'Игрок';
    } catch { return 'Игрок'; }
  })(),
  networkRoomId: null,
  networkPeers: {},
  playerAssignments: {},
  networkHostOnline: false,
  networkSignalingStatus: 'offline',
  peerLatencies: {},
  peerLastSeen: {},
  peerCursors: {},
  syncRollState: null,
  massRollState: null,

  // ── Live Roll Stage Overlay initial state ──────────────────
  liveRollStage: null,
  liveRollQueue: [],
  liveRollSeenIds: [],
  liveRollExiting: false,
  // ВАЖНО: начальное значение — РАЗНЫЕ грани (+, −, пусто, +), а не все пустые.
  // Раньше было [0,0,0,0] — кейс при первой загрузке показывал 4 пустых куба,
  // что выглядело уныло. Теперь кейс сразу показывает «живые» кубы с разными
  // гранями — красивее и понятнее для пользователя. После первого броска
  // значение заменяется реальным результатом.
  lastDiceResult: [1, -1, 0, 1],
  theatricalMode: (() => {
    if (typeof window === 'undefined') return true;
    try {
      const v = localStorage.getItem('fate-theatrical-mode');
      // Default ON; only OFF if explicitly set to '0' / 'false'.
      return v === null ? true : v !== '0' && v !== 'false';
    } catch { return true; }
  })(),
  theatricalDurationMs: (() => {
    if (typeof window === 'undefined') return 3500;
    try {
      const v = Number(localStorage.getItem('fate-theatrical-duration'));
      if (Number.isFinite(v) && v >= 1500 && v <= 6000) return v;
      return 3500;
    } catch { return 3500; }
  })(),
  diceMode: (() => {
    if (typeof window === 'undefined') return '3d' as const;
    try {
      const v = localStorage.getItem('fate-dice-mode');
      // Default 3D (physics); only '2d' explicitly opts out.
      return v === '2d' ? '2d' : '3d';
    } catch { return '3d' as const; }
  })(),
  diceColor: (() => {
    if (typeof window === 'undefined') return '#1976d2';
    try {
      const v = localStorage.getItem('fate-dice-color');
      // Validate hex format; default to classic blue if invalid.
      if (v && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v;
      return '#1976d2';
    } catch { return '#1976d2'; }
  })(),
  symbolColor: (() => {
    if (typeof window === 'undefined') return '#f8fafc';
    try {
      const v = localStorage.getItem('fate-symbol-color');
      if (v && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) return v;
      return '#f8fafc';
    } catch { return '#f8fafc'; }
  })(),
  // Per-peer dice colors map — populated as players announce via presence.
  // Empty initially; the host's own entry is added when network starts.
  peerDiceColors: {},

  isLoading: false,

  // ── Adventures ─────────────────────────────────────────────
  loadAdventures: async () => {
    set({ isLoading: true });
    try {
      const data = await apiGet<Adventure[]>('/api/adventures');
      set({ adventures: data });
    } finally {
      set({ isLoading: false });
    }
  },

  createAdventure: async (name: string) => {
    const adventure = await apiPost<Adventure>('/api/adventures', { name });
    set((s) => ({ adventures: [...s.adventures, adventure] }));
  },

  deleteAdventure: async (id: string) => {
    await apiDelete('/api/adventures', { id });
    const state = get();
    const isSelected = state.currentAdventureId === id;
    // Clear the persisted adventure id if we're deleting the active one so
    // a subsequent page refresh doesn't try to restore a deleted adventure.
    if (isSelected) {
      try { localStorage.removeItem('fate-current-adventure'); } catch {}
    }
    set((s) => ({
      adventures: s.adventures.filter((a) => a.id !== id),
      ...(isSelected
        ? {
            currentAdventureId: null,
            currentSceneId: null,
            characters: [],
            scenes: [],
            logEntries: [],
            items: [],
            folders: [],
            notes: [],
            settings: { ...DEFAULT_SETTINGS },
            magicModuleEnabled: false,
            magicTable: [],
          }
        : {}),
    }));
  },

  switchAdventure: async (id: string) => {
    // Persist currentAdventureId to localStorage so a page refresh restores
    // the same session instead of dropping the user back to the welcome screen.
    try { localStorage.setItem('fate-current-adventure', id); } catch {}
    // Preserve the adventure's saved currentSceneId so scene/floor selection
    // survives across reloads. Will be refined after scenes are loaded.
    const adv = get().adventures.find((a) => a.id === id);
    const savedSceneId = adv?.currentSceneId ?? null;
    set({ currentAdventureId: id, currentSceneId: savedSceneId, currentFloorIndex: 0 });
    // Load all adventure data in parallel
    const adventure = get().adventures.find((a) => a.id === id);
    if (adventure) {
      // Load settings from the adventure — deep-merge initiative to preserve mode default
      const adventureSettings = adventure.settings ?? { ...DEFAULT_SETTINGS };
      const mergedInitiative = {
        ...DEFAULT_SETTINGS.initiative,
        ...(adventureSettings.initiative ?? {}),
      };
      set({
        settings: { ...DEFAULT_SETTINGS, ...adventureSettings, initiative: mergedInitiative },
        magicModuleEnabled: adventureSettings.modules?.magic ?? adventureSettings.magicModuleEnabled ?? false,
        // Load magic table from adventure settings (database), fall back to localStorage
        magicTable: adventureSettings.magicTable?.length
          ? adventureSettings.magicTable
          : (() => {
              try {
                const stored = localStorage.getItem('fate-magic-table');
                return stored ? JSON.parse(stored) : [];
              } catch { return []; }
            })(),
      });
      // Load related data concurrently
      const state = get();
      await Promise.all([
        state.loadCharacters(id),
        state.loadScenes(id),
        state.loadLogEntries(id),
        state.loadItems(id),
        state.loadFolders(id),
        state.loadNotes(id),
      ]);
      // After scenes are loaded, restore the saved currentSceneId (if it still
      // exists) and the saved currentFloorIndex from that scene.
      const scenesNow = get().scenes;
      if (savedSceneId && scenesNow.some((s) => s.id === savedSceneId)) {
        const scene = scenesNow.find((s) => s.id === savedSceneId);
        set({
          currentSceneId: savedSceneId,
          currentFloorIndex: scene?.currentFloorIndex ?? 0,
        });
      }
    }
  },

  exportAdventure: async () => {
    const adventureId = get().currentAdventureId;
    if (!adventureId) {
      throw new Error('No adventure selected');
    }
    // Fetch the full export payload (adventure + all related entities)
    const payload = await apiGet<Record<string, unknown>>('/api/adventures/export', { id: adventureId });
    const adventure = (payload.adventure as { name?: string } | undefined) ?? undefined;
    const adventureName = adventure?.name ?? 'adventure';
    const date = new Date().toISOString().slice(0, 10);
    const filename = `${adventureName}-export-${date}.json`;

    // Trigger a client-side file download via Blob + anchor click
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  importAdventure: async (file: File) => {
    const text = await file.text();
    const data = JSON.parse(text) as unknown;
    await apiPost('/api/adventures/import', data);
    // Refresh adventures list so the imported one appears
    await get().loadAdventures();
  },

  transferAdventure: async (sourceAdventureId, targetAdventureId, transfer) => {
    const result = await apiPost<{
      success: boolean;
      counts: { characters: number; scenes: number; items: number; folders: number; notes: number; settings: boolean; modules: boolean };
    }>('/api/adventures/transfer', { sourceAdventureId, targetAdventureId, transfer });
    // If the target is the currently-loaded adventure, reload its data so the
    // newly-transferred entities appear immediately.
    if (get().currentAdventureId === targetAdventureId) {
      await get().switchAdventure(targetAdventureId);
    } else {
      // Still refresh the adventures list so counts update
      await get().loadAdventures();
    }
    return result.counts;
  },

  // ── Characters ─────────────────────────────────────────────
  loadCharacters: async (adventureId: string) => {
    try {
      const data = await apiGet<Character[]>('/api/characters', { adventureId });
      set({ characters: data });
    } catch {
      // Silently fail — the data may not exist yet
    }
  },

  createCharacter: async (data: Partial<Character>) => {
    const character = await apiPost<Character>('/api/characters', data);
    set((s) => ({ characters: [...s.characters, character] }));
    return character;
  },

  updateCharacter: async (id: string, data: Partial<Character>) => {
    // ── LATENCY FIX: broadcast FIRST, persist in background ──
    // (аналогично updateScene — см. комментарии там)
    if (!_suppressCharacterBroadcast && _broadcastCharacterUpdateFn) {
      try {
        _broadcastCharacterUpdateFn(id, data);
      } catch (e) {
        console.warn('[store] broadcastCharacterUpdate failed:', e);
      }
    }

    if (_suppressCharacterBroadcast) {
      // Remote-apply: merge в local state БЕЗ API call.
      set((s) => ({
        characters: s.characters.map((c) =>
          c.id === id ? ({ ...c, ...data } as Character) : c,
        ),
      }));
    } else {
      const updated = await apiPut<Character>(`/api/characters?id=${id}`, data);
      set((s) => ({
        characters: s.characters.map((c) => (c.id === id ? updated : c)),
      }));
    }
  },

  deleteCharacter: async (id: string) => {
    await apiDelete('/api/characters', { id });
    set((s) => ({ characters: s.characters.filter((c) => c.id !== id) }));
  },

  // ── Scenes ────────────────────────────────────────────────
  loadScenes: async (adventureId: string) => {
    try {
      const data = await apiGet<Scene[]>('/api/scenes', { adventureId });
      set({ scenes: data });
      // Auto-select first scene if none selected
      if (data.length > 0 && !get().currentSceneId) {
        set({ currentSceneId: data[0].id });
      }
    } catch {
      // Silently fail
    }
  },

  createScene: async (name: string) => {
    const adventureId = get().currentAdventureId;
    if (!adventureId) return;
    const scene = await apiPost<Scene>('/api/scenes', { name, adventureId });
    set((s) => ({ scenes: [...s.scenes, scene] }));
  },

  deleteScene: async (id: string) => {
    await apiDelete('/api/scenes', { id });
    const state = get();
    const isSelected = state.currentSceneId === id;
    const remaining = state.scenes.filter((s) => s.id !== id);
    set({
      scenes: remaining,
      ...(isSelected ? { currentSceneId: remaining[0]?.id ?? null } : {}),
    });
  },

  switchScene: async (id: string) => {
    set({ currentSceneId: id });
    // Persist the new scene selection on the adventure so it survives reloads.
    // Fire-and-forget — no need to block the UI switch on the API call.
    const adventureId = get().currentAdventureId;
    if (adventureId) {
      // Reset floor index to the scene's saved value (if any) for consistency
      const scene = get().scenes.find((s) => s.id === id);
      if (scene) {
        set({ currentFloorIndex: scene.currentFloorIndex ?? 0 });
      }
      apiPut(`/api/adventures?id=${adventureId}`, { currentSceneId: id }).catch(() => {
        // Silent — best-effort persistence
      });
    }
  },

  updateScene: async (id: string, data: Partial<Scene>) => {
    // ── LATENCY FIX: broadcast FIRST, persist in background ──
    // Раньше: await apiPut → set → broadcast. Каждое обновление сцены
    // (token move, drawing, zone, fog edit) ЖДАЛО HTTP round-trip к БД
    // (20-80ms на localhost, больше по сети) прежде чем отправиться пирам.
    // Это было главной причиной "невероятных лагов даже на localhost".
    //
    // Теперь: broadcast идёт СРАЗУ (fire-and-forget через DataChannel),
    // DB-персистенс — в фоне. Peers видят обновление за ~0ms (DataChannel
    // latency), а не за apiPut-latency + 50ms coalescing.
    //
    // ── SUPPRESS FLAG = REMOTE APPLY ──
    // Когда _suppressSceneBroadcast=true — мы ПРИМЕНЯЕМ remote-действие
    // (полученное через P2P от host/другого игрока). В этом случае:
    //   1. НЕ делаем HTTP PUT (originator уже персистит в БД — redundant).
    //   2. НЕ broadcastим (suppressed — avoids infinite echo).
    //   3. Только обновляем local state (merge data в existing scene).
    if (!_suppressSceneBroadcast && _broadcastSceneUpdateFn) {
      try {
        _broadcastSceneUpdateFn(id, data);
      } catch (e) {
        console.warn('[store] broadcastSceneUpdate failed:', e);
      }
    }

    if (_suppressSceneBroadcast) {
      // Remote-apply: merge data в local state БЕЗ API call.
      // Originator уже персистит в БД; мы только обновляем UI.
      set((s) => ({
        scenes: s.scenes.map((sc) =>
          sc.id === id ? ({ ...sc, ...data } as Scene) : sc,
        ),
      }));
    } else {
      // Local action: persist to DB + update local state с canonical scene.
      const updated = await apiPut<Scene>(`/api/scenes?id=${id}`, data);
      set((s) => ({
        scenes: s.scenes.map((sc) => (sc.id === id ? updated : sc)),
      }));
    }
  },

  addCharacterToScene: async (characterId: string) => {
    const scene = get().getCurrentScene();
    if (!scene) return;
    const char = get().characters.find((c) => c.id === characterId);
    if (!char) return;

    if (char.type === 'player') {
      // PCs go into the persistent player roster — visible across all scenes
      const roster = get().settings.playerRoster ?? [];
      if (!roster.includes(characterId)) {
        await get().updateSettings({ playerRoster: [...roster, characterId] });
      }
    } else {
      // NPCs are bound to the current scene
      if (scene.presentCharacters.includes(characterId)) return;
      const updatedPresent = [...scene.presentCharacters, characterId];
      await get().updateScene(scene.id, { presentCharacters: updatedPresent });
    }
  },

  addTokenToMap: async (characterId: string) => {
    const scene = get().getCurrentScene();
    if (!scene) return;
    const floorIdx = get().currentFloorIndex;
    const updatedFloors = [...scene.floors];
    if (updatedFloors[floorIdx]) {
      const floor = { ...updatedFloors[floorIdx] };
      const alreadyHasToken = floor.tokens.some((t) => t.charId === characterId);
      if (!alreadyHasToken) {
        // Place token at a random position near center
        const cx = 200 + Math.random() * 200;
        const cy = 200 + Math.random() * 200;
        floor.tokens = [...floor.tokens, { charId: characterId, x: cx, y: cy }];
        updatedFloors[floorIdx] = floor;
        await get().updateScene(scene.id, { floors: updatedFloors });
      }
    }
    // Also ensure the character is in the left panel (roster for PCs, presentCharacters for NPCs)
    await get().addCharacterToScene(characterId);
  },

  addTokenToMapAt: async (characterId: string, x: number, y: number) => {
    const scene = get().getCurrentScene();
    if (!scene) return;
    const floorIdx = get().currentFloorIndex;
    const updatedFloors = [...scene.floors];
    if (updatedFloors[floorIdx]) {
      const floor = { ...updatedFloors[floorIdx] };
      // Remove any existing token for this character on this floor (move it instead of duplicating)
      const existingTokens = floor.tokens.filter((t) => t.charId !== characterId);
      floor.tokens = [...existingTokens, { charId: characterId, x, y }];
      updatedFloors[floorIdx] = floor;
      await get().updateScene(scene.id, { floors: updatedFloors });
    }
    // Also ensure the character is in the left panel
    await get().addCharacterToScene(characterId);
  },

  removeTokenFromMap: async (characterId: string) => {
    const scene = get().getCurrentScene();
    if (!scene) return;
    const updatedFloors = scene.floors.map((floor) => ({
      ...floor,
      tokens: floor.tokens.filter((t) => t.charId !== characterId),
    }));
    await get().updateScene(scene.id, { floors: updatedFloors });
    // If in conflict, remove from conflict too
    if (scene.conflictData) {
      await get().removeParticipantFromConflict(characterId);
    }
  },

  removeCharacterFromScene: async (characterId: string) => {
    const scene = get().getCurrentScene();
    if (!scene) return;
    const char = get().characters.find((c) => c.id === characterId);

    if (char?.type === 'player') {
      // Removing a PC from the scene removes them from the roster (all scenes)
      // and also removes their tokens from ALL scenes
      const roster = get().settings.playerRoster ?? [];
      await get().updateSettings({ playerRoster: roster.filter((id) => id !== characterId) });
      // Remove tokens from all scenes
      const updatedScenes = get().scenes.map((sc) => ({
        ...sc,
        floors: sc.floors.map((floor) => ({
          ...floor,
          tokens: floor.tokens.filter((t) => t.charId !== characterId),
        })),
      }));
      // Persist each scene that had tokens removed
      await Promise.all(updatedScenes
        .filter((sc) => sc.id !== scene.id || scene.presentCharacters.includes(characterId))
        .map((sc) => get().updateScene(sc.id, { floors: sc.floors })));
      // Also remove from current scene's presentCharacters (in case they were there too)
      if (scene.presentCharacters.includes(characterId)) {
        await get().updateScene(scene.id, {
          presentCharacters: scene.presentCharacters.filter((id) => id !== characterId),
        });
      }
    } else {
      // NPC: only remove from current scene
      const updatedPresent = scene.presentCharacters.filter((id) => id !== characterId);
      const updatedFloors = scene.floors.map((floor) => ({
        ...floor,
        tokens: floor.tokens.filter((t) => t.charId !== characterId),
      }));
      await get().updateScene(scene.id, { presentCharacters: updatedPresent, floors: updatedFloors });
    }
    // If in conflict, remove from conflict too
    if (scene.conflictData) {
      await get().removeParticipantFromConflict(characterId);
    }
  },

  // ── Log ────────────────────────────────────────────────────
  loadLogEntries: async (adventureId: string) => {
    // Load any pending (locally-stored) entries from previous sessions.
    // These were saved when the server was unreachable.
    const pendingLocal = loadPendingEntries(adventureId);

    let serverEntries: LogEntry[] = [];
    try {
      const data = await apiGet<LogEntry[]>('/api/log', { adventureId });
      serverEntries = data;
      setSyncStatus('online');
    } catch {
      // Server unreachable — work offline with whatever we have.
      setSyncStatus('offline');
    }

    // Merge: server entries first (DESC by createdAt), then any pending local
    // entries that don't have a corresponding server entry yet.
    // Local entries are always newer (in terms of when they were created),
    // so they should appear at the top of the list.
    const localOnly = pendingLocal.filter(
      (le) => !serverEntries.some((se) => se.id === le.id),
    );

    // Sort local entries by createdAt DESC so newest is first.
    localOnly.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));

    set({ logEntries: [...localOnly, ...serverEntries] });

    // Initialize the background sync loop with the current state.
    initSyncLoop({
      onSynced: (localId, serverEntry) => {
        // Replace the local entry with the server-confirmed one.
        set((s) => ({
          logEntries: s.logEntries.map((e) =>
            e.id === localId ? serverEntry : e,
          ),
        }));
        // Remove it from the pending list.
        const advId = get().currentAdventureId;
        if (advId) {
          const stillPending = (get().logEntries as LocalLogEntry[]).filter(
            (e) => isLocalId(e.id),
          );
          persistPendingEntries(advId, stillPending);
        }
      },
      onFailed: (localId, retryCount, nextRetryAt) => {
        // Mark the entry as pending — UI can show a "sync pending" badge.
        set((s) => ({
          logEntries: s.logEntries.map((e) =>
            e.id === localId
              ? { ...e, _pending: true, _retryCount: retryCount, _nextRetryAt: nextRetryAt }
              : e,
          ),
        }));
      },
      getPendingEntries: () => get().logEntries as LocalLogEntry[],
      getAdventureId: () => get().currentAdventureId,
    });
  },

  addLogEntry: async (entry: Partial<LogEntry>) => {
    // OFFLINE-FIRST: never block on the server.
    //
    // 1. Generate a local ID and createdAt right now.
    // 2. Add to state immediately — UI shows the entry instantly.
    // 3. POST to server in the background (fire-and-forget).
    //    - On success → replace local entry with server entry.
    //    - On failure → mark as _pending, the sync loop will retry.
    const adventureId = entry.adventureId ?? get().currentAdventureId ?? '';
    const localEntry: LocalLogEntry = {
      id: genLocalId(),
      adventureId,
      characterId: entry.characterId ?? null,
      characterName: entry.characterName ?? '',
      skillName: entry.skillName ?? '',
      diceResults: entry.diceResults ?? [],
      bonus: entry.bonus ?? 0,
      total: entry.total ?? 0,
      opponentTotal: entry.opponentTotal ?? null,
      difficulty: entry.difficulty ?? null,
      result: entry.result ?? '',
      opponentType: entry.opponentType ?? null,
      opponentCharacterId: entry.opponentCharacterId ?? null,
      opponentName: entry.opponentName ?? null,
      opponentSkillName: entry.opponentSkillName ?? null,
      opponentDiceResults: entry.opponentDiceResults ?? [],
      opponentBonus: entry.opponentBonus ?? 0,
      extraBonus: entry.extraBonus ?? 0,
      extraBonusReason: entry.extraBonusReason ?? '',
      rerolled: entry.rerolled ?? false,
      customText: entry.customText ?? null,
      isRiftEvent: entry.isRiftEvent ?? false,
      createdAt: new Date().toISOString(),
      // Rich-tooltip fields
      skillValue: entry.skillValue ?? null,
      manualBonus: entry.manualBonus ?? 0,
      helpers: entry.helpers ?? [],
      aspectInvokeBonus: entry.aspectInvokeBonus ?? 0,
      aspectInvokeReason: entry.aspectInvokeReason ?? '',
      aspectRerolled: entry.aspectRerolled ?? false,
      opponentSkillValue: entry.opponentSkillValue ?? null,
      opponentManualBonus: entry.opponentManualBonus ?? 0,
      opponentHelpers: entry.opponentHelpers ?? [],
      // Magic module fields
      isMagicRoll: entry.isMagicRoll ?? false,
      magicCastType: entry.magicCastType ?? null,
      magicCardName: entry.magicCardName ?? null,
      magicEffect: entry.magicEffect ?? null,
      magicZoneStress: entry.magicZoneStress ?? null,
      magicZoneName: entry.magicZoneName ?? null,
      magicZoneLevelAfter: entry.magicZoneLevelAfter ?? null,
      // Group roll (P2P)
      groupRollResults: entry.groupRollResults ?? [],
      // Offline-sync meta
      _pending: false,
      _syncing: false,
      _retryCount: 0,
    };

    // Add to state immediately (prepend — logEntries is DESC by createdAt).
    set((s) => ({ logEntries: [localEntry, ...s.logEntries] }));

    // Persist to localStorage immediately so it survives a refresh.
    const advId = get().currentAdventureId;
    if (advId) {
      const pending = (get().logEntries as LocalLogEntry[]).filter((e) => isLocalId(e.id));
      persistPendingEntries(advId, pending);
    }

    // Fire-and-forget POST. We do NOT await this — the function has already
    // returned successfully to the caller (the roll UI).
    postLocalEntry(localEntry)
      .then((serverEntry) => {
        // Replace local entry with server-confirmed one.
        set((s) => ({
          logEntries: s.logEntries.map((e) =>
            e.id === localEntry.id ? serverEntry : e,
          ),
        }));
        // Remove from pending list.
        const currentAdvId = get().currentAdventureId;
        if (currentAdvId) {
          const stillPending = (get().logEntries as LocalLogEntry[]).filter(
            (e) => isLocalId(e.id),
          );
          persistPendingEntries(currentAdvId, stillPending);
        }
        setSyncStatus('online');
      })
      .catch(() => {
        // Mark as pending — the sync loop will retry.
        set((s) => ({
          logEntries: s.logEntries.map((e) =>
            e.id === localEntry.id
              ? { ...e, _pending: true, _retryCount: 1, _nextRetryAt: Date.now() + 5_000 }
              : e,
          ),
        }));
        setSyncStatus('offline');
        // Persist the updated pending list.
        const currentAdvId = get().currentAdventureId;
        if (currentAdvId) {
          const pending = (get().logEntries as LocalLogEntry[]).filter((e) => isLocalId(e.id));
          persistPendingEntries(currentAdvId, pending);
        }
      });

    // Return the local entry ID so callers can track the just-created log
    // entry (e.g. to apply aspect invoke / reroll to it immediately after
    // the roll completes).
    //
    // ── Network broadcast ──
    // Push the freshly-created entry to connected peers so it appears in
    // their log panel too. The broadcaster is a no-op when the network is
    // inactive (offline mode) or useNetwork hasn't mounted yet. Peers
    // receive it via addRemoteLogEntry which does NOT re-POST (avoiding
    // server duplicates) and does NOT re-broadcast (avoiding loops).
    try {
      _broadcastLogEntryFn?.(localEntry);
    } catch (e) {
      console.warn('[store] broadcastLogEntry failed:', e);
    }
    return localEntry.id;
  },

  addRemoteLogEntry: (entry) => {
    // Add a log entry that came from a remote peer over the network.
    // CRITICAL: do NOT POST to the server (the originator already did) and
    // do NOT call _broadcastLogEntryFn (would create an infinite loop).
    // Also dedupe by id — if the entry already exists locally (e.g. the
    // host's own roll echoing back from a re-broadcast), silently skip.
    const existing = get().logEntries.find((e) => e.id === entry.id);
    if (existing) return;

    // Prepend (logEntries is DESC by createdAt). Mark as remote so the UI
    // can optionally distinguish local vs remote rolls.
    set((s) => ({ logEntries: [entry, ...s.logEntries] }));

    // Persist to localStorage so it survives a refresh — but ONLY into the
    // pending list if it has a local id (remote entries from the server
    // already have server ids and will be fetched on next load). For remote
    // local-id entries (player hasn't synced to server yet), we persist so
    // they don't vanish on refresh.
    const advId = get().currentAdventureId;
    if (advId && isLocalId(entry.id)) {
      const pending = (get().logEntries as LocalLogEntry[]).filter((e) => isLocalId(e.id));
      persistPendingEntries(advId, pending);
    }
  },

  updateLogEntry: async (id: string, updates: Partial<LogEntry>) => {
    // OFFLINE-FIRST: update local state immediately, fire PATCH in background.
    //
    // Two cases:
    // 1. id is a local ID (entry not yet synced): just update the local
    //    state and the pending localStorage copy. The POST retry will
    //    pick up the updated fields automatically.
    // 2. id is a server ID: update local state, fire PATCH. If PATCH
    //    fails, queue for retry.

    set((s) => ({
      logEntries: s.logEntries.map((e) =>
        e.id === id ? { ...e, ...updates } : e,
      ),
    }));

    if (isLocalId(id)) {
      // Entry not yet on server — persist updated pending list.
      const advId = get().currentAdventureId;
      if (advId) {
        const pending = (get().logEntries as LocalLogEntry[]).filter((e) => isLocalId(e.id));
        persistPendingEntries(advId, pending);
      }
      return;
    }

    // Server-confirmed entry — fire PATCH in background.
    offlinePatchEntry(id, updates)
      .then((updated) => {
        // Replace with server-confirmed version (in case server transformed anything).
        set((s) => ({
          logEntries: s.logEntries.map((e) =>
            e.id === id ? { ...e, ...updated } : e,
          ),
        }));
        setSyncStatus('online');
      })
      .catch(() => {
        // PATCH failed — entry is still updated locally, but the server
        // doesn't know about it yet. The next time the entry is loaded
        // (page refresh), it will get the server version. For now we
        // just log the failure silently — the user already sees their
        // change in the UI.
        setSyncStatus('offline');
      });
  },

  rerollLogEntry: async (entryId: string, target: 'attacker' | 'defender', opts?: { isFree?: boolean }) => {
    const entry = get().logEntries.find((e) => e.id === entryId);
    if (!entry) return;

    const newDice = rollFateDice();
    const newDiceTotal = sumFateDice(newDice);

    if (target === 'attacker') {
      // Reroll the attacker's dice — bonus stays the same, total recalculated
      const newTotal = newDiceTotal + entry.bonus + entry.extraBonus + (entry.aspectInvokeBonus ?? 0);
      const { getRollResult } = await import('@/lib/fate-dice');
      const resultObj = getRollResult(newTotal, entry.difficulty, entry.opponentTotal);
      const patch: Partial<LogEntry> = {
        diceResults: newDice,
        total: newTotal,
        result: resultObj.label,
        rerolled: true,
        aspectRerolled: true,
      };
      // Бесплатный призыв: считаем, сколько free-invoke применено (для лога).
      if (opts?.isFree) {
        patch.aspectFreeInvokeCount = (entry.aspectFreeInvokeCount ?? 0) + 1;
      }
      await get().updateLogEntry(entryId, patch);
    } else {
      // Reroll the defender's dice — defender bonus stays the same
      const newOpponentTotal = newDiceTotal + entry.opponentBonus;
      const { getRollResult } = await import('@/lib/fate-dice');
      const resultObj = getRollResult(entry.total, entry.difficulty, newOpponentTotal);
      await get().updateLogEntry(entryId, {
        opponentDiceResults: newDice,
        opponentTotal: newOpponentTotal,
        result: resultObj.label,
        rerolled: true,
        aspectRerolled: true,
      });
    }
  },

  addBonusToLogEntry: async (entryId: string, target: 'attacker' | 'defender', bonus: number, reason: string, opts?: { isFree?: boolean }) => {
    const entry = get().logEntries.find((e) => e.id === entryId);
    if (!entry) return;

    if (target === 'attacker') {
      // This is an aspect invoke bonus — store separately from the manual bonus
      const newAspectBonus = (entry.aspectInvokeBonus ?? 0) + bonus;
      const newTotal = entry.diceResults.reduce((s, d) => s + d, 0) + entry.bonus + (entry.manualBonus ?? 0) + newAspectBonus;
      const { getRollResult } = await import('@/lib/fate-dice');
      const resultObj = getRollResult(newTotal, entry.difficulty, entry.opponentTotal);
      const newReason = entry.aspectInvokeReason
        ? `${entry.aspectInvokeReason}, ${reason}`
        : reason;
      const patch: Partial<LogEntry> = {
        aspectInvokeBonus: newAspectBonus,
        aspectInvokeReason: newReason,
        total: newTotal,
        result: resultObj.label,
      };
      // Бесплатный призыв: считаем, сколько free-invoke применено (для лога).
      // Сам +2 применяется одинаково — отличие только в отсутствии траты ОС.
      if (opts?.isFree) {
        patch.aspectFreeInvokeCount = (entry.aspectFreeInvokeCount ?? 0) + 1;
      }
      await get().updateLogEntry(entryId, patch);
    } else {
      const newOpponentBonus = entry.opponentBonus + bonus;
      const newOpponentTotal = entry.opponentDiceResults.reduce((s, d) => s + d, 0) + newOpponentBonus;
      const { getRollResult } = await import('@/lib/fate-dice');
      const resultObj = getRollResult(entry.total, entry.difficulty, newOpponentTotal);
      await get().updateLogEntry(entryId, {
        opponentBonus: newOpponentBonus,
        opponentTotal: newOpponentTotal,
        result: resultObj.label,
      });
    }
  },

  clearLog: async () => {
    const adventureId = get().currentAdventureId;
    if (!adventureId) return;
    await apiDelete('/api/log', { adventureId });
    set({ logEntries: [] });
  },

  // ── Items ──────────────────────────────────────────────────
  loadItems: async (adventureId: string) => {
    try {
      const data = await apiGet<Item[]>('/api/items', { adventureId });
      set({ items: data });
    } catch {
      // Silently fail
    }
  },

  createItem: async (data: Partial<Item>) => {
    const item = await apiPost<Item>('/api/items', data);
    set((s) => ({ items: [...s.items, item] }));
  },

  updateItem: async (id: string, data: Partial<Item>) => {
    const updated = await apiPut<Item>(`/api/items?id=${id}`, data);
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? updated : i)),
    }));
  },

  deleteItem: async (id: string) => {
    await apiDelete('/api/items', { id });
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },

  // ── Folders ──────────────────────────────────────────────────
  loadFolders: async (adventureId: string) => {
    try {
      const data = await apiGet<Folder[]>('/api/folders', { adventureId });
      set({ folders: data });
    } catch {
      // Silently fail
    }
  },

  createFolder: async (data: Partial<Folder>) => {
    const folder = await apiPost<Folder>('/api/folders', data);
    set((s) => ({ folders: [...s.folders, folder] }));
  },

  updateFolder: async (id: string, data: Partial<Folder>) => {
    const updated = await apiPut<Folder>(`/api/folders?id=${id}`, data);
    set((s) => ({
      folders: s.folders.map((f) => (f.id === id ? updated : f)),
    }));
  },

  deleteFolder: async (id: string) => {
    await apiDelete('/api/folders', { id });
    // Clear folderId on all characters that were in this folder
    set((s) => ({
      folders: s.folders.filter((f) => f.id !== id),
      characters: s.characters.map((c) =>
        c.folderId === id ? { ...c, folderId: null } : c,
      ),
    }));
  },

  // ── Notes ──────────────────────────────────────────────────
  loadNotes: async (adventureId: string) => {
    try {
      const data = await apiGet<Note[]>('/api/notes', { adventureId });
      set({ notes: data });
    } catch {
      // Silently fail
    }
  },

  createNote: async (data: Partial<Note>) => {
    const note = await apiPost<Note>('/api/notes', data);
    set((s) => ({ notes: [note, ...s.notes] }));
  },

  updateNote: async (id: string, data: Partial<Note>) => {
    const updated = await apiPut<Note>(`/api/notes?id=${id}`, data);
    set((s) => ({
      notes: s.notes.map((n) => (n.id === id ? updated : n)),
    }));
  },

  deleteNote: async (id: string) => {
    await apiDelete('/api/notes', { id });
    set((s) => ({ notes: s.notes.filter((n) => n.id !== id) }));
  },

  // ── Settings ──────────────────────────────────────────────
  updateSettings: async (settings: Partial<AdventureSettings>) => {
    const adventureId = get().currentAdventureId;
    if (!adventureId) return;
    await apiPut(`/api/adventures?id=${adventureId}`, { settings });
    // Derive magicModuleEnabled from settings.modules.magic if provided,
    // otherwise fall back to settings.magicModuleEnabled, then current state.
    const magicEnabled = settings.modules?.magic ?? settings.magicModuleEnabled;
    set((s) => ({
      settings: { ...s.settings, ...settings },
      magicModuleEnabled: magicEnabled ?? s.magicModuleEnabled,
    }));
  },

  // ── Magic ──────────────────────────────────────────────────
  loadMagicTable: (entries: MagicTableEntry[]) => {
    set({ magicTable: entries });
    // Persist to localStorage for quick reload
    try { localStorage.setItem('fate-magic-table', JSON.stringify(entries)); } catch {}
    // Also persist to the adventure settings in the database
    const adventureId = get().currentAdventureId;
    if (adventureId) {
      get().updateSettings({ magicTable: entries });
    }
  },

  performMagicRoll: async (castType: 'normal' | 'dangerous', casterId?: string | null) => {
    const { magicTable, currentAdventureId, characters } = get();

    // If the table is empty, return a null result
    if (magicTable.length === 0) {
      return { roll: 0, entry: null, castType };
    }

    // Pick a random card from the table
    let entry: MagicTableEntry | null;
    let roll: number;

    if (castType === 'dangerous') {
      const dangerousEntries = magicTable.filter((e) => e.zoneStress !== undefined && e.zoneStress >= 1);
      if (dangerousEntries.length > 0) {
        entry = dangerousEntries[Math.floor(Math.random() * dangerousEntries.length)];
      } else {
        const startIdx = Math.floor(magicTable.length / 2);
        entry = magicTable[startIdx + Math.floor(Math.random() * (magicTable.length - startIdx))] ?? null;
      }
    } else {
      entry = magicTable[Math.floor(Math.random() * magicTable.length)] ?? null;
    }

    roll = magicTable.indexOf(entry!) + 1;
    if (roll === 0) roll = Math.floor(Math.random() * magicTable.length) + 1;

    // Resolve caster name and zone
    const casterName = casterId ? (characters.find((c) => c.id === casterId)?.name ?? null) : null;
    const zone = casterId ? get().getZoneForCharacter(casterId) : null;
    const zoneName = zone?.name ?? null;

    // Build custom text (compact summary line for CSV / fallback display)
    const castLabel = castType === 'normal' ? 'Обычный каст' : 'Опасный каст';
    let customText = `🔮 ${castLabel}: ${roll}`;
    if (casterName) customText = `🔮 ${casterName} — ${castLabel}: ${roll}`;
    if (entry) {
      customText += ` — ${entry.name}`;
      if (entry.zoneStress !== undefined) {
        customText += ` (Стресс ${entry.zoneStress > 0 ? '+' : ''}${entry.zoneStress})`;
      }
    }
    if (zoneName) {
      customText += ` | Зона: ${zoneName}`;
    }

    // Apply zone stress FIRST so we know the resulting rift level
    let zoneStressApplied: number | undefined;
    let newZoneLevel: number | undefined;

    if (zone && entry?.zoneStress !== undefined && entry.zoneStress !== 0) {
      const stressResult = await get().applyMagicZoneStress(zone.id, entry.zoneStress, casterName ?? undefined);
      zoneStressApplied = entry.zoneStress;
      newZoneLevel = stressResult.newLevel;
    }

    // Result string (kept for CSV/JSON export + backward-compat rendering)
    const resultStr = entry
      ? `${entry.name}${entry.zoneStress !== undefined ? ` (Стресс ${entry.zoneStress > 0 ? '+' : ''}${entry.zoneStress})` : ''}: ${entry.effect}`
      : `Карта #${roll} — не найдена`;

    // Log the magic roll — populate structured magic fields so the log panel
    // can render a proper "effect card" with name + effect text + zone info.
    await get().addLogEntry({
      adventureId: currentAdventureId ?? undefined,
      characterId: casterId ?? null,
      characterName: casterName ? `🔮 ${casterName}` : '🔮 Магия',
      skillName: castLabel,
      diceResults: [roll],
      bonus: 0,
      total: roll,
      opponentTotal: null,
      difficulty: null,
      result: resultStr,
      opponentType: null,
      opponentCharacterId: null,
      opponentName: null,
      opponentSkillName: null,
      opponentDiceResults: [],
      opponentBonus: 0,
      extraBonus: 0,
      extraBonusReason: '',
      rerolled: false,
      customText,
      isRiftEvent: false,
      // ── Magic module fields ──
      isMagicRoll: true,
      magicCastType: castType,
      magicCardName: entry?.name ?? null,
      magicEffect: entry?.effect ?? null,
      magicZoneStress: entry?.zoneStress ?? null,
      magicZoneName: zoneName,
      magicZoneLevelAfter: newZoneLevel ?? null,
    });

    return { roll, entry, castType, zoneName: zoneName ?? undefined, zoneStressApplied, newZoneLevel };
  },

  // ── Find the zone a character's token is in ───────────────
  getZoneForCharacter: (charId: string): Zone | null => {
    const scene = get().getCurrentScene();
    if (!scene) return null;

    // Search all floors for the token
    for (const floor of scene.floors) {
      const token = floor.tokens.find((t) => t.charId === charId);
      if (!token) continue;

      // Check which zone the token is in on this floor
      for (let i = floor.zones.length - 1; i >= 0; i--) {
        const z = floor.zones[i];
        if (z.vertices && z.vertices.length >= 3) {
          if (pointInPolygon(token.x, token.y, z.vertices)) return z;
        } else {
          if (token.x >= z.x && token.x <= z.x + z.width && token.y >= z.y && token.y <= z.y + z.height) return z;
        }
      }
      return null;
    }
    return null;
  },

  // ── Apply magic stress to a zone and handle level-up ────────
  // Mechanic (per design spec):
  //   • Each zone has 4 levels (0–3) and a *linear* 5-slot stress track.
  //   • Stress belongs to the CURRENT level only.
  //   • When the 6th stress would be applied (filled > 5), the zone
  //     levels up by 1, the stress track is RESET to 0, and any
  //     excess beyond 5 is lost (NOT carried over).
  //   • Stress can be decreased (negative delta) — only the current
  //     level's stress changes; the level NEVER decreases automatically.
  //   • Level is capped at 3. At level 3, further overflow also resets
  //     stress to 0 (the zone is already at maximum catastrophe).
  applyMagicZoneStress: async (zoneId: string, stressDelta: number, casterName?: string) => {
    const scene = get().getCurrentScene();
    if (!scene) return { newLevel: 0, oldLevel: 0, zoneName: '' };
    const floorIdx = get().currentFloorIndex;
    const floor = scene.floors[floorIdx];
    if (!floor) return { newLevel: 0, oldLevel: 0, zoneName: '' };

    const zone = floor.zones.find((z) => z.id === zoneId);
    if (!zone) return { newLevel: 0, oldLevel: 0, zoneName: '' };

    const oldLevel = zone.level;
    const MAX_LEVEL = 3;
    const STRESS_SLOTS = 5;

    // Always operate on a fixed-length 5-slot track.
    const stress = zone.stress.length === STRESS_SLOTS
      ? [...zone.stress]
      : new Array(STRESS_SLOTS).fill(false);

    let currentLevel = oldLevel;
    let remaining = stressDelta; // can be negative

    if (remaining > 0) {
      // Apply positive stress. While we still have stress to add and
      // there are free slots, fill them. If we run out of slots AND
      // the zone isn't already at max level, level up + reset track
      // (excess beyond 5 is lost — only one level-up per overflow).
      let filled = stress.filter(Boolean).length;
      while (remaining > 0) {
        const freeSlots = STRESS_SLOTS - filled;
        if (remaining <= freeSlots) {
          // Fits in current level — mark from left.
          let toMark = remaining;
          for (let i = 0; i < STRESS_SLOTS && toMark > 0; i++) {
            if (!stress[i]) { stress[i] = true; toMark--; }
          }
          filled += remaining;
          remaining = 0;
        } else {
          // Overflow: fill all remaining slots, then level up.
          // Excess beyond the 5th slot is discarded.
          for (let i = 0; i < STRESS_SLOTS; i++) stress[i] = true;
          filled = STRESS_SLOTS;
          remaining = 0; // excess is lost
          if (currentLevel < MAX_LEVEL) {
            currentLevel += 1;
            // Reset stress track for the new level.
            for (let i = 0; i < STRESS_SLOTS; i++) stress[i] = false;
            filled = 0;
          } else {
            // Already at max level — leave stress filled at 5.
            for (let i = 0; i < STRESS_SLOTS; i++) stress[i] = true;
            filled = STRESS_SLOTS;
          }
        }
      }
    } else if (remaining < 0) {
      // Apply negative stress: unmark from right.
      // Level never decreases automatically.
      let toUnmark = Math.abs(remaining);
      for (let i = STRESS_SLOTS - 1; i >= 0 && toUnmark > 0; i--) {
        if (stress[i]) { stress[i] = false; toUnmark--; }
      }
    }

    const newLevel = currentLevel;

    // Update zone data
    const updatedZones = floor.zones.map((z) =>
      z.id === zoneId ? { ...z, stress, level: newLevel } : z,
    );

    const updatedFloors = scene.floors.map((f, i) =>
      i === floorIdx ? { ...f, zones: updatedZones } : f,
    );

    await get().updateScene(scene.id, { floors: updatedFloors });

    // Handle level-up effects
    if (newLevel > oldLevel) {
      const levelLabels = ['', 'Трещины', 'Разрыв', 'Катастрофа'];
      const levelLabel = levelLabels[newLevel] || `Уровень ${newLevel}`;

      if (newLevel === 1) {
        // Level 1: Mass Will roll for mages in zone
        await get().performMassWillRoll(zoneId);
      }

      if (newLevel >= 2) {
        // Level 2+: Add/update rift aspect (the "⚡ ..." constraint text).
        // Level 3 fully replaces the aspect with a stronger version.
        const riftAspectL2 = '⚡ Безопасный каст больше не спасает от эффектов магии';
        const riftAspectL3 = '⚡ Безопасный каст больше не спасает от эффектов магии, каждая пустая грань, выпавшая при касте заклинания, вызывает эффект';

        const updatedZonesWithRift = updatedFloors[floorIdx].zones.map((z) =>
          z.id === zoneId
            ? {
                ...z,
                riftAspects: newLevel === 3
                  ? [riftAspectL3]
                  : [...(z.riftAspects ?? []).filter((a) => a !== riftAspectL2 && a !== riftAspectL3), riftAspectL2],
              }
            : z,
        );
        const finalFloors = updatedFloors.map((f, i) =>
          i === floorIdx ? { ...f, zones: updatedZonesWithRift } : f,
        );
        await get().updateScene(scene.id, { floors: finalFloors });
      }

      // Dramatic rift log entry — full narrative text from the spec, with
      // the actual zone name interpolated in.
      const riftMessages: string[] = [
        '',
        // Level 1
        `Полотно реальности покрывается трещинами, в которые просачиваются потоки потусторонней энергии, наполняя мысли магов невозможными и безумными видениями. В попытке отгородиться от потока образов из других миров, разум мага стремится полностью отгородиться от контакта с тканью реальности.\nКаждый маг в зоне «${zone.name}» совершает бросок Воли против сложности 2. Провалившие получают аспект «Магическое оглушение» и не могут творить заклинания до конца сцены, или до успешной проверки Воли.`,
        // Level 2
        `Прорехи в ткани реальности увеличиваются, а каждая новая попытка вмешаться в её плетение только усугубляет ситуацию. В зоне «${zone.name}» больше нельзя использовать безопасный каст.`,
        // Level 3
        `Раны на измученном теле реальности безостановочно кровоточат, наполняя окружающее пространство потусторонней энергией. Любая попытка сотворить заклинание здесь может привести к катастрофическим последствиям.\nВ зоне «${zone.name}» эффект от магии вызывается не только сотворением заклинания, но и каждой выпавшей пустой гранью при касте.`,
      ];

      await get().addLogEntry({
        adventureId: get().currentAdventureId ?? undefined,
        characterId: null,
        characterName: '💀 Разрыв',
        skillName: levelLabel,
        diceResults: [],
        bonus: 0,
        total: 0,
        opponentTotal: null,
        difficulty: null,
        result: riftMessages[newLevel] || `Уровень зоны ${zone.name} повышен до ${newLevel}`,
        opponentType: null,
        opponentCharacterId: null,
        opponentName: null,
        opponentSkillName: null,
        opponentDiceResults: [],
        opponentBonus: 0,
        extraBonus: 0,
        extraBonusReason: '',
        rerolled: false,
        customText: riftMessages[newLevel] || '',
        isRiftEvent: true,
      });
    }

    return { newLevel, oldLevel, zoneName: zone.name };
  },

  // ── Mass Will roll for mages in a zone ───────────────────
  // Each mage gets a separate log entry with their dice + total + result.
  // Mages who fail also receive the "Магическое оглушение" situational aspect.
  performMassWillRoll: async (zoneId: string) => {
    const scene = get().getCurrentScene();
    if (!scene) return;
    const { characters, currentAdventureId } = get();
    const floorIdx = get().currentFloorIndex;
    const floor = scene.floors[floorIdx];
    if (!floor) return;

    const zone = floor.zones.find((z) => z.id === zoneId);
    if (!zone) return;

    const tokensInZone = floor.tokens.filter((t) => {
      if (zone.vertices && zone.vertices.length >= 3) {
        return pointInPolygon(t.x, t.y, zone.vertices);
      }
      return t.x >= zone.x && t.x <= zone.x + zone.width && t.y >= zone.y && t.y <= zone.y + zone.height;
    });

    const magesInZone = tokensInZone
      .map((t) => characters.find((c) => c.id === t.charId))
      .filter((c): c is Character => !!c && c.isMage);

    if (magesInZone.length === 0) return;

    // One individual log entry per mage — so every roll (success or fail)
    // is visible in the log and never gets lost in a summary line.
    for (const mage of magesInZone) {
      const willSkill = mage.skills.find((s) => s.name === 'Воля');
      const willValue = willSkill?.value ?? 0;
      const dice = rollFateDice();
      const diceTotal = sumFateDice(dice);
      const total = diceTotal + willValue;
      const success = total >= 2;
      const resultType: RollResultType = success ? 'success' : 'fail';

      if (!success) {
        // Apply "Магическое оглушение" aspect to the character
        const updatedSituational = [...(mage.situationalAspects ?? []), 'Магическое оглушение'];
        await get().updateCharacter(mage.id, { situationalAspects: updatedSituational });
      }

      await get().addLogEntry({
        adventureId: currentAdventureId ?? undefined,
        characterId: mage.id,
        characterName: `⚡ ${mage.name}`,
        skillName: `Воля (зона «${zone.name}»)`,
        diceResults: dice,
        bonus: willValue,
        total,
        opponentTotal: null,
        difficulty: 2,
        result: resultType,
        opponentType: null,
        opponentCharacterId: null,
        opponentName: null,
        opponentSkillName: null,
        opponentDiceResults: [],
        opponentBonus: 0,
        extraBonus: 0,
        extraBonusReason: '',
        rerolled: false,
        skillValue: willValue,
        manualBonus: 0,
        helpers: [],
        customText: success
          ? `⚡ ${mage.name} сопротивляется магическому оглушению в зоне «${zone.name}» — успешно`
          : `⚡ ${mage.name} не выдерживает потока образов — «Магическое оглушение»`,
        isRiftEvent: false,
      });
    }
  },

  // ── Conflict ──────────────────────────────────────────────
  startConflict: async (type: 'physical' | 'mental') => {
    const scene = get().getCurrentScene();
    if (!scene) return;

    const { characters, settings } = get();

    // Only include characters that have a token on the map (any floor)
    const tokenCharIds = new Set(scene.floors.flatMap((f) => f.tokens.map((t) => t.charId)));
    const eligibleIds = new Set([...get().getActiveCharacters().map(c => c.id), ...scene.presentCharacters]);
    const sceneChars = characters.filter((c) =>
      eligibleIds.has(c.id) && tokenCharIds.has(c.id),
    );

    if (sceneChars.length === 0) return;

    // Calculate initiative for each participant
    const participants: ConflictParticipant[] = sceneChars.map((char) => ({
      characterId: char.id,
      initiative: calcInitiativeValue(char, type, settings),
      hasActed: false,
      addedThisRound: false,
    }));

    // Sort by initiative (book mode uses tiebreakers, random mode is simple numeric)
    participants.sort(createInitiativeComparator(characters, type, settings));

    const conflictData: ConflictData = {
      type,
      round: 1,
      participants,
      currentParticipantIndex: 0,
      eliminatedIds: [],
      waitingIds: [],
    };

    // In player mode: auto-skip invisible characters at the start
    const isPlayerMode = get().currentMode === 'player';
    if (isPlayerMode && participants.length > 0) {
      let firstVisibleIdx = -1;
      const markedActed = [...participants];
      for (let i = 0; i < markedActed.length; i++) {
        const char = characters.find((c) => c.id === markedActed[i].characterId);
        if (char?.hiddenFromPlayers) {
          markedActed[i] = { ...markedActed[i], hasActed: true };
          continue;
        }
        firstVisibleIdx = i;
        break;
      }
      // Always apply the hasActed marks for invisible characters
      conflictData.participants = markedActed;
      if (firstVisibleIdx !== -1) {
        conflictData.currentParticipantIndex = firstVisibleIdx;
      } else {
        // All participants are invisible in player mode — this shouldn't happen normally
        // but if it does, keep index 0 (they'll be auto-advanced)
        conflictData.currentParticipantIndex = 0;
      }
    }

    await get().updateScene(scene.id, { conflictData });

    // Log conflict start
    const typeLabel = type === 'physical' ? 'Физический конфликт' : 'Ментальный конфликт';
    await get().addLogEntry({
      adventureId: get().currentAdventureId ?? undefined,
      characterId: null,
      characterName: '⚔️ Конфликт',
      skillName: typeLabel,
      diceResults: [],
      bonus: 0,
      total: 0,
      opponentTotal: null,
      difficulty: null,
      result: `Начат ${typeLabel.toLowerCase()}!`,
      opponentType: null,
      opponentCharacterId: null,
      opponentName: null,
      opponentSkillName: null,
      opponentDiceResults: [],
      opponentBonus: 0,
      extraBonus: 0,
      extraBonusReason: '',
      rerolled: false,
      customText: `⚔️ Начат ${typeLabel.toLowerCase()}! Инициатива: ${participants.map((p) => {
        const c = characters.find((ch) => ch.id === p.characterId);
        // In player mode, don't reveal invisible characters in log
        if (isPlayerMode && c?.hiddenFromPlayers) return null;
        return `${c?.name ?? '?'} (${p.initiative >= 0 ? '+' : ''}${p.initiative})`;
      }).filter(Boolean).join(', ')}`,
      isRiftEvent: false,
    });
  },

  nextTurn: async () => {
    const scene = get().getCurrentScene();
    if (!scene?.conflictData) return;

    const { conflictData } = scene;
    const { participants, currentParticipantIndex, eliminatedIds } = conflictData;
    const waitingIds = conflictData.waitingIds ?? [];
    const { currentMode, characters } = get();
    const isPlayerMode = currentMode === 'player';

    // Mark current participant as having acted
    let updatedParticipants = participants.map((p, idx) =>
      idx === currentParticipantIndex ? { ...p, hasActed: true } : p,
    );

    // Find next active participant (not eliminated, not acted)
    // In player mode, auto-skip invisible characters
    let nextIdx = -1;
    for (let i = 1; i <= updatedParticipants.length; i++) {
      const checkIdx = (currentParticipantIndex + i) % updatedParticipants.length;
      const p = updatedParticipants[checkIdx];
      if (!p.hasActed && !eliminatedIds.includes(p.characterId)) {
        // In player mode, skip invisible characters (auto-act for them)
        if (isPlayerMode) {
          const char = characters.find((c) => c.id === p.characterId);
          if (char?.hiddenFromPlayers) {
            // Mark this invisible character as having acted and continue
            updatedParticipants = updatedParticipants.map((up, idx) =>
              idx === checkIdx ? { ...up, hasActed: true } : up,
            );
            continue;
          }
        }
        nextIdx = checkIdx;
        break;
      }
    }

    if (nextIdx === -1) {
      // All have acted → new round
      // Promote waiting participants into active participants
      const { characters, settings } = get();

      const newParticipants: ConflictParticipant[] = [];
      for (const waitId of waitingIds) {
        const char = characters.find((c) => c.id === waitId);
        if (!char) continue;
        newParticipants.push({
          characterId: char.id,
          initiative: calcInitiativeValue(char, conflictData.type, settings),
          hasActed: false,
          addedThisRound: true,
        });
      }

      // Mark previously addedThisRound as no longer new
      const resetParticipants = updatedParticipants.map((p) => ({
        ...p,
        hasActed: false,
        addedThisRound: false,
      }));

      // Merge: existing + new arrivals
      const allParticipants = [...resetParticipants, ...newParticipants];
      // Re-sort by initiative (book mode uses tiebreakers)
      allParticipants.sort(createInitiativeComparator(characters, conflictData.type, settings));

      const newConflictData: ConflictData = {
        ...conflictData,
        round: conflictData.round + 1,
        participants: allParticipants,
        currentParticipantIndex: 0,
        waitingIds: [],
      };

      // In player mode: if the first participant is invisible, auto-skip
      if (isPlayerMode && allParticipants.length > 0) {
        let firstVisibleIdx = -1;
        const markedActed = [...allParticipants];
        for (let i = 0; i < markedActed.length; i++) {
          const char = characters.find((c) => c.id === markedActed[i].characterId);
          if (char?.hiddenFromPlayers) {
            markedActed[i] = { ...markedActed[i], hasActed: true };
            continue;
          }
          firstVisibleIdx = i;
          break;
        }
        // Always apply hasActed marks
        newConflictData.participants = markedActed;
        if (firstVisibleIdx !== -1) {
          newConflictData.currentParticipantIndex = firstVisibleIdx;
        } else {
          newConflictData.currentParticipantIndex = 0;
        }
      }

      await get().updateScene(scene.id, { conflictData: newConflictData });

      // Log new round
      const roundLabel = conflictData.round + 1;
      let customText = `⚔️ Раунд ${roundLabel}!`;
      if (newParticipants.length > 0) {
        customText += ` Вступили: ${newParticipants.map((p) => {
          const c = characters.find((ch) => ch.id === p.characterId);
          return c?.name ?? '?';
        }).join(', ')}`;
      }
      await get().addLogEntry({
        adventureId: get().currentAdventureId ?? undefined,
        characterId: null,
        characterName: '⚔️ Конфликт',
        skillName: `Раунд ${roundLabel}`,
        diceResults: [],
        bonus: 0,
        total: 0,
        opponentTotal: null,
        difficulty: null,
        result: `Начался раунд ${roundLabel}`,
        opponentType: null,
        opponentName: null,
        opponentSkillName: null,
        opponentDiceResults: [],
        opponentBonus: 0,
        extraBonus: 0,
        extraBonusReason: '',
        rerolled: false,
        customText,
        isRiftEvent: false,
      });
    } else {
      const newConflictData: ConflictData = {
        ...conflictData,
        participants: updatedParticipants,
        currentParticipantIndex: nextIdx,
      };

      await get().updateScene(scene.id, { conflictData: newConflictData });
    }
  },

  eliminateParticipant: async (characterId: string) => {
    const scene = get().getCurrentScene();
    if (!scene?.conflictData) return;

    const { conflictData } = scene;
    if (conflictData.eliminatedIds.includes(characterId)) return;

    const newEliminated = [...conflictData.eliminatedIds, characterId];
    const { currentMode, characters } = get();
    const isPlayerMode = currentMode === 'player';

    // If eliminated is current participant, find next active participant
    const isCurrent = conflictData.participants[conflictData.currentParticipantIndex]?.characterId === characterId;

    let newConflictData: ConflictData = {
      ...conflictData,
      eliminatedIds: newEliminated,
    };

    if (isCurrent) {
      // Mark current as acted and find next
      let updatedParticipants = newConflictData.participants.map((p, idx) =>
        idx === newConflictData.currentParticipantIndex ? { ...p, hasActed: true } : p,
      );

      let nextIdx = -1;
      for (let i = 1; i <= updatedParticipants.length; i++) {
        const checkIdx = (newConflictData.currentParticipantIndex + i) % updatedParticipants.length;
        const p = updatedParticipants[checkIdx];
        if (!p.hasActed && !newEliminated.includes(p.characterId)) {
          if (isPlayerMode) {
            const char = characters.find((c) => c.id === p.characterId);
            if (char?.hiddenFromPlayers) {
              updatedParticipants = updatedParticipants.map((up, idx) =>
                idx === checkIdx ? { ...up, hasActed: true } : up,
              );
              continue;
            }
          }
          nextIdx = checkIdx;
          break;
        }
      }

      if (nextIdx === -1) {
        // Everyone has acted or is eliminated — start new round
        newConflictData = {
          ...newConflictData,
          participants: updatedParticipants.map((p) => ({ ...p, hasActed: false })),
          currentParticipantIndex: 0,
          round: newConflictData.round + 1,
        };
      } else {
        newConflictData = {
          ...newConflictData,
          participants: updatedParticipants,
          currentParticipantIndex: nextIdx,
        };
      }
    }

    await get().updateScene(scene.id, { conflictData: newConflictData });

    // Log elimination
    const char = get().getCharacter(characterId);
    await get().addLogEntry({
      adventureId: get().currentAdventureId ?? undefined,
      characterId: null,
      characterName: '⚔️ Конфликт',
      skillName: 'Выбыл',
      diceResults: [],
      bonus: 0,
      total: 0,
      opponentTotal: null,
      difficulty: null,
      result: `${char?.name ?? 'Участник'} выбыл из конфликта`,
      opponentType: null,
      opponentCharacterId: null,
      opponentName: null,
      opponentSkillName: null,
      opponentDiceResults: [],
      opponentBonus: 0,
      extraBonus: 0,
      extraBonusReason: '',
      rerolled: false,
      customText: `💀 ${char?.name ?? 'Участник'} выбыл из конфликта`,
      isRiftEvent: false,
    });
  },

  returnParticipant: async (characterId: string) => {
    const scene = get().getCurrentScene();
    if (!scene?.conflictData) return;

    const { conflictData } = scene;
    if (!conflictData.eliminatedIds.includes(characterId)) return;

    const newEliminated = conflictData.eliminatedIds.filter((id) => id !== characterId);
    const newConflictData: ConflictData = {
      ...conflictData,
      eliminatedIds: newEliminated,
    };

    await get().updateScene(scene.id, { conflictData: newConflictData });

    // Log return
    const char = get().getCharacter(characterId);
    await get().addLogEntry({
      adventureId: get().currentAdventureId ?? undefined,
      characterId: null,
      characterName: '⚔️ Конфликт',
      skillName: 'Вернулся',
      diceResults: [],
      bonus: 0,
      total: 0,
      opponentTotal: null,
      difficulty: null,
      result: `${char?.name ?? 'Участник'} вернулся в конфликт`,
      opponentType: null,
      opponentCharacterId: null,
      opponentName: null,
      opponentSkillName: null,
      opponentDiceResults: [],
      opponentBonus: 0,
      extraBonus: 0,
      extraBonusReason: '',
      rerolled: false,
      customText: `↩️ ${char?.name ?? 'Участник'} вернулся в конфликт`,
      isRiftEvent: false,
    });
  },

  removeParticipantFromConflict: async (characterId: string) => {
    const scene = get().getCurrentScene();
    if (!scene?.conflictData) return;

    const { conflictData } = scene;
    const waitingIds = conflictData.waitingIds ?? [];

    // Check if character is in the conflict at all
    const isInParticipants = conflictData.participants.some((p) => p.characterId === characterId);
    const isEliminated = conflictData.eliminatedIds.includes(characterId);
    const isWaiting = waitingIds.includes(characterId);

    if (!isInParticipants && !isEliminated && !isWaiting) return;

    // Remove from participants
    let updatedParticipants = conflictData.participants.filter((p) => p.characterId !== characterId);
    const removedParticipant = conflictData.participants.find((p) => p.characterId === characterId);

    // Remove from eliminated
    const updatedEliminated = conflictData.eliminatedIds.filter((id) => id !== characterId);

    // Remove from waiting
    const updatedWaiting = waitingIds.filter((id) => id !== characterId);

    // Adjust currentParticipantIndex if needed
    let newIndex = conflictData.currentParticipantIndex;

    if (removedParticipant) {
      const oldIndex = conflictData.participants.findIndex((p) => p.characterId === characterId);
      // If removing someone before current, shift index back
      if (oldIndex < newIndex) {
        newIndex = Math.max(0, newIndex - 1);
      }
      // If removing the current participant, find next valid
      if (oldIndex === newIndex) {
        // Find the next non-eliminated, non-acted participant
        let nextIdx = -1;
        for (let i = 1; i <= updatedParticipants.length; i++) {
          const checkIdx = (newIndex + i) % updatedParticipants.length;
          const p = updatedParticipants[checkIdx];
          if (!p.hasActed && !updatedEliminated.includes(p.characterId)) {
            nextIdx = checkIdx;
            break;
          }
        }
        if (nextIdx !== -1) {
          newIndex = nextIdx;
        } else if (updatedParticipants.length > 0) {
          // Will trigger new round
          newIndex = 0;
        } else {
          newIndex = 0;
        }
      }
    }

    // If no participants left, end conflict
    if (updatedParticipants.length === 0 && updatedWaiting.length === 0) {
      // Just clear conflict data
      await get().updateScene(scene.id, { conflictData: null });
      await get().addLogEntry({
        adventureId: get().currentAdventureId ?? undefined,
        characterId: null,
        characterName: '⚔️ Конфликт',
        skillName: 'Завершён',
        diceResults: [],
        bonus: 0,
        total: 0,
        opponentTotal: null,
        difficulty: null,
        result: 'Конфликт завершён',
        opponentType: null,
        opponentName: null,
        opponentSkillName: null,
        opponentDiceResults: [],
        opponentBonus: 0,
        extraBonus: 0,
        extraBonusReason: '',
        rerolled: false,
        customText: '⏹️ Все участники покинули конфликт',
        isRiftEvent: false,
      });
      return;
    }

    const newConflictData: ConflictData = {
      ...conflictData,
      participants: updatedParticipants,
      currentParticipantIndex: newIndex,
      eliminatedIds: updatedEliminated,
      waitingIds: updatedWaiting,
    };

    await get().updateScene(scene.id, { conflictData: newConflictData });
  },

  endConflict: async () => {
    const scene = get().getCurrentScene();
    if (!scene) return;

    const { characters } = get();

    // Reset stress and situational aspects for all conflict participants
    // Keep consequences (they persist until healed)
    const participantIds = scene.conflictData?.participants.map((p) => p.characterId) ?? [];
    const waitingIds = scene.conflictData?.waitingIds ?? [];
    const allConflictIds = [...participantIds, ...waitingIds];

    // Reset stress and situational aspects on characters
    for (const charId of allConflictIds) {
      const char = characters.find((c) => c.id === charId);
      if (!char) continue;

      // Reset all stress tracks (unmark all boxes)
      const resetStress = char.stressTracks.map((track) => ({
        ...track,
        markers: track.markers.map(() => false),
      }));

      // Clear situational aspects on the character
      await get().updateCharacter(charId, {
        stressTracks: resetStress,
        situationalAspects: [],
      });
    }

    // Clear token situational aspects and conditions in a single scene update
    const updatedFloors = scene.floors.map((floor) => ({
      ...floor,
      tokens: floor.tokens.map((token) => {
        if (allConflictIds.includes(token.charId)) {
          return { ...token, situationalAspects: [], conditions: [] };
        }
        return token;
      }),
    }));

    await get().updateScene(scene.id, { floors: updatedFloors });
    await get().updateScene(scene.id, { conflictData: null });

    // Log conflict end
    await get().addLogEntry({
      adventureId: get().currentAdventureId ?? undefined,
      characterId: null,
      characterName: '⚔️ Конфликт',
      skillName: 'Завершён',
      diceResults: [],
      bonus: 0,
      total: 0,
      opponentTotal: null,
      difficulty: null,
      result: 'Конфликт завершён',
      opponentType: null,
      opponentCharacterId: null,
      opponentName: null,
      opponentSkillName: null,
      opponentDiceResults: [],
      opponentBonus: 0,
      extraBonus: 0,
      extraBonusReason: '',
      rerolled: false,
      customText: '⏹️ Конфликт завершён',
      isRiftEvent: false,
    });
  },

  // ── Conflict: Roll Initiative for All ──────────────────────
  rollInitiativeForAll: async () => {
    const scene = get().getCurrentScene();
    if (!scene?.conflictData) return;

    const { characters, settings, currentAdventureId } = get();
    const { type, participants, eliminatedIds } = scene.conflictData;

    // Re-calculate initiative for each non-eliminated participant.
    // In 'random' mode this re-rolls Fate dice; in 'book' mode it just
    // re-reads skill values. Eliminated participants keep their existing
    // initiative (they won't act anyway).
    const newParticipants: ConflictParticipant[] = participants.map((p) => {
      if (eliminatedIds.includes(p.characterId)) return p;
      const char = characters.find((c) => c.id === p.characterId);
      if (!char) return p;
      return {
        characterId: p.characterId,
        initiative: calcInitiativeValue(char, type, settings),
        hasActed: false,
        addedThisRound: false,
      };
    });

    // Sort: book mode uses tiebreakers, random mode is numeric.
    const sorted = [...newParticipants].sort(createInitiativeComparator(characters, type, settings));

    const newConflictData: ConflictData = {
      ...scene.conflictData,
      participants: sorted,
      currentParticipantIndex: 0,
      round: 1,
    };

    // In player mode: auto-skip invisible characters at the start
    const isPlayerMode = get().currentMode === 'player';
    if (isPlayerMode && sorted.length > 0) {
      let firstVisibleIdx = -1;
      const markedActed = [...sorted];
      for (let i = 0; i < markedActed.length; i++) {
        const char = characters.find((c) => c.id === markedActed[i].characterId);
        if (char?.hiddenFromPlayers) {
          markedActed[i] = { ...markedActed[i], hasActed: true };
          continue;
        }
        firstVisibleIdx = i;
        break;
      }
      if (firstVisibleIdx !== -1) {
        newConflictData.participants = markedActed;
        newConflictData.currentParticipantIndex = firstVisibleIdx;
      }
    }

    // Persist via the existing updateScene action (handles both API + state)
    await get().updateScene(scene.id, { conflictData: newConflictData });

    // Log the results — match the conflict log entry format used elsewhere.
    const typeLabel = type === 'physical' ? 'Физический' : 'Ментальный';
    const sortedNames = sorted
      .filter((p) => !eliminatedIds.includes(p.characterId))
      .map((p) => {
        const char = characters.find((c) => c.id === p.characterId);
        // In player mode, don't reveal invisible characters in log
        if (isPlayerMode && char?.hiddenFromPlayers) return null;
        return `${char?.name ?? 'Неизвестный'} (${p.initiative >= 0 ? '+' : ''}${p.initiative})`;
      })
      .filter(Boolean)
      .join(', ');

    await get().addLogEntry({
      adventureId: currentAdventureId ?? undefined,
      characterId: null,
      characterName: '🎲 Инициатива',
      skillName: type === 'physical'
        ? settings.initiative.physical.primary
        : settings.initiative.mental.primary,
      diceResults: [],
      bonus: 0,
      total: 0,
      opponentTotal: null,
      difficulty: null,
      result: `Инициатива пересчитана (${typeLabel.toLowerCase()}): ${sortedNames}`,
      opponentType: null,
      opponentCharacterId: null,
      opponentName: null,
      opponentSkillName: null,
      opponentDiceResults: [],
      opponentBonus: 0,
      extraBonus: 0,
      extraBonusReason: '',
      rerolled: false,
      customText: `🎲 Бросок инициативы (${typeLabel}): ${sortedNames}`,
      isRiftEvent: false,
    });
  },

  // ── Conflict: Add participant mid-conflict ────────────────
  addParticipantToConflict: async (characterId: string, immediate = false) => {
    const scene = get().getCurrentScene();
    if (!scene?.conflictData) return;

    const { conflictData } = scene;
    // Already a participant?
    if (conflictData.participants.some((p) => p.characterId === characterId)) return;
    if (conflictData.eliminatedIds.includes(characterId)) return;
    if ((conflictData.waitingIds ?? []).includes(characterId)) return;

    const { characters, settings } = get();
    const char = characters.find((c) => c.id === characterId);
    if (!char) return;

    if (immediate) {
      // Add directly to participants with calculated initiative, insert in order
      const initiative = calcInitiativeValue(char, conflictData.type, settings);

      const newParticipant: ConflictParticipant = {
        characterId,
        initiative,
        hasActed: false,
        addedThisRound: true,
      };

      const updatedParticipants = [...conflictData.participants, newParticipant];
      updatedParticipants.sort(createInitiativeComparator(characters, conflictData.type, settings));

      // Find where the current participant is in the new sorted list
      const currentCharId = conflictData.participants[conflictData.currentParticipantIndex]?.characterId;
      const newCurrentIdx = updatedParticipants.findIndex((p) => p.characterId === currentCharId);

      const newConflictData: ConflictData = {
        ...conflictData,
        participants: updatedParticipants,
        currentParticipantIndex: newCurrentIdx >= 0 ? newCurrentIdx : 0,
      };

      await get().updateScene(scene.id, { conflictData: newConflictData });

      await get().addLogEntry({
        adventureId: get().currentAdventureId ?? undefined,
        characterId: null,
        characterName: '⚔️ Конфликт',
        skillName: 'Новый участник',
        diceResults: [],
        bonus: 0,
        total: 0,
        opponentTotal: null,
        difficulty: null,
        result: `${char.name} вступил в конфликт (немедленно)`,
        opponentType: null,
        opponentName: null,
        opponentSkillName: null,
        opponentDiceResults: [],
        opponentBonus: 0,
        extraBonus: 0,
        extraBonusReason: '',
        rerolled: false,
        customText: `⚡ ${char.name} вступил в конфликт немедленно! Инициатива: ${initiative >= 0 ? '+' : ''}${initiative}`,
        isRiftEvent: false,
      });
    } else {
      // Add to waiting list — will join at the start of next round
      const newConflictData: ConflictData = {
        ...conflictData,
        waitingIds: [...(conflictData.waitingIds ?? []), characterId],
      };

      await get().updateScene(scene.id, { conflictData: newConflictData });

      await get().addLogEntry({
        adventureId: get().currentAdventureId ?? undefined,
        characterId: null,
        characterName: '⚔️ Конфликт',
        skillName: 'Ожидание',
        diceResults: [],
        bonus: 0,
        total: 0,
        opponentTotal: null,
        difficulty: null,
        result: `${char.name} ждёт вступления в следующий раунд`,
        opponentType: null,
        opponentName: null,
        opponentSkillName: null,
        opponentDiceResults: [],
        opponentBonus: 0,
        extraBonus: 0,
        extraBonusReason: '',
        rerolled: false,
        customText: `⏳ ${char.name} вступит в конфликт в следующем раунде`,
        isRiftEvent: false,
      });
    }
  },

  // ── Conditions (status effects on tokens) ─────────────────
  addCondition: async (charId: string, condition: Omit<Condition, 'id'>) => {
    const scene = get().getCurrentScene();
    if (!scene) return;

    const newCondition: Condition = { ...condition, id: genId() };
    const updatedFloors = scene.floors.map((floor) => ({
      ...floor,
      tokens: floor.tokens.map((t) =>
        t.charId === charId
          ? { ...t, conditions: [...(t.conditions ?? []), newCondition] }
          : t,
      ),
    }));

    await get().updateScene(scene.id, { floors: updatedFloors });
  },

  removeCondition: async (charId: string, conditionId: string) => {
    const scene = get().getCurrentScene();
    if (!scene) return;

    const updatedFloors = scene.floors.map((floor) => ({
      ...floor,
      tokens: floor.tokens.map((t) =>
        t.charId === charId
          ? { ...t, conditions: (t.conditions ?? []).filter((c) => c.id !== conditionId) }
          : t,
      ),
    }));

    await get().updateScene(scene.id, { floors: updatedFloors });
  },

  updateCondition: async (charId: string, conditionId: string, data: Partial<Condition>) => {
    const scene = get().getCurrentScene();
    if (!scene) return;

    const updatedFloors = scene.floors.map((floor) => ({
      ...floor,
      tokens: floor.tokens.map((t) =>
        t.charId === charId
          ? {
              ...t,
              conditions: (t.conditions ?? []).map((c) =>
                c.id === conditionId ? { ...c, ...data } : c,
              ),
            }
          : t,
      ),
    }));

    await get().updateScene(scene.id, { floors: updatedFloors });
  },

  tickConditions: async () => {
    const scene = get().getCurrentScene();
    if (!scene) return;

    // Decrement duration of all conditions on all tokens across all floors.
    // Skip conditions with duration -1 (unlimited). Remove conditions reaching 0.
    let anyChange = false;
    const updatedFloors = scene.floors.map((floor) => {
      const updatedTokens = floor.tokens.map((t) => {
        if (!t.conditions || t.conditions.length === 0) return t;
        const nextConditions = t.conditions
          .map((c) => (c.duration === -1 ? c : { ...c, duration: c.duration - 1 }))
          .filter((c) => c.duration !== 0);
        if (nextConditions.length !== t.conditions.length) anyChange = true;
        return { ...t, conditions: nextConditions };
      });
      return { ...floor, tokens: updatedTokens };
    });

    if (!anyChange) return;

    await get().updateScene(scene.id, { floors: updatedFloors });

    // Log condition tick
    await get().addLogEntry({
      adventureId: get().currentAdventureId ?? undefined,
      characterId: null,
      characterName: '⏳ Состояния',
      skillName: 'Новый раунд',
      diceResults: [],
      bonus: 0,
      total: 0,
      opponentTotal: null,
      difficulty: null,
      result: 'Длительности состояний обновлены',
      opponentType: null,
      opponentCharacterId: null,
      opponentName: null,
      opponentSkillName: null,
      opponentDiceResults: [],
      opponentBonus: 0,
      extraBonus: 0,
      extraBonusReason: '',
      rerolled: false,
      customText: '⏳ Новый раунд: состояния обновлены',
      isRiftEvent: false,
    });
  },

  // ── Floor background image ─────────────────────────────────
  updateFloorBackground: async (sceneId, floorIndex, backgroundImage) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    if (floorIndex < 0 || floorIndex >= scene.floors.length) return;

    const updatedFloors = scene.floors.map((floor, idx) =>
      idx === floorIndex ? { ...floor, backgroundImage } : floor,
    );

    await get().updateScene(sceneId, { floors: updatedFloors });
  },

  // ── Fog of War ───────────────────────────────────────────
  addFogArea: async (sceneId, floorIndex, area) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    if (floorIndex < 0 || floorIndex >= scene.floors.length) return;

    const updatedFloors = scene.floors.map((floor, idx) =>
      idx === floorIndex
        ? { ...floor, fogAreas: [...(floor.fogAreas ?? []), area] }
        : floor,
    );

    await get().updateScene(sceneId, { floors: updatedFloors });
  },

  removeFogArea: async (sceneId, floorIndex, areaId) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    if (floorIndex < 0 || floorIndex >= scene.floors.length) return;

    const updatedFloors = scene.floors.map((floor, idx) =>
      idx === floorIndex
        ? { ...floor, fogAreas: (floor.fogAreas ?? []).filter((fa) => fa.id !== areaId) }
        : floor,
    );

    await get().updateScene(sceneId, { floors: updatedFloors });
  },

  toggleFogArea: async (sceneId, floorIndex, areaId) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    if (floorIndex < 0 || floorIndex >= scene.floors.length) return;

    const updatedFloors = scene.floors.map((floor, idx) =>
      idx === floorIndex
        ? {
            ...floor,
            fogAreas: (floor.fogAreas ?? []).map((fa) =>
              fa.id === areaId ? { ...fa, hidden: !fa.hidden } : fa,
            ),
          }
        : floor,
    );

    await get().updateScene(sceneId, { floors: updatedFloors });
  },

  toggleFloorFog: async (sceneId, floorIndex, enabled) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    if (floorIndex < 0 || floorIndex >= scene.floors.length) return;

    const updatedFloors = scene.floors.map((floor, idx) =>
      idx === floorIndex ? { ...floor, fogEnabled: enabled } : floor,
    );

    await get().updateScene(sceneId, { floors: updatedFloors });
  },

  clearFloorFog: async (sceneId, floorIndex) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    if (floorIndex < 0 || floorIndex >= scene.floors.length) return;

    const updatedFloors = scene.floors.map((floor, idx) =>
      idx === floorIndex ? { ...floor, fogAreas: [] } : floor,
    );

    await get().updateScene(sceneId, { floors: updatedFloors });
  },

  // ── UI Actions ─────────────────────────────────────────────
  setMode: (mode) => {
    // Network players are locked to 'player' mode — they cannot switch to master.
    const { isNetworkActive, networkRole } = get();
    if (isNetworkActive && networkRole === 'player' && mode === 'master') return;
    set({ currentMode: mode });
  },
  setFloorIndex: (index) => {
    set({ currentFloorIndex: index });
    // Persist floor index on the scene so the floor selection survives reloads.
    const { scenes, currentSceneId } = get();
    const scene = scenes.find((s) => s.id === currentSceneId);
    if (scene && scene.currentFloorIndex !== index) {
      apiPut(`/api/scenes?id=${scene.id}`, { currentFloorIndex: index }).catch(() => {
        // Silent — best-effort persistence
      });
    }
  },

  // ── Network (P2P) Actions ──────────────────────────────────
  setNetworkActive: (active) => set({ isNetworkActive: active }),
  setNetworkRole: (role) => set({ networkRole: role }),
  setNetworkMyPeerId: (peerId) => {
    if (typeof window !== 'undefined' && peerId) {
      try { localStorage.setItem('fate-peer-id', peerId); } catch {}
    }
    set({ networkMyPeerId: peerId });
  },
  setNetworkMyDisplayName: (name) => {
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('fate-display-name', name); } catch {}
    }
    set({ networkMyDisplayName: name });
  },
  setNetworkRoomId: (roomId) => set({ networkRoomId: roomId }),
  setNetworkPeers: (peers) => set({ networkPeers: peers }),
  setNetworkHostOnline: (online) => set({ networkHostOnline: online }),
  setNetworkSignalingStatus: (status) => set({ networkSignalingStatus: status }),
  setPeerLatency: (peerId, latencyMs) => set((s) => ({
    peerLatencies: { ...s.peerLatencies, [peerId]: latencyMs },
    peerLastSeen: { ...s.peerLastSeen, [peerId]: Date.now() },
  })),
  setPeerLatencies: (latencies) => set({ peerLatencies: latencies }),
  touchPeer: (peerId) => set((s) => ({
    peerLastSeen: { ...s.peerLastSeen, [peerId]: Date.now() },
  })),
  forgetPeer: (peerId) => set((s) => {
    const latencies = { ...s.peerLatencies };
    const lastSeen = { ...s.peerLastSeen };
    const cursors = { ...s.peerCursors };
    delete latencies[peerId];
    delete lastSeen[peerId];
    delete cursors[peerId];
    return { peerLatencies: latencies, peerLastSeen: lastSeen, peerCursors: cursors };
  }),
  setPeerCursor: (peerId, cursor) => set((s) => ({
    peerCursors: { ...s.peerCursors, [peerId]: cursor },
  })),
  clearPeerCursor: (peerId) => set((s) => {
    const cursors = { ...s.peerCursors };
    delete cursors[peerId];
    return { peerCursors: cursors };
  }),
  clearAllPeerCursors: () => set({ peerCursors: {} }),
  startSyncRoll: ({ skillName, skillValue, bonus, difficulty, participantPeerIds, countdownSec = 3 }) => {
    const session: SyncRollSession = {
      id: `sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      skillName,
      skillValue,
      bonus,
      difficulty,
      participantPeerIds,
      startedAt: Date.now(),
      deadlineTs: Date.now() + (countdownSec + 5) * 1000, // countdown + 5s grace
      countdownSec,
      results: {},
      status: 'countdown',
    };
    set({ syncRollState: session });
  },
  cancelSyncRoll: () => set({ syncRollState: null }),
  submitSyncRollResult: (result) => set((s) => {
    const session = s.syncRollState;
    if (!session) return {};
    // Ignore results from peers who weren't invited to this session.
    // (Prevents stray results from a previous session or unselected peers.)
    if (!session.participantPeerIds.includes(result.peerId)) return {};
    const results = { ...session.results, [result.peerId]: result };
    const allIn = session.participantPeerIds.every((pid) => pid in results);
    return {
      syncRollState: {
        ...session,
        results,
        status: allIn ? 'complete' : 'rolling',
      },
    };
  }),
  finalizeSyncRoll: async () => {
    const s = get();
    const session = s.syncRollState;
    if (!session) return;
    const results = Object.values(session.results);
    if (results.length === 0) {
      set({ syncRollState: null });
      return;
    }
    // Sort by total desc — best on top, worst on bottom.
    results.sort((a, b) => b.total - a.total);

    // Build a structured customText:
    //   Групповой бросок (Бой сложность 2)
    //   Быба +4
    //   Боба +2
    //   Бябя 0
    // Each participant on its own line, sorted by total desc. The header line
    // includes skill name + (optionally) difficulty and bonus.
    const headerParts: string[] = [session.skillName];
    if (session.difficulty !== null) headerParts.push(`сложность ${session.difficulty}`);
    if (session.bonus !== 0) headerParts.push(`бонус ${session.bonus > 0 ? '+' : ''}${session.bonus}`);
    const header = `Групповой бросок (${headerParts.join(', ')})`;
    const lines = results.map((r) => {
      const totalStr = r.total >= 0 ? `+${r.total}` : String(r.total);
      return `${r.characterName} ${totalStr}`;
    });
    const summary = [header, ...lines].join('\n');

    // Store structured participant results for the rich tooltip.
    const groupRollResults = results.map((r) => ({
      characterName: r.characterName,
      skillName: r.skillName,
      skillValue: r.skillValue,
      dice: r.dice,
      bonus: r.bonus,
      total: r.total,
      resultLabel: r.resultLabel,
    }));

    // Determine aggregate outcome for the log entry's `result` field + color.
    // Use the BEST participant's outcome (since this is a group effort, the
    // best roll represents what the group achieved collectively).
    const best = results[0];
    let aggregateResult = '';
    let aggregateTotal = best.total;
    if (session.difficulty !== null) {
      if (best.total > session.difficulty) {
        aggregateResult = best.total - session.difficulty >= 3 ? 'Стиль' : 'Успех';
      } else if (best.total === session.difficulty) {
        aggregateResult = 'Ничья';
      } else {
        aggregateResult = 'Провал';
      }
    } else {
      // No difficulty — use raw Fate ladder
      if (best.total >= 4) aggregateResult = 'Стиль';
      else if (best.total >= 1) aggregateResult = 'Успех';
      else if (best.total === 0) aggregateResult = 'Ничья';
      else aggregateResult = 'Провал';
    }

    await s.addLogEntry({
      adventureId: s.currentAdventureId ?? undefined,
      characterId: null,
      characterName: '⚡ Групповой бросок',
      skillName: session.skillName,
      diceResults: [],
      bonus: session.bonus,
      total: aggregateTotal,
      difficulty: session.difficulty,
      opponentTotal: null,
      result: aggregateResult,
      opponentType: null,
      opponentName: null,
      opponentSkillName: null,
      opponentDiceResults: [],
      opponentBonus: 0,
      extraBonus: 0,
      extraBonusReason: '',
      rerolled: false,
      customText: summary,
      isRiftEvent: false,
      skillValue: null,
      manualBonus: 0,
      helpers: [],
      aspectInvokeBonus: 0,
      aspectInvokeReason: '',
      aspectRerolled: false,
      groupRollResults,
    });
    set({ syncRollState: null });
  },
  // ── Unified Mass Roll Implementation ──────────────────────
  startMassRoll: ({ mode, skillName, bonus, difficulty, characterIds, opponentId, opponentSkillName, unnamedNpc }) => {
    const state = get();
    const sessionId = `mass-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // Build participants from selected character ids. Each participant may be:
    //  - PC with an online player → peerId resolved from playerAssignments
    //  - PC with offline player → peerId = null (GM rolls locally)
    //  - NPC → peerId = null (GM rolls locally)
    const participants: MassRollParticipant[] = [];
    for (const cid of characterIds) {
      const char = state.characters.find((c) => c.id === cid);
      if (!char) continue;
      // Resolve peerId: search playerAssignments for this character id.
      let peerId: string | null = null;
      let peerName: string | undefined;
      for (const [pid, charIds] of Object.entries(state.playerAssignments)) {
        if (charIds.includes(cid)) {
          peerId = pid;
          peerName = state.networkPeers[pid]?.displayName;
          break;
        }
      }
      // Resolve skill value from the character's sheet for the chosen skill.
      const skillValue = char.skills.find((s) => s.name === skillName)?.value ?? 0;
      participants.push({
        characterId: cid,
        characterName: char.name,
        characterType: char.type === 'player' ? 'pc' : 'npc',
        peerId,
        peerName,
        skillName,
        skillValue,
        manualBonus: 0,
        // NPC / offline PC are "ready" from the start (no invitation sent).
        // Online PC starts unready — waits for player to confirm.
        ready: peerId === null,
        readyAt: peerId === null ? Date.now() : null,
        fatePointMode: 'none',
        fatePointReason: undefined,
      });
    }
    // Opponent data (mode='opposed'):
    //  - unnamedNpc → abstract opponent with fixed bonus, rolled locally now
    //  - opponentId (NPC) → rolled locally now
    //  - opponentId (PC) → GM will trigger a separate roll
    let opponentName: string | undefined;
    let opponentTotal: number | undefined;
    let opponentDice: number[] | undefined;
    let opponentSkillNameResolved: string | undefined;
    if (mode === 'opposed' && unnamedNpc) {
      opponentName = 'Безымянный NPC';
      opponentSkillNameResolved = unnamedNpc.skillName || 'Навык';
      const dice = rollFateDice();
      const diceSum = sumFateDice(dice);
      opponentTotal = diceSum + unnamedNpc.skillValue;
      opponentDice = dice;
    } else if (mode === 'opposed' && opponentId) {
      const oppChar = state.characters.find((c) => c.id === opponentId);
      if (oppChar) {
        opponentName = oppChar.name;
        opponentSkillNameResolved = opponentSkillName ?? skillName;
        // If opponent is NPC, GM rolls locally now. If PC, GM will trigger
        // a separate roll for the opponent (or use existing log entry).
        if (oppChar.type === 'npc') {
          const dice = rollFateDice();
          const diceSum = sumFateDice(dice);
          const skillVal = oppChar.skills.find((s) => s.name === (opponentSkillName ?? skillName))?.value ?? 0;
          opponentTotal = diceSum + skillVal;
          opponentDice = dice;
        }
      }
    }
    const session: MassRollSession = {
      id: sessionId,
      mode,
      skillName,
      bonus,
      difficulty,
      opponentId: unnamedNpc ? undefined : opponentId,
      opponentName,
      opponentSkillName: opponentSkillNameResolved,
      opponentTotal,
      opponentDice,
      participants,
      status: 'inviting',
      startedAt: Date.now(),
      completedAt: null,
    };
    set({ massRollState: session });
    return sessionId;
  },
  updateMassRollParticipant: (characterId, updates) => set((s) => {
    const session = s.massRollState;
    if (!session) return {};
    const participants = session.participants.map((p) => {
      if (p.characterId !== characterId) return p;
      const next = { ...p, ...updates };
      // If skillName changed, re-resolve skillValue from the character sheet.
      if (updates.skillName && updates.skillName !== p.skillName) {
        const char = s.characters.find((c) => c.id === characterId);
        if (char) {
          next.skillValue = char.skills.find((sk) => sk.name === updates.skillName)?.value ?? 0;
        }
      }
      return next;
    });
    return { massRollState: { ...session, participants } };
  }),
  setMassRollReady: (sessionId, characterId, ready, fatePoint) => {
    const s = get();
    const session = s.massRollState;
    if (!session || session.id !== sessionId) return;
    const participants = session.participants.map((p) => {
      if (p.characterId !== characterId) return p;
      return {
        ...p,
        ready,
        readyAt: ready ? Date.now() : null,
        fatePointMode: fatePoint?.mode ?? 'none',
        fatePointReason: fatePoint?.reason,
      };
    });
    set({ massRollState: { ...session, participants } });
    // Note: actual broadcast to host is handled by use-network.ts caller.
  },
  applyMassRollReady: (sessionId, characterId, ready, fatePoint) => set((s) => {
    const session = s.massRollState;
    if (!session || session.id !== sessionId) return {};
    const participants = session.participants.map((p) => {
      if (p.characterId !== characterId) return p;
      return {
        ...p,
        ready,
        readyAt: ready ? Date.now() : null,
        fatePointMode: fatePoint?.mode ?? 'none',
        fatePointReason: fatePoint?.reason,
      };
    });
    return { massRollState: { ...session, participants } };
  }),
  forceStartMassRoll: () => {
    const s = get();
    const session = s.massRollState;
    if (!session) return;
    // Roll dice locally for every participant who doesn't yet have a result.
    // This covers NPC + offline PC + any unready online PC.
    const updatedParticipants = session.participants.map((p) => {
      if (p.result) return p;
      const dice = rollFateDice();
      const diceSum = sumFateDice(dice);
      const fateBonus = p.fatePointMode === 'plus2' ? 2 : 0;
      const total = diceSum + p.skillValue + p.manualBonus + session.bonus + fateBonus;
      // Determine result label based on difficulty (if set) or raw ladder.
      let resultLabel = 'Успех';
      if (session.difficulty !== null) {
        if (total > session.difficulty) resultLabel = total - session.difficulty >= 3 ? 'Стиль' : 'Успех';
        else if (total === session.difficulty) resultLabel = 'Ничья';
        else resultLabel = 'Провал';
      } else {
        if (total >= 4) resultLabel = 'Стиль';
        else if (total >= 1) resultLabel = 'Успех';
        else if (total === 0) resultLabel = 'Ничья';
        else resultLabel = 'Провал';
      }
      return {
        ...p,
        ready: true,
        readyAt: p.readyAt ?? Date.now(),
        result: {
          dice,
          diceSum,
          total,
          resultLabel,
          usedReroll: p.fatePointMode === 'reroll',
        },
      };
    });
    const allComplete = updatedParticipants.every((p) => p.result);
    set({
      massRollState: {
        ...session,
        participants: updatedParticipants,
        status: allComplete ? 'complete' : 'rolling',
        completedAt: allComplete ? Date.now() : null,
      },
    });
  },
  rollMassRollParticipantLocally: (characterId) => set((s) => {
    const session = s.massRollState;
    if (!session) return {};
    const participants = session.participants.map((p) => {
      if (p.characterId !== characterId || p.result) return p;
      const dice = rollFateDice();
      const diceSum = sumFateDice(dice);
      const fateBonus = p.fatePointMode === 'plus2' ? 2 : 0;
      const total = diceSum + p.skillValue + p.manualBonus + session.bonus + fateBonus;
      let resultLabel = 'Успех';
      if (session.difficulty !== null) {
        if (total > session.difficulty) resultLabel = total - session.difficulty >= 3 ? 'Стиль' : 'Успех';
        else if (total === session.difficulty) resultLabel = 'Ничья';
        else resultLabel = 'Провал';
      } else {
        if (total >= 4) resultLabel = 'Стиль';
        else if (total >= 1) resultLabel = 'Успех';
        else if (total === 0) resultLabel = 'Ничья';
        else resultLabel = 'Провал';
      }
      return {
        ...p,
        result: {
          dice,
          diceSum,
          total,
          resultLabel,
          usedReroll: p.fatePointMode === 'reroll',
        },
      };
    });
    const allComplete = participants.every((p) => p.result);
    return {
      massRollState: {
        ...session,
        participants,
        status: allComplete ? 'complete' : 'rolling',
        completedAt: allComplete ? Date.now() : null,
      },
    };
  }),
  submitMassRollResult: (sessionId, characterId, result) => set((s) => {
    const session = s.massRollState;
    if (!session || session.id !== sessionId) return {};
    const participants = session.participants.map((p) => {
      if (p.characterId !== characterId) return p;
      return { ...p, result, ready: true, readyAt: p.readyAt ?? Date.now() };
    });
    const allComplete = participants.every((p) => p.result);
    return {
      massRollState: {
        ...session,
        participants,
        status: allComplete ? 'complete' : 'rolling',
        completedAt: allComplete ? Date.now() : null,
      },
    };
  }),
  finalizeMassRoll: async () => {
    const s = get();
    const session = s.massRollState;
    if (!session) return;
    const completed = session.participants.filter((p) => p.result);
    if (completed.length === 0) {
      set({ massRollState: null });
      return;
    }
    // Sort by total desc — best on top, worst on bottom.
    completed.sort((a, b) => (b.result!.total) - (a.result!.total));

    // Build structured customText:
    //   Массовый бросок (Бой сложность 2)
    //   Боба +4
    //   Быба +2 (Атлетика +3, +1 трюк)        ← override skill + manual bonus
    //   Гоблин 0
    const headerParts: string[] = [session.skillName];
    if (session.difficulty !== null) headerParts.push(`сложность ${session.difficulty}`);
    if (session.bonus !== 0) headerParts.push(`бонус ${session.bonus > 0 ? '+' : ''}${session.bonus}`);
    const header = `Массовый бросок (${headerParts.join(', ')})`;
    const lines = completed.map((p) => {
      const totalStr = p.result!.total >= 0 ? `+${p.result!.total}` : String(p.result!.total);
      let line = `${p.characterName} ${totalStr}`;
      // Annotate overrides + manual bonus + fate point
      const annotations: string[] = [];
      if (p.skillName !== session.skillName) {
        annotations.push(`${p.skillName} +${p.skillValue}`);
      }
      if (p.manualBonus !== 0) {
        annotations.push(`${p.manualBonus > 0 ? '+' : ''}${p.manualBonus} трюк`);
      }
      if (p.fatePointMode === 'plus2') {
        annotations.push(`🔥 жетон: +2`);
      } else if (p.fatePointMode === 'reroll') {
        annotations.push(`🔥 жетон: переброс`);
      }
      // ── Post-roll adjustments ──
      const rerolls = p.result!.rerollCount ?? 0;
      const bonuses = p.result!.bonusCount ?? 0;
      const freeInvokes = p.result!.freeInvokeCount ?? 0;
      if (rerolls > 0) {
        annotations.push(`⟳ переброс ×${rerolls}${rerolls > 1 ? ` (−${rerolls} жетона)` : ' (−1 жетон)'}`);
      }
      if (bonuses > 0) {
        annotations.push(`+${bonuses * 2} бонус${bonuses > 1 ? ` ×${bonuses} (−${bonuses} жетона)` : ' (−1 жетон)'}`);
      }
      if (freeInvokes > 0) {
        annotations.push(`★ бесплатный призыв${freeInvokes > 1 ? ` ×${freeInvokes}` : ''} (+${freeInvokes * 2})`);
      }
      if (annotations.length > 0) line += ` (${annotations.join(', ')})`;
      return line;
    });
    const summary = [header, ...lines].join('\n');

    // Structured group results for rich tooltip.
    const groupRollResults = completed.map((p) => ({
      characterName: p.characterName,
      skillName: p.skillName,
      skillValue: p.skillValue,
      dice: p.result!.dice,
      bonus: p.manualBonus + session.bonus,
      total: p.result!.total,
      resultLabel: p.result!.resultLabel,
      rerollCount: p.result!.rerollCount ?? 0,
      bonusCount: p.result!.bonusCount ?? 0,
      freeInvokeCount: p.result!.freeInvokeCount ?? 0,
    }));

    // Aggregate outcome — use the BEST participant's result.
    const best = completed[0];
    let aggregateResult = '';
    let aggregateTotal = best.result!.total;
    if (session.difficulty !== null) {
      if (best.result!.total > session.difficulty) {
        aggregateResult = best.result!.total - session.difficulty >= 3 ? 'Стиль' : 'Успех';
      } else if (best.result!.total === session.difficulty) {
        aggregateResult = 'Ничья';
      } else {
        aggregateResult = 'Провал';
      }
    } else {
      if (best.result!.total >= 4) aggregateResult = 'Стиль';
      else if (best.result!.total >= 1) aggregateResult = 'Успех';
      else if (best.result!.total === 0) aggregateResult = 'Ничья';
      else aggregateResult = 'Провал';
    }

    await s.addLogEntry({
      adventureId: s.currentAdventureId ?? undefined,
      characterId: null,
      characterName: '🎲 Массовый бросок',
      skillName: session.skillName,
      diceResults: [],
      bonus: session.bonus,
      total: aggregateTotal,
      difficulty: session.difficulty,
      opponentTotal: session.opponentTotal ?? null,
      result: aggregateResult,
      opponentType: null,
      opponentName: session.opponentName ?? null,
      opponentSkillName: session.opponentSkillName ?? null,
      opponentDiceResults: session.opponentDice ?? [],
      opponentBonus: 0,
      extraBonus: 0,
      extraBonusReason: '',
      rerolled: false,
      customText: summary,
      isRiftEvent: false,
      skillValue: null,
      manualBonus: 0,
      helpers: [],
      aspectInvokeBonus: 0,
      aspectInvokeReason: '',
      aspectRerolled: false,
      groupRollResults,
    });
    set({ massRollState: null });
  },
  cancelMassRoll: () => set({ massRollState: null }),

  // ── Live Roll Stage Overlay actions ────────────────────────
  enqueueLiveRoll: (event) => set((s) => {
    // Dedupe: if this id was already seen (local enqueue + network echo),
    // silently drop it. Keep the seen list bounded to last 50.
    if (s.liveRollSeenIds.includes(event.id)) return {};
    const seenIds = [...s.liveRollSeenIds, event.id].slice(-50);

    // ── Per-player dice colors stamping ──
    // Each participant gets dice rendered in THAT player's chosen palette.
    // Priority: (1) colors already on the participant (snapshot from network
    //   payload — host stamped them when broadcasting mass-roll results),
    //   (2) peerDiceColors map by participant.peerId (from presence),
    //   (3) local viewer's diceColor/symbolColor (fallback — correct for
    //   the local roller's own dice, and a safe default for unknown peers).
    const localDice = s.diceColor;
    const localSymbol = s.symbolColor;
    const stampedEvent: LiveRollEvent = {
      ...event,
      participants: event.participants.map((p) => {
        if (p.diceColor && p.symbolColor) return p; // already snapshot
        const peerColors = p.peerId ? s.peerDiceColors[p.peerId] : undefined;
        if (peerColors) {
          return { ...p, diceColor: peerColors.diceColor, symbolColor: peerColors.symbolColor };
        }
        // Fallback: local viewer's colors (my own roll, or unknown peer).
        return { ...p, diceColor: localDice, symbolColor: localSymbol };
      }),
    };

    // Capture the last dice result for the DiceCase display — take the
    // first participant's dice (the "main" roller). Survives overlay close
    // so the cubes in the case keep showing the last result.
    //
    // IMPORTANT: only update lastDiceResult for LOCAL rolls (initiated by
    // this viewer). Remote rolls (received via broadcast) must NOT overwrite
    // this viewer's own case — otherwise every player's dice case would show
    // the remote roller's result, defeating the "these are MY dice" metaphor.
    const lastDice = isLocalRollEvent(event, s)
      ? (stampedEvent.participants[0]?.dice ?? s.lastDiceResult)
      : s.lastDiceResult;
    // If theatrical mode is OFF, don't show the overlay at all — just mark
    // the event as seen so a late-arriving broadcast doesn't trigger it.
    if (!s.theatricalMode) {
      return { liveRollSeenIds: seenIds, lastDiceResult: lastDice };
    }
    // If nothing is currently playing, start this event immediately.
    if (!s.liveRollStage) {
      return { liveRollStage: stampedEvent, liveRollSeenIds: seenIds, lastDiceResult: lastDice };
    }
    // Otherwise queue it.
    return {
      liveRollQueue: [...s.liveRollQueue, stampedEvent],
      liveRollSeenIds: seenIds,
      lastDiceResult: lastDice,
    };
  }),
  dismissLiveRoll: () => set((s) => {
    // Pop the next event from the queue (if any). Reset exiting flag.
    const [next, ...rest] = s.liveRollQueue;
    if (next) {
      return { liveRollStage: next, liveRollQueue: rest, liveRollExiting: false };
    }
    return { liveRollStage: null, liveRollExiting: false };
  }),
  requestLiveRollExit: () => {
    // Only meaningful if an event is currently displayed and not already exiting.
    const s = get();
    if (!s.liveRollStage || s.liveRollExiting) return;
    set({ liveRollExiting: true });
    // Safety net: if the overlay doesn't call dismissLiveRoll in time
    // (e.g. unmounted mid-animation), force-dismiss after 700ms.
    setTimeout(() => {
      if (get().liveRollExiting) {
        get().dismissLiveRoll();
      }
    }, 700);
  },
  clearLiveRollQueue: () => {
    pendingPhysicsResolvers.clear();
    pendingVSResolvers.clear();
    set({ liveRollStage: null, liveRollQueue: [], liveRollExiting: false });
  },
  applyPhysicsResult: (eventId, participantId, dice) => set((s) => {
    // Обновляем и liveRollStage (текущий), и liveRollQueue (будущие),
    // и lastDiceResult (для DiceCase) — на случай если event уже был
    // вытолкнут из stage в момент прихода результата.
    const patchEvent = (ev: LiveRollEvent | null): LiveRollEvent | null => {
      if (!ev || ev.id !== eventId) return ev;
      const participants = ev.participants.map((p) => {
        if (p.id !== participantId) return p;
        const diceSum = dice.reduce<number>((sum, d) => sum + d, 0);
        // Пересчёт total: diceSum + skillValue + manualBonus + бонусы (уже в modifiers)
        const modifiersSum = (p.modifiers ?? []).reduce<number>((sum, m) => sum + (m.value || 0), 0);
        // modifiers уже включает skillValue и manualBonus (см. диалоги),
        // поэтому total = diceSum + sum(modifiers) + fate bonuses если есть.
        const fateBonus = (p.bonusCount ?? 0) * 2 + (p.freeInvokeCount ?? 0) * 2;
        const total = diceSum + modifiersSum + fateBonus;
        // Пересчёт result label на основе ev.difficulty / opponent
        const { label: resultLabel, type: resultType } = getRollResult(
          total,
          ev.difficulty ?? null,
          ev.opponent ? (ev.opponent.total ?? null) : null,
        );
        return {
          ...p,
          dice,
          diceSum,
          total,
          resultLabel,
          resultType,
        };
      });

      // ── Multi-session (VS): убрать завершённую сессию из pendingPhysicsSessions ──
      // Для VS броска event имеет pendingPhysicsSessions (массив). Когда результат
      // сессии получен — убираем её из массива. Verdict считаем только когда
      // ВСЕ сессии завершены (массив пуст).
      let nextPendingSessions = ev.pendingPhysicsSessions;
      if (ev.pendingPhysicsSessions && ev.pendingPhysicsSessions.length > 0) {
        nextPendingSessions = ev.pendingPhysicsSessions.filter(
          (sess) => sess.participantId !== participantId,
        );
        // Если массив пуст — приравниваем к null (чтобы overlay ушёл из rolling-фазы)
        if (nextPendingSessions.length === 0) nextPendingSessions = null;
      }

      // ── Verdict recalculation ──
      let verdict: string | undefined = ev.verdict;
      let verdictType: 'win' | 'lose' | 'tie' | 'info' | undefined = ev.verdictType;

      const allSessionsDone = nextPendingSessions === null || (nextPendingSessions?.length ?? 0) === 0;
      const singleSessionDone = !ev.pendingPhysics;  // для single-session: pendingPhysics уже будет null

      if (ev.type === 'opposed' && ev.pendingPhysicsSessions !== undefined) {
        // ── VS simultaneous: verdict только когда обе сессии завершены ──
        if (allSessionsDone) {
          const roller = participants.find((p) => p.role === 'roller');
          const opponent = participants.find((p) => p.role === 'opponent');
          if (roller && opponent) {
            const margin = roller.total - opponent.total;
            if (margin > 0) {
              verdict = `— Победа (+${margin})`;
              verdictType = 'win';
            } else if (margin < 0) {
              verdict = `— Провал (−${Math.abs(margin)})`;
              verdictType = 'lose';
            } else {
              verdict = '— Ничья';
              verdictType = 'tie';
            }
          }
        }
        // Если не все сессии завершены — verdict остаётся undefined (overlay в rolling)
      } else if (ev.type === 'simple' || ev.type === 'opposed') {
        // ── Single-session: verdict по результату ролика ──
        const mainP = participants.find((p) => p.id === participantId);
        if (mainP) {
          if (mainP.resultType === 'great') {
            verdict = '— Успех со стилем!';
            verdictType = 'win';
          } else if (mainP.resultType === 'success') {
            verdict = '— Успех!';
            verdictType = 'win';
          } else if (mainP.resultType === 'tie') {
            verdict = '— Ничья';
            verdictType = 'tie';
          } else {
            verdict = '— Провал';
            verdictType = 'lose';
          }
        }
      }
      return {
        ...ev,
        participants,
        verdict,
        verdictType,
        pendingPhysics: null,
        pending2DPhysics: null,
        pendingPhysicsSessions: nextPendingSessions ?? null,
      };
    };

    const newStage = patchEvent(s.liveRollStage);
    const newQueue = s.liveRollQueue
      .map(patchEvent)
      .filter((x: LiveRollEvent | null): x is LiveRollEvent => x !== null);
    // Only update lastDiceResult if the patched event is a LOCAL roll (this
    // viewer initiated it). Remote rolls' physics results must NOT overwrite
    // this viewer's own dice case. See isLocalRollEvent for the rules.
    const patchedEvent = newStage?.id === eventId
      ? newStage
      : newQueue.find((ev) => ev.id === eventId) ?? null;
    const newLastDice = isLocalRollEvent(patchedEvent, s)
      ? (newStage?.participants[0]?.dice
          ?? newQueue[0]?.participants[0]?.dice
          ?? s.lastDiceResult)
      : s.lastDiceResult;

    // ── Resolve VS promise (multi-session) ──
    // Для VS броска: накапливаем результаты по участникам. Когда все получены —
    // резолвим promise массивом результатов (в порядке participants).
    const vsResolver = pendingVSResolvers.get(eventId);
    if (vsResolver) {
      const patchedP = newStage?.participants.find((p) => p.id === participantId)
        ?? newQueue.find((ev) => ev.id === eventId)?.participants.find((p) => p.id === participantId);
      if (patchedP) {
        vsResolver.results.set(participantId, {
          dice,
          total: patchedP.total,
          participantId,
        });
        vsResolver.expected.delete(participantId);
        if (vsResolver.expected.size === 0) {
          // Все участники завершены — резолвим с массивом в порядке participants
          const patchedEvent = newStage ?? newQueue.find((ev) => ev.id === eventId);
          const orderedResults = (patchedEvent?.participants ?? [])
            .map((p) => vsResolver.results.get(p.id))
            .filter((r): r is { dice: number[]; total: number; participantId: string } => !!r)
            .map((r) => ({ ...r, eventId }));
          pendingVSResolvers.delete(eventId);
          setTimeout(() => vsResolver.resolve(orderedResults), 0);
        }
      }
    } else {
      // ── Resolve single-session promise ──
      const patchedP = newStage?.participants.find((p) => p.id === participantId)
        ?? newQueue.find((ev) => ev.id === eventId)?.participants.find((p) => p.id === participantId);
      if (patchedP) {
        const resolver = pendingPhysicsResolvers.get(eventId);
        if (resolver) {
          pendingPhysicsResolvers.delete(eventId);
          // Вызываем resolver после того как set() завершится (асинхронно).
          setTimeout(() => resolver({
            dice,
            total: patchedP.total,
            eventId,
            participantId,
          }), 0);
        }
      }
    }

    return {
      liveRollStage: newStage,
      liveRollQueue: newQueue,
      lastDiceResult: newLastDice,
    };
  }),
  // Promise-bridge: хранит resolver'ы для runRollWithPhysics. Когда
  // applyPhysicsResult вызывается — резолвит promise. Когда requestLiveRollExit
  // или clearLiveRollQueue — reject'ит (или резолвит с fallback).
  // Ключ: eventId.
  runRollWithPhysics: (eventSkeleton, presetId, origin) => {
    return new Promise((resolve, reject) => {
      const eventId = eventSkeleton.id;
      const participantId = eventSkeleton.participants[0]?.id ?? 'main';
      const sessionId = `phys-${eventId}`;

      // Safety timeout: если за 10с физика не финализировалась —
      // резолвим с fallback dice (4 нуля), чтобы UI не завис.
      const safetyTimeout = setTimeout(() => {
        const resolver = pendingPhysicsResolvers.get(eventId);
        if (resolver) {
          console.warn(`[runRollWithPhysics] timeout for ${eventId} — using fallback dice`);
          pendingPhysicsResolvers.delete(eventId);
          resolver({ dice: [0, 0, 0, 0], total: 0, eventId, participantId });
        }
      }, 10000);

      pendingPhysicsResolvers.set(eventId, ({ dice, total }) => {
        clearTimeout(safetyTimeout);
        resolve({ dice, total, eventId, participantId });
      });

      // Помечаем event с pendingPhysics и ставим в очередь.
      // presetId + origin (originSide/originX/direction/dropX/dropY/spawnX/spawnZ/swingVelocity/initialQuats)
      // пробрасываются до ServerDiceStage → throwDice → physics-service. origin
      // по умолчанию undefined → ServerDiceStage использует defaults
      // (originSide='near', originX=0, direction=undefined). direction
      // пробрасывается только для drag-броска → physics-service вращает импульс.
      // spawnX/spawnZ — token-placement mode: кубы появляются под курсором.
      // swingVelocity — скорость взмаха: масштабирует импульс (realism).
      // initialQuats — текущие ориентации кубиков из 3D-оверлея (in-hand
      //   rotation): physics-service пропускает фазу перемешивания → бросок
      //   становится бесшовным ("тащил → отпустил → сразу полетели").
      // initialAngularVelocity (Вариант A) — текущие угловые скорости кубиков
      //   из HeldDiceController: physics-service продолжает вращение
      //   удерживаемых кубов (та же ось+скорость) → "те же кубы полетели".
      // dropX/dropY — screen-координаты для UI/логирования.
      const event: LiveRollEvent = {
        ...eventSkeleton,
        pendingPhysics: {
          sessionId,
          participantId,
          presetId,
          ...(origin?.originSide ? { originSide: origin.originSide } : {}),
          ...(origin?.originX !== undefined ? { originX: origin.originX } : {}),
          ...(origin?.direction !== undefined ? { direction: origin.direction } : {}),
          ...(origin?.dropX !== undefined ? { dropX: origin.dropX } : {}),
          ...(origin?.dropY !== undefined ? { dropY: origin.dropY } : {}),
          ...(origin?.spawnX !== undefined ? { spawnX: origin.spawnX } : {}),
          ...(origin?.spawnZ !== undefined ? { spawnZ: origin.spawnZ } : {}),
          ...(origin?.swingVelocity !== undefined ? { swingVelocity: origin.swingVelocity } : {}),
          ...(origin?.initialQuats !== undefined && origin.initialQuats.length > 0
            ? { initialQuats: origin.initialQuats }
            : {}),
          ...(origin?.initialAngularVelocity !== undefined && origin.initialAngularVelocity.length > 0
            ? { initialAngularVelocity: origin.initialAngularVelocity }
            : {}),
        },
      };
      get().enqueueLiveRoll(event);
      // ── СЕТЕВАЯ ВИДИМОСТЬ АНИМАЦИИ ──
      // Broadcastим pre-roll event (с pendingPhysics, isSummary=false) всем
      // пирам СРАЗУ после локального enqueue — чтобы remote-клиенты успели
      // подписаться на sessionId (phys-${eventId}) до того, как наша
      // ServerDiceStage смонтируется и вызовет throwDice. Physics-сервис
      // стримит трансформаты через io.emit ВСЕМ сокетам; remote-клиенты
      // регистрируют sessionId в activeSessions (subscribeToSession) и
      // получают те же кадры, что и мы → анимация видна всем одновременно.
      // _broadcastRollStageFn = enqueue (deduped, no-op) + sendRollStage.
      _broadcastRollStageFn?.(event);
    });
  },
  // ── 2D-физика (локальная, diceMode='2d') ──
  // Полный аналог runRollWithPhysics, но pending2DPhysics вместо pendingPhysics.
  // Тот же pendingPhysicsResolvers Map (по eventId) — applyPhysicsResult
  // резолвит promise, не различая 2D/3D. ServerDiceStage2D ловит pending2DPhysics
  // и запускает локальный 2D-движок (dice-2d-physics).
  runRollWith2DPhysics: (eventSkeleton, presetId, origin2D) => {
    return new Promise((resolve, reject) => {
      const eventId = eventSkeleton.id;
      const participantId = eventSkeleton.participants[0]?.id ?? 'main';
      const sessionId = `phys2d-${eventId}`;

      // Safety timeout: если за 12с 2D-физика не финализировалась —
      // резолвим с fallback dice (4 нуля). 2D может быть дольше 3D при
      // power-пресете с высокой скоростью (кубы долго катятся).
      const safetyTimeout = setTimeout(() => {
        const resolver = pendingPhysicsResolvers.get(eventId);
        if (resolver) {
          console.warn(`[runRollWith2DPhysics] timeout for ${eventId} — using fallback dice`);
          pendingPhysicsResolvers.delete(eventId);
          resolver({ dice: [0, 0, 0, 0], total: 0, eventId, participantId });
        }
      }, 12000);

      pendingPhysicsResolvers.set(eventId, ({ dice, total }) => {
        clearTimeout(safetyTimeout);
        resolve({ dice, total, eventId, participantId });
      });

      const event: LiveRollEvent = {
        ...eventSkeleton,
        pending2DPhysics: {
          sessionId,
          participantId,
          presetId: presetId ?? 'normal',
          // ── SEED для детерминированного реплея на remote-клиентах ──
          // mulberry32 PRNG: одинаковый seed на originator + всех peers →
          // одинаковая последовательность случайных чисел → одинаковые
          // позиции/грани/скорости кубиков → синхронизированная анимация.
          // Без seed каждый клиент использовал бы Math.random → кубы летели
          // бы по-разному и результат отличался бы.
          seed: (Math.random() * 0xFFFFFFFF) >>> 0,
          ...(origin2D?.spawnX !== undefined ? { spawnX: origin2D.spawnX } : {}),
          ...(origin2D?.spawnY !== undefined ? { spawnY: origin2D.spawnY } : {}),
          ...(origin2D?.direction !== undefined ? { direction: origin2D.direction } : {}),
          ...(origin2D?.speed !== undefined ? { speed: origin2D.speed } : {}),
          ...(origin2D?.initialFaces !== undefined && origin2D.initialFaces.length > 0
            ? { initialFaces: origin2D.initialFaces }
            : {}),
          ...(origin2D?.initialPositions !== undefined && origin2D.initialPositions.length > 0
            ? { initialPositions: origin2D.initialPositions }
            : {}),
          ...(origin2D?.initialVelocities !== undefined && origin2D.initialVelocities.length > 0
            ? { initialVelocities: origin2D.initialVelocities }
            : {}),
          ...(origin2D?.dropX !== undefined ? { dropX: origin2D.dropX } : {}),
          ...(origin2D?.dropY !== undefined ? { dropY: origin2D.dropY } : {}),
        },
      };
      get().enqueueLiveRoll(event);
      // ── СЕТЕВАЯ ВИДИМОСТЬ АНИМАЦИИ (2D) ──
      // Broadcastим pre-roll event (с pending2DPhysics, isSummary=false) всем
      // пирам СРАЗУ после локального enqueue — чтобы remote-клиенты получили
      // seed и spawn-параметры до того, как наша ServerDiceStage2D смонтируется.
      // Remote-клиенты создают PRNG с тем же seed → идентичная анимация
      // (кубы летят по тем же траекториям, те же грани).
      // _broadcastRollStageFn = sendRollStage (P2P DataChannel broadcast).
      _broadcastRollStageFn?.(event);
    });
  },
  // ── ОДНОВРЕМЕННЫЙ VS бросок ──
  // Создаёт ONE LiveRollEvent с pendingPhysicsSessions (массив из 2+ сессий).
  // Каждая сессия имеет свой originSide ('near' для ролика, 'far' для оппонента).
  // ServerDiceStage бросает ВСЕ сессии параллельно, рендерит 4*N кубиков
  // (индексы смещены: session[0] → 0..3, session[1] → 4..7, и т.д.).
  // Promise резолвится когда ВСЕ сессии финализированы, с массивом результатов
  // в порядке participants (ролик первым, оппонент вторым).
  runVSRollWithPhysics: (eventSkeleton, sessions) => {
    return new Promise((resolve) => {
      const eventId = eventSkeleton.id;
      const expected = new Set(sessions.map((s) => s.participantId));

      // Safety timeout: если за 12с не все сессии финализированы —
      // резолвим с fallback dice для недостающих.
      const safetyTimeout = setTimeout(() => {
        const resolver = pendingVSResolvers.get(eventId);
        if (resolver) {
          console.warn(`[runVSRollWithPhysics] timeout for ${eventId} — filling fallback for missing: ${[...resolver.expected].join(', ')}`);
          // Заполняем fallback для недостающих участников
          const patchedEvent = get().liveRollStage?.id === eventId
            ? get().liveRollStage
            : get().liveRollQueue.find((ev) => ev.id === eventId);
          for (const pid of resolver.expected) {
            resolver.results.set(pid, { dice: [0, 0, 0, 0], total: 0, participantId: pid });
          }
          const orderedResults = (patchedEvent?.participants ?? [])
            .map((p) => resolver.results.get(p.id))
            .filter((r): r is { dice: number[]; total: number; participantId: string } => !!r)
            .map((r) => ({ ...r, eventId }));
          pendingVSResolvers.delete(eventId);
          resolve(orderedResults);
        }
      }, 12000);

      pendingVSResolvers.set(eventId, {
        expected,
        results: new Map(),
        resolve: (all) => {
          clearTimeout(safetyTimeout);
          resolve(all);
        },
      });

      // Помечаем event с pendingPhysicsSessions и ставим в очередь.
      const event: LiveRollEvent = {
        ...eventSkeleton,
        pendingPhysics: null,  // single-session поле пусто (используем multi)
        pendingPhysicsSessions: sessions.map((s) => ({
          sessionId: `phys-${eventId}-${s.participantId}`,
          participantId: s.participantId,
          presetId: s.presetId,
          originSide: s.originSide,
        })),
      };
      get().enqueueLiveRoll(event);
    });
  },
  // ── ZONAL MASS бросок (N участников одновременно) ──
  // Создаёт ONE LiveRollEvent типа 'mass' с pendingPhysicsSessions (массив
  // из N сессий). Каждая сессия имеет свой originSide и опциональный originX
  // (латеральный офсет точки спавна стакана). ServerDiceStage бросает ВСЕ
  // сессии параллельно, рендерит 4*N кубиков (индексы смещены: session[i] →
  // i*4..i*4+3). Promise резолвится когда ВСЕ сессии финализированы (или
  // 12s safety timeout), с массивом результатов в порядке participants.
  //
  // В отличие от runVSRollWithPhysics (который для VS броска на 2 участников),
  // этот метод поддерживает ПРОИЗВОЛЬНОЕ N ≥ 1 и переиспользует тот же
  // pendingVSResolvers Map (именем "VS" теперь обозначается любой multi-session
  // resolver — VS для 2, mass для N). applyPhysicsResult уже корректно
  // фильтрует завершённые сессии из pendingPhysicsSessions по participantId
  // (работает для любого N) и резолвит promise когда expected.size === 0.
  runMassRollWithPhysics: (eventSkeleton, sessions) => {
    return new Promise((resolve) => {
      const eventId = eventSkeleton.id;
      const expected = new Set(sessions.map((s) => s.participantId));

      // Safety timeout: 12s — если не все N сессий финализированы,
      // заполняем fallback dice [0,0,0,0] для недостающих и резолвим.
      const safetyTimeout = setTimeout(() => {
        const resolver = pendingVSResolvers.get(eventId);
        if (resolver) {
          console.warn(`[runMassRollWithPhysics] timeout for ${eventId} — filling fallback for missing (${resolver.expected.size}): ${[...resolver.expected].join(', ')}`);
          const patchedEvent = get().liveRollStage?.id === eventId
            ? get().liveRollStage
            : get().liveRollQueue.find((ev) => ev.id === eventId);
          for (const pid of resolver.expected) {
            resolver.results.set(pid, { dice: [0, 0, 0, 0], total: 0, participantId: pid });
          }
          const orderedResults = (patchedEvent?.participants ?? [])
            .map((p) => resolver.results.get(p.id))
            .filter((r): r is { dice: number[]; total: number; participantId: string } => !!r)
            .map((r) => ({ ...r, eventId }));
          pendingVSResolvers.delete(eventId);
          resolve(orderedResults);
        }
      }, 12000);

      pendingVSResolvers.set(eventId, {
        expected,
        results: new Map(),
        resolve: (all) => {
          clearTimeout(safetyTimeout);
          resolve(all);
        },
      });

      // Помечаем event с pendingPhysicsSessions и ставим в очередь.
      // originX пробрасывается до ServerDiceStage → throwDice → physics-service.
      const event: LiveRollEvent = {
        ...eventSkeleton,
        pendingPhysics: null,  // single-session поле пусто (используем multi)
        pendingPhysicsSessions: sessions.map((s) => ({
          sessionId: `phys-${eventId}-${s.participantId}`,
          participantId: s.participantId,
          presetId: s.presetId,
          originSide: s.originSide,
          ...(s.originX !== undefined ? { originX: s.originX } : {}),
        })),
      };
      get().enqueueLiveRoll(event);
    });
  },
  setTheatricalMode: (enabled) => {
    set({ theatricalMode: enabled });
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fate-theatrical-mode', enabled ? '1' : '0');
      } catch { /* ignore */ }
    }
    // If turning OFF, also clear any currently-displayed event.
    if (!enabled) {
      set({ liveRollStage: null, liveRollQueue: [], liveRollExiting: false });
    }
  },
  setTheatricalDurationMs: (ms) => {
    const clamped = Math.max(1500, Math.min(6000, Math.round(ms)));
    set({ theatricalDurationMs: clamped });
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fate-theatrical-duration', String(clamped));
      } catch { /* ignore */ }
    }
  },
  setDiceMode: (mode) => {
    set({ diceMode: mode });
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem('fate-dice-mode', mode);
      } catch { /* ignore */ }
    }
  },
  setDiceColor: (hex) => {
    // Guard: cannot equal symbolColor. UI prevents this, but store enforces too.
    const current = get().symbolColor;
    if (hex.toLowerCase() === current.toLowerCase()) return;
    set({ diceColor: hex });
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('fate-dice-color', hex); } catch { /* ignore */ }
    }
    // Broadcast the new palette to peers so they render this player's dice
    // in the chosen color (per-player customization). No-op when offline.
    try {
      _broadcastDiceColorsFn?.({ diceColor: hex, symbolColor: current });
    } catch (e) {
      console.warn('[store] broadcastDiceColors failed:', e);
    }
  },
  setSymbolColor: (hex) => {
    // Guard: cannot equal diceColor.
    const current = get().diceColor;
    if (hex.toLowerCase() === current.toLowerCase()) return;
    set({ symbolColor: hex });
    if (typeof window !== 'undefined') {
      try { localStorage.setItem('fate-symbol-color', hex); } catch { /* ignore */ }
    }
    // Broadcast the new palette to peers (see setDiceColor).
    try {
      _broadcastDiceColorsFn?.({ diceColor: current, symbolColor: hex });
    } catch (e) {
      console.warn('[store] broadcastDiceColors failed:', e);
    }
  },
  setPeerDiceColor: (peerId, colors) => {
    const current = get().peerDiceColors;
    if (colors === null) {
      // Remove disconnected peer.
      if (!(peerId in current)) return;
      const next = { ...current };
      delete next[peerId];
      set({ peerDiceColors: next });
      return;
    }
    // Skip no-op updates (avoid re-renders on repeated presence pings).
    const existing = current[peerId];
    if (existing && existing.diceColor === colors.diceColor && existing.symbolColor === colors.symbolColor) {
      return;
    }
    set({ peerDiceColors: { ...current, [peerId]: colors } });
  },
  togglePeerCharacter: async (peerId, characterId) => {
    const state = get();
    const current = state.playerAssignments[peerId] ?? [];
    const next = current.includes(characterId)
      ? current.filter((id) => id !== characterId)
      : [...current, characterId];
    await get().setPeerCharacters(peerId, next);
  },
  setPeerCharacters: async (peerId, characterIds) => {
    const state = get();
    // Exclusivity rule: a PC may be assigned to AT MOST ONE peer. When we
    // assign characterIds to peerId, strip each of them from every other
    // peer's roster. This enforces "one character → one player" while still
    // allowing "one player → several characters" (the array model above).
    const newAssignments: Record<string, string[]> = {};
    for (const [pid, ids] of Object.entries(state.playerAssignments)) {
      if (pid === peerId) {
        newAssignments[pid] = characterIds;
      } else {
        const filtered = ids.filter((id) => !characterIds.includes(id));
        newAssignments[pid] = filtered;
      }
    }
    newAssignments[peerId] = characterIds;
    set({ playerAssignments: newAssignments });
    const scene = state.scenes.find((s) => s.id === state.currentSceneId);
    if (scene) {
      await state.updateScene(scene.id, { playerAssignments: newAssignments } as Partial<Scene>);
    }
  },
  // Legacy single-assign compat wrapper. Replaced in the active UI by
  // togglePeerCharacter / setPeerCharacters for multi-character rosters.
  assignCharacterToPeer: async (peerId, characterId) => {
    await get().setPeerCharacters(peerId, characterId ? [characterId] : []);
  },
  setPlayerAssignments: (assignments) => set({ playerAssignments: assignments }),
  setNetworkBroadcasters: (fns) => {
    if ('broadcastLogEntry' in fns) {
      _broadcastLogEntryFn = fns.broadcastLogEntry ?? null;
    }
    if ('broadcastRollStage' in fns) {
      _broadcastRollStageFn = fns.broadcastRollStage ?? null;
    }
    if ('broadcastDiceColors' in fns) {
      _broadcastDiceColorsFn = fns.broadcastDiceColors ?? null;
    }
    if ('broadcastSceneUpdate' in fns) {
      _broadcastSceneUpdateFn = fns.broadcastSceneUpdate ?? null;
    }
    if ('broadcastCharacterUpdate' in fns) {
      _broadcastCharacterUpdateFn = fns.broadcastCharacterUpdate ?? null;
    }
    if ('broadcastTokenMove' in fns) {
      _broadcastTokenMoveFn = fns.broadcastTokenMove ?? null;
    }
  },
  resetNetworkState: () => set({
    isNetworkActive: false,
    networkRole: null,
    networkRoomId: null,
    networkPeers: {},
    networkHostOnline: false,
    networkSignalingStatus: 'offline',
    peerLatencies: {},
    peerLastSeen: {},
    peerCursors: {},
    syncRollState: null,
    massRollState: null,
    // Keep playerAssignments — they may have been persisted on the scene
    // and will be re-applied when the player reconnects. Also keep
    // networkMyPeerId (persisted in localStorage) and displayName.
  }),
  // Also clear the network broadcasters when resetting — prevents stale
  // closures from a previous useNetwork mount calling into a torn-down hook.
  // resetNetworkState doesn't clear them because useNetwork's own cleanup
  // (setNetworkBroadcasters({ broadcastLogEntry: null })) handles that.

  // ── Access Control Guards ──────────────────────────────────
  myAssignedCharacterIds: () => {
    const { isNetworkActive, networkRole, networkMyPeerId, playerAssignments } = get();
    if (!isNetworkActive || networkRole !== 'player' || !networkMyPeerId) return [];
    return playerAssignments[networkMyPeerId] ?? [];
  },
  myAssignedCharacterId: () => {
    const ids = get().myAssignedCharacterIds();
    return ids[0] ?? null;
  },
  canRollForCharacter: (characterId) => {
    const { isNetworkActive, networkRole } = get();
    if (!isNetworkActive || networkRole === 'host') return true;
    if (networkRole !== 'player') return false;
    return get().myAssignedCharacterIds().includes(characterId);
  },
  canEditCharacter: (characterId) => {
    const { isNetworkActive, networkRole } = get();
    if (!isNetworkActive || networkRole === 'host') return true;
    if (networkRole !== 'player') return false;
    return get().myAssignedCharacterIds().includes(characterId);
  },
  canControlToken: (characterId) => {
    const { isNetworkActive, networkRole } = get();
    if (!isNetworkActive || networkRole === 'host') return true;
    if (networkRole !== 'player') return false;
    return get().myAssignedCharacterIds().includes(characterId);
  },
  canEditAdventure: () => {
    const { isNetworkActive, networkRole } = get();
    if (!isNetworkActive) return true;
    return networkRole === 'host';
  },
  canSeeLibrary: () => {
    const { isNetworkActive, networkRole } = get();
    if (!isNetworkActive) return true;
    return networkRole === 'host';
  },
  canTeamRoll: () => {
    const { isNetworkActive, networkRole } = get();
    if (!isNetworkActive) return true;
    return networkRole === 'host';
  },
  canRerollLog: () => {
    const { isNetworkActive, networkRole } = get();
    if (!isNetworkActive) return true;
    return networkRole === 'host';
  },
  canManageClocks: () => {
    const { isNetworkActive, networkRole } = get();
    if (!isNetworkActive) return true;
    return networkRole === 'host';
  },
  canEndTurnFor: (characterId) => {
    const { isNetworkActive, networkRole } = get();
    if (!isNetworkActive || networkRole === 'host') return true;
    if (networkRole !== 'player') return false;
    return get().myAssignedCharacterIds().includes(characterId);
  },
  canBecomeHost: () => {
    const { isNetworkActive } = get();
    return !isNetworkActive;
  },
  canDrawFog: () => {
    const { isNetworkActive, networkRole } = get();
    if (!isNetworkActive) return true;
    return networkRole === 'host';
  },
  canManageFloors: () => {
    const { isNetworkActive, networkRole } = get();
    if (!isNetworkActive) return true;
    return networkRole === 'host';
  },

  // ── Floor management ───────────────────────────────────────
  addFloor: async (sceneId, name) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    const newFloor: Floor = {
      id: genId(),
      name: name ?? `Этаж ${scene.floors.length + 1}`,
      opacity: 100,
      background: null,
      backgroundImage: null,
      tokens: [],
      drawings: [],
      zones: [],
      pins: [],
      fogAreas: [],
      fogEnabled: false,
    };
    const updatedFloors = [...scene.floors, newFloor];
    await get().updateScene(sceneId, { floors: updatedFloors });
    // Auto-switch to the newly created floor
    set({ currentFloorIndex: updatedFloors.length - 1 });
  },

  removeFloor: async (sceneId, floorIndex) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    // Never remove the last floor — a scene must always have at least one.
    if (scene.floors.length <= 1) return;
    const updatedFloors = scene.floors.filter((_, idx) => idx !== floorIndex);
    // Clamp the current floor index if needed
    const { currentFloorIndex } = get();
    let newIndex = currentFloorIndex;
    if (floorIndex === currentFloorIndex) {
      newIndex = Math.max(0, floorIndex - 1);
    } else if (floorIndex < currentFloorIndex) {
      newIndex = currentFloorIndex - 1;
    }
    await get().updateScene(sceneId, { floors: updatedFloors, currentFloorIndex: newIndex });
    set({ currentFloorIndex: newIndex });
  },

  renameFloor: async (sceneId, floorIndex, name) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    const updatedFloors = scene.floors.map((f, idx) =>
      idx === floorIndex ? { ...f, name } : f,
    );
    await get().updateScene(sceneId, { floors: updatedFloors });
  },

  duplicateFloor: async (sceneId, floorIndex) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    const src = scene.floors[floorIndex];
    if (!src) return;
    const copy: Floor = {
      ...src,
      id: genId(),
      name: `${src.name || 'Этаж'} (копия)`,
      // Deep-copy mutable arrays so the duplicate is fully independent
      tokens: src.tokens.map((t) => ({ ...t, conditions: t.conditions ? [...t.conditions] : undefined, situationalAspects: t.situationalAspects ? [...t.situationalAspects] : undefined })),
      drawings: src.drawings.map((d) => ({ ...d, points: [...d.points] })),
      zones: src.zones.map((z) => ({ ...z, vertices: z.vertices ? z.vertices.map((v) => ({ ...v })) : undefined, stress: [...z.stress], aspects: [...z.aspects], riftAspects: z.riftAspects ? [...z.riftAspects] : undefined })),
      pins: src.pins.map((p) => ({ ...p })),
      fogAreas: src.fogAreas ? src.fogAreas.map((fa) => ({ ...fa, points: fa.points.map((p) => ({ ...p })) })) : [],
    };
    const updatedFloors = [...scene.floors];
    updatedFloors.splice(floorIndex + 1, 0, copy);
    await get().updateScene(sceneId, { floors: updatedFloors });
    // Switch to the newly duplicated floor
    set({ currentFloorIndex: floorIndex + 1 });
  },

  reorderFloor: async (sceneId, fromIndex, toIndex) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= scene.floors.length || toIndex >= scene.floors.length) return;
    const updatedFloors = [...scene.floors];
    const [moved] = updatedFloors.splice(fromIndex, 1);
    updatedFloors.splice(toIndex, 0, moved);
    // Track the currently-selected floor through the reorder
    const { currentFloorIndex } = get();
    let newIndex = currentFloorIndex;
    if (currentFloorIndex === fromIndex) {
      newIndex = toIndex;
    } else if (fromIndex < currentFloorIndex && toIndex >= currentFloorIndex) {
      newIndex = currentFloorIndex - 1;
    } else if (fromIndex > currentFloorIndex && toIndex <= currentFloorIndex) {
      newIndex = currentFloorIndex + 1;
    }
    await get().updateScene(sceneId, { floors: updatedFloors, currentFloorIndex: newIndex });
    set({ currentFloorIndex: newIndex });
  },

  setFloorOpacity: async (sceneId, floorIndex, opacity) => {
    const scene = get().scenes.find((s) => s.id === sceneId);
    if (!scene) return;
    const updatedFloors = scene.floors.map((f, idx) =>
      idx === floorIndex ? { ...f, opacity } : f,
    );
    await get().updateScene(sceneId, { floors: updatedFloors });
  },

  // ── Custom Random Tables ──────────────────────────────────
  loadCustomTables: () => {
    try {
      const raw = localStorage.getItem('fate-custom-tables');
      if (raw) {
        const tables: CustomTable[] = JSON.parse(raw);
        set({ customTables: tables });
      }
    } catch {
      set({ customTables: [] });
    }
  },

  saveCustomTable: (table) => {
    const { customTables } = get();
    const idx = customTables.findIndex((t) => t.id === table.id);
    let updated: CustomTable[];
    if (idx >= 0) {
      updated = [...customTables];
      updated[idx] = table;
    } else {
      updated = [...customTables, table];
    }
    set({ customTables: updated });
    localStorage.setItem('fate-custom-tables', JSON.stringify(updated));
  },

  deleteCustomTable: (id) => {
    const updated = get().customTables.filter((t) => t.id !== id);
    set({ customTables: updated });
    localStorage.setItem('fate-custom-tables', JSON.stringify(updated));
  },

  // ── Helpers ────────────────────────────────────────────────
  getCurrentAdventure: () => {
    const { adventures, currentAdventureId } = get();
    return adventures.find((a) => a.id === currentAdventureId) ?? null;
  },

  getCurrentScene: () => {
    const { scenes, currentSceneId } = get();
    return scenes.find((s) => s.id === currentSceneId) ?? null;
  },

  getCharacter: (id: string) => {
    const { characters } = get();
    return characters.find((c) => c.id === id) ?? null;
  },

  getActiveCharacters: () => {
    const { characters } = get();
    return characters.filter((c) => c.isActive);
  },

  getSceneCharacters: () => {
    const { characters, scenes, currentSceneId, settings } = get();
    const scene = scenes.find((s) => s.id === currentSceneId);
    if (!scene) {
      // Even with no scene, show roster PCs (so they don't disappear between scene switches)
      const roster = settings.playerRoster ?? [];
      return characters.filter((c) => roster.includes(c.id));
    }
    // PCs: from the persistent player roster
    const roster = settings.playerRoster ?? [];
    // NPCs: from the current scene's presentCharacters
    const npcIds = scene.presentCharacters;
    const visibleIds = new Set<string>([...roster, ...npcIds]);
    return characters.filter((c) => visibleIds.has(c.id));
  },
}));
