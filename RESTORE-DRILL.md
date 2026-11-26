# Restore drill

A backup nobody has restored is a hope. This is the record of restoring one.

```bash
bash scripts/with-secrets.sh dev bash scripts/backup.sh
bash scripts/with-secrets.sh dev bash scripts/restore-drill.sh
```

## The run

|                   |                                                                                   |
| ----------------- | --------------------------------------------------------------------------------- |
| Date              | 2026-10-08, 18:58 EEST                                                            |
| Source            | `marketplace` on `postgres:17-alpine`, loaded with `db/seed.sql` from HW-12       |
| Rows              | 20 000 users · 120 000 products · 200 000 orders · 400 001 order items            |
| Archive           | `backups/marketplace-2026-10-08_185826.dump`, **37 062 997 bytes** (35 MB), `-Fc` |
| Dump time         | **3.1 s**                                                                         |
| Restore time      | **7 s**                                                                           |
| Drill, end to end | **9 s** — fresh container started, restored, verified                             |
| Verdict           | **MATCH**                                                                         |

The drill restores into a `postgres:17-alpine` container created for the run and removed
after it. The data directory has never seen this data, so a pass means the archive carried
everything; a drill that restores into the volume it dumped proves only that the rows were
already there.

Control totals, counted on the live database before the dump and on the restored one after:

```
  jobs=0|0
  order_items=400001|802987314537
  orders=200000|802987314537
  products=120000|96253063917
  users=20000|0
```

A row count alone would pass if every amount were zeroed; a sum alone would pass if rows
were swapped. Both together, per table, is cheap and hard to fool.

Run against the small `npm run seed` fixture instead — 6 users, 10 products, 8 orders, 17
line items — the same drill reports a 19 672-byte archive, a restore time below one second,
and the same **MATCH**. Both scales are in this document because one of them is honest
about the mechanism and the other about the cost.

## RTO — recovery time objective

**Measured: 9 seconds** at 320 000 rows, from "start the drill" to "totals agree".

That number is the floor, not the promise. It covers restoring an archive that is already
on local disk into a container on the same machine. A real incident adds:

| Stage                                               | Realistic                                                                     |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| Noticing, and deciding to restore                   | minutes to hours — the dominant term, and the one this drill does not measure |
| Fetching the archive from off-box storage           | seconds to minutes, depending on where #26 puts it                            |
| Restore and verification (measured here)            | **9 s** per 320 000 rows                                                      |
| Repointing the application at the restored database | minutes                                                                       |

**The honest RTO for this setup is therefore on the order of 30 minutes**, almost all of it
human. The database is not the slow part, which is the useful thing to learn from the
measurement: optimising the restore below nine seconds would buy nothing.

## RPO — recovery point objective

**24 hours.**

`backup.cron` runs `scripts/backup.sh` once a night at 03:17. Everything written between
the last successful run and the incident is gone — up to a full day of orders at the worst
possible moment, which is 03:16 the following night.

That is the number this schedule buys, and it is stated plainly because an undocumented RPO
is always assumed to be zero by whoever has to explain the loss. Making it smaller means
changing the mechanism, not the schedule:

| Want           | Mechanism                                                              | Cost                                                                                        |
| -------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 24 h → ~1 h    | hourly `pg_dump`                                                       | 24× the storage and 24× the dump load; still a full dump each time                          |
| 24 h → minutes | WAL archiving plus base backups, restoring with `recovery_target_time` | continuous WAL shipping, somewhere to put it, and a restore that is no longer one command   |
| → seconds      | synchronous replication                                                | commit latency rises and the primary stops accepting writes when the standby is unreachable |

A replica would not change this number at all. Replication copies the mistake as faithfully
as it copies the data: `DROP TABLE users` reaches the standby in milliseconds. Replicas
protect against a node dying, backups against a human being, and the two are not
substitutes.

## What this drill does not prove

- **Off-box storage.** The archive is written to `backups/` on the same machine as the
  database. A disk that takes the database takes the backup with it. #26 moves this to
  object storage, and that is when the dump time above stops being the whole cost.
- **Partial recovery.** This restores everything. Recovering one table, or the state at
  14:36:59 just before a bad transaction, needs WAL archiving and point-in-time recovery.
- **That a nightly schedule actually runs.** `backup.cron` is a file in a repository, not a
  crontab on a server. The line is right; whether it is installed is an operational fact
  this document cannot assert.
