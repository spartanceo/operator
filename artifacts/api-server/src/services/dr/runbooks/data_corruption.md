# Data Corruption

**Severity:** P0 — checksum mismatch, replication divergence, or
application reports incoherent reads.
**RTO target:** 30 minutes. **RPO target:** ≤ 5 minutes.

## Triage

1. Stop all writes by enabling the marketplace maintenance flag.
2. Identify the corruption boundary — last known-good wall clock minute.
   The latest `dr_snapshots` row with `verifyStatus = 'verified'` whose
   `pitrLogEndAt` is before the corruption is the recovery anchor.

## Recovery

1. **Pick the recovery point.** PITR window is 30 days; resolution is
   1 minute. Record the chosen `pitrTargetAt` on the incident.
2. **Restore.** `POST /api/dr/snapshots/:id/restore` with
   `{ "pitrTargetAt": <ms>, "confirm": true }`. The restore writes a
   shadow database; do NOT swap traffic until validation passes.
3. **Validate.** `POST /api/dr/drills` with `kind = 'manual'` and the
   shadow snapshot id. The drill replays the marketplace validation
   suite. All checks must pass before promotion.
4. **Promote** via the same failover flow as a primary DB failure.

## Post-incident

- All P0 incidents require a written post-incident report in
  `dr_incidents.timeline / impact / rootCause / remediation`. The DR
  service refuses to close a P0/P1 incident with empty fields.
