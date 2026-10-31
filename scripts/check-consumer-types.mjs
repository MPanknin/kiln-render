// Type-check the packed tarball as a consumer: a clean project with skipLibCheck off.
// Catches what ATTW misses, like dev-only imports (zarrita) or names removed by stripInternal.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kiln-consumer-'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

try {
  run('bun', ['pm', 'pack', '--destination', dir, '--quiet'], process.cwd());
  const tarball = readdirSync(dir).find(f => f.endsWith('.tgz'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'],
      strict: true, noEmit: true, skipLibCheck: false,
    },
    include: ['main.ts'],
  }));
  writeFileSync(join(dir, 'main.ts'), "import * as kiln from 'kiln-render';\nexport const api = kiln;\n");
  run('bun', ['add', `./${tarball}`], dir);
  // The repo's own TypeScript, so the check needs no extra download
  run('node', [resolve('node_modules/typescript/bin/tsc'), '-p', dir]);
  console.log('[check-consumer-types] the packed types compile with skipLibCheck off');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
