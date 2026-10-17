import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';

// In dev mode with hot reload, the @prisma/client module can be cached with
// an outdated schema (before Note model was added). We use a tagged template
// fallback via $queryRaw when db.note is unavailable, so the API still works.

// Type-safe check for whether the Note delegate is available on this client
function hasNoteDelegate(): boolean {
  return typeof (db as unknown as { note?: unknown }).note !== 'undefined';
}

// SQLite raw queries return BigInt for integer columns, which JSON.stringify
// can't handle. This helper converts any BigInt values to plain numbers and
// normalizes 0/1 to boolean for the pinned field.
function normalizeRawNote(row: Record<string, unknown>): Record<string, unknown> {
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

// Helper to safely run a note query — uses the model delegate if available,
// otherwise falls back to raw SQL.
async function findNotes(adventureId: string) {
  if (hasNoteDelegate()) {
    return db.note.findMany({
      where: { adventureId },
      orderBy: [{ pinned: 'desc' }, { updatedAt: 'desc' }],
    });
  }
  // Raw SQL fallback — SQLite stores booleans as 0/1
  const rows = await db.$queryRaw`
    SELECT id, title, content, category, pinned, color, adventureId, createdAt, updatedAt
    FROM Note
    WHERE adventureId = ${adventureId}
    ORDER BY pinned DESC, updatedAt DESC
  `;
  return (Array.isArray(rows) ? rows : []).map((r) =>
    normalizeRawNote(r as Record<string, unknown>),
  );
}

// GET /api/notes?adventureId=xxx — List notes for an adventure
export async function GET(request: NextRequest) {
  try {
    const adventureId = request.nextUrl.searchParams.get('adventureId');
    if (!adventureId) {
      return NextResponse.json(
        { error: 'Missing adventureId parameter' },
        { status: 400 },
      );
    }

    const notes = await findNotes(adventureId);
    return NextResponse.json(notes);
  } catch (error) {
    console.error('GET /api/notes error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch notes' },
      { status: 500 },
    );
  }
}

// POST /api/notes — Create a new note
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { adventureId } = body;

    if (!adventureId) {
      return NextResponse.json(
        { error: 'Missing adventureId' },
        { status: 400 },
      );
    }

    const title = body.title || 'Новая заметка';
    const content = body.content ?? '';
    const category = body.category ?? 'session';
    const pinnedBool = body.pinned ?? false;
    const pinned = pinnedBool ? 1 : 0;
    const color = body.color ?? 'default';

    if (hasNoteDelegate()) {
      const note = await db.note.create({
        data: { title, content, category, pinned: pinnedBool, color, adventureId },
      });
      return NextResponse.json(note);
    }

    // Raw SQL fallback — generate a CUID-like id
    const id = `cmrk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    await db.$executeRaw`
      INSERT INTO Note (id, title, content, category, pinned, color, adventureId, createdAt, updatedAt)
      VALUES (${id}, ${title}, ${content}, ${category}, ${pinned}, ${color}, ${adventureId},
              datetime('now'), datetime('now'))
    `;
    const rows = await db.$queryRaw`
      SELECT id, title, content, category, pinned, color, adventureId, createdAt, updatedAt
      FROM Note WHERE id = ${id}
    `;
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    return NextResponse.json(row ? normalizeRawNote(row as Record<string, unknown>) : { id, title, content, category, pinned: pinnedBool, color, adventureId });
  } catch (error) {
    console.error('POST /api/notes error:', error);
    return NextResponse.json(
      { error: 'Failed to create note' },
      { status: 500 },
    );
  }
}

// PUT /api/notes?id=xxx — Update a note
export async function PUT(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { error: 'Missing id parameter' },
        { status: 400 },
      );
    }

    const body = await request.json();

    if (hasNoteDelegate()) {
      const data: Record<string, unknown> = {};
      if (body.title !== undefined) data.title = body.title;
      if (body.content !== undefined) data.content = body.content;
      if (body.category !== undefined) data.category = body.category;
      if (body.pinned !== undefined) data.pinned = body.pinned;
      if (body.color !== undefined) data.color = body.color;
      const note = await db.note.update({ where: { id }, data });
      return NextResponse.json(note);
    }

    // Raw SQL fallback
    const sets: string[] = [];
    if (body.title !== undefined) sets.push(`title = ${Prisma.sql`${body.title}`}`);
    if (body.content !== undefined) sets.push(`content = ${Prisma.sql`${body.content}`}`);
    if (body.category !== undefined) sets.push(`category = ${Prisma.sql`${body.category}`}`);
    if (body.pinned !== undefined) sets.push(`pinned = ${body.pinned ? 1 : 0}`);
    if (body.color !== undefined) sets.push(`color = ${Prisma.sql`${body.color}`}`);
    sets.push(`updatedAt = datetime('now')`);

    if (sets.length > 1) {
      await db.$executeRaw`UPDATE Note SET ${Prisma.raw(sets.join(', '))} WHERE id = ${id}`;
    }
    const rows = await db.$queryRaw`
      SELECT id, title, content, category, pinned, color, adventureId, createdAt, updatedAt
      FROM Note WHERE id = ${id}
    `;
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    return NextResponse.json(row ? normalizeRawNote(row as Record<string, unknown>) : { id });
  } catch (error) {
    console.error('PUT /api/notes error:', error);
    return NextResponse.json(
      { error: 'Failed to update note' },
      { status: 500 },
    );
  }
}

// DELETE /api/notes?id=xxx — Delete a note
export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { error: 'Missing id parameter' },
        { status: 400 },
      );
    }

    if (hasNoteDelegate()) {
      await db.note.delete({ where: { id } });
    } else {
      await db.$executeRaw`DELETE FROM Note WHERE id = ${id}`;
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/notes error:', error);
    return NextResponse.json(
      { error: 'Failed to delete note' },
      { status: 500 },
    );
  }
}

