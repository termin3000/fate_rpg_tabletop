// ============================================================
// Fate RPG Virtual Tabletop — Offline-First Sync Layer
// ============================================================
//
// Architecture (Variant D — offline-first + on-demand signaling):
//
//   roll() → addLogEntry()
//              ├─ 1. Generate local ID (`local_<base36>`)
//              ├─ 2. Save to Zustand state immediately (UI shows it now)
//              ├─ 3. Save to localStorage (survives refresh)
//              └─ 4. POST /api/log (fire-and-forget, NOT awaited)
//                       ├─ on success → replace local entry with server entry
//                       └─ on failure → keep local entry, mark `_pending: true`
//                                       retry on next sync tick
//
// The roll itself NEVER blocks on the server. Even if the dev server is
// dead (502 from gateway, ECONNREFUSED, etc.) the user still sees their
// roll result and the log entry — it's just marked as "pending sync".
//
// This eliminates the dreaded "Ошибка броска" toast permanently.
// ============================================================

import type { LogEntry } from '@/lib/types';
import { apiPost, apiPatch } from '@/lib/api';

// ── Constants ───────────────────────────────────────────────

const LOCAL_PREFIX = 'local_';
const STORAGE_KEY_PREFIX = 'fate-pending-logs:';
const MAX_RETRIES = 5;
const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

// ── Types ───────────────────────────────────────────────────

/** Internal-only fields attached to local (not-yet-synced) log entries. */
export interface PendingMeta {
  /** True while a POST is in flight for this entry. */
  _syncing?: boolean;
  /** True if the last POST attempt failed (entry will be retried). */
  _pending?: boolean;
  /** Number of failed sync attempts so far. */
  _retryCount?: number;
  /** Timestamp (ms) of next allowed retry. */
  _nextRetryAt?: number;
}

export type LocalLogEntry = LogEntry & PendingMeta;

// ── Local ID generation ────────────────────────────────────

/**
 * Generate a client-side ID for an entry that has not yet been confirmed
 * by the server. Prefixed with `local_` so we can distinguish it from
 * server-assigned IDs.
 */
export function genLocalId(): string {
  return LOCAL_PREFIX + Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

/** True if an entry ID was generated client-side (not yet synced). */
export function isLocalId(id: string | undefined | null): boolean {
  return !!id && id.startsWith(LOCAL_PREFIX);
}

// ── localStorage persistence ───────────────────────────────

function storageKey(adventureId: string): string {
  return STORAGE_KEY_PREFIX + adventureId;
}

/** Load all pending (locally-stored, not yet synced) entries for an adventure. */
export function loadPendingEntries(adventureId: string): LocalLogEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(storageKey(adventureId));
    if (!raw) return [];
    const arr = JSON.parse(raw) as LocalLogEntry[];
    // Reset transient flags on load — they will be re-set by the sync loop.
    return arr.map((e) => ({
      ...e,
      _syncing: false,
      // Keep _pending=true so they're retried, but clear the in-flight flag.
      _pending: true,
    }));
  } catch {
    return [];
  }
}

/** Persist the current set of pending entries for an adventure. */
export function persistPendingEntries(adventureId: string, entries: LocalLogEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    // Only persist entries that still have a local ID (not yet confirmed).
    const pending = entries.filter((e) => isLocalId(e.id));
    localStorage.setItem(storageKey(adventureId), JSON.stringify(pending));
  } catch {
    // localStorage full / unavailable — non-fatal, entries are still in memory.
  }
}

/** Remove all pending entries for an adventure (used after a full sync). */
export function clearPendingEntries(adventureId: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.removeItem(storageKey(adventureId));
  } catch {
    // ignore
  }
}

// ── Per-entry sync ─────────────────────────────────────────

/**
 * POST a single local entry to the server. On success returns the
 * server-confirmed entry (with a real ID and createdAt). On failure
 * throws — caller should bump retry count.
 */
export async function postLocalEntry(entry: LocalLogEntry): Promise<LogEntry> {
  // Strip internal fields before sending.
  const { _syncing, _pending, _retryCount, _nextRetryAt, ...payload } = entry;
  void _syncing; void _pending; void _retryCount; void _nextRetryAt;
  return apiPost<LogEntry>('/api/log', payload);
}

/**
 * PATCH an update for a server-confirmed entry. Used for rerolls/bonus
 * adjustments when the entry already has a real server ID.
 */
export async function patchEntry(id: string, updates: Partial<LogEntry>): Promise<LogEntry> {
  return apiPatch<LogEntry>('/api/log', { id, ...updates });
}

// ── Sync orchestrator ──────────────────────────────────────

export interface SyncCallbacks {
  /** Called when an entry finishes syncing — replaces local with server entry. */
  onSynced: (localId: string, serverEntry: LogEntry) => void;
  /** Called when an entry fails to sync — marks it as pending. */
  onFailed: (localId: string, retryCount: number, nextRetryAt: number) => void;
  /** Returns the current set of pending entries (for re-persisting). */
  getPendingEntries: () => LocalLogEntry[];
  /** Returns the current adventure ID (for localStorage keying). */
  getAdventureId: () => string | null;
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let callbacks: SyncCallbacks | null = null;

/** Register the callbacks used by the background sync loop. */
export function initSyncLoop(cb: SyncCallbacks): void {
  callbacks = cb;
  // Kick off the first tick soon — handles entries that were pending
  // from a previous session (page was refreshed while server was down).
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSyncTick(), 2_000);
}

/** Stop the background sync loop (e.g. when switching adventures). */
export function stopSyncLoop(): void {
  if (syncTimer) {
    clearTimeout(syncTimer);
    syncTimer = null;
  }
  callbacks = null;
}

/**
 * Run a single sync pass: find pending entries whose retry timer has
 * elapsed, POST them, fire callbacks. Schedules the next tick.
 */
async function runSyncTick(): Promise<void> {
  if (!callbacks) return;

  const adventureId = callbacks.getAdventureId();
  const pending = callbacks.getPendingEntries();
  const now = Date.now();

  // Entries that are eligible for retry: pending, not currently syncing,
  // and past their nextRetryAt (or never tried).
  const eligible = pending.filter(
    (e) => isLocalId(e.id) && !e._syncing && (!e._nextRetryAt || e._nextRetryAt <= now),
  );

  if (eligible.length === 0) {
    // Nothing to do — check again in 30s.
    syncTimer = setTimeout(() => runSyncTick(), 30_000);
    return;
  }

  // Mark them as syncing so we don't double-fire.
  for (const e of eligible) {
    e._syncing = true;
  }

  // Fire all eligible POSTs in parallel.
  await Promise.allSettled(
    eligible.map(async (entry) => {
      try {
        const serverEntry = await postLocalEntry(entry);
        callbacks.onSynced(entry.id, serverEntry);
      } catch {
        const retryCount = (entry._retryCount ?? 0) + 1;
        if (retryCount >= MAX_RETRIES) {
          // Give up — keep the entry local so it's not lost, but stop retrying.
          callbacks.onFailed(entry.id, retryCount, Number.MAX_SAFE_INTEGER);
        } else {
          const delay = RETRY_DELAYS_MS[Math.min(retryCount - 1, RETRY_DELAYS_MS.length - 1)];
          callbacks.onFailed(entry.id, retryCount, now + delay);
        }
      }
    }),
  );

  // Persist the updated pending list (so retries survive refresh).
  if (adventureId) {
    persistPendingEntries(adventureId, callbacks.getPendingEntries());
  }

  // Schedule the next tick — short interval so retries fire promptly.
  syncTimer = setTimeout(() => runSyncTick(), 10_000);
}

/** Force an immediate sync pass (e.g. user clicked "Retry sync"). */
export function forceSyncNow(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runSyncTick(), 100);
}

// ── Connection status (for UI badges) ──────────────────────

type SyncStatus = 'online' | 'offline' | 'syncing';

let currentStatus: SyncStatus = 'online';
const statusListeners = new Set<(s: SyncStatus) => void>();

export function getSyncStatus(): SyncStatus {
  return currentStatus;
}

export function setSyncStatus(s: SyncStatus): void {
  if (currentStatus === s) return;
  currentStatus = s;
  statusListeners.forEach((fn) => fn(s));
}

export function onSyncStatusChange(fn: (s: SyncStatus) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

// ── Browser online/offline events ──────────────────────────

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => {
    setSyncStatus('online');
    forceSyncNow();
  });
  window.addEventListener('offline', () => {
    setSyncStatus('offline');
  });
}
