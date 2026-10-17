import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export const dynamic = 'force-dynamic';

const BACKUPS_DIR = join(process.env.FATE_DATA_ROOT || process.cwd(), 'backups');

interface VerifyResult {
  file: string;
  size: number;
  expected: string | null;
  actual: string | null;
  status: 'ok' | 'mismatch' | 'missing' | 'no-checksum';
  durationMs: number;
}

// POST /api/backups/verify
// Body: { ts: "YYYY-MM-DDTHH-MM" }  — verifies all 3 files (db, data, src) for that snapshot
// Returns per-file status + overall integrity verdict
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const ts = body?.ts;
    if (!ts || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/.test(ts)) {
      return NextResponse.json(
        { error: 'Invalid or missing ts. Expected YYYY-MM-DDTHH-MM.' },
        { status: 400 },
      );
    }

    const targets: { type: 'db' | 'data' | 'src'; path: string }[] = [
      { type: 'db', path: join(BACKUPS_DIR, 'db', `custom-${ts}.db`) },
      { type: 'data', path: join(BACKUPS_DIR, 'data', `backup-${ts}.json`) },
      { type: 'src', path: join(BACKUPS_DIR, 'src', `source-${ts}.zip`) },
    ];

    const results: Record<string, VerifyResult> = {};
    let okCount = 0;
    let totalChecked = 0;

    for (const t of targets) {
      const start = Date.now();
      if (!existsSync(t.path)) {
        results[t.type] = {
          file: t.path.split('/').pop() || t.path,
          size: 0,
          expected: null,
          actual: null,
          status: 'missing',
          durationMs: Date.now() - start,
        };
        continue;
      }

      const size = statSync(t.path).size;
      const shaPath = `${t.path}.sha256`;
      let expected: string | null = null;
      if (existsSync(shaPath)) {
        expected = readFileSync(shaPath, 'utf-8').trim().split(/\s+/)[0] || null;
      }

      if (!expected) {
        results[t.type] = {
          file: t.path.split('/').pop() || t.path,
          size,
          expected: null,
          actual: null,
          status: 'no-checksum',
          durationMs: Date.now() - start,
        };
        continue;
      }

      const actual = createHash('sha256').update(readFileSync(t.path)).digest('hex');
      const status: VerifyResult['status'] = actual === expected ? 'ok' : 'mismatch';
      totalChecked++;
      if (status === 'ok') okCount++;

      results[t.type] = {
        file: t.path.split('/').pop() || t.path,
        size,
        expected,
        actual,
        status,
        durationMs: Date.now() - start,
      };
    }

    const overall: 'verified' | 'partial' | 'failed' | 'unknown' =
      totalChecked === 0
        ? 'unknown'
        : okCount === totalChecked
          ? 'verified'
          : okCount === 0
            ? 'failed'
            : 'partial';

    return NextResponse.json({
      ts,
      results,
      overall,
      ok: okCount,
      total: totalChecked,
      summary:
        overall === 'verified'
          ? `Все ${totalChecked} файла прошли проверку целостности`
          : overall === 'partial'
            ? `${okCount}/${totalChecked} файлов прошли проверку`
            : overall === 'failed'
              ? 'Целостность нарушена — все файлы повреждены'
              : 'Нет контрольных сумм для проверки',
    });
  } catch (e) {
    console.error('Verify error:', e);
    return NextResponse.json(
      { error: 'Verify failed', detail: String(e) },
      { status: 500 },
    );
  }
}
