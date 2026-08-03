/**
 * Build the web client into `web/dist`.
 *
 * esbuild only, and it is **declared** in package.json rather than borrowed.
 *
 * It used to be imported without being declared, on the reasoning that vitest already ships
 * it so nothing new was being installed. True, and still a phantom dependency: the import
 * resolved because npm happened to hoist another package's internals to the top level. It
 * would break on a vite bump, on a stricter package manager, or on a clean install that
 * deduped differently — and it would break the *build*, at a moment nobody was touching the
 * build. Declaring it installs nothing extra (it dedupes to the same copy) and costs one
 * line; the alternative was a failure mode with no obvious cause. See ADR-0007.
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

  // The wall screen (M4-05). Its own entry point rather than a route inside the app: it
  // shares no state with the tool, must not pull in the offline outbox or the service
  // worker, and is loaded once by a browser nobody will ever touch again.
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'display.ts')],
    outfile: join(dist, 'display.js'),
  });

  await cp(join(web, 'index.html'), join(dist, 'index.html'));
  await cp(join(web, 'display.html'), join(dist, 'display.html'));
  await cp(join(web, 'theme.css'), join(dist, 'theme.css'));
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
