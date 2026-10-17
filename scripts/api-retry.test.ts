/// <reference types="bun-types" />
import { test, expect } from 'bun:test';
import { apiGet, apiPost } from '../src/lib/api';

async function withFetch(mock: (url: string) => Promise<Response>, check: () => Promise<void>) {
  const originalFetch = globalThis.fetch;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  globalThis.fetch = mock as unknown as typeof fetch;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { origin: 'https://game.loca.lt' } } });
  try { await check(); } finally {
    globalThis.fetch = originalFetch;
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('GET recovers from transient tunnel 502/503 and preserves query parameters', async () => {
  let calls = 0;
  await withFetch((async (url: string) => {
    expect(url).toBe('https://game.loca.lt/api/characters?adventureId=example');
    calls++;
    return calls < 3 ? new Response('Bad Gateway', { status: calls === 1 ? 502 : 503 }) : Response.json([{ id: 'hero' }]);
  }), async () => {
    expect(await apiGet<Array<{ id: string }>>('/api/characters', { adventureId: 'example' })).toEqual([{ id: 'hero' }]);
    expect(calls).toBe(3);
  });
});

test('persistent 502 stops after three attempts and identifies the failed endpoint', async () => {
  let calls = 0;
  await withFetch((async () => { calls++; return new Response('Bad Gateway', { status: 502 }); }), async () => {
    await expect(apiGet('/api/adventures')).rejects.toThrow('502 (GET /api/adventures)');
    expect(calls).toBe(3);
  });
});

test('GET recovers from a temporary fetch connection failure', async () => {
  let calls = 0;
  await withFetch((async () => { if (++calls === 1) throw new TypeError('Failed to fetch'); return Response.json([]); }), async () => {
    expect(await apiGet<unknown[]>('/api/adventures')).toEqual([]);
    expect(calls).toBe(2);
  });
});

test('client errors and invalid JSON are not retried', async () => {
  let calls = 0;
  await withFetch((async () => { calls++; return new Response('Not Found', { status: 404 }); }), async () => {
    await expect(apiGet('/api/missing')).rejects.toThrow('404');
    expect(calls).toBe(1);
  });
  calls = 0;
  await withFetch((async () => { calls++; return new Response('<html>not JSON</html>'); }), async () => {
    await expect(apiGet('/api/adventures')).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

test('mutating requests are not replayed on gateway errors', async () => {
  let calls = 0;
  await withFetch((async () => { calls++; return new Response('Bad Gateway', { status: 502 }); }), async () => {
    await expect(apiPost('/api/characters', { name: 'Hero' })).rejects.toThrow('502');
    expect(calls).toBe(1);
  });
});
