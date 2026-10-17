/**
 * Fate RPG VTT — Signaling Mini-Service
 *
 * Socket.io server that brokers WebRTC signaling between the GM (host) and
 * players for the Fate RPG Virtual Tabletop. Uses a star topology: the host is
 * the central node and every player maintains a direct P2P connection to the
 * host. This service only relays SDP/ICE messages and room metadata — it never
 * touches game media (audio/video/state) directly.
 *
 * Port: 3004 (hardcoded intentionally — Caddy routes via XTransformPort=3004).
 */

import { createServer } from "http";
import { Server, type Socket } from "socket.io";

const PORT = Number(process.env.FATE_SIGNALING_PORT ?? 3004);

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------

type Room = {
  hostPeerId: string | null;
  /** peerId -> displayName */
  players: Map<string, string>;
};

/** roomId -> Room */
const rooms = new Map<string, Room>();

/** socketId -> { roomId, peerId, role } — used for disconnect cleanup */
const socketMeta = new Map<
  string,
  { roomId: string; peerId: string; role: "host" | "player" }
>();

/** roomId -> (peerId -> socketId) — used to route signaling messages */
const peerSockets = new Map<string, Map<string, string>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ts(): string {
  return new Date().toISOString();
}

function log(...args: unknown[]): void {
  console.log(`[${ts()}]`, ...args);
}

function getOrCreateRoom(roomId: string): Room {
  let room = rooms.get(roomId);
  if (!room) {
    room = { hostPeerId: null, players: new Map() };
    rooms.set(roomId, room);
    peerSockets.set(roomId, new Map());
  }
  return room;
}

function deleteRoomIfEmpty(roomId: string): void {
  const room = rooms.get(roomId);
  if (room && room.hostPeerId === null && room.players.size === 0) {
    rooms.delete(roomId);
    peerSockets.delete(roomId);
    log(`Room ${roomId} deleted (empty)`);
  }
}

function removePeerFromRoom(io: Server, socket: Socket, meta: { roomId: string; peerId: string; role: "host" | "player" }): void {
  const { roomId, peerId, role } = meta;
  const room = rooms.get(roomId);
  if (!room) return;

  // A reloaded/reconnected tab can register its replacement before the old
  // transport reports disconnect. The old socket must not remove the new one.
  if (peerSockets.get(roomId)?.get(peerId) !== socket.id) {
    socket.leave(roomId);
    return;
  }

  if (role === "host" && room.hostPeerId === peerId) {
    room.hostPeerId = null;
    log(`Host ${peerId} left room ${roomId}`);
    io.to(roomId).emit("host:status", { isHostOnline: false });
    io.to(roomId).emit("peer:left", { peerId, role: "host" });
  } else {
    room.players.delete(peerId);
    log(`Player ${peerId} left room ${roomId}`);
    io.to(roomId).emit("peer:left", { peerId, role: "player" });
  }

  peerSockets.get(roomId)?.delete(peerId);
  socket.leave(roomId);
  deleteRoomIfEmpty(roomId);
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: { origin: "*" },
  // ── WebSocket keepalive tuning ──────────────────────────────
  // Default socket.io: pingInterval=25s, pingTimeout=20s. Through the Caddy
  // gateway proxy, pings can be delayed by buffer flushes — if a ping doesn't
  // round-trip within pingTimeout, socket.io closes the connection
  // (`transport close` on the client). This was causing the host's socket to
  // drop ~30s after room creation, which made the GM unable to see players
  // joining. Tightening pingInterval (more frequent health checks) and
  // loosening pingTimeout (more slack for proxy delay) fixes it.
  pingInterval: 10000,   // send a ping every 10s (was 25s)
  pingTimeout: 60000,    // wait 60s for pong before closing (was 20s)
});

io.on("connection", (socket) => {
  log(`Socket connected: ${socket.id}`);

  // ----- heartbeat -----
  // Application-level keepalive. The Caddy reverse_proxy (port 81 → 3004)
  // closes idle WebSocket connections after ~30s. Socket.io's built-in
  // ping/pong frames are NOT counted as activity by Caddy's idle timer,
  // so we need real data frames to keep the proxy from closing the socket.
  // The client emits 'heartbeat' every 10s; we ack with a no-op. This is
  // a data frame that resets Caddy's idle timer.
  socket.on("heartbeat", (data: { ts?: number } = {}) => {
    // Log first few heartbeats per socket for diagnostics, then go quiet
    // to avoid log spam. This helps verify the keepalive is working
    // through the Caddy proxy.
    const hbCount = (socket as any).__hbCount ?? 0;
    if (hbCount < 3) {
      log(`heartbeat #${hbCount + 1} from ${socket.id} (clientTs=${data.ts ?? '?'})`);
      (socket as any).__hbCount = hbCount + 1;
    }
    socket.volatile.emit("heartbeat:ack", { serverTs: Date.now(), clientTs: data.ts ?? null });
  });

  // ----- room:join -----
  socket.on("room:join", (payload) => {
    const { roomId, role, peerId, displayName } = payload ?? {};
    if (!roomId || !peerId || (role !== "host" && role !== "player")) {
      log(`Invalid room:join payload from ${socket.id}:`, payload);
      return;
    }

    // Dedup: if this socket+peerId is already in this room, skip re-processing.
    // Clients may send room:join on reconnect; we only need to process the first.
    const existing = socketMeta.get(socket.id);
    if (existing && existing.roomId === roomId && existing.peerId === peerId) {
      log(`Duplicate room:join from ${socket.id} (${role} ${peerId}) — ignoring.`);
      return;
    }

    const room = getOrCreateRoom(roomId);
    socketMeta.set(socket.id, { roomId, peerId, role });
    peerSockets.get(roomId)!.set(peerId, socket.id);
    socket.join(roomId);

    if (role === "host") {
      room.hostPeerId = peerId;
      log(`Host ${peerId} joined room ${roomId}`);
      // Broadcast to everyone in the room (including host as ack)
      io.to(roomId).emit("host:joined", { peerId, roomId });

      // ── Reconnect recovery ──────────────────────────────────────
      // If the host's socket disconnected briefly (page refresh, HMR reload,
      // network blip) and then reconnected, the players who joined during the
      // gap are still in `room.players` on the server — but the host's fresh
      // socket has no knowledge of them. Without this, the GM refreshes the
      // page and silently loses visibility of every connected player.
      //
      // Re-emit `player:joined` for each currently-connected player so the
      // host's `networkPeers` map is rebuilt. (Dedup on the client side is
      // handled by the store's merge semantics — re-adding an existing peerId
      // is a no-op.)
      const existingPlayers = Array.from(room.players.entries());
      if (existingPlayers.length > 0) {
        log(`Sending ${existingPlayers.length} existing player(s) to (re)joining host ${peerId} in room ${roomId}`);
        for (const [playerPeerId, displayName] of existingPlayers) {
          socket.emit("player:joined", { peerId: playerPeerId, displayName });
        }
      }
    } else {
      const name = typeof displayName === "string" ? displayName : "";
      room.players.set(peerId, name);
      log(`Player ${peerId} (${name || "anonymous"}) joined room ${roomId}`);

      const isHostOnline = room.hostPeerId !== null;

      // Notify host (if online) about the new player
      if (isHostOnline && room.hostPeerId !== null) {
        const hostSocketId = peerSockets.get(roomId)?.get(room.hostPeerId);
        log(`Notifying host socket ${hostSocketId} (peer ${room.hostPeerId}) of player ${peerId} in room ${roomId}. peerSockets:`, Array.from(peerSockets.get(roomId)?.entries() ?? []));
        if (hostSocketId) {
          io.to(hostSocketId).emit("player:joined", { peerId, displayName: name });
        }
      }

      // Tell the joining player whether the host is currently online
      socket.emit("host:status", { isHostOnline });
    }
  });

  // ----- room:leave -----
  socket.on("room:leave", (payload) => {
    const { roomId, peerId } = payload ?? {};
    if (!roomId || !peerId) return;
    const meta = socketMeta.get(socket.id);
    if (!meta || meta.roomId !== roomId || meta.peerId !== peerId) return;
    removePeerFromRoom(io, socket, meta);
    socketMeta.delete(socket.id);
  });

  // ----- signal -----
  socket.on("signal", (payload) => {
    const { toPeerId, fromPeerId, data } = payload ?? {};
    if (!toPeerId || !fromPeerId) return;

    const meta = socketMeta.get(socket.id);
    if (!meta) return;

    const targetSocketId = peerSockets.get(meta.roomId)?.get(toPeerId);
    if (targetSocketId) {
      io.to(targetSocketId).emit("signal", { toPeerId, fromPeerId, data });
    } else {
      log(`Signal relay target ${toPeerId} not found in room ${meta.roomId}`);
    }
  });

  // ----- assign:character -----
  // Multi-character roster: a peer may control several characters at once
  // (their PC plus temporarily-handed-off NPCs). Payload carries the FULL
  // list of characterIds the peer now controls — host sends the entire array
  // so players and host always agree on the complete roster.
  socket.on("assign:character", (payload) => {
    const { roomId, peerId, characterIds } = payload ?? {};
    if (!roomId || !peerId) return;
    const ids = Array.isArray(characterIds) ? characterIds : [];
    log(`Assignment in room ${roomId}: peer ${peerId} -> characters [${ids.join(",")}]`);
    // Broadcast to the whole room (host is sender, gets implicit ack)
    io.to(roomId).emit("assignment:update", { peerId, characterIds: ids });
  });

  // ----- state:sync -----
  socket.on("state:sync", (payload) => {
    const { roomId, snapshot } = payload ?? {};
    if (!roomId) return;
    log(`State sync in room ${roomId}`);
    // Broadcast to all players in the room (everyone except the sender/host)
    socket.to(roomId).emit("state:sync", { snapshot });
  });

  // ----- disconnect -----
  socket.on("disconnect", (reason) => {
    log(`Socket disconnected: ${socket.id} (reason: ${reason})`);
    const meta = socketMeta.get(socket.id);
    if (meta) {
      removePeerFromRoom(io, socket, meta);
    }
    socketMeta.delete(socket.id);
  });
});

// ---------------------------------------------------------------------------
// Health / metrics HTTP endpoint (same port — useful for `curl` checks)
// ---------------------------------------------------------------------------

// Health / metrics HTTP endpoint.
// IMPORTANT: only respond to our own routes ("/" and "/health") — for any
// other URL (including socket.io's `/socket.io/?EIO=4&transport=polling`),
// do nothing so socket.io's own request handler can process the request.
// Writing a 404 here would race with socket.io and cause ERR_HTTP_HEADERS_SENT.
httpServer.on("request", (req, res) => {
  if (req.method !== "GET") return;
  if (req.url !== "/" && req.url !== "/health") return;
  const roomCount = rooms.size;
  let totalPeers = 0;
  rooms.forEach((r) => {
    if (r.hostPeerId) totalPeers += 1;
    totalPeers += r.players.size;
  });
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      service: "fate-rpg-signaling",
      port: PORT,
      uptimeSec: Math.round(process.uptime()),
      rooms: roomCount,
      peers: totalPeers,
    })
  );
});

httpServer.listen(PORT, () => {
  log(`Signaling server listening on port ${PORT}`);
});
