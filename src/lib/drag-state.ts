// Lightweight module-level drag state for cross-component drag-and-drop.
// The HTML5 drag API does not expose dataTransfer.getData() during dragover
// (only types), so we stash the dragged character id here on dragStart.
// GameCanvas reads it while rendering the live preview token on the map.

export interface CharDragPayload {
  charId: string;
  charName: string;
  avatar?: string | null;
  avatarColor?: string | null;
  type: 'player' | 'npc';
}

export const charDragState: { current: CharDragPayload | null } = {
  current: null,
};

export function setCharDrag(payload: CharDragPayload | null): void {
  charDragState.current = payload;
}
