/// <reference types="bun-types" />
import { test, expect } from 'bun:test';
import { clearNetworkSession, loadNetworkSession, saveNetworkSession } from '../src/lib/network-session';

test('room identity survives reload and explicit leave removes it', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  } });
  try {
    expect(loadNetworkSession()).toBeNull();
    const session = { role: 'host' as const, roomId: 'ABC234', displayName: 'GM', playerAssignments: { player: ['hero'] } };
    saveNetworkSession(session);
    expect(loadNetworkSession()).toEqual(session);
    clearNetworkSession();
    expect(loadNetworkSession()).toBeNull();
    values.set('fate-network-session', '{bad json');
    expect(loadNetworkSession()).toBeNull();
    values.set('fate-network-session', JSON.stringify({ ...session, role: 'admin' }));
    expect(loadNetworkSession()).toBeNull();
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
    else Reflect.deleteProperty(globalThis, 'sessionStorage');
  }
});
