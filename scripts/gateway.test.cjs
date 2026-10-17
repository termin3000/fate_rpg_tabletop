const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { Server } = require('../mini-services/signaling/node_modules/socket.io');
const { io } = require('socket.io-client');
const { createGateway } = require('./gateway.cjs');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('single origin forwards HTTP, signaling and physics without a browser-local service', async t => {
  const app = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ url: req.url, method: req.method, body, host: req.headers.host }));
  });
  const signaling = http.createServer();
  const physics = http.createServer();
  const signalIO = new Server(signaling);
  const physicsIO = new Server(physics);
  signalIO.on('connection', socket => {
    socket.on('room:join', room => { socket.join(room); socket.emit('joined', room); });
    socket.on('signal', payload => socket.to(payload.room).emit('signal', payload.data));
  });
  physicsIO.on('connection', socket => socket.on('test:roll', () => socket.emit('test:result', [1, 0, -1, 1])));
  const appPort = await listen(app);
  const signalingPort = await listen(signaling);
  const physicsPort = await listen(physics);
  const gateway = createGateway({ appPort, signalingPort, physicsPort });
  const port = await listen(gateway);
  const origin = `http://127.0.0.1:${port}`;
  const clients = [];
  t.after(async () => {
    clients.forEach(client => client.disconnect());
    gateway.shutdown();
    signalIO.close();
    physicsIO.close();
    signaling.closeAllConnections();
    physics.closeAllConnections();
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
  });
  function client(service, transport = 'websocket') {
    const socket = io(origin, { query: { XTransformPort: service }, transports: [transport], reconnection: false });
    clients.push(socket);
    return socket;
  }

  await t.test('page query and API POST reach Next upstream with public Host intact', async () => {
    const body = await new Promise((resolve, reject) => {
      const request = http.request(`${origin}/api/example?join=ABC234`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Host: 'game.loca.lt' },
      }, response => {
        let data = '';
        response.on('data', chunk => { data += chunk; });
        response.on('end', () => resolve(JSON.parse(data)));
      });
      request.on('error', reject);
      request.end('{"name":"player"}');
    });
    assert.deepEqual(body, {
      url: '/api/example?join=ABC234', method: 'POST', body: '{"name":"player"}', host: 'game.loca.lt',
    });
  });
  await t.test('Socket.IO HTTP handshake routes to signaling', async () => {
    const response = await fetch(`${origin}/socket.io/?EIO=4&transport=polling&XTransformPort=3004`);
    assert.equal(response.status, 200);
    const handshake = await response.text();
    assert.match(handshake, /^0\{"sid":/);
    // This probe has no client to send a disconnect packet on teardown.
    signalIO.engine.clients[JSON.parse(handshake.slice(1)).sid].close(true);
  });
  await t.test('two peers exchange signaling over WebSocket through the gateway', { timeout: 5000 }, async () => {
    const host = client('3004');
    const player = client('3004');
    await Promise.all([once(host, 'connect'), once(player, 'connect')]);
    const joined = Promise.all([once(host, 'joined'), once(player, 'joined')]);
    host.emit('room:join', 'ABC234');
    player.emit('room:join', 'ABC234');
    await joined;
    const received = once(player, 'signal');
    host.emit('signal', { room: 'ABC234', data: { type: 'offer', sdp: 'example' } });
    assert.deepEqual((await received)[0], { type: 'offer', sdp: 'example' });
  });
  await t.test('physics uses its own upstream via the same public origin', { timeout: 5000 }, async () => {
    const player = client('3006');
    await once(player, 'connect');
    const result = once(player, 'test:result');
    player.emit('test:roll');
    assert.deepEqual((await result)[0], [1, 0, -1, 1]);
  });
  await t.test('polling-only client can use the same route', { timeout: 5000 }, async () => {
    const player = client('3004', 'polling');
    await once(player, 'connect');
    const joined = once(player, 'joined');
    player.emit('room:join', 'POLLING');
    assert.equal((await joined)[0], 'POLLING');
  });
  await t.test('arbitrary local ports are rejected', async () => {
    assert.equal((await fetch(`${origin}/?XTransformPort=22`)).status, 400);
  });
  await t.test('unavailable upstream returns 502 and gateway stays alive', async () => {
    app.closeAllConnections();
    await new Promise(resolve => app.close(resolve));
    assert.equal((await fetch(`${origin}/`)).status, 502);
    assert.equal((await fetch(`${origin}/_fate/health`)).status, 200);
  });
});
