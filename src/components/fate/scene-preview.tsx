'use client';

import { useEffect, useRef } from 'react';

import type { Scene, Token } from '@/lib/types';
import { useFateStore } from '@/lib/store';

interface ScenePreviewProps {
  scene: Scene;
  width?: number;
  height?: number;
  isActive?: boolean;
}

/**
 * Miniature, non-interactive preview of a scene.
 * Renders all tokens (across all floors) and zones as colored dots/rects
 * inside a small canvas. Useful as a thumbnail in scene lists.
 */
export function ScenePreview({
  scene,
  width = 96,
  height = 72,
  isActive = false,
}: ScenePreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const getCharacter = useFateStore((s) => s.getCharacter);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // High-DPI scaling
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // ── Background ────────────────────────────────────────────
    const isDark = document.documentElement.classList.contains('dark');
    const bg = isDark ? '#1a1a1a' : '#f5f5f5';
    const grid = isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    // ── Gather all tokens and zones across all floors ────────
    const allTokens: Array<Token & { floorColor?: string }> = [];
    const allZones: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
      color: string;
      vertices?: { x: number; y: number }[];
    }> = [];

    scene.floors.forEach((floor) => {
      floor.tokens.forEach((t) => allTokens.push(t));
      floor.zones.forEach((z) => allZones.push(z));
    });

    // ── Compute bounding box of tokens + zones ───────────────
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    allTokens.forEach((t) => {
      minX = Math.min(minX, t.x);
      minY = Math.min(minY, t.y);
      maxX = Math.max(maxX, t.x);
      maxY = Math.max(maxY, t.y);
    });
    allZones.forEach((z) => {
      if (z.vertices && z.vertices.length > 0) {
        z.vertices.forEach((v) => {
          minX = Math.min(minX, v.x);
          minY = Math.min(minY, v.y);
          maxX = Math.max(maxX, v.x);
          maxY = Math.max(maxY, v.y);
        });
      } else {
        minX = Math.min(minX, z.x);
        minY = Math.min(minY, z.y);
        maxX = Math.max(maxX, z.x + z.width);
        maxY = Math.max(maxY, z.y + z.height);
      }
    });

    // Default bounds if scene is empty
    if (!isFinite(minX) || !isFinite(minY)) {
      minX = 0;
      minY = 0;
      maxX = 400;
      maxY = 300;
    }
    // Pad bounds
    const padFactor = 0.1;
    const bw = maxX - minX || 400;
    const bh = maxY - minY || 300;
    minX -= bw * padFactor;
    maxX += bw * padFactor;
    minY -= bh * padFactor;
    maxY += bh * padFactor;

    // ── Compute scale to fit ─────────────────────────────────
    const totalW = maxX - minX;
    const totalH = maxY - minY;
    const scale = Math.min(width / totalW, height / totalH);

    const toCanvasX = (x: number) => (x - minX) * scale;
    const toCanvasY = (y: number) => (y - minY) * scale;

    // ── Draw grid (sparse dots) ───────────────────────────────
    ctx.fillStyle = grid;
    const gridSpacing = 40 * scale;
    if (gridSpacing > 4) {
      for (let x = 0; x < width; x += gridSpacing) {
        for (let y = 0; y < height; y += gridSpacing) {
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }

    // ── Draw zones (filled translucent rects/polygons) ──────
    allZones.forEach((z) => {
      ctx.fillStyle = z.color + '33';
      ctx.strokeStyle = z.color + '88';
      ctx.lineWidth = 0.8;
      if (z.vertices && z.vertices.length > 0) {
        ctx.beginPath();
        z.vertices.forEach((v, i) => {
          const cx = toCanvasX(v.x);
          const cy = toCanvasY(v.y);
          if (i === 0) ctx.moveTo(cx, cy);
          else ctx.lineTo(cx, cy);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      } else {
        const x = toCanvasX(z.x);
        const y = toCanvasY(z.y);
        const w = z.width * scale;
        const h = z.height * scale;
        ctx.fillRect(x, y, w, h);
        ctx.strokeRect(x, y, w, h);
      }
    });

    // ── Draw tokens as colored dots ──────────────────────────
    const tokenR = Math.max(2.5, Math.min(5, scale * 14));
    allTokens.forEach((t) => {
      const char = getCharacter(t.charId);
      if (!char) return;
      const cx = toCanvasX(t.x);
      const cy = toCanvasY(t.y);
      // Color by type
      const color = char.type === 'player' ? '#e67e22' : '#27ae60';
      // Soft glow
      ctx.beginPath();
      ctx.arc(cx, cy, tokenR + 1.5, 0, Math.PI * 2);
      ctx.fillStyle = color + '33';
      ctx.fill();
      // Solid dot
      ctx.beginPath();
      ctx.arc(cx, cy, tokenR, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      // White border
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 0.6;
      ctx.stroke();
      // Active conflict participant: red ring
      if (scene.conflictData?.participants.some((p) => p.characterId === t.charId)) {
        ctx.beginPath();
        ctx.arc(cx, cy, tokenR + 2, 0, Math.PI * 2);
        ctx.strokeStyle = '#e74c3c';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });

    // ── Draw pins as small diamond markers ────────────────────
    scene.floors.forEach((floor) => {
      floor.pins.forEach((p) => {
        const cx = toCanvasX(p.x);
        const cy = toCanvasY(p.y);
        ctx.fillStyle = p.color || '#2c3e50';
        ctx.beginPath();
        ctx.moveTo(cx, cy - 2);
        ctx.lineTo(cx + 2, cy);
        ctx.lineTo(cx, cy + 2);
        ctx.lineTo(cx - 2, cy);
        ctx.closePath();
        ctx.fill();
      });
    });

    // ── Draw drawings as thin lines ───────────────────────────
    scene.floors.forEach((floor) => {
      floor.drawings.forEach((d) => {
        if (d.points.length < 2) return;
        ctx.strokeStyle = d.color + 'aa';
        ctx.lineWidth = Math.max(0.6, d.size * scale * 0.5);
        ctx.beginPath();
        d.points.forEach((p, i) => {
          const px = toCanvasX(p.x);
          const py = toCanvasY(p.y);
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.stroke();
      });
    });

    // ── Active scene overlay: subtle accent border with glow ─
    if (isActive) {
      ctx.save();
      ctx.shadowColor = 'rgba(230, 126, 34, 0.5)';
      ctx.shadowBlur = 8;
      ctx.strokeStyle = '#e67e22';
      ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, width - 2, height - 2);
      ctx.restore();
    }

    // ── Empty state hint ──────────────────────────────────────
    if (allTokens.length === 0 && allZones.length === 0) {
      ctx.font = '9px sans-serif';
      ctx.fillStyle = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.25)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('пусто', width / 2, height / 2);
    }
  }, [scene, width, height, isActive, getCharacter]);

  return (
    <canvas
      ref={canvasRef}
      className="rounded-lg block"
      style={{
        width: `${width}px`,
        height: `${height}px`,
        backgroundColor: 'var(--fate-bg-card)',
      }}
      aria-label={`Предпросмотр сцены ${scene.name}`}
    />
  );
}
