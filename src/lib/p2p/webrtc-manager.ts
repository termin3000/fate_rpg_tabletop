// ============================================================
// Fate RPG — WebRTC Manager
// ============================================================
// Manages RTCPeerConnection(s) and DataChannel(s) for P2P data.
// Star topology: GM (host) is the hub; each player has a direct
// connection to the host. Players do NOT connect to each other.
// ============================================================

'use client';

import type { P2PMessage } from './message-types';

// ICE servers: Google STUN + OpenRelay TURN (free, public).
// TURN is used as a fallback when STUN alone can't traverse symmetric NAT,
// carrier-grade NAT, or strict corporate firewalls. Credentials are public
// and shared by Metered for open use — see https://www.metered.ca/openrelay/
const ICE_SERVERS: RTCIceServer[] = [
  // Primary STUN
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // OpenRelay STUN (port 80 fallback when 19302 blocked)
  { urls: 'stun:openrelay.metered.ca:80' },
  // OpenRelay TURN — UDP
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  // OpenRelay TURN — TCP
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  // OpenRelay TURN — TLS (most restrictive firewalls)
  {
    urls: 'turns:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
];

export interface WebRtcHandlers {
  /** Called when a DataChannel message arrives. */
  onMessage?: (fromPeerId: string, msg: P2PMessage) => void;
  /** Called when a peer's connection state changes. */
  onPeerStateChange?: (peerId: string, state: RTCPeerConnectionState) => void;
  /** Called when a new peer connection is established (open DataChannel). */
  onPeerConnected?: (peerId: string) => void;
  /** Called when a peer connection is closed or failed. */
  onPeerDisconnected?: (peerId: string) => void;
  /** Called when an offer needs to be sent via signaling. */
  onSendOffer?: (toPeerId: string, sdp: RTCSessionDescriptionInit) => void;
  /** Called when an answer needs to be sent via signaling. */
  onSendAnswer?: (toPeerId: string, sdp: RTCSessionDescriptionInit) => void;
  /** Called when an ICE candidate needs to be sent via signaling. */
  onSendIce?: (toPeerId: string, candidate: RTCIceCandidateInit) => void;
}

interface PeerConn {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  role: 'host-initiated' | 'player-initiated';
}

/**
 * WebRtcManager — manages peer connections.
 *
 * Host mode: when a new player joins, host calls createOffer(playerId).
 * Player mode: receives offer via handleOffer, sends answer via handleAnswer.
 */
export class WebRtcManager {
  private peers = new Map<string, PeerConn>();
  private handlers: WebRtcHandlers = {};
  private isHost = false;

  setHandlers(handlers: WebRtcHandlers) {
    this.handlers = handlers;
  }

  setHostMode(isHost: boolean) {
    this.isHost = isHost;
  }

  // ── Host: create offer to a newly-joined player ─────────
  async createOffer(playerPeerId: string): Promise<void> {
    if (this.peers.has(playerPeerId)) {
      // Already have a connection — skip
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    // Host creates the DataChannel
    const dc = pc.createDataChannel('fate-data', { ordered: true });
    this.setupDataChannel(playerPeerId, dc);

    const conn: PeerConn = { pc, dc, role: 'host-initiated' };
    this.peers.set(playerPeerId, conn);
    this.setupIceHandlers(playerPeerId, pc);
    this.setupConnectionStateHandler(playerPeerId, pc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.handlers.onSendOffer?.(playerPeerId, offer);
  }

  // ── Player: handle incoming offer from host ─────────────
  async handleOffer(hostPeerId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    // If we already have a connection to this peer, close it first (reconnect case)
    const existing = this.peers.get(hostPeerId);
    if (existing) {
      try { existing.pc.close(); } catch {}
      this.peers.delete(hostPeerId);
    }
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.ondatachannel = (event) => {
      const dc = event.channel;
      this.setupDataChannel(hostPeerId, dc);
      const conn = this.peers.get(hostPeerId);
      if (conn) conn.dc = dc;
    };
    const conn: PeerConn = { pc, dc: null, role: 'player-initiated' };
    this.peers.set(hostPeerId, conn);
    this.setupIceHandlers(hostPeerId, pc);
    this.setupConnectionStateHandler(hostPeerId, pc);

    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.handlers.onSendAnswer?.(hostPeerId, answer);
  }

  // ── Either side: handle incoming answer ─────────────────
  async handleAnswer(peerId: string, sdp: RTCSessionDescriptionInit): Promise<void> {
    const conn = this.peers.get(peerId);
    if (!conn) return;
    await conn.pc.setRemoteDescription(sdp);
  }

  // ── Either side: handle incoming ICE candidate ──────────
  async handleIce(peerId: string, candidate: RTCIceCandidateInit): Promise<void> {
    const conn = this.peers.get(peerId);
    if (!conn) return;
    try {
      await conn.pc.addIceCandidate(candidate);
    } catch (err) {
      // Ignore stale candidates from previous connection attempts
      console.warn('[webrtc] addIceCandidate error:', err);
    }
  }

  // ── Send a message to a specific peer ───────────────────
  sendTo(peerId: string, msg: P2PMessage): boolean {
    const conn = this.peers.get(peerId);
    if (!conn || !conn.dc || conn.dc.readyState !== 'open') return false;
    try {
      conn.dc.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.warn('[webrtc] send error:', err);
      return false;
    }
  }

  // ── Host: broadcast a message to all peers ──────────────
  broadcast(msg: P2PMessage): number {
    let sent = 0;
    for (const peerId of this.peers.keys()) {
      if (this.sendTo(peerId, msg)) sent++;
    }
    return sent;
  }

  // ── Get all connected peer ids (with open DataChannel) ──
  getConnectedPeerIds(): string[] {
    const result: string[] = [];
    for (const [peerId, conn] of this.peers.entries()) {
      if (conn.dc?.readyState === 'open') result.push(peerId);
    }
    return result;
  }

  /** Get the connection state of a peer. */
  getPeerState(peerId: string): RTCPeerConnectionState | null {
    const conn = this.peers.get(peerId);
    return conn ? conn.pc.connectionState : null;
  }

  // ── Close a specific peer connection ────────────────────
  closePeer(peerId: string) {
    const conn = this.peers.get(peerId);
    if (conn) {
      try { conn.dc?.close(); } catch {}
      try { conn.pc.close(); } catch {}
      this.peers.delete(peerId);
    }
  }

  // ── Close all peer connections ──────────────────────────
  closeAll() {
    for (const peerId of this.peers.keys()) {
      this.closePeer(peerId);
    }
  }

  // ── Internal: DataChannel setup ─────────────────────────
  private setupDataChannel(peerId: string, dc: RTCDataChannel) {
    dc.onopen = () => {
      this.handlers.onPeerConnected?.(peerId);
    };
    dc.onclose = () => {
      this.handlers.onPeerDisconnected?.(peerId);
    };
    dc.onerror = (e) => {
      console.warn('[webrtc] dc error:', e);
    };
    dc.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as P2PMessage;
        this.handlers.onMessage?.(peerId, msg);
      } catch (err) {
        console.warn('[webrtc] invalid message:', err, event.data);
      }
    };
  }

  private setupIceHandlers(peerId: string, pc: RTCPeerConnection) {
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.handlers.onSendIce?.(peerId, event.candidate.toJSON());
      }
    };
  }

  private setupConnectionStateHandler(peerId: string, pc: RTCPeerConnection) {
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.handlers.onPeerStateChange?.(peerId, state);
      if (state === 'failed' || state === 'closed' || state === 'disconnected') {
        // Note: we don't auto-remove here — store will decide via timeout
        if (state === 'failed') {
          this.handlers.onPeerDisconnected?.(peerId);
        }
      }
    };
  }
}

// Singleton instance.
let _instance: WebRtcManager | null = null;
export function getWebRtcManager(): WebRtcManager {
  if (!_instance) {
    _instance = new WebRtcManager();
  }
  return _instance;
}
