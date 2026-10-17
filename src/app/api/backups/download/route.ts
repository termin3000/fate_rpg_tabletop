import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

export const dynamic = 'force-dynamic';

const BACKUPS_DIR = join(process.env.FATE_DATA_ROOT || process.cwd(), 'backups');

// GET /api/backups/download?type=db|data|src|bundle&ts=YYYY-MM-DDTHH-MM
//
// - type=db    → backups/db/custom-{ts}.db
// - type=data  → backups/data/backup-{ts}.json
// - type=src   → backups/src/source-{ts}.zip
// - type=bundle → backups/bundles/bundle-{ts}.zip (created on-demand if missing)
//
// Optional: ?verify=1 — recomputes sha256 and compares to .sha256 sidecar.
//           Returns 422 if checksum mismatch (data corruption detected).
//
// Optional: ?bundle=1 with type=db|data|src — returns a single zip containing
//           db + data + src for that timestamp. Created on-demand.

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get('type') ?? 'bundle';
    const ts = searchParams.get('ts');
    const verify = searchParams.get('verify') === '1';

    if (!ts || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}$/.test(ts)) {
      return NextResponse.json(
        { error: 'Invalid or missing ts parameter. Expected YYYY-MM-DDTHH-MM.' },
        { status: 400 },
      );
    }

    // Resolve the file to serve
    let filepath = '';
    let filename = '';
    let contentType = 'application/octet-stream';

    if (type === 'db') {
      filepath = join(BACKUPS_DIR, 'db', `custom-${ts}.db`);
      filename = `custom-${ts}.db`;
      contentType = 'application/octet-stream';
    } else if (type === 'data') {
      filepath = join(BACKUPS_DIR, 'data', `backup-${ts}.json`);
      filename = `backup-${ts}.json`;
      contentType = 'application/json';
    } else if (type === 'src') {
      filepath = join(BACKUPS_DIR, 'src', `source-${ts}.zip`);
      filename = `source-${ts}.zip`;
      contentType = 'application/zip';
    } else if (type === 'bundle') {
      // Build a bundle zip on demand if it doesn't exist
      const bundlePath = join(BACKUPS_DIR, 'bundles', `bundle-${ts}.zip`);
      if (!existsSync(bundlePath)) {
        const built = buildBundle(ts, bundlePath);
        if (!built) {
          return NextResponse.json(
            { error: 'No files found for this timestamp to bundle.' },
            { status: 404 },
          );
        }
      }
      filepath = bundlePath;
      filename = `fate-rpg-bundle-${ts}.zip`;
      contentType = 'application/zip';
    } else {
      return NextResponse.json(
        { error: 'Invalid type. Use db, data, src, or bundle.' },
        { status: 400 },
      );
    }

    if (!existsSync(filepath)) {
      return NextResponse.json(
        { error: 'Snapshot not found', requestedType: type, timestamp: ts },
        { status: 404 },
      );
    }

    // Optional integrity check
    if (verify && type !== 'bundle') {
      const shaPath = filepath + '.sha256';
      if (existsSync(shaPath)) {
        const expected = readFileSync(shaPath, 'utf-8').trim().split(/\s+/)[0];
        const actual = createHash('sha256').update(readFileSync(filepath)).digest('hex');
        if (expected !== actual) {
          return NextResponse.json(
            {
              error: 'Checksum mismatch — snapshot may be corrupted',
              expected,
              actual,
              file: filename,
            },
            { status: 422 },
          );
        }
      }
    }

    const data = readFileSync(filepath);
    const stat = statSync(filepath);

    return new NextResponse(data as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(stat.size),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'X-Backup-Timestamp': ts,
        'X-Backup-Type': type,
        'X-Backup-Size': String(stat.size),
      },
    });
  } catch (e) {
    console.error('Backup download error:', e);
    return NextResponse.json(
      { error: 'Download failed', detail: String(e) },
      { status: 500 },
    );
  }
}

function buildBundle(ts: string, bundlePath: string): boolean {
  // Combine db + data + src into a single zip using the `zip` command
  const dbPath = join(BACKUPS_DIR, 'db', `custom-${ts}.db`);
  const dataPath = join(BACKUPS_DIR, 'data', `backup-${ts}.json`);
  const srcPath = join(BACKUPS_DIR, 'src', `source-${ts}.zip`);

  const args: string[] = ['-j', '-r', bundlePath]; // -j = junk paths (flatten)
  let added = false;
  if (existsSync(dbPath)) { args.push(dbPath); added = true; }
  if (existsSync(dataPath)) { args.push(dataPath); added = true; }
  if (existsSync(srcPath)) { args.push(srcPath); added = true; }

  if (!added) return false;

  const result = spawnSync('zip', args, { cwd: BACKUPS_DIR });
  return result.status === 0 && existsSync(bundlePath);
}
