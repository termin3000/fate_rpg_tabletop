// Skill
export interface Skill {
  name: string;
  value: number;
}

// StressTrack
export interface StressTrack {
  name: string;
  type: 'progressive' | 'linear';
  icon: string;
  markers: boolean[];
  showInTooltip: boolean;
}

// Consequence
export interface Consequence {
  name: string;
  value: number;  // Stress absorption value: Mild=2, Moderate=4, Severe=6
  description: string;  // Description of the consequence (e.g. "вывих ноги") — empty means not taken
  healed: boolean;  // True = recovery has begun
}

// Stunt
export interface Stunt {
  name: string;
  description: string;
}

// Aspect source — tracks which source characters contribute each aspect to a crowd
export interface AspectSource {
  text: string;           // The aspect text
  sourceIds: string[];    // baseCharacterIds that contribute this aspect
}

// Character
export interface Character {
  id: string;
  name: string;
  type: 'player' | 'npc';
  concept: string;
  problem: string;
  aspects: string[];
  skills: Skill[];
  stunts: Stunt[];
  stressTracks: StressTrack[];
  consequences: Consequence[];
  situationalAspects: string[];
  fatePoints: number;
  refresh: number;
  isActive: boolean;
  hiddenFromPlayers: boolean;
  folderId: string | null;
  isHorde: boolean;
  members: HordeMember[];
  crowdEligible: boolean;
  crowdComposition: Record<string, number>; // {characterId: count}
  aspectSources: AspectSource[];             // Aspects with source tracking (for crowds)
  temporary: boolean;
  isMage: boolean;
  avatar: string | null;
  avatarColor: string;
  adventureId: string;
}

// HordeMember (Crowd member)
export interface HordeMember {
  id: string;
  name: string;
  stress: boolean[];
  isActive: boolean;
  stressType: 'progressive' | 'linear';
  baseCharacterId: string;   // Source NPC character ID
  baseCharacterName: string; // Source NPC name
  stressTracks: StressTrack[]; // Inherited stress tracks from source NPC
}

// FogArea
export interface FogArea {
  id: string;
  type: 'rect' | 'freehand';
  points: { x: number; y: number }[]; // rect: [topLeft, bottomRight]; freehand: polygon points
  hidden: boolean; // true = fogged/hidden from players, false = revealed
}

// Floor
export interface Floor {
  id: string;
  name: string;
  opacity: number;
  background: string | null;
  backgroundImage?: string | null;
  tokens: Token[];
  drawings: Drawing[];
  zones: Zone[];
  pins: Pin[];
  fogAreas?: FogArea[]; // optional for backward compat
  fogEnabled?: boolean; // whether fog is active on this floor
}

// Condition (status effect on a token)
export interface Condition {
  id: string;        // unique id
  type: string;      // 'poisoned' | 'blessed' | 'stunned' | 'asleep' | 'fear' | 'rage' | 'protected' | 'bleeding' | 'inspired' | 'custom'
  name: string;      // display name in Russian
  icon: string;      // emoji
  color: string;     // hex color for the badge
  duration: number;  // rounds remaining (-1 for unlimited)
  description?: string;
}

// Token
export interface Token {
  charId: string;
  x: number;
  y: number;
  conditions?: Condition[]; // default empty array (optional for backward compat)
  situationalAspects?: string[]; // situational aspects on this token
}

// Preset conditions (without id/duration — those are filled when added)
export const CONDITION_PRESETS: Record<string, Omit<Condition, 'id' | 'duration'>> = {
  poisoned: {
    type: 'poisoned',
    name: 'Отравлен',
    icon: '🤢',
    color: '#27ae60',
    description: '−2 ко всем броскам',
  },
  blessed: {
    type: 'blessed',
    name: 'Благословён',
    icon: '✨',
    color: '#f39c12',
    description: '+2 ко всем броскам',
  },
  stunned: {
    type: 'stunned',
    name: 'Оглушён',
    icon: '💫',
    color: '#8e44ad',
    description: 'Не может действовать в этом раунде',
  },
  asleep: {
    type: 'asleep',
    name: 'Спит',
    icon: '😴',
    color: '#3498db',
    description: 'Не может действовать, просыпается при уроне',
  },
  fear: {
    type: 'fear',
    name: 'Страх',
    icon: '😱',
    color: '#e74c3c',
    description: 'Должен убегать',
  },
  rage: {
    type: 'rage',
    name: 'Ярость',
    icon: '😡',
    color: '#c0392b',
    description: '+2 к атаке, −2 к защите',
  },
  protected: {
    type: 'protected',
    name: 'Защищён',
    icon: '🛡️',
    color: '#2980b9',
    description: '+2 к защите',
  },
  bleeding: {
    type: 'bleeding',
    name: 'Кровотечение',
    icon: '🩸',
    color: '#c0392b',
    description: 'Получает 1 стресс каждый раунд',
  },
  inspired: {
    type: 'inspired',
    name: 'Вдохновлён',
    icon: '💡',
    color: '#f1c40f',
    description: '+1 ко всем броскам',
  },
};

// Drawing
export interface Drawing {
  points: { x: number; y: number }[];
  color: string;
  size: number;
}

// Zone
export type ZoneType = 'normal' | 'danger' | 'bonus' | 'special';

export interface Zone {
  id: string;
  name: string;
  x: number;           // Kept for backward compat (also used as bounding box origin)
  y: number;           // Kept for backward compat
  width: number;       // Kept for backward compat (bounding box)
  height: number;      // Kept for backward compat (bounding box)
  vertices?: { x: number; y: number }[];  // Polygon vertices (if present, overrides rect)
  color: string;
  level: number;       // 0=Чисто, 1=Трещины, 2=Разрыв, 3=Катастрофа
  stress: boolean[];   // 5 cells, linear stress
  aspects: string[];
  zoneType?: ZoneType;       // default 'normal'
  description?: string;       // GM notes about the zone
  riftAspects?: string[];  // Auto-added rift aspects (displayed in red)
}

// Pin
export interface Pin {
  id: string;
  name: string;
  x: number;
  y: number;
  icon: string;
  color: string;
}

// Scene
export interface Scene {
  id: string;
  name: string;
  adventureId: string;
  currentFloorIndex: number;
  playerFloorIndex: number;
  floors: Floor[];
  presentCharacters: string[];
  conflictData: ConflictData | null;
  items: SceneItem[];
}

// ConflictData
export interface ConflictData {
  type: 'physical' | 'mental';
  round: number;
  participants: ConflictParticipant[];
  currentParticipantIndex: number;
  eliminatedIds: string[];
  waitingIds: string[]; // Characters waiting to enter conflict until end of round
}

// ConflictParticipant
export interface ConflictParticipant {
  characterId: string;
  initiative: number;
  hasActed: boolean;
  addedThisRound: boolean; // Joined during current round — act immediately when their turn arrives
}

// SceneItem
export interface SceneItem {
  id: string;
  name: string;
  type: 'item' | 'note';
  description: string;
  text?: string;
}

// Roll helper — a character who contributed to a joint-effort roll
export interface RollHelper {
  name: string;
  skillName?: string;
  skillValue?: number;
  bonus: number; // +1 if had the skill at >= 1, otherwise 0
  // The "type" of this helper — the base character name (e.g. "Гоблин", "Волк").
  // Used to group helpers of the same kind together in tooltips so a large
  // crowd doesn't produce one row per member. Optional for backward compat
  // with older log entries (falls back to `name`).
  baseCharacterName?: string;
}

// A grouped bucket of crowd helpers of the same kind (same base character).
export interface GroupedCrowdHelper {
  /** Display name of the creature type, e.g. "Гоблин". */
  typeLabel: string;
  /** Number of helpers in this group (excludes the roller). */
  count: number;
  /** The skill being rolled. */
  skillName?: string;
  /** The base skill value shared by members of this type. */
  skillValue?: number;
  /** Sum of per-member bonuses in this group. */
  totalBonus: number;
}

// LogEntry
export interface LogEntry {
  id: string;
  adventureId: string;
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
  // ── New rich-tooltip fields (optional for backward compat) ──
  skillValue?: number | null;        // Raw skill value (e.g. +4 for Athletics +4)
  manualBonus?: number;              // Bonus manually added in the roll dialog (before rolling)
  helpers?: RollHelper[];            // Joint-effort helpers (excludes the roller)
  aspectInvokeBonus?: number;        // Bonus added via aspect invoke (right-click on log)
  aspectInvokeReason?: string;       // Aspect name that was invoked
  aspectRerolled?: boolean;          // Was rerolled via aspect invoke (right-click on log)
  aspectFreeInvokeCount?: number;    // How many FREE invocations were applied (no FP cost)
  // ── Opponent rich-tooltip fields ──
  opponentSkillValue?: number | null;  // Raw opponent skill value (e.g. +3 for Contacts +3)
  opponentManualBonus?: number;        // Manual bonus the opponent added in dialog
  // Joint-effort helpers for the DEFENDER (opposed rolls where the defender is
  // a crowd). Mirrors `helpers` but for the opponent side.
  opponentHelpers?: RollHelper[];
  // ── Magic module fields (destructive magic card draw) ──
  isMagicRoll?: boolean;            // true for magic card draws
  magicCastType?: 'normal' | 'dangerous' | null;
  magicCardName?: string | null;    // Drawn card name
  magicEffect?: string | null;      // Full effect text of the card
  magicZoneStress?: number | null;  // Zone stress delta from the card (-2..+2)
  magicZoneName?: string | null;    // Name of the zone where stress was applied
  magicZoneLevelAfter?: number | null; // Zone rift level after the cast (0..3)
  // ── Group roll (P2P synchronized dice roll) ──
  // When set, this entry represents a synchronized multi-player roll. Each
  // participant's dice + skill + bonus + total is stored here so the log
  // tooltip can render a structured breakdown per participant.
  groupRollResults?: GroupRollParticipant[];
}

/** One participant's result in a group (sync) roll log entry. */
export interface GroupRollParticipant {
  characterName: string;
  skillName: string;
  skillValue: number;
  dice: number[];        // 4 Fudge dice results (-1, 0, +1 each)
  bonus: number;         // Total bonus applied (skill value + flat bonus + manual)
  total: number;         // Final total = sum(dice) + bonus
  resultLabel: string;   // Fate ladder label ("Успех", "Ничья", etc.)
}

// Adventure
export interface Adventure {
  id: string;
  name: string;
  currentSceneId: string | null;
  settings: AdventureSettings;
  characters: Character[];
  scenes: Scene[];
  logEntries: LogEntry[];
  items: Item[];
  folders: Folder[];
  createdAt: string;
  updatedAt: string;
}

// AdventureSettings
export type InitiativeMode = 'book' | 'random';

export interface AdventureSettings {
  baseSkills: string[];
  initiative: {
    mode: InitiativeMode;
    physical: { primary: string; secondary: string; tertiary: string };
    mental: { primary: string; secondary: string; tertiary: string };
  };
  modules: { magic: boolean };
  magicModuleEnabled?: boolean;
  magicTable?: MagicTableEntry[]; // Persisted magic table data
  // Player roster — PCs that stay in the left "Characters on scene" panel
  // across ALL scenes until explicitly removed. NPCs are scene-bound (in Scene.presentCharacters).
  playerRoster?: string[];
}

// Item
export interface Item {
  id: string;
  name: string;
  type: 'item' | 'note';
  description: string;
  text: string | null;
  adventureId: string;
  sceneId: string | null;
}

// Folder
export interface Folder {
  id: string;
  name: string;
  adventureId: string;
}

// Note
export type NoteCategory = 'session' | 'lore' | 'npc' | 'quest' | 'handout';
export type NoteColor = 'default' | 'orange' | 'green' | 'blue' | 'purple' | 'red';

export interface Note {
  id: string;
  title: string;
  content: string;
  category: NoteCategory;
  pinned: boolean;
  color: NoteColor;
  adventureId: string;
  createdAt: string;
  updatedAt: string;
}

// Fate Die value (-1, 0, +1)
export type FateDie = -1 | 0 | 1;

// Roll result type
export type RollResultType = 'fail' | 'tie' | 'success' | 'great';

// Roll result
export interface RollResult {
  dice: FateDie[];
  total: number;
  label: string;
  type: RollResultType;
}

// Magic table entry
export interface MagicTableEntry {
  name: string;
  effect: string;
  /** Zone stress cost from the CSV (e.g. -2, -1, 0, +1, +2). `undefined` for CSVs without it. */
  zoneStress?: number;
}

// Custom Random Table (stored in localStorage)
export interface CustomTable {
  id: string;
  name: string;
  icon: string;
  color: string;
  entries: string[];
  createdAt: string;
}

// ── Live Roll Stage Overlay (theatrical mode) ───────────────────────────
// A "stage event" represents one animated dice-roll broadcast that plays on
// top of the screen for everyone (the roller + all connected peers). The
// roller fills it in, broadcasts via use-network.ts (`roll:stage`), and each
// peer enqueues it into its own local overlay queue.

/** Type of roll being shown. Determines animation length and layout. */
export type LiveRollEventType =
  | 'simple'       // single skill check — short animation (~1.5s)
  | 'opposed'      // vs roll — long dramatic (~3.5s)
  | 'cooperative'  // joint effort — long
  | 'mass'         // multi-participant "race" — reveal one by one
  | 'mass-damage'; // attacker → defenders sequence

/** One participant in a stage event (the roller, opponent, helpers, defenders). */
export interface LiveRollParticipant {
  /** Stable id (for React keys + re-targeting by mass-roll adjust). */
  id: string;
  /** Display name of the character. */
  characterName: string;
  /** Optional character id (for click-through to sheet, future). */
  characterId?: string;
  /** PeerId of the player who controls this participant (so overlay can
   *  render dice in THAT player's colors). Null for host-side NPCs (host's
   *  own colors apply) or offline/legacy rolls. */
  peerId?: string | null;
  /** ── Per-player dice colors (snapshot at roll time) ──
   *  When set, the overlay renders THIS participant's dice in these colors
   *  instead of the viewer's local colors. This makes mass rolls visually
   *  distinct: each player's dice use their chosen palette.
   *  Snapshot (not a live ref) so historical accuracy is preserved even if
   *  the player changes colors later. */
  diceColor?: string;
  symbolColor?: string;
  /** Skill name being rolled (e.g. "Бой"). */
  skillName?: string;
  /** Raw skill value (e.g. +3). */
  skillValue?: number;
  /** Manual bonus the player added in the dialog (before rolling). */
  manualBonus?: number;
  /** 4 Fudge dice results (-1, 0, +1 each). */
  dice: number[];
  /** Sum of dice only (-4..+4). Cached so the overlay doesn't need to recompute. */
  diceSum: number;
  /** Final total = diceSum + skillValue + manualBonus + sessionBonus + fateBonuses. */
  total: number;
  /** Fate ladder label ("Успех", "Ничья", "Провал", "Стиль!!"). */
  resultLabel: string;
  /** Machine-readable result bucket for color coding. */
  resultType: 'fail' | 'tie' | 'success' | 'great';
  /** Role this participant plays in the visualization. */
  role: 'roller' | 'opponent' | 'helper' | 'attacker' | 'defender';
  /** For mass-damage defenders: damage assigned to this defender. */
  damage?: number;
  /** For mass-damage defenders: outcome label after defense roll. */
  defenseOutcome?: 'blocked' | 'tie' | 'damage';
  /** # of fate-point +2 invocations applied. */
  bonusCount?: number;
  /** # of free invocations (+2 each, no fate cost). */
  freeInvokeCount?: number;
  /** Was this roll rerolled via fate point? */
  rerolled?: boolean;
  /** For group rolls: was this the highest-scoring participant? */
  isWinner?: boolean;
  /** ── Informativeness fields (added for rich roll display) ── */
  /** Breakdown of every modifier that contributes to (total - diceSum).
   *  Shown as small chips so the user sees exactly where the bonus comes from.
   *  e.g. [{label:"Бой", value:3}, {label:"ситуативный", value:2}, {label:"помощники", value:1}] */
  modifiers?: { label: string; value: number }[];
  /** Margin vs difficulty/opponent. Positive = exceeded, negative = fell short.
   *  Null when not applicable (e.g. cooperative helpers). */
  margin?: number | null;
}

/** A complete stage event (one animated roll sequence). */
export interface LiveRollEvent {
  /** Unique id (uuid-ish). Used as React key + dedupe on receive. */
  id: string;
  /** Animation type — drives layout + duration. */
  type: LiveRollEventType;
  /** Display name of the peer who initiated the roll (for "Бросил: name"). */
  rolledBy: string;
  /** Epoch ms when the roll was made (for ordering / dedupe). */
  rolledAt: number;
  /** Optional scene/skill title (e.g. "Совместная проверка Внимательности"). */
  title?: string;
  /** ── Informativeness fields ── */
  /** Action context — what kind of action this roll represents. Drives the
   *  icon + label shown in the header so the user instantly knows if this is
   *  an attack, a defense, a plain check, etc. */
  actionContext?: 'attack' | 'defense' | 'check' | 'overcome' | 'cooperative' | 'mass' | null;
  /** For opposed rolls: kind of opponent. 'named' = a real character sheet,
   *  'unnamed' = abstract NPC with a fixed skill value. Drives display. */
  opponentKind?: 'named' | 'unnamed' | null;
  /** Difficulty for 'simple'/'opposed' (if any). */
  difficulty?: number | null;
  /** Verdict line shown at the end ("— Победа!", "— Ничья", etc.). */
  verdict?: string;
  /** Verdict color bucket. */
  verdictType?: 'win' | 'lose' | 'tie' | 'info';
  /** The opponent (for 'opposed' type with named/unnamed NPC). */
  opponent?: LiveRollParticipant;
  /** All participants. For 'simple' has 1 entry; for 'mass' has N; etc. */
  participants: LiveRollParticipant[];
  /** Adventure id (for filtering — only show events for the active adventure). */
  adventureId?: string;
  /** ── Server-authoritative physics (real dice, no relabel) ──
   *  Если установлен, overlay запускает бросок через physics-service
   *  (Rapier3D на сервере). Результат приходит асинхронно через
   *  `applyPhysicsResult`. Пока поле активно — overlay показывает кубики
   *  в «rolling» фазе (кувыркаются через серверные трансформы), verdict
   *  скрыт. После settle поле очищается и показывается финальный результат. */
  pendingPhysics?: {
    sessionId: string;
    participantId: string;
    /** Пресет броска (gentle/normal/power/lob/scatter). По умолчанию 'normal'. */
    presetId?: string;
    /** 'near' = со стороны игрока (+Z, ближний край), 'far' = с противоположной
     *  (−Z, дальний край). По умолчанию 'near'. Используется для жест-броска:
     *  игрок тащит кубы на карту — direction броска вычисляется из того, в
     *  какой половине canvas он отпустил (верх/низ). */
    originSide?: 'near' | 'far';
    /** Латеральный X-офсет точки спавна стакана (в физ. единицах, default 0).
     *  Вычисляется из X-координаты drop точки относительно центра canvas. */
    originX?: number;
    /** Угол направления броска в радианах (только для drag-броска).
     *  0 = вперёд (−Z), π/2 = вправо (+X), π = назад (+Z), −π/2 = влево (−X).
     *  Physics-service вращает импульс на этот угол — кубы летят в сторону жеста.
     *  undefined для кнопка-броска → physics-service использует zSign (originSide). */
    direction?: number;
    /** ── Drop-позиция в screen-координатах (clientX/Y) ──
     *  Точная точка где игрок отпустил кубы на карте. Пробрасывается до
     *  Dice3DPhysicsCanvas, который позиционирует МАЛЕНЬКУЮ арену прямо на
     *  этой точке — кубы появляются чуть ниже и падают рядом.
     *  undefined для кнопка-броска → используется большая арена = вся карта. */
    dropX?: number;
    dropY?: number;
    /** ── Абсолютная позиция спавна на арене (drag-roll "token placement" mode) ──
     *  Когда оба spawnX и spawnZ заданы (в физ. единицах, центр арены = (0,0)),
     *  physics-service спавнит стакан В ЭТОЙ ТОЧКЕ — кубы появляются ровно
     *  под курсором в точке отпускания. Это поведение как у размещения токена.
     *  Переопределяет edge-based расчёт из originSide/originX.
     *  undefined для кнопка-броска → edge-based позиция. */
    spawnX?: number;
    spawnZ?: number;
    /** ── Скорость взмаха в момент отпускания (drag-roll realism mode) ──
     *  В пикселях/мс (модуль вектора скорости курсора). Только для drag-броска.
     *  Physics-service масштабирует импульс броска (horizontal + vertical +
     *  angular) от этой скорости: медленный отпуск → кубы мягко падают на
     *  месте ("поставил"), быстрый flick → кубы летят дальше с дугой и
     *  кручением ("бросил с размаху").
     *  undefined для кнопка-броска → используется полный импульс пресета. */
    swingVelocity?: number;
    /** ── Начальные ориентации кубиков (drag-roll "in-hand rotation" mode) ──
     *  Массив кватернионов [x, y, z, w] — по одному на кубик. Захватываются
     *  из 3D-оверлея в момент отпускания: кубы вращались всё время drag'а,
     *  их текущая ориентация и есть "случайная стартовая точка" для броска.
     *
     *  Когда задан, physics-service ПРОПУСКАЕТ фазу перемешивания
     *  (SHAKE_DURATION_MS = 120мс) — кубы сразу получают импульс броска с
     *  этими ориентациями. Это даёт БЕСШОВНЫЙ бросок: "тащил → отпустил →
     *  кубы сразу полетели", без задержки на shake-анимацию.
     *
     *  undefined для кнопка-броска/VS/mass → physics-service использует
     *  фазу перемешивания со случайными стартовыми ориентациями. */
    initialQuats?: Array<[number, number, number, number]>;
    /** ── Начальные угловые скорости кубиков (Вариант A — продолжение вращения) ──
     *  Массив векторов [wx, wy, wz] (рад/с, world space) — по одному на кубик.
     *  Захватываются из постоянного DiceCanvasHost (HeldDiceController) в
     *  момент отпускания drag. Когда задан, physics-service при release
     *  использует ЭТУ угловую скорость вместо throwSpin пресета → брошенные
     *  кубы ПРОДОЛЖАЮТ вращение удерживаемых. Буквально "те же кубы полетели".
     *  undefined для кнопка-броска/VS/mass → throwSpin пресета. */
    initialAngularVelocity?: Array<[number, number, number]>;
    /** ── Remote-origin flag (сетевая видимость анимации) ──
     *  true — этот event получен по сети от другого пира (мы не инициировали
     *  бросок). ServerDiceStage в этом случае НЕ вызывает physics.throwDice
     *  (не создаёт дублирующую сессию на physics-сервисе), а вместо этого
     *  регистрирует sessionId в activeSessions через subscribeToSession —
     *  и принимает трансформаты от io.emit physics-сервиса, который стримит
     *  кадры ВСЕМ подключённым сокетам. Так анимация броска видна всем.
     *  undefined/false — локальный бросок (мы инициатор, вызываем throwDice). */
    isRemote?: boolean;
  } | null;
  /** ── Multi-session physics (для одновременного VS броска) ──
   *  Когда установлено, overlay запускает НЕСКОЛЬКО параллельных physics-сессий
   *  одновременно (по одной на участника). Каждая сессия имеет свой originSide,
   *  чтобы кубики летели с разных сторон арены навстречу друг другу.
   *  Результаты приходят независимо через applyPhysicsResult (по participantId).
   *  Пока массив непустой — overlay в «rolling» фазе. Когда все сессии
   *  финализированы — массив очищается (или заменяется на null) и показывается verdict.
   *
   *  ВАЖНО: индексы кубиков в bufferRef смещаются по сессиям:
   *    session[0] → dice indices 0..3
   *    session[1] → dice indices 4..7
   *    session[i] → dice indices i*4..i*4+3
   *  Это позволяет одному Dice3DPhysicsCanvas рендерить 4*N кубиков, каждый
   *  из своей сессии. pushSnapshot при приёме трансформа смещает die.i на
   *  baseIndex соответствующей сессии. */
  pendingPhysicsSessions?: Array<{
    sessionId: string;
    participantId: string;
    presetId?: string;
    /** 'near' = со стороны игрока (+Z), 'far' = с противоположной (−Z). */
    originSide: 'near' | 'far';
    /** Lateral offset of the spawn cup in physics units (default 0).
     *  Used to spread multiple sessions horizontally so dice don't overlap
     *  when N participants throw simultaneously (zonal mass-roll).
     *  Server (physics-service) uses this as `cupX` for the spawn position
     *  only — the throw velocity (vx) stays at 0, dice still fly forward. */
    originX?: number;
    /** true — event получен по сети (см. pendingPhysics.isRemote). */
    isRemote?: boolean;
  }> | null;
  /** ── Summary-only event (без 3D-анимации) ──
   *  Когда true — overlay НЕ монтирует ни ServerDiceStage, ни Dice3DCanvas.
   *  Показывается ТОЛЬКО CompactResultStrip с финальными результатами.
   *  Используется для «Записать в лог» в массовой атаке: кубики УЖЕ были
   *  брошены и показаны в фазах attack/defend (с реальной физикой), повторно
   *  анимировать их не нужно — это вызывало «выпрыгивание» 3D кубов со
   *  старой логикой (face-snapping под заранее определённый результат). */
  isSummary?: boolean;
  /** ── 2D-физика (локальная, для diceMode='2d') ──
   *  Полный аналог pendingPhysics, но для 2D-режима. Когда установлен,
   *  overlay запускает локальный 2D-движок (dice-2d-physics) вместо
   *  server-authoritative Rapier3D. Результат приходит асинхронно через
   *  `applyPhysicsResult` (тот же store-action, что и для 3D — резолвит
   *  promise в runRollWith2DPhysics).
   *
   *  Координаты — пиксели относительно карты (0,0 = верх-лево), а НЕ
   *  физ. единицы (как в pendingPhysics). direction — угол в screen-coords
   *  (0=вправо, π/2=вниз), как directionAngle в RollGesture.
   *
   *  initialFaces — текущие грани удерживаемых 2D-плиток из drag-контроллера
   *  (бесшовный handoff: кубы кувыркались в руке, их грани и есть стартовая
   *  точка для 2D-физики). */
  pending2DPhysics?: {
    sessionId: string;
    participantId: string;
    presetId?: string;
    /** Стартовая позиция на карте в px (центр стакана). */
    spawnX?: number;
    spawnY?: number;
    /** Направление полёта в рад (0=вправо, π/2=вниз, screen-coords). */
    direction?: number;
    /** Базовая скорость в px/с (масштабируется пресетом). */
    speed?: number;
    /** Начальные грани (из drag-контроллера). */
    initialFaces?: Array<1 | 0 | -1>;
    /** Начальные позиции (для бесшовного handoff). */
    initialPositions?: Array<{ x: number; y: number }>;
    /** Начальные скорости (для бесшовного handoff). */
    initialVelocities?: Array<{ vx: number; vy: number }>;
    /** Drop-позиция в screen-координатах (для логирования). */
    dropX?: number;
    dropY?: number;
    /** Seed для детерминированного реплея на remote-клиентах (mulberry32).
     *  Originator генерирует seed, remote-клиенты создают PRNG с тем же seed →
     *  идентичная анимация (те же позиции/грани/скорости). */
    seed?: number;
    /** Удалённый бросок (получен от пира через P2P). Remote-клиент НЕ вызывает
     *  applyResult (результат уже определён originator'ом и придёт через log-entry),
     *  только рендерит анимацию через seeded PRNG. */
    isRemote?: boolean;
  } | null;
}

// Default adventure settings
export const DEFAULT_SETTINGS: AdventureSettings = {
  baseSkills: [
    'Атлетика', 'Бой', 'Верховая езда', 'Взаимопонимание',
    'Внимательность', 'Воля', 'Воровство', 'Знания',
    'Контакты', 'Обман', 'Провокация', 'Расследование',
    'Ремесло', 'Ресурсы', 'Скрытность', 'Стрельба',
    'Телосложение', 'Эмпатия',
  ],
  initiative: {
    mode: 'book',
    physical: { primary: 'Внимательность', secondary: 'Атлетика', tertiary: 'Телосложение' },
    mental: { primary: 'Эмпатия', secondary: 'Взаимопонимание', tertiary: 'Воля' },
  },
  modules: { magic: false },
};
