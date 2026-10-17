// ============================================================
// Fate RPG — Signaling Client
// ============================================================
// Wraps socket.io-client connection to the signaling mini-service
// (port 3004). Used by both host (GM) and player to:
//  - join a room by id
//  - exchange SDP offers/answers/ICE candidates
//  - broadcast game state and events
//  - maintain a roster of connected peers
// ============================================================

'use client';

import { io, Socket } from 'socket.io-client';

export interface SignalingEvents {
  onJoined: (data: { roomId: string; peerId: string; isHost: boolean }) => void;
  onRoster: (peers: Array<{ peerId: string; name: string; isHost: boolean; characterId: string | null }>) => void;
  onPlayerJoined: (data: { peerId: string; name: string }) => void;
  onPeerLeft: (data: { peerId: string }) => void;
  onOffer: (data: { from: string; sdp: unknown }) => void;
  onAnswer: (data: { from: string; sdp: unknown }) => void;
  onIce: (data: { from: string; candidate: unknown }) => void;
  onStateUpdate: (payload: unknown) => void;
  onPeerEvent: (payload: { from: string; type: string; data: unknown }) => void;
  onError: (msg: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
}

export class SignalingClient {
  private socket: Socket | null = null;
  private roomId: string | null = null;
  private isHost: boolean = false;
  private handlers: Partial<SignalingEvents> = {};

  setHandlers(handlers: Partial<SignalingEvents>) {
    this.handlers = handlers;
  }

  /**
   * Connect to the signaling server and join a room.
   * For host: roomId is generated fresh; for player: roomId is provided by GM.
   */
  connect(roomId: string, name: string, isHost: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      // Disconnect any existing socket first
      this.disconnect();

      // Detect the best signaling URL by probing both strategies with a quick
      // HTTP fetch. This is more reliable than guessing from window.location
      // because it works regardless of how the page is accessed (localhost:3000
      // direct, Caddy:81, preview tunnel on :80/:443, custom domain, etc.).
      const probe = async (url: string): Promise<boolean> => {
        try {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 2500);
          const r = await fetch(url, { signal: ctrl.signal, method: 'GET' });
          clearTimeout(t);
          if (!r.ok) return false;
          const text = await r.text();
          // socket.io polling handshake returns something like:
          // 0{"sid":"...","upgrades":["websocket"],...}
          return text.startsWith('0{') && text.includes('"sid"');
        } catch {
          return false;
        }
      };

      const tryConnect = (
        socketUrl: string,
        query: Record<string, string> | undefined,
        onFail: () => void,
      ) => {
        const socketOpts: Record<string, unknown> = {
          transports: ['polling'],
          forceNew: true,
          reconnection: false, // we handle retries ourselves
          timeout: 6000,
        };
        if (query && Object.keys(query).length > 0) {
          socketOpts.query = query;
        }
        const socket = io(socketUrl, socketOpts as any);
        this.socket = socket;
        this.roomId = roomId;
        this.isHost = isHost;

        let settled = false;

        const failTimer = setTimeout(() => {
          if (settled) return;
          settled = true;
          try { socket.removeAllListeners(); socket.disconnect(); } catch {}
          this.socket = null;
          onFail();
        }, 7000);

        socket.on('connect', () => {
          if (settled) return;
          // Emit join-room — server will respond with 'joined' or 'error-msg'
          socket.emit('join-room', { roomId, name, isHost });
        });

        socket.on('joined', (data: { roomId: string; peerId: string; isHost: boolean }) => {
          if (settled) return;
          settled = true;
          clearTimeout(failTimer);
          this.handlers.onConnect?.();
          this.handlers.onJoined?.(data);
          // Enable reconnection now that we're joined
          socket.io.opts.reconnection = true;
          socket.io.opts.reconnectionAttempts = 10;
          socket.io.opts.reconnectionDelay = 1000;
          resolve();
        });

        socket.on('error-msg', (data: { message: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(failTimer);
          try { socket.removeAllListeners(); socket.disconnect(); } catch {}
          this.socket = null;
          this.handlers.onError?.(data.message);
          reject(new Error(data.message));
        });

        socket.on('connect_error', (err: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(failTimer);
          try { socket.removeAllListeners(); socket.disconnect(); } catch {}
          this.socket = null;
          onFail();
          void err;
        });

        // Wire up the rest of the event handlers (these are no-ops until
        // joined succeeds, but safe to register early)
        this.attachPersistentHandlers(socket);
      };

      const failAll = () => {
        this.handlers.onError?.('Signaling server unreachable (tried both gateway and direct)');
        reject(new Error('Signaling server unreachable'));
      };

      // Strategy 0: Caddy gateway on port 81 (works in sandbox/agent-browser
      // where browser opens localhost:3000 directly — port 81 is reachable
      // and Caddy proxies XTransformPort=3004 to localhost:3004)
      const probe0Url = 'http://localhost:81/socket.io/?EIO=4&transport=polling&XTransformPort=3004';
      // Strategy 1: relative path with XTransformPort (works through Caddy /
      // any gateway that respects the query param — for production via domain)
      const probe1Url = '/?XTransformPort=3004&EIO=4&transport=polling';
      // Strategy 2: direct localhost:3004 (works only when browser can reach
      // localhost — i.e. running on the same machine as the dev server)
      const probe2Url = 'http://localhost:3004/socket.io/?EIO=4&transport=polling';

      (async () => {
        // Try gateway:81 first (most reliable in sandbox)
        const ok0 = await probe(probe0Url);
        if (ok0) {
          tryConnect('http://localhost:81', { XTransformPort: '3004' }, async () => {
            // Fall through to other strategies if gateway:81 connect fails
            const ok1 = await probe(probe1Url);
            if (ok1) {
              tryConnect('/', { XTransformPort: '3004' }, async () => {
                const ok2 = await probe(probe2Url);
                if (ok2) {
                  tryConnect('http://localhost:3004', undefined, failAll);
                } else {
                  failAll();
                }
              });
              return;
            }
            const ok2 = await probe(probe2Url);
            if (ok2) {
              tryConnect('http://localhost:3004', undefined, failAll);
            } else {
              failAll();
            }
          });
          return;
        }
        const ok1 = await probe(probe1Url);
        if (ok1) {
          tryConnect('/', { XTransformPort: '3004' }, async () => {
            const ok2 = await probe(probe2Url);
            if (ok2) {
              tryConnect('http://localhost:3004', undefined, failAll);
            } else {
              failAll();
            }
          });
          return;
        }
        const ok2 = await probe(probe2Url);
        if (ok2) {
          tryConnect('http://localhost:3004', undefined, failAll);
        } else {
          failAll();
        }
      })();
    });
  }

  /** Wire up event handlers that should persist for the lifetime of a socket. */
  private attachPersistentHandlers(socket: Socket) {
    socket.on('roster', (data: { peers: Array<{ peerId: string; name: string; isHost: boolean; characterId: string | null }> }) => {
      this.handlers.onRoster?.(data.peers);
    });

    socket.on('player-joined', (data: { peerId: string; name: string }) => {
      this.handlers.onPlayerJoined?.(data);
    });

    socket.on('peer-left', (data: { peerId: string }) => {
      this.handlers.onPeerLeft?.(data);
    });

    socket.on('webrtc-offer', (data: { from: string; sdp: unknown }) => {
      this.handlers.onOffer?.(data);
    });

    socket.on('webrtc-answer', (data: { from: string; sdp: unknown }) => {
      this.handlers.onAnswer?.(data);
    });

    socket.on('webrtc-ice', (data: { from: string; candidate: unknown }) => {
      this.handlers.onIce?.(data);
    });

    socket.on('state-update', (payload: unknown) => {
      this.handlers.onStateUpdate?.(payload);
    });

    socket.on('peer-event', (payload: { from: string; type: string; data: unknown }) => {
      this.handlers.onPeerEvent?.(payload);
    });

    socket.on('disconnect', () => {
      this.handlers.onDisconnect?.();
    });
  }

  /** Send WebRTC offer to a peer (host → player). */
  sendOffer(to: string, sdp: unknown) {
    this.socket?.emit('webrtc-offer', { to, sdp });
  }

  /** Send WebRTC answer to a peer (player → host). */
  sendAnswer(to: string, sdp: unknown) {
    this.socket?.emit('webrtc-answer', { to, sdp });
  }

  /** Send ICE candidate to a peer. */
  sendIce(to: string, candidate: unknown) {
    this.socket?.emit('webrtc-ice', { to, candidate });
  }

  /** Update this peer's metadata (name / characterId). */
  updateMeta(meta: { name?: string; characterId?: string | null }) {
    this.socket?.emit('update-meta', meta);
  }

  /** Host-only: broadcast game state to all players. */
  broadcastState(payload: unknown) {
    if (!this.isHost) return;
    this.socket?.emit('state-broadcast', payload);
  }

  /** Any peer: broadcast a game event (dice roll, sheet audit, presence). */
  broadcastEvent(type: string, data: unknown) {
    this.socket?.emit('event-broadcast', { type, data });
  }

  /** Get our socket id (= our peerId on the signaling layer). */
  getPeerId(): string | null {
    return this.socket?.id ?? null;
  }

  /** Are we connected to the signaling server? */
  isConnected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Disconnect and clean up. */
  disconnect() {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
    this.roomId = null;
  }
}

// Singleton instance — one signaling client per browser tab.
let _instance: SignalingClient | null = null;
export function getSignalingClient(): SignalingClient {
  if (!_instance) {
    _instance = new SignalingClient();
  }
  return _instance;
}
