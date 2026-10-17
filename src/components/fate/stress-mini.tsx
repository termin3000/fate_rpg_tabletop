'use client';

import { useState } from 'react';
import { Heart } from 'lucide-react';

import { useFateStore } from '@/lib/store';
import type { Character, StressTrack } from '@/lib/types';

interface StressMiniProps {
  character: Character;
  compact?: boolean;
}

/**
 * Compact, clickable stress-track indicators for a character.
 * Each track is rendered as a row of numbered boxes; clicking a box toggles it.
 * In compact mode, tracks render inline (one row).
 * In expanded mode, track names are shown.
 */
export function StressMini({ character, compact = true }: StressMiniProps) {
  const { updateCharacter } = useFateStore();
  const [hovered, setHovered] = useState(false);

  const tracks: StressTrack[] = character.stressTracks ?? [];
  if (tracks.length === 0) return null;

  const toggleBox = (trackIdx: number, boxIdx: number) => {
    const updatedTracks = tracks.map((t, ti) => {
      if (ti !== trackIdx) return t;
      const newMarkers = [...t.markers];
      newMarkers[boxIdx] = !newMarkers[boxIdx];
      return { ...t, markers: newMarkers };
    });
    updateCharacter(character.id, { stressTracks: updatedTracks });
  };

  // Count marked stress
  const totalMarked = tracks.reduce(
    (sum, t) => sum + (t.markers?.filter(Boolean).length ?? 0),
    0,
  );
  const totalBoxes = tracks.reduce((sum, t) => sum + (t.markers?.length ?? 0), 0);

  if (compact) {
    return (
      <div
        className="flex items-center gap-1.5 mt-0.5"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {tracks.map((track, ti) => (
          <div key={ti} className="flex items-center gap-0.5" title={track.name}>
            <span className="text-[10px]" style={{ opacity: 0.7 }}>
              {track.icon || '■'}
            </span>
            <div className="flex items-center gap-0.5">
              {track.markers.map((marked, bi) => (
                <button
                  key={bi}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleBox(ti, bi);
                  }}
                  className="transition-all duration-150 hover:scale-125"
                  title={`${track.name} ${track.type === 'progressive' ? bi + 1 : 1}${marked ? ' (отмечено)' : ''}`}
                  aria-label={`${track.name} ${track.type === 'progressive' ? bi + 1 : 1}${marked ? ' (отмечено)' : ''}`}
                  aria-pressed={marked}
                >
                  <span
                    className="fate-stress-box block rounded-sm transition-colors duration-150 flex items-center justify-center"
                    style={{
                      width: 14,
                      height: 14,
                      backgroundColor: marked
                        ? 'var(--fate-danger)'
                        : 'transparent',
                      border: `1.5px solid ${
                        marked ? 'var(--fate-danger)' : 'var(--fate-text-muted)'
                      }`,
                      opacity: marked ? 1 : hovered ? 0.7 : 0.4,
                      fontSize: 8,
                      fontWeight: marked ? 800 : 600,
                      color: marked ? 'white' : 'var(--fate-text-muted)',
                      lineHeight: '14px',
                    }}
                  >
                    {track.type === 'progressive' ? bi + 1 : 1}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}
        {totalMarked > 0 && (
          <span
            className="text-[9px] font-bold ml-1 px-1 rounded"
            style={{
              backgroundColor: 'rgba(231, 76, 60, 0.15)',
              color: 'var(--fate-danger)',
            }}
          >
            {totalMarked}/{totalBoxes}
          </span>
        )}
      </div>
    );
  }

  // Expanded mode — show track names
  return (
    <div className="space-y-1.5 mt-1">
      {tracks.map((track, ti) => (
        <div key={ti} className="flex items-center gap-2">
          <span
            className="text-[10px] font-medium min-w-[70px] flex items-center gap-1"
            style={{ color: 'var(--fate-text-muted)' }}
          >
            <span>{track.icon}</span>
            {track.name}
          </span>
          <div className="flex items-center gap-1">
            {track.markers.map((marked, bi) => (
              <button
                key={bi}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleBox(ti, bi);
                }}
                className="transition-all duration-150 hover:scale-125"
                title={`${track.name} ${track.type === 'progressive' ? bi + 1 : 1}${marked ? ' (отмечено)' : ''}`}
                aria-label={`${track.name} ${track.type === 'progressive' ? bi + 1 : 1}${marked ? ' (отмечено)' : ''}`}
                aria-pressed={marked}
              >
                <span
                  className="fate-stress-box block rounded-md transition-colors duration-150 flex items-center justify-center"
                  style={{
                    width: 20,
                    height: 20,
                    backgroundColor: marked ? 'var(--fate-danger)' : 'transparent',
                    border: `1.5px solid ${
                      marked ? 'var(--fate-danger)' : 'var(--fate-text-muted)'
                    }`,
                    opacity: marked ? 1 : 0.5,
                    fontSize: 10,
                    fontWeight: marked ? 800 : 600,
                    color: marked ? 'white' : 'var(--fate-text-muted)',
                    lineHeight: '20px',
                  }}
                >
                  {track.type === 'progressive' ? bi + 1 : 1}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
