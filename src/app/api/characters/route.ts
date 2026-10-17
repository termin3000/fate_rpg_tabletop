import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { DEFAULT_SETTINGS } from '@/lib/types';
import type { Skill, StressTrack, Consequence } from '@/lib/types';

// JSON fields that need parsing on read
const JSON_FIELDS = [
  'aspects',
  'skills',
  'stunts',
  'stressTracks',
  'consequences',
  'situationalAspects',
  'members',
  'crowdComposition',
  'aspectSources',
] as const;

function parseCharacter(raw: Record<string, unknown>) {
  const result: Record<string, unknown> = { ...raw };
  for (const field of JSON_FIELDS) {
    if (typeof result[field] === 'string') {
      try {
        result[field] = JSON.parse(result[field] as string);
      } catch {
        result[field] = [];
      }
    }
  }
  return result;
}

// Default stress tracks for new characters.
// Both physical and mental tracks default to TWO boxes (classic Fate Accelerated
// style for lighter characters; GMs can extend via the character sheet editor).
function defaultStressTracks(): StressTrack[] {
  return [
    {
      name: 'Физический',
      type: 'progressive',
      icon: '❤️',
      markers: [false, false],
      showInTooltip: true,
    },
    {
      name: 'Ментальный',
      type: 'progressive',
      icon: '🧠',
      markers: [false, false],
      showInTooltip: true,
    },
  ];
}

// Default consequences for new characters
function defaultConsequences(): Consequence[] {
  return [
    { name: 'Лёгкое', value: 2, description: '', healed: false },
    { name: 'Среднее', value: 4, description: '', healed: false },
    { name: 'Тяжёлое', value: 6, description: '', healed: false },
  ];
}

// Default skills from adventure settings
function defaultSkills(): Skill[] {
  return DEFAULT_SETTINGS.baseSkills.map((name) => ({ name, value: 0 }));
}

// GET /api/characters?adventureId=xxx — List characters for an adventure
export async function GET(request: NextRequest) {
  try {
    const adventureId = request.nextUrl.searchParams.get('adventureId');
    if (!adventureId) {
      return NextResponse.json(
        { error: 'Missing adventureId parameter' },
        { status: 400 },
      );
    }

    const characters = await db.character.findMany({
      where: { adventureId },
      orderBy: { createdAt: 'asc' },
    });

    const result = characters.map((c) => parseCharacter(c as unknown as Record<string, unknown>));
    return NextResponse.json(result);
  } catch (error) {
    console.error('GET /api/characters error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch characters' },
      { status: 500 },
    );
  }
}

// POST /api/characters — Create a new character
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

    const skills = body.skills ?? defaultSkills();
    const stressTracks = body.stressTracks ?? defaultStressTracks();
    const consequences = body.consequences ?? defaultConsequences();

    const character = await db.character.create({
      data: {
        name: body.name || 'Новый персонаж',
        type: body.type || 'npc',
        concept: body.concept || '',
        problem: body.problem || '',
        aspects: JSON.stringify(body.aspects ?? []),
        skills: JSON.stringify(skills),
        stunts: JSON.stringify(body.stunts ?? []),
        stressTracks: JSON.stringify(stressTracks),
        consequences: JSON.stringify(consequences),
        situationalAspects: JSON.stringify(body.situationalAspects ?? []),
        fatePoints: body.fatePoints ?? 3,
        refresh: body.refresh ?? 3,
        isActive: body.isActive ?? false,
        hiddenFromPlayers: body.hiddenFromPlayers ?? false,
        folderId: body.folderId ?? null,
        isHorde: body.isHorde ?? false,
        members: JSON.stringify(body.members ?? []),
        crowdEligible: body.crowdEligible ?? false,
        crowdComposition: JSON.stringify(body.crowdComposition ?? {}),
        aspectSources: JSON.stringify(body.aspectSources ?? []),
        temporary: body.temporary ?? false,
        isMage: body.isMage ?? false,
        avatar: body.avatar ?? null,
        avatarColor: body.avatarColor ?? '',
        adventureId,
      },
    });

    return NextResponse.json(parseCharacter(character as unknown as Record<string, unknown>));
  } catch (error) {
    console.error('POST /api/characters error:', error);
    return NextResponse.json(
      { error: 'Failed to create character' },
      { status: 500 },
    );
  }
}

// PUT /api/characters?id=xxx — Update a character
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
    if (body.type !== undefined) data.type = body.type;
    if (body.concept !== undefined) data.concept = body.concept;
    if (body.problem !== undefined) data.problem = body.problem;
    if (body.fatePoints !== undefined) data.fatePoints = body.fatePoints;
    if (body.refresh !== undefined) data.refresh = body.refresh;
    if (body.isActive !== undefined) data.isActive = body.isActive;
    if (body.hiddenFromPlayers !== undefined) data.hiddenFromPlayers = body.hiddenFromPlayers;
    if (body.folderId !== undefined) data.folderId = body.folderId;
    if (body.isHorde !== undefined) data.isHorde = body.isHorde;
    if (body.crowdEligible !== undefined) data.crowdEligible = body.crowdEligible;
    if (body.temporary !== undefined) data.temporary = body.temporary;
    if (body.isMage !== undefined) data.isMage = body.isMage;
    if (body.avatar !== undefined) data.avatar = body.avatar;
    if (body.avatarColor !== undefined) data.avatarColor = body.avatarColor;

    // JSON fields — stringify before saving
    if (body.aspects !== undefined) data.aspects = JSON.stringify(body.aspects);
    if (body.skills !== undefined) data.skills = JSON.stringify(body.skills);
    if (body.stunts !== undefined) data.stunts = JSON.stringify(body.stunts);
    if (body.stressTracks !== undefined) data.stressTracks = JSON.stringify(body.stressTracks);
    if (body.consequences !== undefined) data.consequences = JSON.stringify(body.consequences);
    if (body.situationalAspects !== undefined) data.situationalAspects = JSON.stringify(body.situationalAspects);
    if (body.members !== undefined) data.members = JSON.stringify(body.members);
    if (body.crowdComposition !== undefined) data.crowdComposition = JSON.stringify(body.crowdComposition);
    if (body.aspectSources !== undefined) data.aspectSources = JSON.stringify(body.aspectSources);

    const character = await db.character.update({
      where: { id },
      data,
    });

    return NextResponse.json(parseCharacter(character as unknown as Record<string, unknown>));
  } catch (error) {
    console.error('PUT /api/characters error:', error);
    return NextResponse.json(
      { error: 'Failed to update character' },
      { status: 500 },
    );
  }
}

// DELETE /api/characters?id=xxx — Delete a character
export async function DELETE(request: NextRequest) {
  try {
    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json(
        { error: 'Missing id parameter' },
        { status: 400 },
      );
    }

    await db.character.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/characters error:', error);
    return NextResponse.json(
      { error: 'Failed to delete character' },
      { status: 500 },
    );
  }
}
