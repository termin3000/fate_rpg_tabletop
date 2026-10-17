const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, createWriteStream } = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createGateway } = require('./gateway.cjs');

const here = path.resolve(__dirname, '..');
const bundle = existsSync(path.join(here, 'server.js')) ? here : path.join(here, '.next/standalone');
const dataRoot = path.resolve(process.env.FATE_DATA_ROOT || here);
const noOpen = process.argv.includes('--no-open') || process.env.FATE_NO_BROWSER === '1';
const children = [];
let gateway;
let stopping = false;
let ready = false;
mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
const log = createWriteStream(path.join(dataRoot, 'logs/runtime.log'), { flags: 'a' });
function report(text) {
  const line = `[${new Date().toISOString()}] ${text}`;
  console.log(line);
  log.write(line + '\n');
}
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  report('Stopping Fate RPG services...');
  // Close localtunnel gracefully before terminating the Next process.
  if (children.length) {
    try { await fetch('http://127.0.0.1:3000/api/tunnel/stop', { method: 'POST', signal: AbortSignal.timeout(1500) }); } catch {}
  }
  for (const child of children) {
    try { if (child.connected) child.send('shutdown'); else child.kill(); } catch { child.kill(); }
  }
  const deadline = Date.now() + 2500;
  while (children.some(child => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  gateway?.shutdown();
  report('All services stopped.');
  log.end(() => process.exit(code));
}
function run(name, entry, env) {
  const child = spawn(process.execPath, [path.join(bundle, 'scripts/runtime-entry.cjs'), entry], {
    cwd: bundle, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => report(`${name}: ${chunk.toString().trimEnd().split('\n').map(line => line.length > 4000 ? '[long source line omitted]' : line).join('\n')}`));
  child.on('error', error => { report(`${name}: ${error.message}`); void stop(1); });
  child.on('exit', code => { if (!stopping) { report(`${name} exited (${code}).`); void stop(1); } });
}
async function portFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Port ${port} is already in use. Close the previous Fate RPG instance.`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
function openBrowser() {
  const url = 'http://localhost:3008';
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(command, [url], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => report(`Open ${url} in your browser.`));
  browser.unref();
}
async function main() {
  if (!existsSync(path.join(bundle, 'server.js'))) throw new Error('Production build missing. Run npm run build first.');
  if (process.env.FATE_LAUNCHER_WAIT === '1') {
    // The native launcher attaches this process to its Windows Job first.
    await new Promise(resolve => process.stdin.once('data', resolve));
  }
  for (const port of [3000, 3004, 3006, 3008]) await portFree(port);
  require(path.join(bundle, 'node_modules/@next/env')).loadEnvConfig(dataRoot, false);
  let databaseUrl = process.env.DATABASE_URL || 'file:../db/custom.db';
  if (databaseUrl.startsWith('file:')) {
    const filename = databaseUrl.slice(5);
    const absolute = path.isAbsolute(filename) ? filename : path.resolve(dataRoot, 'prisma', filename);
    if (!existsSync(absolute)) throw new Error('Database file not found. Restore db/custom.db before starting.');
    databaseUrl = 'file:' + absolute.replaceAll('\\', '/');
  }
  const env = { ...process.env, DATABASE_URL: databaseUrl, FATE_DATA_ROOT: dataRoot, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', HOSTNAME: '127.0.0.1', PORT: '3000' };
  // Do not pass the native launch handshake to children.
  delete env.FATE_LAUNCHER_WAIT;
  run('signaling', path.join(bundle, 'mini-services/signaling/dist/index.cjs'), env);
  run('physics', path.join(bundle, 'mini-services/physics-service/dist/index.cjs'), env);
  run('next', path.join(bundle, 'server.js'), env);
  gateway = createGateway({ onShutdown: () => void stop(), getStatus: () => ({ ready }) });
  gateway.on('error', error => { report(error.message); void stop(1); });
  await new Promise(resolve => gateway.listen(3008, '0.0.0.0', resolve));
  const deadline = Date.now() + 30000;
  while (!stopping) {
    try {
      const responses = await Promise.all([['3000', '/api'], ['3004', '/health'], ['3006', '/health']].map(([port, route]) => fetch(`http://127.0.0.1:${port}${route}`, { signal: AbortSignal.timeout(1000) })));
      if (responses.every(response => response.ok)) { ready = true; break; }
    } catch {}
    if (Date.now() > deadline) throw new Error('Services did not become ready in 30 seconds. See logs/runtime.log.');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (ready && !stopping) {
    report('READY http://localhost:3008');
    if (!noOpen) openBrowser();
  }
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
process.on('uncaughtException', error => { report(error.stack || error.message); void stop(1); });
process.on('unhandledRejection', error => { report(String(error)); void stop(1); });
main().catch(error => { report(error.message); void stop(1); });
