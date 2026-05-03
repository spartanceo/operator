/**
 * Tenant + request context that flows through every backend call.
 *
 * Per Section 11 of the project context (Multi-Tenancy Rules) every request
 * carries a tenantId; workspaceId is present once the request resolves to a
 * specific workspace; userId is present once the request is authenticated.
 *
 * The shape is deliberately small and serialisable — it travels through
 * AsyncLocalStorage on the server, gets logged on every request, and is
 * passed by reference into the `tenantScope` helper from `@workspace/db`.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly workspaceId?: string;
  readonly userId?: string;
  /** Opaque trace identifier propagated as `X-Request-ID` end-to-end. */
  readonly requestId: string;
  /**
   * Runtime ids the operator confirmed this session for cloud egress.
   * Populated by the tenant-context middleware from the session cookie so
   * that *any* server-side caller (routes, tools, agent orchestrator)
   * can dispatch to a confirmed cloud runtime without plumbing the list
   * through every signature.
   *
   * Background workers / scheduled jobs that build their own context
   * may omit this field; in that case the runtime service treats no
   * cloud runtime as confirmed (deny-by-default).
   */
  readonly confirmedRuntimeIds?: readonly string[];
}

/**
 * The roles that may be attached to a user inside a tenant.
 * Real role-checking middleware lands in Task #4 (Authentication). This enum
 * exists now so route definitions and policy types can reference it.
 */
export type TenantRole = "owner" | "admin" | "member" | "viewer";

/**
 * Tenant lifecycle status. `erased` is a soft-delete state set by the GDPR
 * data-erasure endpoint; rows in this state are not returned by tenant-scoped
 * queries (enforced via the `tenantScope` helper).
 */
export type TenantStatus = "active" | "suspended" | "erased";
