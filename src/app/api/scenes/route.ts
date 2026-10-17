import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { genId } from '@/lib/fate-dice';

// JSON fields that need parsing on read
const JSON_FIELDS = [
  'floors',
  'presentCharacters',
  'conflictData',
  'items',
] as const;

function parseScene(raw: Record<string, unknown>) {
  const result: Record<string, unknown> = { ...raw };
  for (const field of JSON_FIELDS) {
    if (field === 'conflictData') {
      // conflictData can be null
      if (result[field] === null || result[field] === undefined) {
        result[field] = null;
      } else if (typeof result[field] === 'string') {
        try {
          result[field] = JSON.parse(result[field] as string);
        } catch {
          result[field] = null;
        }
      }
      // Normalize conflictData: ensure waitingIds and eliminatedIds exist
      if (result[field] && typeof result[field] === 'object') {
        const cd = result[field] as Record<string, unknown>;
        if (!Array.isArray(cd.waitingIds)) cd.waitingIds = [];
        if (!Array.isArray(cd.eliminatedIds)) cd.eliminatedIds = [];
      }
    } else if (typeof result[field] === 'string') {
      try {
        result[field] = JSON.parse(result[field] as string);
      } catch {
        result[field] = [];
      }
    }
  }
  return result;
}

// Default floor for new scenes
function defaultFloors() {
  return [
    {
      id: genId(),
      name: 'Этаж 1',
      opacity: 100,
      background: null,
      tokens: [],
      drawings: [],
      zones: [],
      pins: [],
    },
  ];
}

// GET /api/scenes?adventureId=xxx — List scenes for an adventure
export async function GET(request: NextRequest) {
  try {
    const adventureId = request.nextUrl.searchParams.get('adventureId');
    if (!adventureId) {
      return NextResponse.json(
        { error: 'Missing adventureId parameter' },
        { status: 400 },
      );
    }

    const scenes = await db.scene.findMany({
      where: { adventureId },
      orderBy: { createdAt: 'asc' },
    });

    const result = scenes.map((s) => parseScene(s as unknown as Record<string, unknown>));
    return NextResponse.json(result);
  } catch (error) {
    console.error('GET /api/scenes error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch scenes' },
      { status: 500 },
    );
  }
}

// POST /api/scenes — Create a new scene
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

    // Verify adventure exists
    const adventure = await db.adventure.findUnique({ where: { id: adventureId } });
    if (!adventure) {
      return NextResponse.json(
        { error: 'Adventure not found' },
        { status: 404 },
      );
    }

    const floors = body.floors ?? defaultFloors();

    const scene = await db.scene.create({
      data: {
        name: body.name || 'Новая сцена',
        adventureId,
        currentFloorIndex: body.currentFloorIndex ?? 0,
        playerFloorIndex: body.playerFloorIndex ?? 0,
        floors: JSON.stringify(floors),
        presentCharacters: JSON.stringify(body.presentCharacters ?? []),
        conflictData: body.conflictData ? JSON.stringify(body.conflictData) : null,
        items: JSON.stringify(body.items ?? []),
      },
    });

    return NextResponse.json(parseScene(scene as unknown as Record<string, unknown>));
  } catch (error) {
    console.error('POST /api/scenes error:', error);
    return NextResponse.json(
      { error: 'Failed to create scene' },
      { status: 500 },
    );
  }
}

// PUT /api/scenes?id=xxx — Update a scene
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
    const data: Record<string, unknown> = {};

    // Scalar fields
    if (body.name !== undefined) data.name = body.name;
    if (body.currentFloorIndex !== undefined) data.currentFloorIndex = body.currentFloorIndex;
    if (body.playerFloorIndex !== undefined) data.playerFloorIndex = body.playerFloorIndex;

    // JSON fields — stringify before saving
    if (body.floors !== undefined) data.floors = JSON.stringify(body.floors);
    if (body.presentCharacters !== undefined) data.presentCharacters = JSON.stringify(body.presentCharacters);
    if (body.conflictData !== undefined) {
      data.conflictData = body.conflictData ? JSON.stringify(body.conflictData) : null;
    }
    if (body.items !== undefined) data.items = JSON.stringify(body.items);

    const scene = await db.scene.update({
      where: { id },
      data,
    });

    return NextResponse.json(parseScene(scene as unknown as Record<string, unknown>));
  } catch (error) {
    console.error('PUT /api/scenes error:', error);
    return NextResponse.json(
      { error: 'Failed to update scene' },
      { status: 500 },
    );
  }
}

// DELETE /api/scenes?id=xxx — Delete a scene
export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { error: 'Missing id parameter' },
        { status: 400 },
      );
    }

    await db.scene.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/scenes error:', error);
    return NextResponse.json(
      { error: 'Failed to delete scene' },
      { status: 500 },
    );
  }
}
