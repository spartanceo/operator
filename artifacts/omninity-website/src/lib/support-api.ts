/**
 * Thin fetch helper for the customer-support / feedback / status-page
 * endpoints (Task #34). These endpoints are not yet exposed through the
 * OpenAPI codegen pipeline — kept off the generated client so the
 * support feature can ship without invalidating the website's
 * generated bundle on every backend tweak.
 *
 * The helper intentionally mirrors the envelope contract used by
 * `@workspace/api-client-react`: `{ success, data?, error? }` for
 * single objects and `{ success, items, nextCursor? }` for paginated
 * lists.
 */
import { getTenantId, getWorkspaceId } from "./api-config";

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface PageEnvelope<T> {
  success: boolean;
  items: T[];
  nextCursor?: string | null;
  error?: { code: string; message: string };
}

async function callApi<T>(
  path: string,
  init: RequestInit & { tenantHeaders?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (init.tenantHeaders !== false) {
    headers["X-Tenant-ID"] = getTenantId();
    headers["X-Workspace-ID"] = getWorkspaceId();
  }
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const env = body as ApiEnvelope<unknown> | null;
    throw new Error(env?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return body as T;
}

// ─── Support tickets ─────────────────────────────────────────────────────────

export interface SupportTicket {
  id: string;
  userEmail: string;
  userLabel: string;
  subject: string;
  body: string;
  category: string;
  priority: string;
  status: string;
  opVersion: string;
  osInfo: string;
  hardwareTier: string;
  attachmentNote: string;
  escalated: boolean;
  assigneeLabel: string;
  resolutionNotes: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicketEvent {
  id: string;
  ticketId: string;
  sender: string;
  senderLabel: string;
  body: string;
  createdAt: string;
}

export async function createTicket(input: {
  subject: string;
  body: string;
  userEmail: string;
  userLabel?: string;
  category?: string;
  priority?: string;
  opVersion?: string;
  osInfo?: string;
}): Promise<SupportTicket> {
  const r = await callApi<ApiEnvelope<{ ticket: SupportTicket }>>(
    "/api/support/tickets",
    { method: "POST", body: JSON.stringify(input) },
  );
  return r.data!.ticket;
}

export async function listTickets(): Promise<SupportTicket[]> {
  const r = await callApi<PageEnvelope<SupportTicket>>("/api/support/tickets");
  return r.items ?? [];
}

export async function getTicket(
  id: string,
): Promise<{ ticket: SupportTicket; events: SupportTicketEvent[] }> {
  const r = await callApi<
    ApiEnvelope<{ ticket: SupportTicket; events: SupportTicketEvent[] }>
  >(`/api/support/tickets/${encodeURIComponent(id)}`);
  return r.data!;
}

export async function appendMessage(
  id: string,
  body: string,
): Promise<SupportTicketEvent> {
  const r = await callApi<ApiEnvelope<{ event: SupportTicketEvent }>>(
    `/api/support/tickets/${encodeURIComponent(id)}/messages`,
    { method: "POST", body: JSON.stringify({ body, sender: "user" }) },
  );
  return r.data!.event;
}

export async function buildDiagnosticBundle(meta: {
  opVersion?: string;
  osInfo?: string;
  hardwareTier?: string;
}): Promise<unknown> {
  const r = await callApi<ApiEnvelope<{ bundle: unknown }>>(
    "/api/support/diagnostics",
    { method: "POST", body: JSON.stringify(meta) },
  );
  return r.data!.bundle;
}

// ─── Feature requests ────────────────────────────────────────────────────────

export interface FeatureRequest {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  status: string;
  statusNote: string;
  submitterLabel: string;
  upvoteCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function listFeatureRequests(opts: {
  status?: string;
  category?: string;
} = {}): Promise<FeatureRequest[]> {
  const params = new URLSearchParams();
  if (opts.status) params.set("status", opts.status);
  if (opts.category) params.set("category", opts.category);
  const qs = params.toString();
  const r = await callApi<PageEnvelope<FeatureRequest>>(
    `/api/feedback/requests${qs ? `?${qs}` : ""}`,
    { tenantHeaders: false },
  );
  return r.items ?? [];
}

export async function createFeatureRequest(input: {
  title: string;
  description?: string;
  category?: string;
  submitterEmail: string;
  submitterLabel?: string;
}): Promise<FeatureRequest> {
  const r = await callApi<ApiEnvelope<{ request: FeatureRequest }>>(
    "/api/feedback/requests",
    {
      method: "POST",
      body: JSON.stringify(input),
      tenantHeaders: false,
    },
  );
  return r.data!.request;
}

export async function voteOn(input: {
  id: string;
  voterEmail: string;
  notifyOnChange?: boolean;
}): Promise<{ deduplicated: boolean; upvoteCount: number }> {
  const r = await callApi<
    ApiEnvelope<{ deduplicated: boolean; upvoteCount: number }>
  >(`/api/feedback/requests/${encodeURIComponent(input.id)}/vote`, {
    method: "POST",
    body: JSON.stringify({
      voterEmail: input.voterEmail,
      notifyOnChange: input.notifyOnChange ?? true,
    }),
    tenantHeaders: false,
  });
  return r.data!;
}

export async function submitThumbs(input: {
  featureKey: string;
  sentiment: "up" | "down";
  comment?: string;
}): Promise<void> {
  await callApi<ApiEnvelope<{ event: unknown }>>("/api/feedback/thumbs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

// ─── Status page ─────────────────────────────────────────────────────────────

export interface StatusComponent {
  id: string;
  componentKey: string;
  label: string;
  status: string;
  message: string;
  sortOrder: number;
  updatedAt: string;
}

export interface StatusIncident {
  id: string;
  title: string;
  body: string;
  status: string;
  severity: string;
  affectedComponents: string[];
  startedAt: string;
  resolvedAt: string | null;
  updatedAt: string;
}

export interface PublicStatusSnapshot {
  overall: string;
  components: StatusComponent[];
  activeIncidents: StatusIncident[];
  generatedAt: string;
}

export async function getPublicStatus(): Promise<PublicStatusSnapshot> {
  const r = await callApi<ApiEnvelope<PublicStatusSnapshot>>(
    "/api/status-page/",
    { tenantHeaders: false },
  );
  return r.data!;
}

// ─── OP team support dashboard ───────────────────────────────────────────────

export interface SupportDashboardMetrics {
  openCount: number;
  inProgressCount: number;
  resolvedLast30dCount: number;
  urgentOpenCount: number;
  avgResolutionHours: number;
  byCategory: Array<{ category: string; total: number }>;
  topReportedIssues: Array<{ subject: string; count: number }>;
  recent: SupportTicket[];
}

export async function getSupportDashboard(): Promise<SupportDashboardMetrics> {
  const r = await callApi<ApiEnvelope<SupportDashboardMetrics>>(
    "/api/support/dashboard",
    { tenantHeaders: false },
  );
  return r.data!;
}
