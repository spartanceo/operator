import { Suspense, lazy, useEffect, Component } from "react";
import type { ReactNode, ErrorInfo } from "react";
import { Switch, Route, Router as WouterRouter, useLocation } from "wouter";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useGetOnboardingProfile } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout/layout";
import { ThemeProvider } from "@/contexts/theme-context";
import { SettingsProvider } from "@/contexts/settings-context";
import {
  HelpProvider,
  HelpPanel,
  ShortcutsOverlay,
  FeatureTour,
  GlobalKeyboardShortcuts,
} from "@/components/help";
import { CatalogHydrator } from "@/components/operator/catalog-hydrator";
import { initApiClient } from "@/lib/api-config";
import { makeQueryClient } from "@/lib/query-client";
import { LocaleProvider } from "@/i18n/locale-context";
import { getBaseUrl } from "@/lib/base-url";
import LandingPage from "@/pages/landing";
import DownloadPage from "@/pages/download";
import PricingPage from "@/pages/pricing";
import MarketplacePage from "@/pages/marketplace";
import MarketplaceCreatePage from "@/pages/marketplace-create";
import SkillDetailPage from "@/pages/skill-detail";
import CreatorsPage from "@/pages/creators";
import CreatorSignupPage from "@/pages/creator-signup";
import CreatorDashboardPage from "@/pages/creator-dashboard";
import CreatorDetailPage from "@/pages/creator-detail";
import DocsPage from "@/pages/docs";
import ApiReferencePage from "@/pages/api-reference";
import NotFound from "@/pages/not-found";
import ChatPage from "@/pages/operator/chat";
const AgentsPage = lazy(() => import("@/pages/operator/agents"));
const DesktopPage = lazy(() => import("@/pages/operator/desktop"));
const ToolsPage = lazy(() => import("@/pages/operator/tools"));
const MediaPage = lazy(() => import("@/pages/operator/media"));
const PrivacyPage = lazy(() => import("@/pages/operator/privacy"));
const MemoryPage = lazy(() => import("@/pages/operator/memory"));
const KnowledgePage = lazy(() => import("@/pages/operator/knowledge"));
const TemplatesPage = lazy(() => import("@/pages/operator/templates"));
const CommunicationsPage = lazy(() => import("@/pages/operator/communications"));
const ActivityPage = lazy(() => import("@/pages/operator/activity"));
const ApprovalsPage = lazy(() => import("@/pages/operator/approvals"));
const UndoPage = lazy(() => import("@/pages/operator/undo"));
const SkillsPage = lazy(() => import("@/pages/operator/skills"));
const QueuePage = lazy(() => import("@/pages/operator/queue"));
const SchedulesPage = lazy(() => import("@/pages/operator/schedules"));
const IntegrationsPage = lazy(() => import("@/pages/operator/integrations"));
const SettingsPage = lazy(() => import("@/pages/operator/settings"));
const SubscriptionPage = lazy(() => import("@/pages/operator/subscription"));
const CreatorRevenuePage = lazy(() => import("@/pages/operator/creator"));
const SupportPage = lazy(() => import("@/pages/operator/support"));
const FeatureRequestsPage = lazy(() => import("@/pages/feature-requests"));
const StatusPage = lazy(() => import("@/pages/status"));
import OnboardingPage from "@/pages/operator/onboarding";
import LoginPage from "@/pages/auth/login";
import MobilePage from "@/pages/mobile";
import LegalPage from "@/pages/legal";
const SuperAdminPage = lazy(() => import("@/pages/admin/super"));
const EnterpriseAdminPage = lazy(() => import("@/pages/admin/enterprise"));
import { LegalGate } from "@/components/operator/legal-gate";

// ─── Route Error Boundary ─────────────────────────────────────────────────────

interface RouteErrorBoundaryState {
  error: Error | null;
}

class RouteErrorBoundary extends Component<
  { children: ReactNode; routeName?: string },
  RouteErrorBoundaryState
> {
  constructor(props: { children: ReactNode; routeName?: string }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[RouteErrorBoundary] ${this.props.routeName ?? "route"} crashed:`, error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[60vh] w-full flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-6 text-left shadow-sm max-w-lg w-full">
            <h2 className="mb-1 text-base font-semibold text-destructive">
              {this.props.routeName ? `${this.props.routeName} failed to load` : "Something went wrong"}
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">
              An unexpected error occurred while rendering this page.
            </p>
            <pre className="overflow-auto rounded bg-muted px-3 py-2 text-xs text-muted-foreground whitespace-pre-wrap break-all">
              {this.state.error.message}
            </pre>
            <button
              className="mt-4 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

initApiClient();

const queryClient = makeQueryClient();

// tier-review: bounded — fixed-size route allow-list, never mutated at runtime
const OPERATOR_ROUTES = new Set([
  "/chat",
  "/agents",
  "/desktop",
  "/tools",
  "/media",
  "/privacy",
  "/memory",
  "/knowledge",
  "/templates",
  "/communications",
  "/approvals",
  "/undo",
  "/schedules",
  "/activity",
  "/skills",
  "/queue",
  "/integrations",
  "/settings",
  "/subscription",
  "/creator",
  "/support",
]);

function isOperatorPath(path: string): boolean {
  return Array.from(OPERATOR_ROUTES).some(
    (route) => path === route || path.startsWith(`${route}/`),
  );
}

function MarketingShell() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={LandingPage} />
        <Route path="/download" component={DownloadPage} />
        <Route path="/pricing" component={PricingPage} />
        <Route path="/marketplace" component={MarketplacePage} />
        <Route path="/marketplace/create" component={MarketplaceCreatePage} />
        <Route path="/marketplace/:slug" component={SkillDetailPage} />
        <Route path="/creators" component={CreatorsPage} />
        <Route path="/creators/signup" component={CreatorSignupPage} />
        <Route path="/creators/dashboard" component={CreatorDashboardPage} />
        <Route path="/creators/:slug" component={CreatorDetailPage} />
        <Route path="/feature-requests" component={FeatureRequestsPage} />
        <Route path="/status" component={StatusPage} />
        <Route path="/docs/api-reference" component={ApiReferencePage} />
        <Route path="/docs" component={DocsPage} />
        <Route path="/docs/:section" component={DocsPage} />
        <Route path="/docs/:section/:page" component={DocsPage} />
        <Route path="/legal/privacy">
          <LegalPage documentType="privacy" />
        </Route>
        <Route path="/legal/terms">
          <LegalPage documentType="terms" />
        </Route>
        <Route path="/legal/eula">
          <LegalPage documentType="eula" />
        </Route>
        <Route path="/legal/eu-ai-act">
          <LegalPage documentType="eu_ai_act" />
        </Route>
        <Route path="/legal/open-source">
          <LegalPage documentType="open_source_attribution" />
        </Route>
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

/**
 * Auth gate — sits in front of OperatorShell (Task #71).
 *
 * Calls GET /api/auth/me. Three states:
 *   - loading  → full-screen spinner (avoids flash of login page on warm sessions)
 *   - 401/error → redirect to /login so the user can sign in or register
 *   - authenticated → render children
 *
 * The X-Tenant-ID header is still sent for the bootstrap case; the /me
 * endpoint checks session.sessionId specifically, so header-only requests
 * correctly resolve as unauthenticated.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, isError } = useAuth();
  const [, navigate] = useLocation();

  useEffect(() => {
    if (!isLoading && (isError || !isAuthenticated)) {
      void navigate("/login", { replace: true });
    }
  }, [isLoading, isError, isAuthenticated, navigate]);

  if (isLoading || isError || !isAuthenticated) {
    return (
      <div
        className="grid min-h-screen w-full place-items-center bg-background text-foreground"
        data-testid="auth-loading"
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <>{children}</>;
}

/**
 * Operator shell — gated by session auth (Task #71) then onboarding profile.
 *
 * The first visit hits `/api/onboarding/profile` and renders the wizard
 * when no completed profile exists. On wizard completion we invalidate the
 * profile query so the gate flips without a hard reload. The intermediate
 * loading state is intentionally minimal — a flash of the wizard for
 * sub-second profile fetches is much better UX than a flash of chat.
 */
function OperatorShell() {
  const profileQuery = useGetOnboardingProfile();
  const qc = useQueryClient();

  if (profileQuery.isLoading) {
    return (
      <div
        className="grid min-h-screen w-full place-items-center bg-background text-foreground"
        data-testid="operator-loading"
      >
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const profile = profileQuery.data?.data.profile ?? null;
  const completed = profile?.completed === true;

  if (!completed) {
    return (
      <LegalGate>
        <OnboardingPage
          onComplete={() => {
            void qc.invalidateQueries();
          }}
        />
      </LegalGate>
    );
  }

  return (
    <LegalGate>
      <OperatorRoutes />
    </LegalGate>
  );
}

/**
 * Auth-gated operator shell — wraps OperatorShell with the session check.
 * Extracted so the AuthGate hook calls (useAuth → react-query) are always
 * inside QueryClientProvider and always triggered on operator paths.
 */
function OperatorShellGated() {
  return (
    <AuthGate>
      <OperatorShell />
    </AuthGate>
  );
}

function OperatorRoutes() {
  return (
    <Suspense
      fallback={
        <div
          className="grid min-h-[60vh] w-full place-items-center"
          data-testid="operator-route-loading"
        >
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      }
    >
      <Switch>
        <Route path="/chat" component={ChatPage} />
        <Route path="/agents" component={AgentsPage} />
        <Route path="/desktop">
          <RouteErrorBoundary routeName="Desktop">
            <DesktopPage />
          </RouteErrorBoundary>
        </Route>
        <Route path="/tools" component={ToolsPage} />
        <Route path="/media" component={MediaPage} />
        <Route path="/privacy" component={PrivacyPage} />
        <Route path="/memory" component={MemoryPage} />
        <Route path="/knowledge" component={KnowledgePage} />
        <Route path="/templates" component={TemplatesPage} />
        <Route path="/communications" component={CommunicationsPage} />
        <Route path="/approvals" component={ApprovalsPage} />
        <Route path="/undo" component={UndoPage} />
        <Route path="/schedules" component={SchedulesPage} />
        <Route path="/activity" component={ActivityPage} />
        <Route path="/skills" component={SkillsPage} />
        <Route path="/queue" component={QueuePage} />
        <Route path="/integrations" component={IntegrationsPage} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/subscription" component={SubscriptionPage} />
        <Route path="/creator" component={CreatorRevenuePage} />
        <Route path="/support" component={SupportPage} />
      </Switch>
    </Suspense>
  );
}

function Router() {
  const [path] = useLocation();
  const base = getBaseUrl().replace(/\/$/, "");
  const relativePath = base && path.startsWith(base) ? path.slice(base.length) || "/" : path;
  const isMobile = relativePath === "/mobile" || relativePath.startsWith("/mobile/");
  const isAdmin = relativePath.startsWith("/admin/");
  const isLogin = relativePath === "/login";
  const isOperator = !isMobile && !isAdmin && !isLogin && isOperatorPath(relativePath);
  if (isMobile) {
    return <MobilePage />;
  }
  if (isLogin) {
    return <LoginPage />;
  }
  if (isAdmin) {
    return (
      <Suspense
        fallback={
          <div className="grid min-h-screen w-full place-items-center bg-background text-foreground">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        }
      >
        <Switch>
          <Route path="/admin/super" component={SuperAdminPage} />
          <Route path="/admin/super/:rest*" component={SuperAdminPage} />
          <Route path="/admin/enterprise" component={EnterpriseAdminPage} />
          <Route path="/admin/enterprise/:rest*" component={EnterpriseAdminPage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    );
  }
  return (
    <>
      {isOperator ? <OperatorShellGated /> : <MarketingShell />}
      {isOperator ? (
        <>
          <HelpPanel />
          <ShortcutsOverlay />
          <FeatureTour />
          <GlobalKeyboardShortcuts />
        </>
      ) : null}
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LocaleProvider>
      <ThemeProvider>
        <SettingsProvider>
          <HelpProvider>
            <TooltipProvider>
              <CatalogHydrator />
              <WouterRouter base={getBaseUrl().replace(/\/$/, "")}>
                <Router />
              </WouterRouter>
            </TooltipProvider>
          </HelpProvider>
        </SettingsProvider>
      </ThemeProvider>
      </LocaleProvider>
    </QueryClientProvider>
  );
}

export default App;
