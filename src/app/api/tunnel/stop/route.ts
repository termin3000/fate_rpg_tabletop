import { NextResponse } from 'next/server';
import { stopTunnel } from '../tunnel-state';

export const dynamic = 'force-dynamic';

// POST /api/tunnel/stop — останавливает туннель.
export async function POST() {
  const state = stopTunnel();
  return NextResponse.json(state);
}
