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

/**
 * Read `NODE_ENV` **per build**, not once at import.
 *
 * These used to be computed at module load. Nothing noticed until the M1 gate tried to weigh
 * the shipped bundle by setting `NODE_ENV=production` around a call — and got the development
 * build back, because the flag had already been read minutes earlier. The gate then measured
 * an artefact 40% larger than anything the district downloads.
 */
function options() {
  const production = process.env.NODE_ENV === 'production';

  return {
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome110',
    // Sourcemaps in dev only; a production bundle should not ship internals.
    sourcemap: !production,
    minify: production,
  };
}

export async function buildWeb() {
  const common = options();
  await mkdir(dist, { recursive: true });

  await build({
    ...common,
    entryPoints: [join(web, 'src', 'main.ts')],
    outfile: join(dist, 'app.js'),
  });

  /**
   * The post-incident report, as its own file — **not part of the shell**.
   *
   * The shell is what a field officer downloads at a scene on a weak connection, and the M1
   * gate holds it to a budget from `docs/00-thesis.md`. When this screen was written the shell
   * stood at 159 KB against 160 KB: one kilobyte of headroom, which the budget existed to make
   * visible and duly did.
   *
   * The answer is not a bigger budget. **An officer standing at a road accident has no use for
   * a post-incident report**, and neither does the phone in their hand — this screen is office
   * work, read after everything is over, always with a connection. So it ships separately and
   * loads the first time somebody asks for one.
   *
   * Deliberately a second entry point rather than `splitting: true`: that needs ESM output and
   * hashed chunk names, and the service worker names the shell's files explicitly so the app
   * opens with no network (INV-01). Trading a known offline boot for a tidier build config is
   * not a trade this project makes.
   */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'report.ts')],
    outfile: join(dist, 'report.js'),
    // Attached to the window because the shell loads this with a script tag, not an import —
    // see the note above on why this is not an ESM chunk.
    globalName: 'DncReport',
  });

  /**
   * The office screens — console, roster, Status — in one file.
   *
   * One bundle rather than three because `admin.ts` already imports `roster.ts`: the console
   * reaches every department's roster, and "My department" is the same component through its
   * other door (M1a-10). Three entry points would put a second copy of the roster in one of
   * them, and the point of this is fewer bytes rather than tidier filenames.
   */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'office.ts')],
    outfile: join(dist, 'office.js'),
    globalName: 'DncOffice',
  });

  /** Search, on the same terms as the report: office work, and useless without a connection. */
  await build({
    ...common,
    entryPoints: [join(web, 'src', 'search.ts')],
    outfile: join(dist, 'search.js'),
    globalName: 'DncSearch',
  });

  await build({
    ...common,
    entryPoints: [join(web, 'src', 'sw.ts')],
    outfile: join(dist, 'sw.js'),
  });

  await cp(join(web, 'index.html'), join(dist, 'index.html'));
  await cp(join(web, 'theme.css'), join(dist, 'theme.css'));
  // Fetched by the report screen, not by the shell — see the report entry point above.
  await cp(join(web, 'report.css'), join(dist, 'report.css'));
  await cp(join(web, 'search.css'), join(dist, 'search.css'));
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
