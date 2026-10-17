import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { DEFAULT_SETTINGS } from '@/lib/types';

// GET /api/adventures — List all adventures with character/scene counts
export async function GET() {
  try {
    const adventures = await db.adventure.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        _count: {
          select: { characters: true, scenes: true },
        },
      },
    });

    const result = adventures.map((a) => ({
      id: a.id,
      name: a.name,
      currentSceneId: a.currentSceneId,
      settings: JSON.parse(a.settings),
      characterCount: a._count.characters,
      sceneCount: a._count.scenes,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error('GET /api/adventures error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch adventures' },
      { status: 500 },
    );
  }
}

// POST /api/adventures — Create a new adventure
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const name = body.name || 'Новое приключение';

    const adventure = await db.adventure.create({
      data: {
        name,
        settings: JSON.stringify(DEFAULT_SETTINGS),
      },
    });

    return NextResponse.json({
      id: adventure.id,
      name: adventure.name,
      currentSceneId: adventure.currentSceneId,
      settings: JSON.parse(adventure.settings),
      characterCount: 0,
      sceneCount: 0,
      createdAt: adventure.createdAt,
      updatedAt: adventure.updatedAt,
    });
  } catch (error) {
    console.error('POST /api/adventures error:', error);
    return NextResponse.json(
      { error: 'Failed to create adventure' },
      { status: 500 },
    );
  }
}

// PUT /api/adventures?id=xxx — Update adventure
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

    if (body.name !== undefined) data.name = body.name;
    if (body.settings !== undefined) data.settings = JSON.stringify(body.settings);
    if (body.currentSceneId !== undefined) data.currentSceneId = body.currentSceneId;

    const adventure = await db.adventure.update({
      where: { id },
      data,
    });

    return NextResponse.json({
      id: adventure.id,
      name: adventure.name,
      currentSceneId: adventure.currentSceneId,
      settings: JSON.parse(adventure.settings),
      createdAt: adventure.createdAt,
      updatedAt: adventure.updatedAt,
    });
  } catch (error) {
    console.error('PUT /api/adventures error:', error);
    return NextResponse.json(
      { error: 'Failed to update adventure' },
      { status: 500 },
    );
  }
}

// DELETE /api/adventures?id=xxx — Delete adventure and all related data
export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { error: 'Missing id parameter' },
        { status: 400 },
      );
    }

    // Cascade delete is handled by Prisma schema (onDelete: Cascade)
    await db.adventure.delete({ where: { id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/adventures error:', error);
    return NextResponse.json(
      { error: 'Failed to delete adventure' },
      { status: 500 },
    );
  }
}
