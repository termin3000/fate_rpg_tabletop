import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// The Note delegate can be missing in dev hot-reload (singleton caching).
// Detect and fall back to raw SQL — same pattern as /api/notes/route.ts.
function hasNoteDelegate(): boolean {
  return typeof (db as unknown as { note?: unknown }).note !== 'undefined';
}

// Generate a CUID-like id matching Prisma's default format (letter-prefixed,
// ~24 chars, base36). Used so we can pre-build old→new id mappings before
// inserting rows.
function genId(): string {
  const timestamp = Date.now().toString(36).padStart(9, '0');
  const random1 = Math.random().toString(36).substring(2, 10);
  const random2 = Math.random().toString(36).substring(2, 6);
  return `c${timestamp}${random1}${random2}`;
}

// Type alias for the loose imported JSON shape
type AnyObject = Record<string, unknown>;

// POST /api/adventures/import — Import a JSON backup as a NEW adventure.
// All entities receive fresh ids; cross-entity references are remapped.
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // Validate payload shape
    const adventureData = (body?.adventure ?? body) as AnyObject | undefined;
    if (!adventureData || typeof adventureData.name !== 'string') {
      return NextResponse.json(
        { error: 'Invalid import data — missing adventure.name' },
        { status: 400 },
      );
    }

    // ── Name conflict handling ──────────────────────────────────
    const originalName = adventureData.name as string;
    const existing = await db.adventure.findMany({
      where: { name: originalName },
      select: { id: true },
    });
    const newName = existing.length > 0 ? `${originalName} (копия)` : originalName;

    // ── Build new-id maps for every entity ──────────────────────
    const newAdventureId = genId();

    const folderIdMap = new Map<string, string>();
    const characterIdMap = new Map<string, string>();
    const sceneIdMap = new Map<string, string>();

    const folders = Array.isArray(adventureData.folders) ? (adventureData.folders as AnyObject[]) : [];
    const characters = Array.isArray(adventureData.characters) ? (adventureData.characters as AnyObject[]) : [];
    const scenes = Array.isArray(adventureData.scenes) ? (adventureData.scenes as AnyObject[]) : [];
    const logEntries = Array.isArray(adventureData.logEntries) ? (adventureData.logEntries as AnyObject[]) : [];
    const items = Array.isArray(adventureData.items) ? (adventureData.items as AnyObject[]) : [];
    const notes = Array.isArray(adventureData.notes) ? (adventureData.notes as AnyObject[]) : [];

    folders.forEach((f) => {
      const oldId = String(f.id ?? '');
      if (oldId) folderIdMap.set(oldId, genId());
    });
    characters.forEach((c) => {
      const oldId = String(c.id ?? '');
      if (oldId) characterIdMap.set(oldId, genId());
    });
    scenes.forEach((s) => {
      const oldId = String(s.id ?? '');
      if (oldId) sceneIdMap.set(oldId, genId());
    });

    // Helper to remap a single id through a map; returns null for missing ids.
    const remap = (oldId: unknown, map: Map<string, string>): string | null => {
      if (oldId === null || oldId === undefined) return null;
      return map.get(String(oldId)) ?? null;
    };

    // ── Run everything inside a transaction ─────────────────────
    const created = await db.$transaction(async (tx) => {
      // Parse settings — fall back to a minimal valid object if malformed
      let settingsString: string;
      try {
        settingsString = JSON.stringify(adventureData.settings ?? {
          baseSkills: [],
          initiative: { physical: {}, mental: {} },
          modules: { magic: false },
        });
      } catch {
        settingsString = JSON.stringify({
          baseSkills: [],
          initiative: { physical: {}, mental: {} },
          modules: { magic: false },
        });
      }

      // Remap currentSceneId — if the original scene isn't in the export,
      // leave it null (will be auto-picked by client).
      const newCurrentSceneId = remap(adventureData.currentSceneId, sceneIdMap);

      // 1. Adventure
      await tx.adventure.create({
        data: {
          id: newAdventureId,
          name: newName,
          currentSceneId: newCurrentSceneId,
          settings: settingsString,
        },
      });

      // 2. Folders
      for (const f of folders) {
        const oldId = String(f.id ?? '');
        await tx.folder.create({
          data: {
            id: folderIdMap.get(oldId) ?? genId(),
            name: String(f.name ?? 'Папка'),
            adventureId: newAdventureId,
          },
        });
      }

      // 3. Characters (re-map folderId)
      for (const c of characters) {
        const oldId = String(c.id ?? '');
        const newCharId = characterIdMap.get(oldId) ?? genId();
        const newFolderId = remap(c.folderId, folderIdMap);

        await tx.character.create({
          data: {
            id: newCharId,
            name: String(c.name ?? 'Новый персонаж'),
            type: String(c.type ?? 'npc'),
            concept: String(c.concept ?? ''),
            problem: String(c.problem ?? ''),
            aspects: JSON.stringify(c.aspects ?? []),
            skills: JSON.stringify(c.skills ?? []),
            stunts: JSON.stringify(c.stunts ?? []),
            stressTracks: JSON.stringify(c.stressTracks ?? []),
            consequences: JSON.stringify(c.consequences ?? []),
            situationalAspects: JSON.stringify(c.situationalAspects ?? []),
            fatePoints: Number(c.fatePoints ?? 3),
            refresh: Number(c.refresh ?? 3),
            isActive: Boolean(c.isActive ?? false),
            hiddenFromPlayers: Boolean(c.hiddenFromPlayers ?? false),
            folderId: newFolderId,
            isHorde: Boolean(c.isHorde ?? false),
            members: JSON.stringify(c.members ?? []),
            crowdEligible: Boolean(c.crowdEligible ?? false),
            crowdComposition: JSON.stringify(c.crowdComposition ?? {}),
            aspectSources: JSON.stringify(c.aspectSources ?? []),
            temporary: Boolean(c.temporary ?? false),
            adventureId: newAdventureId,
          },
        });
      }

      // 4. Scenes (re-map floors.tokens.charId, presentCharacters,
      //    conflictData.participants.characterId, conflictData.eliminatedIds)
      for (const s of scenes) {
        const oldId = String(s.id ?? '');
        const newSceneId = sceneIdMap.get(oldId) ?? genId();

        // Remap token charIds inside floors
        const floors = Array.isArray(s.floors) ? (s.floors as AnyObject[]) : [];
        const newFloors = floors.map((floor) => {
          const tokens = Array.isArray(floor.tokens) ? (floor.tokens as AnyObject[]) : [];
          return {
            ...floor,
            tokens: tokens
              .map((t) => {
                const mapped = remap(t.charId, characterIdMap);
                return mapped ? { ...t, charId: mapped } : null;
              })
              .filter((t): t is AnyObject & { charId: string } => t !== null),
          };
        });

        // Remap presentCharacters
        const present = Array.isArray(s.presentCharacters) ? (s.presentCharacters as string[]) : [];
        const newPresent = present
          .map((cid) => remap(cid, characterIdMap))
          .filter((cid): cid is string => cid !== null);

        // Remap conflictData
        let newConflictData: string | null = null;
        if (s.conflictData && typeof s.conflictData === 'object') {
          const cd = s.conflictData as AnyObject;
          const participants = Array.isArray(cd.participants) ? (cd.participants as AnyObject[]) : [];
          const eliminated = Array.isArray(cd.eliminatedIds) ? (cd.eliminatedIds as string[]) : [];

          const remappedConflict = {
            ...cd,
            participants: participants
              .map((p) => {
                const mapped = remap(p.characterId, characterIdMap);
                return mapped ? { ...p, characterId: mapped } : null;
              })
              .filter((p): p is AnyObject & { characterId: string } => p !== null),
            eliminatedIds: eliminated
              .map((cid) => remap(cid, characterIdMap))
              .filter((cid): cid is string => cid !== null),
          };
          newConflictData = JSON.stringify(remappedConflict);
        }

        // Scene items are embedded JSON (not the Item model); they have their
        // own internal ids that we can leave alone.
        const sceneItems = Array.isArray(s.items) ? (s.items as unknown[]) : [];

        await tx.scene.create({
          data: {
            id: newSceneId,
            name: String(s.name ?? 'Новая сцена'),
            adventureId: newAdventureId,
            currentFloorIndex: Number(s.currentFloorIndex ?? 0),
            playerFloorIndex: Number(s.playerFloorIndex ?? 0),
            floors: JSON.stringify(newFloors),
            presentCharacters: JSON.stringify(newPresent),
            conflictData: newConflictData,
            items: JSON.stringify(sceneItems),
          },
        });
      }

      // 5. Log entries (re-map characterId)
      for (const e of logEntries) {
        const newCharId = remap(e.characterId, characterIdMap);
        await tx.logEntry.create({
          data: {
            adventureId: newAdventureId,
            characterId: newCharId,
            characterName: String(e.characterName ?? ''),
            skillName: String(e.skillName ?? ''),
            diceResults: JSON.stringify(e.diceResults ?? []),
            bonus: Number(e.bonus ?? 0),
            total: Number(e.total ?? 0),
            opponentTotal: e.opponentTotal === null || e.opponentTotal === undefined ? null : Number(e.opponentTotal),
            difficulty: e.difficulty === null || e.difficulty === undefined ? null : Number(e.difficulty),
            result: String(e.result ?? ''),
            opponentType: e.opponentType === null || e.opponentType === undefined ? null : String(e.opponentType),
            opponentCharacterId: e.opponentCharacterId === null || e.opponentCharacterId === undefined ? null : String(e.opponentCharacterId),
            opponentName: e.opponentName === null || e.opponentName === undefined ? null : String(e.opponentName),
            opponentSkillName: e.opponentSkillName === null || e.opponentSkillName === undefined ? null : String(e.opponentSkillName),
            opponentDiceResults: JSON.stringify(e.opponentDiceResults ?? []),
            opponentBonus: Number(e.opponentBonus ?? 0),
            extraBonus: Number(e.extraBonus ?? 0),
            extraBonusReason: String(e.extraBonusReason ?? ''),
            rerolled: Boolean(e.rerolled ?? false),
            customText: e.customText === null || e.customText === undefined ? null : String(e.customText),
            isRiftEvent: Boolean(e.isRiftEvent ?? false),
            // ── Rich-tooltip fields (preserve on import) ──
            skillValue: e.skillValue === null || e.skillValue === undefined ? null : Number(e.skillValue),
            manualBonus: Number(e.manualBonus ?? 0),
            helpers: JSON.stringify(e.helpers ?? []),
            aspectInvokeBonus: Number(e.aspectInvokeBonus ?? 0),
            aspectInvokeReason: String(e.aspectInvokeReason ?? ''),
            aspectRerolled: Boolean(e.aspectRerolled ?? false),
            opponentSkillValue: e.opponentSkillValue === null || e.opponentSkillValue === undefined ? null : Number(e.opponentSkillValue),
            opponentManualBonus: Number(e.opponentManualBonus ?? 0),
            opponentHelpers: JSON.stringify(e.opponentHelpers ?? []),
          },
        });
      }

      // 6. Items (re-map sceneId)
      for (const i of items) {
        const newSceneId = remap(i.sceneId, sceneIdMap);
        await tx.item.create({
          data: {
            name: String(i.name ?? 'Новый предмет'),
            type: String(i.type ?? 'item'),
            description: String(i.description ?? ''),
            text: i.text === null || i.text === undefined ? null : String(i.text),
            adventureId: newAdventureId,
            sceneId: newSceneId,
          },
        });
      }

      // 7. Notes — uses raw SQL fallback when the Note delegate is missing
      //    (dev hot-reload caching issue; see /api/notes/route.ts).
      const noteDelegate = hasNoteDelegate()
        ? (tx as unknown as { note: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } }).note
        : null;

      for (const n of notes) {
        const title = String(n.title ?? 'Новая заметка');
        const content = String(n.content ?? '');
        const category = String(n.category ?? 'session');
        const pinned = Boolean(n.pinned ?? false);
        const color = String(n.color ?? 'default');

        if (noteDelegate) {
          await noteDelegate.create({
            data: {
              title,
              content,
              category,
              pinned,
              color,
              adventureId: newAdventureId,
            },
          });
        } else {
          // Raw SQL fallback — pinned is stored as 0/1 in SQLite
          const noteId = genId();
          await tx.$executeRaw`
            INSERT INTO Note (id, title, content, category, pinned, color, adventureId, createdAt, updatedAt)
            VALUES (${noteId}, ${title}, ${content}, ${category}, ${pinned ? 1 : 0}, ${color}, ${newAdventureId},
                    datetime('now'), datetime('now'))
          `;
        }
      }

      // Re-fetch the created adventure to return
      return tx.adventure.findUnique({ where: { id: newAdventureId } });
    });

    if (!created) {
      return NextResponse.json(
        { error: 'Failed to create imported adventure' },
        { status: 500 },
      );
    }

    return NextResponse.json({
      id: created.id,
      name: created.name,
      currentSceneId: created.currentSceneId,
      settings: JSON.parse(created.settings),
      characterCount: 0,
      sceneCount: 0,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    });
  } catch (error) {
    console.error('POST /api/adventures/import error:', error);
    return NextResponse.json(
      { error: 'Failed to import adventure' },
      { status: 500 },
    );
  }
}
