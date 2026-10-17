// ============================================================
// Fate RPG — P2P Network Manager
// ============================================================
// High-level orchestrator that ties together signaling-client and
// webrtc-manager, exposes simple actions to the UI/store layer.
// ============================================================

'use client';

import { getSignalingClient, SignalingClient } from './signaling-client';
import { getWebRtcManager, WebRtcManager } from './webrtc-manager';
import { buildPlayerVisibleState, logEntryToSerializable } from './state-sync';
import type {
  NetworkRole,
  NetworkStatus,
  PeerMeta,
  P2PMessage,
  PlayerVisibleState,
  RollEventMessage,
  SerializableLogEntry,
  SheetAuditMessage,
  StateSnapshotMessage,
} from './message-types';
import type {
  Adventure,
  Character,
  LogEntry,
  Scene,
} from '@/lib/types';

// ── Callbacks (the store registers these) ──────────────────
export interface P2PCallbacks {
  onStatusChange: (status: NetworkStatus) => void;
  onPeersChange: (peers: PeerMeta[]) => void;
  /** Host: a player joined the signaling room (need to send WebRTC offer). */
  onPlayerJoinedSignaling: (peerId: string, name: string) => void;
  /** Player: received a full state snapshot from host. */
  onStateSnapshot: (state: PlayerVisibleState) => void;
  /** Player: received a delta update from host. */
  onStateDelta: (patch: Array<{ op: string; path: string; value?: unknown }>) => void;
  /** Host: received a roll event from a player (persist + broadcast). */
  onRollEvent: (roll: SerializableLogEntry, fromPeerId: string) => void;
  /** Host: received a sheet update from a player (apply + broadcast). */
  onSheetUpdate: (characterId: string, patch: Array<{ op: string; path: string; value?: unknown }>, fromPeerId: string) => void;
  /** Player: received a sheet audit (only relevant for GM, so usually ignored by player). */
  onSheetAudit: (audit: { characterId: string; characterName: string; description: string; ts: number }) => void;
  /** Host: a peer's WebRTC connection state changed. */
  onPeerConnectionStateChange: (peerId: string, state: RTCPeerConnectionState) => void;
}

const PING_INTERVAL_MS = 15000; // 15s

/**
 * P2PManager — singleton orchestrator.
 *
 * Lifecycle:
 *  1. startHost(roomId, name) — GM starts network mode
 *  2. startPlayer(roomId, name) — player joins
 *  3. host pushes state via pushStateSnapshot() / pushStateDelta()
 *  4. player rolls → sendRollEvent() → host persists + broadcasts
 *  5. player edits sheet → sendSheetUpdate() → host applies + broadcasts audit
 *  6. stop() — disconnect everything
 */
export class P2PManager {
  private signaling: SignalingClient;
  private webrtc: WebRtcManager;
  private callbacks: P2PCallbacks | null = null;
  private role: NetworkRole | null = null;
  private roomId: string | null = null;
  private myPeerId: string | null = null;
  private myName: string = 'Игрок';
  private status: NetworkStatus = 'offline';
  private peers: PeerMeta[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastSnapshotVersion = 0;
  // For host: keep latest full state for late joiners
  private lastSnapshot: PlayerVisibleState | null = null;

  constructor() {
    this.signaling = getSignalingClient();
    this.webrtc = getWebRtcManager();
    this.setupSignalingHandlers();
    this.setupWebRtcHandlers();
  }

  setCallbacks(cbs: P2PCallbacks) {
    this.callbacks = cbs;
  }

  getStatus(): NetworkStatus {
    return this.status;
  }

  getRole(): NetworkRole | null {
    return this.role;
  }

  getRoomId(): string | null {
    return this.roomId;
  }

  getMyPeerId(): string | null {
    return this.myPeerId;
  }

  getMyName(): string {
    return this.myName;
  }

  getPeers(): PeerMeta[] {
    return [...this.peers];
  }

  // ── Start as host (GM) ──────────────────────────────────
  async startHost(roomId: string, name: string): Promise<void> {
    this.role = 'host';
    this.roomId = roomId;
    this.myName = name;
    this.setStatus('connecting');
    this.webrtc.setHostMode(true);
    try {
      await this.signaling.connect(roomId, name, true);
      // myPeerId will be set via the 'joined' event
      this.startPingLoop();
    } catch (err) {
      this.setStatus('error');
      throw err;
    }
  }

  // ── Start as player ─────────────────────────────────────
  async startPlayer(roomId: string, name: string): Promise<void> {
    this.role = 'player';
    this.roomId = roomId;
    this.myName = name;
    this.setStatus('connecting');
    this.webrtc.setHostMode(false);
    try {
      await this.signaling.connect(roomId, name, false);
      this.startPingLoop();
    } catch (err) {
      this.setStatus('error');
      throw err;
    }
  }

  // ── Stop networking ─────────────────────────────────────
  stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.webrtc.closeAll();
    this.signaling.disconnect();
    this.role = null;
    this.roomId = null;
    this.myPeerId = null;
    this.peers = [];
    this.lastSnapshot = null;
    this.lastSnapshotVersion = 0;
    this.setStatus('offline');
    this.callbacks?.onPeersChange([]);
  }

  // ── Host: push a full state snapshot to all players ─────
  pushStateSnapshot(
    adventure: Adventure,
    scene: Scene,
    characters: Character[],
    logEntries: LogEntry[],
  ) {
    if (this.role !== 'host') return;
    const state = buildPlayerVisibleState(adventure, scene, characters, logEntries);
    this.lastSnapshot = state;
    this.lastSnapshotVersion++;
    const msg: StateSnapshotMessage = {
      type: 'state-snapshot',
      version: this.lastSnapshotVersion,
      adventureId: adventure.id,
      sceneId: scene.id,
      state,
      ts: Date.now(),
    };
    this.webrtc.broadcast(msg);
  }

  // ── Host: push a delta (used for incremental updates) ───
  pushStateDelta(patch: Array<{ op: 'replace' | 'add' | 'remove'; path: string; value?: unknown }>) {
    if (this.role !== 'host') return;
    this.lastSnapshotVersion++;
    const msg: P2PMessage = {
      type: 'state-delta',
      version: this.lastSnapshotVersion,
      sceneId: this.roomId ?? '',
      patch,
      ts: Date.now(),
    };
    this.webrtc.broadcast(msg);
  }

  // ── Player: send a roll event to host ───────────────────
  sendRollEvent(roll: LogEntry) {
    if (this.role !== 'player' || !this.myPeerId) return;
    const msg: RollEventMessage = {
      type: 'roll-event',
      roll: logEntryToSerializable(roll),
      fromPeerId: this.myPeerId,
      ts: Date.now(),
    };
    // Find the host in our peer list (only one)
    const hostPeer = this.peers.find((p) => p.isHost);
    if (hostPeer) {
      this.webrtc.sendTo(hostPeer.peerId, msg);
    }
  }

  // ── Player: send a sheet update to host ─────────────────
  sendSheetUpdate(characterId: string, patch: Array<{ op: 'replace' | 'add' | 'remove'; path: string; value?: unknown }>) {
    if (this.role !== 'player' || !this.myPeerId) return;
    const msg: P2PMessage = {
      type: 'sheet-update',
      characterId,
      patch,
      fromPeerId: this.myPeerId,
      ts: Date.now(),
    };
    const hostPeer = this.peers.find((p) => p.isHost);
    if (hostPeer) {
      this.webrtc.sendTo(hostPeer.peerId, msg);
    }
  }

  // ── Host: broadcast a sheet audit to GM's own log ───────
  // (No-op for player role; on host side, the store should listen for sheet-audit messages
  //  via onSheetAudit callback and add an entry to the GM log.)
  broadcastSheetAudit(characterId: string, characterName: string, description: string) {
    if (this.role !== 'host') return;
    const msg: SheetAuditMessage = {
      type: 'sheet-audit',
      characterId,
      characterName,
      description,
      ts: Date.now(),
    };
    // Send to all players too (they may want to update their UI, though audit is GM-only log)
    this.webrtc.broadcast(msg);
  }

  // ── Host: send latest snapshot to a newly-connected peer ─
  sendSnapshotToPeer(peerId: string) {
    if (this.role !== 'host' || !this.lastSnapshot) return;
    const msg: StateSnapshotMessage = {
      type: 'state-snapshot',
      version: this.lastSnapshotVersion,
      adventureId: this.lastSnapshot.adventureId,
      sceneId: this.lastSnapshot.sceneId,
      state: this.lastSnapshot,
      ts: Date.now(),
    };
    this.webrtc.sendTo(peerId, msg);
  }

  // ── Update this peer's metadata (name / assigned character) ──
  updateMeta(meta: { name?: string; characterId?: string | null }) {
    if (meta.name !== undefined) this.myName = meta.name;
    this.signaling.updateMeta(meta);
  }

  // ── Internal: setup signaling event handlers ────────────
  private setupSignalingHandlers() {
    this.signaling.setHandlers({
      onConnect: () => {
        this.setStatus('online');
      },
      onDisconnect: () => {
        if (this.role === 'player') {
          // Player needs host to re-establish connection
          this.setStatus('connecting');
        }
      },
      onJoined: (data) => {
        this.myPeerId = data.peerId;
        this.setStatus('online');
      },
      onRoster: (peers) => {
        // Map roster to PeerMeta, preserving ping/state info from existing list
        const prev = new Map(this.peers.map((p) => [p.peerId, p]));
        this.peers = peers.map((p) => ({
          peerId: p.peerId,
          name: p.name,
          isHost: p.isHost,
          characterId: p.characterId,
          pingMs: prev.get(p.peerId)?.pingMs,
          connectionState: prev.get(p.peerId)?.connectionState,
        }));
        this.callbacks?.onPeersChange([...this.peers]);
      },
      onPlayerJoined: (data) => {
        if (this.role === 'host') {
          // Host initiates WebRTC offer to the new player
          this.webrtc.createOffer(data.peerId).catch((err) => {
            console.warn('[p2p] createOffer error:', err);
          });
          this.callbacks?.onPlayerJoinedSignaling(data.peerId, data.name);
        }
      },
      onPeerLeft: (data) => {
        this.peers = this.peers.filter((p) => p.peerId !== data.peerId);
        this.callbacks?.onPeersChange([...this.peers]);
        this.webrtc.closePeer(data.peerId);
      },
      onOffer: (data) => {
        this.webrtc.handleOffer(data.from, data.sdp as RTCSessionDescriptionInit).catch((err) => {
          console.warn('[p2p] handleOffer error:', err);
        });
      },
      onAnswer: (data) => {
        this.webrtc.handleAnswer(data.from, data.sdp as RTCSessionDescriptionInit).catch((err) => {
          console.warn('[p2p] handleAnswer error:', err);
        });
      },
      onIce: (data) => {
        this.webrtc.handleIce(data.from, data.candidate as RTCIceCandidateInit).catch((err) => {
          console.warn('[p2p] handleIce error:', err);
        });
      },
      onError: (msg) => {
        console.error('[p2p] signaling error:', msg);
        this.setStatus('error');
      },
      onStateUpdate: (payload) => {
        // Player receives state update from host (broadcast via signaling — fallback path
        // for when WebRTC DataChannel is not yet open)
        this.handleIncomingMessage('__signaling__', payload as P2PMessage);
      },
      onPeerEvent: (payload) => {
        // Generic peer event via signaling (fallback for DataChannel)
        this.handleIncomingMessage(payload.from, {
          type: payload.type,
          ...((payload.data as Record<string, unknown>) ?? {}),
        } as P2PMessage);
      },
    });
  }

  // ── Internal: setup WebRTC event handlers ───────────────
  private setupWebRtcHandlers() {
    this.webrtc.setHandlers({
      onMessage: (fromPeerId, msg) => {
        this.handleIncomingMessage(fromPeerId, msg);
      },
      onPeerStateChange: (peerId, state) => {
        const idx = this.peers.findIndex((p) => p.peerId === peerId);
        if (idx >= 0) {
          this.peers[idx] = { ...this.peers[idx], connectionState: state };
          this.callbacks?.onPeersChange([...this.peers]);
        }
        this.callbacks?.onPeerConnectionStateChange(peerId, state);
      },
      onPeerConnected: (peerId) => {
        // If host: send the latest snapshot to this newly-connected player
        if (this.role === 'host') {
          this.sendSnapshotToPeer(peerId);
        }
      },
      onPeerDisconnected: (peerId) => {
        // Mark peer as disconnected but keep in roster (signaling still shows them)
        const idx = this.peers.findIndex((p) => p.peerId === peerId);
        if (idx >= 0) {
          this.peers[idx] = { ...this.peers[idx], connectionState: 'disconnected' };
          this.callbacks?.onPeersChange([...this.peers]);
        }
      },
      onSendOffer: (toPeerId, sdp) => {
        this.signaling.sendOffer(toPeerId, sdp);
      },
      onSendAnswer: (toPeerId, sdp) => {
        this.signaling.sendAnswer(toPeerId, sdp);
      },
      onSendIce: (toPeerId, candidate) => {
        this.signaling.sendIce(toPeerId, candidate);
      },
    });
  }

  // ── Internal: dispatch incoming P2P messages ────────────
  private handleIncomingMessage(_fromPeerId: string, msg: P2PMessage) {
    switch (msg.type) {
      case 'state-snapshot': {
        this.callbacks?.onStateSnapshot(msg.state);
        break;
      }
      case 'state-delta': {
        this.callbacks?.onStateDelta(msg.patch);
        break;
      }
      case 'roll-event': {
        if (this.role === 'host') {
          this.callbacks?.onRollEvent(msg.roll, msg.fromPeerId);
          // Host re-broadcasts the roll to all other players (so they see each other's rolls)
          this.webrtc.broadcast(msg);
        } else {
          // Player receives a roll from another player (relayed by host)
          this.callbacks?.onRollEvent(msg.roll, msg.fromPeerId);
        }
        break;
      }
      case 'sheet-update': {
        if (this.role === 'host') {
          this.callbacks?.onSheetUpdate(msg.characterId, msg.patch, msg.fromPeerId);
        }
        break;
      }
      case 'sheet-audit': {
        this.callbacks?.onSheetAudit({
          characterId: msg.characterId,
          characterName: msg.characterName,
          description: msg.description,
          ts: msg.ts,
        });
        break;
      }
      case 'presence': {
        // Update last-seen timestamp (for ping calc)
        break;
      }
      case 'request-snapshot': {
        if (this.role === 'host') {
          this.sendSnapshotToPeer(msg.fromPeerId);
        }
        break;
      }
      case 'peer-info': {
        // Player learns their assigned characterId — store will handle
        break;
      }
    }
  }

  // ── Internal: status helper ─────────────────────────────
  private setStatus(status: NetworkStatus) {
    this.status = status;
    this.callbacks?.onStatusChange(status);
  }

  // ── Internal: ping loop (for latency display) ───────────
  private startPingLoop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      // Simple ping: emit a presence event via signaling (cheap, doesn't need DataChannel)
      // The actual RTT measurement would require a round-trip; for Phase 1 we just
      // estimate via signaling socket latency which is good enough for UI.
      // TODO: proper RTT via DataChannel ping/pong
    }, PING_INTERVAL_MS);
  }
}

// Singleton instance
let _instance: P2PManager | null = null;
export function getP2PManager(): P2PManager {
  if (!_instance) {
    _instance = new P2PManager();
  }
  return _instance;
}

// ── Utility: generate a short room code (6 chars, easy to type) ──
export function generateRoomCode(): string {
  // Avoid ambiguous chars (0/O, 1/I/L)
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

// ── Utility: generate a unique peerId per browser tab ──────
// NOTE: sessionStorage (not localStorage) so each tab gets its own peerId.
// Using localStorage would cause all tabs in the same browser to share one
// peerId, which collides on the signaling server's peerSockets map.
const PEER_ID_KEY = 'fate-peer-id';
export function getOrCreatePeerId(): string {
  if (typeof window === 'undefined') return 'ssr-' + Math.random().toString(36).slice(2, 10);
  try {
    let id = sessionStorage.getItem(PEER_ID_KEY);
    if (!id) {
      id = 'p-' + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem(PEER_ID_KEY, id);
    }
    return id;
  } catch {
    return 'p-' + Math.random().toString(36).slice(2, 10);
  }
}
