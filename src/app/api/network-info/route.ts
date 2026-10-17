import { NextResponse } from 'next/server';
import os from 'os';

/**
 * GET /api/network-info
 *
 * Returns the host machine's network addresses so the GM can build a
 * shareable URL that players on OTHER machines/networks can actually reach.
 *
 * Why this exists:
 *   The naive approach (used earlier) builds the share URL from
 *   `window.location.origin`. That works only when the player opens the link
 *   on the SAME machine as the GM — they'd both be hitting `localhost:3000`.
 *   For anyone on another device, `localhost` is unreachable.
 *
 * What we return:
 *   - lan:       All non-internal IPv4 addresses of the host (e.g.
 *                192.168.1.42, 10.0.0.5). These work for anyone on the same
 *                LAN / Wi-Fi as the GM.
 *   - public:    The host's public (internet-facing) IP, fetched from an
 *                external echo service. Works for cross-network play BUT only
 *                if the GM has set up port forwarding / a tunnel on their
 *                router. May be null if the echo service is unreachable.
 *   - port:      The port the Next.js app is listening on (defaults to 3000,
 *                overridden by the PORT env var if present).
 *   - hostname:  The OS-level hostname of the machine (purely informational).
 *
 * Caching:
 *   LAN IPs are read live from os.networkInterfaces() — cheap and accurate.
 *   The public IP is cached for 5 minutes per process to avoid hammering the
 *   echo service on every dialog open.
 */

// ── Public IP cache ─────────────────────────────────────────────
let cachedPublicIp: string | null = null;
let cachedPublicIpAt = 0;
const PUBLIC_IP_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchPublicIp(): Promise<string | null> {
  // Return cached value if fresh.
  if (cachedPublicIp && Date.now() - cachedPublicIpAt < PUBLIC_IP_TTL_MS) {
    return cachedPublicIp;
  }

  // Try a few echo services in order — some may be blocked by corporate
  // firewalls. We race them and take the first response.
  const services = [
    'https://api.ipify.org?format=json',
    'https://ifconfig.me/all.json',
  ];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const result = await Promise.any(
      services.map(async (url) => {
        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'fate-rpg-vtt/1.0' },
        });
        if (!res.ok) throw new Error(`${url} returned ${res.status}`);
        const data = await res.json();
        // ipify returns { ip: "..." }, ifconfig.me returns { ip_addr: "..." }
        const ip = data.ip || data.ip_addr || null;
        if (!ip || typeof ip !== 'string') throw new Error('No IP in response');
        return ip;
      }),
    );

    clearTimeout(timeout);
    cachedPublicIp = result;
    cachedPublicIpAt = Date.now();
    return result;
  } catch {
    // All services failed — return null. The UI will hide the public-IP option.
    return null;
  }
}

function getLanAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const result: string[] = [];

  for (const name of Object.keys(interfaces)) {
    const entries = interfaces[name];
    if (!entries) continue;

    for (const entry of entries) {
      // Skip non-IPv4 and internal (loopback) addresses.
      if (entry.family !== 'IPv4') continue;
      if (entry.internal) continue;
      // Skip link-local (169.254.x.x) and other auto-config addresses.
      if (entry.address.startsWith('169.254.')) continue;
      result.push(entry.address);
    }
  }

  return result;
}

export async function GET() {
  try {
    const port = process.env.PORT || '3000';
    const hostname = os.hostname();

    const [lan, publicIp] = await Promise.all([
      Promise.resolve(getLanAddresses()),
      fetchPublicIp(),
    ]);

    return NextResponse.json({
      ok: true,
      lan,
      public: publicIp,
      port,
      hostname,
      // Hint for the UI: if the user is currently viewing the app via
      // localhost, they almost certainly want to share one of the LAN/public
      // URLs instead. The UI uses this to pick the default share URL.
      serverTime: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        lan: [],
        public: null,
        port: process.env.PORT || '3000',
      },
      { status: 500 },
    );
  }
}
