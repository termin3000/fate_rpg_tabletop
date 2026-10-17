import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROJECT_ROOT = process.env.FATE_DATA_ROOT || process.cwd();
const MANIFEST_PATH = join(PROJECT_ROOT, 'backups', 'manifest.json');

// POST /api/backups/snapshot
// Manually triggers a new immutable snapshot via scripts/snapshot_backup.ts.
// Runs as a background subprocess (non-blocking) — returns immediately with a job id.
// Poll the manifest to see when the new snapshot appears.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const reason = body?.reason || 'manual';

    // Count current snapshots for "before" baseline
    const beforeCount = countSnapshots();

    // Spawn the snapshot script as a detached background process
    const child = spawn(
      'bun',
      ['run', 'scripts/snapshot_backup.ts'],
      {
        cwd: PROJECT_ROOT,
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, SNAPSHOT_REASON: reason },
      },
    );
    child.unref();

    // Capture job id (pid) for status tracking
    const jobId = String(child.pid ?? Date.now());

    return NextResponse.json({
      ok: true,
      jobId,
      pid: child.pid,
      reason,
      beforeCount,
      message: 'Создание снапшота запущено в фоне. Обновите список через ~5-10 секунд.',
      estimatedDuration: '5-10s',
      pollHint: 'GET /api/backups/list — новый снапшот появится сверху',
    });
  } catch (e) {
    console.error('Snapshot trigger error:', e);
    return NextResponse.json(
      { error: 'Failed to trigger snapshot', detail: String(e) },
      { status: 500 },
    );
  }
}

function countSnapshots(): number {
  try {
    if (!existsSync(MANIFEST_PATH)) return 0;
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    if (Array.isArray(raw)) return raw.length;
    if (Array.isArray(raw.snapshots)) return raw.snapshots.length;
    return 0;
  } catch {
    return 0;
  }
}
