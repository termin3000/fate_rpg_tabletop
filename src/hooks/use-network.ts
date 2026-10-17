'use client';

/**
 * useNetwork — P2P WebRTC networking hook for the Fate RPG VTT.
 *
 * Star topology: the GM (host) is the central node and every player maintains
 * a single direct RTCPeerConnection to the host. The signaling mini-service
 * on port 3004 (proxied by Caddy as `/?XTransformPort=3004`) only relays
 * SDP/ICE messages and room metadata — it never touches game state itself.
 *
 * The host owns the canonical game state. Players request an initial snapshot
 * via the `state:sync` socket event (server relays to the host) and then
 * receive incremental updates over their DataChannel via `broadcastAction`.
 *
 * DataChannel wire format (JSON):
 *   { type: 'action' | 'state' | 'assignment', payload: ... }
 *
 *   - 'action'     → host → player; an incremental state mutation
 *   - 'state'      → host → player; a full state snapshot (replaces state)
 *   - 'assignment' → host → player; a character assignment update
 */

import { useCallback, useEffect, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { useFateStore, setSuppressSceneBroadcast, setSuppressCharacterBroadcast } from '@/lib/store';
import { rollFateDice, sumFateDice } from '@/lib/fate-dice';
import type { LiveRollEvent } from '@/lib/types';
import { clearNetworkSession, loadNetworkSession, saveNetworkSession } from '@/lib/network-session';

// ── Types ───────────────────────────────────────────────────
type SignalType = 'offer' | 'answer' | 'ice';

interface SignalData {
  type: SignalType;
  data: RTCSessionDescriptionInit | RTCIceCandidateInit;
}

interface SignalPayload {
  toPeerId: string;
  fromPeerId: string;
  data: SignalData;
}

interface PlayerJoinedPayload {
  peerId: string;
  displayName: string;
}

interface PeerLeftPayload {
  peerId: string;
  role: 'host' | 'player';
}

interface HostStatusPayload {
  isHostOnline: boolean;
}

interface AssignmentUpdatePayload {
  peerId: string;
  characterIds: string[];
}

interface StateSyncPayload {
  snapshot?: StateSnapshot;
}

interface StateSnapshot {
  adventures?: unknown[];
  characters?: unknown[];
  scenes?: unknown[];
  logEntries?: unknown[];
  items?: unknown[];
  settings?: unknown;
  currentAdventureId?: string | null;
  currentSceneId?: string | null;
  /** Character assignments: peerId → list of characterIds. Included so
   *  players receive existing assignments when they join/reconnect —
   *  without this, the master's pre-existing assignments never reach
   *  the player (the assignment:update event only fires on NEW assigns). */
  playerAssignments?: Record<string, string[]>;
}

interface BroadcastAction {
  kind: string;
  payload?: unknown;
}

interface DataChannelMessage {
  type: 'action' | 'state' | 'assignment' | 'ping' | 'pong' | 'sync-roll-request' | 'sync-roll-result' | 'cursor-move' | 'cursor-leave' | 'mass-roll-invite' | 'mass-roll-ready' | 'mass-roll-unready' | 'mass-roll-start' | 'mass-roll-result' | 'mass-roll-cancel' | 'mass-roll-results' | 'mass-roll-reroll' | 'mass-roll-adjust' | 'roll-stage' | 'log-entry' | 'dice-colors';
  payload: unknown;
}

/** Payload for 'dice-colors' — a player announces their chosen dice palette.
 *  Recipients store it in peerDiceColors[fromPeerId] so they can render that
 *  player's rolls in their colors. Sent on color change and on initial connect. */
interface DiceColorsPayload {
  fromPeerId: string;
  diceColor: string;
  symbolColor: string;
  ts: number;
}

/** Payload for ping/pong messages — the timestamp the sender captured. */
interface PingPongPayload {
  ts: number;
}

/** Host → player: request a synchronous dice roll. */
interface SyncRollRequestPayload {
  id: string;
  skillName: string;
  skillValue: number;
  bonus: number;
  difficulty: number | null;
  countdownSec: number;
  deadlineTs: number;
}

/** Player → host: my roll result for a sync-roll session. */
interface SyncRollResultPayload {
  id: string;
  peerId: string;
  peerName: string;
  characterId: string | null;
  characterName: string;
  skillName: string;
  skillValue: number;
  dice: number[];
  bonus: number;
  total: number;
  resultLabel: string;
  ts: number;
}

// ── Unified Mass Roll payloads ────────────────────────────
/** Host → player: invite to participate in a mass-roll session. The player
 *  should open RollInvitationDialog showing the skill, difficulty, and their
 *  resolved skill value + any GM overrides. Player marks ready when prepared. */
interface MassRollInvitePayload {
  sessionId: string;
  mode: 'normal' | 'difficulty' | 'opposed';
  skillName: string;
  bonus: number;
  difficulty: number | null;
  // Opponent data (mode='opposed')
  opponentName?: string;
  opponentTotal?: number;
  // This player's character + resolved skill (with GM overrides applied)
  characterId: string;
  characterName: string;
  skillNameOverride?: string;  // if GM changed skill for this char
  skillValue: number;
  manualBonus: number;         // GM-applied bonus (from stunts)
}

/** Player → host: I'm ready (or unready). Includes fate point choice. */
interface MassRollReadyPayload {
  sessionId: string;
  characterId: string;
  ready: boolean;
  fatePointMode: 'none' | 'plus2' | 'reroll';
  fatePointReason?: string;
}

/** Host → player: roll starts now (everyone ready, or GM force-started).
 *  Player should auto-roll and send back the result. */
interface MassRollStartPayload {
  sessionId: string;
}

/** Player → host: my roll result for a mass-roll session. */
interface MassRollResultPayload {
  sessionId: string;
  characterId: string;
  dice: number[];
  diceSum: number;
  total: number;
  resultLabel: string;
  usedReroll: boolean;
  /** Player's dice colors (snapshot) — host stores in peerDiceColors + stamps
   *  onto MassRollResultsPayload so all players render this roll in the
   *  roller's palette. Optional for backward compat. */
  diceColor?: string;
  symbolColor?: string;
}

/** Host → player: session cancelled (GM aborted or finalized). Player should
 *  close RollInvitationDialog. */
interface MassRollCancelPayload {
  sessionId: string;
}

/** Host → players: broadcast the full participants list with results, so every
 *  player can see all rolls (not just their own). Sent after each result
 *  arrives, after force-start, and after any post-roll adjustment (reroll,
 *  +2 bonus, free invoke). Also carries opponent info for opposed mode. */
interface MassRollResultsPayload {
  sessionId: string;
  status: 'inviting' | 'rolling' | 'complete';
  participants: Array<{
    characterId: string;
    characterName: string;
    characterType: 'pc' | 'npc';
    peerId: string | null;
    skillName: string;
    skillValue: number;
    manualBonus: number;
    ready: boolean;
    fatePointMode: 'none' | 'plus2' | 'reroll';
    fatePointReason?: string;
    /** Roller's dice colors (snapshot). Host stamps from peerDiceColors map
     *  (or its own colors for host-side NPCs). Players copy onto
     *  LiveRollParticipant so each participant's dice render in their palette. */
    diceColor?: string;
    symbolColor?: string;
    result?: {
      dice: number[];
      diceSum: number;
      total: number;
      resultLabel: string;
      usedReroll?: boolean;
      rerollCount?: number;
      bonusCount?: number;
      freeInvokeCount?: number;
      history?: Array<{ type: 'initial' | 'reroll' | 'plus2' | 'free-invoke'; ts: number }>;
    };
  }>;
  // Opponent info (mode='opposed') — kept fresh in case GM pre-rolled.
  opponentName?: string;
  opponentTotal?: number;
  opponentSkillName?: string;
  opponentDice?: number[];
}

/** Player → host: I want to reroll my dice (spending a fate point). Only valid
 *  after the initial roll has happened. Host validates fate point availability,
 *  deducts it, re-rolls, and broadcasts the updated results.
 *  DEPRECATED: superseded by MassRollAdjustPayload (mode='reroll'). Kept for
 *  backward compat — old callers still send this message type. */
interface MassRollRerollPayload {
  sessionId: string;
  characterId: string;
  reason?: string;
}

/** Player → host: I want to adjust my roll result post-roll. Three modes:
 *  - 'reroll': spend 1 fate point, re-roll the dice (replaces dice + diceSum).
 *  - 'plus2': spend 1 fate point, add +2 to total.
 *  - 'free-invoke': no fate point cost, add +2 to total (from a free invocation
 *    on an aspect created with Create an Advantage).
 * Multiple adjustments are allowed — one fate point per reroll/plus2. Host
 * validates fate points, applies the adjustment, updates history, broadcasts. */
interface MassRollAdjustPayload {
  sessionId: string;
  characterId: string;
  mode: 'reroll' | 'plus2' | 'free-invoke';
  reason?: string;
}

/** Either side → other side: my cursor moved on the map. */
interface CursorMovePayload {
  peerId: string;
  name: string;
  color: string;
  x: number;
  y: number;
  ts: number;
}

/** Either side → other side: my cursor left the map area. */
interface CursorLeavePayload {
  peerId: string;
}

// ── Constants ───────────────────────────────────────────────
/**
 * ICE server configuration for WebRTC peer connections.
 *
 * Layered strategy (browser tries them in order, picks the first that works):
 *
 *  1. Google STUN — fast, free, sufficient when at least one peer is on a
 *     network without symmetric NAT (e.g. home Wi-Fi, same-LAN dev).
 *
 *  2. OpenRelay STUN/TURN (openrelay.metered.ca) — free public TURN relay
 *     provided by Metered. Used when STUN alone cannot establish a direct
 *     path. Covers ~80% of "hard" NAT scenarios:
 *       - symmetric NAT on either side
 *       - carrier-grade NAT (mobile networks)
 *       - strict corporate firewalls
 *     Multiple transports (UDP → TCP → TLS) are tried automatically.
 *
 *     Credentials are publicly shared by Metered for open use; no secret.
 *     See: https://www.metered.ca/openrelay/
 *
 *  3. STUN on port 80 — fallback when 19302 is blocked outbound.
 *
 * Notes:
 *   - TURN is only used as a last resort — direct P2P is preferred whenever
 *     possible for latency and bandwidth.
 *   - This configuration is read once per RTCPeerConnection creation in
 *     ensureSocket → createHostPeer / createPlayerPeer.
 */
const ICE_SERVERS: RTCConfiguration = {
  iceServers: [
    // Primary STUN — fastest, no auth needed
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },

    // OpenRelay STUN (port 80 fallback when 19302 blocked)
    { urls: 'stun:openrelay.metered.ca:80' },

    // OpenRelay TURN — UDP (preferred for low latency)
    {
      urls: 'turn:openrelay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    // OpenRelay TURN — TCP (when UDP is blocked)
    {
      urls: 'turn:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    // OpenRelay TURN — TLS (most restrictive firewalls, slowest)
    {
      urls: 'turns:openrelay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  // Prefer peer-reflexive / host candidates; only fall back to relay when
  // direct connectivity fails. This keeps latency low when possible.
  iceTransportPolicy: 'all',
};

/**
 * Signaling URL discovery.
 *
 * The signaling server runs on port 3004. How the browser reaches it depends
 * on where the user opened the page:
 *
 *  A. Local dev (browser opens http://localhost:3000 or :81 directly on the
 *     same machine as the dev server): the browser can reach localhost:3004
 *     directly — fastest, no proxy in the path. Falls back to localhost:81
 *     (Caddy gateway with XTransformPort=3004) if 3004 is firewalled.
 *
 *  B. Preview / production (browser opens the deployed domain — e.g. the
 *     web preview pane): localhost is NOT reachable (it refers to the user's
 *     machine, not the server). The only working path is the current origin
 *     + Caddy gateway, with `?XTransformPort=3004` so Caddy proxies to
 *     localhost:3004. We pass `window.location.origin` as the socket.io URL
 *     and set `query: { XTransformPort: '3004' }` — socket.io then opens
 *     `${origin}/socket.io/?XTransformPort=3004&EIO=4&...` which Caddy
 *     routes correctly.
 *
 * The old "relative path" strategy (`io('/?XTransformPort=3004')`) was
 * broken: socket.io-client treats the URL's path portion as the socket.io
 * endpoint path (replacing the default `/socket.io/`), so the handshake
 * never reached Caddy's XTransformPort rule. Using origin + query option
 * is the correct pattern.
 */
const SIGNALING_PATHS = {
  // Caddy gateway on port 81 — works in sandbox/agent-browser where browser
  // opens localhost:3000 directly. Port 81 is reachable and Caddy proxies
  // XTransformPort=3004 to localhost:3004.
  gateway81: 'http://localhost:81',
  // Direct localhost:3004 — for local dev (browser on same machine).
  direct: 'http://localhost:3004',
};

let _resolvedSignalingUrl: string | null = null;
let _resolvedSignalingUseQuery = false;

async function probeSignaling(url: string, useXTransformPort: boolean): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    // Build the socket.io polling handshake URL.
    // For absolute URLs (direct or gateway:81) the socket.io endpoint is
    // `${url}/socket.io/`. For the origin-only case (preview/production)
    // we also use `${url}/socket.io/` — socket.io's default endpoint path.
    const query = useXTransformPort
      ? '?EIO=4&transport=polling&XTransformPort=3004'
      : '?EIO=4&transport=polling';
    const probeUrl = `${url.replace(/\/$/, '')}/socket.io/${query}`;
    const r = await fetch(probeUrl, { signal: ctrl.signal, method: 'GET' });
    clearTimeout(t);
    if (!r.ok) return false;
    const text = await r.text();
    // socket.io polling handshake returns: 0{"sid":"...","upgrades":["websocket"],...}
    return text.startsWith('0{') && text.includes('"sid"');
  } catch {
    return false;
  }
}

async function resolveSignalingUrl(): Promise<string> {
  if (_resolvedSignalingUrl) return _resolvedSignalingUrl;

  // Determine if we're in a local-dev context (browser on same machine as
  // the signaling server) or a remote-preview/production context.
  const hostname = typeof window !== 'undefined' ? window.location.hostname : '';
  const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';

  // Select the public origin synchronously, before ensureSocket creates its
  // first connection. A remote browser must never briefly connect to its
  // own localhost while an asynchronous discovery probe is in flight.
  if (!isLocalhost || window.location.port === '3008') {
    _resolvedSignalingUrl = window.location.origin;
    _resolvedSignalingUseQuery = true;
    return _resolvedSignalingUrl;
  }

  if (isLocalhost) {
    // Strategy 0: direct localhost:3004 (browser on same host — fastest, most
    // reliable, no gateway proxy in the path). This is the preferred path in
    // the sandbox/agent-browser environment where the browser and signaling
    // server run on the same machine.
    if (await probeSignaling(SIGNALING_PATHS.direct, false)) {
      _resolvedSignalingUrl = SIGNALING_PATHS.direct;
      _resolvedSignalingUseQuery = false;
      console.info('[net] signaling via direct localhost:', _resolvedSignalingUrl);
      return _resolvedSignalingUrl;
    }

    // Strategy 1: Caddy gateway on port 81 (sandbox/agent-browser fallback)
    if (await probeSignaling(SIGNALING_PATHS.gateway81, true)) {
      _resolvedSignalingUrl = SIGNALING_PATHS.gateway81;
      _resolvedSignalingUseQuery = true;
      console.info('[net] signaling via gateway :81:', _resolvedSignalingUrl);
      return _resolvedSignalingUrl;
    }
  }

  // Strategy 2 (preview/production): use the current origin + XTransformPort
  // query. Caddy on the preview domain routes `?XTransformPort=3004` to
  // localhost:3004. This is the ONLY working path when the browser is remote
  // (localhost is the user's machine, not the server).
  //
  // We probe first to give early feedback if it's broken, but we use this
  // strategy unconditionally for non-localhost origins — there's no other
  // option, and the probe can fail due to CORS even when socket.io itself
  // works (socket.io-client doesn't rely on the fetch probe).
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  if (origin) {
    const ok = await probeSignaling(origin, true);
    _resolvedSignalingUrl = origin;
    _resolvedSignalingUseQuery = true;
    console.info(`[net] signaling via origin (${ok ? 'probe ok' : 'probe failed, using anyway'}):`, _resolvedSignalingUrl);
    return _resolvedSignalingUrl;
  }

  // Last resort: try the gateway URL anyway. Better than nothing — server
  // might be reachable from the user's network even if our probe failed
  // (e.g. due to CORS on the fetch).
  _resolvedSignalingUrl = SIGNALING_PATHS.gateway81;
  _resolvedSignalingUseQuery = true;
  console.warn('[net] signaling probes failed — defaulting to', _resolvedSignalingUrl);
  return _resolvedSignalingUrl;
}

/** Characters allowed in a generated room code (no ambiguous 0/O, 1/I). */
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Generate a 6-char alphanumeric room code. */
export function genRoomCode(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return out;
}

// ── Module-level singleton ─────────────────────────────────
// CRITICAL: useNetwork() is called from multiple components (game-canvas,
// network-dialog, sync-roll-dialog). If these used component-level useRef,
// each instance would get its own empty socket/peer/channel maps — so a
// dialog opened AFTER hosting would have no data channels and broadcasts
// would silently go nowhere. By keeping all networking state at module
// level, every useNetwork() caller shares the same connection.
const _net = {
  socket: null as Socket | null,
  /** peerId → RTCPeerConnection (host: one per player; player: single entry for host). */
  peers: new Map<string, RTCPeerConnection>(),
  /** peerId → RTCDataChannel used for game state traffic. */
  dataChannels: new Map<string, RTCDataChannel>(),
  /** Tracks the active role so cleanup knows how to restore `currentMode`. */
  role: null as 'host' | 'player' | null,
  /** Cached ensureSocket impl — set once, reused by all callers. */
  ensureSocketImpl: null as (() => Socket) | null,
  /** Refs to hostRoom/joinRoom — set after declaration, used by ensureSocket
   *  to re-establish listeners after socket recreation. */
  hostRoomFn: null as ((roomId: string, displayName: string) => void) | null,
  joinRoomFn: null as ((roomId: string, displayName: string) => void) | null,
  /** Ref to broadcastAssignment — set after declaration, used by hostRoom's
   *  player:joined handler to re-broadcast pre-existing assignments. Using
   *  a ref avoids the forward-reference problem (broadcastAssignment is
   *  declared after hostRoom in the hook body). */
  broadcastAssignmentFn: null as ((peerId: string, characterIds: string[]) => void) | null,
  /** Player-side: timer for the delayed host-left close. When the host's
   *  signaling socket blips, we don't immediately close the RTCPeerConnection
   *  — we wait 8s for the host to reconnect (host:joined cancels the timer).
   *  This keeps the WebRTC alive across signaling blips. */
  hostLeftCloseTimer: null as ReturnType<typeof setTimeout> | null,
  adventureLoad: null as Promise<void> | null,
  adventureLoadId: null as string | null,
  loadedAdventureId: null as string | null,
  snapshotVersion: 0,
};

// ── Hook ────────────────────────────────────────────────────
export function useNetwork() {

  const ensureSocket = useCallback((): Socket => {
    if (_net.ensureSocketImpl) return _net.ensureSocketImpl();

    const impl = (): Socket => {
      if (_net.socket) return _net.socket;

      // Kick off URL resolution. When resolved, if it's different from what
      // we initially used, recreate the socket. After recreation, if we
      // have a pending room:join (because hostRoom/playerJoinRoom was called
      // before the socket connected), re-emit it.
      if (!_resolvedSignalingUrl) {
        void resolveSignalingUrl().then((resolvedUrl) => {
          if (!_net.socket) return;
          const currentIo = (_net.socket as any).io;
          const currentUri: string = (currentIo?.uri as string | undefined) ?? '';
          // Compare the base URL the socket is currently using against the
          // resolved URL. We extract the origin+host:port portion because
          // socket.io's io.uri may include or exclude the query string
          // depending on version/transport — comparing just the base is
          // reliable. If they differ, recreate the socket with the resolved
          // URL so we use the best available path.
          const normalizeUrl = (u: string): string => {
            try {
              // Strip query string and trailing slash for comparison
              return u.split('?')[0].replace(/\/$/, '');
            } catch {
              return u;
            }
          };
          const currentNorm = normalizeUrl(currentUri);
          const resolvedNorm = normalizeUrl(resolvedUrl);
          if (currentNorm !== resolvedNorm) {
            console.info('[net] recreating socket — was:', currentNorm, 'now:', resolvedNorm);
            try {
              // Clear the application-level heartbeat interval and watchdog
              // before discarding the old socket — otherwise they would keep
              // firing on a dead socket reference.
              const oldSock = _net.socket as any;
              if (oldSock?._heartbeatInterval) clearInterval(oldSock._heartbeatInterval);
              if (oldSock?._clearHeartbeatWatchdog) oldSock._clearHeartbeatWatchdog();
              _net.socket.removeAllListeners();
              _net.socket.disconnect();
            } catch { /* ignore */ }
            _net.socket = null;
            impl();
            // After recreation, if we were already hosting/joined, re-run
            // hostRoom/joinRoom to re-register all the event listeners and
            // re-emit room:join. Without this, the new socket has no
            // listeners for `player:joined`, `signal`, etc., and we'd lose
            // all P2P traffic after a URL resolution swap.
            const role = _net.role;
            const store = useFateStore.getState();
            const roomId = store.networkRoomId;
            const displayName = store.networkMyDisplayName;
            if (role === 'host' && roomId && _net.hostRoomFn) {
              console.info('[net] re-hosting after recreate', { roomId });
              // Use setTimeout to avoid recursion during the current
              // resolveSignalingUrl callback.
              setTimeout(() => _net.hostRoomFn?.(roomId, displayName), 0);
            } else if (role === 'player' && roomId && _net.joinRoomFn) {
              console.info('[net] re-joining after recreate', { roomId });
              setTimeout(() => _net.joinRoomFn?.(roomId, displayName), 0);
            }
          }
        });
      }

      // Use the resolved URL if available, otherwise default to direct
      // localhost:3004 (the preferred path in sandbox/dev where the browser
      // is on the same machine as the signaling server). If resolution
      // later picks a different URL, the recreate logic above handles it.
      const url = _resolvedSignalingUrl ?? SIGNALING_PATHS.direct;
      useFateStore.getState().setNetworkSignalingStatus('connecting');
      const sockOpts: Record<string, unknown> = {
        // WebSocket transport. The Caddy reverse_proxy (port 81 → 3004)
        // closes any single WebSocket/polling connection after ~30s, but
        // socket.io's automatic reconnection (reconnection: true) opens a
        // new connection within 500ms. The application-level heartbeat
        // (below) keeps the connection alive within each 30s window; when
        // Caddy inevitably closes it, socket.io reconnects transparently.
        // The host's room:join is re-emitted on reconnect (see the
        // 'reconnect' handler below), so the signaling server re-registers
        // the host and re-sends the existing-players list — the GM's peer
        // list is preserved across the reconnect cycle.
        transports: ['websocket'],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 500,
        reconnectionDelayMax: 3000,
        timeout: 10000,
        pingTimeout: 120000,
      };
      // Для gateway:81 нужен XTransformPort query (Caddy проксирует на 3004).
      // Для relative URL '/?XTransformPort=3004' query уже в URL.
      // Для direct localhost:3004 query не нужен.
      if (_resolvedSignalingUseQuery) {
        sockOpts.query = { XTransformPort: '3004' };
      }
      const sock = io(url, sockOpts as any);

      // ── Reconnect / lifecycle logging ──────────────────────
      // These are diagnostic-only; they help trace connectivity issues
      // across host/player tabs without a separate debugger.
      sock.on('connect', () => {
        console.info('[net] socket connected — id:', sock.id, 'url:', url);
        useFateStore.getState().setNetworkSignalingStatus('online');
      });
      sock.on('disconnect', (reason: string) => {
        console.warn('[net] socket disconnected — reason:', reason);
        // If server-side closed us, peers will go stale. Player UI will
        // show "reconnecting…" via onDisconnect handler below.
        useFateStore.getState().setNetworkSignalingStatus('offline');

        // ── Manual reconnect fallback ──────────────────────────
        // Socket.io's built-in reconnection sometimes fails to trigger
        // after `transport close` (which the Caddy reverse_proxy emits
        // every ~30s when it idle-closes the WebSocket). Without this
        // manual fallback, the host's socket would stay disconnected
        // after the first Caddy-imposed close, making the GM unable to
        // see players joining. We schedule a reconnect attempt after a
        // short delay; if the built-in reconnection already kicked in,
        // this is a harmless no-op (sock.connect() on an already-open
        // socket is safe).
        if (reason === 'transport close' || reason === 'transport error' || reason === 'ping timeout') {
          setTimeout(() => {
            if (!sock.connected) {
              console.info('[net] manual reconnect attempt after', reason);
              try {
                sock.connect();
              } catch (e) {
                console.warn('[net] manual reconnect failed:', e);
              }
            }
          }, 1500);
        }
      });
      sock.on('connect_error', (err: Error) => {
        // Common during dev: signaling server down, or browser cannot
        // reach port 3004 via gateway. Will retry per reconnection opts.
        console.warn('[net] socket connect_error:', err.message, 'url:', url);
        useFateStore.getState().setNetworkSignalingStatus('error');
      });
      sock.io.on('reconnect_attempt', (attempt: number) => {
        console.info('[net] reconnect attempt #' + attempt);
        useFateStore.getState().setNetworkSignalingStatus('connecting');
      });
      sock.io.on('reconnect', (attempt: number) => {
        console.info('[net] reconnect succeeded after ' + attempt + ' attempt(s)');
        useFateStore.getState().setNetworkSignalingStatus('online');
      });
      sock.io.on('reconnect_failed', () => {
        console.error('[net] reconnect failed — gave up after max attempts');
        useFateStore.getState().setNetworkSignalingStatus('error');
      });

      // ── Application-level heartbeat with dead-connection detection ──
      // The Caddy reverse_proxy (port 81 → 3004) closes WebSocket
      // connections after ~12-30s, but does so SILENTLY — the browser
      // never receives a WebSocket onClose event, so socket.io's
      // built-in disconnect detection never fires. The client thinks
      // the connection is alive long after Caddy has dropped it.
      //
      // We work around this with an application-level heartbeat: every
      // 8s we emit a 'heartbeat' event; the server immediately responds
      // with 'heartbeat:ack'. If we don't receive an ack within 6s, we
      // assume the connection is dead (Caddy closed it silently) and
      // forcibly reconnect. This is more reliable than relying on
      // WebSocket ping/pong frames (which Caddy may also drop silently)
      // or socket.io's built-in ping timeout (which requires the onClose
      // event to fire first).
      let pendingHeartbeatTs: number | null = null;
      let heartbeatWatchdog: NodeJS.Timeout | null = null;

      const clearHeartbeatWatchdog = () => {
        if (heartbeatWatchdog) {
          clearTimeout(heartbeatWatchdog);
          heartbeatWatchdog = null;
        }
        pendingHeartbeatTs = null;
      };

      sock.on('heartbeat:ack', (data: { serverTs?: number; clientTs?: number }) => {
        // Got an ack — connection is alive. Reset the watchdog.
        if (pendingHeartbeatTs !== null) {
          const rtt = data.serverTs ? Date.now() - (data.serverTs as number) : null;
          console.info('[net] heartbeat ack received', rtt ? `rtt~${rtt}ms` : '');
          clearHeartbeatWatchdog();
        }
      });

      const heartbeatInterval = setInterval(() => {
        if (!sock.connected) return;
        // If we still have a pending heartbeat from last cycle, the
        // connection is dead (Caddy closed it silently). Force reconnect.
        if (pendingHeartbeatTs !== null) {
          console.warn('[net] heartbeat ack timed out — forcing reconnect (Caddy silent close)');
          clearHeartbeatWatchdog();
          try {
            sock.disconnect();
            // socket.io will auto-reconnect (reconnection: true). But just
            // in case, schedule a manual reconnect as a fallback.
            setTimeout(() => {
              if (!sock.connected) {
                console.info('[net] manual reconnect after heartbeat timeout');
                try { sock.connect(); } catch { /* ignore */ }
              }
            }, 800);
          } catch (e) {
            console.warn('[net] disconnect failed:', e);
          }
          return;
        }
        // Send a new heartbeat and arm the watchdog.
        pendingHeartbeatTs = Date.now();
        sock.volatile.emit('heartbeat', { ts: pendingHeartbeatTs });
        heartbeatWatchdog = setTimeout(() => {
          // Watchdog fired — no ack within 6s. Force reconnect on next
          // heartbeat cycle (the pendingHeartbeatTs check above will
          // catch it). We don't reconnect immediately here to avoid
          // double-reconnect if the ack was just delayed.
          console.warn('[net] heartbeat watchdog fired (no ack in 6s)');
        }, 6000);
      }, 8000);

      // Clean up on socket teardown.
      (sock as any)._heartbeatInterval = heartbeatInterval;
      (sock as any)._clearHeartbeatWatchdog = clearHeartbeatWatchdog;

      _net.socket = sock;
      return sock;
    };

    _net.ensureSocketImpl = impl;
    return impl();
  }, []);

  // ── Peer connection teardown ──────────────────────────────
  const closePeer = useCallback((peerId: string) => {
    const ch = _net.dataChannels.get(peerId);
    if (ch) {
      try { ch.close(); } catch { /* ignore */ }
      _net.dataChannels.delete(peerId);
    }
    const pc = _net.peers.get(peerId);
    if (pc) {
      try { pc.close(); } catch { /* ignore */ }
      _net.peers.delete(peerId);
    }
  }, []);

  const closeAllPeers = useCallback(() => {
    for (const id of Array.from(_net.peers.keys())) closePeer(id);
  }, [closePeer]);

  // ── State snapshot helpers ────────────────────────────────
  const buildSnapshot = useCallback((): StateSnapshot => {
    const s = useFateStore.getState();
    // ── MINIMAL snapshot — players already load full data from the API ──
    //
    // Previously this sent ALL adventures, characters, scenes, items, and
    // settings. For a real game with multiple scenes and characters that
    // easily exceeds 100KB — well beyond the WebRTC DataChannel's ~16KB
    // max message size, which caused `RTCDataChannel.send` to throw and
    // fall back to an even-slower signaling-server relay. That relay is
    // the source of the "incredible latency even on localhost" bug: the
    // snapshot goes host → signaling server → player, serialized as one
    // giant JSON blob over a WebSocket that has no flow control.
    //
    // The player's page load ALREADY fetches the full adventure/scene/
    // character data from the REST API (see page.tsx's loadAdventures /
    // loadScenes / loadCharacters calls). So the snapshot only needs to
    // carry:
    //   • currentAdventureId / currentSceneId — so the player's UI opens
    //     the same adventure + scene the GM is looking at.
    //   • playerAssignments — so the player knows which PCs they control
    //     (this isn't derivable from the API; only the host knows it).
    //   • settings — GM-configured settings the player needs (dice mode,
    //     magic module flag, etc.). Small object, safe to send.
    //
    // After the snapshot, real-time scene/character updates flow via the
    // broadcastSceneUpdate / broadcastCharacterUpdate DataChannel messages
    // (registered above) — those are small (one scene's diff, not all
    // scenes) and go peer-to-peer, not through the signaling server.
    return {
      currentAdventureId: s.currentAdventureId,
      currentSceneId: s.currentSceneId,
      playerAssignments: s.playerAssignments,
      settings: s.settings,
    };
  }, []);

  const applySnapshot = useCallback(async (snapshot: StateSnapshot) => {
    const version = ++_net.snapshotVersion;
    const adventureId = snapshot.currentAdventureId;
    // A fresh browser (including a new localtunnel origin) has no selected
    // adventure. The minimal snapshot carries IDs, not scene/character data.
    // Hydrate those through the shared-origin API before applying host state.
    if (adventureId) {
      const store = useFateStore.getState();
      if (store.currentAdventureId !== adventureId || (_net.loadedAdventureId !== adventureId && !store.scenes.some(scene => scene.adventureId === adventureId))) {
        if (!_net.adventureLoad || _net.adventureLoadId !== adventureId) {
          const previous = _net.adventureLoad;
          _net.adventureLoadId = adventureId;
          _net.adventureLoad = (async () => {
            await previous?.catch(() => {});
            if (!useFateStore.getState().adventures.some(adventure => adventure.id === adventureId)) {
              await useFateStore.getState().loadAdventures();
            }
            await useFateStore.getState().switchAdventure(adventureId);
            if (_net.role === 'player') _net.loadedAdventureId = adventureId;
          })();
        }
        const loading = _net.adventureLoad;
        try {
          await loading;
        } catch (error) {
          console.warn('[net/player] Failed to load host adventure after retries:', error);
          toast.error('Не удалось загрузить приключение мастера. Переподключитесь к комнате.');
          return;
        } finally {
          if (_net.adventureLoad === loading) _net.adventureLoad = null;
        }
      }
    }
    if (version !== _net.snapshotVersion || _net.role !== 'player') return;
    const patch: Record<string, unknown> = {};
    if (snapshot.characters) patch.characters = snapshot.characters;
    if (snapshot.scenes) patch.scenes = snapshot.scenes;
    if (snapshot.logEntries) patch.logEntries = snapshot.logEntries;
    if (snapshot.items) patch.items = snapshot.items;
    if (snapshot.settings) patch.settings = snapshot.settings;
    if (snapshot.currentAdventureId !== undefined) patch.currentAdventureId = snapshot.currentAdventureId;
    if (snapshot.currentSceneId !== undefined) patch.currentSceneId = snapshot.currentSceneId;
    if (snapshot.currentSceneId) {
      const scene = useFateStore.getState().scenes.find(scene => scene.id === snapshot.currentSceneId);
      if (scene) patch.currentFloorIndex = scene.playerFloorIndex ?? 0;
    }
    // Apply playerAssignments ONLY if the snapshot actually carries them.
    // We MERGE with existing local assignments (snapshot takes priority for
    // keys it defines) so we don't wipe assignments that arrived via a
    // real-time assignment:update event just before this snapshot.
    if (snapshot.playerAssignments && typeof snapshot.playerAssignments === 'object') {
      const existing = useFateStore.getState().playerAssignments ?? {};
      patch.playerAssignments = { ...existing, ...snapshot.playerAssignments };
    }
    if (Object.keys(patch).length > 0) {
      useFateStore.setState(patch);
    }
  }, []);

  // ── Player side: apply inbound actions from the host ──────
  // IMPORTANT: while applying a remote scene/character update, we set the
  // store's suppression flag so the local updateScene/updateCharacter
  // doesn't re-broadcast the change (which would echo back to the sender
  // and cause an infinite loop: host → player → host → ...).
  const applyAction = useCallback((action: BroadcastAction) => {
    const store = useFateStore.getState();
    switch (action.kind) {
      case 'character:update': {
        const p = action.payload as { id: string; data: Record<string, unknown> };
        // Suppress re-broadcast while applying the remote update.
        setSuppressCharacterBroadcast(true);
        try {
          store.updateCharacter(p.id, p.data);
        } finally {
          setSuppressCharacterBroadcast(false);
        }
        break;
      }
      case 'character:delete': {
        const p = action.payload as { id: string };
        store.deleteCharacter(p.id);
        break;
      }
      case 'scene:update': {
        const p = action.payload as { id: string; data: Record<string, unknown> };
        setSuppressSceneBroadcast(true);
        try {
          store.updateScene(p.id, p.data);
        } finally {
          setSuppressSceneBroadcast(false);
        }
        break;
      }
      case 'token:move': {
        // ── GRANULAR TOKEN MOVE (latency fix) ──
        // Вместо отправки всего массива floors (~10KB+) на каждый drag-end,
        // шлём только {sceneId, floorIndex, charId, x, y} (~100 байт).
        // Receiver патчит local state мгновенно (без API call, без broadcast).
        // Это убирает лаги от JSON.stringify большого payload + гарантирует
        // что сообщение не превысит 16KB limit DataChannel.
        const p = action.payload as {
          sceneId: string;
          floorIndex: number;
          charId: string;
          x: number;
          y: number;
        };
        setSuppressSceneBroadcast(true);
        try {
          // Патчим local state напрямую (merge в scene.floors[floorIndex].tokens).
          const scene = store.scenes.find((s) => s.id === p.sceneId);
          if (scene) {
            const updatedFloors = [...scene.floors];
            const floor = updatedFloors[p.floorIndex];
            if (floor) {
              updatedFloors[p.floorIndex] = {
                ...floor,
                tokens: floor.tokens.map((t) =>
                  t.charId === p.charId ? { ...t, x: p.x, y: p.y } : t,
                ),
              };
              store.updateScene(p.sceneId, { floors: updatedFloors });
            }
          }
        } finally {
          setSuppressSceneBroadcast(false);
        }
        break;
      }
      case 'scene:switch': {
        const p = action.payload as { sceneId: string };
        store.switchScene(p.sceneId);
        break;
      }
      case 'floor:switch': {
        const p = action.payload as { floorIndex: number };
        store.setFloorIndex(p.floorIndex);
        break;
      }
      case 'log:add': {
        const p = action.payload as Record<string, unknown>;
        store.addLogEntry(p);
        break;
      }
      default:
        console.warn('[useNetwork] Unknown action kind:', action.kind);
    }
  }, []);

  // ── DataChannel send helper ───────────────────────────────
  const sendOnChannel = useCallback((peerId: string, msg: DataChannelMessage) => {
    const ch = _net.dataChannels.get(peerId);
    if (ch && ch.readyState === 'open') {
      try {
        ch.send(JSON.stringify(msg));
      } catch (e) {
        console.warn('[useNetwork] DataChannel send failed:', e);
      }
    }
  }, []);

  // ── Host: create a peer connection + offer for a new player
  const hostCreatePeer = useCallback((peerId: string) => {
    // If a PC already exists for this peer, check its state. If it's still
    // healthy (connected/connecting/new), leave it alone — the player:joined
    // event might be a re-broadcast from the signaling server after a
    // socket blip. If the PC is in a bad state (disconnected/failed/closed),
    // tear it down and create a fresh one so the player can reconnect.
    // NOTE: 'disconnected' is included here (not just 'failed'/'closed')
    // because in this sandbox environment, the ICE connection frequently
    // drops to 'disconnected' after a signaling blip and never recovers on
    // its own. Forcing a fresh PC on the next player:joined is the most
    // reliable recovery path.
    const existingPc = _net.peers.get(peerId);
    if (existingPc) {
      const state = existingPc.connectionState;
      if (state === 'connected' || state === 'connecting' || state === 'new') {
        // PC is still alive — skip re-creation. This is critical for
        // surviving signaling blips: without this guard, every player:joined
        // re-broadcast would tear down and rebuild the PC, causing endless
        // ICE churn.
        return;
      }
      // PC is stale (disconnected/failed/closed) — close it and recreate.
      console.info(`[net/host] peer ${peerId} PC in state ${state} — recreating`);
      closePeer(peerId);
    }
    const myPeerId = useFateStore.getState().networkMyPeerId;
    if (!myPeerId) return;

    const pc = new RTCPeerConnection(ICE_SERVERS);
    _net.peers.set(peerId, pc);

    // Host creates the data channel; the player picks it up via ondatachannel.
    const channel = pc.createDataChannel(`fate-state-${peerId}`);
    _net.dataChannels.set(peerId, channel);

    channel.onopen = () => {
      // Send the initial snapshot as soon as the channel is open.
      const snapshot = buildSnapshot();
      const sendSnapshot = (s: StateSnapshot) => {
        channel.send(JSON.stringify({ type: 'state', payload: s } as DataChannelMessage));
      };
      try {
        sendSnapshot(snapshot);
      } catch (e) {
        // The full snapshot might exceed the DataChannel's ~16KB max message
        // size (especially with many characters/scenes). Fall back to a
        // MINIMAL snapshot containing only the essentials the player needs
        // to function: playerAssignments (so they know which characters they
        // control) + currentAdventureId/SceneId (so the UI loads the right
        // adventure). Characters/scenes/settings are already loaded from the
        // server API on the player's page load.
        console.warn('[useNetwork/host] full snapshot send failed, trying minimal:', e);
        const s = useFateStore.getState();
        const minimal: StateSnapshot = {
          currentAdventureId: s.currentAdventureId,
          currentSceneId: s.currentSceneId,
          playerAssignments: s.playerAssignments,
        };
        try {
          sendSnapshot(minimal);
          console.info('[useNetwork/host] minimal snapshot sent successfully');
        } catch (e2) {
          console.error('[useNetwork/host] minimal snapshot send also failed:', e2);
        }
      }
      // Announce the host's dice palette to the newly-connected player so
      // peerDiceColors is seeded immediately (not just on a later color change).
      try {
        const s = useFateStore.getState();
        const hostPeerId = s.networkMyPeerId;
        if (hostPeerId) {
          const payload: DiceColorsPayload = {
            fromPeerId: hostPeerId,
            diceColor: s.diceColor,
            symbolColor: s.symbolColor,
            ts: Date.now(),
          };
          channel.send(JSON.stringify({ type: 'dice-colors', payload } as DataChannelMessage));
        }
      } catch (e) {
        console.warn('[useNetwork/host] dice-colors announce failed:', e);
      }
    };

    channel.onmessage = (e) => {
      // Host receives ping messages from players and immediately echoes
      // back a pong with the same timestamp. The player computes RTT as
      // Date.now() - ts when the pong arrives. Also handles sync-roll
      // results from players and cursor-move relay.
      try {
        const msg = JSON.parse(e.data) as DataChannelMessage;
        if (msg.type === 'ping') {
          const { ts } = msg.payload as PingPongPayload;
          useFateStore.getState().touchPeer(peerId);
          try {
            channel.send(JSON.stringify({ type: 'pong', payload: { ts } } as DataChannelMessage));
          } catch (err) {
            console.warn('[useNetwork/host] pong send failed:', err);
          }
        } else if (msg.type === 'pong') {
          // Host shouldn't receive pongs (it doesn't send pings), but
          // handle gracefully just in case.
          const { ts } = msg.payload as PingPongPayload;
          const rtt = Date.now() - ts;
          useFateStore.getState().setPeerLatency(peerId, rtt);
        } else if (msg.type === 'sync-roll-result') {
          // Player submitted their roll result — store it locally on the host.
          const p = msg.payload as SyncRollResultPayload;
          const store = useFateStore.getState();
          if (store.syncRollState && store.syncRollState.id === p.id) {
            store.submitSyncRollResult({
              peerId: p.peerId,
              peerName: p.peerName,
              characterId: p.characterId,
              characterName: p.characterName,
              skillName: p.skillName,
              skillValue: p.skillValue,
              dice: p.dice,
              bonus: p.bonus,
              total: p.total,
              resultLabel: p.resultLabel,
              ts: p.ts,
            });
          }
        } else if (msg.type === 'mass-roll-ready' || msg.type === 'mass-roll-unready') {
          // Player marked themselves ready (or unready) for a mass-roll session.
          const p = msg.payload as MassRollReadyPayload;
          const store = useFateStore.getState();
          if (store.massRollState && store.massRollState.id === p.sessionId) {
            store.applyMassRollReady(p.sessionId, p.characterId, p.ready, {
              mode: p.fatePointMode,
              reason: p.fatePointReason,
            });
            // Check if all online participants are now ready → auto-start.
            const session = useFateStore.getState().massRollState;
            if (session && session.status === 'inviting') {
              const onlineParticipants = session.participants.filter((pp) => pp.peerId !== null);
              const allReady = onlineParticipants.every((pp) => pp.ready);
              if (allReady) {
                // Broadcast start to all online participants, then roll locally
                // for NPC + offline PC.
                for (const pp of session.participants) {
                  if (pp.peerId) {
                    sendOnChannel(pp.peerId, {
                      type: 'mass-roll-start',
                      payload: { sessionId: session.id } as MassRollStartPayload,
                    });
                  }
                }
                store.forceStartMassRoll();
                // Broadcast the full results (with NPC/offline rolls done by host)
                // so online players immediately see everyone's dice. We inline the
                // broadcast here (rather than calling broadcastMassRollResults) to
                // match the existing pattern in this handler and avoid stale-closure
                // issues with useCallback identity.
                const afterForceState = useFateStore.getState();
                const afterForce = afterForceState.massRollState;
                if (afterForce) {
                  const resultsPayload: MassRollResultsPayload = {
                    sessionId: afterForce.id,
                    status: afterForce.status,
                    participants: afterForce.participants.map((pp) => {
                      const pc = pp.peerId ? afterForceState.peerDiceColors[pp.peerId] : undefined;
                      return {
                        characterId: pp.characterId,
                        characterName: pp.characterName,
                        characterType: pp.characterType,
                        peerId: pp.peerId,
                        skillName: pp.skillName,
                        skillValue: pp.skillValue,
                        manualBonus: pp.manualBonus,
                        ready: pp.ready,
                        fatePointMode: pp.fatePointMode,
                        fatePointReason: pp.fatePointReason,
                        diceColor: pc?.diceColor ?? afterForceState.diceColor,
                        symbolColor: pc?.symbolColor ?? afterForceState.symbolColor,
                        result: pp.result,
                      };
                    }),
                    opponentName: afterForce.opponentName,
                    opponentTotal: afterForce.opponentTotal,
                    opponentSkillName: afterForce.opponentSkillName,
                    opponentDice: afterForce.opponentDice,
                  };
                  for (const pid of Array.from(_net.dataChannels.keys())) {
                    sendOnChannel(pid, { type: 'mass-roll-results', payload: resultsPayload });
                  }
                }
              }
            }
          }
        } else if (msg.type === 'mass-roll-result') {
          // Player rolled dice and sent their result back to host.
          const p = msg.payload as MassRollResultPayload;
          const store = useFateStore.getState();
          if (store.massRollState && store.massRollState.id === p.sessionId) {
            // Store the player's dice colors so we can stamp them onto the
            // mass-roll-results broadcast (and any future rolls from them).
            if (p.diceColor && p.symbolColor) {
              store.setPeerDiceColor(peerId, { diceColor: p.diceColor, symbolColor: p.symbolColor });
            }
            store.submitMassRollResult(p.sessionId, p.characterId, {
              dice: p.dice,
              diceSum: p.diceSum,
              total: p.total,
              resultLabel: p.resultLabel,
              usedReroll: p.usedReroll,
            });
            // Broadcast the full updated session (with all results) to every
            // online player so they can see everyone's rolls, not just their own.
            // Inlined to match the pattern in this handler (avoid stale closure).
            const updatedState = useFateStore.getState();
            const updated = updatedState.massRollState;
            if (updated) {
              const resultsPayload: MassRollResultsPayload = {
                sessionId: updated.id,
                status: updated.status,
                participants: updated.participants.map((pp) => {
                  const pc = pp.peerId ? updatedState.peerDiceColors[pp.peerId] : undefined;
                  return {
                    characterId: pp.characterId,
                    characterName: pp.characterName,
                    characterType: pp.characterType,
                    peerId: pp.peerId,
                    skillName: pp.skillName,
                    skillValue: pp.skillValue,
                    manualBonus: pp.manualBonus,
                    ready: pp.ready,
                    fatePointMode: pp.fatePointMode,
                    fatePointReason: pp.fatePointReason,
                    diceColor: pc?.diceColor ?? updatedState.diceColor,
                    symbolColor: pc?.symbolColor ?? updatedState.symbolColor,
                    result: pp.result,
                  };
                }),
                opponentName: updated.opponentName,
                opponentTotal: updated.opponentTotal,
                opponentSkillName: updated.opponentSkillName,
                opponentDice: updated.opponentDice,
              };
              for (const pid of Array.from(_net.dataChannels.keys())) {
                sendOnChannel(pid, { type: 'mass-roll-results', payload: resultsPayload });
              }
            }
          }
        } else if (msg.type === 'mass-roll-reroll' || msg.type === 'mass-roll-adjust') {
          // Player requested a post-roll adjustment to their result. Three modes:
          //   - 'reroll': spend 1 fate point, re-roll the dice.
          //   - 'plus2':  spend 1 fate point, add +2 to total.
          //   - 'free-invoke': no fate point cost, add +2 (from a free invocation).
          // Legacy 'mass-roll-reroll' messages are treated as mode='reroll'.
          // Multiple adjustments are allowed — one fate point per reroll/plus2.
          const rawPayload = msg.payload as MassRollRerollPayload | MassRollAdjustPayload;
          const mode: 'reroll' | 'plus2' | 'free-invoke' =
            msg.type === 'mass-roll-reroll' ? 'reroll' : (rawPayload as MassRollAdjustPayload).mode;
          const sessionId = rawPayload.sessionId;
          const characterId = rawPayload.characterId;
          // Wrap in async IIFE — channel.onmessage is synchronous.
          (async () => {
            const store = useFateStore.getState();
            const session = store.massRollState;
            if (!session || session.id !== sessionId) return;
            const participant = session.participants.find((pp) => pp.characterId === characterId);
            if (!participant || !participant.result) return; // can only adjust after first roll

            // ── Fate point validation (only for reroll + plus2; free-invoke is free) ──
            const character = store.characters.find((c) => c.id === characterId);
            if (mode !== 'free-invoke') {
              if (!character || (character.fatePoints ?? 0) <= 0) {
                console.warn('[useNetwork] mass-roll-adjust: no fate points for', characterId);
                return;
              }
              // Deduct fate point.
              await store.updateCharacter(characterId, { fatePoints: character.fatePoints - 1 });
            }

            // ── Apply the adjustment ──
            const prev = participant.result;
            const fateBonus = participant.fatePointMode === 'plus2' ? 2 : 0; // pre-roll +2 choice
            const baseBonus = participant.skillValue + participant.manualBonus + session.bonus + fateBonus;

            let newDice = prev.dice;
            let newDiceSum = prev.diceSum;
            let deltaBonus = 0; // additional +2 from plus2/free-invoke modes
            const rerollCount = prev.rerollCount ?? 0;
            const bonusCount = prev.bonusCount ?? 0;
            const freeInvokeCount = prev.freeInvokeCount ?? 0;
            const history = prev.history ? [...prev.history] : [{ type: 'initial' as const, ts: session.startedAt }];

            if (mode === 'reroll') {
              newDice = rollFateDice();
              newDiceSum = sumFateDice(newDice);
              history.push({ type: 'reroll', ts: Date.now() });
            } else if (mode === 'plus2') {
              deltaBonus = 2;
              history.push({ type: 'plus2', ts: Date.now() });
            } else { // free-invoke
              deltaBonus = 2;
              history.push({ type: 'free-invoke', ts: Date.now() });
            }

            const total = newDiceSum + baseBonus + bonusCount * 2 + freeInvokeCount * 2 + deltaBonus;

            // ── Recompute result label ──
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

            store.submitMassRollResult(sessionId, characterId, {
              dice: newDice,
              diceSum: newDiceSum,
              total,
              resultLabel,
              usedReroll: rerollCount + (mode === 'reroll' ? 1 : 0) > 0,
              rerollCount: rerollCount + (mode === 'reroll' ? 1 : 0),
              bonusCount: bonusCount + (mode === 'plus2' ? 1 : 0),
              freeInvokeCount: freeInvokeCount + (mode === 'free-invoke' ? 1 : 0),
              history,
            });

            // ── Broadcast updated results to all players ──
            const updatedState = useFateStore.getState();
            const updated = updatedState.massRollState;
            if (updated) {
              const resultsPayload: MassRollResultsPayload = {
                sessionId: updated.id,
                status: updated.status,
                participants: updated.participants.map((pp) => {
                  const pc = pp.peerId ? updatedState.peerDiceColors[pp.peerId] : undefined;
                  return {
                    characterId: pp.characterId,
                    characterName: pp.characterName,
                    characterType: pp.characterType,
                    peerId: pp.peerId,
                    skillName: pp.skillName,
                    skillValue: pp.skillValue,
                    manualBonus: pp.manualBonus,
                    ready: pp.ready,
                    fatePointMode: pp.fatePointMode,
                    fatePointReason: pp.fatePointReason,
                    diceColor: pc?.diceColor ?? updatedState.diceColor,
                    symbolColor: pc?.symbolColor ?? updatedState.symbolColor,
                    result: pp.result,
                  };
                }),
                opponentName: updated.opponentName,
                opponentTotal: updated.opponentTotal,
                opponentSkillName: updated.opponentSkillName,
                opponentDice: updated.opponentDice,
              };
              for (const pid of Array.from(_net.dataChannels.keys())) {
                sendOnChannel(pid, { type: 'mass-roll-results', payload: resultsPayload });
              }
            }
          })().catch((err) => console.warn('[useNetwork] mass-roll-adjust error:', err));
        } else if (msg.type === 'cursor-move') {
          // Player's cursor moved — store it and relay to all OTHER players
          // so everyone sees everyone else's cursor (star topology: host is hub).
          const p = msg.payload as CursorMovePayload;
          const store = useFateStore.getState();
          store.setPeerCursor(p.peerId, {
            x: p.x,
            y: p.y,
            name: p.name,
            color: p.color,
            ts: p.ts,
            active: true,
          });
          // Relay to every other peer (host → other players)
          for (const otherId of Array.from(_net.dataChannels.keys())) {
            if (otherId === peerId) continue;
            sendOnChannel(otherId, { type: 'cursor-move', payload: p });
          }
        } else if (msg.type === 'cursor-leave') {
          const p = msg.payload as CursorLeavePayload;
          useFateStore.getState().clearPeerCursor(p.peerId);
          // Relay leave to other peers
          for (const otherId of Array.from(_net.dataChannels.keys())) {
            if (otherId === peerId) continue;
            sendOnChannel(otherId, { type: 'cursor-leave', payload: p });
          }
        } else if (msg.type === 'roll-stage') {
          // Player rolled dice and is sharing the stage event so the host
          // (and other players) can see the roll animation + result card.
          // Host enqueues locally (dedupe by event id handles echo back to
          // the roller) and re-broadcasts to all OTHER players (star hub).
          //
          // ── СЕТЕВАЯ ВИДИМОСТЬ АНИМАЦИИ ──
          // Если event несёт pendingPhysics/pendingPhysicsSessions, ставим
          // isRemote=true перед enqueue — чтобы ServerDiceStage на нашей
          // стороне вызвал subscribeToSession (подписка на io.emit стрим
          // physics-сервиса) вместо throwDice (который создал бы дубль).
          const p = msg.payload as LiveRollEvent;
          if (p.pendingPhysics) {
            p.pendingPhysics = { ...p.pendingPhysics, isRemote: true };
          }
          if (p.pendingPhysicsSessions) {
            p.pendingPhysicsSessions = p.pendingPhysicsSessions.map((s) => ({ ...s, isRemote: true }));
          }
          if (p.pending2DPhysics) {
            p.pending2DPhysics = { ...p.pending2DPhysics, isRemote: true };
          }
          useFateStore.getState().enqueueLiveRoll(p);
          for (const otherId of Array.from(_net.dataChannels.keys())) {
            if (otherId === peerId) continue;
            sendOnChannel(otherId, { type: 'roll-stage', payload: p });
          }
        } else if (msg.type === 'log-entry') {
          // Player created a log entry (addLogEntry on their side) and is
          // sharing it so the host + other players see it in their log panel.
          // Host adds it via addRemoteLogEntry (no POST, no re-broadcast) and
          // relays to all OTHER players.
          const p = msg.payload as Record<string, unknown>;
          useFateStore.getState().addRemoteLogEntry(p as never);
          for (const otherId of Array.from(_net.dataChannels.keys())) {
            if (otherId === peerId) continue;
            sendOnChannel(otherId, { type: 'log-entry', payload: p });
          }
        } else if (msg.type === 'dice-colors') {
          // Player announced their dice color palette. Store it locally (so
          // the host renders that player's rolls in their colors) and relay to
          // all OTHER players (star hub) so everyone's peerDiceColors map
          // stays in sync. Idempotent: setPeerDiceColor skips no-op updates.
          const p = msg.payload as DiceColorsPayload;
          useFateStore.getState().setPeerDiceColor(p.fromPeerId, {
            diceColor: p.diceColor,
            symbolColor: p.symbolColor,
          });
          for (const otherId of Array.from(_net.dataChannels.keys())) {
            if (otherId === peerId) continue;
            sendOnChannel(otherId, { type: 'dice-colors', payload: p });
          }
        }
      } catch (err) {
        console.warn('[useNetwork/host] bad msg from', peerId, err);
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        _net.socket?.emit('signal', {
          toPeerId: peerId,
          fromPeerId: myPeerId,
          data: { type: 'ice', data: e.candidate.toJSON() },
        });
      } else {
        // null candidate = ICE gathering complete
        console.info(`[net/host] ICE gathering complete for ${peerId}`);
      }
    };

    // Log ICE gathering state — helps diagnose NAT traversal issues
    pc.onicegatheringstatechange = () => {
      console.info(`[net/host] ICE gathering state (${peerId}): ${pc.iceGatheringState}`);
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.info(`[net/host] ICE connection state (${peerId}): ${s}`);
      if (s === 'failed') {
        console.error(`[net/host] ICE FAILED for ${peerId} — TURN relay may be required but unreachable`);
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.info(`[net/host] peer ${peerId} connection state: ${state}`);
      if (state === 'failed') {
        console.error(`[net/host] ICE FAILED for ${peerId} — TURN relay may be required but unreachable`);
        // Clean up the stale PC so a subsequent player:joined (e.g. after
        // signaling reconnect) can create a FRESH connection. Without this,
        // hostCreatePeer's `if (_net.peers.has(peerId)) return;` guard would
        // skip re-creation, leaving the peer permanently disconnected.
        closePeer(peerId);
      } else if (state === 'disconnected' || state === 'closed') {
        console.warn(`[useNetwork/host] peer ${peerId} connection state: ${state}`);
        // For 'disconnected': ICE might recover on its own (network blip),
        // so we DON'T close immediately. Only close on 'closed' (explicit
        // teardown). If disconnected persists for >15s, the stale-peer
        // sweeper + signaling reconnect will eventually trigger a fresh
        // player:joined → hostCreatePeer.
        if (state === 'closed') {
          closePeer(peerId);
        }
      }
    };

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        _net.socket?.emit('signal', {
          toPeerId: peerId,
          fromPeerId: myPeerId,
          data: { type: 'offer', data: pc.localDescription },
        });
      })
      .catch((e) => console.error('[useNetwork/host] offer creation failed:', e));
  }, [buildSnapshot, closePeer]);

  // ── Host: handle inbound signals from players (answers + ICE)
  const hostHandleSignal = useCallback((fromPeerId: string, signal: SignalData) => {
    const pc = _net.peers.get(fromPeerId);
    if (!pc) {
      console.warn(`[useNetwork/host] signal from unknown peer ${fromPeerId}`);
      return;
    }
    if (signal.type === 'answer') {
      pc.setRemoteDescription(new RTCSessionDescription(signal.data as RTCSessionDescriptionInit))
        .catch((e) => console.error('[useNetwork/host] setRemoteDescription failed:', e));
    } else if (signal.type === 'ice') {
      pc.addIceCandidate(new RTCIceCandidate(signal.data as RTCIceCandidateInit))
        .catch((e) => console.warn('[useNetwork/host] addIceCandidate failed:', e));
    }
  }, []);

  // ── Player: handle inbound signals from the host ─────────
  const playerHandleSignal = useCallback((fromPeerId: string, signal: SignalData) => {
    const myPeerId = useFateStore.getState().networkMyPeerId;
    if (!myPeerId) return;

    let pc = _net.peers.get(fromPeerId);
    // If the host sent a new OFFER and our existing PC is in a bad state
    // (disconnected/failed/closed), tear it down and create a fresh one.
    // This mirrors the host's hostCreatePeer stale-PC handling. Without this,
    // the player would try to setRemoteDescription on a dead PC, and the new
    // DataChannel (created by the host's fresh PC) would never arrive.
    if (pc && signal.type === 'offer') {
      const state = pc.connectionState;
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        console.info(`[net/player] host ${fromPeerId} PC in state ${state} — recreating for new offer`);
        closePeer(fromPeerId);
        pc = undefined; // fall through to the create-new-PC branch below
      }
    }
    if (!pc) {
      // First signal from the host — create the peer connection.
      pc = new RTCPeerConnection(ICE_SERVERS);
      _net.peers.set(fromPeerId, pc);

      pc.ondatachannel = (event) => {
        const channel = event.channel;
        _net.dataChannels.set(fromPeerId, channel);

        channel.onopen = () => {
          // Announce this player's dice palette to the host as soon as the
          // channel opens, so the host (and other players via relay) can
          // render this player's rolls in their chosen colors right away.
          try {
            const s = useFateStore.getState();
            const myPeerId = s.networkMyPeerId;
            if (myPeerId) {
              const payload: DiceColorsPayload = {
                fromPeerId: myPeerId,
                diceColor: s.diceColor,
                symbolColor: s.symbolColor,
                ts: Date.now(),
              };
              channel.send(JSON.stringify({ type: 'dice-colors', payload } as DataChannelMessage));
            }
          } catch (e) {
            console.warn('[useNetwork/player] dice-colors announce failed:', e);
          }
        };

        channel.onmessage = (e) => {
          try {
            const msg = JSON.parse(e.data) as DataChannelMessage;
            if (msg.type === 'state') {
              applySnapshot(msg.payload as StateSnapshot);
            } else if (msg.type === 'action') {
              applyAction(msg.payload as BroadcastAction);
            } else if (msg.type === 'assignment') {
              const p = msg.payload as AssignmentUpdatePayload;
              const cur = useFateStore.getState().playerAssignments;
              useFateStore.getState().setPlayerAssignments({
                ...cur,
                [p.peerId]: p.characterIds,
              });
            } else if (msg.type === 'pong') {
              // Player receives pong from host — compute RTT.
              const { ts } = msg.payload as PingPongPayload;
              const rtt = Date.now() - ts;
              useFateStore.getState().setPeerLatency(fromPeerId, rtt);
            } else if (msg.type === 'ping') {
              // Player shouldn't receive pings (only host sends pings to
              // players in this design), but echo back just in case.
              const { ts } = msg.payload as PingPongPayload;
              try {
                channel.send(JSON.stringify({ type: 'pong', payload: { ts } } as DataChannelMessage));
              } catch (err) {
                console.warn('[useNetwork/player] pong send failed:', err);
              }
            } else if (msg.type === 'sync-roll-request') {
              // Host initiated a sync roll — store it locally so the UI
              // shows the countdown + auto-roll panel.
              const p = msg.payload as SyncRollRequestPayload;
              const myPeerId = useFateStore.getState().networkMyPeerId;
              if (!myPeerId) return;
              useFateStore.setState({
                syncRollState: {
                  id: p.id,
                  skillName: p.skillName,
                  skillValue: p.skillValue,
                  bonus: p.bonus,
                  difficulty: p.difficulty,
                  participantPeerIds: [myPeerId],
                  startedAt: Date.now(),
                  deadlineTs: p.deadlineTs,
                  countdownSec: p.countdownSec,
                  results: {},
                  status: 'countdown',
                },
              });
            } else if (msg.type === 'mass-roll-invite') {
              // Host invited me to participate in a mass-roll. Construct a
              // minimal MassRollSession with just my participant entry — the
              // RollInvitationDialog reads this and shows the invite UI.
              const p = msg.payload as MassRollInvitePayload;
              const myPeerId = useFateStore.getState().networkMyPeerId;
              if (!myPeerId) return;
              useFateStore.setState({
                massRollState: {
                  id: p.sessionId,
                  mode: p.mode,
                  skillName: p.skillName,
                  bonus: p.bonus,
                  difficulty: p.difficulty,
                  opponentName: p.opponentName,
                  opponentTotal: p.opponentTotal,
                  participants: [{
                    characterId: p.characterId,
                    characterName: p.characterName,
                    characterType: 'pc',
                    peerId: myPeerId,
                    skillName: p.skillNameOverride ?? p.skillName,
                    skillValue: p.skillValue,
                    manualBonus: p.manualBonus,
                    ready: false,
                    readyAt: null,
                    fatePointMode: 'none',
                  }],
                  status: 'inviting',
                  startedAt: Date.now(),
                  completedAt: null,
                },
              });
            } else if (msg.type === 'mass-roll-start') {
              // Host signaled: roll starts now. Player should auto-roll their
              // own dice and send the result back.
              const p = msg.payload as MassRollStartPayload;
              const store = useFateStore.getState();
              const session = store.massRollState;
              if (!session || session.id !== p.sessionId) return;
              // Find my participant entry and roll dice for it.
              const me = session.participants.find((pp) => pp.peerId === store.networkMyPeerId);
              if (!me || me.result) return;
              const dice = rollFateDice();
              const diceSum = sumFateDice(dice);
              const fateBonus = me.fatePointMode === 'plus2' ? 2 : 0;
              const total = diceSum + me.skillValue + me.manualBonus + session.bonus + fateBonus;
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
              const result = {
                dice,
                diceSum,
                total,
                resultLabel,
                // Note: reroll is now a post-roll action (player requests it after
                // seeing their dice). Pre-roll fate choice is only "+2" or "none".
                usedReroll: false,
                rerollCount: 0,
                bonusCount: 0,
                freeInvokeCount: 0,
                history: [{ type: 'initial' as const, ts: Date.now() }],
              };
              store.submitMassRollResult(p.sessionId, me.characterId, result);
              // Send result back to host — include my dice colors so the host
              // can stamp them onto the broadcast (and store in peerDiceColors).
              const resultPayload: MassRollResultPayload = {
                sessionId: p.sessionId,
                characterId: me.characterId,
                dice,
                diceSum,
                total,
                resultLabel,
                usedReroll: false,
                diceColor: store.diceColor,
                symbolColor: store.symbolColor,
              };
              for (const pid of Array.from(_net.dataChannels.keys())) {
                sendOnChannel(pid, { type: 'mass-roll-result', payload: resultPayload });
              }
            } else if (msg.type === 'mass-roll-cancel') {
              // Host cancelled or finalized — clear local session state.
              const p = msg.payload as MassRollCancelPayload;
              const store = useFateStore.getState();
              if (store.massRollState && store.massRollState.id === p.sessionId) {
                store.cancelMassRoll();
              }
            } else if (msg.type === 'mass-roll-results') {
              // Host broadcast the full participants list with results.
              // Update the local session so the player can see everyone's rolls.
              const p = msg.payload as MassRollResultsPayload;
              const store = useFateStore.getState();
              const session = store.massRollState;
              if (!session || session.id !== p.sessionId) return;
              // Merge: keep my local fatePointReason if present, but update
              // participants with the host's authoritative list + results.
              const mergedParticipants = p.participants.map((hostP) => {
                const localP = session.participants.find((lp) => lp.characterId === hostP.characterId);
                return {
                  characterId: hostP.characterId,
                  characterName: hostP.characterName,
                  characterType: hostP.characterType,
                  peerId: hostP.peerId,
                  peerName: localP?.peerName,
                  // Per-player dice colors (stamped by host from peerDiceColors).
                  // Preserved on the local session so any rendering path that
                  // reads massRollState.participants can use them.
                  diceColor: hostP.diceColor,
                  symbolColor: hostP.symbolColor,
                  skillName: hostP.skillName,
                  skillValue: hostP.skillValue,
                  manualBonus: hostP.manualBonus,
                  ready: hostP.ready,
                  readyAt: localP?.readyAt ?? null,
                  fatePointMode: hostP.fatePointMode,
                  fatePointReason: hostP.fatePointReason,
                  result: hostP.result,
                };
              });
              useFateStore.setState({
                massRollState: {
                  ...session,
                  participants: mergedParticipants,
                  status: p.status,
                  completedAt: p.status === 'complete' ? Date.now() : session.completedAt,
                  opponentName: p.opponentName ?? session.opponentName,
                  opponentTotal: p.opponentTotal ?? session.opponentTotal,
                  opponentSkillName: p.opponentSkillName ?? session.opponentSkillName,
                  opponentDice: p.opponentDice ?? session.opponentDice,
                },
              });
            } else if (msg.type === 'cursor-move') {
              // Host relayed another peer's cursor movement — store it.
              const p = msg.payload as CursorMovePayload;
              useFateStore.getState().setPeerCursor(p.peerId, {
                x: p.x,
                y: p.y,
                name: p.name,
                color: p.color,
                ts: p.ts,
                active: true,
              });
            } else if (msg.type === 'cursor-leave') {
              const p = msg.payload as CursorLeavePayload;
              useFateStore.getState().clearPeerCursor(p.peerId);
            } else if (msg.type === 'roll-stage') {
              // Host relayed another peer's roll-stage event (or the host's
              // own roll). Enqueue locally — dedupe by event id prevents
              // double-play if this is an echo of my own roll.
              //
              // ── СЕТЕВАЯ ВИДИМОСТЬ АНИМАЦИИ ──
              // Ставим isRemote=true если есть pendingPhysics — чтобы
              // ServerDiceStage подписался на трансформаты, а не бросал.
              const p = msg.payload as LiveRollEvent;
              if (p.pendingPhysics) {
                p.pendingPhysics = { ...p.pendingPhysics, isRemote: true };
              }
              if (p.pendingPhysicsSessions) {
                p.pendingPhysicsSessions = p.pendingPhysicsSessions.map((s) => ({ ...s, isRemote: true }));
              }
              if (p.pending2DPhysics) {
                p.pending2DPhysics = { ...p.pending2DPhysics, isRemote: true };
              }
              useFateStore.getState().enqueueLiveRoll(p);
            } else if (msg.type === 'log-entry') {
              // Host relayed another peer's log entry (or the host's own).
              // addRemoteLogEntry dedupes by id and does NOT re-broadcast.
              const p = msg.payload as Record<string, unknown>;
              useFateStore.getState().addRemoteLogEntry(p as never);
            } else if (msg.type === 'dice-colors') {
              // Host relayed another peer's (or the host's own) dice palette.
              // Store it so we render that player's rolls in their colors.
              // Players do NOT re-broadcast (star topology: only the host relays).
              const p = msg.payload as DiceColorsPayload;
              useFateStore.getState().setPeerDiceColor(p.fromPeerId, {
                diceColor: p.diceColor,
                symbolColor: p.symbolColor,
              });
            }
          } catch (err) {
            console.warn('[useNetwork/player] bad msg from host:', err);
          }
        };
      };

      pc.onicecandidate = (e) => {
        if (e.candidate) {
          _net.socket?.emit('signal', {
            toPeerId: fromPeerId,
            fromPeerId: myPeerId,
            data: { type: 'ice', data: e.candidate.toJSON() },
          });
        } else {
          console.info(`[net/player] ICE gathering complete for host ${fromPeerId}`);
        }
      };

      // ICE diagnostics — mirror the host side
      pc.onicegatheringstatechange = () => {
        console.info(`[net/player] ICE gathering state (host ${fromPeerId}): ${pc!.iceGatheringState}`);
      };
      pc!.oniceconnectionstatechange = () => {
        const s = pc!.iceConnectionState;
        console.info(`[net/player] ICE connection state (host ${fromPeerId}): ${s}`);
        if (s === 'failed') {
          console.error(`[net/player] ICE FAILED for host ${fromPeerId} — TURN relay may be required but unreachable`);
        }
      };

      pc.onconnectionstatechange = () => {
        const state = pc!.connectionState;
        console.info(`[net/player] host ${fromPeerId} connection state: ${state}`);
        if (state === 'failed') {
          console.error(`[net/player] ICE FAILED for host ${fromPeerId} — TURN relay may be required but unreachable`);
          // Clean up the stale PC so the host can re-create the connection
          // on the next player:joined (signaling reconnect). Without this,
          // the player would be stuck with a dead PC and never reconnect.
          closePeer(fromPeerId);
        } else if (state === 'disconnected' || state === 'closed') {
          console.warn(`[useNetwork/player] host ${fromPeerId} connection state: ${state}`);
          if (state === 'closed') {
            closePeer(fromPeerId);
          }
        }
      };
    }

    if (signal.type === 'offer') {
      pc.setRemoteDescription(new RTCSessionDescription(signal.data as RTCSessionDescriptionInit))
        .then(() => pc!.createAnswer())
        .then((answer) => pc!.setLocalDescription(answer))
        .then(() => {
          _net.socket?.emit('signal', {
            toPeerId: fromPeerId,
            fromPeerId: myPeerId,
            data: { type: 'answer', data: pc!.localDescription },
          });
        })
        .catch((e) => console.error('[useNetwork/player] answer creation failed:', e));
    } else if (signal.type === 'answer') {
      // Player rarely receives answers (host already created the offer), but
      // handle defensively in case of glare.
      pc.setRemoteDescription(new RTCSessionDescription(signal.data as RTCSessionDescriptionInit))
        .catch((e) => console.error('[useNetwork/player] setRemoteDescription failed:', e));
    } else if (signal.type === 'ice') {
      pc.addIceCandidate(new RTCIceCandidate(signal.data as RTCIceCandidateInit))
        .catch((e) => console.warn('[useNetwork/player] addIceCandidate failed:', e));
    }
  }, [applyAction, applySnapshot, closePeer]);

  // ── Public: host a new room ───────────────────────────────
  const hostRoom = useCallback((roomId: string, displayName: string) => {
    const store = useFateStore.getState();
    const peerId = store.networkMyPeerId;
    if (!peerId) {
      console.error('[useNetwork] No networkMyPeerId — cannot host');
      return;
    }
    _net.role = 'host';

    store.setNetworkMyDisplayName(displayName);
    store.setNetworkRole('host');
    store.setNetworkActive(true);
    store.setNetworkRoomId(roomId);
    store.setNetworkHostOnline(true);
    saveNetworkSession({ role: 'host', roomId, displayName, playerAssignments: store.playerAssignments });
    // Host is always locked to master mode.
    if (useFateStore.getState().currentMode !== 'master') {
      useFateStore.setState({ currentMode: 'master' });
    }

    const socket = ensureSocket();
    // Clear any stale listeners from a previous session.
    socket.removeAllListeners('player:joined');
    socket.removeAllListeners('peer:left');
    socket.removeAllListeners('signal');
    socket.removeAllListeners('state:sync');
    socket.removeAllListeners('host:status');
    socket.removeAllListeners('host:joined');

    // Emit room:join exactly once per connection.
    // If socket is already connected, emit now. Otherwise the 'connect'
    // handler fires when it does connect. This avoids the double-emit bug
    // where socket.io buffers the immediate emit AND the connect handler
    // fires on the same handshake.
    const emitJoin = () => {
      socket.emit('room:join', { roomId, role: 'host', peerId, displayName });
    };
    const previousJoin = (socket as any)._roomJoinHandler;
    if (previousJoin) socket.off('connect', previousJoin);
    (socket as any)._roomJoinHandler = emitJoin;
    if (socket.connected) {
      emitJoin();
    }
    socket.on('connect', emitJoin);

    socket.on('player:joined', (payload: PlayerJoinedPayload) => {
      console.info('[net/host] player:joined received', payload);
      const s = useFateStore.getState();
      const name = payload.displayName || 'Игрок';
      const alreadyKnown = Boolean(s.networkPeers[payload.peerId]);
      const peers = {
        ...s.networkPeers,
        [payload.peerId]: {
          peerId: payload.peerId,
          displayName: name,
          role: 'player' as const,
        },
      };
      s.setNetworkPeers(peers);
      hostCreatePeer(payload.peerId);
      // ── Re-broadcast any pre-existing character assignment for this peer ──
      // When the player (re)joins, they may have missed the assignment:update
      // event (e.g., host assigned before player connected, or player refreshed
      // their tab and lost in-memory state). The state snapshot already carries
      // playerAssignments, but the snapshot is requested asynchronously and may
      // race with the WebRTC handshake. Re-sending the assignment explicitly
      // here guarantees the player learns their character as soon as the
      // signaling path is up — even before DataChannel opens (signaling fallback).
      const existingAssignment = s.playerAssignments[payload.peerId];
      if (existingAssignment && existingAssignment.length > 0) {
        console.info(`[net/host] re-broadcasting assignment for ${payload.peerId}:`, existingAssignment);
        _net.broadcastAssignmentFn?.(payload.peerId, existingAssignment);
      }
      // Visible feedback for the GM — a player just connected to the room.
      // Without this toast the only sign is a new row in the peer list
      // inside the network dialog, which is easy to miss.
      // Always show the toast (even on reconnect-recovery) — the GM must
      // see every player connection event. Suppressing caused user confusion
      // when the host refreshed the page and silently lost visibility.
      toast.success(
        alreadyKnown
          ? `Игрок снова на связи: ${name}`
          : `Игрок подключился: ${name}`,
        {
          description: alreadyKnown
            ? 'Соединение восстановлено'
            : 'Откройте «Сетевая игра», чтобы назначить ему персонажа',
          duration: 5000,
        },
      );
    });

    socket.on('peer:left', (payload: PeerLeftPayload) => {
      if (payload.role === 'host') return; // We ARE the host; ignore self-leave
      const s = useFateStore.getState();
      const leftName = s.networkPeers[payload.peerId]?.displayName ?? 'Игрок';
      const peers = { ...s.networkPeers };
      delete peers[payload.peerId];
      s.setNetworkPeers(peers);
      closePeer(payload.peerId);
      toast.info(`Игрок отключился: ${leftName}`, { duration: 4000 });
    });

    socket.on('signal', (payload: SignalPayload) => {
      hostHandleSignal(payload.fromPeerId, payload.data);
    });

    // A player requesting state: emits `state:sync` with no snapshot.
    // The server relays to the host, which responds with the full snapshot.
    socket.on('state:sync', (payload: StateSyncPayload) => {
      if (!payload?.snapshot) {
        const snapshot = buildSnapshot();
        socket.emit('state:sync', { roomId, snapshot });
      }
    });
  }, [buildSnapshot, closePeer, ensureSocket, hostCreatePeer, hostHandleSignal]);

  // ── Public: join an existing room as a player ─────────────
  const joinRoom = useCallback((roomId: string, displayName: string) => {
    const store = useFateStore.getState();
    const peerId = store.networkMyPeerId;
    if (!peerId) {
      console.error('[useNetwork] No networkMyPeerId — cannot join');
      return;
    }
    _net.role = 'player';

    store.setNetworkMyDisplayName(displayName);
    store.setNetworkRole('player');
    store.setNetworkActive(true);
    store.setNetworkRoomId(roomId);
    // Player is locked to player mode — they cannot switch to master.
    saveNetworkSession({ role: 'player', roomId, displayName, playerAssignments: {} });
    if (useFateStore.getState().currentMode !== 'player') {
      useFateStore.setState({ currentMode: 'player' });
    }

    const socket = ensureSocket();
    socket.removeAllListeners('player:joined');
    socket.removeAllListeners('peer:left');
    socket.removeAllListeners('signal');
    socket.removeAllListeners('state:sync');
    socket.removeAllListeners('host:status');
    socket.removeAllListeners('host:joined');
    socket.removeAllListeners('assignment:update');

    // Emit room:join exactly once per connection (same pattern as host).
    const emitJoin = () => {
      socket.emit('room:join', { roomId, role: 'player', peerId, displayName });
      // Re-request state on every reconnect, after re-registering the room.
      socket.emit('state:sync', { roomId });
    };
    const previousJoin = (socket as any)._roomJoinHandler;
    if (previousJoin) socket.off('connect', previousJoin);
    (socket as any)._roomJoinHandler = emitJoin;
    if (socket.connected) {
      emitJoin();
    }
    socket.on('connect', emitJoin);

    socket.on('host:status', (payload: HostStatusPayload) => {
      useFateStore.getState().setNetworkHostOnline(payload.isHostOnline);
      // If the host came back online, cancel any pending host-left close timer.
      if (payload.isHostOnline && _net.hostLeftCloseTimer) {
        clearTimeout(_net.hostLeftCloseTimer);
        _net.hostLeftCloseTimer = null;
      }
    });

    // Also handle `host:joined` (emitted by the server when the host joins
    // AFTER the player). This is the player's signal that the host is now
    // reachable. (Note: the host won't have a `player:joined` event for this
    // player in that case — the player would need to re-emit `room:join` to
    // be visible to the host. For MVP, we support the normal host-first flow.)
    socket.on('host:joined', () => {
      const wasOffline = !useFateStore.getState().networkHostOnline;
      useFateStore.getState().setNetworkHostOnline(true);
      // Cancel any pending host-left close timer — the host is back online
      // and the existing RTCPeerConnection may still be usable (or the host
      // will send a fresh offer via hostCreatePeer).
      if (_net.hostLeftCloseTimer) {
        clearTimeout(_net.hostLeftCloseTimer);
        _net.hostLeftCloseTimer = null;
      }
      if (wasOffline) {
        toast.success('Мастер на связи', {
          description: 'Подключение к игре установлено',
          duration: 4000,
        });
      }
    });

    socket.on('signal', (payload: SignalPayload) => {
      playerHandleSignal(payload.fromPeerId, payload.data);
    });

    socket.on('state:sync', (payload: StateSyncPayload) => {
      if (payload?.snapshot) {
        applySnapshot(payload.snapshot);
      }
    });

    socket.on('assignment:update', (payload: AssignmentUpdatePayload) => {
      const cur = useFateStore.getState().playerAssignments;
      useFateStore.getState().setPlayerAssignments({
        ...cur,
        [payload.peerId]: payload.characterIds,
      });
    });

    socket.on('peer:left', (payload: PeerLeftPayload) => {
      if (payload.role === 'host') {
        useFateStore.getState().setNetworkHostOnline(false);
        // ── DELAYED close: don't tear down the RTCPeerConnection immediately ──
        // The signaling socket frequently blips (Caddy gateway silent close
        // → heartbeat timeout → manual reconnect). Each blip emits peer:left,
        // and if we close the PC on every blip, the WebRTC connection never
        // stabilizes. Instead, set a timer: if the host doesn't come back
        // within 8s (via host:joined/host:status, which cancels the timer),
        // THEN close the stale PC. This keeps the WebRTC alive across
        // signaling blips while still cleaning up if the host truly left.
        if (_net.hostLeftCloseTimer) clearTimeout(_net.hostLeftCloseTimer);
        _net.hostLeftCloseTimer = setTimeout(() => {
          _net.hostLeftCloseTimer = null;
          closePeer(payload.peerId);
          console.info('[net/player] host-left close timer fired — closing stale PC');
        }, 8000);
        toast.warning('Мастер покинул игру', {
          description: 'Соединение потеряно. Ожидание переподключения...',
          duration: 5000,
        });
      } else {
        const s = useFateStore.getState();
        const peers = { ...s.networkPeers };
        delete peers[payload.peerId];
        s.setNetworkPeers(peers);
      }
    });

    // Request the initial state snapshot from the host. The server relays
    // this (without a snapshot) to the other sockets in the room; the host
    // responds by emitting `state:sync` with the full snapshot.
    socket.emit('state:sync', { roomId });
  }, [applySnapshot, ensureSocket, playerHandleSignal, closePeer]);

  // Keep refs to hostRoom/joinRoom in sync so ensureSocket can re-call them
  // after a socket recreation (URL resolution swap). Using useEffect avoids
  // the self-reference lint error.
  useEffect(() => {
    _net.hostRoomFn = hostRoom;
  }, [hostRoom]);
  useEffect(() => {
    _net.joinRoomFn = joinRoom;
  }, [joinRoom]);

  // ── Public: leave the current session ─────────────────────
  const leaveSession = useCallback(() => {
    clearNetworkSession();
    const store = useFateStore.getState();
    const { networkRoomId: roomId, networkMyPeerId: peerId } = store;
    const socket = _net.socket;

    if (socket && roomId && peerId) {
      try { socket.emit('room:leave', { roomId, peerId }); } catch { /* ignore */ }
    }

    closeAllPeers();

    const wasRole = _net.role;
    store.resetNetworkState();

    // Host stays in master mode; player is freed to switch back to master
    // if they wish (e.g., to run their own game locally).
    if (wasRole === 'player') {
      useFateStore.setState({ currentMode: 'master' });
    }

    _net.role = null;
    _net.loadedAdventureId = null;
    if (socket) {
      clearInterval((socket as any)._heartbeatInterval);
      (socket as any)._clearHeartbeatWatchdog?.();
      socket.removeAllListeners();
      socket.disconnect();
      _net.socket = null;
    }
  }, [closeAllPeers]);

  const restoreSession = useCallback(() => {
    if (useFateStore.getState().isNetworkActive) return;
    const saved = loadNetworkSession();
    if (!saved) return;
    const requested = new URLSearchParams(window.location.search).get('join')?.toUpperCase();
    if (requested && (saved.role === 'host' || requested !== saved.roomId)) return;
    if (saved.role === 'host') {
      useFateStore.getState().setPlayerAssignments(saved.playerAssignments);
      hostRoom(saved.roomId, saved.displayName);
    } else {
      joinRoom(saved.roomId, saved.displayName);
    }
  }, [hostRoom, joinRoom]);

  // ── Public (host): push a full state snapshot to all players
  const sendStateToPlayers = useCallback(() => {
    const snapshot = buildSnapshot();
    // Prefer DataChannels for connected peers.
    const connectedPeerIds: string[] = [];
    for (const peerId of Array.from(_net.dataChannels.keys())) {
      const ch = _net.dataChannels.get(peerId);
      if (ch && ch.readyState === 'open') {
        sendOnChannel(peerId, { type: 'state', payload: snapshot });
        connectedPeerIds.push(peerId);
      }
    }
    // LATENCY FIX: Only use signaling-server relay for peers whose DataChannel
    // ISN'T open yet. Раньше snapshot дублировался через signaling server ВСЕМ
    // пирам (даже с открытым DataChannel) — двойной payload, двойная нагрузка
    // на main thread (JSON.stringify + parse), плюс Caddy proxy добавлял lag.
    // Теперь signaling relay = fallback ТОЛЬКО для ещё не подключенных peers.
    const s = useFateStore.getState();
    if (s.networkRoomId) {
      const hasPendingPeers = Object.keys(s.networkPeers).some(
        (pid) => !connectedPeerIds.includes(pid),
      );
      if (hasPendingPeers) {
        _net.socket?.emit('state:sync', { roomId: s.networkRoomId, snapshot });
      }
    }
  }, [buildSnapshot, sendOnChannel]);

  // ── Public (host): broadcast an incremental action ────────
  const broadcastAction = useCallback((action: BroadcastAction) => {
    for (const peerId of Array.from(_net.dataChannels.keys())) {
      sendOnChannel(peerId, { type: 'action', payload: action });
    }
  }, [sendOnChannel]);

  // ── Public: broadcast a scene update to peers ─────────────
  // Called from the store's updateScene (via the broadcastSceneUpdate ref).
  // Throttled + deduped per scene to avoid flooding the DataChannel when
  // the GM drags a token (which fires dozens of updateScene calls per
  // second). We coalesce updates within a 50ms window and send the LATEST
  // data for each scene — earlier intermediate positions are dropped
  // (the player only needs the final position, not every pixel along the
  // drag path).
  //
  // Role semantics (star topology):
  //   - Host: broadcasts to ALL connected players.
  //   - Player: sends to host only (host re-broadcasts to other players).
  //     The host's applyAction will call updateScene, which (because the
  //     player's message set _suppressSceneBroadcast on the host) won't
  //     echo back. The host then broadcasts to OTHER players.
  const _sceneUpdateQueue = useRef<Map<string, Partial<{ floors: unknown; presentCharacters: unknown; conflictData: unknown; playerFloorIndex: unknown; currentFloorIndex: unknown; background: unknown; backgroundImage: unknown; [k: string]: unknown }>>>(new Map());
  const _sceneUpdateFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const broadcastSceneUpdate = useCallback((sceneId: string, data: Record<string, unknown>) => {
    // Merge into the per-scene queue.
    const prev = _sceneUpdateQueue.current.get(sceneId) ?? {};
    _sceneUpdateQueue.current.set(sceneId, { ...prev, ...data });

    // Coalesce: flush after 16ms (one frame). Раньше было 50ms — добавляло
    // заметную задержку к каждому обновлению. 16ms достаточно для batch
    // rapid-fire updates (rapid token drags) без добавления perceivable lag.
    if (_sceneUpdateFlushTimer.current) clearTimeout(_sceneUpdateFlushTimer.current);
    _sceneUpdateFlushTimer.current = setTimeout(() => {
      _sceneUpdateFlushTimer.current = null;
      const queue = _sceneUpdateQueue.current;
      _sceneUpdateQueue.current = new Map();
      for (const [id, merged] of queue.entries()) {
        const action: BroadcastAction = {
          kind: 'scene:update',
          payload: { id, data: merged },
        };
        for (const peerId of Array.from(_net.dataChannels.keys())) {
          sendOnChannel(peerId, { type: 'action', payload: action });
        }
      }
    }, 16);
  }, [sendOnChannel]);

  // ── Public: broadcast a GRANULAR token move (latency fix) ──────────────
  // Вместо отправки всего массива floors (~10KB+) на каждый drag-end, шлём
  // только {sceneId, floorIndex, charId, x, y} (~100 байт). Это:
  //   1. Мгновенная синхронизация (нет JSON.stringify большого payload).
  //   2. Гарантия что сообщение не превысит 16KB DataChannel limit.
  //   3. Нет coalescing — отправляется СРАЗУ (0ms delay).
  // Receiver патчит local state через applyAction 'token:move' handler.
  const broadcastTokenMove = useCallback(
    (sceneId: string, floorIndex: number, charId: string, x: number, y: number) => {
      const action: BroadcastAction = {
        kind: 'token:move',
        payload: { sceneId, floorIndex, charId, x, y },
      };
      for (const peerId of Array.from(_net.dataChannels.keys())) {
        sendOnChannel(peerId, { type: 'action', payload: action });
      }
    },
    [sendOnChannel],
  );

  // ── Public: broadcast a character update to peers ─────────
  // Same throttling approach as scene updates, but per-character. Character
  // sheet edits are less frequent than token drags, but a single save can
  // touch multiple fields (stress, consequences, fate points) — coalescing
  // avoids sending 5 messages when 1 suffices.
  const _charUpdateQueue = useRef<Map<string, Record<string, unknown>>>(new Map());
  const _charUpdateFlushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const broadcastCharacterUpdate = useCallback((characterId: string, data: Record<string, unknown>) => {
    const prev = _charUpdateQueue.current.get(characterId) ?? {};
    _charUpdateQueue.current.set(characterId, { ...prev, ...data });

    if (_charUpdateFlushTimer.current) clearTimeout(_charUpdateFlushTimer.current);
    _charUpdateFlushTimer.current = setTimeout(() => {
      _charUpdateFlushTimer.current = null;
      const queue = _charUpdateQueue.current;
      _charUpdateQueue.current = new Map();
      for (const [id, merged] of queue.entries()) {
        const action: BroadcastAction = {
          kind: 'character:update',
          payload: { id, data: merged },
        };
        for (const peerId of Array.from(_net.dataChannels.keys())) {
          sendOnChannel(peerId, { type: 'action', payload: action });
        }
      }
    }, 16);
  }, [sendOnChannel]);

  // ── Public (host): broadcast a character assignment to a player ──
  // Sends via both DataChannel (preferred) and the signaling server
  // (fallback for peers whose DataChannel isn't open yet).
  const broadcastAssignment = useCallback((peerId: string, characterIds: string[]) => {
    const payload = { peerId, characterIds };
    // DataChannel (real-time, preferred)
    sendOnChannel(peerId, { type: 'assignment', payload });
    // Signaling fallback — reaches the player even before DataChannel opens.
    const s = useFateStore.getState();
    if (s.networkRole === 'host' && s.networkRoomId) {
      saveNetworkSession({ role: 'host', roomId: s.networkRoomId, displayName: s.networkMyDisplayName, playerAssignments: s.playerAssignments });
    }
    if (s.networkRoomId) {
      _net.socket?.emit('assign:character', {
        roomId: s.networkRoomId,
        peerId,
        characterIds,
      });
    }
  }, [sendOnChannel]);

  // Keep broadcastAssignmentFn ref in sync so hostRoom (declared earlier) can
  // call it via _net ref — avoids forward-reference issues with useCallback.
  useEffect(() => {
    _net.broadcastAssignmentFn = broadcastAssignment;
  }, [broadcastAssignment]);

  // ── Public (host): broadcast a sync-roll request to selected players ──
  // Only the peers in `targetPeerIds` receive the request. Players who aren't
  // selected never see the countdown dialog and don't roll.
  const broadcastSyncRoll = useCallback((session: {
    id: string;
    skillName: string;
    skillValue: number;
    bonus: number;
    difficulty: number | null;
    countdownSec: number;
    deadlineTs: number;
    targetPeerIds: string[];
  }) => {
    const payload: SyncRollRequestPayload = {
      id: session.id,
      skillName: session.skillName,
      skillValue: session.skillValue,
      bonus: session.bonus,
      difficulty: session.difficulty,
      countdownSec: session.countdownSec,
      deadlineTs: session.deadlineTs,
    };
    for (const peerId of session.targetPeerIds) {
      sendOnChannel(peerId, { type: 'sync-roll-request', payload });
    }
  }, [sendOnChannel]);

  // ── Public (player): send my roll result back to the host ──
  // Called by the sync-roll dialog when the player's auto-roll completes.
  const sendSyncRollResult = useCallback((result: SyncRollResultPayload) => {
    // Player has exactly one data channel — to the host.
    for (const peerId of Array.from(_net.dataChannels.keys())) {
      sendOnChannel(peerId, { type: 'sync-roll-result', payload: result });
    }
  }, [sendOnChannel]);

  // ── Public (host): invite selected players to a mass-roll session ──
  // Sends a per-player invitation with their resolved skill value + GM overrides.
  // Only the participants with peerId !== null receive the invite; NPC + offline
  // PC are rolled locally by the host.
  const broadcastMassRollInvite = useCallback((session: {
    sessionId: string;
    mode: 'normal' | 'difficulty' | 'opposed';
    skillName: string;
    bonus: number;
    difficulty: number | null;
    opponentName?: string;
    opponentTotal?: number;
    participants: Array<{
      characterId: string;
      characterName: string;
      peerId: string;
      skillName: string;       // resolved (with override)
      skillValue: number;
      manualBonus: number;
    }>;
  }) => {
    for (const p of session.participants) {
      const payload: MassRollInvitePayload = {
        sessionId: session.sessionId,
        mode: session.mode,
        skillName: session.skillName,
        bonus: session.bonus,
        difficulty: session.difficulty,
        opponentName: session.opponentName,
        opponentTotal: session.opponentTotal,
        characterId: p.characterId,
        characterName: p.characterName,
        skillNameOverride: p.skillName !== session.skillName ? p.skillName : undefined,
        skillValue: p.skillValue,
        manualBonus: p.manualBonus,
      };
      sendOnChannel(p.peerId, { type: 'mass-roll-invite', payload });
    }
  }, [sendOnChannel]);

  // ── Public (player): mark myself ready (or unready) for a mass-roll ──
  // Sends my ready state + fate point choice to the host. Host uses this to
  // decide when to auto-start the roll.
  const sendMassRollReady = useCallback((params: {
    sessionId: string;
    characterId: string;
    ready: boolean;
    fatePointMode: 'none' | 'plus2' | 'reroll';
    fatePointReason?: string;
  }) => {
    const payload: MassRollReadyPayload = {
      sessionId: params.sessionId,
      characterId: params.characterId,
      ready: params.ready,
      fatePointMode: params.fatePointMode,
      fatePointReason: params.fatePointReason,
    };
    // Player has exactly one data channel — to the host.
    for (const peerId of Array.from(_net.dataChannels.keys())) {
      sendOnChannel(peerId, { type: params.ready ? 'mass-roll-ready' : 'mass-roll-unready', payload });
    }
  }, [sendOnChannel]);

  // ── Public (host): broadcast a force-start to all online participants ──
  // Used when GM clicks "Бросить сейчас" before everyone is ready. Online
  // players auto-roll; offline/NPC are rolled locally by the host.
  const broadcastMassRollStart = useCallback((sessionId: string, participantPeerIds: string[]) => {
    const payload: MassRollStartPayload = { sessionId };
    for (const peerId of participantPeerIds) {
      sendOnChannel(peerId, { type: 'mass-roll-start', payload });
    }
  }, [sendOnChannel]);

  // ── Public (host): broadcast cancel/finalize to all online participants ──
  // Tells players to close their RollInvitationDialog.
  const broadcastMassRollCancel = useCallback((sessionId: string, participantPeerIds: string[]) => {
    const payload: MassRollCancelPayload = { sessionId };
    for (const peerId of participantPeerIds) {
      sendOnChannel(peerId, { type: 'mass-roll-cancel', payload });
    }
  }, [sendOnChannel]);

  // ── Public (host): broadcast the full participants list (with results) to
  // all online players. Sent after each result arrives, after force-start,
  // and after any post-roll adjustment (reroll, +2 bonus, free invoke), so
  // every player can see all rolls and adjustments in their RollInvitationPanel.
  const broadcastMassRollResults = useCallback((session: {
    id: string;
    status: 'inviting' | 'rolling' | 'complete';
    participants: Array<{
      characterId: string;
      characterName: string;
      characterType: 'pc' | 'npc';
      peerId: string | null;
      skillName: string;
      skillValue: number;
      manualBonus: number;
      ready: boolean;
      fatePointMode: 'none' | 'plus2' | 'reroll';
      fatePointReason?: string;
      result?: {
        dice: number[];
        diceSum: number;
        total: number;
        resultLabel: string;
        usedReroll?: boolean;
        rerollCount?: number;
        bonusCount?: number;
        freeInvokeCount?: number;
        history?: Array<{ type: 'initial' | 'reroll' | 'plus2' | 'free-invoke'; ts: number }>;
      };
    }>;
    opponentName?: string;
    opponentTotal?: number;
    opponentSkillName?: string;
    opponentDice?: number[];
  }) => {
    const hostState = useFateStore.getState();
    const payload: MassRollResultsPayload = {
      sessionId: session.id,
      status: session.status,
      participants: session.participants.map((p) => {
        const pc = p.peerId ? hostState.peerDiceColors[p.peerId] : undefined;
        return {
          characterId: p.characterId,
          characterName: p.characterName,
          characterType: p.characterType,
          peerId: p.peerId,
          skillName: p.skillName,
          skillValue: p.skillValue,
          manualBonus: p.manualBonus,
          ready: p.ready,
          fatePointMode: p.fatePointMode,
          fatePointReason: p.fatePointReason,
          diceColor: pc?.diceColor ?? hostState.diceColor,
          symbolColor: pc?.symbolColor ?? hostState.symbolColor,
          result: p.result,
        };
      }),
      opponentName: session.opponentName,
      opponentTotal: session.opponentTotal,
      opponentSkillName: session.opponentSkillName,
      opponentDice: session.opponentDice,
    };
    // Broadcast to every connected peer (host → all players).
    for (const peerId of Array.from(_net.dataChannels.keys())) {
      sendOnChannel(peerId, { type: 'mass-roll-results', payload });
    }
  }, [sendOnChannel]);

  // ── Public (player): request a post-roll adjustment for my own character ──
  // Three modes:
  //   - 'reroll': spend 1 fate point, re-roll the dice.
  //   - 'plus2':  spend 1 fate point, add +2 to total.
  //   - 'free-invoke': no fate point cost, add +2 (from a free invocation).
  // Host validates fate points, applies the adjustment, broadcasts updated
  // results to all players. Multiple adjustments allowed.
  const sendMassRollAdjust = useCallback((params: {
    sessionId: string;
    characterId: string;
    mode: 'reroll' | 'plus2' | 'free-invoke';
    reason?: string;
  }) => {
    const payload: MassRollAdjustPayload = {
      sessionId: params.sessionId,
      characterId: params.characterId,
      mode: params.mode,
      reason: params.reason,
    };
    for (const peerId of Array.from(_net.dataChannels.keys())) {
      sendOnChannel(peerId, { type: 'mass-roll-adjust', payload });
    }
  }, [sendOnChannel]);

  // ── Public (player): request a reroll for my own character ──
  // DEPRECATED: use sendMassRollAdjust({ mode: 'reroll' }) instead.
  // Kept for backward compat — delegates to sendMassRollAdjust.
  const sendMassRollReroll = useCallback((params: {
    sessionId: string;
    characterId: string;
    reason?: string;
  }) => {
    const payload: MassRollRerollPayload = {
      sessionId: params.sessionId,
      characterId: params.characterId,
      reason: params.reason,
    };
    for (const peerId of Array.from(_net.dataChannels.keys())) {
      sendOnChannel(peerId, { type: 'mass-roll-reroll', payload });
    }
  }, [sendOnChannel]);

  // ── Public: send my cursor position to the other side ──
  // Throttled to ~33ms (30fps) to avoid flooding the DataChannel. Host
  // sends to ALL players; players send only to host (who relays).
  const lastCursorSentRef = useRef(0);
  const sendCursorMove = useCallback((x: number, y: number) => {
    const now = Date.now();
    if (now - lastCursorSentRef.current < 33) return; // throttle ~30fps
    lastCursorSentRef.current = now;
    const s = useFateStore.getState();
    if (!s.networkMyPeerId || !s.networkMyDisplayName) return;
    const payload: CursorMovePayload = {
      peerId: s.networkMyPeerId,
      name: s.networkMyDisplayName,
      color: s.networkRole === 'host' ? '#e67e22' : '#3498db',
      x,
      y,
      ts: now,
    };
    for (const peerId of Array.from(_net.dataChannels.keys())) {
      sendOnChannel(peerId, { type: 'cursor-move', payload });
    }
  }, [sendOnChannel]);

  // ── Public: notify peers that my cursor left the map ──
  const sendCursorLeave = useCallback(() => {
    const s = useFateStore.getState();
    if (!s.networkMyPeerId) return;
    const payload: CursorLeavePayload = { peerId: s.networkMyPeerId };
    for (const peerId of Array.from(_net.dataChannels.keys())) {
      sendOnChannel(peerId, { type: 'cursor-leave', payload });
    }
  }, [sendOnChannel]);

  // ── Public: broadcast a roll stage event to peers WITHOUT local enqueue ──
  // Use this when the local overlay is already handled by another path (e.g.
  // 2D inline result panel, or 3D physics event already enqueued by
  // executeDiceRoll) but peers still need to see the roll.
  //
  // ── СЕТЕВАЯ ВИДИМОСТЬ АНИМАЦИИ ──
  // Если event несёт pendingPhysics / pendingPhysicsSessions (live-physics
  // бросок) — отправляем их ЦЕЛИКОМ, isSummary=false. Remote-клиенты
  // монтируют ServerDiceStage, видят isRemote-флаг (ставится в receive-
  // обработчике) и вызывают subscribeToSession(sessionId) вместо throwDice.
  // Physics-сервис стримит трансформаты через io.emit ВСЕМ сокетам →
  // анимация видна всем. Если physics-полей нет (чистый summary) —
  // старое поведение: срезаем physics-поля, isSummary=true.
  const sendRollStage = useCallback((event: LiveRollEvent) => {
    const hasLivePhysics = !!(event.pendingPhysics || event.pendingPhysicsSessions || event.pending2DPhysics);
    let payload: LiveRollEvent;
    if (hasLivePhysics) {
      // Live-physics event (3D ИЛИ 2D) — отправляем с physics-полями, БЕЗ isSummary.
      // Remote-клиенты увидят isRemote=true (после receive-обработчика) и:
      //   • 3D: подпишутся на трансформаты physics-сервиса (subscribeToSession)
      //   • 2D: запустят локальный 2D-движок с тем же seed → идентичная анимация
      payload = { ...event, isSummary: false };
    } else {
      // Summary event — срезаем локальные physics-поля, isSummary=true.
      const {
        pendingPhysics: _pp,
        pendingPhysicsSessions: _pps,
        pending2DPhysics: _p2d,
        ...networkSafe
      } = event;
      payload = { ...networkSafe, isSummary: true };
    }

    for (const peerId of Array.from(_net.dataChannels.keys())) {
      sendOnChannel(peerId, { type: 'roll-stage', payload });
    }
  }, [sendOnChannel]);

  // ── Public: enqueue a roll stage event for the live roll overlay ──
  // Called by roll-tool-panel (and mass-roll components) after computing a
  // roll result. Enqueues the event locally so the RollStageOverlay shows on
  // the roller's screen, AND broadcasts to connected peers so they see the
  // roll animation + result card too.
  //
  // Network behavior:
  //   - Host: broadcasts to ALL connected players (star hub). Each player's
  //     enqueueLiveRoll dedupes by event id, so the host's own local enqueue
  //     + the echo-back from re-broadcast are silently dropped on the host.
  //   - Player: sends to the host ONLY. The host enqueues locally and re-
  //     broadcasts to all OTHER players (star hub relay).
  //
  // The broadcast payload STRIPS pendingPhysics / pendingPhysicsSessions /
  // pending2DPhysics (these are local physics sessions tied to the roller's
  // machine; remote peers can't run them) and sets isSummary: true so the
  // remote overlay shows the result card without trying to animate 3D dice.
  const broadcastRollStage = useCallback((event: LiveRollEvent) => {
    // Always enqueue locally first — the roller sees their own overlay.
    useFateStore.getState().enqueueLiveRoll(event);
    sendRollStage(event);
  }, [sendRollStage]);

  // ── Public: broadcast a log entry to connected peers ──
  // Called by the store's addLogEntry (via the module-level broadcaster ref)
  // after a log entry is added locally. Peers receive it via addRemoteLogEntry
  // which does NOT re-POST (avoiding server duplicates) and does NOT re-
  // broadcast (avoiding infinite loops).
  //
  // Network behavior mirrors broadcastRollStage:
  //   - Host: sends to ALL players.
  //   - Player: sends to host ONLY; host re-broadcasts to other players.
  const broadcastLogEntry = useCallback((entry: Record<string, unknown>) => {
    for (const peerId of Array.from(_net.dataChannels.keys())) {
      sendOnChannel(peerId, { type: 'log-entry', payload: entry });
    }
  }, [sendOnChannel]);

  // ── Public: broadcast this client's dice color palette to connected peers ──
  // Called by the store (via _broadcastDiceColorsFn) whenever the local player
  // changes their diceColor/symbolColor, AND on initial peer connect (so a
  // freshly-joined player's colors are known to everyone immediately, not just
  // after their first color change). Peers store the palette in
  // peerDiceColors[myPeerId] and use it to render that player's rolls (and
  // mass-roll participants) in their chosen colors — the foundation of
  // per-player dice customization.
  //
  // Network behavior (star topology, mirrors broadcastLogEntry):
  //   - Host: sends to ALL players.
  //   - Player: sends to host ONLY; host re-broadcasts to other players.
  const broadcastDiceColors = useCallback((colors: { diceColor: string; symbolColor: string }) => {
    const myPeerId = useFateStore.getState().networkMyPeerId;
    if (!myPeerId) return;
    const payload: DiceColorsPayload = {
      fromPeerId: myPeerId,
      diceColor: colors.diceColor,
      symbolColor: colors.symbolColor,
      ts: Date.now(),
    };
    for (const peerId of Array.from(_net.dataChannels.keys())) {
      sendOnChannel(peerId, { type: 'dice-colors', payload });
    }
  }, [sendOnChannel]);

  // ── Idle-cursor sweeper: every 1s, mark peers as idle (active=false) if
  // they haven't sent a cursor-move in >3s. The cursor stays visible but
  // rendered at reduced opacity so users know it's stale.
  useEffect(() => {
    const IDLE_THRESHOLD_MS = 3000;
    const id = window.setInterval(() => {
      const now = Date.now();
      const { peerCursors, setPeerCursor } = useFateStore.getState();
      for (const [peerId, c] of Object.entries(peerCursors)) {
        if (c.active && now - c.ts > IDLE_THRESHOLD_MS) {
          setPeerCursor(peerId, { ...c, active: false });
        }
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  // ── Ping/pong heartbeat: every 5s, send a ping to every connected peer
  // over their DataChannel. The recipient echoes back a pong with the same
  // timestamp; the sender computes RTT = now - ts and stores it in
  // `peerLatencies`. The host pings each player; players ping the host.
  // This also serves as a liveness probe — `peerLastSeen` is updated on
  // every pong, and the UI can mark peers as stale if lastSeen is old.
  useEffect(() => {
    const PING_INTERVAL_MS = 5000;
    const id = window.setInterval(() => {
      const role = _net.role;
      if (!role) return;
      const now = Date.now();
      for (const peerId of Array.from(_net.dataChannels.keys())) {
        const ch = _net.dataChannels.get(peerId);
        if (ch && ch.readyState === 'open') {
          try {
            ch.send(JSON.stringify({ type: 'ping', payload: { ts: now } } as DataChannelMessage));
          } catch (e) {
            console.warn('[useNetwork] ping send failed for', peerId, e);
          }
        }
      }
    }, PING_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  // ── Stale-peer sweeper: every 15s, drop peers whose lastSeen is older
  // than 30s. This clears the latency/lastSeen entries when a peer has
  // silently disconnected without sending a peer:left event (rare but
  // possible on mobile networks where the socket just dies).
  useEffect(() => {
    const SWEEP_INTERVAL_MS = 15000;
    const STALE_THRESHOLD_MS = 30000;
    const id = window.setInterval(() => {
      const now = Date.now();
      const { peerLastSeen, forgetPeer } = useFateStore.getState();
      for (const [peerId, lastSeen] of Object.entries(peerLastSeen)) {
        if (now - lastSeen > STALE_THRESHOLD_MS) {
          forgetPeer(peerId);
        }
      }
    }, SWEEP_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);

  // ── Register network broadcasters with the store ──────────
  // The store's addLogEntry calls _broadcastLogEntryFn to push entries to
  // peers without a circular import. We register the fn here (on mount).
  // We deliberately do NOT unregister on unmount — useNetwork is a shared
  // singleton called by MANY components (header, dialogs, panels), and each
  // unmount would clear the broadcasters for the still-mounted siblings. The
  // fns are stable (useCallback with [sendOnChannel], sendOnChannel is []) so
  // re-registration is idempotent. The refs live for the page lifetime; the
  // browser cleans up on unload.
  useEffect(() => {
    useFateStore.getState().setNetworkBroadcasters({
      broadcastLogEntry: (entry) => broadcastLogEntry(entry as Record<string, unknown>),
      broadcastRollStage: (event) => broadcastRollStage(event),
      broadcastDiceColors: (colors) => broadcastDiceColors(colors),
      // Real-time scene sync: when the GM (or a player, for their own
      // character's token) updates a scene, broadcast it to peers. This
      // is what makes token moves, drawings, zones, and fog edits appear
      // live on other clients — previously only the initial connect
      // snapshot was sent, so all subsequent edits were invisible until
      // a reconnect/refresh.
      broadcastSceneUpdate: (sceneId, data) =>
        broadcastSceneUpdate(sceneId, data as Record<string, unknown>),
      broadcastCharacterUpdate: (characterId, data) =>
        broadcastCharacterUpdate(characterId, data as Record<string, unknown>),
      broadcastTokenMove: (sceneId, floorIndex, charId, x, y) =>
        broadcastTokenMove(sceneId, floorIndex, charId, x, y),
    });
  }, [broadcastLogEntry, broadcastRollStage, broadcastDiceColors, broadcastSceneUpdate, broadcastCharacterUpdate, broadcastTokenMove]);

  // ── Cleanup on unmount ────────────────────────────────────
  // NOTE: The socket, peers, and data channels are module-level singletons
  // shared across ALL useNetwork() callers. We deliberately do NOT disconnect
  // them here — otherwise closing one dialog (e.g. sync-roll-dialog) would
  // kill the connection for every other component. Explicit teardown happens
  // only via leaveSession(). The socket lives for the page lifetime; the
  // browser cleans it up on unload.
  useEffect(() => {
    return () => {
      // No-op: shared singleton must persist across mount/unmount cycles.
      // (React StrictMode double-mounts in dev; tearing down here would be
      // catastrophic for the other mounted instances.)
    };
  }, []);

  return {
    hostRoom,
    joinRoom,
    leaveSession,
    restoreSession,
    sendStateToPlayers,
    broadcastAction,
    broadcastAssignment,
    broadcastSyncRoll,
    sendSyncRollResult,
    broadcastMassRollInvite,
    sendMassRollReady,
    broadcastMassRollStart,
    broadcastMassRollCancel,
    broadcastMassRollResults,
    sendMassRollAdjust,
    sendMassRollReroll,
    sendCursorMove,
    sendCursorLeave,
    broadcastRollStage,
    sendRollStage,
    broadcastLogEntry,
    broadcastTokenMove,
  };
}
