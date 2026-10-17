import { NextRequest, NextResponse } from 'next/server';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

export const dynamic = 'force-dynamic';

const PROJECT_ROOT = process.env.FATE_DATA_ROOT || process.cwd();
const BACKUPS_DIR = join(PROJECT_ROOT, 'backups');
const MANIFEST_PATH = join(BACKUPS_DIR, 'manifest.json');

// GET /api/backups/latest?type=bundle|mirror
//
// - type=bundle → dynamically built zip from the latest snapshot's db + data + src
// - type=mirror → the latest snapshot's src zip (renamed as source-mirror.zip)
//
// Previously this endpoint required a pre-built file in public/, which silently
// 404'd when no script had built it. Now it always resolves from the manifest.

interface RawManifestEntry {
  timestamp: string;
  db?: string;
  data?: string;
  src?: string;
  dbSize?: number;
  dataSize?: number;
  srcSize?: number;
}

function readLatestTimestamp(): string | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
    let entries: RawManifestEntry[] = [];
    if (Array.isArray(raw)) {
      entries = raw;
    } else if (Array.isArray(raw.snapshots)) {
      entries = raw.snapshots;
    }
    if (entries.length === 0) return null;
    // sort newest first
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return entries[0].timestamp ?? null;
  } catch {
    return null;
  }
}

function buildBundleZip(ts: string, bundlePath: string): boolean {
  const dbPath = join(BACKUPS_DIR, 'db', `custom-${ts}.db`);
  const dataPath = join(BACKUPS_DIR, 'data', `backup-${ts}.json`);
  const srcPath = join(BACKUPS_DIR, 'src', `source-${ts}.zip`);

  const args: string[] = ['-j', '-q', bundlePath]; // -j = junk paths (flatten), -q = quiet
  let added = false;
  if (existsSync(dbPath)) {
    args.push(dbPath);
    added = true;
  }
  if (existsSync(dataPath)) {
    args.push(dataPath);
    added = true;
  }
  if (existsSync(srcPath)) {
    args.push(srcPath);
    added = true;
  }
  if (!added) return false;

  const result = spawnSync('zip', args, { cwd: BACKUPS_DIR, timeout: 30000 });
  return result.status === 0 && existsSync(bundlePath);
}

function serveFile(
  filepath: string,
  filename: string,
  contentType: string,
  extraHeaders: Record<string, string> = {},
) {
  const data = readFileSync(filepath);
  const stat = statSync(filepath);
  return new NextResponse(data as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...extraHeaders,
    },
  });
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const type = searchParams.get('type') ?? 'bundle';

    const latestTs = readLatestTimestamp();
    if (!latestTs) {
      return NextResponse.json(
        {
          error:
            'No snapshots found. Create one first via POST /api/backups/snapshot or the "Создать снапшот сейчас" button.',
        },
        { status: 404 },
      );
    }

    if (type === 'bundle') {
      // Use pre-built bundle if it exists and matches the latest snapshot;
      // otherwise build on-demand into the bundles cache dir.
      const cachedPath = join(BACKUPS_DIR, 'bundles', `bundle-${latestTs}.zip`);
      if (!existsSync(cachedPath)) {
        const built = buildBundleZip(latestTs, cachedPath);
        if (!built) {
          return NextResponse.json(
            {
              error: 'Failed to build bundle from latest snapshot.',
              timestamp: latestTs,
            },
            { status: 500 },
          );
        }
      }
      return serveFile(cachedPath, `fate-rpg-bundle-${latestTs}.zip`, 'application/zip', {
        'X-Backup-Timestamp': latestTs,
        'X-Backup-Type': 'bundle',
      });
    }

    if (type === 'mirror') {
      // The src backup IS already a self-contained zip of the source tree.
      const srcPath = join(BACKUPS_DIR, 'src', `source-${latestTs}.zip`);
      if (!existsSync(srcPath)) {
        return NextResponse.json(
          {
            error: 'Source mirror not found in latest snapshot.',
            timestamp: latestTs,
          },
          { status: 404 },
        );
      }
      return serveFile(srcPath, `source-mirror-${latestTs}.zip`, 'application/zip', {
        'X-Backup-Timestamp': latestTs,
        'X-Backup-Type': 'mirror',
      });
    }

    return NextResponse.json(
      { error: 'Invalid type. Use ?type=bundle or ?type=mirror' },
      { status: 400 },
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('Latest backup download error:', e);
    return NextResponse.json(
      { error: 'Internal error', details: msg },
      { status: 500 },
    );
  }
}
