const fs = require('node:fs/promises');
const path = require('node:path');
const ts = require('typescript');
// Use the same dependency tracer as this installed Next.js version.
const { nodeFileTrace } = require('next/dist/compiled/@vercel/nft');
const { execFileSync } = require('node:child_process');

async function main() {
  const root = path.resolve(__dirname, '..');
  const target = path.join(root, '.next/standalone');
  for (const name of ['signaling', 'physics-service']) {
    let source = await fs.readFile(path.join(root, 'mini-services', name, 'index.ts'), 'utf8');
    // Rapier 0.15 labels its .cjs.js entry as ESM. Node 22 can require its
    // actual ESM build; select that entry without changing physics behavior.
    if (name === 'physics-service') source = source.replace('from "@dimforge/rapier3d-compat"', 'from "@dimforge/rapier3d-compat/rapier.es.js"');
    const output = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
      fileName: 'index.ts',
    });
    const dest = path.join(root, 'mini-services', name, 'dist/index.cjs');
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, output.outputText);
  }
  const entries = [
    'scripts/gateway.cjs', 'scripts/tunnel.cjs', 'scripts/runtime-entry.cjs',
    'mini-services/signaling/dist/index.cjs', 'mini-services/physics-service/dist/index.cjs',
  ];
  const { fileList } = await nodeFileTrace(entries.map(file => path.join(root, file)), { base: root, processCwd: root });
  for (const file of fileList) {
    const source = path.resolve(root, file);
    if (!source.startsWith(root + path.sep)) throw new Error(`Dependency outside project: ${file}`);
    const dest = path.join(target, file);
    if (!(await fs.stat(source)).isFile()) continue;
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(source, dest);
  }
  for (const name of ['start-all.cjs']) {
    await fs.copyFile(path.join(root, 'scripts', name), path.join(target, 'scripts', name));
  }
  await fs.cp(path.join(root, 'public'), path.join(target, 'public'), { recursive: true });
  await fs.cp(path.join(root, '.next/static'), path.join(target, '.next/static'), { recursive: true });
  // Prisma's native Windows engine and generated schema are runtime assets.
  await fs.cp(path.join(root, 'node_modules/.prisma/client'), path.join(target, 'node_modules/.prisma/client'), { recursive: true });
  await fs.cp(path.join(root, 'node_modules/@next/env'), path.join(target, 'node_modules/@next/env'), { recursive: true });
  // Include Node so the exe does not depend on a system Node/Bun installation.
  await fs.mkdir(path.join(target, 'runtime'), { recursive: true });
  await fs.copyFile(process.execPath, path.join(target, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
  if (process.platform !== 'win32') await fs.chmod(path.join(target, 'runtime/node'), 0o755);
  if (process.platform === 'win32') {
    const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const exe = path.join(target, 'Fate RPG.exe');
    execFileSync(compiler, ['/nologo', '/target:winexe', '/platform:anycpu', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', `/out:${exe}`, path.join(root, 'launcher/FateLauncher.cs')], { stdio: 'inherit', windowsHide: true });
    await fs.copyFile(exe, path.join(root, 'Fate RPG.exe'));
  }
  console.log('Production bundle ready: .next/standalone. Start with Fate RPG.exe, start.bat or npm start.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
