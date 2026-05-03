# Region Outage

**Severity:** P0 — entire primary availability zone or region is
unreachable.
**RTO target:** 30 minutes for marketplace browse + skill downloads.

## Mitigation

1. Confirm the outage is region-wide via the cloud provider status
   page; do not failover for a transient single-AZ blip.
2. **Failover to the cross-AZ standby.** The hot standby in the
   secondary AZ is the failover target. `POST /api/dr/replicas/:id/failover`.
3. **Re-route skill downloads.** Storage nodes outside the affected
   region take over. Verify `GET /api/dr/storage-nodes` shows ≥ 3
   healthy nodes outside the affected region. If not, route traffic
   to the geographically nearest healthy node.
4. **Pause writes that depend on the affected region** until a fresh
   standby is provisioned in a third AZ.

## Resilience checklist

- Backups must be in the same geographic region as the primary
  (GDPR data residency for EU users) — verify `dr_snapshots.region`
  matches the primary region.
- Skill packages must remain on ≥ 3 storage nodes after the failover.

## Post-incident

- Quarterly failover drills exist precisely to verify this runbook.
  After resolving, update `dr_drills` with `kind = 'manual'` and the
  achieved RTO so leadership can compare against the 60s target.
