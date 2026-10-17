'use client';

/**
 * NetworkDialog — UI for hosting/joining a Fate RPG VTT P2P session.
 *
 * Two states:
 *   1. Idle: enter display name, then either create a room (host/GM) or
 *      join an existing one (player) by entering its 6-char code.
 *   2. Active: show role badge, room code with copy button, peer list with
 *      character assignments (host view) or own assignment (player view),
 *      and a "leave session" button.
 *
 * Star topology: GM (host) is the central node. Players connect to the host
 * directly via WebRTC; the signaling server only brokers the connection.
 */

import { useState, useCallback, useEffect, useMemo } from 'react';
import QRCode from 'qrcode';
import {
  Check,
  ChevronDown,
  Copy,
  Crown,
  Globe,
  Laptop,
  Link2,
  LogOut,
  Plus,
  QrCode,
  RefreshCw,
  Router,
  User,
  Users,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { useFateStore } from '@/lib/store';
import { genRoomCode, useNetwork } from '@/hooks/use-network';

interface NetworkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Visual tokens — kept in sync with the rest of the Fate dialogs.
const HOST_COLOR = '#e67e22';    // warm orange — GM/master
const PLAYER_COLOR = '#27ae60';  // green — player character (PC)
const DANGER_COLOR = '#c0392b';  // red — leave/disconnect

// ── ShareUrlPicker ──────────────────────────────────────────────────
// Popover content that lets the GM pick which network address the share
// URL should point to. Shows one row per candidate:
//
//   • This computer       → http://localhost:<port>   (same machine only)
//   • <LAN IP>            → http://<lan-ip>:<port>    (same Wi-Fi)
//   • <Public IP>         → http://<public-ip>:<port> (cross-network,
//                                                       requires port forwarding)
//   • Custom address      → user input (ngrok, localtunnel, etc.)
//
// The active row gets a green check on the right. The custom row has an
// inline Input + Apply button so the user can paste any host/URL.
type ShareSource =
  | { kind: 'local' }
  | { kind: 'lan'; ip: string }
  | { kind: 'public' }
  | { kind: 'tunnel' }
  | { kind: 'custom'; host: string };

type NetworkInfoData = {
  lan: string[];
  public: string | null;
  port: string;
  hostname?: string;
};

// ── Tunnel state (localtunnel) ──
// Полный публичный URL вида https://random-words-123.trycloudflare.com.
// Запускается одной кнопкой в ShareUrlPicker — не требует установки,
// регистрации, или порт-форвардинга на роутере.
type TunnelState = {
  status: 'idle' | 'starting' | 'running' | 'error';
  url: string | null;
  error: string | null;
  pid: number | null;
  startedAt: number | null;
};

interface ShareUrlPickerProps {
  networkInfo: NetworkInfoData | null;
  loading: boolean;
  current: ShareSource;
  customDraft: string;
  onCustomDraftChange: (v: string) => void;
  onSelect: (src: ShareSource) => void;
  onApplyCustom: () => void;
  // Tunnel state + controls
  tunnel: TunnelState;
  tunnelBusy: boolean;
  onTunnelStart: () => void;
  onTunnelStop: () => void;
}

// Single row inside the URL picker. Declared OUTSIDE ShareUrlPicker so
// React doesn't treat it as a fresh component on every render (which would
// reset any internal state and cause the lint rule
// `react-hooks/static-components` to fire).
function ShareUrlPickerRow({
  src,
  current,
  icon,
  title,
  subtitle,
  url,
  onSelect,
}: {
  src: ShareSource;
  current: ShareSource;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  url: string;
  onSelect: (src: ShareSource) => void;
}) {
  const isCurrent = (() => {
    if (src.kind !== current.kind) return false;
    if (src.kind === 'lan' && current.kind === 'lan') return src.ip === current.ip;
    if (src.kind === 'custom' && current.kind === 'custom') return src.host === current.host;
    return true;
  })();

  return (
    <button
      type="button"
      onClick={() => onSelect(src)}
      className="w-full text-left px-3 py-2 flex items-start gap-2.5 hover:bg-[var(--fate-bg-hover,#f5f5f5)] transition-colors"
      style={{
        backgroundColor: isCurrent ? 'rgba(39, 174, 96, 0.08)' : 'transparent',
      }}
    >
      <div
        className="size-7 rounded-md flex items-center justify-center shrink-0 mt-0.5"
        style={{
          backgroundColor: isCurrent
            ? 'rgba(39, 174, 96, 0.15)'
            : 'var(--fate-bg-card, rgba(0,0,0,0.04))',
        }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium flex items-center gap-1.5" style={{ color: 'var(--fate-text)' }}>
          {title}
          {isCurrent && <Check className="size-3.5" style={{ color: PLAYER_COLOR }} />}
        </div>
        <div className="text-[10px] truncate" style={{ color: 'var(--fate-text-muted)' }}>
          {subtitle}
        </div>
        <div className="text-[10px] font-mono mt-0.5 truncate" style={{ color: 'var(--fate-text-muted)', opacity: 0.7 }}>
          {url}
        </div>
      </div>
    </button>
  );
}

function ShareUrlPicker({
  networkInfo,
  loading,
  current,
  customDraft,
  onCustomDraftChange,
  onSelect,
  onApplyCustom,
  tunnel,
  tunnelBusy,
  onTunnelStart,
  onTunnelStop,
}: ShareUrlPickerProps) {
  // Use the current browser port (e.g. 81 if the GM is on the Caddy gateway,
  // 3000 if on direct Next.js) so the displayed URLs match what the shareUrl
  // useMemo actually produces.
  const port = typeof window !== 'undefined' && window.location.port
    ? window.location.port
    : (networkInfo?.port ?? '3000');

  if (loading) {
    return (
      <div className="p-4 text-center text-xs" style={{ color: 'var(--fate-text-muted)' }}>
        Определение сетевых адресов...
      </div>
    );
  }

  return (
    <div className="max-h-[420px] overflow-y-auto fate-scroll">
      {/* Local — same machine only */}
      <ShareUrlPickerRow
        src={{ kind: 'local' }}
        current={current}
        onSelect={onSelect}
        icon={<Laptop className="size-3.5" style={{ color: 'var(--fate-text-muted)' }} />}
        title="Этот компьютер"
        subtitle="Только для запуска на этой же машине"
        url={`http://localhost:${port}/?join=...`}
      />

      <div className="h-px" style={{ backgroundColor: 'var(--fate-border)' }} />

      {/* LAN addresses — same Wi-Fi / LAN */}
      {networkInfo && networkInfo.lan.length > 0 ? (
        networkInfo.lan.map((ip) => (
          <ShareUrlPickerRow
            key={`lan-${ip}`}
            src={{ kind: 'lan', ip }}
            current={current}
            onSelect={onSelect}
            icon={<Router className="size-3.5" style={{ color: PLAYER_COLOR }} />}
            title={`Локальная сеть — ${ip}`}
            subtitle="Игроки в той же Wi-Fi сети"
            url={`http://${ip}:${port}/?join=...`}
          />
        ))
      ) : (
        <div className="px-3 py-2 text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
          Локальные IP не обнаружены
        </div>
      )}

      {/* ── INTERNET TUNNEL (localtunnel) ── */}
      {/* Главная фича для не-программиста: одна кнопка → публичный URL. */}
      <div className="h-px" style={{ backgroundColor: 'var(--fate-border)' }} />
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--fate-text)' }}>
          <Globe className="size-3.5" style={{ color: HOST_COLOR }} />
          Интернет-туннель (localtunnel)
          {current.kind === 'tunnel' && tunnel.status === 'running' && (
            <Check className="size-3.5" style={{ color: PLAYER_COLOR }} />
          )}
        </div>

        {tunnel.status === 'idle' && (
          <>
            <p className="text-[10px] leading-snug" style={{ color: 'var(--fate-text-muted)' }}>
              Создайте публичную ссылку для игры с друзьями из любой сети.
              Без настройки роутера, без регистрации. Бесплатно.
            </p>
            <Button
              size="sm"
              className="w-full h-9 rounded-lg fate-btn-accent"
              onClick={onTunnelStart}
              disabled={tunnelBusy}
            >
              <Globe className="size-3.5 mr-1.5" />
              Создать ссылку для интернета
            </Button>
          </>
        )}

        {tunnel.status === 'starting' && (
          <>
            <p className="text-[10px] leading-snug" style={{ color: 'var(--fate-text-muted)' }}>
              {tunnel.error || 'Подключение к localtunnel...'}
            </p>
            <div className="flex items-center justify-center gap-2 py-2">
              <div className="size-3 rounded-full border-2 border-current border-t-transparent animate-spin" style={{ color: HOST_COLOR }} />
              <span className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                Подождите...
              </span>
            </div>
          </>
        )}

        {tunnel.status === 'running' && tunnel.url && (
          <>
            <p className="text-[10px] leading-snug" style={{ color: 'var(--fate-text-muted)' }}>
              Публичная ссылка активна. Отправьте её друзьям — они смогут
              подключиться по ссылке комнаты. Если localtunnel покажет страницу доступа,
              сначала пройдите её.
            </p>
            <button
              type="button"
              onClick={() => onSelect({ kind: 'tunnel' })}
              className="w-full text-left px-2.5 py-2 rounded-lg transition-colors"
              style={{
                backgroundColor: current.kind === 'tunnel' ? 'rgba(39, 174, 96, 0.08)' : 'var(--fate-bg-card, rgba(0,0,0,0.04))',
              }}
            >
              <div className="text-[10px] font-mono break-all" style={{ color: 'var(--fate-text)' }}>
                {tunnel.url}
              </div>
              <div className="text-[10px] mt-0.5" style={{ color: PLAYER_COLOR }}>
                {current.kind === 'tunnel' ? '✓ Выбрано — добавьте ?join=CODE при копировании' : 'Нажмите чтобы выбрать'}
              </div>
            </button>
            <Button
              size="sm"
              variant="outline"
              className="w-full h-8 rounded-lg text-[11px]"
              onClick={onTunnelStop}
              disabled={tunnelBusy}
            >
              Остановить туннель
            </Button>
          </>
        )}

        {tunnel.status === 'error' && (
          <>
            <p className="text-[10px] leading-snug" style={{ color: '#dc2626' }}>
              {tunnel.error || 'Не удалось запустить туннель.'}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="w-full h-8 rounded-lg text-[11px]"
              onClick={onTunnelStart}
              disabled={tunnelBusy}
            >
              Попробовать снова
            </Button>
          </>
        )}
      </div>

      {/* Public IP — cross-network, needs port forwarding */}
      {networkInfo && networkInfo.public && (
        <>
          <div className="h-px" style={{ backgroundColor: 'var(--fate-border)' }} />
          <ShareUrlPickerRow
            src={{ kind: 'public' }}
            current={current}
            onSelect={onSelect}
            icon={<Globe className="size-3.5" style={{ color: 'var(--fate-text-muted)' }} />}
            title={`Публичный IP — ${networkInfo.public}`}
            subtitle="Нужен порт-форвардинг на роутере"
            url={`http://${networkInfo.public}:${port}/?join=...`}
          />
        </>
      )}

      <div className="h-px" style={{ backgroundColor: 'var(--fate-border)' }} />

      {/* Custom host — for tunnels / ngrok / cloudflare / etc. */}
      <div className="p-3 space-y-2">
        <div className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--fate-text)' }}>
          <Link2 className="size-3.5" style={{ color: 'var(--fate-text-muted)' }} />
          Свой адрес
          {current.kind === 'custom' && <Check className="size-3.5" style={{ color: PLAYER_COLOR }} />}
        </div>
        <p className="text-[10px] leading-snug" style={{ color: 'var(--fate-text-muted)' }}>
          Вставьте адрес туннеля (ngrok, localtunnel, и т.п.) или
          свой публичный IP с портом.
        </p>
        <div className="flex items-center gap-2">
          <Input
            value={customDraft}
            onChange={(e) => onCustomDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onApplyCustom();
              }
            }}
            placeholder="my-tunnel.ngrok.io:4040"
            className="text-xs h-9 rounded-lg"
            style={{ backgroundColor: 'var(--fate-bg-card)' }}
          />
          <Button
            size="sm"
            className="h-9 rounded-lg fate-btn-accent shrink-0"
            onClick={onApplyCustom}
          >
            ОК
          </Button>
        </div>
      </div>
    </div>
  );
}

type IdleMode = 'idle' | 'hosting' | 'joining';

export function NetworkDialog({ open, onOpenChange }: NetworkDialogProps) {
  const {
    isNetworkActive,
    networkRole,
    networkMyDisplayName,
    networkRoomId,
    networkPeers,
    networkHostOnline,
    networkMyPeerId,
    networkSignalingStatus,
    peerLatencies,
    peerLastSeen,
    playerAssignments,
    characters,
    settings,
    getCurrentScene,
    setNetworkMyDisplayName,
    setPeerCharacters,
    forgetPeer,
  } = useFateStore();

  const { hostRoom, joinRoom, leaveSession, broadcastAssignment } = useNetwork();

  const [displayName, setDisplayName] = useState(networkMyDisplayName);
  const [idleMode, setIdleMode] = useState<IdleMode>('idle');
  const [roomCode, setRoomCode] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [copiedLink, setCopiedLink] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [showQr, setShowQr] = useState(false);

  // ── Network info for shareable URLs ────────────────────────────
  // The shareable link must point to a host that players on OTHER
  // machines/networks can actually reach. `window.location.origin`
  // only works when GM and player share the same browser instance.
  // We fetch the host's LAN + public IPs from /api/network-info and
  // let the GM pick which one to share.
  const [networkInfo, setNetworkInfo] = useState<NetworkInfoData | null>(null);
  const [networkInfoLoading, setNetworkInfoLoading] = useState(false);

  // Which share-URL source is currently selected. The picker default
  // is the first LAN IP (so the share link works for same-Wi-Fi players);
  // if no LAN IP is detected we fall back to localhost.
  const [shareSource, setShareSource] = useState<ShareSource>({ kind: 'local' });
  const [customHostDraft, setCustomHostDraft] = useState('');
  const [urlPickerOpen, setUrlPickerOpen] = useState(false);

  // ── Tunnel state (localtunnel) ──
  // Публичный URL для игры через интернет. Запускается одной кнопкой,
  // не требует порт-форвардинга. См. /api/tunnel/* routes.
  const [tunnel, setTunnel] = useState<TunnelState>({
    status: 'idle',
    url: null,
    error: null,
    pid: null,
    startedAt: null,
  });
  const [tunnelBusy, setTunnelBusy] = useState(false);

  // The tunnel lives on the server; a browser reload must recover its URL.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch('/api/tunnel/status').then(response => response.json()).then((state: TunnelState) => {
      if (cancelled || !['idle', 'starting', 'running', 'error'].includes(state.status)) return;
      setTunnel(state);
      if (state.status === 'running' && state.url) {
        setShareSource(previous => previous.kind === 'custom' ? previous : { kind: 'tunnel' });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [open]);

  // Poll tunnel status while it's starting (to catch the URL when localtunnel
  // prints it to stderr). Once running/idle/error, stop polling.
  useEffect(() => {
    if (tunnel.status !== 'starting') return;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch('/api/tunnel/status');
        const data: TunnelState = await r.json();
        if (!cancelled && data.status !== 'starting') {
          setTunnel(data);
        }
      } catch {
        // ignore — best-effort poll
      }
    };
    const interval = setInterval(poll, 1000);
    // Also poll once immediately.
    poll();
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [tunnel.status]);

  const handleTunnelStart = useCallback(async () => {
    setTunnelBusy(true);
    setTunnel({
      status: 'starting',
      url: null,
      error: null,
      pid: null,
      startedAt: Date.now(),
    });
    try {
      const r = await fetch('/api/tunnel/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data: TunnelState = await r.json();
      setTunnel(data);
      if (data.status === 'running' && data.url) {
        setShareSource({ kind: 'tunnel' });
      }
    } catch (e) {
      setTunnel({
        status: 'error',
        url: null,
        error: e instanceof Error ? e.message : String(e),
        pid: null,
        startedAt: null,
      });
    } finally {
      setTunnelBusy(false);
    }
  }, []);

  const handleTunnelStop = useCallback(async () => {
    setTunnelBusy(true);
    try {
      await fetch('/api/tunnel/stop', { method: 'POST' });
      setTunnel({
        status: 'idle',
        url: null,
        error: null,
        pid: null,
        startedAt: null,
      });
      // If tunnel was selected, fall back to localhost.
      setShareSource((prev) => prev.kind === 'tunnel' ? { kind: 'local' } : prev);
    } catch {
      // ignore
    } finally {
      setTunnelBusy(false);
    }
  }, []);

  // Fetch network info whenever the dialog opens — we need fresh IPs
  // in case the host changed networks since the last open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // Defer the loading-flag setState via a microtask so it's not
    // called synchronously inside the effect body (which triggers the
    // `react-hooks/set-state-in-effect` rule and can cause cascading
    // renders on first paint).
    Promise.resolve().then(() => {
      if (!cancelled) setNetworkInfoLoading(true);
    });
    fetch('/api/network-info')
      .then((r) => r.json())
      .then((data: NetworkInfoData & { ok?: boolean }) => {
        if (cancelled) return;
        if (data && Array.isArray(data.lan)) {
          setNetworkInfo({
            lan: data.lan,
            public: data.public ?? null,
            port: data.port ?? '3000',
            hostname: data.hostname,
          });
          // Default: prefer the first LAN IP. If user already had a
          // custom host selected, keep their choice.
          setShareSource((prev) => {
            if (prev.kind === 'custom' || prev.kind === 'tunnel') return prev;
            if (data.lan.length > 0) {
              return { kind: 'lan', ip: data.lan[0] };
            }
            return { kind: 'local' };
          });
        }
      })
      .catch(() => {
        // Network info is best-effort — fall back to localhost.
        if (!cancelled) setNetworkInfo(null);
      })
      .finally(() => {
        if (!cancelled) setNetworkInfoLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset local form state whenever the dialog opens. Using the React-recommended
  // "store information from previous renders" pattern (see react.dev/reference/react/useState)
  // — detect the open transition synchronously during render and update state
  // conditionally. This avoids the `react-hooks/set-state-in-effect` lint rule
  // and prevents cascading renders that an effect-based reset would trigger.
  // Also initialize the join form when mounted already open (share landing).
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setDisplayName(networkMyDisplayName);
      setJoinCode('');
      setCopied(false);
      setCopiedLink(false);
      setShowQr(false);
      // If the page was opened via ?join=CODE, jump straight to the
      // joining flow with the code pre-filled.
      if (typeof window !== 'undefined') {
        const params = new URLSearchParams(window.location.search);
        const urlJoin = params.get('join');
        if (urlJoin && /^[A-Z0-9]{6}$/i.test(urlJoin)) {
          setJoinCode(urlJoin.toUpperCase());
          setIdleMode('joining');
        } else {
          setIdleMode('idle');
          setRoomCode('');
        }
      } else {
        setIdleMode('idle');
        setRoomCode('');
      }
    }
  }

  // ── Handlers ──────────────────────────────────────────────
  const handleCreateRoom = useCallback(() => {
    const name = displayName.trim() || 'Мастер';
    const code = genRoomCode();
    setRoomCode(code);
    setNetworkMyDisplayName(name);
    hostRoom(code, name);
    setIdleMode('hosting');
    // NOTE: We intentionally do NOT update the URL with ?join=CODE here.
    // In Next.js 16 App Router, window.history.replaceState() is intercepted
    // and triggers a soft navigation / re-render. That re-render caused the
    // host's socket.io connection to drop ~30s after room creation (the
    // re-validation cycle closed the WebSocket as "transport close"), which
    // made the GM unable to see players joining. The room code is already
    // visible in the dialog UI and the share-link textbox — no need to
    // pollute the URL. Players reach the room via the shared link, not via
    // the host's URL bar.
    toast.success(`Комната создана: ${code}`);
  }, [displayName, hostRoom, setNetworkMyDisplayName]);

  const handleConnectPlayer = useCallback(() => {
    const code = joinCode.trim().toUpperCase();
    if (code.length !== 6) {
      toast.error('Код комнаты должен содержать 6 символов');
      return;
    }
    const name = displayName.trim() || 'Игрок';
    setNetworkMyDisplayName(name);
    joinRoom(code, name);
    toast.info('Подключение к комнате…');
  }, [displayName, joinCode, joinRoom, setNetworkMyDisplayName]);

  const handleLeave = useCallback(() => {
    leaveSession();
    setIdleMode('idle');
    setRoomCode('');
    setJoinCode('');
    setShowQr(false);
    // NOTE: We do NOT strip ?join= from the URL here either — same reason as
    // handleCreateRoom: window.history.replaceState triggers a Next.js
    // re-render that disrupts the socket. The ?join= param (if any) is
    // harmless once the session is left — the NetworkDialog reads it only
    // on initial mount, not on every render.
    toast.info('Сессия завершена');
  }, [leaveSession]);

  const handleCopyRoom = useCallback((code: string | null) => {
    if (!code) return;
    navigator.clipboard?.writeText(code)
      .then(() => {
        setCopied(true);
        toast.success('Код скопирован');
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error('Не удалось скопировать код'));
  }, []);

  // The room code currently in effect — either the one the host just
  // generated (idleMode === 'hosting') or the live networkRoomId once the
  // session is active.
  const activeRoomCode = idleMode === 'hosting' ? roomCode : networkRoomId;

  // Build the shareable URL based on the selected source. We always carry
  // the room code as `?join=CODE` so the player's browser auto-fills it.
  //
  // Sources:
  //   local  → http://localhost:<port>/?join=CODE   (same machine only)
  //   lan    → http://<lan-ip>:<port>/?join=CODE    (same Wi-Fi / LAN)
  //   public → http://<public-ip>:<port>/?join=CODE (cross-network, needs port-forward)
  //   custom → http(s)://<user-input>/?join=CODE    (ngrok / localtunnel / etc.)
  //
  // IMPORTANT: We use `window.location.port` (the port the GM is currently
  // browsing through) — NOT `networkInfo.port` (the Next.js listen port).
  // This way, if the GM is accessing the app via the Caddy gateway on :81,
  // the share URL also points to :81, so players can reach it without the
  // GM having to open port 3000 separately. If the GM is on direct Next.js
  // (:3000), the share URL uses :3000 — which works for same-LAN players
  // provided Windows firewall allows it (it usually prompts on first run).
  const shareUrl = useMemo(() => {
    if (typeof window === 'undefined' || !activeRoomCode) return '';
    // Current port the GM is browsing through. Empty string means the
    // browser is using the protocol default (80 for http, 443 for https).
    const currentPort = window.location.port;
    const currentProtocol = window.location.protocol; // 'http:' or 'https:'
    // For the 'lan' and 'public' sources we use the same protocol+port as
    // the GM's current view, since they're accessing the same app.
    const scheme = currentProtocol.replace(':', '');
    const portSuffix = currentPort ? `:${currentPort}` : '';

    let origin: string;
    switch (shareSource.kind) {
      case 'local':
        origin = window.location.origin;
        break;
      case 'lan':
        origin = `${scheme}://${shareSource.ip}${portSuffix}`;
        break;
      case 'public':
        if (!networkInfo?.public) {
          // No public IP available — fall back to window origin.
          origin = window.location.origin;
        } else {
          origin = `${scheme}://${networkInfo.public}${portSuffix}`;
        }
        break;
      case 'tunnel': {
        // localtunnel URL — публичный HTTPS-адрес шлюза.
        // Добавляем ?join=CODE к нему.
        if (!tunnel.url) {
          origin = window.location.origin;
        } else {
          try {
            const parsed = new URL(tunnel.url);
            origin = parsed.origin;
          } catch {
            origin = window.location.origin;
          }
        }
        break;
      }
      case 'custom': {
        // Accept user input with or without scheme/path. Strip trailing
        // slashes; we set ?join= on top.
        let host = shareSource.host.trim();
        if (!host) {
          origin = window.location.origin;
          break;
        }
        // If user pasted a full URL, use its origin; otherwise prepend http://.
        if (!/^https?:\/\//i.test(host)) {
          host = `http://${host}`;
        }
        try {
          const parsed = new URL(host);
          origin = parsed.origin;
        } catch {
          origin = window.location.origin;
        }
        break;
      }
      default:
        origin = window.location.origin;
    }

    const url = new URL(origin);
    url.searchParams.set('join', activeRoomCode);
    return url.toString();
  }, [activeRoomCode, shareSource, networkInfo, tunnel]);

  // Regenerate the QR PNG whenever the share URL changes. We render at a
  // comfortable 240×240 px and with a high error-correction level so the
  // code still scans even if the dialog renders a badge/logo over it.
  useEffect(() => {
    if (!shareUrl) return; // nothing to render — leave stale state hidden
    let cancelled = false;
    QRCode.toDataURL(shareUrl, {
      width: 240,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#1a1a1a', light: '#ffffff' },
    })
      .then((url) => {
        if (!cancelled) setQrDataUrl(url);
      })
      .catch(() => { /* ignore — QR generation is best-effort */ });
    return () => { cancelled = true; };
  }, [shareUrl]);

  const handleCopyLink = useCallback(() => {
    if (!shareUrl) return;
    navigator.clipboard?.writeText(shareUrl)
      .then(() => {
        setCopiedLink(true);
        toast.success('Ссылка скопирована');
        setTimeout(() => setCopiedLink(false), 1500);
      })
      .catch(() => toast.error('Не удалось скопировать ссылку'));
  }, [shareUrl]);

  // Characters available for host→player assignment. We surface ALL
  // characters in the adventure (not just those placed on the current
  // scene) so the GM can hand a PC to a player even before dragging it
  // onto the map. Grouped by type for quick scanning in the dropdown.
  const scene = getCurrentScene();
  const hasScene = !!scene;
  const roster = new Set(settings?.playerRoster ?? []);
  // Only player-type characters (PCs) are assignable to network players.
  // NPCs are excluded from assignment by design — they stay under GM control.
  const playerChars = characters.filter(
    (c) => c.type === 'player' || roster.has(c.id),
  );

  const peerCount = Object.keys(networkPeers).length + 1; // peers + self

  // The player's own assigned PCs (multi-assign: a player may control several
  // PCs, but each PC belongs to exactly one player). For the player view we
  // render them all as green badges.
  const myAssignedIds = networkMyPeerId ? (playerAssignments[networkMyPeerId] ?? []) : [];

  // ── Render ────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md max-h-[92vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5 fate-dialog-title fate-dialog-title-bar">
            <div
              className="fate-icon-circle"
              style={{ backgroundColor: 'rgba(39, 174, 96, 0.12)' }}
            >
              <Globe className="size-4" style={{ color: PLAYER_COLOR }} />
            </div>
            🌐 Сетевая игра
          </DialogTitle>
          <DialogDescription>
            {isNetworkActive
              ? `Вы в комнате как ${networkRole === 'host' ? 'Мастер' : 'Игрок'}`
              : 'Создайте комнату как Мастер или подключитесь к существующей'}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto fate-scroll flex-1 min-h-0">
          {!isNetworkActive ? (
            <>
              {/* Display name input */}
              <div className="space-y-2">
                <Label className="text-sm font-medium" style={{ color: 'var(--fate-text)' }}>
                  Ваше имя
                </Label>
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Введите имя..."
                  className="rounded-lg"
                  maxLength={32}
                />
              </div>

              <Separator />

              {/* Idle: choose host or player */}
              {idleMode === 'idle' && (
                <div className="grid grid-cols-1 gap-2.5">
                  <Button
                    size="lg"
                    className="h-auto py-4 flex flex-col items-center gap-1.5 rounded-xl fate-btn-accent fate-button-shine"
                    onClick={handleCreateRoom}
                    disabled={!displayName.trim()}
                  >
                    <Crown className="size-5" />
                    <span className="font-semibold">Создать комнату</span>
                    <span className="text-xs opacity-80">Вы — Мастер</span>
                  </Button>
                  <Button
                    size="lg"
                    variant="outline"
                    className="h-auto py-4 flex flex-col items-center gap-1.5 rounded-xl"
                    onClick={() => setIdleMode('joining')}
                    disabled={!displayName.trim()}
                  >
                    <Users className="size-5" />
                    <span className="font-semibold">Подключиться к комнате</span>
                    <span className="text-xs opacity-70">Вы — Игрок</span>
                  </Button>
                </div>
              )}

              {/* Hosting: show generated room code + copy */}
              {idleMode === 'hosting' && (
                <div className="space-y-3 animate-slide-down">
                  <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                    Код комнаты
                  </Label>
                  <div className="flex items-center gap-2">
                    <div
                      className="flex-1 text-center text-3xl font-black tracking-[0.4em] py-3 rounded-lg select-all"
                      style={{
                        backgroundColor: 'var(--fate-bg-card)',
                        border: `1px solid ${HOST_COLOR}40`,
                        color: 'var(--fate-text)',
                      }}
                    >
                      {roomCode}
                    </div>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-12 rounded-lg"
                      onClick={() => handleCopyRoom(roomCode)}
                      aria-label="Скопировать код"
                    >
                      {copied
                        ? <Check className="size-4" style={{ color: PLAYER_COLOR }} />
                        : <Copy className="size-4" />}
                    </Button>
                  </div>
                  <p className="text-xs text-center" style={{ color: 'var(--fate-text-muted)' }}>
                    Поделитесь кодом с игроками
                  </p>

                  {/* Share link + QR — lets players join by clicking a URL or
                      scanning a code instead of typing the 6-char code. */}
                  <div className="space-y-2 pt-1">
                    <Label className="text-xs font-medium flex items-center gap-1.5" style={{ color: 'var(--fate-text-muted)' }}>
                      <Link2 className="size-3.5" />
                      Ссылка для подключения
                    </Label>
                    <div className="flex items-center gap-2">
                      <Input
                        readOnly
                        value={shareUrl}
                        className="text-xs rounded-lg select-all"
                        style={{ backgroundColor: 'var(--fate-bg-card)' }}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <Popover open={urlPickerOpen} onOpenChange={setUrlPickerOpen}>
                        <PopoverTrigger asChild>
                          <Button
                            variant="outline"
                            size="icon"
                            className="size-10 rounded-lg shrink-0"
                            aria-label="Выбрать адрес ссылки"
                            title="Выбрать адрес ссылки"
                          >
                            <ChevronDown className="size-4" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent
                          className="w-[320px] p-0"
                          align="end"
                          sideOffset={4}
                        >
                          <ShareUrlPicker
                            networkInfo={networkInfo}
                            loading={networkInfoLoading}
                            current={shareSource}
                            customDraft={customHostDraft}
                            onCustomDraftChange={setCustomHostDraft}
                            onSelect={(src) => {
                              setShareSource(src);
                              setUrlPickerOpen(false);
                            }}
                            onApplyCustom={() => {
                              const v = customHostDraft.trim();
                              if (!v) {
                                toast.error('Введите адрес');
                                return;
                              }
                              setShareSource({ kind: 'custom', host: v });
                              setUrlPickerOpen(false);
                            }}
                            tunnel={tunnel}
                            tunnelBusy={tunnelBusy}
                            onTunnelStart={handleTunnelStart}
                            onTunnelStop={handleTunnelStop}
                          />
                        </PopoverContent>
                      </Popover>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-10 rounded-lg shrink-0"
                        onClick={handleCopyLink}
                        aria-label="Скопировать ссылку"
                      >
                        {copiedLink
                          ? <Check className="size-4" style={{ color: PLAYER_COLOR }} />
                          : <Link2 className="size-4" />}
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full rounded-lg gap-1.5"
                      onClick={() => setShowQr((v) => !v)}
                    >
                      <QrCode className="size-3.5" />
                      {showQr ? 'Скрыть QR-код' : 'Показать QR-код'}
                    </Button>
                    {showQr && qrDataUrl && (
                      <div className="flex flex-col items-center gap-1.5 pt-1 animate-slide-down">
                        <img
                          src={qrDataUrl}
                          alt={`QR-код для подключения к комнате ${roomCode}`}
                          className="rounded-lg"
                          style={{ width: 200, height: 200, border: '1px solid var(--fate-border)' }}
                        />
                        <p className="text-[10px] text-center" style={{ color: 'var(--fate-text-muted)' }}>
                          Наведите камеру телефона, чтобы открыть комнату
                        </p>
                      </div>
                    )}
                  </div>

                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full rounded-lg gap-1.5"
                    onClick={() => setIdleMode('idle')}
                  >
                    <RefreshCw className="size-3.5" />
                    Сгенерировать другой код
                  </Button>
                </div>
              )}

              {/* Joining: code input + connect */}
              {idleMode === 'joining' && (
                <div className="space-y-3 animate-slide-down">
                  <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                    Код комнаты
                  </Label>
                  <Input
                    value={joinCode}
                    onChange={(e) =>
                      setJoinCode(e.target.value.toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 6))
                    }
                    placeholder="ABC123"
                    className="text-center text-2xl font-bold tracking-[0.3em] rounded-lg"
                    maxLength={6}
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="flex-1 rounded-lg"
                      onClick={() => setIdleMode('idle')}
                    >
                      Назад
                    </Button>
                    <Button
                      className="flex-1 rounded-lg fate-btn-accent fate-button-shine gap-1.5"
                      onClick={handleConnectPlayer}
                      disabled={joinCode.trim().length !== 6}
                    >
                      <Wifi className="size-4" />
                      Подключиться
                    </Button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <>
              {/* Active session header */}
              <div className="flex items-center justify-between gap-2">
                <Badge
                  className="px-3 py-1 rounded-lg text-xs font-semibold gap-1"
                  style={{
                    backgroundColor:
                      networkRole === 'host'
                        ? `rgba(230, 126, 34, 0.12)`
                        : `rgba(39, 174, 96, 0.12)`,
                    color: networkRole === 'host' ? HOST_COLOR : PLAYER_COLOR,
                    border: 'none',
                  }}
                >
                  {networkRole === 'host'
                    ? <><Crown className="size-3" /> Мастер</>
                    : <><User className="size-3" /> Игрок</>}
                </Badge>
                <div
                  className="flex items-center gap-1.5 text-xs font-medium"
                  style={{ color: 'var(--fate-text-muted)' }}
                >
                  {networkRole === 'host' || networkHostOnline ? (
                    <><Wifi className="size-3.5" style={{ color: PLAYER_COLOR }} /> Хост на связи</>
                  ) : (
                    <><WifiOff className="size-3.5" style={{ color: DANGER_COLOR }} /> Хост не в сети</>
                  )}
                </div>
              </div>

              {/* Room code with copy */}
              <div className="space-y-1.5">
                <Label className="text-xs font-medium" style={{ color: 'var(--fate-text-muted)' }}>
                  Код комнаты
                </Label>
                <div className="flex items-center gap-2">
                  <div
                    className="flex-1 text-center text-2xl font-black tracking-[0.4em] py-2.5 rounded-lg select-all"
                    style={{
                      backgroundColor: 'var(--fate-bg-card)',
                      border: '1px solid var(--fate-border)',
                      color: 'var(--fate-text)',
                    }}
                  >
                    {networkRoomId}
                  </div>
                  <Button
                    variant="outline"
                    size="icon"
                    className="size-10 rounded-lg"
                    onClick={() => handleCopyRoom(networkRoomId)}
                    aria-label="Скопировать код"
                  >
                    {copied
                      ? <Check className="size-4" style={{ color: PLAYER_COLOR }} />
                      : <Copy className="size-4" />}
                  </Button>
                </div>

                {/* Share link + QR — host can still invite players after the
                    session has started. */}
                <div className="space-y-2 pt-1">
                  <div className="flex items-center gap-2">
                    <Input
                      readOnly
                      value={shareUrl}
                      className="text-xs rounded-lg select-all"
                      style={{ backgroundColor: 'var(--fate-bg-card)' }}
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <Popover open={urlPickerOpen} onOpenChange={setUrlPickerOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-10 rounded-lg shrink-0"
                          aria-label="Выбрать адрес ссылки"
                          title="Выбрать адрес ссылки"
                        >
                          <ChevronDown className="size-4" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent
                        className="w-[320px] p-0"
                        align="end"
                        sideOffset={4}
                      >
                        <ShareUrlPicker
                          networkInfo={networkInfo}
                          loading={networkInfoLoading}
                          current={shareSource}
                          customDraft={customHostDraft}
                          onCustomDraftChange={setCustomHostDraft}
                          onSelect={(src) => {
                            setShareSource(src);
                            setUrlPickerOpen(false);
                          }}
                          onApplyCustom={() => {
                            const v = customHostDraft.trim();
                            if (!v) {
                              toast.error('Введите адрес');
                              return;
                            }
                            setShareSource({ kind: 'custom', host: v });
                            setUrlPickerOpen(false);
                          }}
                          tunnel={tunnel}
                          tunnelBusy={tunnelBusy}
                          onTunnelStart={handleTunnelStart}
                          onTunnelStop={handleTunnelStop}
                        />
                      </PopoverContent>
                    </Popover>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-10 rounded-lg shrink-0"
                      onClick={handleCopyLink}
                      aria-label="Скопировать ссылку"
                    >
                      {copiedLink
                        ? <Check className="size-4" style={{ color: PLAYER_COLOR }} />
                        : <Link2 className="size-4" />}
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-10 rounded-lg shrink-0"
                      onClick={() => setShowQr((v) => !v)}
                      aria-label="Показать QR-код"
                    >
                      <QrCode className="size-4" />
                    </Button>
                  </div>
                  {showQr && qrDataUrl && (
                    <div className="flex flex-col items-center gap-1.5 pt-1 animate-slide-down">
                      <img
                        src={qrDataUrl}
                        alt={`QR-код для подключения к комнате ${networkRoomId}`}
                        className="rounded-lg"
                        style={{ width: 180, height: 180, border: '1px solid var(--fate-border)' }}
                      />
                      <p className="text-[10px] text-center" style={{ color: 'var(--fate-text-muted)' }}>
                        Наведите камеру телефона, чтобы открыть комнату
                      </p>
                    </div>
                  )}
                </div>
              </div>

              <Separator />

              {/* Peer list */}
              <div className="space-y-2">
                <Label
                  className="text-xs font-medium flex items-center gap-1.5"
                  style={{ color: 'var(--fate-text-muted)' }}
                >
                  <Users className="size-3.5" />
                  Участники ({peerCount})
                </Label>
                {networkRole === 'host' && characters.length === 0 && (
                  <p
                    className="text-[10px] px-1 leading-snug"
                    style={{ color: 'var(--fate-text-muted)' }}
                  >
                    💡 В приключении пока нет персонажей. Создайте их в библиотеке, чтобы назначить игрокам.
                  </p>
                )}
                {networkRole === 'host' && characters.length > 0 && !hasScene && (
                  <p
                    className="text-[10px] px-1 leading-snug"
                    style={{ color: 'var(--fate-text-muted)' }}
                  >
                    💡 Назначения работают и без сцены, но сохранятся между сессиями только при открытой сцене.
                  </p>
                )}
                <ScrollArea
                  className="max-h-[240px] rounded-lg"
                  style={{ border: '1px solid var(--fate-border)' }}
                >
                  <div className="p-2 space-y-1.5">
                    {/* Self row */}
                    <div
                      className="flex items-center gap-2 p-2 rounded-md"
                      style={{ backgroundColor: 'rgba(230, 126, 34, 0.06)' }}
                    >
                      <div
                        className="size-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                        style={{
                          backgroundColor: networkRole === 'host' ? HOST_COLOR : PLAYER_COLOR,
                          color: 'white',
                        }}
                      >
                        {(displayName || '?').slice(0, 1).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate" style={{ color: 'var(--fate-text)' }}>
                          {displayName} <span className="opacity-60">(Вы)</span>
                        </div>
                        <div className="text-[10px]" style={{ color: 'var(--fate-text-muted)' }}>
                          {networkRole === 'host' ? 'Мастер' : 'Игрок'}
                        </div>
                      </div>
                    </div>

                    {/* Other peers (host sees all players; player list is empty in MVP) */}
                    {Object.values(networkPeers).map((p) => {
                      const assignedIds = playerAssignments[p.peerId] ?? [];
                      // updateRoster: replace this peer's full controlled roster
                      // and broadcast the new list to every affected player.
                      // setPeerCharacters enforces exclusivity (a PC assigned to
                      // this peer is stripped from all others in the host's
                      // store) — so we must broadcast the UPDATED roster to every
                      // peer whose list changed, not just the target peer.
                      // Otherwise a player whose PC was silently taken away never
                      // learns about it until a full state resync.
                      const updateRoster = async (next: string[]) => {
                        const prev = assignedIds;
                        // Snapshot every peer's roster BEFORE the change so we
                        // can diff afterwards and notify exactly the peers whose
                        // roster actually changed.
                        const before = { ...playerAssignments };
                        await setPeerCharacters(p.peerId, next);
                        const after = useFateStore.getState().playerAssignments;
                        for (const [pid, ids] of Object.entries(after)) {
                          const beforeIds = before[pid] ?? [];
                          if (JSON.stringify(beforeIds) !== JSON.stringify(ids)) {
                            broadcastAssignment(pid, ids);
                          }
                        }
                        const added = next.find((id) => !prev.includes(id));
                        const removed = prev.find((id) => !next.includes(id));
                        if (added) {
                          const c = characters.find((ch) => ch.id === added);
                          toast.success(`«${p.displayName}» → ${c?.name ?? '?'}`);
                        } else if (removed) {
                          const c = characters.find((ch) => ch.id === removed);
                          toast.info(`С игрока «${p.displayName}» снят ${c?.name ?? '?'}`);
                        }
                      };
                      return (
                      <div
                        key={p.peerId}
                        className="p-2 rounded-md space-y-1.5"
                        style={{ backgroundColor: 'var(--fate-bg-card)' }}
                      >
                        <div className="flex items-center gap-2">
                          <div
                            className="size-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                            style={{ backgroundColor: '#7f8c8d', color: 'white' }}
                          >
                            {(p.displayName || '?').slice(0, 1).toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div
                              className="text-sm font-medium truncate"
                              style={{ color: 'var(--fate-text)' }}
                            >
                              {p.displayName || 'Безымянный'}
                            </div>
                            <div
                              className="text-[10px] flex items-center gap-1.5"
                              style={{ color: 'var(--fate-text-muted)' }}
                            >
                              <span>
                                {p.role === 'host' ? 'Мастер' : 'Игрок'}
                                {assignedIds.length > 0 && ` · ${assignedIds.length} персонаж(ей)`}
                              </span>
                              {(() => {
                                // Per-peer latency indicator: green/amber/red dot
                                // based on RTT, with the value shown on hover.
                                const ping = peerLatencies[p.peerId];
                                const lastSeen = peerLastSeen[p.peerId];
                                const now = Date.now();
                                const isStale = !lastSeen || (now - lastSeen > 30000);
                                if (isStale && p.peerId !== networkMyPeerId) {
                                  return (
                                    <span
                                      className="inline-flex items-center gap-0.5"
                                      title="Нет ответа более 30 сек — возможно, игрок отключился"
                                    >
                                      <span className="size-1.5 rounded-full bg-gray-400" />
                                      <span className="opacity-60">offline</span>
                                    </span>
                                  );
                                }
                                if (typeof ping !== 'number') return null;
                                let color = '#10b981'; // emerald — good (<100ms)
                                if (ping > 300) color = '#ef4444'; // red — poor
                                else if (ping > 100) color = '#f59e0b'; // amber — acceptable
                                return (
                                  <span
                                    className="inline-flex items-center gap-0.5"
                                    title={`Пинг до игрока: ${ping} мс`}
                                  >
                                    <span
                                      className="size-1.5 rounded-full"
                                      style={{ backgroundColor: color }}
                                    />
                                    <span>{ping} мс</span>
                                  </span>
                                );
                              })()}
                            </div>
                          </div>
                          {/* Forget peer button (host only) — removes stale
                              latency/lastSeen entries when a peer has silently
                              disconnected. Does not kick the peer; just clears
                              local bookkeeping. */}
                          {networkRole === 'host' && (
                            <button
                              type="button"
                              onClick={() => forgetPeer(p.peerId)}
                              className="text-[10px] opacity-40 hover:opacity-100 hover:text-red-500 transition-opacity px-1"
                              title="Очистить метрики пира (пинг/lastSeen)"
                              aria-label="Очистить метрики пира"
                            >
                              ×
                            </button>
                          )}
                        </div>

                        {/* Host: multi-character roster (PC only).
                            A player may control several PCs at once, but each
                            PC belongs to exactly one player — assigning it to
                            a second player automatically removes it from the
                            first (exclusivity enforced in setPeerCharacters).
                            Each assigned PC is a removable green badge; a «+»
                            button opens a popover checklist of all PCs. */}
                        {networkRole === 'host' && (
                          <div className="space-y-1.5">
                            {assignedIds.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {assignedIds.map((cid) => {
                                  const c = characters.find((ch) => ch.id === cid);
                                  if (!c) return null;
                                  return (
                                    <Badge
                                      key={cid}
                                      variant="outline"
                                      className="text-[10px] gap-1 pl-1.5 pr-1 py-0 font-medium"
                                      style={{
                                        borderColor: `${PLAYER_COLOR}40`,
                                        color: PLAYER_COLOR,
                                        backgroundColor: `${PLAYER_COLOR}10`,
                                      }}
                                    >
                                      <span className="opacity-70 font-semibold">PC</span>
                                      <span className="truncate max-w-[100px]">{c.name}</span>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          updateRoster(assignedIds.filter((x) => x !== cid))
                                        }
                                        className="rounded-sm hover:bg-black/10 dark:hover:bg-white/10 p-0.5"
                                        aria-label={`Снять ${c.name}`}
                                      >
                                        <X className="size-2.5" />
                                      </button>
                                    </Badge>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="text-[10px] opacity-60">
                                Персонажи не назначены
                              </div>
                            )}

                            <Popover>
                              <PopoverTrigger asChild>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 w-full text-xs rounded-md gap-1"
                                  style={{ borderColor: 'var(--fate-border)' }}
                                >
                                  <Plus className="size-3" />
                                  Добавить персонажа
                                </Button>
                              </PopoverTrigger>
                              <PopoverContent
                                className="w-60 p-1 max-h-72 overflow-y-auto"
                                align="start"
                              >
                                {playerChars.length === 0 ? (
                                  <div className="px-2 py-3 text-center text-xs opacity-60">
                                    В приключении нет персонажей игроков (PC)
                                  </div>
                                ) : (
                                  <>
                                    <div className="px-2 py-1 text-[10px] uppercase tracking-wide opacity-60">
                                      Игроки (PC)
                                    </div>
                                    {playerChars.map((c) => {
                                      const checked = assignedIds.includes(c.id);
                                      // If this PC is assigned to a DIFFERENT peer, surface it
                                      // so the host sees the exclusivity conflict before reassigning.
                                      const ownerPeerId = Object.entries(playerAssignments)
                                        .find(([pid, ids]) => pid !== p.peerId && ids.includes(c.id))?.[0];
                                      const ownerPeer = ownerPeerId
                                        ? Object.values(networkPeers).find((pp) => pp.peerId === ownerPeerId)
                                        : null;
                                      const isOwn = checked; // already on this peer's roster
                                      const isTaken = !checked && !!ownerPeer; // on someone else's roster
                                      return (
                                        <button
                                          key={c.id}
                                          type="button"
                                          onClick={() =>
                                            updateRoster(
                                              checked
                                                ? assignedIds.filter((x) => x !== c.id)
                                                : [...assignedIds, c.id],
                                            )
                                          }
                                          className={`flex items-center gap-2 px-2 py-1.5 w-full text-left text-xs rounded-sm hover:bg-accent ${
                                            isTaken ? 'opacity-50' : ''
                                          }`}
                                          style={{ color: 'var(--fate-text)' }}
                                          title={
                                            isOwn
                                              ? `Назначен этому игроку. Клик — снять.`
                                              : isTaken
                                                ? `Сейчас у: ${ownerPeer?.displayName ?? '?'}. Клик — переназначить (будет снят с текущего игрока).`
                                                : `Доступен для назначения.`
                                          }
                                        >
                                          <span
                                            className="size-3.5 rounded-[3px] border flex items-center justify-center shrink-0"
                                            style={
                                              checked
                                                ? {
                                                    backgroundColor: 'var(--fate-accent)',
                                                    borderColor: 'var(--fate-accent)',
                                                  }
                                                : { borderColor: 'var(--fate-border)' }
                                            }
                                          >
                                            {checked && (
                                              <Check className="size-2.5" style={{ color: 'white' }} />
                                            )}
                                          </span>
                                          <span className={`truncate flex-1 ${isTaken ? 'line-through' : ''}`}>
                                            {c.name}
                                          </span>
                                          {isOwn && (
                                            <span
                                              className="text-[9px] px-1 rounded shrink-0 font-semibold"
                                              style={{ color: PLAYER_COLOR }}
                                            >
                                              ✓ мой
                                            </span>
                                          )}
                                          {isTaken && (
                                            <span
                                              className="text-[9px] px-1 rounded shrink-0"
                                              style={{ color: 'var(--fate-text-muted)' }}
                                            >
                                              ← {ownerPeer?.displayName ?? '?'}
                                            </span>
                                          )}
                                        </button>
                                      );
                                    })}
                                  </>
                                )}
                              </PopoverContent>
                            </Popover>
                          </div>
                        )}
                      </div>
                      );
                    })}

                    {/* Player view: show own assigned PCs (multi-assign) */}
                    {networkRole === 'player' && (
                      <div
                        className="p-2.5 rounded-md text-xs space-y-1.5"
                        style={{
                          backgroundColor: 'rgba(39, 174, 96, 0.06)',
                          border: `1px solid ${PLAYER_COLOR}30`,
                        }}
                      >
                        <div style={{ color: 'var(--fate-text-muted)' }}>
                          Ваши персонажи{myAssignedIds.length > 0 ? ` (${myAssignedIds.length})` : ''}:
                        </div>
                        {myAssignedIds.length > 0 ? (
                          <div className="flex flex-wrap gap-1">
                            {myAssignedIds.map((cid) => {
                              const c = characters.find((ch) => ch.id === cid);
                              if (!c) return null;
                              return (
                                <Badge
                                  key={cid}
                                  variant="outline"
                                  className="text-[10px] gap-1 px-1.5 py-0 font-medium"
                                  style={{
                                    borderColor: `${PLAYER_COLOR}40`,
                                    color: PLAYER_COLOR,
                                    backgroundColor: `${PLAYER_COLOR}10`,
                                  }}
                                >
                                  <span className="opacity-70 font-semibold">PC</span>
                                  <span className="truncate max-w-[120px]">{c.name}</span>
                                </Badge>
                              );
                            })}
                          </div>
                        ) : (
                          <div
                            className="text-sm font-medium"
                            style={{ color: 'var(--fate-text-muted)' }}
                          >
                            Не назначен
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>

              {/* Leave session */}
              <Button
                variant="outline"
                className="w-full rounded-lg gap-1.5"
                style={{ borderColor: `${DANGER_COLOR}50`, color: DANGER_COLOR }}
                onClick={handleLeave}
              >
                <LogOut className="size-4" />
                Покинуть сессию
              </Button>
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            className="rounded-lg"
            onClick={() => onOpenChange(false)}
          >
            Закрыть
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
