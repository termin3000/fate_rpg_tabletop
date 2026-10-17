import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';

// ── Helpers ──────────────────────────────────────────────────
// The Note delegate can be missing in dev hot-reload (singleton caching).
function hasNoteDelegate(): boolean {
  return typeof (db as unknown as { note?: unknown }).note !== 'undefined';
}

function genId(): string {
  const timestamp = Date.now().toString(36).padStart(9, '0');
  const random1 = Math.random().toString(36).substring(2, 10);
  const random2 = Math.random().toString(36).substring(2, 6);
  return `c${timestamp}${random1}${random2}`;
}

type AnyObject = Record<string, unknown>;

// POST /api/adventures/transfer
// Body: {
//   sourceAdventureId: string,
//   targetAdventureId: string,
//   transfer: {
//     characters?: boolean, scenes?: boolean, items?: boolean,
//     folders?: boolean, notes?: boolean,
//     settings?: boolean,  // baseSkills + initiative
//     modules?: boolean,   // modules.{magic} toggle + magicTable
//   }
// }
// Copies (not moves) the selected entity types from source → target.
// All entities receive fresh ids; cross-entity references are remapped.
// playerRoster is NEVER copied (it references source-only character ids).
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const sourceAdventureId = body?.sourceAdventureId as string | undefined;
    const targetAdventureId = body?.targetAdventureId as string | undefined;
    const transfer = (body?.transfer ?? {}) as {
      characters?: boolean;
      scenes?: boolean;
      items?: boolean;
      folders?: boolean;
      notes?: boolean;
      settings?: boolean;
      modules?: boolean;
    };

    if (!sourceAdventureId || !targetAdventureId) {
      return NextResponse.json(
        { error: 'sourceAdventureId and targetAdventureId are required' },
        { status: 400 },
      );
    }
    if (sourceAdventureId === targetAdventureId) {
      return NextResponse.json(
        { error: 'Source and target adventures must be different' },
        { status: 400 },
      );
    }

    const source = await db.adventure.findUnique({ where: { id: sourceAdventureId } });
    const target = await db.adventure.findUnique({ where: { id: targetAdventureId } });
    if (!source) {
      return NextResponse.json({ error: 'Source adventure not found' }, { status: 404 });
    }
    if (!target) {
      return NextResponse.json({ error: 'Target adventure not found' }, { status: 404 });
    }

    // ── Load source entities (only what we're transferring) ──
    const [sourceFolders, sourceCharacters, sourceScenes, sourceItems, sourceNotes] =
      await Promise.all([
        transfer.folders ? db.folder.findMany({ where: { adventureId: sourceAdventureId } }) : [],
        transfer.characters ? db.character.findMany({ where: { adventureId: sourceAdventureId } }) : [],
        transfer.scenes ? db.scene.findMany({ where: { adventureId: sourceAdventureId } }) : [],
        transfer.items ? db.item.findMany({ where: { adventureId: sourceAdventureId } }) : [],
        transfer.notes
          ? hasNoteDelegate()
            ? db.note.findMany({ where: { adventureId: sourceAdventureId } })
            : db.$queryRaw`SELECT id, title, content, category, pinned, color, adventureId, createdAt, updatedAt FROM Note WHERE adventureId = ${sourceAdventureId}`
          : [],
      ]);

    // Normalize notes (raw SQL returns BigInt for ints)
    const notesNormalized: AnyObject[] = (sourceNotes as unknown[]).map((n) => {
      const row = n as Record<string, unknown>;
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
    });

    // ── Build id maps ──
    const folderIdMap = new Map<string, string>();
    const characterIdMap = new Map<string, string>();
    const sceneIdMap = new Map<string, string>();

    (sourceFolders as unknown as AnyObject[]).forEach((f) => {
      const oldId = String(f.id ?? '');
      if (oldId) folderIdMap.set(oldId, genId());
    });
    (sourceCharacters as unknown as AnyObject[]).forEach((c) => {
      const oldId = String(c.id ?? '');
      if (oldId) characterIdMap.set(oldId, genId());
    });
    (sourceScenes as unknown as AnyObject[]).forEach((s) => {
      const oldId = String(s.id ?? '');
      if (oldId) sceneIdMap.set(oldId, genId());
    });

    const remap = (oldId: unknown, map: Map<string, string>): string | null => {
      if (oldId === null || oldId === undefined) return null;
      return map.get(String(oldId)) ?? null;
    };

    // ── Run everything inside a transaction ──
    const counts = { characters: 0, scenes: 0, items: 0, folders: 0, notes: 0, settings: false, modules: false };

    await db.$transaction(async (tx) => {
      // 1a. Settings + Modules — both modify the target's settings JSON.
      //   • settings: copies baseSkills + initiative (the "configuration")
      //   • modules:  copies modules.{magic} toggle + magicModuleEnabled + magicTable
      //   • playerRoster is NEVER copied — it references source character ids
      //     that don't exist in the target.
      if (transfer.settings || transfer.modules) {
        let sourceSettings: Record<string, unknown> = {};
        try {
          sourceSettings = JSON.parse(source.settings) as Record<string, unknown>;
        } catch {
          sourceSettings = {};
        }
        let targetSettings: Record<string, unknown> = {};
        try {
          targetSettings = JSON.parse(target.settings) as Record<string, unknown>;
        } catch {
          targetSettings = {};
        }
        const merged: Record<string, unknown> = { ...targetSettings };
        if (transfer.settings) {
          if (sourceSettings.baseSkills) merged.baseSkills = sourceSettings.baseSkills;
          if (sourceSettings.initiative) merged.initiative = sourceSettings.initiative;
          counts.settings = true;
        }
        if (transfer.modules) {
          if (sourceSettings.modules) merged.modules = sourceSettings.modules;
          if (sourceSettings.magicModuleEnabled !== undefined) {
            merged.magicModuleEnabled = sourceSettings.magicModuleEnabled;
          }
          if (sourceSettings.magicTable) merged.magicTable = sourceSettings.magicTable;
          counts.modules = true;
        }
        // Preserve target's playerRoster (adventure-specific character ids)
        if (targetSettings.playerRoster) {
          merged.playerRoster = targetSettings.playerRoster;
        }
        await tx.adventure.update({
          where: { id: targetAdventureId },
          data: { settings: JSON.stringify(merged) },
        });
      }

      // 2. Folders
      if (transfer.folders) {
        for (const f of sourceFolders as unknown as AnyObject[]) {
          const oldId = String(f.id ?? '');
          await tx.folder.create({
            data: {
              id: folderIdMap.get(oldId) ?? genId(),
              name: String(f.name ?? 'Папка'),
              adventureId: targetAdventureId,
            },
          });
          counts.folders++;
        }
      }

      // 3. Characters (re-map folderId)
      if (transfer.characters) {
        for (const c of sourceCharacters as unknown as AnyObject[]) {
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
              aspects: String(c.aspects ?? '[]'),
              skills: String(c.skills ?? '[]'),
              stunts: String(c.stunts ?? '[]'),
              stressTracks: String(c.stressTracks ?? '[]'),
              consequences: String(c.consequences ?? '[]'),
              situationalAspects: String(c.situationalAspects ?? '[]'),
              fatePoints: Number(c.fatePoints ?? 3),
              refresh: Number(c.refresh ?? 3),
              isActive: Boolean(c.isActive ?? false),
              hiddenFromPlayers: Boolean(c.hiddenFromPlayers ?? false),
              folderId: newFolderId,
              isHorde: Boolean(c.isHorde ?? false),
              members: String(c.members ?? '[]'),
              crowdEligible: Boolean(c.crowdEligible ?? false),
              crowdComposition: String(c.crowdComposition ?? '{}'),
              aspectSources: String(c.aspectSources ?? '[]'),
              temporary: Boolean(c.temporary ?? false),
              avatar: c.avatar === null || c.avatar === undefined ? null : String(c.avatar),
              avatarColor: String(c.avatarColor ?? ''),
              adventureId: targetAdventureId,
            },
          });
          counts.characters++;
        }
      }

      // 4. Scenes (re-map floors.tokens.charId, presentCharacters, conflictData)
      if (transfer.scenes) {
        for (const s of sourceScenes as unknown as AnyObject[]) {
          const oldId = String(s.id ?? '');
          const newSceneId = sceneIdMap.get(oldId) ?? genId();

          // Remap token charIds inside floors
          let floors: unknown[] = [];
          try {
            floors = typeof s.floors === 'string' ? JSON.parse(s.floors as string) : (s.floors as unknown[]) ?? [];
          } catch {
            floors = [];
          }
          const newFloors = (floors as AnyObject[]).map((floor) => {
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
          let present: string[] = [];
          try {
            const raw = typeof s.presentCharacters === 'string' ? JSON.parse(s.presentCharacters as string) : s.presentCharacters;
            present = Array.isArray(raw) ? (raw as string[]) : [];
          } catch {
            present = [];
          }
          const newPresent = present
            .map((cid) => remap(cid, characterIdMap))
            .filter((cid): cid is string => cid !== null);

          // Remap conflictData
          let newConflictData: string | null = null;
          if (s.conflictData && typeof s.conflictData === 'string') {
            try {
              const cd = JSON.parse(s.conflictData as string) as AnyObject;
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
            } catch {
              newConflictData = null;
            }
          }

          // Scene items are embedded JSON — keep as-is
          let sceneItems: unknown[] = [];
          try {
            const raw = typeof s.items === 'string' ? JSON.parse(s.items as string) : s.items;
            sceneItems = Array.isArray(raw) ? raw : [];
          } catch {
            sceneItems = [];
          }

          await tx.scene.create({
            data: {
              id: newSceneId,
              name: String(s.name ?? 'Новая сцена'),
              adventureId: targetAdventureId,
              currentFloorIndex: Number(s.currentFloorIndex ?? 0),
              playerFloorIndex: Number(s.playerFloorIndex ?? 0),
              floors: JSON.stringify(newFloors),
              presentCharacters: JSON.stringify(newPresent),
              conflictData: newConflictData,
              items: JSON.stringify(sceneItems),
            },
          });
          counts.scenes++;
        }
      }

      // 5. Items (re-map sceneId)
      if (transfer.items) {
        for (const i of sourceItems as unknown as AnyObject[]) {
          const newSceneId = remap(i.sceneId, sceneIdMap);
          await tx.item.create({
            data: {
              name: String(i.name ?? 'Новый предмет'),
              type: String(i.type ?? 'item'),
              description: String(i.description ?? ''),
              text: i.text === null || i.text === undefined ? null : String(i.text),
              adventureId: targetAdventureId,
              sceneId: newSceneId,
            },
          });
          counts.items++;
        }
      }

      // 6. Notes
      if (transfer.notes) {
        const noteDelegate = hasNoteDelegate()
          ? (tx as unknown as { note: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> } }).note
          : null;

        for (const n of notesNormalized) {
          const title = String(n.title ?? 'Новая заметка');
          const content = String(n.content ?? '');
          const category = String(n.category ?? 'session');
          const pinned = Boolean(n.pinned ?? false);
          const color = String(n.color ?? 'default');

          if (noteDelegate) {
            await noteDelegate.create({
              data: { title, content, category, pinned, color, adventureId: targetAdventureId },
            });
          } else {
            const noteId = genId();
            await tx.$executeRaw`
              INSERT INTO Note (id, title, content, category, pinned, color, adventureId, createdAt, updatedAt)
              VALUES (${noteId}, ${title}, ${content}, ${category}, ${pinned ? 1 : 0}, ${color}, ${targetAdventureId},
                      datetime('now'), datetime('now'))
            `;
          }
          counts.notes++;
        }
      }
    });

    return NextResponse.json({ success: true, counts });
  } catch (error) {
    console.error('POST /api/adventures/transfer error:', error);
    return NextResponse.json(
      { error: 'Failed to transfer adventure data' },
      { status: 500 },
    );
  }
}
