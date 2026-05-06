/**
 * Static catalogue of supported integration providers.
 *
 * The registry is intentionally a plain TypeScript constant — adding a new
 * provider is a one-line edit and a deploy. Each entry declares:
 *   - identity   : id, label, category, icon hint
 *   - auth shape : auth_type + which credential fields the UI must collect
 *   - actions    : the tool actions this provider exposes once connected
 *
 * Tool execution is deliberately stub-only in Tier 1: the service layer
 * returns a deterministic `{ simulated: true, ... }` response for every
 * action so the UI, agent loop, and audit log can all be wired end-to-end
 * without depending on real third-party API access. Real adapters land
 * incrementally once each provider's connection has been verified.
 */
export type AuthType = "oauth" | "api_key";
export type ProviderCategory =
  | "productivity"
  | "communication"
  | "files"
  | "code"
  | "tickets"
  | "crm"
  | "commerce"
  | "data";

export interface ProviderField {
  readonly name: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly secret?: boolean;
  readonly required?: boolean;
}

export interface ProviderAction {
  readonly name: string;
  readonly description: string;
  readonly riskLevel: "low" | "medium" | "high";
}

export interface ProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly category: ProviderCategory;
  readonly authType: AuthType;
  readonly description: string;
  readonly oauthScopes: readonly string[];
  readonly fields: readonly ProviderField[];
  readonly actions: readonly ProviderAction[];
  /**
   * When true, the UI shows a "Recommended" badge on this provider card.
   * Use this to highlight the preferred provider within a category when
   * multiple options cover the same capability (e.g. web search).
   */
  readonly recommended?: boolean;
}

const apiKeyOnly: readonly ProviderField[] = [
  { name: "apiKey", label: "API key", secret: true, required: true },
];

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "gmail",
    label: "Gmail",
    category: "communication",
    authType: "oauth",
    description: "Read, send, and manage Gmail messages.",
    oauthScopes: ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"],
    fields: [
      { name: "accessToken", label: "Access token", secret: true, required: true },
      { name: "refreshToken", label: "Refresh token", secret: true },
    ],
    actions: [
      { name: "listMessages", description: "List Gmail messages", riskLevel: "low" },
      { name: "sendMessage", description: "Send an email", riskLevel: "medium" },
    ],
  },
  {
    id: "outlook",
    label: "Outlook",
    category: "communication",
    authType: "oauth",
    description: "Read, send, and manage Outlook email via Microsoft Graph.",
    oauthScopes: ["Mail.ReadWrite", "Mail.Send", "User.Read"],
    fields: [
      { name: "accessToken", label: "Access token", secret: true, required: true },
      { name: "refreshToken", label: "Refresh token", secret: true },
    ],
    actions: [
      { name: "listMessages", description: "List Outlook messages", riskLevel: "low" },
      { name: "sendMessage", description: "Send an email", riskLevel: "medium" },
    ],
  },
  {
    id: "twilio",
    label: "Twilio",
    category: "communication",
    authType: "api_key",
    description: "Place VoIP calls and send SMS via Twilio.",
    oauthScopes: [],
    fields: [
      { name: "accountSid", label: "Account SID", required: true },
      { name: "authToken", label: "Auth token", secret: true, required: true },
      { name: "phoneNumber", label: "Twilio phone number", required: true },
    ],
    actions: [
      { name: "placeCall", description: "Place an outbound VoIP call", riskLevel: "medium" },
    ],
  },
  {
    id: "notion",
    label: "Notion",
    category: "productivity",
    authType: "oauth",
    description: "Read and write Notion pages, databases, and comments.",
    oauthScopes: ["read_content", "update_content", "read_user"],
    fields: [
      { name: "accessToken", label: "Access token", secret: true, required: true },
      { name: "workspaceName", label: "Workspace name" },
    ],
    actions: [
      { name: "search", description: "Search Notion pages and databases", riskLevel: "low" },
      { name: "createPage", description: "Create a new Notion page", riskLevel: "medium" },
      { name: "appendBlock", description: "Append a block to a page", riskLevel: "medium" },
    ],
  },
  {
    id: "slack",
    label: "Slack",
    category: "communication",
    authType: "oauth",
    description: "Send messages and read channel history in Slack.",
    oauthScopes: ["channels:read", "chat:write", "users:read"],
    fields: [
      { name: "accessToken", label: "Bot user OAuth token", secret: true, required: true },
      { name: "teamName", label: "Workspace name" },
    ],
    actions: [
      { name: "listChannels", description: "List channels the bot can see", riskLevel: "low" },
      { name: "postMessage", description: "Post a message to a channel", riskLevel: "medium" },
    ],
  },
  {
    id: "teams",
    label: "Microsoft Teams",
    category: "communication",
    authType: "oauth",
    description: "Send messages and manage Teams chats.",
    oauthScopes: ["Chat.ReadWrite", "ChannelMessage.Send", "User.Read"],
    fields: [
      { name: "accessToken", label: "Microsoft Graph access token", secret: true, required: true },
      { name: "tenantName", label: "Tenant name" },
    ],
    actions: [
      { name: "listChats", description: "List recent chats", riskLevel: "low" },
      { name: "postMessage", description: "Post a message to a chat or channel", riskLevel: "medium" },
    ],
  },
  {
    id: "google_drive",
    label: "Google Drive",
    category: "files",
    authType: "oauth",
    description: "Browse, read, and create Google Drive files.",
    oauthScopes: ["https://www.googleapis.com/auth/drive"],
    fields: [
      { name: "accessToken", label: "Google access token", secret: true, required: true },
      { name: "refreshToken", label: "Refresh token", secret: true },
    ],
    actions: [
      { name: "listFiles", description: "List recent Drive files", riskLevel: "low" },
      { name: "getFile", description: "Get a file's metadata", riskLevel: "low" },
      { name: "uploadFile", description: "Upload a file to Drive", riskLevel: "medium" },
    ],
  },
  {
    id: "google_sheets",
    label: "Google Sheets",
    category: "data",
    authType: "oauth",
    description: "Read and write Google Sheets ranges.",
    oauthScopes: ["https://www.googleapis.com/auth/spreadsheets"],
    fields: [
      { name: "accessToken", label: "Google access token", secret: true, required: true },
      { name: "refreshToken", label: "Refresh token", secret: true },
    ],
    actions: [
      { name: "readRange", description: "Read a range from a sheet", riskLevel: "low" },
      { name: "appendRow", description: "Append a row to a sheet", riskLevel: "medium" },
    ],
  },
  {
    id: "dropbox",
    label: "Dropbox",
    category: "files",
    authType: "oauth",
    description: "Browse and manage files in Dropbox.",
    oauthScopes: ["files.content.read", "files.content.write"],
    fields: [
      { name: "accessToken", label: "Dropbox access token", secret: true, required: true },
    ],
    actions: [
      { name: "listFolder", description: "List the contents of a folder", riskLevel: "low" },
      { name: "uploadFile", description: "Upload a file", riskLevel: "medium" },
    ],
  },
  {
    id: "airtable",
    label: "Airtable",
    category: "data",
    authType: "api_key",
    description: "Read and write Airtable bases and tables.",
    oauthScopes: [],
    fields: [
      { name: "apiKey", label: "Personal access token", secret: true, required: true },
      { name: "baseId", label: "Base ID" },
    ],
    actions: [
      { name: "listRecords", description: "List records in a table", riskLevel: "low" },
      { name: "createRecord", description: "Create a record", riskLevel: "medium" },
      { name: "updateRecord", description: "Update a record", riskLevel: "medium" },
    ],
  },
  {
    id: "github",
    label: "GitHub",
    category: "code",
    authType: "oauth",
    description: "Read repositories, issues, and pull requests.",
    oauthScopes: ["repo", "read:user"],
    fields: [
      { name: "accessToken", label: "Personal access token", secret: true, required: true },
    ],
    actions: [
      { name: "listRepos", description: "List repositories", riskLevel: "low" },
      { name: "getIssue", description: "Fetch an issue", riskLevel: "low" },
      { name: "createIssue", description: "Open an issue", riskLevel: "medium" },
      { name: "createPullRequest", description: "Open a pull request", riskLevel: "high" },
    ],
  },
  {
    id: "gitlab",
    label: "GitLab",
    category: "code",
    authType: "oauth",
    description: "Browse GitLab projects, issues, and merge requests.",
    oauthScopes: ["api", "read_user"],
    fields: [
      { name: "accessToken", label: "Personal access token", secret: true, required: true },
      { name: "host", label: "Instance host", placeholder: "gitlab.com" },
    ],
    actions: [
      { name: "listProjects", description: "List projects", riskLevel: "low" },
      { name: "createIssue", description: "Open an issue", riskLevel: "medium" },
    ],
  },
  {
    id: "linear",
    label: "Linear",
    category: "tickets",
    authType: "oauth",
    description: "Manage Linear issues and projects.",
    oauthScopes: ["read", "write"],
    fields: [
      { name: "accessToken", label: "Personal API key", secret: true, required: true },
    ],
    actions: [
      { name: "listIssues", description: "List recent issues", riskLevel: "low" },
      { name: "createIssue", description: "Create an issue", riskLevel: "medium" },
    ],
  },
  {
    id: "jira",
    label: "Jira",
    category: "tickets",
    authType: "api_key",
    description: "Manage Jira issues, sprints, and projects.",
    oauthScopes: [],
    fields: [
      { name: "host", label: "Site URL", placeholder: "your-org.atlassian.net", required: true },
      { name: "email", label: "Account email", required: true },
      { name: "apiKey", label: "API token", secret: true, required: true },
    ],
    actions: [
      { name: "searchIssues", description: "Run a JQL search", riskLevel: "low" },
      { name: "createIssue", description: "Create an issue", riskLevel: "medium" },
    ],
  },
  {
    id: "salesforce",
    label: "Salesforce",
    category: "crm",
    authType: "oauth",
    description: "Read and update Salesforce records.",
    oauthScopes: ["api", "refresh_token"],
    fields: [
      { name: "accessToken", label: "Access token", secret: true, required: true },
      { name: "instanceUrl", label: "Instance URL" },
    ],
    actions: [
      { name: "queryRecords", description: "Run a SOQL query", riskLevel: "low" },
      { name: "createRecord", description: "Create a record", riskLevel: "medium" },
    ],
  },
  {
    id: "hubspot",
    label: "HubSpot",
    category: "crm",
    authType: "oauth",
    description: "Read and update HubSpot contacts, companies, and deals.",
    oauthScopes: ["crm.objects.contacts.read", "crm.objects.contacts.write"],
    fields: [
      { name: "accessToken", label: "Access token", secret: true, required: true },
    ],
    actions: [
      { name: "listContacts", description: "List contacts", riskLevel: "low" },
      { name: "createContact", description: "Create a contact", riskLevel: "medium" },
      { name: "createDeal", description: "Create a deal", riskLevel: "medium" },
    ],
  },
  {
    id: "pipedrive",
    label: "Pipedrive",
    category: "crm",
    authType: "api_key",
    description: "Read and update Pipedrive deals and people.",
    oauthScopes: [],
    fields: [
      { name: "apiKey", label: "API token", secret: true, required: true },
      { name: "host", label: "Domain", placeholder: "your-org.pipedrive.com" },
    ],
    actions: [
      { name: "listDeals", description: "List deals", riskLevel: "low" },
      { name: "createDeal", description: "Create a deal", riskLevel: "medium" },
    ],
  },
  {
    id: "shopify",
    label: "Shopify",
    category: "commerce",
    authType: "oauth",
    description: "Read products and orders from a Shopify store.",
    oauthScopes: ["read_products", "read_orders", "write_orders"],
    fields: [
      { name: "accessToken", label: "Admin API access token", secret: true, required: true },
      { name: "shopDomain", label: "Shop domain", placeholder: "your-store.myshopify.com", required: true },
    ],
    actions: [
      { name: "listProducts", description: "List products", riskLevel: "low" },
      { name: "listOrders", description: "List recent orders", riskLevel: "low" },
      { name: "createDraftOrder", description: "Create a draft order", riskLevel: "medium" },
    ],
  },
  {
    id: "woocommerce",
    label: "WooCommerce",
    category: "commerce",
    authType: "api_key",
    description: "Read and update a WooCommerce store via REST API.",
    oauthScopes: [],
    fields: [
      { name: "host", label: "Store URL", placeholder: "https://your-store.com", required: true },
      { name: "consumerKey", label: "Consumer key", secret: true, required: true },
      { name: "consumerSecret", label: "Consumer secret", secret: true, required: true },
    ],
    actions: [
      { name: "listProducts", description: "List products", riskLevel: "low" },
      { name: "listOrders", description: "List recent orders", riskLevel: "low" },
    ],
  },
  {
    id: "s3",
    label: "Amazon S3",
    category: "files",
    authType: "api_key",
    description: "List, read, and upload objects in an S3 bucket.",
    oauthScopes: [],
    fields: [
      { name: "accessKeyId", label: "Access key ID", secret: true, required: true },
      { name: "secretAccessKey", label: "Secret access key", secret: true, required: true },
      { name: "region", label: "Region", placeholder: "us-east-1", required: true },
      { name: "bucket", label: "Default bucket" },
    ],
    actions: [
      { name: "listObjects", description: "List objects in a bucket", riskLevel: "low" },
      { name: "putObject", description: "Upload an object", riskLevel: "medium" },
      { name: "deleteObject", description: "Delete an object", riskLevel: "high" },
    ],
  },
  {
    id: "supabase",
    label: "Supabase",
    category: "data",
    authType: "api_key",
    description: "Query and mutate Supabase tables via the REST API.",
    oauthScopes: [],
    fields: [
      { name: "host", label: "Project URL", placeholder: "https://xyz.supabase.co", required: true },
      { name: "apiKey", label: "Service role key", secret: true, required: true },
    ],
    actions: [
      { name: "selectRows", description: "Select rows from a table", riskLevel: "low" },
      { name: "insertRow", description: "Insert a row", riskLevel: "medium" },
    ],
  },
  // ─── AI / external service providers ────────────────────────────────────────
  //
  // PATTERN: Every external AI or data-service feature the agent uses must be
  // registered here as a provider entry rather than reading a server-level env
  // var. Tool handlers call `getConnectedProvider(ctx, providerId)` in
  // integrations.service.ts to resolve per-tenant credentials at runtime.
  //
  // Adding a new external service:
  //   1. Register a ProviderDescriptor here (authType "api_key" for most AI APIs).
  //   2. Add the required credential fields and the actions it exposes.
  //   3. In the relevant service (tools.service, media.service, voice.service,
  //      …) call `getConnectedProvider(ctx, "<your-id>")` to fetch credentials
  //      and fall back gracefully (stub / clear log warning) when null.
  //   4. Mark one provider per capability as `recommended: true` so the UI can
  //      surface a sensible default choice to new customers.
  //
  // Never add a new `process.env["SOME_API_KEY"]` lookup in service code —
  // always use this registry + getConnectedProvider instead.
  {
    id: "brave_search",
    label: "Brave Search",
    category: "data",
    authType: "api_key",
    description: "Privacy-respecting web search via the Brave Search API.",
    recommended: true,
    oauthScopes: [],
    fields: apiKeyOnly,
    actions: [
      { name: "search", description: "Search the web for up-to-date information", riskLevel: "low" },
    ],
  },
  {
    id: "serper",
    label: "Serper",
    category: "data",
    authType: "api_key",
    description: "Google Search results via the Serper.dev API.",
    oauthScopes: [],
    fields: apiKeyOnly,
    actions: [
      { name: "search", description: "Search the web for up-to-date information", riskLevel: "low" },
    ],
  },
  {
    id: "google_cse",
    label: "Google Custom Search",
    category: "data",
    authType: "api_key",
    description: "Web search via Google Programmable Search Engine.",
    oauthScopes: [],
    fields: [
      { name: "apiKey", label: "API key", secret: true, required: true },
      { name: "cxId", label: "Search engine ID (cx)", required: true },
    ],
    actions: [
      { name: "search", description: "Search the web for up-to-date information", riskLevel: "low" },
    ],
  },
  {
    id: "replicate",
    label: "Replicate",
    category: "data",
    authType: "api_key",
    description: "Cloud AI inference for image generation (FLUX) and speech-to-text (Whisper).",
    recommended: true,
    oauthScopes: [],
    fields: apiKeyOnly,
    actions: [
      { name: "imageGenerate", description: "Generate an image from a text prompt via FLUX", riskLevel: "low" },
      { name: "transcribeAudio", description: "Transcribe speech audio via Whisper", riskLevel: "low" },
    ],
  },
];

export function listProviders(): readonly ProviderDescriptor[] {
  return PROVIDERS;
}

export function getProvider(id: string): ProviderDescriptor | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export function getProviderOrThrow(id: string): ProviderDescriptor {
  const p = getProvider(id);
  if (!p) {
    const error = new Error(`Unknown integration provider: ${id}`);
    (error as Error & { code?: string }).code = "UNKNOWN_PROVIDER";
    throw error;
  }
  return p;
}

/**
 * Strip secret fields from a credentials payload before returning to the
 * client. Used by the GET routes so the UI can show "this field is set"
 * without exposing the value.
 */
export function redactCredentials(
  provider: ProviderDescriptor,
  creds: Record<string, unknown> | null,
): Record<string, "set" | "unset" | unknown> {
  const out: Record<string, "set" | "unset" | unknown> = {};
  for (const f of provider.fields) {
    const v = creds?.[f.name];
    if (f.secret) {
      out[f.name] = v ? "set" : "unset";
    } else {
      out[f.name] = v ?? null;
    }
  }
  return out;
}
