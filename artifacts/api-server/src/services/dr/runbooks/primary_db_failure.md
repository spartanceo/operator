# Primary Database Failure

**Severity:** P0 — marketplace is down or actively failing writes.
**Response SLA:** 15 minutes from page → mitigation in progress.
**RTO target:** 30 minutes. **RPO target:** ≤ 5 minutes.

## Pre-flight

1. Confirm the page is real: `GET /api/dr/replicas` shows the primary
   in `status = "down"` or replication lag past threshold.
2. Open the active incident from `GET /api/dr/incidents?status=open`,
   or create one with `POST /api/dr/incidents`.

## Mitigation

1. **Verify the standby is caught up.** Check the most recent
   `last_probe_at` on the synchronous standby. Lag must be ≤ 5 seconds.
2. **Promote the standby.** `POST /api/dr/replicas/:id/failover`
   with `{ "confirm": true, "durationMs": <ms-since-page> }`. The
   endpoint records the achieved RTO and marks the replica as the
   new primary.
3. **Repoint the marketplace API.** Roll the deployment with the new
   primary endpoint. Health probe `/api/health` must return 200 against
   the new primary.
4. **Re-establish a standby.** Provision a new replica from the most
   recent verified snapshot, register it via `POST /api/dr/replicas`.

## Post-incident

- Close the incident (status becomes `closed`) and populate
  `timeline`, `impact`, `rootCause`, `remediation` via
  `POST /api/dr/incidents/:id/close`. P0/P1 closures are rejected
  with HTTP 409 if any of those four fields is empty.
- Schedule a quarterly drill review if the achieved RTO exceeded 60s.
