import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// GET /api/folders?adventureId=xxx — List folders for an adventure
export async function GET(request: NextRequest) {
  try {
    const adventureId = request.nextUrl.searchParams.get('adventureId');
    if (!adventureId) {
      return NextResponse.json(
        { error: 'Missing adventureId parameter' },
        { status: 400 },
      );
    }

    const folders = await db.folder.findMany({
      where: { adventureId },
      orderBy: { createdAt: 'asc' },
    });

    return NextResponse.json(folders);
  } catch (error) {
    console.error('GET /api/folders error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch folders' },
      { status: 500 },
    );
  }
}

// POST /api/folders — Create a new folder
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

    const folder = await db.folder.create({
      data: {
        name: body.name || 'Новая папка',
        adventureId,
      },
    });

    return NextResponse.json(folder);
  } catch (error) {
    console.error('POST /api/folders error:', error);
    return NextResponse.json(
      { error: 'Failed to create folder' },
      { status: 500 },
    );
  }
}

// PUT /api/folders?id=xxx — Update a folder
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

    const folder = await db.folder.update({
      where: { id },
      data,
    });

    return NextResponse.json(folder);
  } catch (error) {
    console.error('PUT /api/folders error:', error);
    return NextResponse.json(
      { error: 'Failed to update folder' },
      { status: 500 },
    );
  }
}

// DELETE /api/folders?id=xxx — Delete a folder
export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { error: 'Missing id parameter' },
        { status: 400 },
      );
    }

    // Clear folderId on all characters in this folder
    await db.character.updateMany({
      where: { folderId: id },
      data: { folderId: null },
    });

    await db.folder.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/folders error:', error);
    return NextResponse.json(
      { error: 'Failed to delete folder' },
      { status: 500 },
    );
  }
}
