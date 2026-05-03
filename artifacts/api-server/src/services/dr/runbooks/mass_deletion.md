# Accidental Mass Deletion

**Severity:** P1 — payouts, subscriptions, or audit log rows have been
mass-deleted by a buggy script, admin action, or compromised credential.
**RTO target:** 30 minutes. **RPO target:** ≤ 5 minutes for the affected
table set.

## Containment

1. Revoke the credential or stop the calling service before any
   recovery work. Otherwise the recovery will be re-deleted.
2. Capture the exact wall-clock minute of the deletion from the audit
   log entry (`audit_log_entries.action_type = 'data.delete'`).

## Recovery

1. **Selective PITR.** Use `POST /api/dr/snapshots/:id/restore` with
   the table allow-list and `pitrTargetAt = (deletion_minute − 1)` to
   restore only the affected table to the shadow environment.
2. **Diff and copy back.** Compare shadow vs primary to produce the
   exact row set to re-insert. Replay against the live primary inside
   a single transaction.
3. **Re-verify the audit chain** if `audit_log_entries` rows were
   touched: `POST /api/audit/integrity/verify`.

## Post-incident

- Critical-data classes (`payouts`, `subscriptions`) MUST be
  synchronously replicated. If the dr_replicas row for the affected
  data class shows `replication_mode != 'synchronous'`, that
  misconfiguration is the highest-priority remediation item.
