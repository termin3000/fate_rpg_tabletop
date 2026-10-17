const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { existsSync } = require('node:fs');
const { io } = require('socket.io-client');
const { createGateway } = require('./gateway.cjs');

test('late disconnect of an old socket preserves replacement peer and room', { timeout: 15000 }, async t => {
  const reservation = http.createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const signalingPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const root = path.resolve(__dirname, '..');
  const localBun = path.join(root, '.tools/node_modules/bun/bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
  const service = spawn(existsSync(localBun) ? localBun : 'bun', ['run', 'index.ts'], {
    cwd: path.join(root, 'mini-services/signaling'), env: { ...process.env, FATE_SIGNALING_PORT: String(signalingPort) },
    stdio: 'ignore', windowsHide: true,
  });
  let startupError;
  service.on('error', error => { startupError = error; });
  const gateway = createGateway({ signalingPort });
  const clients = [];
  t.after(() => { clients.forEach(socket => socket.disconnect()); gateway.shutdown(); service.kill(); });
  const deadline = Date.now() + 5000;
  while (true) {
    if (startupError) throw startupError;
    try {
      const response = await fetch(`http://127.0.0.1:${signalingPort}/health`);
      if (response.ok) break;
    } catch { /* Wait for isolated service readiness. */ }
    if (Date.now() > deadline) throw new Error('Signaling service startup timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  async function peer(peerId, role) {
    const socket = io(origin, { transports: ['websocket'], query: { XTransformPort: '3004' }, reconnection: false });
    clients.push(socket);
    await once(socket, 'connect');
    socket.emit('room:join', { roomId: 'ABC234', peerId, role, displayName: peerId });
    return socket;
  }
  const host = await peer('host', 'host');
  const joined = once(host, 'player:joined');
  const old = await peer('player', 'player');
  await joined;
  const replacementJoined = once(host, 'player:joined');
  const replacement = await peer('player', 'player');
  await replacementJoined;
  let wronglyLeft = false;
  host.on('peer:left', () => { wronglyLeft = true; });
  old.disconnect();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(wronglyLeft, false);
  const forwarded = once(replacement, 'signal');
  host.emit('signal', { toPeerId: 'player', fromPeerId: 'host', data: { type: 'test' } });
  assert.equal((await forwarded)[0].data.type, 'test');
});
