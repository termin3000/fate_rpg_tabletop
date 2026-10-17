import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export type TunnelStatus = 'idle' | 'starting' | 'running' | 'error';
interface TunnelState {
  status: TunnelStatus;
  url: string | null;
  error: string | null;
  pid: number | null;
  startedAt: number | null;
}
interface Controller {
  state: TunnelState;
  tunnel: ChildProcess | null;
  gateway: ChildProcess | null;
  pending: Promise<TunnelState> | null;
  generation: number;
}
const idle = (): TunnelState => ({ status: 'idle', url: null, error: null, pid: null, startedAt: null });
// Shared by all API routes and survives development module reloads.
const shared = globalThis as typeof globalThis & { fateLocalTunnel?: Controller };
const controller: Controller = shared.fateLocalTunnel ??= {
  state: idle(), tunnel: null, gateway: null, pending: null, generation: 0,
};

export function getTunnelState(): TunnelState { return { ...controller.state }; }

function launch(script: string): ChildProcess {
  const runtime = process.versions.bun ? 'node' : process.execPath;
  return spawn(runtime, [path.join(process.cwd(), 'scripts', script)], {
    cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
}

async function gatewayReady(): Promise<boolean> {
  try {
    const response = await fetch('http://127.0.0.1:3008/_fate/health', {
      signal: AbortSignal.timeout(500), cache: 'no-store',
    });
    const health = await response.json();
    return response.ok && health.service === 'fate-gateway' && health.appPort === 3000;
  } catch { return false; }
}

function disposeOwnedProcesses() {
  const { tunnel, gateway } = controller;
  controller.tunnel = null;
  controller.gateway = null;
  tunnel?.kill();
  gateway?.kill();
}

export function startTunnel(): Promise<TunnelState> {
  if (controller.pending) return controller.pending;
  if (controller.state.status === 'running') return Promise.resolve(getTunnelState());
  const generation = ++controller.generation;
  disposeOwnedProcesses();
  controller.state = { ...idle(), status: 'starting', startedAt: Date.now() };
  controller.pending = openTunnel(generation).finally(() => {
    if (generation === controller.generation) controller.pending = null;
  });
  return controller.pending;
}

async function openTunnel(generation: number): Promise<TunnelState> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!await gatewayReady()) {
      if (generation !== controller.generation) return getTunnelState();
      const gateway = launch('gateway.cjs');
      controller.gateway = gateway;
      let failure: string | null = null;
      gateway.on('error', error => { failure = error.message; });
      gateway.stderr?.on('data', chunk => { failure = String(chunk).trim(); });
      const deadline = Date.now() + 5000;
      while (!await gatewayReady()) {
        if (generation !== controller.generation) return getTunnelState();
        if (failure || gateway.exitCode !== null || Date.now() > deadline) {
          throw new Error(failure || 'Не удалось запустить игровой шлюз на порту 3008.');
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      gateway.on('exit', () => {
        if (generation !== controller.generation || controller.gateway !== gateway) return;
        controller.state = { ...controller.state, status: 'error', url: null, pid: null, error: 'Игровой шлюз остановлен.' };
        disposeOwnedProcesses();
      });
    }
    if (generation !== controller.generation) return getTunnelState();
    const child = launch('tunnel.cjs');
    controller.tunnel = child;
    controller.state.pid = child.pid ?? null;
    let output = '';
    let lastError = '';
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('localtunnel не вернул ссылку за 30 секунд. Проверьте доступ к localtunnel.me.')), 30000);
      child.stdout?.on('data', chunk => {
        output += chunk.toString();
        const lines = output.split('\n');
        output = lines.pop() ?? '';
        for (const line of lines) {
          try {
            const { url } = JSON.parse(line);
            if (generation !== controller.generation || controller.tunnel !== child) return;
            if (typeof url !== 'string' || !url.startsWith('https://')) continue;
            controller.state = { ...controller.state, status: 'running', url, error: null };
            clearTimeout(timeout);
            resolve();
          } catch { /* Ignore runtime diagnostics. */ }
        }
      });
      child.stderr?.on('data', chunk => { lastError = String(chunk).slice(-500); });
      child.on('error', reject);
      child.on('exit', code => {
        clearTimeout(timeout);
        const error = new Error(lastError || `localtunnel завершился с кодом ${code}.`);
        if (generation === controller.generation && controller.tunnel === child) {
          controller.state = { ...controller.state, status: 'error', url: null, pid: null, error: error.message };
          disposeOwnedProcesses();
        }
        reject(error);
      });
    });
  } catch (error) {
    if (generation === controller.generation) {
      controller.state = { ...controller.state, status: 'error', url: null, pid: null, error: error instanceof Error ? error.message : String(error) };
      disposeOwnedProcesses();
    }
  } finally {
    clearTimeout(timeout);
  }
  return getTunnelState();
}

export function stopTunnel(): TunnelState {
  ++controller.generation;
  disposeOwnedProcesses();
  controller.pending = null;
  controller.state = idle();
  return getTunnelState();
}
