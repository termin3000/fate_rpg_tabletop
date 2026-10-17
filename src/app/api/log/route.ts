import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// JSON fields that need parsing on read
const JSON_FIELDS = ['diceResults', 'opponentDiceResults', 'helpers', 'opponentHelpers', 'groupRollResults'] as const;

function parseLogEntry(raw: Record<string, unknown>) {
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

// GET /api/log?adventureId=xxx — List log entries for an adventure
export async function GET(request: NextRequest) {
  try {
    const adventureId = request.nextUrl.searchParams.get('adventureId');
    if (!adventureId) {
      return NextResponse.json(
        { error: 'Missing adventureId parameter' },
        { status: 400 },
      );
    }

    const entries = await db.logEntry.findMany({
      where: { adventureId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const result = entries.map((e) => parseLogEntry(e as unknown as Record<string, unknown>));
    return NextResponse.json(result);
  } catch (error) {
    console.error('GET /api/log error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch log entries' },
      { status: 500 },
    );
  }
}

// POST /api/log — Add a log entry
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

    // Validate adventure exists
    const adventure = await db.adventure.findUnique({ where: { id: adventureId } });
    if (!adventure) {
      return NextResponse.json(
        { error: 'Adventure not found' },
        { status: 404 },
      );
    }

    const entry = await db.logEntry.create({
      data: {
        adventureId,
        characterId: body.characterId ?? null,
        characterName: body.characterName ?? '',
        skillName: body.skillName ?? '',
        diceResults: JSON.stringify(body.diceResults ?? []),
        bonus: body.bonus ?? 0,
        total: body.total ?? 0,
        opponentTotal: body.opponentTotal ?? null,
        difficulty: body.difficulty ?? null,
        result: body.result ?? '',
        opponentType: body.opponentType ?? null,
        opponentCharacterId: body.opponentCharacterId ?? null,
        opponentName: body.opponentName ?? null,
        opponentSkillName: body.opponentSkillName ?? null,
        opponentDiceResults: JSON.stringify(body.opponentDiceResults ?? []),
        opponentBonus: body.opponentBonus ?? 0,
        extraBonus: body.extraBonus ?? 0,
        extraBonusReason: body.extraBonusReason ?? '',
        rerolled: body.rerolled ?? false,
        customText: body.customText ?? null,
        isRiftEvent: body.isRiftEvent ?? false,
        // ── New rich-tooltip fields ──
        skillValue: body.skillValue ?? null,
        manualBonus: body.manualBonus ?? 0,
        helpers: JSON.stringify(body.helpers ?? []),
        aspectInvokeBonus: body.aspectInvokeBonus ?? 0,
        aspectInvokeReason: body.aspectInvokeReason ?? '',
        aspectRerolled: body.aspectRerolled ?? false,
        // ── Opponent rich-tooltip fields ──
        opponentSkillValue: body.opponentSkillValue ?? null,
        opponentManualBonus: body.opponentManualBonus ?? 0,
        opponentHelpers: JSON.stringify(body.opponentHelpers ?? []),
        // ── Magic module fields ──
        isMagicRoll: body.isMagicRoll ?? false,
        magicCastType: body.magicCastType ?? null,
        magicCardName: body.magicCardName ?? null,
        magicEffect: body.magicEffect ?? null,
        magicZoneStress: body.magicZoneStress ?? null,
        magicZoneName: body.magicZoneName ?? null,
        magicZoneLevelAfter: body.magicZoneLevelAfter ?? null,
        // ── Group roll (P2P) ──
        groupRollResults: JSON.stringify(body.groupRollResults ?? []),
      },
    });

    return NextResponse.json(parseLogEntry(entry as unknown as Record<string, unknown>));
  } catch (error) {
    console.error('POST /api/log error:', error);
    return NextResponse.json(
      { error: 'Failed to create log entry' },
      { status: 500 },
    );
  }
}

// DELETE /api/log?adventureId=xxx — Clear all log entries for an adventure
export async function DELETE(request: NextRequest) {
  try {
    const adventureId = request.nextUrl.searchParams.get('adventureId');
    if (!adventureId) {
      return NextResponse.json(
        { error: 'Missing adventureId parameter' },
        { status: 400 },
      );
    }

    await db.logEntry.deleteMany({ where: { adventureId } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('DELETE /api/log error:', error);
    return NextResponse.json(
      { error: 'Failed to clear log entries' },
      { status: 500 },
    );
  }
}

// PATCH /api/log — Update a log entry (for rerolls and bonuses)
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json(
        { error: 'Missing log entry id' },
        { status: 400 },
      );
    }

    // Build update data from provided fields
    const data: Record<string, unknown> = {};
    const updatableFields = [
      'diceResults', 'bonus', 'total', 'opponentTotal', 'difficulty',
      'result', 'opponentType', 'opponentCharacterId', 'opponentName', 'opponentSkillName',
      'opponentDiceResults', 'opponentBonus', 'extraBonus',
      'extraBonusReason', 'rerolled', 'customText', 'isRiftEvent',
      'skillValue', 'manualBonus', 'helpers',
      'aspectInvokeBonus', 'aspectInvokeReason', 'aspectRerolled',
      'opponentSkillValue', 'opponentManualBonus', 'opponentHelpers',
      // ── Magic module fields ──
      'isMagicRoll', 'magicCastType', 'magicCardName', 'magicEffect',
      'magicZoneStress', 'magicZoneName', 'magicZoneLevelAfter',
      // ── Group roll (P2P) ──
      'groupRollResults',
    ];

    for (const field of updatableFields) {
      if (body[field] !== undefined) {
        if (field === 'diceResults' || field === 'opponentDiceResults' || field === 'helpers' || field === 'opponentHelpers' || field === 'groupRollResults') {
          data[field] = JSON.stringify(body[field]);
        } else {
          data[field] = body[field];
        }
      }
    }

    const entry = await db.logEntry.update({
      where: { id },
      data,
    });

    return NextResponse.json(parseLogEntry(entry as unknown as Record<string, unknown>));
  } catch (error) {
    console.error('PATCH /api/log error:', error);
    return NextResponse.json(
      { error: 'Failed to update log entry' },
      { status: 500 },
    );
  }
}
