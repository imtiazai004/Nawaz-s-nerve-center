/**
 * The shell and the cache version have to change together.
 *
 * ## What went wrong
 *
 * `sw.ts` caches `/`, `/index.html` and `/app.js` under a version string, and its own comment
 * says a browser holding an older cache keeps serving the stale shell until that string
 * changes. Over four commits the shell changed a great deal — the office screens, search and
 * the post-incident report left `app.js` for their own files, and their styling left
 * `index.html` — and the string did not.
 *
 * Every browser that had ever opened the app therefore kept serving the old one. It was found
 * by somebody opening the app and asking where the dashboard had gone. Had it reached Bannu,
 * every installed handset would have kept the previous app and no amount of deploying would
 * have changed that.
 *
 * ## Why a comment was not enough
 *
 * The comment was there. It was correct, and it was read, and the mistake happened anyway —
 * because **the shell can change in files `sw.ts` never mentions.** Nothing connected editing
 * `index.html` to editing a string in a different file, so the connection lived only in
 * somebody's memory, which is the same place INV-05 refuses to put authorisation.
 *
 * So this test holds the connection instead. Change the shell and it fails, naming what to do.
 * That is deliberately a small nuisance on every CSS tweak: **a CSS tweak is a shell change,
 * and a stale cache hides it exactly as thoroughly as it hides a missing dashboard.**
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWeb } from '../../build.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, '..', '..');
const RECORD = join(app, 'web', 'shell-version.json');

interface Record {
  cache: string;
  sha256: string;
}

/**
 * The shell's bytes, with line endings normalised.
 *
 * Without that, a Windows checkout and a Linux CI runner hash the same file differently and
 * the test fails on whichever machine did not record it — a failure about nobody's mistake,
 * which is the kind people learn to ignore.
 */
async function shellDigest(): Promise<string> {
  const before = process.env['NODE_ENV'];
  process.env['NODE_ENV'] = 'production';

  try {
    const root = await buildWeb();
    const html = (await readFile(join(root, 'index.html'), 'utf8')).replace(/\r\n/g, '\n');
    const js = (await readFile(join(root, 'app.js'), 'utf8')).replace(/\r\n/g, '\n');

    return createHash('sha256').update(html).update(js).digest('hex');
  } finally {
    if (before === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = before;
    // Put the development build back, as the M1 gate does, so a later suite loads what it
    // expects rather than a minified bundle it never asked for.
    await buildWeb();
  }
}

async function cacheVersionInSw(): Promise<string> {
  const source = await readFile(join(app, 'web', 'src', 'sw.ts'), 'utf8');
  const match = /const CACHE = '([^']+)'/.exec(source);
  expect(match, 'sw.ts no longer declares CACHE the way this test reads it').not.toBeNull();
  return match![1]!;
}

describe('the service worker cache version', () => {
  it('has been bumped for the shell that is actually built', async () => {
    const [digest, cache, recorded] = await Promise.all([
      shellDigest(),
      cacheVersionInSw(),
      readFile(RECORD, 'utf8').then((t) => JSON.parse(t) as Record),
    ]);

    // Half of the pair: the record must describe the version sw.ts declares.
    expect(
      recorded.cache,
      `web/shell-version.json records "${recorded.cache}" but sw.ts declares "${cache}"`,
    ).toBe(cache);

    // The other half: the built shell must be the one that was recorded against it.
    expect(
      digest,
      [
        '',
        'The built shell has changed since this version was recorded.',
        '',
        'A browser that has already opened the app will keep serving the OLD shell until the',
        'cache version changes — that is what happened on 2026-08-04, four commits running.',
        '',
        'Two things, together:',
        `  1. bump CACHE in web/src/sw.ts (currently "${cache}")`,
        '  2. run `npm run shell:record` to store the new shell against it',
        '',
      ].join('\n'),
    ).toBe(recorded.sha256);
  }, 120_000);
});

/** `npm run shell:record` — deliberately not automatic. See the note at the top. */
export async function recordShell(): Promise<void> {
  const [sha256, cache] = await Promise.all([shellDigest(), cacheVersionInSw()]);
  await writeFile(RECORD, `${JSON.stringify({ cache, sha256 }, null, 2)}\n`);
}
