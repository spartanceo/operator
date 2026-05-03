# Replica Lag Exceeding Threshold

**Severity:** P1 — replication lag has crossed the 10-second alert
threshold but the primary is still serving.
**Response SLA:** 30 minutes.

## Diagnosis

1. `GET /api/dr/replicas` to find the affected replica's current
   `lagSeconds` and `lastProbeAt`.
2. Check if the primary is overloaded (long-running write transactions,
   bulk import, schema migration in flight). If yes, throttle the
   workload before touching replication.
3. If the standby host is the bottleneck (CPU / disk full), enlarge or
   replace it — promotion is unsafe while lag is climbing.

## Mitigation

1. Pause any non-critical batch jobs that produce write volume.
2. If the lag is on a `data_class = 'payouts'` or `'subscriptions'`
   replica, promote a **different** synchronously-replicated standby
   to keep RPO at zero for critical data. Never let a payout-bearing
   replica fall behind asynchronously.
3. Once lag is back under threshold, ack the alert with
   `POST /api/dr/alerts/:id/ack`.

## Escalation

- If lag stays above the threshold for ≥ 15 minutes, escalate to a
  primary-DB-failure incident — the standby cannot meet the 5-minute
  RPO and a planned failover may be safer than waiting.
