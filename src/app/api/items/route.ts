import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/items?adventureId=xxx — List items for an adventure
export async function GET(request: NextRequest) {
  try {
    const adventureId = request.nextUrl.searchParams.get('adventureId');
    if (!adventureId) {
      return NextResponse.json(
        { error: 'Missing adventureId parameter' },
        { status: 400 },
      );
    }

    const items = await db.item.findMany({
      where: { adventureId },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json(items);
  } catch (error) {
    console.error('GET /api/items error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch items' },
      { status: 500 },
    );
  }
}

// POST /api/items — Create a new item
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

    const item = await db.item.create({
      data: {
        name: body.name || 'Новый предмет',
        type: body.type || 'item',
        description: body.description ?? '',
        text: body.text ?? null,
        adventureId,
        sceneId: body.sceneId ?? null,
      },
    });

    return NextResponse.json(item);
  } catch (error) {
    console.error('POST /api/items error:', error);
    return NextResponse.json(
      { error: 'Failed to create item' },
      { status: 500 },
    );
  }
}

// PUT /api/items?id=xxx — Update an item
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
    if (body.type !== undefined) data.type = body.type;
    if (body.description !== undefined) data.description = body.description;
    if (body.text !== undefined) data.text = body.text;
    if (body.sceneId !== undefined) data.sceneId = body.sceneId;

    const item = await db.item.update({
      where: { id },
      data,
    });

    return NextResponse.json(item);
  } catch (error) {
    console.error('PUT /api/items error:', error);
    return NextResponse.json(
      { error: 'Failed to update item' },
      { status: 500 },
    );
  }
}

// DELETE /api/items?id=xxx — Delete an item
export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { error: 'Missing id parameter' },
        { status: 400 },
      );
    }

    await db.item.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/items error:', error);
    return NextResponse.json(
      { error: 'Failed to delete item' },
      { status: 500 },
    );
  }
}
