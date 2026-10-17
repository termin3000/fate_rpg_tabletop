/// <reference types="bun-types" />
import { test, expect } from 'bun:test';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { startTunnel, stopTunnel, getTunnelState } from '../src/app/api/tunnel/tunnel-state';

test('localtunnel lifecycle and real TCP forwarding through an API-owned gateway', async () => {
  const sockets = new Set<net.Socket>();
  const relays: net.Socket[] = [];
  const relay = net.createServer(socket => {
    sockets.add(socket);
    relays.push(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const relayPort = (relay.address() as net.AddressInfo).port;
  let allocations = 0;
  const provider = http.createServer((_req, res) => {
    allocations++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ id: 'test', ip: '127.0.0.1', port: relayPort, url: 'https://test.loca.lt', max_conn_count: 1 }));
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  const previousHost = process.env.LOCALTUNNEL_HOST;
  process.env.LOCALTUNNEL_HOST = `http://127.0.0.1:${(provider.address() as net.AddressInfo).port}`;
  try {
    expect(getTunnelState().status).toBe('idle');
    const first = startTunnel();
    const duplicate = startTunnel();
    expect(first).toBe(duplicate);
    const state = await first;
    expect(state.status).toBe('running');
    expect(state.url).toBe('https://test.loca.lt');
    expect(allocations).toBe(1);
    expect((await startTunnel()).pid).toBe(state.pid);
    const deadline = Date.now() + 3000;
    while (!relays.length && Date.now() < deadline) await Bun.sleep(20);
    expect(relays.length).toBeGreaterThan(0);
    // Behave like localtunnel's remote server: send a public request down
    // the reverse TCP connection opened by the actual localtunnel package.
    const response = new Promise<string>((resolve, reject) => {
      let data = '';
      const timer = setTimeout(() => reject(new Error('Forwarding timeout')), 3000);
      relays[0].on('data', chunk => {
        data += chunk.toString();
        if (data.includes('fate-gateway')) { clearTimeout(timer); resolve(data); }
      });
    });
    relays[0].write('GET /_fate/health HTTP/1.1\r\nHost: test.loca.lt\r\nConnection: close\r\n\r\n');
    expect(await response).toContain('200 OK');
    expect(stopTunnel().status).toBe('idle');
    await Bun.sleep(200);
    const cancelled = startTunnel();
    stopTunnel();
    await cancelled;
    expect(getTunnelState().status).toBe('idle');
    // A new start after cancellation must not be overwritten by old events.
    expect((await startTunnel()).status).toBe('running');
    expect(stopTunnel().url).toBeNull();
  } finally {
    stopTunnel();
    if (previousHost === undefined) delete process.env.LOCALTUNNEL_HOST;
    else process.env.LOCALTUNNEL_HOST = previousHost;
    for (const socket of sockets) socket.destroy();
    provider.closeAllConnections();
    provider.close();
    relay.close();
  }
}, 15000);
