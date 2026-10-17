'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Power } from 'lucide-react';
import { toast } from 'sonner';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from '@/components/ui/alert-dialog';
import { useFateStore } from '@/lib/store';
import { useNetwork } from '@/hooks/use-network';

const ExitContext = createContext<(() => void) | null>(null);

export function ExitApplicationMenuItem() {
  const requestExit = useContext(ExitContext);
  if (!requestExit) return null;
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={requestExit} className="gap-2 cursor-pointer text-destructive">
        <Power className="size-3.5" />
        <div className="flex flex-col">
          <span className="text-xs font-semibold">Выход</span>
          <span className="text-[10px] text-muted-foreground">Остановить приложение и сервисы</span>
        </div>
      </DropdownMenuItem>
    </>
  );
}

export function ExitApplication({ children }: { children: ReactNode }) {
  const role = useFateStore(state => state.networkRole);
  const { leaveSession } = useNetwork();
  const [token, setToken] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stopped, setStopped] = useState(false);
  useEffect(() => {
    if (!['localhost', '127.0.0.1'].includes(window.location.hostname)) return;
    let cancelled = false;
    fetch('/_fate/control').then(async response => {
      if (!response.ok) return;
      const control = await response.json();
      if (!cancelled && control.canShutdown && typeof control.token === 'string') setToken(control.token);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function exit() {
    if (!token || busy) return;
    setBusy(true);
    try {
      const response = await fetch('/_fate/shutdown', { method: 'POST', headers: { 'X-Fate-Control': token } });
      if (!response.ok) throw new Error('Сервер не подтвердил остановку');
      leaveSession();
      setStopped(true);
    } catch {
      toast.error('Не удалось остановить приложение. Закройте окно Fate RPG.');
    } finally { setBusy(false); setConfirm(false); }
  }
  if (stopped) return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-center justify-center gap-3 bg-background text-foreground">
      <Power className="size-10" />
      <h1 className="text-2xl font-bold">Приложение остановлено</h1>
      <p>Эту вкладку можно закрыть.</p>
    </div>
  );
  return (
    <ExitContext.Provider value={token && role !== 'player' ? () => setConfirm(true) : null}>
      {children}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Завершить работу Fate RPG?</AlertDialogTitle>
            <AlertDialogDescription>Приложение и сетевые сервисы остановятся. Подключённые игроки потеряют связь с мастером.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Отмена</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void exit(); }}>{busy ? 'Завершение…' : 'Выход'}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ExitContext.Provider>
  );
}
