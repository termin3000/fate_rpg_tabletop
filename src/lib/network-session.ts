// Per-tab storage: a reload keeps the room, a different tab has its own role.
export interface SavedNetworkSession {
  role: 'host' | 'player';
  roomId: string;
  displayName: string;
  playerAssignments: Record<string, string[]>;
}
const KEY = 'fate-network-session';

export function saveNetworkSession(session: SavedNetworkSession): void {
  try { sessionStorage.setItem(KEY, JSON.stringify(session)); } catch { /* Storage may be unavailable. */ }
}
export function loadNetworkSession(): SavedNetworkSession | null {
  try {
    const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (!saved || !['host', 'player'].includes(saved.role) || !/^[A-Z0-9]{6}$/.test(saved.roomId) || typeof saved.displayName !== 'string') return null;
    return { ...saved, playerAssignments: saved.playerAssignments ?? {} };
  } catch { return null; }
}
export function clearNetworkSession(): void {
  try { sessionStorage.removeItem(KEY); } catch { /* Ignore unavailable storage. */ }
}
