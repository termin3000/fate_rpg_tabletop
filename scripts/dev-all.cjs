const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const localBun = path.join(root, '.tools/node_modules/bun/bin', process.platform === 'win32' ? 'bun.exe' : 'bun');
const bun = existsSync(localBun) ? localBun : 'bun';
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 300);
}
function run(command, args, cwd = root) {
  const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: true });
  children.push(child);
  child.on('error', error => { console.error(error.message); stop(1); });
  child.on('exit', code => { if (!stopping) stop(code ?? 1); });
}
run(bun, ['run', 'index.ts'], path.join(root, 'mini-services/signaling'));
run(bun, ['run', 'index.ts'], path.join(root, 'mini-services/physics-service'));
run(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'dev', '-p', '3000', '--webpack']);
run(process.execPath, [path.join(__dirname, 'gateway.cjs')]);
console.log('Open http://localhost:3008 — Network → Create room → Internet link (localtunnel).');
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
