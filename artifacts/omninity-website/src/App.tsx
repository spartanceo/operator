import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout/layout";
import { ThemeProvider } from "@/contexts/theme-context";
import { SettingsProvider } from "@/contexts/settings-context";
import { initApiClient } from "@/lib/api-config";
import { makeQueryClient } from "@/lib/query-client";
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
import ToolsPage from "@/pages/operator/tools";
import PrivacyPage from "@/pages/operator/privacy";
import MemoryPage from "@/pages/operator/memory";
import SettingsPage from "@/pages/operator/settings";

initApiClient();

const queryClient = makeQueryClient();

const OPERATOR_ROUTES = new Set([
  "/chat",
  "/agents",
  "/tools",
  "/privacy",
  "/memory",
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
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function OperatorShell() {
  return (
    <Switch>
      <Route path="/chat" component={ChatPage} />
      <Route path="/agents" component={AgentsPage} />
      <Route path="/tools" component={ToolsPage} />
      <Route path="/privacy" component={PrivacyPage} />
      <Route path="/memory" component={MemoryPage} />
      <Route path="/settings" component={SettingsPage} />
    </Switch>
  );
}

function Router() {
  const path = typeof window !== "undefined" ? window.location.pathname : "/";
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const relativePath = base && path.startsWith(base) ? path.slice(base.length) || "/" : path;
  return isOperatorPath(relativePath) ? <OperatorShell /> : <MarketingShell />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <SettingsProvider>
          <TooltipProvider>
            <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
              <Router />
            </WouterRouter>
          </TooltipProvider>
        </SettingsProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
