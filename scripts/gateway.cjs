const http = require('node:http');
const httpProxy = require('http-proxy');
const { randomBytes, timingSafeEqual } = require('node:crypto');

// One public origin for HTTP, Socket.IO polling and WebSocket upgrades.
// Only known services can be selected; never proxy arbitrary local ports.
function createGateway({ appPort = 3000, signalingPort = 3004, physicsPort = 3006, onShutdown, getStatus } = {}) {
  const proxy = httpProxy.createProxyServer({ xfwd: true, ws: true });
  const sockets = new Set();
  const controlToken = randomBytes(32).toString('hex');
  function localOwner(req) {
    const remote = req.socket.remoteAddress;
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)
      && /^(localhost|127\.0\.0\.1):\d+$/.test(req.headers.host || '')
      && !req.headers['x-forwarded-for'];
  }
  function target(req) {
    const url = new URL(req.url, 'http://localhost');
    const service = url.searchParams.get('XTransformPort');
    if (service && service !== '3004' && service !== '3006') return null;
    const port = service === '3004' ? signalingPort : service === '3006' ? physicsPort : appPort;
    return `http://127.0.0.1:${port}`;
  }
  proxy.on('error', (_error, _req, res) => {
    if (typeof res.writeHead === 'function') {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Local service unavailable' }));
    } else {
      res.destroy();
    }
  });
  const server = http.createServer((req, res) => {
    if (req.url === '/_fate/control' || req.url === '/_fate/shutdown') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      if (!onShutdown || !localOwner(req)) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Local launcher control only' }));
        return;
      }
      if (req.url === '/_fate/control' && req.method === 'GET') {
        res.end(JSON.stringify({ canShutdown: true, token: controlToken }));
        return;
      }
      const token = req.headers['x-fate-control'];
      const origin = req.headers.origin;
      const authorized = typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)
        && timingSafeEqual(Buffer.from(token), Buffer.from(controlToken))
        && origin === `http://${req.headers.host}`;
      if (req.url !== '/_fate/shutdown' || req.method !== 'POST' || !authorized) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Invalid shutdown request' }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
      setTimeout(onShutdown, 150);
      return;
    }
    if (req.url === '/_fate/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ service: 'fate-gateway', appPort, signalingPort, physicsPort, ...getStatus?.() }));
      return;
    }
    const upstream = target(req);
    if (!upstream) {
      res.writeHead(400);
      res.end('Unknown service');
      return;
    }
    proxy.web(req, res, { target: upstream });
  });
  server.on('upgrade', (req, socket, head) => {
    const upstream = target(req);
    if (!upstream) return socket.destroy();
    proxy.ws(req, socket, head, { target: upstream });
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('close', () => proxy.close());
  server.shutdown = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  return server;
}

module.exports = { createGateway };

if (require.main === module) {
  const server = createGateway();
  server.on('error', error => { console.error(error.message); process.exit(1); });
  server.listen(3008, '0.0.0.0', () => console.log('Fate gateway: http://localhost:3008'));
  const stop = () => { server.shutdown(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // API-owned gateway follows its parent. A manually started gateway stays up.
  if (process.send) process.on('disconnect', stop);
}
