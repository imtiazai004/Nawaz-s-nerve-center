/**
 * Build the web client into `web/dist`.
 *
 * esbuild only — it already ships with vitest, so this adds no dependency (ADR-0007).
 * The service worker is a separate entry point because it must be served from the origin
 * root as its own file; a bundler that inlined it would silently limit its scope.
 */

import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, 'web');
const dist = join(web, 'dist');

const manifest = {
  name: 'District Nerve Center — Bannu',
  short_name: 'Nerve Center',
  start_url: '/',
  display: 'standalone',
  background_color: '#f1eee7',
  theme_color: '#1e2430',
  description: 'District emergency coordination for Bannu.',
};

const common = {
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome110',
  // Sourcemaps in dev only; a production bundle should not ship internals.
  sourcemap: process.env.NODE_ENV !== 'production',
  minify: process.env.NODE_ENV === 'production',
};

export async function buildWeb() {
  await mkdir(dist, { recursive: true });

  await build({
    ...common,
    entryPoints: [join(web, 'src', 'main.ts')],
    outfile: join(dist, 'app.js'),
  });

  await build({
    ...common,
    entryPoints: [join(web, 'src', 'sw.ts')],
    outfile: join(dist, 'sw.js'),
  });

  await cp(join(web, 'index.html'), join(dist, 'index.html'));
  await writeFile(join(dist, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2));

  return dist;
}

// `file://${argv[1]}` does not round-trip on Windows — drive letters and separators differ.
// pathToFileURL is the only comparison that holds on every platform.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await buildWeb();
  // eslint-disable-next-line no-console
  console.log(`built -> ${out}`);
}
