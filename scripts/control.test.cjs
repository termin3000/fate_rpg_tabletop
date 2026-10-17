const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { createGateway } = require('./gateway.cjs');

test('only local owner with a per-launch token and same origin can stop the application', async t => {
  let stopped = 0;
  const gateway = createGateway({ onShutdown: () => { stopped++; } });
  gateway.listen(0, '127.0.0.1');
  await once(gateway, 'listening');
  t.after(() => gateway.shutdown());
  const origin = `http://127.0.0.1:${gateway.address().port}`;
  const control = await (await fetch(`${origin}/_fate/control`)).json();
  assert.equal(control.canShutdown, true);
  assert.match(control.token, /^[a-f0-9]{64}$/);
  async function request(route, headers, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request(origin + route, { headers, method }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject);
      req.end();
    });
  }
  assert.equal(await request('/_fate/control', { Host: 'player.loca.lt' }), 403);
  assert.equal(await request('/_fate/control', { 'X-Forwarded-For': '203.0.113.5' }), 403);
  assert.equal(await request('/_fate/shutdown', { 'X-Fate-Control': control.token }, 'POST'), 403);
  assert.equal(await request('/_fate/shutdown', { Origin: 'https://evil.example', 'X-Fate-Control': control.token }, 'POST'), 403);
  assert.equal(await request('/_fate/shutdown', { Origin: origin, 'X-Fate-Control': 'a'.repeat(64) }, 'POST'), 403);
  assert.equal(stopped, 0);
  assert.equal(await request('/_fate/shutdown', { Origin: origin, 'X-Fate-Control': control.token }, 'POST'), 200);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(stopped, 1);
});
