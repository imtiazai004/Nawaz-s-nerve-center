/**
 * Getting the district's record out of the building — M0-53, ADR-0011.
 *
 * `ops/backup.ts` makes a verified dump on the DC office's own disk. That covers a bad
 * restore and a corrupted table. It does not cover the building: fire, flood, or somebody
 * walking out with the machine.
 *
 * So a copy goes to Google Cloud Storage, **nightly**. The owner said weekly; ADR-0011
 * records why that became nightly — a weekly cadence means losing up to seven days of the
 * district's emergency record, and the difference in cost is a few hundred megabytes of
 * transfer.
 *
 * Three rules, and the third is the one that is usually got wrong.
 *
 * 1. **Encrypted before it leaves.** A dump holds every reporter's phone number in Bannu.
 *    Handing that to a cloud provider in plaintext is a disclosure nobody decided to make.
 * 2. **The key never goes with it.** Obvious, and worth a line of code that makes it
 *    impossible rather than a note saying so.
 * 3. **A failed upload is loud.** A backup that silently stops working is worse than no
 *    backup at all, because it buys false confidence — the district believes it is covered
 *    for a year and finds out on the day it is not. Failures are recorded in the ledger and
 *    surfaced by `/health`.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

import type { Pool } from '../db/pool.js';
import { log } from '../obs/log.js';

/**
 * AES-256-GCM, with a key derived from a passphrase by scrypt.
 *
 * GCM rather than CBC because it authenticates: a dump that has been altered in the bucket
 * fails to decrypt rather than restoring quietly wrong. That matters more here than the
 * confidentiality does — a tampered emergency record that restores cleanly is the worst
 * available outcome.
 *
 * The output is `salt | iv | authTag | ciphertext`, all of which the reader needs and none of
 * which is secret. The passphrase is not in it.
 */
export function encryptDump(plaintext: Buffer, passphrase: string): Buffer {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32);

  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]);
}

/**
 * The reverse, for the runbook and for the verify step.
 *
 * Here rather than in a separate tool because a backup nobody can decrypt is not a backup,
 * and the decryption path has to be exercised by the same test suite that exercises the
 * encryption path. See `docs/08-runbook.md`.
 */
export function decryptDump(payload: Buffer, passphrase: string): Buffer {
  if (payload.length < 16 + 12 + 16) throw new Error('not an encrypted dump: too short');

  const salt = payload.subarray(0, 16);
  const iv = payload.subarray(16, 28);
  const authTag = payload.subarray(28, 44);
  const ciphertext = payload.subarray(44);

  const key = scryptSync(passphrase, salt, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  // Throws on a bad tag rather than returning altered bytes. That is the whole reason for
  // GCM here: a tampered emergency record that restores cleanly is worse than one that
  // refuses to restore at all.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

//------------------------------------------------------------------------------
// Where it goes
//------------------------------------------------------------------------------

/**
 * Somewhere off-site to put a file.
 *
 * One method, so the whole path is testable against an in-memory fake and so that a district
 * that decides against Google Cloud later is changing one adapter rather than the backup job
 * (ADR-0007: nothing in the critical path should need a vendor SDK to be understood).
 */
export interface OffsiteStore {
  readonly name: string;
  /** False until the district has a bucket and a service account (R-06). */
  readonly configured: boolean;
  readonly why: string | null;
  put(key: string, bytes: Buffer): Promise<void>;
  list(): Promise<readonly { readonly key: string; readonly bytes: number }[]>;
}

export interface OffsiteEnv {
  readonly GCS_BUCKET?: string | undefined;
  readonly GCS_TOKEN?: string | undefined;
  readonly BACKUP_PASSPHRASE?: string | undefined;
}

/**
 * Google Cloud Storage, over its plain JSON upload API.
 *
 * No SDK. The whole interaction is one authenticated POST, and a dependency that pulls in a
 * hundred transitive packages to do that is a dependency the district's one technical person
 * has to understand at 02:00.
 */
export function gcsStore(env: OffsiteEnv, http = fetch): OffsiteStore {
  const bucket = env.GCS_BUCKET;
  const token = env.GCS_TOKEN;

  if (bucket === undefined || token === undefined) {
    return {
      name: 'google-cloud-storage',
      configured: false,
      why: 'no bucket or service account yet (R-06) — backups stay in the DC office, so fire, flood or theft takes the record with them',
      put: () => Promise.reject(new Error('offsite storage is not configured')),
      list: () => Promise.resolve([]),
    };
  }

  return {
    name: 'google-cloud-storage',
    configured: true,
    why: null,
    async put(key, bytes): Promise<void> {
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(
        bucket,
      )}/o?uploadType=media&name=${encodeURIComponent(key)}`;

      const res = await http(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
        },
        body: new Uint8Array(bytes),
      });

      if (!res.ok) throw new Error(`upload rejected: HTTP ${String(res.status)}`);
    },
    async list(): Promise<readonly { key: string; bytes: number }[]> {
      const res = await http(
        `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (!res.ok) throw new Error(`listing rejected: HTTP ${String(res.status)}`);

      const body = (await res.json()) as { items?: { name: string; size: string }[] };
      return (body.items ?? []).map((i) => ({ key: i.name, bytes: Number(i.size) }));
    },
  };
}

//------------------------------------------------------------------------------
// The upload
//------------------------------------------------------------------------------

export interface UploadResult {
  readonly ok: boolean;
  readonly key?: string;
  readonly bytes?: number;
  readonly sha256?: string;
  readonly skipped?: string;
  readonly error?: string;
}

/**
 * Encrypt a verified dump and put it off-site.
 *
 * **`skipped` is not `ok`.** A district with no bucket yet gets `{ ok: false, skipped }`, and
 * the ledger records it as not uploaded — because "we did not try" and "we tried and it
 * worked" must never render the same on a screen somebody uses to decide whether the record
 * is safe.
 */
export async function uploadDump(
  pool: Pool,
  backupRunId: string,
  dumpPath: string,
  store: OffsiteStore,
  env: OffsiteEnv,
): Promise<UploadResult> {
  const passphrase = env.BACKUP_PASSPHRASE;

  const note = async (result: UploadResult): Promise<UploadResult> => {
    await pool.query(
      `UPDATE backup_run
          SET offsite_key = $2, offsite_at = $3, offsite_error = $4
        WHERE backup_run_id = $1`,
      [
        backupRunId,
        result.key ?? null,
        result.ok ? new Date().toISOString() : null,
        result.ok ? null : (result.error ?? result.skipped ?? 'not attempted'),
      ],
    );
    return result;
  };

  if (!store.configured) {
    return note({ ok: false, skipped: store.why ?? 'offsite storage is not configured' });
  }
  if (passphrase === undefined || passphrase.length < 16) {
    // Refused rather than uploaded in the clear. A dump holds every reporter's number in
    // the district, and "we will encrypt it later" is how it leaves unencrypted forever.
    return note({
      ok: false,
      skipped:
        'no BACKUP_PASSPHRASE of at least 16 characters — refusing to send the district’s record out unencrypted',
    });
  }

  try {
    const plaintext = await readFile(dumpPath);
    const encrypted = encryptDump(plaintext, passphrase);
    const key = `${basename(dumpPath)}.enc`;

    await store.put(key, encrypted);

    return await note({
      ok: true,
      key,
      bytes: encrypted.length,
      // The hash of what was actually sent, so the copy in the bucket can be checked against
      // the ledger without downloading and decrypting it first.
      sha256: createHash('sha256').update(encrypted).digest('hex'),
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Loud. A silent upload failure buys a year of false confidence.
    log('error', 'off-site backup upload failed', { backupRunId, error });
    return note({ ok: false, error });
  }
}
