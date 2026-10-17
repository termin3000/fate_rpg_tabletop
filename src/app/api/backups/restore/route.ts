import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync, copyFileSync, statSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PROJECT_ROOT = process.env.FATE_DATA_ROOT || process.cwd();
const BACKUPS_DIR = join(PROJECT_ROOT, 'backups');
const DB_PATH = join(PROJECT_ROOT, 'db', 'custom.db');
const PRE_RESTORE_DIR = join(BACKUPS_DIR, 'pre-restore');

interface RestoreBody {
  ts: string;
  mode: 'db' | 'data' | 'both';
  confirm?: boolean;
}

// POST /api/backups/restore
// Restores the database (and/or JSON data) from a snapshot.
// CRITICAL: Before overwriting the live DB, makes a safety backup in backups/pre-restore/.
// Returns instructions for completing the restore (server restart needed).
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as RestoreBody;
    const { ts, mode = 'db', confirm } = body;

    if (!ts || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/.test(ts)) {
      return NextResponse.json(
        { error: 'Invalid or missing ts. Expected YYYY-MM-DDTHH-MM.' },
        { status: 400 },
      );
    }

    if (!confirm) {
      return NextResponse.json(
        {
          error: 'Confirmation required',
          hint: 'Send { confirm: true } to proceed with restore. This will overwrite the live database.',
          ts,
          mode,
        },
        { status: 409 },
      );
    }

    // Locate snapshot files
    const dbSnapshot = join(BACKUPS_DIR, 'db', `custom-${ts}.db`);
    const dataSnapshot = join(BACKUPS_DIR, 'data', `backup-${ts}.json`);

    const dbExists = existsSync(dbSnapshot);
    const dataExists = existsSync(dataSnapshot);

    if (mode === 'db' && !dbExists) {
      return NextResponse.json(
        { error: 'Snapshot DB file not found', path: dbSnapshot },
        { status: 404 },
      );
    }
    if (mode === 'data' && !dataExists) {
      return NextResponse.json(
        { error: 'Snapshot JSON data file not found', path: dataSnapshot },
        { status: 404 },
      );
    }
    if (mode === 'both' && !dbExists && !dataExists) {
      return NextResponse.json(
        { error: 'No snapshot files found for this timestamp' },
        { status: 404 },
      );
    }

    // Verify checksums before restoring (refuse to restore corrupted snapshot)
    const checks: { file: string; ok: boolean; reason?: string }[] = [];
    if (mode !== 'data' && dbExists) {
      const ok = verifyChecksum(dbSnapshot);
      checks.push({ file: 'db', ok: ok.ok, reason: ok.reason });
      if (!ok.ok) {
        return NextResponse.json(
          { error: 'Snapshot DB checksum verification failed — refusing to restore corrupted file', checks },
          { status: 422 },
        );
      }
    }
    if (mode !== 'db' && dataExists) {
      const ok = verifyChecksum(dataSnapshot);
      checks.push({ file: 'data', ok: ok.ok, reason: ok.reason });
      if (!ok.ok) {
        return NextResponse.json(
          { error: 'Snapshot data checksum verification failed — refusing to restore corrupted file', checks },
          { status: 422 },
        );
      }
    }

    // Step 1: safety backup of the CURRENT live DB
    mkdirSync(PRE_RESTORE_DIR, { recursive: true });
    const safetyTs = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .slice(0, 19);
    const safetyDbPath = join(PRE_RESTORE_DIR, `pre-restore-${safetyTs}.db`);
    const safetyDataPath = join(PRE_RESTORE_DIR, `pre-restore-${safetyTs}.json`);

    const restoredFiles: string[] = [];
    const safetyFiles: string[] = [];

    if (existsSync(DB_PATH)) {
      copyFileSync(DB_PATH, safetyDbPath);
      writeShaSidecar(safetyDbPath);
      safetyFiles.push(safetyDbPath);
    }

    // Step 2: restore DB by copying snapshot over live DB
    if ((mode === 'db' || mode === 'both') && dbExists) {
      // Prisma might have a handle open — copyFileSync should still work on Linux
      copyFileSync(dbSnapshot, DB_PATH);
      restoredFiles.push(`db/custom.db ← custom-${ts}.db`);
    }

    // Step 3: for data mode, also restore the JSON export to public/ (for re-import)
    if (mode === 'data' || mode === 'both') {
      if (dataExists) {
        const publicDataPath = join(PROJECT_ROOT, 'public', 'fate-data-backup.json');
        copyFileSync(dataSnapshot, publicDataPath);
        // Also copy to pre-restore safety
        copyFileSync(dataSnapshot, safetyDataPath);
        writeShaSidecar(safetyDataPath);
        safetyFiles.push(safetyDataPath);
        restoredFiles.push(`public/fate-data-backup.json ← backup-${ts}.json`);
      }
    }

    // Step 4: try to re-import the JSON data into the DB via prisma (only if data mode)
    let reimportResult: { ok: boolean; message: string } | null = null;
    if (mode === 'data' && dataExists) {
      reimportResult = await reimportJsonToDb(dataSnapshot);
    }

    return NextResponse.json({
      ok: true,
      ts,
      mode,
      restoredFiles,
      safetyBackup: {
        dir: PRE_RESTORE_DIR,
        files: safetyFiles,
        note: 'If restore goes wrong, copy these back to db/custom.db to undo.',
      },
      checks,
      reimportResult,
      nextStep:
        'Перезагрузите страницу (F5), чтобы приложение подхватило восстановленную БД. ' +
        'Если что-то пошло не так — safety backup находится в backups/pre-restore/.',
    });
  } catch (e) {
    console.error('Restore error:', e);
    return NextResponse.json(
      { error: 'Restore failed', detail: String(e) },
      { status: 500 },
    );
  }
}

function verifyChecksum(filePath: string): { ok: boolean; reason?: string } {
  const shaPath = `${filePath}.sha256`;
  if (!existsSync(shaPath)) {
    return { ok: false, reason: 'no checksum sidecar' };
  }
  try {
    const expected = readFileSync(shaPath, 'utf-8').trim().split(/\s+/)[0];
    const actual = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    if (expected !== actual) {
      return { ok: false, reason: `checksum mismatch (expected ${expected?.slice(0, 8)}, got ${actual.slice(0, 8)})` };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: e?.message || 'unknown error' };
  }
}

function writeShaSidecar(filePath: string): void {
  try {
    const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex');
    const name = filePath.split('/').pop() || filePath;
    writeFileSync(`${filePath}.sha256`, `${hash}  ${name}`, 'utf-8');
  } catch {
    // best-effort
  }
}

async function reimportJsonToDb(jsonPath: string): Promise<{ ok: boolean; message: string }> {
  try {
    // Use the existing import script as a subprocess (it has the full prisma logic)
    // We don't have a direct reimport script, so we just report that data is in public/
    // and the user can use the existing /api/adventures/import flow.
    const size = statSync(jsonPath).size;
    return {
      ok: true,
      message: `JSON restored to public/fate-data-backup.json (${formatBytes(size)}). Use Backup Dialog → "Импорт JSON" to load it into the DB.`,
    };
  } catch (e: any) {
    return { ok: false, message: e?.message || 'reimport failed' };
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}
