import { NextResponse } from 'next/server';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export const dynamic = 'force-dynamic';

const PROJECT_ROOT = process.env.FATE_DATA_ROOT || process.cwd();
const BACKUPS_DIR = join(PROJECT_ROOT, 'backups');
const DB_PATH = join(PROJECT_ROOT, 'db', 'custom.db');

interface SnapshotFile {
  file: string;
  size: number;
  sha256: string | null;
  verified: 'ok' | 'mismatch' | 'missing' | 'no-checksum';
}

interface SnapshotInfo {
  timestamp: string;
  db?: SnapshotFile;
  data?: SnapshotFile & { counts?: Record<string, number> };
  src?: SnapshotFile;
  integrity: {
    ok: number;
    total: number;
    status: 'verified' | 'partial' | 'failed' | 'unknown';
  };
}

interface RawManifestEntry {
  timestamp: string;
  db?: string;
  data?: string;
  src?: string;
  dbSize?: number;
  dataSize?: number;
  srcSize?: number;
}

interface BackupListResponse {
  snapshots: SnapshotInfo[];
  total: number;
  lastUpdated: string | null;
  retention: { hourly: number; daily: number; weekly: number };
  diskUsageBytes: number;
  diskUsageHuman: string;
  currentDbSize: number;
  currentDbModified: string | null;
  nextSnapshotIn: string | null;
}

// GET /api/backups/list — returns the manifest plus live disk verification
export async function GET() {
  try {
    if (!existsSync(BACKUPS_DIR)) {
      return NextResponse.json({ snapshots: [], total: 0, error: 'backups dir missing' });
    }

    const manifestPath = join(BACKUPS_DIR, 'manifest.json');
    let rawEntries: RawManifestEntry[] = [];
    let lastUpdated: string | null = null;

    if (existsSync(manifestPath)) {
      try {
        const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        // Handle both shapes: flat array OR { snapshots: [...] }
        if (Array.isArray(raw)) {
          rawEntries = raw as RawManifestEntry[];
        } else if (Array.isArray(raw.snapshots)) {
          rawEntries = raw.snapshots as RawManifestEntry[];
          lastUpdated = raw.lastUpdated ?? null;
        }
      } catch {
        // ignore parse errors
      }
    }

    const verified: SnapshotInfo[] = [];
    for (const snap of rawEntries) {
      const entry: SnapshotInfo = {
        timestamp: snap.timestamp,
        integrity: { ok: 0, total: 0, status: 'unknown' },
      };
      let okCount = 0;
      let totalCount = 0;

      if (snap.db) {
        const fileDir = join(BACKUPS_DIR, 'db');
        const p = join(fileDir, snap.db);
        if (existsSync(p)) {
          const sha = readShaSidecar(p);
          const size = statSync(p).size;
          const verifiedStatus = checkIntegrity(p, sha);
          entry.db = { file: snap.db, size, sha256: sha, verified: verifiedStatus };
          totalCount++;
          if (verifiedStatus === 'ok') okCount++;
        }
      }
      if (snap.data) {
        const fileDir = join(BACKUPS_DIR, 'data');
        const p = join(fileDir, snap.data);
        if (existsSync(p)) {
          const sha = readShaSidecar(p);
          const size = statSync(p).size;
          const verifiedStatus = checkIntegrity(p, sha);
          const counts = readCountsFromData(p);
          entry.data = { file: snap.data, size, sha256: sha, verified: verifiedStatus, counts };
          totalCount++;
          if (verifiedStatus === 'ok') okCount++;
        }
      }
      if (snap.src) {
        const fileDir = join(BACKUPS_DIR, 'src');
        const p = join(fileDir, snap.src);
        if (existsSync(p)) {
          const sha = readShaSidecar(p);
          const size = statSync(p).size;
          const verifiedStatus = checkIntegrity(p, sha);
          entry.src = { file: snap.src, size, sha256: sha, verified: verifiedStatus };
          totalCount++;
          if (verifiedStatus === 'ok') okCount++;
        }
      }

      entry.integrity = {
        ok: okCount,
        total: totalCount,
        status:
          totalCount === 0
            ? 'unknown'
            : okCount === totalCount
              ? 'verified'
              : okCount === 0
                ? 'failed'
                : 'partial',
      };
      verified.push(entry);
    }

    // Sort newest first
    verified.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    // Disk usage summary
    let totalSize = 0;
    for (const dir of ['db', 'data', 'src', 'bundles']) {
      const d = join(BACKUPS_DIR, dir);
      if (existsSync(d)) {
        for (const f of readdirSync(d)) {
          try {
            totalSize += statSync(join(d, f)).size;
          } catch {
            /* ignore */
          }
        }
      }
    }

    // Current DB info
    let currentDbSize = 0;
    let currentDbModified: string | null = null;
    if (existsSync(DB_PATH)) {
      const st = statSync(DB_PATH);
      currentDbSize = st.size;
      currentDbModified = st.mtime.toISOString();
    }

    // Estimate next snapshot
    const nextSnapshotIn = estimateNextSnapshot(verified);

    const response: BackupListResponse = {
      snapshots: verified,
      total: verified.length,
      lastUpdated,
      retention: { hourly: 168, daily: 30, weekly: 12 },
      diskUsageBytes: totalSize,
      diskUsageHuman: formatBytes(totalSize),
      currentDbSize,
      currentDbModified,
      nextSnapshotIn,
    };

    return NextResponse.json(response);
  } catch (e) {
    console.error('Backup list error:', e);
    return NextResponse.json(
      { error: 'Failed to list backups', detail: String(e) },
      { status: 500 },
    );
  }
}

function readShaSidecar(filePath: string): string | null {
  try {
    const shaPath = `${filePath}.sha256`;
    if (!existsSync(shaPath)) return null;
    const content = readFileSync(shaPath, 'utf-8').trim();
    // sidecar format: "<hex>  <filename>" OR just "<hex>"
    const parts = content.split(/\s+/);
    return parts[0] || null;
  } catch {
    return null;
  }
}

function checkIntegrity(
  filePath: string,
  expectedSha: string | null,
): SnapshotFile['verified'] {
  if (!expectedSha) return 'no-checksum';
  try {
    const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    return actual === expectedSha ? 'ok' : 'mismatch';
  } catch {
    return 'missing';
  }
}

function readCountsFromData(dataPath: string): Record<string, number> | undefined {
  try {
    const raw = readFileSync(dataPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.counts && typeof parsed.counts === 'object') {
      return parsed.counts as Record<string, number>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function estimateNextSnapshot(snapshots: SnapshotInfo[]): string | null {
  if (snapshots.length === 0) return null;
  // newest is first after sort
  const newest = snapshots[0];
  const m = newest.timestamp.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const lastTime = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  const nextTime = new Date(lastTime.getTime() + 60 * 60 * 1000); // +1 hour
  const now = new Date();
  const diffMs = nextTime.getTime() - now.getTime();
  if (diffMs <= 0) return 'скоро';
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 60) return `~${diffMin} мин`;
  const diffHr = Math.floor(diffMin / 60);
  const remMin = diffMin % 60;
  return `~${diffHr}ч ${remMin}м`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
