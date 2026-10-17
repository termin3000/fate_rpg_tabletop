import { NextResponse } from 'next/server';
import { startTunnel } from '../tunnel-state';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Publish the gateway so HTTP and both Socket.IO services share one URL.
export async function POST() {
  try {
    const state = await startTunnel();
    return NextResponse.json(state, { status: state.status === 'error' ? 502 : 200 });
  } catch (e) {
    return NextResponse.json(
      {
        status: 'error',
        url: null,
        error: e instanceof Error ? e.message : String(e),
        pid: null,
        startedAt: null,
      },
      { status: 500 },
    );
  }
}
