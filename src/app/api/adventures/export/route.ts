import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// The Note delegate can be missing in dev hot-reload (singleton caching).
// Detect and fall back to raw SQL — same pattern as /api/notes/route.ts.
function hasNoteDelegate(): boolean {
  return typeof (db as unknown as { note?: unknown }).note !== 'undefined';
}

// SQLite raw queries return BigInt for integer columns; JSON.stringify can't
// handle BigInt. Normalise values to plain numbers / booleans.
function normalizeRawRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') {
      const num = Number(v);
      out[k] = k === 'pinned' ? num === 1 : num;
    } else {
      out[k] = v;
    }
  }
  return out;
}

async function findNotes(adventureId: string): Promise<Record<string, unknown>[]> {
  if (hasNoteDelegate()) {
    return db.note.findMany({ where: { adventureId } }) as unknown as Promise<Record<string, unknown>[]>;
  }
  const rows = await db.$queryRaw`
    SELECT id, title, content, category, pinned, color, adventureId, createdAt, updatedAt
    FROM Note
    WHERE adventureId = ${adventureId}
  `;
  return (Array.isArray(rows) ? rows : []).map((r) =>
    normalizeRawRow(r as Record<string, unknown>),
  );
}

// ── JSON field parsers ──────────────────────────────────────
const CHARACTER_JSON_FIELDS = [
  'aspects',
  'skills',
  'stunts',
  'stressTracks',
  'consequences',
  'situationalAspects',
  'members',
] as const;

const SCENE_JSON_FIELDS = [
  'floors',
  'presentCharacters',
  'items',
] as const;

const LOG_JSON_FIELDS = ['diceResults', 'opponentDiceResults', 'helpers', 'opponentHelpers'] as const;

function safeParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseCharacter(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const f of CHARACTER_JSON_FIELDS) {
    out[f] = safeParse(out[f], []);
  }
  return out;
}

function parseScene(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const f of SCENE_JSON_FIELDS) {
    out[f] = safeParse(out[f], []);
  }
  // conflictData may be null
  if (out.conflictData === null || out.conflictData === undefined) {
    out.conflictData = null;
  } else if (typeof out.conflictData === 'string') {
    out.conflictData = safeParse(out.conflictData, null);
  }
  // Normalize conflictData: ensure waitingIds and eliminatedIds exist
  if (out.conflictData && typeof out.conflictData === 'object') {
    const cd = out.conflictData as Record<string, unknown>;
    if (!Array.isArray(cd.waitingIds)) cd.waitingIds = [];
    if (!Array.isArray(cd.eliminatedIds)) cd.eliminatedIds = [];
  }
  return out;
}

function parseLogEntry(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...raw };
  for (const f of LOG_JSON_FIELDS) {
    out[f] = safeParse(out[f], []);
  }
  return out;
}

// GET /api/adventures/export?id=xxx — Export full adventure as JSON backup
export async function GET(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { error: 'Missing id parameter' },
        { status: 400 },
      );
    }

    const adventure = await db.adventure.findUnique({ where: { id } });
    if (!adventure) {
      return NextResponse.json(
        { error: 'Adventure not found' },
        { status: 404 },
      );
    }

    // Load all related entities in parallel. Note uses a delegate-or-raw-SQL
    // helper because the Note delegate can be missing in dev hot-reload.
    const [characters, scenes, logEntries, items, folders, notes] = await Promise.all([
      db.character.findMany({ where: { adventureId: id } }),
      db.scene.findMany({ where: { adventureId: id } }),
      db.logEntry.findMany({ where: { adventureId: id }, orderBy: { createdAt: 'asc' } }),
      db.item.findMany({ where: { adventureId: id } }),
      db.folder.findMany({ where: { adventureId: id } }),
      findNotes(id),
    ]);

    const result = {
      version: 1,
      exportedAt: new Date().toISOString(),
      adventure: {
        id: adventure.id,
        name: adventure.name,
        currentSceneId: adventure.currentSceneId,
        settings: safeParse(adventure.settings, { baseSkills: [], initiative: {}, modules: { magic: false } }),
        createdAt: adventure.createdAt,
        updatedAt: adventure.updatedAt,
        characters: characters.map((c) => parseCharacter(c as unknown as Record<string, unknown>)),
        scenes: scenes.map((s) => parseScene(s as unknown as Record<string, unknown>)),
        logEntries: logEntries.map((e) => parseLogEntry(e as unknown as Record<string, unknown>)),
        items: items.map((i) => ({ ...i })),
        folders: folders.map((f) => ({ ...f })),
        notes: notes.map((n) => ({ ...n })),
      },
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error('GET /api/adventures/export error:', error);
    return NextResponse.json(
      { error: 'Failed to export adventure' },
      { status: 500 },
    );
  }
}
