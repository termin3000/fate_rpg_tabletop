import { NextResponse } from 'next/server';
import { getTunnelState } from '../tunnel-state';

export const dynamic = 'force-dynamic';

// GET /api/tunnel/status — текущее состояние туннеля.
// Возвращает { status: 'idle'|'starting'|'running'|'error', url?: string, error?: string }
export async function GET() {
  return NextResponse.json(getTunnelState());
}
