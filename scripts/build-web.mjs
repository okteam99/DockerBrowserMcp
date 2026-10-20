import { build } from 'esbuild';
await build({
  entryPoints: ['web/main.tsx'],
  bundle: true,
  minify: true,
  target: ['es2022'],
  outfile: 'dist/public/app.js',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'eof',
  logLevel: 'info',
});

import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
for (const name of ['app.js', 'app.css']) {
  const raw = await readFile(`dist/public/${name}`);
  await writeFile(`dist/public/${name}.gz`, gzipSync(raw, { level: 9 }));
}
