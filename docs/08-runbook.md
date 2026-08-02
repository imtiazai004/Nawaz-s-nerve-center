# Runbook

Written for the person on the other end of the phone at 02:00, who did not build this.

If you are reading this during an incident, the only section you need is
[**Restore from backup**](#restore-from-backup). Start there.

---

## Restore from backup

**The drill (M0-38) is not complete until somebody who did not write this system has
performed it, end to end, timed, and written down what actually happened.** A restore
procedure that has only ever been run by its author is not a backup strategy — it is a
document. That is why this section exists and why the gate stays open until it has been
used.

### What you need

- The dump file. Backups are written to the configured backup directory, named
  `dnc-<timestamp>.sql`.
- `psql` on the machine you are restoring to.
- A **new, empty database**. Never restore over the live one — see *Why never in place*.

### Steps

1. **Find the most recent good backup.**

   ```sql
   SELECT finished_at, path, bytes, event_count, sha256
     FROM backup_run
    WHERE status = 'ok'
    ORDER BY finished_at DESC
    LIMIT 5;
   ```

   If that query cannot be run because the database is gone, the files are in the backup
   directory and the newest is the one you want.

2. **Check the file is the file.**

   ```
   sha256sum dnc-<timestamp>.sql        # Linux
   Get-FileHash dnc-<timestamp>.sql     # Windows
   ```

   Compare against `sha256` from the ledger. A mismatch means a truncated or corrupted
   copy — use the previous backup rather than restoring a partial one.

3. **Create an empty target.**

   ```sql
   CREATE DATABASE dnc_restore_YYYYMMDD;
   ```

4. **Replay it. `ON_ERROR_STOP` is not optional.**

   ```
   psql --set ON_ERROR_STOP=1 --file dnc-<timestamp>.sql "postgresql://.../dnc_restore_YYYYMMDD"
   ```

   Without that flag `psql` reports success after replaying a dump that half-failed. You get
   a database, it is missing things, and nothing said so.

5. **Verify — do not trust the exit code.**

   ```sql
   SELECT count(*) FROM incident_event;          -- compare against event_count in the ledger
   SELECT count(*) FROM schema_migration;        -- must not be zero
   SELECT tgname FROM pg_trigger
    WHERE tgrelid = 'incident_event'::regclass AND NOT tgisinternal;
   ```

   The last one matters more than it looks. A restore that brings back the rows but not the
   append-only triggers gives you a database where the event log **can be edited**, and
   nobody finds out until an audit. The data would be back and the guarantee would be gone.

   `verifyRestoredIntegrity` in `app/src/ops/restore.ts` runs all three, including actually
   attempting a forbidden `UPDATE` inside a transaction it always rolls back.

6. **Write down how long it took**, and what went wrong. An untimed restore is an untested
   one, and the number matters: it is how long the district is without its record.

### Why never in place

Every restore goes into a database you name. A tool whose easiest path overwrites production
is a tool that will eventually overwrite production — at 02:00, by someone tired, who meant
to type something else. Swapping a verified restore into place is a separate, deliberate
step taken by someone awake.

---

## Backups

- Taken by `runBackup` (`app/src/ops/backup.ts`), which records every attempt in
  `backup_run` **before** the dump starts. A process killed mid-dump therefore leaves a
  visible `running` row rather than no row at all.
- Plain SQL, not the custom format: you can read it, grep it, and replay it with `psql`
  alone (ADR-0007). One fewer tool to have installed and be wrong about under pressure.
- A dump is **verified, not assumed**. `pg_dump` exiting 0 proves nothing — size, checksum
  and the event count inside the file are all checked, and a dump holding fewer events than
  the live database is recorded as a failure.

### Is the backup working?

```
curl http://<host>/health
```

`degraded: true` with `backup.ok: false` means no successful backup in 24 hours, or a run
that started and never finished.

**`/health` returns 200 even when the backup is stale.** That is deliberate: a 503 would
take the node out of a load balancer and stop the district reporting emergencies because a
dump was old. INV-01 outranks a stale backup. Monitor `degraded`, not the status code.

---

## Things that are not yet true

Recorded here rather than discovered at 02:00:

- **Nothing schedules the backup yet.** `runBackup` is written, tested and callable; wiring
  it to a timer is a deployment decision that waits on P-08 (hosting).
- **Nothing pages a human.** `degraded` is reported and nobody is watching it. That is M5.
- **The restore drill has not been performed by a second person.** M0-38, and the last open
  item on the M0 gate.
