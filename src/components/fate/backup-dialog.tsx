'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  Clock,
  Database,
  Download,
  FileArchive,
  FileJson,
  HardDrive,
  History,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Upload,
  XCircle,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';

interface SnapshotFile {
  file: string;
  size: number;
  sha256: string | null;
  verified: 'ok' | 'mismatch' | 'missing' | 'no-checksum';
}

interface Snapshot {
  timestamp: string;
  db?: SnapshotFile;
  data?: SnapshotFile & { counts?: Record<string, number> };
  src?: SnapshotFile;
  integrity: {
    ok: number;
    total: number;
    status: 'verified' | 'partial' | 'failed' | 'unknown';
  };
}

interface BackupListResponse {
  snapshots: Snapshot[];
  total: number;
  lastUpdated: string | null;
  retention: { hourly: number; daily: number; weekly: number };
  diskUsageBytes: number;
  diskUsageHuman: string;
  currentDbSize: number;
  currentDbModified: string | null;
  nextSnapshotIn: string | null;
}

interface VerifyFileResult {
  file: string;
  size: number;
  expected: string | null;
  actual: string | null;
  status: 'ok' | 'mismatch' | 'missing' | 'no-checksum';
  durationMs: number;
}

interface VerifyResponse {
  ts: string;
  results: Record<string, VerifyFileResult>;
  overall: 'verified' | 'partial' | 'failed' | 'unknown';
  ok: number;
  total: number;
  summary: string;
}

interface BackupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function formatTimestamp(ts: string): { date: string; time: string; relative: string } {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})$/);
  if (!m) return { date: ts, time: '', relative: '' };
  const [, y, mo, d, h, mi] = m;
  const date = `${y}-${mo}-${d}`;
  const time = `${h}:${mi}`;
  const then = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi)));
  const now = new Date();
  const diffMs = now.getTime() - then.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  let relative: string;
  if (diffMin < 1) relative = 'только что';
  else if (diffMin < 60) relative = `${diffMin} мин назад`;
  else if (diffHr < 24) relative = `${diffHr} ч назад`;
  else relative = `${diffDay} дн назад`;
  return { date, time, relative };
}

function shortHash(h: string | null): string {
  if (!h) return '—';
  return h.slice(0, 8) + '…' + h.slice(-4);
}

const INTEGRITY_BADGE: Record<
  Snapshot['integrity']['status'],
  { label: string; icon: React.ReactNode; className: string }
> = {
  verified: {
    label: 'Целостность OK',
    icon: <ShieldCheck className="h-3 w-3" />,
    className: 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300 dark:border-emerald-800',
  },
  partial: {
    label: 'Частично',
    icon: <ShieldAlert className="h-3 w-3" />,
    className: 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800',
  },
  failed: {
    label: 'Нарушена',
    icon: <ShieldX className="h-3 w-3" />,
    className: 'bg-red-100 text-red-700 border-red-300 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800',
  },
  unknown: {
    label: 'Нет данных',
    icon: <ShieldAlert className="h-3 w-3" />,
    className: 'bg-muted text-muted-foreground border-border',
  },
};

export function BackupDialog({ open, onOpenChange }: BackupDialogProps) {
  const [data, setData] = useState<BackupListResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);
  const [activeTab, setActiveTab] = useState('snapshots');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/backups/list', { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setData(json);
    } catch (e) {
      console.error('Load backups error:', e);
      toast.error('Не удалось загрузить список резервных копий');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const handleDownload = async (ts: string, type: 'db' | 'data' | 'src' | 'bundle') => {
    const key = `${ts}:${type}`;
    setDownloading(key);
    try {
      const url = `/api/backups/download?type=${type}&ts=${encodeURIComponent(ts)}&verify=1`;
      const res = await fetch(url);
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      const cd = res.headers.get('Content-Disposition') || '';
      const fnameMatch = cd.match(/filename="([^"]+)"/);
      a.download = fnameMatch
        ? fnameMatch[1]
        : `backup-${ts}.${type === 'data' ? 'json' : type === 'src' || type === 'bundle' ? 'zip' : 'db'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
      toast.success(
        `Скачивание ${type === 'bundle' ? 'архива' : type === 'db' ? 'БД' : type === 'data' ? 'JSON' : 'кода'} начато`,
      );
    } catch (e) {
      console.error('Download error:', e);
      toast.error(`Ошибка скачивания: ${e instanceof Error ? e.message : 'неизвестная'}`);
    } finally {
      setDownloading(null);
    }
  };

  const handleDownloadLatest = async () => {
    if (!data?.snapshots.length) return;
    const latest = data.snapshots[0];
    await handleDownload(latest.timestamp, 'bundle');
  };

  const handleDownloadLatestBundle = async () => {
    try {
      setDownloading('latest-bundle');
      const res = await fetch('/api/backups/latest?type=bundle');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      // Prefer the filename from Content-Disposition; fall back to a sensible name.
      const cd = res.headers.get('Content-Disposition') || '';
      const fnameMatch = cd.match(/filename="([^"]+)"/);
      a.download = fnameMatch ? fnameMatch[1] : 'fate-rpg-bundle-latest.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const ts = res.headers.get('X-Backup-Timestamp');
      const sizeKb = Math.round(blob.size / 1024);
      toast.success(
        `Bundle скачан${ts ? ` (снапшот ${ts})` : ''} — ${sizeKb} KB. Сохраните его в надёжном месте.`,
        { duration: 6000 },
      );
    } catch (e: any) {
      console.error('Latest bundle download error:', e);
      toast.error(`Не удалось скачать bundle: ${e.message}`, { duration: 8000 });
    } finally {
      setDownloading(null);
    }
  };

  const handleDownloadMirror = async () => {
    try {
      setDownloading('mirror');
      const res = await fetch('/api/backups/latest?type=mirror');
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const cd = res.headers.get('Content-Disposition') || '';
      const fnameMatch = cd.match(/filename="([^"]+)"/);
      a.download = fnameMatch ? fnameMatch[1] : 'source-mirror.zip';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      const ts = res.headers.get('X-Backup-Timestamp');
      const sizeKb = Math.round(blob.size / 1024);
      toast.success(
        `Зеркало кода скачано${ts ? ` (снапшот ${ts})` : ''} — ${sizeKb} KB`,
        { duration: 6000 },
      );
    } catch (e: any) {
      console.error('Mirror download error:', e);
      toast.error(`Не удалось скачать зеркало: ${e.message}`, { duration: 8000 });
    } finally {
      setDownloading(null);
    }
  };

  const handleUploadBundle = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      setUploading(true);
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/backups/restore-upload', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }

      const result = await res.json();
      toast.success(
        `Bundle загружен: ${file.name} (${result.size}KB). Скажите ассистенту: "восстанови из upload/${file.name}"`,
        { duration: 10000 },
      );
    } catch (err: any) {
      console.error('Upload error:', err);
      toast.error(`Ошибка загрузки: ${err.message}`);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleCreateSnapshot = async () => {
    setCreatingSnapshot(true);
    try {
      const res = await fetch('/api/backups/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'manual-ui' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const result = await res.json();
      toast.success(
        `Создание снапшота запущено (job #${result.jobId}). Было ${result.beforeCount}, обновите список через 5-10 сек.`,
        { duration: 6000 },
      );
      // Auto-refresh after a delay to pick up the new snapshot
      setTimeout(() => {
        load();
      }, 7000);
    } catch (e: any) {
      console.error('Create snapshot error:', e);
      toast.error(`Ошибка: ${e.message}`);
    } finally {
      setCreatingSnapshot(false);
    }
  };

  const snapshots = data?.snapshots ?? [];
  const latest = snapshots[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl max-h-[92vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-xl">
            <Shield className="h-5 w-5 text-emerald-600" />
            Защита данных
          </DialogTitle>
          <DialogDescription>
            Иммутабельные снапшоты. Каждый час создаётся отдельная копия БД, данных и исходного
            кода с SHA-256 контрольной суммой. Можно восстановиться из любого снапшота.
          </DialogDescription>
        </DialogHeader>

        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryCard
            icon={<ShieldCheck className="h-4 w-4" />}
            label="Снапшотов"
            value={data?.total?.toString() ?? '—'}
            sub={data?.nextSnapshotIn ? `следующий: ${data.nextSnapshotIn}` : undefined}
            tone="emerald"
          />
          <SummaryCard
            icon={<HardDrive className="h-4 w-4" />}
            label="Объём бэкапов"
            value={data?.diskUsageHuman ?? '—'}
            sub={data?.currentDbSize ? `живая БД: ${formatBytes(data.currentDbSize)}` : undefined}
            tone="sky"
          />
          <SummaryCard
            icon={<Clock className="h-4 w-4" />}
            label="Последний"
            value={latest ? formatTimestamp(latest.timestamp).relative : '—'}
            sub={latest ? latest.timestamp : undefined}
            tone="violet"
          />
          <SummaryCard
            icon={<Calendar className="h-4 w-4" />}
            label="Retention"
            value={data ? `${data.retention.hourly / 24}д/${data.retention.daily}д/${data.retention.weekly}н` : '—'}
            sub="час/день/неделя"
            tone="amber"
          />
        </div>

        {/* Quick actions bar */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" onClick={handleCreateSnapshot} disabled={creatingSnapshot}>
            {creatingSnapshot ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Создать снапшот сейчас
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleDownloadLatest}
            disabled={!latest || downloading === `${latest?.timestamp}:bundle`}
          >
            {downloading === `${latest?.timestamp}:bundle` ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Download className="h-4 w-4" />
            )}
            Скачать последний архив
          </Button>
          {latest && (
            <span className="text-[11px] text-muted-foreground">
              снапшот: <code className="font-mono">{latest.timestamp}</code>
              {latest.data?.counts && (
                <span className="ml-1 opacity-70">
                  · {latest.data.counts.characters ?? 0} перс., {latest.data.counts.logEntries ?? 0} записей
                </span>
              )}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Обновить
          </Button>
        </div>

        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className="w-full flex-1 min-h-0 flex flex-col"
        >
          <TabsList className="grid grid-cols-4 w-full shrink-0">
            <TabsTrigger value="snapshots" className="text-xs gap-1">
              <History className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">История</span>
              {snapshots.length > 0 && (
                <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
                  {snapshots.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="restore" className="text-xs gap-1">
              <RotateCcw className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Восстановление</span>
            </TabsTrigger>
            <TabsTrigger value="integrity" className="text-xs gap-1">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Целостность</span>
            </TabsTrigger>
            <TabsTrigger value="emergency" className="text-xs gap-1">
              <ShieldAlert className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Экстренно</span>
            </TabsTrigger>
          </TabsList>

          {/* TAB: Snapshots history */}
          <TabsContent value="snapshots" className="flex-1 min-h-0 flex flex-col mt-2">
            <ScrollArea className="flex-1 max-h-[440px] pr-2">
              {snapshots.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <ShieldAlert className="h-10 w-10 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">Снапшоты пока не созданы</p>
                  <p className="text-xs mt-1">Они появляются автоматически каждый час.</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {snapshots.map((snap) => {
                    const ts = formatTimestamp(snap.timestamp);
                    const counts = snap.data?.counts;
                    const badge = INTEGRITY_BADGE[snap.integrity.status];
                    return (
                      <div
                        key={snap.timestamp}
                        className="rounded-lg border p-3 hover:bg-accent/40 transition-colors"
                      >
                        <div className="flex items-start justify-between gap-3 flex-wrap">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-mono text-sm font-semibold">{snap.timestamp}</span>
                              <Badge variant="outline" className="text-xs">{ts.relative}</Badge>
                              <Badge variant="outline" className={`text-xs ${badge.className}`}>
                                {badge.icon}
                                {badge.label}
                              </Badge>
                            </div>
                            <div className="mt-1.5 flex flex-wrap gap-2 text-xs text-muted-foreground">
                              {snap.db && (
                                <span className="flex items-center gap-1">
                                  <Database className="h-3 w-3" />
                                  БД: {formatBytes(snap.db.size)}
                                </span>
                              )}
                              {snap.data && (
                                <span className="flex items-center gap-1">
                                  <FileJson className="h-3 w-3" />
                                  JSON: {formatBytes(snap.data.size)}
                                </span>
                              )}
                              {snap.src && (
                                <span className="flex items-center gap-1">
                                  <FileArchive className="h-3 w-3" />
                                  Код: {formatBytes(snap.src.size)}
                                </span>
                              )}
                            </div>
                            {counts && (
                              <div className="mt-1 text-xs text-muted-foreground">
                                Прикл.: {counts.adventures ?? 0} · Персонажей: {counts.characters ?? 0} · Сцен: {counts.scenes ?? 0} · Логов: {counts.logEntries ?? 0}
                              </div>
                            )}
                            {snap.db?.sha256 && (
                              <div className="mt-0.5 text-[10px] font-mono text-muted-foreground/70">
                                SHA: {shortHash(snap.db.sha256)}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => handleDownload(snap.timestamp, 'db')}
                              disabled={!snap.db || downloading === `${snap.timestamp}:db`}
                              title="Скачать SQLite базу данных"
                            >
                              {downloading === `${snap.timestamp}:db` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Database className="h-3 w-3" />
                              )}
                              БД
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => handleDownload(snap.timestamp, 'data')}
                              disabled={!snap.data || downloading === `${snap.timestamp}:data`}
                              title="Скачать JSON-экспорт данных"
                            >
                              {downloading === `${snap.timestamp}:data` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <FileJson className="h-3 w-3" />
                              )}
                              JSON
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2 text-xs"
                              onClick={() => handleDownload(snap.timestamp, 'src')}
                              disabled={!snap.src || downloading === `${snap.timestamp}:src`}
                              title="Скачать архив исходного кода"
                            >
                              {downloading === `${snap.timestamp}:src` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <FileArchive className="h-3 w-3" />
                              )}
                              Код
                            </Button>
                            <Button
                              size="sm"
                              className="h-7 px-3 text-xs"
                              onClick={() => handleDownload(snap.timestamp, 'bundle')}
                              disabled={downloading === `${snap.timestamp}:bundle`}
                              title="Скачать всё одним архивом"
                            >
                              {downloading === `${snap.timestamp}:bundle` ? (
                                <Loader2 className="h-3 w-3 animate-spin" />
                              ) : (
                                <Download className="h-3 w-3" />
                              )}
                              Всё
                            </Button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>

          {/* TAB: Restore */}
          <TabsContent value="restore" className="flex-1 min-h-0 flex flex-col mt-2">
            <RestoreTab snapshots={snapshots} onRestored={load} />
          </TabsContent>

          {/* TAB: Integrity */}
          <TabsContent value="integrity" className="flex-1 min-h-0 flex flex-col mt-2">
            <IntegrityTab snapshots={snapshots} />
          </TabsContent>

          {/* TAB: Emergency */}
          <TabsContent value="emergency" className="flex-1 min-h-0 flex flex-col mt-2">
            <EmergencyTab
              onDownloadLatestBundle={handleDownloadLatestBundle}
              onDownloadMirror={handleDownloadMirror}
              onUploadBundle={handleUploadBundle}
              uploading={uploading}
              downloading={downloading}
              fileInputRef={fileInputRef}
            />
          </TabsContent>
        </Tabs>

        <Separator />

        {/* Footer info */}
        <div className="text-xs text-muted-foreground space-y-1">
          <p>
            <strong>Защита данных:</strong> снапшоты неизменяемые (immutable). Каждый час создаётся
            новая копия с SHA-256 контрольной суммой. Восстановление создаёт safety backup в{' '}
            <code className="px-1 py-0.5 rounded bg-muted">backups/pre-restore/</code>.
          </p>
          <p>
            <strong>Retention:</strong> почасовые — 7 дней, ежедневные — 30 дней, еженедельные — 12
            недель.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Summary card ──────────────────────────────────────────────

function SummaryCard({
  icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  tone: 'emerald' | 'sky' | 'violet' | 'amber';
}) {
  const toneClasses = {
    emerald: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300',
    sky: 'bg-sky-50 dark:bg-sky-950/30 border-sky-200 dark:border-sky-800 text-sky-700 dark:text-sky-300',
    violet: 'bg-violet-50 dark:bg-violet-950/30 border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300',
    amber: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300',
  };
  return (
    <div className={`rounded-lg border p-3 ${toneClasses[tone]}`}>
      <div className="flex items-center gap-1.5 text-xs opacity-80">
        {icon}
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold leading-tight">{value}</div>
      {sub && <div className="text-[10px] opacity-70 truncate">{sub}</div>}
    </div>
  );
}

// ── Restore tab ───────────────────────────────────────────────

function RestoreTab({
  snapshots,
  onRestored,
}: {
  snapshots: Snapshot[];
  onRestored: () => void;
}) {
  const [selectedTs, setSelectedTs] = useState<string | null>(null);
  const [mode, setMode] = useState<'db' | 'data' | 'both'>('db');
  const [restoring, setRestoring] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<any>(null);

  const selected = snapshots.find((s) => s.timestamp === selectedTs);

  const handleRestore = async () => {
    if (!selectedTs) return;
    setConfirmOpen(false);
    setRestoring(true);
    try {
      const res = await fetch('/api/backups/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts: selectedTs, mode, confirm: true }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      setResult(json);
      toast.success('Восстановление выполнено. Перезагрузите страницу (F5) для применения.');
      onRestored();
    } catch (e: any) {
      console.error('Restore error:', e);
      toast.error(`Ошибка восстановления: ${e.message}`);
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col gap-3 overflow-hidden">
      <div className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3">
        <div className="flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs space-y-1 text-amber-900 dark:text-amber-100">
            <p className="font-semibold">Восстановление перезаписывает живую БД</p>
            <p>
              Перед восстановлением автоматически создаётся safety backup в{' '}
              <code className="px-1 py-0.5 rounded bg-amber-100 dark:bg-amber-900">backups/pre-restore/</code>.
              Если что-то пойдёт не так — откатиться можно из него.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold text-muted-foreground">
          1. Выберите снапшот для восстановления
        </label>
        <ScrollArea className="h-[200px] rounded-lg border">
          <div className="p-2 space-y-1">
            {snapshots.length === 0 ? (
              <div className="text-center py-8 text-xs text-muted-foreground">
                Нет доступных снапшотов
              </div>
            ) : (
              snapshots.map((snap) => {
                const ts = formatTimestamp(snap.timestamp);
                const isSelected = selectedTs === snap.timestamp;
                const counts = snap.data?.counts;
                return (
                  <button
                    key={snap.timestamp}
                    onClick={() => setSelectedTs(snap.timestamp)}
                    className={`w-full text-left rounded-md p-2 text-xs transition-colors border ${
                      isSelected
                        ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/40'
                        : 'border-transparent hover:bg-accent'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-semibold">{snap.timestamp}</span>
                      <span className="text-muted-foreground">{ts.relative}</span>
                    </div>
                    {counts && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        Прикл: {counts.adventures ?? 0} · Персонажей: {counts.characters ?? 0} · Сцен: {counts.scenes ?? 0} · Логов: {counts.logEntries ?? 0}
                      </div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold text-muted-foreground">
          2. Что восстановить
        </label>
        <div className="grid grid-cols-3 gap-2">
          {([
            { value: 'db', label: 'Только БД', desc: 'SQLite файл целиком' },
            { value: 'data', label: 'Только JSON', desc: 'Только данные в public/' },
            { value: 'both', label: 'БД + JSON', desc: 'Полное восстановление' },
          ] as const).map((opt) => (
            <button
              key={opt.value}
              onClick={() => setMode(opt.value)}
              className={`rounded-lg border p-2 text-left text-xs transition-colors ${
                mode === opt.value
                  ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-950/40'
                  : 'hover:bg-accent'
              }`}
            >
              <div className="font-semibold">{opt.label}</div>
              <div className="text-[10px] text-muted-foreground">{opt.desc}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          onClick={() => setConfirmOpen(true)}
          disabled={!selectedTs || restoring}
        >
          {restoring ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4" />
          )}
          Восстановить из снапшота
        </Button>
        {selected && (
          <span className="text-xs text-muted-foreground">
            Выбран: <span className="font-mono font-semibold">{selected.timestamp}</span>
          </span>
        )}
      </div>

      {result && (
        <div className="rounded-lg border border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/30 p-3 text-xs space-y-1 max-h-[150px] overflow-auto">
          <div className="font-semibold flex items-center gap-1 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            Восстановление выполнено
          </div>
          <div className="text-emerald-900 dark:text-emerald-100 space-y-1">
            <div>
              <strong>Восстановлено:</strong>
              <ul className="ml-4 list-disc">
                {result.restoredFiles?.map((f: string, i: number) => (
                  <li key={i} className="font-mono text-[10px]">{f}</li>
                ))}
              </ul>
            </div>
            {result.safetyBackup?.files?.length > 0 && (
              <div>
                <strong>Safety backup:</strong>
                <ul className="ml-4 list-disc">
                  {result.safetyBackup.files.map((f: string, i: number) => (
                    <li key={i} className="font-mono text-[10px]">{f.split('/').slice(-2).join('/')}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="text-[10px] italic mt-1">{result.nextStep}</div>
          </div>
        </div>
      )}

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-600" />
              Подтвердите восстановление
            </AlertDialogTitle>
            <AlertDialogDescription>
              Это перезапишет текущую базу данных данными из снапшота{' '}
              <code className="px-1 py-0.5 rounded bg-muted">{selectedTs}</code>.
              <br />
              <br />
              Режим: <strong>{mode === 'db' ? 'только БД' : mode === 'data' ? 'только JSON' : 'БД + JSON'}</strong>
              <br />
              Автоматически будет создан safety backup текущего состояния.
              <br />
              <br />
              <span className="text-amber-600 dark:text-amber-400 font-medium">
                Это необратимая операция. Продолжить?
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRestore}
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              <RotateCcw className="h-4 w-4 mr-1" />
              Восстановить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Integrity tab ─────────────────────────────────────────────

function IntegrityTab({ snapshots }: { snapshots: Snapshot[] }) {
  const [verifying, setVerifying] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, VerifyResponse>>({});
  const [verifyAllRunning, setVerifyAllRunning] = useState(false);

  const handleVerifyOne = async (ts: string) => {
    setVerifying(ts);
    try {
      const res = await fetch('/api/backups/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ts }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      setResults((prev) => ({ ...prev, [ts]: json }));
      if (json.overall === 'verified') {
        toast.success(`${ts}: целостность подтверждена`);
      } else if (json.overall === 'failed') {
        toast.error(`${ts}: целостность НАРУШЕНА`);
      } else {
        toast.warning(`${ts}: частичная проверка (${json.ok}/${json.total})`);
      }
    } catch (e: any) {
      toast.error(`Ошибка проверки: ${e.message}`);
    } finally {
      setVerifying(null);
    }
  };

  const handleVerifyAll = async () => {
    setVerifyAllRunning(true);
    let ok = 0;
    let failed = 0;
    for (const snap of snapshots) {
      await handleVerifyOne(snap.timestamp);
      const r = results[snap.timestamp];
      if (r?.overall === 'verified') ok++;
      else if (r?.overall === 'failed') failed++;
    }
    setVerifyAllRunning(false);
    toast.success(`Проверка завершена: ${ok} OK, ${failed} нарушено`);
  };

  const verifiedCount = snapshots.filter((s) => s.integrity.status === 'verified').length;
  const partialCount = snapshots.filter((s) => s.integrity.status === 'partial').length;
  const failedCount = snapshots.filter((s) => s.integrity.status === 'failed').length;
  const unknownCount = snapshots.filter((s) => s.integrity.status === 'unknown').length;

  return (
    <div className="flex-1 flex flex-col gap-3 overflow-hidden">
      <div className="grid grid-cols-4 gap-2">
        <StatBox label="Verified" value={verifiedCount} tone="emerald" icon={<CheckCircle2 className="h-3 w-3" />} />
        <StatBox label="Partial" value={partialCount} tone="amber" icon={<ShieldAlert className="h-3 w-3" />} />
        <StatBox label="Failed" value={failedCount} tone="red" icon={<ShieldX className="h-3 w-3" />} />
        <StatBox label="Unknown" value={unknownCount} tone="muted" icon={<ShieldAlert className="h-3 w-3" />} />
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleVerifyAll}
          disabled={verifyAllRunning || snapshots.length === 0}
        >
          {verifyAllRunning ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
          Проверить все ({snapshots.length})
        </Button>
      </div>

      <ScrollArea className="flex-1 max-h-[380px] pr-2">
        <div className="space-y-1.5">
          {snapshots.length === 0 ? (
            <div className="text-center py-8 text-xs text-muted-foreground">
              Нет снапшотов для проверки
            </div>
          ) : (
            snapshots.map((snap) => {
              const r = results[snap.timestamp];
              const isVerifying = verifying === snap.timestamp;
              return (
                <div
                  key={snap.timestamp}
                  className="rounded-md border p-2 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs font-semibold">{snap.timestamp}</span>
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${INTEGRITY_BADGE[snap.integrity.status].className}`}
                      >
                        {INTEGRITY_BADGE[snap.integrity.status].icon}
                        {snap.integrity.ok}/{snap.integrity.total}
                      </Badge>
                      {r && (
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${
                            r.overall === 'verified'
                              ? 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-300'
                              : r.overall === 'failed'
                                ? 'bg-red-100 text-red-700 border-red-300 dark:bg-red-950/50 dark:text-red-300'
                                : 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-950/50 dark:text-amber-300'
                          }`}
                        >
                          {r.overall === 'verified' ? (
                            <CheckCircle2 className="h-2.5 w-2.5" />
                          ) : r.overall === 'failed' ? (
                            <XCircle className="h-2.5 w-2.5" />
                          ) : (
                            <ShieldAlert className="h-2.5 w-2.5" />
                          )}
                          re-verified
                        </Badge>
                      )}
                    </div>
                    {r && (
                      <div className="mt-1 grid grid-cols-3 gap-1 text-[10px]">
                        {(['db', 'data', 'src'] as const).map((type) => {
                          const file = r.results[type];
                          if (!file) return null;
                          return (
                            <div
                              key={type}
                              className={`px-1.5 py-0.5 rounded font-mono ${
                                file.status === 'ok'
                                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300'
                                  : file.status === 'mismatch'
                                    ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300'
                                    : 'bg-muted text-muted-foreground'
                              }`}
                            >
                              {type}: {file.status}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleVerifyOne(snap.timestamp)}
                    disabled={isVerifying}
                  >
                    {isVerifying ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-3 w-3" />
                    )}
                    Проверить
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function StatBox({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: number;
  tone: 'emerald' | 'amber' | 'red' | 'muted';
  icon: React.ReactNode;
}) {
  const tones = {
    emerald: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300',
    amber: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800 text-amber-700 dark:text-amber-300',
    red: 'bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800 text-red-700 dark:text-red-300',
    muted: 'bg-muted border-border text-muted-foreground',
  };
  return (
    <div className={`rounded-lg border p-2 ${tones[tone]}`}>
      <div className="flex items-center gap-1 text-[10px] opacity-80">
        {icon}
        {label}
      </div>
      <div className="text-lg font-bold">{value}</div>
    </div>
  );
}

// ── Emergency tab ─────────────────────────────────────────────

function EmergencyTab({
  onDownloadLatestBundle,
  onDownloadMirror,
  onUploadBundle,
  uploading,
  downloading,
  fileInputRef,
}: {
  onDownloadLatestBundle: () => void;
  onDownloadMirror: () => void;
  onUploadBundle: (e: React.ChangeEvent<HTMLInputElement>) => void;
  uploading: boolean;
  downloading: string | null;
  fileInputRef: React.RefObject<HTMLInputElement>;
}) {
  return (
    <div className="flex-1 overflow-auto pr-2 space-y-3">
      <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-xs space-y-1 text-red-900 dark:text-red-100">
            <p className="font-semibold">Экстренная защита</p>
            <p>
              Если sandbox откатил файлы или БД повреждена — скачайте архив ниже и сохраните его в
              надёжном месте. Это ваш последний рубеж восстановления.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        {/* Latest bundle (self-contained) */}
        <div className="flex items-center gap-2 p-3 rounded-lg border bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800">
          <FileArchive className="h-4 w-4 text-amber-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-amber-900 dark:text-amber-100">
              Свежий bundle (БД + код)
            </p>
            <p className="text-[10px] text-amber-700 dark:text-amber-300 truncate">
              Один файл для полного восстановления
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={onDownloadLatestBundle}
            disabled={downloading === 'latest-bundle'}
            className="h-7 px-2 text-xs"
          >
            {downloading === 'latest-bundle' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            Скачать
          </Button>
        </div>

        {/* Source mirror */}
        <div className="flex items-center gap-2 p-3 rounded-lg border bg-sky-50 dark:bg-sky-950/30 border-sky-200 dark:border-sky-800">
          <HardDrive className="h-4 w-4 text-sky-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-sky-900 dark:text-sky-100">
              Зеркало исходного кода
            </p>
            <p className="text-[10px] text-sky-700 dark:text-sky-300 truncate">
              Только src/, scripts/, mini-services/
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={onDownloadMirror}
            disabled={downloading === 'mirror'}
            className="h-7 px-2 text-xs"
          >
            {downloading === 'mirror' ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            Скачать
          </Button>
        </div>

        {/* Upload bundle for restore */}
        <div className="flex items-center gap-2 p-3 rounded-lg border bg-violet-50 dark:bg-violet-950/30 border-violet-200 dark:border-violet-800">
          <Upload className="h-4 w-4 text-violet-600 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-violet-900 dark:text-violet-100">
              Восстановить из bundle (ручной режим)
            </p>
            <p className="text-[10px] text-violet-700 dark:text-violet-300 truncate">
              Загрузите ранее скачанный .zip для восстановления
            </p>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip"
            onChange={onUploadBundle}
            className="hidden"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="h-7 px-2 text-xs"
          >
            {uploading ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Upload className="h-3 w-3" />
            )}
            Загрузить
          </Button>
        </div>
      </div>

      <Separator />

      <div className="text-xs text-muted-foreground space-y-2">
        <p className="font-semibold flex items-center gap-1">
          <ShieldCheck className="h-3 w-3 text-emerald-600" />
          Что делать при потере данных
        </p>
        <ol className="ml-4 list-decimal space-y-1 text-[11px]">
          <li>Скачайте свежий bundle (кнопка выше) — это БД + исходный код.</li>
          <li>Сохраните .zip в надёжном месте (Google Drive, USB, и т.д.).</li>
          <li>Если sandbox откатил файлы — загрузите .zip обратно через форму выше.</li>
          <li>Скажите ассистенту: «восстанови из upload/&lt;filename&gt;».</li>
          <li>Для превентивной защиты используйте вкладку «Восстановление» — откат к любому снапшоту.</li>
        </ol>
      </div>
    </div>
  );
}
