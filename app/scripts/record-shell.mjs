/**
 * Record the built shell against the cache version in `sw.ts` — `npm run shell:record`.
 *
 * Run this **after** bumping `CACHE`, never instead of it. The pair exists because on
 * 2026-08-04 the shell changed over four commits and the version string did not, so every
 * browser that had ever opened the app kept serving the old one — found by somebody opening it
 * and asking where the dashboard had gone.
 *
 * Deliberately a separate command rather than something a test writes for itself: a check that
 * silently repairs what it is checking is not a check.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWeb } from '../build.mjs';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');

process.env.NODE_ENV = 'production';
const root = await buildWeb();

// Normalised, so a Windows checkout and a Linux runner agree.
const html = (await readFile(join(root, 'index.html'), 'utf8')).replace(/\r\n/g, '\n');
const js = (await readFile(join(root, 'app.js'), 'utf8')).replace(/\r\n/g, '\n');
const sha256 = createHash('sha256').update(html).update(js).digest('hex');

const source = await readFile(join(app, 'web', 'src', 'sw.ts'), 'utf8');
const cache = /const CACHE = '([^']+)'/.exec(source)?.[1];
if (cache === undefined) throw new Error('could not read CACHE from web/src/sw.ts');

await writeFile(
  join(app, 'web', 'shell-version.json'),
  `${JSON.stringify({ cache, sha256 }, null, 2)}\n`,
);

// Leave a development build behind, not the minified one this just measured.
delete process.env.NODE_ENV;
await buildWeb();

// eslint-disable-next-line no-console
console.log(`recorded ${cache} -> ${sha256.slice(0, 16)}…`);
