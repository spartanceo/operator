import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useGetOnboardingProfile } from "@workspace/api-client-react";
import { Loader2 } from "lucide-react";
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
import SkillDetailPage from "@/pages/skill-detail";
import CreatorsPage from "@/pages/creators";
import CreatorDetailPage from "@/pages/creator-detail";
import DocsPage from "@/pages/docs";
import ApiReferencePage from "@/pages/api-reference";
import NotFound from "@/pages/not-found";
import ChatPage from "@/pages/operator/chat";
import AgentsPage from "@/pages/operator/agents";
import DesktopPage from "@/pages/operator/desktop";
import ToolsPage from "@/pages/operator/tools";
import MediaPage from "@/pages/operator/media";
import PrivacyPage from "@/pages/operator/privacy";
import MemoryPage from "@/pages/operator/memory";
import KnowledgePage from "@/pages/operator/knowledge";
import CommunicationsPage from "@/pages/operator/communications";
import ActivityPage from "@/pages/operator/activity";
import ApprovalsPage from "@/pages/operator/approvals";
import UndoPage from "@/pages/operator/undo";
import SettingsPage from "@/pages/operator/settings";
import OnboardingPage from "@/pages/operator/onboarding";
import MobilePage from "@/pages/mobile";
import LegalPage from "@/pages/legal";
import { LegalGate } from "@/components/operator/legal-gate";

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
  "/communications",
  "/approvals",
  "/undo",
  "/activity",
  "/settings",
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
        <Route path="/marketplace/:slug" component={SkillDetailPage} />
        <Route path="/creators" component={CreatorsPage} />
        <Route path="/creators/:slug" component={CreatorDetailPage} />
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
 * Operator shell — gated by the onboarding profile.
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
          initialProfile={profile}
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

function OperatorRoutes() {
  return (
    <Switch>
      <Route path="/chat" component={ChatPage} />
      <Route path="/agents" component={AgentsPage} />
      <Route path="/desktop" component={DesktopPage} />
      <Route path="/tools" component={ToolsPage} />
      <Route path="/media" component={MediaPage} />
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/memory" component={MemoryPage} />
      <Route path="/knowledge" component={KnowledgePage} />
      <Route path="/communications" component={CommunicationsPage} />
      <Route path="/approvals" component={ApprovalsPage} />
      <Route path="/undo" component={UndoPage} />
      <Route path="/activity" component={ActivityPage} />
      <Route path="/settings" component={SettingsPage} />
    </Switch>
  );
}

function Router() {
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  const base = getBaseUrl().replace(/\/$/, "");
  const relativePath = base && path.startsWith(base) ? path.slice(base.length) || "/" : path;
  const isMobile = relativePath === "/mobile" || relativePath.startsWith("/mobile/");
  const isOperator = !isMobile && isOperatorPath(relativePath);
  if (isMobile) {
    return <MobilePage />;
  }
  return (
    <>
      {isOperator ? <OperatorShell /> : <MarketingShell />}
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
